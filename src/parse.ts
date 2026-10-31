import type { PromptMessage } from "./types";

const MESSAGE_CHAR_CAP = 500_000;
const TOTAL_CHAR_CAP = 2_000_000;

export type NormalizedRequest = {
  model: string;
  messages: PromptMessage[];
};

export function looksLikeGeneration(endpoint: string, json: unknown): boolean {
  const path = endpoint.split("?")[0].toLowerCase();
  if (/\/(embeddings|images\/generations|images\/edits|audio\/|moderations)(\/|$)/.test(path)) {
    return false;
  }
  if (/\/(chat\/completions|responses|messages|completions)(\/|$)/.test(path)) {
    return true;
  }
  if (!json || typeof json !== "object") {
    return false;
  }
  const body = json as Record<string, unknown>;
  return Array.isArray(body.messages) || typeof body.system === "string" || Array.isArray(body.system);
}

export function normalizeRequest(endpoint: string, json: unknown): NormalizedRequest {
  const body = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const model = typeof body.model === "string" && body.model.trim() ? body.model : "unknown model";
  const messages: PromptMessage[] = [];
  let remaining = TOTAL_CHAR_CAP;

  const push = (role: string, content: string) => {
    if (remaining <= 0) {
      return;
    }
    const text = content.replace(/\r\n/g, "\n");
    if (!text.trim()) {
      return;
    }
    const clipped = text.length > Math.min(MESSAGE_CHAR_CAP, remaining) ? text.slice(0, Math.min(MESSAGE_CHAR_CAP, remaining)) : text;
    messages.push({
      role,
      content: clipped,
      truncated: clipped.length !== text.length,
    });
    remaining -= clipped.length;
  };

  if (typeof body.system === "string" || Array.isArray(body.system)) {
    push("system", contentToText(body.system));
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== "object") {
        continue;
      }
      const record = message as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "user";
      const text = [contentToText(record.content), toolCallsToText(record.tool_calls)].filter(Boolean).join("\n");
      push(role, text);
    }
  }
  const tools = toolsToText(body.tools);
  if (tools && remaining > 0) {
    const insertAt = messages.findIndex((message) => message.role !== "system");
    const toolMessage: PromptMessage = {
      role: "tools",
      content: tools.length > Math.min(MESSAGE_CHAR_CAP, remaining) ? tools.slice(0, Math.min(MESSAGE_CHAR_CAP, remaining)) : tools,
      truncated: tools.length > Math.min(MESSAGE_CHAR_CAP, remaining),
    };
    remaining -= toolMessage.content.length;
    if (insertAt === -1) {
      messages.push(toolMessage);
    } else {
      messages.splice(insertAt, 0, toolMessage);
    }
  }
  if (!Array.isArray(body.messages)) {
    if (typeof body.input === "string") {
      push("user", body.input);
    } else if (Array.isArray(body.input)) {
      push("user", contentToText(body.input));
    }
  }
  if (typeof body.instructions === "string" && body.system === undefined) {
    messages.unshift(clipMessage("system", body.instructions));
  }
  if (messages.length === 0 && looksLikeGeneration(endpoint, json)) {
    push("request", jsonPreview(json));
  }
  return { model, messages };
}

export function extractReply(contentType: string | undefined, body: string): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("text/event-stream") || body.trimStart().startsWith("data:")) {
    return collectSse(body).trim();
  }
  const streamed = ollamaStreamText(body);
  if (streamed !== null) {
    return streamed;
  }
  try {
    return replyFromJson(JSON.parse(body)).trim();
  } catch {
    return body.trim().slice(0, 200_000);
  }
}

export function readableReply(body: string): string {
  const streamed = ollamaStreamText(body);
  return streamed === null ? body : streamed;
}

function ollamaStreamText(body: string): string | null {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return null;
  }
  let content = "";
  let thinking = "";
  for (const line of lines) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return null;
    }
    if (!json || typeof json !== "object" || !("message" in json)) {
      return null;
    }
    const message = (json as Record<string, unknown>).message;
    if (!message || typeof message !== "object") {
      return null;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.content === "string") {
      content += record.content;
    }
    if (typeof record.thinking === "string") {
      thinking += record.thinking;
    }
  }
  return [content.trim(), thinking.trim()].filter(Boolean).join("\n\n");
}

export function createSseCollector(): { push(chunk: string): void; text(): string } {
  let buffer = "";
  const parts: string[] = [];
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeSseLine(line, parts);
      }
    },
    text() {
      if (buffer.trim()) {
        consumeSseLine(buffer, parts);
        buffer = "";
      }
      return parts.join("");
    },
  };
}

function collectSse(body: string): string {
  const parts: string[] = [];
  for (const line of body.split("\n")) {
    consumeSseLine(line, parts);
  }
  return parts.join("");
}

function consumeSseLine(line: string, parts: string[]): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return;
  }
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") {
    return;
  }
  try {
    const text = textFromEvent(JSON.parse(data));
    if (text) {
      parts.push(text);
    }
  } catch {
    return;
  }
}

function replyFromJson(json: unknown): string {
  if (!json || typeof json !== "object") {
    return "";
  }
  const body = json as Record<string, unknown>;
  const pieces: string[] = [];
  if (typeof body.output_text === "string") {
    pieces.push(body.output_text);
  }
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (!choice || typeof choice !== "object") {
        continue;
      }
      const message = (choice as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const record = message as Record<string, unknown>;
        pieces.push(contentToText(record.content));
        pieces.push(toolCallsToText(record.tool_calls));
      }
      const text = (choice as Record<string, unknown>).text;
      if (typeof text === "string") {
        pieces.push(text);
      }
    }
  }
  if (Array.isArray(body.content)) {
    pieces.push(contentToText(body.content));
  }
  if (body.message && typeof body.message === "object") {
    pieces.push(contentToText((body.message as Record<string, unknown>).content));
  }
  if (typeof body.completion === "string") {
    pieces.push(body.completion);
  }
  if (typeof body.error === "string") {
    pieces.push(body.error);
  } else if (body.error && typeof body.error === "object") {
    const message = (body.error as Record<string, unknown>).message;
    if (typeof message === "string") {
      pieces.push(message);
    }
  }
  return pieces.filter(Boolean).join("\n");
}

function textFromEvent(json: unknown): string {
  if (!json || typeof json !== "object") {
    return "";
  }
  const event = json as Record<string, unknown>;
  const pieces: string[] = [];
  if (typeof event.output_text === "string") {
    pieces.push(event.output_text);
  }
  const delta = event.delta;
  if (delta && typeof delta === "object") {
    const record = delta as Record<string, unknown>;
    if (typeof record.content === "string") {
      pieces.push(record.content);
    } else if (typeof record.text === "string") {
      pieces.push(record.text);
    }
  }
  if (Array.isArray(event.choices)) {
    for (const choice of event.choices) {
      if (!choice || typeof choice !== "object") {
        continue;
      }
      const choiceDelta = (choice as Record<string, unknown>).delta;
      if (!choiceDelta || typeof choiceDelta !== "object") {
        continue;
      }
      const record = choiceDelta as Record<string, unknown>;
      if (typeof record.content === "string") {
        pieces.push(record.content);
      }
      pieces.push(toolCallsToText(record.tool_calls));
    }
  }
  return pieces.filter(Boolean).join("");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map(partToText).filter(Boolean).join("\n");
}

function partToText(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (record.type === "image_url" || record.type === "image" || record.type === "input_image") {
    return "[image]";
  }
  if (record.type === "tool_use" || record.type === "tool_call") {
    const name = typeof record.name === "string" ? record.name : "tool";
    return `${name}\n${jsonPreview(record.input ?? record.arguments)}`;
  }
  if (record.type === "tool_result" || record.type === "tool_result_block") {
    return contentToText(record.content);
  }
  return "";
}

function toolCallsToText(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls)) {
    return "";
  }
  return toolCalls
    .map((call) => {
      if (!call || typeof call !== "object") {
        return "";
      }
      const record = call as Record<string, unknown>;
      const fn = record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : record;
      const name = typeof fn.name === "string" ? fn.name : "tool";
      const args = typeof fn.arguments === "string" ? fn.arguments : jsonPreview(fn.arguments ?? fn.input);
      return `${name}\n${args}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function toolsToText(tools: unknown): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    return "";
  }
  return tools.map((tool) => JSON.stringify(tool, null, 2)).join("\n\n");
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, MESSAGE_CHAR_CAP);
  } catch {
    return "";
  }
}

function clipMessage(role: string, content: string): PromptMessage {
  const text = content.replace(/\r\n/g, "\n");
  const clipped = text.slice(0, MESSAGE_CHAR_CAP);
  return { role, content: clipped, truncated: clipped.length !== text.length };
}
