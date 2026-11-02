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
  cleanQuotes?: string[];
  invariantPrefix?: string;
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
  chatCount?: number;
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
  sections?: ContextSection[];
  activeScope?: ContextScope;
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
  telemetries?: SectionTelemetry[];
};

export type ProjectView = {
  path: string;
  name: string;
  fileCount: number;
  truncated: boolean;
  indexing: boolean;
  clues: { file: string; line: number; text: string }[];
};

export type AndroidViewInfo = {
  isAndroid: boolean;
  deviceLabel?: string;
  bridged: boolean;
  cleartextPermitted: boolean;
  securityRisk?: string;
  remediationSnippet?: string;
  isStale: boolean;
  staleSummary?: string;
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
  mobile?: AndroidViewInfo;
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

export type HelperActivityKind = "thought" | "tool_call" | "tool_result" | "status" | "finish" | "user" | "assistant";

export type HelperActivityItem = {
  id: string;
  timestamp: number;
  kind: HelperActivityKind;
  text: string;
  toolName?: string;
  detail?: string;
  patch?: TemplatePatchProposal;
  patchApplied?: boolean;
};

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

export type ChatConversation = {
  id: string;
  activity: HelperActivityItem[];
  messages: ChatMessage[];
  activePatch?: TemplatePatchProposal | null;
  updatedAt: number;
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
  activeScope?: ContextScope;
  activePatch?: TemplatePatchProposal | null;
  threadCount?: number;
  conversationId?: string;
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

export type ToolSecondOpinionVerdict =
  | "recommended"
  | "caution"
  | "bloat"
  | "unnecessary"
  | "redundant"
  | "security_risk";

export type ToolSecondOpinion = {
  verdict: ToolSecondOpinionVerdict;
  verdictLabel: string;
  advice: string;
};

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
  toolName?: string;
  heading?: string;
  secondOpinion?: ToolSecondOpinion;
  fromModel?: boolean;
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
  toolName?: string;
  heading?: string;
  parametersJson?: string;
};

export type ContextScopeKind = "global" | "section" | "selection" | "compare";

export type ContextScope = {
  kind: ContextScopeKind;
  sectionId?: string;
  category?: ContextSectionCategory;
  categoryLabel?: string;
  selectedText?: string;
  charCount?: number;
  messageIndex?: number;
  compareCaptureId?: string;
  label: string;
};

export type ContextSectionMatch = {
  sectionId: string;
  messageIndex: number;
  category: ContextSectionCategory;
  line: number;
  snippet: string;
  charOffset: number;
};

export type ContextQueryResult = {
  matchesCount: number;
  matches: ContextSectionMatch[];
};

export type ContextSectionReadResult = {
  sectionId: string;
  role: string;
  category: ContextSectionCategory;
  totalLines: number;
  startLine: number;
  endLine: number;
  tokens: number;
  content: string;
};

export type TemplatePatchProposal = {
  patchId: string;
  status: "ready_for_user_approval" | "applied" | "rejected";
  file: string;
  startLine: number;
  endLine: number;
  originalCode: string;
  replacementCode: string;
  explanation: string;
  tokenImpactEstimate: string;
  diffPreview: string;
};

export type CodeTemplateInspectionResult = {
  attributed: boolean;
  file?: string;
  startLine?: number;
  endLine?: number;
  templateType?: string;
  templateSource?: string;
  runtimeInterpolations?: Array<{ variable: string; value?: string; count?: number }>;
  explanation?: string;
};

export type DiffCapturesResult = {
  primaryId: string;
  compareId: string;
  primaryModel: string;
  compareModel: string;
  statusComparison: {
    primaryStatus: number | null;
    compareStatus: number | null;
    primaryError: string | null;
    compareError: string | null;
  };
  tokenComparison: {
    primaryTokens: number;
    compareTokens: number;
    delta: number;
  };
  sectionComparison: {
    primaryCount: number;
    compareCount: number;
    delta: number;
  };
  categoryDivergence: Array<{
    category: ContextSectionCategory;
    categoryLabel: string;
    primaryTokens: number;
    compareTokens: number;
    delta: number;
  }>;
  keyDivergences: string[];
  replyComparison?: {
    primaryReplyPreview: string;
    compareReplyPreview: string;
  };
};

export type AndroidDevice = {
  serial: string;
  type: "emulator" | "physical";
  model?: string;
  product?: string;
  state: string;
};

export type AndroidEnvironment = {
  available: boolean;
  adbPath: string | null;
  devices: AndroidDevice[];
  defaultStrategy: "adb_reverse" | "emulator_gateway" | "none";
  summary: string;
};

export type AndroidBridgeResult = {
  success: boolean;
  bridgedDevices: string[];
  forwardingRule: string;
  verification: "active" | "failed" | "unverified";
  error?: string;
};

export type AndroidSecurityResult = {
  cleartextPermitted: boolean;
  manifestFound: boolean;
  manifestPath?: string;
  usesCleartextTraffic?: boolean | null;
  networkSecurityConfigPath?: string;
  configAllowsLocalhost?: boolean;
  risk?: string;
  remediation?: string;
};

export type AndroidBuildStateResult = {
  isAndroidProject: boolean;
  hasBuildArtifacts: boolean;
  latestArtifactPath?: string;
  latestArtifactMtime?: number;
  sourceMtime?: number;
  isStale: boolean;
  summary: string;
};


