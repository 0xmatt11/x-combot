import http from "node:http";
import { loadEnv } from "../src/env.js";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkce,
} from "../src/oauth.js";
import { persistTokens } from "../src/x/live-client.js";

async function main(): Promise<void> {
  const env = loadEnv(false);
  if (!env.clientId) {
    throw new Error("CLIENT_ID is required. Copy .env.example to .env and fill it in.");
  }

  const redirect = new URL(env.redirectUri);
  const { verifier, challenge } = generatePkce();
  const state = generatePkce().verifier.slice(0, 24);
  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.clientId,
    redirectUri: env.redirectUri,
    state,
    challenge,
  });

  console.log("X OAuth 2.0 user-context (PKCE)");
  console.log("Scopes: dm.read dm.write tweet.read users.read offline.access");
  console.log("");
  console.log("1. Sign in as the bot account.");
  console.log("2. Open this URL in a browser:\n");
  console.log(authorizeUrl);
  console.log("\nWaiting for the callback on", env.redirectUri);

  const { code } = await waitForCallback(redirect, state);
  const token = await exchangeAuthorizationCode({
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    redirectUri: env.redirectUri,
    code,
    verifier,
  });

  persistTokens(env.tokenPath, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAtMs: Date.now() + (token.expires_in ?? 7200) * 1000,
  });

  console.log("\nStored tokens at", env.tokenPath);
  console.log("You can also set ACCESS_TOKEN in .env (expires in ~2 hours without refresh).");
  if (token.scope) {
    console.log("Granted scopes:", token.scope);
  }
  process.exit(0);
}

function waitForCallback(
  redirect: URL,
  expectedState: string,
): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("missing url");
        return;
      }
      const requestUrl = new URL(req.url, `${redirect.protocol}//${redirect.host}`);
      if (requestUrl.pathname !== redirect.pathname) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const code = requestUrl.searchParams.get("code");
      const state = requestUrl.searchParams.get("state");
      const error = requestUrl.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(error));
        return;
      }
      if (!code || state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid callback (code/state).");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Authorization complete. You can close this tab and return to the terminal.");
      server.close();
      resolve({ code });
    });

    const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
    const host = redirect.hostname;
    server.listen(port, host, () => {
      /* ready */
    });
    server.on("error", reject);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
