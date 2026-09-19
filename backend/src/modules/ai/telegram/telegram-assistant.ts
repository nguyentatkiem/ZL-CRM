/**
 * telegram-assistant.ts — trợ lý ZL CRM trên Telegram cho chủ tổ chức.
 *
 * Hai chiều:
 *   - Báo ngay khi AI gửi tin vào nhóm Zalo, và cờ riêng khi kiểm duyệt phải sửa
 *     câu không căn cứ (tức là câu người thật nên tự trả lời). Kèm nút dừng nhóm.
 *   - Lệnh điều khiển: /trangthai /nhom /dung /chay /homnay /hoi — nhắn thường
 *     cũng được hiểu là câu hỏi cho AI về khách hàng hôm nay.
 *
 * An toàn:
 *   - Token lưu trong app_settings, người dùng dán ở trang cài đặt, không qua chat.
 *   - Chỉ chat đã GHÉP CẶP (mở link t.me/<bot>?start=<mã>) mới dùng được. Người lạ
 *     nhắn bot chỉ nhận câu từ chối, không lộ dữ liệu nào.
 *   - Token được đọc lại mỗi 10 giây: dán là tự nối, đổi là tự đổi, xoá là tự dừng.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '../../../shared/database/prisma-client.js';
import { logger } from '../../../shared/utils/logger.js';

const API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const KEY_TOKEN = 'telegram_bot_token';
const KEY_PAIR = 'telegram_pair_code';
const KEY_CHATS = 'telegram_owner_chats';
const KEY_USERNAME = 'telegram_bot_username';
const KEY_STATUS = 'telegram_status';

type Chat = { id: number; name: string; pairedAt: string };

/* ── Lưu trữ trong app_settings ──────────────────────────────────────── */

async function getSetting(orgId: string, key: string) {
  const row = await prisma.appSetting.findUnique({ where: { orgId_settingKey: { orgId, settingKey: key } } });
  return row?.valuePlain ?? null;
}

async function setSetting(orgId: string, key: string, value: string | null) {
  if (value === null) {
    await prisma.appSetting.deleteMany({ where: { orgId, settingKey: key } });
    return;
  }
  await prisma.appSetting.upsert({
    where: { orgId_settingKey: { orgId, settingKey: key } },
    create: { orgId, settingKey: key, valuePlain: value },
    update: { valuePlain: value },
  });
}

export async function getChats(orgId: string): Promise<Chat[]> {
  try { return JSON.parse((await getSetting(orgId, KEY_CHATS)) || '[]') as Chat[]; } catch { return []; }
}

async function saveChats(orgId: string, chats: Chat[]) {
  await setSetting(orgId, KEY_CHATS, JSON.stringify(chats));
}

export async function ensurePairCode(orgId: string) {
  let code = await getSetting(orgId, KEY_PAIR);
  if (!code) {
    code = randomBytes(9).toString('base64url');
    await setSetting(orgId, KEY_PAIR, code);
  }
  return code;
}

export async function getTelegramStatus(orgId: string) {
  const [token, username, status, chats, code] = await Promise.all([
    getSetting(orgId, KEY_TOKEN), getSetting(orgId, KEY_USERNAME), getSetting(orgId, KEY_STATUS),
    getChats(orgId), ensurePairCode(orgId),
  ]);
  return {
    hasToken: !!token,
    username,
    status: status || (token ? 'đang khởi động' : 'chưa có token'),
    pairLink: username ? `https://t.me/${username}?start=${code}` : null,
    chats: chats.map((c) => ({ name: c.name, pairedAt: c.pairedAt })),
  };
}

/* ── Gọi Telegram ────────────────────────────────────────────────────── */

async function tg<T = any>(token: string, method: string, body?: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
  if (!data.ok) {
    const err = new Error(data.description || `Telegram ${res.status}`) as Error & { code?: number };
    err.code = data.error_code ?? res.status;
    throw err;
  }
  return data.result as T;
}

export async function validateToken(token: string): Promise<{ username: string }> {
  const me = await tg<{ username: string }>(token, 'getMe');
  return { username: me.username };
}

export function esc(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** AI hay trả markdown (**đậm**, `mã`, # tiêu đề). Telegram chế độ HTML không hiểu
 *  markdown nên đổi sang thẻ HTML tương ứng, sau khi đã escape an toàn. */
export function mdToTelegramHtml(text: string) {
  return esc(text)
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-*]\s+/gm, '• ');
}

async function send(token: string, chatId: number, html: string, buttons?: Array<Array<{ text: string; data: string }>>) {
  return tg(token, 'sendMessage', {
    chat_id: chatId,
    text: html.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
  });
}

/** Gửi cho mọi chat đã ghép cặp của tổ chức. Lỗi thì ghi log, không làm hỏng luồng gọi. */
export async function notifyOwners(orgId: string, html: string, buttons?: Array<Array<{ text: string; data: string }>>) {
  try {
    const token = await getSetting(orgId, KEY_TOKEN);
    if (!token) return;
    const chats = await getChats(orgId);
    for (const c of chats) {
      await send(token, c.id, html, buttons).catch((err) => logger.warn(`[telegram] gửi tới chat ${c.id} lỗi: ${err.message}`));
    }
  } catch (err) {
    logger.warn('[telegram] notifyOwners lỗi:', err);
  }
}

/* ── Lệnh ─────────────────────────────────────────────────────────────── */

const HELP = [
  '<b>Trợ lý ZL CRM</b>',
  '/trangthai  xem AI các nhóm đang chạy thế nào',
  '/nhom  danh sách nhóm đang bật',
  '/dung  DỪNG KHẨN CẤP AI ở mọi nhóm',
  '/chay  bật lại AI',
  '/homnay  số liệu khách hàng hôm nay',
  '/hoi &lt;câu hỏi&gt;  hỏi AI về khách hôm nay',
  '',
  'Nhắn câu bình thường cũng được, bot hiểu là câu hỏi cho AI.',
].join('\n');

async function ownerUser(orgId: string) {
  return prisma.user.findFirst({
    where: { orgId, role: 'owner', isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, orgId: true, role: true },
  });
}

async function statusText(orgId: string) {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [cfg, rules, nicks] = await Promise.all([
    prisma.autoReplyConfig.findUnique({ where: { orgId }, select: { groupEnabled: true } }),
    prisma.groupAutoReplyRule.findMany({
      where: { orgId, enabled: true },
      select: { conversationId: true, conversation: { select: { groupName: true } } },
    }),
    prisma.zaloAccount.findMany({ where: { orgId, purged: false }, select: { displayName: true, status: true } }),
  ]);
  const lines = [
    `<b>Công tắc tổng:</b> ${cfg?.groupEnabled ? '🟢 ĐANG BẬT' : '🔴 ĐANG TẮT'}`,
    `<b>Nick Zalo:</b> ${nicks.map((n) => `${esc(n.displayName || '?')} ${n.status === 'connected' ? '🟢' : '🔴'}`).join(', ') || 'chưa có'}`,
    '',
    `<b>Nhóm đang bật (${rules.length}):</b>`,
  ];
  for (const r of rules) {
    const [sent, skipped] = await Promise.all([
      prisma.groupAutoReplyLog.count({ where: { conversationId: r.conversationId, decision: 'sent', createdAt: { gte: since } } }),
      prisma.groupAutoReplyLog.count({ where: { conversationId: r.conversationId, decision: 'failed', createdAt: { gte: since } } }),
    ]);
    lines.push(`• ${esc(r.conversation.groupName || 'nhóm')}: đã trả lời ${sent} tin/24h${skipped ? `, ${skipped} lỗi` : ''}`);
  }
  return lines.join('\n');
}

async function handleCommand(orgId: string, token: string, chatId: number, text: string) {
  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();
  const arg = rest.join(' ').trim();

  if (cmd === '/help' || cmd === '/start') return send(token, chatId, HELP);

  if (cmd === '/trangthai') return send(token, chatId, await statusText(orgId), [[
    { text: '⏸ Dừng tất cả', data: 'stop_all' }, { text: '▶️ Bật lại', data: 'start_all' },
  ]]);

  if (cmd === '/nhom') {
    const rules = await prisma.groupAutoReplyRule.findMany({
      where: { orgId, enabled: true },
      select: { conversationId: true, alwaysReply: true, conversation: { select: { groupName: true, groupMembersCount: true } } },
    });
    if (!rules.length) return send(token, chatId, 'Chưa có nhóm nào bật.');
    return send(
      token, chatId,
      rules.map((r) => `• <b>${esc(r.conversation.groupName || 'nhóm')}</b> (${r.conversation.groupMembersCount ?? '?'} người${r.alwaysReply ? ', luôn trả lời' : ''})`).join('\n'),
      rules.map((r) => [{ text: `⏸ Dừng: ${(r.conversation.groupName || 'nhóm').slice(0, 30)}`, data: `pause:${r.conversationId}` }]),
    );
  }

  if (cmd === '/dung' || cmd === '/stop') {
    await prisma.autoReplyConfig.updateMany({ where: { orgId }, data: { groupEnabled: false } });
    logger.info(`[telegram] công tắc tổng → TẮT (qua Telegram chat ${chatId})`);
    return send(token, chatId, '🔴 Đã DỪNG AI ở mọi nhóm. Gõ /chay để bật lại.');
  }

  if (cmd === '/chay') {
    await prisma.autoReplyConfig.updateMany({ where: { orgId }, data: { groupEnabled: true } });
    logger.info(`[telegram] công tắc tổng → BẬT (qua Telegram chat ${chatId})`);
    return send(token, chatId, '🟢 Đã BẬT lại AI cho các nhóm đang chọn.');
  }

  if (cmd === '/homnay') {
    const user = await ownerUser(orgId);
    if (!user) return send(token, chatId, 'Không tìm thấy tài khoản chủ tổ chức.');
    const { buildDailyBriefSnapshot } = await import('../daily-brief-service.js');
    const s = await buildDailyBriefSnapshot(user);
    const t = s.totals;
    const waiting = s.waitingCustomers.slice(0, 8).map((c) => `• ${esc(c.name)} (${c.waitingMinutes ?? '?'} phút)`).join('\n');
    return send(token, chatId, [
      `<b>Khách hàng hôm nay ${s.date}</b>`,
      `Chờ trả lời: <b>${t.waitingReply}</b> · Tin khách gửi: ${t.messagesIn} · Khách mới: ${t.newContacts}`,
      `Lịch hẹn: ${t.appointmentsToday} · Hẹn quá hạn: ${s.overdueFollowUps.length}`,
      waiting ? `\n<b>Đang chờ lâu nhất:</b>\n${waiting}` : '',
    ].join('\n'));
  }

  const question = cmd === '/hoi' ? arg : text.trim();
  if (!question) return send(token, chatId, 'Gõ câu hỏi sau /hoi, ví dụ: /hoi khách nào cần gọi trước?');
  const user = await ownerUser(orgId);
  if (!user) return send(token, chatId, 'Không tìm thấy tài khoản chủ tổ chức.');
  await tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
  try {
    const { askDailyBrief } = await import('../daily-brief-service.js');
    const r = await askDailyBrief({ user, question: question.slice(0, 500) });
    return send(token, chatId, mdToTelegramHtml(r.answer));
  } catch (err) {
    return send(token, chatId, `Không hỏi được AI: ${esc(err instanceof Error ? err.message : 'lỗi')}`);
  }
}

async function handleCallback(orgId: string, token: string, chatId: number, data: string) {
  if (data === 'stop_all') {
    await prisma.autoReplyConfig.updateMany({ where: { orgId }, data: { groupEnabled: false } });
    return send(token, chatId, '🔴 Đã DỪNG AI ở mọi nhóm.');
  }
  if (data === 'start_all') {
    await prisma.autoReplyConfig.updateMany({ where: { orgId }, data: { groupEnabled: true } });
    return send(token, chatId, '🟢 Đã BẬT lại AI.');
  }
  if (data.startsWith('pause:')) {
    const conversationId = data.slice(6);
    const rule = await prisma.groupAutoReplyRule.findFirst({
      where: { orgId, conversationId },
      select: { conversation: { select: { groupName: true } } },
    });
    if (!rule) return send(token, chatId, 'Không tìm thấy nhóm.');
    await prisma.groupAutoReplyRule.update({ where: { conversationId }, data: { enabled: false } });
    logger.info(`[telegram] tắt nhóm "${rule.conversation.groupName}" qua Telegram`);
    return send(token, chatId, `⏸ Đã tắt AI ở nhóm <b>${esc(rule.conversation.groupName || '')}</b>. Bật lại ở trang cài đặt.`);
  }
}

/* ── Vòng nhận tin (long polling), mỗi tổ chức một vòng ─────────────── */

const running = new Map<string, { token: string; stop: boolean }>();
/* Token đã biết là hỏng thì không thử lại mỗi 10 giây — chờ người dùng dán token khác. */
const badTokens = new Set<string>();

async function pollLoop(orgId: string, token: string) {
  const state = { token, stop: false };
  running.set(orgId, state);
  let offset = 0;
  try {
    const me = await validateToken(token);
    await setSetting(orgId, KEY_USERNAME, me.username);
    await setSetting(orgId, KEY_STATUS, 'đang chạy');
    await ensurePairCode(orgId);
    logger.info(`[telegram] bot @${me.username} đã nối cho org ${orgId}`);
  } catch (err) {
    await setSetting(orgId, KEY_STATUS, `token không dùng được: ${err instanceof Error ? err.message : 'lỗi'}`);
    badTokens.add(token);
    running.delete(orgId);
    return;
  }

  while (!state.stop) {
    try {
      const updates = await tg<any[]>(token, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        const cb = u.callback_query;
        const chatId: number | undefined = msg?.chat?.id ?? cb?.message?.chat?.id;
        if (!chatId) continue;
        // chỉ nhận chat riêng với bot, không nhận trong nhóm
        if ((msg?.chat?.type ?? cb?.message?.chat?.type) !== 'private') continue;

        const chats = await getChats(orgId);
        const paired = chats.some((c) => c.id === chatId);
        const text: string = msg?.text ?? '';

        if (!paired) {
          const code = await ensurePairCode(orgId);
          if (text.startsWith('/start') && text.split(/\s+/)[1] === code) {
            const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || String(chatId);
            await saveChats(orgId, [...chats, { id: chatId, name, pairedAt: new Date().toISOString() }]);
            logger.info(`[telegram] ghép cặp thành công với "${name}" (${chatId})`);
            await send(token, chatId, `✅ Đã ghép cặp với ZL CRM.\n\n${HELP}`);
          } else {
            await send(token, chatId, 'Bot này là trợ lý riêng. Hãy mở đúng link ghép cặp trong trang cài đặt ZL CRM.');
          }
          continue;
        }

        try {
          if (cb) {
            await tg(token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => undefined);
            await handleCallback(orgId, token, chatId, cb.data || '');
          } else if (text) {
            await handleCommand(orgId, token, chatId, text);
          }
        } catch (err) {
          logger.error('[telegram] xử lý tin lỗi:', err);
          await send(token, chatId, 'Có lỗi khi xử lý, thử lại sau nhé.').catch(() => undefined);
        }
      }
    } catch (err: any) {
      if (err?.code === 409) {
        await setSetting(orgId, KEY_STATUS, 'token này đang được chương trình khác dùng, hãy tạo bot MỚI');
        logger.warn('[telegram] 409 xung đột getUpdates — token đang dùng ở nơi khác');
        await new Promise((r) => setTimeout(r, 60_000));
      } else if (err?.code === 401 || err?.code === 404) {
        await setSetting(orgId, KEY_STATUS, 'token không hợp lệ hoặc đã bị thu hồi');
        badTokens.add(token);
        break;
      } else {
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }
  if (running.get(orgId) === state) running.delete(orgId);
}

/** Mỗi 10 giây đối chiếu token trong DB với vòng đang chạy: mới thì nối, đổi thì đổi, xoá thì dừng. */
export function startTelegramAssistant() {
  const sync = async () => {
    try {
      const rows = await prisma.appSetting.findMany({ where: { settingKey: KEY_TOKEN }, select: { orgId: true, valuePlain: true } });
      const wanted = new Map(rows.filter((r) => r.valuePlain).map((r) => [r.orgId, r.valuePlain as string]));
      for (const [orgId, st] of running) {
        if (wanted.get(orgId) !== st.token) st.stop = true;
      }
      for (const [orgId, token] of wanted) {
        if (badTokens.has(token)) continue;
        const cur = running.get(orgId);
        if (!cur || cur.stop) {
          if (cur?.stop) running.delete(orgId);
          void pollLoop(orgId, token);
        }
      }
    } catch (err) {
      logger.warn('[telegram] đồng bộ token lỗi:', err);
    }
  };
  void sync();
  setInterval(sync, 10_000);
  logger.info('[telegram] trợ lý Telegram đã sẵn sàng — dán token ở trang cài đặt là tự nối');
}

export const TELEGRAM_KEYS = { KEY_TOKEN, KEY_PAIR, KEY_CHATS, KEY_USERNAME, KEY_STATUS };
export { setSetting as setTelegramSetting };
