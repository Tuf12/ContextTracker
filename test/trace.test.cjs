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
