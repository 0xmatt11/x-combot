import { afterEach, describe, expect, it } from "vitest";
import { fetchImaginePublicImage, parseImaginePublicImageUrl } from "../src/bot/imagine-public.js";
import { loadEnv } from "../src/env.js";

const JPEG =
  "https://imagine-public.x.ai/imagine-public/images/8f99def9-25a9-4803-b281-873fd4564123.jpg";

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

describe("BOOBS_IMAGINE_APP", () => {
  const previous = {
    owner: process.env.BOT_OWNER_ID,
    app: process.env.BOOBS_IMAGINE_APP,
    chest: process.env.BOOBS_IMAGINE_PUBLIC_URL,
    booty: process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URL,
  };

  afterEach(() => {
    restore("BOT_OWNER_ID", previous.owner);
    restore("BOOBS_IMAGINE_APP", previous.app);
    restore("BOOBS_IMAGINE_PUBLIC_URL", previous.chest);
    restore("BOOBS_IMAGINE_PUBLIC_BOOTY_URL", previous.booty);
  });

  it("stays off unless set, and rejects a URL that is not a public JPEG", () => {
    process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "1";
    delete process.env.BOOBS_IMAGINE_APP;
    delete process.env.BOOBS_IMAGINE_PUBLIC_URL;
    delete process.env.BOOBS_IMAGINE_PUBLIC_BOOTY_URL;
    expect(loadEnv(true).boobsImagineApp).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicUrl).toBeUndefined();
    expect(loadEnv(true).boobsImaginePublicBootyUrl).toBeUndefined();

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
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
