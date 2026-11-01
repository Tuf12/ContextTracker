import type { TrafficState } from "./types";

/** How long capture can run with zero requests before a passive “still waiting” hint. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 120;
/** Min capture uptime before panel activity can trigger a bypass warning. */
export const DEFAULT_ACTIVITY_IDLE_SECONDS = 45;

export interface WatchdogOptions {
  upstream?: string;
  idleTimeoutSeconds?: number;
  activityIdleSeconds?: number;
  onStateChange?: (state: TrafficState, hint: string | null) => void;
}

export class TrafficWatchdog {
  private state: TrafficState = "off";
  private requestCount = 0;
  private startedAt: number | null = null;
  private missedHint: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private upstream: string;
  private idleTimeoutSeconds: number;
  private activityIdleSeconds: number;
  private onStateChange?: (state: TrafficState, hint: string | null) => void;
  private projectContext?: { isAndroid?: boolean; isStale?: boolean };

  constructor(options?: WatchdogOptions) {
    this.upstream = options?.upstream || "upstream";
    this.idleTimeoutSeconds = options?.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
    this.activityIdleSeconds = options?.activityIdleSeconds ?? DEFAULT_ACTIVITY_IDLE_SECONDS;
    this.onStateChange = options?.onStateChange;
  }

  setUpstream(upstream: string): void {
    this.upstream = upstream;
  }

  setProjectContext(context?: { isAndroid?: boolean; isStale?: boolean }): void {
    this.projectContext = context;
  }

  start(now = Date.now()): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state = "listening";
    this.requestCount = 0;
    this.startedAt = now;
    this.missedHint = null;
    this.notify();
    this.startTimer();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state = "off";
    this.requestCount = 0;
    this.startedAt = null;
    this.missedHint = null;
    this.notify();
  }

  recordRequest(): void {
    this.requestCount += 1;
    this.state = "active";
    this.missedHint = null;
    this.notify();
  }

  recordUserActivity(now = Date.now()): boolean {
    if (this.state === "listening" && this.requestCount === 0 && this.startedAt) {
      const elapsed = (now - this.startedAt) / 1000;
      if (elapsed >= this.activityIdleSeconds) {
        this.transitionToIdle(elapsed, "activity");
        return true;
      }
    }
    return false;
  }

  troubleshoot(now = Date.now()): void {
    if (this.state === "off") {
      return;
    }
    const elapsed = this.getUptimeSeconds(now);
    this.transitionToIdle(elapsed, "manual");
  }

  checkIdle(now = Date.now()): boolean {
    if (this.state === "listening" && this.requestCount === 0 && this.startedAt) {
      const elapsed = (now - this.startedAt) / 1000;
      if (elapsed >= this.idleTimeoutSeconds) {
        this.transitionToIdle(elapsed, "silence");
        return true;
      }
    }
    return false;
  }

  private transitionToIdle(elapsed: number, trigger: "silence" | "activity" | "manual"): void {
    this.state = "listening_idle";
    const sec = Math.floor(elapsed);
    if (this.projectContext?.isAndroid) {
      if (this.projectContext.isStale) {
        this.missedHint = `No requests on port 47321 after ${sec}s. Your Android APK may be older than the redirected source file. Re-run or rebuild in Android Studio.`;
      } else {
        this.missedHint = `No requests on port 47321 after ${sec}s. For physical Android devices or emulators, ensure port 47321 is bridged via ADB. Click Troubleshoot Connection.`;
      }
    } else if (trigger === "silence") {
      this.missedHint = `Still no requests on port 47321 after ${sec}s. Launch your app and send a prompt; if traffic still does not appear, use Troubleshoot Connection.`;
    } else {
      this.missedHint = `No prompts arrived after ${sec}s. If your app sent messages that didn't appear, it may still be pointing directly to ${this.upstream} instead of port 47321.`;
    }
    this.notify();
  }

  getUptimeSeconds(now = Date.now()): number {
    if (!this.startedAt) {
      return 0;
    }
    return Math.max(0, Math.floor((now - this.startedAt) / 1000));
  }

  getState(): TrafficState {
    return this.state;
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  getMissedHint(): string | null {
    return this.missedHint;
  }

  private notify(): void {
    this.onStateChange?.(this.state, this.missedHint);
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.checkIdle();
    }, 1000);
    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }
}
