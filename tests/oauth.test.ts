import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, DM_SCOPES, generatePkce } from "../src/oauth.js";
import { isGroupConversation } from "../src/x/client.js";

describe("OAuth 2.0 PKCE helpers", () => {
  it("builds the documented authorize URL with DM scopes", () => {
    const { challenge } = generatePkce();
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "abc",
        redirectUri: "http://127.0.0.1:3000/callback",
        state: "xyz",
        challenge,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([...DM_SCOPES].sort());
  });
});

describe("isGroupConversation", () => {
  it("treats hyphenated IDs as 1:1 and snowflakes as groups", () => {
    expect(isGroupConversation("111-222")).toBe(false);
    expect(isGroupConversation("1578398451921985538")).toBe(true);
  });
});
