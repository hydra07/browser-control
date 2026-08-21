export const MAX_CRAWL_DEPTH = 5;
export const MAX_CRAWL_PAGES = 1000;
export const MAX_CONCURRENT_CRAWLS = 2;

/**
 * Per-page fetch timeout, not a whole-crawl one — a crawl processing
 * hundreds of pages has no single sensible overall deadline, but one page
 * hanging shouldn't tie up a worker slot forever either.
 */
export const PAGE_TIMEOUT_MS = 30000;
