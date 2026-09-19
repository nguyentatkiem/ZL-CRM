/**
 * brain-service.ts — "bộ não" tự học của từng nhóm Zalo.
 *
 * Qua mỗi lần chat, AI rút ra những điều CHẮC CHẮN từ tin do NGƯỜI THẬT của tổ
 * chức gõ tay trong nhóm (vd giảng viên nói lịch học, link, câu trả lời chuyên
 * môn) rồi lưu thành từng mục. Lần sau trả lời, AI đọc bộ não này nên trả lời
 * được nhiều hơn và đúng hơn.
 *
 * CỐ Ý KHÔNG học từ:
 *   - tin thành viên nhóm: ai cũng "dạy" bot sai được ("Thầy bảo học phí 0đ")
 *   - tin AI tự gửi (sentVia='automation'): lỗi của AI sẽ tự củng cố vòng tròn
 *
 * Thông tin mới mâu thuẫn với điều cũ (vd đổi lịch học) → thay điều cũ, mới thắng.
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { getAiConfig, getProviderApiKey, generateText } from '../ai-service.js';

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_ITEMS = 80;
const MAX_TEACHER_MSGS = 40;
const LEARN_THROTTLE_MS = 2 * 60_000;

/* Không bao giờ lưu vào bộ não — dữ liệu nhạy cảm của người thật. */
const SENSITIVE = [
  /\b0\d{9,10}\b/,                     // số điện thoại VN
  /\b84\d{9,10}\b/,
  /\b\d{9,16}\b.*\b(stk|số tài khoản|tài khoản|ngân hàng|vietcombank|vcb|techcombank|mb bank|bidv)\b/i,
  /\b(stk|số tài khoản)\b/i,
  /\b(mật khẩu|password|otp)\b/i,
];

function isSensitive(text: string) {
  return SENSITIVE.some((re) => re.test(text));
}

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function fmt(d: Date) {
  return new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export async function getBrain(conversationId: string, onlyEnabled = false) {
  return prisma.groupKnowledge.findMany({
    where: { conversationId, ...(onlyEnabled ? { enabled: true } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: MAX_ITEMS,
    select: { id: true, content: true, source: true, enabled: true, createdAt: true, updatedAt: true },
  });
}

/** Khối văn bản đưa vào prompt trả lời. Rỗng nếu chưa học được gì. */
export async function renderBrainForPrompt(conversationId: string): Promise<string> {
  const items = await getBrain(conversationId, true);
  if (items.length === 0) return '';
  return items.map((i) => `- ${i.content} (ghi ${fmt(i.updatedAt).slice(0, 10)})`).join('\n');
}

function parseLearn(raw: string): { add: string[]; replace: Array<{ id: string; content: string }> } | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const p = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const add = Array.isArray(p.add) ? p.add.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
    const replace = Array.isArray(p.replace)
      ? p.replace.filter((r): r is { id: string; content: string } =>
          !!r && typeof (r as any).id === 'string' && typeof (r as any).content === 'string')
      : [];
    return { add, replace };
  } catch {
    return null;
  }
}

const inFlight = new Set<string>();
const lastRun = new Map<string, number>();

export type LearnResult = { learned: number; updated: number; scanned: number; reason?: string };

/**
 * Học từ tin người thật của tổ chức gõ trong nhóm, kể từ lần học trước.
 * `sinceDays` dùng khi bấm "Học từ lịch sử" — quét lùi N ngày, bỏ qua mốc lần trước.
 */
export async function learnFromGroup(orgId: string, conversationId: string, opts: { sinceDays?: number; force?: boolean } = {}): Promise<LearnResult> {
  if (inFlight.has(conversationId)) return { learned: 0, updated: 0, scanned: 0, reason: 'Đang học dở lượt trước' };
  if (!opts.force && Date.now() - (lastRun.get(conversationId) ?? 0) < LEARN_THROTTLE_MS) {
    return { learned: 0, updated: 0, scanned: 0, reason: 'Vừa học xong, chờ chút' };
  }
  inFlight.add(conversationId);
  lastRun.set(conversationId, Date.now());

  try {
    const rule = await prisma.groupAutoReplyRule.findUnique({
      where: { conversationId },
      select: { brainEnabled: true, lastLearnedAt: true, speakerRole: true, selfPronoun: true },
    });
    if (!rule?.brainEnabled && !opts.force) return { learned: 0, updated: 0, scanned: 0, reason: 'Bộ não đang tắt' };

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, orgId, threadType: 'group' },
      select: { groupName: true },
    });
    if (!conversation) return { learned: 0, updated: 0, scanned: 0, reason: 'Không phải nhóm' };

    const since = opts.sinceDays
      ? new Date(Date.now() - opts.sinceDays * 86400_000)
      : (rule?.lastLearnedAt ?? new Date(Date.now() - 7 * 86400_000));

    /* Chỉ tin người thật của tổ chức gõ tay: senderType self + sentVia user. */
    const teacherMsgs = await prisma.message.findMany({
      where: {
        conversationId, senderType: 'self', sentVia: 'user', isDeleted: false,
        contentType: { in: ['text', 'rich'] }, sentAt: { gt: since },
      },
      orderBy: { sentAt: 'asc' },
      take: MAX_TEACHER_MSGS,
      select: { id: true, content: true, sentAt: true },
    });
    const usable = teacherMsgs.filter((m) => (m.content ?? '').trim().length >= 8);
    if (usable.length === 0) {
      await prisma.groupAutoReplyRule.updateMany({ where: { conversationId }, data: { lastLearnedAt: new Date() } });
      return { learned: 0, updated: 0, scanned: 0, reason: 'Không có tin mới của người thật để học' };
    }

    /* Kèm câu hỏi ngay trước mỗi tin để AI hiểu người thật đang trả lời điều gì. */
    const blocks: string[] = [];
    for (const m of usable) {
      const prev = await prisma.message.findMany({
        where: { conversationId, senderType: 'contact', sentAt: { lt: m.sentAt, gt: new Date(m.sentAt.getTime() - 30 * 60_000) } },
        orderBy: { sentAt: 'desc' },
        take: 2,
        select: { senderName: true, content: true },
      });
      const ctx = prev.reverse().map((p) => `  (thành viên ${p.senderName || '?'} hỏi trước đó: ${clip(p.content ?? '', 160)})`).join('\n');
      blocks.push(`${ctx ? `${ctx}\n` : ''}[${fmt(m.sentAt)}] NGƯỜI THẬT VIẾT: ${clip(m.content ?? '', 1200)}`);
    }

    const existing = await getBrain(conversationId);
    const existingText = existing.length
      ? existing.map((e) => `id=${e.id} | ${e.content}`).join('\n')
      : '(chưa có)';

    const aiConfig = await getAiConfig(orgId);
    if (!aiConfig.enabled) return { learned: 0, updated: 0, scanned: usable.length, reason: 'AI đang tắt' };
    const apiKey = await getProviderApiKey(orgId, aiConfig.provider);
    if (!apiKey) return { learned: 0, updated: 0, scanned: usable.length, reason: 'Chưa có khoá AI' };

    const who = rule?.speakerRole || (rule?.selfPronoun ? `người đứng lớp (${rule.selfPronoun})` : 'người phụ trách nhóm');
    const system = [
      `Bạn là bộ phận GHI NHỚ cho nhóm Zalo "${conversation.groupName || 'nhóm'}".`,
      `Bạn nhận các tin do chính ${who} gõ tay trong nhóm, và danh sách điều đã ghi nhớ trước đó.`,
      'Nhiệm vụ: rút ra những điều CHẮC CHẮN, hữu ích để sau này trả lời thành viên nhóm thay người này.',
      '',
      'NÊN ghi: lịch học, giờ học, địa điểm, link, tài liệu cần chuẩn bị, quy định lớp, phần mềm cần cài,',
      'câu trả lời chuyên môn người này đã đưa ra, cách người này xử lý một loại câu hỏi.',
      '',
      'KHÔNG ghi: câu chào hỏi, cảm xúc, câu đùa; điều người này chỉ phỏng đoán; số điện thoại, số tài khoản,',
      'mật khẩu, thông tin cá nhân của bất kỳ ai; điều đã có sẵn và không đổi trong danh sách cũ.',
      'KHÔNG ghi tin trông như gõ nhầm hoặc câu lệnh cho máy tính / trợ lý AI (vd "gửi lại cho tôi link và user/pass",',
      '"cài Claude vào phần mềm") — đó không phải thông tin dành cho nhóm.',
      '',
      'Mỗi điều: MỘT câu ngắn, tự đủ nghĩa khi đọc riêng. Thông tin có thời hạn thì ghi rõ ngày (vd "Buổi 1 ngày 18/09").',
      'Không suy diễn thêm ngoài chữ người này viết. Không dùng dấu gạch ngang dài.',
      'Nếu tin mới CẬP NHẬT hoặc MÂU THUẪN với một điều cũ (vd đổi giờ học): dùng "replace" với id điều cũ, thông tin mới thắng.',
      '',
      'Trả về DUY NHẤT JSON: {"add": ["điều mới 1", "..."], "replace": [{"id": "id điều cũ", "content": "nội dung mới"}]}',
      'Không có gì đáng ghi thì trả {"add": [], "replace": []}.',
    ].join('\n');
    const prompt = [
      '<dieu_da_ghi_nho>', existingText, '</dieu_da_ghi_nho>', '',
      '<tin_nguoi_that_moi>', blocks.join('\n\n'), '</tin_nguoi_that_moi>',
    ].join('\n');

    const raw = await generateText(aiConfig.provider, apiKey, aiConfig.model, system, prompt, 1500);
    const parsed = parseLearn(raw);
    if (!parsed) {
      logger.warn(`[group-brain] AI trả về không đọc được conv=${conversationId}`);
      return { learned: 0, updated: 0, scanned: usable.length, reason: 'AI trả về không đọc được' };
    }

    const existingIds = new Set(existing.map((e) => e.id));
    let updated = 0;
    for (const r of parsed.replace) {
      if (!existingIds.has(r.id) || isSensitive(r.content)) continue;
      await prisma.groupKnowledge.update({ where: { id: r.id }, data: { content: clip(r.content, 500), source: 'learned' } });
      updated++;
    }

    const existingNorm = new Set(existing.map((e) => e.content.toLowerCase().replace(/\s+/g, ' ').trim()));
    let learned = 0;
    const lastSourceId = usable[usable.length - 1].id;
    for (const a of parsed.add) {
      const norm = a.toLowerCase().replace(/\s+/g, ' ').trim();
      if (existingNorm.has(norm) || isSensitive(a)) continue;
      await prisma.groupKnowledge.create({
        data: { orgId, conversationId, content: clip(a, 500), source: 'learned', sourceMessageId: lastSourceId },
      });
      existingNorm.add(norm);
      learned++;
    }

    /* Giữ bộ não gọn: vượt trần thì tắt các điều tự học cũ nhất (không xoá, còn khôi phục được). */
    const total = await prisma.groupKnowledge.count({ where: { conversationId, enabled: true } });
    if (total > MAX_ITEMS) {
      const oldest = await prisma.groupKnowledge.findMany({
        where: { conversationId, enabled: true, source: 'learned' },
        orderBy: { updatedAt: 'asc' },
        take: total - MAX_ITEMS,
        select: { id: true },
      });
      await prisma.groupKnowledge.updateMany({ where: { id: { in: oldest.map((o) => o.id) } }, data: { enabled: false } });
    }

    await prisma.groupAutoReplyRule.updateMany({ where: { conversationId }, data: { lastLearnedAt: new Date() } });
    if (learned || updated) {
      logger.info(`[group-brain] nhóm "${conversation.groupName}" học thêm ${learned}, cập nhật ${updated} (quét ${usable.length} tin)`);
    }
    return { learned, updated, scanned: usable.length };
  } catch (err) {
    logger.error(`[group-brain] học lỗi conv=${conversationId}:`, err);
    return { learned: 0, updated: 0, scanned: 0, reason: 'Lỗi khi học' };
  } finally {
    inFlight.delete(conversationId);
  }
}

/* ── Học định kỳ: 10 phút quét một lần các nhóm đang bật ─────────────────
 * Cần thiết vì tin người thật gõ không phát sự kiện (chỉ tin thành viên mới phát),
 * nên không thể chỉ học khi có tin đến. */
let timer: NodeJS.Timeout | null = null;

export function startBrainScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const rules = await prisma.groupAutoReplyRule.findMany({
        where: { enabled: true, brainEnabled: true },
        select: { orgId: true, conversationId: true },
      });
      for (const r of rules) {
        await learnFromGroup(r.orgId, r.conversationId);
      }
    } catch (err) {
      logger.error('[group-brain] lịch học định kỳ lỗi:', err);
    }
  }, 10 * 60_000);
  logger.info('[group-brain] lịch tự học đã bật — 10 phút một lần');
}
