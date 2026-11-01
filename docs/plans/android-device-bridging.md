# Context Tracker — Autonomous Mobile & Android Device Bridging Specification (Loop 7)

## 1. Vision & Problem Statement

### 1.1 The Context & Hackathon Opportunity
Context Tracker is engineered for the **Meta Global AI Developer Hackathon**, competing for the **General Track** and the **$5,000 Best Agentic Use-Case bonus**. 

In previous iterations, Meta AI models (**Muse Spark 1.3** and **Muse Wonder**) were established across six autonomous loops:
- **Loop 1 & 2:** Autonomous connection intelligence and machine sensory grounding.
- **Loop 3:** Self-healing connection watchdog for silent / misrouted traffic.
- **Loop 4:** Autonomous semantic prompt attribution, reverse-engineering dynamic templates (f-strings, Jinja2, YAML) to project source code.
- **Loop 5:** Live reasoning thought streaming, sensory action feed, and interactive developer command console.
- **Loop 6:** Context Window Anatomy & Telemetry (structural decomposition, token budgeting, and prompt hygiene).

However, a major class of modern AI applications runs not on desktop/backend servers, but on **mobile devices (Android / Kotlin apps built with Jetpack Compose, Retrofit, Ktor, OkHttp, LangChain for Android, or on-device LLM hybrids)**. Developers typically run and debug these applications through **Android Studio**, targeting either physical devices via USB or the Android Virtual Device (AVD) emulator.

### 1.2 The Problem: Mobile Network Isolation & Android Platform Guardrails

When developers attempt to use Context Tracker with an Android project, standard desktop loopback capture fails due to four platform constraints:

1. **Loopback Isolation (`127.0.0.1` Disconnect):**  
   Context Tracker's recorder proxy binds to `127.0.0.1:47321` on the development host. On an Android device or emulator, `127.0.0.1` refers to the mobile device itself, *not* the developer's computer. Outbound HTTP requests from the app die instantly with `ECONNREFUSED` on the device.
2. **Platform Cleartext HTTP Blocking:**  
   Starting in Android 9 (API level 28), Android blocks plain unencrypted HTTP (`http://`) traffic by default. Because Context Tracker redirects upstream HTTPS endpoints to a local recording proxy via `http://`, the Android OS aborts the connection with `java.io.IOException: Cleartext HTTP traffic to 127.0.0.1 not permitted`.
3. **Compiled Artifact Latency & Stale Binaries:**  
   Unlike interpreted Python or Node.js environments that reload on save, Android Kotlin apps compile endpoints into bytecode, `BuildConfig` constants, or `res/values/strings.xml`. If Context Tracker redirects a source file, the change has zero effect on the running app until the developer triggers a rebuild/run in Android Studio.
4. **Emulator Gateway Divergence (`10.0.2.2` vs. ADB Reverse):**  
   The Android emulator accesses host loopback via `10.0.2.2`, whereas physical devices require a reverse port forward (`adb reverse tcp:47321 tcp:47321`). Manual command-line setup is brittle, fails whenever the USB cable is replugged or ADB server restarts, and requires deep Android platform networking knowledge.

### 1.3 The Solution: Loop 7 — Autonomous Android Device Bridging & Environment Grounding

Rather than requiring developers to manually configure reverse tunnels, edit network security configs, or figure out emulator IP aliases, **Meta AI acts as an Autonomous Mobile Connection & Bridging Agent**:

1. **Sensory Device Grounding (`detect_android_environment`):**  
   Meta AI inspects the developer's system for active Android SDK installations, ADB binaries, and connected hardware (physical devices vs. emulators).
2. **Autonomous Port Bridging (`bridge_android_device`):**  
   Meta AI establishes and validates reverse port forwarding (`adb reverse tcp:47321 tcp:47321`) across connected devices in a single actuation step.
3. **Static Security Inspection (`inspect_android_security`):**  
   Meta AI inspects `AndroidManifest.xml` and `res/xml/network_security_config.xml` to detect cleartext policy restrictions upfront and proposes safe configuration changes or debug overrides.
4. **Android Stack Architecture Recognition:**  
   Meta AI identifies Kotlin/Java networking layers (Retrofit `baseUrl`, Ktor `HttpClient`, OkHttp interceptors, `BuildConfig`, Gradle build variants, resources).
5. **Watchdog Self-Healing (Loop 3 Integration):**  
   If capture is armed but prompts bypass the recorder, Meta AI diagnoses whether:
   - ADB tunnel was severed or device disconnected.
   - The APK is stale (source modified after binary compile timestamp).
   - Cleartext policy blocked the traffic.
   It autonomously repairs the tunnel or provides exact remediation instructions.

---

## 2. System Architecture & Autonomy Model

```
+---------------------------------------------------------------------------------------+
|                          Context Tracker Extension Core                               |
+---------------------------------------------------------------------------------------+
                                           |
                   +-----------------------+-----------------------+
                   |                                               |
                   v                                               v
+-------------------------------------+         +-------------------------------------+
| Android Architecture Analysis       |         | Sensory Mobile Environment Tooling  |
| (Muse Spark 1.3 / Muse Wonder)      |         | (ADB & Platform Probing)            |
+-------------------------------------+         +-------------------------------------+
                   |                                               |
                   | • Gradle & Kotlin inspect                     | • detect_android_environment
                   | • Retrofit/Ktor/OkHttp recognition            | • bridge_android_device (adb reverse)
                   | • Cleartext policy parsing                    | • inspect_android_security
                   +-----------------------+-----------------------+
                                           |
                                           v
                       +---------------------------------------+
                       | Autonomous Address & Bridge Proposal  |
                       | - Device present: adb reverse + 47321 |
                       | - Emulator only: 10.0.2.2:47321       |
                       +---------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
|                               Traffic Watchdog & Self-Healing                         |
| • Silence detection -> Checks ADB tunnel heartbeat                                    |
| • Stale binary check -> Verifies build output timestamp vs redirect timestamp          |
| • Cleartext warning -> Suggests network_security_config debug override                |
+---------------------------------------------------------------------------------------+
```

---

## 3. Sensory Tool Specifications & Contracts

### 3.1 Tool 1: `detect_android_environment`
Probes the host machine for the Android SDK, the `adb` executable, and any active physical devices or emulators.

* **Parameters:** None.
* **Return Schema:**
  ```json
  {
    "available": true,
    "adbPath": "/home/tuf/Android/Sdk/platform-tools/adb",
    "devices": [
      {
        "serial": "emulator-5554",
        "type": "emulator",
        "model": "sdk_gphone64_x86_64",
        "state": "device"
      },
      {
        "serial": "RFCW10ABCD",
        "type": "physical",
        "model": "Pixel_8_Pro",
        "state": "device"
      }
    ],
    "defaultStrategy": "adb_reverse"
  }
  ```
* **Execution Logic:**
  1. Searches for `adb` in `PATH`, `$ANDROID_HOME/platform-tools/adb`, and `$ANDROID_SDK_ROOT/platform-tools/adb`.
  2. Runs `adb devices -l` with a strict 1500ms timeout.
  3. Parses device serials, models, and types (`emulator-*` vs physical serial).

### 3.2 Tool 2: `bridge_android_device`
Establishes a reverse TCP tunnel forwarding the device's loopback port to the host recorder port.

* **Parameters:**
  ```json
  {
    "deviceSerial": { "type": "string", "description": "Optional specific device serial. If omitted, bridges all active devices or default device." },
    "devicePort": { "type": "number", "description": "Port on device to bind (default: 47321)" },
    "hostPort": { "type": "number", "description": "Port on host to forward to (default: 47321)" }
  }
  ```
* **Return Schema:**
  ```json
  {
    "success": true,
    "bridgedDevices": ["emulator-5554", "RFCW10ABCD"],
    "forwardingRule": "tcp:47321 -> tcp:47321",
    "verification": "active"
  }
  ```
* **Execution Logic:**
  1. Executes `adb -s <serial> reverse tcp:<devicePort> tcp:<hostPort>`.
  2. Runs `adb reverse --list` to verify the rule is registered.
  3. Returns actionable status for Meta AI reasoning.

### 3.3 Tool 3: `inspect_android_security`
Scans the project's Android manifests and network security configurations to evaluate cleartext HTTP permissibility.

* **Parameters:**
  ```json
  {
    "manifestPath": { "type": "string", "description": "Optional relative path to AndroidManifest.xml (defaults to automatic discovery)." }
  }
  ```
* **Return Schema:**
  ```json
  {
    "cleartextPermitted": false,
    "manifestFound": true,
    "manifestPath": "app/src/main/AndroidManifest.xml",
    "usesCleartextTraffic": null,
    "networkSecurityConfigPath": "app/src/main/res/xml/network_security_config.xml",
    "configAllowsLocalhost": false,
    "risk": "Android 9+ blocks cleartext http:// by default. App network calls will fail with java.io.IOException: Cleartext HTTP traffic to 127.0.0.1 not permitted.",
    "remediation": "<network-security-config>\n  <domain-config cleartextTrafficPermitted=\"true\">\n    <domain includeSubdomains=\"true\">127.0.0.1</domain>\n    <domain includeSubdomains=\"true\">10.0.2.2</domain>\n  </domain-config>\n</network-security-config>"
  }
  ```

---

## 4. Prompt Engineering & Reasoning Strategy

### 4.1 Enhanced `ADDRESS_SYSTEM` Prompt Additions
The system prompt in `src/helperTools.ts` will be updated to include **Mobile & Android Architecture Recognition**:

```text
### MOBILE & ANDROID ARCHITECTURE RECOGNITION
When inspecting projects with Android / Kotlin codebases (e.g. build.gradle, build.gradle.kts, AndroidManifest.xml, app/src/...):
1. Tool Invocation: Call detect_android_environment and inspect_android_security in your initial turn alongside search_text.
2. Endpoint Resolution:
   - Identify Retrofit base URLs, Ktor client configurations, OkHttp baseUrl, BuildConfig fields, or strings.xml.
   - If an active Android device or emulator is detected:
     a) Call bridge_android_device to map port 47321.
     b) Propose http://127.0.0.1:47321 as the target address.
   - If an emulator is running without ADB bridge access, propose http://10.0.2.2:47321.
3. Build State Warning:
   - Always notify if the configuration resides in compiled code (Kotlin source, BuildConfig, or Gradle build scripts), advising the user to trigger 'Run' in Android Studio after capture arms.
```

### 4.2 Diagnostic & Self-Healing Prompt Additions
In `buildDiagnosticUserPrompt` (Loop 3), when an Android project is detected, the diagnostic prompt grounds the model with:
- Connected ADB device status.
- Build artifact timestamps (e.g., `app/build/outputs/apk/debug/app-debug.apk` mtime vs. source file mtime).
- Cleartext security findings.

---

## 5. Safety, Redaction & Sandboxing Guarantees

1. **Strict ADB Command Sandboxing:**
   * Only fixed, parameterized ADB operations (`adb devices -l`, `adb reverse tcp:... tcp:...`, `adb reverse --list`) are permitted.
   * Device serials and port numbers are validated via strict regex (`/^[a-zA-Z0-9._:-]+$/`, `/^\d+$/`) to prevent shell injection or arbitrary command execution.
   * Arbitrary `adb shell` execution is forbidden.
2. **Credential Redaction:**
   * Any API keys or tokens embedded in `gradle.properties`, `local.properties`, or `BuildConfig` are filtered through `redactText` before reaching Meta AI.
3. **Safe Teardown & Zero Footprint:**
   * On "Stop capture", extension deactivation, or window reload:
     - All registered ADB reverse rules (`adb reverse --remove tcp:47321`) are cleaned up.
     - Source file modifications are reverted via `restoreAllRedirects`.

---

## 6. Phased Implementation Plan

### Phase 1: ADB Sensory & Actuation Tools
* **1.1 Android Environment Detector (`detect_android_environment`):**
  - Implement discovery of `adb` executable from `PATH`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and common OS paths (`~/Android/Sdk`, `~/Library/Android/sdk`, `%LOCALAPPDATA%\Android\Sdk`).
  - Implement `adb devices -l` parser with 1500ms safety timeout.
* **1.2 Reverse Bridge Actuator (`bridge_android_device`):**
  - Implement `adb reverse tcp:47321 tcp:47321` runner with verification check.
  - Implement teardown utility (`adb reverse --remove tcp:47321`).
* **1.3 Android Network Security Inspector (`inspect_android_security`):**
  - Locate `AndroidManifest.xml` in standard locations (`app/src/main/`, `src/main/`).
  - Parse `android:usesCleartextTraffic` and `android:networkSecurityConfig`.
  - Parse XML config for `127.0.0.1` and `10.0.2.2` domain exceptions.
* **1.4 Fast Unit Tests:**
  - Mocked child process unit tests verifying parser stability and safety constraints without invoking actual devices.

### Phase 2: Autonomous Meta AI Reasoning Integration
* **2.1 Tool Registration:**
  - Register `detect_android_environment`, `bridge_android_device`, and `inspect_android_security` in `addressTools()` and `diagnosticTools()`.
* **2.2 Prompt Engineering:**
  - Update `ADDRESS_SYSTEM` and `buildDiagnosticUserPrompt` with Android architecture rules, Gradle/Kotlin sourcing hierarchy, and emulator vs. device routing.
* **2.3 Verification:**
  - Verify Meta Muse Spark 1.3 / Muse Wonder tool calling behavior against Kotlin project mock fixtures.

### Phase 3: Traffic Watchdog & Self-Healing Diagnostics
* **3.1 Stale Artifact Detection:**
  - Add build output timestamp checker (comparing redirected source/config file `mtime` with `app/build/` APK or class outputs).
* **3.2 Automated Watchdog Diagnostic Check:**
  - When capture is silent after timeout, check if ADB reverse forwarding was disconnected or if the APK is older than the rewrite.
  - Provide instant one-click or automated fix via Meta AI.
* **3.3 Teardown Lifecycle:**
  - Hook ADB reverse cleanup into `stopCapture()` in `src/app.ts`.

### Phase 4: Webview UI & Developer Experience
* **4.1 Mobile Device Status Badge:**
  - Show active device pill in the webview header (`📱 Pixel 8 (Bridged)` or `📱 Emulator (Bridged)`).
* **4.2 Cleartext Traffic Notification:**
  - If cleartext HTTP is blocked, display a non-blocking warning card with a one-click copyable `network_security_config.xml` snippet.
* **4.3 Build Reminder Indicator:**
  - When capture arms on a compiled Kotlin/Gradle file, display a reminder badge: *"Re-run app in Android Studio to apply capture endpoint"*.

---

## 7. Hackathon Evaluation Alignment

| Contest Dimension | Weight | Loop 7 Contribution |
| :--- | :--- | :--- |
| **Best Agentic Use-Case ($5,000 Bonus)** | Primary Target | Demonstrates complete autonomous device bridging: Meta AI perceives the mobile execution runtime, bridges physical hardware/emulators via ADB, inspects OS security manifests, and self-heals disconnected tunnels. |
| **Use of Meta AI Tooling** | 25% | Directly leverages Meta Muse Spark 1.3 and Muse Wonder with advanced multi-tool parallel calling across filesystem, local network, and mobile ADB layers. |
| **Utility & Technical Execution** | 25% | Solves the #1 real-world barrier preventing mobile developers from tracking LLM context in Android apps. Zero manual proxy configuration required. |
| **User Experience & Completeness** | 25% | Seamless workflow: launch app from Android Studio as usual, while Context Tracker autonomously handles reverse tunnels, security policies, and capture. |
