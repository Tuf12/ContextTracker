const assert = require("node:assert/strict");
const test = require("node:test");
const { buildContextCopilotSystem } = require("../out/helperTools.js");
const { createContextTools } = require("../out/contextTools.js");
const { deriveCapture, presentCapture } = require("../out/derive.js");
const { toSummary } = require("../out/store.js");

test("buildContextCopilotSystem grounds multi-hop agent loop trajectory", () => {
  const runInfo = {
    runId: "run_agent_42",
    hopIndex: 1,
    hopCount: 3,
    prevCaptureId: "cap_hop_0",
    nextCaptureId: "cap_hop_2",
    triggeringUserQuery: "Analyze revenue trends and summarize findings",
    loopRole: "tool_call",
    toolCalls: ["query_db"],
  };

  const sysPrompt = buildContextCopilotSystem({
    projectName: "RevenueAnalyzer",
    projectPath: "/projects/rev",
    captureId: "cap_hop_1",
    model: "meta/muse-spark-1.3",
    provider: "Meta AI",
    totalTokens: 2500,
    runInfo,
    runTrajectorySummary: "Loop Progression:\n- Hop 1/3: ~1200 tokens\n- Hop 2/3: ~2500 tokens\n- Hop 3/3: ~3200 tokens",
  });

  assert.ok(sysPrompt.includes("### MULTI-HOP AGENT LOOP GROUNDING"));
  assert.ok(sysPrompt.includes("Run ID: run_agent_42"));
  assert.ok(sysPrompt.includes("Analyze revenue trends and summarize findings"));
  assert.ok(sysPrompt.includes("Hop 2 of 3"));
  assert.ok(sysPrompt.includes("inspect_run_trajectory"));
});

test("createContextTools exposes inspect_run_trajectory tool when multi-hop capture is active", async () => {
  const runInfo = {
    runId: "run_agent_42",
    hopIndex: 1,
    hopCount: 3,
    prevCaptureId: "cap_hop_0",
    nextCaptureId: "cap_hop_2",
    triggeringUserQuery: "Analyze revenue trends",
    loopRole: "tool_call",
    toolCalls: ["query_db"],
  };

  const capture = {
    id: "cap_hop_1",
    run: runInfo,
    messages: [
      { role: "user", content: "Analyze revenue trends" },
      { role: "assistant", content: "I will query the database." },
    ],
  };

  const mockTrajectory = {
    runId: "run_agent_42",
    totalHops: 3,
    currentHop: 2,
    triggeringUserQuery: "Analyze revenue trends",
    tokenGrowth: {
      initialTokens: 1200,
      currentTokens: 2500,
      deltaTokens: 1300,
      growthPercent: 108,
    },
    hops: [
      {
        hopIndex: 0,
        captureId: "cap_hop_0",
        createdAt: "2026-11-04T12:00:00Z",
        model: "meta/muse-spark-1.3",
        estimatedTokens: 1200,
        status: 200,
        loopRole: "initial",
        replyPreview: "I will query...",
        isCurrent: false,
      },
      {
        hopIndex: 1,
        captureId: "cap_hop_1",
        createdAt: "2026-11-04T12:00:05Z",
        model: "meta/muse-spark-1.3",
        estimatedTokens: 2500,
        status: 200,
        loopRole: "tool_call",
        toolCalls: ["query_db"],
        replyPreview: "Results found...",
        isCurrent: true,
      },
    ],
  };

  const tools = createContextTools({
    capture,
    getRunTrajectory: () => mockTrajectory,
  });

  const trajectoryTool = tools.find((t) => t.name === "inspect_run_trajectory");
  assert.ok(trajectoryTool, "inspect_run_trajectory tool should be registered");

  const result = await trajectoryTool.run({});
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.runId, "run_agent_42");
  assert.equal(parsed.totalHops, 3);
  assert.equal(parsed.currentHop, 2);
  assert.equal(parsed.tokenGrowth.deltaTokens, 1300);
  assert.equal(parsed.hops.length, 2);
});

test("deriveCapture and presentCapture preserve run metadata", () => {
  const runInfo = {
    runId: "run_test_99",
    hopIndex: 0,
    hopCount: 2,
    triggeringUserQuery: "Test query",
  };

  const stored = {
    id: "cap_1",
    run: runInfo,
    clientRequestId: null,
    projectPath: "/proj",
    createdAt: new Date().toISOString(),
    provider: "openai",
    upstream: "https://api.openai.com",
    endpoint: "/v1/chat/completions",
    model: "gpt-4o",
    status: 200,
    error: null,
    messages: [{ role: "user", content: "Test query", truncated: false }],
    reply: "Test reply",
    reported: [],
  };

  const view = deriveCapture(stored, null);
  assert.deepEqual(view.run, runInfo);

  const presented = presentCapture(view);
  assert.deepEqual(presented.run, runInfo);
});

test("toSummary preserves run metadata", () => {
  const runInfo = {
    runId: "run_test_88",
    hopIndex: 1,
    hopCount: 2,
    prevCaptureId: "cap_prev",
    nextCaptureId: null,
    triggeringUserQuery: "What is the capital of France?",
    loopRole: "final",
  };

  const stored = {
    id: "cap_2",
    run: runInfo,
    clientRequestId: null,
    projectPath: "/proj",
    createdAt: new Date().toISOString(),
    provider: "openai",
    upstream: "https://api.openai.com",
    endpoint: "/v1/chat/completions",
    model: "gpt-4o",
    status: 200,
    error: null,
    messages: [{ role: "user", content: "What is the capital of France?", truncated: false }],
    reply: "Paris",
    reported: [],
  };

  const summary = toSummary(stored);
  assert.deepEqual(summary.run, runInfo);
});
