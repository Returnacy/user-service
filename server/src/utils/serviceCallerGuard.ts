import { getInternalServiceClients } from './selfIssuedJwt.js';

// Fallback used when INTERNAL_SERVICE_CLIENTS env var is missing or unparsable.
// Mirrors the keys deployed in Phase 2.7. Keep in sync with staging-notes.md.
const FALLBACK_SERVICE_CLIENT_IDS: ReadonlySet<string> = new Set([
  'campaign-service',
  'business-service',
  'messaging-service',
  'user-service',
  'domain-mapper-service',
]);

/**
 * Detects self-issued service-to-service callers. For self-issued tokens
 * minted via /internal/v1/auth/service-token, sub === client_id.
 *
 * We deliberately do NOT check `azp`: real user tokens minted by user-service
 * via Keycloak password grant carry azp=KEYCLOAK_CLIENT_ID (which equals
 * "user-service"), and our self-issued user tokens default azp to
 * "user-service" as well. Checking azp would reject every real customer.
 *
 * Legacy Keycloak service-account tokens (sub = service-account UUID, azp =
 * client_id) are not caught here. They predate Phase 2.7 and will be retired
 * when callers cut over to self-issued tokens.
 *
 * Per-tenant ids ("business-service:sudest") match on the segment before ':' as
 * well as in full — the same rule as tenantGuard's matchesAllowedService and
 * business-service's evaluateTenantAccess. Exact matching alone was a trap
 * waiting for the first client: the moment §8.1 mints a credential for a new
 * brand, that caller's sub is absent from FALLBACK_SERVICE_CLIENT_IDS, so any
 * request served while INTERNAL_SERVICE_CLIENTS is missing or unparsable would
 * read as a *user* — and /me would upsert a phantom User row keyed by the
 * client id, which is exactly what this guard exists to stop. It also keeps the
 * three services agreeing on what a service token looks like; a caller that
 * business-service treats as a service and user-service treats as a person is
 * how a check ends up guarding nothing.
 */
export function isServiceCaller(auth: { sub?: unknown } | null | undefined): boolean {
  if (!auth) return false;
  const clients = getInternalServiceClients();
  const knownIds: ReadonlySet<string> = clients
    ? new Set(Object.keys(clients))
    : FALLBACK_SERVICE_CLIENT_IDS;
  const sub = typeof auth.sub === 'string' ? auth.sub : '';
  if (sub.length === 0) return false;
  if (knownIds.has(sub)) return true;
  // A real user's sub is a UUID and carries no ':', so widening to the prefix
  // cannot swallow a person.
  const base = sub.split(':')[0] ?? '';
  return base.length > 0 && base !== sub && knownIds.has(base);
}
