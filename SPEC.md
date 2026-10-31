# Context Tracker — Autonomous Meta AI Connection & Diagnostic Specification

## 1. Vision & Problem Statement

### 1.1 The Contest Opportunity
Context Tracker is built for the **Meta Global AI Developer Hackathon**. Its mission is to make inspecting, tracking, and debugging LLM prompts effortless across arbitrary codebases. The core differentiator is **leveraging Meta AI models (Muse Spark 1.3 and Muse Wonder) as an autonomous reasoning engine** that connects any coding project to Context Tracker without requiring the user to edit `.env` files, reconfigure settings, or understand reverse proxies.

### 1.2 Anti-Pattern to Avoid: Fragile Hardcoding
Relying on hand-crafted TypeScript heuristics (e.g. language-specific regexes or static directory path checks) is brittle. It may solve one specific project today, but fails whenever a developer uses a different language (Python, Go, Rust, Java), a different configuration library (`pydantic-settings`, Viper, `figment`), or an unexpected architecture.

### 1.3 Core Architectural Principle
**The Meta AI Helper is the autonomous brain of the extension.** 
Instead of TypeScript guessing project structure, the Meta AI model:
1. Inspects the codebase's client architecture.
2. Queries the environment via sensory tools.
3. Decides where the true runtime endpoint is configured.
4. Monitors connection status and autonomously self-heals when a connection attempt is missed.

---

## 2. System Architecture & Autonomy Model

The autonomous system operates across three interconnected loops:

```
+-------------------------------------------------------------------------------+
|                       Context Tracker Extension Core                          |
+-------------------------------------------------------------------------------+
                                    |
          +-------------------------+-------------------------+
          |                                                   |
          v                                                   v
+-----------------------+                           +-------------------+
| Architecture Analysis |                           | Sensory Tooling   |
| (Muse Spark / Wonder) |                           | & Environment     |
+-----------------------+                           +-------------------+
          |                                                   |
          +-------------------------+-------------------------+
                                    |
                                    v
                        +-----------------------+
                        |  Autonomous Proposal  |
                        |      & Rewriting      |
                        +-----------------------+
                                    |
                                    v
                        +-----------------------+
                        |   Traffic Watchdog    |
                        |  & Self-Healing Loop  |
                        +-----------------------+
```

### Loop 1: Architecture Discovery & Static Intelligence
The helper analyzes the project's codebase to classify:
* **LLM Client / SDK:** OpenAI SDK, Anthropic SDK, Ollama REST API, Chutes, vLLM, OpenRouter, LangChain, LlamaIndex, or raw HTTP client (`fetch`, `requests`, `axios`, `httpx`).
* **Configuration Sourcing Hierarchy:**
  1. *Type A (Environment Variables):* `.env`, `process.env`, `os.environ` (e.g. `OPENAI_BASE_URL`, `OLLAMA_HOST`).
  2. *Type B (In-Tree Config Files):* `config.yaml`, `settings.json`, `appsettings.json`.
  3. *Type C (External User/System Configs):* Files loaded from `$HOME/.config/<app>/...`, `$HOME/.<app>/...`, `%APPDATA%`, etc.
  4. *Type D (In-Code Instantiations):* Hardcoded default fallbacks in source code (e.g., `const fallback = 'http://127.0.0.1:11434'`).
* **Runtime Decision Rule:** If an application defines a fallback in source code (Type D) but reads an active configuration from disk (Type B or C), the model recognizes that Type D is inert at runtime and directs the redirect to Type B or C.

### Loop 2: Sensory Tooling & Machine Grounding
To prevent hallucinations and give the Meta model ground-truth awareness of the developer's system, the harness provides 6 focused tools:

1. `search_text(query | queries)`:
   * Regex and multi-term search across the project.
   * Redacts secrets, tokens, and private keys automatically.
   * Returns line-numbered references.

2. `list_files(path)`:
   * Explores project directory structure, excluding noise (`node_modules`, `.git`, `dist`, `.venv`, etc.).

3. `read_file(path)`:
   * Reads any project file or permissible user config file (`~/.config/...`).
   * Redacts secret lines with `[private]`.
   * Enforces path safety (blocks `.ssh`, `.aws`, `.cursor`, `.pem`, etc.).

4. `find_user_config_dirs(app_hints: string[])`:
   * Grounding tool: checks `$HOME/.config`, `$HOME`, and `%APPDATA%` for configuration directories matching the app's name or package identifier.
   * Returns actual directories and existing config files found on disk so the model does not have to guess.

5. `detect_local_services()`:
   * Checks which common local AI servers are actively listening on the machine:
     - Ollama (`http://127.0.0.1:11434`)
     - LM Studio (`http://127.0.0.1:1234`)
     - vLLM / LocalAI (`http://127.0.0.1:8000`)
     - Text Generation WebUI (`http://127.0.0.1:5000`)
   * Gives the model certainty when evaluating local vs. cloud endpoints.

6. `propose_address(file, url, reason)`:
   * Finish tool: signals that the model has identified the exact file and URL.
   * Validates that the URL exists verbatim in the file.
   * Ensures the URL is not port `47321` (prevents self-proxy loops).

### Loop 3: Autonomous Diagnostic & Self-Healing Loop
When capture is armed, Context Tracker's recorder server listens on `127.0.0.1:47321`.
* **Traffic Watchdog:** Context Tracker tracks whether outbound requests from the app hit port `47321`.
* **Silence Detection:** If capture is active and the user reports or the extension observes that a prompt did not arrive, the user can click **"Troubleshoot Connection"** (or an autonomous watchdog fires).
* **Diagnostic Re-Engagement:** The Meta AI helper re-activates with a diagnostic prompt:
  ```
  "Capture was armed pointing to {previous_file} ({previous_url}), but an application 
  message was sent and bypassed the recorder. 
  
  Diagnose why the application did not use {previous_file}. 
  Investigate alternative configuration paths, runtime overrides, or user config files, 
  and propose the true active connection address."
  ```
* **Self-Healing Resolution:** The helper investigates, identifies the bypassed mechanism, and proposes the corrected address.

---

## 3. Security, Privacy & Safety Guarantees

1. **Secret & Credential Redaction:**
   * API keys, tokens, auth headers, and passwords are unconditionally replaced with `[private]` before files or search results are sent to Meta.
   * `.env` files, `.pem` keys, and credentials files are never uploaded in full.
2. **Path Sandboxing:**
   * Reads outside the workspace are strictly restricted to non-sensitive user config paths (`~/.config/...`, `%APPDATA%`).
   * System directories (`/etc`, `/root`), SSH keys (`~/.ssh`), and IDE/agent storage (`~/.cursor`) are blocked.
3. **Safe Rollback & Zero Residual Footprint:**
   * Any file modified for redirection is backed up in extension storage before alteration.
   * On "Stop capture", extension deactivate, or window reload, original file states are restored automatically.
4. **Proxy Loop Prevention:**
   * Recorder port `47321` is never accepted as an upstream target.

---

## 4. Phased Implementation Plan

### Phase 1: Environment Grounding Tools
**Objective:** Give the Meta model sensory tools to inspect local machine context without guesswork.
* **1.1 `detect_local_services` Tool:**
  - Implement a fast socket/HTTP probe for ports `11434` (Ollama), `1234` (LM Studio), `8000` (vLLM/LocalAI), and `5000`.
  - Return listening services and status to the helper.
* **1.2 `find_user_config_dirs` Tool:**
  - Implement discovery across `~/.config`, `~/.<name>`, and `%APPDATA%` based on project name, `package.json` name, or app hints.
  - Return list of valid config files on disk.
* **1.3 Tests:**
  - Add unit tests verifying probe timeouts and config directory resolution.

### Phase 2: Autonomous Architecture Analysis Prompting
**Objective:** Upgrade the Meta model's system prompt and reasoning flow to classify architecture rather than doing blind string matching.
* **2.1 Enhanced System Prompt:**
  - Guide the model on client classification (OpenAI, Anthropic, Ollama, Chutes, custom HTTP).
  - Instruct the model to query `detect_local_services` and `find_user_config_dirs` when analyzing startup sequences.
  - Prioritize active runtime configuration files over static in-code fallbacks.
* **2.2 Parallel Tool Calling Guidance:**
  - Prompt Muse Spark 1.3 / Muse Wonder to batch searches and file inspections into parallel calls.
* **2.3 Verification:**
  - Test helper runs on test repositories with single-turn resolution.

### Phase 3: Traffic Watchdog & Missed Connection Detection
**Objective:** Provide real-time feedback when an app is running but bypassing Context Tracker.
* **3.1 Capture Heartbeat & Traffic State:**
  - Add request counter and timer since capture started.
  - If capture is active but 0 requests arrive after user activity, transition recorder state to `listening_idle`.
* **3.2 UI Action:**
  - Add a **"Troubleshoot Connection"** button in the Capture card when capture is running.
  - Show a clear hint if the app might still be pointing directly to upstream.

### Phase 4: Autonomous Self-Healing Diagnostic Loop
**Objective:** Allow the AI helper to diagnose and fix failed connections autonomously.
* **4.1 Diagnostic Harness Mode:**
  - Create `diagnoseConnection(project, failedEndpoint)` in `src/app.ts`.
  - Inject diagnostic context: which file was rewritten, what address was used, and the failure symptom.
* **4.2 Self-Correction Proposal:**
  - Helper inspects secondary targets, identifies runtime precedence, and returns an updated `AddressOffer`.
  - UI updates offer card with explanation: *"Helper found that the app loaded settings from X instead of Y. Click to switch connection."*
* **4.3 Tests:**
  - Test that the diagnostic loop correctly pivots from a source fallback to a user config file.

### Phase 5: Multi-Project Hackathon Demonstration Suite
**Objective:** Validate that Context Tracker autonomously connects across multiple diverse AI frameworks.
* **5.1 Test Fixtures:**
  - Project A: Electron / Node app with user config (OptimalX Desktop).
  - Project B: Python app with local Ollama (`config.yaml` / EidosBot).
  - Project C: Python app with `.env` / OpenAI SDK.
  - Project D: Next.js / TypeScript app with `OPENAI_BASE_URL`.
* **5.2 Showcase Documentation & Video Script:**
  - Document zero-config autonomous connection for hackathon judges.
  - Highlight Meta Muse model agentic tool-use and self-healing diagnostics.

---

## 5. Success Metrics for Hackathon Evaluation

| Metric | Target | Measurement |
| :--- | :--- | :--- |
| **Autonomy** | 100% hands-free | User never types a URL, port, or edits code manually. |
| **Speed to Connect** | ≤ 2 turns | Helper identifies the correct endpoint in 1–2 model turns. |
| **Self-Healing** | Successful recovery | If an app bypasses capture, the diagnostic loop correctly identifies the active file on Turn 1. |
| **Security** | 0 secrets leaked | No API key, token, or private file content ever leaves the local machine. |
