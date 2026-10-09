import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeHistoryExport, resolveHistoryDatabasePath } from "../src/cli/history-export.js";

/**
 * Operator export of the local chat transcript. Not a chat command.
 * Opens DATABASE_PATH read-only and writes a mode 0600 file.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (invokedDirectly()) {
  const result = executeHistoryExport(process.argv.slice(2), {
    dbPath: resolveHistoryDatabasePath(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
