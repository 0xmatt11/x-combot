import { describe, expect, it } from "vitest";
import {
  createWebSearch,
  formatWebSearchResult,
  parseDuckDuckGoHtml,
  WEB_SEARCH_EMPTY,
  WEB_SEARCH_UNAVAILABLE,
} from "../src/bot/web-search.js";

const PAGE = `
<html><body>
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fmilady&amp;rut=1">Milady &amp; friends</a>
  <a class="result__snippet" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fmilady">A public note.</a>
  <a class="result__a" href="http://insecure.example/nope">Skip me</a>
  <a class="result__snippet">nope</a>
</body></html>`;

describe("parseDuckDuckGoHtml", () => {
  it("unwraps https results and skips insecure urls", () => {
    const hits = parseDuckDuckGoHtml(PAGE);
    expect(hits).toEqual([
      {
        title: "Milady & friends",
        url: "https://example.com/milady",
        snippet: "A public note.",
      },
    ]);
  });
});

describe("createWebSearch", () => {
  it("caches a hit and fails soft without calling api.x.ai", async () => {
    const urls: string[] = [];
    let now = 1_000;
    const search = createWebSearch({
      now: () => now,
      ttlMs: 1_000,
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        expect(url).not.toContain("api.x.ai");
        expect(url).not.toContain("grok.com");
        expect(url.startsWith("https://html.duckduckgo.com/html/?q=")).toBe(true);
        return new Response(PAGE, { status: 200 });
      },
    });
    const first = await search.search("  milady maker  ");
    const second = await search.search("milady maker");
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(first.results).toHaveLength(1);
    expect(urls).toHaveLength(1);
    expect(formatWebSearchResult(first)).toContain("https://example.com/milady");
    now += 1_001;
    await search.search("milady maker");
    expect(urls).toHaveLength(2);
  });

  it("returns a short error when the request fails and does not throw", async () => {
    const search = createWebSearch({
      fetchImpl: async () => new Response("no", { status: 503 }),
    });
    const result = await search.search("milady");
    expect(result.error).toBe(WEB_SEARCH_UNAVAILABLE);
    expect(result.results).toEqual([]);
    expect(formatWebSearchResult(result)).toBe(WEB_SEARCH_UNAVAILABLE);
  });

  it("does not fetch an empty query", async () => {
    let called = false;
    const search = createWebSearch({
      fetchImpl: async () => {
        called = true;
        return new Response("", { status: 200 });
      },
    });
    const result = await search.search("   ");
    expect(called).toBe(false);
    expect(result.error).toBe(WEB_SEARCH_EMPTY);
  });
});
