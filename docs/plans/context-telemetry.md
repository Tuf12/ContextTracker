# Context Tracker — Context Window Anatomy & Telemetry Specification (Loop 6)

## 1. Vision & Problem Statement

### 1.1 The Contest Opportunity

Context Tracker is engineered for the **Meta Global AI Developer Hackathon**, competing for the **General Track** and the **$5,000 Best Agentic Use-Case bonus**. 

In previous iterations, Meta AI models (**Muse Spark 1.3** and **Muse Wonder**) were established as:

- **Loop 1 & 2:** Autonomous connection intelligence and machine sensory grounding.
- **Loop 3:** Self-healing connection watchdog for silent / misrouted traffic.
- **Loop 4:** Autonomous semantic prompt attribution, reverse-engineering dynamic templates (f-strings, Jinja2, YAML) to project source code.
- **Loop 5:** Live reasoning thought streaming, sensory action feed, and interactive developer command console.

However, modern real-world LLM applications (built with LangChain, LlamaIndex, AutoGen, Claude Code, Cursor, or custom RAG agents) do not send simple single-sentence prompts. They emit **massive 5,000 to 50,000+ token context windows** packed with disparate components:

- System personality definitions and safety instructions.
- Dynamic Retrieval-Augmented Generation (RAG) vector database snippets.
- Complex JSON and Pydantic function/tool calling schemas.
- Extensive multi-turn chat history backlogs.
- Few-shot exemplars and formatting guardrails.

### 1.2 The Problem: The "Context Wall"

When developers inspect these captured context windows in Context Tracker, they encounter a daunting wall of text. They are left asking critical questions:

1. **What is each section?** Is this 2,000-word block a RAG document, conversational memory, or hardcoded system instructions?
2. **Why is it here?** What prompt-engineering or behavioral purpose does this specific block serve for the model completion?
3. **Where is my token budget going?** How much of my context window is consumed by stale conversational backlog versus critical grounding data?
4. **Is there bloat or contradiction?** Are there outdated history turns or contradictory instructions diluting the model's attention?

### 1.3 The Solution: Loop 6 — Context Window Anatomy & Telemetry

Rather than treating Meta AI as a naive generic text summarizer (which generates bland paragraph summaries of conversational prose), **Meta AI acts as an Architectural Context Telemetry Engine**:

1. **Structural Triage & Decomposition:** Breaks the captured prompt into distinct semantic sections while intelligently collapsing repetitive conversational backlogs (turns 1..N-1) and tool definitions into unified blocks.
2. **Deterministic Fast-Path & Caching:** Uses SHA-256 fingerprinting to instantly return cached analyses for repetitive invariant blocks (like standard system instructions and tool catalogs) at **0ms latency and 0 token cost**.
3. **Single-Turn Architectural Telemetry:** Sends a compact context skeleton to Meta Muse Spark 1.3 / Muse Wonder in a single structured turn. Meta AI returns:
   - **Category:** `system_instruction`, `rag_grounding`, `chat_history`, `few_shot_exemplar`, `schema_tool_spec`, `user_query`, or `runtime_data`.
   - **What:** Precise technical identity of the content (e.g., *"AcmeCorp Support Persona & Brand Safety Policy"*).
   - **Why:** Prompt engineering rationale (e.g., *"Enforces response schema constraints and forbids competitor mentions"*).
   - **Hygiene & Bloat Warnings:** Flags stale history turns, redundant instructions, or token hogs.
4. **Interactive Visual Anatomy:** Renders a sleek **Context Composition Bar** (e.g., `[ 25% System ] [ 45% RAG Grounding ] [ 20% History ] [ 10% User Query ]`) and per-section **"What & Why" Anatomy Badges** with one-click handoff to Loop 4 Sensory Code Attribution.

This elevates Meta AI into a continuous **runtime prompt profiler and context optimizer**, directly cementing the **Best Agentic Use-Case bonus**.

---

## 2. System Architecture & Two-Tier Processing Pipeline

```
+-------------------------------------------------------------------------------+
|                       Captured Context Window (Proxy)                         |
+-------------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------------+
|                  Tier 1: Pre-Classification & Triage Engine                   |
| - Fast heuristic classifier (System, User, Assistant, Tool definitions, RAG)  |
| - Dialogue backlog compression (collapse repetitive turns 1..N-1)             |
| - SHA-256 Section Fingerprinting & In-Memory Summary Cache                    |
+-------------------------------------------------------------------------------+
          |                                                   |
          | (Cache Hit or Deterministic)                      | (Cache Miss / Novel Prompt)
          v                                                   v
+-----------------------+                           +-----------------------------------+
| Instant Local Returns |                           | Tier 2: Meta AI Telemetry Engine  |
| (0ms, 0 token cost)   |                           | (Muse Spark 1.3 / Muse Wonder)    |
+-----------------------+                           | - Context Skeleton Batching       |
          |                                         | - Single-turn structured output   |
          |                                         | - What, Why & Bloat Detection     |
          |                                         +-----------------------------------+
          |                                                   |
          +-------------------------+-------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------------+
|                        Interactive Webview Presentation                       |
| - Context Window Composition Bar (Token % breakdown by category)              |
| - Section Anatomy Badges (🎯 WHAT & 💡 WHY with category pills)               |
| - Context Bloat & Hygiene Advisories (⚠️ Stale history, redundant tokens)     |
| - "Trace in Code" Quick Action (invokes Loop 4 ReAct Attribution Harness)     |
+-------------------------------------------------------------------------------+
```

### 2.1 The Two-Tier Strategy: Loop vs. Harness

| Tier | Component | Mechanism | Role & Latency |
| :--- | :--- | :--- | :--- |
| **Tier 1 (Loop)** | **Context Telemetry Loop** | Heuristic triage + Cache + Single-turn Meta AI batch | Evaluates the entire prompt at once; generates What, Why, and token composition in **< 800ms**. |
| **Tier 2 (Harness)** | **Sensory Attribution Harness** | Multi-turn ReAct (`search_text`, `read_file`, `attribute_prompt`) | Activated **on-demand** when a developer clicks *"✨ Trace in Code"* on an identified RAG chunk or template section. |

This two-tier design protects developer machine resources, strictly respects hardware limitations (avoiding back-to-back heavy LLM test runs that cause system strain), and delivers instant, responsive UI updates.

---

## 3. Data Models & Type Specifications

### 3.1 Type Definitions (`src/types.ts`)

```typescript
export type ContextSectionCategory =
  | "system_instruction"
  | "rag_grounding"
  | "chat_history"
  | "few_shot_exemplar"
  | "schema_tool_spec"
  | "user_query"
  | "runtime_data";

export type SectionTelemetry = {
  sectionId: string;
  messageIndex: number;
  category: ContextSectionCategory;
  categoryLabel: string;
  what: string;
  why: string;
  tokenEstimate: number;
  tokenPercentage: number;
  warning?: string;
};

export type CategoryComposition = {
  category: ContextSectionCategory;
  categoryLabel: string;
  tokens: number;
  percentage: number;
  colorVar: string;
};

export type CaptureTelemetry = {
  captureId: string;
  analyzedAt: string;
  totalTokens: number;
  composition: CategoryComposition[];
  sections: SectionTelemetry[];
  warnings: string[];
};
```

### 3.2 View & Storage Integration

- `StoredCapture`: Add optional `telemetry?: CaptureTelemetry`.
- `CaptureView`: Add `telemetry?: CaptureTelemetry`.
- `ViewMessage`: Add optional `telemetry?: SectionTelemetry` or telemetry badge list.

---

## 4. Meta AI Telemetry System Prompt & Protocol

### 4.1 `TELEMETRY_SYSTEM` Prompt

```text
You are Context Tracker's autonomous Context Window Telemetry Engine powered by Meta AI models (Muse Spark 1.3.
Your mission is to perform architectural decomposition and semantic telemetry on a captured LLM prompt context window.

For each section provided in the prompt context skeleton:
1. Classify its functional category:
   - "system_instruction": Persona, system rules, safety guardrails, output formatting constraints.
   - "rag_grounding": Retrieved context documents, vector database search snippets, knowledge base chunks.
   - "chat_history": Prior conversational turns between user and assistant for multi-turn dialogue memory.
   - "few_shot_exemplar": Input/output demonstrations guiding the model's response format or logic.
   - "schema_tool_spec": Function definitions, JSON schemas, or tool calling specifications.
   - "user_query": The immediate current user task or question prompting this completion.
   - "runtime_data": Dynamic state, session metadata, database rows, or environment variables.

2. Identify WHAT this section is (concise, technical description, 4-10 words):
   - Bad: "A text describing some rules."
   - Good: "AcmeCorp Support Persona & Brand Safety Policy"
   - Bad: "Some search results."
   - Good: "PostgreSQL Migration Guide (Vector RAG Search Results)"

3. Explain WHY this section is included in the context window (prompt engineering rationale, 8-18 words):
   - Good: "Enforces strict JSON output schema and prevents competitor brand mentions."
   - Good: "Grounds troubleshooting instructions with accurate hardware specs for Acme Router 4000."
   - Good: "Provides conversational memory so model can resolve coreferences to previous steps."

4. Detect Hygiene Issues or Bloat:
   - Identify stale dialogue history turns that consume excessive tokens without adding value to the active query.
   - Flag conflicting instructions or duplicate context blocks.

Output ONLY a valid JSON object matching the requested schema.
```

### 4.2 Compact Context Skeleton Generator

To ensure minimal token consumption and blazing fast inference, the extension formats the context window into a lightweight skeleton:

```json
[
  {
    "sectionId": "msg-0",
    "messageIndex": 0,
    "role": "system",
    "tokenEstimate": 450,
    "preview": "You are an autonomous AI support assistant for Acme Cloud. Always answer in JSON format..."
  },
  {
    "sectionId": "msg-1-rag",
    "messageIndex": 1,
    "role": "user",
    "tokenEstimate": 1850,
    "preview": "Reference Documents:\nDoc 1: Postgres 16 replica failover protocol...\nDoc 2: Connection pool sizing..."
  },
  {
    "sectionId": "history-collapse",
    "messageIndex": 2,
    "role": "chat_history",
    "turns": 4,
    "tokenEstimate": 920,
    "preview": "User: How do I scale pool? -> Assistant: Use PgBouncer -> User: What about failover?"
  },
  {
    "sectionId": "msg-3",
    "messageIndex": 3,
    "role": "user",
    "tokenEstimate": 40,
    "preview": "What happens if the primary node goes offline during peak hours?"
  }
]
```

---

## 5. UI/UX Specification

### 5.1 Context Window Composition Bar (`media/panel.js` & `media/panel.css`)

Displayed prominently directly below the capture stats bar (Tokens, Provider, Model):

```
+----------------------------------------------------------------------------------------------------+
| CONTEXT ANATOMY & BUDGET BREAKDOWN                                                    ⚡ Meta AI   |
| [=== 22% System ===][====== 48% RAG Grounding ======][==== 20% History ====][== 10% Query ==]     |
| 🟢 System: 450t (22%)  🟣 RAG: 1,850t (48%)  🟡 History: 920t (20%)  🔵 Query: 40t (10%)           |
+----------------------------------------------------------------------------------------------------+
```

- Each segment uses clean VS Code theme variables (`--vscode-charts-purple`, `--vscode-charts-blue`, `--vscode-charts-green`, `--vscode-charts-orange`).
- Hovering shows token count, percentage, and category.
- Clicking a segment scrolls directly to that message section in the context view.

### 5.2 Section Anatomy Cards & Badges

Attached directly above each message block:

```
+----------------------------------------------------------------------------------------------------+
| [User Message · 1,890 tokens]                           [ 🟣 RAG Grounding · 48% of prompt budget ] |
| 🎯 WHAT: PostgreSQL 16 Replica Failover Protocol (Vector RAG Snippets)                             |
| 💡 WHY:  Grounds the assistant with active infrastructure failover procedures to prevent hallucination|
| [ ✨ Trace in Code ]                                                                               |
+----------------------------------------------------------------------------------------------------+
| Reference Documents:                                                                               |
| Doc 1: Postgres 16 replica failover protocol...                                                    |
+----------------------------------------------------------------------------------------------------+
```

### 5.3 Context Hygiene & Bloat Advisories

When Meta AI detects context inefficiencies, an amber advisory badge appears:

- `⚠️ Context Bloat Advisory: Dialogue turns 1–3 consume 25% of context window but are unrelated to active failover query.`
- `⚠️ Duplicate System Instructions: JSON formatting rules repeated in message 0 and message 2.`

---

## 6. Phased Implementation Plan

### Phase 1: Context Decomposition, Triage & Caching Engine

**Objective:** Provide fast, deterministic sectioning of captured prompts with zero overhead.

* **1.1 Section Extractor (**`src/telemetry.ts`**):**
  - Implement `extractContextSections(messages, tools)` to parse a capture into structural units.
  - Heuristically detect system prompts, tool schemas, user queries, and dialogue history chains.
* **1.2 Backlog Collapser:**
  - Group repetitive historical user/assistant turns (prior to the active prompt) into a single cohesive dialogue block with token estimates.
* **1.3 Section Fingerprinting & LRU Cache:**
  - SHA-256 fingerprinting for sections (`hashText(content)`).
  - In-memory LRU cache storing prior Meta AI telemetry results so identical system prompts and tool schemas cost **0 tokens and 0 ms**.
* **1.4 Unit Tests:**
  - Tests in `test/telemetry.test.cjs` verifying section extraction, history grouping, and cache hits.

### Phase 2: Meta AI Telemetry System Prompting & Client Integration

**Objective:** Wire Meta Muse Spark 1.3 / Muse Wonder to execute single-turn structured telemetry analysis.

* **2.1** `TELEMETRY_SYSTEM` **& Skeleton Builder:**
  - Implement `buildTelemetrySkeleton(sections)` with secret redaction (`redactText`).
  - Strict JSON schema for model response validation (`TelemetryResponse`).
* **2.2 Telemetry Service in** `TrackerApp` **(**`src/app.ts`**):**
  - Implement `analyzeContextTelemetry(captureId)` method.
  - Check cache for invariant sections, isolate novel sections, and format skeleton.
  - Execute batched completion via `completeChat` using active Meta AI model.
  - Handle JSON parse failures gracefully with local heuristic fallbacks.
* **2.3 Telemetry Event Streaming:**
  - Push status events to Meta AI Helper Console (`🤖 Meta AI Telemetry: Analyzed 4 prompt sections, identified 48% RAG grounding`).
* **2.4 Unit Tests:**
  - Unit tests verifying mock Meta AI responses, JSON validation, and error recovery.

### Phase 3: Extension Pipeline, Data Persistence & Bridge to Loop 4

**Objective:** Connect telemetry results to the store, view derivation, and sensory attribution.

* **3.1 Type Definitions (**`src/types.ts`**):**
  - Add `CaptureTelemetry`, `SectionTelemetry`, and `CategoryComposition` to `src/types.ts`.
  - Add `telemetry` field to `StoredCapture` and `CaptureView`.
* **3.2 Persistence (**`src/store.ts` **&** `src/derive.ts`**):**
  - Persist `telemetry` in JSON storage alongside capture data.
  - Map telemetry records into `deriveCapture` so views retain telemetry across app restarts.
* **3.3 Bridge to Sensory Attribution Harness:**
  - Clicking *"✨ Trace in Code"* on an identified RAG or template section triggers Loop 4's `attributeCaptureMessage`, connecting high-level telemetry directly to file & line numbers in source code.
* **3.4 Unit Tests:**
  - Persistence and view derivation roundtrip tests.

### Phase 4: Webview UI Rendering (Composition Bar & Anatomy Badges)

**Objective:** Build high-signal, beautiful visual components in the Context Tracker panel.

* **4.1 Context Window Composition Bar (**`media/panel.js`**):**
  - Render proportional segmented bar under capture header with token counts and percentages.
  - Interactive click handlers to scroll to corresponding sections.
* **4.2 Section Anatomy Cards (**`media/panel.js`**):**
  - Render `🎯 WHAT` and `💡 WHY` badges above messages and gap spans.
  - Visual category badges (System, RAG, History, Tool, Query).
* **4.3 Context Bloat & Hygiene Warnings (**`media/panel.js` **&** `media/panel.css`**):**
  - Display amber advisory banners for bloat or repetitive instructions.
* **4.4 Webview Styling (**`media/panel.css`**):**
  - CSS styles for `.telemetry-bar`, `.telemetry-segment`, `.anatomy-card`, `.badge-rag`, `.badge-system`, etc.

### Phase 5: RAG & Multi-Turn Test Fixtures & Video Script Documentation

**Objective:** Verify end-to-end functionality on diverse real-world AI patterns and update hackathon showcase.

* **5.1 Realistic Test Fixtures:**
  - Fixture A: 12-turn conversational chat with system rules and trailing query.
  - Fixture B: RAG pipeline with 3 vector search context chunks and citation instructions.
  - Fixture C: Tool-calling agent context with complex JSON schema definitions.
* **5.2 Showcase & Documentation Update:**
  - Update `HACKATHON_SHOWCASE.md` with **Loop 6: Context Window Anatomy & Telemetry**.
  - Document the combination of Loop 4 (Reverse-Engineering Source Code) and Loop 6 (Prompt Profiling & Purpose Telemetry) for the judges.

---

## 7. Security, Safety & Hardware Guarantees

1. **Secret & Key Redaction:**
   - Pre-processes all previews with `redactText()` before sending to Meta AI, guaranteeing no OpenAI, Anthropic, or database credentials leak in prompts.
2. **PC & System Protection:**
   - Honors developer constraints: no rapid back-to-back testing loops that overload local machines or trigger IDE crashes.
   - Leverages local caching and single-turn batching to minimize API calls and compute overhead.
3. **Graceful Fallbacks:**
   - If offline or Meta AI key is not configured, deterministic heuristic fallback provides baseline category labels and token estimates instantly.
4. **Non-Destructive Read-Only Operation:**
   - Context telemetry is purely diagnostic and makes 0 modifications to source files or user configurations.

---

## 8. Success Metrics for Hackathon Evaluation

| Metric | Target | Measurement |
| :--- | :--- | :--- |
| **Analysis Latency** | < 800ms | Full context window analyzed in a single Meta AI call using Muse Spark 1.3. |
| **Cache Hit Efficiency** | > 80% on repeat requests | Invariant system prompts and tool schemas resolved in 0ms with 0 tokens. |
| **Context Clarity** | 100% of sections labeled | Every section tagged with Category, What, Why, and Token %. |
| **Hardware Overhead** | Negligible (< 1% CPU) | 1 request per capture; zero back-to-back hammering or loop lockups. |
| **Agentic Value** | Loop 6 + Loop 4 synergy | One click from high-level telemetry to exact source code file and line numbers. |
