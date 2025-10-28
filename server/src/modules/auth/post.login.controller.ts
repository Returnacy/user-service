import type { FastifyReply, FastifyRequest } from 'fastify';
import axios from 'axios';
import crypto from 'node:crypto';
import { z } from 'zod';
import { verifyGoogleIdToken } from '../../utils/googleIdentity.js';

const legacyLoginSchema = z.object({
  username: z.string().email(),
  password: z.string().min(1)
});

const passwordLoginSchema = z.object({
  authType: z.literal('password'),
  email: z.string().email(),
  password: z.string().min(1)
});

const oauthLoginSchema = z.object({
  authType: z.literal('oauth'),
  provider: z.literal('google'),
  idToken: z.string().min(10)
});

function buildTokenUrl() {
  return `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`;
}

async function issuePasswordGrant(username: string, password: string) {
  const tokenUrl = buildTokenUrl();
  const form = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    client_id: process.env.KEYCLOAK_CLIENT_ID!,
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET!,
    scope: 'openid profile email offline_access'
  });
  return axios.post(tokenUrl, form, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

export async function postLoginHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const rawBody = (request.body ?? {}) as any;

    if (rawBody?.authType === 'oauth') {
      const oauthInput = oauthLoginSchema.parse(rawBody);
      if (oauthInput.provider !== 'google') {
        return reply.status(400).send({ error: 'UNSUPPORTED_OAUTH_PROVIDER' });
      }

      const repository = (request.server as any).repository;
      const tokenService = (request.server as any).keycloakTokenService as { getAccessToken(): Promise<string> };
      const googlePayload = await verifyGoogleIdToken(oauthInput.idToken);
      const googleSub = googlePayload.sub;
      const emailFromGoogle = (googlePayload.email || '').toLowerCase();
      const email = emailFromGoogle || (typeof rawBody.email === 'string' ? rawBody.email.toLowerCase() : '');

      // Resolve local user by googleSub -> email fallback
      let user = googleSub ? await repository.findUserByGoogleSub(googleSub) : null;
      if (!user && email) {
        user = await repository.findUserByEmail(email);
        if (user && googleSub && !(user as any).googleSub) {
          await repository.upsertUserByKeycloakSub(user.keycloakSub, { googleSub });
          user = await repository.findUserByKeycloakSub(user.keycloakSub);
        }
      }

      if (!user) {
        return reply.status(404).send({ error: 'USER_NOT_FOUND', message: 'Registrati con Google prima di effettuare l\'accesso.' });
      }

      const adminAccessToken = await tokenService.getAccessToken();
      const baseUrl = process.env.KEYCLOAK_BASE_URL!;
      const realm = process.env.KEYCLOAK_REALM!;

      try {
        await axios.put(
          `${baseUrl}/admin/realms/${realm}/users/${user.keycloakSub}`,
          {
            emailVerified: true,
            attributes: {
              googleSub: [googleSub],
            },
          },
          { headers: { Authorization: `Bearer ${adminAccessToken}` } }
        );
      } catch (e) {
        request.log.warn({ err: e }, 'Failed to sync googleSub attribute on Keycloak user');
      }

      const tempPassword = crypto.randomBytes(24).toString('hex');
      try {
        await axios.put(
          `${baseUrl}/admin/realms/${realm}/users/${user.keycloakSub}/reset-password`,
          { type: 'password', temporary: false, value: tempPassword },
          { headers: { Authorization: `Bearer ${adminAccessToken}` } }
        );
      } catch (err) {
        request.log.error({ err }, 'Failed to set temporary password for Google login');
        return reply.status(500).send({ error: 'GOOGLE_LOGIN_PASSWORD_RESET_FAILED' });
      }

      try {
        const tokenRes = await issuePasswordGrant(user.email || email || emailFromGoogle, tempPassword);
        const tokens = tokenRes.data;
        return reply.send({
          ...tokens,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          user: {
            id: user.id,
            keycloakSub: user.keycloakSub,
            email: user.email,
          },
        });
      } catch (err: any) {
        const detail = err?.response?.data || err?.message || 'Unknown error';
        request.log.error({ err, detail }, 'GOOGLE_LOGIN_TOKEN_EXCHANGE_FAILED');
        return reply.status(401).send({ error: 'GOOGLE_LOGIN_FAILED', detail });
      }
    }

    const credentials = rawBody?.authType === 'password'
      ? passwordLoginSchema.parse(rawBody)
      : legacyLoginSchema.parse(rawBody);

    const isPasswordVariant = (credentials as any).authType === 'password';
    const username = isPasswordVariant ? (credentials as any).email : (credentials as any).username;
    const password = (credentials as any).password;

    try {
      const res = await issuePasswordGrant(username, password);
      return reply.send(res.data);
    } catch (err: any) {
      const errData = err?.response?.data;
      const isRequiredActionsBlock = err?.response?.status === 400 && (
        errData?.error === 'invalid_grant' || errData?.error_description?.toLowerCase?.().includes('not fully set up')
      );
      if (!isRequiredActionsBlock) throw err;

      try {
        const adminTokenUrl = buildTokenUrl();
        const adminBody = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.KEYCLOAK_CLIENT_ID!,
          client_secret: process.env.KEYCLOAK_CLIENT_SECRET!
        });
        const adminRes = await axios.post(adminTokenUrl, adminBody, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const adminAccessToken: string = adminRes.data.access_token;

        const baseUrl = process.env.KEYCLOAK_BASE_URL!;
        const realm = process.env.KEYCLOAK_REALM!;
        const findResp = await axios.get(`${baseUrl}/admin/realms/${realm}/users`, {
          params: { email: username },
          headers: { Authorization: `Bearer ${adminAccessToken}` }
        });
        const kcUser = Array.isArray(findResp.data) ? findResp.data[0] : null;
        if (kcUser?.id) {
          await axios.put(`${baseUrl}/admin/realms/${realm}/users/${kcUser.id}`,
            { requiredActions: [], emailVerified: true },
            { headers: { Authorization: `Bearer ${adminAccessToken}` } }
          );
        }

        const retry = await issuePasswordGrant(username, password);
        return reply.send(retry.data);
      } catch (e) {
        throw err;
      }
    }
  } catch (error: any) {
    const status = error?.statusCode ?? 401;
    const detail = error?.response?.data || error?.message || 'Unknown error';
    request.log.error({ err: error, detail }, 'LOGIN_FAILED');
    return reply.status(status).send({ error: 'LOGIN_FAILED', detail });
  }
}
