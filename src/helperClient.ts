export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

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
    messages: options.messages,
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
    throw new Error(`The helper model returned HTTP ${response.status}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("The helper model returned an unreadable response.");
  }
  return turnFromResponse(json);
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
