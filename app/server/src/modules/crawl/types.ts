export interface DeepCrawlInput {
  seedUrls?: string[];
  searchQuery?: string;
  depth?: number;
  maxPages?: number;
  concurrency?: number;
  sameDomainOnly?: boolean;
  matchPattern?: string;
  excludePattern?: string;
  maxCharsPerPage?: number;
  maxCharsPerUrl?: number;
  maxOutlinksPerPage?: number;
}

export interface CrawlItemResult {
  url: string;
  normalizedUrl: string;
  title: string;
  author?: string;
  publishedTime?: string;
  readingTime?: string;
  description?: string;
  text: string;
  isArticle: boolean;
  contentSelector?: string;
  outlinks: string[];
  fetchDurationMs: number;
  status: number;
  error?: string;
}

export interface BatchCrawlOptions {
  maxCharsPerUrl?: number;
  concurrency?: number;
  timeoutMs?: number;
  saveToDocs?: boolean;
  sessionId?: string;
}

export interface QueueEntry {
  url: string;
  depth: number;
}

export interface Crawl {
  id: string;
  seedUrls: string[];
  searchQuery?: string;
  depth: number;
  maxPages: number;
  concurrency: number;
  sameDomainOnly: boolean;
  matchRegex?: RegExp;
  excludeRegex?: RegExp;
  maxCharsPerPage: number;
  sessionId: string;
  allowedHosts: Set<string>;
  visited: Set<string>;
  pages: CrawlItemResult[];
  queue: QueueEntry[];
  activeWorkers: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
}
