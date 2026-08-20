// browser_reading_mode and browser_find — for when the goal is reading/
// locating content fast, not acting on it. Both are cheaper than
// browser_snapshot for their specific job: reading_mode skips the whole
// accessibility tree and just returns clean article text; find jumps
// straight to matching elements instead of scanning a full node list.
import { sendCommand, quadToBox } from "./cdp.js";
import { getAxInfoForNode, type AxInfo } from "./actions.js";
import { showNativeHighlight, hideNativeHighlight } from "./overlay.js";

/**
 * Self-contained: injected via Runtime.evaluate (returnByValue).
 * Intelligent reader view extractor inspired by Mozilla Readability & Arc Reader:
 * - Extracts structured metadata (title, author, publishedTime, readingTime, description).
 * - Prioritizes canonical content selectors ([itemprop="articleBody"], article, .entry-content, .markdown-body, etc.).
 * - Applies Readability heuristics (scoring by paragraph text, comma density, link density penalty).
 * - Formats output with clean Markdown (headings, lists, quotes, code blocks).
 */
function extractReadableContent(): {
    title: string;
    byline?: string;
    publishedTime?: string;
    readingTime?: string;
    description?: string;
    text: string;
    isArticle: boolean;
} {
    const NOISE_SELECTORS = [
        "script",
        "style",
        "nav",
        "header",
        "footer",
        "aside",
        "iframe",
        "noscript",
        "svg",
        "form",
        ".ads",
        ".advertisement",
        ".social-share",
        ".share-buttons",
        ".comments",
        "#comments",
        ".disqus",
        ".newsletter",
        ".cookie-banner",
        '[role="navigation"]',
        '[role="banner"]',
        '[role="contentinfo"]',
        '[aria-hidden="true"]',
        '[hidden]',
    ].join(",");

    function cleanText(t: string): string {
        return t.replace(/\s+/g, " ").trim();
    }

    // 1. Metadata Extraction
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const docH1 = document.querySelector("h1")?.textContent?.trim();
    const rawTitle = ogTitle || docH1 || document.title || "";
    const cleanTitle = rawTitle.replace(/\s*[-–—|]\s*[^–—|-]+$/, "").trim() || rawTitle;

    const author =
        document.querySelector('meta[name="author"]')?.getAttribute("content") ||
        document.querySelector('meta[property="article:author"]')?.getAttribute("content") ||
        document.querySelector('[rel="author"], .author, .byline, [itemprop="author"]')?.textContent?.trim();

    const publishedTime =
        document.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ||
        document.querySelector('time[datetime]')?.getAttribute("datetime") ||
        document.querySelector('meta[name="pubdate"]')?.getAttribute("content");

    const description =
        document.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
        document.querySelector('meta[name="description"]')?.getAttribute("content");

    // 2. Element Scoring & Candidate Selection
    const CANONICAL_SELECTORS = [
        '[itemprop="articleBody"]',
        ".article-body",
        ".post-content",
        ".entry-content",
        ".story-body",
        ".markdown-body",
        ".prose",
        "#mw-content-text",
        "article",
        "main",
        '[role="main"]',
    ];

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
        if (linkDensity > 0.45) return 0; // Penalize link lists / menus / card feeds

        let score = textLen * (1 - linkDensity * 1.5);
        const paras = clone.querySelectorAll("p");
        score += paras.length * 50;

        const commas = (text.match(/,/g) || []).length;
        score += commas * 10;

        const tag = el.tagName.toLowerCase();
        if (tag === "article") score *= 1.4;
        if (tag === "main" || el.getAttribute("role") === "main") score *= 1.2;
        if (el.matches('[itemprop="articleBody"], .article-body, .entry-content, .markdown-body')) score *= 1.5;

        return score;
    }

    let bestCandidate: Element | null = null;
    let bestScore = 0;

    for (const sel of CANONICAL_SELECTORS) {
        document.querySelectorAll(sel).forEach((el) => {
            if (el.closest(NOISE_SELECTORS)) return;
            const s = calculateScore(el);
            if (s > bestScore) {
                bestScore = s;
                bestCandidate = el;
            }
        });
    }

    if (!bestCandidate || bestScore < 150) {
        document.querySelectorAll("section, div").forEach((el) => {
            if (el.closest(NOISE_SELECTORS)) return;
            const s = calculateScore(el);
            if (s > bestScore) {
                bestScore = s;
                bestCandidate = el;
            }
        });
    }

    const root = bestCandidate ?? document.querySelector("article") ?? document.querySelector("main") ?? document.body;

    // 3. Formatted Content Extraction
    function formatNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return (node.textContent || "").replace(/\s+/g, " ");
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return "";

        const el = node as Element;
        if (el.matches(NOISE_SELECTORS)) return "";

        const tag = el.tagName.toLowerCase();
        const inner = Array.from(el.childNodes).map(formatNode).join("");
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

    const formattedText = formatNode(root)
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    const wordCount = formattedText.split(/\s+/).filter(Boolean).length;
    const estMinutes = Math.max(1, Math.round(wordCount / 200));
    const readingTime = `${estMinutes} min read (${wordCount} words)`;

    const isArticle = wordCount >= 60 && bestScore > 100;

    return {
        title: cleanTitle,
        byline: author ? cleanText(author) : undefined,
        publishedTime: publishedTime ? cleanText(publishedTime) : undefined,
        readingTime,
        description: description ? cleanText(description) : undefined,
        text: formattedText,
        isArticle,
    };
}

const DEFAULT_MAX_READING_CHARS = 25000;

export async function handleReadingModeCommand(
    target: chrome.debugger.Debuggee,
    maxChars = DEFAULT_MAX_READING_CHARS,
): Promise<Record<string, unknown>> {
    const res = await sendCommand(target, "Runtime.evaluate", {
        expression: `(${extractReadableContent.toString()})()`,
        returnByValue: true,
    });
    if (res?.exceptionDetails) {
        return {
            error: res.exceptionDetails.text,
            hint: "Reading-mode extraction threw — the page may block script access to some content.",
        };
    }
    const result = res?.result?.value as
        | {
              title: string;
              byline?: string;
              publishedTime?: string;
              readingTime?: string;
              description?: string;
              text: string;
              isArticle: boolean;
          }
        | undefined;

    if (!result || !result.text || !result.isArticle) {
        return {
            message:
                "This page does not appear to be article-shaped (e.g. an app UI, form, dashboard, or listing). Use browser_inspect({action:\"snapshot\"}) instead.",
            title: result?.title ?? "",
            description: result?.description,
            text: result?.text?.slice(0, 1000) ?? "",
            isArticle: false,
        };
    }

    let text = result.text;
    let truncated = false;
    if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
    }

    return {
        title: result.title,
        byline: result.byline,
        publishedTime: result.publishedTime,
        readingTime: result.readingTime,
        description: result.description,
        text,
        length: text.length,
        truncated,
        isArticle: true,
    };
}

export async function handleFindCommand(
    target: chrome.debugger.Debuggee,
    query: string | undefined,
    limit = 20,
): Promise<Record<string, unknown>> {
    if (!query)
        return {
            error: "Missing query",
            hint: "Pass the text (or a CSS selector/XPath) to search for — same query syntax as DevTools' Elements panel search.",
        };

    await sendCommand(target, "DOM.getDocument", { depth: -1 }).catch(() => {});
    const search = await sendCommand(target, "DOM.performSearch", { query });
    if (!search?.searchId || search.resultCount === 0) {
        if (search?.searchId)
            void sendCommand(target, "DOM.discardSearchResults", {
                searchId: search.searchId,
            }).catch(() => {});
        return { message: `No matches for "${query}".`, count: 0, matches: [] };
    }

    const capped = Math.min(search.resultCount, limit);
    const searchResults = await sendCommand(target, "DOM.getSearchResults", {
        searchId: search.searchId,
        fromIndex: 0,
        toIndex: capped,
    }).catch(() => null);
    void sendCommand(target, "DOM.discardSearchResults", {
        searchId: search.searchId,
    }).catch(() => {});

    const nodeIds = searchResults?.nodeIds ?? [];
    const matches = await Promise.all(
        nodeIds.map(async (nodeId) => {
            const describeResult = await sendCommand(target, "DOM.describeNode", {
                nodeId,
            }).catch(() => null);
            const backendNodeId = describeResult?.node?.backendNodeId;
            if (!backendNodeId) return null;

            const [axInfo, resolveResult] = await Promise.all([
                getAxInfoForNode(target, backendNodeId).catch(
                    (): AxInfo => ({}),
                ),
                sendCommand(target, "DOM.resolveNode", { backendNodeId }).catch(
                    () => null,
                ),
            ]);

            let contextText: string | undefined;
            const objectId = resolveResult?.object?.objectId;
            if (objectId) {
                const evalRes = await sendCommand(target, "Runtime.callFunctionOn", {
                    objectId,
                    functionDeclaration: `function() {
                        const target = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
                        const block = target ? (target.closest('p, li, h1, h2, h3, h4, tr, blockquote') || target) : this;
                        return (block.innerText || block.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
                    }`,
                    returnByValue: true,
                }).catch(() => null);
                contextText = evalRes?.result?.value;
                void sendCommand(target, "Runtime.releaseObject", { objectId }).catch(
                    () => {},
                );
            }

            return {
                i: backendNodeId,
                tag: describeResult?.node?.nodeName,
                r: axInfo.role,
                n: axInfo.name,
                context: contextText,
            };
        }),
    );
    const found = matches.filter((m): m is NonNullable<typeof m> => m !== null);

    // Scroll to and flash the first match natively so it's visible on screen
    if (found.length > 0) {
        await sendCommand(target, "DOM.scrollIntoViewIfNeeded", {
            backendNodeId: found[0].i,
        }).catch(() => {});
        const boxModel = await sendCommand(target, "DOM.getBoxModel", {
            backendNodeId: found[0].i,
        }).catch(() => null);
        if (boxModel?.model?.content) {
            const box = quadToBox(boxModel.model.content);
            await showNativeHighlight(target, box, { r: 251, g: 191, b: 36 });
            setTimeout(() => hideNativeHighlight(target), 1200);
        }
    }

    return {
        message: `Found ${search.resultCount} match(es) for "${query}"${search.resultCount > capped ? ` (showing first ${capped})` : ""}. Use these ids with browser_act's click/type or browser_inspect's inspect_element/select_content.`,
        count: search.resultCount,
        matches: found,
    };
}

/**
 * Self-contained: injected two ways below (Runtime.evaluate for a CSS
 * selector, Runtime.callFunctionOn with `this` bound to a resolved node for
 * a nodeId) — same function body either way via .toString(). Serializes an
 * element to lightweight markdown (headings, links, lists, code, emphasis)
 * instead of plain innerText, since browser_select_content exists
 * specifically to feed doc generation, where that structure is the point —
 * reading_mode's plain-text extraction is for when it isn't.
 */
function elementToMarkdown(root: Element): string {
    const SKIP = new Set(["script", "style", "noscript", "svg", "iframe"]);
    function walk(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE)
            return (node.textContent || "").replace(/\s+/g, " ");
        if (node.nodeType !== Node.ELEMENT_NODE) return "";
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        if (SKIP.has(tag)) return "";
        const inner = Array.from(el.childNodes).map(walk).join("");
        switch (tag) {
            case "h1":
                return `\n# ${inner.trim()}\n`;
            case "h2":
                return `\n## ${inner.trim()}\n`;
            case "h3":
                return `\n### ${inner.trim()}\n`;
            case "h4":
            case "h5":
            case "h6":
                return `\n#### ${inner.trim()}\n`;
            case "p":
            case "div":
            case "section":
            case "article":
                return `\n${inner.trim()}\n`;
            case "br":
                return "\n";
            case "li":
                return `\n- ${inner.trim()}`;
            case "a": {
                const href = el.getAttribute("href");
                return href ? `[${inner.trim()}](${href})` : inner;
            }
            case "code":
                return el.closest("pre") ? inner : `\`${inner.trim()}\``;
            case "pre":
                return `\n\`\`\`\n${inner.trim()}\n\`\`\`\n`;
            case "strong":
            case "b":
                return `**${inner.trim()}**`;
            case "em":
            case "i":
                return `*${inner.trim()}*`;
            case "img": {
                const alt = el.getAttribute("alt") || "";
                const src = el.getAttribute("src") || "";
                return src ? `![${alt}](${src})` : "";
            }
            case "tr":
                return `\n${inner}|`;
            case "td":
            case "th":
                return `${inner.trim()} |`;
            default:
                return inner;
        }
    }
    return walk(root).replace(/\n{3,}/g, "\n\n").trim();
}

const DEFAULT_MAX_SELECT_CHARS = 20000;
const DEFAULT_MAX_SELECT_MATCHES = 20;

export async function handleSelectContentCommand(
    target: chrome.debugger.Debuggee,
    opts: {
        selector?: string;
        nodeId?: number;
        maxChars?: number;
        maxMatches?: number;
    },
): Promise<Record<string, unknown>> {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_SELECT_CHARS;
    const maxMatches = opts.maxMatches ?? DEFAULT_MAX_SELECT_MATCHES;

    if (!opts.selector && opts.nodeId == null) {
        return {
            error: "Missing selector or nodeId",
            hint: "Pass a CSS selector to extract from (possibly matching several elements), or a nodeId from browser_inspect's snapshot/find to extract one specific element.",
        };
    }

    let blocks: string[];
    let matchCount: number;

    if (opts.nodeId != null) {
        const resolveResult = await sendCommand(target, "DOM.resolveNode", {
            backendNodeId: opts.nodeId,
        }).catch(() => null);
        const objectId = resolveResult?.object?.objectId;
        if (!objectId) {
            return {
                error: "Failed to resolve node",
                hint: "The node id may be stale (page navigated/re-rendered since the last snapshot). Take a fresh snapshot or browser_inspect({action:\"find\"}) and retry.",
            };
        }
        const res = await sendCommand(target, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function() { return (${elementToMarkdown.toString()})(this); }`,
            returnByValue: true,
        });
        void sendCommand(target, "Runtime.releaseObject", { objectId }).catch(
            () => {},
        );
        if (res?.exceptionDetails) {
            return {
                error: res.exceptionDetails.text,
                hint: "Content extraction threw on this node.",
            };
        }
        blocks = [String(res?.result?.value ?? "")];
        matchCount = 1;
    } else {
        const res = await sendCommand(target, "Runtime.evaluate", {
            expression: `(function(){
                const fn = ${elementToMarkdown.toString()};
                const els = Array.from(document.querySelectorAll(${JSON.stringify(opts.selector)})).slice(0, ${maxMatches});
                return { count: document.querySelectorAll(${JSON.stringify(opts.selector)}).length, blocks: els.map(fn) };
            })()`,
            returnByValue: true,
        });
        if (res?.exceptionDetails) {
            return {
                error: res.exceptionDetails.text,
                hint: "Invalid selector, or extraction threw. Check the selector against the page source.",
            };
        }
        const value = res?.result?.value as
            | { count: number; blocks: string[] }
            | undefined;
        if (!value || value.count === 0) {
            return {
                message: `No elements matched "${opts.selector}".`,
                count: 0,
                blocks: [],
            };
        }
        blocks = value.blocks;
        matchCount = value.count;
    }

    let truncated = false;
    let usedChars = 0;
    const cappedBlocks: string[] = [];
    for (const block of blocks) {
        if (usedChars >= maxChars) {
            truncated = true;
            break;
        }
        const remaining = maxChars - usedChars;
        if (block.length > remaining) {
            cappedBlocks.push(block.slice(0, remaining));
            usedChars += remaining;
            truncated = true;
            break;
        }
        cappedBlocks.push(block);
        usedChars += block.length;
    }

    return {
        message: `Extracted ${cappedBlocks.length} of ${matchCount} matched element(s) as markdown.${matchCount > cappedBlocks.length ? ` Narrow the selector or raise maxMatches/maxChars to get the rest.` : ""}`,
        count: matchCount,
        blocks: cappedBlocks,
        truncated,
    };
}
