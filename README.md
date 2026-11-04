# Context Tracker

**Autonomous, Zero-Config LLM Prompt Recorder, Context Profiler & Prompt Co-Pilot for VS Code and Cursor**  
*Powered by Meta AI (*`muse-spark-1.3` *&* `muse-wonder-1.0`*) via the Meta Model API*

![Built with Meta Model API](https://img.shields.io/badge/Meta_Model_API-Muse_Spark_1.3_%7C_Muse_Wonder-0668E1?style=flat-square)
![VS Code Extension](https://img.shields.io/badge/VS_Code_%26_Cursor-%5E1.85.0-007ACC?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)

> 🏆 **Meta Global AI Developer Hackathon 2026 Submission**  
> **Problem Statement:** *Build for Your World* | **Track:** *Indie Developer* & *Best Agentic Use-Case*  
> **Core AI Brain:** Meta Muse Spark 1.3 & Muse Wonder via [Meta Model API](https://api.meta.ai/v1)  
> **Original Work Declaration:** 100% of Context Tracker was conceived and built from scratch during the hackathon building period (Oct 27 – Nov 4, 2026).  
> 📺 **Demo Walkthrough & Video:** [Watch the 3-Minute Demo (YouTube)](https://youtu.be/n7IsV_Dyu9M) · [Comprehensive Hackathon Showcase Guide](./HACKATHON_SHOWCASE.md)

---

## Why Context Tracker?

Modern AI applications assemble massive token context windows dynamically from system prompts, Jinja2/f-string templates, vector database RAG chunks, tool schemas, and multi-turn chat histories. When a model hallucinates, violates instructions, or burns unexpected tokens, developers ask a simple question:

> *"What exact prompt did my application send to the model, where in my codebase did each slice come from, and why did it behave that way?"*

Traditionally, answering that requires manually editing `.env` files, wiring up `mitmproxy`, digging through `~/.config` directories, or reading raw JSON logs by hand.

**Context Tracker, a VS Code and Cursor Extension, eliminates manual proxy setup and blind debugging.** By using **Meta's newest AI Models** as an autonomous multi-loop reasoning engine, developers simply click **Start capture**:

1. **Zero-Config Connection:** Meta AI inspects your project's client architecture, probes local AI ports and user config directories, and routes traffic through Context Tracker's local recorder (`127.0.0.1:47321`) automatically restoring every file on stop.
2. **Codebase Grounding & Attribution:** Static lines match instantaneously to source files, while dynamic templates (f-strings, Jinja2, Mustache, RAG injections) are reverse-engineered back to exact file and line ranges by Meta AI.
3. **Context Window Anatomy & Telemetry:** Every captured prompt is decomposed into visual card boundaries with token budget shares, **WHAT / WHY** prompt-engineering profiling, and tool-schema hygiene second opinions.
4. **Scoped Prompt Co-Pilot & 1-Click Patching:** Click any prompt section, tool card, or runtime slice to interrogate it with Meta AI, detect contradictions between system rules and retrieved RAG chunks, diff captures, and apply syntax-highlighted template patches directly to your workspace.

---

## System Architecture & The 8 Autonomous Agentic Loops

Context Tracker is built around **8 interconnected autonomy loops** driven by the Meta Model API (`https://api.meta.ai/v1`) and grounded in deterministic machine sensory tools:

```text
+---------------------------------------------------------------------------------------+
|                            Context Tracker Extension Core                             |
|                     (VS Code / Cursor Host + Local Proxy :47321)                      |
+---------------------------------------------------------------------------------------+
                                           |
        +----------------------------------+----------------------------------+
        |                                  |                                  |
        v                                  v                                  v
+-------------------------------+  +-------------------------------+  +-----------------+
| Loops 1, 2, 3 & 7             |  | Loops 4 & 6                   |  | Loops 5 & 8     |
| Autonomous Connection         |  | Context Telemetry &           |  | Live Command    |
| & Self-Healing                |  | Semantic Code Attribution     |  | & Prompt CoPilot|
+-------------------------------+  +-------------------------------+  +-----------------+
| • Client SDK classification   |  | • Token budget composition    |  | • Live thought  |
| • Local service TCP probes    |  | • WHAT / WHY section cards    |  |   & tool stream |
| • ~/.config & .env discovery  |  | • Tool schema second opinions |  | • Click-to-scope|
| • Traffic watchdog & recovery |  | • Dynamic template & sub-span |  | • Contradiction |
| • Android ADB reverse bridge  |  |   reverse-engineering to code |  |   & 1-click diff|
+-------------------------------+  +-------------------------------+  +-----------------+
```

### Loop 1: Architecture Discovery & Runtime Precedence Intelligence

Instead of brittle language-specific regexes, Meta Muse Spark / Wonder inspects the workspace to classify:

- **LLM Clients & SDKs:** OpenAI SDK, Anthropic SDK, Ollama REST API, vLLM, OpenRouter, Chutes, LangChain, LlamaIndex, or raw HTTP clients (`fetch`, `requests`, `httpx`, `axios`, `Retrofit`, `Ktor`, `OkHttp`).
- **Configuration Sourcing Hierarchy:**
  - **Type A (Environment Variables):** `.env`, `process.env`, `os.environ` (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OLLAMA_HOST`).
  - **Type B (In-Tree Config Files):** `config.yaml`, `settings.json`, `appsettings.json`.
  - **Type C (External User Configs):** `~/.config/<app>/...`, `~/.<app>/...`, `%APPDATA%`.
  - **Type D (In-Code Default Fallbacks):** Hardcoded fallback literals in source code.
- **Runtime Precedence Rule:** Recognizes when an in-code fallback (Type D) is overridden at runtime by an active disk config (Type A/B/C) and targets the true active config.

### Loop 2: Sensory Machine Tooling & Environment Grounding

To guarantee **zero hallucinations**, Meta AI operates through sandboxed, secret-redacting sensory tools (`src/helperTools.ts`):

- `detect_local_services`: Fast TCP probes for active local AI servers (Ollama `:11434`, LM Studio `:1234`, vLLM/LocalAI `:8000`, TextGen WebUI `:5000`).
- `find_user_config_dirs`: Discovers actual user config directories on disk matching the project.
- `search_text` / `list_files` / `read_file`: Parallel multi-query codebase search and file inspection with automatic credential redaction (`[private]`).
- `propose_address`: Verifies that the proposed upstream URL exists verbatim in the target file and prevents self-proxy loops on port `47321`.

### Loop 3: Autonomous Traffic Watchdog & Self-Healing Diagnostics

- **Heartbeat & Silence Detection (**`src/watchdog.ts`**):** Tracks outbound requests reaching port `47321`. If capture is armed but zero requests arrive (`listening_idle`), Context Tracker flags a missed connection.
- **Self-Healing Recovery:** Clicking **Troubleshoot Connection** re-engages Meta AI with diagnostic context (`failedFile`, `failedUrl`), prompting it to investigate bypassed configs and hot-swap the active connection.

### Loop 4: Semantic Prompt Attribution (Whole-Message & Sub-Span)

- **Static + Agentic Matching (**`src/indexer.ts`**,** `src/matcher.ts`**):** Verbatim prompt slices link immediately to workspace files (`🔵 Matched`).
- **Dynamic Template Reverse-Engineering:** For prompts built via Python f-strings, Jinja2 loops, Mustache templates, or RAG injections, clicking **✨ Attribute with Meta AI** (or **✨ Trace Section in Code** on any unlinked runtime block) instructs Meta AI to isolate invariant template instructions from runtime variables, search the workspace in parallel, and link the slice (`🟣 Attributed by Meta AI`) to the exact file and line range.

### Loop 5: Live Agent Thoughts, Sensory Feed & Dual-Surface UI

- **Transparent Reasoning:** Streams live model thoughts (`💭 Meta AI Thought`), sensory tool invocations (`⚙️ Sensory Tool`), and tool outputs in real time.
- **Sidebar & Dual-Column Editor Layout:** Operates compactly in the VS Code Activity Bar sidebar or expands into a full two-column command center in an editor tab.

### Loop 6: Context Window Anatomy & Telemetry ("What & Why" Profiler)

- **Two-Tier Telemetry Engine (**`src/telemetry.ts`**):**
  - **Tier 1 (0ms Local Triage & SHA-256 Caching):** Collapses multi-turn dialogue backlogs, splits multi-part system prompts and individual tool schemas, and caches invariant sections via SHA-256 fingerprints.
  - **Tier 2 (Meta AI Semantic Profiling):** Generates concise **🎯 WHAT** (technical identity) and **💡 WHY** (prompt engineering rationale) statements for each section, plus **Tool Hygiene Second Opinions** (`recommended`, `caution`, `bloat`, `unnecessary`, `redundant`, `security_risk`).
- **Visual Boundary Cards:** Eliminates "prompt blobbing" by framing every static template and injected runtime state block in isolated cards with explicit boundary dividers and token percentages.

### Loop 7: Autonomous Mobile & Android Device Bridging

- **Mobile Network Grounding (**`src/android.ts`**):** When inspecting Android/Kotlin projects (`build.gradle.kts`, `AndroidManifest.xml`, `Retrofit`/`Ktor`/`OkHttp`), Meta AI invokes:
  - `detect_android_environment`: Locates `adb` and enumerates connected physical devices and emulators.
  - `bridge_android_device`: Automatically establishes and verifies reverse port forwarding (`adb reverse tcp:47321 tcp:47321`) so `127.0.0.1:47321` on the mobile device routes directly to the host recorder.
  - `inspect_android_security`: Audits `AndroidManifest.xml` and `network_security_config.xml` for Android 9+ cleartext HTTP restrictions and provides copyable remediation snippets.

### Loop 8: Conversational Context Interrogation & Prompt Co-Pilot

- **Click-to-Scope Interaction:** Click any Anatomy Card, Tool Card, or Content Block (or highlight text) to immediately scope Meta AI to that slice (`🎯 Active AI Scope`) without disorienting viewport jumps.
- **On-Demand Context Sensory Tools (**`src/contextTools.ts`**):** Instead of stuffing 50k tokens into every chat turn, Meta AI calls `search_context`, `read_context_section`, `inspect_code_template`, and `diff_captures`.
- **Closed-Loop Workspace Patching:** Meta AI calls `propose_template_patch` to render an inline syntax-highlighted diff card with token impact estimates. Clicking **✅ Apply Patch to Workspace** safely patches your source file via `vscode.workspace.applyEdit` after verifying on-disk contents.

---

## Sensory Tool Catalog

| Loop / Domain | Tool Name | Purpose |
| :--- | :--- | :--- |
| **Connection & Recon (Loops 1–3)** | `search_text` | Parallel single/multi-query regex search across workspace with secret redaction |
| | `list_files` | Workspace file tree discovery (skips `node_modules`, `.venv`, `.git`, `dist`) |
| | `read_file` | Sandboxed file reader for workspace & `~/.config` with `[private]` secret redaction |
| | `find_user_config_dirs` | Grounds external user config paths across `~/.config`, `~`, and `%APPDATA%` |
| | `detect_local_services` | Fast socket probes for Ollama (`11434`), LM Studio (`1234`), vLLM (`8000`), TextGen (`5000`) |
| | `propose_address` | Verifies and proposes the active runtime file and upstream URL to redirect |
| **Attribution (Loop 4)** | `attribute_prompt` | Links dynamic templates/sub-spans to verified workspace `file`, `startLine`, `endLine` |
| **Android Bridge (Loop 7)** | `detect_android_environment` | Detects Android SDK `adb` path and active physical devices / AVD emulators |
| | `bridge_android_device` | Actuates `adb reverse tcp:47321 tcp:47321` and verifies active tunnel |
| | `inspect_android_security` | Audits `AndroidManifest.xml` & `network_security_config.xml` for cleartext HTTP rules |
| **Prompt Co-Pilot (Loop 8)** | `search_context` | Regex/keyword search across captured prompt messages or scoped sections |
| | `read_context_section` | Paged line-numbered inspection of specific context window sections |
| | `inspect_code_template` | Traces a context section to its source file template and extracts `{{ var }}` slots |
| | `propose_template_patch` | Produces a verified diff proposal to fix prompt contradictions or prune token bloat |
| | `diff_captures` | Compares two captured prompts across status, token deltas, RAG chunks, and replies |

---

## Quickstart & Installation

### Prerequisites

- **Node.js** `>= 18.x` and **npm**
- **VS Code** (`^1.85.0`) or **Cursor**
- **Meta Model API Key** (from the [Meta AI Developer Dashboard](https://dev.meta.ai))

### 1. Clone and Build

```bash
git clone https://github.com/Tuf12/ContextTracker.git
cd ContextTracker
npm install
npm run compile
```

### 2. Launch the Extension in Development Host

1. Open this repository folder in **VS Code** or **Cursor**.
2. Press `F5` (or select **Run and Debug → Run Context Tracker** from `.vscode/launch.json`).
3. In the newly opened `[Extension Development Host]` window, open any AI project folder you want to inspect.
4. Click the **Context Tracker** icon (`$(layers)`) in the Activity Bar on the left.

### 3. Configure the Meta AI Brain

1. In the Context Tracker panel, open the **AI Helper** connection settings.
2. Select your Meta model:
   - **Muse Spark 1.3** (`muse-spark-1.3`) — Default high-speed reasoning & parallel tool use
   - **Muse Wonder** (`muse-wonder-1.0`) — Deep analytical reasoning
   - *(Also supports* `muse-spark-1.3-contributor`*,* `muse-spark-1.2`*,* `muse-spark-1.1`*, or any OpenAI-compatible base URL)*
3. Paste your **Meta Model API Key** (stored securely in VS Code's OS keychain via `context.secrets`—never written to disk or git).

### 4. Capture, Profile & Debug Prompts

1. Click **Start capture**. Watch the live feed as Meta AI inspects your project and proposes or rewrites the active endpoint to `http://127.0.0.1:47321`.
2. Trigger an LLM request in your application.
3. Click the captured request in Context Tracker (or click **Open in editor tab** for the full dual-column view):
   - Inspect the **Context Window Composition Bar** and **Section Anatomy Cards**.
   - Click any matched badge (`🔵`) or attributed badge (`🟣`) to jump straight to that line in your editor.
   - Click any unlinked runtime block's **✨ Trace Section in Code** button to reverse-engineer dynamic templates.
   - Click any section card to scope the **Prompt Co-Pilot**, or use quick chips (`🔍 Detect Contradictions`, `✂️ Optimize & Prune`, `🛡️ Scan PII`, `💡 Explain Output`, `🔄 Compare Captures`).
4. Click **Stop capture** when finished—all modified `.env` or config files (and any Android `adb reverse` tunnels) are automatically restored to their exact original state.

---

## Security, Privacy & Zero-Footprint Guarantees

Context Tracker is designed with strict local-first safety guarantees:

- **Unconditional Secret Redaction (**`src/redact.ts`**):** Every line matching API keys, tokens, passwords, or `Authorization` headers is replaced with `[private]` before any file snippet or search match is sent to the helper model. Raw `.env`, `credentials.json`, and `.pem` files are blocked from full-text upload.
- **Strict Path Sandboxing (**`src/paths.ts`**):** File reads outside the workspace are strictly confined to non-sensitive user config directories (`~/.config/...`, `%APPDATA%`). Sensitive directories (`~/.ssh`, `~/.aws`, `~/.cursor`, `/etc`) are unconditionally blocked.
- **Parameterized ADB Sandboxing (**`src/android.ts`**):** Only fixed ADB commands (`adb devices -l`, `adb reverse`) with regex-validated serials and ports are executed; arbitrary `adb shell` execution is never allowed.
- **Automatic Rollback (**`src/redirect.ts`**,** `src/env.ts`**):** Original file contents are backed up in extension state prior to any redirect and automatically restored on **Stop capture**, window reload, or extension deactivation.

---

## Running the Test Suite

Context Tracker includes a comprehensive unit and multi-framework fixture suite (`test/*.test.cjs`) covering proxy routing, secret redaction, static & semantic attribution, traffic watchdog state transitions, Android ADB bridging, context telemetry, and Prompt Co-Pilot tools.

Compile TypeScript first:

```bash
npm run compile
```

Run individual test suites (recommended to avoid spawning heavy concurrent processes):

```bash
node --test test/proxy.test.cjs
node --test test/trace.test.cjs
node --test test/helper.test.cjs
node --test test/watchdog.test.cjs
node --test test/android.test.cjs
node --test test/telemetry.test.cjs
node --test test/contextTools.test.cjs
node --test test/contextCopilot.test.cjs
node --test test/chatScopingPersistence.test.cjs
node --test test/fixtures.test.cjs
```

---

## Repository Structure

```text
ContextTracker/
├── src/
│   ├── extension.ts       # VS Code extension entry point (activate / deactivate)
│   ├── app.ts             # Core controller orchestrating recorder, indexing, telemetry & UI state
│   ├── helperClient.ts    # Meta Model API client (https://api.meta.ai/v1, Muse Spark & Wonder)
│   ├── harness.ts         # Multi-turn agentic tool-calling loop with live thought/action streaming
│   ├── helperTools.ts     # Loops 1–4 & 7 sensory tools (local services, user configs, attribution)
│   ├── contextTools.ts    # Loop 8 Prompt Co-Pilot sensory tools (search, read, template patch, diff)
│   ├── telemetry.ts       # Loop 6 two-tier context anatomy profiler & SHA-256 fingerprint cache
│   ├── android.ts         # Loop 7 Android ADB environment detection, reverse bridging & security audit
│   ├── watchdog.ts        # Loop 3 traffic heartbeat monitor & silent-capture detection
│   ├── recorder.ts        # Local HTTP/HTTPS reverse proxy & SSE stream collector on port 47321
│   ├── parse.ts           # Normalizes OpenAI Chat/Responses, Anthropic Messages, and custom payloads
│   ├── indexer.ts         # Fast workspace line indexer & endpoint clue extractor
│   ├── matcher.ts         # Maps prompt slices to matched, reported, and AI-attributed source spans
│   ├── redirect.ts        # Safe file redirector with atomic backup and rollback on stop
│   ├── env.ts             # .env parser, backup manager, and safe key rewriter
│   ├── redact.ts          # Multi-layer credential and secret redaction ([private])
│   ├── paths.ts           # Workspace and ~/.config path sandboxing
│   ├── store.ts           # Persistent capture, attribution cache, and chat thread storage
│   ├── derive.ts          # Derives webview ViewState from captures, spans, and telemetry
│   ├── html.ts            # Webview HTML shell and Content Security Policy (CSP)
│   └── types.ts           # Shared TypeScript interfaces across host, harness, and webview
├── media/
│   ├── panel.js           # Interactive webview frontend (anatomy bar, click-to-scope, patch cards)
│   └── panel.css          # Theme-adaptive styling for sidebar and dual-column editor modes
├── test/                  # Unit and multi-project integration tests (Node.js test runner)
├── docs/plans/            # Architectural specifications for Loops 4, 6, 7, and 8
├── SPEC.md                # Core autonomous connection & diagnostic specification (Loops 1–3)
├── HACKATHON_SHOWCASE.md  # Meta Global AI Developer Hackathon demonstration & video guide
└── package.json           # Extension manifest and build scripts
```

---

## Documentation & Specifications

- [`HACKATHON_SHOWCASE.md`](./HACKATHON_SHOWCASE.md) — Executive summary, multi-project benchmark table, 3-minute demo script, and rubric alignment.
- [`SPEC.md`](./SPEC.md) — Loops 1–3: Autonomous connection intelligence, sensory grounding, and self-healing watchdog.
- [`docs/plans/semantic-attribution.md`](./docs/plans/semantic-attribution.md) — Loop 4: Semantic prompt attribution for dynamic templates.
- [`docs/plans/context-telemetry.md`](./docs/plans/context-telemetry.md) — Loop 6: Context window anatomy & telemetry profiler.
- [`docs/plans/android-device-bridging.md`](./docs/plans/android-device-bridging.md) — Loop 7: Mobile & Android ADB reverse bridging.
- [`docs/plans/context-interrogation-chat.md`](./docs/plans/context-interrogation-chat.md) — Loop 8: Conversational context interrogation & Prompt Co-Pilot.
- [`docs/plans/context-boundaries-scoped-interrogation.md`](./docs/plans/context-boundaries-scoped-interrogation.md) — Visual context boundaries, click-to-scope, and sub-section attribution.

---

## License

Released under the [MIT License](./LICENSE).
