import { exportPKCS8, generateKeyPair, decodeJwt } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async (name: string) => mocks.env[name],
}));

async function serviceAccountKeyJson() {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return JSON.stringify({
    client_email: "openseo@example-project.iam.gserviceaccount.com",
    private_key: await exportPKCS8(privateKey),
  });
}

async function load() {
  vi.resetModules();
  return import("./serviceAccount");
}

describe("service account Google access", () => {
  beforeEach(() => {
    mocks.env = {};
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("adds no grant when no key is configured", async () => {
    const { withServiceAccountGrant } = await load();
    const grants = [{ id: "row-1", accountId: "sub-1" }];
    await expect(withServiceAccountGrant(grants)).resolves.toEqual(grants);
  });

  it("ignores a key that is not valid service account JSON", async () => {
    mocks.env.GOOGLE_SERVICE_ACCOUNT_KEY = "not json";
    const { getServiceAccountKey, withServiceAccountGrant } = await load();
    await expect(getServiceAccountKey()).resolves.toBeNull();
    await expect(withServiceAccountGrant([])).resolves.toEqual([]);
  });

  it("offers the service account ahead of personal grants", async () => {
    mocks.env.GOOGLE_SERVICE_ACCOUNT_KEY = await serviceAccountKeyJson();
    const { withServiceAccountGrant, isRemovableGrant } = await load();
    const grants = await withServiceAccountGrant([
      { id: "row-1", accountId: "sub-1" },
    ]);
    expect(isRemovableGrant(grants[0]?.accountId ?? "")).toBe(false);
    expect(isRemovableGrant("sub-1")).toBe(true);
    expect(grants.map((grant) => grant.accountId)).toEqual([
      "service-account",
      "sub-1",
    ]);
  });

  it("exchanges a signed assertion for the provider scope and reuses the token", async () => {
    mocks.env.GOOGLE_SERVICE_ACCOUNT_KEY = await serviceAccountKeyJson();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ access_token: "sa-access", expires_in: 3600 }),
        ),
    );
    const { getServiceAccountAccessToken } = await load();

    await expect(
      getServiceAccountAccessToken("google-search-console"),
    ).resolves.toBe("sa-access");
    await expect(
      getServiceAccountAccessToken("google-search-console"),
    ).resolves.toBe("sa-access");

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const body = mocks.fetch.mock.calls[0]?.[1]?.body;
    if (!(body instanceof URLSearchParams)) throw new Error("form body");
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const claims = decodeJwt(body.get("assertion") ?? "");
    expect(claims.iss).toBe("openseo@example-project.iam.gserviceaccount.com");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.scope).toBe(
      "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/userinfo.email",
    );
  });

  it("mints a separate token per provider scope", async () => {
    mocks.env.GOOGLE_SERVICE_ACCOUNT_KEY = await serviceAccountKeyJson();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ access_token: "sa-access", expires_in: 3600 }),
        ),
    );
    const { getServiceAccountAccessToken } = await load();
    await getServiceAccountAccessToken("google-search-console");
    await getServiceAccountAccessToken("google-analytics");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails loudly when Google rejects the assertion", async () => {
    mocks.env.GOOGLE_SERVICE_ACCOUNT_KEY = await serviceAccountKeyJson();
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 400 }));
    const { getServiceAccountAccessToken } = await load();
    await expect(
      getServiceAccountAccessToken("google-analytics"),
    ).rejects.toThrow("Google refused the service account assertion (400).");
  });
});
