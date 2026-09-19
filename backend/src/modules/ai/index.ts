// Đã sửa bởi TAKI Academy (09/2026): thêm tính năng AI trả lời tự động. Xem NGUON-GOC.md.
/**
 * AI plugin — route AI assistant (Phase 4 batch 2 migrate).
 * Route handler giữ NGUYÊN; lớp mỏng cho plugin-host nạp.
 */
import type { ZaloCrmPlugin } from '../../plugin-api/index.js';
import { aiRoutes } from './ai-routes.js';
import { autoReplyRoutes } from './auto-reply/routes.js';
import { groupAutoReplyRoutes } from './auto-reply/group-routes.js';
import { telegramRoutes } from './telegram/telegram-routes.js';

export const aiPlugin: ZaloCrmPlugin = {
  name: 'ai',
  version: '1.0.0',
  edition: 'core',
  async register({ app }) {
    await app.register(aiRoutes);
    await app.register(autoReplyRoutes);
    await app.register(groupAutoReplyRoutes);
    await app.register(telegramRoutes);
  },
};
