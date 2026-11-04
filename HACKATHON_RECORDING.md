# Recording script

Record the picture first, then the voice. Do not read while you click.

This take is the opening, Start capture, one captured request, and Stop capture. The contradiction patch and the self-healing loop stay in `HACKATHON_SHOWCASE.md`. They only work on special demo apps.

## Before you record

- Context Tracker sidebar is open.
- The AI helper is already connected. The button should say **AI helper: Meta**, not **Connect AI helper**.
- The demo app is running in a terminal.
- The **Calls** list is empty.
- After **Start capture**, quit the demo app and start it again. An app that was already open keeps the old model address, and no call will appear.

After each screen shot, stop or leave two seconds of stillness. If a button is not on screen, hold the frame. Do not hunt for it.

---

## 1. Screen only

No talking during this pass.

**Shot 1 — Hold the workspace.** Show the editor, the terminal with the app running, and the Context Tracker sidebar. Do not click. Hold about 15 seconds.

**Shot 2 — Start capture.** Move the pointer onto **Start capture** and rest it there for two seconds. Click it. The button changes to **AI helper is working…** and the status bar says **AI helper is searching**. Click **Log** and leave the tool lines on screen until the search finishes. Hold when the badge changes to **● Active (47321)**. The button is now **Stop capture**.

**Shot 3 — Restart the app.** In the terminal, stop the demo app and start it again. Hold until it is ready. Do not click the panel. This shot has no voice.

**Shot 4 — Send one message.** Send one message from the app. Return to the sidebar. When **Calls (1)** appears, click that call. The main view opens on **Context Window**. Hold there.

**Shot 5 — Show the bar.** If the top says **Context Window Anatomy & Telemetry** and the button says **Analyze Anatomy with Meta AI**, click it and wait. The title becomes **Context Anatomy & Token Budget**. Hold on the colored bar, then on the legend under it (the category names and percentages). Do not read the numbers out loud later. They change per app.

**Shot 6 — Show one card.** Scroll to the first card that shows **WHAT** and **WHY**. Hold on those two lines.

**Shot 7 — Open the source, if it is there.** Use whichever of these is actually on screen:

- The call already says **source links**. Click the link. Hold on the file and line in the editor.
- A card shows **Trace in Code**. Click it, wait through **Tracing…**, then hold on the file that opens.
- Neither is there. Stay on the **WHAT** / **WHY** card. You will skip the Shot 7 voice line.

**Shot 8 — Stop capture.** Click **Stop capture**. Hold when the badge returns to **○ Off**.

---

## 2. Voice only

Read one shot, pause, then read the next. Look at this page, not the app. Skip Shot 7 if the picture has no file jump. Shot 3 stays silent.

**Shot 1.** Every model call is built from instructions, conversation history, tools, and sometimes retrieved data. When the answer is wrong, it is hard to see exactly what the model received, or which part of your code put it there. Context Tracker captures the request inside VS Code. You inspect the context, and Meta AI traces each piece back to the file it came from. Let me show you how it works.

**Shot 2.** Context Tracker does not guess with hardcoded patterns. Meta AI's Muse Spark reads the project and decides how to connect. You click Start capture. Meta AI looks through the code, checks for local services, and searches your config files. It runs those checks at the same time. Very quickly, it finds the runtime configuration and starts the recorder on port 47321.

**Shot 3.** No words.

**Shot 4.** Let's send a request in the app. Context Tracker catches the call.

**Shot 5.** The bar at the top splits the prompt into sections and shows how much of the token budget each one uses. That split follows the app: instructions, chat history, tools, or retrieved data.

**Shot 6.** Meta AI labels each section with what it is and why it is there.

**Shot 7.** If a section comes from the project, you can jump to the file and line that produced it. When the text was built at runtime, Meta AI traces it back to the source.

**Shot 8.** Stop capture, and the project points back at the real model. Context Tracker shows what the model received, and where that text came from, inside the editor.

---

## 3. Together

Lay each voice clip on the timeline where that shot's picture starts. If the voice is longer than the click, hold the last frame. If the picture is longer, trim the end. Shot 3 sits silent between Shot 2 and Shot 4.

| Shot | Start the voice when you see this | The picture must reach this before the line ends |
| --- | --- | --- |
| 1 | The editor and the running terminal | The same view. No clicks. |
| 2 | The pointer resting on **Start capture** | The **● Active (47321)** badge |
| 4 | The moment you send the message | The open **Context Window** |
| 5 | The colored bar, or **Analyze Anatomy with Meta AI** if you had to click it | The legend with the category names and percentages |
| 6 | The first **WHAT** line | The **WHY** line under it |
| 7 | The source link or **Trace in Code** | The file open in the editor |
| 8 | The click on **Stop capture** | The **○ Off** badge |
