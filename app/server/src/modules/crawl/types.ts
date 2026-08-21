export interface DeepCrawlInput {
  seedUrls?: string[];
  searchQuery?: string;
  depth?: number;
  maxPages?: number;
  maxOutlinksPerPage?: number;
  concurrency?: number;
  maxCharsPerUrl?: number;
}

export interface VisitedPage {
  url: string;
  depth: number;
  status: "success" | "error";
  title?: string;
  error?: string;
  delivered: boolean;
}

export interface Crawl {
  id: string;
  sessionId: string;
  depth: number;
  maxPages: number;
  maxOutlinksPerPage: number;
  concurrency: number;
  pages: VisitedPage[];
  status: "running" | "done" | "error";
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface QueueEntry {
  url: string;
  depth: number;
}
