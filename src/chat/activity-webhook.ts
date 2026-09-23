import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { log } from "../log.js";
import { crcResponseToken, verifyWebhookSignature } from "./activity.js";

const MAX_BODY_BYTES = 1_048_576;

export interface ActivityWebhookOptions {
  port: number;
  path: string;
  clientSecret: string;
  onEvent: (body: unknown) => Promise<void>;
}

export interface ActivityWebhook {
  port: number;
  close(): Promise<void>;
}

/**
 * CRC (GET) plus signed event delivery (POST) for X webhooks.
 * `POST /2/webhooks` is not called here; pass `ACTIVITY_WEBHOOK_URL` to register.
 */
export function startActivityWebhook(options: ActivityWebhookOptions): Promise<ActivityWebhook> {
  const server = createServer((req, res) => {
    void handleWebhookRequest(req, res, options).catch((error: unknown) => {
      log.error("Activity webhook request failed", error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      log.info(`Activity webhook listening on port ${port}${options.path}`);
      resolve({
        port,
        close() {
          return new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          });
        },
      });
    });
  });
}

async function handleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ActivityWebhookOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== options.path) {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === "GET") {
    const crcToken = url.searchParams.get("crc_token");
    if (!crcToken) {
      res.writeHead(400);
      res.end("Missing crc_token");
      return;
    }
    const body = JSON.stringify({
      response_token: crcResponseToken(crcToken, options.clientSecret),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  const raw = await readBody(req);
  const oauth2 = header(req, "x-twitter-webhooks-signature-oauth2");
  const legacy = header(req, "x-twitter-webhooks-signature");
  const signature = oauth2 ?? legacy;
  if (!verifyWebhookSignature(raw, signature, options.clientSecret)) {
    res.writeHead(401);
    res.end("Invalid signature");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    res.writeHead(400);
    res.end("Invalid JSON");
    return;
  }

  res.writeHead(200);
  res.end();
  try {
    await options.onEvent(parsed);
  } catch (error) {
    log.error("Activity webhook event failed", error);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Activity webhook body exceeds 1MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
