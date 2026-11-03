import type { ChatMessage, OpenAIToolCall } from "./types";

export type { ChatMessage, OpenAIToolCall };

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ChatTurn = {
  content: string | null;
  toolCalls: ToolCall[];
};

export const META_HELPER_BASE = "https://api.meta.ai/v1";

export const META_MODELS = [
  { id: "muse-spark-1.3", label: "Muse Spark 1.3" },
  { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor" },
  { id: "muse-wonder-1.0", label: "Muse Wonder" },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2" },
  { id: "muse-spark-1.1", label: "Muse Spark 1.1" },
];

export type HelperFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export function helperChatUrl(baseUrl: string): string {
  return helperEndpoint(baseUrl, "chat/completions");
}

export function helperModelsUrl(baseUrl: string): string {
  return helperEndpoint(baseUrl, "models");
}

export function modelIdsFromResponse(json: unknown): string[] {
  if (!json || typeof json !== "object") {
    return [];
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      ids.add(id.trim());
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right)).slice(0, 200);
}

export async function listHelperModels(options: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: HelperFetch;
}): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const response = await fetchImpl(helperModelsUrl(options.baseUrl), {
    method: "GET",
    headers: { authorization: `Bearer ${options.apiKey}` },
  });
  const raw = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error("The helper host rejected the API key.");
  }
  if (!response.ok) {
    return [];
  }
  try {
    return modelIdsFromResponse(JSON.parse(raw));
  } catch {
    return [];
  }
}

function helperEndpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl.trim());
  const pathName = url.pathname.replace(/\/$/, "");
  url.pathname = `${pathName}/${suffix}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * Normalizes persisted chat history so follow-up helper requests stay API-compatible.
 * Muse/OpenAI-compatible hosts reject null assistant content and assistant tool_calls without matching tool messages.
 */
export function sanitizeMessagesForHelperApi(messages: ChatMessage[]): ChatMessage[] {
  const normalized = messages.map((message) => ({
    ...message,
    content: message.content ?? "",
  }));

  const valid: ChatMessage[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const msg = normalized[i];
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const needed = msg.tool_calls.map((call) => call.id);
      const toolMessages: ChatMessage[] = [];
      const answered = new Set<string>();
      let j = i + 1;
      while (j < normalized.length && normalized[j].role === "tool") {
        toolMessages.push(normalized[j]);
        const toolCallId = normalized[j].tool_call_id;
        if (toolCallId) {
          answered.add(toolCallId);
        }
        j += 1;
      }
      if (!needed.every((id) => answered.has(id))) {
        if (j > i + 1) {
          i = j - 1;
        }
        continue;
      }
      valid.push(msg);
      valid.push(...toolMessages);
      i = j - 1;
      continue;
    }
    if (msg.role === "tool") {
      continue;
    }
    valid.push(msg);
  }
  return valid;
}

export async function completeChat(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: OpenAITool[];
  fetchImpl?: HelperFetch;
}): Promise<ChatTurn> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const requestBody: Record<string, unknown> = {
    model: options.model,
    messages: sanitizeMessagesForHelperApi(options.messages),
  };
  if (options.tools && options.tools.length > 0) {
    requestBody.tools = options.tools;
    requestBody.tool_choice = "auto";
  }
  const response = await fetchImpl(helperChatUrl(options.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  const raw = await response.text();
  if (!response.ok) {
    const detail = helperErrorDetail(raw);
    throw new Error(
      detail
        ? `The helper model returned HTTP ${response.status}: ${detail}`
        : `The helper model returned HTTP ${response.status}.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("The helper model returned an unreadable response.");
  }
  return turnFromResponse(json);
}

function helperErrorDetail(raw: string): string | null {
  if (!raw.trim()) {
    return null;
  }
  try {
    const json = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
    const fromError = json.error && typeof json.error.message === "string" ? json.error.message.trim() : "";
    const fromMessage = typeof json.message === "string" ? json.message.trim() : "";
    const detail = fromError || fromMessage;
    return detail || null;
  } catch {
    return null;
  }
}

function defaultFetch(): HelperFetch {
  const fetchImpl = (globalThis as { fetch?: HelperFetch }).fetch;
  if (!fetchImpl) {
    throw new Error("This environment cannot call the helper model.");
  }
  return fetchImpl;
}

function turnFromResponse(json: unknown): ChatTurn {
  if (!json || typeof json !== "object") {
    throw new Error("The helper model returned an empty response.");
  }
  const choices = (json as { choices?: unknown }).choices;
  const choice = Array.isArray(choices) ? choices[0] : null;
  const message = choice && typeof choice === "object" ? (choice as { message?: unknown }).message : null;
  if (!message || typeof message !== "object") {
    throw new Error("The helper model returned an empty response.");
  }
  const record = message as { content?: unknown; tool_calls?: unknown };
  const content = typeof record.content === "string" ? record.content : null;
  const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls.map(readToolCall).filter((call): call is ToolCall => Boolean(call)) : [];
  return { content, toolCalls };
}

function readToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { id?: unknown; function?: unknown };
  const fn = record.function;
  if (!fn || typeof fn !== "object") {
    return null;
  }
  const name = (fn as { name?: unknown }).name;
  const args = (fn as { arguments?: unknown }).arguments;
  if (typeof name !== "string" || !name.trim()) {
    return null;
  }
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : `call-${name}`,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  };
}
