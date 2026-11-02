# Plan run findings

- Plan path: docs/plans/context-interrogation-chat.md
- Started: Sunday, Nov 1, 2026, 6:11 PM (UTC-6)

## Phase 1 Review

**Scope:** Plan §6 Phase 1 (1.1 types, 1.2 `src/contextTools.ts`, 1.3 `test/contextTools.test.cjs`).

**Verification (2026-11-01):** `npm run compile` succeeds; `node --test test/contextTools.test.cjs` — **12/12 pass**.

### Requirements coverage

| Plan item | Status | Notes |
| :--- | :--- | :--- |
| **1.1** `ContextScope` (`global`, `section`, `selection`, `compare`) | Met | `ContextScopeKind` + `ContextScope` in `src/types.ts`. |
| **1.1** `ContextQueryResult`, `ContextSectionMatch`, `TemplatePatchProposal` | Met | Also `ContextSectionReadResult`, `CodeTemplateInspectionResult` (align with §3.2–3.3). |
| **1.1** `HelperView` / `CaptureView` scope + thread state | Partial | Both have optional `activeScope`. `HelperView` adds `activePatch`, `threadCount` only—no thread message type or history fields. `CaptureView` has `sections?` but no per-capture chat buffer. |
| **1.2** `search_context` | Met | Substring + `/regex/flags`, optional `sectionId`, `caseSensitive`, redaction via `redactText`. |
| **1.2** `read_context_section` | Met | Paging, line clamp, `maxLines` cap 300, token estimate, redacted content. |
| **1.2** `inspect_code_template` | Met | Reported spans + `CachedAttribution` fingerprint/quote; reads workspace slice when `projectPath` + file exist. |
| **1.2** `propose_template_patch` | Met | Relative-path safety, optional workspace existence check, unified `diffPreview`, `patchId`. |
| **1.3** Isolated unit tests | Met | No servers; mocked `fsImpl` where needed. |
| **§7.1** Redaction on search/read | Implemented | Not covered by tests. |

**Out of Phase 1 (expected):** `createContextTools` → `HelperTool` wrappers exist but are **not** registered in `src/app.ts` (Phase 2). `helperTools.ts` already imports `CaptureInput` / `getOrExtractSections` from `contextTools.ts` (early coupling).

**Repo state:** Phase 1 artifacts still **uncommitted** (`??` `src/contextTools.ts`, `test/contextTools.test.cjs`, `docs/plans/context-interrogation-chat.md`; `M` `src/types.ts`).

### Contract & design discrepancies

- **Section IDs:** Plan §3 examples use `sec_0`, `sec_1`; `extractContextSections` emits `msg-*`, `history-*`, `msg-*-rag`, `msg-*-query`. Tools alias `msg-${sectionId}` and (read only) `history-${sectionId}`—**`sec_N` is not a first-class ID** and does not map to `msg-N`.
- **Section lookup parity:** `readContextSection` accepts `history-${targetId}`; **`searchContext` and `inspectCodeTemplate` do not**, so the same alias can work for read but fail for search/inspect.
- **`searchContext` cap:** Stops at **50** line matches; **`matchesCount` equals returned `matches.length`**, not total hits in the window (may under-report vs naive reading of §3.1).
- **`inspect_code_template` — `runtimeInterpolations`:** Plan §3.3 shows **`value` / `count`** from runtime; implementation only discovers **variable names** from template syntax (`{{ }}`, `{ }`), not values from the capture.
- **`templateType`:** `.prompt` files → **`prompt_file`**, not **`jinja2`**, even when content uses Jinja syntax (plan example uses `jinja2` for a `.prompt`-like template).
- **`CodeTemplateInspectionResult.explanation`:** Extra field on attributed and unattributed paths; unattributed returns **`attributed: false`** (no throw)—reasonable but beyond strict §3.3 JSON.
- **`TemplatePatchProposal`:** Return type includes full patch payload (`startLine`, `endLine`, `originalCode`, etc.), not only §3.4’s minimal four fields—fine for internal use / Phase 3 UI.
- **`proposeTemplatePatch` validation:** Plan **1.2** wording suggests validation; Phase 1 only enforces **relative path**, optional **file exists** when `projectPath` is set, and **does not** verify `originalCode` against disk (§7.2 / Phase **4**).

### Test coverage

**Covered:** blank query; cross-section substring search; regex `/pattern/i`; `sectionId` scoping; read full section + paging; missing section error; inspect via **reported** span + mock FS; unattributed section; `generateDiffPreview`; path traversal rejection; full patch proposal; `createContextTools` registers four tools and runs **search**, **read**, **propose** handlers.

**Gaps (recommended follow-ups, non-blocking for Phase 1 sign-off):**

- `caseSensitive: true` vs default false
- 50-match cap behavior
- `redactText` on search/read snippets (API keys in content)
- `inspectCodeTemplate` via **`CachedAttribution`** (fingerprint / quote), not only `reported`
- `proposeTemplatePatch` rejects missing file when `projectPath` + `existsSync` false
- `createContextTools` **`inspect_code_template`** handler smoke test
- Telemetry-driven **`category`** override (`capture.telemetry.sections`)
- Section alias edge cases (`sec_0`, `history-*` on search/inspect)

### User checks (deferred)

- None.

## Phase 2: Phase 2: Autonomous Meta AI Grounding & Conversational Engine

**Scope:** Plan §6 Phase 2 (2.1 `src/helperTools.ts`, 2.2 `src/app.ts` + `src/harness.ts`, 2.3 `test/contextCopilot.test.cjs`).

**Verification (2026-11-01):** `npm run compile` succeeds; `node --test test/contextCopilot.test.cjs` — **6/6 pass**.

### Discrepancies

- Phase 2 deliverables are **uncommitted** (modified `src/app.ts`, `src/helperTools.ts`, `src/harness.ts`, `src/derive.ts`, `src/types.ts`; untracked `test/contextCopilot.test.cjs`; depends on untracked Phase 1 `src/contextTools.ts`; not isolated on `HEAD` commits).
- Plan **2.1** names **`CONTEXT_COPILOT_SYSTEM`**; implementation exposes **`buildContextCopilotSystem()`** (dynamic string builder, no exported constant with that name).
- Plan **§4.1** section labels **`ACTIVE SCOPE:`** / **`CONTEXT SKELETON:`** / **`INSTRUCTIONS:`**; prompt uses markdown **`### ACTIVE SCOPE`** (and similar)—substance aligned, formatting differs.
- **`totalTokens` in co-pilot system prompt** comes from **`estimateTokens` summed over raw messages** in `handleHelperMessage`; **`buildContextSkeleton`** totals **section `tokenEstimate`** values—the two counts can diverge for the same capture.
- **Active scope is prompt-only:** `activeScope` is injected into **`buildContextCopilotSystem`** and quick-prompt suffixes use **`sectionId` only**; **`search_context` / `read_context_section` are not auto-scoped** to selection text or compare mode (selection/compare appear in system text only).
- **`compare_captures` quick action** ( **`handleQuickAction` → `buildCompareCapturesPrompt`** ) sends a **single user query** with capture ids/token metadata; it does **not** attach a second capture skeleton, diff payload, or **`kind: "compare"`** scope wiring beyond whatever the webview passes—full cross-capture grounding is deferred to **Phase 4** in the plan.
- **`setScope` / `clearScope` / `quickAction`** postMessage handlers live in **`app.ts`** (backend ready); **Phase 3** owns **`media/panel.js`** UI—expected split, but chip/scope UX is not verifiable in Phase 2 alone.
- **`derive.ts`** adds **`sections`** to **`CaptureView`** (via **`extractContextSections`**)—supports scoping/UI but is **outside** the Phase 2 bullet list.
- **`respond` finish** is recorded as activity **`kind: "thought"`**; **`propose_template_patch`** sets **`HelperView.activePatch`** plus **`kind: "finish"`** activity with **`diffPreview`** text—patch **card UI** is Phase **3**; stream wiring is partial vs §5.3 visuals.
- **Contract tests (2.3)** use **mocked `complete`** callbacks, not live **Muse Spark 1.3 / Muse Wonder** API calls—aligned with plan wording (“mocked multi-section capture scenarios”) and §7.3 hardware-safe tests; harness scenarios use minimal system strings rather than full **`buildContextCopilotSystem`** output.
- **Carry-over from Phase 1** (still affects co-pilot tool behavior): section id conventions (`sec_N` vs `msg-*`), search/inspect alias parity, etc.

### User checks (deferred)

- None.

## Phase 3: Phase 3: Webview UI & Interactive Scoping Experience

**Scope:** Plan §6 Phase 3 (3.1 `media/panel.js` / `media/panel.css`, 3.2 section & selection hooks, 3.3 patch cards + `applyPatch` wiring). UX reference §5.1–5.3.

**Verification (2026-11-01):** `npm run compile` succeeds; `node --test test/contextCopilot.test.cjs` — **9/9 pass** (includes Phase 3 string-presence tests for `panel.js` / `panel.css`).

### Discrepancies

- Phase 3 deliverables are **uncommitted** (modified **`media/panel.js`**, **`media/panel.css`**; **`applyPatch` / `setScope` / `clearScope` / `quickAction`** handlers in modified **`src/app.ts`** shared with Phases 2 and 4; Phase 3 tests live in untracked **`test/contextCopilot.test.cjs`**).
- **Scope bar placement vs §5.1:** Plan places the scope pill **directly above the chat input**; UI renders **`helperScopeBar()`** under the helper console header **above the activity feed**, with quick chips **`helperQuickChips()`** between feed and input (Phase **3.1** “chat header” is closer, but still not above the input as in §5.1).
- **Scope pill copy/format:** Global pill uses a **`Scope:`** prefix and **`All Context (~N tokens)`** rather than **`[🌐 All Context (N tokens)]`**. Section scope shows raw **`sectionId`** (e.g. **`msg-0`**, telemetry id) plus optional category text—not plan-style **`Section 2: RAG Grounding (3,400 tokens)`** with ordinal section numbers and per-section token counts in the pill.
- **Compare scope (§5.1):** **`helperScopeBar`** renders **`kind: "compare"`** copy, but the webview **never posts `setScope` with `kind: "compare"`** when a comparison capture is selected; only the **`🔄 Compare Captures`** chip runs **`quickAction`** without setting compare scope (cross-capture UX still Phase **4**-leaning).
- **Text selection hook (3.2 / §5.1):** Implementation uses a **`selection-floating-bar`** at the **top of the prompt column** (preview + **`💬 Ask Meta AI`**), not a small floating **`[💬 Ask about selection]`** pill anchored to the highlight. Selection requires **≥ 8 characters**; **`mouseup`** listens on **`document`**, so selections outside the prompt body can also trigger the bar.
- **Patch card actions (3.3 / §5.3):** Color-coded unified-diff viewer and **`✅ Apply Patch to Workspace`** → **`applyPatch`** postMessage are present. **`[Open in Editor]`** is **not implemented**. Dismiss uses **`clearHelperActivity`**, which clears the **entire** helper activity log and **per-capture threads**, not only the patch card.
- **Patch card data binding:** **`renderPatchCard`** reads **`state.helper.activePatch`** (single global patch) for file/impact/apply actions while diff text comes from the activity item—multiple patch **`finish`** entries could show **stale or mismatched** metadata if **`activePatch`** was cleared or superseded.
- **Patch card detection:** **`finish`** items become patch cards only when **`item.detail.includes("--- a/")`**; diffs without that prefix fall back to a generic outcome row even when a patch was proposed.
- **`handleApplyPatch` (backend):** Wired from the webview as required for **3.3**, but **`src/app.ts`** already performs **`vscode.workspace.applyEdit`** by line range **without** verifying **`originalCode`** against disk (plan **§7.2** / Phase **4.1** safety)—UI wiring is done; safe actuator semantics are not.
- **Tests:** Phase 3 coverage is **static substring checks** on **`panel.js` / `panel.css`** plus a mock **`HelperView`** object—**no** webview/DOM or end-to-end **`setScope` → co-pilot** interaction tests.
- **Minor label drift:** Quick chip **`🛡️ Scan PII`** vs plan **`🛡️ Scan PII & Leakage`**; helper chip row also includes pre–Loop 8 actions (**Find address**, **Probe local services**, **Troubleshoot connection**, telemetry/attribute)—beyond Phase **3.1**’s four diagnostics (+ compare).

### User checks (deferred)

- None.

## Phase 4: Phase 4: Actionable Codebase Patching & Workspace Application

**Scope:** Plan §6 Phase 4 (4.1 `applyTemplatePatch` + `originalCode` validation in `src/app.ts` / `src/contextTools.ts`, 4.2 comparative capture interrogation). Safety reference §7.2.

**Verification (2026-11-01):** `npm run compile` succeeds; `node --test test/contextCopilot.test.cjs` — **13/13 pass** (includes four Phase 4 tests: `validateTemplatePatchContent`, `diffCaptures`, `diff_captures` / dual `search_context`, mocked comparative harness flow).

### Discrepancies

- Phase 4 deliverables are **uncommitted** (modified **`src/app.ts`**, **`src/contextTools.ts`**, **`src/helperTools.ts`**; extended **`test/contextCopilot.test.cjs`**; relies on prior-phase **`media/panel.js`** pin/compare UI and **`applyPatch`** wiring).
- **4.1 actuator — core requirements met:** **`applyTemplatePatch`** opens the workspace file, calls **`validateTemplatePatchContent`** against **`originalCode`** at **`startLine`–`endLine`**, aborts with VS Code error + chat **`kind: "status"`** activity on mismatch, otherwise **`vscode.workspace.applyEdit`**, **`document.save()`**, information notification, success activity, and **`push()`**.
- **`patchId` handling:** Plan names **`applyTemplatePatch(patchId)`**; implementation also accepts **`patchCandidate`** from the webview (**`body.patch`**) and resolves **`const patch = patchCandidate || … this.activePatch`** — **`patchId` is not required to match** when **`activePatch`** is set (ignores stale/wrong id).
- **Apply vs validate semantics:** Validation compares the **line slice** to **`originalCode`** (with CRLF normalization and **`.trim()`** on both sides); the edit still replaces the **full start/end lines** with **`replacementCode`**. Edge cases where **`originalCode`** is a strict substring of those lines could pass validation but replace whole lines — not spelled out in the plan.
- **Confirmation UX:** Plan **4.1** asks for notification + chat feed confirmation (present). Plan **§5.3** “success confirmation badge” on the patch card is **not** added in Phase 4 (still a generic status activity row).
- **4.1 test gap:** **`validateTemplatePatchContent`** is unit-tested in **`contextTools`**; **`applyTemplatePatch`** (VS Code APIs) has **no** automated test — expected for extension host behavior.
- **4.2 comparative interrogation — largely met:** **`compareId` / `compare`** state, **`pinCapture`**, auto-compare previous capture on new ingress, side-by-side prompt columns when **`state.compare`**, **`createContextTools({ compareCapture })`** registers **`diff_captures`**, dual **`search_context`** via **`targetCapture`** (`primary` / `compare` / `both`), **`buildContextCopilotSystem`** injects comparison skeleton + **`diff_captures`** directive, and **`handleHelperMessage`** passes **`compareCapture`** into tools whenever a comparison capture is pinned.
- **`search_context` API extension:** **`targetCapture`** and dual-result shapes (**`primary`/`compare`** for **`both`**, **`compareMatches`** for **`compare`**) are **not** in plan **§3.1** — supportive of 4.2 but undocumented in the spec.
- **`read_context_section` / `inspect_code_template`:** Remain **primary-capture-only** even when a comparison capture is active — cross-capture Q&A depends on **`diff_captures`**, skeleton text, and scoped **`search_context`**, not verbatim section reads of the compare capture.
- **Compare scope pill (§5.1 / 4.2 UX):** Pinning a comparison capture **does not** post **`setScope` with `kind: "compare"`**; compare mode is implicit via backend state and side-by-side viewer. **`helperScopeBar`** compare copy remains unreachable unless the webview sets compare scope manually.
- **`compare_captures` quick chip:** Still sends **`buildCompareCapturesPrompt`** (ids/models/token totals only); full divergence grounding is via system **comparison skeleton** + tool calls, not the chip text itself (acceptable split but weaker than “cross-capture diffing” read literally on the chip alone).
- **Carry-over:** Phase 1 section-id / alias issues; Phase 3 patch card **`[Open in Editor]`** missing; **`clearHelperActivity`** clears whole feed on dismiss.

### User checks (deferred)

- None.

## Phase 5: Phase 5: Hackathon Showcase & Verification

**Scope:** Plan §6 Phase 5 (5.1 `HACKATHON_SHOWCASE.md`, 5.2 Co-Pilot demonstration in `test/fixtures.test.cjs`).

**Verification (2026-11-01):** `npm run compile` succeeds; `node --test --test-name-pattern "Context Interrogation" test/fixtures.test.cjs` — **1/1 pass** (11 sibling fixtures skipped by pattern).

### Discrepancies

- Phase 5 deliverables are **uncommitted** and **absent from `HEAD`**: modified **`HACKATHON_SHOWCASE.md`** (0 **`Loop 8`** mentions on committed tip) and **`test/fixtures.test.cjs`** (+254 lines); fixture imports **`buildContextSkeleton`**, **`buildContextCopilotSystem`**, **`buildDetectContradictionsPrompt`**, **`createContextTools`**, **`diffCaptures`**, **`validateTemplatePatchContent`** from compiled **`out/`** — depends on **untracked** **`src/contextTools.ts`** and prior-phase **`helperTools` / `app` / `media`** work not isolated on committed history.
- **5.1 showcase — requirements largely met:** New **§2 Loop 8** subsection (problem, Meta AI co-pilot, four plan tools + **`diff_captures`**, scoping/chips, closed-loop patching), **§3** fixture table row **Co-Pilot Fixture: RAG Interrogation & Patch**, **§4** video segment **[1:55–2:30]** elevating Loop 8 as the demo climax, and **§5** rubric rows updated for Loop 8 / workspace patching.
- **5.1 “interactive climax” framing:** Plan asks to document Loop 8 as the **interactive climax**; the doc still leads with Loops 1–7 in earlier sections—**climax emphasis is strongest in the 3-minute script**, not as a standalone capstone chapter.
- **Showcase vs live product (carry-over):** Marketing copy describes ideal scope pills, **`🛡️ Scan PII`**, and **`vscode.workspace.applyEdit`** patching; Phase **3–4** findings still apply (**compare scope pill unreachable**, no **`[Open in Editor]`**, chip label drift, patch-card edge cases).
- **5.2 fixture — plan trio covered with mocks:** Representative RAG capture (FooCorp rule vs retrieved docs), **`buildDetectContradictionsPrompt()`** user message, mocked **3-turn** harness invoking **`diff_captures`**, **`search_context`**, **`inspect_code_template`**, **`propose_template_patch`**, asserts final **`diffPreview`** and on-disk **`validateTemplatePatchContent`** + **`fs`** apply — aligned with **§7.3** hardware-safe testing, **not** live Muse API or extension-host **`applyTemplatePatch`**.
- **5.2 scope beyond plan bullet:** Fixture also asserts **`buildContextSkeleton`**, **`buildContextCopilotSystem`** (incl. **`diff_captures`** directive), and **`diffCaptures`** status/RAG divergence — **not** listed in plan **5.2** but supports showcase table narrative.
- **5.2 assertion gaps vs “context inquiry”:** No direct assertions on **`search_context`** match payloads, **`read_context_section`**, or **`inspect_code_template`** return bodies—only that the harness completes with a patch; **`read_context_section`** is not exercised in the scenario.
- **Fixture table vs test apply path:** Showcase table says patch **“applies to workspace”**; the test applies via **`fs.writeFileSync`** after validation, not **`vscode.workspace.applyEdit`** (reasonable for unit fixture, differs from end-user path).

### User checks (deferred)

- None.
