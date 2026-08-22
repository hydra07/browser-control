import { TRACKING_PARAMS } from "./constants.js";
import type { CrawlItemResult } from "./types.js";

export function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim());
    u.hash = "";
    for (const p of TRACKING_PARAMS) {
      u.searchParams.delete(p);
    }
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search ? u.search : ""}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * High-performance streaming HTML-to-Markdown extractor powered by Bun's native C++ HTMLRewriter.
 * Runs in O(N) single-pass with zero Chrome memory allocations.
 */
export async function parseHtmlToMarkdown(
  htmlText: string,
  url: string,
  maxChars = 25_000,
): Promise<Omit<CrawlItemResult, "url" | "normalizedUrl" | "fetchDurationMs" | "status" | "error">> {
  let title = "";
  let description = "";
  let author = "";
  let publishedTime: string | undefined;
  const outlinks = new Set<string>();
  const chunks: string[] = [];

  let currentTag = "";
  let insideNoise = 0;
  let currentLinkHref = "";
  let currentLinkText = "";

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        if (!title && chunk.text) title += chunk.text;
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        const val = el.getAttribute("content");
        if (val && !title) title = val;
      },
    })
    .on('meta[name="description"], meta[property="og:description"]', {
      element(el) {
        const val = el.getAttribute("content");
        if (val && !description) description = val;
      },
    })
    .on('meta[name="author"], meta[property="article:author"]', {
      element(el) {
        const val = el.getAttribute("content");
        if (val && !author) author = val;
      },
    })
    .on('meta[property="article:published_time"], meta[name="pubdate"], time[datetime]', {
      element(el) {
        const val = el.getAttribute("content") || el.getAttribute("datetime");
        if (val && !publishedTime) publishedTime = val;
      },
    })
    .on("script, style, nav, footer, aside, noscript, svg, iframe, .ads, .cookie-banner, [aria-hidden='true']", {
      element(el) {
        insideNoise++;
        el.onEndTag(() => {
          insideNoise = Math.max(0, insideNoise - 1);
        });
      },
    })
    .on("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, code, a, strong, b, em, i, br", {
      element(el) {
        if (insideNoise > 0) return;
        currentTag = el.tagName.toLowerCase();
        if (currentTag === "a") {
          currentLinkHref = el.getAttribute("href") || "";
          currentLinkText = "";
          if (currentLinkHref && !currentLinkHref.startsWith("#") && !currentLinkHref.startsWith("javascript:")) {
            try {
              const abs = new URL(currentLinkHref, url).href;
              const norm = normalizeUrl(abs);
              if (norm !== normalizeUrl(url)) {
                outlinks.add(norm);
              }
            } catch {}
          }
        } else if (currentTag === "h1") {
          chunks.push("\n\n# ");
        } else if (currentTag === "h2") {
          chunks.push("\n\n## ");
        } else if (currentTag === "h3") {
          chunks.push("\n\n### ");
        } else if (currentTag === "h4" || currentTag === "h5" || currentTag === "h6") {
          chunks.push("\n\n#### ");
        } else if (currentTag === "p") {
          chunks.push("\n\n");
        } else if (currentTag === "blockquote") {
          chunks.push("\n\n> ");
        } else if (currentTag === "li") {
          chunks.push("\n- ");
        } else if (currentTag === "pre") {
          chunks.push("\n\n```\n");
        } else if (currentTag === "br") {
          chunks.push("\n");
        }
      },
      text(chunk) {
        if (insideNoise > 0) return;
        const text = chunk.text;
        if (!text) return;
        if (currentTag === "a") {
          currentLinkText += text;
          if (chunk.lastInTextNode) {
            try {
              const abs = new URL(currentLinkHref, url).href;
              chunks.push(`[${currentLinkText.trim()}](${abs})`);
            } catch {
              chunks.push(currentLinkText);
            }
          }
        } else {
          chunks.push(text);
        }
      },
    });

  const res = rewriter.transform(new Response(htmlText));
  await res.text();

  const rawMarkdown = chunks
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncatedText = rawMarkdown.slice(0, maxChars);
  const isArticle = rawMarkdown.length > 500 && (title.length > 0 || publishedTime !== undefined);
  const wordCount = truncatedText.split(/\s+/).length;
  const readingTime = `${Math.max(1, Math.round(wordCount / 200))} min read`;

  return {
    title: title.trim() || url,
    description: description.trim() || undefined,
    author: author.trim() || undefined,
    publishedTime,
    readingTime,
    text: truncatedText,
    isArticle,
    outlinks: Array.from(outlinks).slice(0, 25),
  };
}
