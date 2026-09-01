import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { buildServer } from '../src/appBuilder.js';
import { signServiceToken, _resetSelfIssuedCache } from '@/utils/selfIssuedJwt.js';

/**
 * The audience allow-list in keycloakAuthPlugin, exercised through the real
 * plugin rather than a copy of its logic: it is a global preHandler, so /health
 * is enough to observe it and needs no repository.
 *
 * KEYCLOAK_AUDIENCE below is deliberately the value a deployment provisioned
 * BEFORE the quieora tenant existed carries — the situation that produced the
 * 401 this change fixes.
 */

const TEST_ISSUER = 'https://test.user-service.local';

let server: any;

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.JWT_PRIVATE_KEY = privateKey;
  process.env.JWT_PUBLIC_KEY = publicKey;
  process.env.JWT_KID = 'test-kid-aud-1';
  process.env.JWT_ISSUER = TEST_ISSUER;
  // The gate only exists when the plugin actually runs.
  delete process.env.KEYCLOAK_AUTH_BYPASS;
  process.env.KEYCLOAK_AUDIENCE = 'user-service,business-service';
  _resetSelfIssuedCache();

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

async function health(clientId: string) {
  const token = await signServiceToken({ azp: clientId });
  return server.inject({
    method: 'GET',
    url: '/health',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('keycloakAuthPlugin audience gate', () => {
  it('admits a per-tenant id whose family is allowed, without listing the tenant', async () => {
    const res = await health('business-service:quieora');
    expect(res.statusCode).toBe(200);
  });

  it('leaves the legacy bare id Che Pizza presents unchanged', async () => {
    const res = await health('business-service');
    expect(res.statusCode).toBe(200);
  });

  it('refuses an unrelated service family carrying a known tenant slug', async () => {
    const res = await health('attacker-service:quieora');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid audience');
  });

  it('widens on the ":" segment only, not on any shared prefix', async () => {
    const res = await health('business-service-evil');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid audience');
  });

  it('still lets an unauthenticated request through (permissive mode)', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
