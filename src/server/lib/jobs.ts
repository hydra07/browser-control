// browser_start_job / browser_job_status — async multi-tab task runner.
// browser_run_flow and friends are all synchronous: one MCP call, one wait,
// one answer. That's wrong for "go read these 12 pages" — either the call
// blocks for however long 12 real navigations take (risking the daemon's
// own timeouts), or the caller has to drive 12 browser_navigate/
// browser_reading_mode round trips itself. A job instead: browser_start_job
// returns almost immediately (work continues in the background via
// executeCommand, the same channel every other tool already uses), and
// browser_job_status is polled later for progress.
//
// The status-polling side is the part actually worth being careful about:
// naively returning "here's every task and its status" on every poll means
// the AI re-reads N already-known results every single time it checks in on
// a long job — wasted tokens, and worse, a real path to it re-announcing
// "page 3 failed" three different times because it saw task 3 in three
// different status calls. Each task carries a `delivered` flag instead;
// browser_job_status returns only tasks that finished (success OR error)
// since the LAST time this job was polled, and immediately marks them
// delivered. A finished job is dropped from the registry the first time a
// status call sees it fully delivered — nothing to leak, nothing to see
// twice.
import { appendContentToDocsFile, DOCS_FILE } from "./docs.js";

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
    error?: string;
    delivered: boolean;
}

interface Job {
    id: string;
    tasks: JobTask[];
    concurrency: number;
    startedAt: number;
    finishedAt?: number;
}

export const MAX_JOB_TASKS = 20;
export const MAX_CONCURRENT_JOBS = 3;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
// Generous, not tight — this bounds ONE task (navigate + extract on one
// real page), not the whole job. A task that blows through it is far more
// likely a genuinely hung page load than a slow-but-fine one; either way
// the worker needs to give up and move to the next task rather than stall
// the whole job behind one stuck tab.
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
            hint: "Split into multiple browser_start_job calls.",
        };
    }
    if (jobs.size >= MAX_CONCURRENT_JOBS) {
        return {
            error: `${MAX_CONCURRENT_JOBS} jobs are already running`,
            hint: "Poll browser_job_status on an existing jobId until it completes (completed jobs are dropped automatically), or that job may be stuck.",
        };
    }

    const jobId = crypto.randomUUID();
    const job: Job = {
        id: jobId,
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
            await runTask(task, execute);
        }
    }
    const workerCount = Math.min(job.concurrency, job.tasks.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    job.finishedAt = Date.now();
}

async function runTask(task: JobTask, execute: Executor): Promise<void> {
    task.status = "running";
    let tabId: number | undefined;
    try {
        const nav = await execute(
            "navigate",
            { url: task.url, newTab: true },
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
            if (blocks.length > 0)
                appendContentToDocsFile(blocks, `job task: ${task.url}`);
        } else if (task.extract === "snapshot") {
            const res = await execute("snapshot", { tabId }, TASK_TIMEOUT_MS);
            if (res?.error) throw new Error(String(res.error));
            const json = JSON.stringify(res?.nodes ?? [], null, 2);
            task.title = task.url;
            task.chars = json.length;
            appendContentToDocsFile(
                [`\`\`\`json\n${json.slice(0, 8000)}\n\`\`\``],
                `job task snapshot: ${task.url}`,
            );
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
                appendContentToDocsFile(
                    [`# [${task.title}](${task.url})\n\n${text}`],
                    `job task: ${task.url}`,
                );
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

// Lets daemon.ts's unified browser_task_status tool tell a job id from a
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
                    ? `✅ ${t.title || t.url} — ${t.chars ?? 0} chars appended to ${DOCS_FILE}`
                    : `❌ ${t.url} — ${t.error}`,
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
