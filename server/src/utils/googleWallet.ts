import { SignJWT, importPKCS8 } from 'jose';

type WalletConfig = {
  serviceAccountEmail: string;
  privateKey: string;
  classId: string;
  issuerId: string;
  defaultOrigins: string[];
  programName: string;
  issuerName: string;
  pointsLabel: string;
  backgroundColor?: string;
  heroImageUri?: string;
  logoUri?: string;
};

type LoyaltyPassParams = {
  userId: string;
  accountName: string;
  accountEmail?: string;
  businessId: string;
  qrValue: string;
  validStamps?: number;
  origins?: string[];
};

type LoyaltyPassResult = {
  jwt: string;
  saveUrl: string;
  objectId: string;
  classId: string;
  expiresAt: string;
};

let cachedPrivateKey: any = null;
let cachedPrivateKeySource: string | null = null;

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${name} is required to issue Google Wallet passes`);
}

function getWalletConfig(): WalletConfig {
  const classId = readEnv('GOOGLE_WALLET_LOYALTY_CLASS_ID');
  const issuerId = (() => {
    const dotIndex = classId.indexOf('.');
    if (dotIndex === -1) return readEnv('GOOGLE_WALLET_ISSUER_ID');
    return classId.slice(0, dotIndex);
  })();

  const allowedOriginsEnv = process.env.GOOGLE_WALLET_ALLOWED_ORIGINS;
  const defaultOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [];

  const config: WalletConfig = {
    serviceAccountEmail: readEnv('GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL'),
    privateKey: readEnv('GOOGLE_WALLET_PRIVATE_KEY'),
    classId,
    issuerId,
    defaultOrigins,
    programName: process.env.GOOGLE_WALLET_PROGRAM_NAME?.trim() || 'Returnacy Loyalty',
    issuerName: process.env.GOOGLE_WALLET_ISSUER_NAME?.trim() || 'Returnacy',
    pointsLabel: process.env.GOOGLE_WALLET_POINTS_LABEL?.trim() || 'Timbri',
  };

  const backgroundColor = process.env.GOOGLE_WALLET_BACKGROUND_COLOR?.trim();
  if (backgroundColor) config.backgroundColor = backgroundColor;

  const heroImageUri = process.env.GOOGLE_WALLET_HERO_IMAGE_URI?.trim();
  if (heroImageUri) config.heroImageUri = heroImageUri;

  const logoUri = process.env.GOOGLE_WALLET_LOGO_URI?.trim();
  if (logoUri) config.logoUri = logoUri;

  return config;
}

function sanitizeIdentifier(value: string, fallback: string, maxLength = 64): string {
  const trimmed = (value || '').trim();
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]/g, '-');
  const finalValue = sanitized.length > 0 ? sanitized : fallback;
  if (finalValue.length <= maxLength) return finalValue;
  return finalValue.slice(0, maxLength);
}

function uniqueOrigins(origins: string[], defaults: string[]): string[] {
  const acc = new Set<string>();
  const push = (value: string | undefined | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//i.test(trimmed)) return;
    acc.add(trimmed.replace(/\/$/, ''));
  };
  defaults.forEach(push);
  origins.forEach(push);
  return Array.from(acc);
}

async function loadPrivateKey(privateKeyRaw: string): Promise<CryptoKey> {
  const normalized = privateKeyRaw.replace(/\\n/g, '\n');
  if (cachedPrivateKey && cachedPrivateKeySource === normalized) {
    return cachedPrivateKey;
  }
  const key = await importPKCS8(normalized, 'RS256');
  cachedPrivateKey = key;
  cachedPrivateKeySource = normalized;
  return key;
}

function buildLoyaltyObject(config: WalletConfig, params: LoyaltyPassParams) {
  const accountId = sanitizeIdentifier(params.userId, 'user');
  const businessToken = sanitizeIdentifier(params.businessId, 'business');
  const objectId = `${config.issuerId}.${businessToken}-${accountId}`;
  const cardName = params.accountName.trim() || `Cliente ${accountId}`;

  const textModules = [] as Array<{ header: string; body: string }>;
  textModules.push({ header: 'Business ID', body: params.businessId });
  if (params.accountEmail) {
    textModules.push({ header: 'Email', body: params.accountEmail });
  }

  const loyaltyObject: any = {
    id: objectId,
    classId: config.classId,
    state: 'active',
    accountId,
    accountName: cardName,
    barcode: {
      type: 'qrCode',
      value: params.qrValue,
      alternateText: cardName,
    },
    loyaltyPoints: {
      label: config.pointsLabel,
      balance: { int: Math.max(0, Math.floor(params.validStamps ?? 0)) },
    },
    textModulesData: textModules,
  };

  if (config.backgroundColor) {
    loyaltyObject.hexBackgroundColor = config.backgroundColor;
  }

  if (config.heroImageUri) {
    loyaltyObject.heroImage = { sourceUri: { uri: config.heroImageUri } };
  }

  if (config.logoUri) {
    loyaltyObject.imageModulesData = [{ mainImage: { sourceUri: { uri: config.logoUri } } }];
  }

  return { loyaltyObject, objectId };
}

export async function createLoyaltySaveJwt(params: LoyaltyPassParams): Promise<LoyaltyPassResult> {
  const config = getWalletConfig();
  const origins = uniqueOrigins(params.origins ?? [], config.defaultOrigins);
  const { loyaltyObject, objectId } = buildLoyaltyObject(config, params);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresSeconds = nowSeconds + 5 * 60;

  const privateKey = await loadPrivateKey(config.privateKey);

  const jwtBuilder = new SignJWT({
    typ: 'savetowallet',
    origins,
    payload: {
      loyaltyObjects: [loyaltyObject],
    },
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(config.serviceAccountEmail)
    .setAudience('google')
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresSeconds);

  const jwt = await jwtBuilder.sign(privateKey);
  const saveUrl = `https://pay.google.com/gp/v/save/${encodeURIComponent(jwt)}`;

  return {
    jwt,
    saveUrl,
    objectId,
    classId: config.classId,
    expiresAt: new Date(expiresSeconds * 1000).toISOString(),
  };
}
