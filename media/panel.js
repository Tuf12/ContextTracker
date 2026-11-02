let asideScrollTop = 0;
let cardsScrollTop = 0;
let feedScrollTop = 0;
let detailScrollTop = 0;

(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  if (!app) {
    throw new Error("Context Tracker panel root (#app) is missing.");
  }
  let state = null;
  let confirmClear = false;
  let selectedSpan = null;
  let seenCapture = null;
  let scrollTop = 0;
  let helperChoice = null;
  let helperKey = "";
  let helperMessageInput = "";
  let activeSidebarTab = "helper"; // "helper" | "prompt"

  const savedLayout = (function () {
    try {
      return (vscode && vscode.getState && vscode.getState()) || {};
    } catch {
      return {};
    }
  })();

  let sidebarWidth = typeof savedLayout.sidebarWidth === "number" ? savedLayout.sidebarWidth : 420;
  let sidebarCardsHeight = typeof savedLayout.sidebarCardsHeight === "number" ? savedLayout.sidebarCardsHeight : 260;
  let isSidebarCollapsed = Boolean(savedLayout.isSidebarCollapsed);
  let mainViewTab = savedLayout.mainViewTab === "chat" ? "chat" : "prompt"; // "prompt" | "chat"
  let quickActionsCollapsed = Boolean(savedLayout.quickActionsCollapsed);
  let collapsed = {
    project: Boolean(savedLayout.collapsedProject),
    recorder: Boolean(savedLayout.collapsedRecorder),
    capture: Boolean(savedLayout.collapsedCapture),
  };

  const expandedToolSchemas = new Set();
  const showRawToolsJson = new Map();

  function saveLayoutState(updates) {
    try {
      const prev = (vscode && vscode.getState && vscode.getState()) || {};
      vscode.setState({
        ...prev,
        sidebarWidth,
        sidebarCardsHeight,
        isSidebarCollapsed,
        mainViewTab,
        quickActionsCollapsed,
        collapsedProject: collapsed.project,
        collapsedRecorder: collapsed.recorder,
        collapsedCapture: collapsed.capture,
        ...updates,
      });
    } catch {
      // ignore
    }
  }

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
  let copiedSecuritySnippet = false;
  let activeSelection = "";

  document.addEventListener("mouseup", () => {
    if (document.body.classList.contains("is-resizing-col") || document.body.classList.contains("is-resizing-row")) {
      return;
    }
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        return;
      }
      const text = sel.toString().trim();
      if (state && text.length >= 8 && text !== activeSelection) {
        activeSelection = text;
        render();
      }
    }, 50);
  });

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
  render();

  function render() {
    const scroller = document.scrollingElement;
    if (scroller) {
      scrollTop = scroller.scrollTop;
    }
    const existingAside = document.querySelector(".layout-editor > aside");
    const existingCards = document.getElementById("sidebar-cards");
    const existingFeed = document.getElementById("helper-feed");
    const existingDetail = document.getElementById("detail");
    if (existingAside) {
      asideScrollTop = existingAside.scrollTop;
    }
    if (existingCards) {
      cardsScrollTop = existingCards.scrollTop;
    }
    if (existingFeed) {
      feedScrollTop = existingFeed.scrollTop;
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
      const newCards = document.getElementById("sidebar-cards");
      if (newCards) {
        newCards.scrollTop = cardsScrollTop;
      }
      const newFeed = document.getElementById("helper-feed");
      if (newFeed) {
        if (!sameCapture || (state.helper && state.helper.busy)) {
          newFeed.scrollTop = newFeed.scrollHeight;
        } else {
          newFeed.scrollTop = feedScrollTop;
        }
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
    } catch (error) {
      app.replaceChildren();
      app.append(h("p", { class: "banner" }, error instanceof Error ? error.message : "The prompt view failed to draw."));
    }
  }

  function toggleSidebar() {
    isSidebarCollapsed = !isSidebarCollapsed;
    saveLayoutState({ isSidebarCollapsed });
    render();
  }

  function startHorizontalResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const gutter = document.getElementById("gutter-col");
    if (gutter) gutter.classList.add("dragging");
    document.body.classList.add("is-resizing-col");

    function onMouseMove(moveEvent) {
      moveEvent.preventDefault();
      const delta = moveEvent.clientX - startX;
      const windowWidth = window.innerWidth || document.documentElement.clientWidth || 1000;
      const minW = 260;
      const maxW = Math.max(minW, windowWidth - 280);
      const newWidth = Math.max(minW, Math.min(maxW, Math.round(startWidth + delta)));
      sidebarWidth = newWidth;
      const asideEl = document.getElementById("sidebar-panel");
      if (asideEl) {
        asideEl.style.width = newWidth + "px";
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.classList.remove("is-resizing-col");
      if (gutter) gutter.classList.remove("dragging");
      saveLayoutState({ sidebarWidth });
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function startVerticalResize(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = sidebarCardsHeight;
    const gutter = document.getElementById("gutter-row");
    if (gutter) gutter.classList.add("dragging");
    document.body.classList.add("is-resizing-row");

    function onMouseMove(moveEvent) {
      moveEvent.preventDefault();
      const delta = moveEvent.clientY - startY;
      const asideEl = document.getElementById("sidebar-panel");
      const asideHeight = asideEl ? asideEl.clientHeight : 800;
      const minH = 50;
      const maxH = Math.max(minH, asideHeight - 140);
      const newHeight = Math.max(minH, Math.min(maxH, Math.round(startHeight + delta)));
      sidebarCardsHeight = newHeight;
      const cardsEl = document.getElementById("sidebar-cards");
      if (cardsEl) {
        cardsEl.style.flex = "0 1 " + newHeight + "px";
        cardsEl.style.maxHeight = newHeight + "px";
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.body.classList.remove("is-resizing-row");
      if (gutter) gutter.classList.remove("dragging");
      saveLayoutState({ sidebarCardsHeight });
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function resetHorizontalResize() {
    sidebarWidth = 420;
    saveLayoutState({ sidebarWidth: 420 });
    render();
  }

  function resetVerticalResize() {
    sidebarCardsHeight = 260;
    saveLayoutState({ sidebarCardsHeight: 260 });
    render();
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
    const isChatInMain = mainViewTab === "chat";

    const cardsContainer = h("div", {
      class: "sidebar-cards-container",
      id: "sidebar-cards",
      style: `flex: 0 1 ${sidebarCardsHeight}px; max-height: ${sidebarCardsHeight}px;`,
    },
      header("editor"),
      projectCard(),
      recorderCard(),
      captureCard());

    const gutterRow = isChatInMain ? null : h("div", {
      class: "split-gutter split-gutter-row",
      id: "gutter-row",
      title: "Drag to resize Cards vs Chat · Double-click to reset (260px)",
      onMousedown: startVerticalResize,
      onDblclick: resetVerticalResize,
    });

    const chatContainer = isChatInMain
      ? h("div", { class: "sidebar-chat-companion" },
          h("div", { class: "card helper-companion-card" },
            h("div", { class: "spread" },
              h("strong", { style: "font-size:12px;display:flex;align-items:center;gap:6px;" },
                h("span", null, "🤖"),
                "Meta AI Co-Pilot"),
              h("span", { class: "badge badge-ready", style: "font-size:10px;" }, "Active in Main View")),
            h("p", { class: "quiet", style: "font-size:11px;margin:4px 0;" }, "Chat is expanded to the large main editor pane for maximum readability."),
            h("div", { class: "row", style: "gap:6px;margin-top:6px;" },
              h("button", {
                class: "secondary icon-btn",
                onClick: () => {
                  mainViewTab = "prompt";
                  saveLayoutState({ mainViewTab: "prompt" });
                  render();
                },
                title: "Dock chat back into this sidebar",
              }, "⤡ Dock to Sidebar"),
              h("button", {
                class: "ghost icon-btn",
                onClick: () => {
                  const input = document.querySelector(".helper-input");
                  if (input) input.focus();
                },
                title: "Focus message input in main view",
              }, "💬 Focus Chat"))))
      : h("div", {
          class: "sidebar-chat-container",
          id: "sidebar-chat",
        }, helperConsole({ inAside: true }));

    const aside = isSidebarCollapsed
      ? null
      : h("aside", {
          class: "stack sidebar-panel",
          id: "sidebar-panel",
          style: `width: ${sidebarWidth}px;`,
        },
          cardsContainer,
          gutterRow,
          chatContainer);

    const gutterCol = isSidebarCollapsed
      ? null
      : h("div", {
          class: "split-gutter split-gutter-col",
          id: "gutter-col",
          title: "Drag to resize sidebar width · Double-click to reset (420px)",
          onMousedown: startHorizontalResize,
          onDblclick: resetHorizontalResize,
        });

    const collapsedRail = isSidebarCollapsed
      ? h("div", {
          class: "sidebar-collapsed-rail",
          id: "sidebar-rail",
          title: "Click to expand sidebar",
          onClick: toggleSidebar,
        },
          h("button", { class: "ghost rail-toggle-btn", title: "Expand sidebar (Calls, Project, Capture)" }, "▶"),
          h("span", { class: "rail-vertical-label" }, `Calls (${state.captures.length})`))
      : null;

    const main = h("main", { class: "detail", id: "detail" }, detail());

    return h("div", {
      class: "layout layout-editor" + (isSidebarCollapsed ? " layout-sidebar-collapsed" : ""),
      id: "shell",
    },
      aside,
      gutterCol,
      collapsedRail,
      main);
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
          onClick: () => {
            collapsed.project = !collapsed.project;
            saveLayoutState({ collapsedProject: collapsed.project });
            render();
          },
          title: isCollapsed ? "Expand Project card" : "Collapse Project card",
        },
          h("span", { class: "collapse-arrow" }, isCollapsed ? "▸" : "▾"),
          h("h2", { style: "margin:0;display:inline-flex;align-items:center;gap:6px;" },
            project.name,
            state.recorder && state.recorder.mobile && state.recorder.mobile.isAndroid
              ? h("span", { class: "badge badge-mobile-idle", style: "font-size:10px;font-weight:normal;" }, "Android")
              : null)),
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
          onClick: () => {
            collapsed.recorder = !collapsed.recorder;
            saveLayoutState({ collapsedRecorder: collapsed.recorder });
            render();
          },
          title: isCollapsed ? "Expand Capture card" : "Collapse Capture card",
        },
          h("span", { class: "collapse-arrow" }, isCollapsed ? "▸" : "▾"),
          h("h2", { style: "margin:0;" }, "Capture")),
        h("div", { class: "row", style: "gap:6px;align-items:center;" },
          recorder.mobile && recorder.mobile.isAndroid
            ? h("span", {
                class: recorder.mobile.bridged ? "badge badge-mobile badge-mobile-active" : "badge badge-mobile",
                title: recorder.mobile.deviceLabel
                  ? `Device: ${recorder.mobile.deviceLabel} (${recorder.mobile.bridged ? "Bridged via ADB" : "Detected"})`
                  : "Android Project",
              }, recorder.mobile.deviceLabel
                ? `📱 ${recorder.mobile.deviceLabel.split(",")[0].trim()} (${recorder.mobile.bridged ? "Bridged" : "Active"})`
                : "📱 Android")
            : null,
          h("span", { class: recorder.running ? "badge badge-ready" : "badge badge-idle" },
            recorder.running ? "● Active (47321)" : "○ Off"))),
      isCollapsed ? null : trafficSummary ? h("p", { class: "quiet", style: "font-weight:600;font-size:11px;margin:2px 0;" }, trafficSummary) : null,
      isCollapsed ? null : (recorder.running && recorder.mobile && recorder.mobile.isStale)
        ? h("div", { class: "banner warning mobile-stale-card", style: "margin:6px 0;display:flex;align-items:center;gap:6px;" },
            h("span", { style: "font-size:13px;" }, "⚡"),
            h("div", null,
              h("strong", { style: "font-size:11px;display:block;" }, "Re-run app in Android Studio"),
              h("span", { class: "quiet", style: "font-size:10px;" }, "APK is older than the redirected endpoint. Trigger 'Run' in Android Studio to apply capture.")))
        : null,
      isCollapsed ? null : (recorder.mobile && recorder.mobile.isAndroid && !recorder.mobile.cleartextPermitted)
        ? h("div", { class: "banner warning mobile-security-card", style: "margin:6px 0;display:flex;flex-direction:column;gap:6px;" },
            h("div", { class: "spread", style: "align-items:flex-start;" },
              h("span", { style: "font-weight:600;font-size:11px;" }, "⚠️ Cleartext HTTP Blocked"),
              h("button", {
                class: "secondary icon-btn",
                style: "font-size:10px;padding:2px 6px;",
                onClick: () => {
                  copyToClipboard(recorder.mobile.remediationSnippet || "");
                  copiedSecuritySnippet = true;
                  render();
                  setTimeout(() => { copiedSecuritySnippet = false; render(); }, 2500);
                },
                title: "Copy network_security_config.xml XML configuration to clipboard",
              }, copiedSecuritySnippet ? "✓ Copied XML" : "Copy network_security_config.xml")),
            h("p", { class: "quiet", style: "font-size:10px;margin:0;line-height:1.4;" },
              "Android 9+ blocks unencrypted http:// by default. Requests to port 47321 will fail unless permitted in network_security_config.xml."))
        : null,
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
          onClick: () => {
            collapsed.capture = !collapsed.capture;
            saveLayoutState({ collapsedCapture: collapsed.capture });
            render();
          },
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
    const chatBadge = capture.chatCount
      ? h("span", { class: "chat-indicator-pill", title: `${capture.chatCount} chat messages on this context window` }, `💬 ${capture.chatCount}`)
      : null;
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
          h("span", { class: "meta row", style: "gap:4px;align-items:center;" },
            chatBadge,
            status)),
        h("div", null, capture.model),
        h("div", { class: "quiet" },
          (capture.fileSpanCount > 0 ? capture.fileSpanCount + " source links · " : "") + capture.preview)),
      state.captures.length > 1 && capture.id !== state.selectedId
        ? h("button", { class: "ghost icon-btn", onClick: () => post({ type: "pinCapture", id: capture.id }) }, pinned ? "Unpin" : "Pin")
        : null);
  }

  function detail() {
    return h("div", { class: "detail-wrapper" },
      detailTabs(),
      h("div", { class: "detail-body" + (mainViewTab === "chat" ? " chat-mode" : "") },
        mainViewTab === "chat" ? mainChatView() : promptDetailView()));
  }

  function detailTabs() {
    const isChat = mainViewTab === "chat";
    const helperActivityCount = state.helper && state.helper.activity ? state.helper.activity.length : 0;
    const isBusy = Boolean(state.helper && state.helper.busy);
    const tokenCount = state.selected ? (state.selected.estimatedTokens || 0).toLocaleString("en-US") + " tokens" : null;

    return h("div", { class: "main-view-tabs spread" },
      h("div", { class: "row", style: "gap:6px;align-items:center;" },
        h("button", {
          class: "tab-btn" + (!isChat ? " active" : ""),
          onClick: () => {
            mainViewTab = "prompt";
            saveLayoutState({ mainViewTab: "prompt" });
            render();
          },
          title: "Inspect prompt context window, attributed files, and token breakdown",
        }, "📄 Context Window" + (tokenCount ? ` (${tokenCount})` : "")),
        h("button", {
          class: "tab-btn" + (isChat ? " active" : "") + (isBusy ? " pulse" : ""),
          onClick: () => {
            mainViewTab = "chat";
            saveLayoutState({ mainViewTab: "chat" });
            render();
          },
          title: "Full-width Meta AI Prompt Co-Pilot & Interrogation Chat",
        }, isBusy ? "● Meta AI Working…" : `🤖 Meta AI Co-Pilot & Chat (${helperActivityCount})`)),
      h("div", { class: "row", style: "gap:4px;align-items:center;" },
        h("button", {
          class: "ghost icon-btn sidebar-toggle-btn",
          onClick: toggleSidebar,
          title: isSidebarCollapsed ? "Show left sidebar" : "Hide left sidebar to maximize workspace",
        }, isSidebarCollapsed ? "▶ Show Sidebar" : "◀ Hide Sidebar")));
  }

  function promptDetailView() {
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

  function mainChatView() {
    return h("section", { class: "main-chat-container" },
      helperConsole({ inAside: false, inMain: true }));
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
      activeSelection
        ? h("div", { class: "selection-floating-bar spread" },
            h("div", { class: "row", style: "gap:6px;align-items:center;" },
              h("span", { style: "font-size:13px;" }, "✂️"),
              h("span", { class: "selection-bar-text" }, "Highlighted text: \"" + activeSelection.slice(0, 50) + (activeSelection.length > 50 ? "…" : "") + "\" (" + activeSelection.length + " chars)")),
            h("div", { class: "row", style: "gap:6px;" },
              h("button", {
                class: "primary selection-ask-btn",
                onClick: () => {
                  post({
                    type: "setScope",
                    scope: {
                      kind: "selection",
                      selectedText: activeSelection,
                      charCount: activeSelection.length,
                      label: "Selection (" + activeSelection.length + " chars)",
                    },
                  });
                  focusHelperConsole();
                },
                title: "Scope Meta AI questions to this selected text",
              }, "💬 Ask Meta AI"),
              h("button", {
                class: "ghost icon-btn",
                onClick: () => {
                  activeSelection = "";
                  render();
                },
                title: "Clear selection",
              }, "✕")))
        : null,
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
      renderTelemetryBar(capture),
      bar(capture, spans),
      ...(capture.messages || []).map((message, idx) => renderMessage(capture, message, idx)),
      h("section", { class: "reply" },
        h("h2", null, "Model reply"),
        h("p", { class: "quiet" }, "About " + capture.replyEstimatedTokens.toLocaleString("en-US") + " tokens · characters ÷ 4. This text was written by the model."),
        h("pre", null, capture.reply && capture.reply.trim() ? capture.reply : "No text came back.")),
      which ? null : exactHelp());
  }

  function focusHelperConsole() {
    const surface = document.body.dataset.surface;
    if (surface === "sidebar") {
      activeSidebarTab = "helper";
    } else {
      if (mainViewTab === "prompt" && isSidebarCollapsed) {
        isSidebarCollapsed = false;
        saveLayoutState({ isSidebarCollapsed: false });
      }
    }
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
    const inMain = Boolean(options && options.inMain);
    const activity = (helper && helper.activity) || [];
    const busy = Boolean(helper && helper.busy);
    const modelName = helper && helper.model ? (helperChoiceLabel(helper.model) || helper.model) : "Meta Muse";
    const surface = document.body.dataset.surface;
    const isEditor = surface === "editor";

    const statusBadge = busy
      ? h("span", { class: "badge badge-busy pulse" }, "● " + (helper.status || "Working…"))
      : helper && helper.keySaved
        ? h("span", { class: "badge badge-ready" }, "● Ready")
        : h("span", { class: "badge badge-idle" }, "○ Needs Key");

    const header = h("div", { class: "helper-console-header spread" },
      h("div", { class: "row", style: "gap:6px;align-items:center;" },
        h("span", { style: "font-size:14px;" }, "🤖"),
        h("h3", { style: "margin:0;font-size:12px;font-weight:600;" }, inMain ? "Meta AI Prompt Co-Pilot & Interrogation" : "Meta AI Helper"),
        h("span", { class: "helper-model-pill" }, modelName),
        state.selected
          ? h("span", { class: "helper-context-pill", title: "Chat conversation scoped to this context window" }, "🎯 " + (state.selected.model || ("Call " + formatTime(state.selected.createdAt))))
          : h("span", { class: "helper-context-pill", title: "Project-level conversation" }, "📁 Project"),
        statusBadge),
      h("div", { class: "row", style: "gap:4px;align-items:center;" },
        activity.length > 0
          ? h("button", { class: "ghost icon-btn", onClick: () => post({ type: "clearHelperActivity" }), title: state.selected ? "Clear chat for this context window" : "Clear project chat activity" }, "Clear")
          : null,
        isEditor && inAside
          ? h("button", {
              class: "secondary icon-btn expand-main-btn",
              onClick: () => {
                mainViewTab = "chat";
                saveLayoutState({ mainViewTab: "chat" });
                render();
              },
              title: "Expand chat into large main view",
            }, "⤢ Expand to Main")
          : null,
        isEditor && inMain
          ? h("button", {
              class: "secondary icon-btn dock-sidebar-btn",
              onClick: () => {
                mainViewTab = "prompt";
                saveLayoutState({ mainViewTab: "prompt" });
                render();
              },
              title: "Dock chat back into left sidebar",
            }, "⤡ Dock to Sidebar")
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

    return h("section", {
      class: "helper-console" + (inAside ? " helper-console-aside" : "") + (inMain ? " helper-console-main" : ""),
      id: "helper-console",
    },
      header,
      helperScopeBar(),
      feed,
      helperQuickChips(Boolean(state.selected)),
      helperInputRow());
  }

  function helperScopeBar() {
    if (!state.selected) {
      return null;
    }
    const activeScope = (state.helper && state.helper.activeScope) || { kind: "global", label: "All Context" };
    const isGlobal = activeScope.kind === "global";
    const isSection = activeScope.kind === "section";
    const isSelection = activeScope.kind === "selection";
    const isCompare = activeScope.kind === "compare";

    let icon = "🌐";
    let scopeText = "All Context";
    if (isGlobal) {
      scopeText = "All Context (~" + (state.selected.estimatedTokens || 0).toLocaleString("en-US") + " tokens)";
    } else if (isSection) {
      icon = "🎯";
      scopeText = "Section " + (activeScope.sectionId || "") + (activeScope.categoryLabel ? " · " + activeScope.categoryLabel : "") + (activeScope.label && activeScope.label !== activeScope.categoryLabel ? ": " + activeScope.label : "");
    } else if (isSelection) {
      icon = "✂️";
      scopeText = "Selection (" + (activeScope.charCount || (activeScope.selectedText && activeScope.selectedText.length) || 0) + " chars)";
    } else if (isCompare) {
      icon = "⚖️";
      scopeText = "Comparing vs " + (activeScope.compareCaptureId || (state.compare ? state.compare.id : "comparison"));
    }

    return h("div", { class: "helper-scope-bar spread" },
      h("div", { class: "row", style: "gap:6px;align-items:center;overflow:hidden;flex:1;" },
        h("span", { class: "scope-label-prefix" }, "Scope:"),
        h("span", { class: "scope-pill " + (isGlobal ? "scope-pill-global" : "scope-pill-targeted") },
          h("span", { style: "font-size:12px;" }, icon),
          h("span", { class: "scope-pill-text", title: scopeText }, scopeText),
          !isGlobal
            ? h("button", {
                class: "scope-clear-btn",
                onClick: (e) => {
                  e.stopPropagation();
                  post({ type: "clearScope" });
                },
                title: "Clear scope and return to All Context",
              }, "✕")
            : null)),
      h("div", { class: "row", style: "gap:4px;" },
        !isGlobal
          ? h("button", {
              class: "ghost scope-reset-link",
              onClick: () => post({ type: "clearScope" }),
              title: "Reset scope to All Context",
            }, "All Context")
          : null));
  }

  function helperEmptyState() {
    if (state.selected) {
      const model = state.selected.model || "Captured Model";
      const tokenCount = (state.selected.estimatedTokens || 0).toLocaleString("en-US");
      return h("div", { class: "helper-empty" },
        h("div", { class: "spread" },
          h("strong", null, "Meta AI Context Co-Pilot"),
          h("span", { class: "meta" }, "🎯 " + model + " (~" + tokenCount + " tokens)")),
        h("p", { class: "quiet" }, "Ask questions about this specific context window, detect contradictions, scan for PII, or optimize token usage. Chat is scoped to this capture."),
        h("p", { class: "note", style: "margin-top:4px;" }, "Type below or choose a quick diagnostic action to begin."));
    }
    return h("div", { class: "helper-empty" },
      h("div", { class: "spread" },
        h("strong", null, "Meta AI Assistant"),
        h("span", { class: "meta" }, "📁 Project Scope")),
      h("p", { class: "quiet" }, "Select a call on the left to interrogate its context window, or ask questions about your project, investigate local AI services, or let Meta AI find model addresses."),
      h("p", { class: "note", style: "margin-top:4px;" }, "Type below or click a quick action to start."));
  }

  function renderPatchCard(item) {
    const time = formatTime(item.timestamp);
    const diff = item.detail || "";
    const patch = item.patch || (state.helper && state.helper.activePatch);
    const patchId = patch ? patch.patchId : undefined;
    const impact = patch && patch.tokenImpactEstimate ? patch.tokenImpactEstimate : "optimized";
    const isApplied = Boolean(item.patchApplied || (patch && patch.status === "applied"));

    const lines = diff.split("\n");
    const diffElements = lines.map((line) => {
      if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) {
        return h("div", { class: "diff-line diff-meta" }, line);
      }
      if (line.startsWith("-")) {
        return h("div", { class: "diff-line diff-del" }, line);
      }
      if (line.startsWith("+")) {
        return h("div", { class: "diff-line diff-add" }, line);
      }
      return h("div", { class: "diff-line" }, line);
    });

    return h("div", { class: "helper-item patch-card" + (isApplied ? " patch-applied" : "") },
      h("div", { class: "patch-card-header spread" },
        h("div", { class: "row", style: "gap:6px;align-items:center;" },
          h("span", { class: "helper-badge finish-badge" }, "🛠️ Proposed Patch"),
          h("span", { class: "patch-file-pill" }, patch ? patch.file + ":" + patch.startLine + "-" + patch.endLine : "Source Template"),
          isApplied
            ? h("span", { class: "patch-applied-pill" }, "✅ Applied")
            : h("span", { class: "patch-impact-pill" }, impact)),
        h("span", { class: "helper-time" }, time)),
      h("p", { class: "patch-description" }, item.text),
      patch && patch.explanation ? h("p", { class: "patch-explanation" }, patch.explanation) : null,
      h("div", { class: "diff-viewer" }, ...diffElements),
      h("div", { class: "patch-actions spread", style: "align-items:center;" },
        isApplied
          ? h("div", { class: "row", style: "gap:6px;align-items:center;" },
              h("span", { style: "color:#4ade80;font-size:12px;font-weight:600;" }, "✓ Applied to workspace"),
              h("span", { class: "quiet", style: "font-size:11px;" }, patch ? (patch.file + ":" + patch.startLine) : ""))
          : h("button", {
              class: "primary patch-apply-btn",
              disabled: Boolean(state.helper && state.helper.busy),
              onClick: () => post({ type: "applyPatch", patchId: patchId, patch: patch }),
              title: "Apply this patch directly to the file in the workspace",
            }, "✅ Apply Patch to Workspace"),
        h("button", {
          class: "ghost icon-btn",
          onClick: () => post({ type: "clearHelperActivity" }),
          title: "Dismiss this patch proposal",
        }, "✕ Dismiss")));
  }

  function renderActivityItem(item) {
    const time = formatTime(item.timestamp);
    if (item.kind === "assistant") {
      return h("div", { class: "helper-item helper-assistant" },
        h("div", { class: "helper-item-header" },
          h("span", { class: "helper-badge assistant-badge" }, "🤖 Meta AI"),
          h("span", { class: "helper-time" }, time)),
        h("div", { class: "helper-assistant-body" }, item.text));
    }
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
      if (item.detail && item.detail.includes("--- a/")) {
        return renderPatchCard(item);
      }
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
    const activeScope = state.helper && state.helper.activeScope;
    const chips = [];

    if (hasSelectedCapture) {
      chips.push(h("button", {
        class: "chip-btn chip-highlight",
        disabled: busy,
        onClick: () => post({ type: "quickAction", action: "detect_contradictions", scope: activeScope }),
        title: "Analyze prompt context for contradictions between system rules, RAG data, and user query",
      }, "🔍 Detect Contradictions"));

      chips.push(h("button", {
        class: "chip-btn",
        disabled: busy,
        onClick: () => post({ type: "quickAction", action: "optimize_context", scope: activeScope }),
        title: "Audit context window for bloat, redundant history, and estimated token savings",
      }, "✂️ Optimize & Prune"));

      chips.push(h("button", {
        class: "chip-btn",
        disabled: busy,
        onClick: () => post({ type: "quickAction", action: "scan_pii", scope: activeScope }),
        title: "Scan context window for credentials, sensitive data, and prompt leaks",
      }, "🛡️ Scan PII"));

      chips.push(h("button", {
        class: "chip-btn",
        disabled: busy,
        onClick: () => post({ type: "quickAction", action: "explain_output" }),
        title: "Explain how system instructions and RAG grounding produced the model's completion",
      }, "💡 Explain Output"));

      if (state.compare) {
        chips.push(h("button", {
          class: "chip-btn chip-highlight",
          disabled: busy,
          onClick: () => post({ type: "quickAction", action: "compare_captures" }),
          title: "Compare prompt divergence and behavioral changes between the active and comparison capture",
        }, "🔄 Compare Captures"));
      }
    }

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

    if (hasSelectedCapture && state.selected) {
      chips.push(h("button", {
        class: "chip-btn" + (state.selected.telemetry ? "" : " chip-highlight"),
        disabled: busy,
        onClick: () => {
          post({ type: "analyzeTelemetry", captureId: state.selected.id });
        },
        title: "Analyze prompt context window anatomy, purpose (what and why), and token budget with Meta AI",
      }, "📊 Context telemetry"));
    }

    const toggle = h("div", {
      class: "quick-actions-bar spread",
      onClick: () => {
        quickActionsCollapsed = !quickActionsCollapsed;
        saveLayoutState({ quickActionsCollapsed });
        render();
      },
      title: quickActionsCollapsed ? "Expand quick diagnostic actions" : "Collapse quick diagnostic actions to save vertical space",
    },
      h("div", { class: "row", style: "gap:6px;align-items:center;" },
        h("span", { class: "collapse-arrow" }, quickActionsCollapsed ? "▸" : "▾"),
        h("span", { class: "quick-actions-title" }, `⚡ Quick Actions (${chips.length})`)),
      quickActionsCollapsed
        ? h("div", { class: "row", style: "gap:4px;overflow:hidden;align-items:center;" },
            hasSelectedCapture ? h("span", { class: "quick-actions-mini-tag" }, "🔍 Contradictions") : null,
            hasSelectedCapture ? h("span", { class: "quick-actions-mini-tag" }, "✂️ Optimize") : null,
            h("span", { class: "quick-actions-mini-tag quiet", style: "font-size:9.5px;" }, "click to expand"))
        : null);

    return h("div", { class: "helper-chips-container" },
      toggle,
      quickActionsCollapsed ? null : h("div", { class: "helper-chips" }, ...chips));
  }

  function helperInputRow() {
    const isBusy = Boolean(state.helper && state.helper.busy);
    return h("div", { class: "helper-input-row" },
      h("textarea", {
        class: "helper-input",
        rows: "1",
        placeholder: "Ask Meta AI Co-Pilot (Enter to send, Shift+Enter for newline)...",
        value: helperMessageInput,
        onInput: (event) => {
          helperMessageInput = event.target.value;
          event.target.style.height = "auto";
          event.target.style.height = Math.min(event.target.scrollHeight, 130) + "px";
        },
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitHelperMessage();
          }
        },
      }),
      h("button", {
        class: "primary helper-send-btn",
        disabled: isBusy,
        onClick: submitHelperMessage,
        title: "Send message (Enter)",
      }, isBusy ? "..." : "Send"));
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
    const telemetries = (message.telemetries && message.telemetries.length > 0)
      ? message.telemetries
      : (message.telemetry ? [message.telemetry] : []);

    const isTools = message.role === "tools";
    const toolsCount = isTools ? telemetries.length : 0;
    const roleTitle = isTools && toolsCount > 0
      ? "Tool Definitions (" + toolsCount + " tool" + (toolsCount > 1 ? "s" : "") + ")"
      : message.roleLabel;

    return h("section", { class: "message" + (isTools ? " message-tools" : ""), id: "message-" + capture.id + "-" + messageIndex },
      h("div", { class: "spread" },
        h("h2", null, roleTitle),
        h("div", { class: "row", style: "gap:4px;align-items:center;" },
          h("button", {
            class: "ghost ask-ai-btn",
            onClick: () => {
              post({
                type: "setScope",
                scope: {
                  kind: "section",
                  sectionId: telemetries[0]?.sectionId || ("msg-" + messageIndex),
                  messageIndex: messageIndex,
                  label: roleTitle + " (#" + (messageIndex + 1) + ")",
                },
              });
              focusHelperConsole();
            },
            title: "Scope Meta AI questions to this " + roleTitle,
          }, "💬 Ask AI"),
          canAttribute && telemetries.length === 0
            ? h("button", {
                class: "ghost attribution-btn",
                disabled: isAttributing || (state.helper && state.helper.busy),
                onClick: () => attributeMessage(capture.id, messageIndex),
                title: "Use Meta AI to search the project and attribute this prompt to a template or source file",
              }, isAttributing ? "Attributing…" : "✨ Attribute with Meta AI")
            : null)),
      isTools && telemetries.length > 0
        ? renderToolsBreakdown(capture, message, messageIndex, telemetries)
        : (telemetries.length > 0
            ? h("div", { class: "stack", style: "gap:6px;margin-bottom:8px;" },
                ...telemetries.map((t) => renderAnatomyCard(capture, message, messageIndex, t)))
            : null),
      message.truncated ? h("p", { class: "quiet" }, "This part was shortened for display. The model still received the full text.") : null,
      !isTools ? message.spans.map((span) => renderSpan(capture, span)) : null);
  }

  function renderToolsBreakdown(capture, message, messageIndex, telemetries) {
    const rawKey = capture.id + ":raw-tools:" + messageIndex;
    const isRawOpen = Boolean(showRawToolsJson.get(rawKey));

    const recCount = telemetries.filter((t) => t.secondOpinion && t.secondOpinion.verdict === "recommended").length;
    const bloatCount = telemetries.filter((t) => t.secondOpinion && (t.secondOpinion.verdict === "unnecessary" || t.secondOpinion.verdict === "bloat")).length;
    const cautionCount = telemetries.filter((t) => t.secondOpinion && (t.secondOpinion.verdict === "caution" || t.secondOpinion.verdict === "security_risk" || t.secondOpinion.verdict === "redundant")).length;
    const totalTokens = telemetries.reduce((sum, t) => sum + t.tokenEstimate, 0);

    return h("div", { class: "tools-overview-container", id: "section-" + capture.id + "-tools" },
      h("div", { class: "tools-summary-bar" },
        h("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap;" },
          h("span", { class: "tools-summary-title" }, "🛠️ Tool Architecture & Meta AI Hygiene Review"),
          h("span", { class: "quiet", style: "font-size:11px;" }, totalTokens.toLocaleString("en-US") + " tokens total")),
        h("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap;" },
          recCount > 0 ? h("span", { class: "badge-verdict verdict-recommended" }, "✅ " + recCount + " Active") : null,
          bloatCount > 0 ? h("span", { class: "badge-verdict verdict-unnecessary" }, "⚠️ " + bloatCount + " Unneeded Bloat") : null,
          cautionCount > 0 ? h("span", { class: "badge-verdict verdict-caution" }, "🛡️ " + cautionCount + " Caution/Risk") : null)),
      h("div", { class: "tools-cards-list" },
        ...telemetries.map((t) => {
          const toolKey = capture.id + ":" + t.sectionId;
          const isSchemaExpanded = expandedToolSchemas.has(toolKey);
          const opinion = t.secondOpinion;
          const verdictClass = opinion ? ("verdict-" + opinion.verdict) : "";

          return h("div", { class: "tool-card", id: "section-" + capture.id + "-" + t.sectionId },
            h("div", { class: "tool-card-header" },
              h("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap;" },
                h("code", { class: "tool-name-badge" }, "🔧 " + (t.toolName || "tool")),
                h("span", { class: "anatomy-meta" },
                  t.tokenEstimate.toLocaleString("en-US") + " tokens · " + t.tokenPercentage + "% of context"),
                opinion ? h("span", { class: "badge-verdict " + verdictClass }, opinion.verdictLabel) : null),
              h("div", { class: "row", style: "gap:4px;align-items:center;" },
                h("button", {
                  class: "ghost ask-ai-btn",
                  onClick: () => {
                    post({
                      type: "setScope",
                      scope: {
                        kind: "section",
                        sectionId: t.sectionId,
                        messageIndex: messageIndex,
                        category: t.category,
                        categoryLabel: t.categoryLabel,
                        label: "Tool: " + (t.toolName || t.what),
                      },
                    });
                    focusHelperConsole();
                  },
                  title: "Scope Meta AI questions to tool " + (t.toolName || t.what),
                }, "💬 Ask AI"),
                h("button", {
                  class: "ghost icon-btn",
                  style: "font-size:11px;padding:2px 6px;",
                  onClick: () => {
                    if (expandedToolSchemas.has(toolKey)) {
                      expandedToolSchemas.delete(toolKey);
                    } else {
                      expandedToolSchemas.add(toolKey);
                    }
                    render();
                  },
                  title: "Toggle JSON schema definition",
                }, isSchemaExpanded ? "Hide Schema" : "Show Schema"))),
            h("div", { class: "anatomy-body" },
              h("div", { class: "anatomy-what" },
                h("span", { class: "anatomy-prefix" }, "🎯 WHAT:"),
                h("span", null, t.what)),
              h("div", { class: "anatomy-why" },
                h("span", { class: "anatomy-prefix" }, "💡 WHY:"),
                h("span", null, t.why))),
            opinion && opinion.advice
              ? h("div", { class: "anatomy-second-opinion " + verdictClass },
                  h("span", { class: "anatomy-prefix" }, "🤖 META AI SECOND OPINION:"),
                  h("span", null, opinion.advice))
              : null,
            t.warning && (!opinion || t.warning !== opinion.advice)
              ? h("div", { class: "anatomy-warning-pill" }, "⚠️ " + t.warning)
              : null,
            isSchemaExpanded
              ? h("div", { class: "tool-schema-block" },
                  h("div", { class: "quiet", style: "font-size:10.5px;margin-bottom:4px;" }, "JSON Schema Definition:"),
                  h("pre", { style: "max-height:220px;overflow-y:auto;font-size:11px;margin:0;" }, t.content || ""))
              : null);
        })),
      h("div", { style: "margin-top:8px;" },
        h("button", {
          class: "ghost",
          style: "font-size:11px;padding:3px 8px;opacity:0.8;",
          onClick: () => {
            showRawToolsJson.set(rawKey, !isRawOpen);
            render();
          },
        }, isRawOpen ? "▼ Hide Full Raw Tools JSON" : "▶ Show Full Raw Tools JSON (" + message.spans.length + " payload block" + (message.spans.length > 1 ? "s" : "") + ")"),
        isRawOpen
          ? h("div", { style: "margin-top:6px;" }, ...message.spans.map((span) => renderSpan(capture, span)))
          : null));
  }

  function renderAnatomyCard(capture, message, messageIndex, telemetry) {
    const isAttributing = attributingMessage === (capture.id + ":" + messageIndex);
    const canTrace = message.role !== "assistant" && !message.spans.some((s) => s.kind === "file");
    const catClass = "cat-" + telemetry.category;
    const labelTitle = telemetry.heading
      ? (categoryIcon(telemetry.category) + " " + telemetry.heading)
      : (categoryIcon(telemetry.category) + " " + telemetry.categoryLabel);

    const opinion = telemetry.secondOpinion;
    const verdictClass = opinion ? ("verdict-" + opinion.verdict) : "";

    return h("div", { class: "anatomy-card", id: "section-" + capture.id + "-" + telemetry.sectionId },
      h("div", { class: "anatomy-card-header" },
        h("div", { class: "row", style: "gap:6px;align-items:center;flex-wrap:wrap;" },
          h("span", { class: "badge-category " + catClass }, labelTitle),
          h("span", { class: "anatomy-meta" },
            telemetry.tokenEstimate.toLocaleString("en-US") + " tokens · " + telemetry.tokenPercentage + "% of context"),
          opinion ? h("span", { class: "badge-verdict " + verdictClass }, opinion.verdictLabel) : null),
        h("div", { class: "row", style: "gap:4px;align-items:center;" },
          h("button", {
            class: "ghost ask-ai-btn",
            onClick: () => {
              post({
                type: "setScope",
                scope: {
                  kind: "section",
                  sectionId: telemetry.sectionId,
                  messageIndex: messageIndex,
                  category: telemetry.category,
                  categoryLabel: telemetry.categoryLabel,
                  label: telemetry.heading || telemetry.what || telemetry.categoryLabel,
                },
              });
              focusHelperConsole();
            },
            title: "Scope Meta AI questions to this " + (telemetry.heading || telemetry.categoryLabel) + " section",
          }, "💬 Ask AI"),
          canTrace
            ? h("button", {
                class: "ghost attribution-btn",
                disabled: isAttributing || (state.helper && state.helper.busy),
                onClick: () => attributeMessage(capture.id, messageIndex),
                title: "Attribute this " + telemetry.categoryLabel + " block to source template using Meta AI",
              }, isAttributing ? "Tracing…" : "✨ Trace in Code")
            : null)),
      h("div", { class: "anatomy-body" },
        h("div", { class: "anatomy-what" },
          h("span", { class: "anatomy-prefix" }, "🎯 WHAT:"),
          h("span", null, telemetry.what)),
        h("div", { class: "anatomy-why" },
          h("span", { class: "anatomy-prefix" }, "💡 WHY:"),
          h("span", null, telemetry.why))),
      opinion && opinion.advice
        ? h("div", { class: "anatomy-second-opinion " + verdictClass },
            h("span", { class: "anatomy-prefix" }, "🤖 META AI OPINION:"),
            h("span", null, opinion.advice))
        : null,
      telemetry.warning && (!opinion || telemetry.warning !== opinion.advice)
        ? h("div", { class: "anatomy-warning-pill" }, "⚠️ " + telemetry.warning)
        : null);
  }

  function renderTelemetryBar(capture) {
    const telemetry = capture.telemetry;
    const isBusy = Boolean(state.helper && state.helper.busy);

    if (!telemetry) {
      return h("div", { class: "telemetry-container telemetry-prompt-banner" },
        h("div", { class: "spread" },
          h("div", { class: "row", style: "gap:6px;align-items:center;" },
            h("span", { style: "font-size:14px;" }, "📊"),
            h("strong", { class: "telemetry-title" }, "Context Window Anatomy & Telemetry")),
          h("button", {
            class: "secondary",
            style: "font-size:11.5px;padding:3px 10px;",
            disabled: isBusy,
            onClick: () => post({ type: "analyzeTelemetry", captureId: capture.id }),
            title: "Profile prompt architecture, RAG grounding, chat history share, and token budget with Meta AI",
          }, isBusy ? "Analyzing…" : "⚡ Analyze Anatomy with Meta AI")),
        h("p", { class: "quiet", style: "font-size:11.5px;" },
          "Discover prompt composition, RAG context shares, token budget allocation, and context bloat issues."));
    }

    const sections = telemetry.sections || [];
    const composition = telemetry.composition || [];
    const warnings = telemetry.warnings || [];

    return h("div", { class: "telemetry-container", id: "telemetry-container" },
      h("div", { class: "telemetry-header" },
        h("div", { class: "row", style: "gap:6px;align-items:center;" },
          h("span", { style: "font-size:14px;" }, "📊"),
          h("h3", { class: "telemetry-title" }, "Context Anatomy & Token Budget"),
          h("span", { class: "helper-badge finish-badge", style: "font-size:10px;padding:1px 5px;" }, "⚡ Meta AI")),
        h("div", { class: "row", style: "gap:6px;" },
          h("button", {
            class: "ghost icon-btn",
            style: "font-size:11px;",
            disabled: isBusy,
            onClick: () => post({ type: "analyzeTelemetry", captureId: capture.id }),
            title: "Re-run Meta AI architectural decomposition and telemetry on this capture",
          }, isBusy ? "Analyzing…" : "⚡ Re-analyze"))),
      h("div", { class: "telemetry-bar", role: "group", "aria-label": "Context Composition" },
        ...sections.map((section) => {
          const catClass = "cat-" + section.category;
          const width = Math.max(1, section.tokenEstimate);
          const nameLabel = section.toolName
            ? ("🔧 Tool: " + section.toolName)
            : (section.heading ? ("🟢 " + section.heading) : section.categoryLabel);
          const opinionPart = section.secondOpinion
            ? ("\n🤖 Second Opinion: [" + section.secondOpinion.verdictLabel + "] " + section.secondOpinion.advice)
            : (section.warning ? ("\n⚠️ " + section.warning) : "");
          const title = nameLabel + ": " + section.tokenEstimate.toLocaleString("en-US") + " tokens (" + section.tokenPercentage + "%)\n🎯 " + section.what + "\n💡 " + section.why + opinionPart;
          return h("button", {
            class: "telemetry-segment " + catClass,
            style: "flex:" + width + " 1 0",
            title: title,
            onClick: () => scrollToSectionOrMessage(capture.id, section.messageIndex, section.sectionId),
          });
        })),
      h("div", { class: "telemetry-legend" },
        ...composition.map((item) => {
          const catClass = "cat-" + item.category;
          return h("div", {
            class: "telemetry-legend-item",
            title: "Click to jump to " + item.categoryLabel,
            onClick: () => {
              const match = sections.find((s) => s.category === item.category);
              if (match) scrollToSectionOrMessage(capture.id, match.messageIndex, match.sectionId);
            },
          },
            h("span", { class: "swatch " + catClass, style: "border-radius:2px;" }),
            h("span", { style: "font-weight:600;" }, item.categoryLabel + ":"),
            h("span", { class: "quiet" }, item.tokens.toLocaleString("en-US") + "t (" + item.percentage + "%)"));
        })),
      warnings.length > 0
        ? h("div", { class: "stack", style: "gap:4px;" },
            ...warnings.map((w) => h("div", { class: "telemetry-advisory" },
              h("span", null, "⚠️"),
              h("span", null, w))))
        : null);
  }

  function scrollToSectionOrMessage(captureId, messageIndex, sectionId) {
    if (sectionId) {
      const el = document.getElementById("section-" + captureId + "-" + sectionId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.classList.add("highlight-pulse");
        setTimeout(() => el.classList.remove("highlight-pulse"), 2000);
        return;
      }
    }
    scrollToMessage(captureId, messageIndex);
  }

  function categoryIcon(category) {
    switch (category) {
      case "system_instruction": return "🟢";
      case "rag_grounding": return "🟣";
      case "chat_history": return "🟡";
      case "few_shot_exemplar": return "⭐";
      case "schema_tool_spec": return "🔧";
      case "user_query": return "🔵";
      default: return "📄";
    }
  }

  function scrollToMessage(captureId, messageIndex) {
    const el = document.getElementById("message-" + captureId + "-" + messageIndex);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function attributeMessage(captureId, messageIndex, content) {
    attributingMessage = captureId + ":" + messageIndex;
    render();
    post({ type: "attributeMessage", captureId: captureId, messageIndex: messageIndex, content: content });
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

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => undefined);
    }
    post({ type: "copyText", text: text });
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
