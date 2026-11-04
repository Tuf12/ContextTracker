# Context Tracker — Meta Global AI Developer Hackathon Showcase & Demonstration Guide

> **Submission Track:** Indie Developer Track & Best Agentic Use-Case Award  
> **Problem Statement:** Build for Your World  
> **Core AI Models:** Meta Muse Spark 1.3 & Meta Muse Wonder (Meta Model API)  
> **Extension:** Context Tracker for VS Code & Cursor  
> **Demo Video:** [3-Minute Video Walkthrough (YouTube/Loom)](#)  

---

## 1. Executive Summary & Vision

### 1.1 The Challenge

Modern AI applications are complex and fragmented. When developers build with LLMs—whether using OpenAI, Anthropic, Ollama, vLLM, Chutes, LangChain, or custom HTTP clients—debugging prompt context is painful. Developers are forced to:

- Manually edit `.env` files or hardcode reverse proxies into source code.
- Dig through external user configuration directories (`~/.config/...`, `%APPDATA%`).
- Wonder why an app isn't logging traffic when an in-code default was overridden at runtime.

### 1.2 The Solution: Autonomous Zero-Config Connection

Context Tracker revolutionizes this experience by employing **Meta AI models (Muse Spark 1.3 and Muse Wonder) as the autonomous reasoning engine of the extension**. 

Instead of brittle, hardcoded TypeScript regexes that break across different languages or frameworks, Meta AI:

1. **Inspects the codebase's client architecture** dynamically.
2. **Queries the developer's environment** via sensory machine tools.
3. **Decides where the active runtime endpoint is configured**.
4. **Self-heals autonomously** if traffic bypasses the initial connection attempt.

Developers click **Start capture** and begin debugging immediately. No URLs to type, no ports to configure, and zero residual footprint.

---

## 2. System Architecture & The 3 Interconnected Autonomy Loops

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

- **LLM Client / SDK:** OpenAI SDK, Anthropic SDK, Ollama REST API, Chutes, vLLM, OpenRouter, LangChain, LlamaIndex, or raw HTTP client (`fetch`, `requests`, `axios`, `httpx`, `aiohttp`).
- **Configuration Sourcing Hierarchy:**
  - **Type A (Environment Variables):** `.env`, `process.env`, `os.environ` (e.g. `OPENAI_BASE_URL`, `OLLAMA_HOST`).
  - **Type B (In-Tree Config Files):** `config.yaml`, `settings.json`, `appsettings.json`.
  - **Type C (External User/System Configs):** Files loaded from `$HOME/.config/<app>/...`, `$HOME/.<app>/...`, `%APPDATA%`.
  - **Type D (In-Code Default Fallbacks):** Hardcoded fallback literals in source code (e.g., `const fallback = 'http://127.0.0.1:11434'`).
- **Runtime Precedence Decision Rule:** If an application defines a fallback in source code (Type D) but reads an active configuration from disk (Type B or C), the model recognizes that Type D is inert at runtime and directs the proposal to Type B or C.

### Loop 2: Sensory Tooling & Machine Grounding

To prevent hallucinations and provide ground-truth awareness of the developer's system, Context Tracker provides 6 focused sensory tools:

1. `detect_local_services()`: Fast TCP/socket probes detecting active local AI servers (Ollama on 11434, LM Studio on 1234, vLLM/LocalAI on 8000, Text Generation WebUI on 5000).
2. `find_user_config_dirs(app_hints)`: Discovers user config directories matching the app across `~/.config`, `~/.<name>`, and `%APPDATA%`.
3. `search_text(query | queries)`: Parallel regex and multi-query text search with automated secret redaction.
4. `list_files(path)`: Scans project file tree excluding noisy dependency directories (`node_modules`, `.venv`, `.git`).
5. `read_file(path)`: Reads project files or allowed user config files with strict path-sandboxing and credential redaction (`[private]`).
6. `propose_address(file, url, reason)`: Verified finish tool ensuring verbatim URL existence, non-proxy loop safety, and active config targeting.

### Loop 3: Autonomous Traffic Watchdog & Self-Healing Diagnostic Loop

- **Traffic Watchdog (**`src/watchdog.ts`**):** Monitors outbound requests reaching recorder port `47321`, tracks request count, and maintains heartbeat uptime.
- **Silence Detection:** If capture is active but 0 requests arrive after user activity (or silence timeout), state transitions to `listening_idle` with an upstream warning banner.
- **Autonomous Diagnostic Re-Engagement:** User clicks **"Troubleshoot Connection"** (or watchdog triggers). The Meta AI helper re-activates with failure context (`failedFile`, `failedUrl`, symptom).
- **Self-Healing Resolution:** The helper diagnoses why the previous file was bypassed, discovers the true runtime configuration (e.g. user config file), and presents a **"Switch connection"** proposal with clear explanation.

### Loop 4: Autonomous Semantic Prompt Attribution (Dynamic Prompts & Templates)

- **The Problem:** Modern prompts contain dynamic variable interpolations, Jinja2/Mustache loops, and RAG context chunks that break verbatim character-for-character matching.
- **The Meta AI Solution:** When a prompt message contains dynamic content, the user clicks **"✨ Attribute with Meta AI"** (or it runs autonomously).
- **Agentic Reverse-Engineering:** Meta Muse Spark 1.3 / Muse Wonder inspects the prompt, separates the runtime variable data from the invariant template instructions, executes sensory searches across candidate files, and calls `attribute_prompt` with the verified source file, startLine, and endLine.
- **Interactive Result:** The prompt slice lights up in distinct purple with an attributed badge (`✨ prompts/analyst.prompt · lines 1–5 · Attributed by Meta AI`). Clicking the badge jumps directly to the source code line in the editor.

### Loop 5: Live Agent Thoughts, Sensory Action Feed & Interactive Command Console

- **Real-Time Agent Visibility:** Instead of an opaque loading spinner, developers watch Meta AI think and operate in real time in a dedicated command center.
- **Live Event Streaming:** Streams model reasoning thoughts (`💭 Meta AI Thought`), sensory machine tool invocations (`⚙️ Sensory Tool: detect_local_services()`, `search_text()`), outputs (`📋 Sensory Output`), and verified proposals.
- **Two-Way Developer-Agent Communication:** Features an interactive command bar and quick action chips (`🔍 Find address`, `🔌 Probe local services`, `🩺 Troubleshoot connection`, `✨ Attribute prompt`). Developers can ask questions about how their app connects or instruct Meta AI to investigate specific ports or directories.
- **Sidebar-First Permanent Command Center:**
  - **In the Sidebar:** The Meta AI Helper & Chat console sits permanently right below the compact capture controls. Developers can chat with Meta AI, click quick chips (`🔍 Find address`, `🔌 Probe local services`, `🩺 Troubleshoot connection`, `✨ Attribute prompt`), and watch sensory tools operate in real time. When a prompt is selected, clean view tabs (`[ 🤖 AI Helper ]` / `[ 📄 Prompt Details ]`) allow seamless toggling.
  - **In the Editor Tab:** Clicking "Open in editor tab" expands Context Tracker into a dual-column command center, placing the Meta AI console on the left and the full context window viewer on the right side-by-side.

### Loop 6: Context Window Anatomy & Telemetry (The "What & Why" Profiler)

- **The Problem:** Modern LLM prompts are 10k–50k+ token walls of text combining system guidelines, vector RAG grounding documents, tool calling JSON schemas, few-shot examples, and extensive chat histories. Developers can't easily see what each section is, why it was included, or where token budget is being wasted.
- **The Meta AI Solution:** Meta Muse Spark 1.3 / Muse Wonder performs architectural decomposition and semantic telemetry on the context window in a single batch turn.
- **Two-Tier Intelligence:**
  - **Tier 1 (Instant Local Triage & Caching):** Automatically collapses multi-turn dialogue history backlogs and caches invariant system prompts and tool schemas via SHA-256 fingerprinting for 0ms latency and 0 token cost.
  - **Tier 2 (Meta AI Telemetry Engine):** For novel or dynamic sections, Meta AI identifies the technical identity (**🎯 WHAT**) and prompt engineering rationale (**💡 WHY**), and detects context bloat or conflicting instructions.
- **Visual Telemetry Bar & Anatomy Badges:**
  - **Context Composition Bar:** Proportional segmented bar rendering token budget shares (`[ 25% System ] [ 48% RAG Grounding ] [ 20% History ] [ 7% Query ]`) with interactive click-to-scroll.
  - **Section Anatomy Cards:** Displays category badges (`🟢 System`, `🟣 RAG Grounding`, `🟡 Chat History`, `🔧 Tool Schemas`), token metrics, and `🎯 WHAT` / `💡 WHY` purpose statements.
  - **Loop 6 to Loop 4 Bridge:** Clicking **"✨ Trace in Code"** on an identified RAG or template section instantly activates the Loop 4 sensory harness to locate the exact source code generator in the project.

### Loop 8: Conversational Context Interrogation & Prompt Co-Pilot

- **The Problem:** Modern LLM prompts are massive 10,000–50,000+ token context windows. When a model hallucinates, violates constraints, or costs too much, developers cannot easily spot contradictory rules, needle-in-a-haystack data, or bloated tool schemas by manual inspection.
- **The Meta AI Solution:** Meta Muse Spark 1.3 / Muse Wonder acts as an active, conversational **Prompt Co-Pilot** directly grounded in the captured context window and its Loop 6 semantic anatomy.
- **Context Sensory Tools (No Token Overload):** Rather than naively dumping 50k tokens into every chat completion turn, Meta AI calls dedicated context sensory machine tools on demand:
  - `search_context(query, sectionId?, targetCapture?, caseSensitive?)`: Fast multi-line regex and keyword search across prompt messages or targeted sections.
  - `read_context_section(sectionId, startLine?, maxLines?)`: Paged verbatim inspection of specific context sections with bounds clamping.
  - `inspect_code_template(sectionId)`: Connects the context slice back to source templates in the workspace and extracts dynamic variable slots (`{{ var }}`, `{var}`).
  - `propose_template_patch(file, startLine, endLine, originalCode, replacementCode, explanation, tokenImpactEstimate?)`: Emits concrete, syntax-highlighted diffs to optimize prompt templates or resolve contradictions.
  - `diff_captures()`: Analyzes regression, status differences, token shifts, and RAG divergences between two prompt captures.
- **Interactive Scoping & 1-Click Diagnostics:**
  - **Dynamic Scope Bar:** Lets developers interrogate globally (`[🌐 All Context]`), scope to a section (`[🎯 Section msg-3: RAG Grounding ✕]`), or ask about highlighted text (`[✂️ Selection: 142 chars ✕]`).
  - **1-Click Quick Action Chips:** `🔍 Detect Contradictions`, `✂️ Optimize & Prune`, `🛡️ Scan PII`, `💡 Explain Output`, and `🔄 Compare Captures`.
  - **Closed-Loop Codebase Patching:** When Meta AI spots a prompt bug, it renders an inline **Proposed Patch Card** with syntax-highlighted diff viewer and a `[✅ Apply Patch to Workspace]` button. With one click, VS Code safely applies the patch via `vscode.workspace.applyEdit` with race-condition on-disk content verification.

---

## 3. Multi-Project Demonstration Suite

Context Tracker includes a comprehensive multi-framework demonstration suite (`test/fixtures.test.cjs`) validating zero-config autonomous connection, semantic attribution, and telemetry profiling across diverse frameworks:

| Fixture | Tech Stack | Configuration / Prompt Mechanism | Autonomous Behavior Verified |
| :--- | :--- | :--- | :--- |
| **Project A: OptimalX Desktop** | Electron, Node.js, JavaScript | User Config in `~/.config/optimalx/config.json` | Discovers inert in-tree fallback, probes user config dirs, connects to active user config in 2 turns. |
| **Project B: EidosBot** | Python, YAML, Local AI | `config.yaml` + Local Ollama | Probes local services, identifies Ollama on port 11434, and connects in a single turn. |
| **Project C: Python OpenAI Agent** | Python, OpenAI SDK | `.env` file + `OPENAI_BASE_URL` | Inspects client structure, safely updates `.env` with secret redaction, and restores on stop. |
| **Project D: Next.js Chat App** | Next.js 14 App Router, TypeScript | `settings.json` / OpenRouter | Discovers App Router route handler, detects OpenRouter baseURL, and rewrites upstream cleanly. |
| **Self-Healing Diagnostic Demo** | Multi-file Node/Python app | In-code fallback bypassed | Diagnoses silence on port 47321, investigates user configs, and hot-swaps to active runtime config. |
| **Dynamic Fixture A: Python f-string** | Python 3 | f-string with interpolated customer ID & query | Meta AI isolates invariant compliance rule and attributes dynamic prompt to `src/assistant.py:1-4`. |
| **Dynamic Fixture B: Jinja2 Template** | Jinja2, Python | Template loop with dynamic reviews | Meta AI filters review items, searches for FTC summary directive, and attributes to `templates/review_analyst.jinja2:1-4`. |
| **Dynamic Fixture C: RAG Pipeline** | Vector DB / Knowledge Base | Corporate policy RAG chunks injected into template | Meta AI isolates core policy refusal directive from retrieved chunks, attributing prompt to `prompts/rag_system.prompt:1-3`. |
| **Telemetry Fixture A: 12-Turn Chat** | Multi-turn dialogue | 12-turn chat history + active query | Backlog collapser groups prior turns, calculates 68% token share, and Meta AI flags stale history advisory. |
| **Telemetry Fixture B: RAG Context & Bridge** | Vector DB + RAG Injection | Postgres 16 replica docs + query | Decomposes composite message into RAG grounding + query, generates What/Why, and bridges to Loop 4 Trace in Code. |
| **Telemetry Fixture C: Tool-Calling Schemas** | Function Calling Agent | Complex SQL & Charting JSON schemas | Identifies tool definitions, profiles schema capabilities, and validates 0ms/0-token fingerprint cache reuse. |
| **Co-Pilot Fixture: RAG Interrogation & Patch** | Vector DB, RAG & Templates | Contradictory retrieval vs negative constraint | Meta AI interrogates context with sensory tools, diagnoses contradiction with RAG docs, calls `diff_captures`, proposes safe template patch, and applies to workspace. |

---

## 4. 3-Minute Video Pitch & Walkthrough Script

### **[0:00 - 0:30] Hook & Problem Statement**

- **Visual:** Open VS Code. An LLM agent project is running in a terminal.
- **Presenter (Voiceover):**  
  *"Every model call is built from instructions, conversation history, tools, and sometimes retrieved data. When the answer is wrong, it is hard to see exactly what the model received—or which part of your code put it there.*  
  *Context Tracker captures the request inside VS Code. You inspect the context, and Meta AI traces each piece back to the file it came from.*  
  *Let me show you how it works."*

### **[0:30 - 1:15] The Meta AI Autonomous Brain**

- **Visual:** Click "Start capture" in Context Tracker. The spinner shows *"AI helper is searching"*. Expand the log/details to show Meta Muse Spark tool calls.
- **Presenter (Voiceover):**  
  *"Context Tracker does not guess with hardcoded patterns. Meta AI's Muse Spark 1.3 reads the project and decides how to connect.*  
  *You click Start capture. Meta AI looks through the code, checks for local services like Ollama or vLLM, and searches your config files. It runs those checks at the same time.*  
  *Very quickly, it finds the runtime configuration and starts the recorder on port 47321."*

### **[1:15 - 1:55] Live Prompt Capture, Anatomy Telemetry & Attribution**

- **Visual:** Send a message in the app. Context Tracker intercepts the call and shows the composition bar plus a card for each section of the prompt.
- **Presenter (Voiceover):**  
  *"Let's send a request in the app. Context Tracker catches the call.*  
  *The bar at the top splits the prompt into sections and shows how much of the token budget each one uses. That split follows the app: instructions, chat history, tools, or retrieved data.*  
  *Meta AI labels each section with what it is and why it is there.*  
  *If a section comes from the project, you can jump to the file and line that produced it. When the text was built at runtime, Meta AI traces it back to the source."*

### **[1:55 - 2:30] Autonomous Prompt Co-Pilot, Contradiction Detection & 1-Click Codebase Patching**

- **Visual:** In Context Tracker, click **"🔍 Detect Contradictions"** or click **"💬 Ask AI"** on a RAG Anatomy Card. Meta AI streams reasoning, calls `search_context` and `inspect_code_template`, detects the conflicting instruction, and pops an inline **Proposed Patch Card** with a syntax-highlighted diff preview. Click **"✅ Apply Patch to Workspace"**.
- **Presenter (Voiceover):**  
*"Now for the ultimate feature: **Loop 8 Prompt Co-Pilot**. In real apps, prompts span 30,000+ tokens. When hallucinations occur, developers don't want to read a 50-page wall of text.*  
*We click **'🔍 Detect Contradictions'**. Meta AI uses context sensory tools to cross-reference our system instructions against retrieved RAG documents.*  
*Look at that: Meta AI flags that our system prompt strictly forbade mentioning competitor FooCorp, but our vector database retrieved a FooCorp pricing comparison!*  
*Even better, Meta AI inspects the source template and generates an actionable diff. We click **'Apply Patch to Workspace'**—and Context Tracker patches `support_agent.prompt` directly in VS Code. Observability to resolution in 10 seconds!"*

### **[2:30 - 2:45] Autonomous Self-Healing Diagnostic Loop (Best Agentic Use-Case)**

- **Visual:** Switch to an app with an in-tree default fallback and an external `~/.config` file. Click "Start capture". Watchdog displays *"Listening idle · 0 requests received"*. Click **"Troubleshoot Connection"**.
- **Presenter (Voiceover):**  
*"And if an application has a hidden configuration hierarchy, our Traffic Watchdog detects zero requests and engages the self-healing loop.*  
*Meta AI analyzes the silence, queries* `find_user_config_dirs`*, finds the real user config file, and hot-swaps the connection with one click."*

### **[2:45 - 3:00] Security & Wrap-Up**

- **Visual:** Click "Stop capture". Show `.env` and source code cleanly restored.
- **Presenter (Voiceover):**  
*"Security and privacy are non-negotiable. Context Tracker unconditionally redacts API keys and tokens before sending context to Meta AI, sandboxes all file operations, and automatically restores all modified files when capture stops.*  
*Context Tracker: zero-config, autonomous, and powered by Meta AI. Thanks for watching!"*

---

## 5. Hackathon Rubric Alignment

| Criteria | Target | Implementation in Context Tracker |
| :--- | :--- | :--- |
| **Use of Meta AI Tooling (25%)** | Core Product Brain | Meta Muse Spark 1.3 & Muse Wonder drive all architecture analysis, sensory probing, self-healing diagnostics, semantic prompt attribution (Loop 4), context window anatomy telemetry (Loop 6), and conversational co-pilot context interrogation with direct codebase patching (Loop 8). |
| **Best Agentic Use-Case Award** | Full Multi-Step Autonomy | Autonomous multi-loop agent: connection reconnaissance, sensory environment grounding, self-healing watchdog, dynamic template reverse-engineering, context window semantic profiling, and closed-loop prompt debugging with workspace patching. |
| **Speed to Connect & Attribute** | ≤ 2 turns | Parallel tool calling resolves endpoints, prompt template origins, and context contradictions in 1–2 model turns without human configuration. |
| **Reliability & Grounding** | 0 Hallucinations | Sensory tools (`detect_local_services`, `find_user_config_dirs`, `search_text`, `read_context_section`, `inspect_code_template`) ground the model in real local machine, context window, and codebase state. |
| **Security & Privacy** | 0 Secrets Leaked | Multi-layer regex redaction of keys/passwords, file sandboxing, and zero residual file footprint on stop. |
