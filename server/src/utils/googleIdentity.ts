import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JSONWebKeySet, RemoteJWKSetOptions } from 'jose';

const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

type RemoteOptions = {
  extendedTimeout?: boolean;
};

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  return fallback;
}

function buildRemoteOptions(opts: RemoteOptions = {}): RemoteJWKSetOptions {
  const baseTimeout = readNumberEnv('GOOGLE_JWKS_TIMEOUT_MS', 15000);
  const fallbackTimeout = readNumberEnv('GOOGLE_JWKS_TIMEOUT_FALLBACK_MS', Math.max(baseTimeout * 2, 30000));
  const options: RemoteJWKSetOptions = {
    timeoutDuration: opts.extendedTimeout ? fallbackTimeout : baseTimeout,
  };

  const cooldown = readNumberEnv('GOOGLE_JWKS_COOLDOWN_MS', 30000);
  if (cooldown >= 0) options.cooldownDuration = cooldown;

  const cacheMaxAge = readNumberEnv('GOOGLE_JWKS_CACHE_MAX_AGE_MS', 6 * 60 * 60 * 1000);
  if (cacheMaxAge > 0) options.cacheMaxAge = cacheMaxAge;
  return options;
}

function parseStaticJwks(): JSONWebKeySet | null {
  const raw = process.env.GOOGLE_JWKS_JSON || process.env.GOOGLE_JWKS;
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).keys)) {
      return parsed as JSONWebKeySet;
    }
    console.warn('[googleIdentity] Ignoring GOOGLE_JWKS_JSON because it is not a valid JWKS');
  } catch (err) {
    console.warn('[googleIdentity] Failed to parse GOOGLE_JWKS_JSON', err);
  }
  return null;
}

function buildJwks(opts: RemoteOptions = {}) {
  const staticJwks = parseStaticJwks();
  if (staticJwks) {
    return createLocalJWKSet(staticJwks);
  }
  const jwksUrl = process.env.GOOGLE_JWKS_URL || DEFAULT_JWKS_URL;
  return createRemoteJWKSet(new URL(jwksUrl), buildRemoteOptions(opts));
}

let googleJwks = buildJwks();

export type GoogleIdTokenPayload = JWTPayload & {
  sub: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
  picture?: string;
};

function resolveAudience(): string | string[] {
  const raw = process.env.GOOGLE_ID_TOKEN_AUDIENCE
    ?? process.env.GOOGLE_CLIENT_ID
    ?? process.env.VITE_GOOGLE_CLIENT_ID
    ?? '';
  const candidates = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (candidates.length === 0) return 'googleID';
  if (candidates.length === 1) return candidates[0]!;
  return candidates;
}

function isRecoverableJwksError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as any).name;
  if (name === 'JWKSTimeout' || name === 'JWKSNoMatchingKey' || name === 'JWKSetInvalid') {
    return true;
  }
  const code = (err as any).code || (err as any).cause?.code;
  return code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'FETCH_ERROR';
}

async function attemptVerify(idToken: string, audience: string | string[]): Promise<GoogleIdTokenPayload> {
  const { payload } = await jwtVerify(idToken, googleJwks, {
    issuer: GOOGLE_ISSUERS,
    audience,
  });
  const sub = payload.sub;
  if (!sub) throw new Error('GOOGLE_ID_TOKEN_SUB_MISSING');
  return payload as GoogleIdTokenPayload;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdTokenPayload> {
  if (!idToken || typeof idToken !== 'string') {
    throw Object.assign(new Error('GOOGLE_ID_TOKEN_MISSING'), { statusCode: 400 });
  }
  const audience = resolveAudience();
  let lastError: unknown;
  const attempts: RemoteOptions[] = [{ extendedTimeout: false }, { extendedTimeout: true }];

  for (let idx = 0; idx < attempts.length; idx += 1) {
    try {
      if (idx > 0) {
        // Refresh JWKS with relaxed timeout settings before retrying
        googleJwks = buildJwks(attempts[idx]);
      }
      return await attemptVerify(idToken, audience);
    } catch (err) {
      lastError = err;
      const recoverable = isRecoverableJwksError(err);
      if (!recoverable || idx === attempts.length - 1) {
        break;
      }
    }
  }

  const error = new Error('INVALID_GOOGLE_ID_TOKEN');
  (error as any).cause = lastError;
  (error as any).statusCode = 401;
  throw error;
}
