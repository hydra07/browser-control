export type JobTaskExtract = "reading_mode" | "select_content" | "snapshot";

export interface JobTaskInput {
  url: string;
  extract?: JobTaskExtract;
  /** Only meaningful for extract: "select_content". */
  selector?: string;
}

export interface JobTask extends JobTaskInput {
  extract: JobTaskExtract;
  status: "pending" | "running" | "success" | "error";
  title?: string;
  chars?: number;
  blockIds?: number[];
  error?: string;
  delivered: boolean;
}

export interface Job {
  id: string;
  sessionId: string;
  tasks: JobTask[];
  concurrency: number;
  startedAt: number;
  finishedAt?: number;
}
