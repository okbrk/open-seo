import {
  createOpenRouter,
  type LanguageModelV3,
  type OpenRouterProvider,
} from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

// OpenRouter model slug used for the SAM in-app chat agent. Override with
// OPENROUTER_MODEL to swap models without a code change.
const DEFAULT_CHAT_AGENT_MODEL = "openai/gpt-5.6-luna";

// Previous default; kept reachable via OPENROUTER_MODEL for rollback, and the
// fallback where OpenAI is blocked. Its routing needs the ZDR/provider tuning
// below.
const MINIMAX_M3 = "minimax/minimax-m3";

// OpenRouter rejects OpenAI models for requests from these countries ("This
// model is not available in your region"). Workflows and Durable Objects run
// near the user, outside prod's US placement.
const OPENAI_BLOCKED_COUNTRIES = [
  "CN",
  "HK",
  "MO",
  "RU",
  "BY",
  "IR",
  "KP",
  "SY",
  "CU",
];

// The country this isolate's requests leave from. An isolate stays in one
// location, so one lookup serves its lifetime. Caches the value, not the
// promise: Workers can't share a pending fetch across requests. Fails open: a
// slow or failed lookup leaves the country unknown, and calls stay on OpenAI.
let egressCountry: string | undefined;
async function openAiBlockedHere(): Promise<boolean> {
  egressCountry ??= await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => response.text())
    .then((trace) => /^loc=(\w+)$/m.exec(trace)?.[1] ?? "")
    .catch(() => "");
  return OPENAI_BLOCKED_COUNTRIES.includes(egressCountry);
}

/**
 * Returns the AI SDK LanguageModel for the chat agent. `usage: { include: true }`
 * turns on OpenRouter usage accounting so each response carries its real USD
 * cost (providerMetadata.openrouter.usage.cost) — which we meter against the
 * shared usage-credit pool.
 *
 * Default model: GPT-5.6 Luna at `reasoning.effort: "max"` — "max" is valid at
 * the OpenRouter API for GPT-5.x but missing from the SDK's effort union, so
 * the reasoning config rides in `extraBody`. Reasoning tokens stream on the
 * separate reasoning channel and are billed as output tokens, which the usage
 * accounting above captures.
 *
 * Sync on purpose: Think's `getModel()` hook is sync and runs on every turn,
 * so the SAM agent reads the key/model from its DO env and builds here.
 */
export function buildChatAgentModel(
  readEnv: (name: ChatAgentEnvVar) => string | undefined,
  reasoningEffort: "max" | "low" = "max",
): LanguageModelV3 {
  const apiKey = readEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing required environment variable: OPENROUTER_API_KEY",
    );
  }
  const model = readEnv("OPENROUTER_MODEL") ?? DEFAULT_CHAT_AGENT_MODEL;
  const openrouter = createOpenRouter({
    apiKey,
    ...gatewaySettings(readEnv),
  });
  const primary = openRouterModel(openrouter, model, reasoningEffort);
  if (!model.startsWith("openai/")) return primary;
  // Where OpenRouter would reject OpenAI, pick MiniMax M3 before the request.
  // The country lookup is async and getModel() is sync, so it runs per call.
  const fallback = openRouterModel(openrouter, MINIMAX_M3, reasoningEffort);
  const pick = async () => ((await openAiBlockedHere()) ? fallback : primary);
  return wrapLanguageModel({
    model: primary,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ params }) => (await pick()).doGenerate(params),
      wrapStream: async ({ params }) => (await pick()).doStream(params),
    },
  });
}

export async function loadChatAgentModel(
  reasoningEffort: "max" | "low",
): Promise<LanguageModelV3> {
  const values = new Map(
    await Promise.all(
      CHAT_AGENT_ENV_VARS.map(
        async (name) => [name, await getOptionalEnvValue(name)] as const,
      ),
    ),
  );
  return buildChatAgentModel((name) => values.get(name), reasoningEffort);
}

const CHAT_AGENT_ENV_VARS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_HEADERS",
] as const;

type ChatAgentEnvVar = (typeof CHAT_AGENT_ENV_VARS)[number];

const gatewayHeadersSchema = z.record(z.string(), z.string());

function gatewaySettings(
  readEnv: (name: ChatAgentEnvVar) => string | undefined,
) {
  const baseURL = readEnv("OPENROUTER_BASE_URL");
  if (!baseURL) return {};
  const headers = readEnv("OPENROUTER_HEADERS");
  return {
    baseURL,
    headers: headers ? gatewayHeadersSchema.parse(JSON.parse(headers)) : {},
    fetch: fetchFromOpenAiCompatibleGateway,
  };
}

async function fetchFromOpenAiCompatibleGateway(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return response;
  }
  const body: unknown = JSON.parse(await response.text(), dropNullFields);
  return Response.json(withZeroCostWhenUnreported(body), {
    status: response.status,
    statusText: response.statusText,
  });
}

function dropNullFields(_key: string, value: unknown): unknown {
  return value === null ? undefined : value;
}

const completionUsageSchema = z.looseObject({
  usage: z.looseObject({ cost: z.number().default(0) }),
});

function withZeroCostWhenUnreported(body: unknown): unknown {
  const parsed = completionUsageSchema.safeParse(body);
  return parsed.success ? parsed.data : body;
}

function openRouterModel(
  openrouter: OpenRouterProvider,
  model: string,
  reasoningEffort: "max" | "low",
): LanguageModelV3 {
  // MiniMax M3 (env override or OpenAI fallback): `provider.order` prefers
  // Together, then Atlas Cloud (fp8); `zdr: true` restricts routing to Zero-Data-
  // Retention endpoints, which excludes MiniMax first-party — the account's
  // "Non-frontier requires ZDR" data policy enforces the same, this flag is
  // belt-and-braces. Fallbacks stay on within the ZDR set because pinning
  // providers caused a prod outage (Jul 2026: Together upstream-rate-limited
  // m3 and every chat turn 429'd). The explicit reasoning channel keeps m3's
  // `<think>` trace out of the visible answer text.
  if (model === MINIMAX_M3) {
    return openrouter(model, {
      usage: { include: true },
      reasoning: { effort: reasoningEffort === "low" ? "low" : "medium" },
      provider: {
        order: ["together", "atlas-cloud/fp8"],
        zdr: true,
        allow_fallbacks: true,
      },
    });
  }

  return openrouter(model, {
    usage: { include: true },
    extraBody: { reasoning: { effort: reasoningEffort } },
  });
}
