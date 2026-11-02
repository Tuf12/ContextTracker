import * as fs from "node:fs";
import * as path from "node:path";
import { redactText } from "./redact";
import { CATEGORY_LABELS, estimateTokens, extractContextSections } from "./telemetry";
import type {
  CachedAttribution,
  CaptureTelemetry,
  CaptureView,
  CodeTemplateInspectionResult,
  ContextQueryResult,
  ContextSection,
  ContextSectionCategory,
  ContextSectionMatch,
  ContextSectionReadResult,
  DiffCapturesResult,
  PromptMessage,
  ReportedSpan,
  StoredCapture,
  TemplatePatchProposal,
  ViewMessage,
} from "./types";
import type { HelperTool } from "./harness";

export type CaptureInput = {
  id?: string;
  messages: Array<{ role: string; content?: string; spans?: Array<{ text: string }> }>;
  reported?: ReportedSpan[];
  telemetry?: CaptureTelemetry;
  sections?: ContextSection[];
};

export type SearchContextOptions = {
  capture: CaptureInput;
  query: string;
  sectionId?: string;
  caseSensitive?: boolean;
};

export type ReadContextSectionOptions = {
  capture: CaptureInput;
  sectionId: string;
  startLine?: number;
  maxLines?: number;
};

export type InspectCodeTemplateOptions = {
  capture: CaptureInput;
  sectionId: string;
  projectPath?: string;
  attributions?: CachedAttribution[];
  fsImpl?: {
    readFile?: (path: string, enc: "utf8") => Promise<string>;
    existsSync?: (path: string) => boolean;
  };
};

export type ProposeTemplatePatchOptions = {
  file: string;
  startLine: number;
  endLine: number;
  originalCode: string;
  replacementCode: string;
  explanation: string;
  tokenImpactEstimate?: string;
  projectPath?: string;
  fsImpl?: {
    existsSync?: (path: string) => boolean;
    readFile?: (path: string, enc: "utf8") => Promise<string>;
  };
};

function getMessageText(msg: { content?: string; spans?: Array<{ text: string }> }): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.spans)) {
    return msg.spans.map((s) => s.text).join("");
  }
  return "";
}

export function normalizeMessages(capture: CaptureInput): PromptMessage[] {
  return (capture.messages || []).map((m) => ({
    role: m.role || "user",
    content: getMessageText(m),
    truncated: Boolean((m as any).truncated),
  }));
}

export function getOrExtractSections(capture: CaptureInput): ContextSection[] {
  if (capture.sections && capture.sections.length > 0) {
    return capture.sections;
  }
  const normalized = normalizeMessages(capture);
  return extractContextSections(normalized);
}

/**
 * Finds a context section by exact ID, prefix alias, or section number.
 */
export function findSectionById(
  sections: ContextSection[],
  idOrAlias: string | undefined,
): ContextSection | undefined {
  if (!idOrAlias) return undefined;
  const raw = idOrAlias.trim();
  const lower = raw.toLowerCase();

  // 1. Exact or case-insensitive match
  const exact = sections.find((s) => s.sectionId === raw || s.sectionId.toLowerCase() === lower);
  if (exact) return exact;

  // 2. Direct prefix check: msg-<id> or history-<id>
  const prefix = sections.find((s) => s.sectionId === `msg-${raw}` || s.sectionId === `history-${raw}`);
  if (prefix) return prefix;

  // 3. Tool name match: e.g. "search_semantic", "describe_image"
  const byTool = sections.find((s) => s.toolName && (s.toolName.toLowerCase() === lower || s.toolName === raw));
  if (byTool) return byTool;

  // 4. Heading match: e.g. "OptimalX app model", "Note edit routing"
  const byHeading = sections.find((s) => s.heading && s.heading.toLowerCase().includes(lower));
  if (byHeading) return byHeading;

  // 5. Sub-id prefix match (e.g. "msg-1" matching "msg-1-tool-0-...")
  const bySubId = sections.find((s) => s.sectionId.startsWith(`msg-${raw}-`) || s.sectionId.startsWith(`${raw}-`));
  if (bySubId) return bySubId;

  // 3. sec_N, sec-N, section N alias (e.g. sec_0 -> msg-0, or 1-based Section #N)
  const secMatch = lower.match(/^(?:sec|section)[_ -]?(\d+)$/);
  if (secMatch) {
    const num = parseInt(secMatch[1], 10);
    // Check msg-<num> or history-<num>
    const byMsg = sections.find((s) => s.sectionId === `msg-${num}` || s.sectionId === `history-${num}`);
    if (byMsg) return byMsg;
    // Check 1-based index (Section #1 -> sections[0])
    if (num >= 1 && num <= sections.length) {
      return sections[num - 1];
    }
    // Check 0-based index
    if (num >= 0 && num < sections.length) {
      return sections[num];
    }
  }

  // 4. Bare number: "0" or "1"
  if (/^\d+$/.test(raw)) {
    const num = parseInt(raw, 10);
    const byMsg = sections.find((s) => s.sectionId === `msg-${num}` || s.sectionId === `history-${num}`);
    if (byMsg) return byMsg;
    if (num >= 0 && num < sections.length) {
      return sections[num];
    }
  }

  return undefined;
}

function resolveSectionCategory(
  sec: ContextSection,
  telemetry?: CaptureTelemetry,
): ContextSectionCategory {
  if (telemetry?.sections) {
    const matched = telemetry.sections.find(
      (s) => s.sectionId === sec.sectionId || s.messageIndex === sec.messageIndex,
    );
    if (matched) {
      return matched.category;
    }
  }
  return sec.heuristicCategory || "runtime_data";
}

/**
 * Fast search over prompt context sections and messages.
 */
export function searchContext(options: SearchContextOptions): ContextQueryResult {
  const query = options.query?.trim();
  if (!query) {
    return { matchesCount: 0, matches: [] };
  }

  const sections = getOrExtractSections(options.capture);
  const targetSections = options.sectionId
    ? (() => {
        const found = findSectionById(sections, options.sectionId);
        return found ? [found] : [];
      })()
    : sections;

  const matches: ContextSectionMatch[] = [];
  const maxMatches = 50;
  let totalMatches = 0;
  const isRegex = query.startsWith("/") && query.lastIndexOf("/") > 0;
  let matcher: (line: string) => boolean;

  if (isRegex) {
    try {
      const lastSlash = query.lastIndexOf("/");
      const pattern = query.slice(1, lastSlash);
      const flags = query.slice(lastSlash + 1) || (options.caseSensitive ? "" : "i");
      const rx = new RegExp(pattern, flags);
      matcher = (line: string) => rx.test(line);
    } catch {
      const needle = options.caseSensitive ? query : query.toLowerCase();
      matcher = (line: string) =>
        options.caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle);
    }
  } else {
    const needle = options.caseSensitive ? query : query.toLowerCase();
    matcher = (line: string) =>
      options.caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle);
  }

  for (const sec of targetSections) {
    const category = resolveSectionCategory(sec, options.capture.telemetry);
    const lines = sec.content.split("\n");
    let currentOffset = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (matcher(line)) {
        totalMatches += 1;
        if (matches.length < maxMatches) {
          const snippet = redactText(line.trim().slice(0, 200));
          matches.push({
            sectionId: sec.sectionId,
            messageIndex: sec.messageIndex,
            category,
            line: i + 1,
            snippet,
            charOffset: currentOffset,
          });
        }
      }
      currentOffset += line.length + 1;
    }
  }

  return {
    matchesCount: totalMatches,
    matches,
  };
}

/**
 * Paged verbatim reader for a prompt context section.
 */
export function readContextSection(options: ReadContextSectionOptions): ContextSectionReadResult {
  const sections = getOrExtractSections(options.capture);
  const targetId = options.sectionId?.trim();
  const sec = findSectionById(sections, targetId);

  if (!sec) {
    const available = sections.map((s) => s.sectionId).join(", ");
    throw new Error(
      `Section '${targetId}' was not found in the current prompt context. Available sections: [${available}]`,
    );
  }

  const category = resolveSectionCategory(sec, options.capture.telemetry);
  const lines = sec.content.split("\n");
  const totalLines = Math.max(1, lines.length);
  const startLine = Math.max(1, Math.min(options.startLine ?? 1, totalLines));
  const maxLines = Math.max(1, Math.min(options.maxLines ?? 100, 300));
  const endLine = Math.min(startLine + maxLines - 1, totalLines);

  const sliced = lines.slice(startLine - 1, endLine);
  const content = redactText(sliced.join("\n"));

  return {
    sectionId: sec.sectionId,
    role: sec.role,
    category,
    totalLines,
    startLine,
    endLine,
    tokens: estimateTokens(content),
    content,
  };
}

/**
 * Connects a context section back to the source template via Loop 4 attribution.
 */
export async function inspectCodeTemplate(
  options: InspectCodeTemplateOptions,
): Promise<CodeTemplateInspectionResult> {
  const sections = getOrExtractSections(options.capture);
  const targetId = options.sectionId?.trim();
  const sec = findSectionById(sections, targetId);

  if (!sec) {
    return {
      attributed: false,
      explanation: `Section '${targetId}' was not found in the context window.`,
    };
  }

  // 1. Check reported spans on capture
  let matchedSpan: ReportedSpan | undefined;
  if (options.capture.reported) {
    matchedSpan = options.capture.reported.find((span) => {
      if (span.messageIndex !== undefined && sec.messageIndices.includes(span.messageIndex)) {
        return Boolean(span.file && span.startLine);
      }
      return false;
    });
  }

  // 2. Check cached attributions
  let matchedAttr: CachedAttribution | undefined;
  if (!matchedSpan && options.attributions && options.attributions.length > 0) {
    matchedAttr = options.attributions.find((attr) => {
      if (attr.fingerprint && attr.fingerprint === sec.fingerprint) {
        return true;
      }
      if (attr.invariantPrefix && sec.content.includes(attr.invariantPrefix)) {
        return true;
      }
      if (attr.quote && sec.content.includes(attr.quote)) {
        return true;
      }
      return false;
    });
  }

  const file = matchedSpan?.file || matchedAttr?.file;
  const startLine = matchedSpan?.startLine || matchedAttr?.startLine;
  const endLine = matchedSpan?.endLine || matchedAttr?.endLine || startLine;
  const explanation =
    matchedSpan?.explanation || matchedAttr?.explanation || "Attributed from source template in project.";

  if (!file || !startLine) {
    return {
      attributed: false,
      explanation:
        "This section has not yet been attributed to a source template in the codebase. Use '✨ Attribute prompt' or Loop 4 to reverse-engineer its source location.",
    };
  }

  // Infer template type
  const ext = path.extname(file).toLowerCase();
  let templateType = "source_code";
  if (ext === ".jinja" || ext === ".jinja2" || ext === ".j2") {
    templateType = "jinja2";
  } else if (ext === ".prompt") {
    templateType = "prompt_file";
  } else if (ext === ".py") {
    templateType = "python_fstring";
  } else if (ext === ".ts" || ext === ".js") {
    templateType = "template_literal";
  } else if (ext === ".json") {
    templateType = "json_template";
  } else if (ext === ".yaml" || ext === ".yml") {
    templateType = "yaml_template";
  }

  // Read template source if file exists in workspace
  let templateSource: string | undefined;
  const runtimeInterpolations: Array<{ variable: string; value?: string; count?: number }> = [];

  if (options.projectPath) {
    const fullPath = path.resolve(options.projectPath, file);
    const readFile = options.fsImpl?.readFile ?? ((p) => fs.promises.readFile(p, "utf8"));
    const existsSync = options.fsImpl?.existsSync ?? fs.existsSync;

    if (existsSync(fullPath)) {
      try {
        const text = await readFile(fullPath, "utf8");
        const lines = text.split("\n");
        const actualStart = Math.max(1, startLine);
        const actualEnd = Math.min(lines.length, endLine || startLine);
        const snippet = lines.slice(actualStart - 1, actualEnd).join("\n");
        templateSource = redactText(snippet);

        // Detect dynamic variable slots: {{ var }}, {var}, $var
        const varMatches = new Set<string>();
        const jinjaRx = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
        let m: RegExpExecArray | null;
        while ((m = jinjaRx.exec(snippet)) !== null) {
          varMatches.add(m[1]);
        }
        const pyRx = /\{([a-zA-Z0-9_]+)\}/g;
        while ((m = pyRx.exec(snippet)) !== null) {
          varMatches.add(m[1]);
        }
        for (const v of varMatches) {
          runtimeInterpolations.push({ variable: v });
        }
      } catch {
        // file reading error ignored
      }
    }
  }

  return {
    attributed: true,
    file,
    startLine,
    endLine,
    templateType,
    templateSource,
    runtimeInterpolations: runtimeInterpolations.length > 0 ? runtimeInterpolations : undefined,
    explanation,
  };
}

/**
 * Formats a clean unified diff preview for patch proposals.
 */
export function generateDiffPreview(
  file: string,
  startLine: number,
  originalCode: string,
  replacementCode: string,
): string {
  const origLines = originalCode.split("\n");
  const newLines = replacementCode.split("\n");
  const header = `--- a/${file}\n+++ b/${file}\n@@ -${startLine},${origLines.length} +${startLine},${newLines.length} @@`;
  const removed = origLines.map((l) => `-${l}`).join("\n");
  const added = newLines.map((l) => `+${l}`).join("\n");
  return `${header}\n${removed}\n${added}`;
}

/**
 * Validates and constructs a proposed template patch.
 */
export async function proposeTemplatePatch(
  options: ProposeTemplatePatchOptions,
): Promise<TemplatePatchProposal> {
  const file = options.file?.trim();
  if (!file) {
    throw new Error("File path is required for template patch proposal.");
  }
  if (path.isAbsolute(file) || file.startsWith("..") || file.includes("/../")) {
    throw new Error("Template patch file must be a relative path within the workspace root.");
  }

  const startLine = Math.max(1, options.startLine || 1);
  const endLine = Math.max(startLine, options.endLine || startLine);
  const originalCode = options.originalCode ?? "";
  const replacementCode = options.replacementCode ?? "";
  const explanation = options.explanation?.trim() || "Proposed template optimization.";
  const tokenImpactEstimate = options.tokenImpactEstimate?.trim() || "neutral";

  // Verify file existence if projectPath given
  if (options.projectPath) {
    const fullPath = path.resolve(options.projectPath, file);
    const existsSync = options.fsImpl?.existsSync ?? fs.existsSync;
    if (!existsSync(fullPath)) {
      throw new Error(`File '${file}' does not exist in the project workspace.`);
    }
  }

  const diffPreview = generateDiffPreview(file, startLine, originalCode, replacementCode);
  const patchId = `patch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  return {
    patchId,
    status: "ready_for_user_approval",
    file,
    startLine,
    endLine,
    originalCode,
    replacementCode,
    explanation,
    tokenImpactEstimate,
    diffPreview,
  };
}

/**
 * Validates whether the document content matches the patch's originalCode at the specified lines.
 * Normalizes line endings (\r\n vs \n) and trailing whitespace to prevent false rejection.
 */
export function validateTemplatePatchContent(
  fileContent: string,
  startLine: number,
  endLine: number,
  expectedOriginalCode: string,
): { valid: boolean; actualSnippet?: string; error?: string } {
  const lines = fileContent.split(/\r?\n/);
  const actualStart = Math.max(1, startLine);
  const actualEnd = Math.min(lines.length, Math.max(actualStart, endLine));

  if (actualStart > lines.length) {
    return {
      valid: false,
      error: `Start line ${startLine} is beyond the end of the file (${lines.length} lines).`,
    };
  }

  const actualSnippet = lines.slice(actualStart - 1, actualEnd).join("\n");
  const normActual = actualSnippet.replace(/\r\n/g, "\n").trim();
  const normExpected = (expectedOriginalCode || "").replace(/\r\n/g, "\n").trim();

  if (normActual !== normExpected) {
    return {
      valid: false,
      actualSnippet,
      error: `File content at lines ${startLine}-${endLine} has changed since the patch was generated. Expected:\n"""\n${expectedOriginalCode}\n"""\nFound:\n"""\n${actualSnippet}\n"""`,
    };
  }

  return { valid: true, actualSnippet };
}

/**
 * Computes structural differences, token deltas, and prompt divergences between two captures.
 */
export function diffCaptures(primary: CaptureInput, compare: CaptureInput): DiffCapturesResult {
  const pSections = getOrExtractSections(primary);
  const cSections = getOrExtractSections(compare);

  const pTokens = pSections.reduce((sum, s) => sum + s.tokenEstimate, 0);
  const cTokens = cSections.reduce((sum, s) => sum + s.tokenEstimate, 0);

  const pModel = (primary as any).model || "primary";
  const cModel = (compare as any).model || "compare";

  const pStatus = (primary as any).status ?? null;
  const cStatus = (compare as any).status ?? null;
  const pError = (primary as any).error ?? null;
  const cError = (compare as any).error ?? null;

  const keyDivergences: string[] = [];

  if (pStatus !== cStatus || pError !== cError) {
    keyDivergences.push(
      `Status Divergence: Primary returned HTTP ${pStatus ?? "none"}${pError ? ` (${pError})` : ""}, whereas Compare returned HTTP ${cStatus ?? "none"}${cError ? ` (${cError})` : ""}.`,
    );
  }

  if (pModel !== cModel) {
    keyDivergences.push(`Model Divergence: Primary used '${pModel}' vs Compare used '${cModel}'.`);
  }

  const tokenDelta = pTokens - cTokens;
  if (Math.abs(tokenDelta) > 0) {
    const direction = tokenDelta > 0 ? "more" : "fewer";
    keyDivergences.push(`Token Delta: Primary prompt has ~${Math.abs(tokenDelta)} ${direction} tokens than Compare.`);
  }

  const allCats: ContextSectionCategory[] = [
    "system_instruction",
    "rag_grounding",
    "chat_history",
    "few_shot_exemplar",
    "schema_tool_spec",
    "user_query",
    "runtime_data",
  ];

  const categoryDivergence: DiffCapturesResult["categoryDivergence"] = [];

  for (const cat of allCats) {
    const pCatTokens = pSections
      .filter((s) => resolveSectionCategory(s, primary.telemetry) === cat)
      .reduce((sum, s) => sum + s.tokenEstimate, 0);
    const cCatTokens = cSections
      .filter((s) => resolveSectionCategory(s, compare.telemetry) === cat)
      .reduce((sum, s) => sum + s.tokenEstimate, 0);

    const delta = pCatTokens - cCatTokens;
    if (pCatTokens > 0 || cCatTokens > 0) {
      categoryDivergence.push({
        category: cat,
        categoryLabel: CATEGORY_LABELS[cat] || cat,
        primaryTokens: pCatTokens,
        compareTokens: cCatTokens,
        delta,
      });

      if (Math.abs(delta) > 20) {
        keyDivergences.push(
          `${CATEGORY_LABELS[cat] || cat} shifted by ${delta > 0 ? `+${delta}` : delta} tokens.`,
        );
      }
    }
  }

  // Check new/removed RAG sections
  const pRAG = pSections.some((s) => resolveSectionCategory(s, primary.telemetry) === "rag_grounding");
  const cRAG = cSections.some((s) => resolveSectionCategory(s, compare.telemetry) === "rag_grounding");
  if (pRAG && !cRAG) {
    keyDivergences.push("Primary capture contains RAG grounding documents that were absent in Compare.");
  } else if (!pRAG && cRAG) {
    keyDivergences.push("Compare capture contained RAG grounding documents that are absent in Primary.");
  }

  // Check chat history turn delta
  const pHist = pSections.find((s) => s.isCollapsedHistory);
  const cHist = cSections.find((s) => s.isCollapsedHistory);
  if (pHist || cHist) {
    const pTurns = pHist?.turns || 0;
    const cTurns = cHist?.turns || 0;
    if (pTurns !== cTurns) {
      keyDivergences.push(
        `Chat History Backlog: Primary has ${pTurns} conversational turn(s) vs Compare has ${cTurns} turn(s).`,
      );
    }
  }

  const pReply = typeof (primary as any).reply === "string" ? (primary as any).reply : "";
  const cReply = typeof (compare as any).reply === "string" ? (compare as any).reply : "";

  return {
    primaryId: primary.id || "primary",
    compareId: compare.id || "compare",
    primaryModel: pModel,
    compareModel: cModel,
    statusComparison: {
      primaryStatus: pStatus,
      compareStatus: cStatus,
      primaryError: pError,
      compareError: cError,
    },
    tokenComparison: {
      primaryTokens: pTokens,
      compareTokens: cTokens,
      delta: tokenDelta,
    },
    sectionComparison: {
      primaryCount: pSections.length,
      compareCount: cSections.length,
      delta: pSections.length - cSections.length,
    },
    categoryDivergence,
    keyDivergences: keyDivergences.length > 0 ? keyDivergences : ["No significant structural divergences found between captures."],
    replyComparison: (pReply || cReply) ? {
      primaryReplyPreview: redactText(pReply.slice(0, 300)),
      compareReplyPreview: redactText(cReply.slice(0, 300)),
    } : undefined,
  };
}

/**
 * Creates OpenAI Function tool descriptors and execution handlers for Context Interrogation.
 */
export function createContextTools(options: {
  capture: CaptureInput;
  compareCapture?: CaptureInput;
  projectPath?: string;
  attributions?: CachedAttribution[];
  fsImpl?: {
    existsSync?: (path: string) => boolean;
    readFile?: (path: string, enc: "utf8") => Promise<string>;
  };
  onPatchProposed?: (patch: TemplatePatchProposal) => void;
  finishOnPatch?: boolean;
}): HelperTool<TemplatePatchProposal | any>[] {
  const { capture, compareCapture, projectPath, attributions, fsImpl, onPatchProposed, finishOnPatch } = options;

  const tools: HelperTool<TemplatePatchProposal | any>[] = [
    {
      name: "search_context",
      description:
        "Search across prompt messages and context sections for specific keywords, variable names, instructions, or regex patterns.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text substring or regex pattern (e.g. '/pattern/i') to search for.",
          },
          sectionId: {
            type: "string",
            description: "Optional sectionId (e.g. 'sec_0', 'msg-1') to restrict search to a single section.",
          },
          targetCapture: {
            type: "string",
            enum: ["primary", "compare", "both"],
            description: "Which capture to search when comparison capture is active. Defaults to 'primary'.",
          },
          caseSensitive: {
            type: "boolean",
            description: "Whether search is case-sensitive. Defaults to false.",
          },
        },
        required: ["query"],
      },
      run: (args: unknown) => {
        const query = args && typeof args === "object" && "query" in args ? String((args as any).query) : "";
        const sectionId =
          args && typeof args === "object" && "sectionId" in args ? String((args as any).sectionId) : undefined;
        const targetCapture =
          args && typeof args === "object" && "targetCapture" in args ? String((args as any).targetCapture) : "primary";
        const caseSensitive =
          args && typeof args === "object" && "caseSensitive" in args
            ? Boolean((args as any).caseSensitive)
            : false;

        if (targetCapture === "compare" && compareCapture) {
          const result = searchContext({
            capture: compareCapture,
            query,
            sectionId,
            caseSensitive,
          });
          return { content: JSON.stringify({ compareMatches: result }, null, 2) };
        }

        if (targetCapture === "both" && compareCapture) {
          const primaryResult = searchContext({
            capture,
            query,
            sectionId,
            caseSensitive,
          });
          const compareResult = searchContext({
            capture: compareCapture,
            query,
            sectionId,
            caseSensitive,
          });
          return {
            content: JSON.stringify({ primary: primaryResult, compare: compareResult }, null, 2),
          };
        }

        const result = searchContext({
          capture,
          query,
          sectionId,
          caseSensitive,
        });

        return { content: JSON.stringify(result, null, 2) };
      },
    },
    {
      name: "read_context_section",
      description:
        "Read verbatim lines from a specific context section (e.g. RAG grounding, system instruction, or chat history) without exceeding token limits.",
      parameters: {
        type: "object",
        properties: {
          sectionId: {
            type: "string",
            description: "The ID of the section to read (e.g. 'msg-0', 'history-1-3', 'msg-2-rag').",
          },
          startLine: {
            type: "number",
            description: "1-based line number to start reading from. Defaults to 1.",
          },
          maxLines: {
            type: "number",
            description: "Maximum lines to return. Defaults to 100, max 300.",
          },
        },
        required: ["sectionId"],
      },
      run: (args: unknown) => {
        try {
          const sectionId =
            args && typeof args === "object" && "sectionId" in args ? String((args as any).sectionId) : "";
          const startLine =
            args && typeof args === "object" && "startLine" in args ? Number((args as any).startLine) : 1;
          const maxLines =
            args && typeof args === "object" && "maxLines" in args ? Number((args as any).maxLines) : 100;

          const result = readContextSection({
            capture,
            sectionId,
            startLine,
            maxLines,
          });

          return { content: JSON.stringify(result, null, 2) };
        } catch (err) {
          return { content: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: "inspect_code_template",
      description:
        "Inspect the underlying source code template or prompt builder function in the developer's workspace that generated this context section.",
      parameters: {
        type: "object",
        properties: {
          sectionId: {
            type: "string",
            description: "The ID of the section to inspect in code.",
          },
        },
        required: ["sectionId"],
      },
      run: async (args: unknown) => {
        const sectionId =
          args && typeof args === "object" && "sectionId" in args ? String((args as any).sectionId) : "";

        const result = await inspectCodeTemplate({
          capture,
          sectionId,
          projectPath,
          attributions,
          fsImpl,
        });

        return { content: JSON.stringify(result, null, 2) };
      },
    },
    {
      name: "propose_template_patch",
      description:
        "Propose a concrete, actionable source code patch for a prompt template to fix contradictions, reduce prompt bloat, or optimize token usage.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Relative path to the workspace file being patched (e.g. 'prompts/analyst.prompt').",
          },
          startLine: {
            type: "number",
            description: "1-based start line of code being replaced.",
          },
          endLine: {
            type: "number",
            description: "1-based end line of code being replaced.",
          },
          originalCode: {
            type: "string",
            description: "Original code or prompt text being replaced.",
          },
          replacementCode: {
            type: "string",
            description: "New proposed code or prompt text.",
          },
          explanation: {
            type: "string",
            description: "Explanation of why this patch resolves the issue or optimizes tokens.",
          },
          tokenImpactEstimate: {
            type: "string",
            description: "Estimated token impact (e.g. '-350 tokens', 'neutral').",
          },
        },
        required: ["file", "startLine", "endLine", "originalCode", "replacementCode", "explanation"],
      },
      run: async (args: unknown) => {
        try {
          const a = (args && typeof args === "object" ? args : {}) as any;
          const patch = await proposeTemplatePatch({
            file: String(a.file || ""),
            startLine: Number(a.startLine || 1),
            endLine: Number(a.endLine || 1),
            originalCode: String(a.originalCode || ""),
            replacementCode: String(a.replacementCode || ""),
            explanation: String(a.explanation || ""),
            tokenImpactEstimate: a.tokenImpactEstimate ? String(a.tokenImpactEstimate) : undefined,
            projectPath,
            fsImpl,
          });

          onPatchProposed?.(patch);
          const shouldFinish = finishOnPatch ?? !onPatchProposed;

          return {
            content: `Template patch proposal created successfully for ${patch.file}:${patch.startLine}-${patch.endLine}.\n\nDiff preview:\n${patch.diffPreview}\n\nCRITICAL NEXT STEP: You must now explain to the user in conversational detail what was happening in their prompt context, why this issue occurred, alternative approaches they could take, and why this patch was proposed. Deliver your final response to the user via respond().`,
            finish: shouldFinish ? patch : undefined,
          };
        } catch (err) {
          return { content: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];

  if (compareCapture) {
    tools.push({
      name: "diff_captures",
      description:
        "Compare structural prompt anatomy, status, tokens, RAG context, and history turns between the primary capture and the comparison capture to identify regressions and divergences.",
      parameters: {
        type: "object",
        properties: {},
      },
      run: () => {
        const diff = diffCaptures(capture, compareCapture);
        return { content: JSON.stringify(diff, null, 2) };
      },
    });
  }

  return tools;
}
