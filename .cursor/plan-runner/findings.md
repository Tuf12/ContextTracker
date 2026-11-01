# Plan run findings

- Plan path: docs/plans/android-device-bridging.md
- Started: Sunday, Nov 1, 2026, 1:35 PM (UTC-6)

## Phase 1: Phase 1: ADB Sensory & Actuation Tools

### Discrepancies

- Phase 1 deliverables are **uncommitted** (untracked `src/android.ts`, `test/android.test.cjs`; modified `src/types.ts`; not on `HEAD`).
- Plan **§3.1 / 1.1** tool name `detect_android_environment` maps to **`detectAndroidEnvironment`** in `src/android.ts` (library API; Meta AI snake_case registration is Phase **2**).
- Plan **§3.1** return schema has no **`summary`** field; **`AndroidEnvironment`** adds **`summary`** and **`AndroidDevice`** adds optional **`product`** (from `adb devices -l` parsing)—extras beyond the spec JSON.
- Plan **§3.1** example **`defaultStrategy`** is only **`adb_reverse`**; types allow **`emulator_gateway`**, but **`detectAndroidEnvironment`** never sets **`emulator_gateway`** (only **`adb_reverse`** or **`none`**). Missing-adb copy mentions **`10.0.2.2:47321`** without setting **`emulator_gateway`**.
- Plan **§3.1** **`available: true`** implies ADB readiness; implementation sets **`available: false`** when **`adb`** is missing **or** when **`adb devices -l`** exits non-zero ( **`adbPath`** may still be set on query failure).
- **`detectAndroidEnvironment`** returns **all** parsed rows (e.g. **`unauthorized`**, **`offline`**); plan examples show only **`state: "device"`**—callers must filter (bridge does filter for **`device`**).
- Plan **§5.1** port validation regex **`/^\d+$/`**; code exports **`PORT_REGEX = /^\d{1,5}$/`** but **`bridgeAndroidDevice`** validates ports with integer range checks instead—**`PORT_REGEX` is unused**.
- Plan **1.2** teardown is **`adb reverse --remove tcp:47321`**; implemented as **`removeAndroidBridge`** (aligned). With no **`deviceSerial`**, a single global **`reverse --remove`** runs and **`removedDevices`** is **`["all"]`**—not per-device cleanup when multiple devices were bridged.
- Plan **1.3 / §3.3** tool parameter is optional **`manifestPath`**; **`inspectAndroidSecurity(projectRoot, options?)`** requires an explicit **`projectRoot`** (appropriate for a library; harness wiring is Phase **2**).
- Plan **1.3** manifest locations **`app/src/main/`**, **`src/main/`**; **`findManifestFile`** also checks project-root **`AndroidManifest.xml`** (broader discovery).
- Plan **1.3** asks to parse domain exceptions for **`127.0.0.1`** and **`10.0.2.2`**; **`base-config cleartextTrafficPermitted="true"`** sets **`configAllowsLocalhost`** without requiring those domains (broader than loopback-only exceptions).
- Plan **1.1** Windows path **`%LOCALAPPDATA%\Android\Sdk`**; **`findAdbPath`** uses **`~/AppData/Local/Android/Sdk`** (typical default, not **`process.env.LOCALAPPDATA`**).
- Plan **1.1** also lists **`ANDROID_SDK_ROOT`**; unit tests cover **`ANDROID_HOME`** and **`PATH`** but not **`ANDROID_SDK_ROOT`** or homedir **`~/Android/Sdk`** discovery.
- Plan **1.4** mocked process tests are present and pass (**`npm run compile`** + **`node --test test/android.test.cjs`**). Gaps vs implementation surface: no test for **`src/main/AndroidManifest.xml`**, bridge **`verification: "unverified"`**, **`ANDROID_SDK_ROOT`**, or malicious serial filtering in **`parseAdbDevicesOutput`**.

### User checks (deferred)

- None.

## Phase 2: Phase 2: Autonomous Meta AI Reasoning Integration

### Discrepancies

- Phase 2 deliverables are **uncommitted** (modified `src/helperTools.ts`, `src/app.ts`, `test/helper.test.cjs`; depends on untracked Phase 1 `src/android.ts`; not on `HEAD`).
- **`ADDRESS_SYSTEM` conflict:** Mobile section instructs proposing **`http://127.0.0.1:47321`** / **`http://10.0.2.2:47321`**, while **RULES & CONSTRAINTS** still says **never propose port 47321**; **`proposeAddress`** rejects any URL with port **47321** via **`isCaptureUrl`**—so the documented Android resolution path cannot succeed through **`propose_address`** as written (plan §4.1 copied into the prompt without reconciling existing capture rules).
- **Phase 2.2 / plan §4.2 diagnostic grounding:** **`buildDiagnosticUserPrompt`** accepts **`androidEnvironment`**, **`securityFindings`**, and **`buildArtifactStatus`**, but **`src/app.ts`** watchdog/diagnostic harness still calls it with only **`failedFile`**, **`failedUrl`**, **`reason`**, **`projectName`**, and **`clues`**—no automatic ADB, cleartext, or APK timestamp injection at runtime.
- **`buildDiagnosticUserPrompt`** adds optional Android **data** sections only; it does **not** include Android architecture rules, Gradle/Kotlin sourcing hierarchy, or emulator-vs-device routing text in the diagnostic prompt itself (Phase 2.2 bullet is only fully reflected in **`ADDRESS_SYSTEM`**, not diagnostics).
- **`diagnosticTools`** is implemented as a thin alias of **`addressTools`** (tools registered as required); **`app.ts`** continues to call **`addressTools`** directly for diagnostics—behaviorally aligned, not a separate tool set.
- **Phase 2.3 verification:** **`test/helper.test.cjs`** **`Meta Muse helper discovers Android Kotlin architecture and bridges device in 2 turns`** uses a **mocked** **`complete`** callback, not live **Muse Spark 1.3 / Muse Wonder** API calls; turn-2 comment expects **`bridge_android_device` + `propose_address`** but the mock only invokes **`propose_address`**; assertions do **not** require **`bridge_android_device`**; finish URL stays **`https://api.openai.com/v1`** rather than exercising Android recorder targeting or **`47321`** bridging flow from the plan.
- Minor prompt wording vs plan §4.1: build-state bullet uses **“Always note in your reasoning”** instead of **“Always notify”**.

### User checks (deferred)

- **Plan §2.3 / Phase 2.3:** Exercise address discovery against a Kotlin/Android fixture with **live** Meta **Muse Spark 1.3** or **Muse Wonder** tool calling (parallel **`detect_android_environment`**, **`inspect_android_security`**, **`search_text`**, then **`bridge_android_device`** when a device is present)—not covered by mocked harness tests alone.
- Confirm end-to-end behavior when the model follows Android prompt guidance: whether proposing **`127.0.0.1:47321`** is intended to bypass **`propose_address`** / file-verbatim rules, or whether **`ADDRESS_SYSTEM`** and **`proposeAddress`** need a product change (deferred product decision; note for manual validation after prompt/tool reconciliation).

## Phase 3: Phase 3: Traffic Watchdog & Self-Healing Diagnostics

### Discrepancies

- Phase 3 deliverables are **uncommitted** (untracked **`src/android.ts`** with **`checkAndroidBuildState`**, **`diagnoseAndroidConnection`**, **`removeAndroidBridge`**; modified **`src/app.ts`**, **`src/watchdog.ts`**, **`test/android.test.cjs`**, **`test/watchdog.test.cjs`**, **`src/types.ts`**; branch **ahead 4** of **`origin/main`**, not on isolated Phase-3-only commits).
- **Phase 3.1 / architecture §2 “Stale binary check”:** **`checkAndroidBuildState`** compares **one** optional **`sourceFilePath`** (armed endpoint at capture time) against the newest **`.apk` / `.class` / `.jar`** under **`app/build/`** and **`build/`** trees—not a dedicated **`app-debug.apk`** path as in plan §4.2. Missing artifacts mark **`isStale: true`** even when no redirect timestamp exists yet.
- **Phase 3.2 “When capture is silent after timeout, check ADB reverse … or APK older than rewrite”:** **`TrafficWatchdog.checkIdle`** only sets **`missedHint`** from **`projectContext`** flags frozen at **arm capture** (**`isStale`** from initial **`checkAndroidBuildState`**); it does **not** re-run ADB **`reverse --list`**, **`diagnoseAndroidConnection`**, or refresh artifact mtimes on silence. Architecture diagram **“Silence detection → Checks ADB tunnel heartbeat”** is **hint text only**, not an automated probe.
- **Phase 3.2 automated / one-click fix:** **`diagnoseAndroidConnection`** may **`bridgeAndroidDevice`** (self-heal tunnel) and populate diagnostic prompt fields, but only when the user triggers **`troubleshootConnection`** → **`diagnoseConnection`** (helper connected). Idle timeout does **not** invoke repair or Meta AI; there is no Phase 3 UI one-click beyond existing **Troubleshoot Connection** (Phase **4** owns richer UX).
- **`diagnoseAndroidConnection`** builds **`issues`** / **`remedies`** (cleartext, stale APK, missing ADB/device); **`app.ts`** passes only **`env`**, **`security`**, and **`buildState.summary`** into **`buildDiagnosticUserPrompt`**—aggregated issue/remedy lists and **`repairedBridge`** outcome are omitted from the model prompt (bridge repair is logged to output channel only).
- **Stale APK without helper:** **`troubleshootConnection`** returns early with **`buildState.summary`** when **`isStale`** and helper is **not** connected—it does **not** run **`diagnoseAndroidConnection`** or attempt **`bridgeAndroidDevice`** in that path (ADB/cleartext checks deferred until helper is connected).
- **Phase 3.3 teardown:** **`removeAndroidBridge()`** is hooked into **`stopCapture()`** and extension **`dispose()`** (aligned with plan **3.3** and §5.3 stop/deactivate). **`forgetAddress()`** closes the recorder and restores redirects but **does not** call **`removeAndroidBridge`** (residual tunnel if user disconnects address without **Stop capture**).
- **Watchdog cleartext:** Android silence hints mention ADB bridging or stale APK only; **cleartext policy** is not reflected in **`missedHint`** (only via security section on full diagnostic).
- **Tests:** Unit coverage for **`checkAndroidBuildState`**, **`diagnoseAndroidConnection`** (mock ADB), and Android **`TrafficWatchdog`** hints; **no** test that **`TrackerApp.stopCapture`** / **`dispose`** invoke teardown, and **no** integration test for silence-timeout → troubleshoot → bridge repair flow.
- **Cross-phase (resolved here):** Phase 2 noted missing Android grounding in diagnostics at runtime; **`diagnoseConnection`** now calls **`diagnoseAndroidConnection`** and passes Android fields into **`buildDiagnosticUserPrompt`** when **`diag.isAndroid`**.

### User checks (deferred)

- On a real Android project with capture armed: let **`TrafficWatchdog`** hit idle timeout with zero requests and confirm **`missedHint`** shows ADB vs stale-APK messaging in the webview.
- Disconnect or drop **`adb reverse`** (or replug USB) while capture is running, click **Troubleshoot Connection** with helper connected, and confirm tunnel re-establishment log and traffic recovery without manual **`adb reverse`**.
- Edit a redirected Kotlin/config file without rebuilding, arm capture, and confirm stale detection (**output channel**, troubleshoot early message, and/or diagnostic prompt **Build Artifact State**).
- **Stop capture** (and extension reload/deactivate) and verify **`adb reverse --list`** no longer includes **`tcp:47321`** for bridged devices.

## Phase 4: Phase 4: Webview UI & Developer Experience

### Discrepancies

- Phase 4 deliverables are **uncommitted** (modified **`media/panel.js`**, **`media/panel.css`**, **`src/app.ts`**, **`src/types.ts`**; **`AndroidViewInfo`** / **`RecorderView.mobile`** wiring; **`test/android.test.cjs`** contract test; branch **ahead 4** of **`origin/main`**).
- **Phase 4.1 “webview header” device pill:** Plan examples **`📱 Pixel 8 (Bridged)`** / **`📱 Emulator (Bridged)`**; UI places the status pill in the **Capture card** header (alongside Active/Off), not the top-level **`Context Tracker`** header. Project card shows a separate static **“Android”** idle badge only.
- **Device label semantics:** Pre-bridge **`detectAndroidEnvironment`** sets **`deviceLabel`** from **`model || serial`**; after **`bridgeAndroidDevice`**, **`armCapture`** overwrites **`deviceLabel`** with **`bridgedDevices` serials** (e.g. **`emulator-5554`**, not **“Emulator”** or a friendly **Pixel 8** name). Unbridged state shows **`(Active)`**, which the plan does not describe (plan copy is **“(Bridged)”** only).
- **`stopCapture`** clears **`activeAndroidBridge`** but not **`activeAndroidDevice`**—pill can still show a device name with **Bridged → Active** after capture stops.
- **Phase 4.2 cleartext card:** Non-blocking warning + copy control is implemented when **`isAndroid && !cleartextPermitted`** (Capture card expanded). Plan **4.2** asks for a copyable **`network_security_config.xml` snippet**; clipboard gets the full **`inspectAndroidSecurity` remediation** block (numbered steps, manifest attribute, and XML)—broader than the XML-only snippet in plan **§3.3**. **`securityRisk`** on **`AndroidViewInfo`** is populated but **not shown** in the webview.
- **Cleartext visibility:** Warning appears for any loaded Android project while the Capture section is open, **not** gated on capture **running** or on traffic failure.
- **Phase 4.3 build reminder:** Plan ties the indicator to capture on a **compiled Kotlin/Gradle** endpoint; UI shows the stale **banner** only when **`recorder.running && mobile.isStale`**, driven by **`checkAndroidBuildState`** (artifact mtime vs redirected file)—including **“no build artifacts found”** stale cases, and **no** reminder when the armed file is Kotlin/Gradle but artifacts are already newer than the redirect. Copy matches plan headline **“Re-run app in Android Studio”** but subtitle is hardcoded; **`staleSummary`** from the backend is unused in **`panel.js`**. Plan wording is **“badge”**; implementation is a warning banner card.
- **Collapsed Capture card:** Device pill, cleartext card, and build reminder are **hidden** when the Capture card is collapsed (plan silent on collapse).
- **Tests:** **`Phase 4 Webview UI integration: AndroidViewInfo contract conforms to schema`** validates the **`mobile`** payload shape only—**no** webview/DOM test for pill text, copy button, or banner visibility.

### User checks (deferred)

- None.
