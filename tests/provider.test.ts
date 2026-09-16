import { describe, expect, it } from "vitest";
import {
  normalizeLlmProvider,
  resolveLlmConnection,
  PROVIDER_DEFAULTS,
} from "../src/llm/provider.js";

describe("normalizeLlmProvider", () => {
  it("maps aliases to openai, grok, and local", () => {
    expect(normalizeLlmProvider("openai")?.id).toBe("openai");
    expect(normalizeLlmProvider("grok")?.id).toBe("grok");
    expect(normalizeLlmProvider("xai")?.id).toBe("grok");
    expect(normalizeLlmProvider("local")?.id).toBe("local");
    expect(normalizeLlmProvider("ollama")?.id).toBe("local");
    expect(normalizeLlmProvider("openai-compatible")?.id).toBe("local");
    expect(normalizeLlmProvider("lmstudio")?.alias).toBe("lmstudio");
    expect(normalizeLlmProvider("nope")).toBeUndefined();
  });
});

describe("resolveLlmConnection", () => {
  it("defaults to OpenAI chat completions", () => {
    const result = resolveLlmConnection({ openaiApiKey: "sk-test" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.provider).toBe("openai");
    expect(result.connection.baseUrl).toBe(PROVIDER_DEFAULTS.openai.baseUrl);
    expect(result.connection.model).toBe("gpt-4o-mini");
    expect(result.connection.apiKey).toBe("sk-test");
    expect(result.explicit).toBe(false);
  });

  it("resolves Grok/xAI with documented base URL and current chat model", () => {
    const result = resolveLlmConnection({
      provider: "grok",
      xaiApiKey: "xai-key",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.provider).toBe("grok");
    expect(result.connection.baseUrl).toBe("https://api.x.ai/v1");
    expect(result.connection.model).toBe("grok-4.6");
    expect(result.connection.apiKey).toBe("xai-key");
  });

  it("uses XAI_API_KEY over LLM_API_KEY over OPENAI_API_KEY for grok", () => {
    const result = resolveLlmConnection({
      provider: "xai",
      xaiApiKey: "from-xai",
      llmApiKey: "from-llm",
      openaiApiKey: "from-openai",
    });
    expect(result.ok && result.connection.apiKey).toBe("from-xai");

    const fallback = resolveLlmConnection({
      provider: "grok",
      openaiApiKey: "from-openai",
    });
    expect(fallback.ok && fallback.connection.apiKey).toBe("from-openai");
  });

  it("defaults local/Ollama to loopback :11434 and does not require a cloud key", () => {
    const result = resolveLlmConnection({ provider: "ollama" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.provider).toBe("local");
    expect(result.connection.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(result.connection.model).toBe("llama3.2");
    expect(result.connection.apiKeyRequired).toBe(false);
    expect(result.connection.requiresNetworkToPc).toBe(true);
  });

  it("defaults the lmstudio alias to :1234", () => {
    const result = resolveLlmConnection({ provider: "lmstudio" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("lets LLM_BASE_URL and LLM_MODEL override defaults", () => {
    const result = resolveLlmConnection({
      provider: "local",
      llmBaseUrl: "http://192.168.1.20:11434/v1/",
      llmModel: "mistral",
      openaiBaseUrl: "http://ignored:1/v1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.baseUrl).toBe("http://192.168.1.20:11434/v1");
    expect(result.connection.model).toBe("mistral");
  });

  it("lets env LLM_PROVIDER win over yaml provider", () => {
    const result = resolveLlmConnection({
      provider: "grok",
      yamlProvider: "openai",
      xaiApiKey: "xai-key",
      openaiApiKey: "sk-test",
    });
    expect(result.ok && result.connection.provider).toBe("grok");
    expect(result.ok && result.connection.baseUrl).toBe("https://api.x.ai/v1");
  });

  it("fails loudly for unknown providers and missing grok/openai keys when provider is set", () => {
    const unknown = resolveLlmConnection({ provider: "anthropic" });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.fatal).toBe(true);
    expect(unknown.message).toMatch(/Unknown LLM_PROVIDER/i);

    const grok = resolveLlmConnection({ provider: "grok" });
    expect(grok.ok).toBe(false);
    if (grok.ok) return;
    expect(grok.fatal).toBe(true);
    expect(grok.message).toMatch(/XAI_API_KEY/);

    const openai = resolveLlmConnection({ provider: "openai" });
    expect(openai.ok).toBe(false);
    if (openai.ok) return;
    expect(openai.fatal).toBe(true);
    expect(openai.message).toMatch(/OPENAI_API_KEY/);
  });

  it("does not fatal-fail implicit OpenAI when no key is set", () => {
    const result = resolveLlmConnection({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fatal).toBe(false);
    expect(result.explicit).toBe(false);
  });

  it("treats yaml provider openai as implicit, but yaml grok as explicit", () => {
    const openaiYaml = resolveLlmConnection({ yamlProvider: "openai" });
    expect(openaiYaml.ok).toBe(false);
    if (openaiYaml.ok) return;
    expect(openaiYaml.fatal).toBe(false);

    const grokYaml = resolveLlmConnection({ yamlProvider: "grok" });
    expect(grokYaml.ok).toBe(false);
    if (grokYaml.ok) return;
    expect(grokYaml.fatal).toBe(true);
  });
});
