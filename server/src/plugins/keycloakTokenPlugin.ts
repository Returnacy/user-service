import fp from 'fastify-plugin';
import { TokenService } from '../classes/tokenService.js';

export default fp(async (fastify) => {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL
    ? process.env.KEYCLOAK_TOKEN_URL
    : `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`;

  const tokenService = new TokenService({
    clientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? process.env.KEYCLOAK_CLIENT_ID!,
    clientSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? process.env.KEYCLOAK_CLIENT_SECRET!,
    tokenUrl,
  });
  fastify.decorate('keycloakTokenService', tokenService);
});
