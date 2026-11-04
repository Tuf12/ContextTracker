import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as vscode from "vscode";
import { deriveCapture, presentCapture } from "./derive";
import { ANTHROPIC_ENV, applyEnv, envPointsAtCapturePort, OPENAI_ENV, proposedBases, readEnvStatus, restoreEnv } from "./env";
import { completeChat, listHelperModels, META_HELPER_BASE, META_MODELS, sanitizeMessagesForHelperApi, type ChatMessage } from "./helperClient";
import {
  ADDRESS_SYSTEM,
  addressTools,
  ATTRIBUTION_SYSTEM,
  attributionTools,
  buildAttributionUserPrompt,
  buildCompareCapturesPrompt,
  buildContextCopilotSystem,
  buildContextSkeleton,
  buildDetectContradictionsPrompt,
  buildDiagnosticUserPrompt,
  buildExplainOutputPrompt,
  buildHelperUserPrompt,
  buildOptimizeContextPrompt,
  buildScanPiiPrompt,
} from "./helperTools";
import { createContextTools, proposeTemplatePatch, validateTemplatePatchContent } from "./contextTools";
import { runHarness } from "./harness";
import { panelHtml } from "./html";
import { indexProject } from "./indexer";
import { isHomeConfigPath, isInside, projectKey, resolveAddressFile, resolveProjectFile } from "./paths";
import { CAPTURE_PORT, chooseUpstream, startRecorder, type RecorderCapture, type RecorderServer } from "./recorder";
import { armRedirect, chooseEndpoint, endpointFromRedirectBackup, endpointLabel, findEndpoints, hasRedirectBackup, isCaptureUrl, locateEndpointInFile, planRewrite, restoreAllRedirects, type FoundEndpoint } from "./redirect";
import { CaptureStore, extractCleanQuote, extractCleanQuotes, extractInvariantPrefix, hashPromptText, matchCachedAttribution } from "./store";
import {
  applyTelemetryResponse,
  buildDeterministicTelemetry,
  buildTelemetrySkeleton,
  estimateTokens,
  extractContextSections,
  globalTelemetryCache,
  parseTelemetryResponse,
  TELEMETRY_SYSTEM,
} from "./telemetry";
import {
  bridgeAndroidDevice,
  checkAndroidBuildState,
  detectAndroidEnvironment,
  diagnoseAndroidConnection,
  inspectAndroidSecurity,
  isAndroidProject,
  removeAndroidBridge,
} from "./android";
import type {
  AddressOffer,
  AndroidEnvironment,
  AndroidSecurityResult,
  AndroidViewInfo,
  AttributedSpan,
  CachedAttribution,
  CaptureTelemetry,
  ChatConversation,
  ContextScope,
  HelperActivityItem,
  HelperActivityKind,
  ProjectIndex,
  ProjectView,
  PromptMessage,
  ReportedSpan,
  RouteSettings,
  RunHopInfo,
  RunTrajectoryHop,
  RunTrajectoryResult,
  StoredCapture,
  TemplatePatchProposal,
  ViewState,
} from "./types";
import { TrafficWatchdog } from "./watchdog";

const PROJECT_KEY = "contextTracker.projectPath";
const ROUTE_KEY = "contextTracker.route";
const HELPER_MODEL = "contextTracker.helperModel";
const HELPER_SECRET = "contextTracker.helperApiKey";
const SAVED_ENDPOINT_PREFIX = "contextTracker.savedEndpoint.";

type ActiveRunState = {
  runId: string;
  triggeringUserHash: string;
  triggeringUserQuery: string;
  lastCaptureTime: number;
  captureIds: string[];
};

function extractTriggeringUserMessage(messages: PromptMessage[]): { text: string; hash: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.content && m.content.trim()) {
      const text = m.content.trim();
      return { text, hash: hashPromptText(text) };
    }
  }
  const fallback = messages[0]?.content?.trim() || "Empty prompt";
  return { text: fallback, hash: hashPromptText(fallback) };
}

function extractToolCalls(messages: PromptMessage[], reply: string): string[] {
  const tools = new Set<string>();
  for (const m of messages) {
    const fnMatches = m.content.matchAll(/\[(?:call|tool_use|function_call):\s*([a-zA-Z0-9_\-\.]+)/g);
    for (const match of fnMatches) {
      if (match[1]) tools.add(match[1]);
    }
  }
  const replyMatches = reply.matchAll(/"name":\s*"([a-zA-Z0-9_\-\.]+)"/g);
  for (const match of replyMatches) {
    if (match[1] && !["function", "object", "string"].includes(match[1])) {
      tools.add(match[1]);
    }
  }
  return Array.from(tools).slice(0, 5);
}

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
  private readonly activeRuns = new Map<string, ActiveRunState>();
  private project: ProjectView | null = null;
  private index: ProjectIndex | null = null;
  private indexGeneration = 0;
  private summaries: ViewState["captures"] = [];
  private projectAttributions: CachedAttribution[] = [];
  private selectedId: string | null = null;
  private selected: StoredCapture | null = null;
  private compareId: string | null = null;
  private compare: StoredCapture | null = null;
  private server: RecorderServer | null = null;
  private route: RouteSettings = { mode: "auto", customUpstream: "" };
  private readonly redirectDir: string;
  private readonly ignoredEndpoints = new Set<string>();
  private readonly watchdog = new TrafficWatchdog({
    onStateChange: () => this.push(),
  });
  private currentEndpoint: FoundEndpoint | null = null;
  private foundLabel: string | null = null;
  private recorderError: string | null = null;
  private lastEvent: string | null = null;
  private helperModel = "";
  private helperKeySaved = false;
  private helperConnectOpen = false;
  private helperNeeded = false;
  private helperBusy = false;
  private helperStatus: string | null = null;
  private addressOffer: AddressOffer | null = null;
  private activeAndroidDevice: string | null = null;
  private activeAndroidBridge = false;
  private activeScope: ContextScope | undefined;
  private activePatch: TemplatePatchProposal | null = null;
  private readonly knownPatches = new Map<string, TemplatePatchProposal>();
  private readonly appliedPatches = new Set<string>();
  private readonly conversations = new Map<string, ChatConversation>();
  private readonly conversationWritePromises = new Map<string, Promise<void>>();
  private helperRun = 0;
  private panel: vscode.WebviewPanel | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  private currentConversationKey(): string {
    return this.selected?.id || "project";
  }

  private getConversation(key: string): ChatConversation {
    let conv = this.conversations.get(key);
    if (!conv) {
      conv = {
        id: key,
        activity: [],
        messages: [],
        activePatch: null,
        updatedAt: Date.now(),
      };
      this.conversations.set(key, conv);
    }
    return conv;
  }

  private async loadConversation(key: string): Promise<ChatConversation> {
    const existing = this.conversations.get(key);
    if (existing) {
      return existing;
    }
    if (this.project) {
      const stored = await this.store.getChat(this.project.path, key);
      if (stored) {
        if (stored.activePatch) {
          this.knownPatches.set(stored.activePatch.patchId, stored.activePatch);
        }
        for (const item of stored.activity) {
          if (item.patch) {
            this.knownPatches.set(item.patch.patchId, item.patch);
          }
        }
        this.conversations.set(key, stored);
        return stored;
      }
    }
    return this.getConversation(key);
  }

  private saveConversationAsync(key: string): Promise<void> {
    if (!this.project) {
      return Promise.resolve();
    }
    const conv = this.conversations.get(key);
    if (!conv) {
      return Promise.resolve();
    }
    const prior = this.conversationWritePromises.get(key) ?? Promise.resolve();
    const next = prior
      .then(async () => {
        if (this.project) {
          await this.store.saveChat(this.project.path, conv);
        }
      })
      .catch((err) => {
        this.output.appendLine(
          `[Chat] Failed to persist chat ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    this.conversationWritePromises.set(key, next);
    return next;
  }

  private recordActivity(
    item: {
      kind: HelperActivityKind;
      text: string;
      toolName?: string;
      detail?: string;
      patch?: TemplatePatchProposal;
      patchApplied?: boolean;
    },
    targetKey?: string,
  ): void {
    const key = targetKey || this.currentConversationKey();
    const conv = this.getConversation(key);
    const entry: HelperActivityItem = {
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      kind: item.kind,
      text: item.text,
      toolName: item.toolName,
      detail: item.detail,
      patch: item.patch,
      patchApplied: item.patchApplied,
    };
    if (item.patch) {
      this.knownPatches.set(item.patch.patchId, item.patch);
      conv.activePatch = item.patch;
      if (key === this.currentConversationKey()) {
        this.activePatch = item.patch;
      }
    }
    conv.activity.push(entry);
    if (conv.activity.length > 100) {
      conv.activity.splice(0, conv.activity.length - 100);
    }
    conv.updatedAt = Date.now();
    void this.saveConversationAsync(key);
    this.push();
  }

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
    this.watchdog.stop();
    void removeAndroidBridge().catch(() => undefined);
    void this.server?.close().catch(() => undefined);
    this.server = null;
    this.restoreProjectRouting();
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
    await this.loadHelperSettings();
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
    this.watchdog.recordUserActivity();
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
      case "troubleshootConnection":
        await this.troubleshootConnection();
        return;
      case "openHelper":
        this.helperConnectOpen = !this.helperConnectOpen;
        this.push();
        return;
      case "saveHelper":
        await this.saveHelper(
          typeof body.model === "string" ? body.model : "",
          typeof body.apiKey === "string" ? body.apiKey : "",
        );
        return;
      case "findAddress":
        await this.findAddress();
        return;
      case "forgetAddress":
        await this.forgetAddress();
        return;
      case "confirmAddress":
        await this.confirmAddress();
        return;
      case "dismissAddress":
        this.addressOffer = null;
        this.helperStatus = "No model address was found in this project.";
        this.push();
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
      case "attributeMessage":
        if (typeof body.captureId === "string" && typeof body.messageIndex === "number") {
          const content = typeof body.content === "string" ? body.content : undefined;
          await this.attributeCaptureMessage(body.captureId, body.messageIndex, { content });
        }
        return;
      case "analyzeTelemetry":
        if (typeof body.captureId === "string") {
          await this.analyzeContextTelemetry(body.captureId);
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
      case "copyText":
        if (typeof body.text === "string" && body.text) {
          await vscode.env.clipboard.writeText(body.text);
          this.lastEvent = "Copied to clipboard.";
          this.push();
        }
        return;
      case "showLog":
        this.output.show(true);
        return;
      case "openBeside":
        this.openBeside();
        return;
      case "helperMessage":
        await this.handleHelperMessage(typeof body.text === "string" ? body.text : "");
        return;
      case "setScope":
        if (body.scope && typeof body.scope === "object" && "kind" in body.scope && "label" in body.scope) {
          this.activeScope = body.scope as ContextScope;
          this.push();
        }
        return;
      case "clearScope":
        this.activeScope = this.selected ? { kind: "global", label: "All Context" } : undefined;
        this.push();
        return;
      case "quickAction":
        if (typeof body.action === "string") {
          const scope = body.scope && typeof body.scope === "object" && "kind" in body.scope && "label" in body.scope ? (body.scope as ContextScope) : undefined;
          await this.handleQuickAction(body.action, scope);
        }
        return;
      case "applyPatch":
        await this.applyTemplatePatch(
          typeof body.patchId === "string" ? body.patchId : undefined,
          body.patch && typeof body.patch === "object" ? (body.patch as TemplatePatchProposal) : undefined,
        );
        return;
      case "applyAllPatches":
        await this.applyAllTemplatePatches();
        return;
      case "clearHelperActivity": {
        const key = this.currentConversationKey();
        const conv = this.getConversation(key);
        conv.activity = [];
        conv.messages = [];
        conv.activePatch = null;
        conv.updatedAt = Date.now();
        this.activePatch = null;
        if (this.project) {
          await this.store.removeChat(this.project.path, key);
        }
        this.push();
        return;
      }
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
    this.activeScope = undefined;
    this.activePatch = null;
    this.helperNeeded = false;
    this.addressOffer = null;
    this.helperRun += 1;
    this.helperBusy = false;
    this.ignoredEndpoints.delete(resolved);
    this.conversations.clear();
    this.conversationWritePromises.clear();
    this.projectAttributions = await this.store.seedAttributionsFromCaptures(resolved);
    const rawSummaries = await this.store.list(resolved);
    const chatIds = new Set(await this.store.listChats(resolved));
    this.summaries = rawSummaries.map((s) => ({
      ...s,
      chatCount: chatIds.has(s.id) ? 1 : 0,
    }));
    if (this.summaries.length > 0 && !this.selectedId) {
      this.selectedId = this.summaries[0].id;
      const topCapture = await this.store.get(resolved, this.selectedId);
      if (topCapture) {
        this.applyCachedAttributions(topCapture);
        this.live.set(topCapture.id, topCapture);
        this.selected = topCapture;
        this.activeScope = { kind: "global", label: "All Context" };
      }
    }
    const currentKey = this.currentConversationKey();
    const initialConv = await this.loadConversation(currentKey);
    this.activePatch = initialConv.activePatch ?? null;
    await this.context.globalState.update(PROJECT_KEY, resolved);
    await this.reconcileInterruptedCapture();
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
    if (isAndroidProject(resolved)) {
      void detectAndroidEnvironment().then((env) => {
        if (env.available) {
          const active = env.devices.filter((d) => d.state === "device");
          if (active.length > 0) {
            this.activeAndroidDevice = active.map((d) => d.model || d.serial).join(", ");
            this.push();
          }
        }
      }).catch(() => undefined);
    }
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
    let chosen: FoundEndpoint | null = null;
    if (!this.ignoredEndpoints.has(this.project.path)) {
      chosen = chooseEndpoint(findEndpoints(this.project.path));
      if (!chosen) {
        chosen = this.getSavedEndpoint(this.project.path);
      }
    }
    if (!chosen) {
      this.foundLabel = null;
      this.recorderError = null;
      this.helperNeeded = true;
      if (!this.helperKeySaved || !this.helperModel.trim()) {
        this.lastEvent = "No model address was found. Connect an AI helper above, then press Start capture again.";
        this.helperConnectOpen = true;
        this.helperStatus = "Connect an AI helper to find the address.";
        this.push();
        return;
      }
      this.helperConnectOpen = false;
      await this.findAddress();
      return;
    }
    await this.armCapture(chosen);
  }

  private async armCapture(chosen: FoundEndpoint): Promise<void> {
    const upstreamValue = this.upstreamForCapture(chosen);
    if (isCaptureUrl(upstreamValue)) {
      this.recorderError = "Could not determine the real model address. Use Find address with the AI helper or confirm the endpoint again.";
      this.push();
      return;
    }
    const plan = planRewrite(upstreamValue, `http://127.0.0.1:${CAPTURE_PORT}`);
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
      this.restoreProjectRouting();
      this.recorderError = error instanceof Error ? error.message : "The model address could not be updated.";
      this.refreshStatus();
      this.push();
      return;
    }
    this.recorderError = null;
    this.helperNeeded = false;
    this.addressOffer = null;
    this.foundLabel = endpointLabel(chosen);
    this.currentEndpoint = chosen;
    this.watchdog.setUpstream(plan.upstream);

    const buildState = checkAndroidBuildState(chosen.projectPath, chosen.filePath);
    if (buildState.isAndroidProject) {
      this.watchdog.setProjectContext({ isAndroid: true, isStale: buildState.isStale });
      void bridgeAndroidDevice({}).then((res) => {
        if (res.success && res.bridgedDevices.length > 0) {
          this.activeAndroidBridge = true;
          this.activeAndroidDevice = res.bridgedDevices.join(", ");
          this.output.appendLine(`[Android Bridge] Bridged port 47321 to device(s): ${res.bridgedDevices.join(", ")}`);
          this.push();
        }
      }).catch(() => undefined);
      if (buildState.isStale) {
        this.output.appendLine(`[Android Build] Note: ${buildState.summary}`);
      }
    } else {
      this.watchdog.setProjectContext(undefined);
    }

    this.watchdog.start();
    this.lastEvent = `Capture is on. ${chosen.relativeFile} now points at capture. Close the app and start it again, then send a message. A message from an app that is already open is not recorded.`;
    this.output.appendLine(`Routing ${chosen.relativeFile} ${chosen.keyPath} through capture to ${plan.upstream}`);
    await this.saveConfirmedEndpoint(chosen);
    this.refreshStatus();
    this.push();
    this.openBeside();
  }

  private async loadHelperSettings(): Promise<void> {
    const saved = this.context.globalState.get<string>(HELPER_MODEL) ?? "";
    this.helperModel = META_MODELS.some((item) => item.id === saved) ? saved : "";
    const key = await this.context.secrets.get(HELPER_SECRET);
    this.helperKeySaved = Boolean(key && key.trim());
  }

  private async saveHelper(model: string, apiKey: string): Promise<void> {
    const chosen = META_MODELS.find((item) => item.id === model.trim());
    if (!chosen) {
      this.helperStatus = "Choose a Meta model.";
      this.helperConnectOpen = true;
      this.push();
      return;
    }
    const previousKey = await this.context.secrets.get(HELPER_SECRET);
    const nextKey = apiKey.trim() || previousKey || "";
    if (!nextKey) {
      this.helperStatus = "Add an API key.";
      this.helperConnectOpen = true;
      this.push();
      return;
    }
    try {
      await listHelperModels({ baseUrl: META_HELPER_BASE, apiKey: nextKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      this.helperStatus = message === "The helper host rejected the API key."
        ? "Meta rejected that API key."
        : "Meta could not be reached.";
      this.helperConnectOpen = true;
      this.push();
      return;
    }
    await this.context.secrets.store(HELPER_SECRET, nextKey);
    this.helperKeySaved = true;
    this.helperModel = chosen.id;
    await this.context.globalState.update(HELPER_MODEL, this.helperModel);
    this.helperConnectOpen = true;
    this.helperStatus = `AI helper is ${chosen.label}.`;
    this.push();
  }

  private async findAddress(): Promise<void> {
    if (!this.project || this.helperBusy || this.server) {
      return;
    }
    const apiKey = await this.context.secrets.get(HELPER_SECRET);
    if (!apiKey?.trim() || !this.helperModel) {
      this.helperStatus = "Connect an AI helper and choose a Meta model first.";
      this.push();
      return;
    }
    const run = ++this.helperRun;
    const projectPath = this.project.path;
    const searching = "The AI helper is searching this project for the model address so capture can connect.";
    this.helperBusy = true;
    this.addressOffer = null;
    this.helperStatus = searching;
    this.lastEvent = searching;
    this.status.text = "$(loading~spin) AI helper is searching";
    this.status.tooltip = searching;
    this.status.show();
    this.recordActivity({
      kind: "status",
      text: "Starting autonomous search for model address with Meta AI...",
      detail: `Model: ${this.helperModel}`,
    }, "project");
    this.push();
    try {
      const userPrompt = buildHelperUserPrompt(this.project.clues || [], {
        name: this.project.name,
        path: this.project.path,
      });
      const result = await runHarness({
        system: ADDRESS_SYSTEM,
        user: userPrompt,
        tools: addressTools(projectPath),
        stepCap: 16,
        complete: (messages, tools) => completeChat({
          baseUrl: META_HELPER_BASE,
          apiKey,
          model: this.helperModel,
          messages,
          tools,
        }),
        onTool: (name) => {
          if (run !== this.helperRun) {
            return;
          }
          const step = helperStepLabel(name);
          this.helperStatus = step;
          this.lastEvent = step;
          this.push();
        },
        onEvent: (event) => {
          if (run !== this.helperRun) {
            return;
          }
          if (event.kind === "thought") {
            this.recordActivity({ kind: "thought", text: event.text }, "project");
          } else if (event.kind === "tool_call") {
            this.recordActivity({
              kind: "tool_call",
              toolName: event.toolName,
              text: formatToolCall(event.toolName, event.args),
              detail: typeof event.args === "object" ? JSON.stringify(event.args, null, 2) : String(event.args),
            }, "project");
          } else if (event.kind === "tool_result") {
            this.recordActivity({
              kind: "tool_result",
              toolName: event.toolName,
              text: summarizeToolResult(event.toolName, event.content),
              detail: event.content,
            }, "project");
          }
        },
      });
      if (run !== this.helperRun) {
        return;
      }
      if (!result.finish) {
        this.helperStatus = `The AI helper reached the search limit (${result.steps} steps) without an address. Click Start capture again to retry.`;
        this.lastEvent = this.helperStatus;
        this.recordActivity({
          kind: "status",
          text: this.helperStatus,
        }, "project");
      } else {
        this.addressOffer = result.finish;
        this.helperStatus = "The AI helper found a model address. Confirm it above to start capture.";
        this.lastEvent = this.helperStatus;
        this.recordActivity({
          kind: "finish",
          text: `Found model address ${this.addressOffer.url} in ${this.addressOffer.relativeFile}:${this.addressOffer.line}`,
          detail: this.addressOffer.reason,
        }, "project");
      }
    } catch (error) {
      if (run !== this.helperRun) {
        return;
      }
      this.helperStatus = error instanceof Error ? error.message : "The helper model could not be reached.";
      this.lastEvent = this.helperStatus;
      this.recordActivity({
        kind: "status",
        text: this.helperStatus,
      }, "project");
    } finally {
      if (run === this.helperRun) {
        this.helperBusy = false;
        this.refreshStatus();
        this.push();
      }
    }
  }

  private async confirmAddress(): Promise<void> {
    if (!this.project || !this.addressOffer) {
      return;
    }
    if (this.server) {
      await this.stopCapture();
    }
    this.ignoredEndpoints.delete(this.project.path);
    const offer = this.addressOffer;
    const filePath = resolveAddressFile(this.project.path, offer.relativeFile);
    if (!filePath) {
      this.helperStatus = "That file is not in the project.";
      this.push();
      return;
    }
    await this.armCapture({
      projectPath: this.project.path,
      filePath,
      relativeFile: offer.relativeFile,
      line: offer.line,
      keyPath: "helper",
      value: offer.url,
    });
  }

  private async stopCapture(): Promise<void> {
    this.watchdog.stop();
    this.currentEndpoint = null;
    const server = this.server;
    this.server = null;
    if (server) {
      await server.close().catch(() => undefined);
    }
    await removeAndroidBridge().catch(() => undefined);
    this.activeAndroidBridge = false;
    this.restoreProjectRouting();
    this.refreshFoundLabel();
    this.lastEvent = "Capture is off, and the model address is restored.";
    this.refreshStatus();
    this.push();
  }

  public async diagnoseConnection(
    project: ProjectView,
    failedEndpoint: { relativeFile: string; url: string; reason?: string },
  ): Promise<AddressOffer | null> {
    if (!this.helperKeySaved || !this.helperModel.trim()) {
      this.helperConnectOpen = true;
      this.helperStatus = "Connect an AI helper to run connection diagnostics.";
      this.push();
      return null;
    }
    const apiKey = await this.context.secrets.get(HELPER_SECRET);
    if (!apiKey) {
      this.helperKeySaved = false;
      this.helperConnectOpen = true;
      this.helperStatus = "API key was not found. Connect the AI helper again.";
      this.push();
      return null;
    }
    const run = ++this.helperRun;
    const diagnosing = `The AI helper is diagnosing why traffic bypassed ${failedEndpoint.relativeFile}...`;
    this.helperBusy = true;
    this.addressOffer = null;
    this.helperStatus = diagnosing;
    this.lastEvent = diagnosing;
    this.status.text = "$(loading~spin) AI helper diagnosing";
    this.status.tooltip = diagnosing;
    this.status.show();
    this.recordActivity({
      kind: "status",
      text: diagnosing,
    }, "project");
    this.push();

    try {
      let androidEnvironment: AndroidEnvironment | undefined;
      let securityFindings: AndroidSecurityResult | undefined;
      let buildArtifactStatus: string | undefined;

      try {
        const fullSourcePath = failedEndpoint.relativeFile ? resolveAddressFile(project.path, failedEndpoint.relativeFile) : undefined;
        const diag = await diagnoseAndroidConnection({
          projectRoot: project.path,
          sourceFilePath: fullSourcePath || undefined,
        });
        if (diag.isAndroid) {
          androidEnvironment = diag.env;
          securityFindings = diag.security;
          buildArtifactStatus = diag.buildState.summary;
          if (diag.repairedBridge && diag.repairedBridge.success) {
            this.output.appendLine(`[Android Bridge] Re-established bridge for ${diag.repairedBridge.bridgedDevices.join(", ")}`);
          }
        }
      } catch {
        // Non-blocking
      }

      const userPrompt = buildDiagnosticUserPrompt({
        failedFile: failedEndpoint.relativeFile,
        failedUrl: failedEndpoint.url,
        reason: failedEndpoint.reason || "Outbound prompts bypassed recorder port 47321.",
        projectName: project.name,
        clues: project.clues,
        androidEnvironment,
        securityFindings,
        buildArtifactStatus,
      });

      const result = await runHarness({
        system: ADDRESS_SYSTEM,
        user: userPrompt,
        tools: addressTools(project.path, {
          failedFile: failedEndpoint.relativeFile,
          failedUrl: failedEndpoint.url,
        }),
        stepCap: 16,
        complete: (messages, tools) =>
          completeChat({
            baseUrl: META_HELPER_BASE,
            apiKey,
            model: this.helperModel,
            messages,
            tools,
          }),
        onTool: (name) => {
          if (run !== this.helperRun) {
            return;
          }
          const step = helperStepLabel(name);
          this.helperStatus = step;
          this.lastEvent = step;
          this.push();
        },
        onEvent: (event) => {
          if (run !== this.helperRun) {
            return;
          }
          if (event.kind === "thought") {
            this.recordActivity({ kind: "thought", text: event.text }, "project");
          } else if (event.kind === "tool_call") {
            this.recordActivity({
              kind: "tool_call",
              toolName: event.toolName,
              text: formatToolCall(event.toolName, event.args),
              detail: typeof event.args === "object" ? JSON.stringify(event.args, null, 2) : String(event.args),
            }, "project");
          } else if (event.kind === "tool_result") {
            this.recordActivity({
              kind: "tool_result",
              toolName: event.toolName,
              text: summarizeToolResult(event.toolName, event.content),
              detail: event.content,
            }, "project");
          }
        },
      });

      if (run !== this.helperRun) {
        return null;
      }

      if (!result.finish) {
        this.helperStatus = "Diagnostic search completed without finding an alternative address. Check your app's configuration files.";
        this.lastEvent = this.helperStatus;
        this.recordActivity({
          kind: "status",
          text: this.helperStatus,
        }, "project");
        return null;
      }

      const offer: AddressOffer = {
        ...result.finish,
        previousFile: failedEndpoint.relativeFile,
        explanation: `Helper found that the app loaded settings from ${result.finish.relativeFile} instead of ${failedEndpoint.relativeFile}. Click to switch connection.`,
      };
      this.addressOffer = offer;
      this.helperStatus = offer.explanation ?? null;
      this.lastEvent = offer.explanation ?? null;
      this.recordActivity({
        kind: "finish",
        text: `Diagnosed active runtime configuration in ${offer.relativeFile} line ${offer.line}`,
        detail: offer.explanation,
      }, "project");
      return offer;
    } catch (error) {
      if (run !== this.helperRun) {
        return null;
      }
      this.helperStatus = error instanceof Error ? error.message : "Connection diagnostics failed.";
      this.lastEvent = this.helperStatus;
      this.recordActivity({
        kind: "status",
        text: this.helperStatus,
      }, "project");
      return null;
    } finally {
      if (run === this.helperRun) {
        this.helperBusy = false;
        this.refreshStatus();
        this.push();
      }
    }
  }

  public async attributeCaptureMessage(
    captureId: string,
    messageIndex: number,
    options?: { content?: string },
  ): Promise<AttributedSpan | null> {
    if (!this.project) {
      this.lastEvent = "Open a project first.";
      this.push();
      return null;
    }
    const capture = this.live.get(captureId) ?? (await this.store.get(this.project.path, captureId));
    if (!capture || !capture.messages[messageIndex]) {
      this.lastEvent = "Message was not found in capture.";
      this.push();
      return null;
    }
    const message = capture.messages[messageIndex];
    const targetContent = options?.content?.trim() || message.content;
    if (!targetContent.trim()) {
      this.lastEvent = "Message has no content to attribute.";
      this.push();
      return null;
    }

    if (!this.helperKeySaved || !this.helperModel.trim()) {
      this.helperConnectOpen = true;
      this.helperStatus = "Connect an AI helper to attribute prompt templates to code.";
      this.push();
      return null;
    }
    const apiKey = await this.context.secrets.get(HELPER_SECRET);
    if (!apiKey) {
      this.helperKeySaved = false;
      this.helperConnectOpen = true;
      this.helperStatus = "API key was not found. Connect the AI helper again.";
      this.push();
      return null;
    }

    const run = ++this.helperRun;
    const working = `The AI helper is attributing prompt message ${messageIndex + 1} to source code...`;
    this.helperBusy = true;
    this.helperStatus = working;
    this.lastEvent = working;
    this.status.text = "$(loading~spin) Attributing prompt";
    this.status.tooltip = working;
    this.status.show();
    this.recordActivity({
      kind: "status",
      text: working,
    }, captureId);
    this.push();

    try {
      const userPrompt = buildAttributionUserPrompt({
        content: targetContent,
        role: message.role,
        projectName: this.project.name,
        model: capture.model,
      });

      const result = await runHarness({
        system: ATTRIBUTION_SYSTEM,
        user: userPrompt,
        tools: attributionTools(this.project.path),
        stepCap: 8,
        complete: (messages, tools) =>
          completeChat({
            baseUrl: META_HELPER_BASE,
            apiKey,
            model: this.helperModel,
            messages,
            tools,
          }),
        onTool: (name) => {
          if (run !== this.helperRun) {
            return;
          }
          const step = helperStepLabel(name);
          this.helperStatus = step;
          this.lastEvent = step;
          this.push();
        },
        onEvent: (event) => {
          if (run !== this.helperRun) {
            return;
          }
          if (event.kind === "thought") {
            this.recordActivity({ kind: "thought", text: event.text }, captureId);
          } else if (event.kind === "tool_call") {
            this.recordActivity({
              kind: "tool_call",
              toolName: event.toolName,
              text: formatToolCall(event.toolName, event.args),
              detail: typeof event.args === "object" ? JSON.stringify(event.args, null, 2) : String(event.args),
            }, captureId);
          } else if (event.kind === "tool_result") {
            this.recordActivity({
              kind: "tool_result",
              toolName: event.toolName,
              text: summarizeToolResult(event.toolName, event.content),
              detail: event.content,
            }, captureId);
          }
        },
      });

      if (run !== this.helperRun) {
        return null;
      }

      if (!result.finish) {
        this.helperStatus = "The AI helper completed search without identifying a template file.";
        this.lastEvent = this.helperStatus;
        this.recordActivity({
          kind: "status",
          text: this.helperStatus,
        }, captureId);
        return null;
      }

      const attributed = result.finish;
      const cleanQuotes = extractCleanQuotes(attributed.matchedSnippet);
      const cleanQuote = cleanQuotes[0] ?? extractCleanQuote(attributed.matchedSnippet);
      const invariantPrefix = extractInvariantPrefix(targetContent);
      const reportedSpan: ReportedSpan = {
        messageIndex,
        file: attributed.file,
        startLine: attributed.startLine,
        endLine: attributed.endLine,
        source: "attributed",
        confidence: attributed.confidence,
        explanation: attributed.explanation,
        quote: cleanQuote || attributed.matchedSnippet,
      };

      if (options?.content && message.content.includes(options.content)) {
        const offset = message.content.indexOf(options.content);
        reportedSpan.charStart = offset;
        reportedSpan.charEnd = offset + options.content.length;
      }

      capture.reported = (capture.reported ?? [])
        .filter((span) => {
          if (span.messageIndex !== messageIndex || span.source !== "attributed") {
            return true;
          }
          if (
            reportedSpan.charStart !== undefined &&
            reportedSpan.charEnd !== undefined &&
            span.charStart !== undefined &&
            span.charEnd !== undefined
          ) {
            return span.charEnd <= reportedSpan.charStart || span.charStart >= reportedSpan.charEnd;
          }
          return !options?.content;
        })
        .concat(reportedSpan);

      const cachedAttr: CachedAttribution = {
        fingerprint: hashPromptText(targetContent),
        quote: attributed.matchedSnippet,
        cleanQuote: cleanQuote ?? undefined,
        cleanQuotes: cleanQuotes.length > 0 ? cleanQuotes : undefined,
        invariantPrefix: invariantPrefix ?? undefined,
        file: attributed.file,
        startLine: attributed.startLine,
        endLine: attributed.endLine,
        confidence: attributed.confidence,
        explanation: attributed.explanation,
        attributedAt: new Date().toISOString(),
      };
      await this.store.saveAttribution(this.project.path, cachedAttr);
      const existingIdx = this.projectAttributions.findIndex(
        (a) => a.fingerprint === cachedAttr.fingerprint || (cachedAttr.cleanQuote && a.cleanQuote === cachedAttr.cleanQuote),
      );
      if (existingIdx >= 0) {
        this.projectAttributions[existingIdx] = cachedAttr;
      } else {
        this.projectAttributions.unshift(cachedAttr);
      }

      for (const [liveId, liveCap] of this.live.entries()) {
        if (liveId !== capture.id) {
          if (this.applyCachedAttributions(liveCap)) {
            await this.enqueue(liveId, () => this.store.update(liveCap));
          }
        }
      }

      this.live.set(capture.id, capture);
      if (this.selectedId === capture.id) {
        this.selected = capture;
      }
      if (this.compareId === capture.id) {
        this.compare = capture;
      }
      await this.enqueue(capture.id, async () => {
        this.summaries = await this.store.update(capture);
      });

      this.helperStatus = `Prompt attributed to ${attributed.file}:${attributed.startLine}–${attributed.endLine}`;
      this.lastEvent = this.helperStatus;
      this.recordActivity({
        kind: "finish",
        text: `Prompt attributed to ${attributed.file}:${attributed.startLine}–${attributed.endLine} (confidence: ${Math.round(attributed.confidence * 100)}%)`,
        detail: attributed.explanation,
      }, captureId);
      this.push();
      return attributed;
    } catch (error) {
      if (run !== this.helperRun) {
        return null;
      }
      this.helperStatus = error instanceof Error ? error.message : "Attribution failed.";
      this.lastEvent = this.helperStatus;
      this.recordActivity({
        kind: "status",
        text: this.helperStatus,
      }, captureId);
      return null;
    } finally {
      if (run === this.helperRun) {
        this.helperBusy = false;
        this.refreshStatus();
        this.push();
      }
    }
  }

  public async analyzeContextTelemetry(captureId: string): Promise<CaptureTelemetry | null> {
    if (!this.project) {
      this.lastEvent = "Open a project first.";
      this.push();
      return null;
    }
    const capture = this.live.get(captureId) ?? (await this.store.get(this.project.path, captureId));
    if (!capture || !capture.messages || capture.messages.length === 0) {
      this.lastEvent = "Capture has no messages to analyze.";
      this.push();
      return null;
    }

    const sections = extractContextSections(capture.messages);
    const totalTokens = sections.reduce((sum, s) => sum + s.tokenEstimate, 0);

    const apiKey = await this.context.secrets.get(HELPER_SECRET);
    const hasHelper = Boolean(apiKey?.trim() && this.helperModel.trim());

    if (!hasHelper) {
      const telemetry = buildDeterministicTelemetry(capture.id, capture.messages);
      capture.telemetry = telemetry;
      this.live.set(capture.id, capture);
      if (this.selectedId === capture.id) {
        this.selected = capture;
      }
      if (this.compareId === capture.id) {
        this.compare = capture;
      }
      await this.enqueue(capture.id, async () => {
        this.summaries = await this.store.update(capture);
      });

      const topCategory = telemetry.composition[0]?.categoryLabel ?? "General Context";
      const topPct = telemetry.composition[0]?.percentage ?? 100;
      const statusText = `Context telemetry: Analyzed ${sections.length} sections (${topPct}% ${topCategory})`;
      this.lastEvent = statusText;
      this.recordActivity({
        kind: "status",
        text: `📊 Context Telemetry: Analyzed ${sections.length} prompt sections (${topPct}% ${topCategory})`,
        detail: telemetry.composition.map((c) => `${c.categoryLabel}: ${c.tokens}t (${c.percentage}%)`).join(", "),
      }, captureId);
      this.push();
      return telemetry;
    }

    const run = ++this.helperRun;
    const working = `The AI helper is analyzing prompt context anatomy and evaluating ${sections.length} sections (${totalTokens} estimated tokens)…`;
    this.helperBusy = true;
    this.helperStatus = working;
    this.lastEvent = working;
    this.status.text = "$(loading~spin) Analyzing context telemetry";
    this.status.tooltip = working;
    this.status.show();
    this.recordActivity({
      kind: "status",
      text: working,
    }, captureId);
    this.push();

    try {
      const skeletonJson = buildTelemetrySkeleton(sections);
      const userContent = [
        `Captured Prompt Messages: ${capture.messages.length}`,
        `Total Estimated Tokens: ${totalTokens}`,
        `Model: ${capture.model || "unknown"}`,
        "",
        "Context Skeleton to analyze:",
        skeletonJson,
      ].join("\n");

      const response = await completeChat({
        baseUrl: META_HELPER_BASE,
        apiKey: apiKey!,
        model: this.helperModel,
        messages: [
          { role: "system", content: TELEMETRY_SYSTEM },
          { role: "user", content: userContent },
        ],
      });

      if (run !== this.helperRun) {
        return null;
      }

      const parsed = parseTelemetryResponse(response.content ?? "");
      const telemetry = applyTelemetryResponse(capture.id, sections, parsed);

      capture.telemetry = telemetry;
      this.live.set(capture.id, capture);
      if (this.selectedId === capture.id) {
        this.selected = capture;
      }
      if (this.compareId === capture.id) {
        this.compare = capture;
      }
      await this.enqueue(capture.id, async () => {
        this.summaries = await this.store.update(capture);
      });

      const topCategory = telemetry.composition[0]?.categoryLabel ?? "Context";
      const topPct = telemetry.composition[0]?.percentage ?? 100;
      const finishText = `🤖 Meta AI Telemetry: Analyzed ${sections.length} prompt sections, identified ${topPct}% ${topCategory}`;
      this.helperStatus = finishText;
      this.lastEvent = finishText;
      this.recordActivity({
        kind: "finish",
        text: finishText,
        detail: telemetry.composition.map((c) => `${c.categoryLabel}: ${c.tokens}t (${c.percentage}%)`).join("\n"),
      }, captureId);
      this.push();
      return telemetry;
    } catch (error) {
      if (run !== this.helperRun) {
        return null;
      }
      const fallback = buildDeterministicTelemetry(capture.id, capture.messages);
      capture.telemetry = fallback;
      this.live.set(capture.id, capture);
      if (this.selectedId === capture.id) {
        this.selected = capture;
      }
      if (this.compareId === capture.id) {
        this.compare = capture;
      }
      await this.enqueue(capture.id, async () => {
        this.summaries = await this.store.update(capture);
      });

      const errMsg = error instanceof Error ? error.message : "Telemetry analysis failed.";
      this.helperStatus = `Telemetry fallback applied: ${errMsg}`;
      this.lastEvent = this.helperStatus;
      this.recordActivity({
        kind: "status",
        text: `⚠️ Telemetry fallback applied: ${errMsg}`,
      }, captureId);
      this.push();
      return fallback;
    } finally {
      if (run === this.helperRun) {
        this.helperBusy = false;
        this.refreshStatus();
        this.push();
      }
    }
  }

  private async troubleshootConnection(): Promise<void> {
    if (!this.server) {
      this.lastEvent = "Capture is not running.";
      this.push();
      return;
    }
    this.watchdog.troubleshoot();
    const upstream = this.route.customUpstream || "the model provider";
    this.output.appendLine(`[Watchdog] Troubleshoot connection requested. Traffic state: ${this.watchdog.getState()}. Requests: ${this.watchdog.getRequestCount()}. Uptime: ${this.watchdog.getUptimeSeconds()}s.`);

    if (this.currentEndpoint && this.project && this.helperKeySaved && this.helperModel.trim()) {
      await this.diagnoseConnection(this.project, {
        relativeFile: this.currentEndpoint.relativeFile,
        url: this.currentEndpoint.value,
        reason: `Capture was armed pointing to ${this.currentEndpoint.relativeFile}, but no messages arrived at port 47321 after ${this.watchdog.getUptimeSeconds()}s.`,
      });
      return;
    }

    if (this.project) {
      const fullSourcePath = this.currentEndpoint?.relativeFile ? resolveAddressFile(this.project.path, this.currentEndpoint.relativeFile) : undefined;
      const buildState = checkAndroidBuildState(this.project.path, fullSourcePath || undefined);
      if (buildState.isAndroidProject && buildState.isStale) {
        this.lastEvent = `Troubleshoot: ${buildState.summary}`;
        this.push();
        return;
      }
    }

    if (!this.helperKeySaved || !this.helperModel.trim()) {
      this.helperConnectOpen = true;
      this.helperStatus = "Connect an AI helper to diagnose why the app is bypassing capture.";
    }

    this.lastEvent = `Troubleshoot connection: watching for missed traffic. App may still be pointing directly to ${upstream}. Close and re-launch your app, or check your configuration.`;
    this.push();
  }

  private refreshFoundLabel(): void {
    if (!this.project || this.server) {
      return;
    }
    if (this.ignoredEndpoints.has(this.project.path)) {
      this.foundLabel = null;
      return;
    }
    const chosen = chooseEndpoint(findEndpoints(this.project.path)) ?? this.getSavedEndpoint(this.project.path);
    this.foundLabel = chosen ? endpointLabel(chosen) : null;
  }

  private async forgetAddress(): Promise<void> {
    if (!this.project) {
      return;
    }
    this.watchdog.stop();
    this.currentEndpoint = null;
    if (this.server) {
      const server = this.server;
      this.server = null;
      await server.close().catch(() => undefined);
    }
    await removeAndroidBridge().catch(() => undefined);
    this.activeAndroidBridge = false;
    this.restoreProjectRouting();
    const key = SAVED_ENDPOINT_PREFIX + projectKey(this.project.path);
    await this.context.globalState.update(key, undefined);
    this.ignoredEndpoints.add(this.project.path);
    this.foundLabel = null;
    this.addressOffer = null;
    this.helperNeeded = false;
    this.lastEvent = "Address disconnected. You can now use Start capture or Find address with AI helper.";
    this.refreshStatus();
    this.push();
  }

  private getSavedEndpoint(projectPath: string): FoundEndpoint | null {
    const key = SAVED_ENDPOINT_PREFIX + projectKey(projectPath);
    const saved = this.context.globalState.get<FoundEndpoint>(key);
    const candidate =
      saved && typeof saved === "object" && saved.filePath && saved.value
        ? saved
        : endpointFromRedirectBackup(this.redirectDir, projectPath);
    if (!candidate?.filePath || !candidate.value) {
      return null;
    }
    return locateEndpointInFile(projectPath, candidate);
  }

  private upstreamForCapture(endpoint: FoundEndpoint): string {
    if (!isCaptureUrl(endpoint.value)) {
      return endpoint.value;
    }
    const key = SAVED_ENDPOINT_PREFIX + projectKey(endpoint.projectPath);
    const saved = this.context.globalState.get<FoundEndpoint>(key);
    if (saved?.value && !isCaptureUrl(saved.value)) {
      return saved.value;
    }
    const backup = endpointFromRedirectBackup(this.redirectDir, endpoint.projectPath);
    if (backup?.value && !isCaptureUrl(backup.value)) {
      return backup.value;
    }
    const custom = this.route.customUpstream.trim();
    if (custom && !isCaptureUrl(custom)) {
      return custom;
    }
    return endpoint.value;
  }

  private restoreProjectRouting(): void {
    restoreAllRedirects(this.redirectDir);
    if (this.project) {
      restoreEnv(this.project.path, this.backupDir);
    }
  }

  private async reconcileInterruptedCapture(): Promise<void> {
    if (!this.project || this.server) {
      return;
    }
    let restored = false;
    if (hasRedirectBackup(this.redirectDir, this.project.path)) {
      const recovered = endpointFromRedirectBackup(this.redirectDir, this.project.path);
      if (recovered) {
        await this.saveConfirmedEndpoint(recovered);
      }
      restoreAllRedirects(this.redirectDir);
      restored = true;
    }
    if (restoreEnv(this.project.path, this.backupDir)) {
      restored = true;
    }
    if (envPointsAtCapturePort(this.project.path) && !restored) {
      this.lastEvent =
        "This project's .env still points at capture port 47321, but capture is off. Use Restore .env in the panel, or edit OPENAI_BASE_URL / ANTHROPIC_BASE_URL, then Start capture again.";
      return;
    }
    if (restored) {
      this.lastEvent =
        "Restored the project's model address after capture was interrupted. Click Start capture, restart your app, then send a prompt.";
      this.refreshFoundLabel();
    }
  }

  private async saveConfirmedEndpoint(endpoint: FoundEndpoint): Promise<void> {
    const key = SAVED_ENDPOINT_PREFIX + projectKey(endpoint.projectPath);
    await this.context.globalState.update(key, endpoint);
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

  private applyCachedAttributions(capture: StoredCapture): boolean {
    if (!this.projectAttributions.length || !capture.messages) {
      return false;
    }
    let changed = false;
    capture.reported = capture.reported ?? [];
    capture.messages.forEach((msg, idx) => {
      if (msg.role === "assistant") {
        return;
      }
      const alreadyAttributed = capture.reported.some(
        (s) => s.messageIndex === idx && s.source === "attributed",
      );
      if (alreadyAttributed) {
        return;
      }
      const match = matchCachedAttribution(msg.content, this.projectAttributions);
      if (match) {
        const matchedQuote = match.invariantPrefix && msg.content.includes(match.invariantPrefix)
          ? match.invariantPrefix
          : (match.cleanQuotes ?? []).find((q) => q && q.length >= 15 && msg.content.includes(q))
            ?? (match.cleanQuote && msg.content.includes(match.cleanQuote) ? match.cleanQuote : match.quote);

        capture.reported.push({
          messageIndex: idx,
          file: match.file,
          startLine: match.startLine,
          endLine: match.endLine,
          source: "attributed",
          confidence: match.confidence,
          explanation: match.explanation,
          quote: matchedQuote,
        });
        changed = true;
      }
    });
    return changed;
  }

  private async buildRunTrajectory(capture: StoredCapture): Promise<RunTrajectoryResult | null> {
    if (!capture.run || !this.project) {
      return null;
    }
    const runId = capture.run.runId;
    const projectCaptures = await this.store.list(this.project.path);
    const matchingSummaries = projectCaptures
      .filter((s) => s.run && s.run.runId === runId)
      .sort((a, b) => (a.run?.hopIndex ?? 0) - (b.run?.hopIndex ?? 0));

    if (matchingSummaries.length === 0) {
      return null;
    }

    const hops: RunTrajectoryHop[] = [];
    let initialTokens = 0;
    let currentTokens = 0;

    for (const sum of matchingSummaries) {
      const full = this.live.get(sum.id) ?? (await this.store.get(this.project.path, sum.id));
      const tokens = full
        ? full.messages.reduce((s, m) => s + estimateTokens(m.content), 0)
        : Math.round(sum.preview.length / 4);
      if (sum.run?.hopIndex === 0) {
        initialTokens = tokens;
      }
      if (sum.id === capture.id) {
        currentTokens = tokens;
      }
      hops.push({
        hopIndex: sum.run?.hopIndex ?? 0,
        captureId: sum.id,
        createdAt: sum.createdAt,
        model: sum.model,
        estimatedTokens: tokens,
        status: sum.status,
        loopRole: sum.run?.loopRole,
        toolCalls: sum.run?.toolCalls,
        replyPreview: full ? full.reply.slice(0, 150) : "",
        isCurrent: sum.id === capture.id,
      });
    }

    const delta = currentTokens - initialTokens;
    const growthPercent = initialTokens > 0 ? Math.round((delta / initialTokens) * 100) : 0;

    return {
      runId,
      totalHops: matchingSummaries.length,
      currentHop: capture.run.hopIndex + 1,
      triggeringUserQuery: capture.run.triggeringUserQuery,
      tokenGrowth: {
        initialTokens,
        currentTokens,
        deltaTokens: delta,
        growthPercent,
      },
      hops,
    };
  }

  private async accept(incoming: RecorderCapture): Promise<void> {
    if (!this.project) {
      return;
    }
    const pending = incoming.clientRequestId ? this.pendingSpans.get(incoming.clientRequestId) ?? [] : [];
    if (incoming.clientRequestId) {
      this.pendingSpans.delete(incoming.clientRequestId);
    }

    const captureId = crypto.randomUUID();
    const userMsg = extractTriggeringUserMessage(incoming.messages);
    const now = Date.now();
    const RUN_TIMEOUT_MS = 3 * 60 * 1000;
    const activeRun = this.activeRuns.get(this.project.path);
    let runId: string;
    let hopIndex: number;
    let prevCaptureId: string | null = null;
    const isExplicit = Boolean(incoming.explicitRunId);

    const isSameRun = isExplicit
      ? Boolean(activeRun && activeRun.runId === incoming.explicitRunId)
      : Boolean(
          activeRun &&
          activeRun.triggeringUserHash === userMsg.hash &&
          now - activeRun.lastCaptureTime < RUN_TIMEOUT_MS,
        );

    if (isSameRun && activeRun) {
      runId = activeRun.runId;
      hopIndex = activeRun.captureIds.length;
      prevCaptureId = activeRun.captureIds[hopIndex - 1] ?? null;
      activeRun.captureIds.push(captureId);
      activeRun.lastCaptureTime = now;
    } else {
      runId = incoming.explicitRunId || `run_${crypto.randomUUID().slice(0, 8)}`;
      hopIndex = 0;
      prevCaptureId = null;
      this.activeRuns.set(this.project.path, {
        runId,
        triggeringUserHash: userMsg.hash,
        triggeringUserQuery: userMsg.text.slice(0, 120),
        lastCaptureTime: now,
        captureIds: [captureId],
      });
    }

    const toolCalls = extractToolCalls(incoming.messages, incoming.reply);
    const currentActiveRun = this.activeRuns.get(this.project.path)!;
    const runInfo: RunHopInfo = {
      runId,
      hopIndex,
      hopCount: currentActiveRun.captureIds.length,
      prevCaptureId,
      nextCaptureId: null,
      triggeringUserQuery: currentActiveRun.triggeringUserQuery,
      loopRole: hopIndex === 0 ? "initial" : "tool_call",
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    const capture: StoredCapture = {
      id: captureId,
      run: runInfo,
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

    if (hopIndex > 0) {
      const totalHops = currentActiveRun.captureIds.length;
      for (let i = 0; i < currentActiveRun.captureIds.length - 1; i++) {
        const priorId = currentActiveRun.captureIds[i];
        const prior = this.live.get(priorId) ?? (await this.store.get(this.project.path, priorId));
        if (prior && prior.run) {
          prior.run.hopCount = totalHops;
          if (i === hopIndex - 1) {
            prior.run.nextCaptureId = capture.id;
          }
          this.live.set(prior.id, prior);
          await this.store.update(prior);
        }
      }
    }

    this.applyCachedAttributions(capture);
    this.live.set(capture.id, capture);
    this.watchdog.recordRequest();
    if (incoming.clientRequestId) {
      this.clientIds.set(incoming.clientRequestId, capture.id);
    }
    this.compare = null;
    this.compareId = null;
    this.activeScope = { kind: "global", label: "All Context" };
    this.selected = capture;
    this.selectedId = capture.id;
    const newConv = this.getConversation(capture.id);
    this.activePatch = newConv.activePatch ?? null;
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

  private enqueue<T = void>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.writes.set(id, next.then(() => {}, () => {}));
    return next;
  }

  private async selectCapture(id: string): Promise<void> {
    if (!this.project) {
      return;
    }
    this.selectedId = id;
    const capture = this.live.get(id) ?? (await this.store.get(this.project.path, id));
    if (capture) {
      const added = this.applyCachedAttributions(capture);
      this.live.set(id, capture);
      if (added) {
        await this.enqueue(capture.id, async () => {
          this.summaries = await this.store.update(capture);
        });
      }
    }
    this.selected = capture;
    if (capture) {
      this.activeScope = { kind: "global", label: "All Context" };
    } else {
      this.activeScope = undefined;
    }
    if (this.compareId === id) {
      this.compareId = null;
      this.compare = null;
    }
    const conv = await this.loadConversation(id);
    this.activePatch = conv.activePatch ?? null;
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
    this.applyCachedAttributions(capture);
    this.live.set(id, capture);
    this.compare = capture;
    this.compareId = capture.id;
    this.push();
  }

  private async deleteCapture(id: string): Promise<void> {
    if (!this.project) {
      return;
    }
    const activeRun = this.activeRuns.get(this.project.path);
    if (activeRun) {
      activeRun.captureIds = activeRun.captureIds.filter((cid) => cid !== id);
      if (activeRun.captureIds.length === 0) {
        this.activeRuns.delete(this.project.path);
      }
    }
    this.live.delete(id);
    this.writes.delete(id);
    this.conversations.delete(id);
    this.conversationWritePromises.delete(id);
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
      const newKey = this.currentConversationKey();
      const conv = await this.loadConversation(newKey);
      this.activePatch = conv.activePatch ?? null;
    }
    this.push();
  }

  private async clearCaptures(): Promise<void> {
    if (!this.project) {
      return;
    }
    this.activeRuns.delete(this.project.path);
    await this.store.clear(this.project.path);
    this.live.clear();
    this.conversations.clear();
    this.conversationWritePromises.clear();
    this.summaries = [];
    this.selected = null;
    this.selectedId = null;
    this.compare = null;
    this.compareId = null;
    this.activeScope = undefined;
    this.activePatch = null;
    this.lastEvent = "Cleared saved calls for this project. Model routing and capture connection were not changed — use Stop capture or Restore .env if the app still targets port 47321.";
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
      if (span?.canOpen && span.absolutePath && span.startLine && span.endLine && (isInside(this.project.path, span.absolutePath) || isHomeConfigPath(span.absolutePath))) {
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
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel("contextTracker.editor", "Context Tracker", vscode.ViewColumn.Active, {
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

  private collectPendingTemplatePatches(conversationKey?: string): TemplatePatchProposal[] {
    const key = conversationKey || this.currentConversationKey();
    const conv = this.getConversation(key);
    const pending: TemplatePatchProposal[] = [];
    const seen = new Set<string>();
    for (const act of conv.activity) {
      const patch = act.patch;
      if (!patch || act.patchApplied || this.appliedPatches.has(patch.patchId) || seen.has(patch.patchId)) {
        continue;
      }
      seen.add(patch.patchId);
      pending.push(patch);
    }
    pending.sort((a, b) => {
      const byFile = a.file.localeCompare(b.file);
      if (byFile !== 0) {
        return byFile;
      }
      return b.startLine - a.startLine;
    });
    return pending;
  }

  public async applyAllTemplatePatches(conversationKey?: string): Promise<void> {
    const pending = this.collectPendingTemplatePatches(conversationKey);
    if (pending.length === 0) {
      vscode.window.showInformationMessage("No pending template patches to apply.");
      return;
    }
    let applied = 0;
    let failed = 0;
    for (const patch of pending) {
      const ok = await this.applyTemplatePatch(undefined, patch);
      if (ok) {
        applied += 1;
      } else {
        failed += 1;
      }
    }
    if (applied > 0 && failed === 0) {
      vscode.window.showInformationMessage(
        applied === 1 ? "Applied 1 template patch." : `Applied ${applied} template patches.`,
      );
    } else if (applied > 0) {
      vscode.window.showWarningMessage(`Applied ${applied} patch(es); ${failed} could not be applied.`);
    } else {
      vscode.window.showErrorMessage("Could not apply the pending template patches.");
    }
  }

  public async applyTemplatePatch(patchId?: string, patchCandidate?: TemplatePatchProposal): Promise<boolean> {
    const patch = patchCandidate || (patchId ? this.knownPatches.get(patchId) : null) || this.activePatch;
    if (!patch || !this.project) {
      vscode.window.showWarningMessage("No active template patch to apply.");
      return false;
    }
    if (this.appliedPatches.has(patch.patchId)) {
      vscode.window.showInformationMessage(`Patch for ${patch.file} has already been applied.`);
      return true;
    }
    const fullPath = path.resolve(this.project.path, patch.file);
    if (!fs.existsSync(fullPath)) {
      vscode.window.showErrorMessage(`File '${patch.file}' was not found in project.`);
      return false;
    }
    try {
      const uri = vscode.Uri.file(fullPath);
      const document = await vscode.workspace.openTextDocument(uri);
      const fullText = document.getText();

      const validation = validateTemplatePatchContent(
        fullText,
        patch.startLine,
        patch.endLine,
        patch.originalCode,
        patch.replacementCode,
      );

      if (!validation.valid) {
        vscode.window.showErrorMessage(
          `Cannot apply patch to ${patch.file}: on-disk content at lines ${patch.startLine}-${patch.endLine} has changed since the patch was generated. Aborted to prevent race condition.`,
        );
        this.recordActivity({
          kind: "status",
          text: `Patch aborted for ${patch.file}:${patch.startLine}-${patch.endLine} (content changed on disk).`,
        });
        return false;
      }

      if (validation.alreadyApplied) {
        this.appliedPatches.add(patch.patchId);
        for (const conv of this.conversations.values()) {
          let updated = false;
          for (const act of conv.activity) {
            if (act.patch?.patchId === patch.patchId) {
              act.patchApplied = true;
              updated = true;
            }
          }
          if (conv.activePatch?.patchId === patch.patchId) {
            conv.activePatch = null;
            updated = true;
          }
          if (updated) {
            void this.saveConversationAsync(conv.id);
          }
        }
        if (this.activePatch?.patchId === patch.patchId) {
          this.activePatch = null;
        }
        this.recordActivity({
          kind: "status",
          text: `Patch for ${patch.file}:${patch.startLine}-${patch.endLine} is already applied on disk.`,
        });
        vscode.window.showInformationMessage(`Patch for ${patch.file} is already applied on disk.`);
        this.push();
        return true;
      }

      const effectiveStart = validation.resolvedStartLine || patch.startLine;
      const effectiveEnd = validation.resolvedEndLine || patch.endLine;
      const startLineIdx = Math.max(0, effectiveStart - 1);
      const endLineIdx = Math.max(startLineIdx, effectiveEnd - 1);
      const range = new vscode.Range(
        new vscode.Position(startLineIdx, 0),
        new vscode.Position(endLineIdx, document.lineAt(endLineIdx).text.length),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, range, patch.replacementCode);
      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        await document.save();
        patch.startLine = effectiveStart;
        patch.endLine = effectiveEnd;
        this.appliedPatches.add(patch.patchId);
        for (const conv of this.conversations.values()) {
          let updated = false;
          for (const act of conv.activity) {
            if (act.patch?.patchId === patch.patchId) {
              act.patchApplied = true;
              updated = true;
            }
          }
          if (conv.activePatch?.patchId === patch.patchId) {
            conv.activePatch = null;
            updated = true;
          }
          if (updated) {
            void this.saveConversationAsync(conv.id);
          }
        }
        if (this.activePatch?.patchId === patch.patchId) {
          this.activePatch = null;
        }
        this.recordActivity({
          kind: "status",
          text: `Applied patch to ${patch.file}:${patch.startLine}-${patch.endLine}.`,
        });
        vscode.window.showInformationMessage(`Applied patch to ${patch.file}`);
        this.push();
        return true;
      } else {
        vscode.window.showErrorMessage(`Failed to apply patch to ${patch.file}`);
        return false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Error applying patch: ${msg}`);
      return false;
    }
  }

  private async handleQuickAction(action: string, scope?: ContextScope): Promise<void> {
    if (scope) {
      this.activeScope = scope;
    }
    let query = "";
    switch (action) {
      case "detect_contradictions":
        query = buildDetectContradictionsPrompt(this.activeScope);
        break;
      case "optimize_context":
        query = buildOptimizeContextPrompt(this.activeScope);
        break;
      case "scan_pii":
        query = buildScanPiiPrompt(this.activeScope);
        break;
      case "explain_output":
        query = buildExplainOutputPrompt(this.selected?.reply);
        break;
      case "compare_captures":
        if (this.selected && this.compare) {
          const selectedTokens = this.selected.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
          const compareTokens = this.compare.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
          query = buildCompareCapturesPrompt(
            { id: this.selected.id, model: this.selected.model, totalTokens: selectedTokens },
            { id: this.compare.id, model: this.compare.model, totalTokens: compareTokens },
          );
        } else {
          query = "Compare prompt captures: select a second capture to compare with the active capture.";
        }
        break;
      default:
        query = action;
        break;
    }
    await this.handleHelperMessage(query);
  }

  private async handleHelperMessage(userText: string): Promise<void> {
    const query = userText.trim();
    if (!query) {
      return;
    }
    const targetKey = this.currentConversationKey();
    this.recordActivity({
      kind: "user",
      text: query,
    }, targetKey);

    if (!this.project) {
      this.recordActivity({
        kind: "status",
        text: "Load a project first to use the AI helper.",
      }, targetKey);
      return;
    }

    const apiKey = await this.context.secrets.get(HELPER_SECRET);
    if (!apiKey?.trim() || !this.helperModel) {
      this.helperConnectOpen = true;
      this.recordActivity({
        kind: "status",
        text: "Connect an AI helper and choose a Meta model first to interact with Meta AI.",
      }, targetKey);
      this.push();
      return;
    }

    if (this.helperBusy) {
      this.recordActivity({
        kind: "status",
        text: "The AI helper is currently busy with another operation.",
      }, targetKey);
      return;
    }

    const run = ++this.helperRun;
    this.helperBusy = true;
    this.helperStatus = "AI helper is thinking…";
    this.status.text = "$(loading~spin) AI helper thinking";
    this.status.show();
    this.push();

    try {
      const projectPath = this.project.path;
      const baseTools = addressTools(projectPath);
      const respondTool = {
        name: "respond",
        description: "Provide your final response, explanation, or advice directly to the user in clean Markdown.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Your final answer, explanation, or response to the user." },
          },
          required: ["message"],
        },
        run: (args: unknown) => {
          const msg = args && typeof args === "object" && "message" in args ? String((args as any).message) : "Done.";
          return {
            content: "Response delivered to user.",
            finish: { url: "", relativeFile: "", line: 0, reason: msg, explanation: msg },
          };
        },
      };

      const conv = await this.loadConversation(targetKey);
      const threadHistory = sanitizeMessagesForHelperApi(conv.messages || []);

      let chatTools: Array<any>;
      let systemPrompt: string;

      if (this.selected) {
        const compareSkeleton = this.compare ? buildContextSkeleton(this.compare) : undefined;
        const compareTokens = this.compare
          ? this.compare.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
          : undefined;

        const runTraj = this.selected.run ? await this.buildRunTrajectory(this.selected) : null;
        let runTrajectorySummary = "";
        if (runTraj && runTraj.totalHops > 1) {
          const hopLines = runTraj.hops.map((h) => {
            const role = h.loopRole || (h.hopIndex === 0 ? "initial" : "hop");
            const tools = h.toolCalls && h.toolCalls.length > 0 ? ` [Tools: ${h.toolCalls.join(", ")}]` : "";
            const currMarker = h.isCurrent ? " (Current View)" : "";
            return `- Hop ${h.hopIndex + 1}/${runTraj.totalHops}: ~${h.estimatedTokens} tokens (${role})${tools}${currMarker} -> Reply: "${h.replyPreview.replace(/\r?\n/g, " ").slice(0, 80)}"`;
          });
          runTrajectorySummary = [
            "Loop Progression:",
            ...hopLines,
            `Trajectory: Net token change from initial hop: ${runTraj.tokenGrowth.deltaTokens >= 0 ? "+" : ""}${runTraj.tokenGrowth.deltaTokens} tokens (${runTraj.tokenGrowth.growthPercent}% growth)`,
          ].join("\n");
        }

        const contextTools = createContextTools({
          capture: this.selected,
          compareCapture: this.compare || undefined,
          projectPath: this.project.path,
          attributions: this.projectAttributions,
          getRunTrajectory: runTraj ? () => runTraj : undefined,
          onPatchProposed: (patch) => {
            this.activePatch = patch;
            this.knownPatches.set(patch.patchId, patch);
            conv.activePatch = patch;
            this.recordActivity({
              kind: "finish",
              text: `Proposed template patch for ${patch.file}:${patch.startLine}-${patch.endLine} (${patch.tokenImpactEstimate || "optimized"})`,
              detail: patch.diffPreview,
              patch: patch,
              patchApplied: false,
            }, targetKey);
          },
        });
        chatTools = [
          ...contextTools,
          ...baseTools,
          respondTool,
        ];
        const skeleton = buildContextSkeleton(this.selected);
        const selectedTokens = this.selected.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
        systemPrompt = buildContextCopilotSystem({
          projectName: this.project.name,
          projectPath: this.project.path,
          captureId: this.selected.id,
          model: this.selected.model,
          provider: this.selected.provider,
          totalTokens: selectedTokens,
          scope: this.activeScope,
          contextSkeleton: skeleton,
          compareId: this.compare?.id,
          compareModel: this.compare?.model,
          compareTotalTokens: compareTokens,
          compareSkeleton: compareSkeleton,
          runInfo: this.selected.run,
          runTrajectorySummary,
        });
      } else {
        const standalonePatchTool = {
          name: "propose_template_patch",
          description:
            "Propose a concrete, actionable source code patch or diff for any file in the project workspace (including prompt templates, scripts, config, route handlers, components, or client code) to fix contradictions, implement features, reduce prompt bloat, or apply requested codebase modifications directly.",
          parameters: {
            type: "object",
            properties: {
              file: {
                type: "string",
                description: "Relative path to the workspace file being patched (e.g. 'electron/eidos/prompt-composer.js').",
              },
              startLine: {
                type: "number",
                description: "1-based start line of code being replaced.",
              },
              endLine: {
                type: "number",
                description: "1-based end line of code being replaced.",
              },
              originalCode: {
                type: "string",
                description: "Original code or prompt text being replaced.",
              },
              replacementCode: {
                type: "string",
                description: "New proposed code or replacement text.",
              },
              explanation: {
                type: "string",
                description: "Explanation of why this patch resolves the issue or implements the requested change.",
              },
              tokenImpactEstimate: {
                type: "string",
                description: "Estimated token impact (e.g. '-250 tokens', '+5 lines', 'optimized').",
              },
            },
            required: ["file", "startLine", "endLine", "originalCode", "replacementCode", "explanation"],
          },
          run: async (args: unknown) => {
            try {
              const a = (args && typeof args === "object" ? args : {}) as any;
              const patch = await proposeTemplatePatch({
                file: String(a.file || ""),
                startLine: Number(a.startLine || 1),
                endLine: Number(a.endLine || 1),
                originalCode: String(a.originalCode || ""),
                replacementCode: String(a.replacementCode || ""),
                explanation: String(a.explanation || ""),
                tokenImpactEstimate: a.tokenImpactEstimate ? String(a.tokenImpactEstimate) : undefined,
                projectPath: this.project?.path,
              });

              this.activePatch = patch;
              this.knownPatches.set(patch.patchId, patch);
              conv.activePatch = patch;
              this.recordActivity({
                kind: "finish",
                text: `Proposed template patch for ${patch.file}:${patch.startLine}-${patch.endLine} (${patch.tokenImpactEstimate || "optimized"})`,
                detail: patch.diffPreview,
                patch: patch,
                patchApplied: false,
              }, targetKey);

              return {
                content: `Template patch proposal created successfully for ${patch.file}:${patch.startLine}-${patch.endLine}.\n\nDiff preview:\n${patch.diffPreview}\n\nCRITICAL NEXT STEP: You must now explain to the user in conversational detail what was changed in their code, why, and summarize the changes. Deliver your final response via respond(). You may propose additional patches in parallel before calling respond().`,
              };
            } catch (err) {
              return { content: err instanceof Error ? err.message : String(err) };
            }
          },
        };

        chatTools = [
          standalonePatchTool,
          ...baseTools,
          respondTool,
        ];
        systemPrompt = [
          "You are Context Tracker's autonomous AI assistant powered by Meta AI models (Muse Spark 1.3 and Muse Wonder).",
          "You help developers understand, configure, and debug prompt capture, and directly modify or patch their project codebase.",
          `Current Project: ${this.project.name} (${this.project.path})`,
          "No prompt capture currently selected.",
          "",
          "You have access to sensory and modification tools for the developer's codebase and machine:",
          "- detect_local_services: Probes local ports (Ollama on 11434, LM Studio on 1234, vLLM on 8000, etc.)",
          "- find_user_config_dirs: Discovers user config directories (~/.config, ~/.<app>, %APPDATA%)",
          "- search_text: Searches codebase for literal or regex patterns",
          "- read_file: Reads project or user config files with line numbers",
          "- list_files: Lists directory contents",
          "- propose_address: Proposes an active model address to connect capture",
          "- propose_template_patch: Proposes a concrete, actionable source code diff patch to modify files in the project workspace",
          "- respond: Delivers your final answer or explanation to the user",
          "",
          "### CRITICAL CODE WRITING INSTRUCTION:",
          "Whenever the user asks you to add, write, modify, implement, or patch code in the project, or whenever you propose code changes, YOU MUST CALL `propose_template_patch` for EACH file being changed so an interactive diff card is created for the user to review and apply to their codebase with one click! DO NOT just output raw code blocks in `respond()` when code modifications are requested. Always call `propose_template_patch` first, then summarize in `respond()`.",
        ].join("\n");
      }

      const result = await runHarness({
        system: systemPrompt,
        user: query,
        history: threadHistory,
        tools: chatTools,
        stepCap: 10,
        allowDirectAnswer: true,
        complete: (messages, toolsList) =>
          completeChat({
            baseUrl: META_HELPER_BASE,
            apiKey,
            model: this.helperModel,
            messages,
            tools: toolsList,
          }),
        onTool: (name) => {
          if (run !== this.helperRun) return;
          const step = helperStepLabel(name);
          this.helperStatus = step;
          this.push();
        },
        onEvent: (event) => {
          if (run !== this.helperRun) return;
          if (event.kind === "thought") {
            this.recordActivity({ kind: "thought", text: event.text }, targetKey);
          } else if (event.kind === "tool_call") {
            this.recordActivity({
              kind: "tool_call",
              toolName: event.toolName,
              text: formatToolCall(event.toolName, event.args),
              detail: typeof event.args === "object" ? JSON.stringify(event.args, null, 2) : String(event.args),
            }, targetKey);
          } else if (event.kind === "tool_result") {
            this.recordActivity({
              kind: "tool_result",
              toolName: event.toolName,
              text: summarizeToolResult(event.toolName, event.content),
              detail: event.content,
            }, targetKey);
          }
        },
      });

      if (run !== this.helperRun) return;

      if (result.messages && result.messages.length > 0) {
        const nonSystem = result.messages.filter((m) => m.role !== "system");
        conv.messages = sanitizeMessagesForHelperApi(nonSystem).slice(-16);
      }

      if (result.finish) {
        const fin = result.finish as any;
        if (fin.patchId && fin.diffPreview) {
          const patch = fin as TemplatePatchProposal;
          this.activePatch = patch;
          this.knownPatches.set(patch.patchId, patch);
          conv.activePatch = patch;
          this.helperStatus = `Proposed patch for ${patch.file}:${patch.startLine}-${patch.endLine}.`;
          this.recordActivity({
            kind: "finish",
            text: `Proposed template patch for ${patch.file}:${patch.startLine}-${patch.endLine} (${patch.tokenImpactEstimate || "optimized"})`,
            detail: patch.diffPreview,
            patch: patch,
            patchApplied: false,
          }, targetKey);
          if (patch.explanation) {
            this.recordActivity({
              kind: "assistant",
              text: `### Proposed Template Patch\n\n${patch.explanation}\n\nYou can review the diff above and apply it with one click, or let me know if you would prefer a different approach.`,
            }, targetKey);
          }
        } else if (fin.url && fin.relativeFile) {
          this.addressOffer = fin as AddressOffer;
          this.helperStatus = "The AI helper found a model address. Confirm it to start capture.";
          this.recordActivity({
            kind: "finish",
            text: `Proposed address ${fin.url} in ${fin.relativeFile}:${fin.line}`,
            detail: fin.reason || fin.explanation,
          }, targetKey);
        } else if (fin.explanation || fin.reason || typeof fin === "string") {
          const reply = typeof fin === "string" ? fin : (fin.explanation || fin.reason);
          this.recordActivity({
            kind: "assistant",
            text: reply,
          }, targetKey);
          this.helperStatus = "AI helper finished.";
        }
      }
      conv.updatedAt = Date.now();
      await this.saveConversationAsync(targetKey);
    } catch (error) {
      if (run !== this.helperRun) return;
      this.helperStatus = error instanceof Error ? error.message : "AI helper communication failed.";
      this.recordActivity({
        kind: "status",
        text: this.helperStatus,
      }, targetKey);
    } finally {
      if (run === this.helperRun) {
        this.helperBusy = false;
        this.refreshStatus();
        this.push();
      }
    }
  }

  private buildState(): ViewState {
    const url = `http://127.0.0.1:${this.server?.port ?? CAPTURE_PORT}`;
    const bases = proposedBases(url);
    const selected = this.selected && this.project && path.resolve(this.selected.projectPath) === this.project.path
      ? presentCapture(deriveCapture(this.selected, this.index))
      : null;
    if (selected) {
      selected.activeScope = this.activeScope;
    }
    const compare = this.compare && this.project && path.resolve(this.compare.projectPath) === this.project.path
      ? presentCapture(deriveCapture(this.compare, this.index))
      : null;

    let mobile: AndroidViewInfo | undefined;
    if (this.project && isAndroidProject(this.project.path)) {
      const fullSource = this.currentEndpoint?.relativeFile ? resolveAddressFile(this.project.path, this.currentEndpoint.relativeFile) : undefined;
      const buildState = checkAndroidBuildState(this.project.path, fullSource || undefined);
      const security = inspectAndroidSecurity(this.project.path);
      mobile = {
        isAndroid: true,
        deviceLabel: this.activeAndroidDevice || undefined,
        bridged: this.activeAndroidBridge,
        cleartextPermitted: security.cleartextPermitted,
        securityRisk: security.risk,
        remediationSnippet: security.remediation,
        isStale: buildState.isStale,
        staleSummary: buildState.summary,
      };
    }

    const currentKey = this.currentConversationKey();
    const currentConv = this.getConversation(currentKey);
    const enrichedSummaries = this.summaries.map((summary) => {
      const conv = this.conversations.get(summary.id);
      const count = conv ? conv.activity.length : (summary.chatCount ?? 0);
      return count > 0 ? { ...summary, chatCount: count } : summary;
    });

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
        trafficState: this.watchdog.getState(),
        requestCount: this.watchdog.getRequestCount(),
        uptimeSeconds: this.watchdog.getUptimeSeconds(),
        missedHint: this.watchdog.getMissedHint(),
        mobile,
      },
      helper: {
        model: this.helperModel,
        choices: META_MODELS,
        keySaved: this.helperKeySaved,
        connectOpen: this.helperConnectOpen,
        needed: this.helperNeeded && !this.server,
        busy: this.helperBusy,
        status: this.helperStatus,
        offer: this.addressOffer,
        activity: currentConv.activity,
        activeScope: this.activeScope,
        activePatch: currentConv.activePatch ?? this.activePatch,
        threadCount: (currentConv.messages || []).length,
        conversationId: currentKey,
      },
      env: this.project ? readEnvStatus(this.project.path, url, this.backupDir) : null,
      captures: enrichedSummaries,
      selectedId: selected ? this.selectedId : null,
      selected,
      compareId: compare ? this.compareId : null,
      compare,
    };
  }

  private push(): void {
    let state: ViewState;
    try {
      state = this.buildState();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Context Tracker failed to build panel state.";
      this.output.appendLine(`[UI] ${message}`);
      this.lastEvent = "The panel could not refresh. Open the log for details.";
      const errKey = this.currentConversationKey();
      state = {
        project: this.project,
        recorder: {
          running: Boolean(this.server),
          url: `http://127.0.0.1:${this.server?.port ?? CAPTURE_PORT}`,
          openaiBase: null,
          anthropicBase: null,
          mode: this.route.mode,
          customUpstream: this.route.customUpstream,
          error: this.recorderError,
          lastEvent: this.lastEvent,
          found: this.foundLabel,
          trafficState: this.watchdog.getState(),
          requestCount: this.watchdog.getRequestCount(),
          uptimeSeconds: this.watchdog.getUptimeSeconds(),
          missedHint: this.watchdog.getMissedHint(),
        },
        helper: {
          model: this.helperModel,
          choices: META_MODELS,
          keySaved: this.helperKeySaved,
          connectOpen: this.helperConnectOpen,
          needed: this.helperNeeded && !this.server,
          busy: this.helperBusy,
          status: this.helperStatus,
          offer: this.addressOffer,
          activity: this.getConversation(errKey).activity,
          activeScope: this.activeScope,
          activePatch: this.activePatch,
          threadCount: 0,
          conversationId: errKey,
        },
        env: null,
        captures: this.summaries,
        selectedId: null,
        selected: null,
        compareId: null,
        compare: null,
      };
    }
    for (const webview of this.views) {
      void webview.postMessage({ type: "state", state });
    }
  }
}

function helperStepLabel(name: string): string {
  if (name === "list_files") {
    return "The AI helper is listing project files to find the model address.";
  }
  if (name === "search_text") {
    return "The AI helper is searching the project for the model address.";
  }
  if (name === "read_file") {
    return "The AI helper is reading a project file to find the model address.";
  }
  if (name === "find_user_config_dirs") {
    return "The AI helper is searching user configuration directories for active settings.";
  }
  if (name === "detect_local_services") {
    return "The AI helper is detecting active local AI services.";
  }
  if (name === "detect_android_environment") {
    return "The AI helper is probing for connected Android devices or emulators.";
  }
  if (name === "bridge_android_device") {
    return "The AI helper is bridging Android device port 47321 via ADB.";
  }
  if (name === "inspect_android_security") {
    return "The AI helper is inspecting Android network security policy.";
  }
  if (name === "propose_address") {
    return "The AI helper is checking a model address it found.";
  }
  if (name === "attribute_prompt") {
    return "The AI helper is attributing prompt text to project source code.";
  }
  if (name === "analyze_telemetry") {
    return "The AI helper is analyzing prompt context anatomy and token budget.";
  }
  if (name === "search_context") {
    return "The AI helper is searching across prompt context sections.";
  }
  if (name === "read_context_section") {
    return "The AI helper is reading verbatim lines from a context section.";
  }
  if (name === "inspect_code_template") {
    return "The AI helper is inspecting the source code template for this section.";
  }
  if (name === "propose_template_patch") {
    return "The AI helper is preparing a template patch proposal.";
  }
  if (name === "respond") {
    return "The AI helper is formulating its response.";
  }
  return "The AI helper is connecting this project to capture.";
}

function formatToolCall(name: string, args: unknown): string {
  if (typeof args !== "object" || args === null) {
    return `${name}()`;
  }
  const record = args as Record<string, unknown>;
  if (name === "search_text") {
    const q = record.query || (Array.isArray(record.queries) ? record.queries.join(", ") : "");
    return `search_text("${q}")`;
  }
  if (name === "read_file") {
    return `read_file("${record.path || ""}")`;
  }
  if (name === "list_files") {
    return `list_files("${record.path || "."}")`;
  }
  if (name === "find_user_config_dirs") {
    const hints = Array.isArray(record.app_hints) ? record.app_hints.join(", ") : "";
    return `find_user_config_dirs([${hints}])`;
  }
  if (name === "detect_local_services") {
    return "detect_local_services()";
  }
  if (name === "detect_android_environment") {
    return "detect_android_environment()";
  }
  if (name === "bridge_android_device") {
    const dev = record.deviceSerial ? `"${record.deviceSerial}", ` : "";
    return `bridge_android_device(${dev}${record.devicePort || 47321})`;
  }
  if (name === "inspect_android_security") {
    return `inspect_android_security("${record.manifestPath || ""}")`;
  }
  if (name === "propose_address") {
    return `propose_address("${record.file || ""}", "${record.url || ""}")`;
  }
  if (name === "attribute_prompt") {
    return `attribute_prompt("${record.file || ""}:${record.startLine || 1}–${record.endLine || 1}")`;
  }
  if (name === "search_context") {
    const q = record.query || "";
    const sec = record.sectionId ? ` in ${record.sectionId}` : "";
    return `search_context("${q}"${sec})`;
  }
  if (name === "read_context_section") {
    return `read_context_section("${record.sectionId || ""}", L${record.startLine || 1}–${record.maxLines || 100})`;
  }
  if (name === "inspect_code_template") {
    return `inspect_code_template("${record.sectionId || ""}")`;
  }
  if (name === "propose_template_patch") {
    return `propose_template_patch("${record.file || ""}:${record.startLine || 1}–${record.endLine || 1}")`;
  }
  if (name === "respond") {
    return "respond()";
  }
  return `${name}(${JSON.stringify(args)})`;
}

function summarizeToolResult(name: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "No output";
  }
  const lines = trimmed.split("\n");
  if (lines.length === 1 && lines[0].length <= 140) {
    return lines[0];
  }
  const firstLine = lines[0].slice(0, 140);
  return `${firstLine}${lines.length > 1 ? ` (${lines.length} lines)` : ""}`;
}
