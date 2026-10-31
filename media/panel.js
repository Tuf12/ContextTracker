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

  window.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "state") {
      return;
    }
    state = event.data.state;
    render();
  });

  vscode.postMessage({ type: "ready" });

  function render() {
    const scroller = document.scrollingElement;
    if (scroller) {
      scrollTop = scroller.scrollTop;
    }
    const sameCapture = state && state.selectedId === seenCapture;
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
    return h("div", { class: "layout", id: "shell" },
      h("aside", { class: "stack" },
        header(surface),
        projectCard(),
        recorderCard(),
        captureCard()),
      h("main", { class: "detail", id: "detail" }, detail()));
  }

  function header(surface) {
    return h("div", { class: "spread" },
      h("h1", null, "Context Tracker"),
      surface === "sidebar" ? h("button", { class: "secondary", onClick: send("openBeside") }, "Open in editor tab") : null);
  }

  function projectCard() {
    const project = state.project;
    const count = project.indexing
      ? "Indexing files…"
      : project.fileCount.toLocaleString("en-US") + " files indexed" + (project.truncated ? " (stopped at the file limit)" : "");
    return h("section", { class: "card" },
      h("div", { class: "spread" },
        h("h2", null, project.name),
        h("button", { class: "ghost", onClick: send("openProject") }, "Change")),
      h("p", { class: "path" }, project.path),
      h("p", { class: "quiet", id: "file-count" }, count),
      project.indexing ? null : h("button", { class: "ghost", onClick: send("reindex") }, "Index again"),
      h("button", { class: "secondary", onClick: send("openHelper") }, helperButtonLabel(state.helper)),
      state.helper && helperVisible(state.helper) ? helperCard(state.helper) : null);
  }

  function recorderCard() {
    const recorder = state.recorder;
    return h("section", { class: "card" },
      h("h2", null, "Capture"),
      h("p", null, recorder.running ? "Watching for a message." : "Capture is off."),
      recorder.found ? h("p", { class: "quiet" }, recorder.found) : null,
      recorder.error ? h("p", { class: "banner" }, recorder.error) : null,
      state.helper && state.helper.busy
        ? h("p", { class: "note" }, recorder.lastEvent || "The AI helper is searching this project for the model address so capture can connect.")
        : h("p", { class: "note" }, recorder.running
          ? "Launch the app after Start capture. An app that was already open keeps its old address, so its message never reaches capture and no error is shown. Each message after that launch is kept."
          : "Capture is off, so a message sent now is not recorded and the app will not show an error. Turn Start capture on, then close the app and launch it again."),
      state.helper && state.helper.busy ? null : recorder.lastEvent ? h("p", { class: "quiet" }, recorder.lastEvent) : null,
      h("div", { class: "row" },
        state.helper && state.helper.busy
          ? h("button", { class: "primary", disabled: true }, "AI helper is working…")
          : recorder.running
            ? h("button", { class: "secondary", onClick: send("stopCapture") }, "Stop capture")
            : h("button", { class: "primary", onClick: send("startCapture") }, "Start capture"),
        h("button", { class: "ghost", onClick: send("showLog") }, "Show log")));
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
      helper.offer ? h("p", { class: "note" }, helper.offer.relativeFile + " line " + helper.offer.line + " · " + helper.offer.url) : null,
      h("div", { class: "row" },
        helper.connectOpen ? h("button", { class: "secondary", onClick: saveHelper }, "Connect") : null,
        helper.offer
          ? h("button", { class: "primary", onClick: send("confirmAddress") }, "Use this address")
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
    return h("section", { class: "stack" },
      h("div", { class: "spread" },
        h("h2", null, "Calls"),
        state.captures.length
          ? h("button", { class: "ghost", onClick: requestClear }, confirmClear ? "Confirm clear" : "Clear")
          : null),
      state.captures.length === 0
        ? h("p", { class: "quiet" }, "No calls yet.")
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
    return h("div", { class: "capture" + (capture.id === state.selectedId ? " selected" : "") },
      h("button", {
        class: "capture-open",
        onClick: () => post({ type: "selectCapture", id: capture.id }),
      },
        h("div", { class: "spread" },
          h("span", null, when),
          h("span", { class: "meta" }, status)),
        h("div", null, capture.model),
        h("div", { class: "quiet" },
          (capture.fileSpanCount > 0 ? capture.fileSpanCount + " source links · " : "") + capture.preview)),
      state.captures.length > 1 && capture.id !== state.selectedId
        ? h("button", { class: "ghost", onClick: () => post({ type: "pinCapture", id: capture.id }) }, pinned ? "Unpin" : "Pin")
        : null);
  }

  function detail() {
    if (!state.selected) {
      return h("section", { class: "stack" },
        h("h2", null, "Prompt"),
        h("ol", { class: "steps" },
          h("li", null, "Start capture."),
          h("li", null, "Close the app and start it again."),
          h("li", null, "Send a message. Each later message is kept.")),
        h("p", { class: "quiet" }, "The prompt shows up here. A slice that matches a file opens in the editor. Pin an older call to set it beside a newer one."));
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
    return h("section", { class: "stack" },
      h("div", { class: "spread" },
        h("h2", null, which ? which + " · " + capture.model : capture.model),
        h("button", { class: "ghost", onClick: () => post({ type: "deleteCapture", id: capture.id }) }, "Delete call")),
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
      ...capture.messages.map((message) => renderMessage(capture, message)),
      h("section", { class: "reply" },
        h("h2", null, "Model reply"),
        h("p", { class: "quiet" }, "About " + capture.replyEstimatedTokens.toLocaleString("en-US") + " tokens · characters ÷ 4. This text was written by the model."),
        h("pre", null, capture.reply.trim() ? capture.reply : "No text came back.")),
      which ? null : exactHelp());
  }

  function barClass(span) {
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
    const hasFile = spans.some((span) => span.kind === "file" && span.source !== "reported");
    const hasReported = spans.some((span) => span.source === "reported");
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
        hasRuntime ? legend("bar-runtime", "Dynamic / conversation text") : null,
        h("span", { class: "quiet" }, total.toLocaleString("en-US") + " characters")));
  }

  function legend(className, label) {
    return h("span", { class: "row" }, h("span", { class: "swatch " + className }), label);
  }

  function renderMessage(capture, message) {
    return h("section", { class: "message" },
      h("h2", null, message.roleLabel),
      message.truncated ? h("p", { class: "quiet" }, "This part was shortened for display. The model still received the full text.") : null,
      ...message.spans.map((span) => renderSpan(capture, span)));
  }

  function renderSpan(capture, span) {
    const key = capture.id + ":" + span.id;
    const selected = key === selectedSpan;
    const kind = span.kind === "runtime" ? "runtime" : span.source === "reported" ? "reported" : "file";
    const body = h("pre", null, span.text);
    const block = h("div", { class: "block " + kind + (selected ? " selected" : ""), id: "span-" + key },
      span.canOpen
        ? h("button", { class: "block-head", onClick: () => openSpan(capture, span) }, span.label)
        : h("div", { class: "block-label" }, span.label),
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
