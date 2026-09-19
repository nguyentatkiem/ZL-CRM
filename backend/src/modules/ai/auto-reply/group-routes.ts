/**
 * group-routes.ts — API trả lời tự động trong NHÓM Zalo.
 *
 * Chỉ owner/admin mới được bật/tắt và sửa quy tắc, vì nhóm là TỰ GỬI.
 * Nick bật Riêng tư thì chỉ chính chủ nick được bật cho nhóm của nick đó.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { authMiddleware } from '../../auth/auth-middleware.js';
import { requireRole } from '../../auth/role-middleware.js';
import { getAutoReplyConfig, updateAutoReplyConfig } from './config-service.js';
import {
  getGroupRule, upsertGroupRule, validateRuleInput, evaluateGroupMessage,
  type GroupRuleShape,
} from './group-service.js';
import { getBrain, learnFromGroup } from './brain-service.js';
import { findEnrollCandidates, runAutoEnroll } from './auto-enroll-service.js';

export async function groupAutoReplyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  /* ── Công tắc tổng ──────────────────────────────────────────────────── */

  app.get('/api/v1/group-auto-reply/config', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      const cfg = await getAutoReplyConfig(orgId);
      const extra = await prisma.autoReplyConfig.findUnique({ where: { orgId }, select: { autoEnrollGroups: true } });
      return { groupEnabled: cfg.groupEnabled, autoEnrollGroups: !!extra?.autoEnrollGroups };
    } catch (err) {
      logger.error('[group-auto-reply] đọc cấu hình lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được cấu hình' });
    }
  });

  app.put('/api/v1/group-auto-reply/config', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      const { groupEnabled, autoEnrollGroups } = (request.body ?? {}) as { groupEnabled?: boolean; autoEnrollGroups?: boolean };
      if (groupEnabled !== undefined && typeof groupEnabled !== 'boolean') return reply.status(400).send({ error: 'groupEnabled phải là true hoặc false' });
      if (autoEnrollGroups !== undefined && typeof autoEnrollGroups !== 'boolean') return reply.status(400).send({ error: 'autoEnrollGroups phải là true hoặc false' });
      let cfg = await getAutoReplyConfig(orgId);
      if (groupEnabled !== undefined) {
        cfg = await updateAutoReplyConfig(orgId, { groupEnabled });
        logger.info(`[group-auto-reply] công tắc tổng → ${groupEnabled ? 'BẬT' : 'TẮT'} bởi user=${request.user!.id}`);
      }
      if (autoEnrollGroups !== undefined) {
        await prisma.autoReplyConfig.update({ where: { orgId }, data: { autoEnrollGroups } });
        logger.info(`[auto-enroll] tự bật nhóm → ${autoEnrollGroups ? 'BẬT' : 'TẮT'} bởi user=${request.user!.id}`);
        if (autoEnrollGroups) void runAutoEnroll(orgId).catch((err) => logger.error('[auto-enroll] lỗi:', err));
      }
      const extra = await prisma.autoReplyConfig.findUnique({ where: { orgId }, select: { autoEnrollGroups: true } });
      return { groupEnabled: cfg.groupEnabled, autoEnrollGroups: !!extra?.autoEnrollGroups };
    } catch (err) {
      logger.error('[group-auto-reply] lưu cấu hình lỗi:', err);
      return reply.status(500).send({ error: 'Không lưu được cấu hình' });
    }
  });

  /** Xem trước những nhóm sẽ được tự bật (chưa bật gì). */
  app.get('/api/v1/group-auto-reply/auto-enroll/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await findEnrollCandidates(request.user!.orgId);
    } catch (err) {
      logger.error('[auto-enroll] xem trước lỗi:', err);
      return reply.status(500).send({ error: 'Không xem trước được' });
    }
  });

  /* ── Danh sách nhóm kèm trạng thái ─────────────────────────────────── */

  app.get('/api/v1/group-auto-reply/groups', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      const { q, onlyEnabled } = request.query as { q?: string; onlyEnabled?: string };

      const groups = await prisma.conversation.findMany({
        where: {
          orgId,
          threadType: 'group',
          ...(q?.trim() ? { groupName: { contains: q.trim(), mode: 'insensitive' as const } } : {}),
          ...(onlyEnabled === 'true' ? { groupAutoReplyRule: { enabled: true } } : {}),
        },
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        take: 300,
        select: {
          id: true, groupName: true, groupAvatarUrl: true, groupMembersCount: true, lastMessageAt: true,
          zaloAccount: { select: { id: true, displayName: true, privacyMode: true } },
          groupAutoReplyRule: { select: { enabled: true, triggerMode: true, alwaysReply: true, enrolledBy: true } },
        },
      });

      const since = new Date(Date.now() - 24 * 3600_000);
      const sentRows = await prisma.groupAutoReplyLog.groupBy({
        by: ['conversationId'],
        where: { orgId, decision: 'sent', createdAt: { gte: since } },
        _count: { _all: true },
      });
      const sent24h = new Map(sentRows.map((r) => [r.conversationId, r._count._all]));

      return groups.map((g) => ({
        conversationId: g.id,
        groupName: g.groupName || 'Nhóm chưa đặt tên',
        avatarUrl: g.groupAvatarUrl,
        members: g.groupMembersCount,
        lastMessageAt: g.lastMessageAt,
        nick: g.zaloAccount?.displayName ?? null,
        nickPrivate: g.zaloAccount?.privacyMode === 'main',
        enabled: g.groupAutoReplyRule?.enabled ?? false,
        triggerMode: g.groupAutoReplyRule?.triggerMode ?? 'question',
        alwaysReply: g.groupAutoReplyRule?.alwaysReply ?? false,
        enrolledBy: g.groupAutoReplyRule?.enrolledBy ?? null,
        sentLast24h: sent24h.get(g.id) ?? 0,
      }));
    } catch (err) {
      logger.error('[group-auto-reply] liệt kê nhóm lỗi:', err);
      return reply.status(500).send({ error: 'Không liệt kê được nhóm' });
    }
  });

  /* ── Quy tắc một nhóm ──────────────────────────────────────────────── */

  async function loadGroup(orgId: string, conversationId: string) {
    return prisma.conversation.findFirst({
      where: { id: conversationId, orgId, threadType: 'group' },
      select: { id: true, groupName: true, zaloAccount: { select: { privacyMode: true, ownerUserId: true } } },
    });
  }

  app.get('/api/v1/group-auto-reply/groups/:conversationId', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const group = await loadGroup(request.user!.orgId, conversationId);
      if (!group) return reply.status(404).send({ error: 'Không tìm thấy nhóm' });
      const [rule, cfg] = await Promise.all([getGroupRule(conversationId), getAutoReplyConfig(request.user!.orgId)]);
      return { ...rule, groupName: group.groupName, groupEnabled: cfg.groupEnabled };
    } catch (err) {
      logger.error('[group-auto-reply] đọc quy tắc lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được quy tắc nhóm' });
    }
  });

  app.put('/api/v1/group-auto-reply/groups/:conversationId', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const user = request.user!;
      const group = await loadGroup(user.orgId, conversationId);
      if (!group) return reply.status(404).send({ error: 'Không tìm thấy nhóm' });

      if (group.zaloAccount?.privacyMode === 'main' && group.zaloAccount.ownerUserId !== user.id) {
        return reply.status(403).send({ error: 'Nick của nhóm này đang bật Riêng tư — chỉ chính chủ nick mới bật được' });
      }

      const body = (request.body ?? {}) as Partial<GroupRuleShape>;
      const invalid = validateRuleInput(body);
      if (invalid) return reply.status(400).send({ error: invalid });

      const wasEnabled = (await getGroupRule(conversationId)).enabled;
      const rule = await upsertGroupRule(user.orgId, conversationId, user.id, body);
      if (body.enabled !== undefined) {
        logger.info(`[group-auto-reply] nhóm "${group.groupName}" → ${body.enabled ? 'BẬT' : 'TẮT'} bởi user=${user.id}`);
      }
      /* Vừa bật: xử lý luôn các tin đang chờ trong 10 phút gần nhất, không bắt người
         trong nhóm phải nhắn thêm mới được trả lời. Chạy nền, không chặn phản hồi. */
      if (body.enabled === true && !wasEnabled) {
        const since = new Date(Date.now() - 10 * 60_000);
        void evaluateGroupMessage({ orgId: user.orgId, conversationId, backlogSince: since })
          .then((r) => logger.info(`[group-auto-reply] vừa bật "${group.groupName}", xử lý tin chờ: ${r.decision} (${r.reason})`))
          .catch((err) => logger.error('[group-auto-reply] xử lý tin chờ khi bật lỗi:', err));
      }
      return rule;
    } catch (err) {
      logger.error('[group-auto-reply] lưu quy tắc lỗi:', err);
      return reply.status(500).send({ error: 'Không lưu được quy tắc nhóm' });
    }
  });

  /* ── Chạy thử: AI xét tin mới nhất và soạn câu, KHÔNG gửi ─────────────── */

  app.post('/api/v1/group-auto-reply/groups/:conversationId/dry-run', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const group = await loadGroup(request.user!.orgId, conversationId);
      if (!group) return reply.status(404).send({ error: 'Không tìm thấy nhóm' });
      return await evaluateGroupMessage({ orgId: request.user!.orgId, conversationId, dryRun: true });
    } catch (err) {
      logger.error('[group-auto-reply] chạy thử lỗi:', err);
      return reply.status(500).send({ error: 'Chạy thử thất bại' });
    }
  });

  /* ── Trả lời tồn đọng: đáp các câu người khác đã hỏi từ mốc `since` mà nhóm
     chưa được trả lời. GỬI THẬT — chỉ owner/admin. ─────────────────────────── */
  app.post('/api/v1/group-auto-reply/groups/:conversationId/reply-backlog', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const { since, dryRun } = (request.body ?? {}) as { since?: string; dryRun?: boolean };
      const group = await loadGroup(request.user!.orgId, conversationId);
      if (!group) return reply.status(404).send({ error: 'Không tìm thấy nhóm' });
      const sinceDate = since ? new Date(since) : new Date(Date.now() - 2 * 3600_000);
      if (Number.isNaN(sinceDate.getTime())) return reply.status(400).send({ error: 'Mốc thời gian không hợp lệ' });
      if (Date.now() - sinceDate.getTime() > 24 * 3600_000) return reply.status(400).send({ error: 'Chỉ trả lời tồn đọng trong 24 giờ gần nhất' });
      logger.info(`[group-auto-reply] trả lời tồn đọng nhóm "${group.groupName}" từ ${sinceDate.toISOString()} bởi user=${request.user!.id}${dryRun ? ' (chạy thử)' : ''}`);
      return await evaluateGroupMessage({ orgId: request.user!.orgId, conversationId, backlogSince: sinceDate, dryRun: dryRun === true });
    } catch (err) {
      logger.error('[group-auto-reply] trả lời tồn đọng lỗi:', err);
      return reply.status(500).send({ error: 'Trả lời tồn đọng thất bại' });
    }
  });

  /* ── Bộ não nhóm ────────────────────────────────────────────────────── */

  app.get('/api/v1/group-auto-reply/groups/:conversationId/brain', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const group = await loadGroup(request.user!.orgId, conversationId);
      if (!group) return reply.status(404).send({ error: 'Không tìm thấy nhóm' });
      return await getBrain(conversationId);
    } catch (err) {
      logger.error('[group-brain] đọc bộ não lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được bộ não nhóm' });
    }
  });

  /** Học ngay — mặc định quét lại 30 ngày lịch sử. */
  app.post('/api/v1/group-auto-reply/groups/:conversationId/brain/learn', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const { days } = (request.body ?? {}) as { days?: number };
      const group = await loadGroup(request.user!.orgId, conversationId);
      if (!group) return reply.status(404).send({ error: 'Không tìm thấy nhóm' });
      const sinceDays = Number.isInteger(days) && days! > 0 && days! <= 90 ? days! : 30;
      return await learnFromGroup(request.user!.orgId, conversationId, { sinceDays, force: true });
    } catch (err) {
      logger.error('[group-brain] học lỗi:', err);
      return reply.status(500).send({ error: 'Học thất bại' });
    }
  });

  /** Thêm tay một điều vào bộ não. */
  app.post('/api/v1/group-auto-reply/groups/:conversationId/brain', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const { content } = (request.body ?? {}) as { content?: string };
      if (!content?.trim()) return reply.status(400).send({ error: 'Thiếu nội dung' });
      if (content.length > 500) return reply.status(400).send({ error: 'Mỗi điều tối đa 500 ký tự' });
      const group = await loadGroup(request.user!.orgId, conversationId);
      if (!group) return reply.status(404).send({ error: 'Không tìm thấy nhóm' });
      return await prisma.groupKnowledge.create({
        data: { orgId: request.user!.orgId, conversationId, content: content.trim(), source: 'manual' },
        select: { id: true, content: true, source: true, enabled: true, createdAt: true, updatedAt: true },
      });
    } catch (err) {
      logger.error('[group-brain] thêm điều lỗi:', err);
      return reply.status(500).send({ error: 'Không thêm được' });
    }
  });

  /** Sửa nội dung hoặc bật/tắt một điều. */
  app.put('/api/v1/group-auto-reply/brain/:itemId', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const { content, enabled } = (request.body ?? {}) as { content?: string; enabled?: boolean };
      const item = await prisma.groupKnowledge.findFirst({ where: { id: itemId, orgId: request.user!.orgId }, select: { id: true } });
      if (!item) return reply.status(404).send({ error: 'Không tìm thấy' });
      if (content !== undefined && (!content.trim() || content.length > 500)) return reply.status(400).send({ error: 'Nội dung 1-500 ký tự' });
      return await prisma.groupKnowledge.update({
        where: { id: itemId },
        data: {
          ...(content !== undefined ? { content: content.trim(), source: 'manual' } : {}),
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        },
        select: { id: true, content: true, source: true, enabled: true, createdAt: true, updatedAt: true },
      });
    } catch (err) {
      logger.error('[group-brain] sửa điều lỗi:', err);
      return reply.status(500).send({ error: 'Không sửa được' });
    }
  });

  app.delete('/api/v1/group-auto-reply/brain/:itemId', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { itemId } = request.params as { itemId: string };
      const item = await prisma.groupKnowledge.findFirst({ where: { id: itemId, orgId: request.user!.orgId }, select: { id: true } });
      if (!item) return reply.status(404).send({ error: 'Không tìm thấy' });
      await prisma.groupKnowledge.delete({ where: { id: itemId } });
      return { ok: true };
    } catch (err) {
      logger.error('[group-brain] xoá điều lỗi:', err);
      return reply.status(500).send({ error: 'Không xoá được' });
    }
  });

  /* ── Nhật ký ────────────────────────────────────────────────────────── */

  app.get('/api/v1/group-auto-reply/groups/:conversationId/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const group = await loadGroup(request.user!.orgId, conversationId);
      if (!group) return reply.status(404).send({ error: 'Không tìm thấy nhóm' });
      return await prisma.groupAutoReplyLog.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { id: true, decision: true, reason: true, content: true, latencyMs: true, createdAt: true },
      });
    } catch (err) {
      logger.error('[group-auto-reply] đọc nhật ký lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được nhật ký' });
    }
  });
}
