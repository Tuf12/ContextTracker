const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { startRecorder } = require("../out/recorder.js");

const TOKEN = "sk-test-secret-do-not-store";

test("the capture proxy streams the reply and does not keep the API key", async () => {
  let auth = "";
  let receivedPath = "";
  let receivedBody = "";
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      auth = String(req.headers.authorization || "");
      receivedPath = req.url || "";
      receivedBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":" there"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      }, 150);
    });
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;
  let capture = null;
  let spans = null;
  const recorder = await startRecorder({
    port: 0,
    route: () => ({ mode: "custom", customUpstream: `http://127.0.0.1:${upstreamPort}` }),
    onCapture: (item) => {
      capture = item;
    },
    onSpans: (id, reported) => {
      spans = { id, reported };
    },
    onLog: () => undefined,
  });

  try {
    const streamed = await request(recorder.port, "POST", "/v1/chat/completions", JSON.stringify({
      model: "gpt-test",
      messages: [{ role: "user", content: "Can I return the headphones?" }],
    }), {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.body, /"content":"Hello"/);
    assert.match(streamed.body, /"content":" there"/);
    assert.ok(streamed.elapsed >= 80);
    assert.equal(auth, `Bearer ${TOKEN}`);
    assert.equal(receivedPath, "/v1/chat/completions");
    assert.match(receivedBody, /headphones/);
    assert.ok(capture);
    assert.equal(capture.model, "gpt-test");
    assert.equal(capture.reply, "Hello there");
    assert.equal(JSON.stringify(capture).includes(TOKEN), false);

    const listed = await request(recorder.port, "GET", "/v1/models", "", { authorization: `Bearer ${TOKEN}` });
    assert.equal(listed.status, 200);
    assert.equal(capture.endpoint, "/v1/chat/completions");

    const marked = await request(recorder.port, "POST", "/context-tracker/v1/spans", JSON.stringify({
      id: "call-1",
      spans: [{ quote: "Can I return the headphones?", file: "prompts/system.md", startLine: 1, endLine: 1 }],
    }), { "content-type": "application/json" });
    assert.equal(marked.status, 204);
    assert.equal(spans.id, "call-1");
    assert.equal(spans.reported[0].file, "prompts/system.md");
  } finally {
    await recorder.close();
    await close(upstream);
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(port, method, requestPath, body, headers) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let firstAt = 0;
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        if (!firstAt) {
          firstAt = Date.now();
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const endAt = Date.now();
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          elapsed: firstAt ? endAt - firstAt : 0,
        });
      });
    });
    req.on("error", reject);
    req.end(body);
    void started;
  });
}
