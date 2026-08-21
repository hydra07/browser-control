/**
 * Concurrent batch crawler for high-throughput, multi-page HTML data extraction.
 * Runs in offscreen document via fetch() + DOMParser without browser UI overhead.
 */
import { errorMessage } from "../../libs/errorMessage.js";
import {
    CANONICAL_SELECTORS,
    DEFAULT_MAX_CHARS_PER_URL,
    FETCH_TIMEOUT_MS,
    MAX_BATCH_URLS,
    MAX_CONCURRENCY,
    NOISE_SELECTORS,
    TRACKING_PARAMS,
} from "./constants.js";
import type { CrawlItemResult } from "./types.js";

export type { CrawlItemResult } from "./types.js";

/** Approximates optimal fetch concurrency based on navigator.hardwareConcurrency. */
function defaultFetchConcurrency(): number {
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
    return Math.min(Math.max(cores * 4, 8), MAX_CONCURRENCY);
}

export function normalizeUrl(rawUrl: string): string {
    try {
        const u = new URL(rawUrl.trim());
        u.hash = "";
        TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
        let path = u.pathname;
        if (path.length > 1 && path.endsWith("/")) {
            path = path.slice(0, -1);
        }
        return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search ? u.search : ""}`;
    } catch {
        return rawUrl.trim().toLowerCase();
    }
}

function formatNodeWithRefs(node: Node, baseUrl: string, citedRefs: Map<string, string>): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return (node.textContent || "").replace(/\s+/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const el = node as Element;
    if (el.matches(NOISE_SELECTORS)) return "";

    const tag = el.tagName.toLowerCase();
    const inner = Array.from(el.childNodes)
        .map((child) => formatNodeWithRefs(child, baseUrl, citedRefs))
        .join("");
    const trimmedInner = inner.trim();
    if (!trimmedInner && tag !== "br") return "";

    switch (tag) {
        case "h1":
            return `\n\n# ${trimmedInner}\n\n`;
        case "h2":
            return `\n\n## ${trimmedInner}\n\n`;
        case "h3":
            return `\n\n### ${trimmedInner}\n\n`;
        case "h4":
        case "h5":
        case "h6":
            return `\n\n#### ${trimmedInner}\n\n`;
        case "p":
            return `\n\n${trimmedInner}\n\n`;
        case "blockquote":
            return `\n\n> ${trimmedInner.replace(/\n+/g, "\n> ")}\n\n`;
        case "pre":
            return `\n\n\`\`\`\n${trimmedInner}\n\`\`\`\n\n`;
        case "code":
            return el.closest("pre") ? trimmedInner : `\`${trimmedInner}\``;
        case "a": {
            const href = el.getAttribute("href");
            if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
                return trimmedInner;
            }
            try {
                const absoluteUrl = new URL(href, baseUrl).href;
                if (trimmedInner.length >= 2 && !trimmedInner.startsWith("[")) {
                    citedRefs.set(absoluteUrl, trimmedInner);
                }
                return `[${trimmedInner}](${absoluteUrl})`;
            } catch {
                return trimmedInner;
            }
        }
        case "li":
            return `\n- ${trimmedInner}`;
        case "ul":
        case "ol":
            return `\n${trimmedInner}\n`;
        case "strong":
        case "b":
            return `**${trimmedInner}**`;
        case "em":
        case "i":
            return `*${trimmedInner}*`;
        case "br":
            return "\n";
        default:
            return inner;
    }
}

function extractOutlinks(doc: Document, baseUrl: string): string[] {
    const links = new Set<string>();
    try {
        doc.querySelectorAll("a[href]").forEach((a) => {
            const href = a.getAttribute("href");
            if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
            try {
                const resolved = new URL(href, baseUrl);
                if (resolved.protocol === "http:" || resolved.protocol === "https:") {
                    const norm = normalizeUrl(resolved.href);
                    if (norm !== normalizeUrl(baseUrl)) {
                        links.add(norm);
                    }
                }
            } catch {}
        });
    } catch {}
    return Array.from(links).slice(0, 25);
}

function parseHtmlToMarkdown(
    htmlText: string,
    url: string,
    maxChars: number,
): Omit<CrawlItemResult, "url" | "normalizedUrl" | "fetchDurationMs"> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");

    try {
        const base = doc.createElement("base");
        base.href = url;
        doc.head.appendChild(base);
    } catch {}

    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const docH1 = doc.querySelector("h1")?.textContent?.trim();
    const rawTitle = ogTitle || docH1 || doc.title || "";
    const cleanTitle = rawTitle.replace(/\s*[-–—|]\s*[^–—|-]+$/, "").trim() || rawTitle || url;

    const author =
        doc.querySelector('meta[name="author"]')?.getAttribute("content") ||
        doc.querySelector('meta[property="article:author"]')?.getAttribute("content") ||
        doc.querySelector('[rel="author"], .author, .byline, [itemprop="author"]')?.textContent?.trim();

    const publishedTime =
        doc.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ||
        doc.querySelector("time[datetime]")?.getAttribute("datetime") ||
        doc.querySelector('meta[name="pubdate"]')?.getAttribute("content");

    const description =
        doc.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
        doc.querySelector('meta[name="description"]')?.getAttribute("content");

    function calculateScore(el: Element): number {
        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll(NOISE_SELECTORS).forEach((n) => n.remove());

        const text = clone.textContent || "";
        const textLen = text.trim().length;
        if (textLen < 80) return 0;

        let linkLen = 0;
        clone.querySelectorAll("a").forEach((a) => {
            linkLen += (a.textContent || "").trim().length;
        });
        const linkDensity = textLen > 0 ? linkLen / textLen : 0;
        if (linkDensity > 0.45) return 0;

        let score = textLen * (1 - linkDensity * 1.5);
        const paras = clone.querySelectorAll("p");
        score += paras.length * 50;

        const tag = el.tagName.toLowerCase();
        if (tag === "article") score *= 1.4;
        if (tag === "main" || el.getAttribute("role") === "main") score *= 1.2;
        if (el.matches('[itemprop="articleBody"], .article-body, .entry-content, .markdown-body')) score *= 1.5;

        return score;
    }

    let bestCandidate: Element | null = null;
    let bestScore = 0;

    for (const sel of CANONICAL_SELECTORS) {
        doc.querySelectorAll(sel).forEach((el) => {
            if (el.closest(NOISE_SELECTORS)) return;
            const s = calculateScore(el);
            if (s > bestScore) {
                bestScore = s;
                bestCandidate = el;
            }
        });
    }

    if (!bestCandidate || bestScore < 150) {
        doc.querySelectorAll("section, div").forEach((el) => {
            if (el.closest(NOISE_SELECTORS)) return;
            const s = calculateScore(el);
            if (s > bestScore) {
                bestScore = s;
                bestCandidate = el;
            }
        });
    }

    const root = bestCandidate ?? doc.querySelector("article") ?? doc.querySelector("main") ?? doc.body;
    const citedMap = new Map<string, string>();
    let markdown = formatNodeWithRefs(root, url, citedMap)
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (markdown.length > maxChars) {
        markdown = markdown.slice(0, maxChars) + "\n\n...(content truncated at maxChars limit)...";
    }

    // Append dedicated contextual References section
    if (citedMap.size > 0) {
        const refList = Array.from(citedMap.entries())
            .slice(0, 25)
            .map(([linkUrl, linkText]) => `- [${linkText}](${linkUrl})`)
            .join("\n");
        markdown += `\n\n### Tham Chiếu & Nguồn Dẫn (Cited References in this Section):\n${refList}\n`;
    }

    const wordCount = markdown.split(/\s+/).filter(Boolean).length;
    const estMinutes = Math.max(1, Math.round(wordCount / 200));
    const readingTime = `${estMinutes} min read (${wordCount} words)`;
    const outlinks = extractOutlinks(doc, url);

    return {
        status: "success",
        title: cleanTitle,
        byline: author?.trim(),
        publishedTime: publishedTime?.trim(),
        readingTime,
        description: description?.trim(),
        markdown,
        length: markdown.length,
        outlinks,
    };
}

async function fetchAndExtractUrl(url: string, maxChars: number): Promise<CrawlItemResult> {
    const normalizedUrl = normalizeUrl(url);
    const itemStart = Date.now();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            },
        });
        clearTimeout(timeoutId);

        const fetchDurationMs = Date.now() - itemStart;

        if (!res.ok) {
            return {
                url,
                normalizedUrl,
                status: "error",
                fetchDurationMs,
                error: `HTTP ${res.status}: ${res.statusText}`,
            };
        }

        const htmlText = await res.text();
        const parsed = parseHtmlToMarkdown(htmlText, url, maxChars);
        return {
            url,
            normalizedUrl,
            fetchDurationMs,
            ...parsed,
        };
    } catch (e) {
        return {
            url,
            normalizedUrl,
            status: "error",
            fetchDurationMs: Date.now() - itemStart,
            error: errorMessage(e),
        };
    }
}

export class BatchCrawler {
    private readonly sessionCrawledUrls: Set<string>;

    constructor() {
        this.sessionCrawledUrls = new Set();
    }

    public clear(): void {
        this.sessionCrawledUrls.clear();
    }

    public has(url: string): boolean {
        return this.sessionCrawledUrls.has(normalizeUrl(url));
    }

    public mark(url: string): void {
        this.sessionCrawledUrls.add(normalizeUrl(url));
    }

    public async crawl(opts: {
        urls: string[];
        concurrency?: number;
        maxCharsPerUrl?: number;
        skipDeduplication?: boolean;
    }): Promise<Record<string, unknown>> {
        const rawUrls = (opts.urls || []).filter((u) => typeof u === "string" && u.trim().length > 0);
        if (rawUrls.length === 0) {
            return {
                error: "Missing urls",
                hint: "Provide an array of target URLs to crawl, e.g. ['https://en.wikipedia.org/wiki/AI', 'https://news.ycombinator.com'].",
            };
        }
        if (rawUrls.length > MAX_BATCH_URLS) {
            return {
                error: `Too many urls: ${rawUrls.length} (max ${MAX_BATCH_URLS} per call)`,
                hint: 'Split into multiple browser_bulk({action:"batch_crawl"}) calls — each one still appends to the same session docs file, so nothing is lost by batching.',
            };
        }

        const toCrawl: string[] = [];
        const skippedItems: CrawlItemResult[] = [];
        const seenInBatch = new Set<string>();

        for (const u of rawUrls) {
            const norm = normalizeUrl(u);
            if (!opts.skipDeduplication && (this.sessionCrawledUrls.has(norm) || seenInBatch.has(norm))) {
                skippedItems.push({
                    url: u,
                    normalizedUrl: norm,
                    status: "skipped_duplicate",
                    error: "URL already crawled in this session",
                });
                continue;
            }
            seenInBatch.add(norm);
            toCrawl.push(u);
        }

        const concurrency = Math.min(Math.max(1, opts.concurrency ?? defaultFetchConcurrency()), MAX_CONCURRENCY);
        const maxCharsPerUrl = opts.maxCharsPerUrl ?? DEFAULT_MAX_CHARS_PER_URL;

        const startTime = Date.now();
        const results: CrawlItemResult[] = Array.from({ length: toCrawl.length });

        let currentIndex = 0;
        const worker = async () => {
            while (currentIndex < toCrawl.length) {
                const index = currentIndex++;
                const url = toCrawl[index];
                const item = await fetchAndExtractUrl(url, maxCharsPerUrl);
                results[index] = item;
                if (item.status === "success") {
                    this.sessionCrawledUrls.add(item.normalizedUrl);
                }
            }
        };

        const workers = Array.from({ length: Math.min(concurrency, toCrawl.length) }, () => worker());
        await Promise.all(workers);

        const durationMs = Date.now() - startTime;
        const allResults = [...results, ...skippedItems];

        let totalChars = 0;
        let totalFetchTime = 0;
        let successCount = 0;
        let failedCount = 0;
        const discoveredOutlinksSet = new Set<string>();

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (!r) continue;
            if (r.status === "success") {
                successCount++;
                totalChars += r.length || 0;
                totalFetchTime += r.fetchDurationMs || 0;
                if (r.outlinks) {
                    for (let j = 0; j < r.outlinks.length; j++) {
                        const link = r.outlinks[j];
                        if (link && !this.sessionCrawledUrls.has(link)) {
                            discoveredOutlinksSet.add(link);
                        }
                    }
                }
            } else if (r.status === "error") {
                failedCount++;
            }
        }

        const avgFetchLatencyMs = successCount > 0 ? Math.round(totalFetchTime / successCount) : 0;
        const pagesPerSec = durationMs > 0 ? Math.round((toCrawl.length / (durationMs / 1000)) * 10) / 10 : 0;
        const discoveredOutlinks = Array.from(discoveredOutlinksSet).slice(0, 100);

        return {
            totalRequested: rawUrls.length,
            totalProcessed: toCrawl.length,
            duplicatesSkipped: skippedItems.length,
            successful: successCount,
            failed: failedCount,
            durationMs,
            avgFetchLatencyMs,
            throughputPagesPerSec: pagesPerSec,
            totalCharsExtracted: totalChars,
            items: allResults,
            discoveredOutlinks,
        };
    }
}

export const batchCrawler = new BatchCrawler();

export async function handleBatchCrawlCommand(opts: {
    urls: string[];
    concurrency?: number;
    maxCharsPerUrl?: number;
    skipDeduplication?: boolean;
}): Promise<Record<string, unknown>> {
    return batchCrawler.crawl(opts);
}
