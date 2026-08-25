import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// domain-mapper is network-bound; mock it so the tests decide what a host
// resolves to. Every export the code under test touches must be provided.
vi.mock('@/utils/domainMapping.js', () => ({
  resolveDomainFromRequest: vi.fn(),
  resolveDomain: vi.fn(),
  fetchDomainBusinesses: vi.fn(),
  fetchBusinessServiceUrl: vi.fn(),
  resolveBusinessServiceUrl: vi.fn(),
  fetchDomainInfoByHost: vi.fn(),
}));

import {
  resolveDomain,
  resolveDomainFromRequest,
  fetchDomainBusinesses,
  resolveBusinessServiceUrl,
} from '@/utils/domainMapping.js';
import { _resetLegacyWarnings, requireServiceForTenant } from '@/utils/tenantGuard.js';
import { buildServer } from '../src/appBuilder.js';

const BRAND_A = 'brand-a-chepizza';
const BRAND_B = 'brand-b-cliente';
const BIZ_A = 'biz-a-taggi';
const BIZ_B = 'biz-b-unica';

const HOST_A = 'fidelity.brand-a.test';
const HOST_B = 'fidelity.brand-b.test';

type Membership = { userId: string; brandId: string | null; businessId: string | null; role: string; validStamps?: number; validCoupons?: number; totalCoupons?: number };

function createRepo() {
  const users = [
    { id: 'u-staff-a', keycloakSub: 'sub-staff-a', email: 'staff-a@x.com', name: 'Sara', surname: 'A' },
    { id: 'u-cust-a', keycloakSub: 'sub-cust-a', email: 'cust-a@x.com', name: 'Carlo', surname: 'A' },
    { id: 'u-staff-b', keycloakSub: 'sub-staff-b', email: 'staff-b@x.com', name: 'Bruno', surname: 'B' },
    { id: 'u-cust-b', keycloakSub: 'sub-cust-b', email: 'cust-b@x.com', name: 'Bea', surname: 'B' },
    // Legacy shape: membership rows carrying a businessId with no brandId.
    { id: 'u-legacy-staff', keycloakSub: 'sub-legacy-staff', email: 'legacy-staff@x.com', name: 'Lino', surname: 'Legacy' },
    { id: 'u-legacy-cust', keycloakSub: 'sub-legacy-cust', email: 'legacy@x.com', name: 'Lea', surname: 'Legacy' },
  ];
  const memberships: Membership[] = [
    { userId: 'u-staff-a', brandId: BRAND_A, businessId: BIZ_A, role: 'STAFF' },
    { userId: 'u-cust-a', brandId: BRAND_A, businessId: BIZ_A, role: 'USER', validStamps: 7, validCoupons: 1, totalCoupons: 2 },
    { userId: 'u-staff-b', brandId: BRAND_B, businessId: BIZ_B, role: 'STAFF' },
    { userId: 'u-cust-b', brandId: BRAND_B, businessId: BIZ_B, role: 'USER', validStamps: 3, validCoupons: 0, totalCoupons: 0 },
  ];

  return {
    _memberships: memberships,
    async healthCheck() { return { ok: true as const }; },
    async findUserById(id: string) { return users.find((u) => u.id === id) ?? null; },
    async findUserByKeycloakSub(sub: string) { return users.find((u) => u.keycloakSub === sub) ?? null; },
    async listMemberships(userId: string) { return memberships.filter((m) => m.userId === userId); },
    async getMembershipByBrand(userId: string, brandId: string) {
      return memberships.find((m) => m.userId === userId && m.brandId === brandId) ?? null;
    },
    async getMembership(userId: string, businessId: string) {
      return memberships.find((m) => m.userId === userId && m.businessId === businessId) ?? null;
    },
    async findBrandIdByBusinessId(businessId: string) {
      return memberships.find((m) => m.businessId === businessId && m.brandId)?.brandId ?? null;
    },
    async listBusinessIdsForBrand(brandId: string) {
      return Array.from(new Set(
        memberships.filter((m) => m.brandId === brandId && m.businessId).map((m) => m.businessId as string),
      ));
    },
    async upsertMembership(userId: string, m: any) {
      const existing = memberships.find((x) => x.userId === userId && x.brandId === (m.brandId ?? null));
      if (existing) { Object.assign(existing, m); return existing; }
      const rec: Membership = { userId, brandId: m.brandId ?? null, businessId: m.businessId ?? null, role: m.role ?? 'USER' };
      memberships.push(rec);
      return rec;
    },
    async applyMembershipCounters(existing: Membership, counters: any) {
      Object.assign(existing, counters);
      return existing;
    },
    async findUsersForTargetingByBrand(brandId: string) {
      const ids = memberships.filter((m) => m.brandId === brandId).map((m) => m.userId);
      return users.filter((u) => ids.includes(u.id));
    },
    async findUsersForTargeting() { return users; },
    async listMembershipsForUsersByBrand(userIds: string[], brandId: string) {
      return memberships.filter((m) => userIds.includes(m.userId) && m.brandId === brandId);
    },
  };
}

describe('cross-tenant isolation', () => {
  const OLD_ENV = process.env;
  let server: any;
  let repo: ReturnType<typeof createRepo>;

  beforeAll(async () => {
    process.env = { ...OLD_ENV, KEYCLOAK_AUTH_BYPASS: 'true', KEYCLOAK_SERVICE_AUDIENCE: 'business-service,campaign-service,messaging-service,user-service' };
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
    _resetLegacyWarnings();
    delete process.env.REQUIRE_TENANT_SERVICE_TOKENS;
    delete process.env.PLATFORM_ADMIN_SUBS;
    vi.mocked(fetchDomainBusinesses).mockResolvedValue([
      { label: 'A', brandId: BRAND_A, businessId: BIZ_A, services: {} },
      { label: 'B', brandId: BRAND_B, businessId: BIZ_B, services: {} },
    ] as any);
    vi.mocked(resolveBusinessServiceUrl).mockResolvedValue(null as any);
    const byHost = (host?: string | null) => {
      if (host === HOST_A) return { brandId: BRAND_A, businessId: BIZ_A, host: HOST_A, service: null, label: 'A', url: null };
      if (host === HOST_B) return { brandId: BRAND_B, businessId: BIZ_B, host: HOST_B, service: null, label: 'B', url: null };
      return null;
    };
    vi.mocked(resolveDomain).mockImplementation(async (host?: any) => byHost(host) as any);
    vi.mocked(resolveDomainFromRequest).mockImplementation(async (headers: any) => {
      const h = headers?.['x-forwarded-host'] ?? headers?.host;
      return byHost(Array.isArray(h) ? h[0] : h) as any;
    });
  });

  // -------------------------------------------------------------------------
  // The headline case: a service credential belonging to tenant B reading
  // tenant A's customer list. Before the fix this returned 200 with real rows —
  // one shared secret was the whole customer database of every tenant.
  // -------------------------------------------------------------------------
  describe('POST /internal/v1/users/query', () => {
    function query(headers: Record<string, string>, payload: any) {
      return server.inject({ method: 'POST', url: '/internal/v1/users/query', headers, payload });
    }

    it('refuses a brand-B service token querying brand A (was 200, now 403)', async () => {
      const res = await query(
        { 'x-test-azp': 'business-service:brand-b', 'x-test-brand-id': BRAND_B },
        { brandId: BRAND_A, limit: 5 },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('CROSS_TENANT_FORBIDDEN');
    });

    // Unambiguous regression proof. This uses the *legacy* client id
    // ("business-service", which the old allow-list matched exactly) so the
    // only thing separating pass from fail is the tenant check itself, not the
    // new "service:tenant" id format. On the pre-fix code this returned 200
    // with brand A's real customer rows.
    it('refuses a caller bound to brand B dumping brand A under the plain client id', async () => {
      const res = await query(
        { 'x-test-azp': 'business-service', 'x-test-brand-id': BRAND_B },
        { brandId: BRAND_A, limit: 200 },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('CROSS_TENANT_FORBIDDEN');
    });

    it('refuses cross-tenant access expressed as a businessId', async () => {
      const res = await query(
        { 'x-test-azp': 'business-service:brand-b', 'x-test-brand-id': BRAND_B },
        { businessId: BIZ_A, limit: 5 },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('CROSS_TENANT_FORBIDDEN');
    });

    it('allows a service token querying its own brand', async () => {
      const res = await query(
        { 'x-test-azp': 'business-service:brand-a', 'x-test-brand-id': BRAND_A },
        { brandId: BRAND_A, limit: 5 },
      );
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().users)).toBe(true);
    });

    it('refuses an unscoped query from a tenant-bound caller', async () => {
      const res = await query(
        { 'x-test-azp': 'business-service:brand-a', 'x-test-brand-id': BRAND_A },
        { limit: 5 },
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('TENANT_SCOPE_REQUIRED');
    });

    it('still refuses a non-service caller', async () => {
      const res = await query({ 'x-test-sub': 'sub-cust-a' }, { brandId: BRAND_A });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('FORBIDDEN');
    });
  });

  // -------------------------------------------------------------------------
  // Rotation window: the legacy tenant-blind credential keeps working until
  // REQUIRE_TENANT_SERVICE_TOKENS flips, which is what lets Che Pizza stay up
  // while the new per-tenant secrets are rolled out.
  // -------------------------------------------------------------------------
  describe('legacy tenant-blind service tokens', () => {
    it('are accepted during the rotation window', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/internal/v1/users/query',
        headers: { 'x-test-azp': 'business-service' },
        payload: { brandId: BRAND_A, limit: 5 },
      });
      expect(res.statusCode).toBe(200);
    });

    // business-service syncs counters on every stamp, so a per-call warn puts a
    // line in the log for every stamp of every customer. The rotation runbook
    // says "watch until this warning stops"; at that volume nobody can.
    // Exercised directly on the guard: Fastify hands each request its own child
    // logger, so spying on server.log would see nothing.
    it('warns once per client id per process, not per call', () => {
      _resetLegacyWarnings();
      const lines: string[] = [];
      const req = (clientId: string) => ({
        url: '/internal/v1/users/query',
        log: { warn: (_o: any, msg?: any) => lines.push(String(msg ?? '')) },
        auth: { azp: clientId, sub: clientId },
        server: { repository: repo },
      }) as any;

      for (let i = 0; i < 5; i++) requireServiceForTenant(req('business-service'), BRAND_A);
      expect(lines.filter((l) => l.includes('rotation window')).length).toBe(1);

      // A different credential is its own signal and still gets one line.
      requireServiceForTenant(req('campaign-service'), BRAND_A);
      expect(lines.filter((l) => l.includes('rotation window')).length).toBe(2);
    });

    it('always logs a refusal, never deduped', () => {
      _resetLegacyWarnings();
      const lines: string[] = [];
      const req = {
        url: '/internal/v1/users/query',
        log: { warn: (_o: any, msg?: any) => lines.push(String(msg ?? '')) },
        auth: { azp: 'business-service:brand-b', sub: 'business-service:brand-b', brandId: BRAND_B },
        server: { repository: repo },
      } as any;

      for (let i = 0; i < 3; i++) requireServiceForTenant(req, BRAND_A);
      expect(lines.filter((l) => l.includes('cross-tenant service call refused')).length).toBe(3);
    });

    it('are refused once REQUIRE_TENANT_SERVICE_TOKENS=true', async () => {
      process.env.REQUIRE_TENANT_SERVICE_TOKENS = 'true';
      const res = await server.inject({
        method: 'POST',
        url: '/internal/v1/users/query',
        headers: { 'x-test-azp': 'business-service' },
        payload: { brandId: BRAND_A, limit: 5 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('TENANT_BLIND_SERVICE_TOKEN');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/users/:userId — previously readable by ANY authenticated user,
  // for ANY user id, returning email + phone + cross-brand memberships.
  // -------------------------------------------------------------------------
  describe('GET /api/v1/users/:userId', () => {
    function getUser(userId: string, headers: Record<string, string>) {
      return server.inject({ method: 'GET', url: `/api/v1/users/${userId}`, headers });
    }

    it('refuses a plain customer (was 200 for any id, now 403)', async () => {
      const res = await getUser('u-cust-a', { host: HOST_A, 'x-test-sub': 'sub-cust-a' });
      expect(res.statusCode).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await getUser('u-cust-a', { host: HOST_A });
      expect(res.statusCode).toBe(401);
    });

    it('lets brand-A staff read a brand-A customer', async () => {
      const res = await getUser('u-cust-a', { host: HOST_A, 'x-test-sub': 'sub-staff-a' });
      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe('cust-a@x.com');
    });

    it('hides a brand-B customer from brand-A staff (404, not 403)', async () => {
      const res = await getUser('u-cust-b', { host: HOST_A, 'x-test-sub': 'sub-staff-a' });
      expect(res.statusCode).toBe(404);
    });

    it('refuses brand-A staff acting against brand B via the host header', async () => {
      // Host selects the tenant, so pointing it at B is allowed — but the caller
      // holds no membership on B, so it buys nothing.
      const res = await getUser('u-cust-b', { host: HOST_B, 'x-test-sub': 'sub-staff-a' });
      expect(res.statusCode).toBe(403);
    });

    it('never leaks memberships from other brands', async () => {
      // Give the brand-A customer a second membership on brand B.
      repo._memberships.push({ userId: 'u-cust-a', brandId: BRAND_B, businessId: BIZ_B, role: 'USER' });
      const res = await getUser('u-cust-a', { host: HOST_A, 'x-test-sub': 'sub-staff-a' });
      expect(res.statusCode).toBe(200);
      const brands = res.json().memberships.map((m: any) => m.brandId);
      expect(brands).toEqual([BRAND_A]);
      repo._memberships.pop();
    });

    it('lets a platform admin through', async () => {
      process.env.PLATFORM_ADMIN_SUBS = 'sub-cust-a,sub-someone-else';
      const res = await getUser('u-cust-a', { host: HOST_A, 'x-test-sub': 'sub-cust-a' });
      expect(res.statusCode).toBe(200);
    });

    // Legacy rows: a businessId with a NULL brandId. business-service counts
    // them as in-tenant (membershipInTenant matches the brand's location set),
    // so user-service has to as well. While the two disagreed, a staff member
    // could stamp a customer and then get 403 opening that customer's record,
    // and a legacy-row customer was simply a 404 to their own pizzeria.
    describe('memberships carrying only a businessId', () => {
      it('admits staff whose row has a NULL brandId but a location of the brand', async () => {
        repo._memberships.push({ userId: 'u-legacy-staff', brandId: null, businessId: BIZ_A, role: 'STAFF' });
        const res = await getUser('u-cust-a', { host: HOST_A, 'x-test-sub': 'sub-legacy-staff' });
        expect(res.statusCode).toBe(200);
        repo._memberships.pop();
      });

      it('finds a customer whose only row has a NULL brandId', async () => {
        repo._memberships.push({ userId: 'u-legacy-cust', brandId: null, businessId: BIZ_A, role: 'USER' });
        const res = await getUser('u-legacy-cust', { host: HOST_A, 'x-test-sub': 'sub-staff-a' });
        expect(res.statusCode).toBe(200);
        expect(res.json().email).toBe('legacy@x.com');
        repo._memberships.pop();
      });

      it('does not admit a NULL-brand row pointing at another brand location', async () => {
        // The fallback widens what counts as this brand; it must not dissolve
        // the boundary.
        repo._memberships.push({ userId: 'u-legacy-staff', brandId: null, businessId: BIZ_B, role: 'STAFF' });
        const res = await getUser('u-cust-a', { host: HOST_A, 'x-test-sub': 'sub-legacy-staff' });
        expect(res.statusCode).toBe(403);
        repo._memberships.pop();
      });
    });
  });

  // -------------------------------------------------------------------------
  // PATCH memberships — the "enrol anyone into my brand" write.
  // -------------------------------------------------------------------------
  describe('PATCH /api/v1/users/:userId/memberships', () => {
    function patch(headers: Record<string, string>, payload: any) {
      return server.inject({ method: 'PATCH', url: '/api/v1/users/u-cust-a/memberships', headers, payload });
    }

    it('refuses a brand-B service token writing a brand-A membership', async () => {
      const res = await patch(
        { 'x-test-azp': 'business-service:brand-b', 'x-test-brand-id': BRAND_B },
        { memberships: [{ brandId: BRAND_A, businessId: BIZ_A, roles: [] }] },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('CROSS_TENANT_FORBIDDEN');
    });

    it('refuses a mixed-brand payload on the entry the caller does not own', async () => {
      const res = await patch(
        { 'x-test-azp': 'business-service:brand-b', 'x-test-brand-id': BRAND_B },
        { memberships: [
          { brandId: BRAND_B, businessId: BIZ_B, roles: [] },
          { brandId: BRAND_A, businessId: BIZ_A, roles: [] },
        ] },
      );
      expect(res.statusCode).toBe(403);
    });

    it('allows a service token writing its own brand', async () => {
      const res = await patch(
        { 'x-test-azp': 'business-service:brand-a', 'x-test-brand-id': BRAND_A },
        { memberships: [{ brandId: BRAND_A, businessId: BIZ_A, roles: [] }] },
      );
      expect(res.statusCode).toBe(200);
    });

    it('refuses a plain user token (no membership claims exist, so this was already service-only — now it is explicit)', async () => {
      const res = await patch(
        { 'x-test-sub': 'sub-staff-a', host: HOST_A },
        { memberships: [{ brandId: BRAND_A, businessId: BIZ_A, roles: [] }] },
      );
      expect(res.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Counter writes — rewriting another tenant's loyalty ledger.
  // -------------------------------------------------------------------------
  describe('POST /internal/v1/users/:userId/memberships/counters', () => {
    it('refuses a brand-B service token writing brand-A counters', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/internal/v1/users/u-cust-a/memberships/counters',
        headers: { 'x-test-azp': 'business-service:brand-b', 'x-test-brand-id': BRAND_B },
        payload: { businessId: BIZ_A, brandId: BRAND_A, scope: 'BRAND', validStamps: 999 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('CROSS_TENANT_FORBIDDEN');
      expect(repo._memberships.find((m) => m.userId === 'u-cust-a')?.validStamps).toBe(7);
    });

    it('allows the owning tenant', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/internal/v1/users/u-cust-a/memberships/counters',
        headers: { 'x-test-azp': 'business-service:brand-a', 'x-test-brand-id': BRAND_A },
        payload: { businessId: BIZ_A, brandId: BRAND_A, scope: 'BRAND', validStamps: 9 },
      });
      expect(res.statusCode).toBe(200);
    });

    // Stamping path. Under a BRAND wallet the row was resolved by brandId
    // alone, so a customer whose only row is a legacy one got a 404
    // MEMBERSHIP_NOT_FOUND: the stamp persisted in business-service's DB but
    // the counters never synced back.
    it('finds a legacy row when the customer has no brand-scoped membership', async () => {
      repo._memberships.push({ userId: 'u-legacy-cust', brandId: null, businessId: BIZ_A, role: 'USER', validStamps: 1 });
      const res = await server.inject({
        method: 'POST',
        url: '/internal/v1/users/u-legacy-cust/memberships/counters',
        headers: { 'x-test-azp': 'business-service:brand-a', 'x-test-brand-id': BRAND_A },
        payload: { businessId: BIZ_A, brandId: BRAND_A, scope: 'BRAND', validStamps: 4 },
      });
      expect(res.statusCode).toBe(200);
      expect(repo._memberships.find((m) => m.userId === 'u-legacy-cust')?.validStamps).toBe(4);
      repo._memberships.pop();
    });
  });
});
