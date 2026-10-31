const SECRET_FILE = /(^|\/)\.env(\.|$)|(^|\/)credentials\.json$|\.pem$/i;
const SECRET_KEY = /(api[_-]?key|access[_-]?key|token|secret|password|authorization|passwd)/i;

export function isSecretFile(filePath: string): boolean {
  return SECRET_FILE.test(filePath.replace(/\\/g, "/"));
}

export function redactText(text: string): string {
  return text.split(/\r?\n/).map(redactLine).join("\n");
}

function redactLine(line: string): string {
  const match = line.match(/^(\s*(?:export\s+)?)(["']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)(.*)$/);
  if (match && SECRET_KEY.test(match[3])) {
    return `${match[1]}${match[2]}${match[3]}${match[4]}[private]`;
  }
  if (/authorization/i.test(line) && /:\s*\S/.test(line)) {
    return line.replace(/:\s*\S.*$/, ": [private]");
  }
  return line;
}
