#!/usr/bin/env bun
// Bumps manifest.json's version (the source of truth — see version.ts) and
// syncs package.json to match. Never touches git — committing, tagging, and
// pushing stay deliberate steps you take yourself; this only prints them.
//
// Usage:
//   bun run version:bump 1.13.0
//   bun run version:bump patch   # or minor / major
import { readFileSync, writeFileSync } from "node:fs";
import { MANIFEST_PATH, syncPackageVersion } from "./version.js";

const arg = process.argv[2];
if (!arg) {
    console.error(
        "Usage: bun run version:bump <newVersion|patch|minor|major>",
    );
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const current = String(manifest.version);

function bump(version: string, kind: string): string {
    const [major, minor, patch] = version
        .split(".")
        .map((n) => parseInt(n, 10) || 0);
    if (kind === "major") return `${major + 1}.0.0`;
    if (kind === "minor") return `${major}.${minor + 1}.0`;
    if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
    return kind; // an explicit version string was passed instead of a bump kind
}

const next = ["major", "minor", "patch"].includes(arg)
    ? bump(current, arg)
    : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error(
        `"${next}" isn't a valid X.Y.Z version — Chrome's manifest.json version field requires dot-separated integers.`,
    );
    process.exit(1);
}

manifest.version = next;
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest.json: ${current} -> ${next}`);
syncPackageVersion();

console.log(`\nNext (not run automatically):`);
console.log(`  git add manifest.json package.json`);
console.log(`  git commit -m "chore: bump version to v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push && git push --tags`);
