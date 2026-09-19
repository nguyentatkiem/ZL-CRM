/**
 * routes.ts — API cho tính năng trả lời tự động theo ngữ cảnh.
 *
 * Không có route nào ở đây gửi tin cho khách. Nhân viên bấm "Dùng" thì FE chèn
 * nội dung vào ô soạn tin và gửi qua route chat sẵn có — người chịu trách nhiệm
 * vẫn là người bấm gửi.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { authMiddleware } from '../../auth/auth-middleware.js';
import { requireRole } from '../../auth/role-middleware.js';
import {
  getAutoReplyConfig, updateAutoReplyConfig, validateConfigInput,
  type AutoReplyConfigInput,
} from './config-service.js';
import { generateDraftForMessage, expireStaleDrafts } from './draft-service.js';

const SKIP_LABELS: Record<string, string> = {
  disabled: 'Tính năng đang tắt',
  not_direct_chat: 'Chỉ áp dụng cho chat 1-1',
  not_text: 'Tin cuối của khách không phải dạng chữ',
  empty_text: 'Tin cuối của khách không có nội dung chữ',
  account_not_allowed: 'Nick này không nằm trong danh sách áp dụng',
  account_private: 'Nick đang bật Riêng tư nên không soạn nháp',
  outside_hours: 'Ngoài khung giờ đã đặt',
  blocked_keyword: 'Tin có từ khoá cần người thật xử lý',
  too_soon: 'Vừa soạn nháp cho hội thoại này',
  staff_just_replied: 'Nhân viên vừa trả lời khách',
  daily_cap: 'Đã chạm trần số nháp trong ngày',
  ai_disabled: 'AI đang tắt cho tổ chức này',
  no_provider_key: 'Chưa cấu hình khoá cho nhà cung cấp AI',
};

export async function autoReplyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  /* ── Cấu hình ─────────────────────────────────────────────────────────── */

  app.get('/api/v1/auto-reply/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await getAutoReplyConfig(request.user!.orgId);
    } catch (err) {
      logger.error('[auto-reply] đọc cấu hình lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được cấu hình trả lời tự động' });
    }
  });

  app.put('/api/v1/auto-reply/config', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = (request.body ?? {}) as AutoReplyConfigInput;
      const invalid = validateConfigInput(body);
      if (invalid) return reply.status(400).send({ error: invalid });
      return await updateAutoReplyConfig(request.user!.orgId, body);
    } catch (err) {
      logger.error('[auto-reply] lưu cấu hình lỗi:', err);
      return reply.status(500).send({ error: 'Không lưu được cấu hình' });
    }
  });

  /* ── Nháp ─────────────────────────────────────────────────────────────── */

  /** Nháp đang chờ của một hội thoại (FE gọi khi mở hội thoại). */
  app.get('/api/v1/auto-reply/drafts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.query as { conversationId?: string };
      if (!conversationId) return reply.status(400).send({ error: 'Thiếu conversationId' });

      const orgId = request.user!.orgId;
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, orgId },
        select: { id: true },
      });
      if (!conversation) return reply.status(404).send({ error: 'Không tìm thấy hội thoại' });

      const config = await getAutoReplyConfig(orgId);
      await expireStaleDrafts(orgId, config.draftTtlMinutes);

      const draft = await prisma.autoReplyDraft.findFirst({
        where: { conversationId, state: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, content: true, rationale: true, playbookUsed: true,
          provider: true, model: true, createdAt: true,
        },
      });
      return { draft, enabled: config.enabled };
    } catch (err) {
      logger.error('[auto-reply] đọc nháp lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được nháp' });
    }
  });

  /** Đánh dấu nháp đã được dùng (nhân viên chèn vào ô soạn tin). */
  app.post('/api/v1/auto-reply/drafts/:id/use', async (request: FastifyRequest, reply: FastifyReply) => {
    return markDraft(request, reply, 'used');
  });

  /** Nhân viên bỏ nháp. */
  app.post('/api/v1/auto-reply/drafts/:id/dismiss', async (request: FastifyRequest, reply: FastifyReply) => {
    return markDraft(request, reply, 'dismissed');
  });

  async function markDraft(request: FastifyRequest, reply: FastifyReply, state: 'used' | 'dismissed') {
    try {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const existing = await prisma.autoReplyDraft.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, state: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tìm thấy nháp' });

      const updated = await prisma.autoReplyDraft.update({
        where: { id },
        data: {
          state,
          usedByUserId: state === 'used' ? user.id : null,
          usedAt: state === 'used' ? new Date() : null,
        },
        select: { id: true, state: true },
      });
      return updated;
    } catch (err) {
      logger.error('[auto-reply] cập nhật nháp lỗi:', err);
      return reply.status(500).send({ error: 'Không cập nhật được nháp' });
    }
  }

  /** Soạn nháp ngay cho hội thoại đang mở, bỏ qua khung giờ và khoảng nghỉ.
   *  Dùng khi nhân viên muốn AI viết lại — vẫn giữ các chặn về quyền và từ khoá. */
  app.post('/api/v1/auto-reply/drafts/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = (request.body ?? {}) as { conversationId?: string };
      if (!conversationId) return reply.status(400).send({ error: 'Thiếu conversationId' });

      const orgId = request.user!.orgId;
      const lastInbound = await prisma.message.findFirst({
        where: { conversationId, conversation: { orgId }, senderType: 'contact', isDeleted: false },
        orderBy: { sentAt: 'desc' },
        select: { id: true, content: true, contentType: true, conversation: { select: { contactId: true } } },
      });
      if (!lastInbound) return reply.status(400).send({ error: 'Hội thoại chưa có tin nào của khách' });

      const result = await generateDraftForMessage({
        orgId,
        conversationId,
        messageId: lastInbound.id,
        contactId: lastInbound.conversation.contactId,
        content: lastInbound.content ?? '',
        contentType: lastInbound.contentType,
        // Bấm tay thì bỏ qua khung giờ + khoảng nghỉ + chặn "nhân viên vừa trả lời",
        // vì chính nhân viên đang chủ động yêu cầu.
        ignoreTimingGates: true,
      });

      if (!result.created) {
        return reply.status(400).send({ error: SKIP_LABELS[result.reason] ?? 'Không soạn được nháp', reason: result.reason });
      }
      return result;
    } catch (err) {
      logger.error('[auto-reply] soạn nháp thủ công lỗi:', err);
      return reply.status(500).send({ error: 'Không soạn được nháp, thử lại sau' });
    }
  });

  /* ── Kho kịch bản bán hàng ────────────────────────────────────────────── */

  app.get('/api/v1/auto-reply/playbook', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await prisma.salesPlaybookEntry.findMany({
        where: { orgId: request.user!.orgId },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true, title: true, category: true, keywords: true, content: true,
          priority: true, enabled: true, updatedAt: true,
          createdBy: { select: { fullName: true } },
        },
      });
    } catch (err) {
      logger.error('[auto-reply] đọc kịch bản lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được kho kịch bản' });
    }
  });

  type PlaybookBody = {
    title?: string; category?: string | null; keywords?: string[];
    content?: string; priority?: number; enabled?: boolean;
  };

  function validatePlaybook(body: PlaybookBody, requireAll: boolean): string | null {
    if (requireAll || body.title !== undefined) {
      if (!body.title?.trim()) return 'Thiếu tiêu đề';
      if (body.title.length > 200) return 'Tiêu đề tối đa 200 ký tự';
    }
    if (requireAll || body.content !== undefined) {
      if (!body.content?.trim()) return 'Thiếu nội dung';
      if (body.content.length > 8000) return 'Nội dung tối đa 8000 ký tự';
    }
    if (body.keywords !== undefined) {
      if (!Array.isArray(body.keywords) || body.keywords.some((k) => typeof k !== 'string')) {
        return 'Từ khoá phải là mảng chuỗi';
      }
      if (body.keywords.length > 40) return 'Tối đa 40 từ khoá mỗi mục';
    }
    if (body.priority !== undefined && (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 100)) {
      return 'Độ ưu tiên phải là số nguyên 0-100';
    }
    return null;
  }

  app.post('/api/v1/auto-reply/playbook', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = (request.body ?? {}) as PlaybookBody;
      const invalid = validatePlaybook(body, true);
      if (invalid) return reply.status(400).send({ error: invalid });

      return await prisma.salesPlaybookEntry.create({
        data: {
          orgId: request.user!.orgId,
          title: body.title!.trim(),
          category: body.category?.trim() || null,
          keywords: body.keywords ?? [],
          content: body.content!.trim(),
          priority: body.priority ?? 0,
          enabled: body.enabled ?? true,
          createdById: request.user!.id,
        },
        select: { id: true, title: true, category: true, keywords: true, content: true, priority: true, enabled: true },
      });
    } catch (err) {
      logger.error('[auto-reply] tạo kịch bản lỗi:', err);
      return reply.status(500).send({ error: 'Không tạo được mục kịch bản' });
    }
  });

  app.put('/api/v1/auto-reply/playbook/:id', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as PlaybookBody;
      const invalid = validatePlaybook(body, false);
      if (invalid) return reply.status(400).send({ error: invalid });

      const existing = await prisma.salesPlaybookEntry.findFirst({
        where: { id, orgId: request.user!.orgId },
        select: { id: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tìm thấy mục kịch bản' });

      return await prisma.salesPlaybookEntry.update({
        where: { id },
        data: {
          title: body.title?.trim(),
          category: body.category === undefined ? undefined : (body.category?.trim() || null),
          keywords: body.keywords,
          content: body.content?.trim(),
          priority: body.priority,
          enabled: body.enabled,
        },
        select: { id: true, title: true, category: true, keywords: true, content: true, priority: true, enabled: true },
      });
    } catch (err) {
      logger.error('[auto-reply] sửa kịch bản lỗi:', err);
      return reply.status(500).send({ error: 'Không sửa được mục kịch bản' });
    }
  });

  app.delete('/api/v1/auto-reply/playbook/:id', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const existing = await prisma.salesPlaybookEntry.findFirst({
        where: { id, orgId: request.user!.orgId },
        select: { id: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tìm thấy mục kịch bản' });
      await prisma.salesPlaybookEntry.delete({ where: { id } });
      return { ok: true };
    } catch (err) {
      logger.error('[auto-reply] xoá kịch bản lỗi:', err);
      return reply.status(500).send({ error: 'Không xoá được mục kịch bản' });
    }
  });

  /* ── Thống kê nhẹ cho trang cài đặt ───────────────────────────────────── */

  app.get('/api/v1/auto-reply/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      const since = new Date(Date.now() - 7 * 86400000);
      const rows = await prisma.autoReplyDraft.groupBy({
        by: ['state'],
        where: { orgId, createdAt: { gte: since } },
        _count: { _all: true },
      });
      const byState = Object.fromEntries(rows.map((r) => [r.state, r._count._all]));
      const total = rows.reduce((sum, r) => sum + r._count._all, 0);
      const used = byState.used ?? 0;
      return {
        days: 7,
        total,
        used,
        dismissed: byState.dismissed ?? 0,
        pending: byState.pending ?? 0,
        usedRate: total > 0 ? Math.round((used / total) * 100) : 0,
      };
    } catch (err) {
      logger.error('[auto-reply] thống kê lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được thống kê' });
    }
  });
}
