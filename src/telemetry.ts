import crypto from "crypto";
import { redactText } from "./redact";
import type {
  CaptureTelemetry,
  CategoryComposition,
  ContextSection,
  ContextSectionCategory,
  PromptMessage,
  SectionTelemetry,
} from "./types";

export const CATEGORY_LABELS: Record<ContextSectionCategory, string> = {
  system_instruction: "System Instruction",
  rag_grounding: "RAG Grounding",
  chat_history: "Chat History",
  few_shot_exemplar: "Few-Shot Exemplar",
  schema_tool_spec: "Tool Definitions",
  user_query: "User Query",
  runtime_data: "Runtime Data",
};

export const CATEGORY_COLORS: Record<ContextSectionCategory, string> = {
  system_instruction: "var(--vscode-charts-green, #4ade80)",
  rag_grounding: "var(--vscode-charts-purple, #b180d7)",
  chat_history: "var(--vscode-charts-orange, #fb923c)",
  few_shot_exemplar: "var(--vscode-charts-yellow, #facc15)",
  schema_tool_spec: "var(--vscode-charts-blue, #38bdf8)",
  user_query: "var(--vscode-charts-lines, #60a5fa)",
  runtime_data: "var(--vscode-descriptionForeground, #94a3b8)",
};

export function hashText(content: string): string {
  return crypto.createHash("sha256").update(content.trim()).digest("hex").slice(0, 16);
}

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.round(text.length / 4));
}

export function hasRagMarkers(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("reference documents:") ||
    lower.includes("retrieved context:") ||
    lower.includes("search results:") ||
    lower.includes("<context>") ||
    lower.includes("context:") ||
    lower.includes("sources:") ||
    /doc \d+:/i.test(lower) ||
    /document \d+:/i.test(lower)
  );
}

export function hasFewShotMarkers(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("few-shot:") ||
    lower.includes("examples:") ||
    lower.includes("example 1:") ||
    (lower.includes("input:") && lower.includes("output:"))
  );
}

export function classifyHeuristicCategory(
  role: string,
  content: string,
  isLastUser = false,
): ContextSectionCategory {
  if (role === "tools") {
    return "schema_tool_spec";
  }
  if (role === "tool") {
    return "runtime_data";
  }
  if (role === "system") {
    if (hasRagMarkers(content)) {
      return "rag_grounding";
    }
    if (hasFewShotMarkers(content)) {
      return "few_shot_exemplar";
    }
    return "system_instruction";
  }
  if (role === "user") {
    if (hasRagMarkers(content) && !isLastUser) {
      return "rag_grounding";
    }
    if (hasFewShotMarkers(content)) {
      return "few_shot_exemplar";
    }
    if (isLastUser) {
      return "user_query";
    }
    return "chat_history";
  }
  if (role === "assistant") {
    return "chat_history";
  }
  return "runtime_data";
}

export function splitRagUserQuery(content: string): { ragText: string; queryText: string } | null {
  const match = content.match(
    /^(.*?\b(?:context|reference documents?|retrieved context|sources?)\s*:\s*[\s\S]+?)\n\n+(?:user\s+question|question|task|instruction|query)\s*:\s*([\s\S]+)$/i,
  );
  if (match && match[1].trim().length > 40 && match[2].trim().length > 0) {
    return { ragText: match[1].trim(), queryText: match[2].trim() };
  }
  return null;
}

function truncatePreview(text: string, maxChars = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars) + "…";
}

export function extractContextSections(
  messages: PromptMessage[],
  options?: { collapseHistory?: boolean },
): ContextSection[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  const collapseHistory = options?.collapseHistory !== false;
  const sections: ContextSection[] = [];

  // Locate the index of the final user message (the active query)
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    // Check if this is the start of dialogue history turns that should be collapsed
    if (
      collapseHistory &&
      i < lastUserIndex &&
      (msg.role === "user" || msg.role === "assistant" || msg.role === "tool")
    ) {
      // Collect all contiguous history dialogue messages before lastUserIndex
      const historyIndices: number[] = [];
      let combinedTokens = 0;
      const turnPreviews: string[] = [];
      let userTurns = 0;

      while (
        i < lastUserIndex &&
        (messages[i].role === "user" || messages[i].role === "assistant" || messages[i].role === "tool")
      ) {
        historyIndices.push(i);
        const m = messages[i];
        combinedTokens += estimateTokens(m.content);
        if (m.role === "user") {
          userTurns += 1;
        }
        const roleName = m.role.charAt(0).toUpperCase() + m.role.slice(1);
        turnPreviews.push(`${roleName}: ${truncatePreview(m.content, 80)}`);
        i += 1;
      }

      if (historyIndices.length > 0) {
        const joinedContent = turnPreviews.join("\n");
        const turnsCount = Math.max(1, userTurns);
        sections.push({
          sectionId: `history-${historyIndices[0]}-${historyIndices[historyIndices.length - 1]}`,
          messageIndex: historyIndices[0],
          messageIndices: historyIndices,
          role: "chat_history",
          content: joinedContent,
          tokenEstimate: combinedTokens,
          fingerprint: hashText(joinedContent),
          heuristicCategory: "chat_history",
          isCollapsedHistory: true,
          turns: turnsCount,
          preview: truncatePreview(joinedContent, 200),
        });
        continue;
      }
    }

    // Handle the active user query at lastUserIndex
    if (i === lastUserIndex) {
      const split = splitRagUserQuery(msg.content);
      if (split) {
        // RAG grounding part
        const ragTokens = estimateTokens(split.ragText);
        sections.push({
          sectionId: `msg-${i}-rag`,
          messageIndex: i,
          messageIndices: [i],
          role: "user",
          content: split.ragText,
          tokenEstimate: ragTokens,
          fingerprint: hashText(split.ragText),
          heuristicCategory: "rag_grounding",
          preview: truncatePreview(split.ragText, 200),
        });

        // Direct user query part
        const queryTokens = estimateTokens(split.queryText);
        sections.push({
          sectionId: `msg-${i}-query`,
          messageIndex: i,
          messageIndices: [i],
          role: "user",
          content: split.queryText,
          tokenEstimate: queryTokens,
          fingerprint: hashText(split.queryText),
          heuristicCategory: "user_query",
          preview: truncatePreview(split.queryText, 200),
        });
        i += 1;
        continue;
      }

      // Single active query
      const tokens = estimateTokens(msg.content);
      sections.push({
        sectionId: `msg-${i}`,
        messageIndex: i,
        messageIndices: [i],
        role: msg.role,
        content: msg.content,
        tokenEstimate: tokens,
        fingerprint: hashText(msg.content),
        heuristicCategory: classifyHeuristicCategory(msg.role, msg.content, true),
        preview: truncatePreview(msg.content, 200),
      });
      i += 1;
      continue;
    }

    // Any other individual message (e.g. system, tools, trailing assistant reply)
    const tokens = estimateTokens(msg.content);
    sections.push({
      sectionId: `msg-${i}`,
      messageIndex: i,
      messageIndices: [i],
      role: msg.role,
      content: msg.content,
      tokenEstimate: tokens,
      fingerprint: hashText(msg.content),
      heuristicCategory: classifyHeuristicCategory(msg.role, msg.content, false),
      preview: truncatePreview(msg.content, 200),
    });
    i += 1;
  }

  return sections;
}

export class TelemetryCache {
  private map = new Map<string, SectionTelemetry>();
  private maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  get(fingerprint: string): SectionTelemetry | undefined {
    const entry = this.map.get(fingerprint);
    if (entry) {
      this.map.delete(fingerprint);
      this.map.set(fingerprint, entry);
    }
    return entry;
  }

  set(fingerprint: string, telemetry: SectionTelemetry): void {
    if (this.map.has(fingerprint)) {
      this.map.delete(fingerprint);
    } else if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(fingerprint, telemetry);
  }

  has(fingerprint: string): boolean {
    return this.map.has(fingerprint);
  }

  delete(fingerprint: string): boolean {
    return this.map.delete(fingerprint);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export const globalTelemetryCache = new TelemetryCache(200);

export function generateFallbackSectionTelemetry(
  section: ContextSection,
  totalTokens: number,
): SectionTelemetry {
  const tokenPercentage = totalTokens > 0 ? Math.round((section.tokenEstimate / totalTokens) * 100) : 0;
  let what = "";
  let why = "";
  let warning: string | undefined;

  switch (section.heuristicCategory) {
    case "system_instruction":
      what = "System Guidelines & Persona Specification";
      why = "Defines assistant persona, behavior rules, and response constraints.";
      break;
    case "rag_grounding":
      what = "Retrieved Context & Grounding Documents";
      why = "Supplies external reference knowledge to ground answers and prevent hallucination.";
      break;
    case "chat_history": {
      const turns = section.turns ?? 1;
      what = `Prior Dialogue Backlog (${turns} turn${turns > 1 ? "s" : ""})`;
      why = "Maintains conversational memory for multi-turn reference resolution.";
      if (tokenPercentage >= 40) {
        warning = `Dialogue backlog consumes ${tokenPercentage}% of prompt tokens; consider pruning older turns.`;
      }
      break;
    }
    case "few_shot_exemplar":
      what = "In-Context Few-Shot Demonstrations";
      why = "Guides output formatting and reasoning pattern by example.";
      break;
    case "schema_tool_spec":
      what = "Tool & Function Calling Schemas";
      why = "Provides tool definitions so the model can invoke external capabilities.";
      break;
    case "user_query":
      what = "Active User Prompt";
      why = "Direct instruction for the current completion task.";
      break;
    case "runtime_data":
      what = "Dynamic Runtime State / Tool Results";
      why = "Supplies runtime execution output needed for continued reasoning.";
      break;
  }

  return {
    sectionId: section.sectionId,
    messageIndex: section.messageIndex,
    messageIndices: section.messageIndices,
    category: section.heuristicCategory,
    categoryLabel: CATEGORY_LABELS[section.heuristicCategory] ?? section.heuristicCategory,
    what,
    why,
    tokenEstimate: section.tokenEstimate,
    tokenPercentage,
    warning,
  };
}

export function computeCategoryComposition(
  sections: SectionTelemetry[],
  totalTokens: number,
): CategoryComposition[] {
  const categoryMap = new Map<ContextSectionCategory, number>();
  for (const s of sections) {
    categoryMap.set(s.category, (categoryMap.get(s.category) ?? 0) + s.tokenEstimate);
  }

  const composition: CategoryComposition[] = [];
  for (const [cat, tokens] of categoryMap.entries()) {
    const percentage = totalTokens > 0 ? Math.round((tokens / totalTokens) * 100) : 0;
    composition.push({
      category: cat,
      categoryLabel: CATEGORY_LABELS[cat] ?? cat,
      tokens,
      percentage,
      colorVar: CATEGORY_COLORS[cat] ?? "var(--vscode-descriptionForeground)",
    });
  }

  composition.sort((a, b) => b.tokens - a.tokens);
  return composition;
}

export function buildDeterministicTelemetry(
  captureId: string,
  messages: PromptMessage[],
  cache: TelemetryCache = globalTelemetryCache,
): CaptureTelemetry {
  const sections = extractContextSections(messages);
  const totalTokens = sections.reduce((sum, s) => sum + s.tokenEstimate, 0);

  const sectionTelemetries: SectionTelemetry[] = sections.map((section) => {
    const cached = cache.get(section.fingerprint);
    if (cached) {
      return {
        ...cached,
        sectionId: section.sectionId,
        messageIndex: section.messageIndex,
        messageIndices: section.messageIndices,
        tokenEstimate: section.tokenEstimate,
        tokenPercentage: totalTokens > 0 ? Math.round((section.tokenEstimate / totalTokens) * 100) : 0,
      };
    }
    const fallback = generateFallbackSectionTelemetry(section, totalTokens);
    if (section.heuristicCategory === "system_instruction" || section.heuristicCategory === "schema_tool_spec") {
      cache.set(section.fingerprint, fallback);
    }
    return fallback;
  });

  const composition = computeCategoryComposition(sectionTelemetries, totalTokens);
  const warnings = sectionTelemetries.map((s) => s.warning).filter((w): w is string => Boolean(w));

  return {
    captureId,
    analyzedAt: new Date().toISOString(),
    totalTokens,
    composition,
    sections: sectionTelemetries,
    warnings,
  };
}

export const TELEMETRY_SYSTEM = [
  "You are Context Tracker's autonomous Context Window Telemetry Engine powered by Meta AI models (Muse Spark 1.3 and Muse Wonder).",
  "Your mission is to perform architectural decomposition and semantic telemetry on a captured LLM prompt context window.",
  "",
  "For each section provided in the prompt context skeleton:",
  "1. Classify its functional category:",
  '   - "system_instruction": Persona, system rules, safety guardrails, output formatting constraints.',
  '   - "rag_grounding": Retrieved context documents, vector database search snippets, knowledge base chunks.',
  '   - "chat_history": Prior conversational turns between user and assistant for multi-turn dialogue memory.',
  '   - "few_shot_exemplar": Input/output demonstrations guiding the model\'s response format or logic.',
  '   - "schema_tool_spec": Function definitions, JSON schemas, or tool calling specifications.',
  '   - "user_query": The immediate current user task or question prompting this completion.',
  '   - "runtime_data": Dynamic state, session metadata, database rows, or environment variables.',
  "",
  "2. Identify WHAT this section is (concise, technical description, 4-10 words):",
  '   - Example: "AcmeCorp Support Persona & Brand Safety Policy"',
  '   - Example: "PostgreSQL Migration Guide (Vector RAG Search Results)"',
  "",
  "3. Explain WHY this section is included in the context window (prompt engineering rationale, 8-18 words):",
  '   - Example: "Enforces strict JSON output schema and prevents competitor brand mentions."',
  '   - Example: "Grounds troubleshooting instructions with accurate hardware specs for Acme Router 4000."',
  '   - Example: "Provides conversational memory so model can resolve coreferences to previous steps."',
  "",
  "4. Detect Hygiene Issues or Bloat:",
  "   - Identify stale dialogue history turns that consume excessive tokens without adding value to the active query.",
  "   - Flag conflicting instructions or duplicate context blocks.",
  "",
  "Respond with ONLY a valid JSON object matching this schema:",
  "{",
  '  "sections": [',
  "    {",
  '      "sectionId": "string (matching input sectionId)",',
  '      "category": "system_instruction" | "rag_grounding" | "chat_history" | "few_shot_exemplar" | "schema_tool_spec" | "user_query" | "runtime_data",',
  '      "what": "string (concise technical identity, 4-10 words)",',
  '      "why": "string (prompt engineering rationale, 8-18 words)",',
  '      "warning": "optional string (hygiene, bloat, or conflict advisory)"',
  "    }",
  "  ],",
  '  "warnings": ["optional general context bloat or conflict advisory strings"]',
  "}",
].join("\n");

export type TelemetrySkeletonItem = {
  sectionId: string;
  messageIndex: number;
  role: string;
  tokenEstimate: number;
  turns?: number;
  preview: string;
};

export function buildTelemetrySkeleton(sections: ContextSection[]): string {
  const items: TelemetrySkeletonItem[] = sections.map((sec) => ({
    sectionId: sec.sectionId,
    messageIndex: sec.messageIndex,
    role: sec.role,
    tokenEstimate: sec.tokenEstimate,
    turns: sec.turns,
    preview: redactText(sec.preview),
  }));
  return JSON.stringify(items, null, 2);
}

export type TelemetryModelSection = {
  sectionId: string;
  category: ContextSectionCategory;
  what: string;
  why: string;
  warning?: string;
};

export type TelemetryResponse = {
  sections: TelemetryModelSection[];
  warnings?: string[];
};

export const VALID_CATEGORIES = new Set<ContextSectionCategory>([
  "system_instruction",
  "rag_grounding",
  "chat_history",
  "few_shot_exemplar",
  "schema_tool_spec",
  "user_query",
  "runtime_data",
]);

export function parseTelemetryResponse(raw: string): TelemetryResponse | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const rawSections = Array.isArray(parsed.sections) ? parsed.sections : [];
    const validSections: TelemetryModelSection[] = [];
    for (const item of rawSections) {
      if (!item || typeof item !== "object") continue;
      const sectionId = typeof item.sectionId === "string" ? item.sectionId : "";
      if (!sectionId) continue;
      const category: ContextSectionCategory = VALID_CATEGORIES.has(item.category)
        ? item.category
        : "runtime_data";
      const what = typeof item.what === "string" && item.what.trim() ? item.what.trim() : "Context Section";
      const why = typeof item.why === "string" && item.why.trim() ? item.why.trim() : "Supplies context for completion.";
      const warning = typeof item.warning === "string" && item.warning.trim() ? item.warning.trim() : undefined;
      validSections.push({
        sectionId,
        category,
        what,
        why,
        warning,
      });
    }
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((w: unknown): w is string => typeof w === "string" && Boolean(w.trim()))
      : [];
    return {
      sections: validSections,
      warnings,
    };
  } catch {
    return null;
  }
}

export function applyTelemetryResponse(
  captureId: string,
  sections: ContextSection[],
  modelResponse: TelemetryResponse | null,
  cache: TelemetryCache = globalTelemetryCache,
): CaptureTelemetry {
  const totalTokens = sections.reduce((sum, s) => sum + s.tokenEstimate, 0);
  const modelSectionMap = new Map<string, TelemetryModelSection>();
  if (modelResponse) {
    for (const ms of modelResponse.sections) {
      modelSectionMap.set(ms.sectionId, ms);
    }
  }

  const sectionTelemetries: SectionTelemetry[] = sections.map((sec) => {
    // 1. Model provided analysis
    const fromModel = modelSectionMap.get(sec.sectionId);
    if (fromModel) {
      const tokenPercentage = totalTokens > 0 ? Math.round((sec.tokenEstimate / totalTokens) * 100) : 0;
      const item: SectionTelemetry = {
        sectionId: sec.sectionId,
        messageIndex: sec.messageIndex,
        messageIndices: sec.messageIndices,
        category: fromModel.category,
        categoryLabel: CATEGORY_LABELS[fromModel.category] ?? fromModel.category,
        what: fromModel.what,
        why: fromModel.why,
        tokenEstimate: sec.tokenEstimate,
        tokenPercentage,
        warning: fromModel.warning,
      };
      cache.set(sec.fingerprint, item);
      return item;
    }

    // 2. Cache hit
    const cached = cache.get(sec.fingerprint);
    if (cached) {
      return {
        ...cached,
        sectionId: sec.sectionId,
        messageIndex: sec.messageIndex,
        messageIndices: sec.messageIndices,
        tokenEstimate: sec.tokenEstimate,
        tokenPercentage: totalTokens > 0 ? Math.round((sec.tokenEstimate / totalTokens) * 100) : 0,
      };
    }

    // 3. Fallback
    const fallback = generateFallbackSectionTelemetry(sec, totalTokens);
    if (sec.heuristicCategory === "system_instruction" || sec.heuristicCategory === "schema_tool_spec") {
      cache.set(sec.fingerprint, fallback);
    }
    return fallback;
  });

  const composition = computeCategoryComposition(sectionTelemetries, totalTokens);
  const warnings: string[] = [];
  if (modelResponse?.warnings) {
    warnings.push(...modelResponse.warnings);
  }
  for (const s of sectionTelemetries) {
    if (s.warning && !warnings.includes(s.warning)) {
      warnings.push(s.warning);
    }
  }

  return {
    captureId,
    analyzedAt: new Date().toISOString(),
    totalTokens,
    composition,
    sections: sectionTelemetries,
    warnings,
  };
}

