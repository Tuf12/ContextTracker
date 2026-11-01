export type RouteMode = "auto" | "custom";

export type RouteSettings = {
  mode: RouteMode;
  customUpstream: string;
};

export type TrafficState = "off" | "listening" | "listening_idle" | "active";

export type PromptMessage = {
  role: string;
  content: string;
  truncated: boolean;
};

export type ReportedSpan = {
  messageIndex?: number;
  charStart?: number;
  charEnd?: number;
  quote?: string;
  file: string;
  startLine: number;
  endLine: number;
  source?: SpanSource;
  confidence?: number;
  explanation?: string;
};

export type CachedAttribution = {
  fingerprint: string;
  quote?: string;
  cleanQuote?: string;
  file: string;
  startLine: number;
  endLine: number;
  confidence: number;
  explanation: string;
  attributedAt: string;
};

export type StoredCapture = {
  id: string;
  clientRequestId: string | null;
  projectPath: string;
  createdAt: string;
  provider: string;
  upstream: string;
  endpoint: string;
  model: string;
  status: number | null;
  error: string | null;
  messages: PromptMessage[];
  reply: string;
  reported: ReportedSpan[];
  telemetry?: CaptureTelemetry;
};

export type CaptureSummary = {
  id: string;
  createdAt: string;
  model: string;
  provider: string;
  endpoint: string;
  status: number | null;
  error: string | null;
  preview: string;
  fileSpanCount?: number;
};

export type FilePointer = {
  file: string;
  line: number;
};

export type ProjectIndex = {
  root: string;
  fileCount: number;
  truncated: boolean;
  lines: Map<string, FilePointer[]>;
  fileLines: Map<string, string[]>;
  clues: { file: string; line: number; text: string }[];
};

export type SpanSource = "matched" | "reported" | "attributed";

export type ViewSpan = {
  id: string;
  text: string;
  kind: "file" | "runtime";
  label: string;
  source?: SpanSource;
  file?: string;
  absolutePath?: string;
  canOpen: boolean;
  startLine?: number;
  endLine?: number;
  confidence?: number;
  explanation?: string;
};

export type CaptureView = {
  id: string;
  createdAt: string;
  model: string;
  provider: string;
  upstream: string;
  endpoint: string;
  status: number | null;
  error: string | null;
  estimatedTokens: number;
  replyEstimatedTokens: number;
  messages: ViewMessage[];
  reply: string;
  fileSpanCount: number;
  telemetry?: CaptureTelemetry;
};

export type EnvKeyPlan = {
  key: string;
  current: string | null;
  proposed: string;
  pointingHere: boolean;
};

export type EnvStatus = {
  filePath: string;
  exists: boolean;
  keys: EnvKeyPlan[];
  hasBackup: boolean;
  restoreDeletesFile: boolean;
};

export type ViewMessage = {
  role: string;
  roleLabel: string;
  truncated: boolean;
  spans: ViewSpan[];
  telemetry?: SectionTelemetry;
};

export type ProjectView = {
  path: string;
  name: string;
  fileCount: number;
  truncated: boolean;
  indexing: boolean;
  clues: { file: string; line: number; text: string }[];
};

export type RecorderView = {
  running: boolean;
  url: string | null;
  openaiBase: string | null;
  anthropicBase: string | null;
  mode: RouteMode;
  customUpstream: string;
  error: string | null;
  lastEvent: string | null;
  found: string | null;
  trafficState: TrafficState;
  requestCount: number;
  uptimeSeconds: number;
  missedHint: string | null;
};

export type AddressOffer = {
  relativeFile: string;
  line: number;
  url: string;
  reason: string;
  explanation?: string;
  previousFile?: string;
};

export type AttributedSpan = {
  file: string;
  startLine: number;
  endLine: number;
  confidence: number;
  explanation: string;
  matchedSnippet?: string;
};

export type HelperModelChoice = {
  id: string;
  label: string;
};

export type HelperActivityKind = "thought" | "tool_call" | "tool_result" | "status" | "finish" | "user";

export type HelperActivityItem = {
  id: string;
  timestamp: number;
  kind: HelperActivityKind;
  text: string;
  toolName?: string;
  detail?: string;
};

export type HelperView = {
  model: string;
  choices: HelperModelChoice[];
  keySaved: boolean;
  connectOpen: boolean;
  needed: boolean;
  busy: boolean;
  status: string | null;
  offer: AddressOffer | null;
  activity: HelperActivityItem[];
};

export type ViewState = {
  project: ProjectView | null;
  recorder: RecorderView;
  helper: HelperView;
  env: EnvStatus | null;
  captures: CaptureSummary[];
  selectedId: string | null;
  selected: CaptureView | null;
  compareId: string | null;
  compare: CaptureView | null;
};

export type ContextSectionCategory =
  | "system_instruction"
  | "rag_grounding"
  | "chat_history"
  | "few_shot_exemplar"
  | "schema_tool_spec"
  | "user_query"
  | "runtime_data";

export type SectionTelemetry = {
  sectionId: string;
  messageIndex: number;
  messageIndices?: number[];
  category: ContextSectionCategory;
  categoryLabel: string;
  what: string;
  why: string;
  tokenEstimate: number;
  tokenPercentage: number;
  warning?: string;
};

export type CategoryComposition = {
  category: ContextSectionCategory;
  categoryLabel: string;
  tokens: number;
  percentage: number;
  colorVar: string;
};

export type CaptureTelemetry = {
  captureId: string;
  analyzedAt: string;
  totalTokens: number;
  composition: CategoryComposition[];
  sections: SectionTelemetry[];
  warnings: string[];
};

export type ContextSection = {
  sectionId: string;
  messageIndex: number;
  messageIndices: number[];
  role: string;
  content: string;
  tokenEstimate: number;
  fingerprint: string;
  heuristicCategory: ContextSectionCategory;
  isCollapsedHistory?: boolean;
  turns?: number;
  preview: string;
};

