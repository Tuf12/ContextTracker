export type RouteMode = "auto" | "custom";

export type RouteSettings = {
  mode: RouteMode;
  customUpstream: string;
};

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

export type SpanSource = "matched" | "reported";

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
};

export type AddressOffer = {
  relativeFile: string;
  line: number;
  url: string;
  reason: string;
};

export type HelperModelChoice = {
  id: string;
  label: string;
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
