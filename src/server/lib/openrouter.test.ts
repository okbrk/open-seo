import { generateText } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

const completion = () =>
  Response.json({
    choices: [
      {
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
  });

// The egress country is cached per module (one lookup per isolate), so each
// test needs a fresh module to run its own lookup.
beforeEach(() => {
  vi.resetModules();
});

async function requestedModel(trace: () => Promise<Response>) {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(trace)
    .mockResolvedValueOnce(completion());
  const { buildChatAgentModel } = await import("./openrouter");
  await generateText({
    model: buildChatAgentModel((name) =>
      name === "OPENROUTER_API_KEY" ? "key" : undefined,
    ),
    prompt: "hi",
  });
  const body = z
    .object({ model: z.string() })
    .parse(JSON.parse(z.string().parse(fetchMock.mock.calls[1]?.[1]?.body)));
  return body.model;
}

it("sends OpenAI calls to MiniMax M3 from a country where OpenAI is blocked", async () => {
  expect(
    await requestedModel(async () => new Response("colo=HKG\nloc=HK\n")),
  ).toBe("minimax/minimax-m3");
});

it("stays on OpenAI when the country lookup fails", async () => {
  expect(
    await requestedModel(async () => {
      throw new Error("offline");
    }),
  ).toBe("openai/gpt-5.6-luna");
});

it("sends calls to a configured OpenAI-compatible gateway and accepts its null fields", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({
      id: "resp_1",
      model: "gpt-5.6-luna",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
            reasoning_content: null,
            tool_calls: null,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
  );
  const env: Record<string, string> = {
    OPENROUTER_API_KEY: "key",
    OPENROUTER_MODEL: "gpt-5.6-luna",
    OPENROUTER_BASE_URL: "https://gateway.example/v1",
    OPENROUTER_HEADERS: JSON.stringify({ "CF-Access-Client-Id": "client" }),
  };
  const { buildChatAgentModel } = await import("./openrouter");
  const { requireOpenRouterCostUsd } = await import("./chatAgent");

  const result = await generateText({
    model: buildChatAgentModel((name) => env[name]),
    prompt: "hi",
  });

  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe("https://gateway.example/v1/chat/completions");
  expect(new Headers(init?.headers).get("CF-Access-Client-Id")).toBe("client");
  expect(result.text).toBe("ok");
  expect(requireOpenRouterCostUsd(result.providerMetadata)).toBe(0);
});
