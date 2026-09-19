// Đã sửa bởi TAKI Academy (09/2026): thêm tính năng AI trả lời tự động. Xem NGUON-GOC.md.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { getAiConfig, getAiUsage, updateAiConfig, generateAiOutput, aiFormatRichText } from './ai-service.js';
import { buildDailyBriefSnapshot, askDailyBrief } from './daily-brief-service.js';
import { getAvailableProviders } from './provider-registry.js';
import { logger } from '../../shared/utils/logger.js';
import { prisma } from '../../shared/database/prisma-client.js';

async function assertConversationReadAccess(request: FastifyRequest, reply: FastifyReply, conversationId: string) {
  const user = request.user!;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId: user.orgId },
    select: { id: true, zaloAccountId: true },
  });
  if (!conversation) {
    reply.status(404).send({ error: 'Conversation not found' });
    return null;
  }
  if (['owner', 'admin'].includes(user.role)) return conversation;

  const access = await prisma.zaloAccountAccess.findFirst({
    where: { zaloAccountId: conversation.zaloAccountId, userId: user.id },
    select: { permission: true },
  });
  if (!access) {
    reply.status(403).send({ error: 'Không có quyền truy cập tài khoản Zalo này' });
    return null;
  }
  return conversation;
}

function getStatusFromError(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : fallback;
  const status = message.includes('quota exceeded') ? 429 : message.includes('not found') ? 404 : message.includes('disabled') || message.includes('configured') ? 400 : 500;
  return { message, status };
}

function sendHandledError(reply: FastifyReply, err: unknown, fallback: string) {
  const handled = getStatusFromError(err, fallback);
  const safeMessage = handled.status === 500 ? fallback : handled.message;
  return reply.status(handled.status).send({ error: safeMessage });
}


export async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  /* Returns available AI providers + their models (based on .env config) */
  app.get('/api/v1/ai/providers', async () => {
    return getAvailableProviders();
  });

  app.get('/api/v1/ai/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await getAiConfig(request.user!.orgId);
    } catch (err) {
      logger.error('[ai] Get config error:', err);
      return reply.status(500).send({ error: 'Failed to fetch AI config' });
    }
  });

  app.put('/api/v1/ai/config', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as { provider?: string; model?: string; maxDaily?: number; enabled?: boolean };
      if (body.maxDaily !== undefined && body.maxDaily < 1) return reply.status(400).send({ error: 'maxDaily must be at least 1' });
      return await updateAiConfig(request.user!.orgId, body);
    } catch (err) {
      logger.error('[ai] Update config error:', err);
      return reply.status(500).send({ error: 'Failed to update AI config' });
    }
  });

  app.get('/api/v1/ai/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await getAiUsage(request.user!.orgId);
    } catch (err) {
      logger.error('[ai] Usage error:', err);
      return reply.status(500).send({ error: 'Failed to fetch AI usage' });
    }
  });

  app.post('/api/v1/ai/suggest', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as { conversationId?: string; messageId?: string };
      if (!body.conversationId) return reply.status(400).send({ error: 'conversationId is required' });
      const access = await assertConversationReadAccess(request, reply, body.conversationId);
      if (!access) return;
      return await generateAiOutput({ orgId: request.user!.orgId, conversationId: body.conversationId, messageId: body.messageId, type: 'reply_draft' });
    } catch (err) {
      logger.error('[ai] Suggest error:', err);
      return sendHandledError(reply, err, 'Failed to generate AI suggestion');
    }
  });

  app.post('/api/v1/ai/summarize/:id', { preHandler: requireZaloAccess('read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      return await generateAiOutput({ orgId: request.user!.orgId, conversationId: id, type: 'summary' });
    } catch (err) {
      logger.error('[ai] Summary error:', err);
      return sendHandledError(reply, err, 'Failed to summarize conversation');
    }
  });

  app.post('/api/v1/ai/sentiment/:id', { preHandler: requireZaloAccess('read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      return await generateAiOutput({ orgId: request.user!.orgId, conversationId: id, type: 'sentiment' });
    } catch (err) {
      logger.error('[ai] Sentiment error:', err);
      return sendHandledError(reply, err, 'Failed to analyze sentiment');
    }
  });

  /* ── Popup "Tình trạng khách hàng hôm nay" ──────────────────────────────
   * snapshot: số liệu thuần SQL, hiện ngay khi mở popup, KHÔNG gọi AI.
   * ask:      snapshot + câu hỏi tự do → AI trả lời.
   * Cả hai đã lọc theo nick Zalo user được xem (nick riêng tư của người khác
   * bị loại kể cả với owner/admin) — xem daily-brief-service.ts.
   */
  app.get('/api/v1/ai/daily-brief/snapshot', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await buildDailyBriefSnapshot(request.user!);
    } catch (err) {
      logger.error('[ai] Daily brief snapshot error:', err);
      return reply.status(500).send({ error: 'Không lấy được tình trạng khách hàng hôm nay' });
    }
  });

  app.post('/api/v1/ai/daily-brief/ask', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = (request.body ?? {}) as { question?: string };
      return await askDailyBrief({ user: request.user!, question: body.question });
    } catch (err) {
      logger.error('[ai] Daily brief ask error:', err);
      const message = err instanceof Error ? err.message : '';
      // Lỗi do người dùng (hỏi quá nhanh / quá dài / AI tắt / thiếu khoá) trả 400
      // kèm nguyên văn để popup hiện được lý do; lỗi khác giấu chi tiết.
      if (/quá nhanh|quá dài|đang tắt|Chưa cấu hình/.test(message)) {
        return reply.status(400).send({ error: message });
      }
      return sendHandledError(reply, err, 'Không hỏi được AI về tình trạng khách hàng');
    }
  });

  // ── POST /ai/format-rich ─ AI auto-format text → Zalo styles. 2026-05-21 ─
  // Body: { text: string }  → Response: { text, styles[], source: 'ai'|'fallback' }
  // source='fallback' khi AI tắt, hết quota, hoặc parse fail — FE gửi tin plain.
  app.post('/api/v1/ai/format-rich', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as { text?: string };
      if (!body?.text?.trim()) return reply.status(400).send({ error: 'text is required' });
      if (body.text.length > 3000) return reply.status(400).send({ error: 'Đoạn text quá dài (tối đa 3000 ký tự)' });
      return await aiFormatRichText({ orgId: request.user!.orgId, rawText: body.text });
    } catch (err) {
      logger.error('[ai] Format-rich error:', err);
      return sendHandledError(reply, err, 'Không format được tin bằng AI');
    }
  });
}
