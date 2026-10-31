import fs from "fs/promises";
import path from "path";
import { isInside } from "./paths";
import type { FilePointer, ProjectIndex } from "./types";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  "vendor",
  "target",
  "coverage",
  ".idea",
  ".vscode",
  ".cursor",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "site-packages",
  "dist-packages",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "cargo.lock",
  "composer.lock",
]);

const EXTENSIONS = new Set([
  ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".mdx",
  ".json", ".yaml", ".yml", ".txt", ".html", ".css", ".rs", ".go", ".java",
  ".rb", ".php", ".toml", ".jinja", ".j2", ".prompt", ".xml", ".sql", ".vue",
  ".svelte", ".cs", ".cpp", ".h", ".hpp", ".c", ".kt", ".swift", ".sh", ".lua",
  ".rst", ".tf", ".graphql", ".prisma", ".mdc",
]);

const CLUE_MARKERS = [
  "api.openai.com",
  "api.anthropic.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
];

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 400_000;
const MAX_LINES_PER_FILE = 8000;
const MAX_LOCATIONS = 12;

export async function indexProject(
  rootInput: string,
  onProgress?: (fileCount: number) => void,
  shouldContinue?: () => boolean,
): Promise<ProjectIndex> {
  const root = path.resolve(rootInput);
  const lines = new Map<string, FilePointer[]>();
  const fileLines = new Map<string, string[]>();
  const clues: ProjectIndex["clues"] = [];
  let fileCount = 0;
  let truncated = false;
  const stack = [root];
  const seen = new Set<string>();

  while (stack.length > 0) {
    if (shouldContinue && !shouldContinue()) {
      break;
    }
    const dir = stack.pop();
    if (!dir) {
      break;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (shouldContinue && !shouldContinue()) {
        truncated = true;
        break;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        let real = absolute;
        try {
          real = await fs.realpath(absolute);
        } catch {
          continue;
        }
        if (!isInside(root, real) || seen.has(real)) {
          continue;
        }
        seen.add(real);
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !shouldIndexFile(entry.name)) {
        continue;
      }
      if (fileCount >= MAX_FILES) {
        truncated = true;
        continue;
      }
      const indexed = await readIndexedFile(root, absolute);
      if (!indexed) {
        continue;
      }
      fileCount += 1;
      fileLines.set(indexed.relative, indexed.trimmed);
      for (const location of indexed.locations) {
        addLocation(lines, location.key, { file: indexed.relative, line: location.line });
      }
      for (const clue of indexed.clues) {
        if (clues.length < 12) {
          clues.push(clue);
        }
      }
      if (fileCount % 50 === 0) {
        onProgress?.(fileCount);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  onProgress?.(fileCount);
  return { root, fileCount, truncated, lines, fileLines, clues };
}

function shouldIndexFile(name: string): boolean {
  if (SKIP_FILES.has(name.toLowerCase())) {
    return false;
  }
  if (name === ".env" || name.startsWith(".env.") && name !== ".env.example") {
    return false;
  }
  if (name.endsWith(".pem") || name.endsWith(".key")) {
    return false;
  }
  const extension = path.extname(name).toLowerCase();
  return EXTENSIONS.has(extension) || name === ".env.example";
}

async function readIndexedFile(root: string, absolute: string): Promise<{
  relative: string;
  trimmed: string[];
  locations: { key: string; line: number }[];
  clues: { file: string; line: number; text: string }[];
} | null> {
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size === 0) {
    return null;
  }
  let text: string;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch {
    return null;
  }
  if (text.includes("\u0000")) {
    return null;
  }
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  const rawLines = splitFileLines(text).slice(0, MAX_LINES_PER_FILE);
  const trimmed = rawLines.map((line) => line.trim());
  const locations: { key: string; line: number }[] = [];
  const clues: { file: string; line: number; text: string }[] = [];
  trimmed.forEach((key, index) => {
    if (isIndexableLine(key)) {
      locations.push({ key, line: index + 1 });
    }
    if (clues.length < 3 && CLUE_MARKERS.some((marker) => key.includes(marker))) {
      clues.push({ file: relative, line: index + 1, text: key.slice(0, 160) });
    }
  });
  return { relative, trimmed, locations, clues };
}

function splitFileLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function isIndexableLine(line: string): boolean {
  return line.length >= 20 && /[A-Za-z0-9]/.test(line);
}

function addLocation(lines: Map<string, FilePointer[]>, key: string, pointer: FilePointer): void {
  const existing = lines.get(key);
  if (!existing) {
    lines.set(key, [pointer]);
    return;
  }
  if (existing.length > MAX_LOCATIONS) {
    return;
  }
  existing.push(pointer);
  if (existing.length > MAX_LOCATIONS) {
    existing.push(pointer);
  }
}

export function locationsFor(index: ProjectIndex, key: string): FilePointer[] {
  const locations = index.lines.get(key);
  if (!locations || locations.length > MAX_LOCATIONS) {
    return [];
  }
  return locations;
}

export { MAX_LOCATIONS };
