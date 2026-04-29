import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { importJWK, jwtVerify, decodeJwt } from 'jose';

import {
  signAccessToken,
  signRefreshToken,
  verifySelfIssuedToken,
  getJwks,
  isSelfIssuedConfigured,
  useSelfIssuedJwt,
  useLocalPasswordVerification,
  isSelfIssuedToken,
  mintTokenPair,
  extractClaimsFromKeycloakToken,
  _resetSelfIssuedCache,
} from '@/utils/selfIssuedJwt.js';

const TEST_ISSUER = 'https://test.user-service.local';
const TEST_KID = 'test-kid-1';

let testPrivateKeyPem: string;
let testPublicKeyPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  testPrivateKeyPem = privateKey;
  testPublicKeyPem = publicKey;
});

beforeEach(() => {
  process.env.JWT_PRIVATE_KEY = testPrivateKeyPem;
  process.env.JWT_PUBLIC_KEY = testPublicKeyPem;
  process.env.JWT_KID = TEST_KID;
  process.env.JWT_ISSUER = TEST_ISSUER;
  _resetSelfIssuedCache();
});

describe('isSelfIssuedConfigured', () => {
  it('returns true when all four env vars are set', () => {
    expect(isSelfIssuedConfigured()).toBe(true);
  });

  it('returns false when any env var is missing', () => {
    delete process.env.JWT_PRIVATE_KEY;
    expect(isSelfIssuedConfigured()).toBe(false);
  });
});

describe('getJwks', () => {
  it('returns the public key in JWKS format with correct metadata', async () => {
    const jwks = await getJwks();
    expect(jwks.keys).toHaveLength(1);
    const k = jwks.keys[0]!;
    expect(k.kty).toBe('RSA');
    expect(k.kid).toBe(TEST_KID);
    expect(k.use).toBe('sig');
    expect(k.alg).toBe('RS256');
    expect(typeof k.n).toBe('string');
    expect(k.e).toBe('AQAB');
  });

  it('returns empty keys when not configured', async () => {
    delete process.env.JWT_PRIVATE_KEY;
    _resetSelfIssuedCache();
    const jwks = await getJwks();
    expect(jwks.keys).toHaveLength(0);
  });
});

describe('signAccessToken', () => {
  it('produces a JWT with the expected header and claims', async () => {
    const token = await signAccessToken({
      sub: 'user-123',
      email: 'alice@example.com',
      email_verified: true,
      name: 'Alice User',
      given_name: 'Alice',
      family_name: 'User',
    });

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);

    const decoded = decodeJwt(token);
    expect(decoded.iss).toBe(TEST_ISSUER);
    expect(decoded.sub).toBe('user-123');
    expect(decoded.aud).toBe('frontend-spa');
    expect(decoded.azp).toBe('user-service');
    expect((decoded as any).email).toBe('alice@example.com');
    expect((decoded as any).email_verified).toBe(true);
    expect((decoded as any).name).toBe('Alice User');
    expect((decoded as any).typ).toBe('Bearer');
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.exp! > decoded.iat!).toBe(true);
  });

  it('respects custom audience and ttl', async () => {
    const token = await signAccessToken(
      { sub: 'user-123' },
      { audience: 'business-service', ttlSeconds: 60 },
    );
    const decoded = decodeJwt(token);
    expect(decoded.aud).toBe('business-service');
    expect(decoded.exp! - decoded.iat!).toBe(60);
  });
});

describe('signRefreshToken', () => {
  it('produces a refresh-typed token with default 30-day TTL', async () => {
    const token = await signRefreshToken({ sub: 'user-123' });
    const decoded = decodeJwt(token);
    expect(decoded.iss).toBe(TEST_ISSUER);
    expect(decoded.sub).toBe('user-123');
    expect(decoded.aud).toBe(TEST_ISSUER);
    expect((decoded as any).typ).toBe('Refresh');
    const ttl = decoded.exp! - decoded.iat!;
    expect(ttl).toBe(30 * 24 * 60 * 60);
  });
});

describe('full round-trip: sign -> publish JWKS -> verify', () => {
  it('a token signed by signAccessToken verifies against the JWKS public key', async () => {
    const token = await signAccessToken({
      sub: 'user-456',
      email: 'bob@example.com',
    });

    const jwks = await getJwks();
    const jwk = jwks.keys[0]!;
    const publicKey = await importJWK(jwk, 'RS256');

    const { payload } = await jwtVerify(token, publicKey, {
      issuer: TEST_ISSUER,
      audience: 'frontend-spa',
    });

    expect(payload.sub).toBe('user-456');
    expect((payload as any).email).toBe('bob@example.com');
  });

  it('verifySelfIssuedToken accepts a token we just signed', async () => {
    const token = await signAccessToken({ sub: 'user-789' });
    const { payload } = await verifySelfIssuedToken(token);
    expect(payload.sub).toBe('user-789');
    expect(payload.iss).toBe(TEST_ISSUER);
  });

  it('verifySelfIssuedToken rejects a token from a different issuer', async () => {
    const token = await signAccessToken({ sub: 'user-789' });
    process.env.JWT_ISSUER = 'https://different.local';
    _resetSelfIssuedCache();
    await expect(verifySelfIssuedToken(token)).rejects.toThrow();
  });
});

describe('useSelfIssuedJwt', () => {
  it('returns false when keys are not configured (regardless of flag)', () => {
    delete process.env.JWT_PRIVATE_KEY;
    process.env.USE_SELF_ISSUED_JWT = 'true';
    _resetSelfIssuedCache();
    expect(useSelfIssuedJwt()).toBe(false);
  });

  it('returns false when flag is unset', () => {
    delete process.env.USE_SELF_ISSUED_JWT;
    expect(useSelfIssuedJwt()).toBe(false);
  });

  it('returns true when both keys present and flag is "true"', () => {
    process.env.USE_SELF_ISSUED_JWT = 'true';
    expect(useSelfIssuedJwt()).toBe(true);
  });

  it('accepts "1" and "yes" as truthy', () => {
    process.env.USE_SELF_ISSUED_JWT = '1';
    expect(useSelfIssuedJwt()).toBe(true);
    process.env.USE_SELF_ISSUED_JWT = 'yes';
    expect(useSelfIssuedJwt()).toBe(true);
  });

  it('rejects unrecognized values like "0", "false"', () => {
    process.env.USE_SELF_ISSUED_JWT = '0';
    expect(useSelfIssuedJwt()).toBe(false);
    process.env.USE_SELF_ISSUED_JWT = 'false';
    expect(useSelfIssuedJwt()).toBe(false);
  });
});

describe('useLocalPasswordVerification', () => {
  it('returns false when self-issued JWT path is off, even with flag on', () => {
    process.env.USE_SELF_ISSUED_JWT = 'false';
    process.env.USE_LOCAL_PASSWORD_VERIFICATION = 'true';
    expect(useLocalPasswordVerification()).toBe(false);
  });

  it('returns false when own flag is unset', () => {
    process.env.USE_SELF_ISSUED_JWT = 'true';
    delete process.env.USE_LOCAL_PASSWORD_VERIFICATION;
    expect(useLocalPasswordVerification()).toBe(false);
  });

  it('returns true only when both flags are on AND keys are configured', () => {
    process.env.USE_SELF_ISSUED_JWT = 'true';
    process.env.USE_LOCAL_PASSWORD_VERIFICATION = 'true';
    expect(useLocalPasswordVerification()).toBe(true);
  });

  it('accepts "1" and "yes" as truthy', () => {
    process.env.USE_SELF_ISSUED_JWT = 'true';
    process.env.USE_LOCAL_PASSWORD_VERIFICATION = '1';
    expect(useLocalPasswordVerification()).toBe(true);
    process.env.USE_LOCAL_PASSWORD_VERIFICATION = 'yes';
    expect(useLocalPasswordVerification()).toBe(true);
  });
});

describe('isSelfIssuedToken', () => {
  it('returns true for a token signed by us', async () => {
    const token = await signAccessToken({ sub: 'user-1' });
    expect(isSelfIssuedToken(token)).toBe(true);
  });

  it('returns false for a token from a different issuer', async () => {
    // craft a fake JWT (not validly signed) with a different iss
    const fakeJwt = [
      Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: 'https://keycloak.example.com/realms/x', sub: 'u' })).toString('base64url'),
      'sig',
    ].join('.');
    expect(isSelfIssuedToken(fakeJwt)).toBe(false);
  });

  it('returns false for garbage input', () => {
    expect(isSelfIssuedToken('not-a-jwt')).toBe(false);
  });
});

describe('mintTokenPair', () => {
  it('returns a Keycloak-shaped response with our access + refresh tokens', async () => {
    const pair = await mintTokenPair({ sub: 'user-100', email: 'a@b.c' });
    expect(pair.token_type).toBe('Bearer');
    expect(pair.expires_in).toBe(300);
    expect(pair.refresh_expires_in).toBe(30 * 24 * 60 * 60);
    expect(typeof pair.access_token).toBe('string');
    expect(typeof pair.refresh_token).toBe('string');

    const accessDecoded = decodeJwt(pair.access_token);
    expect(accessDecoded.sub).toBe('user-100');

    const refreshDecoded = decodeJwt(pair.refresh_token);
    expect((refreshDecoded as any).typ).toBe('Refresh');
    expect(refreshDecoded.sub).toBe('user-100');
  });
});

describe('extractClaimsFromKeycloakToken', () => {
  it('pulls standard OIDC claims out of an access token', async () => {
    // Build a Keycloak-shaped token using our signer (claims structure is identical)
    const token = await signAccessToken({
      sub: 'kc-user-1',
      email: 'kcuser@example.com',
      email_verified: true,
      given_name: 'Kc',
      family_name: 'User',
      name: 'Kc User',
      preferred_username: 'kcuser',
    });
    const claims = extractClaimsFromKeycloakToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('kc-user-1');
    expect(claims!.email).toBe('kcuser@example.com');
    expect(claims!.email_verified).toBe(true);
    expect(claims!.given_name).toBe('Kc');
    expect(claims!.family_name).toBe('User');
    expect(claims!.name).toBe('Kc User');
    expect(claims!.preferred_username).toBe('kcuser');
  });

  it('returns null on garbage input', () => {
    expect(extractClaimsFromKeycloakToken('not-a-jwt')).toBeNull();
  });
});
