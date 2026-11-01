import { deriveMessageSpans } from "./matcher";
import { readableReply } from "./parse";
import type { CaptureView, ProjectIndex, StoredCapture, ViewMessage } from "./types";

const ROLE_LABELS: Record<string, string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tools: "Tool definitions",
  tool: "Tool result",
  request: "Request",
};

export function deriveCapture(capture: StoredCapture, index: ProjectIndex | null): CaptureView {
  const telemetry = capture.telemetry;
  const messages: ViewMessage[] = capture.messages.map((message, messageIndex) => {
    const reported = (capture.reported ?? []).filter((span) => {
      if (span.messageIndex === undefined) {
        return Boolean(span.quote) || messageIndex === 0;
      }
      return span.messageIndex === messageIndex;
    });
    const spans = deriveMessageSpans(message.content, message.role, index, reported).map((span, spanIndex) => ({
      ...span,
      id: `${messageIndex}-${spanIndex}`,
    }));
    const messageTelemetry = telemetry?.sections.find(
      (sec) => sec.messageIndex === messageIndex || sec.messageIndices?.includes(messageIndex),
    );
    return {
      role: message.role,
      roleLabel: ROLE_LABELS[message.role] ?? message.role,
      truncated: message.truncated,
      spans,
      telemetry: messageTelemetry,
    };
  });
  const reply = readableReply(capture.reply);
  const promptChars = capture.messages.reduce((sum, message) => sum + message.content.length, 0);
  const fileSpanCount = messages.reduce(
    (sum, message) => sum + message.spans.filter((span) => span.kind === "file").length,
    0,
  );
  return {
    id: capture.id,
    createdAt: capture.createdAt,
    model: capture.model,
    provider: capture.provider,
    upstream: capture.upstream,
    endpoint: capture.endpoint,
    status: capture.status,
    error: capture.error,
    estimatedTokens: Math.round(promptChars / 4),
    replyEstimatedTokens: Math.round(reply.length / 4),
    messages,
    reply,
    fileSpanCount,
    telemetry,
  };
}

export function presentCapture(capture: CaptureView): CaptureView {
  return {
    ...capture,
    telemetry: capture.telemetry,
    messages: capture.messages.map((message) => ({
      ...message,
      spans: message.spans.map((span) => {
        const copy = { ...span };
        delete copy.absolutePath;
        return copy;
      }),
    })),
  };
}
