/**
 * context-builder.ts — gom ngữ cảnh cho một nháp trả lời.
 *
 * Bốn nguồn, đúng như đã chốt:
 *   1. Lịch sử chat với chính khách đó (30 tin gần nhất)
 *   2. Hồ sơ CRM của khách (trạng thái, tag, điểm, lịch hẹn, ghi chú sale)
 *   3. Kịch bản bán hàng do chủ doanh nghiệp soạn (chọn mục khớp từ khoá)
 *   4. Mẫu tin nhắn có sẵn trong phần mềm
 *
 * Toàn bộ được cắt ngắn có kiểm soát: prompt dài thì vừa chậm vừa đắt, và AI
 * càng dễ bịa khi bị nhồi quá nhiều thứ không liên quan.
 */
import { prisma } from '../../../shared/database/prisma-client.js';

const HISTORY_LIMIT = 30;
const PLAYBOOK_LIMIT = 6;
const TEMPLATE_LIMIT = 8;
const PLAYBOOK_CHARS = 700;
const TEMPLATE_CHARS = 300;
const MESSAGE_CHARS = 400;

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/* Bỏ dấu để so từ khoá — khách gõ "bao gia" vẫn khớp mục "báo giá". */
function fold(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function matchesAnyKeyword(text: string, keywords: string[]): string | null {
  const hay = fold(text);
  for (const kw of keywords) {
    const needle = fold(String(kw)).trim();
    if (needle && hay.includes(needle)) return kw;
  }
  return null;
}

export type PlaybookSnippet = { title: string; category: string | null; content: string };

/** Chọn mục kịch bản cho một tin: mục khớp từ khoá lên trước, rồi tới mục ưu tiên cao. */
export async function pickPlaybook(orgId: string, incomingText: string, limit = PLAYBOOK_LIMIT): Promise<PlaybookSnippet[]> {
  const rows = await prisma.salesPlaybookEntry.findMany({
    where: { orgId, enabled: true },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    select: { title: true, category: true, keywords: true, content: true },
  });
  const scored = rows.map((row) => {
    const keywords = Array.isArray(row.keywords) ? (row.keywords as string[]) : [];
    return { row, matched: keywords.length > 0 && !!matchesAnyKeyword(incomingText, keywords) };
  });
  return [...scored.filter((s) => s.matched), ...scored.filter((s) => !s.matched)]
    .slice(0, limit)
    .map(({ row }) => ({ title: row.title, category: row.category, content: clip(row.content, PLAYBOOK_CHARS) }));
}

export type AutoReplyContext = {
  customer: Record<string, unknown>;
  history: Array<{ who: string; at: string; text: string }>;
  lastCustomerMessage: string;
  playbook: Array<{ title: string; category: string | null; content: string }>;
  templates: Array<{ name: string; category: string | null; content: string }>;
};

export async function buildAutoReplyContext(input: {
  orgId: string;
  conversationId: string;
  contactId: string | null;
  incomingText: string;
}): Promise<AutoReplyContext> {
  const { orgId, conversationId, contactId, incomingText } = input;

  const [messages, contact, notes, playbookRows, templateRows] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId, isDeleted: false },
      orderBy: { sentAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { senderType: true, senderName: true, content: true, contentType: true, sentAt: true, sentVia: true },
    }),

    contactId
      ? prisma.contact.findUnique({
          where: { id: contactId },
          select: {
            fullName: true, crmName: true, phone: true, source: true, leadScore: true,
            tags: true, province: true, district: true, occupation: true, gender: true,
            nextAppointment: true, firstContactDate: true, consentStatus: true,
            statusRef: { select: { name: true } },
            assignedUser: { select: { fullName: true } },
          },
        })
      : null,

    contactId
      ? prisma.note.findMany({
          where: { orgId, contactId },
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { body: true, createdAt: true, author: { select: { fullName: true } } },
        })
      : [],

    prisma.salesPlaybookEntry.findMany({
      where: { orgId, enabled: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      select: { title: true, category: true, keywords: true, content: true, priority: true },
    }),

    prisma.messageTemplate.findMany({
      where: { orgId },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      select: { name: true, category: true, content: true },
    }),
  ]);

  /* ── Kịch bản: mục khớp từ khoá lên trước, sau đó mới tới mục ưu tiên cao ── */
  const scored = playbookRows.map((row) => {
    const keywords = Array.isArray(row.keywords) ? (row.keywords as string[]) : [];
    const hit = keywords.length > 0 ? matchesAnyKeyword(incomingText, keywords) : null;
    return { row, matched: !!hit };
  });
  const playbook = [
    ...scored.filter((s) => s.matched),
    ...scored.filter((s) => !s.matched),
  ]
    .slice(0, PLAYBOOK_LIMIT)
    .map(({ row }) => ({
      title: row.title,
      category: row.category,
      content: clip(row.content, PLAYBOOK_CHARS),
    }));

  /* ── Mẫu tin: ưu tiên mẫu có từ trùng với tin khách vừa gửi ── */
  const templatesRanked = templateRows
    .map((t) => ({ t, matched: !!matchesAnyKeyword(incomingText, [t.name, ...(t.category ? [t.category] : [])]) }))
    .sort((a, b) => Number(b.matched) - Number(a.matched))
    .slice(0, TEMPLATE_LIMIT)
    .map(({ t }) => ({ name: t.name, category: t.category, content: clip(t.content, TEMPLATE_CHARS) }));

  /* ── Lịch sử chat: đảo lại theo thứ tự thời gian tăng dần ── */
  const history = [...messages].reverse().map((m) => ({
    who: m.senderType === 'self' ? (m.sentVia === 'automation' ? 'bot' : 'nhân viên') : 'khách',
    at: m.sentAt.toISOString(),
    text: m.contentType === 'text' || m.contentType === 'rich'
      ? clip(m.content ?? '', MESSAGE_CHARS)
      : `(gửi ${m.contentType})`,
  }));

  const customer: Record<string, unknown> = contact
    ? {
        ten: contact.crmName || contact.fullName || null,
        trangThai: contact.statusRef?.name ?? null,
        nguoiPhuTrach: contact.assignedUser?.fullName ?? null,
        diemLead: contact.leadScore,
        nguon: contact.source,
        tag: Array.isArray(contact.tags) ? contact.tags : [],
        tinh: contact.province,
        quanHuyen: contact.district,
        ngheNghiep: contact.occupation,
        gioiTinh: contact.gender,
        lichHenSapToi: contact.nextAppointment?.toISOString() ?? null,
        lanDauLienHe: contact.firstContactDate?.toISOString() ?? null,
        ghiChuSale: notes.map((n) => ({
          cua: n.author?.fullName ?? null,
          luc: n.createdAt.toISOString(),
          noiDung: clip(n.body, 300),
        })),
      }
    : { ten: null, ghiChu: 'Hội thoại chưa gắn hồ sơ khách hàng trong CRM' };

  return {
    customer,
    history,
    lastCustomerMessage: clip(incomingText, MESSAGE_CHARS),
    playbook,
    templates: templatesRanked,
  };
}

/** Ghép ngữ cảnh thành khối text đưa vào prompt. */
export function renderContextForPrompt(ctx: AutoReplyContext): string {
  const lines: string[] = [];

  lines.push('<ho_so_khach>');
  lines.push(JSON.stringify(ctx.customer, null, 1));
  lines.push('</ho_so_khach>');
  lines.push('');

  lines.push('<kich_ban_ban_hang>');
  if (ctx.playbook.length === 0) {
    lines.push('(Chưa có kịch bản nào. KHÔNG được tự nêu giá hay chính sách.)');
  } else {
    ctx.playbook.forEach((p) => {
      lines.push(`### ${p.title}${p.category ? ` [${p.category}]` : ''}`);
      lines.push(p.content);
    });
  }
  lines.push('</kich_ban_ban_hang>');
  lines.push('');

  lines.push('<mau_tin_co_san>');
  if (ctx.templates.length === 0) {
    lines.push('(Chưa có mẫu tin nào.)');
  } else {
    ctx.templates.forEach((t) => lines.push(`- ${t.name}: ${t.content}`));
  }
  lines.push('</mau_tin_co_san>');
  lines.push('');

  lines.push('<lich_su_chat>');
  ctx.history.forEach((h) => lines.push(`[${h.at}] ${h.who}: ${h.text}`));
  lines.push('</lich_su_chat>');
  lines.push('');

  lines.push('<tin_moi_nhat_cua_khach>');
  lines.push(ctx.lastCustomerMessage);
  lines.push('</tin_moi_nhat_cua_khach>');

  return lines.join('\n');
}
