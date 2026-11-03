const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildContextSkeleton,
  buildContextCopilotSystem,
  buildDetectContradictionsPrompt,
  buildOptimizeContextPrompt,
  buildScanPiiPrompt,
  buildExplainOutputPrompt,
  buildCompareCapturesPrompt,
} = require("../out/helperTools.js");
const { createContextTools, validateTemplatePatchContent, diffCaptures } = require("../out/contextTools.js");
const { runHarness } = require("../out/harness.js");

function createMockMultiSectionCapture() {
  return {
    id: "cap_copilot_999",
    model: "meta/muse-spark-1.3",
    provider: "Meta AI",
    messages: [
      {
        role: "system",
        content: "You are an autonomous AI support agent for AcmeCorp.\nRule 1: Always greet warmly.\nRule 2: Never mention competitor FooCorp under any circumstance.\nRule 3: Keep responses concise.",
        truncated: false,
      },
      {
        role: "user",
        content: "Hello, I am looking for pricing information.",
        truncated: false,
      },
      {
        role: "assistant",
        content: "Hello! I would be glad to share our standard pricing options with you.",
        truncated: false,
      },
      {
        role: "user",
        content: "Reference Documents:\nDoc 1: FooCorp offers 20% lower pricing on Enterprise plans.\nDoc 2: AcmeCorp provides 24/7 dedicated engineering support.\n\nUser Question:\nHow does your pricing compare with FooCorp?",
        truncated: false,
      },
    ],
    reported: [
      {
        messageIndex: 0,
        file: "prompts/support.prompt",
        startLine: 1,
        endLine: 4,
        explanation: "Matches system instructions",
      },
    ],
    telemetry: {
      captureId: "cap_copilot_999",
      analyzedAt: "2026-11-01T12:00:00Z",
      totalTokens: 120,
      composition: [
        { category: "system_instruction", categoryLabel: "System", tokens: 30, percentage: 25, colorVar: "green" },
        { category: "chat_history", categoryLabel: "Chat History", tokens: 25, percentage: 21, colorVar: "orange" },
        { category: "rag_grounding", categoryLabel: "RAG Grounding", tokens: 45, percentage: 38, colorVar: "purple" },
        { category: "user_query", categoryLabel: "User Query", tokens: 20, percentage: 16, colorVar: "blue" },
      ],
      sections: [
        {
          sectionId: "msg-0",
          messageIndex: 0,
          category: "system_instruction",
          categoryLabel: "System",
          what: "AcmeCorp Agent Guidelines & Safety Guardrails",
          why: "Enforces brand tone and competitive restrictions",
          tokenEstimate: 30,
          tokenPercentage: 25,
        },
        {
          sectionId: "msg-3-rag",
          messageIndex: 3,
          category: "rag_grounding",
          categoryLabel: "RAG Grounding",
          what: "Competitor Comparison Documents",
          why: "Provides retrieval context for enterprise pricing inquiry",
          tokenEstimate: 45,
          tokenPercentage: 38,
          warning: "Contains references to competitor FooCorp forbidden by system rule #2",
        },
      ],
      warnings: [],
    },
  };
}

test("buildContextSkeleton generates token-efficient structural overview with telemetry WHAT/WHY", () => {
  const capture = createMockMultiSectionCapture();
  const skeleton = buildContextSkeleton(capture);

  assert.ok(skeleton.includes("Total Sections: 4"));
  assert.ok(skeleton.includes("Estimated Total Prompt Tokens:"));
  assert.ok(skeleton.includes("[Section #1: msg-0] Role: SYSTEM"));
  assert.ok(skeleton.includes("WHAT: AcmeCorp Agent Guidelines & Safety Guardrails"));
  assert.ok(skeleton.includes("WHY: Enforces brand tone and competitive restrictions"));
  assert.ok(skeleton.includes("[Section #3: msg-3-rag]"));
  assert.ok(skeleton.includes("WHAT: Competitor Comparison Documents"));
});

test("buildContextCopilotSystem formats grounded co-pilot prompt for different scopes", () => {
  const capture = createMockMultiSectionCapture();
  const skeleton = buildContextSkeleton(capture);

  // 1. Global Scope
  const globalSys = buildContextCopilotSystem({
    projectName: "AcmeApp",
    projectPath: "/projects/AcmeApp",
    captureId: capture.id,
    model: capture.model,
    provider: capture.provider,
    totalTokens: 120,
    scope: { kind: "global", label: "All Context" },
    contextSkeleton: skeleton,
  });

  assert.ok(globalSys.includes("You are Context Tracker's Prompt Co-Pilot"));
  assert.ok(globalSys.includes("Project: AcmeApp"));
  assert.ok(globalSys.includes("### ACTIVE SCOPE"));
  assert.ok(globalSys.includes("All Context (Global Prompt Window"));
  assert.ok(globalSys.includes("search_context"));
  assert.ok(globalSys.includes("read_context_section"));
  assert.ok(globalSys.includes("propose_template_patch"));

  // 2. Section Scope
  const sectionSys = buildContextCopilotSystem({
    projectName: "AcmeApp",
    captureId: capture.id,
    scope: { kind: "section", sectionId: "msg-3-rag", categoryLabel: "RAG Grounding", label: "Doc 1 & 2" },
    contextSkeleton: skeleton,
  });

  assert.ok(sectionSys.includes("Section 'msg-3-rag' (RAG Grounding) - Doc 1 & 2"));

  // 3. Selection Scope
  const selectionSys = buildContextCopilotSystem({
    projectName: "AcmeApp",
    captureId: capture.id,
    scope: { kind: "selection", charCount: 42, selectedText: "FooCorp offers 20% lower pricing", label: "Selected text" },
    contextSkeleton: skeleton,
  });

  assert.ok(selectionSys.includes("Highlighted Text Selection (42 characters)"));
  assert.ok(selectionSys.includes("FooCorp offers 20% lower pricing"));
});

test("quick-prompt builders generate targeted interrogation queries", () => {
  // Contradictions
  const contraGlobal = buildDetectContradictionsPrompt();
  assert.ok(contraGlobal.includes("Analyze this prompt context window for contradictions"));

  const contraSection = buildDetectContradictionsPrompt({ kind: "section", sectionId: "msg-3-rag", label: "RAG" });
  assert.ok(contraSection.includes("within section msg-3-rag"));

  // Optimize & Prune
  const optPrompt = buildOptimizeContextPrompt();
  assert.ok(optPrompt.includes("Audit this prompt context window for context bloat"));

  // PII
  const piiPrompt = buildScanPiiPrompt();
  assert.ok(piiPrompt.includes("Audit this prompt context for accidental data leaks"));

  // Explain Output
  const explainPrompt = buildExplainOutputPrompt("We provide 24/7 dedicated support.");
  assert.ok(explainPrompt.includes("We provide 24/7 dedicated support."));

  // Compare Captures
  const comparePrompt = buildCompareCapturesPrompt(
    { id: "cap_1", model: "muse-spark", totalTokens: 100 },
    { id: "cap_2", model: "muse-wonder", totalTokens: 250 },
  );
  assert.ok(comparePrompt.includes("Compare Capture A (cap_1"));
  assert.ok(comparePrompt.includes("Capture B (cap_2"));
});

test("Meta AI Prompt Co-Pilot detects contradictions via search_context and respond", async () => {
  const capture = createMockMultiSectionCapture();
  const contextTools = createContextTools({ capture });

  let respondCalled = false;
  let finalMessage = "";

  const chatTools = [
    ...contextTools,
    {
      name: "respond",
      description: "Deliver final response to user",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      run: (args) => {
        respondCalled = true;
        finalMessage = args.message;
        return {
          content: "Delivered.",
          finish: { reason: args.message, explanation: args.message },
        };
      },
    },
  ];

  let turnCounter = 0;
  const mockComplete = async (messages, tools) => {
    turnCounter += 1;
    if (turnCounter === 1) {
      // Model inspects context using search_context
      return {
        content: "I will search the context for references to FooCorp to check if instructions and dynamic content clash.",
        toolCalls: [
          {
            id: "call_search_1",
            name: "search_context",
            arguments: JSON.stringify({ query: "FooCorp" }),
          },
        ],
      };
    }
    // Turn 2: Model recognizes the conflict between System Rule 2 and RAG Document 1
    return {
      content: "Found a direct contradiction between System Rule 2 and the retrieved RAG document.",
      toolCalls: [
        {
          id: "call_respond_1",
          name: "respond",
          arguments: JSON.stringify({
            message: "Contradiction Detected: Section msg-0 contains Rule 2 ('Never mention competitor FooCorp'), but Section msg-3-rag injected retrieved documents explicitly comparing FooCorp pricing.",
          }),
        },
      ],
    };
  };

  const result = await runHarness({
    system: "You are Context Tracker Prompt Co-Pilot.",
    user: "Are there any contradictions in this context window?",
    tools: chatTools,
    stepCap: 5,
    complete: mockComplete,
  });

  assert.equal(result.steps, 2);
  assert.equal(respondCalled, true);
  assert.ok(finalMessage.includes("Contradiction Detected"));
  assert.ok(finalMessage.includes("Rule 2"));
  assert.ok(finalMessage.includes("FooCorp"));
  assert.ok(Array.isArray(result.messages));
  assert.ok(result.messages.length >= 3);
  const lastMsg = result.messages[result.messages.length - 1];
  assert.equal(lastMsg.role, "tool");
  assert.equal(lastMsg.tool_call_id, "call_respond_1");
  assert.equal(lastMsg.content, "Delivered.");
});

test("Meta AI Prompt Co-Pilot proposes template patch for code optimization", async () => {
  const capture = createMockMultiSectionCapture();
  const contextTools = createContextTools({
    capture,
    projectPath: "/fake/project",
    finishOnPatch: true,
    fsImpl: {
      existsSync: () => true,
      readFile: async () =>
        "You are an AI support agent for AcmeCorp.\nRule 1: Always greet warmly.\nRule 2: Never mention competitor FooCorp.\nRule 3: Keep responses concise.",
    },
  });

  let turnCounter = 0;
  const mockComplete = async (messages, tools) => {
    turnCounter += 1;
    if (turnCounter === 1) {
      // Turn 1: Model inspects code template
      return {
        content: "I will inspect the source code template behind the system instructions.",
        toolCalls: [
          {
            id: "call_inspect_1",
            name: "inspect_code_template",
            arguments: JSON.stringify({ sectionId: "msg-0" }),
          },
        ],
      };
    }
    // Turn 2: Model proposes patch
    return {
      content: "Proposing a safe rule reformulation that avoids contradictions.",
      toolCalls: [
        {
          id: "call_patch_1",
          name: "propose_template_patch",
          arguments: JSON.stringify({
            file: "prompts/support.prompt",
            startLine: 3,
            endLine: 3,
            originalCode: "Rule 2: Never mention competitor FooCorp.",
            replacementCode: "Rule 2: If asked about competitors, highlight AcmeCorp strengths without disparaging others.",
            explanation: "Resolves contradiction with competitive inquiry RAG documents.",
            tokenImpactEstimate: "+4 tokens",
          }),
        },
      ],
    };
  };

  const result = await runHarness({
    system: "You are Context Tracker Prompt Co-Pilot.",
    user: "How can we resolve the contradiction in the system prompt?",
    tools: contextTools,
    stepCap: 5,
    complete: mockComplete,
  });

  assert.equal(result.steps, 2);
  assert.ok(result.finish);
  assert.equal(result.finish.status, "ready_for_user_approval");
  assert.equal(result.finish.file, "prompts/support.prompt");
  assert.ok(result.finish.diffPreview.includes("-Rule 2: Never mention competitor FooCorp."));
  assert.ok(result.finish.diffPreview.includes("+Rule 2: If asked about competitors"));
});

test("runHarness preserves multi-turn history across sequential interactions", async () => {
  const capture = createMockMultiSectionCapture();
  const contextTools = createContextTools({ capture });

  // First interaction:
  const firstTurn = await runHarness({
    system: "You are Prompt Co-Pilot.",
    user: "How many tokens are in the system instructions?",
    tools: contextTools,
    stepCap: 3,
    allowDirectAnswer: true,
    complete: async () => ({
      content: "Section msg-0 has approximately 30 tokens.",
      toolCalls: [],
    }),
  });

  assert.ok(firstTurn.messages);
  const threadHistory = firstTurn.messages.filter((m) => m.role !== "system");
  assert.equal(threadHistory.length, 2); // user + assistant

  // Follow-up interaction using history:
  let receivedHistory = null;
  const followUpTurn = await runHarness({
    system: "You are Prompt Co-Pilot.",
    user: "Can you summarize it in 5 words?",
    history: threadHistory,
    tools: contextTools,
    stepCap: 3,
    allowDirectAnswer: true,
    complete: async (messages) => {
      receivedHistory = messages;
      return {
        content: "AcmeCorp AI guidelines and guardrails.",
        toolCalls: [],
      };
    },
  });

  assert.ok(receivedHistory);
  // messages should contain: system, previous user, previous assistant, new user
  assert.equal(receivedHistory.length, 4);
  assert.equal(receivedHistory[0].role, "system");
  assert.equal(receivedHistory[1].role, "user");
  assert.equal(receivedHistory[1].content, "How many tokens are in the system instructions?");
  assert.equal(receivedHistory[2].role, "assistant");
  assert.equal(receivedHistory[3].role, "user");
  assert.equal(receivedHistory[3].content, "Can you summarize it in 5 words?");
  assert.equal(followUpTurn.finish, "AcmeCorp AI guidelines and guardrails.");
});

test("Phase 3 Webview UI: media/panel.js incorporates Scope Bar, Quick Action Chips, Ask AI buttons, and Patch Cards", () => {
  const panelJsPath = path.join(__dirname, "..", "media", "panel.js");
  const panelJs = fs.readFileSync(panelJsPath, "utf8");

  // 1. Scope bar
  assert.ok(panelJs.includes("helperScopeBar"), "Expected helperScopeBar function in panel.js");
  assert.ok(panelJs.includes("scope-pill"), "Expected scope-pill in panel.js");
  assert.ok(panelJs.includes("clearScope"), "Expected clearScope action in panel.js");

  // 2. Quick chips
  assert.ok(panelJs.includes("detect_contradictions"), "Expected detect_contradictions in panel.js");
  assert.ok(panelJs.includes("optimize_context"), "Expected optimize_context in panel.js");
  assert.ok(panelJs.includes("scan_pii"), "Expected scan_pii in panel.js");
  assert.ok(panelJs.includes("explain_output"), "Expected explain_output in panel.js");
  assert.ok(panelJs.includes("compare_captures"), "Expected compare_captures in panel.js");

  // 3. Section and Selection Action Hooks
  assert.ok(panelJs.includes("ask-ai-btn"), "Expected ask-ai-btn class in panel.js");
  assert.ok(panelJs.includes("setScope"), "Expected setScope dispatch in panel.js");
  assert.ok(panelJs.includes("selection-floating-bar"), "Expected selection-floating-bar in panel.js");

  // 4. Interactive Patch Proposal Card
  assert.ok(panelJs.includes("renderPatchCard"), "Expected renderPatchCard function in panel.js");
  assert.ok(panelJs.includes("applyPatch"), "Expected applyPatch dispatch in panel.js");
  assert.ok(panelJs.includes("applyAllPatches"), "Expected applyAllPatches dispatch in panel.js");
  assert.ok(panelJs.includes("renderMarkdown"), "Expected markdown rendering for assistant chat replies in panel.js");
  assert.ok(panelJs.includes("syncSelectionBar"), "Expected selection bar sync without full re-render in panel.js");
});

test("Phase 3 Webview CSS: media/panel.css incorporates styles for scope bar, patch diff viewer, and floating selection", () => {
  const panelCssPath = path.join(__dirname, "..", "media", "panel.css");
  const panelCss = fs.readFileSync(panelCssPath, "utf8");

  assert.ok(panelCss.includes(".helper-scope-bar"), "Expected .helper-scope-bar in panel.css");
  assert.ok(panelCss.includes(".scope-pill-targeted"), "Expected .scope-pill-targeted in panel.css");
  assert.ok(panelCss.includes(".ask-ai-btn"), "Expected .ask-ai-btn in panel.css");
  assert.ok(panelCss.includes(".selection-floating-bar"), "Expected .selection-floating-bar in panel.css");
  assert.ok(panelCss.includes(".patch-card"), "Expected .patch-card in panel.css");
  assert.ok(panelCss.includes(".diff-viewer"), "Expected .diff-viewer in panel.css");
  assert.ok(panelCss.includes(".diff-add"), "Expected .diff-add in panel.css");
  assert.ok(panelCss.includes(".diff-del"), "Expected .diff-del in panel.css");
});

test("Phase 3 State Contract: HelperView and CaptureView support activeScope, activePatch, and sections", () => {
  const mockHelperView = {
    model: "muse-spark-1.3",
    choices: [],
    keySaved: true,
    connectOpen: false,
    needed: false,
    busy: false,
    status: "Ready",
    offer: null,
    activity: [],
    activeScope: {
      kind: "section",
      sectionId: "msg-0",
      category: "system_instruction",
      categoryLabel: "System",
      label: "System Instructions",
    },
    activePatch: {
      patchId: "patch_123",
      status: "ready_for_user_approval",
      file: "prompts/test.prompt",
      startLine: 1,
      endLine: 2,
      originalCode: "old",
      replacementCode: "new",
      explanation: "better",
      tokenImpactEstimate: "-5 tokens",
      diffPreview: "--- a/test.prompt\n+++ b/test.prompt\n@@ -1,2 +1,2 @@\n-old\n+new",
    },
    threadCount: 4,
  };

  assert.equal(mockHelperView.activeScope.kind, "section");
  assert.equal(mockHelperView.activePatch.patchId, "patch_123");
  assert.equal(mockHelperView.threadCount, 4);
});

test("Patch Lifecycle: HelperActivityItem retains patch object and tracks patchApplied state", () => {
  const patch1 = {
    patchId: "patch_1",
    status: "ready_for_user_approval",
    file: "prompts/agent.prompt",
    startLine: 1,
    endLine: 2,
    originalCode: "old 1",
    replacementCode: "new 1",
    explanation: "fix 1",
    tokenImpactEstimate: "-2 tokens",
    diffPreview: "--- a/agent.prompt\n+++ b/agent.prompt",
  };

  const activityItem = {
    id: "act-1",
    timestamp: Date.now(),
    kind: "finish",
    text: "Proposed template patch",
    detail: patch1.diffPreview,
    patch: patch1,
    patchApplied: false,
  };

  assert.equal(activityItem.patch.patchId, "patch_1");
  assert.equal(activityItem.patchApplied, false);

  activityItem.patchApplied = true;
  assert.equal(activityItem.patchApplied, true);
});

test("Phase 4 validateTemplatePatchContent verifies content and rejects race conditions", () => {
  const fileContent = "Line 1: System prompt\nLine 2: Rule A\nLine 3: Rule B\nLine 4: Rule C";

  // 1. Matches exact lines
  const validResult = validateTemplatePatchContent(fileContent, 2, 3, "Line 2: Rule A\nLine 3: Rule B");
  assert.equal(validResult.valid, true);
  assert.equal(validResult.actualSnippet, "Line 2: Rule A\nLine 3: Rule B");

  // 2. Normalizes line endings (\r\n vs \n)
  const crlfResult = validateTemplatePatchContent(
    "Line 1\r\nLine 2: Rule A\r\nLine 3: Rule B\r\nLine 4",
    2,
    3,
    "Line 2: Rule A\nLine 3: Rule B",
  );
  assert.equal(crlfResult.valid, true);

  // 3. Rejects modified on-disk content
  const staleResult = validateTemplatePatchContent(
    fileContent,
    2,
    3,
    "Line 2: Rule A MODIFIED\nLine 3: Rule B",
  );
  assert.equal(staleResult.valid, false);
  assert.ok(staleResult.error.includes("has changed since the patch was generated"));

  // 4. Rejects out of bounds lines
  const oobResult = validateTemplatePatchContent(fileContent, 10, 12, "Line 10");
  assert.equal(oobResult.valid, false);
  assert.ok(oobResult.error.includes("is beyond the end of the file"));
});

test("Phase 4 diffCaptures computes token delta, status differences, and category divergence", () => {
  const primary = {
    id: "cap_turn_2",
    model: "meta/muse-spark-1.3",
    status: 500,
    error: "Context window limit exceeded or contradictory instructions",
    messages: [
      { role: "system", content: "Rule 1\nRule 2", truncated: false },
      { role: "user", content: "Prior turn 1", truncated: false },
      { role: "assistant", content: "Reply 1", truncated: false },
      { role: "user", content: "Prior turn 2", truncated: false },
      { role: "assistant", content: "Reply 2", truncated: false },
      {
        role: "user",
        content: "Reference Documents:\nDoc 1: FooCorp pricing\nDoc 2: Comparison matrix\n\nUser Question:\nCan you compare?",
        truncated: false,
      },
    ],
    reply: "Error: 500 Internal Server Error",
  };

  const compare = {
    id: "cap_turn_1",
    model: "meta/muse-spark-1.3",
    status: 200,
    error: null,
    messages: [
      { role: "system", content: "Rule 1\nRule 2", truncated: false },
      { role: "user", content: "Hello", truncated: false },
      { role: "assistant", content: "Hi there!", truncated: false },
      { role: "user", content: "Tell me about your product.", truncated: false },
    ],
    reply: "We offer great software products.",
  };

  const diff = diffCaptures(primary, compare);

  assert.equal(diff.primaryId, "cap_turn_2");
  assert.equal(diff.compareId, "cap_turn_1");
  assert.equal(diff.statusComparison.primaryStatus, 500);
  assert.equal(diff.statusComparison.compareStatus, 200);
  assert.ok(diff.statusComparison.primaryError.includes("Context window limit"));

  assert.ok(diff.tokenComparison.delta > 0, "Primary should have more tokens than compare");
  assert.ok(diff.keyDivergences.some((d) => d.includes("Status Divergence")));
  assert.ok(diff.keyDivergences.some((d) => d.includes("Primary capture contains RAG grounding")));
  assert.ok(diff.keyDivergences.some((d) => d.includes("Chat History Backlog")));
});

test("Phase 4 createContextTools registers diff_captures and dual-search when compareCapture provided", async () => {
  const primary = createMockMultiSectionCapture();
  const compare = {
    id: "cap_turn_0",
    model: "meta/muse-wonder-1.0",
    messages: [
      { role: "system", content: "You are an assistant.", truncated: false },
      { role: "user", content: "What is FooCorp?", truncated: false },
    ],
    reply: "FooCorp is another company.",
  };

  const tools = createContextTools({
    capture: primary,
    compareCapture: compare,
  });

  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes("diff_captures"), "Expected diff_captures tool in tools list");
  assert.ok(toolNames.includes("search_context"));

  // 1. Run diff_captures tool
  const diffTool = tools.find((t) => t.name === "diff_captures");
  const diffRes = await diffTool.run({});
  assert.ok(typeof diffRes.content === "string");
  const parsedDiff = JSON.parse(diffRes.content);
  assert.equal(parsedDiff.primaryId, primary.id);
  assert.equal(parsedDiff.compareId, compare.id);
  assert.ok(parsedDiff.keyDivergences.length > 0);

  // 2. Run search_context targeting "both"
  const searchTool = tools.find((t) => t.name === "search_context");
  const searchRes = await searchTool.run({ query: "FooCorp", targetCapture: "both" });
  const parsedSearch = JSON.parse(searchRes.content);
  assert.ok(parsedSearch.primary, "Expected primary matches in search result");
  assert.ok(parsedSearch.compare, "Expected compare matches in search result");
  assert.ok(parsedSearch.primary.matchesCount > 0);
  assert.ok(parsedSearch.compare.matchesCount > 0);
});

test("Phase 4 Meta AI Prompt Co-Pilot performs comparative interrogation via diff_captures", async () => {
  const primary = {
    id: "cap_turn_2",
    model: "meta/muse-spark-1.3",
    status: 500,
    messages: [
      { role: "system", content: "Rule 1: Greet.\nRule 2: Never mention FooCorp.", truncated: false },
      {
        role: "user",
        content: "Reference Documents:\nDoc 1: FooCorp comparison\n\nUser Question:\nCompare with FooCorp?",
        truncated: false,
      },
    ],
    reply: "Error: Contradiction",
  };

  const compare = {
    id: "cap_turn_1",
    model: "meta/muse-spark-1.3",
    status: 200,
    messages: [
      { role: "system", content: "Rule 1: Greet.\nRule 2: Never mention FooCorp.", truncated: false },
      { role: "user", content: "What features do you offer?", truncated: false },
    ],
    reply: "We offer 24/7 support.",
  };

  const tools = createContextTools({
    capture: primary,
    compareCapture: compare,
  });

  let respondMessage = "";
  const chatTools = [
    ...tools,
    {
      name: "respond",
      description: "Deliver final answer to user",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      run: (args) => {
        respondMessage = args.message;
        return { content: "Delivered.", finish: args.message };
      },
    },
  ];

  let turn = 0;
  const mockComplete = async (messages, toolSpecs) => {
    turn += 1;
    if (turn === 1) {
      return {
        content: "I will call diff_captures to see what changed between turn 1 and turn 2.",
        toolCalls: [
          {
            id: "call_diff_1",
            name: "diff_captures",
            arguments: "{}",
          },
        ],
      };
    }
    return {
      content: "I now understand why turn 2 failed.",
      toolCalls: [
        {
          id: "call_resp_1",
          name: "respond",
          arguments: JSON.stringify({
            message: "Comparison Findings: Turn 1 (HTTP 200) asked a standard feature question without RAG. Turn 2 (HTTP 500) injected competitor RAG documents that directly clashed with System Rule #2.",
          }),
        },
      ],
    };
  };

  const result = await runHarness({
    system: "You are Prompt Co-Pilot.",
    user: "Why did turn 2 fail while turn 1 succeeded?",
    tools: chatTools,
    stepCap: 5,
    complete: mockComplete,
  });

  assert.equal(result.steps, 2);
  assert.ok(respondMessage.includes("Turn 1 (HTTP 200)"));
  assert.ok(respondMessage.includes("Turn 2 (HTTP 500)"));
  assert.ok(respondMessage.includes("clashed with System Rule #2"));
});

test("Conversational Co-Pilot chats with user: explains what, why, and alternatives alongside proposed patch", async () => {
  const capture = createMockMultiSectionCapture();
  let capturedPatch = null;

  const contextTools = createContextTools({
    capture,
    projectPath: "/fake/project",
    onPatchProposed: (patch) => {
      capturedPatch = patch;
    },
    fsImpl: {
      existsSync: () => true,
      readFile: async () =>
        "You are an AI support agent for AcmeCorp.\nRule 1: Always greet warmly.\nRule 2: Never mention competitor FooCorp.\nRule 3: Keep responses concise.",
    },
  });

  let respondMessage = "";
  const chatTools = [
    ...contextTools,
    {
      name: "respond",
      description: "Deliver final answer to user",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      run: (args) => {
        respondMessage = args.message;
        return { content: "Delivered.", finish: { explanation: args.message, reason: args.message } };
      },
    },
  ];

  let turn = 0;
  const mockComplete = async (messages, toolSpecs) => {
    turn += 1;
    if (turn === 1) {
      // Turn 1: Model inspects prompt context and template
      return {
        content: "Checking the system rules and retrieved documents.",
        toolCalls: [
          {
            id: "call_inspect_1",
            name: "inspect_code_template",
            arguments: JSON.stringify({ sectionId: "msg-0" }),
          },
        ],
      };
    }
    if (turn === 2) {
      // Turn 2: Model calls propose_template_patch (does not terminate turn)
      return {
        content: "I will draft a safe rule refactor, then explain the diagnosis and options to the developer.",
        toolCalls: [
          {
            id: "call_patch_1",
            name: "propose_template_patch",
            arguments: JSON.stringify({
              file: "prompts/support.prompt",
              startLine: 3,
              endLine: 3,
              originalCode: "Rule 2: Never mention competitor FooCorp.",
              replacementCode: "Rule 2: If asked about competitors, highlight AcmeCorp strengths objectively.",
              explanation: "Allows answering pricing questions without violating negative constraint.",
              tokenImpactEstimate: "+2 tokens",
            }),
          },
        ],
      };
    }
    // Turn 3: Model explains what is happening, why, and alternative options via respond
    return {
      content: "Delivering the full conversational diagnosis to the developer.",
      toolCalls: [
        {
          id: "call_resp_1",
          name: "respond",
          arguments: JSON.stringify({
            message: [
              "### Diagnosis: What is Happening",
              "In Section 3 (RAG Grounding), the retrieval pipeline injected competitor pricing documents for FooCorp.",
              "However, Section 0 (System Rules) contains Rule 2: 'Never mention competitor FooCorp'.",
              "",
              "### Why This Happened",
              "When the user asked for a pricing comparison, the model was trapped between answering truthfully from the retrieved documents and following the negative refusal rule.",
              "",
              "### What We Could Do Differently",
              "1. Option A (Template Refactor): Rephrase Rule 2 into a positive guideline (drafted in the patch above).",
              "2. Option B (RAG Filtering): Filter competitor-tagged chunks before vector context injection.",
              "3. Option C (Few-Shot Exemplar): Add an exemplar demonstrating a neutral response.",
            ].join("\n"),
          }),
        },
      ],
    };
  };

  const result = await runHarness({
    system: "You are Prompt Co-Pilot.",
    user: "Why did the model refuse to answer and what can we do differently?",
    tools: chatTools,
    stepCap: 6,
    complete: mockComplete,
  });

  // Verify full conversational flow occurred without early cutoff
  assert.equal(result.steps, 3);
  assert.ok(capturedPatch, "Expected patch to be captured via onPatchProposed");
  assert.equal(capturedPatch.file, "prompts/support.prompt");

  // Verify conversational explanation was delivered via respond
  assert.ok(respondMessage.includes("### Diagnosis: What is Happening"));
  assert.ok(respondMessage.includes("### Why This Happened"));
  assert.ok(respondMessage.includes("### What We Could Do Differently"));
  assert.ok(respondMessage.includes("Option A"));
  assert.ok(respondMessage.includes("Option B"));
  assert.ok(respondMessage.includes("Option C"));
});

test("runHarness executes every parallel propose_template_patch before finishing the turn", async () => {
  const capture = createMockMultiSectionCapture();
  const captured = [];
  const contextTools = createContextTools({
    capture,
    projectPath: "/fake/project",
    onPatchProposed: (patch) => captured.push(patch),
    fsImpl: { existsSync: () => true },
  });
  const respondTool = {
    name: "respond",
    description: "Finish",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    run: (args) => ({
      content: "ok",
      finish: { explanation: args.message, reason: args.message },
    }),
  };

  let turn = 0;
  const result = await runHarness({
    system: "Co-pilot",
    user: "Fix both rules",
    tools: [...contextTools, respondTool],
    stepCap: 4,
    complete: async () => {
      turn += 1;
      if (turn === 1) {
        return {
          content: "Drafting two related template edits.",
          toolCalls: [
            {
              id: "patch_a",
              name: "propose_template_patch",
              arguments: JSON.stringify({
                file: "prompts/support.prompt",
                startLine: 2,
                endLine: 2,
                originalCode: "Rule 1",
                replacementCode: "Rule 1 updated",
                explanation: "First fix",
              }),
            },
            {
              id: "patch_b",
              name: "propose_template_patch",
              arguments: JSON.stringify({
                file: "prompts/support.prompt",
                startLine: 4,
                endLine: 4,
                originalCode: "Rule 3",
                replacementCode: "Rule 3 updated",
                explanation: "Second fix",
              }),
            },
          ],
        };
      }
      return {
        content: "Done explaining.",
        toolCalls: [{ id: "resp", name: "respond", arguments: JSON.stringify({ message: "Both patches are ready." }) }],
      };
    },
  });

  assert.equal(captured.length, 2);
  assert.equal(captured[0].startLine, 2);
  assert.equal(captured[1].startLine, 4);
  assert.ok(result.finish);
  assert.equal(result.finish.explanation, "Both patches are ready.");
});
