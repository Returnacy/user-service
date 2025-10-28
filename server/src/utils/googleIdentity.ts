import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export type GoogleIdTokenPayload = JWTPayload & {
  sub: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
  picture?: string;
};

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdTokenPayload> {
  if (!idToken || typeof idToken !== 'string') {
    throw Object.assign(new Error('GOOGLE_ID_TOKEN_MISSING'), { statusCode: 400 });
  }
  const audience = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || 'googleID';
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience,
    });
    const sub = payload.sub;
    if (!sub) throw new Error('GOOGLE_ID_TOKEN_SUB_MISSING');
    return payload as GoogleIdTokenPayload;
  } catch (err: any) {
    const error = new Error('INVALID_GOOGLE_ID_TOKEN');
    (error as any).cause = err;
    (error as any).statusCode = 401;
    throw error;
  }
}
