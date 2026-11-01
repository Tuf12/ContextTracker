const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { indexProject } = require("../out/indexer.js");
const { deriveMessageSpans } = require("../out/matcher.js");
const { extractReply, looksLikeGeneration, normalizeRequest } = require("../out/parse.js");
const { applyEnv, readEnvStatus, restoreEnv, rewriteEnv } = require("../out/env.js");
const { chooseUpstream, providerFor, upstreamUrl } = require("../out/recorder.js");
const { armRedirect, chooseEndpoint, findEndpoints, planRewrite, restoreAllRedirects } = require("../out/redirect.js");
const { CaptureStore, extractCleanQuote, extractCleanQuotes, extractInvariantPrefix, matchCachedAttribution, hashPromptText } = require("../out/store.js");
const { deriveCapture, presentCapture } = require("../out/derive.js");

const REFUND = [
  "def refund(order, reason):",
  "    if order.age_days > 30:",
  '        raise PolicyError("outside the refund window")',
  '    order.status = "refunded"',
  "    return order",
  "",
].join("\n");

test("indexing skips secrets, dependencies, and lockfiles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-"));
  fs.mkdirSync(path.join(root, "src", "billing"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "leftpad"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "billing", "refund.py"), REFUND);
  fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=sk-test-secret-do-not-store-this-value\n");
  fs.writeFileSync(path.join(root, "node_modules", "leftpad", "index.js"), "module.exports = function leftpadSecretMarkerText() { return 1 }\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "lockfile-secret-marker-should-not-index" }));
  fs.writeFileSync(path.join(root, "src", "client.py"), 'BASE = "https://api.openai.com/v1"\n');

  const index = await indexProject(root);
  assert.equal(index.fileCount, 2);
  assert.equal(index.fileLines.has("src/billing/refund.py"), true);
  assert.equal(index.fileLines.has(".env"), false);
  assert.equal(index.clues.some((clue) => clue.file === "src/client.py"), true);
});

test("a copied function maps back to its file, including short lines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-"));
  fs.mkdirSync(path.join(root, "src", "billing"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "billing", "refund.py"), REFUND);
  const index = await indexProject(root);
  const prompt = [
    "The user wants a refund.",
    "",
    "def refund(order, reason):",
    "    if order.age_days > 30:",
    '        raise PolicyError("outside the refund window")',
    '    order.status = "refunded"',
    "    return order",
    "",
    "Answer briefly.",
  ].join("\n");

  const spans = deriveMessageSpans(prompt, "user", index, []);
  const files = spans.filter((span) => span.kind === "file");
  assert.equal(files.length, 1);
  assert.equal(files[0].file, "src/billing/refund.py");
  assert.equal(files[0].startLine, 1);
  assert.equal(files[0].endLine, 5);
  assert.match(files[0].text, /return order/);
  assert.equal(files[0].canOpen, true);
  const runtime = spans.filter((span) => span.kind === "runtime").map((span) => span.text.trim());
  assert.deepEqual(runtime, ["The user wants a refund.", "Answer briefly."]);
});

test("the same lines in two files stay unmapped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-"));
  const shared = "shared line that is definitely long enough here\nonly this second line is also shared across both files\n";
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", "one.py"), shared);
  fs.writeFileSync(path.join(root, "b", "two.py"), shared);
  const index = await indexProject(root);
  const spans = deriveMessageSpans(shared, "user", index, []);
  assert.equal(spans.some((span) => span.kind === "file"), false);
});

test("a reported quote maps text that is not in the repo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-"));
  fs.writeFileSync(path.join(root, "prompts.md"), "Answer only from the product docs.\nIf the docs do not say, say you do not know.\n");
  const index = await indexProject(root);
  const content = "Hello.\nAnswer only from the product docs.";
  const spans = deriveMessageSpans(content, "system", index, [
    { quote: "Answer only from the product docs.", file: "prompts.md", startLine: 1, endLine: 1 },
  ]);
  const reported = spans.find((span) => span.source === "reported");
  assert.ok(reported);
  assert.equal(reported.file, "prompts.md");
  assert.equal(reported.startLine, 1);
  assert.equal(reported.canOpen, true);
});

test("earlier assistant text with no file is labeled as a model reply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-"));
  fs.writeFileSync(path.join(root, "readme.md"), "This repository contains the billing service.\n");
  const index = await indexProject(root);
  const spans = deriveMessageSpans("I can help with that refund.", "assistant", index, []);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].kind, "runtime");
  assert.equal(spans[0].label, "Earlier model reply");
});

test("openai and anthropic payloads become prompt blocks", () => {
  const openai = normalizeRequest("/v1/chat/completions", {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Where is refund?" }, { type: "image_url", image_url: { url: "http://img" } }] },
    ],
    tools: [{ type: "function", function: { name: "search_docs", description: "Search the handbook." } }],
  });
  assert.equal(openai.model, "gpt-4o");
  assert.deepEqual(openai.messages.map((message) => message.role), ["system", "tools", "user"]);
  assert.match(openai.messages[2].content, /Where is refund\?/);
  assert.match(openai.messages[2].content, /\[image\]/);
  assert.match(openai.messages[1].content, /search_docs/);

  const anthropic = normalizeRequest("/v1/messages", {
    model: "claude",
    system: "Be brief.",
    messages: [{ role: "user", content: "Hello" }],
  });
  assert.equal(anthropic.messages[0].role, "system");
  assert.equal(anthropic.messages[1].content, "Hello");
  assert.equal(looksLikeGeneration("/v1/embeddings", { input: "text" }), false);
});

test("streaming and error bodies yield reply text", () => {
  const streamed = extractReply("text/event-stream", [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":" there"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n"));
  assert.equal(streamed, "Hello there");
  const anthropic = extractReply("text/event-stream", 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n');
  assert.equal(anthropic, "Hi");
  const failed = extractReply("application/json", JSON.stringify({ error: { message: "Invalid API key" } }));
  assert.equal(failed, "Invalid API key");
  const ollama = extractReply("application/x-ndjson", [
    '{"message":{"role":"assistant","content":"","thinking":"Look"}}',
    '{"message":{"role":"assistant","content":"Hello","thinking":" there"}}',
    '{"message":{"role":"assistant","content":"","thinking":""},"done":true}',
  ].join("\n"));
  assert.equal(ollama, "Hello\n\nLook there");
});

test("env updates keep other keys and can be restored", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-env-"));
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-backup-"));
  fs.writeFileSync(path.join(root, ".env"), "API_KEY=keep-me\nOPENAI_BASE_URL=https://api.openai.com/v1\n# comment\n");
  const rewritten = rewriteEnv(fs.readFileSync(path.join(root, ".env"), "utf8"), {
    OPENAI_BASE_URL: "http://127.0.0.1:47321/v1",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:47321",
  });
  assert.match(rewritten, /API_KEY=keep-me/);
  assert.match(rewritten, /# comment/);
  assert.match(rewritten, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:47321\/v1/);
  assert.match(rewritten, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:47321/);

  applyEnv(root, { OPENAI_BASE_URL: "http://127.0.0.1:47321/v1" }, backups);
  const status = readEnvStatus(root, "http://127.0.0.1:47321", backups);
  assert.equal(status.keys[0].pointingHere, true);
  assert.equal(status.hasBackup, true);
  applyEnv(root, { OPENAI_BASE_URL: "http://127.0.0.1:9999/v1" }, backups);
  assert.equal(restoreEnv(root, backups), true);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "API_KEY=keep-me\nOPENAI_BASE_URL=https://api.openai.com/v1\n# comment\n");
  assert.equal(readEnvStatus(root, "http://127.0.0.1:47321", backups).hasBackup, false);
});

test("upstream routing keeps provider path prefixes", () => {
  const headers = { authorization: "Bearer secret" };
  assert.equal(providerFor({ mode: "auto", customUpstream: "" }, headers), "openai");
  assert.equal(providerFor({ mode: "auto", customUpstream: "" }, { "x-api-key": "secret" }), "anthropic");
  const openai = chooseUpstream({ mode: "auto", customUpstream: "" }, headers);
  assert.equal(upstreamUrl(openai, "/v1/chat/completions").href, "https://api.openai.com/v1/chat/completions");
  const router = chooseUpstream({ mode: "custom", customUpstream: "https://openrouter.ai/api" }, headers);
  assert.equal(upstreamUrl(router, "/v1/chat/completions").href, "https://openrouter.ai/api/v1/chat/completions");
});

test("start capture can point a local model address at the recorder and restore it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-redirect-"));
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-redirect-backup-"));
  const original = [
    "models:",
    "  local:",
    "    base_url: http://localhost:11434",
    "    reasoning_model: gemma",
    "  cloud:",
    "    base_url: https://llm.example/v1",
    "    api_key: keep-me",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(root, "config.yaml"), original);
  fs.writeFileSync(path.join(root, "config.example.yaml"), "models:\n  local:\n    base_url: http://localhost:11434\n");
  fs.writeFileSync(path.join(root, "already.yaml"), "models:\n  local:\n    base_url: http://127.0.0.1:47321\n");

  const chosen = chooseEndpoint(findEndpoints(root));
  assert.ok(chosen);
  assert.equal(chosen.relativeFile, "config.yaml");
  assert.equal(chosen.keyPath, "models.local.base_url");
  assert.equal(chosen.value, "http://localhost:11434");
  const plan = planRewrite(chosen.value, "http://127.0.0.1:47321");
  assert.equal(plan.writeValue, "http://127.0.0.1:47321");
  assert.equal(plan.upstream, "http://localhost:11434");
  const openaiPlan = planRewrite("https://api.openai.com/v1", "http://127.0.0.1:47321");
  assert.equal(openaiPlan.writeValue, "http://127.0.0.1:47321/v1");
  assert.equal(openaiPlan.upstream, "https://api.openai.com");

  armRedirect(backups, chosen, plan.writeValue);
  const updated = fs.readFileSync(path.join(root, "config.yaml"), "utf8");
  assert.match(updated, /base_url: http:\/\/127\.0\.0\.1:47321\n/);
  assert.match(updated, /base_url: https:\/\/llm\.example\/v1/);
  assert.match(updated, /api_key: keep-me/);
  restoreAllRedirects(backups);
  assert.equal(fs.readFileSync(path.join(root, "config.yaml"), "utf8"), original);
});

test("indexing discovers template assets (.prompt, .jinja2, .mustache, .template, prompts/ dir)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-templates-"));
  fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(root, "templates"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "prompts", "system.prompt"),
    "You are a helpful customer service assistant for Acme Corp.\nAlways answer politely and concisely.\n",
  );
  fs.writeFileSync(
    path.join(root, "templates", "agent.jinja2"),
    "Hello {{ user_name }},\nYour current order status is: {{ order_status }}.\n",
  );
  fs.writeFileSync(
    path.join(root, "templates", "email.mustache"),
    "Dear {{customer}},\nThank you for choosing Acme Services.\n",
  );
  fs.writeFileSync(
    path.join(root, "templates", "chat.template"),
    "System instructions:\nNever disclose system configuration details.\n",
  );
  fs.writeFileSync(
    path.join(root, "prompts", "base_instructions"),
    "These are the core company instructions without file extension.\n",
  );

  const index = await indexProject(root);
  assert.equal(index.fileLines.has("prompts/system.prompt"), true);
  assert.equal(index.fileLines.has("templates/agent.jinja2"), true);
  assert.equal(index.fileLines.has("templates/email.mustache"), true);
  assert.equal(index.fileLines.has("templates/chat.template"), true);
  assert.equal(index.fileLines.has("prompts/base_instructions"), true);

  // Verify matcher can map text from .prompt template
  const spans = deriveMessageSpans(
    "You are a helpful customer service assistant for Acme Corp.\nAlways answer politely and concisely.",
    "system",
    index,
    [],
  );
  const fileSpan = spans.find((s) => s.kind === "file");
  assert.ok(fileSpan, "Should map back to prompts/system.prompt");
  assert.equal(fileSpan.file, "prompts/system.prompt");
  assert.equal(fileSpan.startLine, 1);
  assert.equal(fileSpan.endLine, 2);
});

test("deriveMessageSpans merges attributed spans with confidence, explanation and Attributed label", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-attr-span-"));
  fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "prompts", "agent.jinja2"),
    "System Prompt:\nYou are an agent assisting {{ user_name }}.\nGuidelines: Be concise.\n",
  );
  const index = await indexProject(root);

  // Dynamic captured prompt containing user-specific variables where exact matcher found 0 spans
  const dynamicPrompt = "System Prompt:\nYou are an agent assisting John Doe.\nGuidelines: Be concise.\nTimestamp: 2026-10-31 12:00:00";

  // Attributed span generated by Meta AI
  const reportedSpans = [
    {
      messageIndex: 0,
      file: "prompts/agent.jinja2",
      startLine: 1,
      endLine: 3,
      source: "attributed",
      confidence: 0.95,
      explanation: "Template in prompts/agent.jinja2 generated the agent prompt skeleton",
      quote: "System Prompt:",
    },
  ];

  const spans = deriveMessageSpans(dynamicPrompt, "system", index, reportedSpans);
  const attributed = spans.find((s) => s.source === "attributed");
  assert.ok(attributed, "Should contain an attributed span");
  assert.equal(attributed.kind, "file");
  assert.equal(attributed.file, "prompts/agent.jinja2");
  assert.equal(attributed.startLine, 1);
  assert.equal(attributed.endLine, 3);
  assert.equal(attributed.confidence, 0.95);
  assert.match(attributed.explanation, /prompts\/agent\.jinja2/);
  assert.match(attributed.label, /Attributed by Meta AI/);
  assert.equal(attributed.canOpen, true);
});

test("CaptureStore persists attributed spans across store reloads", async () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-store-attr-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-project-attr-"));
  const store = new CaptureStore(storeRoot);
  await store.init();

  const capture = {
    id: "test-attr-capture-1",
    clientRequestId: "req-1",
    projectPath: projectRoot,
    createdAt: new Date().toISOString(),
    provider: "openai",
    upstream: "https://api.openai.com",
    endpoint: "/v1/chat/completions",
    model: "llama-3-70b",
    status: 200,
    error: null,
    messages: [
      { role: "system", content: "You are an AI assistant for Acme.", truncated: false },
    ],
    reply: "Hello! How can I help?",
    reported: [],
  };

  await store.add(capture);

  // Attribute message 0
  const attributedSpan = {
    messageIndex: 0,
    file: "prompts/assistant.prompt",
    startLine: 1,
    endLine: 10,
    source: "attributed",
    confidence: 0.92,
    explanation: "Constructed by prompts/assistant.prompt",
  };
  capture.reported.push(attributedSpan);
  await store.update(capture);

  // Read back from a fresh store instance (reloading from disk)
  const freshStore = new CaptureStore(storeRoot);
  await freshStore.init();
  const loaded = await freshStore.get(projectRoot, "test-attr-capture-1");

  assert.ok(loaded);
  assert.equal(loaded.reported.length, 1);
  assert.equal(loaded.reported[0].source, "attributed");
  assert.equal(loaded.reported[0].file, "prompts/assistant.prompt");
  assert.equal(loaded.reported[0].confidence, 0.92);
  assert.equal(loaded.reported[0].explanation, "Constructed by prompts/assistant.prompt");

  // Verify deriveCapture presents the fileSpanCount correctly
  const view = deriveCapture(loaded, null);
  assert.equal(view.fileSpanCount, 1);
  assert.equal(view.messages[0].spans[0].source, "attributed");
  assert.match(view.messages[0].spans[0].label, /Attributed by Meta AI/);
});

test("CaptureStore persists telemetry and deriveCapture binds section telemetry to view messages", async () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-store-telemetry-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-project-telemetry-"));
  const store = new CaptureStore(storeRoot);
  await store.init();

  const capture = {
    id: "test-telemetry-cap-1",
    clientRequestId: "req-telemetry",
    projectPath: projectRoot,
    createdAt: new Date().toISOString(),
    provider: "openai",
    upstream: "https://api.openai.com",
    endpoint: "/v1/chat/completions",
    model: "llama-3-8b",
    status: 200,
    error: null,
    messages: [
      { role: "system", content: "You are a customer service assistant.", truncated: false },
      { role: "user", content: "Reference Documents:\nDoc 1: Return window is 30 days.\n\nQuestion: Can I return item?", truncated: false },
    ],
    reply: "Yes, you can return items within 30 days.",
    reported: [],
    telemetry: {
      captureId: "test-telemetry-cap-1",
      analyzedAt: new Date().toISOString(),
      totalTokens: 120,
      composition: [
        {
          category: "rag_grounding",
          categoryLabel: "RAG Grounding",
          tokens: 80,
          percentage: 67,
          colorVar: "var(--vscode-charts-purple)",
        },
        {
          category: "system_instruction",
          categoryLabel: "System Instruction",
          tokens: 40,
          percentage: 33,
          colorVar: "var(--vscode-charts-green)",
        },
      ],
      sections: [
        {
          sectionId: "msg-0",
          messageIndex: 0,
          messageIndices: [0],
          category: "system_instruction",
          categoryLabel: "System Instruction",
          what: "Customer Support Persona",
          why: "Defines agent tone and rules.",
          tokenEstimate: 40,
          tokenPercentage: 33,
        },
        {
          sectionId: "msg-1-rag",
          messageIndex: 1,
          messageIndices: [1],
          category: "rag_grounding",
          categoryLabel: "RAG Grounding",
          what: "Policy Return Documentation",
          why: "Grounds return policy limits.",
          tokenEstimate: 80,
          tokenPercentage: 67,
          warning: "High token share",
        },
      ],
      warnings: ["High token share"],
    },
  };

  await store.add(capture);

  // Reload from fresh store instance
  const freshStore = new CaptureStore(storeRoot);
  await freshStore.init();
  const loaded = await freshStore.get(projectRoot, "test-telemetry-cap-1");

  assert.ok(loaded);
  assert.ok(loaded.telemetry);
  assert.equal(loaded.telemetry.totalTokens, 120);
  assert.equal(loaded.telemetry.sections.length, 2);
  assert.equal(loaded.telemetry.sections[0].what, "Customer Support Persona");
  assert.equal(loaded.telemetry.sections[1].what, "Policy Return Documentation");
  assert.equal(loaded.telemetry.composition.length, 2);
  assert.deepEqual(loaded.telemetry.warnings, ["High token share"]);

  // Verify deriveCapture maps telemetry to capture view and message items
  const view = deriveCapture(loaded, null);
  assert.ok(view.telemetry);
  assert.equal(view.telemetry.totalTokens, 120);
  assert.equal(view.messages[0].telemetry?.what, "Customer Support Persona");
  assert.equal(view.messages[0].telemetry?.category, "system_instruction");
  assert.equal(view.messages[1].telemetry?.what, "Policy Return Documentation");
  assert.equal(view.messages[1].telemetry?.category, "rag_grounding");

  // Verify presentCapture retains telemetry
  const presented = presentCapture(view);
  assert.ok(presented.telemetry);
  assert.equal(presented.telemetry.sections[0].why, "Defines agent tone and rules.");
});

test("CaptureStore manages persistent project attributions across captures and reloads", async () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-store-attr-cache-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-project-attr-cache-"));
  const store = new CaptureStore(storeRoot);
  await store.init();

  const promptText = "You are Eidos. You live in this thread. Skills are Host commands.";
  const rawQuote = "'You are Eidos. You live in this thread.',\n    'Skills are Host commands.',";
  const cleanQuote = extractCleanQuote(rawQuote);
  assert.equal(cleanQuote, "You are Eidos. You live in this thread.");

  const attr = {
    fingerprint: hashPromptText(promptText),
    quote: rawQuote,
    cleanQuote,
    file: "desktop/src/core/domain/eidos.ts",
    startLine: 239,
    endLine: 262,
    confidence: 0.98,
    explanation: "Matches Eidos system prompt builder",
    attributedAt: new Date().toISOString(),
  };

  await store.saveAttribution(projectRoot, attr);
  const listed = await store.listAttributions(projectRoot);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].file, "desktop/src/core/domain/eidos.ts");

  // Verify matching logic for verbatim content
  const match1 = matchCachedAttribution(promptText, listed);
  assert.ok(match1);
  assert.equal(match1.file, "desktop/src/core/domain/eidos.ts");

  // Verify matching logic for dynamic content containing invariant quote
  const dynamicPrompt = `${promptText}\nAPP DATA: AAPL=150, TSLA=200\nUser query here`;
  const match2 = matchCachedAttribution(dynamicPrompt, listed);
  assert.ok(match2);
  assert.equal(match2.file, "desktop/src/core/domain/eidos.ts");

  // Verify seedAttributionsFromCaptures scans existing capture files
  const captureWithAttr = {
    id: "cap-seeded-1",
    clientRequestId: null,
    projectPath: projectRoot,
    createdAt: new Date().toISOString(),
    provider: "custom",
    upstream: "http://127.0.0.1:11434",
    endpoint: "/api/chat",
    model: "gemma4:12b",
    status: 200,
    error: null,
    messages: [{ role: "system", content: "System instructions for seeded bot." }],
    reply: "OK",
    reported: [
      {
        messageIndex: 0,
        file: "src/bot.ts",
        startLine: 10,
        endLine: 20,
        source: "attributed",
        confidence: 0.95,
        explanation: "Seeded bot prompt",
        quote: "System instructions for seeded bot.",
      },
    ],
  };
  await store.add(captureWithAttr);

  const seeded = await store.seedAttributionsFromCaptures(projectRoot);
  assert.equal(seeded.some((a) => a.file === "src/bot.ts"), true);
  assert.equal(seeded.some((a) => a.file === "desktop/src/core/domain/eidos.ts"), true);
});

test("Dynamic RAG and code snippet attributions match subsequent captures and back-propagate", async () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-store-rag-attr-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-project-rag-attr-"));
  const store = new CaptureStore(storeRoot);
  await store.init();

  const codeSnippet = 'append("\\n\\nRelevant passages from the World English Bible. ")';
  const cleanQuotes = extractCleanQuotes(codeSnippet);
  assert.ok(cleanQuotes.includes("Relevant passages from the World English Bible."));

  const personaHeader = "You are a knowledgeable and thoughtful Bible study assistant. Help the user understand Scripture.";
  const promptTurn1 = `${personaHeader}\n\nRelevant passages from the World English Bible:\n- Luke 22:68 - and if I ask...\n\nGround your answer.`;
  const promptTurn2 = `${personaHeader}\n\nRelevant passages from the World English Bible:\n- John 11:22 - Even now I know...\n\nGround your answer.`;

  const invariantPrefix = extractInvariantPrefix(promptTurn1);
  assert.equal(invariantPrefix, personaHeader);

  // Capture 1: attributed with code snippet
  const cap1 = {
    id: "cap-turn-1",
    clientRequestId: null,
    projectPath: projectRoot,
    createdAt: new Date().toISOString(),
    provider: "custom",
    upstream: "https://api.moonshot.ai",
    endpoint: "/v1/chat/completions",
    model: "kimi-k2.6",
    status: 200,
    error: null,
    messages: [{ role: "system", content: promptTurn1 }],
    reply: "Turn 1 answer",
    reported: [
      {
        messageIndex: 0,
        file: "app/src/main/java/com/example/PromptBuilder.kt",
        startLine: 121,
        endLine: 149,
        source: "attributed",
        confidence: 0.98,
        explanation: "Matches PromptBuilder.buildSystemContent",
        quote: codeSnippet,
      },
    ],
  };

  // Capture 2: initially un-attributed (e.g. fresh arrival)
  const cap2 = {
    id: "cap-turn-2",
    clientRequestId: null,
    projectPath: projectRoot,
    createdAt: new Date().toISOString(),
    provider: "custom",
    upstream: "https://api.moonshot.ai",
    endpoint: "/v1/chat/completions",
    model: "kimi-k2.6",
    status: 200,
    error: null,
    messages: [{ role: "system", content: promptTurn2 }],
    reply: "Turn 2 answer",
    reported: [],
  };

  await store.add(cap1);
  await store.add(cap2);

  // Seed attributions and back-propagate
  const seeded = await store.seedAttributionsFromCaptures(projectRoot);
  assert.ok(seeded.length > 0);
  assert.equal(seeded[0].file, "app/src/main/java/com/example/PromptBuilder.kt");

  // Verify matchCachedAttribution matches Turn 2
  const match = matchCachedAttribution(promptTurn2, seeded);
  assert.ok(match, "Turn 2 must match cached attribution from Turn 1");
  assert.equal(match.file, "app/src/main/java/com/example/PromptBuilder.kt");

  // Verify Capture 2 on disk was back-propagated and has the reported span
  const reloadedCap2 = await store.get(projectRoot, "cap-turn-2");
  assert.ok(reloadedCap2);
  assert.equal(reloadedCap2.reported.length, 1);
  assert.equal(reloadedCap2.reported[0].source, "attributed");
  assert.equal(reloadedCap2.reported[0].file, "app/src/main/java/com/example/PromptBuilder.kt");

  // Verify deriveCapture produces an attributed file span on Turn 2
  const view = deriveCapture(reloadedCap2, null);
  assert.equal(view.messages[0].spans.some((s) => s.kind === "file"), true);
});




