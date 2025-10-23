import fp from 'fastify-plugin';

import { RepositoryPrisma } from '@user-service/db';

export default fp(async (fastify) => {
  const repository = new RepositoryPrisma();
  fastify.decorate('repository', repository);
});
