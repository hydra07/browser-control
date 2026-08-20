// Dispatches one MCP CallToolRequest to its gateway (browser_act/inspect/
// session/bulk/knowledge) and then to that gateway's `action`. Mirrors
// toolSchemas.ts's TOOLS one-for-one — see that file for what each action
// does and what params it takes.

import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as dataStore from "./dataStore.js";
import { listSkills, saveSkill, findSkillForHostname } from "./skills.js";
import { startJob, getJobStatusText, jobExists } from "./jobs.js";
import type { JobTaskInput, Executor } from "./jobs.js";
import { startDeepCrawl, getDeepCrawlStatusText, crawlExists } from "./crawl.js";
import { PREVIEW_CHARS } from "./callLog.js";
import type { CommandResult, ToolCallResponse } from "./types.js";
import type { FlowStep } from "@browsercontrol/shared";

function saveHarToFile(harData: unknown, sessionId: string): string {
  const dir = join(process.cwd(), "data", "har");
  mkdirSync(dir, { recursive: true });
  const filename = `session-${sessionId}-${Date.now()}.har`;
  const fullPath = join(dir, filename);
  writeFileSync(fullPath, JSON.stringify(harData, null, 2), "utf-8");
  return fullPath;
}

/** What handleToolCall needs from daemon.ts, passed in rather than imported — same reasoning as jobs.ts/crawl.ts's Executor param: this module shouldn't have to import daemon.ts (which imports this one). */
export interface ToolHandlerCtx {
  executeCommand: Executor;
  sessionId: string;
  inlineImages: boolean;
  saveScreenshotToFile: (dataBase64: string, format: string) => string;
  saveVideoToFile: (dataBase64: string, format: string) => string;
}

function unknownAction(gateway: string, action: string, valid: readonly string[]): ToolCallResponse {
  return {
    content: [{ type: "text", text: `Error: Unknown action "${action}" for ${gateway} (hint: use one of ${valid.join(", ")}.)` }],
    isError: true,
  };
}

// Mirrors flow.ts's runtime resolveStepTarget logic — a step that needs a
// target but has neither a selector nor a complete role+name pair resolves
// to null every single time it runs (role alone or name alone never
// matches anything). Catching that here, at save time, turns a flow that's
// silently DOA into an immediate, specific error instead of a confusing
// "found no element matching X" only discovered whenever someone finally
// hits Run in the panel.
function findBadFlowStep(steps: FlowStep[]): { index: number; reason: string } | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const needsTarget =
      step.action !== "scroll" &&
      step.action !== "drag" &&
      !(step.action === "press_key" && !step.role && !step.selector);
    if (!needsTarget) continue;
    const hasSelector = typeof step.selector === "string" && step.selector.trim() !== "";
    const hasRoleName =
      typeof step.role === "string" && step.role.trim() !== "" &&
      typeof step.name === "string" && step.name.trim() !== "";
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
  const { executeCommand, sessionId: SESSION_ID, inlineImages: INLINE_IMAGES, saveScreenshotToFile, saveVideoToFile } = ctx;
  const { name, arguments: args } = request.params;
  const action = typeof args?.action === "string" ? args.action : "";
  try {
    let result: unknown;
    switch (name) {
      // click/type/press_key/scroll/drag each chain several sequential CDP
      // calls (scrollIntoView, getBoxModel, queryAXTree, the actual input
      // dispatch...) behind ONE command. cdp.ts bounds any single one of
      // those at 10s; the default 15000ms executeCommand budget was sized
      // for a typical one-shot CDP round trip and can undercut a legitimate
      // multi-call sequence that hits just one 10s-timed-out call partway
      // through — the daemon's own timer then fires first with a generic
      // "Timeout waiting for Chrome" instead of cdp.ts's specific (and more
      // actionable) per-command error. Bumped 20s across the board; drag
      // gets 25s since performDrag chains the most sequential calls.
      case "browser_act": switch (action) {
        case "click":
          result = await executeCommand("click", { nodeId: args?.nodeId, tabId: args?.tabId }, 20000);
          break;
        case "type":
          result = await executeCommand("type", { text: args?.text, nodeId: args?.nodeId, tabId: args?.tabId }, 20000);
          break;
        case "press_key":
          result = await executeCommand("press_key", { key: args?.key, nodeId: args?.nodeId, tabId: args?.tabId }, 20000);
          break;
        case "scroll":
          result = await executeCommand("scroll", { deltaX: args?.deltaX, deltaY: args?.deltaY, tabId: args?.tabId }, 20000);
          break;
        case "drag":
          result = await executeCommand("drag", {
            fromX: args?.fromX,
            fromY: args?.fromY,
            toX: args?.toX,
            toY: args?.toY,
            shape: args?.shape,
            shapeParams: args?.shapeParams,
            path: args?.path,
            stepsCount: args?.stepsCount,
            easing: args?.easing,
            button: args?.button,
            tabId: args?.tabId,
          }, 30000);
          break;
        case "evaluate":
          result = await executeCommand("evaluate", { expression: args?.expression, tabId: args?.tabId });
          break;
        case "run_flow":
          result = await executeCommand(args?.explore ? "explore_flow" : "run_flow", {
            steps: args?.steps,
            tabId: args?.tabId,
            returnSnapshot: args?.returnSnapshot,
          });
          break;
        default:
          return unknownAction(name, action, ["click", "type", "press_key", "scroll", "drag", "evaluate", "run_flow"]);
      } break;

      case "browser_inspect": switch (action) {
        case "snapshot": {
          // visual wins if both are set — see the tool description for why
          // selector+visual together isn't supported.
          if (args?.visual) {
            const snap = await executeCommand("visual_snapshot", { tabId: args?.tabId });
            if (!snap?.dataBase64) {
              return {
                content: [{ type: "text", text: `Error: ${snap?.error ?? 'Visual snapshot failed'}${snap?.hint ? ` (${snap.hint})` : ''}` }],
                isError: true,
              };
            }
            const snapFilePath = saveScreenshotToFile(snap.dataBase64 as string, 'jpeg');
            return {
              content: [
                ...(INLINE_IMAGES ? [{ type: "image" as const, data: snap.dataBase64 as string, mimeType: 'image/jpeg' }] : []),
                { type: "text", text: `${snap.message}\nScreenshot saved to ${snapFilePath}${INLINE_IMAGES ? " (also shown above)" : " — open it to see the annotated boxes; inline image content is off by default (see BROWSERCONTROL_INLINE_IMAGES)"}.${snap._flowWarning ? `\n\n[${snap._flowWarning}]` : ''}\n\n${JSON.stringify(snap.nodes, null, 2)}` },
              ],
            };
          }
          result = args?.selector
            ? await executeCommand("query_region", { selector: args.selector, tabId: args?.tabId, compact: args?.compact })
            : await executeCommand("snapshot", { tabId: args?.tabId, compact: args?.compact, format: args?.compact ? "compact" : undefined });
          break;
        }
        case "find":
          result = await executeCommand("find", { query: args?.query, limit: args?.limit, tabId: args?.tabId });
          break;
        case "reading_mode":
          result = await executeCommand("reading_mode", { maxChars: args?.maxChars, tabId: args?.tabId });
          break;
        case "inspect_element":
          result = await executeCommand("inspect_element", { nodeId: args?.nodeId, tabId: args?.tabId });
          break;
        case "screenshot": {
          const shot = await executeCommand("screenshot", {
            fullPage: args?.fullPage,
            format: args?.format,
            quality: args?.quality,
            tabId: args?.tabId,
          });
          if (!shot?.dataBase64) {
            return {
              content: [{ type: "text", text: `Error: ${shot?.error ?? 'Screenshot failed'}${shot?.hint ? ` (${shot.hint})` : ''}` }],
              isError: true,
            };
          }
          const shotFilePath = saveScreenshotToFile(shot.dataBase64 as string, shot.format as string);
          return {
            content: [
              ...(INLINE_IMAGES ? [{ type: "image" as const, data: shot.dataBase64 as string, mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg' }] : []),
              { type: "text", text: `Captured ${shot.format} screenshot (${args?.fullPage ? 'full page' : 'viewport'}). Saved to ${shotFilePath}${INLINE_IMAGES ? " (also shown above)" : " — open it to view; inline image content is off by default (see BROWSERCONTROL_INLINE_IMAGES)"}.${shot._flowWarning ? `\n\n[${shot._flowWarning}]` : ''}` },
            ],
          };
        }
        case "select_content": {
          const sel = await executeCommand("select_content", {
            selector: args?.selector,
            nodeId: args?.nodeId,
            maxChars: args?.maxChars,
            maxMatches: args?.maxMatches,
            tabId: args?.tabId,
          });
          if (sel?.error) {
            return {
              content: [{ type: "text", text: `Error: ${sel.error}${sel.hint ? ` (${sel.hint})` : ''}` }],
              isError: true,
            };
          }
          const blocks = (sel?.blocks as string[] | undefined) ?? [];
          if (blocks.length === 0) {
            return { content: [{ type: "text", text: String(sel?.message ?? "No content extracted.") }] };
          }
          const source = args?.selector ? `selector "${args.selector}"` : `nodeId ${args?.nodeId}`;
          // One docs_blocks row per matched element, not one call joining all
          // of them together — keeps each block individually addressable/
          // searchable via browser_knowledge's query_docs instead of every
          // match from a broad selector landing in one big blob.
          const blockIds: number[] = [];
          let sessionTotalChars = 0;
          for (let i = 0; i < blocks.length; i++) {
            const label = blocks.length > 1 ? `${source} (match ${i + 1}/${blocks.length})` : source;
            const added = dataStore.addDocsBlock(SESSION_ID, blocks[i], label);
            blockIds.push(added.blockId);
            sessionTotalChars = added.sessionTotalChars;
          }
          const preview = blocks[0].slice(0, PREVIEW_CHARS);
          return {
            content: [{
              type: "text",
              text: `Extracted ${blocks.length} of ${sel?.count} matched element(s) from ${source}. Saved as docs block${blockIds.length > 1 ? 's' : ''} [${blockIds.join(', ')}] — this session now has ${sessionTotalChars} docs chars total. Content is NOT included in this response; use browser_knowledge({action:"query_docs", docsAction:"read", blockId:${blockIds[0]}}) to retrieve one, or {docsAction:"search", query:"..."} to search across blocks.${sel?.truncated ? ' [truncated at maxChars/maxMatches this call — narrow the selector or raise the caps for more]' : ''}\n\nPreview of first block:\n${preview}${blocks[0].length > PREVIEW_CHARS ? '…' : ''}`,
            }],
          };
        }
        case "network_requests":
          result = args?.requestId
            ? await executeCommand("network_request_detail", { requestId: args.requestId, tabId: args?.tabId })
            : await executeCommand("network_requests", { resourceTypes: args?.resourceTypes, filter: args?.filter, limit: args?.limit, tabId: args?.tabId });
          break;
        case "network_clear":
          result = await executeCommand("network_clear", { tabId: args?.tabId });
          break;
        default:
          return unknownAction(name, action, ["snapshot", "find", "reading_mode", "inspect_element", "screenshot", "select_content", "network_requests", "network_clear"]);
      } break;

      case "browser_session": switch (action) {
        case "navigate": {
          result = await executeCommand("navigate", { url: args?.url, newTab: args?.newTab, tabId: args?.tabId });
          const url = typeof args?.url === "string" ? args.url : undefined;
          if (url) {
            try {
              const hostname = new URL(url).hostname;
              dataStore.recordHostVisit(SESSION_ID, hostname);
              const skill = findSkillForHostname(hostname);
              if (skill) result = { ...(result as Record<string, unknown>), skillHint: `Skill available for this domain: ${skill.path} — read it before exploring.` };
            } catch {}
          }
          break;
        }
        case "list_tabs":
          result = await executeCommand("list_tabs");
          break;
        case "switch_tab":
          result = await executeCommand("switch_tab", { tabId: args?.tabId });
          break;
        case "close_tab":
          result = await executeCommand("close_tab", { tabId: args?.tabId });
          break;
        case "set_session_name":
          dataStore.setSessionName(SESSION_ID, String(args?.name ?? ""));
          result = { success: true, message: `Session ${SESSION_ID} renamed to "${args?.name}".` };
          break;
        case "start_recording": {
          const ack = await executeCommand("start_capture");
          if (!ack?.success) {
            return {
              content: [{ type: "text", text: `Error: ${ack?.error ?? 'Failed to start recording'}${ack?.hint ? ` (${ack.hint})` : ''}` }],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: `${ack.message} Call browser_session({action:"stop_recording"}) when done.` }] };
        }
        case "stop_recording": {
          // Longer timeout than the 15s default: this has to flush the
          // MediaRecorder and base64-encode a multi-MB blob before it can
          // respond, not just round-trip a CDP call.
          const rec = await executeCommand("stop_capture", {}, 60000);
          if (!rec?.dataBase64) {
            return {
              content: [{ type: "text", text: `Error: ${rec?.error ?? 'Failed to stop recording'}${rec?.hint ? ` (${rec.hint})` : ''}` }],
              isError: true,
            };
          }
          const recFilePath = saveVideoToFile(rec.dataBase64 as string, rec.format as string);
          const seconds = ((rec.durationMs as number) / 1000).toFixed(1);
          const frameNote = rec.frameCount === 0 ? " Warning: 0 frames captured — the page may not have repainted during the recording, or the screencast never started; check the daemon log." : ` (${rec.frameCount} frames)`;
          return {
            content: [{ type: "text", text: `Saved ${seconds}s ${rec.format} recording to ${recFilePath}${frameNote}. To see what actions were taken during the recording, check data/logs/session-*.jsonl for entries in that time window.${rec._flowWarning ? `\n\n[${rec._flowWarning}]` : ''}` }],
          };
        }
        case "get_metrics": {
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
          return unknownAction(name, action, ["navigate", "list_tabs", "switch_tab", "close_tab", "set_session_name", "start_recording", "stop_recording", "get_metrics"]);
      } break;

      case "browser_bulk": switch (action) {
        case "batch_crawl": {
          const crawl = await executeCommand("batch_crawl", {
            urls: args?.urls,
            concurrency: args?.concurrency,
            maxCharsPerUrl: args?.maxCharsPerUrl,
          }, 60000);
          if (crawl?.error) {
            return {
              content: [{ type: "text", text: `Error: ${crawl.error}${crawl.hint ? ` (${crawl.hint})` : ''}` }],
              isError: true,
            };
          }
          const items = (crawl?.items as Array<{
            url: string;
            status: string;
            fetchDurationMs?: number;
            title?: string;
            byline?: string;
            publishedTime?: string;
            readingTime?: string;
            description?: string;
            markdown?: string;
            length?: number;
            error?: string;
          }> | undefined) ?? [];

          const successfulItems = items.filter((i) => i.status === "success" && i.markdown);
          const formattedBlocks = successfulItems.map((item) => {
            const metaLines = [
              `# [${item.title || item.url}](${item.url})`,
              `> 🌐 **Source URL**: \`${item.url}\``,
              `> ⏱️ **Crawled At**: \`${new Date().toISOString()}\` | **Latency**: \`${item.fetchDurationMs ?? 0}ms\` | **Reading Time**: \`${item.readingTime || 'N/A'}\``,
              ...(item.byline ? [`> 👤 **Author**: ${item.byline}`] : []),
              ...(item.publishedTime ? [`> 📅 **Published**: ${item.publishedTime}`] : []),
              ...(item.description ? [`> 💬 **Summary**: ${item.description}`] : []),
              "",
              item.markdown,
            ];
            return metaLines.join("\n");
          });

          let fileReport = "";
          if (formattedBlocks.length > 0) {
            // One row per crawled URL (not one call joining all of them) —
            // same reasoning as browser_inspect's select_content above.
            const blockIds: number[] = [];
            let sessionTotalChars = 0;
            for (let i = 0; i < formattedBlocks.length; i++) {
              const item = successfulItems[i];
              const added = dataStore.addDocsBlock(SESSION_ID, formattedBlocks[i], item.url, item.title || item.url);
              blockIds.push(added.blockId);
              sessionTotalChars = added.sessionTotalChars;
            }
            fileReport = `\nSaved ${blockIds.length} docs block(s) [${blockIds.join(', ')}] — this session now has ${sessionTotalChars} docs chars total. Query via browser_knowledge({action:"query_docs"}).`;
          }

          const summaryLines = [
            `⚡ Batch crawled ${crawl?.totalProcessed ?? items.length} URL(s) in ${crawl?.durationMs}ms: ${crawl?.successful} succeeded, ${crawl?.failed} failed${crawl?.duplicatesSkipped ? ` (${crawl.duplicatesSkipped} duplicates skipped)` : ''}.${fileReport}`,
            `📊 Throughput: ${crawl?.throughputPagesPerSec ?? 0} pages/s | Avg Latency: ${crawl?.avgFetchLatencyMs ?? 0}ms/page | Discovered Outlinks: ${(crawl?.discoveredOutlinks as string[])?.length ?? 0}`,
            "",
            "### Crawl Results Summary:",
            ...items.map((item, idx) => {
              if (item.status === "success") {
                return `${idx + 1}. ✅ [${item.title || item.url}](${item.url}) — ${item.fetchDurationMs ? `${item.fetchDurationMs}ms | ` : ''}${item.readingTime || `${item.length} chars`}`;
              } else if (item.status === "skipped_duplicate") {
                return `${idx + 1}. ⏭️ ${item.url} (skipped duplicate)`;
              } else {
                return `${idx + 1}. ❌ ${item.url} — ${item.error || "Failed"}`;
              }
            }),
          ];

          return {
            content: [{
              type: "text",
              text: summaryLines.join("\n"),
            }],
          };
        }
        case "search":
          result = await executeCommand("web_search", { query: args?.query, limit: args?.limit });
          break;
        case "deep_crawl": {
          const started = startDeepCrawl({
            seedUrls: args?.seedUrls as string[] | undefined,
            searchQuery: args?.searchQuery as string | undefined,
            depth: args?.depth as number | undefined,
            maxPages: args?.maxPages as number | undefined,
            maxOutlinksPerPage: args?.maxOutlinksPerPage as number | undefined,
            concurrency: args?.concurrency as number | undefined,
            maxCharsPerUrl: args?.maxCharsPerUrl as number | undefined,
          }, executeCommand, SESSION_ID);
          if ("error" in started) {
            return {
              content: [{ type: "text", text: `Error: ${started.error} (${started.hint})` }],
              isError: true,
            };
          }
          return {
            content: [{
              type: "text",
              text: `Started deep crawl ${started.crawlId} (depth ${started.depth}, up to ${started.maxPages} pages, ${started.concurrency} concurrent workers) running in the background. Poll browser_bulk({action:"task_status", taskId: "${started.crawlId}"}) for progress — don't wait here.`,
            }],
          };
        }
        case "start_job": {
          const rawTasks = (args?.tasks as JobTaskInput[] | undefined) ?? [];
          const started = startJob(rawTasks, Number(args?.concurrency) || undefined, executeCommand, SESSION_ID);
          if ("error" in started) {
            return {
              content: [{ type: "text", text: `Error: ${started.error} (${started.hint})` }],
              isError: true,
            };
          }
          return {
            content: [{
              type: "text",
              text: `Started job ${started.jobId} with ${started.total} task(s) running in the background. Poll browser_bulk({action:"task_status", taskId: "${started.jobId}"}) for progress — don't wait here, this call is meant to return immediately.`,
            }],
          };
        }
        case "task_status": {
          const taskId = String(args?.taskId ?? "");
          result = jobExists(taskId)
            ? getJobStatusText(taskId)
            : crawlExists(taskId)
              ? getDeepCrawlStatusText(taskId)
              : `No task with id "${taskId}" — it may have already completed and been cleaned up (a task is dropped once you've seen its last result), or the id is wrong.`;
          break;
        }
        default:
          return unknownAction(name, action, ["batch_crawl", "search", "deep_crawl", "start_job", "task_status"]);
      } break;

      case "browser_knowledge": switch (action) {
        case "list_skills":
          result = { skills: listSkills({ domain: args?.domain as string | undefined, query: args?.query as string | undefined }) };
          break;
        case "save_skill":
          result = saveSkill(args ?? {});
          break;
        case "list_flows":
          result = { flows: dataStore.listFlows({ domain: args?.domain as string | undefined }) };
          break;
        case "save_flow": {
          const flowName = typeof args?.name === "string" ? args.name : "";
          const steps = Array.isArray(args?.steps) ? args.steps : undefined;
          if (!flowName || !steps || steps.length === 0) {
            return {
              content: [{ type: "text", text: `Error: Missing name or steps (hint: action:"save_flow" needs a non-empty \`name\` and a non-empty \`steps\` array, same shape as browser_act's run_flow.)` }],
              isError: true,
            };
          }
          const badStep = findBadFlowStep(steps as FlowStep[]);
          if (badStep) {
            const badAction = (steps as FlowStep[])[badStep.index].action;
            return {
              content: [{ type: "text", text: `Error: Step ${badStep.index} (${badAction}) ${badStep.reason} — it will never resolve at run time (role alone or name alone never matches anything). Re-check against a fresh inspect.snapshot/act.run_flow({explore:true}) and pass a complete role+name pair or a CSS selector before saving.` }],
              isError: true,
            };
          }
          const saved = dataStore.saveFlow({
            id: typeof args?.id === "string" ? args.id : undefined,
            name: flowName,
            description: typeof args?.description === "string" ? args.description : undefined,
            domain: typeof args?.domain === "string" ? args.domain : undefined,
            steps: steps as FlowStep[],
          });
          result = { ...saved, message: `Saved flow "${saved.name}" (id ${saved.id}) — it now shows up in the extension's side panel.` };
          break;
        }
        case "delete_flow": {
          const id = typeof args?.id === "string" ? args.id : "";
          if (!id) {
            return { content: [{ type: "text", text: `Error: Missing id (hint: get it from action:"list_flows".)` }], isError: true };
          }
          const deleted = dataStore.deleteFlow(id);
          result = deleted
            ? { success: true, message: `Deleted flow ${id}.` }
            : { error: `No flow with id "${id}"`, hint: "Call action:\"list_flows\" again — it may already be deleted." };
          break;
        }
        case "query_docs": {
          const docsAction = String(args?.docsAction ?? "");
          const scopeSessionId = args?.allSessions ? undefined : SESSION_ID;
          if (docsAction === "list") {
            const blocks = dataStore.listDocsBlocks({ sessionId: scopeSessionId, limit: Number(args?.limit) || undefined });
            result = { blocks };
          } else if (docsAction === "search") {
            const query = typeof args?.query === "string" ? args.query : "";
            if (!query) {
              return { content: [{ type: "text", text: `Error: Missing query (hint: docsAction:"search" needs a \`query\` string.)` }], isError: true };
            }
            const blocks = dataStore.searchDocsBlocks(query, { sessionId: scopeSessionId, limit: Number(args?.limit) || undefined });
            result = { blocks };
          } else if (docsAction === "read") {
            const blockId = Number(args?.blockId);
            if (!Number.isFinite(blockId)) {
              return { content: [{ type: "text", text: `Error: Missing blockId (hint: docsAction:"read" needs a \`blockId\` from a prior 'list' or 'search' result.)` }], isError: true };
            }
            const block = dataStore.getDocsBlock(blockId);
            if (!block) {
              return { content: [{ type: "text", text: `Error: No docs block with id ${blockId} (hint: it may belong to a different session — retry with allSessions:true, or it never existed.)` }], isError: true };
            }
            result = { ...block };
          } else {
            return { content: [{ type: "text", text: `Error: Unknown docsAction "${docsAction}" (hint: use "list", "search", or "read".)` }], isError: true };
          }
          break;
        }
        default:
          return unknownAction(name, action, ["list_skills", "save_skill", "list_flows", "save_flow", "delete_flow", "query_docs"]);
      } break;

      case "browser_dev": switch (action) {
        case "inspect_memory":
          result = await executeCommand("dev_memory", { focus: args?.focus, tabId: args?.tabId });
          break;
        case "inspect_process":
          result = await executeCommand("dev_process", { focus: args?.focus, tabId: args?.tabId });
          break;
        case "analyze_har":
          result = await executeCommand("dev_har", { filter: args?.filter, includeBodies: args?.includeBodies, tabId: args?.tabId });
          if (result && typeof result === "object" && "overview" in result) {
            result = (result as Record<string, unknown>).overview;
          }
          break;
        case "export_har": {
          const raw = await executeCommand("dev_har", { filter: args?.filter, includeBodies: args?.includeBodies, tabId: args?.tabId });
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
        case "debug_layout":
          result = await executeCommand("dev_layout", { selector: args?.selector, nodeId: args?.nodeId, focus: args?.focus, tabId: args?.tabId });
          break;
        case "emulate":
          result = await executeCommand("dev_emulate", {
            device: args?.device,
            network: args?.network,
            cpuSlowdown: args?.cpuSlowdown,
            touch: args?.touch,
            tabId: args?.tabId,
          });
          break;
        default:
          return unknownAction(name, action, ["inspect_memory", "inspect_process", "analyze_har", "export_har", "debug_layout", "emulate"]);
      } break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true
    };
  }
}
