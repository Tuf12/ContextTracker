let asideScrollTop = 0;
let detailScrollTop = 0;

(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let state = null;
  let confirmClear = false;
  let selectedSpan = null;
  let seenCapture = null;
  let scrollTop = 0;
  let helperChoice = null;
  let helperKey = "";
  let helperMessageInput = "";
  let activeSidebarTab = "helper"; // "helper" | "prompt"
  let collapsed = {
    project: false,
    recorder: false,
    capture: false,
  };

  const SPAN_EXAMPLE = [
    "{",
    '  "id": "my-request-1",',
    '  "spans": [',
    "    {",
    '      "quote": "Answer only from the product docs.",',
    '      "file": "prompts/system.md",',
    '      "startLine": 2,',
    '      "endLine": 2',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  let attributingMessage = null;

  window.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "state") {
      return;
    }
    state = event.data.state;
    if (state.helper && !state.helper.busy) {
      attributingMessage = null;
    }
    render();
  });

  vscode.postMessage({ type: "ready" });

  function render() {
    const scroller = document.scrollingElement;
    if (scroller) {
      scrollTop = scroller.scrollTop;
    }
    const existingAside = document.querySelector(".layout-editor > aside");
    const existingDetail = document.getElementById("detail");
    if (existingAside) {
      asideScrollTop = existingAside.scrollTop;
    }
    if (existingDetail) {
      detailScrollTop = existingDetail.scrollTop;
    }
    const sameCapture = state && state.selectedId === seenCapture;
    const activeIsHelperInput = document.activeElement && document.activeElement.classList.contains("helper-input");
    try {
      app.replaceChildren();
      if (!state || !state.project) {
        app.append(welcome());
        return;
      }
      ensureLocals();
      app.append(shell());
      seenCapture = state.selectedId;
      if (sameCapture && scroller) {
        scroller.scrollTop = scrollTop;
      }
      const newAside = document.querySelector(".layout-editor > aside");
      if (newAside) {
        newAside.scrollTop = asideScrollTop;
      }
      const newDetail = document.getElementById("detail");
      if (newDetail && sameCapture) {
        newDetail.scrollTop = detailScrollTop;
      }
      if (activeIsHelperInput) {
        const input = document.querySelector(".helper-input");
        if (input) {
          input.focus();
        }
      }
      const feed = document.getElementById("helper-feed");
      if (feed && state.helper && state.helper.busy) {
        feed.scrollTop = feed.scrollHeight;
      }
    } catch (error) {
      app.replaceChildren();
      app.append(h("p", { class: "banner" }, error instanceof Error ? error.message : "The prompt view failed to draw."));
    }
  }

  function ensureLocals() {
    if (state.selectedId !== seenCapture) {
      selectedSpan = null;
    }
  }

  function welcome() {
    return h("section", { class: "welcome" },
      h("h1", null, "Context Tracker"),
      h("p", { class: "lede" }, "Load a project, run it, and send a message to the model. The prompt that went out shows up here, and any slice that matches a file opens in the editor."),
      h("button", { class: "primary", onClick: send("openProject") }, "Load a project"));
  }

  function shell() {
    const surface = document.body.dataset.surface;
    if (surface === "sidebar") {
      return sidebarShell();
    }
    return editorShell();
  }

  function sidebarShell() {
    const hasCapture = Boolean(state.selected);
    return h("div", { class: "layout layout-sidebar", id: "shell" },
      header("sidebar"),
      projectCard(),
      recorderCard(),
      captureCard(),
      hasCapture ? sidebarTabs() : null,
      (!hasCapture || activeSidebarTab === "helper")
        ? helperConsole({ inAside: true })
        : promptColumn(state.selected, null));
  }

  function editorShell() {
    return h("div", { class: "layout layout-editor", id: "shell" },
      h("aside", { class: "stack sidebar-panel" },
        header("editor"),
        projectCard(),
        recorderCard(),
        captureCard(),
        helperConsole({ inAside: true })),
      h("main", { class: "detail", id: "detail" }, detail()));
  }

  function sidebarTabs() {
    const isHelper = activeSidebarTab === "helper";
    const helperActivityCount = state.helper && state.helper.activity ? state.helper.activity.length : 0;
    const isBusy = Boolean(state.helper && state.helper.busy);
    return h("div", { class: "sidebar-view-tabs" },
      h("button", {
        class: "tab-btn" + (isHelper ? " active" : "") + (isBusy ? " pulse" : ""),
        onClick: () => { activeSidebarTab = "helper"; render(); },
        title: "Switch to Meta AI Helper & Chat console",
      }, isBusy ? "● Meta AI Working…" : `🤖 AI Helper (${helperActivityCount})`),
      h("button", {
        class: "tab-btn" + (!isHelper ? " active" : ""),
        onClick: () => { activeSidebarTab = "prompt"; render(); },
        title: "View captured prompt details",
      }, "📄 Prompt Details"));
  }

  function header(surface) {
    return h("div", { class: "spread" },
      h("h1", null, "Context Tracker"),
      h("div", { class: "row", style: "gap:4px;" },
        h("button", { class: "ghost icon-btn", onClick: focusHelperConsole, title: "Scroll down to Meta AI Helper Chat" }, "💬 Chat"),
        surface === "sidebar" ? h("button", { class: "secondary icon-btn", onClick: send("openBeside") }, "Open in tab") : null));
  }

  function projectCard() {
    const project = state.project;
    const isCollapsed = collapsed.project;
    const count = project.indexing
      ? "Indexing files…"
      : project.fileCount.toLocaleString("en-US") + " files indexed" + (project.truncated ? " (stopped at limit)" : "");
    return h("section", { class: "card" },
      h("div", { class: "spread" },
        h("div", {
          class: "clickable-header",
          onClick: () => { collapsed.project = !collapsed.project; render(); },
          title: isCollapsed ? "Expand Project card" : "Collapse Project card",
        },
          h("span", { class: "collapse-arrow" }, isCollapsed ? "▸" : "▾"),
          h("h2", { style: "margin:0;" }, project.name)),
        h("div", { class: "row", style: "gap:4px;" },
          project.indexing ? null : h("button", { class: "ghost icon-btn", onClick: send("reindex"), title: "Index files again" }, "Reindex"),
          h("button", { class: "ghost icon-btn", onClick: send("openProject") }, "Change"))),
      isCollapsed ? null : h("p", { class: "quiet", id: "file-count", style: "font-size:11px;" }, count),
      isCollapsed ? null : h("button", { class: "secondary", style: "font-size:11px;padding:3px 8px;margin-top:2px;", onClick: send("openHelper") }, helperButtonLabel(state.helper)),
      !isCollapsed && state.helper && helperVisible(state.helper) ? helperCard(state.helper) : null);
  }

  function recorderCard() {
    const recorder = state.recorder;
    const helper = state.helper;
    const isCollapsed = collapsed.recorder;
    const trafficState = recorder.trafficState || (recorder.running ? "listening" : "off");
    const count = recorder.requestCount || 0;
    const uptime = recorder.uptimeSeconds || 0;

    let trafficSummary = null;
    if (recorder.running) {
      if (trafficState === "active") {
        trafficSummary = `Traffic active · ${count} request${count === 1 ? "" : "s"} (${uptime}s)`;
      } else if (trafficState === "listening_idle") {
        trafficSummary = `Listening idle · 0 requests (${uptime}s)`;
      } else {
        trafficSummary = `Listening on port 47321 (${uptime}s)`;
      }
    }

    return h("section", { class: "card" },
      h("div", { class: "spread" },
        h("div", {
          class: "clickable-header",
          onClick: () => { collapsed.recorder = !collapsed.recorder; render(); },
          title: isCollapsed ? "Expand Capture card" : "Collapse Capture card",
        },
          h("span", { class: "collapse-arrow" }, isCollapsed ? "▸" : "▾"),
          h("h2", { style: "margin:0;" }, "Capture")),
        h("span", { class: recorder.running ? "badge badge-ready" : "badge badge-idle" },
          recorder.running ? "● Active (47321)" : "○ Off")),
      isCollapsed ? null : trafficSummary ? h("p", { class: "quiet", style: "font-weight:600;font-size:11px;margin:2px 0;" }, trafficSummary) : null,
      isCollapsed ? null : recorder.missedHint
        ? h("p", { class: "banner warning", style: "margin:6px 0;" }, recorder.missedHint)
        : null,
      isCollapsed ? null : recorder.found
        ? h("div", { class: "spread" },
            h("p", { class: "quiet", style: "word-break:break-word;font-size:11px;" }, recorder.found),
            recorder.running
              ? null
              : h("button", { class: "ghost icon-btn", onClick: send("forgetAddress"), title: "Disconnect this address and let the AI helper search again" }, "Disconnect"))
        : null,
      isCollapsed ? null : recorder.error ? h("p", { class: "banner" }, recorder.error) : null,
      isCollapsed ? null : h("div", { class: "row", style: "margin-top:4px;" },
        state.helper && state.helper.busy
          ? h("button", { class: "primary", disabled: true }, "AI helper is working…")
          : recorder.running
            ? h("button", { class: "secondary", onClick: send("stopCapture") }, "Stop capture")
            : h("button", { class: "primary", onClick: send("startCapture") }, "Start capture"),
        recorder.running
          ? h("button", { class: "secondary", onClick: send("troubleshootConnection"), title: "Diagnose why prompts might be bypassing Context Tracker" }, "Troubleshoot")
          : null,
        !recorder.running && helper && !helper.busy && (helper.keySaved || !recorder.found)
          ? h("button", { class: "secondary", onClick: send("findAddress"), title: "Use the AI helper to search the project for the model address" }, "Find address")
          : null,
        h("button", { class: "ghost icon-btn", onClick: send("showLog") }, "Log")));
  }

  function helperButtonLabel(helper) {
    if (helper && helper.keySaved && helper.model) {
      const choice = (helper.choices || []).find((item) => item.id === helper.model);
      return "AI helper: " + (choice ? choice.label : "Meta");
    }
    return "Connect AI helper";
  }

  function helperVisible(helper) {
    return helper.connectOpen || helper.offer || helper.busy || (helper.needed && !helper.keySaved);
  }

  function helperCard(helper) {
    if (!helperChoice && helper.model) {
      helperChoice = helper.model;
    }
    const choices = helper.choices || [];
    return h("div", { class: "stack" },
      helper.connectOpen ? h("p", { class: "quiet" }, "The API key stays in the editor and is sent only to Meta. Muse Spark 1.3 Contributor is the lower-cost choice. Meta may use what that helper reads to train future models.") : null,
      helper.connectOpen ? h("label", { class: "field" }, "Meta model",
        h("select", { onChange: (event) => { helperChoice = event.target.value; } },
          h("option", { value: "", selected: !helperChoice }, "Choose a Meta model"),
          ...choices.map((choice) => h("option", { value: choice.id, selected: choice.id === helperChoice }, choice.label)))) : null,
      helper.connectOpen ? h("label", { class: "field" }, helper.keySaved ? "API key saved. Enter a new key to replace it." : "API key",
        h("input", {
          type: "password",
          value: helperKey,
          onInput: (event) => { helperKey = event.target.value; },
        })) : null,
      helper.status ? h("p", { class: helper.busy ? "note" : "quiet" }, helper.status) : null,
      helper.offer && helper.offer.explanation
        ? h("p", { class: "banner warning", style: "margin:6px 0;" }, helper.offer.explanation)
        : null,
      helper.offer ? h("p", { class: "note" }, helper.offer.relativeFile + " line " + helper.offer.line + " · " + helper.offer.url) : null,
      h("div", { class: "row" },
        helper.connectOpen ? h("button", { class: "secondary", onClick: saveHelper }, "Connect") : null,
        !helper.busy && !state.recorder.running && !helper.offer
          ? h("button", { class: "secondary", onClick: send("findAddress"), title: "Use the AI helper to search the project for the model address" }, "Find address with AI helper")
          : null,
        helper.offer
          ? h("button", { class: "primary", onClick: send("confirmAddress") }, helper.offer.explanation ? "Switch connection" : "Use this address")
          : null,
        helper.offer
          ? h("button", { class: "ghost", onClick: send("dismissAddress") }, "Not this address")
          : null));
  }

  function saveHelper() {
    post({ type: "saveHelper", model: helperChoice || "", apiKey: helperKey });
    helperKey = "";
  }

  function captureCard() {
    const isCollapsed = collapsed.capture;
    return h("section", { class: "card" },
      h("div", { class: "spread" },
        h("div", {
          class: "clickable-header",
          onClick: () => { collapsed.capture = !collapsed.capture; render(); },
          title: isCollapsed ? "Expand Calls card" : "Collapse Calls card",
        },
          h("span", { class: "collapse-arrow" }, isCollapsed ? "▸" : "▾"),
          h("h2", { style: "margin:0;" }, `Calls (${state.captures.length})`)),
        state.captures.length && !isCollapsed
          ? h("button", { class: "ghost icon-btn", onClick: requestClear }, confirmClear ? "Confirm clear" : "Clear")
          : null),
      isCollapsed ? null : state.captures.length === 0
        ? h("p", { class: "quiet", style: "font-size:11px;" }, "No calls yet. Send a prompt from your app.")
        : h("div", { class: "capture-list" }, ...state.captures.map(captureButton)));
  }

  function requestClear() {
    if (!confirmClear) {
      confirmClear = true;
      render();
      return;
    }
    confirmClear = false;
    post({ type: "clearCaptures" });
  }

  function captureButton(capture) {
    const when = formatTime(capture.createdAt);
    const status = capture.status ? "HTTP " + capture.status : capture.error ? "Not sent" : "Waiting";
    const pinned = capture.id === state.compareId;
    const isSelected = capture.id === state.selectedId;
    return h("div", { class: "capture" + (isSelected ? " selected" : "") },
      h("button", {
        class: "capture-open",
        onClick: () => {
          post({ type: "selectCapture", id: capture.id });
          activeSidebarTab = "prompt";
          render();
        },
      },
        h("div", { class: "spread" },
          h("span", null, when),
          h("span", { class: "meta" }, status)),
        h("div", null, capture.model),
        h("div", { class: "quiet" },
          (capture.fileSpanCount > 0 ? capture.fileSpanCount + " source links · " : "") + capture.preview)),
      state.captures.length > 1 && capture.id !== state.selectedId
        ? h("button", { class: "ghost icon-btn", onClick: () => post({ type: "pinCapture", id: capture.id }) }, pinned ? "Unpin" : "Pin")
        : null);
  }

  function detail() {
    if (!state.selected) {
      return h("section", { class: "stack getting-started" },
        h("h2", null, "Context Window Inspector"),
        h("ol", { class: "steps" },
          h("li", null, "Click Start capture."),
          h("li", null, "Start your AI app (or restart it if already running)."),
          h("li", null, "Send a prompt message from your AI app."),
          h("li", null, "The prompt context window appears here, with source file attribution and token analysis.")),
        h("p", { class: "quiet" }, "Select any call on the left to inspect its system instructions, dynamic parameters, and token breakdown."));
    }
    if (state.compare) {
      const older = state.compare.createdAt <= state.selected.createdAt ? state.compare : state.selected;
      const newer = older === state.compare ? state.selected : state.compare;
      return h("div", { class: "compare" },
        promptColumn(older, "Older"),
        promptColumn(newer, "Newer"));
    }
    return promptColumn(state.selected, null);
  }

  function promptColumn(capture, which) {
    const spans = flatten(capture);
    const surface = document.body.dataset.surface;

    return h("section", { class: "stack prompt-column" },
      h("div", { class: "spread" },
        h("h2", null, which ? which + " · " + capture.model : capture.model),
        h("div", { class: "row", style: "gap:6px;" },
          surface === "sidebar"
            ? h("button", {
                class: "pill-jump",
                onClick: () => { activeSidebarTab = "helper"; render(); },
                title: "Switch to Meta AI Helper & Chat console",
              }, "🤖 AI Helper Chat")
            : null,
          h("button", { class: "ghost icon-btn", onClick: () => post({ type: "deleteCapture", id: capture.id }) }, "Delete call"))),
      h("p", { class: "meta" }, [
        formatTime(capture.createdAt),
        capture.provider,
        capture.upstream,
        capture.endpoint,
        capture.status ? "HTTP " + capture.status : "No HTTP status",
      ].join(" · ")),
      capture.error ? h("p", { class: "banner" }, capture.error) : null,
      h("p", { class: "quiet" },
        "About " + capture.estimatedTokens.toLocaleString("en-US") + " tokens in the prompt · " +
        (capture.fileSpanCount > 0 ? (capture.fileSpanCount + " sections matched to project files") : "No matching source files")),
      bar(capture, spans),
      ...capture.messages.map((message, idx) => renderMessage(capture, message, idx)),
      h("section", { class: "reply" },
        h("h2", null, "Model reply"),
        h("p", { class: "quiet" }, "About " + capture.replyEstimatedTokens.toLocaleString("en-US") + " tokens · characters ÷ 4. This text was written by the model."),
        h("pre", null, capture.reply.trim() ? capture.reply : "No text came back.")),
      which ? null : exactHelp());
  }

  function focusHelperConsole() {
    activeSidebarTab = "helper";
    render();
    setTimeout(() => {
      const el = document.getElementById("helper-console");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      const input = document.querySelector(".helper-input");
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 40);
  }

  function submitHelperMessage() {
    const text = helperMessageInput.trim();
    if (!text) {
      return;
    }
    post({ type: "helperMessage", text: text });
    helperMessageInput = "";
    render();
  }

  function helperChoiceLabel(modelId) {
    if (!state.helper || !state.helper.choices) return modelId;
    const choice = state.helper.choices.find((c) => c.id === modelId);
    return choice ? choice.label : modelId;
  }

  function helperConsole(options) {
    const helper = state.helper;
    const inAside = Boolean(options && options.inAside);
    const activity = (helper && helper.activity) || [];
    const busy = Boolean(helper && helper.busy);
    const modelName = helper && helper.model ? (helperChoiceLabel(helper.model) || helper.model) : "Meta Muse";

    const statusBadge = busy
      ? h("span", { class: "badge badge-busy pulse" }, "● " + (helper.status || "Working…"))
      : helper && helper.keySaved
        ? h("span", { class: "badge badge-ready" }, "● Ready")
        : h("span", { class: "badge badge-idle" }, "○ Needs Key");

    const header = h("div", { class: "helper-console-header spread" },
      h("div", { class: "row", style: "gap:6px;" },
        h("span", { style: "font-size:14px;" }, "🤖"),
        h("h3", { style: "margin:0;font-size:12px;font-weight:600;" }, "Meta AI Helper"),
        h("span", { class: "helper-model-pill" }, modelName),
        statusBadge),
      h("div", { class: "row", style: "gap:4px;" },
        activity.length > 0
          ? h("button", { class: "ghost icon-btn", onClick: () => post({ type: "clearHelperActivity" }), title: "Clear activity log" }, "Clear")
          : null,
        !helper || !helper.keySaved
          ? h("button", { class: "secondary icon-btn", onClick: send("openHelper") }, "Connect")
          : null));

    const feed = h("div", {
      class: "helper-feed" + (inAside ? " helper-feed-aside" : " helper-feed-expanded"),
      id: "helper-feed",
    },
      activity.length === 0
        ? helperEmptyState()
        : activity.map(renderActivityItem));

    return h("section", { class: "helper-console" + (inAside ? " helper-console-aside" : ""), id: "helper-console" },
      header,
      feed,
      helperQuickChips(Boolean(state.selected)),
      helperInputRow());
  }

  function helperEmptyState() {
    return h("div", { class: "helper-empty" },
      h("div", { class: "spread" },
        h("strong", null, "Meta AI Assistant"),
        h("span", { class: "meta" }, "Muse Spark / Wonder")),
      h("p", { class: "quiet" }, "Ask questions about your prompts, investigate local AI services, or let Meta AI search your codebase for connection addresses."),
      h("p", { class: "note", style: "margin-top:4px;" }, "Type below or click a quick action to start."));
  }

  function renderActivityItem(item) {
    const time = formatTime(item.timestamp);
    if (item.kind === "thought") {
      return h("div", { class: "helper-item helper-thought" },
        h("div", { class: "helper-item-header" },
          h("span", { class: "helper-badge thought-badge" }, "💭 Meta AI Thought"),
          h("span", { class: "helper-time" }, time)),
        h("div", { class: "helper-thought-body" }, item.text));
    }
    if (item.kind === "tool_call") {
      return h("div", { class: "helper-item helper-tool-call" },
        h("div", { class: "helper-item-header spread" },
          h("div", { class: "row", style: "gap:6px;" },
            h("span", { class: "helper-badge tool-badge" }, "⚙️ Sensory Tool"),
            h("code", { class: "helper-code" }, item.text)),
          h("span", { class: "helper-time" }, time)),
        item.detail && item.detail !== "{}" && item.detail !== item.text
          ? h("pre", { class: "helper-pre-args" }, item.detail)
          : null);
    }
    if (item.kind === "tool_result") {
      return h("div", { class: "helper-item helper-tool-result" },
        h("div", { class: "helper-item-header" },
          h("span", { class: "helper-badge result-badge" }, "📋 Output: " + (item.toolName || "tool"))),
        h("pre", { class: "helper-pre" }, item.text));
    }
    if (item.kind === "finish") {
      return h("div", { class: "helper-item helper-finish" },
        h("div", { class: "helper-item-header" },
          h("span", { class: "helper-badge finish-badge" }, "🎯 Outcome"),
          h("span", { class: "helper-time" }, time)),
        h("p", { class: "helper-finish-text" }, item.text),
        item.detail ? h("p", { class: "quiet", style: "margin-top:4px;" }, item.detail) : null);
    }
    if (item.kind === "user") {
      return h("div", { class: "helper-item helper-user" },
        h("div", { class: "helper-item-header" },
          h("span", { class: "helper-badge user-badge" }, "👤 You"),
          h("span", { class: "helper-time" }, time)),
        h("p", { class: "helper-user-text" }, item.text));
    }
    return h("div", { class: "helper-item helper-status" },
      h("span", { class: "helper-status-icon" }, "ℹ️"),
      h("span", { class: "helper-status-text" }, item.text));
  }

  function helperQuickChips(hasSelectedCapture) {
    const busy = Boolean(state.helper && state.helper.busy);
    const chips = [];
    chips.push(h("button", {
      class: "chip-btn",
      disabled: busy,
      onClick: send("findAddress"),
      title: "Run autonomous search across codebase and local services for the model endpoint",
    }, "🔍 Find address"));

    chips.push(h("button", {
      class: "chip-btn",
      disabled: busy,
      onClick: () => {
        post({ type: "helperMessage", text: "Detect active local AI services on standard ports (Ollama, LM Studio, vLLM)." });
      },
      title: "Probe standard ports for active local AI engines",
    }, "🔌 Probe local services"));

    chips.push(h("button", {
      class: "chip-btn",
      disabled: busy,
      onClick: send("troubleshootConnection"),
      title: "Diagnose why outbound requests may be bypassing the recorder",
    }, "🩺 Troubleshoot connection"));

    if (hasSelectedCapture && state.selected && state.selected.messages.some((m) => m.role !== "assistant" && !m.spans.some((s) => s.kind === "file"))) {
      chips.push(h("button", {
        class: "chip-btn chip-highlight",
        disabled: busy,
        onClick: () => {
          post({ type: "attributeMessage", captureId: state.selected.id, messageIndex: 0 });
        },
        title: "Attribute dynamic prompt message to source template using Meta AI",
      }, "✨ Attribute prompt"));
    }

    return h("div", { class: "helper-chips" }, ...chips);
  }

  function helperInputRow() {
    return h("div", { class: "helper-input-row" },
      h("input", {
        type: "text",
        class: "helper-input",
        placeholder: "Ask Meta AI helper or direct sensory tools (e.g. 'search for ollama port')...",
        value: helperMessageInput,
        onInput: (event) => { helperMessageInput = event.target.value; },
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitHelperMessage();
          }
        },
      }),
      h("button", {
        class: "primary helper-send-btn",
        disabled: Boolean(state.helper && state.helper.busy),
        onClick: submitHelperMessage,
      }, "Send"));
  }

  function barClass(span) {
    if (span.source === "attributed") {
      return "bar-attributed";
    }
    if (span.source === "reported") {
      return "bar-reported";
    }
    if (span.kind === "runtime") {
      return "bar-runtime";
    }
    return "bar-file";
  }

  function bar(capture, spans) {
    if (spans.length === 0) {
      return null;
    }
    const total = spans.reduce((sum, span) => sum + Math.max(1, span.text.length), 0);
    const hasFile = spans.some((span) => span.kind === "file" && span.source !== "reported" && span.source !== "attributed");
    const hasReported = spans.some((span) => span.source === "reported");
    const hasAttributed = spans.some((span) => span.source === "attributed");
    const hasRuntime = spans.some((span) => span.kind === "runtime");
    return h("div", { class: "stack" },
      h("div", { class: "bar", role: "group", "aria-label": "Prompt slices" },
        ...spans.map((span) => h("button", {
          class: barClass(span),
          style: "flex:" + Math.max(1, span.text.length) + " 1 0",
          title: span.label,
          onClick: () => focusSpan(capture, span.id),
        }))),
      h("div", { class: "legend" },
        hasFile ? legend("bar-file", "Matched in the project (click to open file)") : null,
        hasReported ? legend("bar-reported", "Marked by your app") : null,
        hasAttributed ? legend("bar-attributed", "Attributed by Meta AI") : null,
        hasRuntime ? legend("bar-runtime", "Dynamic / conversation text") : null,
        h("span", { class: "quiet" }, total.toLocaleString("en-US") + " characters")));
  }

  function legend(className, label) {
    return h("span", { class: "row" }, h("span", { class: "swatch " + className }), label);
  }

  function renderMessage(capture, message, messageIndex) {
    const hasFileSpan = message.spans.some((s) => s.kind === "file");
    const isAttributing = attributingMessage === (capture.id + ":" + messageIndex);
    const canAttribute = !hasFileSpan && message.role !== "assistant" && message.spans.length > 0;

    return h("section", { class: "message" },
      h("div", { class: "spread" },
        h("h2", null, message.roleLabel),
        canAttribute
          ? h("button", {
              class: "ghost attribution-btn",
              disabled: isAttributing || (state.helper && state.helper.busy),
              onClick: () => attributeMessage(capture.id, messageIndex),
              title: "Use Meta AI to search the project and attribute this prompt to a template or source file",
            }, isAttributing ? "Attributing…" : "✨ Attribute with Meta AI")
          : null),
      message.truncated ? h("p", { class: "quiet" }, "This part was shortened for display. The model still received the full text.") : null,
      ...message.spans.map((span) => renderSpan(capture, span)));
  }

  function attributeMessage(captureId, messageIndex) {
    attributingMessage = captureId + ":" + messageIndex;
    render();
    post({ type: "attributeMessage", captureId: captureId, messageIndex: messageIndex });
  }

  function renderSpan(capture, span) {
    const key = capture.id + ":" + span.id;
    const selected = key === selectedSpan;
    const kind = span.kind === "runtime"
      ? "runtime"
      : span.source === "attributed"
        ? "attributed"
        : span.source === "reported"
          ? "reported"
          : "file";
    const body = h("pre", null, span.text);
    const isAttributed = span.source === "attributed";
    const title = isAttributed && span.explanation
      ? "Attributed by Meta AI: " + span.explanation + (span.confidence ? " (confidence: " + Math.round(span.confidence * 100) + "%)" : "")
      : span.label;
    const displayLabel = isAttributed ? "✨ " + span.label : span.label;

    const block = h("div", { class: "block " + kind + (selected ? " selected" : ""), id: "span-" + key },
      span.canOpen
        ? h("button", { class: "block-head" + (isAttributed ? " block-head-attributed" : ""), onClick: () => openSpan(capture, span), title: title }, displayLabel)
        : h("div", { class: "block-label", title: title }, displayLabel),
      body);
    return block;
  }

  function openSpan(capture, span) {
    selectedSpan = capture.id + ":" + span.id;
    post({ type: "openSpan", captureId: capture.id, spanId: span.id });
    render();
  }

  function focusSpan(capture, id) {
    selectedSpan = capture.id + ":" + id;
    render();
    const node = document.getElementById("span-" + selectedSpan);
    if (node) {
      node.scrollIntoView({ block: "nearest" });
    }
  }

  function exactHelp() {
    const url = (state.recorder.url || "http://127.0.0.1:47321") + "/context-tracker/v1/spans";
    return h("details", { class: "help" },
      h("summary", null, "Mark exact lines from your app"),
      h("p", null, "File matching runs on its own. When a slice has no file, your app can name the text and the lines it came from."),
      h("p", null, "Put a header named x-context-tracker-id on the model request. Post the same id, with the quote and file, to " + url + "."),
      h("pre", null, SPAN_EXAMPLE));
  }

  function flatten(capture) {
    const spans = [];
    capture.messages.forEach((message) => {
      message.spans.forEach((span) => spans.push(span));
    });
    return spans;
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function send(type) {
    return () => post({ type: type });
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function h(tag, props) {
    const node = document.createElement(tag);
    const children = Array.prototype.slice.call(arguments, 2);
    if (props) {
      Object.keys(props).forEach((key) => {
        const value = props[key];
        if (value == null || value === false) {
          return;
        }
        if (key === "class") {
          node.className = value;
        } else if (key === "style") {
          node.setAttribute("style", value);
        } else if (key === "checked" && tag === "input") {
          node.checked = true;
        } else if (key === "value" && (tag === "input" || tag === "textarea")) {
          node.value = value;
        } else if (key === "selected" && tag === "option") {
          node.selected = true;
        } else if (key.startsWith("on") && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, String(value));
        }
      });
    }
    children.flat().forEach((child) => {
      if (child == null || child === false) {
        return;
      }
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }
})();
