import { log } from "../log.js";
import type { ApiError } from "../x/live-client.js";
import { chatReceivedSubscriptionBody, hasChatReceivedSubscription } from "./activity.js";

export interface ActivitySubscriptionClient {
  /** App-only bearer. List is forbidden with the user access token (403). */
  listActivitySubscriptions(appBearer: string): Promise<unknown>;
  /** User access token (scope dm.read). The app-only bearer cannot create chat.received. */
  createActivitySubscription(body: Record<string, unknown>): Promise<unknown>;
}

/**
 * App-only bearer for list and stream. Missing bearer must fail here so callers
 * do not send the user token and retry a 403 forever.
 * Create `chat.received` stays on the user access token.
 */
export function requireActivityAppBearer(
  token: string | undefined,
  usage: "list" | "stream",
): string {
  const bearer = token?.trim();
  if (bearer) return bearer;
  const endpoint =
    usage === "list" ? "GET /2/activity/subscriptions" : "GET /2/activity/stream";
  throw new Error(
    `ACTIVITY_BEARER_TOKEN is required for ${endpoint}. The user access token is forbidden. Create chat.received with POST /2/activity/subscriptions using the user access token (scope dm.read).`,
  );
}

/**
 * Ensure one `chat.received` subscription for the bot user.
 * List uses the app-only bearer. Create uses the user access token (`dm.read`).
 * `conversation_type=group` drops 1:1 noise. If X rejects that qualifier, retry without it.
 */
export async function ensureChatActivitySubscription(
  client: ActivitySubscriptionClient,
  userId: string,
  appBearer?: string,
): Promise<void> {
  const bearer = requireActivityAppBearer(appBearer, "list");
  const existing = await client.listActivitySubscriptions(bearer);
  if (hasChatReceivedSubscription(existing, userId)) {
    log.info(`Activity subscription chat.received already exists for ${userId}`);
    return;
  }

  try {
    await client.createActivitySubscription(chatReceivedSubscriptionBody(userId, true));
    log.info(`Created Activity subscription chat.received for ${userId} (group only)`);
    return;
  } catch (error) {
    const status = (error as ApiError).status;
    if (status === 409) {
      log.info(`Activity subscription chat.received already exists for ${userId}`);
      return;
    }
    if (status !== 400) throw error;
    log.warn(
      "chat.received subscription with conversation_type=group was rejected; retrying without the qualifier",
    );
  }

  await client.createActivitySubscription(chatReceivedSubscriptionBody(userId, false));
  log.info(`Created Activity subscription chat.received for ${userId}`);
}
