import fs from "fs";
import path from "path";
import { projectKey } from "./paths";
import { CAPTURE_PORT } from "./recorder";
import type { EnvStatus } from "./types";

export const OPENAI_ENV = "OPENAI_BASE_URL";
export const ANTHROPIC_ENV = "ANTHROPIC_BASE_URL";
const ALLOWED = new Set([OPENAI_ENV, ANTHROPIC_ENV]);

type Backup = { existed: boolean; content: string };

export function envFilePath(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".env");
}

export function proposedBases(recorderUrl: string): { openai: string; anthropic: string } {
  const base = recorderUrl.replace(/\/$/, "");
  return { openai: `${base}/v1`, anthropic: base };
}

export function readEnvStatus(projectPath: string, recorderUrl: string, backupDir: string): EnvStatus {
  const filePath = envFilePath(projectPath);
  const exists = fs.existsSync(filePath);
  const content = exists ? fs.readFileSync(filePath, "utf8") : "";
  const values = parseEnv(content);
  const proposed = proposedBases(recorderUrl);
  const backup = readBackup(backupDir, projectPath);
  return {
    filePath,
    exists,
    keys: [
      planKey(OPENAI_ENV, values.get(OPENAI_ENV) ?? null, proposed.openai),
      planKey(ANTHROPIC_ENV, values.get(ANTHROPIC_ENV) ?? null, proposed.anthropic),
    ],
    hasBackup: backup !== null,
    restoreDeletesFile: backup !== null && !backup.existed,
  };
}

export function applyEnv(projectPath: string, updates: Record<string, string>, backupDir: string): void {
  const safeUpdates: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (ALLOWED.has(key) && value.trim()) {
      safeUpdates[key] = value.trim();
    }
  }
  if (Object.keys(safeUpdates).length === 0) {
    return;
  }
  const filePath = envFilePath(projectPath);
  const existed = fs.existsSync(filePath);
  const content = existed ? fs.readFileSync(filePath, "utf8") : "";
  const backupFile = backupFilePath(backupDir, projectPath);
  if (!fs.existsSync(backupFile)) {
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    const payload: Backup = { existed, content };
    fs.writeFileSync(backupFile, JSON.stringify(payload));
  }
  fs.writeFileSync(filePath, rewriteEnv(content, safeUpdates));
}

export function restoreEnv(projectPath: string, backupDir: string): boolean {
  const backup = readBackup(backupDir, projectPath);
  if (!backup) {
    return false;
  }
  const filePath = envFilePath(projectPath);
  if (backup.existed) {
    fs.writeFileSync(filePath, backup.content);
  } else if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  fs.unlinkSync(backupFilePath(backupDir, projectPath));
  return true;
}

export function rewriteEnv(content: string, updates: Record<string, string>): string {
  const lines = splitEnvLines(content);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = line.match(/^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !(match[2] in updates)) {
      return line;
    }
    seen.add(match[2]);
    return `${match[1] ?? ""}${match[2]}=${updates[match[2]]}`;
  });
  const missing = Object.keys(updates).filter((key) => !seen.has(key));
  if (missing.length > 0) {
    if (next.length > 0 && next[next.length - 1] !== "") {
      next.push("");
    }
    next.push("# Added by Context Tracker");
    for (const key of missing) {
      next.push(`${key}=${updates[key]}`);
    }
  }
  return `${next.join("\n")}\n`;
}

function planKey(key: string, current: string | null, proposed: string): EnvStatus["keys"][number] {
  return {
    key,
    current,
    proposed,
    pointingHere: urlsMatch(current, proposed),
  };
}

function urlsMatch(current: string | null, proposed: string): boolean {
  if (!current) {
    return false;
  }
  return stripUrl(current) === stripUrl(proposed);
}

function stripUrl(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "").replace(/\/$/, "");
}

export function envPointsAtCapturePort(projectPath: string, port = CAPTURE_PORT): boolean {
  const filePath = envFilePath(projectPath);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const values = parseEnv(fs.readFileSync(filePath, "utf8"));
  for (const key of ALLOWED) {
    const raw = values.get(key);
    if (!raw) {
      continue;
    }
    try {
      if (new URL(stripUrl(raw)).port === String(port)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      values.set(match[1], match[2]);
    }
  }
  return values;
}

function splitEnvLines(content: string): string[] {
  if (!content) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n") && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function backupFilePath(backupDir: string, projectPath: string): string {
  return path.join(backupDir, `${projectKey(projectPath)}.json`);
}

function readBackup(backupDir: string, projectPath: string): Backup | null {
  const file = backupFilePath(backupDir, projectPath);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Backup;
    if (typeof parsed.existed !== "boolean" || typeof parsed.content !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
