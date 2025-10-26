import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import { resolveDomain, resolveBusinessServiceUrl } from '../../utils/domainMapping.js';
import { parseTokenMemberships } from '../../utils/memberships.js';

export async function getUserByIdHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = (request as any).auth as any;
  if (!auth?.sub) return reply.status(401).send({ error: 'UNAUTHENTICATED' });

  const { userId } = (request.params ?? {}) as { userId?: string | number };
  if (!userId) return reply.status(400).send({ error: 'INVALID_USER_ID' });

  const repository = (request.server as any).repository as any;
  const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };

  const user = await repository.findUserById(String(userId));
  if (!user) return reply.status(404).send({ error: 'NOT_FOUND' });

  const memberships = await repository.listMemberships(user.id);

  const host = (request.headers['x-forwarded-host'] as string) || (request.headers['host'] as string);
  const domain = resolveDomain(host);
  const forwardedProto = (request.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim();
  const tokenMembershipClaims = parseTokenMemberships((auth as any).memberships);

  let businessId: string | null = domain?.businessId ?? null;
  if (!businessId) {
    const tokenScope = tokenMembershipClaims.find(m => m?.businessId);
    if (tokenScope?.businessId) businessId = String(tokenScope.businessId);
  }
  if (!businessId && memberships.length === 1) {
    businessId = memberships[0].businessId;
  }
  if (!businessId && memberships.length > 1) {
    const elevated = memberships.find((m: any) => String(m.role).toUpperCase() !== 'USER');
    businessId = elevated?.businessId ?? memberships[0].businessId;
  }

  const businessServiceBase = businessId
    ? resolveBusinessServiceUrl({ businessId, host, scheme: forwardedProto || request.protocol })
    : null;

  const inScopeMembership = businessId
    ? memberships.find((m: any) => m.businessId === businessId)
    : null;

  const validStamps = (() => {
    const raw = (inScopeMembership as any)?.validStamps ?? (inScopeMembership as any)?.stamps;
    if (typeof raw === 'number') return raw;
    if (raw == null) return 0;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  })();

  const membershipValidCoupons = (() => {
    const raw = (inScopeMembership as any)?.validCoupons;
    if (typeof raw === 'number') return raw;
    if (raw == null) return 0;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  })();

  const membershipTotalCoupons = (() => {
    const raw = (inScopeMembership as any)?.totalCoupons;
    if (typeof raw === 'number') return raw;
    if (raw == null) return 0;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
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
      // continue without Authorization header if service token is unavailable
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
    phone: user.phone,
    memberships: memberships.map((m: any) => ({ businessId: m.businessId, brandId: m.brandId, role: m.role })),
    scope: { businessId },
    role: inScopeMembership?.role ?? 'USER',
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
    userAgreement: {
      privacyPolicy: !!user.userPrivacyPolicyAcceptance,
      termsOfService: !!user.userTermsAcceptance,
      marketingPolicy: false,
    },
  });
}
