/**
 * listener.ts — nối tin nhắn đến với bộ soạn nháp.
 *
 * Bám vào event 'message_received' mà message-handler đã phát sẵn, không đụng
 * vào đường xử lý tin nhắn. Nếu phần này hỏng thì tin nhắn vẫn về bình thường,
 * chỉ là không có nháp.
 */
import { logger } from '../../../shared/utils/logger.js';
import { automationEventBus } from '../../automation/engine/event-bus.js';
import { generateDraftForMessage } from './draft-service.js';
import { isGroupWatched, scheduleGroupEvaluation } from './group-service.js';
import { startBrainScheduler } from './brain-service.js';
import { startAutoEnrollScheduler } from './auto-enroll-service.js';

let started = false;

/* Những lý do bỏ qua xảy ra liên tục trong ngày — chỉ ghi log ở mức debug để
   khỏi ngập log. Các lý do còn lại đáng để người vận hành nhìn thấy. */
const QUIET_REASONS = new Set(['disabled', 'not_direct_chat', 'not_text', 'empty_text', 'too_soon', 'staff_just_replied']);

export function startAutoReplyListener(): void {
  if (started) return;
  started = true;

  automationEventBus.onType(['message_received'], async (event) => {
    const payload = event.payload as {
      messageId?: string;
      conversationId?: string;
      content?: string;
      contentType?: string;
    } | undefined;

    if (!payload?.messageId || !payload.conversationId) return;

    /* Nhóm được chỉ định → hẹn giờ xét (gom tin 12 giây). Nhóm không có quy tắc
       bật thì bỏ qua ngay, không tốn gì. */
    try {
      const watch = await isGroupWatched(payload.conversationId);
      if (watch.watched) {
        scheduleGroupEvaluation(event.orgId, payload.conversationId, payload.messageId);
        return;
      }
    } catch (err) {
      logger.error(`[group-auto-reply] kiểm tra nhóm lỗi conv=${payload.conversationId}:`, err);
    }

    try {
      const result = await generateDraftForMessage({
        orgId: event.orgId,
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        contactId: event.contactId ?? null,
        content: payload.content ?? '',
        contentType: payload.contentType ?? 'text',
      });

      if (!result.created && !QUIET_REASONS.has(result.reason)) {
        logger.info(`[auto-reply] bỏ qua conv=${payload.conversationId} lý do=${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
      }
    } catch (err) {
      logger.error(`[auto-reply] soạn nháp thất bại conv=${payload.conversationId}:`, err);
    }
  });

  startBrainScheduler();
  startAutoEnrollScheduler();
  logger.info('[auto-reply] listener đã bật — nháp cho chat 1-1, tự trả lời cho nhóm được chỉ định');
}
