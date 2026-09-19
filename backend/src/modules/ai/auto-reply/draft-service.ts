/**
 * draft-service.ts — sinh nháp trả lời cho một tin nhắn đến.
 *
 * KHÔNG GỬI TIN. Chỉ ghi một hàng AutoReplyDraft ở trạng thái 'pending' rồi
 * đẩy socket cho khung chat hiện lên. Việc gửi vẫn đi qua route gửi tin sẵn có
 * khi nhân viên bấm — nghĩa là mọi hàng rào cũ (khoá riêng tư, giới hạn tần
 * suất của Zalo, ghi nhận người gửi) giữ nguyên, không có đường tắt nào mới.
 *
 * Thứ tự cổng chặn, dừng ở cổng đầu tiên không qua:
 *   1. tính năng đang bật            6. hội thoại vừa sinh nháp (minGap)
 *   2. hội thoại 1-1, tin dạng chữ   7. nhân viên vừa trả lời khách
 *   3. nick được phép, không riêng tư 8. trần số nháp trong ngày
 *   4. trong khung giờ làm việc      9. AI đang bật + có khoá
 *   5. tin không chứa từ khoá chặn
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { zaloPool } from '../../zalo/zalo-pool.js';
import { getAiConfig, getProviderApiKey, generateText } from '../ai-service.js';
import { buildAutoReplyPrompt } from '../prompts/auto-reply.js';
import { getAutoReplyConfig } from './config-service.js';
import { buildAutoReplyContext, renderContextForPrompt, matchesAnyKeyword } from './context-builder.js';

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export type SkipReason =
  | 'disabled' | 'not_direct_chat' | 'not_text' | 'empty_text'
  | 'account_not_allowed' | 'account_private' | 'outside_hours'
  | 'blocked_keyword' | 'too_soon' | 'staff_just_replied'
  | 'daily_cap' | 'ai_disabled' | 'no_provider_key';

export type DraftOutcome =
  | { created: true; draftId: string; content: string }
  | { created: false; reason: SkipReason; detail?: string };

function vnHour(now = new Date()) {
  return new Date(now.getTime() + VN_OFFSET_MS).getUTCHours();
}

function startOfVnDay(now = new Date()) {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - VN_OFFSET_MS);
}

/** AI hay bọc JSON trong ```json … ``` hoặc kèm lời dẫn — gỡ ra trước khi parse. */
function parseAiJson(raw: string): { reply: string; rationale?: string; playbookUsed?: string[] } | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    if (!reply) return null;
    return {
      reply,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
      playbookUsed: Array.isArray(parsed.playbookUsed)
        ? parsed.playbookUsed.filter((v): v is string => typeof v === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

export async function generateDraftForMessage(input: {
  orgId: string;
  conversationId: string;
  messageId: string;
  contactId: string | null;
  content: string;
  contentType: string;
  /* Nhân viên bấm "AI viết lại" → bỏ qua khung giờ, khoảng nghỉ và chặn
     "nhân viên vừa trả lời", vì chính họ đang chủ động yêu cầu. Các chặn về
     quyền, nick riêng tư, từ khoá nhạy cảm và trần ngày vẫn giữ. */
  ignoreTimingGates?: boolean;
}): Promise<DraftOutcome> {
  const { orgId, conversationId, messageId, contactId, content, contentType } = input;
  const ignoreTiming = input.ignoreTimingGates === true;

  const config = await getAutoReplyConfig(orgId);
  if (!config.enabled) return { created: false, reason: 'disabled' };

  if (contentType !== 'text' && contentType !== 'rich') {
    return { created: false, reason: 'not_text' };
  }
  const text = (content || '').trim();
  if (!text) return { created: false, reason: 'empty_text' };

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId },
    select: {
      id: true, threadType: true, zaloAccountId: true,
      zaloAccount: { select: { privacyMode: true } },
    },
  });
  if (!conversation) return { created: false, reason: 'not_direct_chat', detail: 'không tìm thấy hội thoại' };

  /* Chỉ chat 1-1. Nhóm thì bỏ qua — đã chốt như vậy. */
  if (conversation.threadType !== 'user') return { created: false, reason: 'not_direct_chat' };

  /* Nick riêng tư: nội dung bị che với người khác, không sinh nháp để khỏi rò. */
  if (conversation.zaloAccount?.privacyMode === 'main') {
    return { created: false, reason: 'account_private' };
  }

  if (config.accountIds.length > 0 && !config.accountIds.includes(conversation.zaloAccountId)) {
    return { created: false, reason: 'account_not_allowed' };
  }

  if (!ignoreTiming) {
    const hour = vnHour();
    if (hour < config.hourStart || hour >= config.hourEnd) {
      return { created: false, reason: 'outside_hours', detail: `giờ VN hiện tại ${hour}` };
    }
  }

  const blocked = matchesAnyKeyword(text, config.blockedKeywords);
  if (blocked) return { created: false, reason: 'blocked_keyword', detail: blocked };

  /* Vừa sinh nháp cho hội thoại này → khỏi sinh dồn khi khách nhắn liên tiếp. */
  if (!ignoreTiming && config.minGapSeconds > 0) {
    const since = new Date(Date.now() - config.minGapSeconds * 1000);
    const recent = await prisma.autoReplyDraft.findFirst({
      where: { conversationId, createdAt: { gte: since } },
      select: { id: true },
    });
    if (recent) return { created: false, reason: 'too_soon' };
  }

  /* Đang có người trực trả lời thì để người trực làm. */
  if (!ignoreTiming && config.skipIfStaffRepliedWithinMin > 0) {
    const since = new Date(Date.now() - config.skipIfStaffRepliedWithinMin * 60_000);
    const staffReply = await prisma.message.findFirst({
      where: { conversationId, senderType: 'self', sentVia: 'user', sentAt: { gte: since } },
      select: { id: true },
    });
    if (staffReply) return { created: false, reason: 'staff_just_replied' };
  }

  const todayCount = await prisma.autoReplyDraft.count({
    where: { orgId, createdAt: { gte: startOfVnDay() } },
  });
  if (todayCount >= config.maxDraftsPerDay) {
    return { created: false, reason: 'daily_cap', detail: `${todayCount}/${config.maxDraftsPerDay}` };
  }

  const aiConfig = await getAiConfig(orgId);
  if (!aiConfig.enabled) return { created: false, reason: 'ai_disabled' };
  const apiKey = await getProviderApiKey(orgId, aiConfig.provider);
  if (!apiKey) return { created: false, reason: 'no_provider_key' };

  /* ── Gọi AI ──────────────────────────────────────────────────────────── */
  const ctx = await buildAutoReplyContext({ orgId, conversationId, contactId, incomingText: text });
  const started = Date.now();
  const raw = await generateText(
    aiConfig.provider,
    apiKey,
    aiConfig.model,
    buildAutoReplyPrompt(config.extraInstruction),
    renderContextForPrompt(ctx),
    900,
  );
  const latencyMs = Date.now() - started;

  const parsed = parseAiJson(raw);
  if (!parsed) {
    logger.warn(`[auto-reply] AI trả về không đúng JSON, bỏ nháp. conv=${conversationId} raw=${raw.slice(0, 160)}`);
    throw new Error('AI trả về nội dung không đọc được');
  }

  /* Nháp cũ còn treo của cùng hội thoại coi như lỗi thời. */
  await prisma.autoReplyDraft.updateMany({
    where: { conversationId, state: 'pending' },
    data: { state: 'superseded' },
  });

  const draft = await prisma.autoReplyDraft.create({
    data: {
      id: randomUUID(),
      orgId,
      conversationId,
      contactId,
      sourceMessageId: messageId,
      content: parsed.reply,
      rationale: parsed.rationale ?? null,
      playbookUsed: parsed.playbookUsed ?? [],
      provider: aiConfig.provider,
      model: aiConfig.model,
      latencyMs,
    },
    select: { id: true, content: true, rationale: true, playbookUsed: true, createdAt: true },
  });

  /* Đẩy lên khung chat của mọi người trong org đang mở app. */
  try {
    zaloPool.getIO()?.to(`org:${orgId}`).emit('autoreply:draft', {
      draftId: draft.id,
      conversationId,
      content: draft.content,
      rationale: draft.rationale,
      playbookUsed: draft.playbookUsed,
      createdAt: draft.createdAt.toISOString(),
    });
  } catch (err) {
    logger.warn('[auto-reply] emit socket thất bại:', err);
  }

  logger.info(`[auto-reply] đã soạn nháp conv=${conversationId} draft=${draft.id} ${latencyMs}ms`);
  return { created: true, draftId: draft.id, content: draft.content };
}

/** Nháp quá hạn thì không hiện nữa — gọi khi FE hỏi nháp của một hội thoại. */
export async function expireStaleDrafts(orgId: string, ttlMinutes: number) {
  const cutoff = new Date(Date.now() - ttlMinutes * 60_000);
  await prisma.autoReplyDraft.updateMany({
    where: { orgId, state: 'pending', createdAt: { lt: cutoff } },
    data: { state: 'expired' },
  });
}
