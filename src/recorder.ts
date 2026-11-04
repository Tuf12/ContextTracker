import http from "http";
import https from "https";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http";
import { createSseCollector, extractReply, looksLikeGeneration, normalizeRequest } from "./parse";
import type { PromptMessage, ReportedSpan, RouteSettings } from "./types";

export const CAPTURE_PORT = 47321;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_REPLY = 8 * 1024 * 1024;

export type RecorderCapture = {
  clientRequestId: string | null;
  explicitRunId?: string | null;
  provider: string;
  upstream: string;
  endpoint: string;
  model: string;
  status: number | null;
  error: string | null;
  messages: PromptMessage[];
  reply: string;
};

export type RecorderServer = {
  url: string;
  port: number;
  close(): Promise<void>;
};

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

export function chooseUpstream(route: RouteSettings, headers: IncomingHttpHeaders): URL {
  if (route.mode === "custom") {
    const url = new URL(route.customUpstream.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Custom upstream must start with http:// or https://");
    }
    return url;
  }
  if (headers["anthropic-version"] || headers["x-api-key"]) {
    return new URL("https://api.anthropic.com");
  }
  return new URL("https://api.openai.com");
}

export function upstreamUrl(origin: URL, reqPath: string): URL {
  const basePath = origin.pathname.replace(/\/$/, "");
  const suffix = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
  return new URL(`${basePath}${suffix}`, `${origin.protocol}//${origin.host}`);
}

export function providerFor(route: RouteSettings, headers: IncomingHttpHeaders): string {
  if (route.mode === "custom") {
    return "custom";
  }
  if (headers["anthropic-version"] || headers["x-api-key"]) {
    return "anthropic";
  }
  return "openai";
}

export function startRecorder(options: {
  port?: number;
  route: () => RouteSettings;
  onCapture: (capture: RecorderCapture) => void;
  onSpans: (id: string, spans: ReportedSpan[]) => void;
  onLog: (line: string) => void;
}): Promise<RecorderServer> {
  const port = options.port ?? CAPTURE_PORT;
  const server = http.createServer((req, res) => {
    void handle(req, res, options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Capture failed.";
      options.onLog(message);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;

  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      server.on("error", (error) => options.onLog(error.message));
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        close: () =>
          new Promise((done, cancel) => {
            server.close((error) => (error ? cancel(error) : done()));
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    route: () => RouteSettings;
    onCapture: (capture: RecorderCapture) => void;
    onSpans: (id: string, spans: ReportedSpan[]) => void;
    onLog: (line: string) => void;
  },
): Promise<void> {
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "none") {
    res.statusCode = 403;
    res.end("Context Tracker does not accept browser requests.");
    return;
  }

  const endpoint = req.url || "/";
  if (req.method === "POST" && endpoint.split("?")[0] === "/context-tracker/v1/spans") {
    await handleSpans(req, res, options.onSpans);
    return;
  }

  const body = await readBody(req, MAX_BODY);
  const route = options.route();
  let origin: URL;
  try {
    origin = chooseUpstream(route, req.headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream is not a valid URL.";
    const parsed = parseGeneration(endpoint, body);
    if (parsed) {
      options.onCapture({
        ...parsed,
        clientRequestId: clientId(req),
        explicitRunId: explicitRunId(req),
        provider: "custom",
        upstream: route.customUpstream,
        status: null,
        error: message,
        reply: "",
      });
    }
    res.statusCode = 400;
    res.end(message);
    return;
  }

  const target = upstreamUrl(origin, endpoint);
  const parsed = parseGeneration(endpoint, body);
  await forward(req, res, body, target, parsed, {
    provider: providerFor(route, req.headers),
    clientRequestId: clientId(req),
    explicitRunId: explicitRunId(req),
    onCapture: options.onCapture,
    onLog: options.onLog,
  });
}

function parseGeneration(endpoint: string, body: Buffer): { endpoint: string; model: string; messages: PromptMessage[] } | null {
  if (!body.length) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!looksLikeGeneration(endpoint, json)) {
    return null;
  }
  const normalized = normalizeRequest(endpoint, json);
  if (normalized.messages.length === 0) {
    return null;
  }
  return { endpoint, model: normalized.model, messages: normalized.messages };
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  target: URL,
  parsed: { endpoint: string; model: string; messages: PromptMessage[] } | null,
  meta: {
    provider: string;
    clientRequestId: string | null;
    explicitRunId?: string | null;
    onCapture: (capture: RecorderCapture) => void;
    onLog: (line: string) => void;
  },
): Promise<void> {
  return new Promise((resolve) => {
    let saved = false;
    const save = (status: number | null, error: string | null, reply: string) => {
      if (saved || !parsed) {
        return;
      }
      saved = true;
      meta.onCapture({
        clientRequestId: meta.clientRequestId,
        explicitRunId: meta.explicitRunId,
        provider: meta.provider,
        upstream: `${target.protocol}//${target.host}`,
        endpoint: parsed.endpoint,
        model: parsed.model,
        status,
        error,
        messages: parsed.messages,
        reply,
      });
      meta.onLog(`${req.method || "POST"} ${parsed.endpoint} → ${target.host} ${status ?? "failed"}`);
    };

    const lib = target.protocol === "http:" ? http : https;
    const upstreamReq = lib.request(
      target,
      { method: req.method, headers: forwardHeaders(req, body.length, target) },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders(upstreamRes.headers));
        const chunks: Buffer[] = [];
        let size = 0;
        const sse = createSseCollector();
        upstreamRes.on("data", (chunk: Buffer) => {
          if (!res.writableEnded) {
            res.write(chunk);
          }
          if (size < MAX_REPLY) {
            chunks.push(chunk);
            size += chunk.length;
            sse.push(chunk.toString("utf8"));
          }
        });
        upstreamRes.on("end", () => {
          if (!res.writableEnded) {
            res.end();
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          const type = String(upstreamRes.headers["content-type"] ?? "");
          const reply = type.includes("text/event-stream") || raw.trimStart().startsWith("data:")
            ? sse.text() || extractReply(type, raw)
            : extractReply(type, raw);
          const status = upstreamRes.statusCode ?? null;
          save(status, status !== null && status >= 400 ? `The provider returned HTTP ${status}.` : null, reply);
          resolve();
        });
        upstreamRes.on("error", (error) => {
          if (!res.writableEnded) {
            res.end();
          }
          save(upstreamRes.statusCode ?? null, error.message, "");
          resolve();
        });
      },
    );

    upstreamReq.setTimeout(10 * 60 * 1000, () => upstreamReq.destroy(new Error("The provider timed out.")));
    upstreamReq.on("error", (error) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Context Tracker could not reach the model provider.");
      } else if (!res.writableEnded) {
        res.end();
      }
      save(null, error.message, "");
      resolve();
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        upstreamReq.destroy();
      }
    });
    upstreamReq.end(body);
  });
}

async function handleSpans(
  req: IncomingMessage,
  res: ServerResponse,
  onSpans: (id: string, spans: ReportedSpan[]) => void,
): Promise<void> {
  const body = await readBody(req, 2 * 1024 * 1024);
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    res.statusCode = 400;
    res.end("Expected JSON.");
    return;
  }
  const parsed = readReported(json);
  if (!parsed) {
    res.statusCode = 400;
    res.end("Expected an id and a spans list.");
    return;
  }
  onSpans(parsed.id, parsed.spans);
  res.statusCode = 204;
  res.end();
}

function readReported(json: unknown): { id: string; spans: ReportedSpan[] } | null {
  if (!json || typeof json !== "object") {
    return null;
  }
  const body = json as Record<string, unknown>;
  if (typeof body.id !== "string" || !body.id.trim() || !Array.isArray(body.spans)) {
    return null;
  }
  const spans: ReportedSpan[] = [];
  for (const item of body.spans.slice(0, 200)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const span = item as Record<string, unknown>;
    if (typeof span.file !== "string" || !span.file.trim() || span.file.includes("\u0000")) {
      continue;
    }
    if (!isPositiveInt(span.startLine) || !isPositiveInt(span.endLine) || span.endLine < span.startLine) {
      continue;
    }
    const reported: ReportedSpan = {
      file: span.file,
      startLine: span.startLine,
      endLine: span.endLine,
    };
    if (typeof span.quote === "string" && span.quote.length > 0 && span.quote.length <= 20_000) {
      reported.quote = span.quote;
    }
    if (typeof span.messageIndex === "number" && Number.isInteger(span.messageIndex) && span.messageIndex >= 0) {
      reported.messageIndex = span.messageIndex;
    }
    if (typeof span.charStart === "number" && typeof span.charEnd === "number") {
      reported.charStart = span.charStart;
      reported.charEnd = span.charEnd;
    }
    if (!reported.quote && reported.charStart === undefined) {
      continue;
    }
    spans.push(reported);
  }
  return { id: body.id.trim(), spans };
}

function forwardHeaders(req: IncomingMessage, bodyLength: number, target: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
      lower === "content-length" ||
      lower === "accept-encoding" ||
      lower === "x-context-tracker-id" ||
      lower === "x-context-tracker-run-id" ||
      lower === "x-run-id"
    ) {
      continue;
    }
    if (value !== undefined) {
      headers[key] = value;
    }
  }
  headers.host = target.host;
  headers["content-length"] = bodyLength;
  return headers;
}

function responseHeaders(src: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(src)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) {
      continue;
    }
    headers[key] = value;
  }
  return headers;
}

function clientId(req: IncomingMessage): string | null {
  const value = req.headers["x-context-tracker-id"];
  const id = Array.isArray(value) ? value[0] : value;
  return id && id.trim() ? id.trim().slice(0, 200) : null;
}

function explicitRunId(req: IncomingMessage): string | null {
  const value = req.headers["x-context-tracker-run-id"] ?? req.headers["x-run-id"];
  const id = Array.isArray(value) ? value[0] : value;
  return id && id.trim() ? id.trim().slice(0, 200) : null;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("The request body is too large to capture."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
