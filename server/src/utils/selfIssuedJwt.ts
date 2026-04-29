import { randomUUID } from 'node:crypto';
import { importSPKI, importPKCS8, exportJWK, decodeJwt, SignJWT, jwtVerify, type JWK, type JWTPayload, type CryptoKey } from 'jose';

export type SelfIssuedConfig = {
  privateKeyPem: string;
  publicKeyPem: string;
  kid: string;
  issuer: string;
  alg: 'RS256';
};

let cachedJwks: { keys: JWK[] } | null = null;
let cachedSigningKey: CryptoKey | null = null;
let cachedVerifyingKey: CryptoKey | null = null;

export function isSelfIssuedConfigured(): boolean {
  return Boolean(
    process.env.JWT_PRIVATE_KEY &&
      process.env.JWT_PUBLIC_KEY &&
      process.env.JWT_KID &&
      process.env.JWT_ISSUER,
  );
}

export function getSelfIssuedConfig(): SelfIssuedConfig | null {
  if (!isSelfIssuedConfigured()) return null;
  return {
    privateKeyPem: process.env.JWT_PRIVATE_KEY as string,
    publicKeyPem: process.env.JWT_PUBLIC_KEY as string,
    kid: process.env.JWT_KID as string,
    issuer: process.env.JWT_ISSUER as string,
    alg: 'RS256',
  };
}

function requireConfig(): SelfIssuedConfig {
  const config = getSelfIssuedConfig();
  if (!config) throw new Error('Self-issued JWT is not configured');
  return config;
}

async function getSigningKey(): Promise<CryptoKey> {
  if (cachedSigningKey) return cachedSigningKey;
  const config = requireConfig();
  cachedSigningKey = (await importPKCS8(config.privateKeyPem, config.alg)) as CryptoKey;
  return cachedSigningKey;
}

async function getVerifyingKey(): Promise<CryptoKey> {
  if (cachedVerifyingKey) return cachedVerifyingKey;
  const config = requireConfig();
  cachedVerifyingKey = (await importSPKI(config.publicKeyPem, config.alg)) as CryptoKey;
  return cachedVerifyingKey;
}

export async function getJwks(): Promise<{ keys: JWK[] }> {
  if (cachedJwks) return cachedJwks;
  const config = getSelfIssuedConfig();
  if (!config) return { keys: [] };
  const publicKey = await importSPKI(config.publicKeyPem, config.alg, { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = config.kid;
  jwk.use = 'sig';
  jwk.alg = config.alg;
  cachedJwks = { keys: [jwk] };
  return cachedJwks;
}

export type AccessTokenClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  azp?: string;
  scope?: string;
};

export type AccessTokenOptions = {
  audience?: string | string[];
  ttlSeconds?: number;
};

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 300;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function signAccessToken(
  claims: AccessTokenClaims,
  options: AccessTokenOptions = {},
): Promise<string> {
  const config = requireConfig();
  const key = await getSigningKey();
  const ttl = options.ttlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const audience = options.audience ?? 'frontend-spa';

  const payload: JWTPayload = {
    email: claims.email,
    email_verified: claims.email_verified,
    preferred_username: claims.preferred_username,
    given_name: claims.given_name,
    family_name: claims.family_name,
    name: claims.name,
    typ: 'Bearer',
    azp: claims.azp ?? 'user-service',
    scope: claims.scope ?? 'openid email profile',
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: config.alg, kid: config.kid, typ: 'JWT' })
    .setIssuer(config.issuer)
    .setSubject(claims.sub)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(randomUUID())
    .sign(key);
}

export type RefreshTokenClaims = {
  sub: string;
};

export type RefreshTokenOptions = {
  ttlSeconds?: number;
};

export async function signRefreshToken(
  claims: RefreshTokenClaims,
  options: RefreshTokenOptions = {},
): Promise<string> {
  const config = requireConfig();
  const key = await getSigningKey();
  const ttl = options.ttlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;

  return new SignJWT({ typ: 'Refresh' })
    .setProtectedHeader({ alg: config.alg, kid: config.kid, typ: 'JWT' })
    .setIssuer(config.issuer)
    .setSubject(claims.sub)
    .setAudience(config.issuer)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(randomUUID())
    .sign(key);
}

export async function verifySelfIssuedToken(token: string): Promise<{ payload: JWTPayload }> {
  const config = requireConfig();
  const key = await getVerifyingKey();
  const result = await jwtVerify(token, key, { issuer: config.issuer });
  return { payload: result.payload };
}

export function _resetSelfIssuedCache(): void {
  cachedJwks = null;
  cachedSigningKey = null;
  cachedVerifyingKey = null;
}

export function useSelfIssuedJwt(): boolean {
  if (!isSelfIssuedConfigured()) return false;
  const flag = String(process.env.USE_SELF_ISSUED_JWT ?? '').toLowerCase().trim();
  return flag === 'true' || flag === '1' || flag === 'yes';
}

/**
 * Phase 2.5 — gate local bcrypt password verification. Requires
 * useSelfIssuedJwt() because verifying a password locally is only
 * useful if we can also mint our own tokens after.
 */
export function useLocalPasswordVerification(): boolean {
  if (!useSelfIssuedJwt()) return false;
  const flag = String(process.env.USE_LOCAL_PASSWORD_VERIFICATION ?? '').toLowerCase().trim();
  return flag === 'true' || flag === '1' || flag === 'yes';
}

export function isSelfIssuedToken(token: string): boolean {
  const config = getSelfIssuedConfig();
  if (!config) return false;
  try {
    const decoded = decodeJwt(token);
    return decoded.iss === config.issuer;
  } catch {
    return false;
  }
}

export type TokenPairResponse = {
  access_token: string;
  expires_in: number;
  refresh_expires_in: number;
  refresh_token: string;
  token_type: 'Bearer';
  scope: string;
};

export async function mintTokenPair(
  claims: AccessTokenClaims,
  options: { audience?: string | string[]; accessTtlSeconds?: number; refreshTtlSeconds?: number } = {},
): Promise<TokenPairResponse> {
  const accessTtl = options.accessTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTtl = options.refreshTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;

  const accessOpts: AccessTokenOptions = { ttlSeconds: accessTtl };
  if (options.audience !== undefined) accessOpts.audience = options.audience;

  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(claims, accessOpts),
    signRefreshToken({ sub: claims.sub }, { ttlSeconds: refreshTtl }),
  ]);

  return {
    access_token: accessToken,
    expires_in: accessTtl,
    refresh_expires_in: refreshTtl,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    scope: claims.scope ?? 'openid email profile',
  };
}

export type ClaimsFromKeycloak = AccessTokenClaims;

export function extractClaimsFromKeycloakToken(accessToken: string): ClaimsFromKeycloak | null {
  try {
    const d = decodeJwt(accessToken);
    if (!d.sub) return null;
    const claims: ClaimsFromKeycloak = {
      sub: d.sub as string,
      azp: typeof d.azp === 'string' ? (d.azp as string) : 'user-service',
      scope: typeof d.scope === 'string' ? (d.scope as string) : 'openid email profile',
    };
    if (typeof d.email === 'string') claims.email = d.email;
    if (typeof d.email_verified === 'boolean') claims.email_verified = d.email_verified;
    if (typeof d.given_name === 'string') claims.given_name = d.given_name;
    if (typeof d.family_name === 'string') claims.family_name = d.family_name;
    if (typeof d.name === 'string') claims.name = d.name;
    if (typeof d.preferred_username === 'string') claims.preferred_username = d.preferred_username;
    return claims;
  } catch {
    return null;
  }
}
