import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { isSecretFile } from "./redact";

const BLOCKED_HOME_DIRS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker", ".npm", ".cursor"]);

export function resolvePath(value: string): string {
  return path.resolve(value);
}

export function projectKey(projectPath: string): string {
  return crypto.createHash("sha256").update(resolvePath(projectPath)).digest("hex").slice(0, 16);
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(resolvePath(root), resolvePath(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveProjectFile(root: string, file: string): string | null {
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  if (!isInside(root, absolute)) {
    return null;
  }
  return existingFile(absolute);
}

export function isRewritablePath(projectPath: string, filePath: string): boolean {
  const absolute = path.resolve(filePath);
  if (isInside(projectPath, absolute)) {
    return true;
  }
  return isHomeConfigPath(absolute);
}

export function expandHomeDir(filepath: string): string {
  const home = os.homedir();
  if (filepath.startsWith(`~${path.sep}`) || filepath === "~") {
    return path.join(home, filepath.slice(1));
  }
  if (filepath.startsWith("~/")) {
    return path.join(home, filepath.slice(2));
  }
  return filepath;
}

export function resolveAddressFile(root: string, file: string): string | null {
  const expanded = expandHomeDir(file.trim());
  const absolute = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
  if (isInside(root, absolute)) {
    return existingFile(absolute);
  }
  if (!isHomeConfigPath(absolute)) {
    return null;
  }
  return existingFile(absolute);
}

function existingFile(absolute: string): string | null {
  try {
    if (!fs.statSync(absolute).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return absolute;
}

export function isHomeConfigPath(absolute: string): boolean {
  const appData = process.env.APPDATA ? path.resolve(process.env.APPDATA) : null;
  if (appData && isInside(appData, absolute) && !isSecretFile(absolute)) {
    return true;
  }
  const home = path.resolve(os.homedir());
  if (!isInside(home, absolute) || isSecretFile(absolute)) {
    return false;
  }
  const parts = path.relative(home, absolute).split(path.sep);
  if (BLOCKED_HOME_DIRS.has(parts[0])) {
    return false;
  }
  return !(parts[0] === ".config" && (parts[1] === "Cursor" || parts[1] === "Code"));
}

export function toRelative(root: string, file: string): string {
  const relative = path.relative(resolvePath(root), file);
  return relative.split(path.sep).join("/");
}
