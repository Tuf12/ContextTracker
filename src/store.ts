import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { projectKey } from "./paths";
import type { CachedAttribution, CaptureSummary, ChatConversation, StoredCapture } from "./types";

type IndexFile = {
  projects: Record<string, { path: string; items: CaptureSummary[] }>;
};

const CAPTURE_LIMIT = 100;

export class CaptureStore {
  private memory = new Map<string, StoredCapture>();
  private chatMemory = new Map<string, ChatConversation>();
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
        await this.removeChat(capture.projectPath, item.id);
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
          const cleanQuotes = extractCleanQuotes(span.quote);
          const cleanQuote = cleanQuotes[0] ?? extractCleanQuote(span.quote);
          const invariantPrefix = extractInvariantPrefix(msg.content);
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
            cleanQuotes: cleanQuotes.length > 0 ? cleanQuotes : undefined,
            invariantPrefix: invariantPrefix ?? undefined,
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

    const allAttributions = [...discovered, ...existing];
    const uniqueMap = new Map<string, CachedAttribution>();
    for (const item of allAttributions) {
      const idKey = item.fingerprint || `${item.file}:${item.startLine}:${item.endLine}`;
      const prior = uniqueMap.get(idKey);
      if (!prior) {
        uniqueMap.set(idKey, item);
      } else {
        uniqueMap.set(idKey, {
          ...prior,
          cleanQuotes: prior.cleanQuotes ?? item.cleanQuotes,
          invariantPrefix: prior.invariantPrefix ?? item.invariantPrefix,
          cleanQuote: prior.cleanQuote ?? item.cleanQuote,
        });
      }
    }
    const merged = Array.from(uniqueMap.values()).slice(0, 100);

    // Back-propagate to any existing captures that match but are missing attributions
    let indexUpdated = false;
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "attributions.json") {
        continue;
      }
      try {
        const filePath = path.join(projectDir, entry);
        const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as StoredCapture;
        if (!Array.isArray(raw.reported) || !Array.isArray(raw.messages)) {
          continue;
        }
        let captureChanged = false;
        raw.messages.forEach((msg, idx) => {
          if (msg.role === "assistant") return;
          const hasAttr = raw.reported.some((s) => s.messageIndex === idx && s.source === "attributed");
          if (!hasAttr) {
            const match = matchCachedAttribution(msg.content, merged);
            if (match) {
              const matchedQuote = match.invariantPrefix && msg.content.includes(match.invariantPrefix)
                ? match.invariantPrefix
                : (match.cleanQuotes ?? []).find((q) => q && q.length >= 15 && msg.content.includes(q))
                  ?? (match.cleanQuote && msg.content.includes(match.cleanQuote) ? match.cleanQuote : match.quote);
              raw.reported.push({
                messageIndex: idx,
                file: match.file,
                startLine: match.startLine,
                endLine: match.endLine,
                source: "attributed",
                confidence: match.confidence,
                explanation: match.explanation,
                quote: matchedQuote,
              });
              captureChanged = true;
            }
          }
        });
        if (captureChanged) {
          await writeJson(filePath, raw);
          this.remember(raw);
          indexUpdated = true;
        }
      } catch {
        // ignore individual capture read error
      }
    }

    if (discovered.length > 0 || indexUpdated) {
      await fs.mkdir(projectDir, { recursive: true });
      await writeJson(this.attributionPath(projectPath), merged);
      if (indexUpdated) {
        const index = await this.readIndex();
        const prevItems = index.projects[key]?.items ?? [];
        const updatedItems = prevItems.map((item) => {
          const cached = this.memory.get(item.id);
          return cached ? toSummary(cached) : item;
        });
        index.projects[key] = { path: path.resolve(projectPath), items: updatedItems };
        await this.writeIndex(index);
      }
    }
    return merged;
  }

  private attributionPath(projectPath: string): string {
    return path.join(this.root, projectKey(projectPath), "attributions.json");
  }

  async remove(projectPath: string, id: string): Promise<CaptureSummary[]> {
    await fs.rm(this.capturePath(projectPath, id), { force: true });
    this.memory.delete(id);
    await this.removeChat(projectPath, id);
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
      this.chatMemory.delete(`${key}:${item.id}`);
    }
    this.chatMemory.delete(`${key}:project`);
    await fs.rm(path.join(this.root, key), { recursive: true, force: true });
    index.projects[key] = { path: path.resolve(projectPath), items: [] };
    await this.writeIndex(index);
  }

  private chatPath(projectPath: string, conversationId: string): string {
    const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.root, projectKey(projectPath), "chats", `${safeId}.json`);
  }

  async getChat(projectPath: string, conversationId: string): Promise<ChatConversation | null> {
    const key = projectKey(projectPath);
    const memKey = `${key}:${conversationId}`;
    const cached = this.chatMemory.get(memKey);
    if (cached) {
      return cached;
    }
    const file = this.chatPath(projectPath, conversationId);
    try {
      const data = JSON.parse(await fs.readFile(file, "utf8")) as ChatConversation;
      if (data && typeof data === "object" && Array.isArray(data.activity)) {
        this.chatMemory.set(memKey, data);
        return data;
      }
      return null;
    } catch {
      return null;
    }
  }

  async saveChat(projectPath: string, conversation: ChatConversation): Promise<void> {
    const file = this.chatPath(projectPath, conversation.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJson(file, conversation);
    const memKey = `${projectKey(projectPath)}:${conversation.id}`;
    this.chatMemory.set(memKey, conversation);
  }

  async removeChat(projectPath: string, conversationId: string): Promise<void> {
    const file = this.chatPath(projectPath, conversationId);
    await fs.rm(file, { force: true });
    const memKey = `${projectKey(projectPath)}:${conversationId}`;
    this.chatMemory.delete(memKey);
  }

  async listChats(projectPath: string): Promise<string[]> {
    const chatDir = path.join(this.root, projectKey(projectPath), "chats");
    try {
      const entries = await fs.readdir(chatDir);
      return entries
        .filter((e) => e.endsWith(".json"))
        .map((e) => e.replace(/\.json$/, ""));
    } catch {
      return [];
    }
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
    run: capture.run,
  };
}

export function hashPromptText(text: string): string {
  return crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

export function extractCleanQuotes(rawQuote?: string): string[] {
  if (!rawQuote || typeof rawQuote !== "string") {
    return [];
  }
  const results: string[] = [];

  // 1. String literals in code: triple quotes, double quotes, single quotes, backticks
  const literalRegex = /(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|`([\s\S]*?)`|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')/g;
  let match: RegExpExecArray | null;
  while ((match = literalRegex.exec(rawQuote)) !== null) {
    const rawVal = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
    const val = rawVal
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, " ")
      .replace(/\\"/g, "\"")
      .replace(/\\'/g, "'")
      .trim();
    if (val.length >= 15) {
      results.push(val);
      const subLines = val.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 15);
      results.push(...subLines);
    }
  }

  // 2. Lines from raw text (stripping leading code keywords/method calls, assignments, quotes, punctuation)
  const lines = rawQuote.split(/\r?\n/).map((l) => {
    return l
      .replace(/^(?:append|print|println|logger\.\w+|console\.\w+)\s*\(\s*/, "")
      .replace(/^(?:const|let|var|val)\s+\w+\s*=\s*/, "")
      .replace(/^[+\s'"`,]+|[+\s'"`,);]+$/g, "")
      .trim();
  }).filter((l) => l.length >= 15);
  results.push(...lines);

  // 3. Fallback raw text trimmed
  const rawTrimmed = rawQuote.trim();
  if (rawTrimmed.length >= 15) {
    results.push(rawTrimmed);
  }

  // 4. Strip template placeholders like {{ ... }}, { ... }, <%= ... %>
  for (const item of [...results]) {
    const stripped = item.replace(/\{\{[\s\S]*?\}\}|\{[\s\S]*?\}|<%[\s\S]*?%>/g, " ").replace(/\s+/g, " ").trim();
    if (stripped.length >= 15 && stripped !== item) {
      results.push(stripped);
    }
  }

  return Array.from(new Set(results)).filter((q) => q.length >= 15);
}

export function extractCleanQuote(rawQuote?: string): string | null {
  const quotes = extractCleanQuotes(rawQuote);
  return quotes[0] ?? null;
}

export function extractInvariantPrefix(content?: string): string | null {
  if (!content || typeof content !== "string") {
    return null;
  }
  const paragraphs = content
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 25);
  return paragraphs[0] ?? (content.trim().length >= 25 ? content.trim().slice(0, 300) : null);
}

export function matchCachedAttribution(
  content: string,
  attributions: CachedAttribution[],
): CachedAttribution | null {
  if (!content || !content.trim()) {
    return null;
  }
  const fingerprint = hashPromptText(content);
  // 1. Exact full-content match
  for (const attr of attributions) {
    if (attr.fingerprint === fingerprint) {
      return attr;
    }
  }

  // 2. Invariant prefix match (e.g. persona header, system instructions)
  for (const attr of attributions) {
    if (attr.invariantPrefix && attr.invariantPrefix.length >= 25 && content.includes(attr.invariantPrefix)) {
      return attr;
    }
  }

  // 3. Current content prefix match with stored invariantPrefix
  const currentPrefix = extractInvariantPrefix(content);
  if (currentPrefix && currentPrefix.length >= 25) {
    for (const attr of attributions) {
      if (attr.invariantPrefix && (attr.invariantPrefix === currentPrefix || attr.invariantPrefix.includes(currentPrefix) || currentPrefix.includes(attr.invariantPrefix))) {
        return attr;
      }
    }
  }

  // 4. Stored cleanQuotes array match
  for (const attr of attributions) {
    if (Array.isArray(attr.cleanQuotes)) {
      for (const q of attr.cleanQuotes) {
        if (q && q.length >= 15 && content.includes(q)) {
          return attr;
        }
      }
    }
  }

  // 5. Clean quotes dynamically extracted from quote or cleanQuote
  for (const attr of attributions) {
    const raw = attr.quote || attr.cleanQuote;
    if (raw) {
      const candidates = extractCleanQuotes(raw);
      for (const q of candidates) {
        if (q && q.length >= 15 && content.includes(q)) {
          return attr;
        }
      }
      if (raw.length >= 15 && content.includes(raw)) {
        return attr;
      }
    }
  }

  return null;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, file);
}
