export type LlmProviderId = "openai" | "grok" | "local";

export interface LlmResolveInput {
  /** `LLM_PROVIDER` — wins over YAML when set. */
  provider?: string;
  yamlProvider?: string;
  yamlModel?: string;
  llmModel?: string;
  llmApiKey?: string;
  xaiApiKey?: string;
  openaiApiKey?: string;
  llmBaseUrl?: string;
  openaiBaseUrl?: string;
}

export interface LlmConnection {
  provider: LlmProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Local servers often accept any/empty key; cloud providers need a real one. */
  apiKeyRequired: boolean;
  requiresNetworkToPc: boolean;
}

export type LlmResolveResult =
  | { ok: true; connection: LlmConnection; explicit: boolean }
  | { ok: false; fatal: boolean; message: string; explicit: boolean };

export const PROVIDER_DEFAULTS: Record<
  LlmProviderId,
  { baseUrl: string; model: string; apiKeyRequired: boolean }
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyRequired: true,
  },
  grok: {
    // xAI OpenAI-compatible Chat Completions (legacy but documented):
    // POST https://api.x.ai/v1/chat/completions  Authorization: Bearer $XAI_API_KEY
    // Current public chat model as of docs.x.ai (grok-2 is not listed).
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.6",
    apiKeyRequired: true,
  },
  local: {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    apiKeyRequired: false,
  },
};

const LM_STUDIO_DEFAULT_URL = "http://127.0.0.1:1234/v1";
const LOCAL_PLACEHOLDER_KEY = "local";

export function normalizeLlmProvider(
  raw: string | undefined,
): { id: LlmProviderId; alias?: string } | undefined {
  if (!raw?.trim()) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "openai") return { id: "openai" };
  if (value === "grok" || value === "xai") return { id: "grok", alias: value };
  if (value === "local" || value === "ollama" || value === "openai-compatible") {
    return { id: "local", alias: value };
  }
  if (value === "lmstudio" || value === "lm-studio") {
    return { id: "local", alias: "lmstudio" };
  }
  return undefined;
}

export function resolveLlmConnection(input: LlmResolveInput): LlmResolveResult {
  const envRaw = input.provider?.trim();
  const yamlRaw = input.yamlProvider?.trim();
  const envParsed = normalizeLlmProvider(envRaw);
  const yamlParsed = normalizeLlmProvider(yamlRaw);
  if ((envRaw && !envParsed) || (!envRaw && yamlRaw && !yamlParsed)) {
    return {
      ok: false,
      fatal: true,
      explicit: true,
      message:
        `Unknown LLM_PROVIDER "${envRaw || yamlRaw}". Use openai, grok (alias: xai), or local (aliases: ollama, lmstudio, openai-compatible).`,
    };
  }

  const parsed = envParsed ?? yamlParsed ?? { id: "openai" as const };
  const explicit = Boolean(envRaw) || Boolean(yamlParsed && yamlParsed.id !== "openai");

  const defaults = PROVIDER_DEFAULTS[parsed.id];
  const baseUrl = first(
    input.llmBaseUrl,
    input.openaiBaseUrl,
    parsed.alias === "lmstudio" ? LM_STUDIO_DEFAULT_URL : defaults.baseUrl,
  );
  const model = first(input.llmModel, input.yamlModel, defaults.model)!;
  const apiKey = pickApiKey(parsed.id, input);

  if (!baseUrl) {
    return {
      ok: false,
      fatal: true,
      explicit,
      message:
        `LLM_PROVIDER=${parsed.id} needs a base URL. Set LLM_BASE_URL (or OPENAI_BASE_URL), e.g. http://127.0.0.1:11434/v1 for Ollama or http://127.0.0.1:1234/v1 for LM Studio.`,
    };
  }

  if (defaults.apiKeyRequired && !apiKey) {
    return {
      ok: false,
      fatal: explicit,
      explicit,
      message: missingKeyMessage(parsed.id),
    };
  }

  return {
    ok: true,
    explicit,
    connection: {
      provider: parsed.id,
      baseUrl: stripTrailingSlash(baseUrl),
      model,
      apiKey: apiKey || LOCAL_PLACEHOLDER_KEY,
      apiKeyRequired: defaults.apiKeyRequired,
      requiresNetworkToPc: parsed.id === "local",
    },
  };
}

export function missingKeyMessage(provider: LlmProviderId): string {
  if (provider === "grok") {
    return "LLM_PROVIDER=grok needs an API key. Set XAI_API_KEY (preferred), or LLM_API_KEY / OPENAI_API_KEY. Create a key at https://console.x.ai — base URL defaults to https://api.x.ai/v1.";
  }
  return "LLM_PROVIDER=openai needs an API key. Set OPENAI_API_KEY (preferred) or LLM_API_KEY.";
}

function pickApiKey(provider: LlmProviderId, input: LlmResolveInput): string | undefined {
  if (provider === "grok") {
    return first(input.xaiApiKey, input.llmApiKey, input.openaiApiKey);
  }
  if (provider === "openai") {
    return first(input.openaiApiKey, input.llmApiKey);
  }
  return first(input.llmApiKey, input.openaiApiKey);
}

function first(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}
