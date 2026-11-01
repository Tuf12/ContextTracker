import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as vscode from "vscode";
import { deriveCapture, presentCapture } from "./derive";
import { ANTHROPIC_ENV, applyEnv, OPENAI_ENV, proposedBases, readEnvStatus, restoreEnv } from "./env";
import { completeChat, listHelperModels, META_HELPER_BASE, META_MODELS } from "./helperClient";
import { ADDRESS_SYSTEM, addressTools, ATTRIBUTION_SYSTEM, attributionTools, buildAttributionUserPrompt, buildDiagnosticUserPrompt, buildHelperUserPrompt } from "./helperTools";
import { runHarness } from "./harness";
import { panelHtml } from "./html";
import { indexProject } from "./indexer";
import { isHomeConfigPath, isInside, projectKey, resolveAddressFile, resolveProjectFile } from "./paths";
import { CAPTURE_PORT, chooseUpstream, startRecorder, type RecorderCapture, type RecorderServer } from "./recorder";
import { armRedirect, chooseEndpoint, endpointLabel, findEndpoints, planRewrite, restoreAllRedirects, type FoundEndpoint } from "./redirect";
import { CaptureStore, extractCleanQuote, hashPromptText, matchCachedAttribution } from "./store";
import {
  applyTelemetryResponse,
  buildDeterministicTelemetry,
  buildTelemetrySkeleton,
  extractContextSections,
  globalTelemetryCache,
  parseTelemetryResponse,
  TELEMETRY_SYSTEM,
} from "./telemetry";
import type { AddressOffer, AttributedSpan, CachedAttribution, CaptureTelemetry, HelperActivityItem, HelperActivityKind, ProjectIndex, ProjectView, ReportedSpan, RouteSettings, StoredCapture, ViewState } from "./types";
import { TrafficWatchdog } from "./watchdog";

const PROJECT_KEY = "contextTracker.projectPath";
const ROUTE_KEY = "contextTracker.route";
const HELPER_MODEL = "contextTracker.helperModel";
const HELPER_SECRET = "contextTracker.helperApiKey";
const SAVED_ENDPOINT_PREFIX = "contextTracker.savedEndpoint.";

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
  private helperRun = 0;
  private helperActivity: HelperActivityItem[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  private recordActivity(item: {
    kind: HelperActivityKind;
    text: string;
    toolName?: string;
    detail?: string;
  }): void {
    const entry: HelperActivityItem = {
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      kind: item.kind,
      text: item.text,
      toolName: item.toolName,
      detail: item.detail,
    };
    this.helperActivity.push(entry);
    if (this.helperActivity.length > 100) {
      this.helperActivity.splice(0, this.helperActivity.length - 100);
    }
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
      case "showLog":
        this.output.show(true);
        return;
      case "openBeside":
        this.openBeside();
        return;
      case "helperMessage":
        await this.handleHelperMessage(typeof body.text === "string" ? body.text : "");
        return;
      case "clearHelperActivity":
        this.helperActivity = [];
        this.push();
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
    this.helperNeeded = false;
    this.addressOffer = null;
    this.helperRun += 1;
    this.helperBusy = false;
    this.ignoredEndpoints.delete(resolved);
    this.projectAttributions = await this.store.seedAttributionsFromCaptures(resolved);
    this.summaries = await this.store.list(resolved);
    if (this.summaries.length > 0 && !this.selectedId) {
      this.selectedId = this.summaries[0].id;
      const topCapture = await this.store.get(resolved, this.selectedId);
      if (topCapture) {
        this.applyCachedAttributions(topCapture);
        this.live.set(topCapture.id, topCapture);
        this.selected = topCapture;
      }
    }
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
    this.helperNeeded = false;
    this.addressOffer = null;
    this.foundLabel = endpointLabel(chosen);
    this.currentEndpoint = chosen;
    this.watchdog.setUpstream(plan.upstream);
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
    });
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
            this.recordActivity({ kind: "thought", text: event.text });
          } else if (event.kind === "tool_call") {
            this.recordActivity({
              kind: "tool_call",
              toolName: event.toolName,
              text: formatToolCall(event.toolName, event.args),
              detail: typeof event.args === "object" ? JSON.stringify(event.args, null, 2) : String(event.args),
            });
          } else if (event.kind === "tool_result") {
            this.recordActivity({
              kind: "tool_result",
              toolName: event.toolName,
              text: summarizeToolResult(event.toolName, event.content),
              detail: event.content,
            });
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
        });
      } else {
        this.addressOffer = result.finish;
        this.helperStatus = "The AI helper found a model address. Confirm it above to start capture.";
        this.lastEvent = this.helperStatus;
        this.recordActivity({
          kind: "finish",
          text: `Found model address ${this.addressOffer.url} in ${this.addressOffer.relativeFile}:${this.addressOffer.line}`,
          detail: this.addressOffer.reason,
        });
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
      });
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
    restoreAllRedirects(this.redirectDir);
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
    });
    this.push();

    try {
      const userPrompt = buildDiagnosticUserPrompt({
        failedFile: failedEndpoint.relativeFile,
        failedUrl: failedEndpoint.url,
        reason: failedEndpoint.reason || "Outbound prompts bypassed recorder port 47321.",
        projectName: project.name,
        clues: project.clues,
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
            this.recordActivity({ kind: "thought", text: event.text });
          } else if (event.kind === "tool_call") {
            this.recordActivity({
              kind: "tool_call",
              toolName: event.toolName,
              text: formatToolCall(event.toolName, event.args),
              detail: typeof event.args === "object" ? JSON.stringify(event.args, null, 2) : String(event.args),
            });
          } else if (event.kind === "tool_result") {
            this.recordActivity({
              kind: "tool_result",
              toolName: event.toolName,
              text: summarizeToolResult(event.toolName, event.content),
              detail: event.content,
            });
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
        });
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
      });
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
      });
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
    });
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
            this.recordActivity({ kind: "thought", text: event.text });
          } else if (event.kind === "tool_call") {
            this.recordActivity({
              kind: "tool_call",
              toolName: event.toolName,
              text: formatToolCall(event.toolName, event.args),
              detail: typeof event.args === "object" ? JSON.stringify(event.args, null, 2) : String(event.args),
            });
          } else if (event.kind === "tool_result") {
            this.recordActivity({
              kind: "tool_result",
              toolName: event.toolName,
              text: summarizeToolResult(event.toolName, event.content),
              detail: event.content,
            });
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
        });
        return null;
      }

      const attributed = result.finish;
      const cleanQuote = extractCleanQuote(attributed.matchedSnippet);
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

      capture.reported = (capture.reported ?? [])
        .filter((span) => !(span.messageIndex === messageIndex && span.source === "attributed"))
        .concat(reportedSpan);

      const cachedAttr: CachedAttribution = {
        fingerprint: hashPromptText(targetContent),
        quote: attributed.matchedSnippet,
        cleanQuote: cleanQuote ?? undefined,
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
      });
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
      });
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

    const novelSections = sections.filter((s) => !globalTelemetryCache.has(s.fingerprint));
    const apiKey = await this.context.secrets.get(HELPER_SECRET);
    const hasHelper = Boolean(apiKey?.trim() && this.helperModel.trim());

    if (novelSections.length === 0 || !hasHelper) {
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
      });
      this.push();
      return telemetry;
    }

    const run = ++this.helperRun;
    const working = `The AI helper is analyzing context telemetry for ${novelSections.length} novel section${novelSections.length > 1 ? "s" : ""} (${totalTokens} estimated tokens)…`;
    this.helperBusy = true;
    this.helperStatus = working;
    this.lastEvent = working;
    this.status.text = "$(loading~spin) Analyzing context telemetry";
    this.status.tooltip = working;
    this.status.show();
    this.recordActivity({
      kind: "status",
      text: working,
    });
    this.push();

    try {
      const skeletonJson = buildTelemetrySkeleton(novelSections);
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
      });
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
      });
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
    restoreAllRedirects(this.redirectDir);
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
    if (!saved || typeof saved !== "object" || !saved.filePath || !saved.value) {
      return null;
    }
    const filePath = resolveAddressFile(projectPath, saved.filePath);
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const idx = lines.findIndex((line) => line.includes(saved.value));
      if (idx < 0) {
        return null;
      }
      return {
        ...saved,
        filePath,
        line: idx + 1,
      };
    } catch {
      return null;
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
        capture.reported.push({
          messageIndex: idx,
          file: match.file,
          startLine: match.startLine,
          endLine: match.endLine,
          source: "attributed",
          confidence: match.confidence,
          explanation: match.explanation,
          quote: match.cleanQuote || match.quote,
        });
        changed = true;
      }
    });
    return changed;
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
    this.applyCachedAttributions(capture);
    this.live.set(capture.id, capture);
    this.watchdog.recordRequest();
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

  private async handleHelperMessage(userText: string): Promise<void> {
    const query = userText.trim();
    if (!query) {
      return;
    }
    this.recordActivity({
      kind: "user",
      text: query,
    });

    if (!this.project) {
      this.recordActivity({
        kind: "status",
        text: "Load a project first to use the AI helper.",
      });
      return;
    }

    const apiKey = await this.context.secrets.get(HELPER_SECRET);
    if (!apiKey?.trim() || !this.helperModel) {
      this.helperConnectOpen = true;
      this.recordActivity({
        kind: "status",
        text: "Connect an AI helper and choose a Meta model first to interact with Meta AI.",
      });
      this.push();
      return;
    }

    if (this.helperBusy) {
      this.recordActivity({
        kind: "status",
        text: "The AI helper is currently busy with another operation.",
      });
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
      const chatTools = [
        ...baseTools,
        {
          name: "respond",
          description: "Provide your final response or explanation to the user.",
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
        },
      ];

      const systemPrompt = [
        "You are Context Tracker's autonomous AI assistant powered by Meta AI models (Muse Spark 1.3 and Muse Wonder).",
        "You help developers understand, configure, and debug prompt capture and their LLM client code.",
        `Current Project: ${this.project.name} (${this.project.path})`,
        this.selected
          ? `Currently Selected Prompt Capture: model=${this.selected.model}, provider=${this.selected.provider}, upstream=${this.selected.upstream}`
          : "No prompt capture currently selected.",
        "",
        "You have access to sensory tools to inspect the developer's codebase and machine:",
        "- detect_local_services: Probes local ports (Ollama on 11434, LM Studio on 1234, vLLM on 8000, etc.)",
        "- find_user_config_dirs: Discovers user config directories (~/.config, ~/.<app>, %APPDATA%)",
        "- search_text: Searches codebase for literal or regex patterns",
        "- read_file: Reads project or user config files",
        "- list_files: Lists directory contents",
        "- propose_address: Proposes an active model address to connect capture",
        "- respond: Delivers your final answer or explanation to the user",
        "",
        "Answer the user concisely and directly. If the user asks you to find an address, search code, or check ports, call the sensory tools first, then deliver your response using respond (or propose_address if proposing a connection).",
      ].join("\n");

      const result = await runHarness({
        system: systemPrompt,
        user: query,
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
            this.recordActivity({ kind: "thought", text: event.text });
          } else if (event.kind === "tool_call") {
            this.recordActivity({
              kind: "tool_call",
              toolName: event.toolName,
              text: formatToolCall(event.toolName, event.args),
              detail: typeof event.args === "object" ? JSON.stringify(event.args, null, 2) : String(event.args),
            });
          } else if (event.kind === "tool_result") {
            this.recordActivity({
              kind: "tool_result",
              toolName: event.toolName,
              text: summarizeToolResult(event.toolName, event.content),
              detail: event.content,
            });
          }
        },
      });

      if (run !== this.helperRun) return;

      if (result.finish) {
        if (result.finish.url && result.finish.relativeFile) {
          this.addressOffer = result.finish;
          this.helperStatus = "The AI helper found a model address. Confirm it to start capture.";
          this.recordActivity({
            kind: "finish",
            text: `Proposed address ${result.finish.url} in ${result.finish.relativeFile}:${result.finish.line}`,
            detail: result.finish.reason || result.finish.explanation,
          });
        } else if (result.finish.explanation || result.finish.reason) {
          const reply = result.finish.explanation || result.finish.reason;
          this.recordActivity({
            kind: "thought",
            text: reply,
          });
          this.helperStatus = "AI helper finished.";
        }
      }
    } catch (error) {
      if (run !== this.helperRun) return;
      this.helperStatus = error instanceof Error ? error.message : "AI helper communication failed.";
      this.recordActivity({
        kind: "status",
        text: this.helperStatus,
      });
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
        activity: this.helperActivity,
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
  if (name === "propose_address") {
    return "The AI helper is checking a model address it found.";
  }
  if (name === "attribute_prompt") {
    return "The AI helper is attributing prompt text to project source code.";
  }
  if (name === "analyze_telemetry") {
    return "The AI helper is analyzing prompt context anatomy and token budget.";
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
  if (name === "propose_address") {
    return `propose_address("${record.file || ""}", "${record.url || ""}")`;
  }
  if (name === "attribute_prompt") {
    return `attribute_prompt("${record.file || ""}:${record.startLine || 1}–${record.endLine || 1}")`;
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
