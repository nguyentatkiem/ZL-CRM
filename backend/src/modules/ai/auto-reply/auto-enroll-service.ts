/**
 * auto-enroll-service.ts — tự bật AI trả lời cho những nhóm người phụ trách đang
 * THỰC SỰ dẫn dắt, để người dùng không phải bật tay từng nhóm.
 *
 * Tiêu chí dựa trên dữ liệu, không đoán theo tên nhóm:
 *   - người thật của tổ chức tự gõ ≥ 10 tin trong nhóm trong 30 ngày
 *     (nhóm họ đang dẫn dắt → thành viên kỳ vọng họ trả lời, bộ não có đủ lời để học)
 *   - nhóm có 20–300 thành viên (nhỏ hơn thường là coaching riêng / nội bộ,
 *     lớn hơn thì AI tự nói dễ thành spam và dễ bị Zalo đánh dấu)
 *   - thành viên có nhắn trong 7 ngày gần nhất
 *   - tên nhóm không thuộc loại nhạy cảm (khách doanh nghiệp, coaching riêng,
 *     nội bộ, đối tác, nhóm đổi tương tác) và không nằm trong danh sách loại trừ
 *
 * KHÔNG đụng nhóm đã có quy tắc — kể cả nhóm người dùng đã tự tắt. Tự bật chỉ
 * cho nhóm chưa từng được cấu hình.
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';
import { learnFromGroup } from './brain-service.js';

const MIN_OWNER_MSGS_30D = 10;
const MIN_MEMBERS = 20;
const MAX_MEMBERS = 300;

/* Nhóm có tên thế này thì không tự bật — rủi ro quan hệ khách hàng / nội bộ.
   So không dấu, không phân biệt hoa thường. */
const SENSITIVE_NAME = [
  'elite coach', 'coaching rieng', 'traphaco', 'hvs', 'hai van', 'haivanship',
  'noi bo', 'team', 'leaders', 'ban quan tri', 'support', 'ho tro', 'nhan su',
  'hbr', 'hop tac', 'doi tac', 'tuong tac cheo', '[tag]', 'cty', 'cong ty', 'group',
  'phong kham', 'benh vien', 'gia dinh', 'sport', 'chay bo', 'du lich', 'di trung quoc',
];

function fold(t: string) {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

export type EnrollCandidate = { conversationId: string; groupName: string; members: number; ownerMsgs30d: number };

export async function findEnrollCandidates(orgId: string): Promise<EnrollCandidate[]> {
  const cfg = await prisma.autoReplyConfig.findUnique({ where: { orgId }, select: { autoEnrollExclude: true } });
  const exclude = new Set(Array.isArray(cfg?.autoEnrollExclude) ? (cfg!.autoEnrollExclude as string[]) : []);

  const rows = await prisma.$queryRaw<Array<{ id: string; group_name: string | null; members: number | null; owner_msgs: bigint }>>`
    SELECT c.id, c.group_name, c.group_members_count AS members,
           (SELECT count(*) FROM messages m
             WHERE m.conversation_id = c.id AND m.sender_type = 'self' AND m.sent_via = 'user'
               AND m.sent_at > now() - interval '30 days') AS owner_msgs
    FROM conversations c
    JOIN zalo_accounts za ON za.id = c.zalo_account_id
    WHERE c.org_id = ${orgId}
      AND c."threadType" = 'group'
      AND za.privacy_mode <> 'main' AND za.purged = false AND za.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM group_auto_reply_rules r WHERE r.conversation_id = c.id)
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'contact'
                  AND m.sent_at > now() - interval '7 days')
  `;

  return rows
    .map((r) => ({
      conversationId: r.id,
      groupName: r.group_name || '',
      members: r.members ?? 0,
      ownerMsgs30d: Number(r.owner_msgs),
    }))
    .filter((r) =>
      r.ownerMsgs30d >= MIN_OWNER_MSGS_30D
      && r.members >= MIN_MEMBERS && r.members <= MAX_MEMBERS
      && !exclude.has(r.conversationId)
      && !SENSITIVE_NAME.some((w) => fold(r.groupName).includes(w)))
    .sort((a, b) => b.ownerMsgs30d - a.ownerMsgs30d);
}

/** Bật cho các nhóm đủ tiêu chí, với cấu hình mặc định của người dẫn dắt lớp. */
export async function runAutoEnroll(orgId: string): Promise<EnrollCandidate[]> {
  const cfg = await prisma.autoReplyConfig.findUnique({ where: { orgId }, select: { autoEnrollGroups: true } });
  if (!cfg?.autoEnrollGroups) return [];

  const candidates = await findEnrollCandidates(orgId);
  for (const c of candidates) {
    await prisma.groupAutoReplyRule.create({
      data: {
        orgId,
        conversationId: c.conversationId,
        enabled: true,
        enrolledBy: 'auto',
        triggerMode: 'all',
        alwaysReply: true,
        speakerRole: 'Giảng viên, người trực tiếp dẫn dắt nhóm',
        selfPronoun: 'Thầy',
        groupPronoun: 'các bạn',
        memberPronoun: 'bạn',
        maxRepliesPerHour: 6,
        minGapSeconds: 120,
        hourStart: 7,
        hourEnd: 22,
        quoteOriginal: true,
        brainEnabled: true,
      },
    });
    logger.info(`[auto-enroll] tự bật AI cho nhóm "${c.groupName}" (${c.members} tv, người phụ trách gõ ${c.ownerMsgs30d} tin/30 ngày)`);
    // học lịch sử để có cái mà trả lời ngay; tuần tự để không dồn quota
    await learnFromGroup(orgId, c.conversationId, { sinceDays: 30, force: true }).catch(() => undefined);
  }
  return candidates;
}

let timer: NodeJS.Timeout | null = null;

export function startAutoEnrollScheduler() {
  if (timer) return;
  const tick = async () => {
    try {
      const orgs = await prisma.autoReplyConfig.findMany({ where: { autoEnrollGroups: true }, select: { orgId: true } });
      for (const o of orgs) await runAutoEnroll(o.orgId);
    } catch (err) {
      logger.error('[auto-enroll] lỗi khi rà nhóm:', err);
    }
  };
  setTimeout(tick, 60_000);
  timer = setInterval(tick, 60 * 60_000);
  logger.info('[auto-enroll] lịch tự bật nhóm đã chạy — 1 giờ một lần');
}
