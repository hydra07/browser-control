/**
 * browser_bulk's deep_crawl, batch_crawl, and task_status actions —
 * high-performance asynchronous web crawler running entirely server-side via Bun.fetch.
 */
import { cpus } from "node:os";
import { errorMessage } from "../../libs/errorMessage.js";
import type { Executor } from "../../libs/types.js";
import { addDocsBlock } from "../dataStore/index.js";
import { fetchSingleUrl } from "./batch.js";
import { MAX_CONCURRENT_CRAWLS, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES, PAGE_TIMEOUT_MS } from "./constants.js";
import type { DeepCrawlInput, QueueEntry } from "./types.js";

export { batchCrawl, fetchSingleUrl, formatBatchResultsToMarkdown } from "./batch.js";
export { MAX_CONCURRENT_CRAWLS, MAX_CRAWL_DEPTH, MAX_CRAWL_PAGES } from "./constants.js";
export { normalizeUrl, parseHtmlToMarkdown } from "./extractor.js";
export type { BatchCrawlOptions, CrawlItemResult, DeepCrawlInput } from "./types.js";

interface InternalCrawl {
  id: string;
  sessionId: string;
  depth: number;
  maxPages: number;
  maxOutlinksPerPage: number;
  concurrency: number;
  pages: Array<{
    url: string;
    depth: number;
    status: "success" | "error";
    title?: string;
    error?: string;
    delivered: boolean;
  }>;
  status: "running" | "done" | "error";
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const crawls = new Map<string, InternalCrawl>();

function defaultCrawlConcurrency(): number {
  const cores = cpus().length || 4;
  return Math.min(Math.max(cores * 4, 8), 48);
}

/** Starts an async recursive crawl from seedUrls/searchQuery and returns its id immediately. */
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
      hint: 'Poll browser_bulk({action:"task_status"}) on an existing crawlId until it completes.',
    };
  }

  const depth = Math.min(Math.max(1, Number(input.depth) || 2), MAX_CRAWL_DEPTH);
  const maxPages = Math.min(Math.max(1, Number(input.maxPages) || 60), MAX_CRAWL_PAGES);
  const maxOutlinksPerPage = 15;
  const concurrency = Math.min(Math.max(1, Number(input.concurrency) || defaultCrawlConcurrency()), 64);

  const crawlId = crypto.randomUUID();
  const crawl: InternalCrawl = {
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
      maxCharsPerUrl: input.maxCharsPerPage,
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
  crawl: InternalCrawl,
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

  let activeFetches = 0;

  async function worker(): Promise<void> {
    while (true) {
      const entry = queue.shift();
      if (!entry) {
        if (crawl.pages.length >= crawl.maxPages) return;
        if (activeFetches === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      activeFetches++;
      try {
        await crawlOnePage(crawl, entry, opts.maxCharsPerUrl, enqueue);
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
  crawl: InternalCrawl,
  entry: QueueEntry,
  maxCharsPerUrl: number | undefined,
  enqueue: (url: string, depth: number) => void,
): Promise<void> {
  if (crawl.pages.length >= crawl.maxPages) return;
  try {
    const item = await fetchSingleUrl(entry.url, maxCharsPerUrl, PAGE_TIMEOUT_MS);
    if (item.error || item.status === 0 || item.status >= 400) {
      crawl.pages.push({
        url: entry.url,
        depth: entry.depth,
        status: "error",
        error: item.error ?? `HTTP ${item.status}`,
        delivered: false,
      });
      return;
    }

    addDocsBlock(
      crawl.sessionId,
      `# [${item.title || entry.url}](${entry.url})\n\n${item.text ?? ""}`,
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
      const outlinks = item.outlinks.slice(0, crawl.maxOutlinksPerPage);
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

export function crawlExists(crawlId: string): boolean {
  return crawls.has(crawlId);
}

export function getDeepCrawlStatusText(crawlId: string): string {
  const crawl = crawls.get(crawlId);
  if (!crawl) {
    return `No deep crawl with id "${crawlId}" — it may have already completed or the id is wrong.`;
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
  return lines.join("\n");
}
