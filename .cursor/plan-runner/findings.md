# Plan run findings

- Plan path: SPEC.md
- Started: Saturday, Oct 31, 2026, 12:55 PM (UTC-5)

## Phase 1: Phase 1: Environment Grounding Tools

### Discrepancies

- **1.1 socket/HTTP probe:** SPEC Phase 1.1 calls for a “socket/HTTP probe,” but `detectLocalServices` / `probePort` only open a TCP connection to `127.0.0.1` on the four standard ports. There is no HTTP request (e.g. to the URLs listed in SPEC §2.5), so any process listening on those ports is reported as that service.
- **1.2 `~/.<name>` coverage in tests:** `findUserConfigDirs` checks `~/.<hint>` directories (and related dotfile patterns), but unit tests only exercise `~/.config/<app>` and a fake `%APPDATA%` tree—not a standalone `~/.<name>/` config directory called out in the plan.
- **Scope beyond Phase 1:** The same working-tree diff that adds the grounding tools also includes Phase 2–oriented changes (expanded `ADDRESS_SYSTEM`, `search_text` regex/multi-query, `buildHelperUserPrompt`, `detectSourceConfigFile`), UI/flow work (`forgetAddress`, “Find address with AI helper”), and other edits (`indexer.ts`, `paths.ts`, `redirect.ts`). Phase 1 deliverables are present, but they are not isolated to this phase in the diff.
- **Minor:** `isHomeConfigPath` is imported in `src/helperTools.ts` but unused (path-safety tests live in `test/helper.test.cjs` against `paths.ts`).

### User checks (deferred)

- None.

## Phase 2: Phase 2: Autonomous Architecture Analysis Prompting

### Discrepancies

- **2.3 verification vs live Meta model:** Phase 2.3 calls for testing helper runs on test repositories with single-turn resolution. The added tests (`helper runs on test repository with single-turn resolution`, `helper discovers architecture and resolves active user config in 2 turns`) drive `runHarness` with a mocked `complete` callback that simulates Muse parallel tool use—they do not exercise the real Meta helper client or Muse Spark / Wonder endpoints.
- **2.3 “single-turn” vs two-turn test:** The plan’s verification bullet emphasizes single-turn resolution, but the suite also adds an explicit 2-turn scenario test. That aligns with the spec success metric (≤ 2 turns) but is broader than the Phase 2.3 wording alone.
- **Prompt-only vs TypeScript heuristics:** Phase 2’s objective is to upgrade the system prompt and reasoning flow so the model classifies architecture instead of blind string matching. `detectSourceConfigFile` plus the `proposeAddress` guard use regex/heuristics on `.js`/`.ts`/`.py` sources to reject Type D proposals and redirect to user config files—overlapping the runtime-precedence rule in the prompt and echoing the anti-pattern the spec warns about in §1.2.
- **“Startup sequences” wording:** Plan 2.1 says to query sensory tools when analyzing startup sequences. `ADDRESS_SYSTEM` instructs calling `detect_local_services` and `find_user_config_dirs` for local endpoints and external configs but does not mention startup or boot sequences explicitly.
- **`buildHelperUserPrompt` project path:** `app.ts` passes `{ name, path }`, but the builder only emits `Project name:`—`path` is unused in the user prompt.
- **Scope beyond Phase 2:** The same diff bundles UI/flow work (`forgetAddress`, “Find address with AI helper”, `ignoredEndpoints`), expanded indexer clues/redaction, `expandHomeDir` / home-config path fixes, and redirect label tweaks—supporting the helper UX but not listed under Phase 2 deliverables.
- **Minor:** `isHomeConfigPath` remains imported in `src/helperTools.ts` but unused.

### User checks (deferred)

- None.

## Phase 3: Phase 3: Traffic Watchdog & Missed Connection Detection

### Discrepancies

- **3.1 idle triggers beyond “user activity”:** Phase 3.1 only describes transitioning to `listening_idle` when capture is active but zero requests arrive **after user activity**. `TrafficWatchdog` also transitions on a fixed **12s silence** timer (`checkIdle` via `setInterval`) with no user activity required. That matches SPEC §3 Loop 3 (“extension observes”) but is broader than the Phase 3.1 bullet alone.
- **3.1 “user activity” = webview traffic:** `app.ts` calls `watchdog.recordUserActivity()` on **every** panel message (including `ready` and routine UI clicks), not on signals from the target app or an explicit “prompt was sent” event. Idle-after-activity can fire from interacting with Context Tracker’s panel after ~5s (`activityIdleSeconds`), not necessarily from using the connected app.
- **3.1 uptime display not live:** Request count and uptime since capture start are implemented (`getRequestCount`, `getUptimeSeconds`, shown in `trafficSummary`), but the watchdog timer only runs `checkIdle()`; it does not refresh the webview each second. Uptime in the Capture card updates only when something else calls `push()` (state change, capture, panel message), not as a continuous heartbeat in the UI.
- **3.2 troubleshoot hint upstream mismatch:** `missedHint` uses the watchdog’s `plan.upstream` (set at capture start). `troubleshootConnection`’s `lastEvent` uses `this.route.customUpstream || "the model provider"`, which can disagree with the actual routed upstream in **auto** mode.
- **Troubleshoot vs full SPEC troubleshoot loop:** SPEC §3 Loop 3 describes **Troubleshoot Connection** (or autonomous watchdog) leading to Meta AI **diagnostic re-engagement**. Phase 3 deliverables are the button and upstream bypass hint only; the handler sets idle/hint and logs—it does **not** start the Phase 4 diagnostic harness. Correct phase boundary, but the end-to-end SPEC troubleshoot flow is not complete until Phase 4.
- **Scope beyond Phase 3:** The same working-tree diff bundles non–Phase 3 UX (`forgetAddress`, “Find address with AI helper”, helper-card find button, warning banner CSS) plus earlier-phase helper/index/redirect changes alongside `src/watchdog.ts` and `test/watchdog.test.cjs`.

### User checks (deferred)

- None.

## Phase 4: Phase 4: Autonomous Self-Healing Diagnostic Loop

### Discrepancies

- **Autonomous watchdog → diagnostic harness:** SPEC §2 Loop 3 and the phase title imply self-healing when capture misses traffic (user **Troubleshoot Connection** *or* an autonomous watchdog). `TrafficWatchdog` idle transitions only set `listening_idle` / `missedHint` and `onStateChange` triggers `push()`—they never call `diagnoseConnection`. The Meta diagnostic loop runs only after an explicit **Troubleshoot Connection** click, and only when `currentEndpoint`, `project`, and a saved helper model/key are all present.
- **4.1 “Diagnostic Harness Mode” vs reuse:** The plan names a distinct diagnostic harness mode; implementation reuses the same `runHarness` + `ADDRESS_SYSTEM` as initial discovery, differing only via `buildDiagnosticUserPrompt`, `addressTools(..., { failedFile, failedUrl })`, and the `proposeAddress` re-proposal guard—not a separate system prompt or harness mode.
- **4.3 tests vs `diagnoseConnection` wiring:** Phase 4.3 adds harness-level tests (`buildDiagnosticUserPrompt`, failed-file rejection, pivot fixture with mocked `complete`) but no test imports or exercises `AppController.diagnoseConnection`, `troubleshootConnection` → diagnose, or UI `confirmAddress` after a diagnostic offer.
- **4.3 verification vs live Meta model:** Like Phase 2.3, pivot tests simulate Muse tool turns with a mocked `complete` callback; they do not hit the real Meta helper client or Muse Spark / Wonder endpoints.
- **Troubleshoot without helper:** If the user clicks **Troubleshoot Connection** without a connected helper (or without `currentEndpoint`), the flow falls back to watchdog idle state and a manual upstream hint—no queued diagnostic run when the helper is connected later.
- **Scope beyond Phase 4:** The same working-tree diff still bundles Phase 1–3 helper, indexer, redirect, watchdog, and panel UX changes alongside `diagnoseConnection`, `buildDiagnosticUserPrompt`, and diagnostic tool guards.

### User checks (deferred)

- None.

## Phase 5: Phase 5: Multi-Project Hackathon Demonstration Suite

### Discrepancies

- **5.1 fixture form vs “projects”:** Phase 5.1 names four representative apps (OptimalX, EidosBot, etc.). Implementation is **`test/fixtures.test.cjs` only**—each test builds ephemeral temp directories inline. There are **no checked-in sample project trees** (e.g. under `test/fixtures/`) for judges or developers to open outside the test runner.
- **5.1 Project D vs SPEC wording:** SPEC 5.1 calls for a Next.js app with **`OPENAI_BASE_URL`**. The fixture test title mentions that env var, but the harness **finishes on `settings.json`** (`https://openrouter.ai/api/v1`). `route.ts` references `process.env.OPENAI_BASE_URL`, but the test does not drive discovery or rewrite through `.env` / that env key.
- **5.1 Project C vs `.env` / SDK focus:** SPEC emphasizes **`.env` + OpenAI SDK**. The test covers `.env` via `readEnvStatus` / `applyEnv` / `restoreEnv`, but the **helper harness proposes `config.py`** (`DEFAULT_BASE_URL`), not an `.env`-based `OPENAI_BASE_URL` offer.
- **Objective “validate autonomous connects” vs test depth:** Phase 5’s objective is end-to-end validation across frameworks. All four project tests (and the self-healing demo) use **`runHarness` with a mocked `complete` callback**—same limitation as Phases 2.3 / 4.3. They do not exercise the VS Code extension capture path, file rewrite rollback in the UI, or the live Meta helper client.
- **Project B local Ollama grounding:** The mocked turn returns `detect_local_services` and `propose_address` together; the test asserts **one step** and a `config.yaml` finish. It does **not** assert that a local service probe succeeded or that Ollama was listening—only that the harness accepts the scripted tool sequence.
- **Project A “Electron”:** Fixture is **Node `main.js` + `@optimalx/desktop` in `package.json`** with a user config under `~/.config/optimalx`. There is no Electron main/preload structure or dependency—Electron is descriptive labeling, not a distinct stack fixture.
- **5.2 showcase vs product behavior:** `HACKATHON_SHOWCASE.md` delivers documentation and a **3-minute video script** (aligned with 5.2). Loop 3 text says diagnostic re-engagement happens when the user clicks **Troubleshoot Connection** **“(or watchdog triggers)”**; **`TrafficWatchdog` still does not call `diagnoseConnection`**—only explicit troubleshoot (with helper prerequisites) does. The video script also describes live capture latency (“under two seconds”) and UI flows **not automated** in `fixtures.test.cjs`.
- **Showcase table vs SPEC 5.1:** The showcase matrix describes Project D as **`settings.json` / OpenRouter**, which matches the test but **diverges from SPEC Phase 5.1’s `OPENAI_BASE_URL` bullet**.
- **Commit state:** `test/fixtures.test.cjs` and `HACKATHON_SHOWCASE.md` are **untracked** in the current working tree; Phase 5 deliverables are present on disk but not part of the latest committed diff (`main` ahead 1 with other files staged/modified).
- **Overlap with Phase 4 tests:** The fifth fixture test (“Self-Healing Diagnostic Demonstration”) overlaps the Phase 4 **`diagnostic loop correctly pivots…`** scenario in `test/helper.test.cjs` (user-config pivot with mocked turns)—Phase 5 consolidates naming for the demo suite but adds limited new behavioral coverage.

### User checks (deferred)

- None.

