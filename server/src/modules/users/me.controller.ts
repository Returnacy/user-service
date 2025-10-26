import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import { resolveDomain, resolveBusinessServiceUrl } from '../../utils/domainMapping.js';
import { buildMembershipAttribute, parseTokenMemberships } from '../../utils/memberships.js';
import type { Membership } from '../../utils/memberships.js';

export async function getMeHandler(request: FastifyRequest, reply: FastifyReply) {
    const auth = (request as any).auth as any;
    if (!auth?.sub) return reply.status(401).send({ error: 'UNAUTHENTICATED' });

    const repository = (request.server as any).repository as any;
    const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };
    const sub = auth.sub as string;

    const existing = await repository.findUserByKeycloakSub(sub);
    if (!existing) {
      await repository.upsertUserByKeycloakSub(sub, { email: auth.email || '' });
    }
    const user = await repository.findUserByKeycloakSub(sub);

    const host = (request.headers['x-forwarded-host'] as string) || (request.headers['host'] as string);
    const domain = resolveDomain(host);
    const forwardedProto = (request.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();

    let tokenMembershipClaims = parseTokenMemberships((auth as any).memberships);
    let memberships = await repository.listMemberships(user.id);

    if (domain) {
      const hasMembership = memberships.some((m: any) => m.businessId === domain.businessId);
      if (!hasMembership) {
        await repository.addMembership(user.id, { businessId: domain.businessId, brandId: domain.brandId, role: 'USER' });
        memberships = await repository.listMemberships(user.id);

        if (!tokenMembershipClaims.some(m => (m?.businessId ?? '') === domain.businessId)) {
          tokenMembershipClaims = [...tokenMembershipClaims, { brandId: domain.brandId ?? null, businessId: domain.businessId, roles: ['user'] }];
        }

        const attributeMemberships: Membership[] = tokenMembershipClaims
          .map(m => {
            const business = m?.businessId ? String(m.businessId) : '';
            if (!business) return null;
            const rolesSource = Array.isArray(m?.roles) && m.roles.length
              ? m.roles
              : (m?.role ? [String(m.role)] : ['user']);
            return {
              brandId: m?.brandId ?? null,
              businessId: business,
              roles: rolesSource.map(r => String(r).toLowerCase()),
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
        const match = tokenMembershipClaims.find(m => (m?.businessId ?? '') === domain.businessId);
        if (match) {
          const rolesArr = Array.isArray(match.roles) ? match.roles.map(r => String(r).toLowerCase()) : [];
          const single = match.role ? String(match.role).toLowerCase() : undefined;
          const effective = single
            || (rolesArr.includes('admin') ? 'admin'
              : rolesArr.includes('manager') ? 'manager'
              : rolesArr.includes('staff') ? 'staff'
              : 'user');
          const asDbRole = String(effective || 'user').toUpperCase();
          await repository.upsertMembership(user.id, { businessId: domain.businessId, brandId: domain.brandId, role: asDbRole });
          memberships = await repository.listMemberships(user.id);
        }
      } catch {
        // ignore token parsing problems
      }
    }

    const localMemberships = memberships;

    let businessId: string | null = domain?.businessId ?? null;
    if (!businessId) {
      const tokenScope = tokenMembershipClaims.find(m => m?.businessId);
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
      ? resolveBusinessServiceUrl({ businessId, host, scheme: forwardedProto || request.protocol })
      : null;

    const inScopeMembership = businessId
      ? localMemberships.find((m: any) => m.businessId === businessId)
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
    let nextPrize: { name: string | null; stampsNeededForNextPrize: number; stampsNextPrize: number; stampsLastPrize: number } | null = null;

    if (businessId && businessServiceBase) {
      const base = businessServiceBase.replace(/\/$/, '');
      const headers: Record<string, string> = {};
      try {
        const svcToken = await tokenService.getAccessToken();
        if (svcToken) headers.Authorization = `Bearer ${svcToken}`;
      } catch {
        // continue without auth header
      }

      try {
        const res = await axios.get(`${base}/api/v1/coupons`, {
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
      } catch {
        couponsList = [];
      }

      try {
        const res = await axios.post(`${base}/api/v1/prizes/progression`, {
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
      } catch {
        nextPrize = null;
      }
    }

    const effectiveTotalCoupons = Math.max(membershipTotalCoupons, validCoupons);
    const usedCoupons = Math.max(0, effectiveTotalCoupons - validCoupons);

    return reply.send({
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
    });
  }
