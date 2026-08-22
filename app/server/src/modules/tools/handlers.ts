/**
 * Dispatches one MCP CallToolRequest to its gateway (browser_act/inspect/
 * session/bulk/knowledge/dev) and then to that gateway's `action`. Mirrors
 * schemas.ts's TOOLS one-for-one — see that file for what each action
 * does and what params it takes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BenchmarkEngine } from "@browsercontrol/benchmark";
import type { FlowStep, TrajectoryConfig } from "@browsercontrol/shared";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { HAR_DIR } from "../../configs/paths.js";
import { errorMessage } from "../../libs/errorMessage.js";
import {
  ActAction,
  BulkAction,
  DevAction,
  DocsAction,
  Gateway,
  InspectAction,
  KnowledgeAction,
  SessionAction,
} from "../../libs/gateways.js";
import type { ToolCallResponse } from "../../libs/types.js";
import { PREVIEW_CHARS } from "../callLog/constants.js";
import { batchCrawl, crawlExists, getDeepCrawlStatusText, startDeepCrawl } from "../crawl/index.js";
import * as dataStore from "../dataStore/index.js";
import { compileTrajectory } from "../geometry/index.js";
import { getJobStatusText, jobExists, startJob } from "../jobs/index.js";
import type { JobTaskInput } from "../jobs/types.js";
import { findSkillForHostname, listSkills, saveSkill } from "../skills/index.js";
import * as streamSink from "../streamSink/index.js";
import type { ToolHandlerCtx } from "./types.js";

export type { ToolHandlerCtx };

function saveHarToFile(harData: unknown, sessionId: string): string {
  mkdirSync(HAR_DIR, { recursive: true });
  const filename = `session-${sessionId}-${Date.now()}.har`;
  const fullPath = join(HAR_DIR, filename);
  writeFileSync(fullPath, JSON.stringify(harData, null, 2), "utf-8");
  return fullPath;
}

function unknownAction(gateway: string, action: string, valid: readonly string[]): ToolCallResponse {
  return {
    content: [
      {
        type: "text",
        text: `Error: Unknown action "${action}" for ${gateway} (hint: use one of ${valid.join(", ")}.)`,
      },
    ],
    isError: true,
  };
}

/**
 * Mirrors flow.ts's runtime resolveStepTarget logic — a step that needs a
 * target but has neither a selector nor a complete role+name pair resolves
 * to null every single time it runs (role alone or name alone never
 * matches anything). Catching that here, at save time, turns a flow that's
 * silently DOA into an immediate, specific error instead of a confusing
 * "found no element matching X" only discovered whenever someone finally
 * hits Run in the panel.
 */
function findBadFlowStep(steps: FlowStep[]): { index: number; reason: string } | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const needsTarget =
      step.action !== "scroll" &&
      step.action !== "drag" &&
      !(step.action === "press_key" && !step.role && !step.selector);
    if (!needsTarget) continue;
    const hasSelector = typeof step.selector === "string" && step.selector.trim() !== "";
    const hasRoleName =
      typeof step.role === "string" &&
      step.role.trim() !== "" &&
      typeof step.name === "string" &&
      step.name.trim() !== "";
    if (hasSelector || hasRoleName) continue;
    const reason =
      step.role && !hasRoleName
        ? `has role "${step.role}" but no (or empty) name`
        : step.name && !hasRoleName
          ? `has name "${step.name}" but no role`
          : "has neither a selector nor a role+name pair";
    return { index: i, reason };
  }
  return null;
}

export async function handleToolCall(request: CallToolRequest, ctx: ToolHandlerCtx): Promise<ToolCallResponse> {
  const {
    executeCommand,
    sessionId: SESSION_ID,
    inlineImages: INLINE_IMAGES,
    saveScreenshotToFile,
    saveVideoToFile,
  } = ctx;
  const { name, arguments: args } = request.params;
  const action = typeof args?.action === "string" ? args.action : "";
  try {
    let result: unknown;
    switch (name) {
      /**
       * click/type/press_key/scroll/drag each chain several sequential CDP
       * calls (scrollIntoView, getBoxModel, queryAXTree, the actual input
       * dispatch...) behind ONE command. cdp.ts bounds any single one of
       * those at 10s; the default 15000ms executeCommand budget was sized
       * for a typical one-shot CDP round trip and can undercut a legitimate
       * multi-call sequence that hits just one 10s-timed-out call partway
       * through — the daemon's own timer then fires first with a generic
       * "Timeout waiting for Chrome" instead of cdp.ts's specific (and more
       * actionable) per-command error. Bumped 20s across the board; drag
       * gets 25s since performDrag chains the most sequential calls.
       */
      case Gateway.Act:
        switch (action) {
          case ActAction.Click:
            result = await executeCommand("click", { nodeId: args?.nodeId, tabId: args?.tabId }, 20000);
            break;
          case ActAction.Type:
            result = await executeCommand(
              "type",
              { text: args?.text, nodeId: args?.nodeId, tabId: args?.tabId },
              20000,
            );
            break;
          case ActAction.PressKey:
            result = await executeCommand(
              "press_key",
              { key: args?.key, nodeId: args?.nodeId, tabId: args?.tabId },
              20000,
            );
            break;
          case ActAction.Scroll:
            result = await executeCommand(
              "scroll",
              { deltaX: args?.deltaX, deltaY: args?.deltaY, tabId: args?.tabId },
              20000,
            );
            break;
          case ActAction.Drag: {
            const trajectoryConfig: TrajectoryConfig = {
              shape: args?.shape as TrajectoryConfig["shape"],
              fromX: typeof args?.fromX === "number" ? args.fromX : undefined,
              fromY: typeof args?.fromY === "number" ? args.fromY : undefined,
              toX: typeof args?.toX === "number" ? args.toX : undefined,
              toY: typeof args?.toY === "number" ? args.toY : undefined,
              points: args?.path as TrajectoryConfig["points"],
              steps: typeof args?.stepsCount === "number" ? args.stepsCount : undefined,
              easing: args?.easing as TrajectoryConfig["easing"],
              ...((args?.shapeParams as Record<string, unknown> | undefined) ?? {}),
            };
            const points = compileTrajectory(trajectoryConfig);
            result = await executeCommand(
              "drag",
              {
                points,
                fromX: args?.fromX,
                fromY: args?.fromY,
                toX: args?.toX,
                toY: args?.toY,
                button: args?.button,
                tabId: args?.tabId,
              },
              30000,
            );
            break;
          }
          case ActAction.Evaluate:
            result = await executeCommand("evaluate", { expression: args?.expression, tabId: args?.tabId });
            break;
          case ActAction.RunFlow:
            result = await executeCommand(args?.explore ? "explore_flow" : "run_flow", {
              steps: args?.steps,
              tabId: args?.tabId,
              returnSnapshot: args?.returnSnapshot,
            });
            break;
          default:
            return unknownAction(name, action, Object.values(ActAction));
        }
        break;

      case Gateway.Inspect:
        switch (action) {
          case InspectAction.Snapshot: {
            // visual wins if both are set — see the tool description for why selector+visual together isn't supported.
            if (args?.visual) {
              const snap = await executeCommand("visual_snapshot", { tabId: args?.tabId });
              if (!snap?.dataBase64) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error: ${snap?.error ?? "Visual snapshot failed"}${snap?.hint ? ` (${snap.hint})` : ""}`,
                    },
                  ],
                  isError: true,
                };
              }
              const snapFilePath = saveScreenshotToFile(snap.dataBase64 as string, "jpeg");
              return {
                content: [
                  ...(INLINE_IMAGES
                    ? [{ type: "image" as const, data: snap.dataBase64 as string, mimeType: "image/jpeg" }]
                    : []),
                  {
                    type: "text",
                    text: `${snap.message}\nScreenshot saved to ${snapFilePath}${INLINE_IMAGES ? " (also shown above)" : " — open it to see the annotated boxes; inline image content is off by default (see BROWSERCONTROL_INLINE_IMAGES)"}.${snap._flowWarning ? `\n\n[${snap._flowWarning}]` : ""}\n\n${JSON.stringify(snap.nodes, null, 2)}`,
                  },
                ],
              };
            }
            result = args?.selector
              ? await executeCommand("query_region", {
                  selector: args.selector,
                  tabId: args?.tabId,
                  compact: args?.compact,
                })
              : await executeCommand("snapshot", {
                  tabId: args?.tabId,
                  compact: args?.compact,
                  format: args?.compact ? "compact" : undefined,
                });
            break;
          }
          case InspectAction.Find:
            result = await executeCommand("find", { query: args?.query, limit: args?.limit, tabId: args?.tabId });
            break;
          case InspectAction.ReadingMode:
            result = await executeCommand("reading_mode", { maxChars: args?.maxChars, tabId: args?.tabId });
            break;
          case InspectAction.InspectElement:
            result = await executeCommand("inspect_element", { nodeId: args?.nodeId, tabId: args?.tabId });
            break;
          case InspectAction.Screenshot: {
            const shot = await executeCommand("screenshot", {
              fullPage: args?.fullPage,
              format: args?.format,
              quality: args?.quality,
              tabId: args?.tabId,
            });
            if (!shot?.dataBase64) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: ${shot?.error ?? "Screenshot failed"}${shot?.hint ? ` (${shot.hint})` : ""}`,
                  },
                ],
                isError: true,
              };
            }
            const shotFilePath = saveScreenshotToFile(shot.dataBase64 as string, shot.format as string);
            return {
              content: [
                ...(INLINE_IMAGES
                  ? [
                      {
                        type: "image" as const,
                        data: shot.dataBase64 as string,
                        mimeType: shot.format === "png" ? "image/png" : "image/jpeg",
                      },
                    ]
                  : []),
                {
                  type: "text",
                  text: `Captured ${shot.format} screenshot (${args?.fullPage ? "full page" : "viewport"}). Saved to ${shotFilePath}${INLINE_IMAGES ? " (also shown above)" : " — open it to view; inline image content is off by default (see BROWSERCONTROL_INLINE_IMAGES)"}.${shot._flowWarning ? `\n\n[${shot._flowWarning}]` : ""}`,
                },
              ],
            };
          }
          case InspectAction.SelectContent: {
            const sel = await executeCommand("select_content", {
              selector: args?.selector,
              nodeId: args?.nodeId,
              maxChars: args?.maxChars,
              maxMatches: args?.maxMatches,
              tabId: args?.tabId,
            });
            if (sel?.error) {
              return {
                content: [{ type: "text", text: `Error: ${sel.error}${sel.hint ? ` (${sel.hint})` : ""}` }],
                isError: true,
              };
            }
            const blocks = (sel?.blocks as string[] | undefined) ?? [];
            const firstBlock = blocks[0];
            if (blocks.length === 0 || !firstBlock) {
              return { content: [{ type: "text", text: String(sel?.message ?? "No content extracted.") }] };
            }
            const source = args?.selector ? `selector "${args.selector}"` : `nodeId ${args?.nodeId}`;
            // One docs_blocks row per matched element — keeps each individually addressable/searchable instead of one big blob.
            const blockIds: number[] = [];
            let sessionTotalChars = 0;
            for (let i = 0; i < blocks.length; i++) {
              const blockContent = blocks[i];
              if (!blockContent) continue;
              const label = blocks.length > 1 ? `${source} (match ${i + 1}/${blocks.length})` : source;
              const added = dataStore.addDocsBlock(SESSION_ID, blockContent, label);
              blockIds.push(added.blockId);
              sessionTotalChars = added.sessionTotalChars;
            }
            const preview = firstBlock.slice(0, PREVIEW_CHARS);
            return {
              content: [
                {
                  type: "text",
                  text: `Extracted ${blocks.length} of ${sel?.count} matched element(s) from ${source}. Saved as docs block${blockIds.length > 1 ? "s" : ""} [${blockIds.join(", ")}] — this session now has ${sessionTotalChars} docs chars total. Content is NOT included in this response; use browser_knowledge({action:"query_docs", docsAction:"read", blockId:${blockIds[0]}}) to retrieve one, or {docsAction:"search", query:"..."} to search across blocks.${sel?.truncated ? " [truncated at maxChars/maxMatches this call — narrow the selector or raise the caps for more]" : ""}\n\nPreview of first block:\n${preview}${firstBlock.length > PREVIEW_CHARS ? "…" : ""}`,
                },
              ],
            };
          }
          case InspectAction.NetworkRequests:
            result = args?.requestId
              ? await executeCommand("network_request_detail", { requestId: args.requestId, tabId: args?.tabId })
              : await executeCommand("network_requests", {
                  resourceTypes: args?.resourceTypes,
                  filter: args?.filter,
                  limit: args?.limit,
                  tabId: args?.tabId,
                });
            break;
          case InspectAction.NetworkClear:
            result = await executeCommand("network_clear", { tabId: args?.tabId });
            break;
          case InspectAction.PeekScreen: {
            const peek = await executeCommand("peek_screen", {
              screenshot: args?.screenshot,
              maxChars: args?.maxChars,
              tabId: args?.tabId,
            });
            if (peek?.error) {
              return {
                content: [{ type: "text", text: `Error: ${peek.error}${peek.hint ? ` (${peek.hint})` : ""}` }],
                isError: true,
              };
            }
            let shotFilePath: string | undefined;
            if (peek?.screenshotBase64) {
              try {
                shotFilePath = saveScreenshotToFile(peek.screenshotBase64 as string, "jpeg");
              } catch {}
            }
            const isWorkspace = peek?.isWorkspaceTab ? "🤖 AI Workspace" : "Personal / Non-Workspace Tab (Read-Only)";
            let details = `[PEEK ACTIVE SCREEN]\nURL: ${peek?.url}\nTitle: ${peek?.title}\nTab ID: ${peek?.tabId}\nScope: ${isWorkspace}\nPermissions: ${peek?.permissions}`;
            if (peek?.selectedText) details += `\n\n[SELECTION]\n"${peek.selectedText}"`;
            if (peek?.h1) details += `\n\nHeading: ${peek.h1}`;
            if (peek?.text) details += `\n\nPage Text Content (${peek?.textLength} chars):\n${peek.text}`;
            if (shotFilePath) details += `\n\n[SCREENSHOT] saved to: ${shotFilePath}`;

            return {
              content: [
                ...(INLINE_IMAGES && peek?.screenshotBase64
                  ? [{ type: "image" as const, data: peek.screenshotBase64 as string, mimeType: "image/jpeg" as const }]
                  : []),
                { type: "text", text: details },
              ],
            };
          }
          default:
            return unknownAction(name, action, Object.values(InspectAction));
        }
        break;

      case Gateway.Session:
        switch (action) {
          case SessionAction.Navigate: {
            result = await executeCommand("navigate", { url: args?.url, newTab: args?.newTab, tabId: args?.tabId });
            const url = typeof args?.url === "string" ? args.url : undefined;
            if (url) {
              try {
                const hostname = new URL(url).hostname;
                dataStore.recordHostVisit(SESSION_ID, hostname);
                const skill = findSkillForHostname(hostname);
                if (skill)
                  result = {
                    ...(result as Record<string, unknown>),
                    skillHint: `Skill available for this domain: ${skill.path} — read it before exploring.`,
                  };
              } catch {}
            }
            break;
          }
          case SessionAction.ListTabs:
            result = await executeCommand("list_tabs", { scope: args?.scope });
            break;
          case SessionAction.SwitchTab:
            result = await executeCommand("switch_tab", { tabId: args?.tabId });
            break;
          case SessionAction.CloseTab:
            result = await executeCommand("close_tab", { tabId: args?.tabId });
            break;
          case SessionAction.SetSessionName:
            dataStore.setSessionName(SESSION_ID, String(args?.name ?? ""));
            result = { success: true, message: `Session ${SESSION_ID} renamed to "${args?.name}".` };
            break;
          case SessionAction.StartRecording: {
            if (streamSink.isRecordingActive()) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Error: A recording stream is already active. Stop it before starting another.",
                  },
                ],
                isError: true,
              };
            }
            streamSink.startRecordingStream(SESSION_ID);
            let ack: Awaited<ReturnType<typeof executeCommand>>;
            try {
              ack = await executeCommand("start_capture", { tabId: args?.tabId });
            } catch (e) {
              await streamSink.abortRecordingStream();
              return {
                content: [{ type: "text", text: `Error: Failed to start recording (${errorMessage(e)})` }],
                isError: true,
              };
            }
            if (!ack?.success) {
              await streamSink.abortRecordingStream();
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: ${ack?.error ?? "Failed to start recording"}${ack?.hint ? ` (${ack.hint})` : ""}`,
                  },
                ],
                isError: true,
              };
            }
            return {
              content: [
                { type: "text", text: `${ack.message} Call browser_session({action:"stop_recording"}) when done.` },
              ],
            };
          }
          case SessionAction.StopRecording: {
            let rec: Awaited<ReturnType<typeof executeCommand>>;
            try {
              rec = await executeCommand("stop_capture", {}, 60000);
            } catch (e) {
              await streamSink.stopRecordingStream({ commit: false });
              return {
                content: [{ type: "text", text: `Error: Failed to stop recording (${errorMessage(e)})` }],
                isError: true,
              };
            }
            const frameCount = typeof rec?.frameCount === "number" ? rec.frameCount : 0;
            const captureSucceeded = rec?.success === true && frameCount > 0;
            const streamResult = await streamSink.stopRecordingStream({ commit: captureSucceeded });
            if (!captureSucceeded) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: ${rec?.error ?? "Recording produced no real frames"}${rec?.hint ? ` (${rec.hint})` : ""}`,
                  },
                ],
                isError: true,
              };
            }
            if (streamResult && !streamResult.success) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: Failed to finalize recording: ${streamResult.error ?? "unknown write error"}`,
                  },
                ],
                isError: true,
              };
            }
            let recFilePath = streamResult?.filePath;
            if (!recFilePath && rec?.dataBase64) {
              recFilePath = saveVideoToFile(rec.dataBase64 as string, (rec.format as string) || "webm");
            }
            if (!recFilePath) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: ${rec?.error ?? "Failed to stop recording"}${rec?.hint ? ` (${rec.hint})` : ""}`,
                  },
                ],
                isError: true,
              };
            }
            const durationMs = streamResult?.durationMs ?? (rec?.durationMs as number) ?? 0;
            const seconds = (durationMs / 1000).toFixed(1);
            const frameNote = ` (${frameCount} frames)`;
            return {
              content: [
                {
                  type: "text",
                  text: `Saved ${seconds}s webm recording to ${recFilePath}${frameNote}. To see what actions were taken during the recording, check data/logs/session-*.jsonl for entries in that time window.${rec?._flowWarning ? `\n\n[${rec._flowWarning}]` : ""}`,
                },
              ],
            };
          }
          case SessionAction.GetMetrics: {
            const targetSessionId = args?.allSessions ? undefined : SESSION_ID;
            const raw = dataStore.getBenchmarkMetrics(targetSessionId);
            // For MCP tool response to Agent, return lean summary without 100 raw JSON logs
            result = {
              summary: raw.summary,
              tokenSavings: raw.tokenSavings,
              byCommand: raw.byCommand,
              recentCallsCount: raw.recentCalls.length,
              recentCalls: raw.recentCalls.slice(0, 5).map((c) => ({
                cmd: c.cmd,
                durationMs: c.durationMs,
                approxTokens: c.approxTokens,
                isError: c.isError,
                argsSummary: c.argsSummary,
              })),
            };
            break;
          }
          default:
            return unknownAction(name, action, Object.values(SessionAction));
        }
        break;

      case Gateway.Bulk:
        switch (action) {
          case BulkAction.BatchCrawl: {
            const urls = (args?.urls as string[] | undefined) ?? [];
            if (urls.length === 0) {
              return {
                content: [{ type: "text", text: "Error: Missing urls array to crawl." }],
                isError: true,
              };
            }
            const start = performance.now();
            const items = await batchCrawl(urls, {
              concurrency: typeof args?.concurrency === "number" ? args.concurrency : undefined,
              maxCharsPerUrl: typeof args?.maxCharsPerUrl === "number" ? args.maxCharsPerUrl : undefined,
            });
            const durationMs = Math.round(performance.now() - start);

            const successfulItems = items.filter((i) => !i.error && i.status >= 200 && i.status < 300);
            const formattedBlocks = successfulItems.map((item) => {
              const metaLines = [
                `# [${item.title || item.url}](${item.url})`,
                `> **Source URL**: \`${item.url}\``,
                `> **Crawled At**: \`${new Date().toISOString()}\` | **Latency**: \`${item.fetchDurationMs}ms\` | **Reading Time**: \`${item.readingTime || "N/A"}\``,
                ...(item.author ? [`> **Author**: ${item.author}`] : []),
                ...(item.publishedTime ? [`> **Published**: ${item.publishedTime}`] : []),
                ...(item.description ? [`> **Summary**: ${item.description}`] : []),
                "",
                item.text,
              ];
              return metaLines.join("\n");
            });

            let fileReport = "";
            if (formattedBlocks.length > 0) {
              const blockIds: number[] = [];
              let sessionTotalChars = 0;
              for (let i = 0; i < formattedBlocks.length; i++) {
                const blockContent = formattedBlocks[i];
                const item = successfulItems[i];
                if (!blockContent || !item) continue;
                const added = dataStore.addDocsBlock(SESSION_ID, blockContent, item.url, item.title || item.url);
                blockIds.push(added.blockId);
                sessionTotalChars = added.sessionTotalChars;
              }
              fileReport = `\nSaved ${blockIds.length} docs block(s) [${blockIds.join(", ")}] — this session now has ${sessionTotalChars} docs chars total. Query via browser_knowledge({action:"query_docs"}).`;
            }

            const summaryLines = [
              `[BATCH] Crawled ${items.length} URL(s) in ${durationMs}ms: ${successfulItems.length} succeeded, ${items.length - successfulItems.length} failed.${fileReport}`,
              `[STATS] Throughput: ${durationMs > 0 ? ((items.length / durationMs) * 1000).toFixed(2) : 0} pages/s | Avg Latency: ${Math.round(durationMs / Math.max(1, items.length))}ms/page`,
              "",
              "### Crawl Results Summary:",
              ...items.map((item, idx) => {
                if (!item.error && item.status >= 200 && item.status < 300) {
                  return `${idx + 1}. [OK] [${item.title || item.url}](${item.url}) — ${item.fetchDurationMs}ms | ${item.readingTime || `${item.text.length} chars`}`;
                }
                return `${idx + 1}. [FAIL] ${item.url} — ${item.error || `HTTP ${item.status}`}`;
              }),
            ];

            return {
              content: [
                {
                  type: "text",
                  text: summaryLines.join("\n"),
                },
              ],
            };
          }
          case BulkAction.Search:
            result = await executeCommand("web_search", { query: args?.query, limit: args?.limit });
            break;
          case BulkAction.DeepCrawl: {
            const started = startDeepCrawl(
              {
                seedUrls: args?.seedUrls as string[] | undefined,
                searchQuery: args?.searchQuery as string | undefined,
                depth: args?.depth as number | undefined,
                maxPages: args?.maxPages as number | undefined,
                maxOutlinksPerPage: args?.maxOutlinksPerPage as number | undefined,
                concurrency: args?.concurrency as number | undefined,
                maxCharsPerUrl: args?.maxCharsPerUrl as number | undefined,
              },
              executeCommand,
              SESSION_ID,
            );
            if ("error" in started) {
              return {
                content: [{ type: "text", text: `Error: ${started.error} (${started.hint})` }],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Started deep crawl ${started.crawlId} (depth ${started.depth}, up to ${started.maxPages} pages, ${started.concurrency} concurrent workers) running in the background. Poll browser_bulk({action:"task_status", taskId: "${started.crawlId}"}) for progress — don't wait here.`,
                },
              ],
            };
          }
          case BulkAction.StartJob: {
            const rawTasks = (args?.tasks as JobTaskInput[] | undefined) ?? [];
            const started = startJob(rawTasks, Number(args?.concurrency) || undefined, executeCommand, SESSION_ID);
            if ("error" in started) {
              return {
                content: [{ type: "text", text: `Error: ${started.error} (${started.hint})` }],
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: `Started job ${started.jobId} with ${started.total} task(s) running in the background. Poll browser_bulk({action:"task_status", taskId: "${started.jobId}"}) for progress — don't wait here, this call is meant to return immediately.`,
                },
              ],
            };
          }
          case BulkAction.TaskStatus: {
            const taskId = String(args?.taskId ?? "");
            result = jobExists(taskId)
              ? getJobStatusText(taskId)
              : crawlExists(taskId)
                ? getDeepCrawlStatusText(taskId)
                : `No task with id "${taskId}" — it may have already completed and been cleaned up (a task is dropped once you've seen its last result), or the id is wrong.`;
            break;
          }
          default:
            return unknownAction(name, action, Object.values(BulkAction));
        }
        break;

      case Gateway.Knowledge:
        switch (action) {
          case KnowledgeAction.ListSkills:
            result = {
              skills: listSkills({
                domain: args?.domain as string | undefined,
                query: args?.query as string | undefined,
              }),
            };
            break;
          case KnowledgeAction.SaveSkill:
            result = saveSkill(args ?? {});
            break;
          case KnowledgeAction.ListFlows:
            result = { flows: dataStore.listFlows({ domain: args?.domain as string | undefined }) };
            break;
          case KnowledgeAction.SaveFlow: {
            const flowName = typeof args?.name === "string" ? args.name : "";
            const steps = Array.isArray(args?.steps) ? args.steps : undefined;
            if (!flowName || !steps || steps.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: Missing name or steps (hint: action:"save_flow" needs a non-empty \`name\` and a non-empty \`steps\` array, same shape as browser_act's run_flow.)`,
                  },
                ],
                isError: true,
              };
            }
            const flowSteps = steps as FlowStep[];
            const badStep = findBadFlowStep(flowSteps);
            if (badStep) {
              const badStepItem = flowSteps[badStep.index];
              const badAction = badStepItem?.action;
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: Step ${badStep.index} (${badAction}) ${badStep.reason} — it will never resolve at run time (role alone or name alone never matches anything). Re-check against a fresh inspect.snapshot/act.run_flow({explore:true}) and pass a complete role+name pair or a CSS selector before saving.`,
                  },
                ],
                isError: true,
              };
            }
            const saved = dataStore.saveFlow({
              id: typeof args?.id === "string" ? args.id : undefined,
              name: flowName,
              description: typeof args?.description === "string" ? args.description : undefined,
              domain: typeof args?.domain === "string" ? args.domain : undefined,
              steps: flowSteps,
            });
            result = {
              ...saved,
              message: `Saved flow "${saved.name}" (id ${saved.id}) — it now shows up in the extension's side panel.`,
            };
            break;
          }
          case KnowledgeAction.DeleteFlow: {
            const id = typeof args?.id === "string" ? args.id : "";
            if (!id) {
              return {
                content: [{ type: "text", text: `Error: Missing id (hint: get it from action:"list_flows".)` }],
                isError: true,
              };
            }
            const deleted = dataStore.deleteFlow(id);
            if (!deleted) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: No flow with id "${id}" (hint: call action:"list_flows" to see valid ids.)`,
                  },
                ],
                isError: true,
              };
            }
            result = { success: true, message: `Deleted flow ${id}.` };
            break;
          }
          case KnowledgeAction.RecordFlow: {
            const mode = typeof args?.mode === "string" ? args.mode : "status";
            if (mode === "start") {
              result = await executeCommand("start_flow_recording", { domain: args?.domain });
            } else if (mode === "stop") {
              const res = (await executeCommand("stop_flow_recording")) as {
                steps: FlowStep[];
                domain: string;
                stepCount: number;
                durationMs: number;
              };
              if (args?.name && typeof args.name === "string" && res.steps && res.steps.length > 0) {
                const saved = dataStore.saveFlow({
                  name: args.name,
                  description: typeof args?.description === "string" ? args.description : undefined,
                  domain: res.domain || (typeof args?.domain === "string" ? args.domain : undefined),
                  steps: res.steps,
                });
                result = { success: true, savedFlow: saved, ...res };
              } else {
                result = res;
              }
            } else {
              result = await executeCommand("flow_recording_status");
            }
            break;
          }
          case KnowledgeAction.QueryDocs: {
            const docsAction = String(args?.docsAction ?? "");
            const scopeSessionId = args?.allSessions ? undefined : SESSION_ID;
            switch (docsAction) {
              case DocsAction.List: {
                const blocks = dataStore.listDocsBlocks({
                  sessionId: scopeSessionId,
                  limit: Number(args?.limit) || undefined,
                });
                result = { blocks };
                break;
              }
              case DocsAction.Search: {
                const query = typeof args?.query === "string" ? args.query : "";
                if (!query) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Error: Missing query (hint: docsAction:"search" needs a \`query\` string.)`,
                      },
                    ],
                    isError: true,
                  };
                }
                const blocks = dataStore.searchDocsBlocks(query, {
                  sessionId: scopeSessionId,
                  limit: Number(args?.limit) || undefined,
                });
                result = { blocks };
                break;
              }
              case DocsAction.Read: {
                const blockId = Number(args?.blockId);
                if (!Number.isFinite(blockId)) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Error: Missing blockId (hint: docsAction:"read" needs a \`blockId\` from a prior 'list' or 'search' result.)`,
                      },
                    ],
                    isError: true,
                  };
                }
                const block = dataStore.getDocsBlock(blockId);
                if (!block) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Error: No docs block with id ${blockId} (hint: it may belong to a different session — retry with allSessions:true, or it never existed.)`,
                      },
                    ],
                    isError: true,
                  };
                }
                result = { ...block };
                break;
              }
              default:
                return {
                  content: [
                    {
                      type: "text",
                      text: `Error: Unknown docsAction "${docsAction}" (hint: use "list", "search", or "read".)`,
                    },
                  ],
                  isError: true,
                };
            }
            break;
          }
          default:
            return unknownAction(name, action, Object.values(KnowledgeAction));
        }
        break;

      case Gateway.Dev:
        switch (action) {
          case DevAction.InspectMemory:
            result = await executeCommand("dev_memory", { focus: args?.focus, tabId: args?.tabId });
            break;
          case DevAction.InspectProcess:
            result = await executeCommand("dev_process", { focus: args?.focus, tabId: args?.tabId });
            break;
          case DevAction.AnalyzeHar:
            result = await executeCommand("dev_har", {
              filter: args?.filter,
              includeBodies: args?.includeBodies,
              tabId: args?.tabId,
            });
            if (result && typeof result === "object" && "overview" in result) {
              result = (result as Record<string, unknown>).overview;
            }
            break;
          case DevAction.ExportHar: {
            const raw = await executeCommand("dev_har", {
              filter: args?.filter,
              includeBodies: args?.includeBodies,
              tabId: args?.tabId,
            });
            if (raw?.harLog) {
              const filePath = saveHarToFile(raw.harLog, SESSION_ID);
              result = {
                message: `Exported HAR 1.2 archive with ${(raw.harLog as { entries: unknown[] }).entries.length} requests.`,
                filePath,
                overview: raw.overview,
              };
            } else {
              result = raw;
            }
            break;
          }
          case DevAction.DebugLayout:
            result = await executeCommand("dev_layout", {
              selector: args?.selector,
              nodeId: args?.nodeId,
              focus: args?.focus,
              tabId: args?.tabId,
            });
            break;
          case DevAction.Emulate:
            result = await executeCommand("dev_emulate", {
              device: args?.device,
              network: args?.network,
              cpuSlowdown: args?.cpuSlowdown,
              touch: args?.touch,
              tabId: args?.tabId,
            });
            break;
          case DevAction.Sandbox: {
            const mode = args?.mode;
            if (mode !== "block_mutations" && mode !== "off") {
              return {
                content: [{ type: "text", text: `Error: action 'sandbox' requires mode: 'block_mutations' or 'off'.` }],
                isError: true,
              };
            }
            result = await executeCommand("dev_sandbox", { mode, tabId: args?.tabId });
            break;
          }
          case DevAction.BenchmarkReport: {
            const sid = typeof args?.sessionId === "string" && args.sessionId ? args.sessionId : SESSION_ID;
            const metrics = dataStore.getBenchmarkMetrics(sid);
            if (args?.format === "json") {
              result = metrics;
            } else {
              const focus =
                typeof args?.focus === "string"
                  ? (args.focus as "overview" | "telemetry" | "commands" | "full")
                  : "overview";
              result = BenchmarkEngine.formatMarkdownReport(metrics, focus);
            }
            break;
          }
          default:
            return unknownAction(name, action, Object.values(DevAction));
        }
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${errorMessage(error)}` }],
      isError: true,
    };
  }
}
