import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt } from 'jose';

// Domain resolution is network-bound; mock it so tests control the resolved brand.
vi.mock('@/utils/domainMapping.js', () => ({
  resolveDomainFromRequest: vi.fn(),
  fetchDomainBusinesses: vi.fn(),
}));

import { resolveDomainFromRequest, fetchDomainBusinesses } from '@/utils/domainMapping.js';
import { _resetSelfIssuedCache } from '@/utils/selfIssuedJwt.js';
import { postPmHandoffService } from '@/modules/api/v1/auth/post.pmHandoff.service.js';

const TEST_ISSUER = 'https://test.user-service.local';
const TEST_KID = 'test-kid-pm-1';
const BRAND = 'brand-1';
// Mirrors the live shape: TAGGI is in domain-mapping.json, LISSARO is not — it
// exists only as a membership row. That gap is what the omit rule is about.
const TAGGI = 'biz-taggi';
const LISSARO = 'biz-lissaro';
const OTHER_BRAND_BIZ = 'biz-of-another-brand';

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
    { id: 'u-staff', keycloakSub: 'sub-staff', email: 'staff@x.com', name: 'Sara', surname: 'Staff' },
    { id: 'u-user', keycloakSub: 'sub-user', email: 'user@x.com', name: 'Ugo', surname: 'User' },
    { id: 'u-legacy', keycloakSub: 'sub-legacy', email: 'legacy@x.com', name: 'Lino', surname: 'Legacy' },
    { id: 'u-foreign', keycloakSub: 'sub-foreign', email: 'foreign@x.com', name: 'Fabio', surname: 'Foreign' },
  ];
  const memberships: Membership[] = [
    { userId: 'u-staff', brandId: BRAND, businessId: TAGGI, role: 'STAFF' },
    // legacy shape: businessId of this brand, no brandId
    { userId: 'u-legacy', brandId: null, businessId: TAGGI, role: 'STAFF' },
    // legacy shape pointing at a location of a different brand
    { userId: 'u-foreign', brandId: null, businessId: OTHER_BRAND_BIZ, role: 'STAFF' },
    { userId: 'u-user', brandId: BRAND, businessId: TAGGI, role: 'USER' },
  ];
  return {
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
    _memberships: memberships,
  };
}

function makeRequest(opts: { sub?: string; repo: any; body?: any }) {
  return {
    auth: opts.sub ? { sub: opts.sub } : undefined,
    headers: {},
    body: opts.body,
    server: { repository: opts.repo },
    log: { error: () => {}, warn: () => {}, info: () => {} },
  } as any;
}

let repo: ReturnType<typeof createRepo>;

beforeEach(() => {
  process.env.JWT_PRIVATE_KEY = testPrivateKeyPem;
  process.env.JWT_PUBLIC_KEY = testPublicKeyPem;
  process.env.JWT_KID = TEST_KID;
  process.env.JWT_ISSUER = TEST_ISSUER;
  _resetSelfIssuedCache();
  repo = createRepo();
  (resolveDomainFromRequest as any).mockResolvedValue({ brandId: BRAND, businessId: null, host: null, service: null, label: null, url: null });
  // Only TAGGI is mapped, as in production.
  (fetchDomainBusinesses as any).mockResolvedValue([
    { label: 'Taggi', brandId: BRAND, businessId: TAGGI, services: {} },
    { label: 'Other', brandId: 'another-brand', businessId: OTHER_BRAND_BIZ, services: {} },
  ]);
});

describe('POST /api/v1/auth/pm-handoff', () => {
  it('401 when unauthenticated', async () => {
    const res = await postPmHandoffService(makeRequest({ repo }));
    expect(res.statusCode).toBe(401);
  });

  it('403 when domain resolves to no brand', async () => {
    (resolveDomainFromRequest as any).mockResolvedValueOnce(null);
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-staff', repo }));
    expect(res.statusCode).toBe(403);
  });

  it('403 for a plain USER caller', async () => {
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-user', repo }));
    expect(res.statusCode).toBe(403);
  });

  it('mints a 60s pizzeria-manager token with membershipRole for a STAFF caller', async () => {
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-staff', repo }));
    expect(res.statusCode).toBe(200);
    const body = res.body as any;
    expect(body.expiresIn).toBe(60);
    expect(typeof body.token).toBe('string');

    const decoded = decodeJwt(body.token) as any;
    expect(decoded.aud).toBe('pizzeria-manager');
    expect(decoded.iss).toBe(TEST_ISSUER);
    expect(decoded.sub).toBe('sub-staff');
    expect(decoded.email).toBe('staff@x.com');
    expect(decoded.given_name).toBe('Sara');
    expect(decoded.family_name).toBe('Staff');
    expect(decoded.name).toBe('Sara Staff');
    expect(decoded.membershipRole).toBe('STAFF');
    expect(decoded.exp - decoded.iat).toBe(60);
  });

  // brandId is the claim PizzeriaManager checks in order to refuse another
  // tenant's staff. Without it, every PM on this issuer accepted every tenant.
  it('always carries the brandId resolved from the host', async () => {
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-staff', repo }));
    expect((decodeJwt((res.body as any).token) as any).brandId).toBe(BRAND);
  });

  describe('businessId claim', () => {
    // docs/SSO-PM-CONTRACT.md §4: an unverifiable location is OMITTED, never
    // substituted. PM is specified to prefer the claim over the URL fragment,
    // so asserting the wrong pizzeria is worse than asserting nothing —
    // Lissaro staff would silently land on Taggi's chiusura.
    it('omits the claim when the requested location cannot be tied to the brand', async () => {
      const res = await postPmHandoffService(
        makeRequest({ sub: 'sub-staff', repo, body: { businessId: LISSARO } }),
      );
      expect(res.statusCode).toBe(200);
      const decoded = decodeJwt((res.body as any).token) as any;
      expect(decoded.businessId).toBeUndefined();
      // ...and in particular does not fall back to the membership's location.
      expect(decoded.businessId).not.toBe(TAGGI);
      expect(decoded.brandId).toBe(BRAND);
    });

    it('accepts a location proved by the caller own membership', async () => {
      const res = await postPmHandoffService(
        makeRequest({ sub: 'sub-staff', repo, body: { businessId: TAGGI } }),
      );
      expect((decodeJwt((res.body as any).token) as any).businessId).toBe(TAGGI);
    });

    it('never echoes a location belonging to another brand', async () => {
      const res = await postPmHandoffService(
        makeRequest({ sub: 'sub-staff', repo, body: { businessId: OTHER_BRAND_BIZ } }),
      );
      expect((decodeJwt((res.body as any).token) as any).businessId).toBeUndefined();
    });

    it('uses the membership location when nothing is proposed', async () => {
      const res = await postPmHandoffService(makeRequest({ sub: 'sub-staff', repo }));
      expect((decodeJwt((res.body as any).token) as any).businessId).toBe(TAGGI);
    });
  });
});

// Same rule as stamping: a row carrying only a businessId of this brand means
// the person works here. Without it a Lissaro-era staff member could stamp all
// evening and then be refused the chiusura handoff.
describe('pm-handoff for brandId-NULL membership rows', () => {
  it('mints a token for staff whose row names only a location of this brand', async () => {
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-legacy', repo }));
    expect(res.statusCode).toBe(200);
    const decoded = decodeJwt((res.body as any).token) as any;
    expect(decoded.brandId).toBe(BRAND);
    expect(decoded.membershipRole).toBe('STAFF');
  });

  it('refuses a row naming a location of a different brand', async () => {
    const res = await postPmHandoffService(makeRequest({ sub: 'sub-foreign', repo }));
    expect(res.statusCode).toBe(403);
  });
});
