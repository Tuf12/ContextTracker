# Context Tracker — Meta Global AI Developer Hackathon Showcase & Demonstration Guide

> **Submission Track:** Best Agentic Use-Case ($5,000 Bonus) & General Track  
> **Core AI Models:** Meta Muse Spark 1.3 & Meta Muse Wonder (Meta Model API)  
> **Extension:** Context Tracker for VS Code & Cursor  

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
- **Traffic Watchdog (`src/watchdog.ts`):** Monitors outbound requests reaching recorder port `47321`, tracks request count, and maintains heartbeat uptime.
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


---

## 3. Multi-Project Demonstration Suite

Context Tracker includes a comprehensive multi-framework demonstration suite (`test/fixtures.test.cjs`) validating zero-config autonomous connection and semantic attribution across diverse frameworks:

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

---

## 4. 3-Minute Video Pitch & Walkthrough Script

### **[0:00 - 0:30] Hook & Problem Statement**
- **Visual:** Open VS Code. An LLM agent project is running in a terminal.
- **Presenter (Voiceover):**  
  *"Building AI applications is exciting, but debugging LLM prompts is still surprisingly primitive. You send a message, get an unexpected answer, and ask: 'What exact prompt did my code send to the model?'*  
  *Normally, getting answers means manually editing `.env` files, setting up mitmproxy, or hardcoding localhost URLs into your code. It's tedious, fragile, and leaks API keys.*  
  *Meet **Context Tracker**—the zero-config prompt recorder powered by Meta AI."*

### **[0:30 - 1:15] The Meta AI Autonomous Brain**
- **Visual:** Click "Start capture" in Context Tracker. The spinner shows *"AI helper is searching"*. Expand the log/details to show Meta Muse Spark tool calls.
- **Presenter (Voiceover):**  
  *"Context Tracker doesn't use hardcoded regexes or rigid assumptions. Instead, we use Meta AI's Muse Spark 1.3 and Muse Wonder as an autonomous reasoning engine.*  
  *When you click Start capture, Meta AI inspects the codebase architecture, queries our sensory tools to detect active local services like Ollama or vLLM, searches for external user config directories, and batches its reconnaissance using parallel tool calling.*  
  *In under two seconds, Meta AI identifies the exact runtime configuration and arms our recorder on port 47321."*

### **[1:15 - 1:55] Live Prompt Capture & Autonomous Semantic Attribution**
- **Visual:** Send a chat message in the demo app containing dynamic user data and retrieved context. Context Tracker captures the call. The prompt has dynamic slots. Click **"✨ Attribute with Meta AI"**.
- **Presenter (Voiceover):**  
  *"Let's send a chat message in our app. Boom! Context Tracker intercepts the request, streams the model's response back to the app without adding latency, and inspects the prompt.*  
  *Now look at this: in real-world apps, prompts aren't static copy-pasted strings. They use dynamic templates, f-strings, and RAG context chunks. Traditional regex matchers completely fail here.*  
  *Watch this: we click **'Attribute with Meta AI'**. Meta's Muse Spark immediately reverse-engineers the prompt, strips the dynamic user variables, searches the codebase for the invariant instruction skeleton, and tags it: `prompts/analyst.prompt lines 1 to 5`.*  
  *Click the badge, and VS Code jumps directly to the source code line where that prompt template was defined!"*

### **[1:55 - 2:35] Autonomous Self-Healing Diagnostic Loop ($5,000 Best Agentic Use-Case)**
- **Visual:** Switch to an app with an in-tree default fallback and an external `~/.config` file. Click "Start capture". Watchdog displays *"Listening idle · 0 requests received"*. Click **"Troubleshoot Connection"**.
- **Presenter (Voiceover):**  
  *"Now, what happens if an app has a hidden configuration hierarchy—for instance, a default URL in source code, but an active config file in the user's home directory?*  
  *Our Traffic Watchdog detects that capture is armed but zero requests arrived. When we click 'Troubleshoot Connection', the Meta AI diagnostic loop engages.*  
  *Meta AI analyzes the failure, recognizes that the in-code default was bypassed, queries `find_user_config_dirs`, and discovers the true active configuration in `~/.config/optimalx/config.json`.*  
  *With one click on 'Switch connection', capture is redirected and prompts flow immediately. That's true autonomous self-healing."*

### **[2:35 - 3:00] Security & Wrap-Up**
- **Visual:** Click "Stop capture". Show `.env` and source code cleanly restored.
- **Presenter (Voiceover):**  
  *"Security and privacy are non-negotiable. Context Tracker unconditionally redacts API keys and tokens before sending context to Meta AI, sandboxes all file operations, and automatically restores all modified files when capture stops.*  
  *Context Tracker: zero-config, autonomous, and powered by Meta AI. Thanks for watching!"*

---

## 5. Hackathon Rubric Alignment

| Criteria | Target | Implementation in Context Tracker |
| :--- | :--- | :--- |
| **Use of Meta AI Tooling (25%)** | Core Product Brain | Meta Muse Spark 1.3 & Muse Wonder drive all architecture analysis, sensory probing, self-healing diagnostics, and semantic prompt attribution. |
| **Best Agentic Use-Case ($5,000 Bonus)** | Full Multi-Step Autonomy | Autonomous multi-loop agent: reconnaissance, sensory environment grounding, self-healing watchdog, and dynamic template reverse-engineering. |
| **Speed to Connect & Attribute** | ≤ 2 turns | Parallel tool calling resolves endpoints and prompt template origins in 1–2 model turns without human configuration. |
| **Reliability & Grounding** | 0 Hallucinations | Sensory tools (`detect_local_services`, `find_user_config_dirs`, `search_text`) ground the model in real local machine and codebase state. |
| **Security & Privacy** | 0 Secrets Leaked | Multi-layer regex redaction of keys/passwords, file sandboxing, and zero residual file footprint on stop. |
