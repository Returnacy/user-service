import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type DomainMapping = Record<string, { brandId: string | null; businessId: string }>;

let cache: DomainMapping | null = null;

export function loadDomainMapping(): DomainMapping {
  if (cache) return cache;
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // Try multiple fallback locations to survive different build layouts
  const candidates: string[] = [];
  if (process.env.DOMAIN_MAPPING_FILE) candidates.push(process.env.DOMAIN_MAPPING_FILE);
  // dist/src/utils -> dist/domain-mapping.json
  candidates.push(path.resolve(__dirname, '../domain-mapping.json'));
  // dist/src/utils -> server root copy
  candidates.push(path.resolve(__dirname, '../../domain-mapping.json'));
  // common absolute path inside container image
  candidates.push('/app/server/domain-mapping.json');
  const filePath = candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!filePath) return {} as DomainMapping;
  const raw = fs.readFileSync(filePath, 'utf-8');
  cache = JSON.parse(raw);
  return cache!;
}

export function resolveDomain(host?: string): { brandId: string | null; businessId: string } | null {
  if (!host) return null;
  const map = loadDomainMapping();
  const hostname = host.toLowerCase().split(':')[0];
  return map[hostname] ?? null;
}
