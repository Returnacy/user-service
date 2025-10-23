declare module './get.user.controller.js' {
  import type { FastifyReply, FastifyRequest } from 'fastify';
  export function getUserByIdHandler(request: FastifyRequest, reply: FastifyReply): Promise<any>;
}
