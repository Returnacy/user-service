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
 */
export function isServiceCaller(auth: { sub?: unknown } | null | undefined): boolean {
  if (!auth) return false;
  const clients = getInternalServiceClients();
  const knownIds: ReadonlySet<string> = clients
    ? new Set(Object.keys(clients))
    : FALLBACK_SERVICE_CLIENT_IDS;
  const sub = typeof auth.sub === 'string' ? auth.sub : '';
  return sub.length > 0 && knownIds.has(sub);
}
