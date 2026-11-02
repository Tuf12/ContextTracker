import type { ChatMessage, ChatTurn, OpenAITool, OpenAIToolCall } from "./helperClient";

export type HelperTool<T> = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: unknown) => { content: string; finish?: T } | Promise<{ content: string; finish?: T }>;
};

export type HarnessResult<T> = {
  finish: T | null;
  steps: number;
  messages?: ChatMessage[];
};

export type HarnessEvent<T> =
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; toolName: string; args: unknown }
  | { kind: "tool_result"; toolName: string; content: string; isFinish: boolean }
  | { kind: "finish"; finish: T };

export async function runHarness<T>(options: {
  system: string;
  user: string;
  tools: Array<HelperTool<T>>;
  stepCap: number;
  complete: (messages: ChatMessage[], tools: OpenAITool[]) => Promise<ChatTurn>;
  onTool?: (name: string) => void;
  onEvent?: (event: HarnessEvent<T>) => void;
  allowDirectAnswer?: boolean;
  history?: ChatMessage[];
}): Promise<HarnessResult<T>> {
  const specs = options.tools.map(openAITool);
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    ...(options.history || []),
    { role: "user", content: options.user },
  ];
  let steps = 0;
  while (steps < options.stepCap) {
    steps += 1;
    const turn = await options.complete(messages, specs);
    if (turn.content && turn.content.trim()) {
      options.onEvent?.({ kind: "thought", text: turn.content.trim() });
    }
    if (turn.toolCalls.length === 0) {
      if (options.allowDirectAnswer && turn.content && turn.content.trim()) {
        return {
          finish: turn.content as unknown as T,
          steps,
          messages: [...messages, { role: "assistant", content: turn.content }],
        };
      }
      messages.push({ role: "assistant", content: turn.content });
      messages.push({ role: "user", content: "Call a tool. Finish by calling the finish tool." });
      continue;
    }
    const calls: OpenAIToolCall[] = turn.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
    messages.push({ role: "assistant", content: turn.content, tool_calls: calls });
    for (const call of turn.toolCalls) {
      options.onTool?.(call.name);
      let parsedArgs: unknown = call.arguments;
      try {
        parsedArgs = JSON.parse(call.arguments);
      } catch {
        // keep string
      }
      options.onEvent?.({ kind: "tool_call", toolName: call.name, args: parsedArgs });
      const outcome = await runCall(options.tools, call.name, call.arguments);
      options.onEvent?.({
        kind: "tool_result",
        toolName: call.name,
        content: outcome.content,
        isFinish: outcome.finish !== undefined,
      });
      if (outcome.finish !== undefined) {
        options.onEvent?.({ kind: "finish", finish: outcome.finish });
        return { finish: outcome.finish, steps, messages };
      }
      messages.push({ role: "tool", content: outcome.content, tool_call_id: call.id });
    }
  }
  return { finish: null, steps, messages };
}

async function runCall<T>(
  tools: Array<HelperTool<T>>,
  name: string,
  rawArgs: string,
): Promise<{ content: string; finish?: T }> {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    return { content: `Unknown tool ${name}.` };
  }
  let args: unknown;
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { content: "Arguments were not valid JSON." };
  }
  return await tool.run(args);
}

function openAITool<T>(tool: HelperTool<T>): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
