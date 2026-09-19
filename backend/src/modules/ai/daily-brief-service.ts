/**
 * daily-brief-service.ts — "Tình trạng khách hàng hôm nay" cho popup nổi.
 *
 * Hai việc:
 *   1. buildDailyBriefSnapshot() — gom số liệu + danh sách khách cần chú ý TRONG NGÀY.
 *      Chạy thuần SQL, KHÔNG gọi AI → popup hiện số ngay khi mở, không tốn quota.
 *   2. askDailyBrief() — nhét snapshot vào prompt rồi hỏi AI. Câu hỏi tự do của
 *      nhân viên đi kèm; bỏ trống thì AI tự tổng hợp theo cấu trúc mặc định.
 *
 * Phạm vi dữ liệu (quan trọng — tránh rò nick riêng tư):
 *   Chỉ gom conversation/message thuộc các nick Zalo mà user được xem. Nick
 *   privacyMode='main' chỉ chủ nick thấy, kể cả owner/admin cũng không thấy
 *   (khớp thiết kế Phase Riêng Tư 2026-05-22 — content blur cho user khác).
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { getAiConfig, getProviderApiKey, generateText } from './ai-service.js';
import { buildDailyBriefPrompt } from './prompts/daily-brief.js';

const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Ho_Chi_Minh, không DST

/** Mốc 00:00 và 24:00 hôm nay theo giờ VN, trả về Date ở UTC. */
function todayRangeVN() {
  const vnNow = new Date(Date.now() + VN_OFFSET_MS);
  const vnMidnight = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate());
  const start = new Date(vnMidnight - VN_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 86400000) };
}

function vnDateLabel(d: Date) {
  return new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Rút gọn preview tin nhắn để prompt không phình + không lộ cả đoạn chat. */
function preview(text: string | null | undefined, max = 120) {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function minutesSince(d: Date | null | undefined, now: number) {
  return d ? Math.round((now - d.getTime()) / 60000) : null;
}

export type AccessScope = { accountIds: string[]; deniedPrivateCount: number };

/**
 * Danh sách nick Zalo user được phép xem nội dung.
 *   - owner/admin: mọi nick chưa archive, TRỪ nick 'main' của người khác
 *   - còn lại: nick mình sở hữu + nick được cấp ZaloAccountAccess, cùng loại trừ trên
 */
export async function resolveAccessibleAccounts(user: { id: string; orgId: string; role: string }): Promise<AccessScope> {
  const accounts = await prisma.zaloAccount.findMany({
    where: { orgId: user.orgId, purged: false, archivedAt: null },
    select: { id: true, ownerUserId: true, privacyMode: true },
  });

  const isManager = ['owner', 'admin'].includes(user.role);
  let granted = new Set<string>();

  if (isManager) {
    accounts.forEach((a) => granted.add(a.id));
  } else {
    const access = await prisma.zaloAccountAccess.findMany({
      where: { userId: user.id },
      select: { zaloAccountId: true },
    });
    access.forEach((a) => granted.add(a.zaloAccountId));
    accounts.filter((a) => a.ownerUserId === user.id).forEach((a) => granted.add(a.id));
  }

  let deniedPrivateCount = 0;
  const accountIds = accounts
    .filter((a) => {
      if (!granted.has(a.id)) return false;
      if (a.privacyMode === 'main' && a.ownerUserId !== user.id) {
        deniedPrivateCount += 1;
        return false;
      }
      return true;
    })
    .map((a) => a.id);

  return { accountIds, deniedPrivateCount };
}

export type DailyBriefSnapshot = Awaited<ReturnType<typeof buildDailyBriefSnapshot>>;

export async function buildDailyBriefSnapshot(user: { id: string; orgId: string; role: string }) {
  const { start, end } = todayRangeVN();
  const now = Date.now();
  const { accountIds, deniedPrivateCount } = await resolveAccessibleAccounts(user);
  const orgId = user.orgId;

  /* Không có nick nào xem được → trả snapshot rỗng, popup vẫn hiện lý do. */
  if (accountIds.length === 0) {
    return {
      date: vnDateLabel(start),
      scope: { zaloAccounts: 0, hiddenPrivateAccounts: deniedPrivateCount },
      totals: {
        messagesIn: 0, messagesOut: 0, activeConversations: 0,
        waitingReply: 0, newContacts: 0, appointmentsToday: 0, appointmentsDone: 0,
      },
      waitingCustomers: [], newCustomers: [], appointments: [], overdueFollowUps: [], pipeline: [],
    };
  }

  const convScope = { orgId, zaloAccountId: { in: accountIds } };

  const [
    messagesIn, messagesOut, activeConversations, waitingCount,
    waitingRows, newContacts, appointmentRows, overdueRows, pipelineRows, appointmentsDone,
  ] = await Promise.all([
    prisma.message.count({
      where: { conversation: convScope, senderType: 'contact', sentAt: { gte: start, lt: end } },
    }),
    prisma.message.count({
      where: { conversation: convScope, senderType: 'self', sentAt: { gte: start, lt: end } },
    }),
    prisma.conversation.count({
      where: { ...convScope, lastMessageAt: { gte: start, lt: end } },
    }),
    prisma.conversation.count({
      where: { ...convScope, isReplied: false, lastMessageAt: { gte: start, lt: end } },
    }),

    /* Khách nhắn tới hôm nay mà mình chưa trả lời — phần quan trọng nhất của brief */
    prisma.conversation.findMany({
      where: { ...convScope, isReplied: false, lastMessageAt: { gte: start, lt: end } },
      orderBy: { lastMessageAt: 'asc' }, // chờ lâu nhất lên đầu
      take: 25,
      select: {
        id: true, threadType: true, groupName: true, unreadCount: true, lastMessageAt: true,
        zaloAccount: { select: { displayName: true } },
        contact: {
          select: {
            fullName: true, crmName: true, leadScore: true, lastInboundPreview: true,
            statusRef: { select: { name: true } },
            assignedUser: { select: { fullName: true } },
          },
        },
      },
    }),

    prisma.contact.findMany({
      where: { orgId, createdAt: { gte: start, lt: end }, mergedInto: null },
      orderBy: { leadScore: 'desc' },
      take: 15,
      select: {
        fullName: true, crmName: true, phone: true, source: true, leadScore: true, createdAt: true,
        statusRef: { select: { name: true } },
        assignedUser: { select: { fullName: true } },
      },
    }),

    prisma.appointment.findMany({
      where: { orgId, appointmentDate: { gte: start, lt: end } },
      orderBy: { appointmentDate: 'asc' },
      take: 25,
      select: {
        title: true, appointmentDate: true, appointmentTime: true, type: true, status: true, location: true,
        contact: { select: { fullName: true, crmName: true, phone: true } },
        assignedUser: { select: { fullName: true } },
      },
    }),

    /* Hẹn đã quá hạn mà chưa đóng — việc rơi, hay bị bỏ quên nhất */
    prisma.appointment.findMany({
      where: { orgId, appointmentDate: { lt: start }, status: 'scheduled' },
      orderBy: { appointmentDate: 'desc' },
      take: 15,
      select: {
        title: true, appointmentDate: true,
        contact: { select: { fullName: true, crmName: true } },
        assignedUser: { select: { fullName: true } },
      },
    }),

    prisma.contact.groupBy({
      by: ['statusId'],
      where: { orgId, mergedInto: null },
      _count: { _all: true },
    }),

    prisma.appointment.count({
      where: { orgId, appointmentDate: { gte: start, lt: end }, status: 'completed' },
    }),
  ]);

  /* groupBy trả statusId — đổi sang tên trạng thái cho AI đọc được */
  const statusIds = pipelineRows.map((r) => r.statusId).filter((v): v is string => !!v);
  const statuses = statusIds.length
    ? await prisma.status.findMany({ where: { id: { in: statusIds } }, select: { id: true, name: true, order: true } })
    : [];
  const statusName = new Map(statuses.map((s) => [s.id, s.name]));

  const pipeline = pipelineRows
    .map((r) => ({
      status: r.statusId ? (statusName.get(r.statusId) ?? 'Không rõ') : 'Chưa gắn trạng thái',
      contacts: r._count._all,
    }))
    .sort((a, b) => b.contacts - a.contacts);

  const displayName = (c?: { fullName?: string | null; crmName?: string | null } | null) =>
    c?.crmName || c?.fullName || 'Khách chưa đặt tên';

  return {
    date: vnDateLabel(start),
    scope: { zaloAccounts: accountIds.length, hiddenPrivateAccounts: deniedPrivateCount },
    totals: {
      messagesIn,
      messagesOut,
      activeConversations,
      waitingReply: waitingCount,
      newContacts: newContacts.length,
      appointmentsToday: appointmentRows.length,
      appointmentsDone,
    },
    waitingCustomers: waitingRows.map((c) => ({
      name: c.threadType === 'group' ? (c.groupName || 'Nhóm chưa đặt tên') : displayName(c.contact),
      kind: c.threadType === 'group' ? 'nhóm' : 'cá nhân',
      zaloAccount: c.zaloAccount?.displayName ?? null,
      assignedTo: c.contact?.assignedUser?.fullName ?? null,
      status: c.contact?.statusRef?.name ?? null,
      leadScore: c.contact?.leadScore ?? null,
      unread: c.unreadCount,
      waitingMinutes: minutesSince(c.lastMessageAt, now),
      lastMessage: preview(c.contact?.lastInboundPreview),
    })),
    newCustomers: newContacts.map((c) => ({
      name: displayName(c),
      phone: c.phone,
      source: c.source,
      status: c.statusRef?.name ?? null,
      leadScore: c.leadScore,
      assignedTo: c.assignedUser?.fullName ?? null,
    })),
    appointments: appointmentRows.map((a) => ({
      title: a.title || 'Lịch hẹn',
      customer: displayName(a.contact),
      time: a.appointmentTime || new Date(a.appointmentDate.getTime() + VN_OFFSET_MS).toISOString().slice(11, 16),
      type: a.type,
      status: a.status,
      location: a.location,
      assignedTo: a.assignedUser?.fullName ?? null,
    })),
    overdueFollowUps: overdueRows.map((a) => ({
      title: a.title || 'Lịch hẹn',
      customer: displayName(a.contact),
      dueDate: vnDateLabel(a.appointmentDate),
      overdueDays: Math.max(1, Math.round((start.getTime() - a.appointmentDate.getTime()) / 86400000)),
      assignedTo: a.assignedUser?.fullName ?? null,
    })),
    pipeline,
  };
}

/* ── Rate limit nhẹ trong bộ nhớ ───────────────────────────────────────────
 * Brief không ghi vào ai_suggestions (bảng đó bắt buộc conversationId) nên
 * quota ngày của AiConfig không đếm được lượt hỏi này. Chặn spam bằng cửa sổ
 * trượt theo user: tối đa 12 lượt / 5 phút. Reset khi process restart —
 * chấp nhận được vì đây chỉ là hàng rào chống bấm liên tục.
 */
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 12;
const askLog = new Map<string, number[]>();

function checkRateLimit(userId: string) {
  const now = Date.now();
  const hits = (askLog.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    const waitSec = Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000);
    throw new Error(`Bạn hỏi AI hơi nhanh, thử lại sau ${waitSec} giây`);
  }
  hits.push(now);
  askLog.set(userId, hits);
}

const MAX_QUESTION_LEN = 500;

export async function askDailyBrief(input: {
  user: { id: string; orgId: string; role: string };
  question?: string;
}) {
  const question = (input.question || '').trim();
  if (question.length > MAX_QUESTION_LEN) {
    throw new Error(`Câu hỏi quá dài (tối đa ${MAX_QUESTION_LEN} ký tự)`);
  }
  checkRateLimit(input.user.id);

  const [aiConfig, snapshot] = await Promise.all([
    getAiConfig(input.user.orgId),
    buildDailyBriefSnapshot(input.user),
  ]);

  if (!aiConfig.enabled) throw new Error('AI đang tắt cho tổ chức này — bật ở Cài đặt → AI');

  const apiKey = await getProviderApiKey(input.user.orgId, aiConfig.provider);
  if (!apiKey) throw new Error('Chưa cấu hình khoá cho nhà cung cấp AI đang chọn');

  const userPrompt = [
    '<snapshot_hom_nay>',
    JSON.stringify(snapshot, null, 1),
    '</snapshot_hom_nay>',
    '',
    question
      ? `<cau_hoi>\n${question.replace(/<\/?cau_hoi>/gi, '')}\n</cau_hoi>`
      : '<cau_hoi>Tổng hợp tình trạng khách hàng hôm nay và việc cần làm ngay.</cau_hoi>',
  ].join('\n');

  const started = Date.now();
  const answer = await generateText(
    aiConfig.provider,
    apiKey,
    aiConfig.model,
    buildDailyBriefPrompt('vi'),
    userPrompt,
    1200,
  );
  logger.info(`[ai:daily-brief] org=${input.user.orgId} provider=${aiConfig.provider} ${Date.now() - started}ms`);

  return {
    answer: answer.trim(),
    question: question || null,
    snapshot,
    provider: aiConfig.provider,
    model: aiConfig.model,
    generatedAt: new Date().toISOString(),
  };
}
