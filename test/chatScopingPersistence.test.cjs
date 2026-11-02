const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { CaptureStore } = require("../out/store.js");

test("CaptureStore persists chat conversations across sessions and scopes per capture", async () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-store-chat-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-proj-chat-"));
  const store = new CaptureStore(storeRoot);
  await store.init();

  const cap1 = {
    id: "cap-ctx-001",
    clientRequestId: "req-1",
    projectPath: projectRoot,
    createdAt: new Date().toISOString(),
    provider: "Meta AI",
    upstream: "https://api.meta.ai",
    endpoint: "/v1/chat/completions",
    model: "muse-spark-1.3",
    status: 200,
    error: null,
    messages: [
      { role: "system", content: "You are a customer service bot.", truncated: false },
      { role: "user", content: "What is your refund policy?", truncated: false },
    ],
    reply: "Our refund policy is 30 days.",
    reported: [],
  };

  const cap2 = {
    id: "cap-ctx-002",
    clientRequestId: "req-2",
    projectPath: projectRoot,
    createdAt: new Date().toISOString(),
    provider: "Meta AI",
    upstream: "https://api.meta.ai",
    endpoint: "/v1/chat/completions",
    model: "muse-wonder-1.0",
    status: 200,
    error: null,
    messages: [
      { role: "system", content: "You are a coding assistant.", truncated: false },
      { role: "user", content: "Write a quicksort in Python", truncated: false },
    ],
    reply: "def quicksort(arr): ...",
    reported: [],
  };

  await store.add(cap1);
  await store.add(cap2);

  // Chat conversation for Context Window 1
  const conv1 = {
    id: "cap-ctx-001",
    activity: [
      {
        id: "act-1",
        timestamp: Date.now(),
        kind: "user",
        text: "Why did you reply with 30 days?",
      },
      {
        id: "act-2",
        timestamp: Date.now(),
        kind: "thought",
        text: "Checking system instruction and context sections...",
      },
      {
        id: "act-3",
        timestamp: Date.now(),
        kind: "assistant",
        text: "Because rule #1 in the system prompt dictates a 30-day window.",
      },
    ],
    messages: [
      { role: "user", content: "Why did you reply with 30 days?" },
      { role: "assistant", content: "Because rule #1 in the system prompt dictates a 30-day window." },
    ],
    activePatch: {
      patchId: "patch-1",
      file: "prompts/support.prompt",
      startLine: 1,
      endLine: 5,
      originalCode: "refund: 30 days",
      replacementCode: "refund: 60 days",
      diffPreview: "- refund: 30 days\n+ refund: 60 days",
      status: "proposed",
    },
    updatedAt: Date.now(),
  };

  // Chat conversation for Context Window 2
  const conv2 = {
    id: "cap-ctx-002",
    activity: [
      {
        id: "act-201",
        timestamp: Date.now(),
        kind: "user",
        text: "Scan this prompt for PII leaks.",
      },
      {
        id: "act-202",
        timestamp: Date.now(),
        kind: "assistant",
        text: "No PII was detected in the prompt context window.",
      },
    ],
    messages: [
      { role: "user", content: "Scan this prompt for PII leaks." },
      { role: "assistant", content: "No PII was detected in the prompt context window." },
    ],
    updatedAt: Date.now(),
  };

  // Project-level chat conversation
  const convProject = {
    id: "project",
    activity: [
      {
        id: "act-p1",
        timestamp: Date.now(),
        kind: "status",
        text: "Starting autonomous search for model address...",
      },
    ],
    messages: [],
    updatedAt: Date.now(),
  };

  await store.saveChat(projectRoot, conv1);
  await store.saveChat(projectRoot, conv2);
  await store.saveChat(projectRoot, convProject);

  // 1. Verify listChats
  const savedChats = await store.listChats(projectRoot);
  assert.ok(savedChats.includes("cap-ctx-001"), "listChats includes cap-ctx-001");
  assert.ok(savedChats.includes("cap-ctx-002"), "listChats includes cap-ctx-002");
  assert.ok(savedChats.includes("project"), "listChats includes project");

  // 2. Simulate complete extension reload with fresh store instance
  const freshStore = new CaptureStore(storeRoot);
  await freshStore.init();

  const restoredConv1 = await freshStore.getChat(projectRoot, "cap-ctx-001");
  assert.ok(restoredConv1, "Restored conv1 exists");
  assert.equal(restoredConv1.id, "cap-ctx-001");
  assert.equal(restoredConv1.activity.length, 3);
  assert.equal(restoredConv1.activity[0].text, "Why did you reply with 30 days?");
  assert.equal(restoredConv1.messages.length, 2);
  assert.equal(restoredConv1.activePatch?.patchId, "patch-1");

  const restoredConv2 = await freshStore.getChat(projectRoot, "cap-ctx-002");
  assert.ok(restoredConv2, "Restored conv2 exists");
  assert.equal(restoredConv2.id, "cap-ctx-002");
  assert.equal(restoredConv2.activity.length, 2);
  assert.equal(restoredConv2.activity[0].text, "Scan this prompt for PII leaks.");
  assert.equal(restoredConv2.activePatch, undefined);

  const restoredProject = await freshStore.getChat(projectRoot, "project");
  assert.ok(restoredProject, "Restored project chat exists");
  assert.equal(restoredProject.id, "project");
  assert.equal(restoredProject.activity.length, 1);

  // 3. Verify Scoping on Removal
  // Removing chat for cap-ctx-001 leaves cap-ctx-002 and project intact
  await freshStore.removeChat(projectRoot, "cap-ctx-001");
  assert.equal(await freshStore.getChat(projectRoot, "cap-ctx-001"), null);
  assert.notEqual(await freshStore.getChat(projectRoot, "cap-ctx-002"), null);
  assert.notEqual(await freshStore.getChat(projectRoot, "project"), null);

  // 4. Verify capture removal cascades to removing its chat
  await freshStore.remove(projectRoot, "cap-ctx-002");
  assert.equal(await freshStore.getChat(projectRoot, "cap-ctx-002"), null);
  assert.notEqual(await freshStore.getChat(projectRoot, "project"), null);

  // 5. Clean up
  await freshStore.clear(projectRoot);
  assert.equal(await freshStore.getChat(projectRoot, "project"), null);

  fs.rmSync(storeRoot, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});
