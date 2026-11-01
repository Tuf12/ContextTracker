import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import type { HelperTool } from "./harness";
import { isHomeConfigPath, isInside, resolveAddressFile, toRelative } from "./paths";
import { isSecretFile, redactText } from "./redact";
import type { AddressOffer, AttributedSpan } from "./types";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "__pycache__", ".venv", "venv"]);
const MAX_FILE = 200_000;
const MAX_MATCHES = 30;
const MAX_LIST = 200;

export const ADDRESS_SYSTEM = [
  "You are Context Tracker's autonomous AI connection agent powered by Meta AI models (Muse Spark and Muse Wonder).",
  "Your mission is to find the exact HTTP or HTTPS base address this project uses to communicate with an AI model provider (such as Ollama on localhost:11434, OpenAI, Anthropic, Chutes, vLLM, OpenRouter, LangChain, LlamaIndex, or custom HTTP clients) so Context Tracker can capture prompt traffic.",
  "",
  "### ARCHITECTURE & CLIENT CLASSIFICATION",
  "Analyze the project's codebase to classify the LLM client architecture:",
  "1. LLM Client / SDK: OpenAI SDK, Anthropic SDK, Ollama REST API, Chutes, vLLM, OpenRouter, LangChain, LlamaIndex, or raw HTTP client (fetch, requests, axios, httpx, aiohttp, urllib, etc.).",
  "2. Configuration Sourcing Hierarchy:",
  "   - Type A (Environment Variables): .env, process.env, os.environ (e.g. OPENAI_BASE_URL, ANTHROPIC_BASE_URL, OLLAMA_HOST).",
  "   - Type B (In-Tree Config Files): config.yaml, config.json, settings.json, appsettings.json in the repository.",
  "   - Type C (External User/System Configs): files loaded from ~/.config/<app>/..., ~/.<app>/..., or %APPDATA%/<app>/...",
  "   - Type D (In-Code Default Fallbacks): hardcoded fallback literals in source code (e.g. const fallback = 'http://127.0.0.1:11434').",
  "",
  "### RUNTIME DECISION RULE & PRECEDENCE",
  "- CRITICAL: If an application defines a fallback in source code (Type D) but reads an active configuration from disk (Type A, B, or C), Type D is inert at runtime. You MUST propose the active configuration file (Type A, B, or C) that the application reads at runtime.",
  "- If source code loads an external user configuration (e.g. in ~/.config/<app>/ or ~/.<app>/), call find_user_config_dirs to discover the active config files on disk, inspect them with read_file, and propose the address configured inside that user config file.",
  "",
  "### SENSORY GROUNDING & LOCAL SERVICES",
  "- Call detect_local_services when checking local model endpoints (Ollama on 11434, LM Studio on 1234, vLLM/LocalAI on 8000, Text Generation WebUI on 5000) to ground whether a service is actively listening on this machine.",
  "- Call find_user_config_dirs with app hints when the app refers to user configuration directories or when checking for external runtime configurations.",
  "",
  "### PARALLEL TOOL CALLING EFFICIENCY",
  "- Muse Spark 1.3 and Muse Wonder support parallel tool calling. In your initial turn, batch your reconnaissance into parallel tool calls! For example, simultaneously query detect_local_services, find_user_config_dirs, and search_text or read_file in a single turn.",
  "- This enables single-turn or 2-turn resolution without unnecessary roundtrips.",
  "",
  "### RULES & CONSTRAINTS",
  "- Do not invent a URL. The proposed URL must exist verbatim in the file you propose.",
  "- Port 47321 is Context Tracker's own recording proxy; never propose port 47321.",
  "- When you identify the active file and the exact URL configured there, call propose_address to finish.",
].join("\n");

export const ATTRIBUTION_SYSTEM = [
  "You are Context Tracker's autonomous Semantic Prompt Attribution agent powered by Meta AI models (Muse Spark and Muse Wonder).",
  "Your mission is to inspect a prompt that was sent to an LLM provider and reverse-engineer which source file, template, or prompt-builder function in the codebase generated this prompt.",
  "",
  "### DYNAMIC INTERPOLATION & TEMPLATE SKELETONS",
  "Modern AI applications construct prompts dynamically using template engines (Jinja2, Mustache, f-strings, LangChain PromptTemplates, YAML/JSON configs) with dynamic runtime variable slots.",
  "1. Separate Dynamic Runtime Data from Invariant Template Instructions:",
  "   - Dynamic slots: specific user queries, current timestamps, database records, IDs, retrieved RAG context chunks.",
  "   - Invariant skeleton: system instructions, role descriptions, output formatting rules, schema definitions, template placeholders (e.g. {{ variable }} or {slot}).",
  "2. Formulate Sensory Searches:",
  "   - Do NOT search for the entire prompt verbatim, as dynamic values will prevent matches.",
  "   - Extract unique, high-specificity phrases (e.g. 10-40 character distinctive phrases from the system instruction or template skeleton).",
  "   - Use search_text with single or multiple queries to find candidate files across the codebase.",
  "3. Verify and Pinpoint:",
  "   - Inspect candidate files with read_file.",
  "   - Match the template text or prompt-builder code.",
  "   - Determine the exact file and the 1-based startLine and endLine where the prompt is defined.",
  "",
  "### PARALLEL RECONNAISSANCE EFFICIENCY",
  "- Muse Spark 1.3 and Muse Wonder support parallel tool calling. In your initial turn, run parallel search_text calls across multiple candidate phrases from the prompt to locate candidate files in 1 turn.",
  "",
  "### FINISH TOOL",
  "- Once you have confirmed the file and line range, call attribute_prompt with file, startLine, endLine, confidence (0.0 to 1.0), an explanation, and the matchedSnippet.",
].join("\n");

export function addressTools(
  root: string,
  options?: { failedFile?: string; failedUrl?: string },
): Array<HelperTool<AddressOffer>> {
  return [
    {
      name: "list_files",
      description: "List the names in one project directory. path is relative to the project root. Use . for the root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      run: (args) => ({ content: listFiles(root, stringField(args, "path") || ".") }),
    },
    {
      name: "search_text",
      description: "Search project text for a literal query, regex pattern, or multiple queries. Returns redacted matching lines.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query or regex pattern (e.g. '11434|ollama|base_url')." },
          queries: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of multiple search terms to match in one pass.",
          },
        },
      },
      run: (args) => ({ content: searchText(root, args) }),
    },
    {
      name: "read_file",
      description: "Read a text file in the project, or an absolute saved-config path under the user home directory. Secret values are replaced with [private].",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      run: (args) => ({ content: readFile(root, stringField(args, "path")) }),
    },
    {
      name: "find_user_config_dirs",
      description: "Check user configuration locations (~/.config, ~/.<name>, and %APPDATA%) for directories and configuration files matching the application's name or hints. Returns existing directories and configuration files found on disk.",
      parameters: {
        type: "object",
        properties: {
          app_hints: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of application name hints or identifiers to search for (e.g. ['optimalx', 'eidosbot']). Inferred from project name and package.json if omitted.",
          },
        },
      },
      run: (args) => ({ content: findUserConfigDirs(root, args) }),
    },
    {
      name: "detect_local_services",
      description: "Detect which common local AI model servers (Ollama on 11434, LM Studio on 1234, vLLM/LocalAI on 8000, Text Generation WebUI on 5000) are actively listening on localhost.",
      parameters: {
        type: "object",
        properties: {},
      },
      run: async () => ({ content: await detectLocalServices() }),
    },
    {
      name: "propose_address",
      description: "Finish with the file and the exact HTTP URL currently written in that file.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
          url: { type: "string" },
          reason: { type: "string" },
        },
        required: ["file", "url", "reason"],
      },
      run: (args) => proposeAddress(root, args, options),
    },
  ];
}

export function proposeAddress(
  root: string,
  args: unknown,
  options?: { failedFile?: string; failedUrl?: string },
): { content: string; finish?: AddressOffer } {
  const file = stringField(args, "file");
  const url = stringField(args, "url");
  const reason = stringField(args, "reason").slice(0, 200);
  if (!file || !url) {
    return { content: "file and url are required." };
  }
  if (!isHttpUrl(url)) {
    return { content: "The url must start with http:// or https://." };
  }
  if (isCaptureUrl(url)) {
    return { content: "That address is the capture recorder. Find the project's own address." };
  }
  const absolute = resolveAddressFile(root, file);
  if (!absolute) {
    return { content: "That file is not in the project." };
  }
  if (isSecretFile(absolute)) {
    return { content: "That file is private. Find the address in another file." };
  }
  if (options?.failedFile) {
    const failedAbs = resolveAddressFile(root, options.failedFile);
    if (failedAbs && absolute === failedAbs) {
      return {
        content: `This file (${toRelative(root, absolute)}) was already armed and bypassed. Diagnose why it was bypassed, investigate other configuration files (such as user config directories), and propose the active address configured in that other file.`,
      };
    }
  }
  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch {
    return { content: "That file could not be read." };
  }
  const lines = text.split(/\r?\n/);
  const lineIndex = lines.findIndex((line) => line.includes(url));
  if (lineIndex < 0) {
    return { content: "That URL is not in the file." };
  }
  const detectedConfig = detectSourceConfigFile(absolute, text);
  if (detectedConfig) {
    return {
      content: `This file (${toRelative(root, absolute)}) is source code defining fallback defaults, but it references an active user configuration file at ${detectedConfig}. Please read ${detectedConfig} and call propose_address with that configuration file and the URL configured inside it so the running application connects to capture.`,
    };
  }
  return {
    content: "Address accepted.",
    finish: {
      relativeFile: isInside(root, absolute) ? toRelative(root, absolute) : absolute,
      line: lineIndex + 1,
      url,
      reason,
    },
  };
}

export function detectSourceConfigFile(filePath: string, text: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (![".js", ".ts", ".mjs", ".cjs", ".py"].includes(ext)) {
    return null;
  }
  const home = os.homedir();

  const match1 = text.match(/['"]\.config['"]\s*,\s*['"]([a-zA-Z0-9_-]+)['"]/i) ||
                 text.match(/\.config[/\\]([a-zA-Z0-9_-]+)/i);
  if (match1) {
    const appFolder = match1[1];
    for (const name of ["config.json", "config.yaml", "config.yml", ".env", "settings.json"]) {
      const candidate = path.join(home, ".config", appFolder, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }

  const match2 = text.match(/~[/\\]\.([a-zA-Z0-9_-]+)[/\\]([a-zA-Z0-9_.-]+)/);
  if (match2) {
    const candidate = path.join(home, "." + match2[1], match2[2]);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export function attributionTools(root: string): Array<HelperTool<AttributedSpan>> {
  return [
    {
      name: "list_files",
      description: "List the names in one project directory. path is relative to the project root. Use . for the root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      run: (args) => ({ content: listFiles(root, stringField(args, "path") || ".") }),
    },
    {
      name: "search_text",
      description: "Search project text for a literal query, regex pattern, or multiple queries. Returns redacted matching lines.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query or regex pattern (e.g. 'You are a helpful assistant')." },
          queries: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of multiple search terms to match in one pass.",
          },
        },
      },
      run: (args) => ({ content: searchText(root, args) }),
    },
    {
      name: "read_file",
      description: "Read a text file in the project. Secret values are replaced with [private].",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      run: (args) => ({ content: readFile(root, stringField(args, "path")) }),
    },
    {
      name: "attribute_prompt",
      description: "Finish by attributing the prompt to a specific file and line range in the project.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Relative file path in the project that constructed or contains the prompt." },
          startLine: { type: "integer", description: "1-based starting line number in the file." },
          endLine: { type: "integer", description: "1-based ending line number in the file." },
          confidence: { type: "number", description: "Attribution confidence score between 0.0 and 1.0." },
          explanation: { type: "string", description: "Concise reason explaining why this file/line generated the prompt." },
          matchedSnippet: { type: "string", description: "Snippet from the file that matches the prompt template or builder." },
        },
        required: ["file", "startLine", "endLine", "confidence", "explanation"],
      },
      run: (args) => attributePrompt(root, args),
    },
  ];
}

export function attributePrompt(root: string, args: unknown): { content: string; finish?: AttributedSpan } {
  if (!args || typeof args !== "object") {
    return { content: "Arguments object is required." };
  }
  const rec = args as Record<string, unknown>;
  const file = typeof rec.file === "string" ? rec.file.trim() : "";
  const explanation = typeof rec.explanation === "string" ? rec.explanation.trim() : "";
  const matchedSnippet = typeof rec.matchedSnippet === "string" ? rec.matchedSnippet.trim() : "";
  const startLine = typeof rec.startLine === "number" ? Math.floor(rec.startLine) : parseInt(String(rec.startLine ?? ""), 10);
  const endLine = typeof rec.endLine === "number" ? Math.floor(rec.endLine) : parseInt(String(rec.endLine ?? ""), 10);

  if (!file) {
    return { content: "file is required." };
  }
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
    return { content: "startLine and endLine must be valid positive integers where endLine >= startLine." };
  }

  const absolute = resolveAddressFile(root, file);
  if (!absolute) {
    return { content: "That file is not in the project or allowed configuration paths." };
  }
  if (isSecretFile(absolute)) {
    return { content: "That file is private and cannot be attributed." };
  }

  let text: string;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch {
    return { content: "That file could not be read." };
  }

  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  if (startLine > totalLines) {
    return { content: `startLine (${startLine}) exceeds the total lines in the file (${totalLines}).` };
  }

  const clampedEnd = Math.min(endLine, totalLines);
  const targetSlice = lines.slice(startLine - 1, clampedEnd).join("\n").trim();
  if (!targetSlice) {
    return { content: "The specified line range is empty." };
  }

  if (matchedSnippet) {
    const fileContentLower = text.toLowerCase();
    const cleanSnippet = matchedSnippet.toLowerCase();
    const snippetLines = cleanSnippet.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 5);
    const hasOverlap = fileContentLower.includes(cleanSnippet) ||
      snippetLines.some((l) => fileContentLower.includes(l));
    if (!hasOverlap) {
      return { content: "The matched snippet was not found in the file." };
    }
  }

  const rawConf = typeof rec.confidence === "number" ? rec.confidence : parseFloat(String(rec.confidence ?? "0.8"));
  const confidence = Number.isFinite(rawConf) ? Math.max(0.1, Math.min(1.0, rawConf)) : 0.8;

  const relative = isInside(root, absolute) ? toRelative(root, absolute) : absolute;
  return {
    content: "Attribution accepted.",
    finish: {
      file: relative,
      startLine,
      endLine: clampedEnd,
      confidence,
      explanation: explanation || `Prompt originates from ${relative}:${startLine}-${clampedEnd}`,
      matchedSnippet: matchedSnippet || targetSlice.slice(0, 200),
    },
  };
}

function listFiles(root: string, relativeDir: string): string {
  const absolute = resolveInside(root, relativeDir);
  if (!absolute) {
    return "That path is not in the project.";
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return "That path does not exist.";
  }
  if (!stat.isDirectory()) {
    return "That path is a file. Use read_file.";
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return "That directory could not be read.";
  }
  const names = entries
    .filter((entry) => entry.name !== ".git")
    .slice(0, MAX_LIST)
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"} ${entry.name}`);
  return names.join("\n") || "(empty)";
}

function compileSearchPattern(query?: string, queries?: string[]): RegExp | null {
  const parts: string[] = [];
  if (Array.isArray(queries)) {
    for (const q of queries) {
      if (typeof q === "string" && q.trim().length >= 2) {
        parts.push(escapeRegex(q.trim()));
      }
    }
  }
  if (typeof query === "string" && query.trim().length >= 2) {
    const trimmed = query.trim();
    try {
      new RegExp(trimmed);
      parts.push(`(?:${trimmed})`);
    } catch {
      parts.push(escapeRegex(trimmed));
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return new RegExp(parts.join("|"), "i");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchText(root: string, args: unknown): string {
  let query: string | undefined;
  let queries: string[] | undefined;
  if (typeof args === "string") {
    query = args;
  } else if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.query === "string") {
      query = record.query;
    }
    if (Array.isArray(record.queries)) {
      queries = record.queries.filter((item): item is string => typeof item === "string");
    }
  }
  const regex = compileSearchPattern(query, queries);
  if (!regex) {
    return "The query must be at least 2 characters.";
  }
  const matches: string[] = [];
  walk(root, root, (file) => {
    if (matches.length >= MAX_MATCHES || isSecretFile(toRelative(root, file))) {
      return;
    }
    let text: string;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE) {
        return;
      }
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    if (text.includes("\u0000") || !regex.test(text)) {
      return;
    }
    const relative = toRelative(root, file);
    text.split(/\r?\n/).forEach((line, index) => {
      if (matches.length >= MAX_MATCHES || !regex.test(line)) {
        return;
      }
      matches.push(`${relative}:${index + 1}: ${redactText(line)}`);
    });
  });
  return matches.join("\n") || "No matches.";
}

function readFile(root: string, relativeFile: string): string {
  if (!relativeFile) {
    return "path is required.";
  }
  const absolute = resolveAddressFile(root, relativeFile);
  if (!absolute) {
    return "That file is not in the project.";
  }
  if (isSecretFile(absolute)) {
    return "This file is private and was not read.";
  }
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_FILE) {
      return "That file is too large to read.";
    }
    const text = fs.readFileSync(absolute, "utf8");
    if (text.includes("\u0000")) {
      return "That file is not text.";
    }
    return redactText(text);
  } catch {
    return "That file could not be read.";
  }
}

function walk(root: string, current: string, visit: (file: string) => void): void {
  if (!isInside(root, current)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = path.join(current, entry.name);
    if (!isInside(root, absolute)) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(root, absolute, visit);
      continue;
    }
    if (entry.isFile()) {
      visit(absolute);
    }
  }
}

function resolveInside(root: string, relative: string): string | null {
  const absolute = path.resolve(root, relative);
  return isInside(root, absolute) ? absolute : null;
}

function stringField(args: unknown, key: string): string {
  if (!args || typeof args !== "object" || !(key in args)) {
    return "";
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isCaptureUrl(value: string): boolean {
  try {
    return new URL(value).port === "47321";
  } catch {
    return false;
  }
}

export function buildHelperUserPrompt(
  clues: { file: string; line: number; text: string }[],
  projectInfo?: { name?: string; path?: string },
): string {
  const base = "Find the HTTP address this project uses to call a model.";
  const parts: string[] = [base];
  if (projectInfo?.name) {
    parts.push(`Project name: ${projectInfo.name}`);
  }
  if (clues && clues.length > 0) {
    const sample = clues.slice(0, 8);
    const lines = sample.map((c) => `- ${c.file}:${c.line}: ${c.text}`);
    parts.push(`Preliminary scan detected these potential references in the project. Check these first:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

export function buildDiagnosticUserPrompt(options: {
  failedFile: string;
  failedUrl: string;
  reason?: string;
  projectName?: string;
  clues?: { file: string; line: number; text: string }[];
}): string {
  const parts: string[] = [];
  const diagnosticHeader = [
    `Capture was armed pointing to ${options.failedFile} (${options.failedUrl}), but an application message was sent and bypassed the recorder.`,
    options.reason ? `Symptom: ${options.reason}` : "",
    `Diagnose why the application did not use ${options.failedFile}.`,
    `Investigate alternative configuration paths, runtime overrides, or user config files (~/.config, ~/.<app>, %APPDATA%), and propose the true active connection address.`,
  ].filter(Boolean).join("\n\n");

  parts.push(diagnosticHeader);

  if (options.projectName) {
    parts.push(`Project name: ${options.projectName}`);
  }

  if (options.clues && options.clues.length > 0) {
    const sample = options.clues.slice(0, 8);
    const lines = sample.map((c) => `- ${c.file}:${c.line}: ${c.text}`);
    parts.push(`Preliminary scan detected these potential references in the project. Check these first:\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

export function buildAttributionUserPrompt(options: {
  content: string;
  role?: string;
  projectName?: string;
  model?: string;
}): string {
  const parts: string[] = [];
  parts.push("Investigate this prompt captured from the application and identify which source file, template, or prompt builder function in the project generated it.");

  if (options.projectName) {
    parts.push(`Project: ${options.projectName}`);
  }
  if (options.model) {
    parts.push(`Target Model: ${options.model}`);
  }

  const MAX_PROMPT_PREVIEW = 2000;
  const rawContent = options.content.trim();
  const content = rawContent.length > MAX_PROMPT_PREVIEW
    ? rawContent.slice(0, MAX_PROMPT_PREVIEW) + "\n... [truncated]"
    : rawContent;
  const roleLabel = options.role ? `[Role: ${options.role}]` : "";

  parts.push(`Captured Prompt ${roleLabel}:\n\`\`\`\n${redactText(content)}\n\`\`\``);
  parts.push(
    [
      "Instructions:",
      "1. Identify invariant template phrases (system instructions, structural headers, formatting rules) vs dynamic variable slots (user inputs, database rows, timestamps).",
      "2. Use search_text to find candidate files matching the invariant phrases.",
      "3. Inspect candidate files with read_file to verify the exact template or builder function.",
      "4. Call attribute_prompt with the relative file, startLine, endLine, confidence, and explanation.",
    ].join("\n"),
  );

  return parts.join("\n\n");
}

export interface LocalServiceInfo {
  name: string;
  port: number;
  url: string;
}

export const KNOWN_LOCAL_SERVICES: LocalServiceInfo[] = [
  { name: "Ollama", port: 11434, url: "http://127.0.0.1:11434" },
  { name: "LM Studio", port: 1234, url: "http://127.0.0.1:1234" },
  { name: "vLLM / LocalAI", port: 8000, url: "http://127.0.0.1:8000" },
  { name: "Text Generation WebUI", port: 5000, url: "http://127.0.0.1:5000" },
];

export type PortProbeFn = (host: string, port: number, timeoutMs?: number) => Promise<boolean>;

export function probePort(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      cleanup();
      resolve(true);
    });
    socket.once("timeout", () => {
      cleanup();
      resolve(false);
    });
    socket.once("error", () => {
      cleanup();
      resolve(false);
    });

    try {
      socket.connect(port, host);
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

export async function detectLocalServices(
  services: LocalServiceInfo[] = KNOWN_LOCAL_SERVICES,
  probe: PortProbeFn = probePort,
): Promise<string> {
  const results = await Promise.all(
    services.map(async (service) => {
      const active = await probe("127.0.0.1", service.port, 300);
      return { ...service, active };
    }),
  );

  const activeServices = results.filter((r) => r.active);
  const inactiveServices = results.filter((r) => !r.active);

  const lines: string[] = [];
  if (activeServices.length > 0) {
    lines.push(`Active local AI services detected (${activeServices.length}):`);
    for (const s of activeServices) {
      lines.push(`- ${s.name}: ${s.url} (listening on port ${s.port})`);
    }
  } else {
    lines.push("No active local AI services detected on standard ports.");
  }

  if (inactiveServices.length > 0) {
    lines.push("\nProbed inactive services (not listening):");
    for (const s of inactiveServices) {
      lines.push(`- ${s.name}: ${s.url} (port ${s.port} closed)`);
    }
  }

  return lines.join("\n");
}

const COMMON_CONFIG_EXTS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".cfg",
]);

export function inferAppHints(root: string): string[] {
  const hints = new Set<string>();

  const base = path.basename(root).trim();
  if (base && !/^(src|app|workspace|project|code|repo|test)$/i.test(base)) {
    hints.add(base);
  }

  try {
    const pkgPath = path.join(root, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        const rawName = pkg.name.trim();
        const unscoped = rawName.includes("/") ? rawName.split("/").pop()! : rawName;
        hints.add(unscoped);
        hints.add(rawName);
      }
    }
  } catch {
    // ignore
  }

  const expanded = new Set<string>();
  for (const h of hints) {
    const lower = h.toLowerCase();
    expanded.add(lower);
    if (lower.includes("-")) {
      expanded.add(lower.replace(/-/g, ""));
      expanded.add(lower.replace(/-/g, "_"));
    }
    if (lower.includes("_")) {
      expanded.add(lower.replace(/_/g, ""));
      expanded.add(lower.replace(/_/g, "-"));
    }
  }

  return [...expanded].filter((h) => h.length >= 2);
}

export function findUserConfigDirs(
  root: string,
  args?: unknown,
  customHome?: string,
  customAppData?: string,
): string {
  const userHints: string[] = [];
  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>;
    if (Array.isArray(rec.app_hints)) {
      for (const item of rec.app_hints) {
        if (typeof item === "string" && item.trim()) {
          userHints.push(item.trim());
        }
      }
    } else if (typeof rec.hint === "string" && rec.hint.trim()) {
      userHints.push(rec.hint.trim());
    }
  }

  const inferred = inferAppHints(root);
  const allHintsSet = new Set<string>();

  for (const h of [...userHints, ...inferred]) {
    const lower = h.toLowerCase();
    allHintsSet.add(lower);
    if (lower.includes("-")) {
      allHintsSet.add(lower.replace(/-/g, ""));
      allHintsSet.add(lower.replace(/-/g, "_"));
    }
    if (lower.includes("_")) {
      allHintsSet.add(lower.replace(/_/g, ""));
      allHintsSet.add(lower.replace(/_/g, "-"));
    }
  }

  const hints = [...allHintsSet].filter((h) => h.length >= 2);
  const home = customHome || os.homedir();
  const appData = customAppData || process.env.APPDATA || (process.platform === "win32" ? path.join(home, "AppData", "Roaming") : undefined);
  const localAppData = process.env.LOCALAPPDATA || (process.platform === "win32" ? path.join(home, "AppData", "Local") : undefined);

  type FoundDir = {
    dir: string;
    files: string[];
  };

  const foundDirs: FoundDir[] = [];
  const checkedCandidateDirs = new Set<string>();

  for (const hint of hints) {
    const candidates: string[] = [
      path.join(home, ".config", hint),
      path.join(home, "." + hint),
    ];
    if (appData) {
      candidates.push(path.join(appData, hint));
    }
    if (localAppData && localAppData !== appData) {
      candidates.push(path.join(localAppData, hint));
    }

    for (const dir of candidates) {
      if (checkedCandidateDirs.has(dir)) {
        continue;
      }
      checkedCandidateDirs.add(dir);

      try {
        if (!fs.existsSync(dir)) {
          continue;
        }
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) {
          if (stat.isFile() && !isSecretFile(dir)) {
            foundDirs.push({ dir: path.dirname(dir), files: [dir] });
          }
          continue;
        }

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const configFiles: string[] = [];
        for (const entry of entries) {
          if (entry.isFile()) {
            const filePath = path.join(dir, entry.name);
            if (isSecretFile(filePath)) {
              continue;
            }
            const ext = path.extname(entry.name).toLowerCase();
            if (
              COMMON_CONFIG_EXTS.has(ext) ||
              /^(config|settings|preferences)/i.test(entry.name)
            ) {
              configFiles.push(filePath);
            }
          }
        }
        if (configFiles.length > 0 || entries.length === 0) {
          foundDirs.push({ dir, files: configFiles });
        }
      } catch {
        continue;
      }
    }

    for (const singleExt of [".json", ".yaml", ".yml", ".toml", "rc"]) {
      const singleFile = path.join(home, "." + hint + singleExt);
      if (checkedCandidateDirs.has(singleFile)) {
        continue;
      }
      checkedCandidateDirs.add(singleFile);
      try {
        if (fs.existsSync(singleFile) && fs.statSync(singleFile).isFile() && !isSecretFile(singleFile)) {
          foundDirs.push({ dir: home, files: [singleFile] });
        }
      } catch {
        continue;
      }
    }
  }

  if (foundDirs.length === 0) {
    return `No user configuration directories found matching hints: ${hints.join(", ") || "(none)"}.\nChecked standard locations under ~/.config, ~/.<name>, and %APPDATA%.`;
  }

  const lines: string[] = [];
  lines.push(`Found ${foundDirs.length} user configuration location(s):`);
  for (const item of foundDirs) {
    lines.push(`\nDirectory: ${item.dir}`);
    if (item.files.length > 0) {
      lines.push("Configuration files:");
      for (const file of item.files) {
        lines.push(`- ${file}`);
      }
    } else {
      lines.push("(Directory exists but contains no configuration files)");
    }
  }
  lines.push(`\nUse read_file with any of the above file paths to inspect active configuration.`);
  return lines.join("\n");
}
