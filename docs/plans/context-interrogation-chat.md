# Context Tracker — Conversational Context Interrogation & Prompt Co-Pilot Specification (Loop 8)

## 1. Vision & Problem Statement

### 1.1 The Hackathon Opportunity & Context

Context Tracker is engineered for the **Meta Global AI Developer Hackathon**, targeting the **General Track** and the **$5,000 Best Agentic Use-Case bonus**. 

In previous iterations, Meta AI models (**Muse Spark 1.3** and **Muse Wonder**) established seven interconnected autonomy loops:
- **Loop 1 & 2:** Autonomous connection intelligence and machine sensory grounding.
- **Loop 3:** Self-healing connection watchdog for silent / misrouted traffic.
- **Loop 4:** Autonomous semantic prompt attribution, reverse-engineering dynamic templates (f-strings, Jinja2, YAML) to project source code.
- **Loop 5:** Live reasoning thought streaming, sensory action feed, and interactive developer command console.
- **Loop 6:** Context Window Anatomy & Telemetry (structural decomposition, token budgeting, and "What & Why" profiling).
- **Loop 7:** Autonomous Mobile & Android Device Bridging (ADB reverse tunneling and network security remediation).

### 1.2 The Problem: Passive Observability vs. Active Interrogation

While Loops 1–7 give developers extraordinary observability into *how* an application connects and *what* makes up the prompt, modern real-world LLM context windows frequently span **10,000 to 50,000+ tokens**. 

Once an application emits a massive context window containing multi-document RAG retrievals, 20+ tool schemas, multi-turn chat history, and system instructions, developers hit a wall when debugging:
1. **Root-Cause Inquiries:** *"Why did the model hallucinate in this completion? Did it ignore rule #4, or did the RAG chunk contradict it?"*
2. **Needle-in-a-Haystack Navigation:** In a 30,000 token prompt, finding specific parameter values, user data, or instruction overlaps requires painful manual scrolling.
3. **Context Bloat & Token Waste:** Developers know their prompts cost too much, but cannot easily tell which few-shot examples or history turns can be safely pruned without degrading accuracy.
4. **The Disconnect Between Chat and Code:** When developers chat with generic AI assistants in sidebars, the assistant is **completely blind** to the active runtime context window. Furthermore, even if an assistant identifies an issue, the developer must manually locate the source file and edit the code themselves.

Currently, in `src/app.ts` (`handleHelperMessage`), the Meta AI assistant only receives high-level metadata:
```typescript
this.selected
  ? `Currently Selected Prompt Capture: model=${this.selected.model}, provider=${this.selected.provider}, upstream=${this.selected.upstream}`
  : "No prompt capture currently selected."
```
The model cannot read the prompt messages, inspect the telemetry anatomy, search across sections, or see what dynamic variables were injected.

### 1.3 The Solution: Loop 8 — Conversational Context Interrogation & Prompt Co-Pilot

Loop 8 elevates Meta AI from a passive connection/telemetry utility into a **deeply grounded, conversational Prompt Co-Pilot**:

1. **Context-Grounded Interrogation:** Meta Muse Spark 1.3 / Muse Wonder is directly grounded in the selected prompt capture, its message hierarchy, and its Loop 6 semantic anatomy.
2. **Context Sensory Machine Tools:** Rather than overwhelming the model's token limits by naively dumping 50,000 tokens into every chat message, Meta AI utilizes dedicated **Context Sensory Tools** (`search_context`, `read_context_section`, `inspect_code_template`, `propose_template_patch`) to selectively retrieve and inspect targeted slices on demand.
3. **Flexible Scoping Engine:** Developers can scope their questions globally across the entire context window, focus down to a specific section (e.g. `[🎯 Scope: Section 2 · RAG Grounding (3,400 tokens)]`), or highlight a specific passage in the viewer.
4. **Instant Diagnostic Quick Chips:** One-click automated workflows for common debugging tasks:
   - `🔍 Detect Contradictions`: Identifies conflicts between system instructions and retrieved RAG context.
   - `✂️ Optimize & Prune`: Locates redundant dialogue history or bloated JSON schemas and calculates token savings.
   - `🛡️ Scan PII & Leakage`: Audits prompt for credential leaks, sensitive data, or prompt-injection vulnerabilities.
   - `💡 Explain Output`: Explains which exact context fragment or exemplar triggered the model's completion.
   - `🔄 Compare Captures`: Diff-analyzes why two consecutive prompt captures yielded divergent outputs.
5. **The Closed Loop — Autonomous Codebase Patching:** When Meta AI spots a prompt bug (such as an ambiguous rule in a Jinja template), it uses Loop 4 attribution to locate the exact template file in the workspace and emits a **Propose Patch** action. Developers can click **`[Apply Patch to File]`** to update their code directly from the webview.

---

## 2. System Architecture & Context Tooling Pipeline

```
+---------------------------------------------------------------------------------------+
|                       Selected Prompt Capture (Proxy Recorder)                         |
|  - Messages (System, User, Assistant, Tool definitions)                               |
|  - Telemetry Anatomy (Loop 6: What & Why, Categories, Token Budget)                   |
|  - Attributed Templates (Loop 4: Source File & Line Ranges)                           |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
|                    Context Interrogation Grounding Engine                             |
|  - Structural Skeleton Generator (Token weights, section IDs, categories)              |
|  - Scope Manager (Global vs. Selected Section vs. Highlighted Text vs. Compare Diff)   |
|  - Conversational History Buffer (Multi-turn dialogue memory per capture)              |
+---------------------------------------------------------------------------------------+
                                           |
                   +-----------------------+-----------------------+
                   |                                               |
                   v                                               v
+-------------------------------------+         +-------------------------------------+
| Meta AI Autonomous Reasoning        |         | Context Sensory & Actuation Tools   |
| (Muse Spark 1.3 / Muse Wonder)      |         | (Ground-Truth Context Inspection)   |
+-------------------------------------+         +-------------------------------------+
                   |                                               |
                   | • Contradiction reasoning                     | • search_context(query, sectionId?)
                   | • Prompt optimization & pruning               | • read_context_section(sectionId, …)
                   | • Output attribution                          | • inspect_code_template(sectionId)
                   | • Comparative capture diffing                 | • propose_template_patch(file, …)
                   |                                               | • (All Loop 2 Sensory Tools)
                   +-----------------------+-----------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
|                           Interactive Webview Experience                              |
|  - Chat Console with Active Scope Pill: [🎯 Section 3: RAG Grounding ✕]               |
|  - One-Click Diagnostic Chips: [🔍 Detect Contradictions] [✂️ Optimize] [💡 Explain]  |
|  - Section "Ask Meta AI" & Highlight-to-Scope buttons                                 |
|  - Proposed Patch Card with [Apply Patch to Workspace] Button                         |
+---------------------------------------------------------------------------------------+
```

---

## 3. Sensory Tool Specifications & Contracts

### 3.1 Tool 1: `search_context`
Searches across all messages and sections in the currently selected prompt context (or scopes to a specific `sectionId`) using text matching or regular expressions.

* **Parameters:**
  ```json
  {
    "query": { "type": "string", "description": "Text substring or regex pattern to search for within the context window." },
    "sectionId": { "type": "string", "description": "Optional sectionId (e.g. 'sec_0', 'sec_2') to restrict search to a single section." },
    "caseSensitive": { "type": "boolean", "description": "Whether to perform a case-sensitive match. Defaults to false." }
  }
  ```
* **Return Schema:**
  ```json
  {
    "matchesCount": 3,
    "matches": [
      {
        "sectionId": "sec_1",
        "messageIndex": 0,
        "category": "system_instruction",
        "line": 14,
        "snippet": "...Always format dates as YYYY-MM-DD. Never output timestamps in ISO-8601 format...",
        "charOffset": 412
      },
      {
        "sectionId": "sec_3",
        "messageIndex": 2,
        "category": "rag_grounding",
        "line": 45,
        "snippet": "...document_date: 2026-10-31T14:22:00Z...",
        "charOffset": 1280
      }
    ]
  }
  ```

### 3.2 Tool 2: `read_context_section`
Retrieves verbatim content from a specific section in the captured prompt. Allows paging through long sections without blowing the model's token budget.

* **Parameters:**
  ```json
  {
    "sectionId": { "type": "string", "description": "The ID of the section to read (e.g. 'sec_0', 'sec_1')." },
    "startLine": { "type": "number", "description": "1-based line number to start reading from. Defaults to 1." },
    "maxLines": { "type": "number", "description": "Maximum number of lines to return. Defaults to 100, max 300." }
  }
  ```
* **Return Schema:**
  ```json
  {
    "sectionId": "sec_1",
    "role": "system",
    "category": "system_instruction",
    "totalLines": 85,
    "startLine": 1,
    "endLine": 85,
    "tokens": 1240,
    "content": "You are a customer service assistant...\nRule 1: Always greet warmly...\nRule 2: Never disclose internal account IDs."
  }
  ```

### 3.3 Tool 3: `inspect_code_template`
Bridges the captured context section to its underlying source code template in the developer's workspace using Loop 4's semantic attribution data.

* **Parameters:**
  ```json
  {
    "sectionId": { "type": "string", "description": "The section ID to inspect." }
  }
  ```
* **Return Schema:**
  ```json
  {
    "attributed": true,
    "file": "prompts/support_agent.prompt",
    "startLine": 12,
    "endLine": 35,
    "templateType": "jinja2",
    "templateSource": "You are a {{ agent_role }} assistant.\n{% for doc in documents %}\n- {{ doc.title }}: {{ doc.content }}\n{% endfor %}",
    "runtimeInterpolations": [
      { "variable": "agent_role", "value": "customer service" },
      { "variable": "documents", "count": 4 }
    ]
  }
  ```

### 3.4 Tool 4: `propose_template_patch`
Allows Meta AI to propose a concrete, actionable patch for a source template or code file when it detects prompt bloat, ambiguous rules, or contradictions.

* **Parameters:**
  ```json
  {
    "file": { "type": "string", "description": "Relative workspace path to the file to modify." },
    "startLine": { "type": "number", "description": "1-based start line of the block being replaced." },
    "endLine": { "type": "number", "description": "1-based end line of the block being replaced." },
    "originalCode": { "type": "string", "description": "Original code snippet being replaced." },
    "replacementCode": { "type": "string", "description": "New proposed code or template instructions." },
    "explanation": { "type": "string", "description": "Clear explanation of why this patch fixes the issue or optimizes tokens." },
    "tokenImpactEstimate": { "type": "string", "description": "Estimated token change (e.g. '-450 tokens' or 'neutral')." }
  }
  ```
* **Return Schema:**
  ```json
  {
    "patchId": "patch_1698881234",
    "status": "ready_for_user_approval",
    "file": "prompts/support_agent.prompt",
    "diffPreview": "@@ -14,3 +14,2 @@\n- Rule 4: Never mention competitor products under any circumstance.\n- Rule 4b: If asked about competitors, refer to support.\n+ Rule 4: If asked about competitors, politely refer customer to support without naming competitor products."
  }
  ```

---

## 4. Prompt Engineering & System Grounding

### 4.1 System Prompt: `CONTEXT_COPILOT_SYSTEM`
When the developer interacts with Meta AI while a prompt capture is selected, the system prompt equips the model with:
1. **Context Window Telemetry Skeleton:** Total token count, message breakdown, and category distribution from Loop 6.
2. **Active Scope State:** Whether the developer is asking about the whole prompt, a specific section, or a highlighted snippet.
3. **Execution Directives:**
   - Always verify facts using `search_context` or `read_context_section` before making assertions.
   - For contradiction inquiries, cite the exact line numbers and conflicting wording in both the system guidelines and the dynamic data.
   - For pruning inquiries, calculate specific token reduction estimates and identify low-utility content (e.g. ancient conversation turns, over-specified JSON schemas).
   - If an issue stems from a template in the codebase, call `inspect_code_template` and formulate a clean `propose_template_patch` so the developer can apply the fix with a single click.

```markdown
You are Context Tracker's Prompt Co-Pilot powered by Meta AI models (Muse Spark 1.3 and Muse Wonder).
You possess deep expertise in LLM prompt engineering, context optimization, RAG grounding, and prompt debugging.

Project: {{ projectName }} ({{ projectPath }})
Selected Capture: {{ captureId }}
Model: {{ model }} | Provider: {{ provider }} | Total Estimated Tokens: {{ totalTokens }}

ACTIVE SCOPE:
{{ scopeDescription }}

CONTEXT SKELETON:
{{ contextSkeleton }}

INSTRUCTIONS:
1. Grounding: Never guess what the context contains. Use `search_context` and `read_context_section` to inspect actual prompt content.
2. Contradiction Detection: If investigating conflicting instructions, pinpoint the exact conflicting sentences in both the system instructions and runtime data (RAG/query).
3. Optimization & Pruning: When asked to optimize or compress, identify specific sections (e.g. stale dialogue backlog, excessive schema descriptions), suggest exact deletions, and estimate token savings.
4. Codebase Connection: If the prompt contains a flaw rooted in a source template, call `inspect_code_template` to locate the source code, then call `propose_template_patch` to offer an actionable fix to the developer.
5. Delivery: Deliver your final response via the `respond` tool, presenting clean markdown with specific citations, bullet points, and actionable next steps.
```

---

## 5. User Experience & Webview Interactions

### 5.1 Interactive Scope Bar & Chip
- **Location:** Directly above the chat input in `media/panel.js`.
- **States:**
  - **Global Scope (Default):** `[🌐 All Context (14,280 tokens)]`
  - **Section Scope:** When a user clicks **"💬 Ask AI"** on any Anatomy Card or message header, the scope changes to: `[🎯 Section 2: RAG Grounding (3,400 tokens) ✕]` with a quick clear `✕` button.
  - **Text Selection Scope:** Highlighting text in the prompt viewer reveals a small floating pill: `[💬 Ask about selection]`. Clicking it sets the scope to: `[✂️ Selection: 142 chars ✕]`.
  - **Compare Scope:** When two captures are selected for comparison: `[⚖️ Comparing #1 vs #2 ✕]`.

### 5.2 Contextual Action Chips (1-Click Diagnostics)
Rendered above the input bar whenever a capture is active:
1. `🔍 Detect Contradictions`: Triggers Meta AI to cross-analyze system instructions against RAG grounding and user queries for conflicting directives.
2. `✂️ Optimize & Prune`: Directs Meta AI to audit dialogue turns and schema specifications for token bloat, outputting a prioritized pruning plan.
3. `🛡️ Scan PII & Leakage`: Scans prompt for API keys, unmasked tokens, or prompt-leakage vectors.
4. `💡 Explain Model Output`: Analyzes the model's reply against the prompt context to reveal which grounding documents or instructions determined the answer.
5. `🔄 Compare Captures` *(active when compare capture is selected)*: Analyzes prompt divergence and explains behavioral regression between two turns.

### 5.3 Inline Actionable Patch Cards
When Meta AI calls `propose_template_patch`:
- A clean diff card appears in the chat feed showing:
  - File path with line numbers (`prompts/support_agent.prompt:14-16`).
  - Red/Green syntax-highlighted diff preview.
  - Estimated token impact (`-380 tokens`).
  - Action buttons: **`[Apply Patch to Workspace]`** and **`[Open in Editor]`**.
- Clicking **`[Apply Patch to Workspace]`** uses VS Code's `vscode.workspace.applyEdit` to modify the file safely, saves the document, and displays a success confirmation badge.

---

## 6. Phased Implementation Plan

### Phase 1: Context Sensory Engine & Tool Infrastructure
* **1.1 Data Models & Type Definitions (`src/types.ts`):**
  - Define `ContextScope` (`global`, `section`, `selection`, `compare`).
  - Define `ContextQueryResult`, `ContextSectionMatch`, and `TemplatePatchProposal`.
  - Update `HelperView` and `CaptureView` to track active scope and conversational thread state.
* **1.2 Context Sensory Tools Implementation (`src/contextTools.ts`):**
  - Implement `search_context`: Fast multi-line regex and substring search over capture messages.
  - Implement `read_context_section`: Paged section reader with bounds checking and token estimates.
  - Implement `inspect_code_template`: Connects section fingerprint/attribution to workspace source files via Loop 4.
  - Implement `propose_template_patch`: Validates file existence and formats code diff proposals.
* **1.3 Unit Tests (`test/contextTools.test.cjs`):**
  - Fast, isolated unit tests validating search accuracy, section pagination, and patch formatting without spinning up external servers.

### Phase 2: Autonomous Meta AI Grounding & Conversational Engine
* **2.1 Grounded Prompt Construction (`src/helperTools.ts`):**
  - Build `buildContextSkeleton(capture)` to generate token-efficient summaries of all sections.
  - Formulate `CONTEXT_COPILOT_SYSTEM` prompt dynamically injecting the skeleton and active scope.
  - Implement quick-prompt builders for one-click chips (`detect_contradictions`, `optimize_context`, `scan_pii`, `explain_output`, `compare_captures`).
* **2.2 Conversational State & Harness Integration (`src/app.ts`):**
  - Update `handleHelperMessage` to detect active capture scope and attach context sensory tools alongside Loop 2 sensory tools.
  - Maintain a multi-turn conversation thread per capture so developers can ask follow-up questions.
  - Wire `respond` and `propose_template_patch` outcomes into webview activity stream.
* **2.3 Fast Contract Tests (`test/contextCopilot.test.cjs`):**
  - Test Meta Muse Spark 1.3 / Muse Wonder tool-selection flows against mocked multi-section capture scenarios.

### Phase 3: Webview UI & Interactive Scoping Experience
* **3.1 Scope Bar & Quick Chips (`media/panel.js`, `media/panel.css`):**
  - Add interactive Scope Pill in the chat header with dismissal icon (`✕`).
  - Render contextual quick-action chips (`🔍 Detect Contradictions`, `✂️ Optimize & Prune`, `🛡️ Scan PII`, `💡 Explain Output`).
* **3.2 Section & Selection Action Hooks:**
  - Add **"💬 Ask AI"** buttons to Anatomy Cards and Message headers.
  - Add floating **"Ask Meta AI about selection"** tooltip when text is selected in the prompt body.
* **3.3 Interactive Patch Proposal Card:**
  - Render diff preview cards in the activity feed with color-coded additions/deletions.
  - Wire `applyPatch` post-message back to extension backend.

### Phase 4: Actionable Codebase Patching & Workspace Application
* **4.1 Workspace Edit Actuator (`src/app.ts`):**
  - Implement `applyTemplatePatch(patchId)` using `vscode.workspace.applyEdit`.
  - Validate file content matches `originalCode` before applying to prevent race-condition overwrites.
  - Show VS Code notification and record confirmation in chat feed.
* **4.2 Comparative Capture Interrogation:**
  - When `compareId` is selected, enable cross-capture diffing and question answering (*"Why did turn 2 fail while turn 1 succeeded?"*).

### Phase 5: Hackathon Showcase & Verification
* **5.1 Showcase Documentation (`HACKATHON_SHOWCASE.md`):**
  - Document Loop 8 as the interactive climax of Context Tracker.
  - Detail how Meta AI acts as an autonomous co-pilot bridging runtime observability to workspace code generation.
* **5.2 Fixture Demonstrations:**
  - Add a demonstration scenario in `test/fixtures.test.cjs` verifying context inquiry, contradiction detection, and patch proposal on a representative RAG app.

---

## 7. Safety, Redaction & Machine Guardrails

1. **Strict Context Redaction:**
   - Any sensitive secrets, bearer tokens, or private keys discovered during `search_context` or `read_context_section` pass through Context Tracker's `redactText` filter before reaching the Meta AI model.
2. **Deterministic Workspace Edit Safety:**
   - Patches proposed by Meta AI require explicit developer confirmation via the `[Apply Patch to Workspace]` button.
   - Edits verify exact line and text matches (`originalCode`) before applying, cleanly aborting if the local file has diverged.
3. **Hardware-Safe Execution:**
   - Per project guidelines, all test suites run on mocked child processes and deterministic stubs, avoiding heavy continuous model-execution loops that strain the host PC.

---

## 8. Hackathon Evaluation Alignment

| Contest Dimension | Weight | Loop 8 Contribution |
| :--- | :--- | :--- |
| **Best Agentic Use-Case ($5,000 Bonus)** | Primary Target | Meta AI acts as an active, conversational co-pilot: it inspects live context windows, detects semantic contradictions, optimizes token budgets, and proposes direct source code patches to the workspace. |
| **Use of Meta AI Tooling** | 25% | Deeply leverages Meta Muse Spark 1.3 and Muse Wonder with advanced multi-tool parallel calling (`search_context`, `read_context_section`, `inspect_code_template`, `propose_template_patch`). |
| **Utility & Technical Execution** | 25% | Solves the hardest problem in LLM development: debugging 50k+ token context bloat and hallucination causes without manual reading. |
| **User Experience & Completeness** | 25% | Seamless end-to-end loop: Capture prompt &rarr; View telemetry &rarr; Scope chat to section &rarr; One-click diagnose contradictions &rarr; One-click patch codebase. |
