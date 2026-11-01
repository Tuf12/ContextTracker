import path from "path";
import { locationsFor } from "./indexer";
import { isHomeConfigPath, isInside, resolveProjectFile, toRelative } from "./paths";
import type { ProjectIndex, ReportedSpan, SpanSource, ViewSpan } from "./types";

type LineSlice = { text: string; start: number; end: number };
type Hit = { file: string; line: number };

type FileSpan = {
  charStart: number;
  charEnd: number;
  file: string;
  absolutePath?: string;
  startLine: number;
  endLine: number;
  source: SpanSource;
  confidence?: number;
  explanation?: string;
};

const SINGLE_LINE_MIN = 48;
const LEFTOVER_MIN = 20;

export function deriveMessageSpans(
  content: string,
  role: string,
  index: ProjectIndex | null,
  reported: ReportedSpan[],
): ViewSpan[] {
  const fileSpans = index
    ? combineSpans(
        placeReported(content, reported, index),
        role === "tools" ? matchTools(content, index) : matchContent(content, index),
      )
    : placeReported(content, reported, index);
  return toViewSpans(content, role, fileSpans, index);
}

function placeReported(content: string, reported: ReportedSpan[], index: ProjectIndex | null): FileSpan[] {
  const spans: FileSpan[] = [];
  const used: { start: number; end: number }[] = [];
  for (const item of reported) {
    const placed = placeOne(content, item, used, index);
    if (!placed) {
      continue;
    }
    spans.push(placed);
    used.push({ start: placed.charStart, end: placed.charEnd });
  }
  return spans;
}

function placeOne(
  content: string,
  item: ReportedSpan,
  used: { start: number; end: number }[],
  index: ProjectIndex | null,
): FileSpan | null {
  const root = index?.root ?? "";
  const absolute = root ? resolveProjectFile(root, item.file) : null;
  const file = absolute && root ? toRelative(root, absolute) : item.file.replace(/\\/g, "/");
  const startLine = positiveInt(item.startLine);
  const endLine = positiveInt(item.endLine);
  if (!startLine || !endLine || endLine < startLine) {
    return null;
  }

  let charStart: number | null = null;
  let charEnd: number | null = null;
  if (item.quote && item.quote.length > 0) {
    let from = 0;
    while (from <= content.length) {
      const at = content.indexOf(item.quote, from);
      if (at < 0) {
        break;
      }
      const interval = { start: at, end: at + item.quote.length };
      if (!used.some((entry) => overlaps(entry, interval))) {
        charStart = interval.start;
        charEnd = interval.end;
        break;
      }
      from = at + 1;
    }
  } else if (isFiniteNumber(item.charStart) && isFiniteNumber(item.charEnd)) {
    charStart = clamp(item.charStart, 0, content.length);
    charEnd = clamp(item.charEnd, 0, content.length);
  } else if (item.source === "attributed") {
    charStart = 0;
    charEnd = content.length;
  }
  if (charStart === null || charEnd === null || charEnd <= charStart) {
    if (item.source === "attributed" && content.trim().length > 0) {
      charStart = 0;
      charEnd = content.length;
    } else {
      return null;
    }
  }
  return {
    charStart,
    charEnd,
    file,
    absolutePath: absolute ?? undefined,
    startLine,
    endLine,
    source: item.source ?? "reported",
    confidence: item.confidence,
    explanation: item.explanation,
  };
}

function matchContent(content: string, index: ProjectIndex): FileSpan[] {
  const lines = splitLines(content);
  const chosen: (Hit | null)[] = lines.map(() => null);
  const keys = lines.map((line) => line.text.trim());
  const candidates = keys.map((key) => (key.length >= 20 ? locationsFor(index, key) : []));

  for (let i = 0; i < lines.length; i++) {
    if (chosen[i] || candidates[i].length === 0) {
      continue;
    }
    let best: { hit: Hit; score: number } | null = null;
    let tie = false;
    for (const hit of candidates[i]) {
      let score = 1;
      let expect = hit.line + 1;
      for (let j = i + 1; j < lines.length; j++) {
        const next = candidates[j].find((candidate) => candidate.file === hit.file && candidate.line === expect);
        if (!next) {
          break;
        }
        score += 1;
        expect += 1;
      }
      if (!best || score > best.score) {
        best = { hit, score };
        tie = false;
      } else if (score === best.score && best.hit.file !== hit.file) {
        tie = true;
      }
    }
    if (!best) {
      continue;
    }
    const uniqueSingle = candidates[i].length === 1 && keys[i].length >= SINGLE_LINE_MIN;
    const uniqueRun = !tie && best.score >= 2;
    if (!uniqueSingle && !uniqueRun) {
      continue;
    }
    let expect = best.hit.line;
    for (let j = i; j < lines.length; j++) {
      const next = candidates[j].find((candidate) => candidate.file === best?.hit.file && candidate.line === expect);
      if (!next) {
        break;
      }
      chosen[j] = next;
      expect += 1;
    }
  }

  extendChosen(chosen, lines, index);
  return coalesce(chosen, lines);
}

function extendChosen(chosen: (Hit | null)[], lines: LineSlice[], index: ProjectIndex): void {
  for (let i = 0; i < chosen.length; i++) {
    const hit = chosen[i];
    if (!hit) {
      continue;
    }
    let lineNo = hit.line + 1;
    for (let j = i + 1; j < chosen.length && !chosen[j]; j++) {
      const expected = fileLine(index, hit.file, lineNo);
      if (expected === undefined || lines[j].text.trim() !== expected) {
        break;
      }
      chosen[j] = { file: hit.file, line: lineNo };
      lineNo += 1;
    }
  }
  for (let i = chosen.length - 1; i >= 0; i--) {
    const hit = chosen[i];
    if (!hit) {
      continue;
    }
    let lineNo = hit.line - 1;
    for (let j = i - 1; j >= 0 && !chosen[j]; j--) {
      const expected = fileLine(index, hit.file, lineNo);
      if (expected === undefined || lines[j].text.trim() !== expected) {
        break;
      }
      chosen[j] = { file: hit.file, line: lineNo };
      lineNo -= 1;
    }
  }
}

function coalesce(chosen: (Hit | null)[], lines: LineSlice[]): FileSpan[] {
  const spans: FileSpan[] = [];
  let index = 0;
  while (index < chosen.length) {
    const hit = chosen[index];
    if (!hit) {
      index += 1;
      continue;
    }
    let end = index;
    let expect = hit.line;
    while (
      end + 1 < chosen.length &&
      chosen[end + 1] &&
      chosen[end + 1]?.file === hit.file &&
      chosen[end + 1]?.line === expect + 1
    ) {
      end += 1;
      expect += 1;
    }
    spans.push({
      charStart: lines[index].start,
      charEnd: lines[end].end,
      file: hit.file,
      startLine: hit.line,
      endLine: chosen[end]?.line ?? hit.line,
      source: "matched",
    });
    index = end + 1;
  }
  return spans;
}

function combineSpans(reported: FileSpan[], matched: FileSpan[]): FileSpan[] {
  const result: FileSpan[] = [];
  for (const match of matched) {
    const conflicts = reported.filter((span) => overlaps(match, span) && span.file !== match.file);
    if (conflicts.length === 0) {
      result.push(match);
      continue;
    }
    for (const piece of subtract(match, conflicts)) {
      result.push(piece);
    }
  }
  for (const span of reported) {
    const covered = result.some(
      (existing) => existing.file === span.file && existing.charStart <= span.charStart && existing.charEnd >= span.charEnd,
    );
    if (!covered) {
      result.push(span);
    }
  }
  return resolveOverlaps(result.filter((span) => span.charEnd - span.charStart > 0));
}

function subtract(span: FileSpan, blocks: FileSpan[]): FileSpan[] {
  let pieces = [{ start: span.charStart, end: span.charEnd }];
  for (const block of blocks) {
    const next: { start: number; end: number }[] = [];
    for (const piece of pieces) {
      if (block.charEnd <= piece.start || block.charStart >= piece.end) {
        next.push(piece);
        continue;
      }
      if (block.charStart > piece.start) {
        next.push({ start: piece.start, end: block.charStart });
      }
      if (block.charEnd < piece.end) {
        next.push({ start: block.charEnd, end: piece.end });
      }
    }
    pieces = next;
  }
  return pieces
    .filter((piece) => piece.end - piece.start >= LEFTOVER_MIN)
    .map((piece) => ({ ...span, charStart: piece.start, charEnd: piece.end }));
}

function resolveOverlaps(spans: FileSpan[]): FileSpan[] {
  const sorted = [...spans].sort((a, b) => a.charStart - b.charStart || b.charEnd - a.charEnd);
  const out: FileSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (!last || span.charStart >= last.charEnd) {
      out.push(span);
      continue;
    }
    if (span.charEnd <= last.charEnd) {
      continue;
    }
    const trimmed = { ...span, charStart: last.charEnd };
    if (trimmed.charEnd - trimmed.charStart >= LEFTOVER_MIN) {
      out.push(trimmed);
    }
  }
  return out;
}

function toViewSpans(content: string, role: string, fileSpans: FileSpan[], index: ProjectIndex | null): ViewSpan[] {
  const sorted = [...fileSpans].sort((a, b) => a.charStart - b.charStart);
  const spans: ViewSpan[] = [];
  let cursor = 0;
  let count = 0;
  const pushGap = (start: number, end: number) => {
    if (content.slice(start, end).trim() === "") {
      return;
    }
    spans.push({
      id: `gap-${count}`,
      text: content.slice(start, end),
      kind: "runtime",
      label: gapLabel(role),
      canOpen: false,
    });
    count += 1;
  };
  for (const span of sorted) {
    if (span.charStart > cursor) {
      pushGap(cursor, span.charStart);
    }
    const absolute = span.absolutePath ?? (span.source === "matched" && index ? path.join(index.root, span.file) : undefined);
    const canOpen = Boolean(absolute && ((index && isInside(index.root, absolute)) || isHomeConfigPath(absolute)));
    spans.push({
      id: `file-${count}`,
      text: content.slice(span.charStart, span.charEnd),
      kind: "file",
      label: fileLabel(span),
      source: span.source,
      file: span.file,
      absolutePath: canOpen ? absolute : undefined,
      canOpen,
      startLine: span.startLine,
      endLine: span.endLine,
      confidence: span.confidence,
      explanation: span.explanation,
    });
    count += 1;
    cursor = Math.max(cursor, span.charEnd);
  }
  if (cursor < content.length) {
    pushGap(cursor, content.length);
  }
  if (spans.length === 0 && content.trim() !== "") {
    pushGap(0, content.length);
  }
  return spans;
}

function fileLabel(span: FileSpan): string {
  const lines = span.startLine === span.endLine ? `line ${span.startLine}` : `lines ${span.startLine}–${span.endLine}`;
  const how = span.source === "attributed"
    ? "Attributed by Meta AI"
    : span.source === "reported"
      ? "Marked by your app"
      : "Matched in the project";
  return `${span.file} · ${lines} · ${how}`;
}

export function gapLabel(role: string): string {
  if (role === "assistant") {
    return "Earlier model reply";
  }
  if (role === "tool") {
    return "Tool result";
  }
  if (role === "tools") {
    return "Tool definitions";
  }
  return "No matching file";
}

function fileLine(index: ProjectIndex, file: string, line: number): string | undefined {
  const lines = index.fileLines.get(file);
  if (!lines || line < 1) {
    return undefined;
  }
  return lines[line - 1];
}

function splitLines(content: string): LineSlice[] {
  const parts = content.split("\n");
  const lines: LineSlice[] = [];
  let start = 0;
  for (const part of parts) {
    const text = part.replace(/\r$/, "");
    lines.push({ text, start, end: start + text.length });
    start += part.length + 1;
  }
  return lines;
}

function overlaps(a: { charStart?: number; charEnd?: number; start: number; end: number } | { charStart: number; charEnd: number }, b: { charStart?: number; charEnd?: number; start?: number; end?: number }): boolean {
  const aStart = "charStart" in a && a.charStart !== undefined ? a.charStart : "start" in a ? a.start : 0;
  const aEnd = "charEnd" in a && a.charEnd !== undefined ? a.charEnd : "end" in a ? a.end : 0;
  const bStart = "charStart" in b && b.charStart !== undefined ? b.charStart : "start" in b && b.start !== undefined ? b.start : 0;
  const bEnd = "charEnd" in b && b.charEnd !== undefined ? b.charEnd : "end" in b && b.end !== undefined ? b.end : 0;
  return aStart < bEnd && bStart < aEnd;
}

function positiveInt(value: number): number | null {
  if (!isFiniteNumber(value) || value < 1 || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function matchTools(content: string, index: ProjectIndex): FileSpan[] {
  const spans: FileSpan[] = [];
  const regex = /\{\s*"type":\s*"function"[\s\S]*?"function":\s*\{[\s\S]*?"name":\s*"([^"]+)"[\s\S]*?\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const toolName = match[1];
    const charStart = match.index;
    const charEnd = match.index + match[0].length;
    const hit = findToolDefinition(toolName, index);
    if (hit) {
      spans.push({
        charStart,
        charEnd,
        file: hit.file,
        startLine: hit.line,
        endLine: hit.line,
        source: "matched",
      });
    }
  }
  return spans;
}

function findToolDefinition(name: string, index: ProjectIndex): Hit | null {
  const nameRegexes = [
    new RegExp(`\\b${name}\\s*:\\s*\\{`),
    new RegExp(`\\bfunction\\s+${name}\\b`),
    new RegExp(`\\bdef\\s+${name}\\b`),
    new RegExp(`["']name["']\\s*:\\s*["']${name}["']`),
    new RegExp(`\\bname\\s*:\\s*["']${name}["']`),
  ];
  let fallback: Hit | null = null;
  for (const [file, lines] of index.fileLines.entries()) {
    const lowerFile = file.toLowerCase();
    if (lowerFile.includes("test") || lowerFile.includes("spec") || lowerFile.endsWith(".md")) {
      continue;
    }
    const isPreferredFile = /tool|catalog|schema/.test(lowerFile);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (nameRegexes.some((regex) => regex.test(line))) {
        const hit = { file, line: idx + 1 };
        if (isPreferredFile) {
          return hit;
        }
        if (!fallback) {
          fallback = hit;
        }
      }
    }
  }
  return fallback;
}
