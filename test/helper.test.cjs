const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runHarness } = require("../out/harness.js");
const { completeChat, helperChatUrl, listHelperModels, modelIdsFromResponse } = require("../out/helperClient.js");
const { addressTools, proposeAddress } = require("../out/helperTools.js");
const { redactText } = require("../out/redact.js");

test("redaction hides a secret and keeps the model address", () => {
  const text = [
    "base_url: http://localhost:9999",
    "api_key: sk-test-secret",
    'OPENAI_API_KEY=sk-other-secret',
  ].join("\n");
  const redacted = redactText(text);
  assert.match(redacted, /http:\/\/localhost:9999/);
  assert.equal(redacted.includes("sk-test-secret"), false);
  assert.equal(redacted.includes("sk-other-secret"), false);
  assert.match(redacted, /\[private\]/);
});

test("project tools refuse paths outside the project and missing urls", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-helper-"));
  fs.writeFileSync(path.join(root, "client.py"), 'URL = "http://127.0.0.1:8000"\napi_key = "sk-live"\n');
  fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=sk-env\n");
  const tools = addressTools(root);
  const read = tools.find((tool) => tool.name === "read_file");
  const list = tools.find((tool) => tool.name === "list_files");
  const body = read.run({ path: "client.py" });
  assert.match(body.content, /http:\/\/127\.0\.0\.1:8000/);
  assert.equal(body.content.includes("sk-live"), false);
  assert.match(read.run({ path: ".env" }).content, /private/);
  assert.match(list.run({ path: "../" }).content, /not in the project/);
  assert.match(read.run({ path: "../secret.txt" }).content, /not in the project/);
  const missing = proposeAddress(root, { file: "client.py", url: "http://localhost:1", reason: "guess" });
  assert.equal(missing.finish, undefined);
  assert.match(missing.content, /not in the file/);
  const found = proposeAddress(root, { file: "client.py", url: "http://127.0.0.1:8000", reason: "client" });
  assert.equal(found.finish.relativeFile, "client.py");
  assert.equal(found.finish.line, 1);
  assert.equal(found.finish.url, "http://127.0.0.1:8000");
  const homeDir = fs.mkdtempSync(path.join(__dirname, "..", ".tmp-helper-config-"));
  const homeFile = path.join(homeDir, "config.json");
  fs.writeFileSync(homeFile, '{\n  "ollamaHost": "http://127.0.0.1:11434",\n  "apiKey": "sk-live"\n}\n');
  try {
    const saved = proposeAddress(root, { file: homeFile, url: "http://127.0.0.1:11434", reason: "saved config" });
    assert.equal(saved.finish.relativeFile, homeFile);
    assert.equal(saved.finish.line, 2);
    const savedBody = read.run({ path: homeFile });
    assert.match(savedBody.content, /http:\/\/127\.0\.0\.1:11434/);
    assert.equal(savedBody.content.includes("sk-live"), false);
    assert.match(read.run({ path: "/etc/passwd" }).content, /not in the project/);
    assert.match(read.run({ path: path.join(os.homedir(), ".ssh", "id_rsa") }).content, /not in the project/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("the helper loop stops on a proposal and at the step cap", async () => {
  const proposed = await runHarness({
    system: "find",
    user: "go",
    stepCap: 4,
    tools: [{
      name: "propose_address",
      description: "finish",
      parameters: {},
      run: () => ({ content: "ok", finish: { url: "http://localhost:9" } }),
    }],
    complete: async () => ({
      content: null,
      toolCalls: [{ id: "1", name: "propose_address", arguments: "{}" }],
    }),
  });
  assert.equal(proposed.finish.url, "http://localhost:9");
  assert.equal(proposed.steps, 1);

  let calls = 0;
  const capped = await runHarness({
    system: "find",
    user: "go",
    stepCap: 2,
    tools: [{
      name: "list_files",
      description: "list",
      parameters: {},
      run: () => ({ content: "a.py" }),
    }],
    complete: async () => {
      calls += 1;
      return { content: null, toolCalls: [{ id: "1", name: "list_files", arguments: "{\"path\":\".\"}" }] };
    },
  });
  assert.equal(capped.finish, null);
  assert.equal(capped.steps, 2);
  assert.equal(calls, 2);
});

test("the model list comes from the host and a rejected key stays out of the error", async () => {
  assert.equal(helperChatUrl("https://api.openai.com/v1").endsWith("/chat/completions"), true);
  assert.deepEqual(modelIdsFromResponse({ data: [{ id: "zeta" }, { id: "alpha" }, { id: "alpha" }, { id: "" }] }), ["alpha", "zeta"]);
  const secret = "sk-helper-list";
  const models = await listHelperModels({
    baseUrl: "https://example.test/v1",
    apiKey: secret,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://example.test/v1/models");
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(init.headers.authorization, `Bearer ${secret}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "demo-model" }] }) };
    },
  });
  assert.deepEqual(models, ["demo-model"]);
  const missing = await listHelperModels({
    baseUrl: "https://example.test/v1",
    apiKey: secret,
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "missing" }),
  });
  assert.deepEqual(missing, []);
  await assert.rejects(
    () => listHelperModels({
      baseUrl: "https://example.test/v1",
      apiKey: secret,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => secret }),
    }),
    (error) => {
      assert.equal(error.message, "The helper host rejected the API key.");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("helper requests use the chat endpoint and errors omit the API key", async () => {
  assert.equal(helperChatUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  const secret = "sk-helper-test";
  await assert.rejects(
    () => completeChat({
      baseUrl: "https://example.test/v1",
      apiKey: secret,
      model: "demo",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      fetchImpl: async (url, init) => {
        assert.equal(url, "https://example.test/v1/chat/completions");
        assert.equal(init.headers.authorization, `Bearer ${secret}`);
        return { ok: false, status: 401, text: async () => secret };
      },
    }),
    (error) => {
      assert.equal(error.message, "The helper model returned HTTP 401.");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
