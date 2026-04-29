import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { importJWK, jwtVerify, decodeJwt } from 'jose';

import {
  signAccessToken,
  signRefreshToken,
  verifySelfIssuedToken,
  getJwks,
  isSelfIssuedConfigured,
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
