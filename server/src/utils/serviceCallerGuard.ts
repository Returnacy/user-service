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
 * Detects service-to-service callers (self-issued or Keycloak service-account).
 * For self-issued tokens, sub === client_id. For Keycloak service-accounts, sub
 * is a UUID but azp === client_id. Either match means this is not an end-user.
 */
export function isServiceCaller(auth: { sub?: unknown; azp?: unknown } | null | undefined): boolean {
  if (!auth) return false;
  const clients = getInternalServiceClients();
  const knownIds: ReadonlySet<string> = clients
    ? new Set(Object.keys(clients))
    : FALLBACK_SERVICE_CLIENT_IDS;
  const sub = typeof auth.sub === 'string' ? auth.sub : '';
  const azp = typeof auth.azp === 'string' ? auth.azp : '';
  return (sub.length > 0 && knownIds.has(sub)) || (azp.length > 0 && knownIds.has(azp));
}
