export const MAX_BATCH_URLS = 100;
export const MAX_CONCURRENCY = 32;
export const FETCH_TIMEOUT_MS = 12000;
export const DEFAULT_MAX_CHARS_PER_URL = 15000;

export const TRACKING_PARAMS = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "source",
    "fbclid",
    "gclid",
    "_ga",
];

export const NOISE_SELECTORS = [
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
    "[hidden]",
].join(",");

export const CANONICAL_SELECTORS = [
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
