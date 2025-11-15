/**
 * Cookie Domain Detection Utility
 *
 * Automatically detects the appropriate cookie domain from the request hostname
 * to support SSO across multiple custom domains.
 *
 * Supported patterns:
 * - *.returnacy.app → .returnacy.app
 * - *.chepizzadasalva.it → .chepizzadasalva.it
 * - *.custompizza.com → .custompizza.com
 * - localhost/127.0.0.1 → undefined (no domain)
 *
 * Environment variables:
 * - COOKIE_DOMAIN_MAPPING: Optional JSON object for explicit domain mappings
 *   Example: {"special.domain.com": ".domain.com", "other.app": ".other.app"}
 */

import type { FastifyRequest } from 'fastify';

/**
 * Known top-level domains that should be preserved in cookie domain
 * These are multi-segment TLDs like .co.uk, .com.br, etc.
 */
const MULTI_SEGMENT_TLDS = new Set([
  'co.uk',
  'com.au',
  'com.br',
  'co.za',
  'co.in',
  'co.jp',
  'co.kr',
  'com.mx',
  'com.ar',
  'co.nz',
  // Add more as needed
]);

/**
 * Extract the parent domain for cookie sharing
 * Examples:
 * - pizzalonga.returnacy.app → .returnacy.app
 * - vicenza.pizzalonga.returnacy.app → .returnacy.app
 * - fidelity.chepizzadasalva.it → .chepizzadasalva.it
 * - padova.fidelity.chepizzadasalva.it → .chepizzadasalva.it
 * - app.custompizza.com → .custompizza.com
 */
function extractParentDomain(hostname: string): string | undefined {
  const parts = hostname.split('.');

  // For localhost or single-segment domains, return undefined
  if (parts.length <= 1) {
    return undefined;
  }

  // Check for multi-segment TLDs (e.g., .co.uk)
  // If we have example.co.uk, we want .example.co.uk
  if (parts.length >= 3) {
    const possibleMultiSegmentTld = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (MULTI_SEGMENT_TLDS.has(possibleMultiSegmentTld)) {
      // Need at least 4 segments for a multi-segment TLD (sub.domain.co.uk)
      if (parts.length >= 3) {
        // Return .domain.co.uk from sub.domain.co.uk
        return `.${parts.slice(-3).join('.')}`;
      }
      // For domain.co.uk, return .domain.co.uk
      return `.${hostname}`;
    }
  }

  // For standard TLDs (e.g., .com, .it, .app)
  // pizzalonga.returnacy.app → .returnacy.app
  // vicenza.pizzalonga.returnacy.app → .returnacy.app
  if (parts.length >= 3) {
    // Return the last 2 segments with leading dot
    return `.${parts.slice(-2).join('.')}`;
  }

  // For 2-segment domains (e.g., example.com), return with leading dot
  return `.${hostname}`;
}

/**
 * Load custom domain mappings from environment variable
 * Format: {"full.hostname.com": ".cookie.domain.com"}
 */
function loadCustomDomainMappings(): Map<string, string> {
  const mapping = new Map<string, string>();

  try {
    const envValue = process.env.COOKIE_DOMAIN_MAPPING;
    if (envValue) {
      const parsed = JSON.parse(envValue);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof key === 'string' && typeof value === 'string') {
            mapping.set(key.toLowerCase().trim(), value.trim());
          }
        }
      }
    }
  } catch (error) {
    // Invalid JSON or other error - log but don't crash
    console.error('Failed to parse COOKIE_DOMAIN_MAPPING environment variable:', error);
  }

  return mapping;
}

// Cache the custom mappings to avoid parsing on every request
let customDomainMappings: Map<string, string> | null = null;

/**
 * Get custom domain mappings (cached)
 */
function getCustomDomainMappings(): Map<string, string> {
  if (customDomainMappings === null) {
    customDomainMappings = loadCustomDomainMappings();
  }
  return customDomainMappings;
}

/**
 * Determine the appropriate cookie domain for the given hostname
 *
 * @param hostname - The request hostname (e.g., from request.hostname)
 * @returns The cookie domain (e.g., '.returnacy.app') or undefined for localhost
 */
export function getCookieDomain(hostname: string): string | undefined {
  // Normalize hostname
  const normalizedHostname = hostname.toLowerCase().trim();

  // Handle localhost and IP addresses
  if (
    normalizedHostname === 'localhost' ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname.startsWith('192.168.') ||
    normalizedHostname.startsWith('10.') ||
    normalizedHostname.startsWith('172.') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(normalizedHostname) // Any IP address
  ) {
    return undefined;
  }

  // Check custom mappings first (for edge cases)
  const customMappings = getCustomDomainMappings();
  if (customMappings.has(normalizedHostname)) {
    return customMappings.get(normalizedHostname);
  }

  // Extract parent domain
  return extractParentDomain(normalizedHostname);
}

/**
 * Get cookie domain from a Fastify request with logging
 *
 * @param request - Fastify request object
 * @returns The cookie domain or undefined for localhost
 */
export function getCookieDomainFromRequest(request: FastifyRequest): string | undefined {
  const hostname = request.hostname;
  const cookieDomain = getCookieDomain(hostname);

  // Log the decision for debugging
  request.server.log.info(
    {
      hostname,
      cookieDomain,
      hasCustomMapping: getCustomDomainMappings().has(hostname.toLowerCase().trim()),
    },
    'Cookie domain detected'
  );

  return cookieDomain;
}

/**
 * Validate and test the cookie domain detection logic
 * Useful for unit tests and debugging
 *
 * @internal
 */
export function testCookieDomain(hostname: string): {
  hostname: string;
  cookieDomain: string | undefined;
  reason: string;
} {
  const normalizedHostname = hostname.toLowerCase().trim();

  // Check if localhost/IP
  if (
    normalizedHostname === 'localhost' ||
    normalizedHostname === '127.0.0.1' ||
    /^\d+\.\d+\.\d+\.\d+$/.test(normalizedHostname)
  ) {
    return {
      hostname,
      cookieDomain: undefined,
      reason: 'localhost or IP address',
    };
  }

  // Check custom mapping
  const customMappings = getCustomDomainMappings();
  if (customMappings.has(normalizedHostname)) {
    return {
      hostname,
      cookieDomain: customMappings.get(normalizedHostname),
      reason: 'custom mapping from COOKIE_DOMAIN_MAPPING',
    };
  }

  // Extract parent domain
  const cookieDomain = extractParentDomain(normalizedHostname);
  return {
    hostname,
    cookieDomain,
    reason: 'extracted from hostname',
  };
}
