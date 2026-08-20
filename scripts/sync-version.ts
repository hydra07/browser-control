#!/usr/bin/env bun
// Runs as the first step of `bun run build` so package.json can never sit
// stale against manifest.json (the source of truth — see version.ts)
// without anyone noticing.
import { syncPackageVersion, readManifestVersion } from "./version.js";

if (!syncPackageVersion()) {
    console.log(`package.json already at ${readManifestVersion()}`);
}
