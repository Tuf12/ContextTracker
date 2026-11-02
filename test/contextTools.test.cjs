const assert = require("node:assert/strict");
const test = require("node:test");
const {
  searchContext,
  readContextSection,
  inspectCodeTemplate,
  proposeTemplatePatch,
  generateDiffPreview,
  createContextTools,
} = require("../out/contextTools.js");

function createSampleCapture() {
  return {
    id: "cap_test_123",
    messages: [
      {
        role: "system",
        content: "You are an AI support agent for AcmeCorp.\nRule 1: Always greet warmly.\nRule 2: Never mention competitor FooCorp under any circumstance.\nRule 3: Keep answers brief.",
        truncated: false,
      },
      {
        role: "user",
        content: "Hi, I need help with my account.",
        truncated: false,
      },
      {
        role: "assistant",
        content: "Hello! I'd be happy to assist you with your account today.",
        truncated: false,
      },
      {
        role: "user",
        content: "Retrieved Context:\nDocument 1: FooCorp pricing comparison guide.\nDocument 2: AcmeCorp standard policy.\n\nUser Question:\nCan you compare your pricing with FooCorp?",
        truncated: false,
      },
    ],
    reported: [
      {
        messageIndex: 0,
        file: "prompts/system_agent.prompt",
        startLine: 1,
        endLine: 4,
        explanation: "Matches system instruction template",
      },
    ],
  };
}

test("searchContext returns empty matches for blank query", () => {
  const capture = createSampleCapture();
  const res = searchContext({ capture, query: "   " });
  assert.equal(res.matchesCount, 0);
  assert.deepEqual(res.matches, []);
});

test("searchContext searches across sections and returns matching lines with snippets", () => {
  const capture = createSampleCapture();
  const res = searchContext({ capture, query: "FooCorp" });
  assert.ok(res.matchesCount >= 2, `Expected at least 2 matches for FooCorp, got ${res.matchesCount}`);
  assert.ok(res.matches.some((m) => m.sectionId === "msg-0" && m.line === 3));
  assert.ok(res.matches.some((m) => m.snippet.includes("FooCorp")));
});

test("searchContext supports regex search syntax /pattern/i", () => {
  const capture = createSampleCapture();
  const res = searchContext({ capture, query: "/rule \\d+:/i" });
  assert.equal(res.matchesCount, 3);
  assert.equal(res.matches[0].line, 2);
  assert.ok(res.matches[0].snippet.includes("Rule 1:"));
});

test("searchContext restricts search to specified sectionId", () => {
  const capture = createSampleCapture();
  const res = searchContext({ capture, query: "FooCorp", sectionId: "msg-0" });
  assert.equal(res.matchesCount, 1);
  assert.equal(res.matches[0].sectionId, "msg-0");
  assert.equal(res.matches[0].line, 3);
});

test("readContextSection retrieves verbatim content with paging and line clamping", () => {
  const capture = createSampleCapture();
  const full = readContextSection({ capture, sectionId: "msg-0" });
  assert.equal(full.sectionId, "msg-0");
  assert.equal(full.role, "system");
  assert.equal(full.category, "system_instruction");
  assert.equal(full.totalLines, 4);
  assert.equal(full.startLine, 1);
  assert.equal(full.endLine, 4);
  assert.ok(full.content.includes("AcmeCorp"));

  // Paged slice
  const paged = readContextSection({ capture, sectionId: "msg-0", startLine: 2, maxLines: 2 });
  assert.equal(paged.startLine, 2);
  assert.equal(paged.endLine, 3);
  assert.equal(paged.content.split("\n").length, 2);
  assert.ok(paged.content.includes("Rule 1:"));
  assert.ok(paged.content.includes("Rule 2:"));
});

test("readContextSection throws descriptive error when section is not found", () => {
  const capture = createSampleCapture();
  assert.throws(
    () => readContextSection({ capture, sectionId: "nonexistent_sec" }),
    /Section 'nonexistent_sec' was not found in the current prompt context/,
  );
});

test("inspectCodeTemplate returns attributed template info with dynamic variables", async () => {
  const capture = createSampleCapture();
  const mockTemplateFile = "You are an AI support agent for {{ company_name }}.\nRule 1: Always greet warmly.\nRule 2: Never mention competitor {{ competitor }} under any circumstance.\nRule 3: Keep answers brief.";

  const res = await inspectCodeTemplate({
    capture,
    sectionId: "msg-0",
    projectPath: "/fake/project",
    fsImpl: {
      existsSync: (p) => p.includes("system_agent.prompt"),
      readFile: async () => mockTemplateFile,
    },
  });

  assert.equal(res.attributed, true);
  assert.equal(res.file, "prompts/system_agent.prompt");
  assert.equal(res.templateType, "prompt_file");
  assert.equal(res.startLine, 1);
  assert.equal(res.endLine, 4);
  assert.ok(res.templateSource.includes("{{ company_name }}"));
  assert.ok(Array.isArray(res.runtimeInterpolations));
  assert.ok(res.runtimeInterpolations.some((v) => v.variable === "company_name"));
  assert.ok(res.runtimeInterpolations.some((v) => v.variable === "competitor"));
});

test("inspectCodeTemplate handles unattributed sections gracefully", async () => {
  const capture = createSampleCapture();
  const res = await inspectCodeTemplate({
    capture,
    sectionId: "msg-3-query",
  });
  assert.equal(res.attributed, false);
  assert.ok(res.explanation.includes("not yet been attributed"));
});

test("generateDiffPreview outputs clean unified diff format", () => {
  const diff = generateDiffPreview(
    "prompts/test.prompt",
    12,
    "Rule 2: Never mention competitor FooCorp.\nRule 2b: Say no.",
    "Rule 2: If asked about competitors, politely refer to standard policy.",
  );

  assert.ok(diff.startsWith("--- a/prompts/test.prompt\n+++ b/prompts/test.prompt"));
  assert.ok(diff.includes("@@ -12,2 +12,1 @@"));
  assert.ok(diff.includes("-Rule 2: Never mention competitor FooCorp."));
  assert.ok(diff.includes("-Rule 2b: Say no."));
  assert.ok(diff.includes("+Rule 2: If asked about competitors, politely refer to standard policy."));
});

test("proposeTemplatePatch validates relative path safety against path traversal", async () => {
  await assert.rejects(
    () =>
      proposeTemplatePatch({
        file: "../../../etc/passwd",
        startLine: 1,
        endLine: 1,
        originalCode: "root",
        replacementCode: "hacked",
        explanation: "attack",
      }),
    /must be a relative path within the workspace root/,
  );

  await assert.rejects(
    () =>
      proposeTemplatePatch({
        file: "/var/log/syslog",
        startLine: 1,
        endLine: 1,
        originalCode: "x",
        replacementCode: "y",
        explanation: "attack",
      }),
    /must be a relative path within the workspace root/,
  );
});

test("proposeTemplatePatch builds complete proposal with unique patchId", async () => {
  const proposal = await proposeTemplatePatch({
    file: "prompts/system_agent.prompt",
    startLine: 3,
    endLine: 3,
    originalCode: "Rule 2: Never mention competitor FooCorp under any circumstance.",
    replacementCode: "Rule 2: Focus on AcmeCorp's strengths without mentioning competitors.",
    explanation: "Rephrases negative constraint into constructive instruction.",
    tokenImpactEstimate: "-2 tokens",
    projectPath: "/fake/project",
    fsImpl: {
      existsSync: () => true,
    },
  });

  assert.ok(proposal.patchId.startsWith("patch_"));
  assert.equal(proposal.status, "ready_for_user_approval");
  assert.equal(proposal.file, "prompts/system_agent.prompt");
  assert.equal(proposal.tokenImpactEstimate, "-2 tokens");
  assert.ok(proposal.diffPreview.includes("-Rule 2: Never mention competitor FooCorp"));
  assert.ok(proposal.diffPreview.includes("+Rule 2: Focus on AcmeCorp's strengths"));
});

test("createContextTools registers the four context sensory tools with runnable handlers", async () => {
  const capture = createSampleCapture();
  const tools = createContextTools({ capture });

  assert.equal(tools.length, 4);
  const toolNames = tools.map((t) => t.name);
  assert.deepEqual(toolNames, [
    "search_context",
    "read_context_section",
    "inspect_code_template",
    "propose_template_patch",
  ]);

  // Run search_context tool
  const searchTool = tools.find((t) => t.name === "search_context");
  const searchRes = await searchTool.run({ query: "AcmeCorp" });
  assert.ok(typeof searchRes.content === "string");
  const searchParsed = JSON.parse(searchRes.content);
  assert.ok(searchParsed.matchesCount > 0);

  // Run read_context_section tool
  const readTool = tools.find((t) => t.name === "read_context_section");
  const readRes = await readTool.run({ sectionId: "msg-0", startLine: 1, maxLines: 2 });
  assert.ok(typeof readRes.content === "string");
  const readParsed = JSON.parse(readRes.content);
  assert.equal(readParsed.sectionId, "msg-0");
  assert.equal(readParsed.endLine, 2);

  // Run propose_template_patch tool
  const patchTool = tools.find((t) => t.name === "propose_template_patch");
  const patchRes = await patchTool.run({
    file: "prompts/system.prompt",
    startLine: 1,
    endLine: 2,
    originalCode: "Line 1\nLine 2",
    replacementCode: "New Line 1",
    explanation: "Shorten prompt",
  });
  assert.ok(patchRes.finish);
  assert.equal(patchRes.finish.file, "prompts/system.prompt");
  assert.ok(patchRes.content.includes("Template patch proposal created successfully"));
});
