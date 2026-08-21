/**
 * browser_bulk's deep_crawl/task_status actions — automatic recursive
 * crawl on top of the batch_crawl action's per-URL fetch+extract.
 *
 * A real frontier, not depth-by-depth batches: one shared {url, depth}
 * queue and N persistent workers pulling from it. A worker that finishes a
 * fetch immediately pushes that page's outlinks onto the same queue and
 * grabs whatever's next (sibling or freshly-discovered child) instead of
 * waiting for the rest of its "level" to finish first — batching by BFS
 * level measured ~2.75 pages/s (head-of-line blocked on each level's
 * slowest page) vs. sustained full-concurrency throughput with this.
 * Concurrency lives entirely in this queue/worker pool — each
 * executeCommand("batch_crawl") call below is single-URL on purpose.
 */
import { cpus } from "node:os";
import { errorMessage } from "../../libs/errorMessage.js";
import type { Executor } from "../../libs/types.js";
import { addDocsBlock } from "../dataStore/index.js";
import { MAX_CONCURRENT_CRAWLS, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES, PAGE_TIMEOUT_MS } from "./constants.js";
import type { Crawl, DeepCrawlInput, QueueEntry } from "./types.js";

export { MAX_CONCURRENT_CRAWLS, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES } from "./constants.js";
export type { DeepCrawlInput } from "./types.js";

const crawls = new Map<string, Crawl>();

/**
 * Fetch+parse is network-bound, not CPU-bound — it scales usefully well
 * past the core count. This runs server-side (Node/Bun), not in the browser
 * extension, so os.cpus() rather than navigator.hardwareConcurrency is the
 * available proxy for "how much this device can actually take" — same
 * reasoning batch.ts uses for its own default, from the daemon's side.
 */
function defaultCrawlConcurrency(): number {
  const cores = cpus().length || 4;
  return Math.min(Math.max(cores * 4, 8), 48);
}

/** Starts an async recursive crawl from seedUrls/searchQuery and returns its id immediately — see getDeepCrawlStatusText to poll it. */
export function startDeepCrawl(
  input: DeepCrawlInput,
  execute: Executor,
  sessionId: string,
): { crawlId: string; depth: number; maxPages: number; concurrency: number } | { error: string; hint: string } {
  const seedUrls = (input.seedUrls ?? []).filter((u) => typeof u === "string" && u.trim().length > 0);
  if (seedUrls.length === 0 && !input.searchQuery?.trim()) {
    return {
      error: "Missing seedUrls or searchQuery",
      hint: 'Provide at least one root URL in seedUrls, or a searchQuery to discover roots automatically via browser_bulk({action:"search"}).',
    };
  }
  if (crawls.size >= MAX_CONCURRENT_CRAWLS) {
    return {
      error: `${MAX_CONCURRENT_CRAWLS} deep crawls are already running`,
      hint: 'Poll browser_bulk({action:"task_status"}) on an existing crawlId until it completes (it\'s dropped automatically once fully delivered), or that one may be stuck.',
    };
  }

  const depth = Math.min(Math.max(1, Number(input.depth) || 2), MAX_CRAWL_DEPTH);
  const maxPages = Math.min(Math.max(1, Number(input.maxPages) || 60), MAX_CRAWL_PAGES);
  const maxOutlinksPerPage = Math.min(Math.max(1, Number(input.maxOutlinksPerPage) || 15), 50);
  const concurrency = Math.min(Math.max(1, Number(input.concurrency) || defaultCrawlConcurrency()), 64);

  const crawlId = crypto.randomUUID();
  const crawl: Crawl = {
    id: crawlId,
    sessionId,
    depth,
    maxPages,
    maxOutlinksPerPage,
    concurrency,
    pages: [],
    status: "running",
    error: undefined,
    startedAt: Date.now(),
    finishedAt: undefined,
  };
  crawls.set(crawlId, crawl);

  void runDeepCrawl(
    crawl,
    {
      seedUrls,
      searchQuery: input.searchQuery,
      maxCharsPerUrl: input.maxCharsPerUrl,
    },
    execute,
  ).catch((e) => {
    crawl.status = "error";
    crawl.error = errorMessage(e);
    crawl.finishedAt = Date.now();
  });

  return { crawlId, depth, maxPages, concurrency };
}

async function runDeepCrawl(
  crawl: Crawl,
  opts: { seedUrls: string[]; searchQuery?: string; maxCharsPerUrl?: number },
  execute: Executor,
): Promise<void> {
  const visited = new Set<string>();
  const queue: QueueEntry[] = [];
  const enqueue = (url: string, depth: number) => {
    if (visited.has(url) || crawl.pages.length + queue.length >= crawl.maxPages) return;
    visited.add(url);
    queue.push({ url, depth });
  };

  for (const u of opts.seedUrls) enqueue(u, 0);

  if (opts.searchQuery) {
    const search = await execute("web_search", {
      query: opts.searchQuery,
      limit: crawl.maxOutlinksPerPage,
    });
    const results = (search?.results as Array<{ url: string }> | undefined) ?? [];
    for (const r of results) enqueue(r.url, 0);
  }

  /**
   * A worker finding the queue empty must know whether anyone still IN
   * FLIGHT might enqueue more work before it's safe to exit — enqueue()
   * always runs synchronously before crawlOnePage's promise resolves, so
   * activeFetches hitting 0 reliably means nothing more is coming.
   */
  let activeFetches = 0;

  // Persistent workers, no depth barrier — a finished worker re-enters and grabs whatever's next.
  async function worker(): Promise<void> {
    while (true) {
      const entry = queue.shift();
      if (!entry) {
        if (crawl.pages.length >= crawl.maxPages) return;
        if (activeFetches === 0) return; // queue empty, nothing in flight to refill it — truly done
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      activeFetches++;
      try {
        await crawlOnePage(crawl, entry, opts.maxCharsPerUrl, execute, enqueue);
      } finally {
        activeFetches--;
      }
    }
  }

  const workerCount = Math.min(crawl.concurrency, crawl.maxPages);
  await Promise.all(Array.from({ length: workerCount }, worker));

  crawl.status = "done";
  crawl.finishedAt = Date.now();
}

async function crawlOnePage(
  crawl: Crawl,
  entry: QueueEntry,
  maxCharsPerUrl: number | undefined,
  execute: Executor,
  enqueue: (url: string, depth: number) => void,
): Promise<void> {
  if (crawl.pages.length >= crawl.maxPages) return;
  try {
    const res = await execute("batch_crawl", { urls: [entry.url], maxCharsPerUrl, concurrency: 1 }, PAGE_TIMEOUT_MS);
    const item = (res?.items as Array<Record<string, unknown>> | undefined)?.[0];
    if (!item || item.status !== "success") {
      crawl.pages.push({
        url: entry.url,
        depth: entry.depth,
        status: "error",
        error: String(item?.error ?? res?.error ?? "Unknown fetch error"),
        delivered: false,
      });
      return;
    }

    addDocsBlock(
      crawl.sessionId,
      `# [${item.title || entry.url}](${entry.url})\n\n${item.markdown ?? ""}`,
      entry.url,
      typeof item.title === "string" ? item.title : entry.url,
    );
    crawl.pages.push({
      url: entry.url,
      depth: entry.depth,
      status: "success",
      title: typeof item.title === "string" ? item.title : entry.url,
      delivered: false,
    });

    if (entry.depth + 1 < crawl.depth) {
      const outlinks = (item.outlinks as string[] | undefined)?.slice(0, crawl.maxOutlinksPerPage) ?? [];
      for (const link of outlinks) enqueue(link, entry.depth + 1);
    }
  } catch (e) {
    crawl.pages.push({
      url: entry.url,
      depth: entry.depth,
      status: "error",
      error: errorMessage(e),
      delivered: false,
    });
  }
}

/** See jobs's matching jobExists — lets task_status tell a crawl id from a job id without either module reaching into the other's internal Map. */
export function crawlExists(crawlId: string): boolean {
  return crawls.has(crawlId);
}

/** Human-readable status for a deep crawl — marks newly-finished pages delivered and drops the crawl once every page has been delivered at least once. */
export function getDeepCrawlStatusText(crawlId: string): string {
  const crawl = crawls.get(crawlId);
  if (!crawl) {
    return `No deep crawl with id "${crawlId}" — it may have already completed and been cleaned up (a crawl is dropped once you've seen its last result), or the id is wrong.`;
  }

  const newlyDone = crawl.pages.filter((p) => !p.delivered);
  for (const p of newlyDone) p.delivered = true;

  const succeeded = crawl.pages.filter((p) => p.status === "success").length;
  const failed = crawl.pages.filter((p) => p.status === "error").length;
  const elapsedS = ((crawl.finishedAt ?? Date.now()) - crawl.startedAt) / 1000;
  const rate = elapsedS > 0 ? (crawl.pages.length / elapsedS).toFixed(2) : "0";

  const lines = [
    `Deep crawl ${crawlId}: ${crawl.status}${crawl.status === "error" ? ` (${crawl.error})` : ""} — ${crawl.pages.length}/${crawl.maxPages} page(s) visited (${succeeded} ok, ${failed} failed), ${rate} pages/s, depth cap ${crawl.depth}, concurrency ${crawl.concurrency}.`,
  ];
  if (newlyDone.length > 0) {
    lines.push("", `New since your last check (${newlyDone.length}):`);
    for (const p of newlyDone) {
      lines.push(
        p.status === "success"
          ? `[OK] [d${p.depth}] ${p.title || p.url}`
          : `[FAIL] [d${p.depth}] ${p.url} — ${p.error}`,
      );
    }
    lines.push("", `Each page saved as its own docs block — query via browser_knowledge({action:"query_docs"}).`);
  } else {
    lines.push("(nothing new since your last check)");
  }

  if (crawl.status !== "running" && crawl.pages.every((p) => p.delivered)) {
    crawls.delete(crawlId);
  }

  return lines.join("\n");
}
