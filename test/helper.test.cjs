const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runHarness } = require("../out/harness.js");
const { completeChat, helperChatUrl, listHelperModels, modelIdsFromResponse } = require("../out/helperClient.js");
const { ADDRESS_SYSTEM, addressTools, ATTRIBUTION_SYSTEM, attributionTools, attributePrompt, buildAttributionUserPrompt, buildDiagnosticUserPrompt, buildHelperUserPrompt, detectLocalServices, detectSourceConfigFile, findUserConfigDirs, inferAppHints, KNOWN_LOCAL_SERVICES, probePort, proposeAddress, searchText } = require("../out/helperTools.js");
const { expandHomeDir, isHomeConfigPath } = require("../out/paths.js");
const { redactText } = require("../out/redact.js");
const net = require("node:net");

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

test("search_text supports literal, regex, and multi-query array with redaction", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-search-"));
  fs.writeFileSync(path.join(root, "config.py"), 'base_url = "http://localhost:11434"\napi_key = "sk-super-secret"\n');
  fs.writeFileSync(path.join(root, "server.js"), 'const ollamaHost = "http://127.0.0.1:11434";\nconst token = "super-token";\n');

  try {
    // Single string query
    const res1 = searchText(root, "11434");
    assert.match(res1, /config\.py:1:/);
    assert.match(res1, /server\.js:1:/);
    assert.equal(res1.includes("sk-super-secret"), false);

    // Regex pattern
    const res2 = searchText(root, { query: "ollamaHost|base_url" });
    assert.match(res2, /config\.py:1:/);
    assert.match(res2, /server\.js:1:/);

    // Multi-query array
    const res3 = searchText(root, { queries: ["ollamaHost", "base_url"] });
    assert.match(res3, /config\.py:1:/);
    assert.match(res3, /server\.js:1:/);

    // Non-matching
    const res4 = searchText(root, "nonexistent");
    assert.equal(res4, "No matches.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the helper harness executes multiple parallel tool calls in one turn", async () => {
  const executed = [];
  const res = await runHarness({
    system: "find",
    user: "go",
    stepCap: 2,
    tools: [
      {
        name: "tool_a",
        description: "a",
        parameters: {},
        run: () => {
          executed.push("tool_a");
          return { content: "res_a" };
        },
      },
      {
        name: "tool_b",
        description: "b",
        parameters: {},
        run: () => {
          executed.push("tool_b");
          return { content: "res_b" };
        },
      },
      {
        name: "propose_address",
        description: "finish",
        parameters: {},
        run: () => {
          executed.push("propose_address");
          return { content: "ok", finish: { url: "http://localhost:11434" } };
        },
      },
    ],
    complete: async (messages) => {
      if (messages.length === 2) {
        return {
          content: null,
          toolCalls: [
            { id: "1", name: "tool_a", arguments: "{}" },
            { id: "2", name: "tool_b", arguments: "{}" },
          ],
        };
      }
      return {
        content: null,
        toolCalls: [
          { id: "3", name: "propose_address", arguments: "{}" },
        ],
      };
    },
  });

  assert.deepEqual(executed, ["tool_a", "tool_b", "propose_address"]);
  assert.equal(res.finish.url, "http://localhost:11434");
  assert.equal(res.steps, 2);
});

test("buildHelperUserPrompt injects preliminary clues", () => {
  const empty = buildHelperUserPrompt([]);
  assert.equal(empty, "Find the HTTP address this project uses to call a model.");

  const clues = [
    { file: "config.json", line: 10, text: "ollamaHost: 'http://127.0.0.1:11434'" },
    { file: "main.py", line: 42, text: "base_url = 'http://localhost:11434'" },
  ];
  const formatted = buildHelperUserPrompt(clues);
  assert.match(formatted, /Preliminary scan detected these potential references/);
  assert.match(formatted, /config\.json:10: ollamaHost/);
  assert.match(formatted, /main\.py:42: base_url/);
});

test("proposeAddress redirects source code fallbacks to active user configuration files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-source-"));
  const tmpHome = fs.mkdtempSync(path.join(__dirname, "..", ".tmp-fake-home-"));
  const appConfigDir = path.join(tmpHome, ".config", "my-app");
  fs.mkdirSync(appConfigDir, { recursive: true });
  const realConfig = path.join(appConfigDir, "config.json");
  fs.writeFileSync(realConfig, '{\n  "base_url": "http://127.0.0.1:11434"\n}\n');

  // Source file defining defaults and referencing .config/my-app
  const sourceFile = path.join(root, "config.js");
  fs.writeFileSync(
    sourceFile,
    `const CONFIG_DIR = path.join(os.homedir(), '.config', 'my-app');
function defaultConfig() {
  return { base_url: "http://127.0.0.1:11434" };
}`,
  );

  const origHomedir = os.homedir;
  os.homedir = () => tmpHome;

  try {
    const detected = detectSourceConfigFile(sourceFile, fs.readFileSync(sourceFile, "utf8"));
    assert.equal(detected, realConfig);

    const outcome = proposeAddress(root, {
      file: "config.js",
      url: "http://127.0.0.1:11434",
      reason: "defaultConfig in source",
    });

    // Must NOT finish on the source file
    assert.equal(outcome.finish, undefined);
    assert.match(outcome.content, /source code defining fallback defaults/);
    assert.match(outcome.content, /my-app\/config\.json/);

    // Calling propose_address on the real config file succeeds
    const configOutcome = proposeAddress(root, {
      file: realConfig,
      url: "http://127.0.0.1:11434",
      reason: "active runtime config",
    });
    assert.equal(configOutcome.finish.relativeFile, realConfig);
    assert.equal(configOutcome.finish.line, 2);
  } finally {
    os.homedir = origHomedir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("probePort detects listening port and handles closed port with timeout", async () => {
  // Test closed port (random high unused port)
  const closed = await probePort("127.0.0.1", 49151, 50);
  assert.equal(closed, false);

  // Test active port with a transient local server
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const active = await probePort("127.0.0.1", port, 200);
    assert.equal(active, true);
  } finally {
    server.close();
  }
});

test("detectLocalServices reports active services and closed probes", async () => {
  const mockProbe = async (host, port) => {
    return port === 11434; // simulate Ollama running
  };

  const output = await detectLocalServices(KNOWN_LOCAL_SERVICES, mockProbe);
  assert.match(output, /Active local AI services detected \(1\):/);
  assert.match(output, /Ollama: http:\/\/127\.0\.0\.1:11434/);
  assert.match(output, /Probed inactive services/);
  assert.match(output, /LM Studio/);
  assert.match(output, /vLLM \/ LocalAI/);

  // When none are running
  const allClosedOutput = await detectLocalServices(KNOWN_LOCAL_SERVICES, async () => false);
  assert.match(allClosedOutput, /No active local AI services detected on standard ports/);
});

test("inferAppHints extracts and expands hints from folder and package.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-hints-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@optimalx/optimalx-desktop" }));
    const hints = inferAppHints(root);
    assert.equal(hints.includes("optimalx-desktop"), true);
    assert.equal(hints.includes("optimalxdesktop"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findUserConfigDirs resolves directories and files in ~/.config and %APPDATA%", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-proj-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-home-"));
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-appdata-"));

  try {
    // 1. Create a config dir under ~/.config/optimalx
    const configDir = path.join(fakeHome, ".config", "optimalx");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), '{"base_url": "http://127.0.0.1:11434"}');
    fs.writeFileSync(path.join(configDir, "settings.yaml"), "theme: dark");
    fs.writeFileSync(path.join(configDir, ".env"), "SECRET_KEY=12345"); // secret file should be excluded

    // 2. Create an AppData config under %APPDATA%/optimalx
    const appDataDir = path.join(fakeAppData, "optimalx");
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.writeFileSync(path.join(appDataDir, "appsettings.json"), "{}");

    const result = findUserConfigDirs(root, { app_hints: ["optimalx"] }, fakeHome, fakeAppData);
    assert.match(result, /Found 2 user configuration location\(s\)/);
    assert.match(result, /config\.json/);
    assert.match(result, /settings\.yaml/);
    assert.match(result, /appsettings\.json/);
    // .env should NOT be listed
    assert.equal(result.includes(".env"), false);

    // Test with no matching hints
    const emptyResult = findUserConfigDirs(root, { app_hints: ["nonexistent-app-xyz"] }, fakeHome, fakeAppData);
    assert.match(emptyResult, /No user configuration directories found matching hints/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  }
});

test("addressTools includes sensory grounding tools and executes async tools via runHarness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-tools-"));
  try {
    const tools = addressTools(root);
    const serviceTool = tools.find((t) => t.name === "detect_local_services");
    const configTool = tools.find((t) => t.name === "find_user_config_dirs");

    assert.ok(serviceTool, "detect_local_services tool must exist");
    assert.ok(configTool, "find_user_config_dirs tool must exist");

    // Execute detect_local_services via runHarness
    const harnessResult = await runHarness({
      system: "test",
      user: "detect",
      stepCap: 2,
      tools: [
        serviceTool,
        {
          name: "propose_address",
          description: "finish",
          parameters: {},
          run: () => ({ content: "done", finish: { url: "http://127.0.0.1:11434" } }),
        },
      ],
      complete: async (messages) => {
        if (messages.length === 2) {
          return {
            content: null,
            toolCalls: [{ id: "c1", name: "detect_local_services", arguments: "{}" }],
          };
        }
        return {
          content: null,
          toolCalls: [{ id: "c2", name: "propose_address", arguments: "{}" }],
        };
      },
    });

    assert.equal(harnessResult.finish.url, "http://127.0.0.1:11434");
    assert.equal(harnessResult.steps, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("expandHomeDir and home config path safety", () => {
  const home = os.homedir();
  assert.equal(expandHomeDir("~/test.json"), path.join(home, "test.json"));
  assert.equal(expandHomeDir("~/.config/app"), path.join(home, ".config/app"));
  assert.equal(expandHomeDir("/var/log"), "/var/log");

  // Blocked paths
  assert.equal(isHomeConfigPath(path.join(home, ".ssh", "id_rsa")), false);
  assert.equal(isHomeConfigPath(path.join(home, ".cursor", "rules")), false);
  // Allowed config path
  assert.equal(isHomeConfigPath(path.join(home, ".config", "myapp", "config.json")), true);
});

test("ADDRESS_SYSTEM guides client architecture, sensory grounding, and parallel calling", () => {
  // Client classification coverage
  assert.match(ADDRESS_SYSTEM, /OpenAI SDK/);
  assert.match(ADDRESS_SYSTEM, /Anthropic SDK/);
  assert.match(ADDRESS_SYSTEM, /Ollama REST API/);
  assert.match(ADDRESS_SYSTEM, /Chutes/);
  assert.match(ADDRESS_SYSTEM, /vLLM/);
  assert.match(ADDRESS_SYSTEM, /OpenRouter/);
  assert.match(ADDRESS_SYSTEM, /LangChain/);
  assert.match(ADDRESS_SYSTEM, /LlamaIndex/);

  // Sourcing hierarchy & runtime decision rule
  assert.match(ADDRESS_SYSTEM, /Type A/);
  assert.match(ADDRESS_SYSTEM, /Type B/);
  assert.match(ADDRESS_SYSTEM, /Type C/);
  assert.match(ADDRESS_SYSTEM, /Type D/);
  assert.match(ADDRESS_SYSTEM, /inert at runtime/);

  // Sensory tools mentioned
  assert.match(ADDRESS_SYSTEM, /detect_local_services/);
  assert.match(ADDRESS_SYSTEM, /find_user_config_dirs/);

  // Parallel tool calling for Meta Muse models
  assert.match(ADDRESS_SYSTEM, /Muse Spark 1\.3/);
  assert.match(ADDRESS_SYSTEM, /Muse Wonder/);
  assert.match(ADDRESS_SYSTEM, /parallel tool calls/);
});

test("buildHelperUserPrompt formats project metadata and preserves clue formatting", () => {
  // With project info and clues
  const prompt = buildHelperUserPrompt(
    [{ file: "settings.json", line: 5, text: '"base_url": "http://127.0.0.1:11434"' }],
    { name: "OptimalX Desktop", path: "/projects/optimalx" },
  );
  assert.match(prompt, /Find the HTTP address/);
  assert.match(prompt, /Project name: OptimalX Desktop/);
  assert.match(prompt, /settings\.json:5: "base_url"/);

  // With empty clues but project name
  const promptWithName = buildHelperUserPrompt([], { name: "EidosBot" });
  assert.match(promptWithName, /Project name: EidosBot/);
});

test("helper runs on test repository with single-turn resolution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-singleturn-"));
  try {
    fs.writeFileSync(
      path.join(root, "config.yaml"),
      "model: llama3\nbase_url: http://127.0.0.1:11434\ntemperature: 0.7\n",
    );
    fs.writeFileSync(
      path.join(root, "app.py"),
      "import yaml\nwith open('config.yaml') as f:\n    cfg = yaml.safe_load(f)\n",
    );

    const tools = addressTools(root);

    // Single-turn completion where Meta Muse model issues parallel tool calls
    // (detect_local_services and propose_address) in Turn 1
    const res = await runHarness({
      system: ADDRESS_SYSTEM,
      user: buildHelperUserPrompt(
        [{ file: "config.yaml", line: 2, text: "base_url: http://127.0.0.1:11434" }],
        { name: "yaml-app" },
      ),
      stepCap: 4,
      tools,
      complete: async () => ({
        content: "Detected configuration in config.yaml and active local Ollama service.",
        toolCalls: [
          { id: "call-1", name: "detect_local_services", arguments: "{}" },
          {
            id: "call-2",
            name: "propose_address",
            arguments: JSON.stringify({
              file: "config.yaml",
              url: "http://127.0.0.1:11434",
              reason: "Configured runtime base_url in config.yaml",
            }),
          },
        ],
      }),
    });

    assert.ok(res.finish, "Should resolve address in single turn");
    assert.equal(res.finish.relativeFile, "config.yaml");
    assert.equal(res.finish.url, "http://127.0.0.1:11434");
    assert.equal(res.finish.line, 2);
    assert.equal(res.steps, 1, "Must complete in exactly 1 turn");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("helper discovers architecture and resolves active user config in 2 turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-2turn-proj-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-2turn-home-"));
  const userConfigDir = path.join(tmpHome, ".config", "mybot");
  fs.mkdirSync(userConfigDir, { recursive: true });
  const activeConfigFile = path.join(userConfigDir, "config.json");
  fs.writeFileSync(activeConfigFile, JSON.stringify({ endpoint: "http://127.0.0.1:11434" }, null, 2));

  // In-repo source file with inert fallback
  fs.writeFileSync(
    path.join(root, "client.js"),
    'const fallback = "http://127.0.0.1:8000";\nconst userCfg = path.join(os.homedir(), ".config", "mybot", "config.json");\n',
  );

  const origHomedir = os.homedir;
  os.homedir = () => tmpHome;

  try {
    const tools = addressTools(root);
    let turns = 0;

    const res = await runHarness({
      system: ADDRESS_SYSTEM,
      user: buildHelperUserPrompt([], { name: "mybot" }),
      stepCap: 4,
      tools,
      complete: async (messages) => {
        turns++;
        if (turns === 1) {
          // Turn 1: parallel reconnaissance (sensory tools)
          return {
            content: "Checking local services and user config directories in parallel.",
            toolCalls: [
              { id: "call-1", name: "detect_local_services", arguments: "{}" },
              {
                id: "call-2",
                name: "find_user_config_dirs",
                arguments: JSON.stringify({ app_hints: ["mybot"] }),
              },
            ],
          };
        }
        // Turn 2: model inspects results and proposes active user config
        return {
          content: "Active configuration discovered in user config dir.",
          toolCalls: [
            {
              id: "call-3",
              name: "propose_address",
              arguments: JSON.stringify({
                file: activeConfigFile,
                url: "http://127.0.0.1:11434",
                reason: "Active runtime configuration in ~/.config/mybot/config.json",
              }),
            },
          ],
        };
      },
    });

    assert.ok(res.finish, "Should resolve address");
    assert.equal(res.finish.relativeFile, activeConfigFile);
    assert.equal(res.finish.url, "http://127.0.0.1:11434");
    assert.equal(res.steps, 2, "Must complete in 2 turns");
  } finally {
    os.homedir = origHomedir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("buildDiagnosticUserPrompt includes failed file, url, symptom and instructions", () => {
  const prompt = buildDiagnosticUserPrompt({
    failedFile: "src/client.ts",
    failedUrl: "http://127.0.0.1:8000",
    reason: "Prompts did not reach recorder port 47321 after app started",
    projectName: "EidosBot",
    clues: [{ file: "config.yaml", line: 3, text: "base_url: http://127.0.0.1:11434" }],
  });

  assert.match(prompt, /Capture was armed pointing to src\/client\.ts \(http:\/\/127\.0\.0\.1:8000\)/);
  assert.match(prompt, /bypassed the recorder/);
  assert.match(prompt, /Symptom: Prompts did not reach recorder port 47321/);
  assert.match(prompt, /Diagnose why the application did not use src\/client\.ts/);
  assert.match(prompt, /Project name: EidosBot/);
  assert.match(prompt, /config\.yaml:3: base_url/);
});

test("proposeAddress rejects re-proposing the failed file during diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-diag-reject-"));
  try {
    fs.writeFileSync(path.join(root, "client.py"), 'BASE_URL = "http://127.0.0.1:8000"\n');

    // Attempting to propose the same file that failed
    const res = proposeAddress(root, {
      file: "client.py",
      url: "http://127.0.0.1:8000",
      reason: "re-proposing",
    }, { failedFile: "client.py", failedUrl: "http://127.0.0.1:8000" });

    assert.equal(res.finish, undefined);
    assert.match(res.content, /was already armed and bypassed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic loop correctly pivots from a source fallback to a user config file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-diag-pivot-proj-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-tracker-diag-pivot-home-"));

  // 1. In-tree source file with fallback default that failed
  const sourceFile = path.join(root, "app_client.py");
  fs.writeFileSync(sourceFile, 'FALLBACK_URL = "http://127.0.0.1:8000"\n# loads ~/.config/eidosbot/config.yaml at startup\n');

  // 2. Active external user configuration file
  const userConfigDir = path.join(tmpHome, ".config", "eidosbot");
  fs.mkdirSync(userConfigDir, { recursive: true });
  const realConfigFile = path.join(userConfigDir, "config.yaml");
  fs.writeFileSync(realConfigFile, "server:\n  endpoint: http://127.0.0.1:11434\n");

  const origHomedir = os.homedir;
  os.homedir = () => tmpHome;

  try {
    // Diagnostic prompt injecting context that app_client.py failed
    const diagPrompt = buildDiagnosticUserPrompt({
      failedFile: "app_client.py",
      failedUrl: "http://127.0.0.1:8000",
      reason: "Application started but requests bypassed recorder",
      projectName: "eidosbot",
    });

    const tools = addressTools(root, { failedFile: "app_client.py", failedUrl: "http://127.0.0.1:8000" });
    let turns = 0;

    const res = await runHarness({
      system: ADDRESS_SYSTEM,
      user: diagPrompt,
      stepCap: 4,
      tools,
      complete: async (messages) => {
        turns++;
        if (turns === 1) {
          // Model investigates alternative user config paths
          return {
            content: "Diagnosing bypass of app_client.py. Checking user config directories.",
            toolCalls: [
              {
                id: "diag-1",
                name: "find_user_config_dirs",
                arguments: JSON.stringify({ app_hints: ["eidosbot"] }),
              },
            ],
          };
        }
        // Model pivots: proposes the active user config file
        return {
          content: "Identified active runtime configuration in ~/.config/eidosbot/config.yaml.",
          toolCalls: [
            {
              id: "diag-2",
              name: "propose_address",
              arguments: JSON.stringify({
                file: realConfigFile,
                url: "http://127.0.0.1:11434",
                reason: "Active runtime configuration in ~/.config/eidosbot/config.yaml overrides source fallback",
              }),
            },
          ],
        };
      },
    });

    assert.ok(res.finish, "Diagnostic loop should propose address");
    // Verify it pivoted away from app_client.py to realConfigFile
    assert.notEqual(res.finish.relativeFile, "app_client.py");
    assert.equal(res.finish.relativeFile, realConfigFile);
    assert.equal(res.finish.url, "http://127.0.0.1:11434");
    assert.equal(res.steps, 2);

    // Verify constructing the updated offer with explanation matching SPEC 4.2
    const updatedOffer = {
      ...res.finish,
      previousFile: "app_client.py",
      explanation: `Helper found that the app loaded settings from ${res.finish.relativeFile} instead of app_client.py. Click to switch connection.`,
    };
    assert.match(updatedOffer.explanation, /Helper found that the app loaded settings from .* instead of app_client\.py/);
    assert.equal(updatedOffer.previousFile, "app_client.py");
  } finally {
    os.homedir = origHomedir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("ATTRIBUTION_SYSTEM guides invariant instruction extraction and parallel search", () => {
  assert.match(ATTRIBUTION_SYSTEM, /Semantic Prompt Attribution/);
  assert.match(ATTRIBUTION_SYSTEM, /DYNAMIC INTERPOLATION & TEMPLATE SKELETONS/);
  assert.match(ATTRIBUTION_SYSTEM, /Separate Dynamic Runtime Data from Invariant Template Instructions/);
  assert.match(ATTRIBUTION_SYSTEM, /search_text/);
  assert.match(ATTRIBUTION_SYSTEM, /attribute_prompt/);
  assert.match(ATTRIBUTION_SYSTEM, /Muse Spark 1\.3/);
  assert.match(ATTRIBUTION_SYSTEM, /Muse Wonder/);
});

test("buildAttributionUserPrompt formats role, project, model and redacts secrets", () => {
  const prompt = buildAttributionUserPrompt({
    content: "System prompt instructions:\napi_key: sk-super-secret-token-12345\nAlways format as JSON.",
    role: "system",
    projectName: "MyAgent",
    model: "llama-3-70b",
  });

  assert.match(prompt, /Project: MyAgent/);
  assert.match(prompt, /Target Model: llama-3-70b/);
  assert.match(prompt, /Captured Prompt \[Role: system\]:/);
  assert.match(prompt, /Always format as JSON/);
  // Secret should be redacted
  assert.equal(prompt.includes("sk-super-secret-token-12345"), false);
  assert.match(prompt, /\[private\]/);
});

test("attributePrompt validates file existence, line bounds, snippets and confidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-attr-test-"));
  try {
    fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
    const promptFile = path.join(root, "prompts", "system.jinja2");
    fs.writeFileSync(
      promptFile,
      "You are a helpful customer support bot for {{ company_name }}.\nAlways answer politely.\nReturn answers in {{ format }}.\n",
    );

    // Missing file
    const res1 = attributePrompt(root, { file: "nonexistent.py", startLine: 1, endLine: 2 });
    assert.equal(res1.finish, undefined);
    assert.match(res1.content, /not in the project/);

    // Invalid line numbers
    const res2 = attributePrompt(root, { file: "prompts/system.jinja2", startLine: 0, endLine: 2 });
    assert.equal(res2.finish, undefined);
    assert.match(res2.content, /positive integers/);

    const res3 = attributePrompt(root, { file: "prompts/system.jinja2", startLine: 5, endLine: 3 });
    assert.equal(res3.finish, undefined);
    assert.match(res3.content, /endLine >= startLine/);

    const res4 = attributePrompt(root, { file: "prompts/system.jinja2", startLine: 99, endLine: 100 });
    assert.equal(res4.finish, undefined);
    assert.match(res4.content, /exceeds the total lines/);

    // Invalid snippet
    const res5 = attributePrompt(root, {
      file: "prompts/system.jinja2",
      startLine: 1,
      endLine: 2,
      matchedSnippet: "Completely nonexistent text that cannot match anything",
    });
    assert.equal(res5.finish, undefined);
    assert.match(res5.content, /matched snippet was not found/);

    // Valid attribution
    const res6 = attributePrompt(root, {
      file: "prompts/system.jinja2",
      startLine: 1,
      endLine: 3,
      confidence: 0.95,
      explanation: "Matched system prompt template with customer support instructions",
      matchedSnippet: "You are a helpful customer support bot",
    });
    assert.ok(res6.finish);
    assert.equal(res6.finish.file, "prompts/system.jinja2");
    assert.equal(res6.finish.startLine, 1);
    assert.equal(res6.finish.endLine, 3);
    assert.equal(res6.finish.confidence, 0.95);
    assert.match(res6.finish.explanation, /customer support instructions/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attributionTools and harness execution: Meta Muse attributes dynamic prompt to template", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-attr-harness-"));
  try {
    fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "prompts", "analyst.prompt"),
      [
        "# System Instructions",
        "You are an expert financial analyst assistant.",
        "Analyze the user's data according to SEC guidelines.",
        "Company: {{ company_name }} (Ticker: {{ ticker }})",
        "Format output as structured markdown bullet points.",
      ].join("\n") + "\n",
    );

    const dynamicCapturedPrompt = [
      "You are an expert financial analyst assistant.",
      "Analyze the user's data according to SEC guidelines.",
      "Company: Acme Corporation (Ticker: ACM)",
      "Format output as structured markdown bullet points.",
      "User question: What was Q3 net income?",
    ].join("\n");

    const tools = attributionTools(root);
    let turns = 0;

    const res = await runHarness({
      system: ATTRIBUTION_SYSTEM,
      user: buildAttributionUserPrompt({
        content: dynamicCapturedPrompt,
        role: "system",
        projectName: "FinancialBot",
      }),
      stepCap: 4,
      tools,
      complete: async (messages) => {
        turns++;
        if (turns === 1) {
          // Model identifies invariant phrase and searches project in Turn 1
          return {
            content: "Searching for invariant phrase 'SEC guidelines' in project templates.",
            toolCalls: [
              {
                id: "attr-call-1",
                name: "search_text",
                arguments: JSON.stringify({ query: "SEC guidelines" }),
              },
            ],
          };
        }
        // Model inspects search result and calls attribute_prompt in Turn 2
        return {
          content: "Located template in prompts/analyst.prompt. Calling attribute_prompt.",
          toolCalls: [
            {
              id: "attr-call-2",
              name: "attribute_prompt",
              arguments: JSON.stringify({
                file: "prompts/analyst.prompt",
                startLine: 1,
                endLine: 5,
                confidence: 0.95,
                explanation: "Template in prompts/analyst.prompt constructs the analyst prompt with dynamic company/ticker slots",
                matchedSnippet: "Analyze the user's data according to SEC guidelines.",
              }),
            },
          ],
        };
      },
    });

    assert.ok(res.finish, "Harness should finish with an attributed span");
    assert.equal(res.finish.file, "prompts/analyst.prompt");
    assert.equal(res.finish.startLine, 1);
    assert.equal(res.finish.endLine, 5);
    assert.equal(res.finish.confidence, 0.95);
    assert.match(res.finish.explanation, /analyst prompt/);
    assert.equal(res.steps, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runHarness onEvent streams thoughts, tool_call, tool_result, and finish", async () => {
  const events = [];
  const result = await runHarness({
    system: "test-system",
    user: "test-user",
    stepCap: 4,
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        parameters: { type: "object", properties: { q: { type: "string" } } },
        run: (args) => ({ content: "found 1 match" }),
      },
      {
        name: "finish_tool",
        description: "Finish",
        parameters: { type: "object", properties: {} },
        run: () => ({ content: "done", finish: { done: true } }),
      },
    ],
    onEvent: (ev) => events.push(ev),
    complete: async (messages) => {
      if (messages.length <= 2) {
        return {
          content: "Thinking about which tool to call...",
          toolCalls: [{ id: "call-1", name: "test_tool", arguments: JSON.stringify({ q: "sample" }) }],
        };
      }
      return {
        content: "Now finishing up.",
        toolCalls: [{ id: "call-2", name: "finish_tool", arguments: "{}" }],
      };
    },
  });

  assert.equal(result.finish.done, true);
  assert.equal(events.some((e) => e.kind === "thought" && e.text.includes("Thinking about")), true);
  assert.equal(events.some((e) => e.kind === "tool_call" && e.toolName === "test_tool"), true);
  assert.equal(events.some((e) => e.kind === "tool_result" && e.content.includes("found 1 match")), true);
  assert.equal(events.some((e) => e.kind === "finish" && e.finish.done === true), true);
});
