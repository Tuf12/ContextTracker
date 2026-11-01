const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  bridgeAndroidDevice,
  checkAndroidBuildState,
  detectAndroidEnvironment,
  diagnoseAndroidConnection,
  findAdbPath,
  findLatestBuildArtifact,
  findManifestFile,
  inspectAndroidSecurity,
  isAndroidProject,
  parseAdbDevicesOutput,
  parseAdbReverseList,
  removeAndroidBridge,
} = require("../out/android.js");

test("findAdbPath resolves custom path and env variables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adb-test-"));
  try {
    const fakeAdb = path.join(tmp, process.platform === "win32" ? "adb.exe" : "adb");
    fs.writeFileSync(fakeAdb, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeAdb, 0o755);

    // Custom path direct match
    assert.equal(findAdbPath(fakeAdb), fakeAdb);

    // PATH environment resolution
    const fromPath = findAdbPath(undefined, { PATH: tmp });
    assert.equal(fromPath, fakeAdb);

    // ANDROID_HOME / platform-tools resolution
    const sdkHome = path.join(tmp, "sdk");
    const platTools = path.join(sdkHome, "platform-tools");
    fs.mkdirSync(platTools, { recursive: true });
    const sdkAdb = path.join(platTools, process.platform === "win32" ? "adb.exe" : "adb");
    fs.writeFileSync(sdkAdb, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(sdkAdb, 0o755);

    const fromSdk = findAdbPath(undefined, { ANDROID_HOME: sdkHome, PATH: "" });
    assert.equal(fromSdk, sdkAdb);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseAdbDevicesOutput parses physical devices, emulators, and states", () => {
  const output = [
    "List of devices attached",
    "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64x transport_id:1",
    "RFCW10ABCD             device usb:1-1 product:panther model:Pixel_8_Pro device:panther transport_id:2",
    "unauthorized_dev       unauthorized transport_id:3",
    "offline_dev            offline transport_id:4",
    "",
  ].join("\n");

  const devices = parseAdbDevicesOutput(output);
  assert.equal(devices.length, 4);

  assert.equal(devices[0].serial, "emulator-5554");
  assert.equal(devices[0].type, "emulator");
  assert.equal(devices[0].state, "device");
  assert.equal(devices[0].model, "sdk_gphone64_x86_64");

  assert.equal(devices[1].serial, "RFCW10ABCD");
  assert.equal(devices[1].type, "physical");
  assert.equal(devices[1].state, "device");
  assert.equal(devices[1].model, "Pixel_8_Pro");

  assert.equal(devices[2].state, "unauthorized");
  assert.equal(devices[3].state, "offline");
});

test("parseAdbReverseList parses standard and multi-device reverse outputs", () => {
  const output = [
    "RFCW10ABCD tcp:47321 tcp:47321",
    "emulator-5554 tcp:47321 tcp:47321",
    "tcp:8081 tcp:8081",
  ].join("\n");

  const rules = parseAdbReverseList(output);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].deviceSerial, "RFCW10ABCD");
  assert.equal(rules[0].local, "tcp:47321");
  assert.equal(rules[0].remote, "tcp:47321");
  assert.equal(rules[2].local, "tcp:8081");
});

test("detectAndroidEnvironment handles missing ADB and device outputs via runner", async () => {
  // When ADB is missing
  const missing = await detectAndroidEnvironment({ adbPath: "/nonexistent/adb" });
  assert.equal(missing.available, false);
  assert.equal(missing.adbPath, null);
  assert.match(missing.summary, /10\.0\.2\.2:47321/);

  // When ADB exists and runner returns active devices
  const mockRunner = async (cmd, args) => {
    assert.deepEqual(args, ["devices", "-l"]);
    return {
      stdout: "emulator-5554 device product:emu model:Pixel_Tablet\n",
      stderr: "",
      exitCode: 0,
    };
  };

  const detected = await detectAndroidEnvironment({
    adbPath: "/bin/sh",
    runner: mockRunner,
  });

  assert.equal(detected.available, true);
  assert.equal(detected.devices.length, 1);
  assert.equal(detected.devices[0].serial, "emulator-5554");
  assert.equal(detected.defaultStrategy, "adb_reverse");
  assert.match(detected.summary, /Pixel_Tablet/);
});

test("bridgeAndroidDevice validates inputs and executes reverse port forwarding", async () => {
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "devices") {
      return { stdout: "emulator-5554 device\n", stderr: "", exitCode: 0 };
    }
    if (args.includes("reverse") && args.includes("--list")) {
      return { stdout: "emulator-5554 tcp:47321 tcp:47321\n", stderr: "", exitCode: 0 };
    }
    if (args.includes("reverse")) {
      return { stdout: "47321\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  // Port validation
  const invalidPort = await bridgeAndroidDevice({ devicePort: 999999 });
  assert.equal(invalidPort.success, false);
  assert.match(invalidPort.error, /Invalid device port/);

  // Serial injection safety
  const unsafeSerial = await bridgeAndroidDevice({ deviceSerial: "dev; rm -rf /" });
  assert.equal(unsafeSerial.success, false);
  assert.match(unsafeSerial.error, /Invalid device serial/);

  // Successful bridge
  const bridged = await bridgeAndroidDevice({
    adbPath: "/bin/sh",
    deviceSerial: "emulator-5554",
    devicePort: 47321,
    hostPort: 47321,
    runner: mockRunner,
  });

  assert.equal(bridged.success, true);
  assert.deepEqual(bridged.bridgedDevices, ["emulator-5554"]);
  assert.equal(bridged.forwardingRule, "tcp:47321 -> tcp:47321");
  assert.equal(bridged.verification, "active");

  const reverseCall = calls.find((c) => c.args.includes("reverse") && c.args.includes("tcp:47321"));
  assert.ok(reverseCall);
  assert.deepEqual(reverseCall.args, ["-s", "emulator-5554", "reverse", "tcp:47321", "tcp:47321"]);
});

test("removeAndroidBridge executes adb reverse --remove", async () => {
  const calls = [];
  const mockRunner = async (cmd, args) => {
    calls.push(args);
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const removed = await removeAndroidBridge({
    adbPath: "/bin/sh",
    deviceSerial: "RFCW10ABCD",
    devicePort: 47321,
    runner: mockRunner,
  });

  assert.equal(removed.success, true);
  assert.deepEqual(calls[0], ["-s", "RFCW10ABCD", "reverse", "--remove", "tcp:47321"]);
});

test("inspectAndroidSecurity analyzes manifests and network security configs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-sec-"));
  try {
    // 1. Missing manifest
    const noManifest = inspectAndroidSecurity(root);
    assert.equal(noManifest.manifestFound, false);
    assert.equal(noManifest.cleartextPermitted, false);

    // 2. Manifest with usesCleartextTraffic="true"
    const appMain = path.join(root, "app", "src", "main");
    fs.mkdirSync(appMain, { recursive: true });
    const manifestPath = path.join(appMain, "AndroidManifest.xml");
    fs.writeFileSync(
      manifestPath,
      '<manifest><application android:usesCleartextTraffic="true"></application></manifest>',
    );

    const cleartextTrue = inspectAndroidSecurity(root);
    assert.equal(cleartextTrue.manifestFound, true);
    assert.equal(cleartextTrue.cleartextPermitted, true);
    assert.equal(cleartextTrue.usesCleartextTraffic, true);
    assert.equal(cleartextTrue.risk, undefined);

    // 3. Manifest blocking cleartext by default without network config
    fs.writeFileSync(
      manifestPath,
      '<manifest><application android:label="MyApp"></application></manifest>',
    );
    const cleartextBlocked = inspectAndroidSecurity(root);
    assert.equal(cleartextBlocked.cleartextPermitted, false);
    assert.match(cleartextBlocked.risk, /Android 9\+/);
    assert.match(cleartextBlocked.remediation, /network_security_config/);

    // 4. Manifest referencing network_security_config allowing loopback
    fs.writeFileSync(
      manifestPath,
      '<manifest><application android:networkSecurityConfig="@xml/network_security_config"></application></manifest>',
    );
    const resXml = path.join(appMain, "res", "xml");
    fs.mkdirSync(resXml, { recursive: true });
    fs.writeFileSync(
      path.join(resXml, "network_security_config.xml"),
      [
        "<network-security-config>",
        '  <domain-config cleartextTrafficPermitted="true">',
        "    <domain includeSubdomains=\"true\">127.0.0.1</domain>",
        "    <domain includeSubdomains=\"true\">10.0.2.2</domain>",
        "  </domain-config>",
        "</network-security-config>",
      ].join("\n"),
    );

    const securedConfig = inspectAndroidSecurity(root);
    assert.equal(securedConfig.cleartextPermitted, true);
    assert.equal(securedConfig.configAllowsLocalhost, true);
    assert.equal(securedConfig.networkSecurityConfigPath, "app/src/main/res/xml/network_security_config.xml");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("isAndroidProject detects gradle build files and AndroidManifest.xml", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-proj-detect-"));
  try {
    assert.equal(isAndroidProject(root), false);

    const gradleKts = path.join(root, "build.gradle.kts");
    fs.writeFileSync(gradleKts, "// gradle");
    assert.equal(isAndroidProject(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkAndroidBuildState identifies fresh, stale, and missing APK artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-build-state-"));
  try {
    // 1. Non-Android project
    const nonAndroid = checkAndroidBuildState(root);
    assert.equal(nonAndroid.isAndroidProject, false);
    assert.equal(nonAndroid.isStale, false);

    // 2. Android project with no APKs
    fs.writeFileSync(path.join(root, "build.gradle"), "// root gradle");
    const noApk = checkAndroidBuildState(root);
    assert.equal(noApk.isAndroidProject, true);
    assert.equal(noApk.hasBuildArtifacts, false);
    assert.equal(noApk.isStale, true);
    assert.match(noApk.summary, /No build artifacts/);

    // 3. Android project with an APK artifact
    const apkDir = path.join(root, "app", "build", "outputs", "apk", "debug");
    fs.mkdirSync(apkDir, { recursive: true });
    const apkFile = path.join(apkDir, "app-debug.apk");
    fs.writeFileSync(apkFile, "fake-apk-binary");

    // Fresh source file older than APK
    const srcDir = path.join(root, "app", "src", "main", "java");
    fs.mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "Client.kt");
    fs.writeFileSync(srcFile, "class Client");

    // Explicitly set source mtime to earlier than APK
    const now = Date.now();
    fs.utimesSync(srcFile, (now - 10000) / 1000, (now - 10000) / 1000);
    fs.utimesSync(apkFile, now / 1000, now / 1000);

    const freshState = checkAndroidBuildState(root, srcFile);
    assert.equal(freshState.isAndroidProject, true);
    assert.equal(freshState.hasBuildArtifacts, true);
    assert.equal(freshState.isStale, false);
    assert.match(freshState.summary, /up to date/);

    // Stale: source file updated after APK compilation
    fs.utimesSync(srcFile, (now + 5000) / 1000, (now + 5000) / 1000);
    const staleState = checkAndroidBuildState(root, srcFile);
    assert.equal(staleState.isStale, true);
    assert.match(staleState.summary, /older than modified source file/);
    assert.match(staleState.summary, /Android Studio/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("diagnoseAndroidConnection analyzes environment, security, and repairs missing bridge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-diag-"));
  try {
    fs.writeFileSync(path.join(root, "build.gradle"), "// gradle");
    const appDir = path.join(root, "app", "src", "main");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "AndroidManifest.xml"), "<manifest><application></application></manifest>");

    const calls = [];
    const mockRunner = async (cmd, args) => {
      calls.push(args);
      if (args[0] === "devices") {
        return { stdout: "emulator-5554 device model:Pixel_7\n", stderr: "", exitCode: 0 };
      }
      if (args.includes("reverse") && args.includes("--list")) {
        return { stdout: "emulator-5554 tcp:47321 tcp:47321\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "47321\n", stderr: "", exitCode: 0 };
    };

    const diag = await diagnoseAndroidConnection({
      projectRoot: root,
      adbPath: "/bin/sh",
      runner: mockRunner,
    });

    assert.equal(diag.isAndroid, true);
    assert.equal(diag.env.available, true);
    assert.equal(diag.security.cleartextPermitted, false);
    assert.equal(diag.buildState.isStale, true); // No APKs yet
    assert.ok(diag.repairedBridge);
    assert.equal(diag.repairedBridge.success, true);
    assert.deepEqual(diag.repairedBridge.bridgedDevices, ["emulator-5554"]);

    assert.ok(diag.issues.some((i) => i.includes("cleartext")));
    assert.ok(diag.remedies.some((r) => r.includes("network_security_config")));
    assert.ok(diag.remedies.some((r) => r.includes("Android Studio")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 4 Webview UI integration: AndroidViewInfo contract conforms to schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-view-test-"));
  try {
    fs.writeFileSync(path.join(root, "build.gradle.kts"), "// kotlin");
    const appDir = path.join(root, "app", "src", "main");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "AndroidManifest.xml"), "<manifest><application></application></manifest>");

    const isAndroid = isAndroidProject(root);
    assert.equal(isAndroid, true);

    const security = inspectAndroidSecurity(root);
    assert.equal(security.cleartextPermitted, false);
    assert.ok(security.remediation);

    const buildState = checkAndroidBuildState(root);
    assert.equal(buildState.isStale, true);

    const mobileInfo = {
      isAndroid: true,
      deviceLabel: "emulator-5554 (Pixel 8)",
      bridged: true,
      cleartextPermitted: security.cleartextPermitted,
      securityRisk: security.risk,
      remediationSnippet: security.remediation,
      isStale: buildState.isStale,
      staleSummary: buildState.summary,
    };

    assert.equal(mobileInfo.isAndroid, true);
    assert.equal(mobileInfo.bridged, true);
    assert.equal(mobileInfo.cleartextPermitted, false);
    assert.match(mobileInfo.remediationSnippet, /network-security-config/);
    assert.equal(mobileInfo.isStale, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
