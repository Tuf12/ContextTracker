import fs from "fs";
import path from "path";
import { isRewritablePath, projectKey } from "./paths";

export type FoundEndpoint = {
  projectPath: string;
  filePath: string;
  relativeFile: string;
  line: number;
  keyPath: string;
  value: string;
};

type Backup = {
  projectPath: string;
  filePath: string;
  content: string;
};

const MODEL_KEYS = new Set([
  "base_url",
  "baseurl",
  "api_base",
  "apibase",
  "openai_base_url",
  "anthropic_base_url",
  "ollama_url",
  "ollama_host",
  "ollama_base_url",
]);

export function findEndpoints(projectPath: string): FoundEndpoint[] {
  const root = path.resolve(projectPath);
  const found: FoundEndpoint[] = [];
  for (const filePath of candidateFiles(root)) {
    let text: string;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 200_000) {
        continue;
      }
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) {
      continue;
    }
    const relativeFile = path.relative(root, filePath).split(path.sep).join("/");
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".json") {
      found.push(...endpointsFromJson(root, filePath, relativeFile, text));
    } else if (path.basename(filePath) === ".env" || extension === ".env") {
      found.push(...endpointsFromEnv(root, filePath, relativeFile, text));
    } else {
      found.push(...endpointsFromYaml(root, filePath, relativeFile, text));
    }
  }
  return found;
}

export function chooseEndpoint(found: FoundEndpoint[]): FoundEndpoint | null {
  let best: FoundEndpoint | null = null;
  let bestScore = 0;
  for (const endpoint of found) {
    const score = scoreEndpoint(endpoint);
    if (score > bestScore) {
      best = endpoint;
      bestScore = score;
    }
  }
  return best;
}

export function endpointLabel(endpoint: FoundEndpoint): string {
  let host = endpoint.value;
  try {
    host = new URL(endpoint.value).host;
  } catch {
    host = endpoint.value;
  }
  const hint = `${endpoint.keyPath} ${endpoint.value}`.toLowerCase();
  const kind = /local|ollama|localhost|127\.0\.0\.1|:11434/.test(hint) ? "Local model" : "Model";
  return `${kind} at ${host} (${endpoint.relativeFile})`;
}

export function planRewrite(original: string, recorderOrigin: string): { writeValue: string; upstream: string } {
  const url = new URL(original);
  const origin = `${url.protocol}//${url.host}`;
  const pathName = url.pathname.replace(/\/$/, "");
  const recorder = recorderOrigin.replace(/\/$/, "");
  if (pathName === "/v1" || pathName.endsWith("/v1")) {
    const prefix = pathName.slice(0, -3);
    return {
      writeValue: `${recorder}${prefix}/v1`,
      upstream: `${origin}${prefix}`,
    };
  }
  return {
    writeValue: `${recorder}${pathName}`,
    upstream: `${origin}${pathName}`,
  };
}

export function armRedirect(backupDir: string, endpoint: FoundEndpoint, writeValue: string): void {
  const backupFile = backupPath(backupDir, endpoint.projectPath);
  if (!fs.existsSync(backupFile)) {
    fs.mkdirSync(backupDir, { recursive: true });
    const payload: Backup = {
      projectPath: endpoint.projectPath,
      filePath: endpoint.filePath,
      content: fs.readFileSync(endpoint.filePath, "utf8"),
    };
    fs.writeFileSync(backupFile, JSON.stringify(payload));
  }
  const current = fs.readFileSync(endpoint.filePath, "utf8");
  fs.writeFileSync(endpoint.filePath, replaceLineValue(current, endpoint.line, endpoint.value, writeValue));
}

export function restoreAllRedirects(backupDir: string): void {
  if (!fs.existsSync(backupDir)) {
    return;
  }
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const full = path.join(backupDir, name);
    let parsed: Backup;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8")) as Backup;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.content !== "string" || typeof parsed.filePath !== "string" || typeof parsed.projectPath !== "string") {
      continue;
    }
    if (!isRewritablePath(parsed.projectPath, parsed.filePath)) {
      continue;
    }
    try {
      fs.writeFileSync(parsed.filePath, parsed.content);
      fs.unlinkSync(full);
    } catch {
      continue;
    }
  }
}

function candidateFiles(root: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === ".env") {
      files.push(path.join(root, entry.name));
      continue;
    }
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "docs") {
      continue;
    }
    const absolute = path.join(root, entry.name);
    if (entry.isFile() && isConfigFile(entry.name)) {
      files.push(absolute);
    }
    if (entry.isDirectory() && (entry.name === "config" || entry.name === "configs")) {
      let nested: fs.Dirent[];
      try {
        nested = fs.readdirSync(absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of nested) {
        if (child.isFile() && isConfigFile(child.name)) {
          files.push(path.join(absolute, child.name));
        }
      }
    }
  }
  return files;
}

function isConfigFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "package.json" || lower.endsWith(".lock") || lower.includes("example")) {
    return lower === "config.example.yaml" || lower === "config.example.yml";
  }
  return lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".json") || lower.endsWith(".toml") || lower.endsWith(".env");
}

function endpointsFromYaml(root: string, filePath: string, relativeFile: string, text: string): FoundEndpoint[] {
  const found: FoundEndpoint[] = [];
  const frames: { indent: number; key: string }[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith("#")) {
      return;
    }
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!match) {
      return;
    }
    const indent = match[1].length;
    const key = match[2];
    const raw = match[3];
    while (frames.length > 0 && frames[frames.length - 1].indent >= indent) {
      frames.pop();
    }
    if (!raw || raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      frames.push({ indent, key });
      return;
    }
    const scalar = parseScalar(raw);
    if (!scalar || !isHttpUrl(scalar) || isCaptureUrl(scalar)) {
      frames.push({ indent, key });
      return;
    }
    const keyPath = [...frames.map((frame) => frame.key), key].join(".");
    if (!isModelKey(key, keyPath)) {
      return;
    }
    found.push({
      projectPath: root,
      filePath,
      relativeFile,
      line: index + 1,
      keyPath,
      value: scalar,
    });
  });
  return found;
}

function endpointsFromEnv(root: string, filePath: string, relativeFile: string, text: string): FoundEndpoint[] {
  const found: FoundEndpoint[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^(?:export\s+)?(OPENAI_BASE_URL|ANTHROPIC_BASE_URL|OLLAMA_HOST)\s*=\s*(.*)$/);
    if (!match) {
      return;
    }
    const scalar = parseScalar(match[2].trim());
    if (!scalar || !isHttpUrl(scalar) || isCaptureUrl(scalar)) {
      return;
    }
    found.push({
      projectPath: root,
      filePath,
      relativeFile,
      line: index + 1,
      keyPath: match[1],
      value: scalar,
    });
  });
  return found;
}

function endpointsFromJson(root: string, filePath: string, relativeFile: string, text: string): FoundEndpoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const found: FoundEndpoint[] = [];
  const lines = text.split(/\r?\n/);
  walkJson(parsed, [], (keyPath, value) => {
    const line = lines.findIndex((entry) => entry.includes(value));
    if (line < 0) {
      return;
    }
    found.push({
      projectPath: root,
      filePath,
      relativeFile,
      line: line + 1,
      keyPath,
      value,
    });
  });
  return found;
}

function walkJson(value: unknown, parents: string[], visit: (keyPath: string, value: string) => void): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const keyPath = [...parents, key].join(".");
    if (typeof child === "string" && isModelKey(key, keyPath) && isHttpUrl(child) && !isCaptureUrl(child)) {
      visit(keyPath, child);
      continue;
    }
    if (child && typeof child === "object") {
      walkJson(child, [...parents, key], visit);
    }
  }
}

function replaceLineValue(content: string, lineNumber: number, previous: string, nextValue: string): string {
  const endedWithNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (endedWithNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const line = lines[lineNumber - 1];
  if (!line || !line.includes(previous)) {
    throw new Error("The model address in the project no longer matches the one that was found.");
  }
  lines[lineNumber - 1] = line.replace(previous, nextValue);
  return `${lines.join("\n")}${endedWithNewline ? "\n" : ""}`;
}

function scoreEndpoint(endpoint: FoundEndpoint): number {
  const file = endpoint.relativeFile.toLowerCase();
  const hint = `${endpoint.keyPath} ${endpoint.value}`.toLowerCase();
  let score = 0;
  if (file.includes("example") || file.startsWith("docs/")) {
    score -= 100;
  }
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|:11434/.test(hint)) {
    score += 100;
  }
  if (/local|ollama/.test(hint)) {
    score += 40;
  }
  if (file === "config.yaml" || file === "config.yml") {
    score += 20;
  }
  if (/openai\.com|anthropic\.com|chutes\.ai|openrouter\.ai/.test(hint)) {
    score += 1;
  }
  return score;
}

function isModelKey(key: string, keyPath: string): boolean {
  if (MODEL_KEYS.has(key.toLowerCase())) {
    return true;
  }
  return key.toLowerCase() === "host" && /ollama/i.test(keyPath);
}

function parseScalar(raw: string): string | null {
  const commentStripped = raw.replace(/\s+#.*$/, "").trim();
  if (!commentStripped) {
    return null;
  }
  if ((commentStripped.startsWith("\"") && commentStripped.endsWith("\"")) || (commentStripped.startsWith("'") && commentStripped.endsWith("'"))) {
    return commentStripped.slice(1, -1);
  }
  return commentStripped;
}

function isCaptureUrl(value: string): boolean {
  try {
    return new URL(value).port === String(47321);
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function backupPath(backupDir: string, projectPath: string): string {
  return path.join(backupDir, `${projectKey(projectPath)}.json`);
}
