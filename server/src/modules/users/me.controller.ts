import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import { resolveDomain } from '../../utils/domainMapping.js';

export async function getMeHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = (request as any).auth as any;
  if (!auth?.sub) return reply.status(401).send({ error: 'UNAUTHENTICATED' });

  const repository = (request.server as any).repository as any;
  const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };
  const sub = auth.sub as string;

  // Load or create user locally
  const existing = await repository.findUserByKeycloakSub(sub);
  if (!existing) {
    await repository.upsertUserByKeycloakSub(sub, { email: auth.email || '' });
  }
  const user = await repository.findUserByKeycloakSub(sub);

  // Resolve business/brand from host
  const host = request.headers['x-forwarded-host'] as string || request.headers['host'] as string;
  const domain = resolveDomain(host);

  if (domain) {
    const memberships = await repository.listMemberships(user.id);
    const hasMembership = memberships.some((m: any) => m.businessId === domain.businessId);
    if (!hasMembership) {
      // Auto-enroll this user to the business for this domain with default 'user' role
  await repository.addMembership(user.id, { businessId: domain.businessId, brandId: domain.brandId, role: 'USER' });

      // Update Keycloak memberships attribute by merging existing memberships in token with new one
      // Normalize token memberships: Keycloak mappers may emit either an array of strings (JSON) or array of objects.
      const rawMemberships = Array.isArray((auth as any).memberships) ? (auth as any).memberships : [];
      const tokenMemberships: any[] = [];
      for (const item of rawMemberships) {
        if (typeof item === 'string') {
          try {
            const parsed = JSON.parse(item);
            // parsed could be object or array; if array, merge
            if (Array.isArray(parsed)) tokenMemberships.push(...parsed);
            else tokenMemberships.push(parsed);
          } catch (e) {
            // fallback: keep raw string to avoid losing data
            try { tokenMemberships.push(JSON.parse(item)); } catch (_) { /* ignore */ }
          }
        } else if (item && typeof item === 'object') {
          tokenMemberships.push(item);
        }
      }

      // Add the new membership object
      tokenMemberships.push({ brandId: domain.brandId ?? null, businessId: domain.businessId, roles: ['user'] });

      const attribute = [JSON.stringify(tokenMemberships)];

      const adminToken = await tokenService.getAccessToken();
      const baseUrl = process.env.KEYCLOAK_BASE_URL!;
      const realm = process.env.KEYCLOAK_REALM!;
      await axios.put(
        `${baseUrl}/admin/realms/${realm}/users/${sub}`,
        { attributes: { memberships: attribute } },
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
    }

    // Sync local membership role from token memberships for this tenant
    try {
      const rawMemberships = Array.isArray((auth as any).memberships) ? (auth as any).memberships : [];
      const parsed: Array<{ brandId?: string|null; businessId?: string|null; roles?: string[]; role?: string } > = [];
      for (const item of rawMemberships) {
        if (typeof item === 'string') {
          try {
            const val = JSON.parse(item);
            if (Array.isArray(val)) parsed.push(...val);
            else parsed.push(val);
          } catch {}
        } else if (item && typeof item === 'object') {
          parsed.push(item);
        }
      }
      const match = parsed.find(m => (m.businessId || '') === domain.businessId);
      if (match) {
        const rolesArr = Array.isArray(match.roles) ? match.roles.map(r => String(r).toLowerCase()) : [];
        const single = match.role ? String(match.role).toLowerCase() : undefined;
        const effective = single || (rolesArr.includes('admin') ? 'admin' : rolesArr.includes('manager') ? 'manager' : rolesArr.includes('staff') ? 'staff' : 'user');
        const asDbRole = String(effective || 'user').toUpperCase();
        await repository.upsertMembership(user.id, { businessId: domain.businessId, brandId: domain.brandId, role: asDbRole });
      }
    } catch {}
  }

  const localMemberships = await repository.listMemberships(user.id);

  // Determine in-scope business and derive counters from membership
  const businessId = (domain?.businessId ?? null) as string | null;
  const inScopeMembership = businessId
    ? localMemberships.find((m: any) => m.businessId === businessId)
    : null;

  const validStamps = (() => {
    const s = (inScopeMembership as any)?.validStamps ?? (inScopeMembership as any)?.stamps;
    if (typeof s === 'number') return s;
    if (s == null) return 0;
    const n = Number(s);
    return isNaN(n) ? 0 : n;
  })();

  const validCoupons = (() => {
    const c = (inScopeMembership as any)?.validCoupons;
    if (typeof c === 'number') return c;
    if (c == null) return 0;
    const n = Number(c);
    return isNaN(n) ? 0 : n;
  })();

  // Optionally fetch coupons list from business-service for this tenant
  let couponsList: any[] = [];
  if (businessId) {
    try {
      const svcToken = await tokenService.getAccessToken();
      const headers = svcToken ? { Authorization: `Bearer ${svcToken}` } : {};
      const base = process.env.BUSINESS_SERVICE_URL || 'http://business-server:3000';
      const res = await axios.get(`${base.replace(/\/$/, '')}/api/v1/coupons`, {
        params: { userId: user.id, businessId },
        headers,
      });
      const coupons = (res.data && res.data.coupons) ? res.data.coupons : [];
      // Only keep new (unredeemed and not expired) coupons for the /me page
      const now = Date.now();
      couponsList = Array.isArray(coupons)
        ? coupons.filter((c: any) => !c?.isRedeemed && (!c?.expiredAt || new Date(c.expiredAt).getTime() > now))
        : [];
    } catch (e) {
      // swallow errors to not block /me
      couponsList = [];
    }
  }

  return reply.send({
    id: user.id,
    email: user.email,
    name: user.name,
    surname: user.surname,
    userAgreement: {
      privacyPolicy: !!user.userPrivacyPolicyAcceptance,
      termsOfService: !!user.userTermsAcceptance,
      // marketing optional; treat as false unless you later persist/derive it
      marketingPolicy: false,
    },
    memberships: localMemberships.map((m: any) => ({
      brandId: m.brandId,
      businessId: m.businessId,
      role: m.role
    })),
    // Aggregated client fields expected by SPA
    stamps: { validStamps },
    coupons: { usedCoupons: 0, validCoupons, coupons: couponsList.map((c: any) => ({
      id: c.id,
      code: c.code,
      isRedeemed: !!c.isRedeemed,
      redeemedAt: c.redeemedAt ?? null,
      prize: c.prize ? { name: c.prize.name, pointsRequired: c.prize.pointsRequired } : undefined,
      createdAt: c.createdAt,
    })) },
    nextPrize: { name: 'Prossimo premio', stampsNeededForNextPrize: 15, stampsNextPrize: 15, stampsLastPrize: 0 },
  });
}
