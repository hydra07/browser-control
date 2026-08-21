/**
 * Every on-disk location this server reads/writes, resolved once here
 * relative to this file's own fixed location instead of each module
 * recomputing `join(import.meta.dir, "..", ...)` for itself — that
 * per-module math silently broke when cliAgent.ts's DATA_DIR (3 `..` for
 * a file 4 levels deep) ended up pointing at app/server/data instead of
 * the repo's data/ during the module split, and would have gone
 * unnoticed until the Chat tab's sandbox setup ran.
 */
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

export const DATA_DIR = join(REPO_ROOT, "data");
export const IMAGES_DIR = join(DATA_DIR, "images");
export const VIDEOS_DIR = join(DATA_DIR, "videos");
export const LOGS_DIR = join(DATA_DIR, "logs");
export const HAR_DIR = join(DATA_DIR, "har");
export const AGENT_SANDBOX_DIR = join(DATA_DIR, "sandbox", "agent");
export const MCP_CONFIG_PATH = join(AGENT_SANDBOX_DIR, "mcp-config.json");
export const DB_PATH = join(DATA_DIR, "index.sqlite");

/** Pre-migration locations — daemon.ts moves anything found here into the data/-rooted paths above on startup; readers fall back to these only if that hasn't happened yet in this checkout. */
export const LEGACY_LOGS_DIR = join(REPO_ROOT, "logs");

/** Not under data/ — skills are durable per-site notes, not session artifacts, so they don't share data/'s "safe to gc" retention story. */
export const SKILLS_DIR = join(REPO_ROOT, "skills");
