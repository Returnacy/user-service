import type { FastifyRequest } from 'fastify';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveDomain } from '@/utils/domainMapping.js';
import { parseTokenMemberships } from '@/utils/memberships.js';

function deriveRoleFromMembership(match: any): string {
  const rolesArr = Array.isArray(match?.roles) ? match.roles.map((r: any) => String(r).toLowerCase()) : [];
  const single = match?.role ? String(match.role).toLowerCase() : undefined;
  if (single) return single;
  if (rolesArr.includes('admin')) return 'admin';
  if (rolesArr.includes('manager')) return 'manager';
  if (rolesArr.includes('staff')) return 'staff';
  return 'user';
}

type MeResponse = Record<string, unknown>;

export async function getMeService(request: FastifyRequest): Promise<ServiceResponse<MeResponse | { error: string }>> {
  const auth = (request as any).auth as any;
  if (!auth?.sub) {
    return { statusCode: 401, body: { error: 'UNAUTHENTICATED' } };
  }

  try {
    const repository = (request.server as any).repository as any;
    const sub = auth.sub as string;

    const existing = await repository.findUserByKeycloakSub(sub);
    if (!existing) {
      await repository.upsertUserByKeycloakSub(sub, { email: auth.email || '' });
    }
    const user = await repository.findUserByKeycloakSub(sub);

    const forwardedHost = (request.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim();
    const rawHost = forwardedHost || (request.headers['host'] as string);
    const host = rawHost ? rawHost.split(':')[0] : undefined;
    const domain = await resolveDomain(host);

    const tokenMembershipClaims = parseTokenMemberships((auth as any).memberships);
    let memberships = await repository.listMemberships(user.id);

    // Membership creation used to happen right here, on a plain GET: any
    // authenticated user who merely loaded another brand's SPA was enrolled as
    // that brand's customer — no intent, no privacy acceptance for that brand.
    // Enrolment now lives only where the user acts on purpose: register
    // (createUserWithMembership) and login on the brand's own host
    // (post.login.service).
    //
    // ME_AUTO_ENROLL=true restores the old behaviour. The knob exists because
    // this runs against a live tenant with no staging: if some pre-existing
    // account turns out to depend on the implicit enrolment, it can be flipped
    // back from Railway without shipping a revert. Default is the safe path.
    const autoEnrollFlag = String(process.env.ME_AUTO_ENROLL ?? '').toLowerCase().trim();
    const autoEnrollEnabled = autoEnrollFlag === 'true' || autoEnrollFlag === '1' || autoEnrollFlag === 'yes';

    if (domain && autoEnrollEnabled) {
      const targetBusinessId = domain.businessId ?? null;
      const targetBrandId = domain.brandId ?? null;
      const hasMembership = targetBusinessId
        ? memberships.some((m: any) => m.businessId === targetBusinessId)
        : targetBrandId
          ? memberships.some((m: any) => (m.brandId ?? null) === targetBrandId)
          : false;
      if (!hasMembership && (targetBusinessId || targetBrandId)) {
        request.log.warn(
          { userId: user.id, targetBrandId, targetBusinessId },
          '[me] implicit membership enrolment (ME_AUTO_ENROLL=true)',
        );
        await repository.upsertMembership(user.id, { businessId: targetBusinessId, brandId: targetBrandId, role: 'USER' });
        memberships = await repository.listMemberships(user.id);
      }
    }

    // A second write used to follow, taking the role from
    // `tokenMembershipClaims` — i.e. from the caller's own token — and
    // persisting it. It was inert only because user-service does not put
    // membership claims in its tokens; the day it did, a token would have
    // decided its own role. Roles change through the team API, nowhere else.
    void deriveRoleFromMembership;

    const localMemberships = memberships;

    let businessId: string | null = domain?.businessId ?? null;
    if (!businessId) {
      const tokenScope = tokenMembershipClaims.find((m) => m?.businessId);
      if (tokenScope?.businessId) businessId = String(tokenScope.businessId);
    }
    if (!businessId && localMemberships.length === 1) {
      businessId = localMemberships[0].businessId;
    }
    if (!businessId && localMemberships.length > 1) {
      const elevated = localMemberships.find((m: any) => String(m.role).toUpperCase() !== 'USER');
      businessId = elevated?.businessId ?? localMemberships[0].businessId;
    }

    const inScopeMembership = businessId
      ? localMemberships.find((m: any) => m.businessId === businessId)
      : domain?.brandId
        ? localMemberships.find((m: any) => (m.brandId ?? null) === domain.brandId)
        : null;

    const validStamps = (() => {
      const s = (inScopeMembership as any)?.validStamps ?? (inScopeMembership as any)?.stamps;
      if (typeof s === 'number') return s;
      if (s == null) return 0;
      const n = Number(s);
      return Number.isNaN(n) ? 0 : n;
    })();

    const membershipValidCoupons = (() => {
      const c = (inScopeMembership as any)?.validCoupons;
      if (typeof c === 'number') return c;
      if (c == null) return 0;
      const n = Number(c);
      return Number.isNaN(n) ? 0 : n;
    })();

    const membershipTotalCoupons = (() => {
      const total = (inScopeMembership as any)?.totalCoupons;
      if (typeof total === 'number') return total;
      if (total == null) return 0;
      const n = Number(total);
      return Number.isNaN(n) ? 0 : n;
    })();

    // /me intentionally does NOT fan out to chepizza for coupons or prize
    // progression. The customer app fetches both directly (CORS-allowed; see
    // customer.tsx couponsQuery + progressionQuery). Keeping /me as a pure
    // local-DB read eliminates the cascade-failure class we hit during the
    // Phase 2.7 cutover, and lets /me return in <10ms regardless of
    // chepizza/domain-mapper health.
    const validCoupons = membershipValidCoupons;
    const couponsList: any[] = [];
    const nextPrize: {
      name: string | null;
      stampsNeededForNextPrize: number;
      stampsNextPrize: number;
      stampsLastPrize: number;
    } | null = null;

    const effectiveTotalCoupons = Math.max(membershipTotalCoupons, validCoupons);
    const usedCoupons = Math.max(0, effectiveTotalCoupons - validCoupons);

    return {
      statusCode: 200,
      body: {
        id: user.id,
        email: user.email,
        name: user.name,
        surname: user.surname,
        userAgreement: {
          privacyPolicy: !!user.userPrivacyPolicyAcceptance,
          termsOfService: !!user.userTermsAcceptance,
          marketingPolicy: false,
        },
        memberships: localMemberships.map((m: any) => ({
          brandId: m.brandId,
          businessId: m.businessId,
          role: m.role,
        })),
        stamps: { validStamps },
        coupons: {
          usedCoupons,
          validCoupons,
          coupons: couponsList.map((c: any) => ({
            id: c.id,
            code: c.code,
            isRedeemed: !!c.isRedeemed,
            redeemedAt: c.redeemedAt ?? null,
            prize: c.prize ? { name: c.prize.name, pointsRequired: c.prize.pointsRequired } : undefined,
            createdAt: c.createdAt,
          })),
        },
        nextPrize,
      },
    };
  } catch (error: any) {
    request.log.error({ err: error }, 'GET_ME_FAILED');
    return { statusCode: 500, body: { error: 'GET_ME_FAILED' } };
  }
}
