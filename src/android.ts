import childProcess from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  AndroidBridgeResult,
  AndroidBuildStateResult,
  AndroidDevice,
  AndroidEnvironment,
  AndroidSecurityResult,
} from "./types";

export const DEFAULT_RECORDER_PORT = 47321;
export const ADB_TIMEOUT_MS = 1500;

export const SERIAL_REGEX = /^[a-zA-Z0-9._:-]+$/;
export const PORT_REGEX = /^\d{1,5}$/;

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ExecRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<ExecResult>;

export const defaultExecRunner: ExecRunner = (cmd, args, timeoutMs) => {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(
        cmd,
        args,
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ? stdout.toString() : "",
            stderr: stderr ? stderr.toString() : "",
            exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          });
        },
      );
    } catch {
      resolve({ stdout: "", stderr: "Failed to spawn process.", exitCode: 1 });
    }
  });
};

export function findAdbPath(customPath?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (customPath !== undefined && customPath !== null && customPath.trim()) {
    const candidate = customPath.trim();
    return fs.existsSync(candidate) ? candidate : null;
  }

  const isWin = process.platform === "win32";
  const adbBinName = isWin ? "adb.exe" : "adb";

  const pathEntries = (env.PATH || "").split(isWin ? ";" : ":").filter(Boolean);
  for (const dir of pathEntries) {
    const full = path.join(dir, adbBinName);
    if (fs.existsSync(full)) {
      return full;
    }
  }

  const sdkRoots: string[] = [];
  if (env.ANDROID_HOME) {
    sdkRoots.push(env.ANDROID_HOME);
  }
  if (env.ANDROID_SDK_ROOT) {
    sdkRoots.push(env.ANDROID_SDK_ROOT);
  }

  const home = os.homedir();
  if (home) {
    sdkRoots.push(
      path.join(home, "Android", "Sdk"),
      path.join(home, "Library", "Android", "sdk"),
      path.join(home, "AppData", "Local", "Android", "Sdk"),
    );
  }
  sdkRoots.push("/opt/android-sdk", "/usr/lib/android-sdk");

  for (const root of sdkRoots) {
    const candidate = path.join(root, "platform-tools", adbBinName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function parseAdbDevicesOutput(output: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("* daemon")) {
      continue;
    }

    const tokens = line.split(/\s+/);
    if (tokens.length < 2) {
      continue;
    }

    const serial = tokens[0];
    const state = tokens[1];
    if (!SERIAL_REGEX.test(serial)) {
      continue;
    }

    const isEmulator = serial.startsWith("emulator-");
    const deviceType: AndroidDevice["type"] = isEmulator ? "emulator" : "physical";

    let model: string | undefined;
    let product: string | undefined;

    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith("model:")) {
        model = token.slice(6);
      } else if (token.startsWith("product:")) {
        product = token.slice(8);
      }
    }

    devices.push({
      serial,
      state,
      type: deviceType,
      model,
      product,
    });
  }

  return devices;
}

export async function detectAndroidEnvironment(options?: {
  adbPath?: string;
  execTimeoutMs?: number;
  runner?: ExecRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<AndroidEnvironment> {
  const runner = options?.runner || defaultExecRunner;
  const timeoutMs = options?.execTimeoutMs ?? ADB_TIMEOUT_MS;
  const adbPath = findAdbPath(options?.adbPath, options?.env);

  if (!adbPath) {
    return {
      available: false,
      adbPath: null,
      devices: [],
      defaultStrategy: "emulator_gateway",
      summary: "Android Debug Bridge (adb) was not found on this machine. If using an emulator, you can route traffic to http://10.0.2.2:47321 directly.",
    };
  }

  const result = await runner(adbPath, ["devices", "-l"], timeoutMs);
  if (result.exitCode !== 0) {
    return {
      available: false,
      adbPath,
      devices: [],
      defaultStrategy: "none",
      summary: `Failed to query ADB devices (exit code ${result.exitCode}): ${result.stderr.trim() || "timeout or connection refused"}`,
    };
  }

  const devices = parseAdbDevicesOutput(result.stdout);
  const activeDevices = devices.filter((d) => d.state === "device");

  let defaultStrategy: AndroidEnvironment["defaultStrategy"] = "none";
  let summary = "";

  if (activeDevices.length > 0) {
    defaultStrategy = "adb_reverse";
    const descriptions = activeDevices.map(
      (d) => `${d.serial} (${d.type}${d.model ? `, ${d.model}` : ""})`,
    );
    summary = `ADB active at ${adbPath}. Found ${activeDevices.length} connected device(s): ${descriptions.join(", ")}. Use bridge_android_device to map port 47321.`;
  } else if (devices.length > 0) {
    summary = `ADB found devices, but none are ready: ${devices.map((d) => `${d.serial} (${d.state})`).join(", ")}. Please unlock or authorize the device.`;
  } else {
    summary = `ADB is available at ${adbPath}, but no devices or emulators are currently connected. Launch an emulator or connect a device via USB.`;
  }

  return {
    available: true,
    adbPath,
    devices,
    defaultStrategy,
    summary,
  };
}

export function parseAdbReverseList(output: string): Array<{ deviceSerial?: string; local: string; remote: string }> {
  const rules: Array<{ deviceSerial?: string; local: string; remote: string }> = [];
  const lines = output.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const tokens = line.split(/\s+/);
    if (tokens.length >= 2) {
      if (tokens.length >= 3 && tokens[1].startsWith("tcp:") && tokens[2].startsWith("tcp:")) {
        rules.push({
          deviceSerial: tokens[0],
          local: tokens[1],
          remote: tokens[2],
        });
      } else if (tokens[0].startsWith("tcp:") && tokens[1].startsWith("tcp:")) {
        rules.push({
          local: tokens[0],
          remote: tokens[1],
        });
      }
    }
  }

  return rules;
}

export async function bridgeAndroidDevice(options: {
  deviceSerial?: string;
  devicePort?: number;
  hostPort?: number;
  adbPath?: string;
  execTimeoutMs?: number;
  runner?: ExecRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<AndroidBridgeResult> {
  const runner = options.runner || defaultExecRunner;
  const timeoutMs = options.execTimeoutMs ?? ADB_TIMEOUT_MS;
  const adbPath = findAdbPath(options.adbPath, options.env);

  const devicePort = options.devicePort ?? DEFAULT_RECORDER_PORT;
  const hostPort = options.hostPort ?? DEFAULT_RECORDER_PORT;

  if (!Number.isInteger(devicePort) || devicePort < 1 || devicePort > 65535) {
    return {
      success: false,
      bridgedDevices: [],
      forwardingRule: `tcp:${devicePort} -> tcp:${hostPort}`,
      verification: "failed",
      error: `Invalid device port: ${devicePort}. Must be between 1 and 65535.`,
    };
  }

  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    return {
      success: false,
      bridgedDevices: [],
      forwardingRule: `tcp:${devicePort} -> tcp:${hostPort}`,
      verification: "failed",
      error: `Invalid host port: ${hostPort}. Must be between 1 and 65535.`,
    };
  }

  if (options.deviceSerial && !SERIAL_REGEX.test(options.deviceSerial)) {
    return {
      success: false,
      bridgedDevices: [],
      forwardingRule: `tcp:${devicePort} -> tcp:${hostPort}`,
      verification: "failed",
      error: `Invalid device serial: ${options.deviceSerial}. Must contain only alphanumeric, dot, underscore, colon, or hyphen.`,
    };
  }

  if (!adbPath) {
    return {
      success: false,
      bridgedDevices: [],
      forwardingRule: `tcp:${devicePort} -> tcp:${hostPort}`,
      verification: "failed",
      error: "ADB was not found on this machine. Cannot establish reverse port forward.",
    };
  }

  let targetSerials: string[] = [];
  if (options.deviceSerial) {
    targetSerials = [options.deviceSerial];
  } else {
    const envStatus = await detectAndroidEnvironment({ adbPath, runner, execTimeoutMs: timeoutMs });
    const readyDevices = envStatus.devices.filter((d) => d.state === "device");
    if (readyDevices.length === 0) {
      return {
        success: false,
        bridgedDevices: [],
        forwardingRule: `tcp:${devicePort} -> tcp:${hostPort}`,
        verification: "failed",
        error: "No active Android devices or emulators are connected to bridge.",
      };
    }
    targetSerials = readyDevices.map((d) => d.serial);
  }

  const bridged: string[] = [];
  for (const serial of targetSerials) {
    const reverseArgs = ["-s", serial, "reverse", `tcp:${devicePort}`, `tcp:${hostPort}`];
    const reverseRes = await runner(adbPath, reverseArgs, timeoutMs);
    if (reverseRes.exitCode === 0) {
      bridged.push(serial);
    }
  }

  if (bridged.length === 0) {
    return {
      success: false,
      bridgedDevices: [],
      forwardingRule: `tcp:${devicePort} -> tcp:${hostPort}`,
      verification: "failed",
      error: `Failed to reverse forward port ${devicePort} on target device(s). Check if device is unlocked.`,
    };
  }

  let verified: AndroidBridgeResult["verification"] = "unverified";
  try {
    const listRes = await runner(adbPath, ["reverse", "--list"], timeoutMs);
    if (listRes.exitCode === 0) {
      const activeRules = parseAdbReverseList(listRes.stdout);
      const hasRule = activeRules.some(
        (r) => r.local === `tcp:${devicePort}` && r.remote === `tcp:${hostPort}`,
      );
      verified = hasRule ? "active" : "unverified";
    }
  } catch {
    verified = "unverified";
  }

  return {
    success: true,
    bridgedDevices: bridged,
    forwardingRule: `tcp:${devicePort} -> tcp:${hostPort}`,
    verification: verified,
  };
}

export async function removeAndroidBridge(options?: {
  deviceSerial?: string;
  devicePort?: number;
  adbPath?: string;
  execTimeoutMs?: number;
  runner?: ExecRunner;
  env?: NodeJS.ProcessEnv;
}): Promise<{ success: boolean; removedDevices: string[]; error?: string }> {
  const runner = options?.runner || defaultExecRunner;
  const timeoutMs = options?.execTimeoutMs ?? ADB_TIMEOUT_MS;
  const adbPath = findAdbPath(options?.adbPath, options?.env);
  const port = options?.devicePort ?? DEFAULT_RECORDER_PORT;

  if (!adbPath) {
    return { success: false, removedDevices: [], error: "ADB not found." };
  }

  if (options?.deviceSerial && !SERIAL_REGEX.test(options.deviceSerial)) {
    return { success: false, removedDevices: [], error: "Invalid device serial." };
  }

  const args: string[] = [];
  if (options?.deviceSerial) {
    args.push("-s", options.deviceSerial);
  }
  args.push("reverse", "--remove", `tcp:${port}`);

  const res = await runner(adbPath, args, timeoutMs);
  return {
    success: res.exitCode === 0,
    removedDevices: options?.deviceSerial ? [options.deviceSerial] : ["all"],
    error: res.exitCode !== 0 ? res.stderr.trim() : undefined,
  };
}

export function findManifestFile(projectRoot: string, customPath?: string): string | null {
  if (customPath && customPath.trim()) {
    const resolved = path.resolve(projectRoot, customPath.trim());
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  const candidates = [
    path.join(projectRoot, "app", "src", "main", "AndroidManifest.xml"),
    path.join(projectRoot, "src", "main", "AndroidManifest.xml"),
    path.join(projectRoot, "AndroidManifest.xml"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function inspectAndroidSecurity(
  projectRoot: string,
  options?: { manifestPath?: string },
): AndroidSecurityResult {
  const manifestFullPath = findManifestFile(projectRoot, options?.manifestPath);
  if (!manifestFullPath) {
    return {
      cleartextPermitted: false,
      manifestFound: false,
      risk: "No AndroidManifest.xml found in standard project directories (app/src/main/).",
    };
  }

  const manifestRel = path.relative(projectRoot, manifestFullPath);
  let manifestContent = "";
  try {
    manifestContent = fs.readFileSync(manifestFullPath, "utf8");
  } catch (err) {
    return {
      cleartextPermitted: false,
      manifestFound: true,
      manifestPath: manifestRel,
      risk: `Failed to read AndroidManifest.xml: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const cleartextMatch = /android:usesCleartextTraffic\s*=\s*["'](true|false)["']/i.exec(manifestContent);
  const usesCleartextTraffic = cleartextMatch ? cleartextMatch[1].toLowerCase() === "true" : null;

  const netConfigMatch = /android:networkSecurityConfig\s*=\s*["']@xml\/([^"']+)["']/i.exec(manifestContent);
  const netConfigXmlName = netConfigMatch ? netConfigMatch[1] : null;

  let networkSecurityConfigRel: string | undefined;
  let configAllowsLocalhost = false;

  if (netConfigXmlName) {
    const manifestDir = path.dirname(manifestFullPath);
    const xmlCandidates = [
      path.join(manifestDir, "res", "xml", `${netConfigXmlName}.xml`),
      path.join(projectRoot, "app", "src", "main", "res", "xml", `${netConfigXmlName}.xml`),
      path.join(projectRoot, "src", "main", "res", "xml", `${netConfigXmlName}.xml`),
    ];

    for (const xmlPath of xmlCandidates) {
      if (fs.existsSync(xmlPath)) {
        networkSecurityConfigRel = path.relative(projectRoot, xmlPath);
        try {
          const xmlContent = fs.readFileSync(xmlPath, "utf8");
          const baseConfigClear = /<base-config\b[^>]*cleartextTrafficPermitted\s*=\s*["']true["']/i.test(xmlContent);
          const domainConfigClear = /<domain-config\b[^>]*cleartextTrafficPermitted\s*=\s*["']true["'][\s\S]*?<\/domain-config>/gi;
          let domainAllowsLoopback = false;

          let match: RegExpExecArray | null;
          while ((match = domainConfigClear.exec(xmlContent)) !== null) {
            const block = match[0];
            if (/127\.0\.0\.1|10\.0\.2\.2|localhost/i.test(block)) {
              domainAllowsLoopback = true;
              break;
            }
          }

          configAllowsLocalhost = baseConfigClear || domainAllowsLoopback;
        } catch {
          configAllowsLocalhost = false;
        }
        break;
      }
    }
  }

  const cleartextPermitted = usesCleartextTraffic === true || configAllowsLocalhost;

  const remediation = [
    "To allow Context Tracker capture over HTTP on Android 9+ (API 28+):",
    "1. Add res/xml/network_security_config.xml:",
    "   <network-security-config>",
    '     <domain-config cleartextTrafficPermitted="true">',
    '       <domain includeSubdomains="true">127.0.0.1</domain>',
    '       <domain includeSubdomains="true">10.0.2.2</domain>',
    "     </domain-config>",
    "   </network-security-config>",
    "2. In AndroidManifest.xml inside <application ...> add:",
    '   android:networkSecurityConfig="@xml/network_security_config"',
    "   (or for debug builds: android:usesCleartextTraffic=\"true\")",
  ].join("\n");

  let risk: string | undefined;
  if (!cleartextPermitted) {
    risk = "Android 9+ (API 28+) blocks cleartext HTTP by default. Outbound requests to port 47321 will fail with java.io.IOException: Cleartext HTTP traffic not permitted unless permitted in network_security_config.xml or usesCleartextTraffic='true'.";
  }

  return {
    cleartextPermitted,
    manifestFound: true,
    manifestPath: manifestRel,
    usesCleartextTraffic,
    networkSecurityConfigPath: networkSecurityConfigRel,
    configAllowsLocalhost,
    risk,
    remediation: !cleartextPermitted ? remediation : undefined,
  };
}

export function isAndroidProject(projectRoot: string): boolean {
  if (
    fs.existsSync(path.join(projectRoot, "build.gradle")) ||
    fs.existsSync(path.join(projectRoot, "build.gradle.kts")) ||
    fs.existsSync(path.join(projectRoot, "settings.gradle")) ||
    fs.existsSync(path.join(projectRoot, "settings.gradle.kts")) ||
    fs.existsSync(path.join(projectRoot, "app", "build.gradle")) ||
    fs.existsSync(path.join(projectRoot, "app", "build.gradle.kts")) ||
    Boolean(findManifestFile(projectRoot))
  ) {
    return true;
  }
  return false;
}

export function findLatestBuildArtifact(projectRoot: string): { artifactPath: string; mtimeMs: number } | null {
  const searchDirs = [
    path.join(projectRoot, "app", "build", "outputs", "apk"),
    path.join(projectRoot, "build", "outputs", "apk"),
    path.join(projectRoot, "app", "build", "intermediates"),
    path.join(projectRoot, "build", "intermediates"),
  ];

  let latest: { artifactPath: string; mtimeMs: number } | null = null;

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "cache" && entry.name !== "transforms") {
            stack.push(fullPath);
          }
        } else if (entry.isFile()) {
          const isApk = entry.name.endsWith(".apk");
          const isClassOrJar = entry.name.endsWith(".class") || entry.name.endsWith(".jar");
          if (isApk || isClassOrJar) {
            try {
              const stat = fs.statSync(fullPath);
              if (!latest || (isApk && !latest.artifactPath.endsWith(".apk")) || stat.mtimeMs > latest.mtimeMs) {
                latest = { artifactPath: fullPath, mtimeMs: stat.mtimeMs };
              }
            } catch {
              // ignore
            }
          }
        }
      }
    }
  }

  return latest;
}

export function checkAndroidBuildState(
  projectRoot: string,
  sourceFilePath?: string,
): AndroidBuildStateResult {
  if (!isAndroidProject(projectRoot)) {
    return {
      isAndroidProject: false,
      hasBuildArtifacts: false,
      isStale: false,
      summary: "Not an Android project.",
    };
  }

  const latest = findLatestBuildArtifact(projectRoot);
  let sourceMtime: number | undefined;

  if (sourceFilePath && fs.existsSync(sourceFilePath)) {
    try {
      sourceMtime = fs.statSync(sourceFilePath).mtimeMs;
    } catch {
      // ignore
    }
  }

  if (!latest) {
    return {
      isAndroidProject: true,
      hasBuildArtifacts: false,
      sourceMtime,
      isStale: true,
      summary: "No build artifacts (APK/classes) found in app/build/. Build and run the app from Android Studio.",
    };
  }

  const relArtifact = path.relative(projectRoot, latest.artifactPath);
  const isStale = sourceMtime !== undefined && sourceMtime > latest.mtimeMs;

  let summary = "";
  if (isStale) {
    summary = `Build artifact ${path.basename(relArtifact)} is older than modified source file. Run the app in Android Studio to rebuild with the new capture endpoint.`;
  } else {
    summary = `Build artifact ${path.basename(relArtifact)} is up to date with source files.`;
  }

  return {
    isAndroidProject: true,
    hasBuildArtifacts: true,
    latestArtifactPath: relArtifact,
    latestArtifactMtime: latest.mtimeMs,
    sourceMtime,
    isStale,
    summary,
  };
}

export async function diagnoseAndroidConnection(options: {
  projectRoot: string;
  sourceFilePath?: string;
  devicePort?: number;
  hostPort?: number;
  adbPath?: string;
  runner?: ExecRunner;
}): Promise<{
  isAndroid: boolean;
  env: AndroidEnvironment;
  security: AndroidSecurityResult;
  buildState: AndroidBuildStateResult;
  repairedBridge?: AndroidBridgeResult;
  issues: string[];
  remedies: string[];
}> {
  const isAndroid = isAndroidProject(options.projectRoot);
  const env = await detectAndroidEnvironment({
    adbPath: options.adbPath,
    runner: options.runner,
  });
  const security = inspectAndroidSecurity(options.projectRoot);
  const buildState = checkAndroidBuildState(options.projectRoot, options.sourceFilePath);

  const issues: string[] = [];
  const remedies: string[] = [];

  if (isAndroid) {
    if (!security.cleartextPermitted) {
      issues.push("Android cleartext HTTP traffic is blocked by default.");
      remedies.push("Add network_security_config.xml permitting 127.0.0.1 or set android:usesCleartextTraffic='true' in AndroidManifest.xml.");
    }

    if (buildState.isStale) {
      issues.push(buildState.summary);
      remedies.push("Trigger 'Run' or 'Rebuild Project' in Android Studio to install the updated APK.");
    }

    if (!env.available) {
      issues.push("ADB command was not found on this machine.");
      remedies.push("Ensure Android SDK platform-tools is in PATH, or route an emulator to http://10.0.2.2:47321.");
    } else {
      const activeDevices = env.devices.filter((d) => d.state === "device");
      if (activeDevices.length === 0) {
        issues.push("No active Android devices or emulators are connected via ADB.");
        remedies.push("Connect your Android phone via USB with USB debugging enabled, or launch an emulator.");
      }
    }
  }

  let repairedBridge: AndroidBridgeResult | undefined;
  if (env.available && env.devices.some((d) => d.state === "device")) {
    const bridgeRes = await bridgeAndroidDevice({
      adbPath: options.adbPath,
      devicePort: options.devicePort ?? DEFAULT_RECORDER_PORT,
      hostPort: options.hostPort ?? DEFAULT_RECORDER_PORT,
      runner: options.runner,
    });
    if (bridgeRes.success) {
      repairedBridge = bridgeRes;
    }
  }

  return {
    isAndroid,
    env,
    security,
    buildState,
    repairedBridge,
    issues,
    remedies,
  };
}

