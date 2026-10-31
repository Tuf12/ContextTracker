import type { ChatMessage, ChatTurn, OpenAITool, OpenAIToolCall } from "./helperClient";

export type HelperTool<T> = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: unknown) => { content: string; finish?: T };
};

export type HarnessResult<T> = {
  finish: T | null;
  steps: number;
};

export async function runHarness<T>(options: {
  system: string;
  user: string;
  tools: Array<HelperTool<T>>;
  stepCap: number;
  complete: (messages: ChatMessage[], tools: OpenAITool[]) => Promise<ChatTurn>;
  onTool?: (name: string) => void;
}): Promise<HarnessResult<T>> {
  const specs = options.tools.map(openAITool);
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.user },
  ];
  let steps = 0;
  while (steps < options.stepCap) {
    steps += 1;
    const turn = await options.complete(messages, specs);
    if (turn.toolCalls.length === 0) {
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
      const outcome = runCall(options.tools, call.name, call.arguments);
      if (outcome.finish !== undefined) {
        return { finish: outcome.finish, steps };
      }
      messages.push({ role: "tool", content: outcome.content, tool_call_id: call.id });
    }
  }
  return { finish: null, steps };
}

function runCall<T>(tools: Array<HelperTool<T>>, name: string, rawArgs: string): { content: string; finish?: T } {
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
  return tool.run(args);
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
