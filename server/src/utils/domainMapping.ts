import axios, { type AxiosRequestConfig } from 'axios';
import { TokenService } from '../classes/tokenService.js';
export type DomainResolution = {
  brandId: string | null;
  businessId: string | null;
  host: string | null;
  service: string | null;
  label: string | null;
  url: string | null;
};

export type DomainMapperBusinessEntry = {
  label: string | null;
  brandId: string | null;
  businessId: string | null;
  services: Record<string, string>;
};

const DEFAULT_CACHE_MS = Number(process.env.DOMAIN_MAPPER_CACHE_MS || 60_000);

const hostCache = new Map<string, { expiresAt: number; value: DomainResolution | null }>();
const businessUrlCache = new Map<string, { expiresAt: number; value: string | null }>();
let businessesCache: { expiresAt: number; value: DomainMapperBusinessEntry[] } | null = null;

function normalizeHostKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const segment = withoutScheme.split('/')[0] ?? withoutScheme;
  return segment.trim().toLowerCase();
}

function normalizeScheme(scheme?: string | null): string {
  const fallback = process.env.BUSINESS_SERVICE_URL_SCHEME || 'https';
  if (!scheme) return fallback;
  const trimmed = scheme.trim().toLowerCase();
  if (!trimmed) return fallback;
  const isValid = /^[a-z][a-z0-9+.-]*$/.test(trimmed);
  return isValid ? trimmed : fallback;
}

function deriveUrlFromHost(hostOrUrl: string, scheme?: string | null): string {
  const trimmed = hostOrUrl.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/u, '');
  const normalizedScheme = normalizeScheme(scheme);
  const sanitized = trimmed.replace(/^\/+/, '').replace(/\/+$/u, '');
  return `${normalizedScheme}://${sanitized}`;
}

async function getServiceHeaders(): Promise<Record<string, string>> {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL
    || ((process.env.KEYCLOAK_BASE_URL && process.env.KEYCLOAK_REALM)
      ? `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`
      : '');
  const clientId = process.env.KEYCLOAK_CLIENT_ID || '';
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET || '';
  if (!tokenUrl || !clientId || !clientSecret) return {};
  try {
    const ts = new TokenService({ tokenUrl, clientId, clientSecret });
    const token = await ts.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function ensureMapperUrl(): string {
  const url = process.env.DOMAIN_MAPPER_URL;
  if (!url) throw new Error('DOMAIN_MAPPER_URL is not configured');
  return url.replace(/\/+$/, '');
}
async function mapperGet<T = any>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
  const base = ensureMapperUrl();
  const headers = await getServiceHeaders();
  const mergedHeaders = { ...(config.headers ?? {}), ...headers };
  const response = await axios.get<T>(`${base}${path}`, { ...config, headers: mergedHeaders });
  return response.data;
}

export async function fetchDomainInfoByHost(host: string): Promise<DomainResolution | null> {
  const normalized = normalizeHostKey(host);
  if (!normalized) return null;
  const cached = hostCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const data = await mapperGet<any>(`/api/v1/resolve`, { params: { host } });
  const result: DomainResolution | null = data && typeof data === 'object'
    ? {
        brandId: data.brandId ?? null,
        businessId: data.businessId ?? null,
        host: data.host ?? normalized,
        service: data.service ?? null,
        label: data.label ?? null,
        url: data.url ?? null,
      }
    : null;
  hostCache.set(normalized, { expiresAt: Date.now() + DEFAULT_CACHE_MS, value: result });
  return result;
}

export async function resolveDomain(host?: string | null): Promise<DomainResolution | null> {
  if (!host) return null;
  const normalized = host.trim();
  if (!normalized) return null;
  try {
    return await fetchDomainInfoByHost(normalized);
  } catch {
    return null;
  }
}

export async function fetchDomainBusinesses(forceRefresh = false): Promise<DomainMapperBusinessEntry[]> {
  const now = Date.now();
  if (!forceRefresh && businessesCache && businessesCache.expiresAt > now) {
    return businessesCache.value;
  }
  try {
    const data = await mapperGet<any[]>(`/api/v1/businesses`);
    const entries: DomainMapperBusinessEntry[] = Array.isArray(data)
      ? data.map((item: any) => ({
          label: item?.label ?? null,
          brandId: item?.brandId ?? null,
          businessId: item?.businessId ?? null,
          services: typeof item?.services === 'object' && item?.services !== null ? item.services : {},
        }))
      : [];
    businessesCache = { expiresAt: now + DEFAULT_CACHE_MS, value: entries };
    return entries;
  } catch (err) {
    return businessesCache?.value ?? [];
  }
}

export async function fetchBusinessServiceUrl(businessId: string, scheme?: string | null): Promise<string | null> {
  if (!businessId) return null;
  const cached = businessUrlCache.get(businessId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const data = await mapperGet<any>(`/api/v1/business/${encodeURIComponent(businessId)}`);
    const raw = typeof data?.url === 'string' && data.url
      ? data.url
      : (typeof data?.host === 'string' ? data.host : null);
    const resolved = raw ? deriveUrlFromHost(raw, scheme) : null;
    businessUrlCache.set(businessId, { expiresAt: Date.now() + DEFAULT_CACHE_MS, value: resolved });
    return resolved;
  } catch (err) {
    businessUrlCache.set(businessId, { expiresAt: Date.now() + DEFAULT_CACHE_MS, value: null });
    return cached?.value ?? null;
  }
}

export async function resolveBusinessServiceUrl(options: {
  businessId?: string | null;
  host?: string | null;
  scheme?: string | null;
  resolvedDomain?: DomainResolution | null;
} = {}): Promise<string | null> {
  const scheme = normalizeScheme(options.scheme);
  const resolvedDomain = options.resolvedDomain ?? (options.host ? await resolveDomain(options.host) : null);
  if (resolvedDomain?.businessId && options.businessId && resolvedDomain.businessId !== options.businessId) {
    // prefer explicit businessId if mismatch
  } else if (resolvedDomain?.url || resolvedDomain?.host) {
    return deriveUrlFromHost(resolvedDomain.url || resolvedDomain.host || '', scheme) || null;
  }

  const targetBusinessId = options.businessId ?? resolvedDomain?.businessId ?? null;
  if (!targetBusinessId) return null;
  try {
    return await fetchBusinessServiceUrl(targetBusinessId, scheme);
  } catch {
    return null;
  }
}
