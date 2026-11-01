# Plan run findings

- Plan path: docs/plans/semantic-attribution.md
- Started: Saturday, Oct 31, 2026, 2:45 PM (UTC-5)

## Phase 1: Phase 1: Template Asset Scope & Indexer Expansion

### Discrepancies

- Phase 1 changes are **uncommitted** (working-tree edits to `src/indexer.ts` and `test/trace.test.cjs` only; not on `HEAD`).
- Plan **1.1** lists adding `.jinja`, `.j2`, and `.prompt`; those extensions were **already** in `EXTENSIONS` at `HEAD`. This phase adds `.template`, `.mustache`, and `.hbs` as required, plus non-plan extras `.jinja2`, `.tpl`, and `.liquid`.
- Plan **1.2** asks to ensure template assets are not excluded by **size limits**; implementation does not add template-specific handling or tests—`readIndexedFile` still skips files over `MAX_FILE_BYTES` (400KB) and zero-byte files, same as before.
- Architecture **§2.1** (referenced by the phase objective) mentions **external discovered configuration prompt paths**; no indexer logic for config-discovered paths appears in the Phase 1 diff (only `prompts/`, `templates/`, and `prompt_templates/` parent dirs for extensionless files).
- Plan **1.3** cites Jinja2 indexing; the new test indexes `.jinja2` but does **not** include a `.j2`-named fixture (though `.j2` remains in `EXTENSIONS`).

### User checks (deferred)

- None.

## Phase 2: Phase 2: Autonomous Semantic Attribution Prompting & Tools

### Discrepancies

- Phase 2 deliverables are **uncommitted** (working-tree edits to `src/helperTools.ts`, `src/types.ts`, `test/helper.test.cjs`, plus a small `src/app.ts` `helperStepLabel` branch for `attribute_prompt`; not on `HEAD`).
- Plan **2.1** / architecture **§3.3** call for line numbers within file bounds before acceptance; `attributePrompt` **clamps** `endLine` to `totalLines` instead of rejecting out-of-range `endLine`, and returns `finish.endLine` as the clamped value.
- Plan **2.1** says to validate that the **matched snippet corresponds to the code**; `matchedSnippet` is **optional** in the tool schema and snippet checks are **skipped** when omitted, so attributions can succeed with file/line validation only.
- When `matchedSnippet` is provided, verification is **loose** (case-insensitive substring or any snippet line longer than 5 chars), which is weaker than strict correspondence to the attributed line range.
- Plan **2.4** harness completion is covered by tests that **mock** `complete` (simulated Muse tool turns); they do not exercise the live Meta helper client or Muse Spark / Wonder endpoints.
- Plan **2.2** emphasizes **parallel** `search_text` (and read) in a single turn; the harness fixture uses **one** `search_text` call in turn 1 and does not assert parallel multi-query behavior.
- **`buildAttributionUserPrompt`** truncates captured content at 2000 characters (not specified in plan **2.3**); it includes project name and model but not project filesystem path.
- Minor cross-phase prep in the same diff: `AttributedSpan` in `src/types.ts` and UI step copy in `app.ts`—Phase 3 owns wiring attribution into captures/UI per the plan.

### User checks (deferred)

- None.

## Phase 3: Phase 3: Extension Pipeline & Span Integration

### Discrepancies

- Phase 3 deliverables are **uncommitted** (working-tree edits to `src/types.ts`, `src/matcher.ts`, `src/app.ts`, and `test/trace.test.cjs`; bundled in the same diff as Phases 1–2 and not on `HEAD`).
- Plan **3.1** lists attribution metadata on **`StoredCapture`**; implementation adds `confidence` / `explanation` (and optional `source`) on **`ReportedSpan`** and **`ViewSpan`** only—no new top-level fields on `StoredCapture`.
- Plan **3.2** allows a dedicated **`attributedSpans` map**; implementation stores attributions in **`capture.reported`** with `source: "attributed"`, replacing prior attributed rows for the same `messageIndex` (aligned with the “or reported” option, not a separate map).
- Plan **3.3** names **`src/derive.ts`**; **`derive.ts` is unchanged**—integration is entirely in **`matcher.ts`** (`placeOne`, `combineSpans`, `fileLabel`, `ViewSpan` fields) while `deriveCapture` already passes per-message `reported` into `deriveMessageSpans`.
- Plan **3.3** requires attributed spans alongside exact matches **without collision**; `combineSpans` implements overlap handling, but **3.4 adds no test** where both a passive **matched** span and an **attributed** span apply to the same message (only a dynamic-prompt case with no asserted exact matches).
- Plan **3.4** persistence test **simulates** attribution by pushing to `capture.reported` and calling `store.update`; it does **not** exercise **`TrackerApp.attributeCaptureMessage`** or the **`attributeMessage`** webview action (Phase 4 UI for the button is still absent in `media/panel.js`).
- **`attributeCaptureMessage`** wires the **live** `completeChat` Meta helper client; there is **no unit test** mocking that path (unlike Phase 2 harness tests in `test/helper.test.cjs`).
- Attributed placement when **`quote` is absent** falls back to highlighting the **entire message** (`charStart` 0 … `charEnd` `content.length`), which is broader than a file-line span and may interact aggressively with overlap logic when exact matches exist (behavior not covered by tests).

### User checks (deferred)

- None.

## Phase 4: Phase 4: UI Actions & Interactive Attribution Badges

### Discrepancies

- Phase 4 deliverables are **uncommitted** (working-tree edits to `media/panel.js` and `media/panel.css`; `attributeMessage` handling in `src/app.ts` is in the same diff and required for the button to function).
- Plan **4.1** shows the button when `spans.length === 0` **or** there are no file spans; implementation sets `canAttribute = !hasFileSpan && message.spans.length > 0 && message.role !== "assistant"`, so messages with **zero spans** (e.g. empty content) never get the button—the **`spans.length > 0`** guard contradicts the plan’s first condition (typical unmatched prompts still get a runtime gap span, so the primary dynamic-prompt case is covered).
- Plan **4.1** does not restrict by role; the UI **hides** the control on **assistant** messages.
- Plan **4.1** loading state is local (`Attributing…`, `attributingMessage`) plus extension `helperBusy` / status bar; the button is also **disabled whenever `state.helper.busy`** for any helper operation, not only attribution.
- Plan **4.2** tooltip text *"Attributed by Meta AI: [explanation]"*; implementation matches when `explanation` is set but **appends confidence** `(confidence: N%)`, and when `explanation` is missing the `title` falls back to **`span.label`** instead of the prescribed prefix.
- Plan **4.2** “clicking the span opens the source file”: **block headers** call `openSpan` (opens editor at lines when `canOpen`); **bar** segment buttons still call **`focusSpan`** (scroll/highlight only)—same as pre-existing matched-span behavior, not full open-on-click for the bar slice.
- No **automated or webview tests** for `attributeMessage`, loading UI, badges, or tooltips (plan does not require Phase 4 tests; coverage remains manual / extension-only).

### User checks (deferred)

- None.

## Phase 5: Phase 5: Dynamic Prompt Test Fixtures & Video Script Update

### Discrepancies

- Phase 5 deliverables are **uncommitted** (working-tree edits to `test/fixtures.test.cjs` and `HACKATHON_SHOWCASE.md`; tracked on `HEAD` but modified, not committed).
- Phase **objective** calls for **end-to-end** attribution on diverse dynamic prompts; the three new tests exercise **`runHarness` + `ATTRIBUTION_SYSTEM` with a mocked `complete` callback** only—they do not run capture → passive matcher (0 spans) → **`attributeCaptureMessage`** / panel UI → span persistence.
- Plan **5.1 Fixture B** specifies Jinja2 with **loops and conditional blocks**; the fixture template uses a **`{% for %}` loop only** (no `{% if %}` / conditional block in template or rendered prompt).
- Plan **5.1 Fixture C** names a **RAG pipeline**; implementation is a **static** `prompts/rag_system.prompt` plus a hand-built dynamic prompt string with injected chunk text—no retrieval/injection code path or vector-store component under test.
- Dynamic fixture tests **script** one `search_text` then `attribute_prompt` in two turns; they do not assert that **`search_text` / `read_file` discover** the attributed file from disk (unlike a live Muse run), only that the harness accepts the mocked tool sequence and **`attribute_prompt` validation** against written temp files.
- **`attributePrompt`** is imported in `test/fixtures.test.cjs` but **unused** (minor dead import in the Phase 5 diff).
- Plan **5.2** / showcase **Loop 4** and the video script mention attribution **“(or it runs autonomously)”**; the extension UI (Phase 4) exposes a **manual** **“Attribute with Meta AI”** button only—no autonomous attribution trigger is implemented.
- **Showcase copy inconsistency:** Loop 4 and the **[1:15–1:55]** script use example paths **`prompts/analyst.prompt` lines 1–5**, while the fixture table and tests use **`src/assistant.py`**, **`templates/review_analyst.jinja2`**, and **`prompts/rag_system.prompt`** with different line ranges.

### User checks (deferred)

- None.

