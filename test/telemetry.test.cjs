const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  TELEMETRY_SYSTEM,
  TelemetryCache,
  VALID_CATEGORIES,
  applyTelemetryResponse,
  buildDeterministicTelemetry,
  buildTelemetrySkeleton,
  classifyHeuristicCategory,
  computeCategoryComposition,
  estimateTokens,
  extractContextSections,
  generateFallbackSectionTelemetry,
  hashText,
  hasFewShotMarkers,
  hasRagMarkers,
  parseTelemetryResponse,
  splitRagUserQuery,
} = require("../out/telemetry.js");

test("estimateTokens calculates proportional tokens with min 1 for non-empty text", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("hi"), 1);
  assert.equal(estimateTokens("This is a sample prompt for testing token counts."), 12);
});

test("heuristic classifier identifies prompt roles and specialized categories", () => {
  assert.equal(classifyHeuristicCategory("system", "You are a helpful coding assistant."), "system_instruction");
  assert.equal(classifyHeuristicCategory("tools", '{"name": "search"}'), "schema_tool_spec");
  assert.equal(classifyHeuristicCategory("tool", '{"result": 42}'), "runtime_data");
  assert.equal(classifyHeuristicCategory("assistant", "Hello there!"), "chat_history");

  // RAG markers
  assert.equal(
    classifyHeuristicCategory("system", "Reference Documents:\nDoc 1: Specs for API\nDoc 2: Schema"),
    "rag_grounding",
  );
  assert.equal(
    classifyHeuristicCategory("user", "Retrieved Context:\nDocument 1: Database failover\nDocument 2: Logs", false),
    "rag_grounding",
  );

  // Few-shot exemplars
  assert.equal(
    classifyHeuristicCategory("system", "Examples:\nInput: foo\nOutput: bar\nInput: baz\nOutput: qux"),
    "few_shot_exemplar",
  );

  // Active user query vs history
  assert.equal(classifyHeuristicCategory("user", "What is the capital of France?", true), "user_query");
  assert.equal(classifyHeuristicCategory("user", "Hello", false), "chat_history");
});

test("extractContextSections collapses multi-turn dialogue history prior to active user query", () => {
  const messages = [
    { role: "system", content: "You are an autonomous AI assistant.", truncated: false },
    { role: "tools", content: '[{"type": "function", "name": "search"}]', truncated: false },
    // Turn 1
    { role: "user", content: "Can you help me configure nginx?", truncated: false },
    { role: "assistant", content: "Sure, what OS are you on?", truncated: false },
    // Turn 2
    { role: "user", content: "Ubuntu 22.04 LTS.", truncated: false },
    { role: "assistant", content: "Here is the basic config: ...", truncated: false },
    // Active query
    { role: "user", content: "How do I enable SSL certificates?", truncated: false },
  ];

  const sections = extractContextSections(messages);

  // We expect:
  // 1: system message
  // 2: tools message
  // 3: collapsed history section (turns 1 and 2)
  // 4: active user query
  assert.equal(sections.length, 4);

  assert.equal(sections[0].heuristicCategory, "system_instruction");
  assert.equal(sections[0].role, "system");

  assert.equal(sections[1].heuristicCategory, "schema_tool_spec");
  assert.equal(sections[1].role, "tools");

  const history = sections[2];
  assert.equal(history.heuristicCategory, "chat_history");
  assert.equal(history.isCollapsedHistory, true);
  assert.deepEqual(history.messageIndices, [2, 3, 4, 5]);
  assert.equal(history.turns, 2);
  assert.match(history.content, /Turn 1|User:|Ubuntu/i);

  const activeQuery = sections[3];
  assert.equal(activeQuery.heuristicCategory, "user_query");
  assert.equal(activeQuery.messageIndex, 6);
  assert.match(activeQuery.content, /enable SSL/);
});

test("splitRagUserQuery separates RAG context from prompt question in active user message", () => {
  const composite = [
    "Reference Documents:",
    "Doc 1: Postgres failover requires running pg_ctl promote on replica.",
    "Doc 2: Standby node automatically reconnects when primary recovers.",
    "",
    "Question: What happens during failover if primary dies?",
  ].join("\n");

  const split = splitRagUserQuery(composite);
  assert.notEqual(split, null);
  assert.match(split.ragText, /Reference Documents/);
  assert.match(split.queryText, /What happens during failover/);

  // Verify extractContextSections produces two sections for this composite message
  const sections = extractContextSections([
    { role: "system", content: "You are a DBA assistant.", truncated: false },
    { role: "user", content: composite, truncated: false },
  ]);

  assert.equal(sections.length, 3);
  assert.equal(sections[0].heuristicCategory, "system_instruction");
  assert.equal(sections[1].heuristicCategory, "rag_grounding");
  assert.equal(sections[2].heuristicCategory, "user_query");
  assert.equal(sections[1].messageIndex, 1);
  assert.equal(sections[2].messageIndex, 1);
});

test("TelemetryCache supports LRU eviction and fingerprint retrieval", () => {
  const cache = new TelemetryCache(3);

  const item1 = {
    sectionId: "1",
    messageIndex: 0,
    category: "system_instruction",
    categoryLabel: "System Instruction",
    what: "System Rules",
    why: "Persona constraints",
    tokenEstimate: 50,
    tokenPercentage: 50,
  };
  const item2 = { ...item1, sectionId: "2", what: "Doc 1" };
  const item3 = { ...item1, sectionId: "3", what: "Doc 2" };
  const item4 = { ...item1, sectionId: "4", what: "Doc 3" };

  cache.set("hash-1", item1);
  cache.set("hash-2", item2);
  cache.set("hash-3", item3);
  assert.equal(cache.size, 3);
  assert.equal(cache.has("hash-1"), true);

  // Access hash-1 to make it most recently used (order: hash-2, hash-3, hash-1)
  assert.equal(cache.get("hash-1").what, "System Rules");

  // Adding 4th item should evict oldest (hash-2)
  cache.set("hash-4", item4);
  assert.equal(cache.size, 3);
  assert.equal(cache.has("hash-2"), false);
  assert.equal(cache.has("hash-1"), true);
  assert.equal(cache.has("hash-3"), true);
  assert.equal(cache.has("hash-4"), true);

  // Test clear and delete
  assert.equal(cache.delete("hash-3"), true);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("buildDeterministicTelemetry calculates composition percentages and cache hits", () => {
  const testCache = new TelemetryCache(50);
  const messages = [
    { role: "system", content: "You are a customer service AI. Always remain courteous and concise.", truncated: false },
    { role: "user", content: "I would like a refund for my order #12345.", truncated: false },
  ];

  const telemetry1 = buildDeterministicTelemetry("cap-1", messages, testCache);
  assert.equal(telemetry1.captureId, "cap-1");
  assert.equal(telemetry1.sections.length, 2);
  assert.equal(telemetry1.totalTokens > 0, true);
  assert.equal(telemetry1.composition.length, 2);

  // Check categories present in composition
  const categories = telemetry1.composition.map((c) => c.category);
  assert.equal(categories.includes("system_instruction"), true);
  assert.equal(categories.includes("user_query"), true);

  // Check percentage calculation
  const totalPercentage = telemetry1.composition.reduce((sum, c) => sum + c.percentage, 0);
  assert.equal(totalPercentage >= 95 && totalPercentage <= 105, true);

  // Cache hit on system prompt fingerprint
  const systemFingerprint = hashText(messages[0].content);
  assert.equal(testCache.has(systemFingerprint), true);

  // Second capture with identical system prompt
  const messages2 = [
    { role: "system", content: "You are a customer service AI. Always remain courteous and concise.", truncated: false },
    { role: "user", content: "Where is my package?", truncated: false },
  ];
  const telemetry2 = buildDeterministicTelemetry("cap-2", messages2, testCache);
  assert.equal(telemetry2.sections[0].what, telemetry1.sections[0].what);
  assert.equal(telemetry2.sections[0].why, telemetry1.sections[0].why);
});

test("buildTelemetrySkeleton formats items and redacts sensitive credentials", () => {
  const sections = extractContextSections([
    {
      role: "system",
      content: "api_key: sk-topsecret-value-12345\nYou are a financial analysis model.",
      truncated: false,
    },
    { role: "user", content: "Check company financials for Q3.", truncated: false },
  ]);

  const skeletonJson = buildTelemetrySkeleton(sections);
  const items = JSON.parse(skeletonJson);

  assert.equal(Array.isArray(items), true);
  assert.equal(items.length, 2);
  assert.equal(items[0].sectionId, "msg-0");
  assert.equal(items[0].role, "system");
  assert.equal(items[0].tokenEstimate > 0, true);

  // Redaction check: secret must be [private] and not include the secret key literal
  assert.match(items[0].preview, /\[private\]/);
  assert.equal(items[0].preview.includes("sk-topsecret-value-12345"), false);
  assert.match(items[0].preview, /financial analysis model/);
});

test("parseTelemetryResponse parses clean JSON, markdown code-fences, and handles malformed inputs", () => {
  assert.equal(parseTelemetryResponse(""), null);
  assert.equal(parseTelemetryResponse("not a json string"), null);
  assert.equal(parseTelemetryResponse("null"), null);

  // Markdown code fence wrapped JSON
  const fenced = [
    "```json",
    "{",
    '  "sections": [',
    "    {",
    '      "sectionId": "msg-0",',
    '      "category": "system_instruction",',
    '      "what": "Financial Analyst Persona",',
    '      "why": "Constrains model to SEC compliance and financial terminology.",',
    '      "warning": null',
    "    },",
    "    {",
    '      "sectionId": "msg-1",',
    '      "category": "unknown_category_from_future",',
    '      "what": "Q3 Analysis Task",',
    '      "why": "Target instruction for completion"',
    "    }",
    "  ],",
    '  "warnings": ["Section 1 mentions unverified ticker symbol"]',
    "}",
    "```",
  ].join("\n");

  const parsed = parseTelemetryResponse(fenced);
  assert.notEqual(parsed, null);
  assert.equal(parsed.sections.length, 2);
  assert.equal(parsed.sections[0].sectionId, "msg-0");
  assert.equal(parsed.sections[0].category, "system_instruction");
  assert.equal(parsed.sections[0].what, "Financial Analyst Persona");
  assert.match(parsed.sections[0].why, /SEC compliance/);

  // Unknown category defaults to runtime_data
  assert.equal(parsed.sections[1].category, "runtime_data");
  assert.equal(parsed.sections[1].what, "Q3 Analysis Task");

  // Warnings
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /unverified ticker/);
});

test("applyTelemetryResponse merges model outputs with cache and fallback handling", () => {
  const cache = new TelemetryCache(50);
  const sections = extractContextSections([
    { role: "system", content: "You are an AI assistant for database migrations.", truncated: false },
    { role: "user", content: "Retrieved Context:\nDocument 1: Postgres 16 logical replication\n\nQuestion: How to enable it?", truncated: false },
  ]);

  const mockModelResponse = {
    sections: [
      {
        sectionId: "msg-0",
        category: "system_instruction",
        what: "DBA Assistant Persona",
        why: "Guides safe schema and data migration practices.",
      },
      // Note: msg-1 is intentionally omitted to verify fallback handling
    ],
    warnings: ["Be cautious with large replica slots"],
  };

  const result = applyTelemetryResponse("cap-test", sections, mockModelResponse, cache);
  assert.equal(result.captureId, "cap-test");
  assert.equal(result.sections.length, sections.length);

  // First section came from model
  assert.equal(result.sections[0].what, "DBA Assistant Persona");
  assert.equal(result.sections[0].why, "Guides safe schema and data migration practices.");
  assert.equal(result.sections[0].category, "system_instruction");

  // Second section fell back to heuristic/deterministic
  assert.equal(result.sections[1].category, "rag_grounding");
  assert.match(result.sections[1].what, /Retrieved Context/);

  // Model response should have populated cache for msg-0
  assert.equal(cache.has(sections[0].fingerprint), true);
  assert.equal(cache.get(sections[0].fingerprint).what, "DBA Assistant Persona");

  // Composition calculation
  assert.equal(result.composition.length >= 2, true);
  const totalPct = result.composition.reduce((sum, c) => sum + c.percentage, 0);
  assert.equal(totalPct >= 95 && totalPct <= 105, true);

  // Combined warnings
  assert.equal(result.warnings.includes("Be cautious with large replica slots"), true);
});

