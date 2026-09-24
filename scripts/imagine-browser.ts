import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeImagineBrowser, createPlaywrightImagineWorker } from "../src/bot/imagine-browser.js";
import { loadEnv } from "../src/env.js";

/**
 * Manual check for the same Chrome Imagine worker the bot uses.
 * Does not call api.x.ai. The bot calls the worker in-process; this script
 * writes one file and prints its path.
 *
 *   npx tsx scripts/imagine-browser.ts --mode image --prompt "a red cube"
 *   npx tsx scripts/imagine-browser.ts --mode video --prompt "a paper boat"
 */

async function main(): Promise<void> {
  const mode = arg("--mode");
  const prompt = arg("--prompt");
  if (mode !== "image" && mode !== "video") {
    throw new Error('Usage: npx tsx scripts/imagine-browser.ts --mode image|video --prompt "..."');
  }
  if (!prompt?.trim()) {
    throw new Error("Pass --prompt with the text to generate.");
  }
  const env = loadEnv(false);
  const worker = createPlaywrightImagineWorker({
    chromeProfile: env.imagineChromeProfile,
    cdpUrl: env.imagineBrowserCdpUrl,
    headless: env.imagineBrowserHeadless,
    channel: env.imagineBrowserChannel,
    timeoutMs: env.imagineBrowserTimeoutMs,
  });
  try {
    const asset = await worker.generate({ mode, prompt: prompt.trim() });
    const ext = extension(asset.mimeType, mode);
    const file = path.join(os.tmpdir(), `imagine-${mode}-${Date.now()}.${ext}`);
    fs.writeFileSync(file, asset.bytes);
    process.stdout.write(
      `${JSON.stringify({ ok: true, path: file, mimeType: asset.mimeType, bytes: asset.bytes.byteLength })}\n`,
    );
  } finally {
    await closeImagineBrowser();
  }
}

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function extension(mime: string, mode: "image" | "video"): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("webm")) return "webm";
  if (mode === "video") return "mp4";
  return "jpg";
}

main().catch((error: unknown) => {
  const userMessage =
    error && typeof error === "object" && "userMessage" in error && typeof error.userMessage === "string"
      ? error.userMessage
      : undefined;
  const detail = error instanceof Error ? error.message : "Imagine browser failed";
  process.stderr.write(`${userMessage ?? detail}\n`);
  process.exitCode = 1;
});
