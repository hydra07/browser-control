#!/usr/bin/env bun

import { loadAuthToken, rotateAuthToken } from "./configs/auth.js";

const command = process.argv[2] ?? "show";

if (command === "show") {
  console.log(loadAuthToken());
} else if (command === "rotate") {
  console.log(rotateAuthToken());
} else {
  console.error("Usage: bun run src/authCli.ts [show|rotate]");
  process.exitCode = 2;
}
