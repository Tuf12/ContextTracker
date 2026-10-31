import fs from "fs";
import path from "path";
import type { HelperTool } from "./harness";
import { isInside, resolveAddressFile, toRelative } from "./paths";
import { isSecretFile, redactText } from "./redact";
import type { AddressOffer } from "./types";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "__pycache__", ".venv", "venv"]);
const MAX_FILE = 200_000;
const MAX_MATCHES = 30;
const MAX_LIST = 200;

export const ADDRESS_SYSTEM = [
  "You find the HTTP address a project uses to call a model.",
  "Use list_files, search_text, and read_file. You can open any file in the project except private key files.",
  "You can also read_file an absolute path under the user home directory when the project code loads its saved config from there.",
  "When you know the file and the exact URL written there, call propose_address.",
  "Do not invent a URL. Do not propose port 47321.",
  "Prefer the address the app reads at startup. A default written in source is not that address when the app loads a saved config file. Follow that saved file and propose the URL stored there.",
].join(" ");

export function addressTools(root: string): Array<HelperTool<AddressOffer>> {
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
      description: "Search project text for a short literal. Returns redacted matching lines.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      run: (args) => ({ content: searchText(root, stringField(args, "query")) }),
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
      run: (args) => proposeAddress(root, args),
    },
  ];
}

export function proposeAddress(root: string, args: unknown): { content: string; finish?: AddressOffer } {
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

function searchText(root: string, query: string): string {
  const needle = query.trim();
  if (needle.length < 2) {
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
    if (text.includes("\u0000") || !text.includes(needle)) {
      return;
    }
    const relative = toRelative(root, file);
    text.split(/\r?\n/).forEach((line, index) => {
      if (matches.length >= MAX_MATCHES || !line.includes(needle)) {
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
