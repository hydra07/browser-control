// browser_search — a search-engine query as its own primitive, separate
// from crawling. Before this, getting search results meant navigating (or
// fetching) DuckDuckGo's results page and treating the SERP itself as a
// "page" to extract — noisy, and the discovered links were buried in
// whatever browser_select_content/reading_mode's generic extraction did
// with a page that isn't an article. This parses the results page
// specifically for {title, url, snippet} instead. Runs on the same
// fetch()+DOMParser mechanism as batch.ts (offscreen document only, see
// its header for why) — DuckDuckGo's HTML endpoint is built for exactly
// this (no JS required, stable-ish result markup), so no real tab needed.
export interface SearchResult {
    title: string;
    url: string;
    snippet?: string;
}

const SEARCH_TIMEOUT_MS = 12000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

// DuckDuckGo's HTML result links are usually a redirect through
// /l/?uddg=<encoded real URL>&rut=..., not the destination directly —
// unwrap that so callers (browser_deep_crawl's frontier, in particular)
// get a URL actually worth fetching.
function resolveResultUrl(href: string): string | null {
    try {
        const u = new URL(href, "https://duckduckgo.com");
        if (u.pathname === "/l/" && u.searchParams.has("uddg")) {
            return decodeURIComponent(u.searchParams.get("uddg")!);
        }
        return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
        return null;
    }
}

export async function handleWebSearchCommand(opts: {
    query: string;
    limit?: number;
}): Promise<Record<string, unknown>> {
    const query = (opts.query || "").trim();
    if (!query) {
        return {
            error: "Missing query",
            hint: "Pass a search query string.",
        };
    }
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
        const res = await fetch(searchUrl, {
            signal: controller.signal,
            headers: {
                Accept: "text/html,application/xhtml+xml",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            },
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            return {
                error: `Search request failed: HTTP ${res.status}`,
                hint: "DuckDuckGo's HTML endpoint may be rate-limiting — space out repeated searches rather than retrying immediately.",
            };
        }

        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const results: SearchResult[] = [];
        doc.querySelectorAll(".result__a").forEach((a) => {
            if (results.length >= limit) return;
            const href = a.getAttribute("href");
            if (!href) return;
            const url = resolveResultUrl(href);
            if (!url) return;
            const title = (a.textContent || "").trim() || url;
            const snippet = a
                .closest(".result")
                ?.querySelector(".result__snippet")
                ?.textContent?.trim();
            results.push({ title, url, snippet: snippet || undefined });
        });

        return {
            message:
                results.length > 0
                    ? `Found ${results.length} result(s) for "${query}".`
                    : `No results parsed for "${query}" — DuckDuckGo may have changed its result markup, or blocked this request. Try browser_session({action:"navigate"}) to a search URL and browser_inspect({action:"snapshot"}) as a fallback.`,
            query,
            results,
        };
    } catch (e) {
        return {
            error: "Search request failed",
            hint: e instanceof Error ? e.message : String(e),
        };
    }
}
