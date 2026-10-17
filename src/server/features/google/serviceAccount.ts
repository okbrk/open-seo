import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { GA4_DATA_SCOPE, GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { SERVICE_ACCOUNT_GRANT_ID } from "@/shared/google-link";
import { GSC_DATA_SCOPE, GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const ASSERTION_LIFETIME_S = 3600;
const REUSE_MARGIN_MS = 60_000;

const DATA_SCOPE_BY_PROVIDER: Record<string, string> = {
  [GSC_OAUTH_PROVIDER_ID]: GSC_DATA_SCOPE,
  [GA4_OAUTH_PROVIDER_ID]: GA4_DATA_SCOPE,
};

const serviceAccountKeySchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
});

type ServiceAccountKey = z.infer<typeof serviceAccountKeySchema>;
type CachedToken = { accessToken: string; expiresAt: number };

const tokenCache = new Map<string, CachedToken>();

export async function getServiceAccountKey(): Promise<ServiceAccountKey | null> {
  const raw = (await getOptionalEnvValue("GOOGLE_SERVICE_ACCOUNT_KEY"))?.trim();
  if (!raw) return null;
  try {
    const parsed = serviceAccountKeySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function withServiceAccountGrant<
  T extends { id: string; accountId: string },
>(grants: T[]): Promise<Array<T | { id: string; accountId: string }>> {
  if (!(await getServiceAccountKey())) return grants;
  return [
    { id: SERVICE_ACCOUNT_GRANT_ID, accountId: SERVICE_ACCOUNT_GRANT_ID },
    ...grants,
  ];
}

export function isRemovableGrant(accountId: string): boolean {
  return accountId !== SERVICE_ACCOUNT_GRANT_ID;
}

async function exchangeAssertion(
  key: ServiceAccountKey,
  scope: string,
): Promise<CachedToken> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(key.client_email)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ASSERTION_LIFETIME_S)
    .sign(await importPKCS8(key.private_key, "RS256"));
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Google refused the service account assertion (${response.status}).`,
    );
  }
  const body = z
    .object({ access_token: z.string().min(1), expires_in: z.number() })
    .parse(await response.json());
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

export async function getServiceAccountAccessToken(
  providerId: string,
): Promise<string> {
  const dataScope = DATA_SCOPE_BY_PROVIDER[providerId];
  if (!dataScope)
    throw new Error(`No service account scope for ${providerId}.`);
  const key = await getServiceAccountKey();
  if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not configured.");
  const scope = `${dataScope} ${EMAIL_SCOPE}`;
  const cacheKey = `${key.client_email} ${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > REUSE_MARGIN_MS) {
    return cached.accessToken;
  }
  const fresh = await exchangeAssertion(key, scope);
  tokenCache.set(cacheKey, fresh);
  return fresh.accessToken;
}
