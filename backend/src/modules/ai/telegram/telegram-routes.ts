/**
 * telegram-routes.ts — cấu hình trợ lý Telegram từ trang cài đặt ZL CRM.
 * Token dán vào đây (không qua chat), kiểm tra bằng getMe trước khi lưu.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../../shared/utils/logger.js';
import { authMiddleware } from '../../auth/auth-middleware.js';
import { requireRole } from '../../auth/role-middleware.js';
import {
  getTelegramStatus, validateToken, setTelegramSetting, notifyOwners, getChats, TELEGRAM_KEYS,
} from './telegram-assistant.js';

export async function telegramRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.get('/api/v1/telegram/status', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await getTelegramStatus(request.user!.orgId);
    } catch (err) {
      logger.error('[telegram] đọc trạng thái lỗi:', err);
      return reply.status(500).send({ error: 'Không đọc được trạng thái Telegram' });
    }
  });

  app.put('/api/v1/telegram/token', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      const { token } = (request.body ?? {}) as { token?: string };
      const t = (token ?? '').trim();
      if (!t) {
        await setTelegramSetting(orgId, TELEGRAM_KEYS.KEY_TOKEN, null);
        await setTelegramSetting(orgId, TELEGRAM_KEYS.KEY_STATUS, 'đã gỡ token');
        return await getTelegramStatus(orgId);
      }
      if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(t)) {
        return reply.status(400).send({ error: 'Token không đúng định dạng. Token BotFather có dạng 123456789:ABC...' });
      }
      let username: string;
      try {
        username = (await validateToken(t)).username;
      } catch (err) {
        return reply.status(400).send({ error: `Telegram từ chối token này: ${err instanceof Error ? err.message : 'lỗi'}` });
      }
      await setTelegramSetting(orgId, TELEGRAM_KEYS.KEY_TOKEN, t);
      await setTelegramSetting(orgId, TELEGRAM_KEYS.KEY_USERNAME, username);
      await setTelegramSetting(orgId, TELEGRAM_KEYS.KEY_STATUS, 'đang khởi động');
      logger.info(`[telegram] đã lưu token bot @${username} bởi user=${request.user!.id}`);
      return await getTelegramStatus(orgId);
    } catch (err) {
      logger.error('[telegram] lưu token lỗi:', err);
      return reply.status(500).send({ error: 'Không lưu được token' });
    }
  });

  /** Huỷ mọi ghép cặp và đổi mã ghép cặp — dùng khi lỡ để lộ link. */
  app.post('/api/v1/telegram/reset-pairing', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      await setTelegramSetting(orgId, TELEGRAM_KEYS.KEY_CHATS, '[]');
      await setTelegramSetting(orgId, TELEGRAM_KEYS.KEY_PAIR, null);
      return await getTelegramStatus(orgId);
    } catch (err) {
      logger.error('[telegram] huỷ ghép cặp lỗi:', err);
      return reply.status(500).send({ error: 'Không huỷ được' });
    }
  });

  app.post('/api/v1/telegram/test', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = request.user!.orgId;
      if ((await getChats(orgId)).length === 0) return reply.status(400).send({ error: 'Chưa ghép cặp tài khoản Telegram nào' });
      await notifyOwners(orgId, '✅ Tin thử từ ZL CRM. Trợ lý Telegram đang hoạt động. Gõ /trangthai để xem nhanh.');
      return { ok: true };
    } catch (err) {
      logger.error('[telegram] gửi thử lỗi:', err);
      return reply.status(500).send({ error: 'Gửi thử thất bại' });
    }
  });
}
