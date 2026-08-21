export interface CrawlItemResult {
    url: string;
    normalizedUrl: string;
    status: "success" | "error" | "skipped_duplicate";
    fetchDurationMs?: number;
    title?: string;
    byline?: string;
    publishedTime?: string;
    readingTime?: string;
    description?: string;
    markdown?: string;
    length?: number;
    outlinks?: string[];
    error?: string;
}
