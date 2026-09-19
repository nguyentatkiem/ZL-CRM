/**
 * config-service.ts — cấu hình trả lời tự động cho mỗi tổ chức.
 *
 * Mặc định TẮT. Bật lên là bắt đầu tốn quota AI, nên không tự bật hộ ai.
 */
import { prisma } from '../../../shared/database/prisma-client.js';

/* Khách nhắn trúng những từ này thì để người thật xử lý, AI không soạn nháp. */
export const DEFAULT_BLOCKED_KEYWORDS = [
  'hoàn tiền', 'trả hàng', 'khiếu nại', 'lừa đảo', 'kiện', 'luật sư',
  'công an', 'báo chí', 'tố cáo', 'bồi thường', 'huỷ hợp đồng', 'hủy hợp đồng',
];

export type AutoReplyConfigShape = {
  enabled: boolean;
  accountIds: string[];
  hourStart: number;
  hourEnd: number;
  maxDraftsPerDay: number;
  minGapSeconds: number;
  skipIfStaffRepliedWithinMin: number;
  draftTtlMinutes: number;
  blockedKeywords: string[];
  extraInstruction: string | null;
  groupEnabled: boolean;
};

function normalize(row: {
  enabled: boolean; accountIds: unknown; hourStart: number; hourEnd: number;
  maxDraftsPerDay: number; minGapSeconds: number; skipIfStaffRepliedWithinMin: number;
  draftTtlMinutes: number; blockedKeywords: unknown; extraInstruction: string | null;
  groupEnabled: boolean;
}): AutoReplyConfigShape {
  return {
    enabled: row.enabled,
    accountIds: Array.isArray(row.accountIds) ? (row.accountIds as string[]) : [],
    hourStart: row.hourStart,
    hourEnd: row.hourEnd,
    maxDraftsPerDay: row.maxDraftsPerDay,
    minGapSeconds: row.minGapSeconds,
    skipIfStaffRepliedWithinMin: row.skipIfStaffRepliedWithinMin,
    draftTtlMinutes: row.draftTtlMinutes,
    blockedKeywords: Array.isArray(row.blockedKeywords) ? (row.blockedKeywords as string[]) : [],
    extraInstruction: row.extraInstruction,
    groupEnabled: row.groupEnabled,
  };
}

export async function getAutoReplyConfig(orgId: string): Promise<AutoReplyConfigShape> {
  const existing = await prisma.autoReplyConfig.findUnique({ where: { orgId } });
  if (existing) return normalize(existing);

  const created = await prisma.autoReplyConfig.create({
    data: { orgId, blockedKeywords: DEFAULT_BLOCKED_KEYWORDS },
  });
  return normalize(created);
}

export type AutoReplyConfigInput = Partial<AutoReplyConfigShape>;

export function validateConfigInput(input: AutoReplyConfigInput): string | null {
  if (input.hourStart !== undefined || input.hourEnd !== undefined) {
    const s = input.hourStart ?? 0;
    const e = input.hourEnd ?? 23;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 23 || s >= e) {
      return 'Khung giờ phải là số nguyên 0-23 và giờ bắt đầu nhỏ hơn giờ kết thúc';
    }
  }
  if (input.maxDraftsPerDay !== undefined && (!Number.isInteger(input.maxDraftsPerDay) || input.maxDraftsPerDay < 1 || input.maxDraftsPerDay > 5000)) {
    return 'Số nháp mỗi ngày phải từ 1 đến 5000';
  }
  if (input.minGapSeconds !== undefined && (!Number.isInteger(input.minGapSeconds) || input.minGapSeconds < 0 || input.minGapSeconds > 3600)) {
    return 'Khoảng cách giữa hai nháp phải từ 0 đến 3600 giây';
  }
  if (input.skipIfStaffRepliedWithinMin !== undefined && (!Number.isInteger(input.skipIfStaffRepliedWithinMin) || input.skipIfStaffRepliedWithinMin < 0 || input.skipIfStaffRepliedWithinMin > 1440)) {
    return 'Thời gian chờ nhân viên phải từ 0 đến 1440 phút';
  }
  if (input.draftTtlMinutes !== undefined && (!Number.isInteger(input.draftTtlMinutes) || input.draftTtlMinutes < 5 || input.draftTtlMinutes > 1440)) {
    return 'Hạn dùng của nháp phải từ 5 đến 1440 phút';
  }
  if (input.accountIds !== undefined && (!Array.isArray(input.accountIds) || input.accountIds.some((v) => typeof v !== 'string'))) {
    return 'Danh sách nick phải là mảng chuỗi';
  }
  if (input.blockedKeywords !== undefined && (!Array.isArray(input.blockedKeywords) || input.blockedKeywords.some((v) => typeof v !== 'string'))) {
    return 'Danh sách từ khoá chặn phải là mảng chuỗi';
  }
  if (input.groupEnabled !== undefined && typeof input.groupEnabled !== 'boolean') {
    return 'Công tắc nhóm phải là true hoặc false';
  }
  if (input.extraInstruction !== undefined && input.extraInstruction !== null && input.extraInstruction.length > 2000) {
    return 'Lời dặn riêng tối đa 2000 ký tự';
  }
  return null;
}

export async function updateAutoReplyConfig(orgId: string, input: AutoReplyConfigInput): Promise<AutoReplyConfigShape> {
  await getAutoReplyConfig(orgId); // đảm bảo row tồn tại
  const updated = await prisma.autoReplyConfig.update({
    where: { orgId },
    data: {
      enabled: input.enabled,
      accountIds: input.accountIds,
      hourStart: input.hourStart,
      hourEnd: input.hourEnd,
      maxDraftsPerDay: input.maxDraftsPerDay,
      minGapSeconds: input.minGapSeconds,
      skipIfStaffRepliedWithinMin: input.skipIfStaffRepliedWithinMin,
      draftTtlMinutes: input.draftTtlMinutes,
      blockedKeywords: input.blockedKeywords,
      extraInstruction: input.extraInstruction,
      groupEnabled: input.groupEnabled,
    },
  });
  return normalize(updated);
}
