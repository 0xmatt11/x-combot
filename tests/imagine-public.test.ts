import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchImaginePublicImage,
  imaginePublicPoolFor,
  imaginePublicUrlsFor,
  parseImaginePublicImageUrl,
  parseImaginePublicImageUrlList,
  parseImaginePublicVideoUrl,
  parseImaginePublicVideoUrlList,
  pickImaginePublicMedia,
  pickImaginePublicUrl,
} from "../src/bot/imagine-public.js";
import { loadEnv } from "../src/env.js";

const JPEG =
  "https://imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg";
const JPEG_B =
  "https://imagine-public.x.ai/imagine-public/images/11111111-2222-4333-8444-555555555555.jpg";
const JPEG_C =
  "https://imagine-public.x.ai/imagine-public/images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg";

describe("imagine-public JPEG URL", () => {
  it("accepts a public https JPEG and canonicalizes it", () => {
    expect(parseImaginePublicImageUrl(`  ${JPEG}  `)).toBe(JPEG);
    expect(
      parseImaginePublicImageUrl(
        "https://imagine-public.x.ai/imagine-public/images/8F99DEF9-25A9-4803-B281-873FD4564123.JPEG",
      ),
    ).toBe(JPEG);
  });

  it("rejects other hosts, schemes, queries, and non-JPEG paths", () => {
    expect(parseImaginePublicImageUrl(undefined)).toBeUndefined();
    expect(parseImaginePublicImageUrl("")).toBeUndefined();
    expect(parseImaginePublicImageUrl(JPEG.replace("https://", "http://"))).toBeUndefined();
    expect(parseImaginePublicImageUrl(JPEG.replace(".jpg", ".png"))).toBeUndefined();
    expect(parseImaginePublicImageUrl(`${JPEG}?sig=1`)).toBeUndefined();
    expect(parseImaginePublicImageUrl(`${JPEG}#x`)).toBeUndefined();
    expect(parseImaginePublicImageUrl("https://assets.grok.com/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg")).toBeUndefined();
    expect(parseImaginePublicImageUrl("https://imagine-public.x.ai.evil.test/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg")).toBeUndefined();
    expect(parseImaginePublicImageUrl("https://user:pass@imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg")).toBeUndefined();
    expect(parseImaginePublicImageUrl("not a url")).toBeUndefined();
  });

  it("downloads a JPEG and skips anything that is not one", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    };
    const image = await fetchImaginePublicImage(JPEG, fetchImpl);
    expect(image?.mimeType).toBe("image/jpeg");
    expect(image?.bytes.byteLength).toBe(3);
    expect(calls).toEqual([JPEG]);

    const skipped = await fetchImaginePublicImage("https://cdn.example/a.jpg", fetchImpl);
    expect(skipped).toBeUndefined();
    expect(calls).toEqual([JPEG]);

    const png = await fetchImaginePublicImage(JPEG, async () =>
      new Response(Uint8Array.from([1]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    expect(png).toBeUndefined();
  });
});

describe("booty image bank", () => {
  it("parses a comma, space, or newline list and drops duplicates", () => {
    const mixed = [
      `  ${JPEG} `,
      JPEG_B,
      JPEG_C.replace(".jpg", ".JPEG").replace("aaaaaaaa", "AAAAAAAA"),
      JPEG,
    ].join(", \n");
    const parsed = parseImaginePublicImageUrlList(
      `# comment only\n${mixed}\n# trailing note`,
    );
    expect(parsed.invalid).toEqual([]);
    expect(parsed.urls).toEqual([
      JPEG,
      JPEG_B,
      "https://imagine-public.x.ai/imagine-public/images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg",
    ]);
    expect(parseImaginePublicImageUrlList(undefined)).toEqual({ urls: [], invalid: [] });
    expect(parseImaginePublicImageUrlList("  \n , ")).toEqual({ urls: [], invalid: [] });
  });

  it("reports a token that is not a public JPEG", () => {
    const parsed = parseImaginePublicImageUrlList(`${JPEG}, https://cdn.example/a.jpg`);
    expect(parsed.urls).toEqual([JPEG]);
    expect(parsed.invalid).toEqual(["https://cdn.example/a.jpg"]);
    expect(parseImaginePublicImageUrlList(`${JPEG}?sig=1`)?.invalid).toEqual([`${JPEG}?sig=1`]);
  });

  it("merges the single booty URL into the bank and leaves chest alone", () => {
    expect(
      imaginePublicUrlsFor(
        { bootyUrls: [JPEG, JPEG_B], bootyUrl: JPEG_C },
        "ass",
      ),
    ).toEqual([JPEG, JPEG_B, JPEG_C]);
    expect(
      imaginePublicUrlsFor(
        { bootyUrls: [JPEG_B], bootyUrl: JPEG_B.replace(".jpg", ".jpeg") },
        "booty",
      ),
    ).toEqual([JPEG_B]);
    expect(imaginePublicUrlsFor({ bootyUrl: JPEG }, "booty")).toEqual([JPEG]);
    expect(
      imaginePublicUrlsFor({ chestUrl: JPEG, bootyUrls: [JPEG_B, JPEG_C] }, "boobs"),
    ).toEqual([JPEG]);
    expect(imaginePublicUrlsFor(undefined, "ass")).toEqual([]);
  });

  it("picks uniformly and does not roll a one-item list", () => {
    const urls = [JPEG, JPEG_B, JPEG_C];
    expect(pickImaginePublicUrl(urls, () => 0)).toBe(JPEG);
    expect(pickImaginePublicUrl(urls, () => 0.34)).toBe(JPEG_B);
    expect(pickImaginePublicUrl(urls, () => 0.67)).toBe(JPEG_C);
    expect(pickImaginePublicUrl(urls, () => 0.999)).toBe(JPEG_C);
    expect(pickImaginePublicUrl(urls, () => 1)).toBe(JPEG_C);
    expect(pickImaginePublicUrl([], () => 0)).toBeUndefined();

    let calls = 0;
    expect(
      pickImaginePublicUrl([JPEG], () => {
        calls += 1;
        return 0.9;
      }),
    ).toBe(JPEG);
    expect(calls).toBe(0);
  });

  it("accepts every URL in the checked-in example bank", () => {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../config/booty-bank.example.txt",
    );
    const parsed = parseImaginePublicImageUrlList(readFileSync(file, "utf8"));
    expect(parsed.invalid).toEqual([]);
    expect(parsed.urls).toHaveLength(26);
    expect(new Set(parsed.urls).size).toBe(26);
  });
});

const ASS_MP4 =
  "https://imagine-public.x.ai/imagine-public/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4";
const BOOTY_MP4 = "https://vidgen.x.ai/booty-clip.mp4?X-Amz-Signature=abc%2B";
const BOOBS_MP4 =
  "https://imagine-public.x.ai/imagine-public/videos/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4";

describe("imagine-public video banks", () => {
  it("accepts an imagine-public mp4 and a signed https mp4", () => {
    expect(parseImaginePublicVideoUrl(`  ${ASS_MP4}  `)).toBe(ASS_MP4);
    expect(
      parseImaginePublicVideoUrl(
        "https://imagine-public.x.ai/imagine-public/videos/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.MP4",
      ),
    ).toBe(ASS_MP4);
    expect(parseImaginePublicVideoUrl(BOOTY_MP4)).toBe(BOOTY_MP4);
    expect(parseImaginePublicVideoUrl(undefined)).toBeUndefined();
    expect(parseImaginePublicVideoUrl("")).toBeUndefined();
    expect(parseImaginePublicVideoUrl(ASS_MP4.replace("https://", "http://"))).toBeUndefined();
    expect(parseImaginePublicVideoUrl(`${ASS_MP4}?sig=1`)).toBeUndefined();
    expect(parseImaginePublicVideoUrl(`${ASS_MP4}#x`)).toBeUndefined();
    expect(parseImaginePublicVideoUrl(ASS_MP4.replace(".mp4", ".jpg"))).toBeUndefined();
    expect(parseImaginePublicVideoUrl("https://user:pass@vidgen.x.ai/clip.mp4")).toBeUndefined();
    expect(parseImaginePublicVideoUrl("not a url")).toBeUndefined();
  });

  it("parses a comma, space, or newline video list and drops duplicates", () => {
    const parsed = parseImaginePublicVideoUrlList(
      `# clips\n${ASS_MP4}, ${BOOTY_MP4}\n${ASS_MP4} ${BOOBS_MP4}`,
    );
    expect(parsed.invalid).toEqual([]);
    expect(parsed.urls).toEqual([ASS_MP4, BOOTY_MP4, BOOBS_MP4]);
    expect(parseImaginePublicVideoUrlList(undefined)).toEqual({ urls: [], invalid: [] });
    expect(parseImaginePublicVideoUrlList("  \n , ")).toEqual({ urls: [], invalid: [] });
    expect(parseImaginePublicVideoUrlList(`${ASS_MP4} https://cdn.example/a.jpg`).invalid).toEqual([
      "https://cdn.example/a.jpg",
    ]);
  });

  it("mixes command stills with that command's videos only", () => {
    const source = {
      chestUrl: JPEG,
      bootyUrl: JPEG_B,
      bootyUrls: [JPEG_C],
      assVideoUrls: [ASS_MP4],
      bootyVideoUrls: [BOOTY_MP4],
      boobsVideoUrls: [BOOBS_MP4, ASS_MP4],
    };
    const boobs = imaginePublicPoolFor(source, "boobs");
    const ass = imaginePublicPoolFor(source, "ass");
    const booty = imaginePublicPoolFor(source, "booty");
    expect(boobs).toEqual([
      { kind: "image", url: JPEG },
      { kind: "video", url: BOOBS_MP4 },
      { kind: "video", url: ASS_MP4 },
    ]);
    expect(ass).toEqual([
      { kind: "image", url: JPEG_C },
      { kind: "image", url: JPEG_B },
      { kind: "video", url: ASS_MP4 },
    ]);
    expect(booty).toEqual([
      { kind: "image", url: JPEG_C },
      { kind: "image", url: JPEG_B },
      { kind: "video", url: BOOTY_MP4 },
    ]);
    expect(ass.map((item) => item.url)).not.toContain(BOOTY_MP4);
    expect(booty.map((item) => item.url)).not.toContain(ASS_MP4);
    expect(boobs.map((item) => item.url)).not.toContain(JPEG_B);

    expect(pickImaginePublicMedia(boobs, () => 0)).toEqual({ kind: "image", url: JPEG });
    expect(pickImaginePublicMedia(boobs, () => 0.34)).toEqual({ kind: "video", url: BOOBS_MP4 });
    expect(pickImaginePublicMedia(boobs, () => 0.67)).toEqual({ kind: "video", url: ASS_MP4 });
    expect(pickImaginePublicMedia(boobs, () => 0.999)?.kind).toBe("video");
    let calls = 0;
    expect(
      pickImaginePublicMedia([{ kind: "video", url: ASS_MP4 }], () => {
        calls += 1;
        return 0.9;
      }),
    ).toEqual({ kind: "video", url: ASS_MP4 });
    expect(calls).toBe(0);
    expect(pickImaginePublicMedia([], () => 0)).toBeUndefined();
  });
});

describe("BOOBS_IMAGINE_APP", () => {
  const previous = {
    owner: process.env.BOT_OWNER_ID,
    app: process.env.BOOBS_IMAGINE_APP,
    chest: process.env.BOOBS_IMAGINE_PUBLIC_URL,
    booty: process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URL,
    bank: process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URLS,
    assVideos: process.env.BOOBS_IMAGINE_PUBLIC_ASS_VIDEO_URLS,
    bootyVideos: process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_VIDEO_URLS,
    boobsVideos: process.env.BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS,
  };

  afterEach(() => {
    restore("BOT_OWNER_ID", previous.owner);
    restore("BOOBS_IMAGINE_APP", previous.app);
    restore("BOOBS_IMAGINE_PUBLIC_URL", previous.chest);
    restore("BOOBS_IMAGINE_PUBLIC_BOOTY_URL", previous.booty);
    restore("BOOBS_IMAGINE_PUBLIC_BOOTY_URLS", previous.bank);
    restore("BOOBS_IMAGINE_PUBLIC_ASS_VIDEO_URLS", previous.assVideos);
    restore("BOOBS_IMAGINE_PUBLIC_BOOTY_VIDEO_URLS", previous.bootyVideos);
    restore("BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS", previous.boobsVideos);
  });

  it("stays off unless set, and rejects a URL that is not a public JPEG", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    delete process.env.BOOBS_IMAGINE_APP;
    delete process.env.BOOBS_IMAGINE_PUBLIC_URL;
    delete process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URL;
    delete process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URLS;
    delete process.env.BOOBS_IMAGINE_PUBLIC_ASS_VIDEO_URLS;
    delete process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_VIDEO_URLS;
    delete process.env.BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS;
    expect(loadEnv(true).boobsImagineApp).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicUrl).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicBootyUrl).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicBootyUrls).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicAssVideoUrls).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicBootyVideoUrls).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicBoobsVideoUrls).toBeUndefined();

    process.env.BOOBS_IMAGINE_APP = "false";
    expect(loadEnv(true).boobsImagineApp).toBe(false);
    process.env.BOOBS_IMAGINE_APP = "true";
    process.env.BOOBS_IMAGINE_PUBLIC_URL = JPEG;
    process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URL =
      "https://imagine-public.x.ai/imagine-public/images/11111111-2222-4333-8444-555555555555.jpeg";
    const env = loadEnv(true);
    expect(env.boobsImagineApp).toBe(true);
    expect(env.boobsImaginePublicUrl).toBe(JPEG);
    expect(env.boobsImaginePublicBootyUrl).toBe(
      "https://imagine-public.x.ai/imagine-public/images/11111111-2222-4333-8444-555555555555.jpg",
    );

    process.env.BOOBS_IMAGINE_APP = "maybe";
    expect(() => loadEnv(true)).toThrow(/BOOBS_IMAGINE_APP/);
    process.env.BOOBS_IMAGINE_APP = "true";
    process.env.BOOBS_IMAGINE_PUBLIC_URL = "https://cdn.example/a.jpg";
    expect(() => loadEnv(true)).toThrow(/BOOBS_IMAGINE_PUBLIC_URL/);
    process.env.BOOBS_IMAGINE_PUBLIC_URL = `${JPEG}?X-Amz-Signature=secret`;
    expect(() => loadEnv(true)).toThrow(/no query/);
  });

  it("loads a booty URL list and still accepts the single booty URL", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    process.env.BOOBS_IMAGINE_APP = "true";
    delete process.env.BOOBS_IMAGINE_PUBLIC_URL;
    process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URL = JPEG;
    process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URLS = `${JPEG_B}, ${JPEG_C}\n${JPEG_B.replace(".jpg", ".JPEG")}`;
    const env = loadEnv(true);
    expect(env.boobsImaginePublicBootyUrl).toBe(JPEG);
    expect(env.boobsImaginePublicBootyUrls).toEqual([JPEG_B, JPEG_C]);
    expect(
      imaginePublicUrlsFor(
        {
          bootyUrl: env.boobsImaginePublicBootyUrl,
          bootyUrls: env.boobsImaginePublicBootyUrls,
        },
        "booty",
      ),
    ).toEqual([JPEG_B, JPEG_C, JPEG]);

    process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URLS = " \n , ";
    expect(loadEnv(true).boobsImaginePublicBootyUrls).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicBootyUrl).toBe(JPEG);

    process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URLS = `${JPEG_B} https://cdn.example/a.jpg`;
    expect(() => loadEnv(true)).toThrow(/BOOBS_IMAGINE_PUBLIC_BOOTY_URLS/);
  });

  it("loads per-command video banks and rejects a bad entry", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    process.env.BOOBS_IMAGINE_APP = "true";
    delete process.env.BOOBS_IMAGINE_PUBLIC_URL;
    delete process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URL;
    delete process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URLS;
    process.env.BOOBS_IMAGINE_PUBLIC_ASS_VIDEO_URLS = `${ASS_MP4}, ${ASS_MP4}\n${BOOTY_MP4}`;
    process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_VIDEO_URLS = BOOTY_MP4;
    process.env.BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS = `# chest clips\n${BOOBS_MP4}`;
    const env = loadEnv(true);
    expect(env.boobsImaginePublicAssVideoUrls).toEqual([ASS_MP4, BOOTY_MP4]);
    expect(env.boobsImaginePublicBootyVideoUrls).toEqual([BOOTY_MP4]);
    expect(env.boobsImaginePublicBoobsVideoUrls).toEqual([BOOBS_MP4]);

    process.env.BOOBS_IMAGINE_PUBLIC_ASS_VIDEO_URLS = " \n , ";
    expect(loadEnv(true).boobsImaginePublicAssVideoUrls).toBeUndefined();

    process.env.BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS = `${BOOBS_MP4} https://cdn.example/clip.jpg`;
    expect(() => loadEnv(true)).toThrow(/BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS/);
    process.env.BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS = `${BOOBS_MP4}?sig=1`;
    expect(() => loadEnv(true)).toThrow(/BOOBS_IMAGINE_PUBLIC_BOOBS_VIDEO_URLS/);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
