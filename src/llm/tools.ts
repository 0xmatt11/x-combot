import type { LlmToolDefinition } from "./client.js";

/**
 * Tools the in-bot agent may call. Image and video generation are not tools.
 * Nothing here starts another assistant.
 */
export const LOOKUP_USER_TIMELINE_TOOL: LlmToolDefinition = {
  name: "lookup_user_timeline",
  description:
    "Read one X account's recent public posts. Use for who someone is, what they post, or a roast that needs their timeline. Pass an @handle. Public posts only.",
  parameters: {
    type: "object",
    properties: {
      username: {
        type: "string",
        description: "X handle, with or without @. Not a numeric id.",
      },
    },
    required: ["username"],
    additionalProperties: false,
  },
};

export const WEB_SEARCH_TOOL: LlmToolDefinition = {
  name: "web_search",
  description:
    "Search the public web for newer information that is not in the chat and not on a public X timeline. One short query. Do not use this for images or video.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const CHAT_TOOL_DEFINITIONS: readonly LlmToolDefinition[] = [
  LOOKUP_USER_TIMELINE_TOOL,
  WEB_SEARCH_TOOL,
];

/** Appended to the group-chat system prompt when tools are available. */
export const USER_CONTEXT_TOOL_NOTE = [
  "You may call lookup_user_timeline for recent public X posts and web_search for newer public web info.",
  "Timeline notes already in the prompt are public posts only.",
  "If a note says a timeline or a search could not be read, say that short line and answer from what you have.",
  "Do not print numeric user ids.",
  "Do not invent search results or posts.",
  "These tools run inside this bot. Do not ask for another assistant.",
].join(" ");
