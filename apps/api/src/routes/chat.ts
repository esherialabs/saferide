import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isPrivacyCapabilityEnabled } from '../config/privacyControls.js';
import { badRequest, notFound, serviceUnavailable } from '../http/errors.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { redis } from '../plugins/redis.js';
import {
  createSession,
  deleteSession,
  getOrCreateSession,
  insertMessage,
  isChatSessionOwnedBy,
  listMessages,
  listSessions,
} from '../repositories/chatRepository.js';
import { auditEvent } from '../services/auditService.js';
import { ACTIVE_PRIVACY_CONTROL_VERSION } from '../config/privacyControls.js';

const CHAT_MESSAGE_CHANNEL = 'saferide:chat_messages';

const messageSchema = z.object({
  sessionId: z.string().uuid().optional(),
  role: z.enum(['user', 'assistant']).default('user'),
  content: z.string().min(1).max(8000),
  mode: z.string().min(1).default('legal-aid'),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const sessionSchema = z.object({
  mode: z.string().min(1).default('legal-aid'),
});

function requireRemoteChatIngestion(): void {
  if (!isPrivacyCapabilityEnabled('remote_chat_ingestion')) {
    throw serviceUnavailable('Remote chat storage is disabled pending privacy and legal approval', {
      handoffId: 'HANDOFF-PRIVACY-LEGAL-REVIEW',
    });
  }
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chat/sessions', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    return { sessions: await listSessions(auth.userId) };
  });

  app.post('/api/chat/sessions', { preHandler: requireAuth }, async request => {
    requireRemoteChatIngestion();
    const auth = getAuth(request);
    const parsed = sessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('Invalid chat session payload', parsed.error.flatten());
    const session = await createSession(auth.userId, parsed.data.mode);
    return { session };
  });

  app.post('/api/chat/session', { preHandler: requireAuth }, async request => {
    requireRemoteChatIngestion();
    const auth = getAuth(request);
    const parsed = sessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('Invalid chat session payload', parsed.error.flatten());
    const session = await getOrCreateSession(auth.userId, parsed.data.mode);
    return { session };
  });

  app.delete('/api/chat/session/:id', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await deleteSession(auth.userId, params.id);
    if (!deleted) throw notFound('Chat session not found');

    await auditEvent({
      action: 'chat.session.delete',
      resourceClass: 'chat_session',
      requestId: request.id,
      outcome: 'success',
      policyVersion: ACTIVE_PRIVACY_CONTROL_VERSION,
    });

    return { deleted: true };
  });

  app.post('/api/chat/message', { preHandler: requireAuth }, async request => {
    requireRemoteChatIngestion();
    const auth = getAuth(request);
    const parsed = messageSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid chat payload', parsed.error.flatten());

    const session = parsed.data.sessionId
      ? { id: parsed.data.sessionId }
      : await getOrCreateSession(auth.userId, parsed.data.mode);

    const userMessage = await insertMessage({
      ownerId: auth.userId,
      sessionId: session.id,
      role: parsed.data.role,
      content: parsed.data.content,
      metadata: parsed.data.metadata ?? null,
    });
    if (!userMessage) throw notFound('Chat session not found');

    await redis.publish(
      CHAT_MESSAGE_CHANNEL,
      JSON.stringify({
        sessionId: session.id,
        message: userMessage,
      }),
    );

    await auditEvent({
      action: 'chat.message',
      resourceClass: 'chat_session',
      requestId: request.id,
      outcome: 'success',
      policyVersion: ACTIVE_PRIVACY_CONTROL_VERSION,
    });

    return {
      sessionId: session.id,
      message: userMessage,
    };
  });

  app.get('/api/chat/session/:id/messages', { preHandler: requireAuth }, async request => {
    const auth = getAuth(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!await isChatSessionOwnedBy(auth.userId, params.id)) throw notFound('Chat session not found');
    return { messages: await listMessages(auth.userId, params.id) };
  });
}
