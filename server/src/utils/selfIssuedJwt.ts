import { importSPKI, exportJWK, type JWK } from 'jose';

export type SelfIssuedConfig = {
  privateKeyPem: string;
  publicKeyPem: string;
  kid: string;
  issuer: string;
  alg: 'RS256';
};

let cachedJwks: { keys: JWK[] } | null = null;

export function isSelfIssuedConfigured(): boolean {
  return Boolean(
    process.env.JWT_PRIVATE_KEY &&
      process.env.JWT_PUBLIC_KEY &&
      process.env.JWT_KID &&
      process.env.JWT_ISSUER,
  );
}

export function getSelfIssuedConfig(): SelfIssuedConfig | null {
  if (!isSelfIssuedConfigured()) return null;
  return {
    privateKeyPem: process.env.JWT_PRIVATE_KEY as string,
    publicKeyPem: process.env.JWT_PUBLIC_KEY as string,
    kid: process.env.JWT_KID as string,
    issuer: process.env.JWT_ISSUER as string,
    alg: 'RS256',
  };
}

export async function getJwks(): Promise<{ keys: JWK[] }> {
  if (cachedJwks) return cachedJwks;
  const config = getSelfIssuedConfig();
  if (!config) return { keys: [] };
  const publicKey = await importSPKI(config.publicKeyPem, config.alg, { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = config.kid;
  jwk.use = 'sig';
  jwk.alg = config.alg;
  cachedJwks = { keys: [jwk] };
  return cachedJwks;
}
