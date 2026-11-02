import crypto from "crypto";
import { redactText } from "./redact";
import type {
  CaptureTelemetry,
  CategoryComposition,
  ContextSection,
  ContextSectionCategory,
  PromptMessage,
  SectionTelemetry,
  ToolSecondOpinion,
  ToolSecondOpinionVerdict,
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

export type SystemSubSection = {
  heading: string;
  content: string;
};

export function splitSystemSections(content: string): SystemSubSection[] {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length < 150) {
    return [{ heading: "System Instructions", content: trimmed }];
  }

  // Split by double newlines or markdown headers
  const rawBlocks = trimmed.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  if (rawBlocks.length <= 1) {
    return [{ heading: "System Instructions", content: trimmed }];
  }

  const sections: SystemSubSection[] = [];
  let currentAccumulator: string[] = [];
  let currentHeading = "";

  for (const block of rawBlocks) {
    const firstLine = block.split("\n")[0].trim();
    const mdHeaderMatch = firstLine.match(/^#{1,6}\s+(.+)$/);
    const labelColonMatch = firstLine.match(/^([A-Za-z0-9 _\-/]{2,50}):(?:\s*|$)/);
    const bracketMatch = firstLine.match(/^\[([A-Za-z0-9 _\-/]{2,50})\](?:\s*|$)/);
    const xmlMatch = firstLine.match(/^<([a-z0-9_\-]+)>(?:\s*|$)/i);

    const isDistinctSection =
      Boolean(mdHeaderMatch || labelColonMatch || bracketMatch || xmlMatch) ||
      (block.length > 80 && block.includes("\n-"));

    if (isDistinctSection && currentAccumulator.length > 0) {
      sections.push({
        heading: currentHeading || "System Directive",
        content: currentAccumulator.join("\n\n"),
      });
      currentAccumulator = [];
      currentHeading = "";
    }

    if (!currentHeading) {
      if (mdHeaderMatch) {
        currentHeading = mdHeaderMatch[1].trim();
      } else if (labelColonMatch) {
        currentHeading = labelColonMatch[1].trim();
      } else if (bracketMatch) {
        currentHeading = bracketMatch[1].trim();
      } else if (xmlMatch) {
        currentHeading = xmlMatch[1].trim();
      } else if (/^you are\b/i.test(firstLine)) {
        currentHeading = "Persona & Role Definition";
      } else {
        currentHeading = firstLine.slice(0, 45).replace(/[#*`_]/g, "").trim();
      }
    }

    currentAccumulator.push(block);
  }

  if (currentAccumulator.length > 0) {
    sections.push({
      heading: currentHeading || "System Directive",
      content: currentAccumulator.join("\n\n"),
    });
  }

  return sections.length > 0 ? sections : [{ heading: "System Instructions", content: trimmed }];
}

export type ToolDefinitionItem = {
  toolName: string;
  description: string;
  rawJson: string;
  parametersJson?: string;
};

export function parseIndividualTools(content: string): ToolDefinitionItem[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  // 1. Try JSON.parse directly (in case it is a JSON array)
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const items = parsed.map((item, idx) => extractToolInfo(item, idx)).filter(Boolean) as ToolDefinitionItem[];
      if (items.length > 0) return items;
    } else if (parsed && typeof parsed === "object") {
      const single = extractToolInfo(parsed, 0);
      if (single) return [single];
    }
  } catch {
    // Not a single JSON document, likely multiple JSON documents joined with \n\n
  }

  // 2. Scan balanced curly braces to extract top-level JSON objects
  const tools: ToolDefinitionItem[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let startIndex = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && startIndex !== -1) {
        const slice = trimmed.slice(startIndex, i + 1);
        startIndex = -1;
        try {
          const obj = JSON.parse(slice);
          const tool = extractToolInfo(obj, tools.length);
          if (tool) {
            tools.push(tool);
          }
        } catch {
          // If JSON parse fails, skip
        }
      }
    }
  }

  return tools;
}

function extractToolInfo(obj: unknown, fallbackIdx: number): ToolDefinitionItem | null {
  if (!obj || typeof obj !== "object") {
    return null;
  }
  const record = obj as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object"
    ? (record.function as Record<string, unknown>)
    : record;

  const toolName = typeof fn.name === "string" && fn.name.trim()
    ? fn.name.trim()
    : typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : `tool_${fallbackIdx + 1}`;

  const description = typeof fn.description === "string"
    ? fn.description.trim()
    : typeof record.description === "string"
      ? record.description.trim()
      : "";

  const params = fn.parameters ?? fn.input_schema ?? record.parameters ?? record.input_schema;
  const parametersJson = params ? JSON.stringify(params, null, 2) : undefined;
  const rawJson = JSON.stringify(obj, null, 2);

  return {
    toolName,
    description,
    rawJson,
    parametersJson,
  };
}

export function formatVerdictLabel(verdict: ToolSecondOpinionVerdict): string {
  switch (verdict) {
    case "recommended":
      return "✅ Recommended in Context";
    case "unnecessary":
      return "⚠️ Unnecessary in Context";
    case "bloat":
      return "⚠️ Context Bloat";
    case "redundant":
      return "⚠️ Redundant Tool";
    case "security_risk":
      return "🛡️ Security / Mutation Risk";
    case "caution":
      return "⚠️ Needs Review";
  }
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

    // Handle tools messages by breaking down into individual tool functions
    if (msg.role === "tools") {
      const individualTools = parseIndividualTools(msg.content);
      if (individualTools.length > 0) {
        for (let toolIdx = 0; toolIdx < individualTools.length; toolIdx++) {
          const t = individualTools[toolIdx];
          const toolTokens = estimateTokens(t.rawJson);
          const safeName = t.toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
          sections.push({
            sectionId: `msg-${i}-tool-${toolIdx}-${safeName}`,
            messageIndex: i,
            messageIndices: [i],
            role: "tools",
            content: t.rawJson,
            tokenEstimate: toolTokens,
            fingerprint: hashText(t.rawJson),
            heuristicCategory: "schema_tool_spec",
            toolName: t.toolName,
            parametersJson: t.parametersJson,
            preview: `Tool "${t.toolName}": ${t.description || truncatePreview(t.rawJson, 140)}`,
          });
        }
        i += 1;
        continue;
      }
    }

    // Handle system messages with multiple sections
    if (msg.role === "system") {
      const subSections = splitSystemSections(msg.content);
      if (subSections.length > 1) {
        for (let sysIdx = 0; sysIdx < subSections.length; sysIdx++) {
          const sub = subSections[sysIdx];
          const subTokens = estimateTokens(sub.content);
          sections.push({
            sectionId: `msg-${i}-sys-${sysIdx}`,
            messageIndex: i,
            messageIndices: [i],
            role: "system",
            content: sub.content,
            tokenEstimate: subTokens,
            fingerprint: hashText(sub.content),
            heuristicCategory: classifyHeuristicCategory("system", sub.content, false),
            heading: sub.heading,
            preview: truncatePreview(sub.content, 200),
          });
        }
        i += 1;
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

    // Any other individual message (e.g. system single-block, trailing assistant reply)
    const tokens = estimateTokens(msg.content);
    const heading = msg.role === "system" ? splitSystemSections(msg.content)[0]?.heading : undefined;
    sections.push({
      sectionId: `msg-${i}`,
      messageIndex: i,
      messageIndices: [i],
      role: msg.role,
      content: msg.content,
      tokenEstimate: tokens,
      fingerprint: hashText(msg.content),
      heuristicCategory: classifyHeuristicCategory(msg.role, msg.content, false),
      heading,
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
  allSections?: ContextSection[],
): SectionTelemetry {
  const tokenPercentage = totalTokens > 0 ? Math.round((section.tokenEstimate / totalTokens) * 100) : 0;
  let what = "";
  let why = "";
  let warning: string | undefined;
  let secondOpinion: ToolSecondOpinion | undefined;

  switch (section.heuristicCategory) {
    case "system_instruction":
      if (section.heading && section.heading !== "System Directive" && section.heading !== "System Instructions") {
        what = `System Directive: ${section.heading}`;
        why = `Specifies behavioral directives and operational guidance for ${section.heading.toLowerCase()}.`;
      } else {
        const firstLine = section.content.split("\n")[0].trim().replace(/[#*`_]/g, "").slice(0, 45);
        what = firstLine && firstLine.length > 8 ? `System: ${firstLine}` : "System Guidelines & Persona Specification";
        why = "Defines assistant persona, behavior rules, and response constraints.";
      }
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
    case "schema_tool_spec": {
      const name = section.toolName || "Custom Tool";
      what = `Tool: ${name} Function Calling Schema`;
      why = `Enables model to invoke the ${name} function during completion.`;

      // Analyze tool hygiene heuristically
      const lowerName = name.toLowerCase();
      const isVisionTool = /image|vision|photo|ocr|camera|visual/i.test(lowerName);
      const isDestructive = /delete|drop|destroy|remove|kill|unlink|rm\b/i.test(lowerName);

      // Check if user query mentions images if this is a vision tool
      const userQueries = (allSections ?? []).filter((s) => s.heuristicCategory === "user_query");
      const hasImageQuery = userQueries.some((q) =>
        /image|photo|picture|look at|attachment|file_reference/i.test(q.content),
      );

      if (isVisionTool && !hasImageQuery) {
        warning = `Tool '${name}' is in context window but no image inputs were detected in this turn (~${section.tokenEstimate} tokens).`;
        secondOpinion = {
          verdict: "unnecessary",
          verdictLabel: formatVerdictLabel("unnecessary"),
          advice: `This tool should not be in the prompt window: No image inputs or vision tasks were detected in the active turn. Omit '${name}' from tool definitions to conserve context tokens and reduce model confusion.`,
        };
      } else if (isDestructive) {
        warning = `Tool '${name}' exposes destructive mutations. Ensure authorization is strictly enforced.`;
        secondOpinion = {
          verdict: "security_risk",
          verdictLabel: formatVerdictLabel("security_risk"),
          advice: `Exposes destructive data operations. Verify that strict confirmation safeguards and scope restrictions are applied before invocation.`,
        };
      } else if (section.tokenEstimate > 400 || (section.tokenEstimate > 250 && tokenPercentage >= 35)) {
        warning = `Tool '${name}' consumes ${section.tokenEstimate} tokens (${tokenPercentage}% of context). Schema may be bloated.`;
        secondOpinion = {
          verdict: "bloat",
          verdictLabel: formatVerdictLabel("bloat"),
          advice: `High token footprint: Tool schema takes ${section.tokenEstimate} tokens. Consider pruning redundant parameter descriptions or extracting sub-schemas.`,
        };
      } else {
        secondOpinion = {
          verdict: "recommended",
          verdictLabel: formatVerdictLabel("recommended"),
          advice: `Tool function schema is cleanly defined and ready for tool calling.`,
        };
      }
      break;
    }
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
    toolName: section.toolName,
    heading: section.heading,
    secondOpinion,
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
        toolName: section.toolName ?? cached.toolName,
        heading: section.heading ?? cached.heading,
      };
    }
    const fallback = generateFallbackSectionTelemetry(section, totalTokens, sections);
    if (cache !== globalTelemetryCache) {
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
  "Your mission is to perform architectural decomposition, prompt telemetry, and tool hygiene evaluation on a captured LLM prompt context window.",
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
  '   - For system prompt sections: state the specific domain, rule set, or architectural aspect (e.g. "OptimalX Hierarchical Data Model & Routing Rules", "Temporal Anchor & Scope Guardrails"). NEVER give identical generic boilerplate for different system sections.',
  '   - For tool specifications: name the tool and its primary function (e.g. "search_semantic: Semantic Vector Note & File Retrieval", "describe_image: Local Vision Image Analysis").',
  "",
  "3. Explain WHY this section is included in the context window (prompt engineering rationale, 8-18 words):",
  '   - Example: "Enforces strict JSON output schema and prevents competitor brand mentions."',
  '   - Example: "Grounds troubleshooting instructions with accurate hardware specs for Acme Router 4000."',
  '   - Example: "Enables model to perform semantic retrieval across user notes and workshop files."',
  "",
  "4. Provide a SECOND OPINION and Hygiene Audit (CRITICAL FOR TOOLS AND SYSTEM PROMPTS):",
  '   - For each tool function ("schema_tool_spec"): Evaluate whether this tool actually belongs in the prompt window for the user\'s current task or if it represents context bloat, redundancy, or a security hazard.',
  '     * If a tool is irrelevant to the active task (e.g. vision/image description tool in a text-only coding conversation, or note-creation tool in a read-only question), set verdict to "unnecessary" or "bloat" and explain why in advice.',
  '     * If multiple tools overlap in function, set verdict to "redundant".',
  '     * If a tool exposes dangerous file mutations or execution without confirmation, set verdict to "caution" or "security_risk".',
  '     * If the tool is appropriate and useful for the task, set verdict to "recommended".',
  '   - For system prompt sections: detect conflicting instructions, outdated rules, duplicate guidelines, or bloated formatting constraints.',
  '   - For dialogue history: flag stale turns consuming token budget without relevance to the active query.',
  "",
  "Respond with ONLY a valid JSON object matching this schema:",
  "{",
  '  "sections": [',
  "    {",
  '      "sectionId": "string (matching input sectionId)",',
  '      "category": "system_instruction" | "rag_grounding" | "chat_history" | "few_shot_exemplar" | "schema_tool_spec" | "user_query" | "runtime_data",',
  '      "what": "string (concise technical identity, 4-10 words)",',
  '      "why": "string (prompt engineering rationale, 8-18 words)",',
  '      "warning": "optional string (hygiene, bloat, or conflict advisory)",',
  '      "secondOpinion": {',
  '        "verdict": "recommended" | "unnecessary" | "bloat" | "redundant" | "security_risk" | "caution",',
  '        "advice": "string (Meta AI second opinion on whether this tool or section belongs in the prompt window, 10-30 words)"',
  '      }',
  "    }",
  "  ],",
  '  "warnings": ["general context bloat, token waste, or prompt hygiene advisory strings"]',
  "}",
].join("\n");

export type TelemetrySkeletonItem = {
  sectionId: string;
  messageIndex: number;
  role: string;
  tokenEstimate: number;
  turns?: number;
  toolName?: string;
  heading?: string;
  preview: string;
};

export function buildTelemetrySkeleton(sections: ContextSection[]): string {
  const items: TelemetrySkeletonItem[] = sections.map((sec) => ({
    sectionId: sec.sectionId,
    messageIndex: sec.messageIndex,
    role: sec.role,
    tokenEstimate: sec.tokenEstimate,
    turns: sec.turns,
    toolName: sec.toolName,
    heading: sec.heading,
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
  secondOpinion?: ToolSecondOpinion;
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
      let warning = typeof item.warning === "string" && item.warning.trim() ? item.warning.trim() : undefined;

      let secondOpinion: ToolSecondOpinion | undefined;
      if (item.secondOpinion && typeof item.secondOpinion === "object") {
        const rawVerdict = String((item.secondOpinion as any).verdict || "").toLowerCase();
        const verdict: ToolSecondOpinionVerdict =
          rawVerdict === "unnecessary" ||
          rawVerdict === "bloat" ||
          rawVerdict === "redundant" ||
          rawVerdict === "security_risk" ||
          rawVerdict === "caution" ||
          rawVerdict === "recommended"
            ? (rawVerdict as ToolSecondOpinionVerdict)
            : warning
              ? "caution"
              : "recommended";

        const advice =
          typeof (item.secondOpinion as any).advice === "string" ? (item.secondOpinion as any).advice.trim() : "";
        if (advice) {
          secondOpinion = {
            verdict,
            verdictLabel: formatVerdictLabel(verdict),
            advice,
          };
          if (!warning && verdict !== "recommended") {
            warning = advice;
          }
        }
      }

      validSections.push({
        sectionId,
        category,
        what,
        why,
        warning,
        secondOpinion,
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
        toolName: sec.toolName,
        heading: sec.heading,
        secondOpinion: fromModel.secondOpinion,
        fromModel: true,
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
        toolName: sec.toolName ?? cached.toolName,
        heading: sec.heading ?? cached.heading,
      };
    }

    // 3. Fallback
    const fallback = generateFallbackSectionTelemetry(sec, totalTokens, sections);
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

