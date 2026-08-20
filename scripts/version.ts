// Shared version helpers. manifest.json is the single source of truth for
// this project's version — it's the Chrome extension, which is what
// actually gets released/loaded by a browser. package.json and daemon.ts's
// own MCP server version used to each hand-carry their own number, which is
// exactly how they drifted (package.json said 1.9.0, manifest.json said
// 1.12.1, daemon.ts hardcoded a third value) — daemon.ts now reads
// manifest.json live at startup, and package.json gets synced by
// syncPackageVersion() below (wired into `bun run build`, see sync-version.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const MANIFEST_PATH = join(ROOT, "manifest.json");
export const PACKAGE_PATH = join(ROOT, "package.json");

export function readManifestVersion(): string {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).version;
}

/** Copies manifest.json's version into package.json if they've drifted. Returns true if package.json was changed. */
export function syncPackageVersion(): boolean {
    const version = readManifestVersion();
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
    if (pkg.version === version) return false;
    const oldVersion = pkg.version;
    pkg.version = version;
    writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`package.json version: ${oldVersion} -> ${version}`);
    return true;
}
