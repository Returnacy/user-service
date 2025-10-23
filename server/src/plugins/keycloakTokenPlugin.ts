import fp from 'fastify-plugin';
import { TokenService } from '../classes/tokenService.js';

export default fp(async (fastify) => {
  const tokenService = new TokenService({
    clientId: process.env.KEYCLOAK_CLIENT_ID!,
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
    tokenUrl: `${process.env.KEYCLOAK_BASE_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
  });
  fastify.decorate('keycloakTokenService', tokenService);
});
