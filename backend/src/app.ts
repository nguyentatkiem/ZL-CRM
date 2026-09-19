// Đã sửa bởi TAKI Academy (09/2026): thêm tính năng AI trả lời tự động. Xem NGUON-GOC.md.
/**
 * Main application entry point.
 * Bootstraps Fastify server with all plugins, Socket.IO, and route handlers.
 * The process never exits — all errors are caught and logged.
 */

// BigInt → string khi JSON.stringify (Fastify response serializer).
// Cần thiết cho Message.zaloMsgIdNum (Prisma trả BigInt, JSON native fail without this).
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

// Ép ưu tiên IPv4 cho mọi DNS lookup — PHẢI chạy trước khi zca-js/fetch gọi ra Zalo.
// Khắc phục ETIMEDOUT "fetch failed" do VPS không có IPv6 mà DNS Zalo trả cả AAAA. Xem file.
import './shared/utils/prefer-ipv4.js';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma } from '@prisma/client';
import { config } from './config/index.js';
import { prisma } from './shared/database/prisma-client.js';
import { logger } from './shared/utils/logger.js';
import { authRoutes } from './modules/auth/auth-routes.js';
import { ensureBootstrapAdmin } from './modules/auth/ensure-admin.js';
import { zaloRoutes } from './modules/zalo/zalo-routes.js';
import { chatRoutes } from './modules/chat/chat-routes.js';
import { folderRoutes } from './modules/chat/folder-routes.js';
import { presetRoutes } from './modules/chat/preset-routes.js';
import { chatAttachmentRoutes } from './modules/chat/chat-attachment-routes.js';
import { contactRoutes } from './modules/contacts/contact-routes.js';
import { statusRoutes } from './modules/contacts/status-routes.js';
import { contactSubResourceRoutes } from './modules/contacts/contact-sub-resource-routes.js';
import { appointmentRoutes } from './modules/contacts/appointment-routes.js';
import { notesRoutes } from './modules/contacts/notes-routes.js';
import { startInteractionCron } from './modules/contacts/interaction-cron.js';
import { crmTagRoutes } from './modules/contacts/crm-tag-routes.js';
import { crmTagGroupRoutes } from './modules/contacts/crm-tag-group-routes.js';
import { userPreferenceRoutes } from './modules/auth/user-preference-routes.js';
import { zaloLabelsRoutes, startLabelsBackgroundSync } from './modules/zalo/zalo-labels-routes.js';
import { startAppointmentReminder } from './modules/contacts/appointment-reminder.js';
import { zinstantProxyRoutes } from './modules/contacts/zinstant-proxy-routes.js';
import { userRoutes } from './modules/auth/user-routes.js';
import { teamRoutes } from './modules/auth/team-routes.js';
import { orgRoutes } from './modules/auth/org-routes.js';
import { zaloAccessRoutes } from './modules/zalo/zalo-access-routes.js';
import { zaloSyncRoutes } from './modules/zalo/zalo-sync-routes.js';
import { zaloDashboardRoutes } from './modules/zalo/zalo-dashboard-routes.js';
import { zaloPool } from './modules/zalo/zalo-pool.js';
import { registerZaloSocketHandlers } from './modules/zalo/zalo-socket.js';
import { startZaloHealthCheck } from './modules/zalo/zalo-health-check.js';
import { startContactIntelligence } from './modules/contacts/contact-intelligence.js';
import { integrationRoutes } from './modules/integrations/integration-routes.js';
import { facebookRoutes } from './modules/integrations/providers/facebook/facebook-routes.js';
import { automationRoutes } from './modules/automation/automation-routes.js';
import { templateRoutes } from './modules/automation/template-routes.js';
// Phase 7 — Automation framework (Block / Sequence / Trigger / Broadcast)
import { blockRoutes } from './modules/automation/blocks/block-routes.js';
import { blockFolderRoutes } from './modules/automation/blocks/block-folder-routes.js';
import { sequenceRoutes } from './modules/automation/sequences/sequence-routes.js';
import { triggerRoutes } from './modules/automation/triggers/trigger-routes.js';
import { broadcastRoutes } from './modules/automation/broadcasts/broadcast-routes.js';
import { webhookRoutes as automationWebhookRoutes } from './modules/automation/webhooks/webhook-routes.js';
// Tệp khách hàng (CustomerList) — Phase 7 audience layer
import { customerListRoutes } from './modules/automation/lists/list-routes.js';
import { customerListEntryRoutes } from './modules/automation/lists/list-entry-routes.js';
import { startListEnrichmentWorker } from './modules/automation/lists/list-enrichment-service.js';
import { registerCustomerListEventHandlers } from './modules/automation/lists/list-event-handlers.js';
import { chatOperationsRoutes, registerChatSocketHandlers } from './modules/chat/chat-operations-routes.js';
import { groupRoutes } from './modules/zalo/group-routes.js';
import { groupModerationRoutes } from './modules/zalo/group-moderation-routes.js';
import { friendRoutes } from './modules/zalo/friend-routes.js';
import { profileRoutes } from './modules/zalo/profile-routes.js';
import { credentialRoutes } from './modules/zalo/credential-routes.js';
import { eventBuffer } from './shared/event-buffer.js';
// Plugin architecture — xem core/plugin-host.ts
import { buildContext } from './core/build-context.js';
import { loadPlugins } from './core/plugin-host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bootstrap() {
  const app = Fastify({ logger: false });

  // ── Plugins ──────────────────────────────────────────────────────────────

  await app.register(cors, {
    origin: config.isProduction ? config.appUrl : true,
    credentials: true,
  });

  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
  });

  // Global optional authentication: populate `request.user` whenever a valid
  // Bearer token is present. Routes that REQUIRE auth still gate themselves
  // (e.g. core modules add their own authMiddleware preHandler; plugin routes
  // return 401 when `request.user` is absent). Verification failure is swallowed
  // so public routes (login, health, webhooks) keep working. This gives every
  // route — including those registered by plugins — a consistent `request.user`.
  app.addHook('onRequest', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      /* no / invalid token → leave request.user undefined, let the route decide */
    }
  });

  await app.register(rateLimit, {
    max: 500,
    timeWindow: '1 minute',
    // Skip rate limiting for static assets — only limit API routes
    allowList: (request: { url: string }) => !request.url.startsWith('/api/'),
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500 MB — video cap; per-kind size enforced in route
      files: 10,
    },
  });

  // POST/PUT/PATCH KHÔNG có body (reconnect, pin, block, leave-group, sync...) — frontend
  // gọi `api.post(url)` không kèm data nên không có Content-Type.
  //
  // Fastify chỉ bỏ qua bước parse body khi vừa thiếu Content-Type VỪA thiếu
  // Transfer-Encoding (lib/handle-request.js). Nhưng cloudflared nhận HTTP/2 từ trình duyệt
  // (không có content-length) rồi phát lại xuống origin bằng HTTP/1.1 kèm
  // `Transfer-Encoding: chunked` → Fastify rơi vào nhánh parser cho content-type rỗng,
  // không ai đăng ký → trả 415 Unsupported Media Type. Request thậm chí chưa vào handler.
  //
  // Vì vậy CHỈ hỏng khi đi qua tunnel; gọi thẳng 127.0.0.1:3080 vẫn 200 — đây là hồi quy
  // sinh ra lúc chuyển sang Cloudflare Tunnel (2026-08-10), không phải lỗi của route.
  // Phải đăng ký bằng RegExp khớp "/": Fastify 5 chặn thẳng chuỗi rỗng
  // (FST_ERR_CTP_EMPTY_TYPE), còn khi tra parser thì nó chuẩn hoá content-type rỗng
  // thành media-type "/" (lib/content-type.js) rồi mới dò danh sách RegExp.
  app.addContentTypeParser(/^\/$/, { parseAs: 'string' }, (_request, body: string, done) => {
    if (!body || body.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      // Không phải JSON thì trả nguyên văn, để route tự quyết — không nuốt dữ liệu.
      done(null, body as unknown as Record<string, unknown>);
    }
  });

  // Serve compiled frontend assets in production
  if (config.isProduction) {
    await app.register(fastifyStatic, {
      root: path.join(__dirname, '../static'),
      prefix: '/',
    });
  }

  // ── Socket.IO ─────────────────────────────────────────────────────────────

  const io = new Server(app.server, {
    cors: {
      origin: config.isProduction ? config.appUrl : '*',
      credentials: true,
    },
  });

  // Attach io to app so route handlers can emit events
  app.decorate('io', io);

  // Pass io to zalo pool for real-time event emission
  zaloPool.setIO(io);

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);
    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
    });
  });

  // Register Zalo Socket.IO event handlers
  registerZaloSocketHandlers(io);

  // Register chat Socket.IO event handlers
  registerChatSocketHandlers(io);

  // ── Routes ────────────────────────────────────────────────────────────────

  await app.register(authRoutes);

  // ── Plugin host ───────────────────────────────────────────────────────────
  // Nạp plugin core (12 module: branding, dashboard, analytics, search,
  // notifications, scoring, activity, ai, api, engagement, rbac, privacy)
  // + bundle tùy chọn (nếu cài). Xem core/plugin-host.ts + modules/plugins-index.ts.
  const { ctx } = buildContext(app, io);
  await loadPlugins(ctx);

  await app.register(zaloRoutes);
  await app.register(chatRoutes);
  await app.register(folderRoutes);
  await app.register(presetRoutes);
  await app.register(chatAttachmentRoutes);
  await app.register(contactRoutes);
  await app.register(statusRoutes);
  await app.register(contactSubResourceRoutes);
  await app.register(appointmentRoutes);
  await app.register(notesRoutes);
  await app.register(crmTagRoutes);
  await app.register(crmTagGroupRoutes);
  await app.register(userPreferenceRoutes);
  // engagement (heatmap), rbac (department/permission/user-assignment), privacy (PIN)
  // đã chuyển sang plugin-host (batch 3). Xem modules/plugins-index.ts.
  await app.register(zaloLabelsRoutes);
  await app.register(zinstantProxyRoutes);
  await app.register(userRoutes);
  await app.register(teamRoutes);
  await app.register(orgRoutes);
  await app.register(zaloAccessRoutes);
  await app.register(zaloSyncRoutes);
  await app.register(zaloDashboardRoutes);
  await app.register(integrationRoutes);
  await app.register(facebookRoutes);
  await app.register(automationRoutes);
  await app.register(templateRoutes);
  // Phase 7 — Block authoring layer (must register BEFORE sequence/trigger/broadcast in later phases)
  await app.register(blockRoutes);
  await app.register(blockFolderRoutes);
  await app.register(sequenceRoutes);
  await app.register(triggerRoutes);
  await app.register(broadcastRoutes);
  await app.register(automationWebhookRoutes);
  // Tệp khách hàng — CustomerList CRUD + entries + enrichment + event handlers
  await app.register(customerListRoutes);
  await app.register(customerListEntryRoutes);
  await app.register(chatOperationsRoutes);
  await app.register(groupRoutes);
  await app.register(groupModerationRoutes);
  await app.register(friendRoutes);
  await app.register(profileRoutes);
  await app.register(credentialRoutes);

  // Liveness/readiness probe — also checks DB connectivity
  app.get('/health', async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'connected', timestamp: new Date().toISOString() };
    } catch {
      return { status: 'error', db: 'disconnected', timestamp: new Date().toISOString() };
    }
  });

  // API version banner
  app.get('/api/v1/status', async () => {
    return { version: '1.0.0', name: 'Zalo CRM' };
  });

  // SPA fallback — serve index.html for non-API routes in production
  if (config.isProduction) {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // ── Error handler ─────────────────────────────────────────────────────────

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
    let statusCode = error.statusCode ?? 500;
    // Fastify schema-validation failures are client errors, not 500s.
    if (error.validation) statusCode = 400;
    // Map common Prisma errors to sensible HTTP codes instead of a blanket 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') statusCode = 404;       // record not found
      else if (error.code === 'P2002') statusCode = 409;  // unique constraint
      else if (error.code === 'P2003') statusCode = 409;  // FK constraint
      else statusCode = 400;                              // other known request error
    } else if (error instanceof Prisma.PrismaClientValidationError) {
      statusCode = 400;
    }

    // Log full error (with stack) server-side; warn for 4xx, error for 5xx.
    if (statusCode >= 500) logger.error('Request error:', error);
    else logger.warn(`Request ${statusCode}: ${error.message}`);

    // Never leak internal error text for unmapped 5xx in production.
    const clientMessage =
      statusCode >= 500 && config.nodeEnv === 'production'
        ? 'Internal Server Error'
        : error.message || 'Internal Server Error';
    reply.status(statusCode).send({ error: clientMessage });
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  // Đảm bảo tài khoản admin bootstrap tồn tại (idempotent, non-fatal).
  // Chỉ chạy khi ENV BOOTSTRAP_ADMIN_PHONE/PASSWORD được cấu hình; bỏ qua khi test.
  if (config.nodeEnv !== 'test') {
    try {
      await ensureBootstrapAdmin();
    } catch (err) {
      logger.error('[ensure-admin] bootstrap admin thất bại (bỏ qua):', err);
    }
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`Zalo CRM running on http://${config.host}:${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);

    // Graceful shutdown — KEY FIX 2026-06-19: stop Zalo listeners sạch (gửi close frame)
    // trước khi exit để Zalo giải phóng session. Nếu không, container bị SIGKILL đột ngột
    // → Zalo giữ session cũ → restart sau login lại bị từ chối (reconnect_failed → kẹt
    // qr_pending ~vài phút). Docker gửi SIGTERM (tini forward) → ta có ~10s để dọn.
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`[shutdown] ${signal} received — stopping Zalo listeners + closing server`);
      const force = setTimeout(() => { logger.warn('[shutdown] timeout — force exit'); process.exit(0); }, 8000);
      force.unref();
      try { zaloPool.shutdownAll(); } catch (err) { logger.error('[shutdown] pool error:', err); }
      try { await app.close(); } catch (err) { logger.error('[shutdown] server close error:', err); }
      clearTimeout(force);
      process.exit(0);
    };
    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

    startAppointmentReminder(io);
    startZaloHealthCheck();
    startContactIntelligence();
    startLabelsBackgroundSync(60_000); // realtime-ish 2-way pull every 60s
    startInteractionCron(); // daily silent_30d detection (02:00 VN)
    // Phase 8 — Engagement heatmap classification (02:30 VN daily)
    const { startEngagementCron } = await import('./modules/engagement/engagement-cron.js');
    startEngagementCron();
    // Phase A — Real-time Zalo presence cache + bulk refresh 60s + socket emit
    const { startPresenceCron } = await import('./modules/zalo/presence-service.js');
    startPresenceCron(io);
    // Friend full-sync periodic (*/15 min) — catch alias/name/avatar drift từ Zalo
    // native app mà friend_event listener không bắt được (xem friend-sync-cron.ts)
    const { startFriendSyncCron } = await import('./modules/zalo/friend-sync-cron.js');
    startFriendSyncCron(io);
    // Phase ZaloAccounts redesign 2026-05-22 — status log: backfill open records 1
    // lần lúc startup (idempotent), rồi start checkpoint cron (*/5 min) reconcile
    // orphan records sau crash. Uptime accuracy = 5p resolution.
    const { backfillStatusLog } = await import('./modules/zalo/status-log-backfill.js');
    backfillStatusLog().catch((err) => logger.error('[status-log-backfill] failed:', err));
    const { startStatusLogCheckpointCron } = await import('./modules/zalo/status-log-checkpoint-cron.js');
    startStatusLogCheckpointCron();
    // Phase 6 — Lead Scoring background jobs (decay hourly + stuck detection 6am daily)
    const { startScoringScheduler } = await import('./modules/scoring/scoring-scheduler.js');
    startScoringScheduler({ enabled: config.nodeEnv !== 'test' });
    await eventBuffer.start(io);
    // Phase 7 — Automation engine (event bus + materializer + task worker + 3 action handlers)
    if (config.nodeEnv !== 'test') {
      const { startAutomationEngine } = await import('./modules/automation/engine/index.js');
      startAutomationEngine();
      // Trả lời tự động theo ngữ cảnh — bám vào event bus của engine, chỉ soạn
      // nháp chờ người duyệt, không tự gửi tin cho khách.
      const { startAutoReplyListener } = await import('./modules/ai/auto-reply/listener.js');
      startAutoReplyListener();
      // Phase F — Broadcast scheduler: poll automation_broadcasts scheduled→running
      const { startBroadcastScheduler } = await import('./modules/automation/broadcasts/broadcast-scheduler.js');
      startBroadcastScheduler();
      // Tệp khách hàng — enrichment worker + reverse-update event handlers
      startListEnrichmentWorker();
      registerCustomerListEventHandlers();
      // FB Lead Ingestion — BullMQ worker (Phase 04)
      const { startFacebookLeadIngestionWorker } = await import('./modules/integrations/providers/facebook/facebook-lead-worker.js');
      void startFacebookLeadIngestionWorker();
      // FB Form Discovery — BullMQ worker (Phase FB-11)
      const { startFormDiscoveryWorker } = await import('./modules/integrations/providers/facebook/facebook-form-discovery-worker.js');
      void startFormDiscoveryWorker();
      // FB Page Token refresh — daily cron @ 03:00 (Phase 06)
      const { startFacebookTokenRefreshCron } = await import('./modules/integrations/providers/facebook/facebook-token-refresh-cron.js');
      startFacebookTokenRefreshCron();
    }
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }

  // Reconnect Zalo accounts that have saved sessions
  try {
    const accounts = await prisma.zaloAccount.findMany({
      where: { sessionData: { not: Prisma.JsonNull }, archivedAt: null, status: { not: 'disconnected' } },
      select: { id: true, sessionData: true },
    });
    logger.info(`Attempting reconnect for ${accounts.length} Zalo account(s)`);
    for (const account of accounts) {
      const session = account.sessionData as {
        cookie: any;
        imei: string;
        userAgent: string;
      } | null;
      if (session?.imei) {
        // Qua ensureReconnecting → thử ngay + tự backoff retry nếu Zalo từ chối lúc boot
        // (sau restart Zalo thường giữ session cũ vài phút). Không còn 1-shot rồi đợi 5'.
        zaloPool.ensureReconnecting(account.id);
      }
    }
  } catch (err) {
    logger.error('Failed to load accounts for reconnect:', err);
  }
}

// Keep process alive — log but never crash on unhandled errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

bootstrap();
