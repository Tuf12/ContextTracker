# Specification & Implementation Plan: Prompt Context Boundaries, Scoped Messaging & Sub-Section Attribution

**Document ID:** `SPEC-2026-LOOP8-DEBUG-01`  
**Status:** Approved for Implementation  
**Target:** Meta Global AI Developer Hackathon — Context Tracker (General Track & Best Agentic Use-Case)  
**Authors:** Context Tracker Engineering Team  

---

## 1. Executive Summary & Root-Cause Debugging Findings

During live testing with production multi-component prompts (e.g. OptimalX Desktop assistant prompts with extensive tool schemas, hierarchical app models, dynamic location states, and note routing rules), several critical discrepancies were identified between the intended design and runtime behavior:

### 1.1 Root-Cause Failure Analysis

| Issue | Observed Behavior | Root Cause in Codebase | User Impact |
| :--- | :--- | :--- | :--- |
| **1. Prompt "Blobbing" & Bleeding** | File spans and unmatched runtime content run together as flat, continuous text blocks. Unlinked sections look like they are part of the file above them. | In `media/panel.css`, `.block` only had `border-left: 3px solid`. No margin, card container, header bar, or distinct border framing exists between adjacent spans. | The user cannot discern where static template code ends and where injected dynamic runtime state begins. |
| **2. Scoped Messaging Disorientation** | Clicking `[💬 Ask AI]` causes the chat view to jump or scroll unpredictably, but the clicked section does **not** highlight. | In `media/panel.js`, `focusHelperConsole()` called `scrollIntoView()` on `#helper-console` inside the `aside` sidebar, disorienting the main prompt viewport. Neither the message, card, nor span applied an active CSS class based on `activeScope`. | The user feels like "nothing happened" because there is zero visual feedback on the prompt section they wanted to inspect. |
| **3. Lack of Direct Click-to-Scope** | Users cannot simply click on a section, card, or span to scope it. They must find a small `[💬 Ask AI]` button. | No `onClick` handler existed on `.anatomy-card`, `.tool-card`, or `.block`. Selection was restricted only to file opening (`openSpan`). | High friction; unintuitive interaction model contrary to the core product promise. |
| **4. Unlinked Sections Missing Code Attribution** | Sub-sections in multi-part prompts fail static indexing and remain unlinked with no recourse. | Static indexer (`src/indexer.ts`) requires \(\ge 20\) char lines with 2 consecutive matches. Attribution in `panel.js` only operated on the *entire message*, sending the whole 2,000+ char string rather than the specific unlinked sub-section. | Prompts that contain 3 or 4 distinct templates plus runtime data cannot be attributed granularly. |
| **5. Latency in Scope Indicator** | Scope pill updates only after an asynchronous WebSocket/message round-trip to the VS Code backend. | `setScope` posted to the backend and waited for `this.push()`, delaying the local UI update. | Noticeable visual lag before the Scope Bar reflects the user's click. |

---

## 2. Architecture & Design Specification

### 2.1 Visual Section Boundary Framing (Eliminating "Blobs")

Every message will no longer render as a flat gutter-bordered text stream. Instead, every distinct slice of context will be housed within an **Isolated Content Card**:

```
+--------------------------------------------------------------------------------------------------+
| 🟢 SECTION 1: SYSTEM DIRECTIVE — Persona & Role Definition [prompts/system.prompt : lines 1–12] |
| 450 tokens · 4% of context · Matched in codebase                                                 |
+--------------------------------------------------------------------------------------------------+
| You are Eidos, the AI assistant in OptimalX Desktop...                                           |
+--------------------------------------------------------------------------------------------------+
                                                |
                                      [Explicit Boundary]
                                                v
+--------------------------------------------------------------------------------------------------+
| ⚡ SECTION 2: DYNAMIC RUNTIME STATE — Injected Session Context                                   |
| 112 tokens · 1% of context · Unlinked Runtime State               [✨ Trace Section in Code]     |
+--------------------------------------------------------------------------------------------------+
| Current date and time: Saturday, October 31, 2026 at 9:07 AM CDT.                                |
| Active scope: general | Location: OptimalX                                                       |
+--------------------------------------------------------------------------------------------------+
                                                |
                                      [Explicit Boundary]
                                                v
+--------------------------------------------------------------------------------------------------+
| 🟢 SECTION 3: SYSTEM DIRECTIVE — OptimalX App Model & Note Routing                               |
| 620 tokens · 6% of context · [✨ Trace Section in Code]                                         |
+--------------------------------------------------------------------------------------------------+
| OptimalX app model: Hierarchy: Parent folder -> Subfolder...                                     |
+--------------------------------------------------------------------------------------------------+
```

#### Key Visual Attributes:
1. **Card Border & Separation:** Each `.block` receives a full subtle border (`1px solid var(--vscode-widget-border)`), rounded corners (`4px`), and distinct vertical spacing (`margin-bottom: 8px`).
2. **Distinct Block Headers:**
   - **Template File Blocks (`.block.file` / `.block.attributed`):** Feature a top banner with file path, line numbers, and an interactive `[Open in Editor ↗]` link.
   - **Runtime State Blocks (`.block.runtime`):** Feature a distinct badge (`⚡ Dynamic Runtime State / Unlinked`), a soft warning-tinted left accent, and an inline `[✨ Trace Section in Code]` button.
3. **Boundary Dividers:** When an injected runtime block directly abuts a static template block, a visual divider explicitly labels the boundary: `--- Dynamic Runtime Injection Boundary ---`.

---

### 2.2 Scoped Messaging & Interaction Flow

The interaction model is redesigned so clicking **anywhere on a section** immediately focuses and scopes Meta AI without disorienting page jumps:

```
[ Developer clicks on Section Card or Span ]
                     |
                     v
+-------------------------------------------------------------------+
| 1. Instant Local State Update:                                    |
|    - activeScope = { kind: "section", sectionId, label, ... }     |
|    - scopedSectionId = sectionId                                  |
| 2. Visual Highlighting Applied:                                   |
|    - Selected section gets .is-scoped (bright focus border + glow)|
|    - Scope Pill badge appears: [🎯 Active Target for Meta AI]     |
|    - Single pulse animation draws user's focus                    |
| 3. Helper Chat Synchronization:                                   |
|    - Ensure sidebar chat is visible (uncollapse if needed)        |
|    - Update Scope Bar: [Scope: Section msg-0-sys-1 (340t) ✕]      |
|    - Focus .helper-input WITHOUT scrolling main prompt away       |
|    - Set placeholder: "Ask Meta AI about <Section Name>..."       |
| 4. Async Dispatch:                                                |
|    - post({ type: "setScope", scope: ... })                       |
+-------------------------------------------------------------------+
```

#### Guarding Against Viewport Jumps:
- Instead of calling `helperConsole.scrollIntoView()`, the UI detects that the chat is already co-located in the sidebar (`surface === "editor"`).
- It simply calls `input.focus()` directly. The main prompt viewport stays locked exactly where the developer is reading, while the chat input is immediately active and awaiting their query.

---

### 2.3 Sub-Span & Sub-Section Attribution Grounding

When a prompt contains multiple templates or dynamic fragments, developers can attribute individual chunks directly:

1. **Inline Trace Action on Every Unlinked Slice:**
   - Every `.block.runtime` contains an inline `[✨ Trace Section in Code]` button.
   - Clicking this button dispatches:
     ```javascript
     post({
       type: "attributeMessage",
       captureId: capture.id,
       messageIndex: messageIndex,
       content: span.text,
     });
     ```
2. **Backend Sub-Span Matching:**
   - `src/app.ts` (`attributeCaptureMessage`) already accepts `{ content?: string }`.
   - The attribution result is mapped back into `capture.reported` with the specific `charStart` and `charEnd` offsets of that slice.
   - The UI transforms that runtime block into a verified purple `✨ Attributed by Meta AI` card linked to the exact template file and line range.

---

## 3. Phased Implementation Plan

```
+---------------------------------------------------------------------------------------+
| PHASE 1: Visual Boundaries & Blob Elimination                                         |
| - Restyle .block into isolated section cards with margins, headers, and distinct borders |
| - Add Runtime vs File header banners with inline actions                              |
| - Add boundary dividers between static template code and dynamic runtime variables    |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| PHASE 2: Click-to-Scope & Persistent Highlighting                                     |
| - Make all Anatomy Cards, Tool Cards, and Content Blocks clickable to set scope       |
| - Add .is-scoped CSS styles (focus ring, glowing pill, pulse animation)             |
| - Fix focusHelperConsole() to prevent disorienting viewport jumps                     |
| - Provide instant local optimistic state update for zero-latency scope bar updates    |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| PHASE 3: Sub-Span Attribution & Codebase Grounding                                    |
| - Add [✨ Trace Section in Code] buttons to unlinked / runtime slices                 |
| - Wire sub-span content slicing into attribution dispatch                             |
| - Support character offset placement for attributed sub-spans                         |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| PHASE 4: Verification & Automated Regression Testing                                  |
| - Run non-resource-intensive unit tests for telemetry and context tools               |
| - Verify real-world multi-part system prompts (e.g. OptimalX Desktop)                 |
| - Verify tool hygiene reviews (e.g. vision tools in text chats, destructive tools)     |
+---------------------------------------------------------------------------------------+
```

---

### Phase 1: Visual Boundaries & Blob Elimination

#### Files Affected:
- `media/panel.css`
- `media/panel.js`

#### Tasks:
1. **Refactor `.block` CSS:**
   - Replace flat left border with a fully contained card:
     ```css
     .block {
       display: flex;
       flex-direction: column;
       margin-bottom: 8px;
       border-radius: 5px;
       background: var(--vscode-editor-background);
       border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
       border-left: 4px solid var(--vscode-descriptionForeground);
       overflow: hidden;
       transition: border-color 0.15s ease, box-shadow 0.15s ease;
     }
     .block.file { border-left-color: var(--vscode-charts-blue); }
     .block.reported { border-left-color: var(--vscode-charts-green); }
     .block.attributed { border-left-color: var(--vscode-charts-purple, #b180d7); }
     .block.runtime { border-left-color: var(--vscode-charts-orange, #f97316); }
     ```
2. **Build Block Header Bar:**
   - Add `.block-header` containing:
     - Badge for origin (`📄 Template File`, `✨ Attributed Template`, `⚡ Injected Runtime State`)
     - Source file location and line numbers (if available)
     - Inline action button: `[Open ↗]` for files, `[✨ Trace in Code]` for runtime blocks
     - Inline `[🎯 Target Scope]` chip to scope Meta AI
3. **Explicit Boundary Dividers:**
   - Add a subtle transition divider between consecutive blocks of differing origins.

---

### Phase 2: Click-to-Scope & Persistent Highlighting

#### Files Affected:
- `media/panel.js`
- `media/panel.css`

#### Tasks:
1. **Interactive Click Handlers:**
   - Attach click listeners to:
     - `.anatomy-card`
     - `.tool-card`
     - `.block`
   - Clicking any of these executes `setScopedSection(sectionId, messageIndex, label, category, categoryLabel)`.
2. **Visual Highlight Styling (`.is-scoped`):**
   - Define active focus styles:
     ```css
     .is-scoped {
       border-color: var(--vscode-focusBorder, #007fd4) !important;
       box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4), 0 0 12px rgba(0, 127, 212, 0.25);
       background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 5%, var(--vscode-editor-background));
     }
     ```
   - Render an active pill inside the scoped card:
     ```html
     <span class="scoped-active-badge">🎯 Active AI Scope</span>
     ```
3. **Fix Focus & Viewport Jumps:**
   - In `focusHelperConsole()`:
     - Check if `helper-console` is already visible in the viewport or sidebar.
     - Only focus the input: `input.focus()`.
     - Remove the jarring `scrollIntoView()` on the helper console when in two-column editor layout.
     - Update input placeholder dynamically to reflect the scoped section.
4. **Optimistic Local State:**
   - Update `state.helper.activeScope` immediately on click in JavaScript, then post to the extension host. This guarantees instantaneous UI updates.

---

### Phase 3: Sub-Span Attribution & Codebase Grounding

#### Files Affected:
- `media/panel.js`
- `src/app.ts`
- `src/matcher.ts`

#### Tasks:
1. **Sub-Span Attribution Button in UI:**
   - In `renderSpan()`, if `span.kind === "runtime"`, render an interactive button: `[✨ Trace Section in Code]`.
   - On click, triggers `attributeMessage(capture.id, messageIndex, span.text)`.
2. **Offset-Aware Span Placement:**
   - When Meta AI attributes a sub-span, `src/matcher.ts` places the resulting `FileSpan` using `item.quote` or exact character intervals, slicing the runtime gap into a verified file span without corrupting other sections.

---

### Phase 4: Verification & Automated Regression Testing

#### Files Affected:
- `test/telemetry.test.cjs`
- `test/contextTools.test.cjs`

#### Tasks:
1. **Unit Testing:**
   - Verify tool schema decomposition into individual functions.
   - Verify tool hygiene second opinions (`recommended`, `unnecessary`, `bloat`, `security_risk`).
   - Verify multi-part system prompt splitting into custom headings.
   - Run existing unit tests via `node --test test/telemetry.test.cjs` (conforming to the rule prohibiting heavy back-to-back app runs).
2. **Manual End-to-End Walkthrough:**
   - Open a multi-part capture (e.g. OptimalX Desktop).
   - Click a tool card: verify immediate highlight, scope pill update, and input focus without viewport jumping.
   - Click an unlinked runtime section: verify distinct card boundaries, click-to-scope, and `[✨ Trace Section in Code]` functionality.

---

## 4. Acceptance Criteria

- [ ] **No Blobbing:** Every prompt message is visually partitioned into crisp, bordered cards with distinct headers.
- [ ] **Instant Click-to-Scope:** Clicking any anatomy card, tool card, or content block immediately scopes the chat.
- [ ] **Persistent Visual Highlighting:** The active scoped section is styled with a distinct focus ring, glow, and active badge.
- [ ] **No Disorienting Viewport Jumps:** Focusing chat does not scroll the main prompt view away from the active section.
- [ ] **Sub-Span Attribution:** Developers can trace specific unlinked runtime sections directly to source templates.
- [ ] **Test Compliance:** All unit tests pass cleanly without violating resource constraints.
