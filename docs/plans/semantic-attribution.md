# Context Tracker — Autonomous Semantic Prompt Attribution & Asset Grounding Specification

## 1. Vision & Problem Statement

### 1.1 The Contest Opportunity
Context Tracker is built for the **Meta Global AI Developer Hackathon**. In the initial phase, **Meta AI models (Muse Spark 1.3 and Muse Wonder)** were integrated as an autonomous connection engine to detect endpoints, probe local services, and self-heal missed connections.

However, once prompt traffic arrives at the capture proxy, a fundamental limitation of exact-string matching appears in real-world AI applications:
- **Dynamic Interpolation:** Prompts are rarely static string literals. They use f-strings, template variables, or runtime state (`f"You are an assistant for {user}. Task: {task}"`).
- **Template Engines:** Prompts are constructed via Jinja2, Mustache, LangChain `PromptTemplate`, or YAML definitions.
- **RAG & Context Injection:** Large blocks of dynamic context (vector search chunks, SQL queries, user chat history) break multi-line verbatim line runs.

Because Context Tracker's passive matcher (`matcher.ts`) requires consecutive verbatim line matches (minimum 48 chars or 2+ consecutive lines), **dynamic prompts produce 0 file spans**, leaving the captured context window disconnected from the source code.

### 1.2 The Solution: Meta AI Autonomous Semantic Attribution
Rather than relying solely on brittle exact-line heuristics, **Meta AI acts as the semantic attribution engine**:
1. When a captured prompt arrives without exact file matches (or when requested by the developer), the Meta AI helper is engaged.
2. The model analyzes the prompt, distinguishes **dynamic runtime variables** (user queries, timestamps, database chunks) from **invariant template instructions**.
3. It formulates targeted queries to search the codebase with `search_text`.
4. It inspects candidate files with `read_file` and identifies the exact template file or builder function that generated the prompt.
5. It returns verified file and line coordinates via an `attribute_prompt` tool, seamlessly highlighting the prompt in Context Tracker and linking it to the editor.

This directly elevates Meta AI from a one-time connection wizard to the **central intelligence of the product during actual usage**, directly targeting the **25% Use of Meta AI Tooling** scoring category and the **$5,000 Best Agentic Use-Case bonus**.

---

## 2. System Architecture & Data Flow

```
+-------------------------------------------------------------------------------+
|                       Captured Context Window (Proxy)                         |
+-------------------------------------------------------------------------------+
                                    |
          +-------------------------+-------------------------+
          |                                                   |
          v (Exact Match Available)                           v (0 Spans or Dynamic)
+-----------------------+                           +-------------------+
| Passive Text Matcher  |                           | Meta AI Semantic  |
|     (matcher.ts)      |                           | Attribution Engine|
+-----------------------+                           +-------------------+
          |                                                   |
          |                                     +-------------+-------------+
          |                                     |                           |
          |                                     v                           v
          |                           +-------------------+       +-------------------+
          |                           | Skeleton Filter   |       | Sensory Searches  |
          |                           | & Template Analysis|      | (search_text /    |
          |                           +-------------------+       |  read_file)       |
          |                                     |                 +-------------------+
          |                                     +-------------+-------------+
          |                                                   |
          |                                                   v
          |                                       +-----------------------+
          |                                       | attribute_prompt Tool |
          |                                       |   (File & Line Span)  |
          |                                       +-----------------------+
          |                                                   |
          +-------------------------+-------------------------+
                                    |
                                    v
                        +-----------------------+
                        | Integrated File Spans |
                        | (View & Editor Jump)  |
                        +-----------------------+
```

### 2.1 The Two-Layer Attribution Pipeline
1. **Layer 1: Expanded Static Indexing (`indexer.ts`)**
   - Automatically indexes all prompt asset formats: `.prompt`, `.template`, `.jinja`, `.j2`, `.mustache`, `.hbs`, `.yaml`, `.yml`, `.json`.
   - Recognizes dedicated prompt directories (`prompts/`, `templates/`, `.github/prompts/`) and external discovered configuration prompt paths.
2. **Layer 2: Agentic Attribution Loop (`ATTRIBUTION_SYSTEM` & `attribute_prompt`)**
   - Meta AI (Muse Spark / Wonder) reads the prompt message.
   - It strips dynamic variable slots and identifies invariant anchor phrases.
   - It runs parallel searches across project files using `search_text`.
   - It confirms the source location using `read_file` and calls `attribute_prompt`.
   - The result is attached to the capture as an attributed span (`source: "attributed"`) and displayed with an AI attribution badge in the UI.

---

## 3. Security, Privacy & Safety Guarantees

1. **Secret & Key Redaction:**
   - Any prompt content or search query inspected by Meta AI is pre-processed with `redactText()` to guarantee API keys, tokens, or auth headers are replaced with `[private]`.
2. **Path Sandboxing:**
   - Attribution tools only resolve files strictly within the project root or allowed user config directories.
3. **No Hallucinated Spans:**
   - `attribute_prompt` validates that the proposed file exists on disk and the specified line numbers exist within the file bounds before accepting the attribution.

---

## 4. Phased Implementation Plan

### Phase 1: Template Asset Scope & Indexer Expansion
**Objective:** Ensure all template and prompt asset files in the project are indexed and discoverable.
* **1.1 Extension List Expansion:**
  - Add `.prompt`, `.template`, `.jinja`, `.j2`, `.mustache`, `.hbs` to `EXTENSIONS` in `src/indexer.ts`.
* **1.2 Directory Scanning & Unindexed Asset Support:**
  - Support dedicated prompt directories and ensure template files are not accidentally excluded by `SKIP_FILES` or size limits.
* **1.3 Unit Tests:**
  - Add unit tests in `test/indexer.test.cjs` (or `test/trace.test.cjs`) verifying indexing of Jinja2 and `.prompt` template files.

### Phase 2: Autonomous Semantic Attribution Prompting & Tools
**Objective:** Provide Meta Muse models with specialized attribution instructions and verification tools.
* **2.1 `attribute_prompt` Tool:**
  - Implement finish tool: `attribute_prompt(file, startLine, endLine, confidence, explanation, matchedSnippet)`.
  - Validate that the file exists, line numbers are valid, and the matched snippet corresponds to the code.
* **2.2 `ATTRIBUTION_SYSTEM` System Prompt:**
  - Instruct Meta Muse Spark 1.3 / Muse Wonder on reverse-engineering prompt origins:
    - Identify static instructions vs dynamic slots (user queries, timestamps, database chunks).
    - Formulate high-specificity search queries targeting invariant phrases.
    - Leverage parallel tool calling to search and read candidate files in a single turn.
* **2.3 `buildAttributionUserPrompt`:**
  - Formats the captured prompt message, role (`system`, `user`, `assistant`), and project context into a structured diagnostic prompt.
* **2.4 Tests:**
  - Unit tests verifying tool execution and harness completion.

### Phase 3: Extension Pipeline & Span Integration
**Objective:** Connect attribution results to the capture store and presentation pipeline.
* **3.1 Type Definitions (`src/types.ts`):**
  - Add `"attributed"` to `SpanSource` type (`"matched" | "reported" | "attributed"`).
  - Add attribution metadata (`confidence`, `explanation`) to `ViewSpan` and `StoredCapture`.
* **3.2 Attribution Service (`src/app.ts`):**
  - Implement `attributeCaptureMessage(captureId, messageIndex)` in `TrackerApp`.
  - Wire harness execution with active Meta AI model and API key.
  - Merge attributed spans into `capture.reported` or a dedicated `attributedSpans` map.
* **3.3 Matcher Derivation (`src/matcher.ts` & `src/derive.ts`):**
  - Integrate attributed spans into `deriveMessageSpans` so they render alongside exact matches without collision.
* **3.4 Tests:**
  - Unit tests verifying span merging and persistence across store reloads.

### Phase 4: UI Actions & Interactive Attribution Badges
**Objective:** Expose attribution controls and visual feedback in the Webview panel.
* **4.1 Webview Actions (`media/panel.js`):**
  - When a message in the context window has `spans.length === 0` (or no file spans), display an **"Attribute with Meta AI"** button.
  - Provide a loading state while Meta AI investigates the codebase.
* **4.2 Visual Badges & Tooltips (`media/panel.css`):**
  - Add distinctive styling for AI-attributed spans (e.g. subtle purple/Meta badge or sparkle icon).
  - Tooltip shows: *"Attributed by Meta AI: [explanation]"*.
  - Clicking the span opens the source file at the attributed line numbers.

### Phase 5: Dynamic Prompt Test Fixtures & Video Script Update
**Objective:** Validate end-to-end attribution on diverse dynamic prompts and document for judges.
* **5.1 Test Fixtures:**
  - Fixture A: Python f-string with interpolated variables and dynamic user input.
  - Fixture B: Jinja2 template prompt with loops and conditional blocks.
  - Fixture C: RAG pipeline injecting dynamic context snippets into a system instruction template.
* **5.2 Showcase Documentation & Script Update:**
  - Update `HACKATHON_SHOWCASE.md` with the Semantic Attribution story.
  - Detail the agentic prompt-to-code reverse-engineering workflow for the **$5,000 Best Agentic Use-Case bonus**.

---

## 5. Success Metrics for Hackathon Evaluation

| Metric | Target | Measurement |
| :--- | :--- | :--- |
| **Attribution Resolution** | ≤ 2 turns | Meta AI identifies the template/builder file within 1–2 model turns. |
| **Dynamic Robustness** | 100% on tested fixtures | Attributed spans resolve accurately even when 50%+ of prompt tokens are dynamic variables. |
| **Zero User Overhead** | Hands-free click | One click (or autonomous trigger) without manual file selection or code modifications. |
| **Secret Safety** | 0 secrets leaked | All prompt queries and inspected code redact sensitive keys with `[private]`. |
