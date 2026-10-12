import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeImagineCli } from "../src/cli/imagine.js";

/**
 * Operator switch for !imagine and !video. Not a chat command.
 * Writes data/imagine-toggle.json (mode 0600). The running bot rereads it.
 *
 *   npm run imagine -- status
 *   npm run imagine -- off --for 7d
 *   npm run imagine -- on
 */

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (invokedDirectly()) {
  const result = executeImagineCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
