const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runHarness } = require("../out/harness.js");
const {
  ADDRESS_SYSTEM,
  addressTools,
  buildDiagnosticUserPrompt,
  buildHelperUserPrompt,
  detectLocalServices,
  findUserConfigDirs,
  proposeAddress,
} = require("../out/helperTools.js");
const { applyEnv, readEnvStatus, restoreEnv } = require("../out/env.js");
const { planRewrite } = require("../out/redirect.js");

test("Project A Fixture: Electron/Node App with external user config (OptimalX Desktop)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-project-a-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-home-a-"));
  const origHomedir = os.homedir;
  os.homedir = () => tmpHome;

  try {
    // 1. Project package.json identifying the Electron app
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@optimalx/desktop", version: "1.0.0" }, null, 2),
    );

    // 2. In-tree fallback source code
    const mainJs = path.join(root, "main.js");
    fs.writeFileSync(
      mainJs,
      `const path = require("path");
const os = require("os");
const configPath = path.join(os.homedir(), ".config", "optimalx", "config.json");
const fallbackAddress = "http://127.0.0.1:8000"; // fallback
`,
    );

    // 3. User config on disk under ~/.config/optimalx/config.json
    const userDir = path.join(tmpHome, ".config", "optimalx");
    fs.mkdirSync(userDir, { recursive: true });
    const userConfig = path.join(userDir, "config.json");
    fs.writeFileSync(
      userConfig,
      JSON.stringify({ endpoint: "http://127.0.0.1:11434", model: "llama3" }, null, 2),
    );

    const tools = addressTools(root);

    // Run harness simulating Meta Muse model autonomous reasoning
    const res = await runHarness({
      system: ADDRESS_SYSTEM,
      user: buildHelperUserPrompt(
        [{ file: "main.js", line: 4, text: 'fallbackAddress = "http://127.0.0.1:8000"' }],
        { name: "optimalx-desktop" },
      ),
      stepCap: 4,
      tools,
      complete: async (messages) => {
        if (messages.length === 2) {
          // Model detects user config directory matching hint "optimalx"
          return {
            content: "Classifying Electron app. Querying user config directories.",
            toolCalls: [
              {
                id: "call-1",
                name: "find_user_config_dirs",
                arguments: JSON.stringify({ app_hints: ["optimalx"] }),
              },
            ],
          };
        }
        // Model inspects ~/.config/optimalx/config.json and proposes active address
        return {
          content: "Active user config overrides source default fallback.",
          toolCalls: [
            {
              id: "call-2",
              name: "propose_address",
              arguments: JSON.stringify({
                file: userConfig,
                url: "http://127.0.0.1:11434",
                reason: "Active runtime configuration in ~/.config/optimalx/config.json",
              }),
            },
          ],
        };
      },
    });

    assert.ok(res.finish, "Should resolve address for Project A");
    assert.equal(res.finish.relativeFile, userConfig);
    assert.equal(res.finish.url, "http://127.0.0.1:11434");
    assert.equal(res.steps, 2);
  } finally {
    os.homedir = origHomedir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Project B Fixture: Python app with local Ollama (config.yaml / EidosBot)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-project-b-"));
  try {
    fs.writeFileSync(
      path.join(root, "config.yaml"),
      `server:
  host: 127.0.0.1
  port: 11434
  base_url: http://127.0.0.1:11434
model:
  name: mistral
`,
    );

    fs.writeFileSync(
      path.join(root, "bot.py"),
      `import yaml
import requests

with open("config.yaml") as f:
    config = yaml.safe_load(f)

url = f"{config['server']['base_url']}/api/generate"
`,
    );

    const tools = addressTools(root);

    // Single-turn parallel discovery with local service detection
    const res = await runHarness({
      system: ADDRESS_SYSTEM,
      user: buildHelperUserPrompt(
        [{ file: "config.yaml", line: 4, text: "base_url: http://127.0.0.1:11434" }],
        { name: "eidosbot" },
      ),
      stepCap: 4,
      tools,
      complete: async () => ({
        content: "Detected Python client using local Ollama endpoint in config.yaml.",
        toolCalls: [
          { id: "call-b1", name: "detect_local_services", arguments: "{}" },
          {
            id: "call-b2",
            name: "propose_address",
            arguments: JSON.stringify({
              file: "config.yaml",
              url: "http://127.0.0.1:11434",
              reason: "Active base_url in config.yaml",
            }),
          },
        ],
      }),
    });

    assert.ok(res.finish, "Should resolve address for Project B in single turn");
    assert.equal(res.finish.relativeFile, "config.yaml");
    assert.equal(res.finish.url, "http://127.0.0.1:11434");
    assert.equal(res.finish.line, 4);
    assert.equal(res.steps, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project C Fixture: Python app with .env and OpenAI SDK", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-project-c-"));
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-backups-c-"));
  try {
    // 1. Python codebase with OpenAI SDK client and config file
    fs.writeFileSync(
      path.join(root, "config.py"),
      `import os

DEFAULT_BASE_URL = "https://api.openai.com/v1"
MODEL = "gpt-4o"
`,
    );

    fs.writeFileSync(
      path.join(root, "agent.py"),
      `import os
from openai import OpenAI
from config import DEFAULT_BASE_URL

client = OpenAI(
    api_key=os.environ.get("OPENAI_API_KEY"),
    base_url=os.environ.get("OPENAI_BASE_URL", DEFAULT_BASE_URL)
)
`,
    );

    // 2. .env file containing OPENAI_API_KEY (secret) and optional OPENAI_BASE_URL
    const envFile = path.join(root, ".env");
    fs.writeFileSync(envFile, "OPENAI_API_KEY=sk-demo-secret-key-12345\n");

    // Test autonomous env management for Python OpenAI SDK projects
    const recorderUrl = "http://127.0.0.1:47321";
    const status = readEnvStatus(root, recorderUrl, backupDir);
    assert.equal(status.exists, true);
    assert.equal(status.keys.some((k) => k.key === "OPENAI_BASE_URL"), true);

    // Apply env redirection to capture
    applyEnv(root, { OPENAI_BASE_URL: recorderUrl }, backupDir);
    const updatedEnv = fs.readFileSync(envFile, "utf8");
    assert.match(updatedEnv, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:47321/);
    assert.match(updatedEnv, /OPENAI_API_KEY=sk-demo-secret-key-12345/); // secret preserved

    // Restore env file back to pristine state
    restoreEnv(root, backupDir);
    const restoredEnv = fs.readFileSync(envFile, "utf8");
    assert.equal(restoredEnv.includes("OPENAI_BASE_URL"), false);
    assert.match(restoredEnv, /OPENAI_API_KEY=sk-demo-secret-key-12345/);

    // Test AI helper analyzing the python client config
    const tools = addressTools(root);

    const res = await runHarness({
      system: ADDRESS_SYSTEM,
      user: buildHelperUserPrompt(
        [{ file: "config.py", line: 3, text: 'DEFAULT_BASE_URL = "https://api.openai.com/v1"' }],
        { name: "python-openai-agent" },
      ),
      stepCap: 4,
      tools,
      complete: async () => ({
        content: "Identified OpenAI SDK client with base_url configured in config.py.",
        toolCalls: [
          {
            id: "call-c1",
            name: "propose_address",
            arguments: JSON.stringify({
              file: "config.py",
              url: "https://api.openai.com/v1",
              reason: "Configured DEFAULT_BASE_URL in config.py",
            }),
          },
        ],
      }),
    });

    assert.ok(res.finish, "Should resolve address for Project C");
    assert.equal(res.finish.relativeFile, "config.py");
    assert.equal(res.finish.url, "https://api.openai.com/v1");

    // Test planRewrite routing logic
    const plan = planRewrite(res.finish.url, "http://127.0.0.1:47321");
    assert.equal(plan.upstream, "https://api.openai.com");
    assert.equal(plan.writeValue, "http://127.0.0.1:47321/v1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});

test("Project D Fixture: Next.js / TypeScript app with OPENAI_BASE_URL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-project-d-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "nextjs-chat-app", dependencies: { next: "^14.0.0", openai: "^4.0.0" } }, null, 2),
    );

    fs.mkdirSync(path.join(root, "app", "api", "chat"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "app", "api", "chat", "route.ts"),
      `import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
});
`,
    );

    fs.writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({ baseURL: "https://openrouter.ai/api/v1" }, null, 2),
    );

    const tools = addressTools(root);

    const res = await runHarness({
      system: ADDRESS_SYSTEM,
      user: buildHelperUserPrompt(
        [{ file: "settings.json", line: 2, text: '"baseURL": "https://openrouter.ai/api/v1"' }],
        { name: "nextjs-chat-app" },
      ),
      stepCap: 4,
      tools,
      complete: async () => ({
        content: "Classified Next.js App Router route handler configured with OpenRouter via settings.json.",
        toolCalls: [
          {
            id: "call-d1",
            name: "propose_address",
            arguments: JSON.stringify({
              file: "settings.json",
              url: "https://openrouter.ai/api/v1",
              reason: "Configured baseURL in settings.json",
            }),
          },
        ],
      }),
    });

    assert.ok(res.finish, "Should resolve address for Project D");
    assert.equal(res.finish.relativeFile, "settings.json");
    assert.equal(res.finish.url, "https://openrouter.ai/api/v1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Self-Healing Diagnostic Demonstration across projects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-healing-"));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-healing-home-"));
  const origHomedir = os.homedir;
  os.homedir = () => tmpHome;

  try {
    // In-code fallback that was erroneously connected first
    fs.writeFileSync(path.join(root, "defaults.js"), 'export const URL = "http://127.0.0.1:8000";\n');

    // True active config on user machine
    const userCfgDir = path.join(tmpHome, ".config", "app-demo");
    fs.mkdirSync(userCfgDir, { recursive: true });
    const realConfig = path.join(userCfgDir, "config.json");
    fs.writeFileSync(realConfig, JSON.stringify({ modelUrl: "http://127.0.0.1:11434" }, null, 2));

    const diagPrompt = buildDiagnosticUserPrompt({
      failedFile: "defaults.js",
      failedUrl: "http://127.0.0.1:8000",
      reason: "Bypassed recorder; 0 requests arrived after user message sent",
      projectName: "app-demo",
    });

    const tools = addressTools(root, { failedFile: "defaults.js", failedUrl: "http://127.0.0.1:8000" });

    const res = await runHarness({
      system: ADDRESS_SYSTEM,
      user: diagPrompt,
      stepCap: 4,
      tools,
      complete: async () => ({
        content: "Investigated bypass of defaults.js. Located active runtime config in ~/.config/app-demo/config.json.",
        toolCalls: [
          {
            id: "diag-call",
            name: "propose_address",
            arguments: JSON.stringify({
              file: realConfig,
              url: "http://127.0.0.1:11434",
              reason: "Active runtime configuration in ~/.config/app-demo/config.json overrides defaults.js",
            }),
          },
        ],
      }),
    });

    assert.ok(res.finish, "Self-healing diagnostic loop must resolve active address");
    assert.equal(res.finish.relativeFile, realConfig);
    assert.equal(res.finish.url, "http://127.0.0.1:11434");
    assert.equal(res.steps, 1);
  } finally {
    os.homedir = origHomedir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
