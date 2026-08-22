import { errorMessage } from "../../libs/errorMessage.js";
import { DEFAULT_MAX_CHARS_PER_URL, FETCH_TIMEOUT_MS, MAX_BATCH_URLS, MAX_CONCURRENCY } from "./constants.js";
import { normalizeUrl, parseHtmlToMarkdown } from "./extractor.js";
import type { BatchCrawlOptions, CrawlItemResult } from "./types.js";

/** Fetches a single URL using native Bun HTTP client and extracts Markdown */
export async function fetchSingleUrl(
  rawUrl: string,
  maxChars = DEFAULT_MAX_CHARS_PER_URL,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<CrawlItemResult> {
  const norm = normalizeUrl(rawUrl);
  const start = performance.now();

  try {
    const res = await fetch(rawUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });

    const status = res.status;
    if (!res.ok) {
      return {
        url: rawUrl,
        normalizedUrl: norm,
        title: rawUrl,
        text: "",
        isArticle: false,
        outlinks: [],
        fetchDurationMs: Math.round(performance.now() - start),
        status,
        error: `HTTP ${status} ${res.statusText}`,
      };
    }

    const htmlText = await res.text();
    const extracted = await parseHtmlToMarkdown(htmlText, rawUrl, maxChars);

    return {
      url: rawUrl,
      normalizedUrl: norm,
      ...extracted,
      fetchDurationMs: Math.round(performance.now() - start),
      status,
    };
  } catch (err) {
    return {
      url: rawUrl,
      normalizedUrl: norm,
      title: rawUrl,
      text: "",
      isArticle: false,
      outlinks: [],
      fetchDurationMs: Math.round(performance.now() - start),
      status: 0,
      error: errorMessage(err),
    };
  }
}

/** Concurrently crawls multiple URLs with pool-based concurrency limiting */
export async function batchCrawl(urls: string[], options: BatchCrawlOptions = {}): Promise<CrawlItemResult[]> {
  const cleanUrls = Array.from(new Set(urls.map((u) => u.trim()).filter((u) => u.length > 0))).slice(0, MAX_BATCH_URLS);
  if (cleanUrls.length === 0) return [];

  const maxConcurrency = Math.min(options.concurrency ?? 12, MAX_CONCURRENCY);
  const maxChars = options.maxCharsPerUrl ?? DEFAULT_MAX_CHARS_PER_URL;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  const results: CrawlItemResult[] = [];
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < cleanUrls.length) {
      const idx = currentIndex++;
      const url = cleanUrls[idx];
      if (!url) break;
      const res = await fetchSingleUrl(url, maxChars, timeoutMs);
      results.push(res);
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, cleanUrls.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/** Formats multiple crawled results into structured Markdown for LLM output */
export function formatBatchResultsToMarkdown(results: CrawlItemResult[]): string {
  if (results.length === 0) return "No URLs crawled.";

  const successful = results.filter((r) => !r.error && r.status >= 200 && r.status < 300);
  const failed = results.filter((r) => !!r.error || r.status >= 400 || r.status === 0);

  const sections: string[] = [];
  sections.push(`## 📊 Batch Crawl Summary (${successful.length}/${results.length} succeeded)\n`);

  if (failed.length > 0) {
    sections.push("### ⚠️ Failed URLs:\n");
    for (const f of failed) {
      sections.push(`- **${f.url}**: ${f.error || `HTTP ${f.status}`}`);
    }
    sections.push("\n");
  }

  for (let i = 0; i < successful.length; i++) {
    const doc = successful[i];
    if (!doc) continue;
    sections.push(`---\n### [${i + 1}] ${doc.title}`);
    sections.push(`- **URL**: ${doc.url}`);
    if (doc.author) sections.push(`- **Author**: ${doc.author}`);
    if (doc.publishedTime) sections.push(`- **Published**: ${doc.publishedTime}`);
    if (doc.readingTime) sections.push(`- **Read Time**: ${doc.readingTime}`);
    sections.push(`- **Latency**: ${doc.fetchDurationMs}ms\n`);
    sections.push(doc.text || "*(No textual content extracted)*");
    sections.push("\n");
  }

  return sections.join("\n");
}
