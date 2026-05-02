import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt } from 'jose';

import { buildServer } from '../src/appBuilder.js';
import {
  signServiceToken,
  verifySelfIssuedToken,
  validateInternalServiceCredentials,
  getInternalServiceClients,
  _resetSelfIssuedCache,
} from '@/utils/selfIssuedJwt.js';

const TEST_ISSUER = 'https://test.user-service.local';
const TEST_KID = 'test-kid-svc-1';

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
  process.env.INTERNAL_SERVICE_CLIENTS = JSON.stringify({
    'campaign-service': 'campaign-secret-aaa',
    'business-service': 'business-secret-bbb',
    'messaging-service': 'messaging-secret-ccc',
  });
  _resetSelfIssuedCache();
});

describe('signServiceToken', () => {
  it('emits a Keycloak-shaped service token with default claims', async () => {
    const token = await signServiceToken({ azp: 'campaign-service' });
    const decoded = decodeJwt(token);
    expect(decoded.iss).toBe(TEST_ISSUER);
    expect(decoded.sub).toBe('campaign-service');
    expect((decoded as any).azp).toBe('campaign-service');
    expect(decoded.aud).toBe('campaign-service'); // defaults to azp
    expect((decoded as any).typ).toBe('Bearer');
    expect(decoded.exp! - decoded.iat!).toBe(300);
    expect((decoded as any).realm_access).toBeUndefined();
    expect((decoded as any).resource_access).toBeUndefined();
  });

  it('emits realm_access.roles when roles are provided', async () => {
    const token = await signServiceToken({ azp: 'campaign-service', roles: ['send', 'read'] });
    const decoded = decodeJwt(token);
    expect((decoded as any).realm_access).toEqual({ roles: ['send', 'read'] });
  });

  it('respects custom audience and ttl', async () => {
    const token = await signServiceToken(
      { azp: 'campaign-service', audience: 'messaging-service' },
      { ttlSeconds: 60 },
    );
    const decoded = decodeJwt(token);
    expect(decoded.aud).toBe('messaging-service');
    expect(decoded.exp! - decoded.iat!).toBe(60);
  });

  it('round-trips through verifySelfIssuedToken', async () => {
    const token = await signServiceToken({ azp: 'business-service', roles: ['send'] });
    const { payload } = await verifySelfIssuedToken(token);
    expect(payload.iss).toBe(TEST_ISSUER);
    expect((payload as any).azp).toBe('business-service');
    expect((payload as any).realm_access).toEqual({ roles: ['send'] });
  });

  it('emits resource_access when provided', async () => {
    const token = await signServiceToken({
      azp: 'campaign-service',
      resourceAccess: { 'messaging-service': { roles: ['send'] } },
    });
    const decoded = decodeJwt(token);
    expect((decoded as any).resource_access).toEqual({ 'messaging-service': { roles: ['send'] } });
  });
});

describe('getInternalServiceClients / validateInternalServiceCredentials', () => {
  it('parses a JSON map from env', () => {
    const clients = getInternalServiceClients();
    expect(clients).toEqual({
      'campaign-service': 'campaign-secret-aaa',
      'business-service': 'business-secret-bbb',
      'messaging-service': 'messaging-secret-ccc',
    });
  });

  it('returns null when env is unset or invalid', () => {
    delete process.env.INTERNAL_SERVICE_CLIENTS;
    expect(getInternalServiceClients()).toBeNull();
    process.env.INTERNAL_SERVICE_CLIENTS = '{not-json';
    expect(getInternalServiceClients()).toBeNull();
    process.env.INTERNAL_SERVICE_CLIENTS = '["array","not","object"]';
    expect(getInternalServiceClients()).toBeNull();
  });

  it('validates correct credentials', () => {
    expect(validateInternalServiceCredentials('campaign-service', 'campaign-secret-aaa')).toBe(true);
  });

  it('rejects unknown client_id', () => {
    expect(validateInternalServiceCredentials('not-a-service', 'whatever')).toBe(false);
  });

  it('rejects bad secret for known client', () => {
    expect(validateInternalServiceCredentials('campaign-service', 'wrong-secret')).toBe(false);
  });

  it('rejects when env is not configured', () => {
    delete process.env.INTERNAL_SERVICE_CLIENTS;
    expect(validateInternalServiceCredentials('campaign-service', 'campaign-secret-aaa')).toBe(false);
  });
});

describe('POST /internal/v1/auth/service-token', () => {
  let server: any;

  beforeAll(async () => {
    // Bypass keycloakAuthPlugin entirely for these tests; route doesn't depend on it.
    process.env.KEYCLOAK_AUTH_BYPASS = 'true';
    process.env.KEYCLOAK_BASE_URL = 'http://kc';
    process.env.KEYCLOAK_REALM = 'returnacy';
    server = await buildServer({
      overrides: {
        repository: { async healthCheck() { return { ok: true as const }; } } as any,
        tokenService: { async getAccessToken() { return 'test-admin-token'; } },
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
  });

  function form(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
  }

  it('mints a token for a valid client_credentials request', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/internal/v1/auth/service-token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'client_credentials',
        client_id: 'campaign-service',
        client_secret: 'campaign-secret-aaa',
        scope: 'send',
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(300);
    expect(body.refresh_expires_in).toBe(0);
    expect(body['not-before-policy']).toBe(0);
    expect(body.scope).toBe('send');
    expect(typeof body.access_token).toBe('string');

    const decoded = decodeJwt(body.access_token);
    expect((decoded as any).azp).toBe('campaign-service');
    expect((decoded as any).realm_access).toEqual({ roles: ['send'] });

    // Verify the token round-trips through the local public key
    const { payload } = await verifySelfIssuedToken(body.access_token);
    expect((payload as any).azp).toBe('campaign-service');
  });

  it('returns 401 invalid_client for unknown client_id', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/internal/v1/auth/service-token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'client_credentials',
        client_id: 'not-a-real-service',
        client_secret: 'anything',
      }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
  });

  it('returns 401 invalid_client for bad secret', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/internal/v1/auth/service-token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'client_credentials',
        client_id: 'campaign-service',
        client_secret: 'wrong-secret',
      }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
  });

  it('returns 400 for unsupported grant_type', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/internal/v1/auth/service-token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'password',
        client_id: 'campaign-service',
        client_secret: 'campaign-secret-aaa',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_grant_type');
  });

  it('returns 400 when required fields are missing (schema validation)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/internal/v1/auth/service-token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ grant_type: 'client_credentials' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('emits a token whose realm_access.roles satisfies a "send" role check', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/internal/v1/auth/service-token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'client_credentials',
        client_id: 'campaign-service',
        client_secret: 'campaign-secret-aaa',
        scope: 'send',
      }),
    });
    expect(res.statusCode).toBe(200);
    const decoded = decodeJwt(res.json().access_token);
    // Mirrors messaging-service's serviceAuthGuard.hasServiceRole('send')
    const realmRoles = (decoded as any).realm_access?.roles ?? [];
    expect(realmRoles.includes('send')).toBe(true);
  });
});
