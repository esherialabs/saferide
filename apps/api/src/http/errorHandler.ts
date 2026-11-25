import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

/** Our code and generic message per client status; Fastify's own text is never sent. */
const CLIENT_ERROR_RESPONSES: Record<number, { code: string; message: string }> = {
  400: { code: 'bad_request', message: 'Invalid request' },
  404: { code: 'not_found', message: 'Not found' },
  405: { code: 'method_not_allowed', message: 'Method not allowed' },
  406: { code: 'not_acceptable', message: 'Not acceptable' },
  408: { code: 'request_timeout', message: 'Request timed out' },
  413: { code: 'payload_too_large', message: 'Request body exceeds the size limit' },
  415: { code: 'unsupported_media_type', message: 'Unsupported content type' },
  431: { code: 'headers_too_large', message: 'Request headers are too large' },
};
const GENERIC_CLIENT_ERROR = { code: 'bad_request', message: 'Invalid request' };

/**
 * A request Fastify itself refused as the client's fault (FST_ERR_CTP_* body
 * parsing, FST_ERR_VALIDATION and similar): a FastifyError carrying a 4xx
 * status. Anything else, including a library error that happens to carry a
 * 4xx statusCode, is not a client error here and stays a server fault.
 */
export function fastifyClientError(error: unknown): { statusCode: number; code: string } | undefined {
  if (!(error instanceof Error) || error.name !== 'FastifyError') return undefined;
  const { code, statusCode } = error as Partial<FastifyError>;
  if (typeof code !== 'string' || !code.startsWith('FST_')) return undefined;
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 499) return undefined;
  return { statusCode, code };
}

/**
 * Answers a Fastify client error with its 4xx in our structured shape and a
 * generic message, logging only the Fastify code and status at warn. Returns
 * false, sending nothing, when the error is not a Fastify client error.
 */
export function sendFastifyClientError(error: unknown, request: FastifyRequest, reply: FastifyReply): boolean {
  const clientError = fastifyClientError(error);
  if (!clientError) return false;
  const { code, message } = CLIENT_ERROR_RESPONSES[clientError.statusCode] ?? GENERIC_CLIENT_ERROR;
  request.log.warn({ fastifyCode: clientError.code, statusCode: clientError.statusCode }, 'Client request rejected');
  reply.status(clientError.statusCode).send({ code, message, requestId: request.id });
  return true;
}

/** Install before any awaited plugin registration can compile existing routes. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ code: error.code, message: error.message, details: error.details, requestId: request.id });
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send({ code: 'bad_request', message: 'Invalid request', details: error.flatten(), requestId: request.id });
      return;
    }
    if (sendFastifyClientError(error, request, reply)) return;
    request.log.error({ err: error }, 'Unhandled API error');
    reply.status(500).send({ code: 'internal_error', message: 'Internal server error', requestId: request.id });
  });
}
