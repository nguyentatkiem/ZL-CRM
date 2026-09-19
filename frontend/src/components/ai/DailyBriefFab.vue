<!--
  DailyBriefFab.vue — popup nổi "Tình trạng khách hàng hôm nay".

  Nút tròn nổi góc dưới phải, luôn có mặt trên mọi trang (mount ở DefaultLayout +
  MobileLayout). Badge đỏ = số khách nhắn tới hôm nay chưa được trả lời.

  Mở popup → gọi /ai/daily-brief/snapshot (SQL thuần, không tốn quota AI) để hiện
  số liệu ngay. Nhân viên bấm gợi ý hoặc gõ câu hỏi → /ai/daily-brief/ask mới gọi AI.

  Câu trả lời render bằng text thuần (white-space: pre-wrap), KHÔNG v-html — nội
  dung do AI sinh, không đưa vào DOM dưới dạng markup.
-->
<template>
  <!-- ── Nút nổi ── -->
  <button
    v-if="!open"
    class="brief-fab"
    :title="fabTitle"
    @click="openPanel"
  >
    <v-icon size="24">mdi-account-clock-outline</v-icon>
    <span v-if="waitingBadge" class="brief-fab__badge">{{ waitingBadge }}</span>
  </button>

  <!-- ── Panel nổi ── -->
  <section v-else class="brief-panel" role="dialog" aria-label="Tình trạng khách hàng hôm nay">
    <header class="brief-panel__head">
      <div class="brief-panel__title">
        <v-icon size="18" class="mr-2">mdi-account-clock-outline</v-icon>
        <div>
          <div class="t1">Khách hàng hôm nay</div>
          <div class="t2">{{ snapshot?.date || '—' }}</div>
        </div>
      </div>
      <div class="brief-panel__head-actions">
        <button class="ghost-btn" title="Tải lại số liệu" :disabled="loadingSnapshot" @click="loadSnapshot">
          <v-icon size="16">mdi-refresh</v-icon>
        </button>
        <button class="ghost-btn" title="Đóng" @click="open = false">
          <v-icon size="18">mdi-close</v-icon>
        </button>
      </div>
    </header>

    <div ref="bodyRef" class="brief-panel__body">
      <v-progress-linear v-if="loadingSnapshot" indeterminate color="primary" height="2" />

      <p v-if="snapshotError" class="brief-error">{{ snapshotError }}</p>

      <!-- Số liệu nhanh -->
      <div v-if="snapshot" class="brief-stats">
        <div class="stat" :class="{ 'stat--alert': snapshot.totals.waitingReply > 0 }">
          <span class="v">{{ snapshot.totals.waitingReply }}</span>
          <span class="k">chờ trả lời</span>
        </div>
        <div class="stat">
          <span class="v">{{ snapshot.totals.messagesIn }}</span>
          <span class="k">tin khách gửi</span>
        </div>
        <div class="stat">
          <span class="v">{{ snapshot.totals.newContacts }}</span>
          <span class="k">khách mới</span>
        </div>
        <div class="stat">
          <span class="v">{{ snapshot.totals.appointmentsToday }}</span>
          <span class="k">lịch hẹn</span>
        </div>
        <div class="stat" :class="{ 'stat--alert': snapshot.overdueFollowUps.length > 0 }">
          <span class="v">{{ snapshot.overdueFollowUps.length }}</span>
          <span class="k">hẹn quá hạn</span>
        </div>
      </div>

      <p v-if="snapshot && snapshot.scope.zaloAccounts === 0" class="brief-note">
        Chưa có nick Zalo nào bạn xem được — số liệu đang rỗng.
      </p>
      <p v-else-if="snapshot && snapshot.scope.hiddenPrivateAccounts > 0" class="brief-note">
        Đã bỏ qua {{ snapshot.scope.hiddenPrivateAccounts }} nick riêng tư của người khác.
      </p>

      <!-- Khách đang chờ -->
      <div v-if="snapshot?.waitingCustomers.length" class="brief-block">
        <div class="brief-block__title">Đang chờ mình trả lời</div>
        <div v-for="(c, i) in topWaiting" :key="i" class="waiting-row">
          <div class="waiting-row__main">
            <span class="name">{{ c.name }}</span>
            <span v-if="c.status" class="tag">{{ c.status }}</span>
          </div>
          <div class="waiting-row__sub">
            <span>{{ formatWait(c.waitingMinutes) }}</span>
            <span v-if="c.assignedTo">· {{ c.assignedTo }}</span>
            <span v-if="c.lastMessage" class="msg">· {{ c.lastMessage }}</span>
          </div>
        </div>
        <button
          v-if="snapshot.waitingCustomers.length > topWaiting.length"
          class="link-btn"
          @click="showAllWaiting = true"
        >
          Xem thêm {{ snapshot.waitingCustomers.length - topWaiting.length }} khách
        </button>
      </div>

      <!-- Hội thoại với AI -->
      <div v-for="(turn, i) in turns" :key="i" class="turn">
        <div v-if="turn.question" class="turn__q">{{ turn.question }}</div>
        <div class="turn__a">{{ turn.answer }}</div>
        <div class="turn__meta">{{ turn.model }} · {{ turn.at }}</div>
      </div>

      <div v-if="asking" class="turn turn--loading">
        <v-progress-circular indeterminate size="16" width="2" color="primary" class="mr-2" />
        AI đang đọc dữ liệu hôm nay…
      </div>

      <p v-if="askError" class="brief-error">{{ askError }}</p>
    </div>

    <!-- Gợi ý + ô hỏi -->
    <footer class="brief-panel__foot">
      <div class="suggestions">
        <button
          v-for="s in suggestions"
          :key="s"
          class="chip"
          :disabled="asking"
          @click="ask(s)"
        >{{ s }}</button>
      </div>
      <div class="ask-row">
        <textarea
          v-model="question"
          class="ask-input"
          rows="1"
          placeholder="Hỏi về khách hàng hôm nay…"
          :disabled="asking"
          @keydown.enter.exact.prevent="ask()"
        />
        <button class="send-btn" :disabled="asking" :title="question.trim() ? 'Gửi' : 'Tổng hợp hôm nay'" @click="ask()">
          <v-icon size="18">{{ question.trim() ? 'mdi-send' : 'mdi-auto-fix' }}</v-icon>
        </button>
      </div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import { api } from '@/api';

type WaitingCustomer = {
  name: string;
  kind: string;
  zaloAccount: string | null;
  assignedTo: string | null;
  status: string | null;
  leadScore: number | null;
  unread: number;
  waitingMinutes: number | null;
  lastMessage: string | null;
};

type Snapshot = {
  date: string;
  scope: { zaloAccounts: number; hiddenPrivateAccounts: number };
  totals: {
    messagesIn: number; messagesOut: number; activeConversations: number;
    waitingReply: number; newContacts: number; appointmentsToday: number; appointmentsDone: number;
  };
  waitingCustomers: WaitingCustomer[];
  newCustomers: Array<Record<string, unknown>>;
  appointments: Array<Record<string, unknown>>;
  overdueFollowUps: Array<Record<string, unknown>>;
  pipeline: Array<{ status: string; contacts: number }>;
};

const open = ref(false);
const snapshot = ref<Snapshot | null>(null);
const loadingSnapshot = ref(false);
const snapshotError = ref('');
const asking = ref(false);
const askError = ref('');
const question = ref('');
const showAllWaiting = ref(false);
const bodyRef = ref<HTMLElement | null>(null);

const turns = ref<Array<{ question: string | null; answer: string; model: string; at: string }>>([]);

const suggestions = [
  'Tổng hợp hôm nay',
  'Khách nào cần gọi trước?',
  'Có khách nào sắp nguội không?',
  'Việc nào đang bị bỏ quên?',
];

const waitingBadge = computed(() => {
  const n = snapshot.value?.totals.waitingReply ?? 0;
  return n > 99 ? '99+' : n > 0 ? String(n) : '';
});

const fabTitle = computed(() =>
  waitingBadge.value
    ? `Hỏi AI về khách hàng hôm nay — ${waitingBadge.value} khách đang chờ`
    : 'Hỏi AI về khách hàng hôm nay',
);

const topWaiting = computed(() =>
  showAllWaiting.value ? (snapshot.value?.waitingCustomers ?? []) : (snapshot.value?.waitingCustomers ?? []).slice(0, 5),
);

function formatWait(minutes: number | null) {
  if (minutes === null) return 'chưa rõ thời gian';
  if (minutes < 60) return `chờ ${minutes} phút`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `chờ ${h}h${m}p` : `chờ ${h} giờ`;
}

function errorText(err: unknown, fallback: string) {
  const res = (err as { response?: { data?: { error?: string } } })?.response;
  return res?.data?.error || fallback;
}

async function loadSnapshot() {
  loadingSnapshot.value = true;
  snapshotError.value = '';
  try {
    const res = await api.get('/ai/daily-brief/snapshot');
    snapshot.value = res.data;
  } catch (err) {
    snapshotError.value = errorText(err, 'Không lấy được số liệu hôm nay');
  } finally {
    loadingSnapshot.value = false;
  }
}

function openPanel() {
  open.value = true;
  if (!snapshot.value) loadSnapshot();
}

async function ask(preset?: string) {
  if (asking.value) return;
  const q = (preset ?? question.value).trim();
  asking.value = true;
  askError.value = '';
  await nextTick();
  scrollToEnd();
  try {
    const res = await api.post('/ai/daily-brief/ask', { question: q || undefined }, { timeout: 120000 });
    turns.value.push({
      question: q || null,
      answer: res.data.answer,
      model: `${res.data.provider}/${res.data.model}`,
      at: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
    });
    snapshot.value = res.data.snapshot; // ask trả kèm snapshot mới → số liệu tự tươi
    if (!preset) question.value = '';
  } catch (err) {
    askError.value = errorText(err, 'Không hỏi được AI, thử lại sau');
  } finally {
    asking.value = false;
    await nextTick();
    scrollToEnd();
  }
}

function scrollToEnd() {
  const el = bodyRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/* Nạp sẵn số liệu 1 lần khi vào app để badge có số ngay, không cần mở popup. */
onMounted(() => {
  loadSnapshot();
});
</script>

<style scoped>
.brief-fab {
  position: fixed;
  right: 20px; bottom: 20px;
  width: 52px; height: 52px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, #0077B6, #00A6D6);
  color: white;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
  cursor: pointer;
  z-index: 2400;
  display: flex; align-items: center; justify-content: center;
}
.brief-fab:hover { filter: brightness(1.08); }
.brief-fab__badge {
  position: absolute; top: -2px; right: -2px;
  min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 10px;
  background: #e53935; color: white;
  font-size: 11px; font-weight: 700; line-height: 20px;
  border: 2px solid white;
}

.brief-panel {
  position: fixed;
  right: 20px; bottom: 20px;
  width: 420px;
  max-height: min(76vh, 680px);
  display: flex; flex-direction: column;
  background: var(--smax-bg, #fff);
  color: var(--smax-text, #1f2937);
  border-radius: 14px;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.24);
  z-index: 2400;
  overflow: hidden;
}
@media (max-width: 640px) {
  .brief-panel {
    right: 8px; left: 8px; bottom: 76px; /* chừa chỗ cho BottomNav */
    width: auto;
    max-height: 70vh;
  }
  .brief-fab { bottom: 78px; }
}

.brief-panel__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  background: linear-gradient(135deg, #0077B6, #00A6D6);
  color: white;
  flex-shrink: 0;
}
.brief-panel__title { display: flex; align-items: center; }
.brief-panel__title .t1 { font-size: 13.5px; font-weight: 600; line-height: 1.2; }
.brief-panel__title .t2 { font-size: 11px; opacity: 0.85; }
.brief-panel__head-actions { display: flex; gap: 2px; }
.ghost-btn {
  width: 28px; height: 28px; border-radius: 6px;
  background: transparent; border: none; color: white; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.ghost-btn:hover { background: rgba(255, 255, 255, 0.16); }
.ghost-btn:disabled { opacity: 0.5; cursor: default; }

.brief-panel__body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 10px 12px;
}

.brief-stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}
.stat {
  background: var(--smax-grey-100, #f3f4f6);
  border-radius: 8px;
  padding: 6px 4px;
  text-align: center;
}
.stat--alert { background: #fdecea; }
.stat .v { display: block; font-size: 16px; font-weight: 700; line-height: 1.1; }
.stat--alert .v { color: #c62828; }
.stat .k { display: block; font-size: 10px; opacity: 0.7; line-height: 1.2; margin-top: 2px; }

.brief-note { font-size: 11.5px; opacity: 0.7; margin: 0 0 8px; }
.brief-error {
  font-size: 12px; color: #c62828;
  background: #fdecea; border-radius: 7px;
  padding: 7px 9px; margin: 0 0 8px;
}

.brief-block { margin-bottom: 12px; }
.brief-block__title {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.4px; opacity: 0.55; margin-bottom: 5px;
}
.waiting-row {
  padding: 6px 8px;
  border-radius: 7px;
  background: var(--smax-grey-100, #f7f8fa);
  margin-bottom: 4px;
}
.waiting-row__main { display: flex; align-items: center; gap: 6px; }
.waiting-row__main .name { font-size: 12.5px; font-weight: 600; }
.waiting-row__main .tag {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: rgba(0, 119, 182, 0.12); color: #0077B6;
}
.waiting-row__sub {
  font-size: 11px; opacity: 0.68; margin-top: 2px;
  display: flex; gap: 4px; flex-wrap: wrap;
}
.waiting-row__sub .msg {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
.link-btn {
  background: none; border: none; padding: 2px 0;
  color: #0077B6; font-size: 11.5px; cursor: pointer;
}

.turn { margin-bottom: 12px; }
.turn__q {
  font-size: 12px; font-weight: 600;
  background: rgba(0, 119, 182, 0.10);
  border-radius: 8px; padding: 6px 9px;
  margin-bottom: 6px;
}
.turn__a {
  font-size: 12.5px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
.turn__meta { font-size: 10px; opacity: 0.45; margin-top: 4px; }
.turn--loading { display: flex; align-items: center; font-size: 12px; opacity: 0.7; }

.brief-panel__foot {
  flex-shrink: 0;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  padding: 8px 10px 10px;
  background: var(--smax-bg, #fff);
}
.suggestions { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
.chip {
  font-size: 11px; padding: 4px 9px;
  border-radius: 12px; cursor: pointer;
  border: 1px solid rgba(0, 119, 182, 0.35);
  background: transparent; color: #0077B6;
}
.chip:hover:not(:disabled) { background: rgba(0, 119, 182, 0.10); }
.chip:disabled { opacity: 0.45; cursor: default; }

.ask-row { display: flex; align-items: flex-end; gap: 6px; }
.ask-input {
  flex: 1;
  resize: none;
  font: inherit; font-size: 12.5px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid rgba(0, 0, 0, 0.16);
  background: var(--smax-bg, #fff);
  color: inherit;
  max-height: 84px;
}
.ask-input:focus { outline: none; border-color: #0077B6; }
.send-btn {
  width: 36px; height: 36px; border-radius: 9px;
  border: none; cursor: pointer;
  background: #0077B6; color: white;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.send-btn:disabled { opacity: 0.5; cursor: default; }
</style>
