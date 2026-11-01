# Plan run findings

- Plan path: docs/plans/context-telemetry.md
- Started: Sunday, Nov 1, 2026, 9:49 AM (UTC-6)

## Phase 1: Phase 1: Context Decomposition, Triage & Caching Engine

### Discrepancies

- Phase 1 deliverables are **uncommitted** (untracked `src/telemetry.ts`, `test/telemetry.test.cjs`; modified `src/types.ts`; not on `HEAD`).
- Plan **1.1** specifies `extractContextSections(messages, tools)`; implementation is `extractContextSections(messages, options?)` only—tool schemas are handled when `parse.ts` injects a `role: "tools"` message, not via a separate `tools` argument.
- Plan **3.1** (later phase) owns telemetry types on `StoredCapture` / `CaptureView` / `ViewMessage`; Phase 1 already adds `CaptureTelemetry`, `SectionTelemetry`, `CategoryComposition`, optional `telemetry` fields, and internal `ContextSection` (with extra `messageIndices` on `SectionTelemetry` vs plan §3.1).
- Plan **1.3** describes caching **prior Meta AI telemetry results**; `TelemetryCache` is generic, but `buildDeterministicTelemetry` only **writes** cache entries from **heuristic fallbacks** (`generateFallbackSectionTelemetry`) for `system_instruction` and `schema_tool_spec`—no Meta AI population yet (expected in Phase 2).
- `hashText` uses SHA-256 then **truncates to 16 hex characters** (plan wording implies full fingerprint; collision surface is larger than a full digest).
- History collapse (**1.2**) groups **`tool`** role messages with user/assistant backlog; the plan text names **user/assistant** turns only.
- Phase 1 scope lists extractor, collapser, cache, and tests; the same module also ships **`splitRagUserQuery`** (active-message RAG/query split), **`buildDeterministicTelemetry`**, composition helpers, and **`CATEGORY_COLORS`** (UI-oriented; plan Phase 4).
- Tests cover system cache reuse on repeat captures; there is **no dedicated cache-hit test** for identical **tool schema** fingerprints (only LRU mechanics with arbitrary hash keys).

### User checks (deferred)

- None.

## Phase 2: Phase 2: Meta AI Telemetry System Prompting & Client Integration

### Discrepancies

- Phase 2 deliverables are **uncommitted** (untracked `src/telemetry.ts`, `test/telemetry.test.cjs`; modified `src/app.ts`, `src/helperClient.ts`; bundled with Phase 1 type changes; not on `HEAD`).
- Plan **2.1** / §4.1 **`TELEMETRY_SYSTEM`** is implemented in `src/telemetry.ts` with the same categories and mission text; plan **Bad/Good** contrast examples are shortened to single **Example:** lines (substantively aligned).
- Plan **2.1** calls for **strict JSON schema** validation (`TelemetryResponse`); implementation uses TypeScript types plus **`parseTelemetryResponse`** (fence stripping, per-field checks, unknown categories coerced to **`runtime_data`**, invalid section rows dropped)—not a JSON Schema validator and no rejection of the whole payload on partial invalidity.
- Plan **2.2** JSON parse failures: **`parseTelemetryResponse` → `null`** still runs the Meta AI success path (`applyTelemetryResponse` with heuristics/cache only) and emits **`🤖 Meta AI Telemetry: …`** without distinguishing fallback-from-parse-failure from a valid model payload (only **thrown** errors get **`⚠️ Telemetry fallback applied`**).
- Plan **2.2** cache + batching: **`novelSections`** are sent in the skeleton only; full **`sections`** are merged via **`applyTelemetryResponse`** (aligned). When **`novelSections.length === 0`**, Meta AI is skipped entirely in favor of **`buildDeterministicTelemetry`** (aligned with full cache hit).
- Plan **2.3** example console line uses **`🤖 Meta AI Telemetry: … identified 48% RAG grounding`**; the live Meta AI finish event matches that pattern with **`categoryLabel`** (e.g. “RAG Grounding”). The **no-helper / all-cached** path uses **`📊 Context Telemetry:`** instead of the Meta AI prefix.
- Plan **2.4** unit tests cover skeleton redaction, **`parseTelemetryResponse`**, and **`applyTelemetryResponse`** with a mock model object; there is **no test** of **`TrackerApp.analyzeContextTelemetry`**, **no mocked `completeChat`** telemetry round-trip, **no explicit `applyTelemetryResponse(…, null)`** parse-failure case, and **`TELEMETRY_SYSTEM`** is imported in **`test/telemetry.test.cjs`** but **unused**.
- Cross-phase prep in the same diff: **`analyzeTelemetry`** webview action and **`capture.telemetry` + `store.update`** (plan **3.2**), while **`deriveCapture`** still omits **`telemetry`** on **`CaptureView`** (plan **3.2**); **`helperStepLabel("analyze_telemetry")`** has no matching harness tool name in the telemetry flow (telemetry uses **`completeChat`** without tools).
- **`completeChat`** now treats **`tools`** as optional (required for telemetry’s tool-less completion); change is outside Phase 2 bullet list but supports **2.2**.

### User checks (deferred)

- None.

## Phase 3: Phase 3: Extension Pipeline, Data Persistence & Bridge to Loop 4

### Discrepancies

- Phase 3 deliverables are **uncommitted** (modified `src/types.ts`, `src/derive.ts`, `src/app.ts`, `test/trace.test.cjs`; bundled with Phases 1–2 telemetry work; not on `HEAD`).
- Plan **3.1** lists types on `StoredCapture` / `CaptureView` / `ViewMessage`; all three are present. Architecture **§3.2** allows **`telemetry?: SectionTelemetry` or telemetry badge list**; implementation binds **one** `SectionTelemetry` per message via `deriveCapture` **`.find()`**, so a message split into multiple sections (e.g. **`msg-N-rag`** and **`msg-N-query`** on the same index) only surfaces **the first** matching section in the view.
- Plan **3.2** names **`src/store.ts`**; **`store.ts` is unchanged**—`telemetry` persists because captures are written as full JSON (`add` / `update`), with no store-specific field handling or migration.
- Plan **3.2** **`deriveCapture`** / **`presentCapture`**: **`deriveCapture`** now copies capture-level **`telemetry`** and attaches per-message **`telemetry`** (including **`messageIndices`** for collapsed history); **`presentCapture`** retains capture **`telemetry`** and keeps message **`telemetry`** via message spread (covered in tests).
- Plan **3.3** **Bridge to Loop 4**: **not implemented**. There is no **“✨ Trace in Code”** control in **`media/panel.js`**, no webview action that passes a telemetry section into attribution, and **`analyzeTelemetry`** is handled in **`src/app.ts`** but **never posted** from the panel. Existing **`attributeMessage`** → **`attributeCaptureMessage`** (Loop 4) remains separate; **`attributeCaptureMessage`** already accepts optional **`content`**, but nothing in the telemetry pipeline invokes it for RAG/template sections.
- Plan **3.4** persistence / derivation roundtrip: **`test/trace.test.cjs`** adds reload-via-**`CaptureStore`**, **`deriveCapture`**, and **`presentCapture`** assertions; it does **not** exercise **`TrackerApp.analyzeContextTelemetry`** → **`store.update`**, collapsed-history multi-index binding, or the Loop 4 bridge (expected once **3.3** / Phase 4 UI exist).
- Residual cross-phase note: **`helperStepLabel("analyze_telemetry")`** has no matching harness tool name (telemetry uses tool-less **`completeChat`**).

### User checks (deferred)

- None.

## Phase 4: Phase 4: Webview UI Rendering (Composition Bar & Anatomy Badges)

### Discrepancies

- Phase 4 deliverables are **uncommitted** (modified `media/panel.js`, `media/panel.css`; bundled with Phases 1–3 telemetry work; branch **ahead 3** of `origin/main`, not isolated on `HEAD` as a Phase-4-only commit).
- Plan **4.1** / §5.1 imply a **category-level** composition bar (e.g. one segment per budget share); the bar renders **`telemetry.sections`** (one segment per section). Aggregated token counts and percentages appear in the **legend** from **`telemetry.composition`**, not as bar segment labels on the bar itself.
- Plan **4.1** “under capture header”: UI places **`renderTelemetryBar`** after the quiet token/file-match line and **before** the existing file-slice **`bar()`**—aligned with §5.1 “below the capture stats bar,” not immediately under the model title row.
- Plan **4.2** requires anatomy above **messages and gap spans**; cards attach only at **`renderMessage`** (per message). **`renderSpan`** / matcher **gap** spans get no telemetry UI.
- When **`splitRagUserQuery`** yields multiple sections on one **`messageIndex`**, **`deriveCapture`** still binds **one** `SectionTelemetry` per message (**.find()**); Phase 4 shows at most **one** anatomy card per message and segment clicks always scroll to that index (no per-section anchor within a message).
- Plan **4.2** / Phase **3.3** **“✨ Trace in Code”**: button is present on anatomy cards and posts **`attributeMessage`**, but **`renderAnatomyCard`** does **not** pass optional **`content`** (nor section id)—attribution uses the **full message** like the legacy control. **`canTrace`** hides the button for **assistant** messages and messages with **file** spans.
- Plan **4.4** names **`.badge-rag`**, **`.badge-system`**, etc.; CSS uses **`.badge-category`** plus **`.cat-{category}`** (e.g. **`.cat-rag_grounding`**). **`CategoryComposition.colorVar`** from telemetry is **unused** in the webview (colors come from static CSS variables).
- Plan **4.3** / §5.3: capture-level **`telemetry.warnings`** render as **`.telemetry-advisory`** banners; per-section **`telemetry.warning`** uses **`.anatomy-warning-pill`** (aligned in spirit). No Phase 4 unit or webview tests (plan does not require them for this phase).
- Extra UX not listed in Phase 4 bullets: empty-state / re-run **`analyzeTelemetry`** controls, helper chip **“📊 Context telemetry”**, and hiding **“✨ Attribute with Meta AI”** when message **`telemetry`** exists (replaced by anatomy **Trace in Code** where **`canTrace`**).

### User checks (deferred)

- None.

## Phase 5: Phase 5: RAG & Multi-Turn Test Fixtures & Video Script Documentation

### Discrepancies

- Phase 5 deliverables are **uncommitted** (modified `test/fixtures.test.cjs`, `HACKATHON_SHOWCASE.md`; bundled with Phases 1–4 telemetry work; branch **ahead 3** of `origin/main`).
- Plan **objective** calls for **end-to-end** verification on diverse patterns; telemetry fixtures exercise **`extractContextSections` → mocked `parseTelemetryResponse` / `applyTelemetryResponse`** only—no **`TrackerApp.analyzeContextTelemetry`**, no **`buildTelemetrySkeleton` + `completeChat`**, and no live Meta AI round-trip (reasonable for hardware constraints but narrower than “end-to-end”).
- Plan **5.1 Fixture A** (“12-turn conversational chat”): fixture builds **12 messages** (system + **5** user/assistant pairs + trailing query) and collapses **5** prior user turns; **`HACKATHON_SHOWCASE.md`** table copy says **“12-turn chat history + active query”**, which overstates the collapsed backlog (10 history messages / 5 exchanges).
- Fixture A **68% token share**: advisory text and mock **`warning`** mention **68%**; the test only asserts history **`composition.percentage > 50`**, not **68%**—showcase table claim **“calculates 68% token share”** is not asserted in code.
- Plan **5.1 Fixture B** / showcase **“bridges to Loop 4 Trace in Code”**: test validates **`attributionTools` → `search_text`** on RAG-like text in a temp repo, not the product **Trace in Code** path (**`attributeMessage` / `attributeCaptureMessage`** with telemetry section content)—consistent with Phase 3/4 bridge gaps noted earlier.
- Plan **5.1 Fixture C**: cache reuse is proven via **`applyTelemetryResponse(..., null, cache)`** on a second capture with identical tools; it does not run **`analyzeContextTelemetry`** or **`buildDeterministicTelemetry`** cache population paths.
- **`test/fixtures.test.cjs`** Phase 5 telemetry imports include unused **`buildDeterministicTelemetry`**, **`buildTelemetrySkeleton`**, and **`TELEMETRY_SYSTEM`** (fixture tests only use **`extractContextSections`**, **`parseTelemetryResponse`**, **`applyTelemetryResponse`**, **`TelemetryCache`**).
- Plan phase **title** includes **“Video Script Documentation”**; bullets under **5.2** only name **`HACKATHON_SHOWCASE.md`**. Implementation updates **§4 3-Minute Video Pitch** and rubric text there (no separate video script file)—substantively aligned with **5.2**, not a standalone doc.
- Plan **5.2** asks to document **Loop 4 + Loop 6** for judges: showcase adds **Loop 6** section with **Loop 6 → Loop 4 Bridge**, weaves both into **§4** voiceover, and updates rubric rows—no dedicated combined narrative section beyond those cross-links.

### User checks (deferred)

- None.

