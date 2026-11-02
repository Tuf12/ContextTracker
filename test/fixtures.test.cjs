const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runHarness } = require("../out/harness.js");
const {
  ADDRESS_SYSTEM,
  addressTools,
  ATTRIBUTION_SYSTEM,
  attributionTools,
  attributePrompt,
  buildAttributionUserPrompt,
  buildDiagnosticUserPrompt,
  buildHelperUserPrompt,
  detectLocalServices,
  findUserConfigDirs,
  proposeAddress,
} = require("../out/helperTools.js");
const { applyEnv, readEnvStatus, restoreEnv } = require("../out/env.js");
const { planRewrite } = require("../out/redirect.js");
const {
  extractContextSections,
  buildDeterministicTelemetry,
  applyTelemetryResponse,
  buildTelemetrySkeleton,
  parseTelemetryResponse,
  TelemetryCache,
  TELEMETRY_SYSTEM,
} = require("../out/telemetry.js");
const {
  buildContextSkeleton,
  buildContextCopilotSystem,
  buildDetectContradictionsPrompt,
  buildCompareCapturesPrompt,
} = require("../out/helperTools.js");
const {
  createContextTools,
  validateTemplatePatchContent,
  diffCaptures,
} = require("../out/contextTools.js");

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

test("Dynamic Attribution Fixture A: Python f-string with interpolated variables and user input", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-fixture-a-fstring-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "assistant.py"),
      [
        "def build_agent_prompt(company: str, user_id: str, query: str) -> str:",
        "    return f'''You are a customer service assistant for {company}.",
        "User {user_id} says: {query}",
        "Follow compliance rule: NEVER disclose customer SSN or banking credentials.'''",
      ].join("\n") + "\n",
    );

    // Dynamic prompt sent to LLM with specific customer values
    const dynamicPrompt = [
      "You are a customer service assistant for Acme Corp.",
      "User 98421 says: Can you reset my password?",
      "Follow compliance rule: NEVER disclose customer SSN or banking credentials.",
    ].join("\n");

    const tools = attributionTools(root);
    let turns = 0;

    const res = await runHarness({
      system: ATTRIBUTION_SYSTEM,
      user: buildAttributionUserPrompt({
        content: dynamicPrompt,
        role: "system",
        projectName: "acme-service-bot",
      }),
      stepCap: 4,
      tools,
      complete: async () => {
        turns++;
        if (turns === 1) {
          return {
            content: "Isolating invariant compliance instruction and searching Python codebase.",
            toolCalls: [
              {
                id: "call-fa-1",
                name: "search_text",
                arguments: JSON.stringify({ query: "NEVER disclose customer SSN" }),
              },
            ],
          };
        }
        return {
          content: "Identified f-string prompt builder in src/assistant.py.",
          toolCalls: [
            {
              id: "call-fa-2",
              name: "attribute_prompt",
              arguments: JSON.stringify({
                file: "src/assistant.py",
                startLine: 1,
                endLine: 4,
                confidence: 0.95,
                explanation: "f-string template in src/assistant.py constructs prompt with dynamic user_id and query slots",
                matchedSnippet: "Follow compliance rule: NEVER disclose customer SSN",
              }),
            },
          ],
        };
      },
    });

    assert.ok(res.finish, "Should attribute f-string prompt");
    assert.equal(res.finish.file, "src/assistant.py");
    assert.equal(res.finish.startLine, 1);
    assert.equal(res.finish.endLine, 4);
    assert.equal(res.finish.confidence, 0.95);
    assert.equal(res.steps, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Dynamic Attribution Fixture B: Jinja2 template prompt with loops and conditional blocks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-fixture-b-jinja-"));
  try {
    fs.mkdirSync(path.join(root, "templates"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "templates", "review_analyst.jinja2"),
      [
        "{% for review in reviews %}",
        "- {{ review.title }}: {{ review.rating }}/5 stars",
        "{% endfor %}",
        "Task: Summarize product feedback strictly according to FTC endorsement guides.",
      ].join("\n") + "\n",
    );

    // Dynamic prompt rendering 3 dynamic customer reviews
    const dynamicPrompt = [
      "- Great product: 5/5 stars",
      "- Shipping took too long: 2/5 stars",
      "- Battery life is average: 3/5 stars",
      "Task: Summarize product feedback strictly according to FTC endorsement guides.",
    ].join("\n");

    const tools = attributionTools(root);
    let turns = 0;

    const res = await runHarness({
      system: ATTRIBUTION_SYSTEM,
      user: buildAttributionUserPrompt({
        content: dynamicPrompt,
        role: "user",
        projectName: "review-bot",
      }),
      stepCap: 4,
      tools,
      complete: async () => {
        turns++;
        if (turns === 1) {
          return {
            content: "Searching for invariant phrase 'FTC endorsement guides' across templates.",
            toolCalls: [
              {
                id: "call-fb-1",
                name: "search_text",
                arguments: JSON.stringify({ query: "FTC endorsement guides" }),
              },
            ],
          };
        }
        return {
          content: "Located Jinja2 template in templates/review_analyst.jinja2.",
          toolCalls: [
            {
              id: "call-fb-2",
              name: "attribute_prompt",
              arguments: JSON.stringify({
                file: "templates/review_analyst.jinja2",
                startLine: 1,
                endLine: 4,
                confidence: 0.95,
                explanation: "Jinja2 template iterating over dynamic customer reviews with FTC summary instructions",
                matchedSnippet: "Task: Summarize product feedback strictly according to FTC endorsement guides.",
              }),
            },
          ],
        };
      },
    });

    assert.ok(res.finish, "Should attribute Jinja2 template");
    assert.equal(res.finish.file, "templates/review_analyst.jinja2");
    assert.equal(res.finish.startLine, 1);
    assert.equal(res.finish.endLine, 4);
    assert.equal(res.finish.confidence, 0.95);
    assert.equal(res.steps, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Dynamic Attribution Fixture C: RAG pipeline injecting dynamic context snippets into system template", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-fixture-c-rag-"));
  try {
    fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "prompts", "rag_system.prompt"),
      [
        "You are an internal corporate policy advisor.",
        "Answer questions strictly using the retrieved knowledge chunks below.",
        "Core Directive: If the retrieved policy does not answer the question, state 'Policy does not specify.'",
      ].join("\n") + "\n",
    );

    // Dynamic RAG prompt with 3 injected handbook chunks
    const dynamicPrompt = [
      "You are an internal corporate policy advisor.",
      "Answer questions strictly using the retrieved knowledge chunks below.",
      "Core Directive: If the retrieved policy does not answer the question, state 'Policy does not specify.'",
      "",
      "--- RETRIEVED CONTEXT CHUNKS ---",
      "Chunk 1: Remote work policy allows up to 2 days per week with manager approval.",
      "Chunk 2: Expense reimbursement requests must be submitted within 30 days of travel.",
      "Chunk 3: Medical benefits begin on the first day of the month following hire date.",
    ].join("\n");

    const tools = attributionTools(root);
    let turns = 0;

    const res = await runHarness({
      system: ATTRIBUTION_SYSTEM,
      user: buildAttributionUserPrompt({
        content: dynamicPrompt,
        role: "system",
        projectName: "policy-rag-agent",
      }),
      stepCap: 4,
      tools,
      complete: async () => {
        turns++;
        if (turns === 1) {
          return {
            content: "Filtering dynamic RAG chunks and searching for corporate policy advisor directive.",
            toolCalls: [
              {
                id: "call-fc-1",
                name: "search_text",
                arguments: JSON.stringify({ query: "Policy does not specify" }),
              },
            ],
          };
        }
        return {
          content: "Attributed system template to prompts/rag_system.prompt.",
          toolCalls: [
            {
              id: "call-fc-2",
              name: "attribute_prompt",
              arguments: JSON.stringify({
                file: "prompts/rag_system.prompt",
                startLine: 1,
                endLine: 3,
                confidence: 0.98,
                explanation: "System prompt template in prompts/rag_system.prompt defining RAG advisor instructions and refusal directive",
                matchedSnippet: "Core Directive: If the retrieved policy does not answer",
              }),
            },
          ],
        };
      },
    });

    assert.ok(res.finish, "Should attribute RAG system prompt template");
    assert.equal(res.finish.file, "prompts/rag_system.prompt");
    assert.equal(res.finish.startLine, 1);
    assert.equal(res.finish.endLine, 3);
    assert.equal(res.finish.confidence, 0.98);
    assert.equal(res.steps, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Telemetry Fixture A: 12-turn conversational chat with history collapse and bloat advisory", async () => {
  // Construct a 12-turn dialogue (system prompt + 5 user/assistant turns + active user query)
  const messages = [
    {
      role: "system",
      content: "You are an autonomous engineering assistant. Answer concisely and use standard markdown format.",
      truncated: false,
    },
    // Turn 1
    { role: "user", content: "How do I list files in Linux?", truncated: false },
    { role: "assistant", content: "Use the ls command, for example ls -la.", truncated: false },
    // Turn 2
    { role: "user", content: "How do I check free disk space?", truncated: false },
    { role: "assistant", content: "Use df -h to see human-readable disk free space.", truncated: false },
    // Turn 3
    { role: "user", content: "What about RAM usage?", truncated: false },
    { role: "assistant", content: "Use free -m or free -h.", truncated: false },
    // Turn 4
    { role: "user", content: "How do I monitor running processes?", truncated: false },
    { role: "assistant", content: "You can use top, htop, or ps aux.", truncated: false },
    // Turn 5
    { role: "user", content: "How do I kill an unresponsive process?", truncated: false },
    { role: "assistant", content: "Find the PID and run kill -9 <PID>.", truncated: false },
    // Active query (Turn 6)
    { role: "user", content: "Can you write a system monitoring bash script that checks all of these?", truncated: false },
  ];

  // 1. Context Decomposition
  const sections = extractContextSections(messages);
  assert.equal(sections.length, 3, "Should produce 3 sections: system, collapsed history, and active query");

  assert.equal(sections[0].heuristicCategory, "system_instruction");
  assert.equal(sections[0].role, "system");

  assert.equal(sections[1].heuristicCategory, "chat_history");
  assert.equal(sections[1].isCollapsedHistory, true);
  assert.equal(sections[1].turns, 5, "Should collapse 5 prior user turns");
  assert.deepEqual(sections[1].messageIndices, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  assert.equal(sections[2].heuristicCategory, "user_query");
  assert.equal(sections[2].messageIndex, 11);

  // 2. Simulated Meta AI Telemetry Response
  const mockModelOutput = JSON.stringify({
    sections: [
      {
        sectionId: sections[0].sectionId,
        category: "system_instruction",
        what: "Engineering Assistant Persona & Formatting Rules",
        why: "Guides model tone and mandates markdown formatting.",
      },
      {
        sectionId: sections[1].sectionId,
        category: "chat_history",
        what: "Linux CLI Troubleshooting Dialogue Backlog (5 turns)",
        why: "Preserves conversational history so the model knows which commands to include in the script.",
        warning: "Dialogue backlog consumes 68% of token budget; consider pruning turns 1-3.",
      },
      {
        sectionId: sections[2].sectionId,
        category: "user_query",
        what: "Bash Script Generation Request",
        why: "Primary user instruction for the completion.",
      },
    ],
    warnings: ["Chat history backlog is heavy (68% of context window)"],
  });

  const parsed = parseTelemetryResponse(mockModelOutput);
  assert.ok(parsed);

  const telemetry = applyTelemetryResponse("fixture-a-cap", sections, parsed);
  assert.equal(telemetry.sections.length, 3);
  assert.equal(telemetry.sections[0].what, "Engineering Assistant Persona & Formatting Rules");
  assert.equal(telemetry.sections[1].category, "chat_history");
  assert.match(telemetry.sections[1].warning, /pruning turns/);
  assert.ok(telemetry.warnings.some((w) => w.includes("heavy")));

  // Verify composition calculation
  const historyComp = telemetry.composition.find((c) => c.category === "chat_history");
  assert.ok(historyComp);
  assert.ok(historyComp.percentage > 50, "Chat history should represent majority of token percentage");
});

test("Telemetry Fixture B: RAG pipeline with 3 vector search context chunks and citation instructions", async () => {
  const compositeRagPrompt = [
    "Reference Documents:",
    "Doc 1: PostgreSQL 16 streaming replication configuration requires setting wal_level = replica.",
    "Doc 2: Automatic failover in Patroni uses DCS (etcd/Consul) to achieve consensus on leader promotion.",
    "Doc 3: Standby nodes must configure primary_conninfo pointing to active primary VIP.",
    "",
    "Question: How does Patroni decide which replica to promote when primary goes offline?",
  ].join("\n");

  const messages = [
    {
      role: "system",
      content: "You are an infrastructure database architect. Answer strictly based on the provided reference documents. Cite Doc numbers.",
      truncated: false,
    },
    {
      role: "user",
      content: compositeRagPrompt,
      truncated: false,
    },
  ];

  // 1. Context Decomposition should split composite RAG into RAG grounding + user query
  const sections = extractContextSections(messages);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].heuristicCategory, "system_instruction");
  assert.equal(sections[1].heuristicCategory, "rag_grounding");
  assert.equal(sections[2].heuristicCategory, "user_query");

  // 2. Telemetry Generation
  const cache = new TelemetryCache(50);
  const mockModelOutput = JSON.stringify({
    sections: [
      {
        sectionId: sections[0].sectionId,
        category: "system_instruction",
        what: "DBA Architect Persona & Citation Constraints",
        why: "Mandates citation of source documents and prevents speculative answers.",
      },
      {
        sectionId: sections[1].sectionId,
        category: "rag_grounding",
        what: "PostgreSQL 16 High Availability & Failover Documentation",
        why: "Supplies external DCS and Patroni consensus facts required to answer the query.",
      },
      {
        sectionId: sections[2].sectionId,
        category: "user_query",
        what: "Patroni Promotion Mechanism Query",
        why: "Direct user prompt for the assistant to resolve using retrieved docs.",
      },
    ],
  });

  const parsed = parseTelemetryResponse(mockModelOutput);
  const telemetry = applyTelemetryResponse("fixture-b-cap", sections, parsed, cache);

  assert.equal(telemetry.sections.length, 3);
  const ragSection = telemetry.sections.find((s) => s.category === "rag_grounding");
  assert.ok(ragSection);
  assert.equal(ragSection.what, "PostgreSQL 16 High Availability & Failover Documentation");
  assert.match(ragSection.why, /Patroni consensus/);

  // 3. Verify bridge to Sensory Attribution Harness:
  // Using the extracted RAG section content, we can run attributionTools to locate the documentation file in the repo
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-demo-rag-telemetry-"));
  try {
    fs.mkdirSync(path.join(root, "docs", "architecture"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "docs", "architecture", "postgres_ha.md"),
      [
        "# PostgreSQL 16 HA Architecture",
        "Automatic failover in Patroni uses DCS (etcd/Consul) to achieve consensus on leader promotion.",
        "Standby nodes must configure primary_conninfo pointing to active primary VIP.",
      ].join("\n"),
    );

    const tools = attributionTools(root);
    const searchTool = tools.find((t) => t.name === "search_text");
    const searchResult = await searchTool.run({ query: "Patroni uses DCS" });
    assert.match(searchResult.content, /postgres_ha\.md/);
    assert.match(searchResult.content, /consensus on leader promotion/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Telemetry Fixture C: Tool-calling agent context with complex JSON schema definitions and cache reuse", async () => {
  const toolDefinitions = [
    {
      type: "function",
      function: {
        name: "execute_sql_query",
        description: "Executes a read-only SQL query against the analytics database replica.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "SELECT query to run" },
            max_rows: { type: "integer", default: 100 },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generate_chart",
        description: "Renders an interactive chart artifact from structured data points.",
        parameters: {
          type: "object",
          properties: {
            chart_type: { type: "string", enum: ["bar", "line", "scatter"] },
            data: { type: "array" },
          },
          required: ["chart_type", "data"],
        },
      },
    },
  ];

  const messages = [
    { role: "system", content: "You are a quantitative data analyst.", truncated: false },
    { role: "tools", content: JSON.stringify(toolDefinitions, null, 2), truncated: false },
    { role: "user", content: "Plot the monthly active users for 2026.", truncated: false },
  ];

  // 1. Context Decomposition identifies schema_tool_spec
  const sections = extractContextSections(messages);
  assert.equal(sections.length, 3);
  assert.equal(sections[1].heuristicCategory, "schema_tool_spec");
  assert.equal(sections[1].role, "tools");

  // 2. Cache test: TelemetryCache stores tool specification analysis
  const cache = new TelemetryCache(50);
  const mockModelOutput = JSON.stringify({
    sections: [
      {
        sectionId: sections[0].sectionId,
        category: "system_instruction",
        what: "Quantitative Analyst Persona",
        why: "Directs statistical tone and analytical approach.",
      },
      {
        sectionId: sections[1].sectionId,
        category: "schema_tool_spec",
        what: "Analytics DB & Charting Function Schemas",
        why: "Enables model to execute SQL queries and render interactive visualizations.",
      },
      {
        sectionId: sections[2].sectionId,
        category: "user_query",
        what: "Monthly Active Users Visualization Query",
        why: "Specific analytical directive for this run.",
      },
    ],
  });

  const parsed = parseTelemetryResponse(mockModelOutput);
  const telemetry1 = applyTelemetryResponse("fixture-c-1", sections, parsed, cache);

  // Tools fingerprint is now cached
  const toolsFingerprint = sections[1].fingerprint;
  assert.equal(cache.has(toolsFingerprint), true);
  assert.equal(cache.get(toolsFingerprint).what, "Analytics DB & Charting Function Schemas");

  // Subsequent request with novel user query but identical tool definitions hits cache in 0 tokens / 0 ms
  const messages2 = [
    { role: "system", content: "You are a quantitative data analyst.", truncated: false },
    { role: "tools", content: JSON.stringify(toolDefinitions, null, 2), truncated: false },
    { role: "user", content: "Compute churn rate for Q2.", truncated: false },
  ];

  const sections2 = extractContextSections(messages2);
  const telemetry2 = applyTelemetryResponse("fixture-c-2", sections2, null, cache);

  // Tool section re-used from cache without model call
  const cachedToolSection = telemetry2.sections.find((s) => s.category === "schema_tool_spec");
  assert.ok(cachedToolSection);
  assert.equal(cachedToolSection.what, "Analytics DB & Charting Function Schemas");
  assert.equal(cachedToolSection.why, "Enables model to execute SQL queries and render interactive visualizations.");
});

test("Context Interrogation & Prompt Co-Pilot Fixture: RAG app with contradictory retrieval, comparative diffing & template patch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-copilot-fixture-"));
  try {
    // 1. Create source template file in the repository
    const promptsDir = path.join(root, "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    const promptFile = path.join(promptsDir, "support_agent.prompt");
    const templateContent = [
      "You are a helpful customer support agent for AcmeCorp.",
      "Rule 1: Always greet warmly and professionally.",
      "Rule 2: Never mention competitor FooCorp under any circumstance.",
      "Rule 3: Keep responses focused and accurate.",
    ].join("\n");
    fs.writeFileSync(promptFile, templateContent);

    // 2. Simulated captured prompt (with conflicting RAG documents injected)
    const primaryCapture = {
      id: "cap_turn_rag_conflict",
      model: "meta/muse-spark-1.3",
      provider: "Meta AI",
      status: 500,
      error: "Internal error: generated response violated negative constraint policy",
      messages: [
        {
          role: "system",
          content: templateContent,
          truncated: false,
        },
        {
          role: "user",
          content: "Hello, I am considering switching to your Enterprise plan.",
          truncated: false,
        },
        {
          role: "assistant",
          content: "Hello! Welcome to AcmeCorp. How can I help with your plan?",
          truncated: false,
        },
        {
          role: "user",
          content: [
            "Reference Documents:",
            "Document 1: FooCorp offers 25% lower seat pricing than AcmeCorp.",
            "Document 2: AcmeCorp offers 24/7 dedicated engineering support.",
            "",
            "User Question:",
            "How does your pricing compare with FooCorp?",
          ].join("\n"),
          truncated: false,
        },
      ],
      reply: "Error: Generation terminated due to constraint violation",
      reported: [
        {
          messageIndex: 0,
          file: "prompts/support_agent.prompt",
          startLine: 1,
          endLine: 4,
          explanation: "Matches system support agent prompt template",
        },
      ],
      telemetry: {
        captureId: "cap_turn_rag_conflict",
        analyzedAt: "2026-11-01T12:00:00Z",
        totalTokens: 140,
        composition: [
          { category: "system_instruction", categoryLabel: "System", tokens: 35, percentage: 25, colorVar: "green" },
          { category: "chat_history", categoryLabel: "Chat History", tokens: 25, percentage: 18, colorVar: "orange" },
          { category: "rag_grounding", categoryLabel: "RAG Grounding", tokens: 55, percentage: 39, colorVar: "purple" },
          { category: "user_query", categoryLabel: "User Query", tokens: 25, percentage: 18, colorVar: "blue" },
        ],
        sections: [
          {
            sectionId: "msg-0",
            messageIndex: 0,
            category: "system_instruction",
            categoryLabel: "System",
            what: "AcmeCorp Agent Guidelines & Safety Guardrails",
            why: "Enforces brand tone and competitive restrictions",
            tokenEstimate: 35,
            tokenPercentage: 25,
          },
          {
            sectionId: "msg-3-rag",
            messageIndex: 3,
            category: "rag_grounding",
            categoryLabel: "RAG Grounding",
            what: "Retrieved Pricing & Competitor Comparison Documents",
            why: "Grounds response in competitor comparison docs",
            tokenEstimate: 55,
            tokenPercentage: 39,
            warning: "Contains explicit competitor references that conflict with Rule #2",
          },
        ],
        warnings: [],
      },
    };

    // Prior successful turn (baseline without RAG conflict)
    const baselineCapture = {
      id: "cap_turn_baseline_success",
      model: "meta/muse-spark-1.3",
      status: 200,
      error: null,
      messages: [
        { role: "system", content: templateContent, truncated: false },
        { role: "user", content: "What are your support hours?", truncated: false },
      ],
      reply: "We offer 24/7 dedicated engineering support.",
    };

    // 3. Verify context skeleton and grounded copilot system prompt
    const skeleton = buildContextSkeleton(primaryCapture);
    assert.ok(skeleton.includes("Total Sections: 4"));
    assert.ok(skeleton.includes("msg-0"));
    assert.ok(skeleton.includes("AcmeCorp Agent Guidelines"));
    assert.ok(skeleton.includes("msg-3-rag"));

    const systemPrompt = buildContextCopilotSystem({
      projectName: "AcmeService",
      projectPath: root,
      captureId: primaryCapture.id,
      model: primaryCapture.model,
      provider: primaryCapture.provider,
      totalTokens: 140,
      scope: { kind: "global", label: "All Context" },
      contextSkeleton: skeleton,
      compareId: baselineCapture.id,
      compareModel: baselineCapture.model,
      compareSkeleton: buildContextSkeleton(baselineCapture),
    });

    assert.ok(systemPrompt.includes("You are Context Tracker's Prompt Co-Pilot"));
    assert.ok(systemPrompt.includes("diff_captures"));

    // 4. Verify comparative diff analysis
    const diff = diffCaptures(primaryCapture, baselineCapture);
    assert.equal(diff.statusComparison.primaryStatus, 500);
    assert.equal(diff.statusComparison.compareStatus, 200);
    assert.ok(diff.keyDivergences.some((k) => k.includes("Primary capture contains RAG grounding")));

    // 5. Test Meta AI autonomous co-pilot multi-turn interrogation:
    // Turn 1: diff_captures + search_context
    // Turn 2: inspect_code_template
    // Turn 3: propose_template_patch
    const tools = createContextTools({
      capture: primaryCapture,
      compareCapture: baselineCapture,
      projectPath: root,
    });

    let turn = 0;
    const mockMetaAiModel = async (messages, toolSpecs) => {
      turn += 1;
      if (turn === 1) {
        return {
          content: "I will call diff_captures and search_context to identify what changed and why the prompt failed.",
          toolCalls: [
            {
              id: "call_diff_1",
              name: "diff_captures",
              arguments: "{}",
            },
            {
              id: "call_search_1",
              name: "search_context",
              arguments: JSON.stringify({ query: "FooCorp" }),
            },
          ],
        };
      }
      if (turn === 2) {
        return {
          content: "The retrieved RAG document injects FooCorp pricing, clashing with System Rule 2. Let me inspect the source template.",
          toolCalls: [
            {
              id: "call_inspect_1",
              name: "inspect_code_template",
              arguments: JSON.stringify({ sectionId: "msg-0" }),
            },
          ],
        };
      }
      return {
        content: "Proposing a safe rule refactor that permits objective comparisons without policy violation.",
        toolCalls: [
          {
            id: "call_patch_1",
            name: "propose_template_patch",
            arguments: JSON.stringify({
              file: "prompts/support_agent.prompt",
              startLine: 3,
              endLine: 3,
              originalCode: "Rule 2: Never mention competitor FooCorp under any circumstance.",
              replacementCode: "Rule 2: If customer asks about competitors, focus objectively on AcmeCorp strengths.",
              explanation: "Resolves contradiction between retrieved competitor documents and rigid refusal directive.",
              tokenImpactEstimate: "+2 tokens",
            }),
          },
        ],
      };
    };

    const harnessResult = await runHarness({
      system: systemPrompt,
      user: buildDetectContradictionsPrompt(),
      tools,
      stepCap: 6,
      complete: mockMetaAiModel,
    });

    assert.equal(harnessResult.steps, 3);
    assert.ok(harnessResult.finish);
    const patch = harnessResult.finish;
    assert.equal(patch.file, "prompts/support_agent.prompt");
    assert.equal(patch.startLine, 3);
    assert.ok(patch.diffPreview.includes("-Rule 2: Never mention competitor FooCorp"));
    assert.ok(patch.diffPreview.includes("+Rule 2: If customer asks about competitors"));

    // 6. Verify pre-apply content validation on disk
    const onDiskContent = fs.readFileSync(promptFile, "utf8");
    const validation = validateTemplatePatchContent(
      onDiskContent,
      patch.startLine,
      patch.endLine,
      patch.originalCode,
    );
    assert.equal(validation.valid, true);

    // Apply the patch safely
    const patchedContent = onDiskContent.replace(patch.originalCode, patch.replacementCode);
    fs.writeFileSync(promptFile, patchedContent);

    // Verify updated content on disk
    const updatedOnDisk = fs.readFileSync(promptFile, "utf8");
    assert.ok(updatedOnDisk.includes("focus objectively on AcmeCorp strengths"));
    assert.ok(!updatedOnDisk.includes("Never mention competitor FooCorp under any circumstance"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


