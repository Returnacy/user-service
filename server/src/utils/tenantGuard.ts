import type { FastifyReply, FastifyRequest } from 'fastify';

import { fetchDomainBusinesses, resolveDomainFromRequest } from './domainMapping.js';

/**
 * Tenant-scoped authorization for user-service.
 *
 * Before this module every guard in the service answered "is the caller a
 * service?" or "does the caller hold role X *somewhere*?" — never "does the
 * caller belong to the tenant that owns this resource?". With one shared
 * identity plane and one shared service secret across all brands, that made
 * every internal endpoint a cross-tenant read/write.
 *
 * Two identities can pass a tenant check here:
 *   - a SERVICE caller, whose brand comes from its credential (never from the
 *     request body — see internal/v1/auth/auth.route.ts);
 *   - a PLATFORM ADMIN, an explicit allow-list of keycloakSubs in
 *     PLATFORM_ADMIN_SUBS. There is no platform-wide role in the schema
 *     (UserRole is per-membership), so this is the only cross-brand identity.
 */

const DEFAULT_SERVICE_CLIENT_IDS = 'campaign-service,messaging-service,user-service,business-service,domain-mapper-service';

export type ServiceIdentity = {
  clientId: string;
  /** Tenant the credential is bound to; null for a legacy tenant-blind client. */
  brandId: string | null;
  legacy: boolean;
};

export type TenantDenial = { statusCode: number; body: { error: string; message?: string } };

/**
 * Service client ids are matched on the segment before ':' as well as in full,
 * so per-tenant ids ("business-service:chepizza") are recognised without having
 * to restate every tenant in KEYCLOAK_SERVICE_AUDIENCE.
 */
function allowedServiceIds(): Set<string> {
  const raw = process.env.KEYCLOAK_SERVICE_AUDIENCE || DEFAULT_SERVICE_CLIENT_IDS;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function matchesAllowedService(candidate: string, allowed: Set<string>): boolean {
  if (allowed.has(candidate)) return true;
  const base = candidate.split(':')[0] ?? '';
  return base.length > 0 && allowed.has(base);
}

function requireTenantScopedServiceTokens(): boolean {
  const flag = String(process.env.REQUIRE_TENANT_SERVICE_TOKENS ?? '').toLowerCase().trim();
  return flag === 'true' || flag === '1' || flag === 'yes';
}

/**
 * Identify a service caller from the verified token payload. Returns null for
 * user tokens (and for anything unauthenticated).
 */
export function getServiceIdentity(request: FastifyRequest): ServiceIdentity | null {
  const auth = (request as any).auth as any;
  if (!auth) return null;

  const allowed = allowedServiceIds();
  const azp = typeof auth.azp === 'string' ? auth.azp : null;
  const audClaim = auth.aud;
  const audList: string[] = Array.isArray(audClaim)
    ? audClaim.map(String)
    : typeof audClaim === 'string'
      ? [audClaim]
      : [];

  let clientId: string | null = null;
  if (azp && matchesAllowedService(azp, allowed)) {
    clientId = azp;
  } else {
    clientId = audList.find((aud) => matchesAllowedService(aud, allowed)) ?? null;
  }
  if (!clientId) return null;

  const brandId = typeof auth.brandId === 'string' && auth.brandId.length > 0 ? auth.brandId : null;
  return { clientId, brandId, legacy: brandId === null };
}

export function isServiceRequest(request: FastifyRequest): boolean {
  return getServiceIdentity(request) !== null;
}

/**
 * Platform-wide operator identity. Deliberately an env allow-list of
 * keycloakSubs rather than a role: adding a schema-level super-admin would mean
 * a migration on a live DB, and a role assignable through the team API would be
 * a new escalation target.
 */
export function isPlatformAdmin(request: FastifyRequest): boolean {
  const auth = (request as any).auth as any;
  const sub = typeof auth?.sub === 'string' ? auth.sub : '';
  if (!sub) return false;
  const raw = process.env.PLATFORM_ADMIN_SUBS || '';
  const subs = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return subs.includes(sub);
}

/**
 * Resolve which brand a location belongs to.
 *
 * Order matters: the memberships table is authoritative (every write path
 * stores brandId next to businessId, including locations absent from
 * domain-mapping.json such as Che Pizza's Lissaro), and domain-mapper only
 * covers the freshly-provisioned case of a location with no members yet.
 */
export async function resolveBrandForBusiness(
  request: FastifyRequest,
  businessId: string,
): Promise<string | null> {
  if (!businessId) return null;
  const repository = (request.server as any).repository as any;
  if (typeof repository?.findBrandIdByBusinessId === 'function') {
    try {
      const fromDb = await repository.findBrandIdByBusinessId(businessId);
      if (fromDb) return fromDb;
    } catch {
      // fall through to the mapper
    }
  }
  try {
    const entries = await fetchDomainBusinesses();
    const match = entries.find((entry) => entry.businessId === businessId && entry.brandId);
    return match?.brandId ?? null;
  } catch {
    return null;
  }
}

/**
 * Gate an internal (service-to-service) endpoint on the tenant of the resource.
 *
 * `targetBrandId === null` means the caller did not scope its request to any
 * brand, which for these endpoints is itself a refusal: an unscoped internal
 * query is exactly the cross-tenant dump we are closing.
 */
export function requireServiceForTenant(
  request: FastifyRequest,
  targetBrandId: string | null,
): { ok: true; identity: ServiceIdentity } | { ok: false; response: TenantDenial } {
  const identity = getServiceIdentity(request);
  if (!identity) {
    return { ok: false, response: { statusCode: 403, body: { error: 'FORBIDDEN' } } };
  }

  if (identity.legacy) {
    if (requireTenantScopedServiceTokens()) {
      request.log?.warn(
        { clientId: identity.clientId, targetBrandId },
        '[tenant] rejected tenant-blind service token (REQUIRE_TENANT_SERVICE_TOKENS=true)',
      );
      return {
        ok: false,
        response: { statusCode: 403, body: { error: 'TENANT_BLIND_SERVICE_TOKEN' } },
      };
    }
    // Rotation window: the legacy credential still works, but every use is
    // logged so the cutover can be verified from traffic instead of hope.
    request.log?.warn(
      { clientId: identity.clientId, targetBrandId, path: request.url },
      '[tenant] tenant-blind service token accepted during rotation window',
    );
    return { ok: true, identity };
  }

  if (!targetBrandId) {
    request.log?.warn(
      { clientId: identity.clientId, path: request.url },
      '[tenant] refused unscoped internal request from a tenant-scoped caller',
    );
    return { ok: false, response: { statusCode: 400, body: { error: 'TENANT_SCOPE_REQUIRED' } } };
  }

  if (identity.brandId !== targetBrandId) {
    request.log?.warn(
      { clientId: identity.clientId, callerBrandId: identity.brandId, targetBrandId, path: request.url },
      '[tenant] cross-tenant service call refused',
    );
    return { ok: false, response: { statusCode: 403, body: { error: 'CROSS_TENANT_FORBIDDEN' } } };
  }

  return { ok: true, identity };
}

// ---------------------------------------------------------------------------
// User-facing (browser) tenant context
// ---------------------------------------------------------------------------

/**
 * The brand a browser request is acting on, taken from the request's host via
 * domain-mapper. The host is attacker-controllable, which is fine and in fact
 * intended: it only *selects* a tenant, it never grants anything — the caller
 * still has to hold a membership on whatever brand it selects.
 */
export async function resolveRequestBrandId(request: FastifyRequest): Promise<string | null> {
  const domain = await resolveDomainFromRequest(request.headers as any);
  return domain?.brandId ?? null;
}

export type BrandCaller = {
  brandId: string;
  userId: string;
  role: string;
};

/**
 * Roles that count as "works here", ordered loosely by power. USER is
 * deliberately absent: a customer is not staff of the brand.
 */
export const BRAND_STAFF_ROLES: ReadonlySet<string> = new Set(['STAFF', 'MANAGER', 'BRAND_MANAGER', 'ADMIN']);

/**
 * preHandler factory: the caller must hold one of `roles` on the brand resolved
 * from the request host. Service callers bound to that same brand pass too
 * (they act on behalf of the tenant), as does a platform admin.
 *
 * On success `request.brandCaller` carries the resolved context so handlers
 * don't repeat the lookup.
 */
export function requireBrandRole(roles: ReadonlySet<string> = BRAND_STAFF_ROLES) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as any).auth as any;

    const brandId = await resolveRequestBrandId(request);

    // A service caller acts for its own tenant; the host need not resolve.
    const identity = getServiceIdentity(request);
    if (identity) {
      const gate = requireServiceForTenant(request, identity.brandId ?? brandId);
      if (!gate.ok) return reply.status(gate.response.statusCode).send(gate.response.body);
      if (identity.brandId || brandId) {
        (request as any).brandCaller = {
          brandId: (identity.brandId ?? brandId) as string,
          userId: '',
          role: 'SERVICE',
        } satisfies BrandCaller;
      }
      return;
    }

    if (!auth?.sub) {
      return reply.status(401).send({ error: 'UNAUTHENTICATED' });
    }

    if (isPlatformAdmin(request)) {
      if (brandId) {
        (request as any).brandCaller = { brandId, userId: '', role: 'PLATFORM_ADMIN' } satisfies BrandCaller;
      }
      return;
    }

    if (!brandId) {
      return reply.status(400).send({ error: 'BRAND_NOT_RESOLVED' });
    }

    const repository = (request.server as any).repository as any;
    const caller = await repository.findUserByKeycloakSub(auth.sub);
    if (!caller) {
      return reply.status(403).send({ error: 'FORBIDDEN' });
    }

    const membership = await repository.getMembershipByBrand(caller.id, brandId);
    const role = membership?.role ? String(membership.role).toUpperCase() : null;
    if (!role || !roles.has(role)) {
      request.log?.info(
        { brandId, callerUserId: caller.id, role, path: request.url },
        '[tenant] brand role check failed',
      );
      return reply.status(403).send({ error: 'FORBIDDEN' });
    }

    (request as any).brandCaller = { brandId, userId: caller.id, role } satisfies BrandCaller;
  };
}

export function getBrandCaller(request: FastifyRequest): BrandCaller | null {
  return ((request as any).brandCaller as BrandCaller | undefined) ?? null;
}
