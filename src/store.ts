import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { projectKey } from "./paths";
import type { CachedAttribution, CaptureSummary, StoredCapture } from "./types";

type IndexFile = {
  projects: Record<string, { path: string; items: CaptureSummary[] }>;
};

const CAPTURE_LIMIT = 100;

export class CaptureStore {
  private memory = new Map<string, StoredCapture>();
  private indexPath: string;

  constructor(private root: string) {
    this.indexPath = path.join(root, "index.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    try {
      await fs.access(this.indexPath);
    } catch {
      await this.writeIndex({ projects: {} });
    }
  }

  async list(projectPath: string): Promise<CaptureSummary[]> {
    const index = await this.readIndex();
    return index.projects[projectKey(projectPath)]?.items ?? [];
  }

  async get(projectPath: string, id: string): Promise<StoredCapture | null> {
    const cached = this.memory.get(id);
    if (cached && path.resolve(cached.projectPath) === path.resolve(projectPath)) {
      return cached;
    }
    try {
      const capture = JSON.parse(await fs.readFile(this.capturePath(projectPath, id), "utf8")) as StoredCapture;
      this.remember(capture);
      return capture;
    } catch {
      return null;
    }
  }

  async add(capture: StoredCapture): Promise<CaptureSummary[]> {
    await fs.mkdir(path.dirname(this.capturePath(capture.projectPath, capture.id)), { recursive: true });
    await writeJson(this.capturePath(capture.projectPath, capture.id), capture);
    this.remember(capture);
    const index = await this.readIndex();
    const key = projectKey(capture.projectPath);
    const previous = index.projects[key]?.items ?? [];
    const items = [toSummary(capture), ...previous.filter((item) => item.id !== capture.id)].slice(0, CAPTURE_LIMIT);
    const kept = new Set(items.map((item) => item.id));
    for (const item of previous) {
      if (!kept.has(item.id)) {
        await fs.rm(this.capturePath(capture.projectPath, item.id), { force: true });
        this.memory.delete(item.id);
      }
    }
    index.projects[key] = { path: path.resolve(capture.projectPath), items };
    await this.writeIndex(index);
    return items;
  }

  async update(capture: StoredCapture): Promise<CaptureSummary[]> {
    await writeJson(this.capturePath(capture.projectPath, capture.id), capture);
    this.remember(capture);
    const index = await this.readIndex();
    const key = projectKey(capture.projectPath);
    const previous = index.projects[key]?.items ?? [];
    const summary = toSummary(capture);
    const items = previous.map((item) => (item.id === capture.id ? summary : item));
    index.projects[key] = { path: path.resolve(capture.projectPath), items };
    await this.writeIndex(index);
    return items;
  }

  async listAttributions(projectPath: string): Promise<CachedAttribution[]> {
    const file = this.attributionPath(projectPath);
    try {
      const data = JSON.parse(await fs.readFile(file, "utf8")) as CachedAttribution[];
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async saveAttribution(projectPath: string, attribution: CachedAttribution): Promise<void> {
    const file = this.attributionPath(projectPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const existing = await this.listAttributions(projectPath);
    const filtered = existing.filter(
      (item) => item.fingerprint !== attribution.fingerprint && (!attribution.cleanQuote || item.cleanQuote !== attribution.cleanQuote),
    );
    const updated = [attribution, ...filtered].slice(0, 100);
    await writeJson(file, updated);
  }

  async seedAttributionsFromCaptures(projectPath: string): Promise<CachedAttribution[]> {
    const existing = await this.listAttributions(projectPath);
    const knownFingerprints = new Set(existing.map((a) => a.fingerprint));
    const knownQuotes = new Set(existing.map((a) => a.cleanQuote).filter(Boolean));

    const key = projectKey(projectPath);
    const projectDir = path.join(this.root, key);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(projectDir);
    } catch {
      return existing;
    }

    const discovered: CachedAttribution[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "attributions.json") {
        continue;
      }
      try {
        const raw = JSON.parse(await fs.readFile(path.join(projectDir, entry), "utf8")) as StoredCapture;
        if (!Array.isArray(raw.reported) || !Array.isArray(raw.messages)) {
          continue;
        }
        for (const span of raw.reported) {
          if (span.source !== "attributed") {
            continue;
          }
          const messageIndex = span.messageIndex ?? 0;
          const msg = raw.messages[messageIndex];
          if (!msg || !msg.content) {
            continue;
          }
          const fingerprint = hashPromptText(msg.content);
          const cleanQuote = extractCleanQuote(span.quote);
          if (knownFingerprints.has(fingerprint) || (cleanQuote && knownQuotes.has(cleanQuote))) {
            continue;
          }
          knownFingerprints.add(fingerprint);
          if (cleanQuote) {
            knownQuotes.add(cleanQuote);
          }
          discovered.push({
            fingerprint,
            quote: span.quote,
            cleanQuote: cleanQuote ?? undefined,
            file: span.file,
            startLine: span.startLine,
            endLine: span.endLine,
            confidence: span.confidence ?? 0.85,
            explanation: span.explanation ?? "Attributed from previous capture",
            attributedAt: raw.createdAt,
          });
        }
      } catch {
        // ignore parse error
      }
    }

    if (discovered.length > 0) {
      const merged = [...discovered, ...existing].slice(0, 100);
      await fs.mkdir(projectDir, { recursive: true });
      await writeJson(this.attributionPath(projectPath), merged);
      return merged;
    }
    return existing;
  }

  private attributionPath(projectPath: string): string {
    return path.join(this.root, projectKey(projectPath), "attributions.json");
  }

  async remove(projectPath: string, id: string): Promise<CaptureSummary[]> {
    await fs.rm(this.capturePath(projectPath, id), { force: true });
    this.memory.delete(id);
    const index = await this.readIndex();
    const key = projectKey(projectPath);
    const items = (index.projects[key]?.items ?? []).filter((item) => item.id !== id);
    index.projects[key] = { path: path.resolve(projectPath), items };
    await this.writeIndex(index);
    return items;
  }

  async clear(projectPath: string): Promise<void> {
    const index = await this.readIndex();
    const key = projectKey(projectPath);
    for (const item of index.projects[key]?.items ?? []) {
      this.memory.delete(item.id);
    }
    await fs.rm(path.join(this.root, key), { recursive: true, force: true });
    index.projects[key] = { path: path.resolve(projectPath), items: [] };
    await this.writeIndex(index);
  }

  private capturePath(projectPath: string, id: string): string {
    return path.join(this.root, projectKey(projectPath), `${id}.json`);
  }

  private remember(capture: StoredCapture): void {
    this.memory.set(capture.id, capture);
    if (this.memory.size > 8) {
      const oldest = this.memory.keys().next().value;
      if (oldest && oldest !== capture.id) {
        this.memory.delete(oldest);
      }
    }
  }

  private async readIndex(): Promise<IndexFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath, "utf8")) as IndexFile;
      if (!parsed.projects) {
        return { projects: {} };
      }
      return parsed;
    } catch {
      return { projects: {} };
    }
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    await writeJson(this.indexPath, index);
  }
}

export function toSummary(capture: StoredCapture): CaptureSummary {
  const previewSource = capture.messages.find((message) => message.content.trim())?.content ?? "";
  const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 140);
  const fileSpanCount = Array.isArray(capture.reported)
    ? capture.reported.filter((s) => s && s.file && (s.source === "attributed" || s.source === "reported")).length
    : 0;
  return {
    id: capture.id,
    createdAt: capture.createdAt,
    model: capture.model,
    provider: capture.provider,
    endpoint: capture.endpoint,
    status: capture.status,
    error: capture.error,
    preview: preview || "Empty prompt",
    fileSpanCount,
  };
}

export function hashPromptText(text: string): string {
  return crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

export function extractCleanQuote(rawQuote?: string): string | null {
  if (!rawQuote || typeof rawQuote !== "string") {
    return null;
  }
  const lines = rawQuote
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s'"`,]+|[\s'"`,]+$/g, "").trim())
    .filter((l) => l.length >= 20);
  return lines[0] ?? (rawQuote.trim().length >= 10 ? rawQuote.trim() : null);
}

export function matchCachedAttribution(
  content: string,
  attributions: CachedAttribution[],
): CachedAttribution | null {
  if (!content || !content.trim()) {
    return null;
  }
  const fingerprint = hashPromptText(content);
  for (const attr of attributions) {
    if (attr.fingerprint === fingerprint) {
      return attr;
    }
  }
  for (const attr of attributions) {
    const q = attr.cleanQuote || attr.quote;
    if (q && q.length >= 20 && content.includes(q)) {
      return attr;
    }
  }
  return null;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, file);
}
