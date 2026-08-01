#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    console.log(readVersion());
    process.exit(0);
  }

  console.log("xharness: REPL not implemented yet");
  process.exit(0);
}

main();
