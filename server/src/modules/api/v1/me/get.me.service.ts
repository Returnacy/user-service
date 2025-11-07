import type { FastifyRequest } from 'fastify';
import axios from 'axios';

import type { ServiceResponse } from '@/types/serviceResponse.js';
import { resolveBusinessServiceUrl, resolveDomain, fetchBusinessServiceUrl } from '@/utils/domainMapping.js';
import { buildMembershipAttribute, parseTokenMemberships } from '@/utils/memberships.js';
import type { Membership } from '@/utils/memberships.js';

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
    const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };
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
    const forwardedProto = (request.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();
    const inferredScheme = forwardedProto || request.protocol;

    let tokenMembershipClaims = parseTokenMemberships((auth as any).memberships);
    let memberships = await repository.listMemberships(user.id);

    if (domain) {
      const targetBusinessId = domain.businessId ?? null;
      const targetBrandId = domain.brandId ?? null;
      const hasMembership = targetBusinessId
        ? memberships.some((m: any) => m.businessId === targetBusinessId)
        : targetBrandId
          ? memberships.some((m: any) => (m.brandId ?? null) === targetBrandId)
          : false;
      if (!hasMembership && (targetBusinessId || targetBrandId)) {
        await repository.upsertMembership(user.id, { businessId: targetBusinessId, brandId: targetBrandId, role: 'USER' });
        memberships = await repository.listMemberships(user.id);

        const alreadyScoped = tokenMembershipClaims.some((m) => (
          targetBusinessId
            ? (m?.businessId ?? '') === targetBusinessId
            : targetBrandId
              ? (m?.brandId ?? '') === targetBrandId
              : false
        ));
        if (!alreadyScoped) {
          tokenMembershipClaims = [...tokenMembershipClaims, { brandId: targetBrandId ?? null, businessId: targetBusinessId, roles: ['user'] }];
        }

        const attributeMemberships: Membership[] = tokenMembershipClaims
          .map((m) => {
            const business = m?.businessId ? String(m.businessId) : null;
            const brand = m?.brandId ?? null;
            if (!business && !brand) return null;
            const rolesSource = Array.isArray(m?.roles) && m.roles.length
              ? m.roles
              : (m?.role ? [String(m.role)] : ['user']);
            return {
              brandId: brand,
              businessId: business,
              roles: rolesSource.map((r) => String(r).toLowerCase()),
            } as Membership;
          })
          .filter((m): m is Membership => m !== null);

        if (attributeMemberships.length) {
          const attribute = buildMembershipAttribute(attributeMemberships);
          const adminToken = await tokenService.getAccessToken();
          const baseUrl = process.env.KEYCLOAK_BASE_URL!;
          const realm = process.env.KEYCLOAK_REALM!;
          await axios.put(
            `${baseUrl}/admin/realms/${realm}/users/${sub}`,
            { attributes: { memberships: attribute } },
            { headers: { Authorization: `Bearer ${adminToken}` } }
          );
        }
      }

      try {
        const match = targetBusinessId
          ? tokenMembershipClaims.find((m) => (m?.businessId ?? '') === targetBusinessId)
          : targetBrandId
            ? tokenMembershipClaims.find((m) => (m?.brandId ?? '') === targetBrandId)
            : null;
        if (match) {
          const effective = deriveRoleFromMembership(match);
          const asDbRole = String(effective || 'user').toUpperCase();
          await repository.upsertMembership(user.id, { businessId: targetBusinessId, brandId: targetBrandId, role: asDbRole });
          memberships = await repository.listMemberships(user.id);
        }
      } catch {
        // ignore token parsing problems
      }
    }

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

    const businessServiceBase = businessId
      ? await resolveBusinessServiceUrl({ businessId, host: host ?? null, scheme: inferredScheme, resolvedDomain: domain })
      : null;

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

    let validCoupons = membershipValidCoupons;
    let couponsList: any[] = [];
    let nextPrize: {
      name: string | null;
      stampsNeededForNextPrize: number;
      stampsNextPrize: number;
      stampsLastPrize: number;
    } | null = null;

    if (businessId) {
      const normalizeBase = (value?: string | null) => {
        if (!value) return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed.replace(/\/+$/u, '');
      };

      const headers: Record<string, string> = {};
      try {
        const svcToken = await tokenService.getAccessToken();
        if (svcToken) headers.Authorization = `Bearer ${svcToken}`;
      } catch {
        // continue without auth header
      }

      let resolvedBusinessBase = normalizeBase(businessServiceBase)
        || normalizeBase(process.env.BUSINESS_SERVICE_INTERNAL_URL)
        || normalizeBase(process.env.BUSINESS_SERVICE_URL);

      if (!resolvedBusinessBase) {
        try {
          const fetched = await fetchBusinessServiceUrl(businessId, inferredScheme);
          resolvedBusinessBase = normalizeBase(fetched);
        } catch (err) {
          request.log.debug({ err }, 'BUSINESS_SERVICE_URL_DISCOVERY_FAILED');
        }
      }

      if (resolvedBusinessBase) {
        try {
          const res = await axios.get(`${resolvedBusinessBase}/api/v1/coupons`, {
            params: { userId: user.id, businessId },
            headers,
          });
          const payload = (res.data && res.data.coupons != null) ? res.data.coupons : res.data;
          const coupons = Array.isArray(payload) ? payload : [];
          const now = Date.now();
          couponsList = coupons.filter((c: any) => !c?.isRedeemed && (!c?.expiredAt || new Date(c.expiredAt).getTime() > now));
          if (couponsList.length > validCoupons) {
            validCoupons = couponsList.length;
          }
        } catch (err) {
          couponsList = [];
          request.log.warn({ err, base: resolvedBusinessBase }, 'BUSINESS_SERVICE_COUPONS_FETCH_FAILED');
        }

        try {
          const res = await axios.post(`${resolvedBusinessBase}/api/v1/prizes/progression`, {
            businessId,
            stamps: Math.max(0, Number(validStamps) || 0),
          }, { headers });
          const data = (res.data && res.data.data != null) ? res.data.data : res.data;
          if (data && typeof data === 'object') {
            const stampsLastPrize = Number((data as any).stampsLastPrize ?? 0) || 0;
            const stampsNextPrize = Number((data as any).stampsNextPrize ?? 0) || 0;
            const needed = Number((data as any).stampsNeededForNextPrize);
            const fallbackNeeded = Math.max(0, stampsNextPrize - Math.max(0, Number(validStamps) || 0));
            nextPrize = {
              name: (data as any).nextPrizeName ?? null,
              stampsLastPrize,
              stampsNextPrize,
              stampsNeededForNextPrize: Number.isFinite(needed) ? Math.max(0, needed) : fallbackNeeded,
            };
          }
        } catch (err) {
          request.log.warn({ err, base: resolvedBusinessBase }, 'BUSINESS_SERVICE_PRIZE_PROGRESSION_FAILED');
          nextPrize = null;
        }
      }
    }

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
