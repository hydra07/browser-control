/**
 * The MCP gateway surface as enums instead of hand-typed string literals —
 * modules/tools/schemas.ts's inputSchema `enum` arrays and
 * modules/tools/handlers.ts's switch cases both read off these, so a typo
 * or a drifted action name between the two is a compile error instead of
 * a silent "Unknown action" at runtime (see AGENTS.md's gateway-tool
 * pattern note on nothing else enforcing this).
 */

export const Gateway = {
  Act: "browser_act",
  Inspect: "browser_inspect",
  Session: "browser_session",
  Bulk: "browser_bulk",
  Knowledge: "browser_knowledge",
  Dev: "browser_dev",
} as const;
export type Gateway = (typeof Gateway)[keyof typeof Gateway];

export const ActAction = {
  Click: "click",
  Type: "type",
  PressKey: "press_key",
  Scroll: "scroll",
  Drag: "drag",
  Evaluate: "evaluate",
  RunFlow: "run_flow",
} as const;
export type ActAction = (typeof ActAction)[keyof typeof ActAction];

export const InspectAction = {
  Snapshot: "snapshot",
  Find: "find",
  ReadingMode: "reading_mode",
  InspectElement: "inspect_element",
  Screenshot: "screenshot",
  SelectContent: "select_content",
  NetworkRequests: "network_requests",
  NetworkClear: "network_clear",
  PeekScreen: "peek_screen",
} as const;
export type InspectAction = (typeof InspectAction)[keyof typeof InspectAction];

export const SessionAction = {
  Navigate: "navigate",
  ListTabs: "list_tabs",
  SwitchTab: "switch_tab",
  CloseTab: "close_tab",
  SetSessionName: "set_session_name",
  StartRecording: "start_recording",
  StopRecording: "stop_recording",
  GetMetrics: "get_metrics",
} as const;
export type SessionAction = (typeof SessionAction)[keyof typeof SessionAction];

export const BulkAction = {
  BatchCrawl: "batch_crawl",
  Search: "search",
  DeepCrawl: "deep_crawl",
  StartJob: "start_job",
  TaskStatus: "task_status",
} as const;
export type BulkAction = (typeof BulkAction)[keyof typeof BulkAction];

export const KnowledgeAction = {
  ListSkills: "list_skills",
  SaveSkill: "save_skill",
  ListFlows: "list_flows",
  SaveFlow: "save_flow",
  DeleteFlow: "delete_flow",
  QueryDocs: "query_docs",
} as const;
export type KnowledgeAction = (typeof KnowledgeAction)[keyof typeof KnowledgeAction];

export const DevAction = {
  InspectMemory: "inspect_memory",
  InspectProcess: "inspect_process",
  AnalyzeHar: "analyze_har",
  ExportHar: "export_har",
  DebugLayout: "debug_layout",
  Emulate: "emulate",
  Sandbox: "sandbox",
} as const;
export type DevAction = (typeof DevAction)[keyof typeof DevAction];

/** browser_knowledge's query_docs action has its own sub-action field (`docsAction`), never reusing the gateway's own `action` name — see AGENTS.md. */
export const DocsAction = {
  List: "list",
  Search: "search",
  Read: "read",
} as const;
export type DocsAction = (typeof DocsAction)[keyof typeof DocsAction];
