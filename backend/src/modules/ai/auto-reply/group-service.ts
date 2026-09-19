/**
 * group-service.ts — AI tự trả lời trong NHÓM Zalo được chỉ định.
 *
 * KHÁC phần 1-1 (draft-service): ở đây AI TỰ GỬI tin vào nhóm. Vì vậy hàng rào
 * chặt hơn. Chế độ thường: AI được quyền IM LẶNG. Chế độ luôn trả lời (alwaysReply):
 * không im, câu không có thông tin thì ghi nhận + hẹn người thật, KHÔNG bịa.
 *
 * Mỗi lượt xét cả ĐỢT tin người khác gửi từ lần xét trước (tối đa 15 tin / 10 phút),
 * gộp trả lời thành một tin gọi @tên từng người — không bỏ sót câu hỏi giữa đợt, và
 * ít tin hơn nên nick không bị Zalo đánh dấu spam.
 *
 * Thứ tự cổng chặn (dừng ở cổng đầu tiên không qua):
 *   1. công tắc tổng nhóm bật + nhóm này bật riêng
 *   2. đúng là nhóm, tin dạng chữ, do người khác gửi (không phải nick nào của org)
 *   3. tin mới (≤ 5 phút) — chặn trả lời hàng loạt tin cũ khi nick đồng bộ lại
 *   4. không chứa từ khoá nhạy cảm
 *   5. trong khung giờ của nhóm
 *   6. đủ khoảng nghỉ từ lần AI gửi trước + chưa chạm trần số tin mỗi giờ
 *   7. đúng chế độ kích hoạt (gọi tên / câu hỏi / mọi tin)
 *   8. AI đang bật + có khoá, nick đang kết nối, không vướng giới hạn tần suất Zalo
 *   9. AI tự quyết: trả lời hay im lặng
 *
 * Chạy thử (dryRun): bỏ qua cổng 1, 3, 5, 6, 7 để quản trị viên xem trước AI sẽ nói gì,
 * nhưng KHÔNG BAO GIỜ gửi. Từ khoá nhạy cảm vẫn chặn để thấy đúng hành vi thật.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { zaloPool } from '../../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../../zalo/zalo-rate-limiter.js';
import { getAiConfig, getProviderApiKey, generateText } from '../ai-service.js';
import { buildGroupAutoReplyPrompt } from '../prompts/group-auto-reply.js';
import { getAutoReplyConfig } from './config-service.js';
import { matchesAnyKeyword, pickPlaybook } from './context-builder.js';
import { renderBrainForPrompt, learnFromGroup } from './brain-service.js';

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_MESSAGE_AGE_MS = 5 * 60_000;
const HISTORY_LIMIT = 30;
const DEBOUNCE_MS = 12_000;

export type TriggerMode = 'mention' | 'question' | 'all';
export const TRIGGER_MODES: TriggerMode[] = ['mention', 'question', 'all'];

export type GroupRuleShape = {
  conversationId: string;
  enabled: boolean;
  triggerMode: TriggerMode;
  callNames: string[];
  instruction: string | null;
  maxRepliesPerHour: number;
  minGapSeconds: number;
  hourStart: number;
  hourEnd: number;
  quoteOriginal: boolean;
  alwaysReply: boolean;
  speakerRole: string | null;
  selfPronoun: string | null;
  groupPronoun: string | null;
  memberPronoun: string | null;
  brainEnabled: boolean;
};

export const DEFAULT_RULE: Omit<GroupRuleShape, 'conversationId'> = {
  enabled: false,
  triggerMode: 'question',
  callNames: [],
  instruction: null,
  maxRepliesPerHour: 6,
  minGapSeconds: 120,
  hourStart: 7,
  hourEnd: 22,
  quoteOriginal: true,
  alwaysReply: false,
  speakerRole: null,
  selfPronoun: null,
  groupPronoun: null,
  memberPronoun: null,
  brainEnabled: true,
};

export type GroupDecision = {
  decision: 'sent' | 'ai_declined' | 'skipped' | 'failed' | 'dry_run';
  reason: string;
  content?: string | null;
  shouldReply?: boolean;
  wouldTrigger?: boolean;
  latencyMs?: number;
  batchSize?: number;
  /* Bị chặn vì đang trong thời gian nghỉ / chạm trần giờ → hẹn quay lại sau
     khoảng này, để tin không bị bỏ rơi (quan trọng ở chế độ luôn trả lời). */
  retryAfterMs?: number;
};

/* ── Tiện ích ─────────────────────────────────────────────────────────── */

function fold(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

function vnHour(now = new Date()) {
  return new Date(now.getTime() + VN_OFFSET_MS).getUTCHours();
}

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/* Dấu hiệu câu hỏi tiếng Việt — đủ để lọc thô trước khi tốn một lượt gọi AI.
   AI vẫn là người quyết cuối cùng có trả lời hay không. */
const QUESTION_HINTS = [
  'khong a', 'ko a', 'k a', 'khong nhi', 'duoc khong', 'dc khong', 'duoc ko',
  'the nao', 'nhu the nao', 'lam sao', 'sao vay', 'tai sao', 'vi sao',
  'bao gio', 'khi nao', 'luc nao', 'o dau', 'cho nao', 'bao nhieu', 'may gio',
  'cho hoi', 'cho em hoi', 'cho minh hoi', 'hoi chut', 'ai biet', 'co ai', 'co ban nao',
  'la gi', 'gi vay', 'gi a', 'nao a', 'phai khong', 'dung khong',
];

export function isCalled(text: string, nickName: string | null, callNames: string[]): boolean {
  const hay = fold(text);
  if (nickName && hay.includes(`@${fold(nickName)}`)) return true;
  return callNames.some((n) => {
    const needle = fold(String(n)).trim();
    if (!needle) return false;
    // khớp nguyên từ để "ad" không dính vào "admin", "adidas"
    return new RegExp(`(^|[^a-z0-9])@?${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay);
  });
}

export function looksLikeQuestion(text: string): boolean {
  if (text.includes('?')) return true;
  const hay = ` ${fold(text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
  return QUESTION_HINTS.some((h) => hay.includes(` ${h} `) || hay.endsWith(` ${h} `));
}

function passesTrigger(mode: TriggerMode, text: string, nickName: string | null, callNames: string[]) {
  if (mode === 'all') return true;
  const called = isCalled(text, nickName, callNames);
  if (mode === 'mention') return called;
  return called || looksLikeQuestion(text);
}

function parseDecision(raw: string): { shouldReply: boolean; reply: string; reason: string } | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const p = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const reply = typeof p.reply === 'string' ? p.reply.trim() : '';
    return {
      shouldReply: p.shouldReply === true && reply.length > 0,
      reply,
      reason: typeof p.reason === 'string' ? p.reason : '',
    };
  } catch {
    return null;
  }
}

/* Trích dẫn tin gốc để trong nhóm đông ai cũng biết AI đang trả lời ai.
   Cùng định dạng route chat sẵn có dùng — không sửa file gốc, chép logic sang đây. */
function buildQuote(m: { zaloMsgId: string | null; senderUid: string | null; content: string | null; sentAt: Date }) {
  if (!m.zaloMsgId || !m.senderUid) return null;
  return {
    content: m.content ?? '',
    msgType: 'webchat',
    propertyExt: {},
    uidFrom: m.senderUid,
    msgId: m.zaloMsgId,
    cliMsgId: m.zaloMsgId,
    ts: String(m.sentAt.getTime()),
    ttl: 0,
  };
}


/* ── Lớp chặn cứng: KHÔNG BAO GIỜ được chối là AI ────────────────────────
 * Prompt dặn thôi chưa đủ: khi bị thành viên hỏi thẳng, mô hình có thể khẳng
 * định mình là người thật, và còn bắt chước lời chối cũ nếu nó nằm trong lịch sử
 * nhóm. Nên kiểm bằng code, SAU khi AI viết, TRƯỚC khi gửi. */
const IDENTITY_Q = /(\bbot\b|agent|\bai\b|tu dong|may tra loi|nguoi that|thay that|robot|chatgpt|tro ly ao)/;
const DENIAL = /(khong phai (la )?(agent|bot|ai|may|robot|tro ly)|chinh la thay|nguoi that|truc tiep nhan chinh la|khong phai bot|thay truc tiep (nhan|tra loi|go)|dang noi chuyen voi thay that|khong dung ai)/;

export function asksIdentity(text: string) {
  return IDENTITY_Q.test(fold(text));
}

function honestLine(self: string | null, mention?: string) {
  const who = self || 'người phụ trách nhóm';
  return `${mention ? `${mention} ` : ''}Tin này là trợ lý AI của ${who} trả lời nhé. ${who.charAt(0).toUpperCase()}${who.slice(1)} vẫn theo dõi nhóm và sẽ trực tiếp trả lời những câu quan trọng.`;
}

/** Thay mọi dòng chối là AI bằng câu thành thật; đợt có câu hỏi danh tính mà
 *  câu trả lời không hề nhận là AI thì thêm một dòng thành thật. */
export function enforceHonesty(reply: string, batchText: string, self: string | null, names: string[] = []): { text: string; fixed: boolean } {
  let fixed = false;
  // tên dài khớp trước để "@Thanh Hà" không bị cắt thành "@Thanh"
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const lines = reply.split('\n').map((line) => {
    if (!DENIAL.test(fold(line))) return line;
    fixed = true;
    const trimmed = line.trimStart();
    const hit = trimmed.startsWith('@') ? sorted.find((n) => trimmed.startsWith(`@${n}`)) : undefined;
    const mention = hit ? `@${hit}` : (trimmed.match(/^@\S+/)?.[0]);
    return honestLine(self, mention);
  });
  let text = lines.join('\n');
  if (asksIdentity(batchText) && !/(\bai\b|tro ly)/.test(fold(text))) {
    text = `${text}\n${honestLine(self)}`;
    fixed = true;
  }
  return { text, fixed };
}

/* ── Quy tắc theo nhóm ────────────────────────────────────────────────── */

export async function getGroupRule(conversationId: string): Promise<GroupRuleShape> {
  const row = await prisma.groupAutoReplyRule.findUnique({ where: { conversationId } });
  if (!row) return { conversationId, ...DEFAULT_RULE };
  return {
    conversationId,
    enabled: row.enabled,
    triggerMode: (TRIGGER_MODES.includes(row.triggerMode as TriggerMode) ? row.triggerMode : 'question') as TriggerMode,
    callNames: Array.isArray(row.callNames) ? (row.callNames as string[]) : [],
    instruction: row.instruction,
    maxRepliesPerHour: row.maxRepliesPerHour,
    minGapSeconds: row.minGapSeconds,
    hourStart: row.hourStart,
    hourEnd: row.hourEnd,
    quoteOriginal: row.quoteOriginal,
    alwaysReply: row.alwaysReply,
    speakerRole: row.speakerRole,
    selfPronoun: row.selfPronoun,
    groupPronoun: row.groupPronoun,
    memberPronoun: row.memberPronoun,
    brainEnabled: row.brainEnabled,
  };
}

export function validateRuleInput(input: Partial<GroupRuleShape>): string | null {
  if (input.triggerMode !== undefined && !TRIGGER_MODES.includes(input.triggerMode)) return 'Chế độ kích hoạt không hợp lệ';
  if (input.callNames !== undefined) {
    if (!Array.isArray(input.callNames) || input.callNames.some((n) => typeof n !== 'string')) return 'Tên gọi phải là mảng chuỗi';
    if (input.callNames.length > 20) return 'Tối đa 20 tên gọi';
  }
  if (input.instruction !== undefined && input.instruction !== null && input.instruction.length > 3000) return 'Lời dặn tối đa 3000 ký tự';
  if (input.maxRepliesPerHour !== undefined && (!Number.isInteger(input.maxRepliesPerHour) || input.maxRepliesPerHour < 1 || input.maxRepliesPerHour > 60)) {
    return 'Số tin mỗi giờ phải từ 1 đến 60';
  }
  if (input.minGapSeconds !== undefined && (!Number.isInteger(input.minGapSeconds) || input.minGapSeconds < 30 || input.minGapSeconds > 3600)) {
    return 'Khoảng nghỉ phải từ 30 đến 3600 giây — dưới 30 giây dễ bị Zalo đánh dấu spam';
  }
  if (input.hourStart !== undefined || input.hourEnd !== undefined) {
    const s = input.hourStart ?? 0;
    const e = input.hourEnd ?? 23;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 23 || s >= e) return 'Khung giờ 0-23, giờ bắt đầu nhỏ hơn giờ kết thúc';
  }
  if (input.alwaysReply !== undefined && typeof input.alwaysReply !== 'boolean') return 'alwaysReply phải là true hoặc false';
  if (input.brainEnabled !== undefined && typeof input.brainEnabled !== 'boolean') return 'brainEnabled phải là true hoặc false';
  for (const [key, max, label] of [
    ['speakerRole', 200, 'Vai trò'], ['selfPronoun', 30, 'Tự xưng'],
    ['groupPronoun', 40, 'Cách gọi cả nhóm'], ['memberPronoun', 40, 'Cách gọi một người'],
  ] as const) {
    const v = input[key];
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > max)) return `${label} tối đa ${max} ký tự`;
  }
  return null;
}

export async function upsertGroupRule(orgId: string, conversationId: string, userId: string, input: Partial<GroupRuleShape>) {
  const data = {
    enabled: input.enabled,
    triggerMode: input.triggerMode,
    callNames: input.callNames,
    instruction: input.instruction === undefined ? undefined : (input.instruction?.trim() || null),
    maxRepliesPerHour: input.maxRepliesPerHour,
    minGapSeconds: input.minGapSeconds,
    hourStart: input.hourStart,
    hourEnd: input.hourEnd,
    quoteOriginal: input.quoteOriginal,
    alwaysReply: input.alwaysReply,
    speakerRole: input.speakerRole === undefined ? undefined : (input.speakerRole?.trim() || null),
    selfPronoun: input.selfPronoun === undefined ? undefined : (input.selfPronoun?.trim() || null),
    groupPronoun: input.groupPronoun === undefined ? undefined : (input.groupPronoun?.trim() || null),
    memberPronoun: input.memberPronoun === undefined ? undefined : (input.memberPronoun?.trim() || null),
    brainEnabled: input.brainEnabled,
    updatedById: userId,
  };
  await prisma.groupAutoReplyRule.upsert({
    where: { conversationId },
    create: { orgId, conversationId, ...DEFAULT_RULE, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) },
    update: data,
  });
  return getGroupRule(conversationId);
}

/* ── Lõi: xét một tin và quyết định ───────────────────────────────────── */

async function log(orgId: string, conversationId: string, sourceMessageId: string | null, d: GroupDecision & { zaloMsgId?: string | null }) {
  try {
    await prisma.groupAutoReplyLog.create({
      data: {
        orgId, conversationId, sourceMessageId,
        decision: d.decision,
        reason: d.reason?.slice(0, 500) ?? null,
        content: d.content ?? null,
        zaloMsgId: d.zaloMsgId ?? null,
        latencyMs: d.latencyMs ?? null,
      },
    });
  } catch (err) {
    logger.warn('[group-auto-reply] ghi nhật ký lỗi:', err);
  }
}

type PendingMsg = {
  id: string; senderUid: string | null; senderName: string | null;
  content: string | null; contentType: string; zaloMsgId: string | null; sentAt: Date;
};

const BATCH_LIMIT = 15;
const BATCH_WINDOW_MS = 10 * 60_000;

/**
 * Đợt tin cần xử lý = mọi tin chữ do NGƯỜI KHÁC gửi kể từ lần xét thật gần nhất
 * (tối đa 15 tin, trong 10 phút). Nhờ vậy câu hỏi giữa đợt không bị bỏ sót như
 * bản đầu (bản đầu chỉ xét tin cuối).
 */
async function loadPendingBatch(orgId: string, conversationId: string, ownUids: Set<string>, dryRun: boolean, backlogSince?: Date): Promise<PendingMsg[]> {
  if (backlogSince) {
    /* Trả lời tồn đọng: mọi tin người khác gửi từ mốc chỉ định mà SAU tin cuối
       nick đã gửi vào nhóm (tin nào nhóm đã được đáp rồi thì thôi). */
    const lastSelf = await prisma.message.findFirst({
      where: { conversationId, senderType: 'self', sentAt: { gt: backlogSince } },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    });
    const from = lastSelf ? lastSelf.sentAt : backlogSince;
    const rows = await prisma.message.findMany({
      where: { conversationId, senderType: 'contact', isDeleted: false, contentType: { in: ['text', 'rich'] }, sentAt: { gt: from } },
      orderBy: { sentAt: 'asc' },
      take: 25,
      select: { id: true, senderUid: true, senderName: true, content: true, contentType: true, zaloMsgId: true, sentAt: true },
    });
    return rows.filter((m) => !(m.senderUid && ownUids.has(m.senderUid)) && (m.content ?? '').trim());
  }
  const lastHandled = dryRun ? null : await prisma.groupAutoReplyLog.findFirst({
    where: { conversationId, decision: { in: ['sent', 'ai_declined'] } },
    orderBy: { createdAt: 'desc' },
    select: { sourceMessageId: true, createdAt: true },
  });
  let since = new Date(Date.now() - BATCH_WINDOW_MS);
  if (lastHandled?.sourceMessageId) {
    const src = await prisma.message.findUnique({ where: { id: lastHandled.sourceMessageId }, select: { sentAt: true } });
    if (src && src.sentAt > since) since = src.sentAt;
  }

  const rows = await prisma.message.findMany({
    where: {
      conversationId, senderType: 'contact', isDeleted: false,
      contentType: { in: ['text', 'rich'] },
      ...(dryRun ? {} : { sentAt: { gt: since } }),
    },
    orderBy: { sentAt: 'desc' },
    take: BATCH_LIMIT,
    select: { id: true, senderUid: true, senderName: true, content: true, contentType: true, zaloMsgId: true, sentAt: true },
  });
  const batch = rows.filter((m) => !(m.senderUid && ownUids.has(m.senderUid)) && (m.content ?? '').trim()).reverse();
  // chạy thử: chỉ lấy đợt dồn cuối cùng (các tin cách nhau không quá 2 phút)
  if (dryRun && batch.length > 1) {
    let start = batch.length - 1;
    while (start > 0 && batch[start].sentAt.getTime() - batch[start - 1].sentAt.getTime() < 120_000) start--;
    return batch.slice(start);
  }
  return batch;
}

export async function evaluateGroupMessage(input: {
  orgId: string;
  conversationId: string;
  messageId?: string;     // giữ để tương thích; đợt tin được tự xác định
  dryRun?: boolean;
  /* Trả lời tồn đọng từ mốc này: bỏ giới hạn "tin cũ hơn 5 phút" và chế độ kích
     hoạt, vì chính người quản trị chủ động yêu cầu. Các cổng khác vẫn giữ. */
  backlogSince?: Date;
}): Promise<GroupDecision> {
  const { orgId, conversationId } = input;
  const dryRun = input.dryRun === true;
  const backlog = input.backlogSince;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, orgId },
    select: {
      id: true, threadType: true, groupName: true, externalThreadId: true, zaloAccountId: true,
      zaloAccount: { select: { id: true, zaloUid: true, displayName: true, privacyMode: true, ownerUserId: true } },
    },
  });
  if (!conversation || conversation.threadType !== 'group') {
    return { decision: 'skipped', reason: 'Không phải hội thoại nhóm' };
  }

  const [config, rule] = await Promise.all([getAutoReplyConfig(orgId), getGroupRule(conversationId)]);

  if (!dryRun) {
    if (!config.groupEnabled) return { decision: 'skipped', reason: 'Công tắc tổng trả lời nhóm đang tắt' };
    if (!rule.enabled) return { decision: 'skipped', reason: 'Nhóm này chưa bật trả lời tự động' };
  }

  /* Nick Zalo của chính tổ chức — không bao giờ trả lời, tránh 2 bot đối đáp vô tận. */
  const ownNicks = await prisma.zaloAccount.findMany({ where: { orgId }, select: { zaloUid: true } });
  const ownUids = new Set(ownNicks.map((n) => n.zaloUid).filter((v): v is string => !!v));

  const batch = await loadPendingBatch(orgId, conversationId, ownUids, dryRun, backlog);
  if (batch.length === 0) return { decision: 'skipped', reason: 'Không có tin mới cần xử lý' };
  const last = batch[batch.length - 1];

  if (!dryRun && !backlog && Date.now() - last.sentAt.getTime() > MAX_MESSAGE_AGE_MS) {
    return { decision: 'skipped', reason: 'Tin cũ hơn 5 phút' };
  }

  /* Từ khoá nhạy cảm: bỏ riêng tin đó ra khỏi đợt. Cả đợt đều nhạy cảm thì dừng. */
  const blockedHits: string[] = [];
  const workable = batch.filter((m) => {
    const hit = matchesAnyKeyword(m.content ?? '', config.blockedKeywords);
    if (hit) blockedHits.push(`${m.senderName || 'thành viên'}: "${hit}"`);
    return !hit;
  });
  if (workable.length === 0) {
    const d: GroupDecision = { decision: 'skipped', reason: `Có từ khoá cần người thật xử lý: ${blockedHits.join('; ')}` };
    if (!dryRun) await log(orgId, conversationId, last.id, d);
    return d;
  }

  const nickName = conversation.zaloAccount?.displayName ?? null;
  const wouldTrigger = workable.some((m) => passesTrigger(rule.triggerMode, m.content ?? '', nickName, rule.callNames));

  if (!dryRun) {
    const hour = vnHour();
    if (hour < rule.hourStart || hour >= rule.hourEnd) return { decision: 'skipped', reason: `Ngoài khung giờ (${hour}h)` };

    const lastSent = await prisma.groupAutoReplyLog.findFirst({
      where: { conversationId, decision: 'sent' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (lastSent) {
      const wait = rule.minGapSeconds * 1000 - (Date.now() - lastSent.createdAt.getTime());
      if (wait > 0) return { decision: 'skipped', reason: 'Chưa đủ khoảng nghỉ từ lần trả lời trước', retryAfterMs: wait + 500 };
    }
    const sentLastHour = await prisma.groupAutoReplyLog.findMany({
      where: { conversationId, decision: 'sent', createdAt: { gte: new Date(Date.now() - 3600_000) } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (sentLastHour.length >= rule.maxRepliesPerHour) {
      const wait = sentLastHour[0].createdAt.getTime() + 3600_000 - Date.now();
      return { decision: 'skipped', reason: `Đã chạm trần ${rule.maxRepliesPerHour} tin/giờ`, retryAfterMs: Math.max(wait, 30_000) };
    }

    if (!backlog && !rule.alwaysReply && !wouldTrigger) return { decision: 'skipped', reason: 'Tin không khớp chế độ kích hoạt' };
  }

  const aiConfig = await getAiConfig(orgId);
  if (!aiConfig.enabled) return { decision: 'skipped', reason: 'AI đang tắt cho tổ chức' };
  const apiKey = await getProviderApiKey(orgId, aiConfig.provider);
  if (!apiKey) return { decision: 'skipped', reason: 'Chưa cấu hình khoá AI' };

  /* ── Ngữ cảnh nhóm ── */
  const batchText = workable.map((m) => m.content ?? '').join('\n');
  const [history, playbook, brainText] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId, isDeleted: false, sentAt: { lt: workable[0].sentAt } },
      orderBy: { sentAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { senderType: true, senderName: true, content: true, contentType: true, sentAt: true, sentVia: true },
    }),
    pickPlaybook(orgId, batchText, 5),
    rule.brainEnabled ? renderBrainForPrompt(conversationId) : Promise.resolve(''),
  ]);

  const botName = nickName || 'trợ lý';
  const fmt = (d: Date) => new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(11, 16);
  const historyText = [...history].reverse().map((m) => {
    const who = m.senderType === 'self'
      ? (m.sentVia === 'automation' ? `${botName} [TRỢ LÝ AI đã trả lời — có thể sai, không bắt chước]` : `${botName} [người thật gõ tay]`)
      : (m.senderName || 'thành viên');
    const body = m.contentType === 'text' || m.contentType === 'rich' ? clip(m.content ?? '', 350) : `(gửi ${m.contentType})`;
    return `[${fmt(m.sentAt)}] ${who}: ${body}`;
  }).join('\n') || '(chưa có)';

  const playbookText = playbook.length
    ? playbook.map((p) => `### ${p.title}${p.category ? ` [${p.category}]` : ''}\n${p.content}`).join('\n')
    : '(Chưa có kịch bản. KHÔNG được nêu giá hay chính sách.)';

  const userPrompt = [
    ...(brainText ? ['<kien_thuc_nhom_da_hoc>', brainText, '</kien_thuc_nhom_da_hoc>', ''] : []),
    '<kich_ban_ban_hang>', playbookText, '</kich_ban_ban_hang>', '',
    '<lich_su_nhom_truoc_do>', historyText, '</lich_su_nhom_truoc_do>', '',
    `<dot_tin_can_xu_ly so_tin="${workable.length}">`,
    ...workable.map((m) => `[${fmt(m.sentAt)}] ${m.senderName || 'thành viên'}: ${clip(m.content ?? '', 500)}`),
    '</dot_tin_can_xu_ly>',
  ].join('\n');

  const started = Date.now();
  let raw: string;
  try {
    raw = await generateText(
      aiConfig.provider, apiKey, aiConfig.model,
      buildGroupAutoReplyPrompt({
        groupName: conversation.groupName || 'nhóm',
        botName,
        instruction: rule.instruction,
        orgInstruction: config.extraInstruction,
        alwaysReply: rule.alwaysReply,
        persona: {
          speakerRole: rule.speakerRole,
          selfPronoun: rule.selfPronoun,
          groupPronoun: rule.groupPronoun,
          memberPronoun: rule.memberPronoun,
        },
      }),
      userPrompt,
      1200,
    );
  } catch (err) {
    const d: GroupDecision = { decision: 'failed', reason: `Gọi AI lỗi: ${err instanceof Error ? err.message.slice(0, 200) : 'không rõ'}`, batchSize: workable.length };
    if (!dryRun) await log(orgId, conversationId, last.id, d);
    return d;
  }
  const latencyMs = Date.now() - started;

  const parsed = parseDecision(raw);
  if (!parsed) {
    const d: GroupDecision = { decision: 'failed', reason: 'AI trả về nội dung không đọc được', latencyMs, batchSize: workable.length };
    if (!dryRun) await log(orgId, conversationId, last.id, d);
    return d;
  }
  /* Lớp chặn cứng về trung thực — áp cho cả chạy thử để thấy đúng hành vi thật. */
  let honestyFixed = false;
  if (parsed.reply) {
    const h = enforceHonesty(parsed.reply, batchText, rule.selfPronoun, workable.map((m) => m.senderName || ''));
    if (h.fixed) {
      honestyFixed = true;
      parsed.reply = h.text;
      if (asksIdentity(batchText)) parsed.shouldReply = true;
      logger.warn(`[group-auto-reply] đã sửa câu chối là AI trước khi gửi conv=${conversationId}`);
    }
  } else if (asksIdentity(batchText)) {
    parsed.reply = honestLine(rule.selfPronoun);
    parsed.shouldReply = true;
    honestyFixed = true;
  }

  /* Chế độ luôn trả lời: AI không được phép im. Nếu nó vẫn trả shouldReply=false
     mà có nội dung thì dùng nội dung; không có nội dung thì ghi lỗi để thấy. */
  if (rule.alwaysReply && !parsed.shouldReply && parsed.reply) parsed.shouldReply = true;

  if (dryRun) {
    const d: GroupDecision = {
      decision: 'dry_run',
      shouldReply: parsed.shouldReply,
      wouldTrigger,
      content: parsed.shouldReply ? parsed.reply : null,
      reason: `${parsed.reason || (parsed.shouldReply ? 'AI chọn trả lời' : 'AI chọn im lặng')}${honestyFixed ? ' [đã sửa câu về danh tính AI]' : ''}`,
      latencyMs,
      batchSize: workable.length,
    };
    await log(orgId, conversationId, last.id, d);
    return d;
  }

  if (!parsed.shouldReply) {
    const d: GroupDecision = {
      decision: rule.alwaysReply ? 'failed' : 'ai_declined',
      reason: rule.alwaysReply ? `Chế độ luôn trả lời nhưng AI không đưa nội dung: ${parsed.reason}` : (parsed.reason || 'AI chọn im lặng'),
      latencyMs, batchSize: workable.length,
    };
    await log(orgId, conversationId, last.id, d);
    return d;
  }

  /* ── Gửi thật ─────────────────────────────────────────────────────────── */
  const accountId = conversation.zaloAccountId;
  const instance = zaloPool.getInstance(accountId);
  if (!instance?.api) {
    const d: GroupDecision = { decision: 'failed', reason: 'Nick Zalo đang mất kết nối', content: parsed.reply, latencyMs };
    await log(orgId, conversationId, last.id, d);
    return d;
  }
  const limits = await zaloRateLimiter.checkLimits(accountId);
  if (!limits.allowed) {
    const d: GroupDecision = { decision: 'skipped', reason: `Giới hạn tần suất Zalo: ${limits.reason ?? ''}`, content: parsed.reply, latencyMs, retryAfterMs: 60_000 };
    await log(orgId, conversationId, last.id, d);
    return d;
  }

  /* Trích dẫn chỉ khi đợt có đúng một người hỏi. Nhiều người thì AI đã gọi @tên
     từng người trong nội dung — trích một tin sẽ gây hiểu nhầm. */
  const askers = new Set(workable.map((m) => m.senderUid || m.senderName));
  const quote = rule.quoteOriginal && askers.size === 1 ? buildQuote(last) : null;

  let zaloMsgId = '';
  try {
    zaloRateLimiter.recordSend(accountId);
    const payload: Record<string, unknown> = { msg: parsed.reply };
    if (quote) payload.quote = quote;
    const result = await instance.api.sendMessage(payload, conversation.externalThreadId || '', 1);
    const sr = result as unknown as { message?: { msgId?: number | string } | null; attachment?: Array<{ msgId?: number | string }> };
    zaloMsgId = String(sr?.message?.msgId ?? sr?.attachment?.[0]?.msgId ?? '');
  } catch (err) {
    const d: GroupDecision = { decision: 'failed', reason: `Gửi Zalo lỗi: ${err instanceof Error ? err.message.slice(0, 200) : 'không rõ'}`, content: parsed.reply, latencyMs };
    await log(orgId, conversationId, last.id, d);
    return d;
  }

  try {
    const saved = await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId,
        zaloMsgId: zaloMsgId || null,
        zaloMsgIdNum: zaloMsgId && /^\d+$/.test(zaloMsgId) ? BigInt(zaloMsgId) : null,
        senderType: 'self',
        senderUid: conversation.zaloAccount?.zaloUid || '',
        senderName: botName,
        content: parsed.reply,
        contentType: 'text',
        quote: quote ?? undefined,
        sentAt: new Date(),
        sentVia: 'automation',
      },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });

    const io = zaloPool.getIO() as Server | null;
    io?.to(`org:${orgId}`).emit('chat:message', {
      accountId,
      conversationId,
      message: { ...saved, zaloMsgIdNum: saved.zaloMsgIdNum?.toString() ?? null },
      _privacyMeta: {
        privacyMode: conversation.zaloAccount?.privacyMode,
        ownerUserId: conversation.zaloAccount?.ownerUserId,
      },
    });
  } catch (err) {
    logger.warn('[group-auto-reply] đã gửi Zalo nhưng lưu tin lỗi:', err);
  }

  const d: GroupDecision = {
    decision: 'sent',
    reason: `${parsed.reason || 'AI trả lời'} (gộp ${workable.length} tin${blockedHits.length ? `, bỏ ${blockedHits.length} tin nhạy cảm` : ''}${honestyFixed ? ', đã sửa câu về danh tính AI' : ''})`,
    content: parsed.reply, latencyMs, batchSize: workable.length,
  };
  await log(orgId, conversationId, last.id, { ...d, zaloMsgId });
  logger.info(`[group-auto-reply] đã trả lời nhóm "${conversation.groupName}" gộp ${workable.length} tin, ${latencyMs}ms`);
  return d;
}

/* ── Gom tin: chờ nhóm im 12 giây rồi mới xét tin cuối ──────────────────
 * Nhóm hay nhắn dồn nhiều tin liền nhau. Xét từng tin sẽ vừa tốn AI vừa trả lời
 * lắp bắp. Mỗi tin mới đặt lại đồng hồ; chỉ tin cuối cùng được xét. */
const pending = new Map<string, { timer: NodeJS.Timeout; orgId: string; messageId: string }>();
const inFlight = new Set<string>();

export function scheduleGroupEvaluation(orgId: string, conversationId: string, messageId: string) {
  const existing = pending.get(conversationId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    const job = pending.get(conversationId);
    pending.delete(conversationId);
    if (!job) return;

    if (inFlight.has(conversationId)) {
      // đang xử lý lượt trước → hẹn lại, đừng chạy song song hai lượt trong cùng nhóm
      scheduleGroupEvaluation(job.orgId, conversationId, job.messageId);
      return;
    }
    inFlight.add(conversationId);
    try {
      /* Học trước khi trả lời: nếu người thật vừa gõ gì mới trong nhóm thì AI biết
         ngay ở lượt này. Có chặn tần suất 2 phút nên không tốn thêm mỗi lượt. */
      await learnFromGroup(job.orgId, conversationId).catch(() => undefined);
      const result = await evaluateGroupMessage({ orgId: job.orgId, conversationId, messageId: job.messageId });
      if (result.decision === 'failed') {
        logger.warn(`[group-auto-reply] conv=${conversationId} ${result.reason}`);
      }
      /* Bị chặn vì đang nghỉ / chạm trần → hẹn quay lại, tin không bị bỏ rơi.
         Chỉ hẹn nếu chưa có tin mới nào đặt lịch trong lúc chờ. */
      if (result.retryAfterMs && !pending.has(conversationId)) {
        const retryIn = Math.min(result.retryAfterMs, 30 * 60_000);
        logger.info(`[group-auto-reply] conv=${conversationId} ${result.reason} → thử lại sau ${Math.round(retryIn / 1000)}s`);
        setTimeout(() => scheduleGroupEvaluation(job.orgId, conversationId, job.messageId), Math.max(retryIn - DEBOUNCE_MS, 0));
      }
    } catch (err) {
      logger.error(`[group-auto-reply] lỗi xử lý conv=${conversationId}:`, err);
    } finally {
      inFlight.delete(conversationId);
    }
  }, DEBOUNCE_MS);

  pending.set(conversationId, { timer, orgId, messageId });
}

/** Lọc rất nhanh trước khi hẹn giờ: chỉ nhóm có quy tắc bật mới đáng để chờ. */
export async function isGroupWatched(conversationId: string): Promise<{ watched: boolean; orgId?: string }> {
  const rule = await prisma.groupAutoReplyRule.findUnique({
    where: { conversationId },
    select: { enabled: true, orgId: true },
  });
  return { watched: !!rule?.enabled, orgId: rule?.orgId };
}
