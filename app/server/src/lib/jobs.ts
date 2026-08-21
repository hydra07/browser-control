// browser_bulk's start_job/task_status actions — async multi-tab task
// runner. start_job returns almost immediately (work continues via
// executeCommand, the same channel every other action uses) instead of
// blocking on however long N real navigations take.
//
// Each task carries a `delivered` flag so task_status only returns
// tasks that finished since the LAST poll, instead of re-reporting the same
// results (and burning tokens) every check-in. A job is dropped from the
// registry once every task has been delivered at least once.
import { addDocsBlock } from "./dataStore.js";

export type JobTaskExtract = "reading_mode" | "select_content" | "snapshot";

export interface JobTaskInput {
    url: string;
    extract?: JobTaskExtract;
    selector?: string; // only meaningful for extract: "select_content"
}

interface JobTask extends JobTaskInput {
    extract: JobTaskExtract;
    status: "pending" | "running" | "success" | "error";
    title?: string;
    chars?: number;
    blockIds?: number[];
    error?: string;
    delivered: boolean;
}

interface Job {
    id: string;
    sessionId: string;
    tasks: JobTask[];
    concurrency: number;
    startedAt: number;
    finishedAt?: number;
}

export const MAX_JOB_TASKS = 20;
export const MAX_CONCURRENT_JOBS = 3;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
// Bounds one task (navigate + extract on one page), not the whole job — a
// task that blows through it is likely a hung page load; the worker should
// move on rather than stall the job behind one stuck tab.
const TASK_TIMEOUT_MS = 45000;

const jobs = new Map<string, Job>();

// Whatever moves a command from daemon.ts to the extension and back —
// passed in rather than imported, so this module doesn't have to import
// daemon.ts (which imports this one).
export type Executor = (
    cmd: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
) => Promise<Record<string, unknown>>;

export function startJob(
    rawTasks: JobTaskInput[],
    concurrency: number | undefined,
    execute: Executor,
    sessionId: string,
): { jobId: string; total: number } | { error: string; hint: string } {
    const tasks = rawTasks.filter(
        (t) => typeof t?.url === "string" && t.url.trim().length > 0,
    );
    if (tasks.length === 0) {
        return {
            error: "Missing tasks",
            hint: "Provide an array of at least one {url} entry, e.g. [{url: 'https://...'}, {url: 'https://...', extract: 'select_content', selector: '.docs-body'}].",
        };
    }
    if (tasks.length > MAX_JOB_TASKS) {
        return {
            error: `Too many tasks: ${tasks.length} (max ${MAX_JOB_TASKS} per job)`,
            hint: "Split into multiple browser_bulk({action:\"start_job\"}) calls.",
        };
    }
    if (jobs.size >= MAX_CONCURRENT_JOBS) {
        return {
            error: `${MAX_CONCURRENT_JOBS} jobs are already running`,
            hint: "Poll browser_bulk({action:\"task_status\"}) on an existing jobId until it completes (completed jobs are dropped automatically), or that job may be stuck.",
        };
    }

    const jobId = crypto.randomUUID();
    const job: Job = {
        id: jobId,
        sessionId,
        tasks: tasks.map((t) => ({
            url: t.url,
            extract: t.extract ?? "reading_mode",
            selector: t.selector,
            status: "pending",
            delivered: false,
        })),
        concurrency: Math.min(
            Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY),
            MAX_CONCURRENCY,
        ),
        startedAt: Date.now(),
    };
    jobs.set(jobId, job);

    // Fire-and-forget — the whole point is the caller does NOT wait on this.
    void runJob(job, execute).catch((e) => {
        console.error(`[job ${jobId}] runJob crashed:`, e);
    });

    return { jobId, total: job.tasks.length };
}

async function runJob(job: Job, execute: Executor): Promise<void> {
    let nextIndex = 0;
    async function worker(): Promise<void> {
        while (nextIndex < job.tasks.length) {
            const task = job.tasks[nextIndex++];
            await runTask(task, execute, job.sessionId);
        }
    }
    const workerCount = Math.min(job.concurrency, job.tasks.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    job.finishedAt = Date.now();
}

async function runTask(
    task: JobTask,
    execute: Executor,
    sessionId: string,
): Promise<void> {
    task.status = "running";
    let tabId: number | undefined;
    try {
        const nav = await execute(
            // background:true — this tab belongs to the job, not to whatever
            // the caller's own foreground session is doing on lastActiveTabId
            // right now. Without it, concurrent job workers hijack the
            // default tab target (and steal OS window focus) out from under
            // any interactive browser_act/browser_inspect/etc. call that
            // omits tabId while the job is still running.
            "navigate",
            { url: task.url, newTab: true, background: true },
            TASK_TIMEOUT_MS,
        );
        if (nav?.error) throw new Error(String(nav.error));
        tabId = nav?.tabId as number | undefined;
        if (tabId == null) throw new Error("navigate did not return a tabId");

        if (task.extract === "select_content") {
            const res = await execute(
                "select_content",
                { tabId, selector: task.selector },
                TASK_TIMEOUT_MS,
            );
            if (res?.error) throw new Error(String(res.error));
            const blocks = (res?.blocks as string[] | undefined) ?? [];
            task.title = task.url;
            task.chars = blocks.reduce((n, b) => n + b.length, 0);
            // One docs_blocks row per matched element, same reasoning as
            // daemon.ts's own browser_inspect select_content handler.
            task.blockIds = blocks.map(
                (b, i) =>
                    addDocsBlock(
                        sessionId,
                        b,
                        blocks.length > 1
                            ? `job task: ${task.url} (match ${i + 1}/${blocks.length})`
                            : `job task: ${task.url}`,
                    ).blockId,
            );
        } else if (task.extract === "snapshot") {
            const res = await execute("snapshot", { tabId }, TASK_TIMEOUT_MS);
            if (res?.error) throw new Error(String(res.error));
            const json = JSON.stringify(res?.nodes ?? [], null, 2);
            task.title = task.url;
            task.chars = json.length;
            task.blockIds = [
                addDocsBlock(
                    sessionId,
                    `\`\`\`json\n${json.slice(0, 8000)}\n\`\`\``,
                    `job task snapshot: ${task.url}`,
                ).blockId,
            ];
        } else {
            const res = await execute(
                "reading_mode",
                { tabId },
                TASK_TIMEOUT_MS,
            );
            if (res?.error) throw new Error(String(res.error));
            const text = String(res?.text ?? "");
            task.title = String(res?.title || task.url);
            task.chars = text.length;
            if (text)
                task.blockIds = [
                    addDocsBlock(
                        sessionId,
                        text,
                        `job task: ${task.url}`,
                        task.title,
                    ).blockId,
                ];
        }
        task.status = "success";
    } catch (e) {
        task.status = "error";
        task.error = e instanceof Error ? e.message : String(e);
    } finally {
        if (tabId != null) {
            // Best-effort — a tab that fails to close is cosmetic clutter,
            // not a reason to fail the task it already ran.
            await execute("close_tab", { tabId }).catch(() => {});
        }
    }
}

// Lets daemon.ts's unified browser_bulk task_status action tell a job id from a
// deep-crawl id (crawl.ts has the matching crawlExists) without either
// module needing to know about the other's internal Map.
export function jobExists(jobId: string): boolean {
    return jobs.has(jobId);
}

export function getJobStatusText(jobId: string): string {
    const job = jobs.get(jobId);
    if (!job) {
        return `No job with id "${jobId}" — it may have already completed and been cleaned up (a job is dropped once you've seen its last result), or the id is wrong.`;
    }

    const newlyDone = job.tasks.filter(
        (t) => (t.status === "success" || t.status === "error") && !t.delivered,
    );
    for (const t of newlyDone) t.delivered = true;

    const succeeded = job.tasks.filter((t) => t.status === "success").length;
    const failed = job.tasks.filter((t) => t.status === "error").length;
    const inProgress = job.tasks.length - succeeded - failed;
    const complete = inProgress === 0;

    const lines = [
        `Job ${jobId}: ${succeeded + failed}/${job.tasks.length} done (${succeeded} ok, ${failed} failed)${complete ? " — job complete." : `, ${inProgress} still in progress.`}`,
    ];
    if (newlyDone.length > 0) {
        lines.push("", "New since your last check:");
        for (const t of newlyDone) {
            lines.push(
                t.status === "success"
                    ? `[OK] ${t.title || t.url} — ${t.chars ?? 0} chars, saved as docs block${(t.blockIds?.length ?? 0) > 1 ? "s" : ""} [${(t.blockIds ?? []).join(", ")}] (browser_knowledge({action:"query_docs"}))`
                    : `[FAIL] ${t.url} — ${t.error}`,
            );
        }
    } else {
        lines.push("(nothing new since your last check)");
    }

    // Only drop the job once EVERY task has actually been delivered to a
    // caller at least once — otherwise a poll that raced ahead of the last
    // task finishing would silently lose it.
    if (complete && job.tasks.every((t) => t.delivered)) {
        jobs.delete(jobId);
    }

    return lines.join("\n");
}
