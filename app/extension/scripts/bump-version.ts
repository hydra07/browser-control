#!/usr/bin/env bun
// Bumps this package's version. WXT reads the extension's manifest version
// straight from package.json at build time (no separate manifest.json file
// to keep in sync anymore — that was the whole point of moving to WXT's
// generated manifest), so this is the one and only place a version lives.
// Never touches git — committing, tagging, and pushing stay deliberate
// steps you take yourself; this only prints them.
//
// Usage:
//   bun run version:bump 1.13.0
//   bun run version:bump patch   # or minor / major
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_PATH = join(import.meta.dir, "..", "package.json");

const arg = process.argv[2];
if (!arg) {
    console.error("Usage: bun run version:bump <newVersion|patch|minor|major>");
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
const current = String(pkg.version);

function bump(version: string, kind: string): string {
    const [major, minor, patch] = version.split(".").map((n) => parseInt(n, 10) || 0);
    if (kind === "major") return `${major + 1}.0.0`;
    if (kind === "minor") return `${major}.${minor + 1}.0`;
    if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
    return kind; // an explicit version string was passed instead of a bump kind
}

const next = ["major", "minor", "patch"].includes(arg) ? bump(current, arg) : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error(
        `"${next}" isn't a valid X.Y.Z version — Chrome's manifest version field requires dot-separated integers.`,
    );
    process.exit(1);
}

pkg.version = next;
writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + "\n");
console.log(`package.json: ${current} -> ${next}`);

console.log(`\nNext (not run automatically):`);
console.log(`  git add package.json`);
console.log(`  git commit -m "chore: bump extension version to v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push && git push --tags`);
