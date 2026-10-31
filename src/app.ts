import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as vscode from "vscode";
import { deriveCapture, presentCapture } from "./derive";
import { ANTHROPIC_ENV, applyEnv, OPENAI_ENV, proposedBases, readEnvStatus, restoreEnv } from "./env";
import { panelHtml } from "./html";
import { indexProject } from "./indexer";
import { isInside, resolveProjectFile } from "./paths";
import { CAPTURE_PORT, chooseUpstream, startRecorder, type RecorderCapture, type RecorderServer } from "./recorder";
import { armRedirect, chooseEndpoint, endpointLabel, findEndpoints, planRewrite, restoreAllRedirects } from "./redirect";
import { CaptureStore } from "./store";
import type { ProjectIndex, ProjectView, ReportedSpan, RouteSettings, StoredCapture, ViewState } from "./types";

const PROJECT_KEY = "contextTracker.projectPath";
const ROUTE_KEY = "contextTracker.route";

export class TrackerApp {
  private readonly output: vscode.OutputChannel;
  private readonly status: vscode.StatusBarItem;
  private readonly store: CaptureStore;
  private readonly backupDir: string;
  private readonly views = new Set<vscode.Webview>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly live = new Map<string, StoredCapture>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly clientIds = new Map<string, string>();
  private readonly pendingSpans = new Map<string, ReportedSpan[]>();
  private project: ProjectView | null = null;
  private index: ProjectIndex | null = null;
  private indexGeneration = 0;
  private summaries: ViewState["captures"] = [];
  private selectedId: string | null = null;
  private selected: StoredCapture | null = null;
  private compareId: string | null = null;
  private compare: StoredCapture | null = null;
  private server: RecorderServer | null = null;
  private route: RouteSettings = { mode: "auto", customUpstream: "" };
  private readonly redirectDir: string;
  private foundLabel: string | null = null;
  private recorderError: string | null = null;
  private lastEvent: string | null = null;
  private panel: vscode.WebviewPanel | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("Context Tracker");
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = "contextTracker.main.focus";
    this.store = new CaptureStore(path.join(context.globalStorageUri.fsPath, "captures"));
    this.backupDir = path.join(context.globalStorageUri.fsPath, "env-backups");
    this.redirectDir = path.join(context.globalStorageUri.fsPath, "redirects");
  }

  start(): void {
    const saved = this.context.globalState.get<RouteSettings>(ROUTE_KEY);
    if (saved?.mode === "auto" || saved?.mode === "custom") {
      this.route = { mode: saved.mode, customUpstream: saved.customUpstream ?? "" };
    }
    const provider: vscode.WebviewViewProvider = {
      resolveWebviewView: (view) => {
        const detach = this.attach(view.webview, "sidebar");
        view.onDidDispose(detach);
      },
    };
    this.disposables.push(
      vscode.window.registerWebviewViewProvider("contextTracker.main", provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      this.output,
      this.status,
    );
    void this.boot().catch((error: unknown) => {
      this.output.appendLine(error instanceof Error ? error.message : "Context Tracker failed to start.");
    });
  }

  dispose(): void {
    this.indexGeneration += 1;
    clearTimeout(this.statusTimer);
    restoreAllRedirects(this.redirectDir);
    void this.server?.close().catch(() => undefined);
    this.server = null;
    this.panel?.dispose();
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables.length = 0;
  }

  private async boot(): Promise<void> {
    await fs.promises.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    restoreAllRedirects(this.redirectDir);
    await this.store.init();
    const savedPath = this.context.globalState.get<string>(PROJECT_KEY);
    if (savedPath && fs.existsSync(savedPath)) {
      await this.loadProject(savedPath);
      return;
    }
    this.push();
  }

  private attach(webview: vscode.Webview, surface: "sidebar" | "editor"): () => void {
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    webview.html = panelHtml(webview, this.context.extensionUri, surface);
    const subscription = webview.onDidReceiveMessage((message) => this.onMessage(message));
    this.views.add(webview);
    this.push();
    return () => {
      subscription.dispose();
      this.views.delete(webview);
    };
  }

  private onMessage(message: unknown): void {
    void this.handle(message).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : "Something went wrong.";
      this.output.appendLine(text);
      this.lastEvent = "Something went wrong. Open the log for details.";
      this.push();
    });
  }

  private async handle(message: unknown): Promise<void> {
    if (!message || typeof message !== "object" || !("type" in message)) {
      return;
    }
    const body = message as { type?: string; [key: string]: unknown };
    switch (body.type) {
      case "ready":
        this.push();
        return;
      case "openProject":
        await this.openProject();
        return;
      case "startCapture":
        await this.startCapture();
        return;
      case "stopCapture":
        await this.stopCapture();
        return;
      case "setRoute":
        await this.setRoute(body.mode === "custom" ? "custom" : "auto", typeof body.customUpstream === "string" ? body.customUpstream : "");
        return;
      case "applyEnv":
        this.writeEnv(Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === "string") : []);
        return;
      case "restoreEnv":
        this.restoreEnvFile();
        return;
      case "selectCapture":
        if (typeof body.id === "string") {
          await this.selectCapture(body.id);
        }
        return;
      case "pinCapture":
        if (typeof body.id === "string") {
          await this.pinCapture(body.id);
        }
        return;
      case "openSpan":
        if (typeof body.captureId === "string" && typeof body.spanId === "string") {
          await this.openSpan(body.captureId, body.spanId);
        }
        return;
      case "openClue":
        if (typeof body.file === "string" && typeof body.line === "number") {
          await this.openClue(body.file, body.line);
        }
        return;
      case "deleteCapture":
        if (typeof body.id === "string") {
          await this.deleteCapture(body.id);
        }
        return;
      case "clearCaptures":
        await this.clearCaptures();
        return;
      case "copyUrl":
        await this.copyUrl(body.which === "anthropic" ? "anthropic" : "openai");
        return;
      case "showLog":
        this.output.show(true);
        return;
      case "openBeside":
        this.openBeside();
        return;
      case "reindex":
        if (this.project) {
          await this.loadProject(this.project.path);
        }
        return;
      default:
        return;
    }
  }

  private async openProject(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Load project",
      title: "Load a project",
    });
    if (!picked?.[0]) {
      return;
    }
    await this.loadProject(picked[0].fsPath);
  }

  private async loadProject(folder: string): Promise<void> {
    const resolved = path.resolve(folder);
    const generation = ++this.indexGeneration;
    this.project = {
      path: resolved,
      name: path.basename(resolved),
      fileCount: 0,
      truncated: false,
      indexing: true,
      clues: [],
    };
    this.index = null;
    this.selected = null;
    this.selectedId = null;
    this.compare = null;
    this.compareId = null;
    this.summaries = await this.store.list(resolved);
    await this.context.globalState.update(PROJECT_KEY, resolved);
    this.refreshStatus();
    this.push();
    const index = await indexProject(resolved, undefined, () => generation === this.indexGeneration);
    if (generation !== this.indexGeneration) {
      return;
    }
    this.index = index;
    this.project = {
      path: resolved,
      name: path.basename(resolved),
      fileCount: index.fileCount,
      truncated: index.truncated,
      indexing: false,
      clues: index.clues,
    };
    this.refreshFoundLabel();
    this.push();
  }

  private async startCapture(): Promise<void> {
    if (this.server) {
      return;
    }
    if (!this.project) {
      this.lastEvent = "Load a project first.";
      this.push();
      return;
    }
    restoreAllRedirects(this.redirectDir);
    const chosen = chooseEndpoint(findEndpoints(this.project.path));
    if (!chosen) {
      this.foundLabel = null;
      this.recorderError = null;
      this.lastEvent = "No model address was found in this project.";
      this.push();
      return;
    }
    const plan = planRewrite(chosen.value, `http://127.0.0.1:${CAPTURE_PORT}`);
    this.route = { mode: "custom", customUpstream: plan.upstream };
    try {
      chooseUpstream(this.route, {});
    } catch (error) {
      this.recorderError = error instanceof Error ? error.message : "The model address could not be used.";
      this.push();
      return;
    }
    try {
      this.server = await startRecorder({
        route: () => this.route,
        onCapture: (capture) => {
          void this.accept(capture).catch((error: unknown) => {
            this.output.appendLine(error instanceof Error ? error.message : "Could not save a call.");
          });
        },
        onSpans: (id, spans) => {
          void this.receiveSpans(id, spans).catch((error: unknown) => {
            this.output.appendLine(error instanceof Error ? error.message : "Could not save line marks.");
          });
        },
        onLog: (line) => this.output.appendLine(line),
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      this.recorderError = code === "EADDRINUSE"
        ? "Port 47321 is already in use. Close the other Context Tracker window, then start capture again."
        : error instanceof Error
          ? error.message
          : "Capture could not start.";
      this.server = null;
      this.refreshStatus();
      this.push();
      return;
    }
    try {
      armRedirect(this.redirectDir, chosen, plan.writeValue);
    } catch (error) {
      await this.server.close().catch(() => undefined);
      this.server = null;
      restoreAllRedirects(this.redirectDir);
      this.recorderError = error instanceof Error ? error.message : "The model address could not be updated.";
      this.refreshStatus();
      this.push();
      return;
    }
    this.recorderError = null;
    this.foundLabel = endpointLabel(chosen);
    this.lastEvent = "Capture is on. Close the app and start it again, then send a message. Each later message is kept.";
    this.output.appendLine(`Routing ${chosen.relativeFile} ${chosen.keyPath} through capture to ${plan.upstream}`);
    this.refreshStatus();
    this.push();
    this.openBeside();
  }

  private async stopCapture(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await server.close().catch(() => undefined);
    }
    restoreAllRedirects(this.redirectDir);
    this.refreshFoundLabel();
    this.lastEvent = "Capture is off, and the model address is restored.";
    this.refreshStatus();
    this.push();
  }

  private refreshFoundLabel(): void {
    if (!this.project || this.server) {
      return;
    }
    const chosen = chooseEndpoint(findEndpoints(this.project.path));
    this.foundLabel = chosen ? endpointLabel(chosen) : null;
  }

  private async setRoute(mode: RouteSettings["mode"], customUpstream: string): Promise<void> {
    const next: RouteSettings = { mode, customUpstream: customUpstream.trim() };
    if (mode === "custom") {
      try {
        chooseUpstream(next, {});
      } catch (error) {
        this.lastEvent = error instanceof Error ? error.message : "That upstream URL is not valid.";
        this.push();
        return;
      }
    }
    this.route = next;
    await this.context.globalState.update(ROUTE_KEY, this.route);
    this.recorderError = null;
    this.lastEvent = mode === "auto"
      ? "OpenAI and Anthropic are detected from each request."
      : "Requests will be forwarded to the custom upstream.";
    this.push();
  }

  private writeEnv(keys: string[]): void {
    if (!this.project) {
      return;
    }
    if (!this.server) {
      this.lastEvent = "Start capture first, then add the URL to .env.";
      this.push();
      return;
    }
    const bases = proposedBases(this.server.url);
    const updates: Record<string, string> = {};
    if (keys.includes(OPENAI_ENV)) {
      updates[OPENAI_ENV] = bases.openai;
    }
    if (keys.includes(ANTHROPIC_ENV)) {
      updates[ANTHROPIC_ENV] = bases.anthropic;
    }
    applyEnv(this.project.path, updates, this.backupDir);
    this.lastEvent = Object.keys(updates).length
      ? "Updated .env. Restart your app, then send a message."
      : "Choose at least one SDK.";
    this.push();
  }

  private restoreEnvFile(): void {
    if (!this.project) {
      return;
    }
    const restored = restoreEnv(this.project.path, this.backupDir);
    this.lastEvent = restored ? "Restored .env to the copy from before the first change." : "There is no saved .env to restore.";
    this.push();
  }

  private async accept(incoming: RecorderCapture): Promise<void> {
    if (!this.project) {
      return;
    }
    const pending = incoming.clientRequestId ? this.pendingSpans.get(incoming.clientRequestId) ?? [] : [];
    if (incoming.clientRequestId) {
      this.pendingSpans.delete(incoming.clientRequestId);
    }
    const capture: StoredCapture = {
      id: crypto.randomUUID(),
      clientRequestId: incoming.clientRequestId,
      projectPath: this.project.path,
      createdAt: new Date().toISOString(),
      provider: incoming.provider,
      upstream: incoming.upstream,
      endpoint: incoming.endpoint,
      model: incoming.model,
      status: incoming.status,
      error: incoming.error,
      messages: incoming.messages,
      reply: incoming.reply,
      reported: pending,
    };
    this.live.set(capture.id, capture);
    if (incoming.clientRequestId) {
      this.clientIds.set(incoming.clientRequestId, capture.id);
    }
    if (this.selected && this.selectedId && this.selectedId !== capture.id) {
      this.compare = this.selected;
      this.compareId = this.selectedId;
    }
    this.selected = capture;
    this.selectedId = capture.id;
    await this.enqueue(capture.id, async () => {
      this.summaries = await this.store.add(capture);
    });
    this.noteCapture(capture.model);
    this.push();
  }

  private async receiveSpans(id: string, spans: ReportedSpan[]): Promise<void> {
    const captureId = this.clientIds.get(id);
    if (!captureId || !this.project) {
      const prior = this.pendingSpans.get(id) ?? [];
      this.pendingSpans.set(id, prior.concat(spans).slice(0, 200));
      if (this.pendingSpans.size > 50) {
        const oldest = this.pendingSpans.keys().next().value;
        if (oldest) {
          this.pendingSpans.delete(oldest);
        }
      }
      return;
    }
    const capture = this.live.get(captureId) ?? (await this.store.get(this.project.path, captureId));
    if (!capture) {
      return;
    }
    capture.reported = capture.reported.concat(spans).slice(0, 200);
    this.live.set(capture.id, capture);
    if (this.selectedId === capture.id) {
      this.selected = capture;
    }
    await this.enqueue(capture.id, () => this.store.update(capture));
    this.lastEvent = "Exact line marks arrived for a call.";
    this.push();
  }

  private enqueue(id: string, work: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.writes.set(id, next);
    return next;
  }

  private async selectCapture(id: string): Promise<void> {
    if (!this.project) {
      return;
    }
    this.selectedId = id;
    this.selected = this.live.get(id) ?? (await this.store.get(this.project.path, id));
    if (this.compareId === id) {
      this.compareId = null;
      this.compare = null;
    }
    this.push();
  }

  private async pinCapture(id: string): Promise<void> {
    if (!this.project) {
      return;
    }
    if (this.compareId === id) {
      this.compareId = null;
      this.compare = null;
      this.push();
      return;
    }
    const capture = this.live.get(id) ?? (await this.store.get(this.project.path, id));
    if (!capture || capture.id === this.selectedId) {
      return;
    }
    this.compare = capture;
    this.compareId = capture.id;
    this.push();
  }

  private async deleteCapture(id: string): Promise<void> {
    if (!this.project) {
      return;
    }
    this.live.delete(id);
    this.summaries = await this.store.remove(this.project.path, id);
    if (this.compareId === id) {
      this.compareId = null;
      this.compare = null;
    }
    if (this.selectedId === id) {
      this.selectedId = this.summaries[0]?.id ?? null;
      this.selected = this.selectedId ? await this.store.get(this.project.path, this.selectedId) : null;
      if (this.compareId === this.selectedId) {
        this.compareId = null;
        this.compare = null;
      }
    }
    this.push();
  }

  private async clearCaptures(): Promise<void> {
    if (!this.project) {
      return;
    }
    await this.store.clear(this.project.path);
    this.live.clear();
    this.summaries = [];
    this.selected = null;
    this.selectedId = null;
    this.compare = null;
    this.compareId = null;
    this.push();
  }

  private async openSpan(captureId: string, spanId: string): Promise<void> {
    if (!this.project) {
      return;
    }
    const stored = this.live.get(captureId) ?? (await this.store.get(this.project.path, captureId));
    if (!stored) {
      return;
    }
    const view = deriveCapture(stored, this.index);
    for (const message of view.messages) {
      const span = message.spans.find((item) => item.id === spanId);
      if (span?.canOpen && span.absolutePath && span.startLine && span.endLine && isInside(this.project.path, span.absolutePath)) {
        await this.showFile(span.absolutePath, span.startLine, span.endLine);
        return;
      }
    }
  }

  private async openClue(file: string, line: number): Promise<void> {
    if (!this.project || !Number.isInteger(line) || line < 1) {
      return;
    }
    const absolute = resolveProjectFile(this.project.path, file);
    if (!absolute) {
      this.lastEvent = "That file is not in the loaded project.";
      this.push();
      return;
    }
    await this.showFile(absolute, line, line);
  }

  private async showFile(file: string, startLine: number, endLine: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
    const start = Math.min(Math.max(0, startLine - 1), Math.max(0, document.lineCount - 1));
    const end = Math.min(Math.max(start, endLine - 1), Math.max(0, document.lineCount - 1));
    const endChar = document.lineAt(end).range.end.character;
    editor.selection = new vscode.Selection(start, 0, end, endChar);
    editor.revealRange(new vscode.Range(start, 0, end, endChar), vscode.TextEditorRevealType.InCenter);
  }

  private async copyUrl(which: "openai" | "anthropic"): Promise<void> {
    if (!this.server) {
      this.lastEvent = "Start capture first.";
      this.push();
      return;
    }
    const bases = proposedBases(this.server.url);
    await vscode.env.clipboard.writeText(which === "anthropic" ? bases.anthropic : bases.openai);
    this.lastEvent = which === "anthropic" ? "Copied the Anthropic base URL." : "Copied the OpenAI base URL.";
    this.push();
  }

  private openBeside(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.panel = vscode.window.createWebviewPanel("contextTracker.editor", "Context Tracker", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.context.extensionUri],
    });
    const detach = this.attach(this.panel.webview, "editor");
    this.panel.onDidDispose(() => {
      detach();
      this.panel = undefined;
    });
  }

  private refreshStatus(flash?: string): void {
    if (!this.project) {
      this.status.hide();
      return;
    }
    this.status.text = flash ?? (this.server ? "$(pulse) Context Tracker" : "$(layers) Context Tracker");
    this.status.tooltip = this.server ? "Capture is on" : "Context Tracker";
    this.status.show();
  }

  private noteCapture(model: string): void {
    this.refreshStatus(`$(pulse) Captured ${model}`);
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.refreshStatus(), 4000);
  }

  private buildState(): ViewState {
    const url = `http://127.0.0.1:${this.server?.port ?? CAPTURE_PORT}`;
    const bases = proposedBases(url);
    const selected = this.selected && this.project && path.resolve(this.selected.projectPath) === this.project.path
      ? presentCapture(deriveCapture(this.selected, this.index))
      : null;
    const compare = this.compare && this.project && path.resolve(this.compare.projectPath) === this.project.path
      ? presentCapture(deriveCapture(this.compare, this.index))
      : null;
    return {
      project: this.project,
      recorder: {
        running: Boolean(this.server),
        url,
        openaiBase: bases.openai,
        anthropicBase: bases.anthropic,
        mode: this.route.mode,
        customUpstream: this.route.customUpstream,
        error: this.recorderError,
        lastEvent: this.lastEvent,
        found: this.foundLabel,
      },
      env: this.project ? readEnvStatus(this.project.path, url, this.backupDir) : null,
      captures: this.summaries,
      selectedId: selected ? this.selectedId : null,
      selected,
      compareId: compare ? this.compareId : null,
      compare,
    };
  }

  private push(): void {
    const state = this.buildState();
    for (const webview of this.views) {
      void webview.postMessage({ type: "state", state });
    }
  }
}
