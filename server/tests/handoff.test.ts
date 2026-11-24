import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, importJWK, jwtVerify } from 'jose';

// Domain resolution is network-bound; mock it so tests control the resolved brand.
vi.mock('@/utils/domainMapping.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/domainMapping.js')>()),
  resolveDomainFromRequest: vi.fn(),
  fetchDomainBusinesses: vi.fn(),
}));

import { resolveDomainFromRequest, fetchDomainBusinesses } from '@/utils/domainMapping.js';
import { _resetSelfIssuedCache, getJwks, signAccessToken } from '@/utils/selfIssuedJwt.js';
import { _resetHandoffTargetsCache, getHandoffTargets } from '@/utils/handoffTargets.js';
import { postHandoffService } from '@/modules/api/v1/auth/post.handoff.service.js';
import { buildServer } from '../src/appBuilder.js';

const TEST_ISSUER = 'https://test.user-service.local';
const BRAND_A = '11111111-1111-4111-8111-111111111111';
const BRAND_B = '22222222-2222-4222-8222-222222222222';
const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROMO_URL = 'https://promo.example.com/handoff';

const TARGETS = {
  'promo-site': { audience: 'promo-site', brandId: BRAND_A, url: PROMO_URL },
  'staff-tool': { audience: 'staff-tool', brandId: BRAND_A, url: 'https://tool.example.com/handoff', roles: ['STAFF', 'ADMIN'] },
  'other-brand-site': { audience: 'other-site', brandId: BRAND_B, url: 'https://other.example.com/handoff' },
};

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

type Membership = { userId: string; brandId: string | null; businessId: string | null; role: string };

function createRepo() {
  const users = [
    { id: 'u-customer', keycloakSub: 'sub-customer', email: 'customer@example.com', name: 'Carla', surname: 'Customer' },
    { id: 'u-noname', keycloakSub: 'sub-noname', email: 'noname@example.com', name: null, surname: null },
    { id: 'u-staff', keycloakSub: 'sub-staff', email: 'staff@example.com', name: 'Sara', surname: 'Staff' },
    { id: 'u-legacy', keycloakSub: 'sub-legacy', email: 'legacy@example.com', name: 'Lino', surname: 'Legacy' },
    { id: 'u-foreign', keycloakSub: 'sub-foreign', email: 'foreign@example.com', name: 'Fabio', surname: 'Foreign' },
    { id: 'u-foreign-legacy', keycloakSub: 'sub-foreign-legacy', email: 'fl@example.com', name: 'Flavio', surname: 'F' },
  ];
  const memberships: Membership[] = [
    { userId: 'u-customer', brandId: BRAND_A, businessId: BIZ_A, role: 'USER' },
    { userId: 'u-noname', brandId: BRAND_A, businessId: null, role: 'USER' },
    { userId: 'u-staff', brandId: BRAND_A, businessId: BIZ_A, role: 'STAFF' },
    // legacy shape: businessId of brand A, no brandId
    { userId: 'u-legacy', brandId: null, businessId: BIZ_A, role: 'USER' },
    // exists only under brand B
    { userId: 'u-foreign', brandId: BRAND_B, businessId: BIZ_B, role: 'ADMIN' },
    // legacy row pointing at a location of brand B
    { userId: 'u-foreign-legacy', brandId: null, businessId: BIZ_B, role: 'USER' },
  ];
  return {
    async healthCheck() { return { ok: true as const }; },
    async findUserByKeycloakSub(sub: string) { return users.find((u) => u.keycloakSub === sub) ?? null; },
    async getMembershipByBrand(userId: string, brandId: string) {
      return memberships.find((m) => m.userId === userId && m.brandId === brandId) ?? null;
    },
    async listMemberships(userId: string) {
      return memberships.filter((m) => m.userId === userId);
    },
    async listBusinessIdsForBrand(brandId: string) {
      return Array.from(new Set(
        memberships.filter((m) => m.brandId === brandId && m.businessId).map((m) => m.businessId as string),
      ));
    },
  };
}

function makeRequest(opts: { sub?: string | undefined; repo: any; body?: any }) {
  return {
    auth: opts.sub ? { sub: opts.sub } : undefined,
    headers: {},
    body: opts.body,
    server: { repository: opts.repo },
    log: { error: () => {}, warn: () => {}, info: () => {} },
  } as any;
}

function resolveTo(brandId: string | null) {
  (resolveDomainFromRequest as any).mockResolvedValue(
    brandId ? { brandId, businessId: null, host: null, service: null, label: null, url: null } : null,
  );
}

let repo: ReturnType<typeof createRepo>;

beforeEach(() => {
  process.env.JWT_PRIVATE_KEY = testPrivateKeyPem;
  process.env.JWT_PUBLIC_KEY = testPublicKeyPem;
  process.env.JWT_KID = 'test-kid-handoff-1';
  process.env.JWT_ISSUER = TEST_ISSUER;
  process.env.HANDOFF_TARGETS = JSON.stringify(TARGETS);
  delete process.env.INTERNAL_SERVICE_CLIENTS;
  delete process.env.KEYCLOAK_AUDIENCE;
  _resetSelfIssuedCache();
  _resetHandoffTargetsCache();
  repo = createRepo();
  resolveTo(BRAND_A);
  (fetchDomainBusinesses as any).mockResolvedValue([
    { label: 'A', brandId: BRAND_A, businessId: BIZ_A, services: {} },
    { label: 'B', brandId: BRAND_B, businessId: BIZ_B, services: {} },
  ]);
});

async function handoff(sub: string | undefined, target: unknown = 'promo-site') {
  return postHandoffService(makeRequest({ sub, repo, body: { target } }));
}

describe('POST /api/v1/auth/handoff', () => {
  it('mints a 60s, audience-bound, minimal token for a customer (USER)', async () => {
    const res = await handoff('sub-customer');
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.expiresIn).toBe(60);
    expect(body.url).toBe(PROMO_URL);
    expect(Object.keys(body).sort()).toEqual(['expiresIn', 'token', 'url']);

    // Signature, issuer and exact audience, verified the way a receiver would.
    const jwk = (await getJwks()).keys[0]!;
    const { payload } = await jwtVerify(body.token, await importJWK(jwk, 'RS256'), {
      issuer: TEST_ISSUER,
      audience: 'promo-site',
    }) as any;

    expect(payload.aud).toBe('promo-site');
    expect(payload.azp).toBe('promo-site');
    expect(payload.sub).toBe('sub-customer');
    expect(payload.exp - payload.iat).toBe(60);
    expect(payload.brandId).toBe(BRAND_A);
    expect(payload.businessId).toBe(BIZ_A);
    expect(payload.membershipRole).toBe('USER');
    expect(payload.given_name).toBe('Carla');
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti.length).toBeGreaterThan(0);

    // Data minimisation: nothing that identifies the person beyond sub + first name.
    for (const claim of ['email', 'email_verified', 'preferred_username', 'family_name', 'name']) {
      expect(payload).not.toHaveProperty(claim);
    }
    expect(JSON.stringify(payload)).not.toContain('@');
    expect(JSON.stringify(payload)).not.toContain('Customer');
  });

  it('issues a fresh jti on every call', async () => {
    const a = decodeJwt(((await handoff('sub-customer')).body as any).token);
    const b = decodeJwt(((await handoff('sub-customer')).body as any).token);
    expect(a.jti).not.toBe(b.jti);
  });

  it('omits given_name and businessId when the user has none', async () => {
    const res = await handoff('sub-noname');
    expect(res.statusCode).toBe(200);
    const decoded = decodeJwt((res.body as any).token) as any;
    expect(decoded).not.toHaveProperty('given_name');
    expect(decoded).not.toHaveProperty('businessId');
    expect(decoded.brandId).toBe(BRAND_A);
  });

  it('401 when unauthenticated', async () => {
    const res = await handoff(undefined);
    expect(res).toEqual({ statusCode: 401, body: { error: 'UNAUTHENTICATED' } });
  });

  it('404 for an unknown target', async () => {
    const res = await handoff('sub-customer', 'nope');
    expect(res).toEqual({ statusCode: 404, body: { error: 'UNKNOWN_HANDOFF_TARGET' } });
  });

  it('404 for a missing or non-string target, and for prototype keys', async () => {
    for (const body of [undefined, {}, { target: 42 }, { target: { a: 1 } }, { target: '__proto__' }, { target: 'constructor' }, { target: 'toString' }]) {
      const res = await postHandoffService(makeRequest({ sub: 'sub-customer', repo, body }));
      expect(res.statusCode).toBe(404);
    }
  });

  it('404 for a target of another brand than the one resolved from the host', async () => {
    const res = await handoff('sub-foreign', 'other-brand-site');
    expect(res).toEqual({ statusCode: 404, body: { error: 'UNKNOWN_HANDOFF_TARGET' } });
  });

  it('404 when the host resolves to no brand', async () => {
    resolveTo(null);
    const res = await handoff('sub-customer');
    expect(res).toEqual({ statusCode: 404, body: { error: 'UNKNOWN_HANDOFF_TARGET' } });
  });

  it('403 for an account that exists only under another brand', async () => {
    const res = await handoff('sub-foreign');
    expect(res).toEqual({ statusCode: 403, body: { error: 'FORBIDDEN' } });
  });

  it('403 for a legacy row naming a location of another brand', async () => {
    const res = await handoff('sub-foreign-legacy');
    expect(res.statusCode).toBe(403);
  });

  it('403 for an unknown user', async () => {
    const res = await handoff('sub-ghost');
    expect(res.statusCode).toBe(403);
  });

  it('403 when the role is not in the target roles', async () => {
    const res = await handoff('sub-customer', 'staff-tool');
    expect(res).toEqual({ statusCode: 403, body: { error: 'FORBIDDEN' } });
  });

  it('admits a role listed in the target roles', async () => {
    const res = await handoff('sub-staff', 'staff-tool');
    expect(res.statusCode).toBe(200);
    expect((decodeJwt((res.body as any).token) as any).membershipRole).toBe('STAFF');
  });

  it('accepts a legacy row (businessId of this brand, brandId NULL)', async () => {
    const res = await handoff('sub-legacy');
    expect(res.statusCode).toBe(200);
    const decoded = decodeJwt((res.body as any).token) as any;
    expect(decoded.brandId).toBe(BRAND_A);
    expect(decoded.businessId).toBe(BIZ_A);
    expect(decoded.membershipRole).toBe('USER');
  });
});

describe('HANDOFF_TARGETS parsing (fail-closed)', () => {
  function configure(value: string | undefined) {
    if (value === undefined) delete process.env.HANDOFF_TARGETS;
    else process.env.HANDOFF_TARGETS = value;
    _resetHandoffTargetsCache();
  }

  function withEntry(entry: Record<string, unknown>) {
    configure(JSON.stringify({ 'promo-site': { ...TARGETS['promo-site'], ...entry } }));
  }

  it('unset → no target exists', async () => {
    configure(undefined);
    expect((await handoff('sub-customer')).statusCode).toBe(404);
  });

  it('invalid JSON → no target exists, with a warning', async () => {
    configure('{not json');
    const warn = vi.fn();
    expect(getHandoffTargets({ warn, info: vi.fn() } as any).size).toBe(0);
    expect(warn).toHaveBeenCalled();
    expect((await handoff('sub-customer')).statusCode).toBe(404);
  });

  it('a JSON array → no target exists', async () => {
    configure('[]');
    expect((await handoff('sub-customer')).statusCode).toBe(404);
  });

  it('http url → target unknown', async () => {
    withEntry({ url: 'http://promo.example.com/handoff' });
    expect((await handoff('sub-customer')).statusCode).toBe(404);
  });

  it('http://localhost is accepted for development', async () => {
    withEntry({ url: 'http://localhost:5173/handoff' });
    const res = await handoff('sub-customer');
    expect(res.statusCode).toBe(200);
    expect((res.body as any).url).toBe('http://localhost:5173/handoff');
  });

  it('non-http(s) url → target unknown', async () => {
    for (const url of ['javascript:alert(1)', 'ftp://promo.example.com', 'not a url', '']) {
      withEntry({ url });
      expect((await handoff('sub-customer')).statusCode).toBe(404);
    }
  });

  it('missing or malformed audience / brandId → target unknown', async () => {
    for (const entry of [
      { audience: undefined },
      { audience: '' },
      { audience: 'has space' },
      { audience: 'promo:site' },
      { brandId: undefined },
      { brandId: 'brand-a' },
      { url: undefined },
    ]) {
      withEntry(entry);
      expect((await handoff('sub-customer')).statusCode).toBe(404);
    }
  });

  it('malformed roles → target unknown', async () => {
    for (const roles of [[], 'USER', ['SUPERUSER'], [42]]) {
      withEntry({ roles });
      expect((await handoff('sub-customer')).statusCode).toBe(404);
    }
  });

  it('one bad entry does not disable the others', async () => {
    configure(JSON.stringify({
      'promo-site': TARGETS['promo-site'],
      broken: { audience: 'frontend-spa', brandId: BRAND_A, url: PROMO_URL },
    }));
    expect((await handoff('sub-customer')).statusCode).toBe(200);
    expect((await handoff('sub-customer', 'broken')).statusCode).toBe(404);
  });

  describe('reserved audiences are rejected at parse time', () => {
    const builtIn = [
      'frontend-spa',
      'pizzeria-manager',
      'user-service',
      'campaign-service',
      'messaging-service',
      'business-service',
      'domain-mapper-service',
      'User-Service', // case does not help
    ];
    for (const audience of builtIn) {
      it(`refuses "${audience}"`, async () => {
        withEntry({ audience });
        const warn = vi.fn();
        expect(getHandoffTargets({ warn, info: vi.fn() } as any).size).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ target: 'promo-site' }), expect.any(String));
        expect((await handoff('sub-customer')).statusCode).toBe(404);
      });
    }

    it('refuses an internal service client id, and the family of a per-tenant one', async () => {
      process.env.INTERNAL_SERVICE_CLIENTS = JSON.stringify({
        'loyalty-worker': 'secret-1',
        'report-service:tenant-x': { secret: 'secret-2', brandId: BRAND_A },
      });
      for (const audience of ['loyalty-worker', 'report-service']) {
        withEntry({ audience });
        expect((await handoff('sub-customer')).statusCode).toBe(404);
      }
    });

    it('refuses anything in the deployment audience allow-list', async () => {
      process.env.KEYCLOAK_AUDIENCE = 'user-service,extra-gateway';
      withEntry({ audience: 'extra-gateway' });
      expect((await handoff('sub-customer')).statusCode).toBe(404);
    });
  });
});

// Through the real auth plugin: the route is wired, authenticated with a user
// access token, and the token it returns is NOT accepted back by user-service.
describe('handoff through the real server', () => {
  let server: any;

  beforeAll(async () => {
    process.env.JWT_PRIVATE_KEY = testPrivateKeyPem;
    process.env.JWT_PUBLIC_KEY = testPublicKeyPem;
    process.env.JWT_KID = 'test-kid-handoff-1';
    process.env.JWT_ISSUER = TEST_ISSUER;
    delete process.env.KEYCLOAK_AUTH_BYPASS;
    // Read by the auth plugin at registration; the value a deployment carries.
    process.env.KEYCLOAK_AUDIENCE = 'user-service,business-service';
    _resetSelfIssuedCache();
    server = await buildServer({
      overrides: {
        repository: createRepo() as any,
        tokenService: { async getAccessToken() { return 'test-admin-token'; } },
      },
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
  });

  beforeEach(() => {
    process.env.KEYCLOAK_AUDIENCE = 'user-service,business-service';
    _resetHandoffTargetsCache();
  });

  it('401 without a token', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/v1/auth/handoff', payload: { target: 'promo-site' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'UNAUTHENTICATED' });
  });

  it('200 with a user token, and the handoff token is refused by our own audience gate', async () => {
    const userToken = await signAccessToken({ sub: 'sub-customer', email: 'customer@example.com' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/handoff',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { target: 'promo-site' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { token, url } = res.json();
    expect(url).toBe(PROMO_URL);

    const replay = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('Invalid audience');
  });
});
