// browser_select_content, browser_batch_crawl, and the job runner (jobs.ts)
// all crawl content that must NOT go back through an MCP tool response —
// that's exactly the context an AI has the least room to spare and a crawl
// target has the most content for. Instead every call appends to ONE
// running markdown file per daemon session, and callers get back a path +
// a short preview/summary — the AI reads the file itself (in chunks) when
// it's ready to use the content, never all of it forced into one response.
import { mkdirSync, appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "..", "..", "data");
const DOCS_DIR = join(DATA_DIR, "docs");
try { mkdirSync(DOCS_DIR, { recursive: true }); } catch {}

export const DOCS_FILE = join(DOCS_DIR, `docs-${Date.now()}.md`);

export function appendContentToDocsFile(
  blocks: string[],
  source: string,
): { appendedChars: number; totalFileChars: number } {
  const body = `\n\n<!-- ${new Date().toISOString()} — ${source} -->\n\n${blocks.join("\n\n---\n\n")}\n`;
  appendFileSync(DOCS_FILE, body);
  const totalFileChars = existsSync(DOCS_FILE) ? statSync(DOCS_FILE).size : body.length;
  return { appendedChars: body.length, totalFileChars };
}
