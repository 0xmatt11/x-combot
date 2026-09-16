import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function csv(name: string): string[] {
  const value = optional(name);
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface Env {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  botOwnerId: string;
  adminIds: string[];
  botUserId?: string;
  configPath: string;
  databasePath: string;
  tokenPath: string;
  pollIntervalMs?: number;
}

export function loadEnv(requireOwner = true): Env {
  const botOwnerId = requireOwner
    ? required("BOT_OWNER_ID")
    : (optional("BOT_OWNER_ID") ?? "0");

  const pollRaw = optional("POLL_INTERVAL_MS");
  return {
    clientId: optional("CLIENT_ID"),
    clientSecret: optional("CLIENT_SECRET"),
    redirectUri: optional("REDIRECT_URI") ?? "http://127.0.0.1:3000/callback",
    accessToken: optional("ACCESS_TOKEN"),
    refreshToken: optional("REFRESH_TOKEN"),
    botOwnerId,
    adminIds: csv("ADMIN_IDS"),
    botUserId: optional("BOT_USER_ID"),
    configPath: path.resolve(optional("CONFIG_PATH") ?? "config/default.yaml"),
    databasePath: path.resolve(optional("DATABASE_PATH") ?? "data/bot.sqlite"),
    tokenPath: path.resolve(optional("TOKEN_PATH") ?? "data/tokens.json"),
    pollIntervalMs: pollRaw ? Number(pollRaw) : undefined,
  };
}
