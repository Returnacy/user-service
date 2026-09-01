import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

// domain-mapper is network-bound; mock it so each test decides what a host
// resolves to — including "resolves to nothing", which is the whole point here.
vi.mock('@/utils/domainMapping.js', () => ({
  resolveDomain: vi.fn(),
  resolveDomainFromRequest: vi.fn(),
  fetchDomainBusinesses: vi.fn(),
  fetchBusinessServiceUrl: vi.fn(),
  resolveBusinessServiceUrl: vi.fn(),
  fetchDomainInfoByHost: vi.fn(),
}));

import { resolveDomain } from '@/utils/domainMapping.js';
import { _resetSelfIssuedCache } from '@/utils/selfIssuedJwt.js';
import { buildServer } from '../src/appBuilder.js';

// Tenant B is the new public tenant; the default-brand env vars point at
// tenant A (Che Pizza's shape). They are set on purpose in every test: on the
// pre-fix code an unresolvable host fell back to them and enrolled the signup
// into tenant A.
const BRAND_A = 'brand-a-chepizza';
const BIZ_A = 'biz-a-taggi';
const BRAND_B = 'brand-b-cliente';
const BIZ_B = 'biz-b-unica';

const HOST_B = 'fidelity.brand-b.test';
const HOST_UNMAPPED = 'fidelity.unknown.test';

type CreatedUser = { id: string; keycloakSub: string; email: string; name: string; surname: string };
type CreatedMembership = { userId: string; businessId: string | null; brandId: string | null; role: string };

function createRepo() {
  const users: CreatedUser[] = [];
  const memberships: CreatedMembership[] = [];
  const repo = {
    _users: users,
    _memberships: memberships,
    async healthCheck() { return { ok: true as const }; },
    async findUserByKeycloakSub(sub: string) { return users.find((u) => u.keycloakSub === sub) ?? null; },
    async findUserByEmail(email: string) { return users.find((u) => u.email === email) ?? null; },
    async findUserByGoogleSub() { return null; },
    createUser: vi.fn(async () => { throw new Error('createUser must not be used by the register path'); }),
    createUserWithMembership: vi.fn(async (sub: string, data: any, membership: any) => {
      if (!membership.businessId && !membership.brandId) {
        throw Object.assign(new Error('BUSINESS_OR_BRAND_REQUIRED'), { code: 'BUSINESS_OR_BRAND_REQUIRED' });
      }
      const user: CreatedUser = {
        id: `u_${users.length + 1}`,
        keycloakSub: sub,
        email: data.email,
        name: data.name,
        surname: data.surname,
      };
      users.push(user);
      memberships.push({
        userId: user.id,
        businessId: membership.businessId ?? null,
        brandId: membership.brandId ?? null,
        role: membership.role ?? 'USER',
      });
      return user;
    }),
    addMembership: vi.fn(async () => { throw new Error('addMembership must not be used by the register path'); }),
    upsertMembership: vi.fn(async () => { throw new Error('upsertMembership must not be used by the register path'); }),
    async listMemberships(userId: string) { return memberships.filter((m) => m.userId === userId); },
    async getLatestPrivacyPolicyVersion() { return '1.0.0'; },
    async getLatestTermsOfServiceVersion() { return '1.0.0'; },
    async getLatestMarketingTermsVersion() { return '1.0.0'; },
    async createPrivacyPolicyAcceptance() { return { ok: true }; },
    async createTermsOfServiceAcceptance() { return { ok: true }; },
    async createMarketingTermsAcceptance() { return { ok: true }; },
    async createEmailVerificationToken(userId: string) { return { id: 'tok_1', token: 'verify-token', userId }; },
  };
  return repo;
}

describe('POST /api/v1/auth/register — tenant resolution fails closed', () => {
  const OLD_ENV = process.env;
  let server: any;
  let repo: ReturnType<typeof createRepo>;
  let emailSeq = 0;

  const payload = () => ({
    email: `signup_${++emailSeq}@test.local`,
    password: 'SuperSecret1!',
    name: 'Test',
    surname: 'User',
    birthday: '2000-01-01',
    acceptPrivacyPolicy: true,
    acceptTermsOfService: true,
  });

  beforeAll(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    process.env = {
      ...OLD_ENV,
      KEYCLOAK_AUTH_BYPASS: 'true',
      JWT_PRIVATE_KEY: privateKey,
      JWT_PUBLIC_KEY: publicKey,
      JWT_KID: 'test-kid-1',
      JWT_ISSUER: 'https://test.user-service.local',
      // The removed fallback, still configured in the environment.
      DEFAULT_BRAND_ID: BRAND_A,
      DEFAULT_BUSINESS_ID: BIZ_A,
    };
    delete process.env.MESSAGING_SERVICE_URL;
    _resetSelfIssuedCache();
    repo = createRepo();
    server = await buildServer({
      overrides: { repository: repo as any, tokenService: { async getAccessToken() { return 't'; } } },
    });
    await server.ready();
  });

  afterAll(async () => {
    process.env = OLD_ENV;
    await server?.close();
  });

  beforeEach(() => {
    vi.mocked(resolveDomain).mockImplementation(async (host?: any) => (
      host === HOST_B
        ? { brandId: BRAND_B, businessId: BIZ_B, host: HOST_B, service: null, label: 'B', url: null } as any
        : null
    ));
  });

  it('registers against the brand the host resolves to', async () => {
    const body = payload();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { host: HOST_B },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(body.email);
    const created = repo._memberships.find((m) => m.userId === repo._users.at(-1)!.id)!;
    expect(created.brandId).toBe(BRAND_B);
    expect(created.businessId).toBe(BIZ_B);
  });

  it('refuses the signup when the host resolves to no tenant', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { host: HOST_UNMAPPED },
      payload: payload(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('REGISTRATION_UNAVAILABLE');
  });

  it('writes no user and no membership when the host resolves to no tenant', async () => {
    const before = { users: repo._users.length, memberships: repo._memberships.length };
    const body = payload();

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { host: HOST_UNMAPPED },
      payload: body,
    });

    expect(res.statusCode).toBe(503);
    expect(repo._users.length).toBe(before.users);
    expect(repo._memberships.length).toBe(before.memberships);
    expect(repo.createUserWithMembership).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: body.email }),
      expect.anything(),
    );
    expect(repo.createUser).not.toHaveBeenCalled();
    expect(repo.addMembership).not.toHaveBeenCalled();
    expect(repo.upsertMembership).not.toHaveBeenCalled();
  });

  // The regression the fix exists for: DEFAULT_BRAND_ID/DEFAULT_BUSINESS_ID are
  // set to tenant A above, so on the pre-fix code this signup arrived on tenant
  // B's host during a mapper outage and became a tenant-A customer.
  it('never enrols an unresolved signup into the configured default brand', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { host: HOST_UNMAPPED },
      payload: payload(),
    });

    expect(repo._memberships.some((m) => m.brandId === BRAND_A || m.businessId === BIZ_A)).toBe(false);
  });

  it('still fails closed when the mapper answers with a tenant-less resolution', async () => {
    vi.mocked(resolveDomain).mockResolvedValue({
      brandId: null, businessId: null, host: HOST_B, service: null, label: null, url: null,
    } as any);

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { host: HOST_B },
      payload: payload(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('REGISTRATION_UNAVAILABLE');
  });
});
