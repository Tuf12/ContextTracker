import crypto from "crypto";
import fs from "fs";
import path from "path";

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
  try {
    if (!fs.statSync(absolute).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return absolute;
}

export function toRelative(root: string, file: string): string {
  const relative = path.relative(resolvePath(root), file);
  return relative.split(path.sep).join("/");
}
