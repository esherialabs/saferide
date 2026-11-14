import { FastifyInstance } from 'fastify';

/**
 * Echoes the server-generated request id (REQUEST_ID_OPTIONS) so a client
 * can quote it to support. Any X-Request-Id the client sent is ignored.
 */
export async function registerRequestContext(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
}
