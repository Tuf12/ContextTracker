const assert = require("node:assert/strict");
const test = require("node:test");
const { TrafficWatchdog } = require("../out/watchdog.js");

test("TrafficWatchdog initializes in off state", () => {
  const watchdog = new TrafficWatchdog({ upstream: "http://127.0.0.1:11434" });
  assert.equal(watchdog.getState(), "off");
  assert.equal(watchdog.getRequestCount(), 0);
  assert.equal(watchdog.getUptimeSeconds(), 0);
  assert.equal(watchdog.getMissedHint(), null);
});

test("TrafficWatchdog starts listening and tracks uptime and request count", () => {
  const changes = [];
  const watchdog = new TrafficWatchdog({
    upstream: "http://127.0.0.1:11434",
    onStateChange: (state, hint) => changes.push({ state, hint }),
  });

  const t0 = 1000000;
  watchdog.start(t0);

  assert.equal(watchdog.getState(), "listening");
  assert.equal(watchdog.getRequestCount(), 0);
  assert.equal(watchdog.getUptimeSeconds(t0 + 5000), 5);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].state, "listening");

  // Record a request
  watchdog.recordRequest();
  assert.equal(watchdog.getState(), "active");
  assert.equal(watchdog.getRequestCount(), 1);
  assert.equal(changes[changes.length - 1].state, "active");

  watchdog.recordRequest();
  assert.equal(watchdog.getRequestCount(), 2);

  // Stop watchdog
  watchdog.stop();
  assert.equal(watchdog.getState(), "off");
  assert.equal(watchdog.getRequestCount(), 0);
  assert.equal(watchdog.getUptimeSeconds(), 0);
});

test("TrafficWatchdog transitions to listening_idle on silence timeout", () => {
  const watchdog = new TrafficWatchdog({
    upstream: "https://api.openai.com",
    idleTimeoutSeconds: 10,
  });

  const t0 = 2000000;
  watchdog.start(t0);

  // Before timeout: still listening
  assert.equal(watchdog.checkIdle(t0 + 5000), false);
  assert.equal(watchdog.getState(), "listening");

  // At or after timeout (10s): transitions to listening_idle with passive waiting hint
  assert.equal(watchdog.checkIdle(t0 + 10000), true);
  assert.equal(watchdog.getState(), "listening_idle");
  assert.match(watchdog.getMissedHint(), /Still no requests on port 47321 after 10s/);
  assert.match(watchdog.getMissedHint(), /Troubleshoot Connection/);
  assert.doesNotMatch(watchdog.getMissedHint(), /https:\/\/api\.openai\.com/);

  watchdog.stop();
});

test("TrafficWatchdog transitions to listening_idle on user activity if no requests arrived", () => {
  const watchdog = new TrafficWatchdog({
    upstream: "http://127.0.0.1:8000",
    activityIdleSeconds: 5,
  });

  const t0 = 3000000;
  watchdog.start(t0);

  // User activity too early (2s): no transition
  assert.equal(watchdog.recordUserActivity(t0 + 2000), false);
  assert.equal(watchdog.getState(), "listening");

  // User activity after 6s: transitions to listening_idle
  assert.equal(watchdog.recordUserActivity(t0 + 6000), true);
  assert.equal(watchdog.getState(), "listening_idle");
  assert.match(watchdog.getMissedHint(), /http:\/\/127\.0\.0\.1:8000/);

  watchdog.stop();
});

test("TrafficWatchdog troubleshoot connection immediately marks idle and generates hint", () => {
  const watchdog = new TrafficWatchdog({ upstream: "http://localhost:11434" });
  const t0 = 4000000;
  watchdog.start(t0);

  watchdog.troubleshoot(t0 + 3000);
  assert.equal(watchdog.getState(), "listening_idle");
  assert.match(watchdog.getMissedHint(), /http:\/\/localhost:11434/);
  assert.match(watchdog.getMissedHint(), /port 47321/);

  watchdog.stop();
});
