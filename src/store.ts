import fs from "fs/promises";
import path from "path";
import { projectKey } from "./paths";
import type { CaptureSummary, StoredCapture } from "./types";

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

  async update(capture: StoredCapture): Promise<void> {
    await writeJson(this.capturePath(capture.projectPath, capture.id), capture);
    this.remember(capture);
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
  return {
    id: capture.id,
    createdAt: capture.createdAt,
    model: capture.model,
    provider: capture.provider,
    endpoint: capture.endpoint,
    status: capture.status,
    error: capture.error,
    preview: preview || "Empty prompt",
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, file);
}
