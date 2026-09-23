import { log } from "../log.js";
import type { ApiError } from "../x/live-client.js";
import { chatReceivedSubscriptionBody, hasChatReceivedSubscription } from "./activity.js";

export interface ActivitySubscriptionClient {
  listActivitySubscriptions(): Promise<unknown>;
  createActivitySubscription(body: Record<string, unknown>): Promise<unknown>;
}

/**
 * Ensure one `chat.received` subscription for the bot user.
 * `dm.read` is the documented scope for `chat.*` events; no extra scope is added.
 * `conversation_type=group` drops 1:1 noise. If X rejects that qualifier, retry without it.
 */
export async function ensureChatActivitySubscription(
  client: ActivitySubscriptionClient,
  userId: string,
): Promise<void> {
  const existing = await client.listActivitySubscriptions();
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
