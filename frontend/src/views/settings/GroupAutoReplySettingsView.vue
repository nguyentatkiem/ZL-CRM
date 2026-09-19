<!--
  GroupAutoReplySettingsView.vue — chỉ định nhóm Zalo nào AI được tự trả lời.

  KHÁC trang "Trả lời tự động" (1-1, chỉ soạn nháp): ở đây AI TỰ GỬI tin vào nhóm.
  Có công tắc tổng để dừng mọi nhóm cùng lúc, công tắc riêng từng nhóm, và nút
  "Chạy thử" để xem AI sẽ nói gì với tin mới nhất mà không gửi gì cả.
-->
<template>
  <div class="gar">
    <div class="gar-title">
      <h2>Trả lời tự động trong nhóm</h2>
      <p>
        Chọn nhóm nào thì AI vào nhóm đó đọc ngữ cảnh và <strong>tự gửi</strong> câu trả lời.
        AI được quyền im lặng: chào hỏi, cảm ơn, hay chuyện riêng giữa hai người thì không chen vào.
        Tin có từ khoá nhạy cảm luôn để người thật xử lý.
      </p>
    </div>

    <!-- ════════ Công tắc tổng ════════ -->
    <v-card variant="outlined" class="mb-4" :class="{ 'gar-master--on': groupEnabled }">
      <v-card-text class="d-flex align-center flex-wrap" style="gap: 12px;">
        <v-switch
          :model-value="groupEnabled"
          color="success"
          inset hide-details
          :loading="savingMaster"
          @update:model-value="toggleMaster"
        />
        <div>
          <div class="gar-master-label">{{ groupEnabled ? 'Công tắc tổng: ĐANG BẬT' : 'Công tắc tổng: ĐANG TẮT' }}</div>
          <div class="gar-master-sub">
            {{ groupEnabled
              ? `AI đang tự trả lời trong ${enabledCount} nhóm được chọn.`
              : 'Mọi nhóm đều dừng, kể cả nhóm đã bật riêng. Bật lên thì nhóm nào đã chọn mới chạy.' }}
          </div>
        </div>
      </v-card-text>
      <v-divider />
      <v-card-text class="d-flex align-center flex-wrap" style="gap: 12px;">
        <v-switch :model-value="autoEnroll" color="primary" inset hide-details @update:model-value="toggleAutoEnroll" />
        <div>
          <div class="gar-master-label">Tự bật cho nhóm Thầy đang dẫn dắt: {{ autoEnroll ? 'BẬT' : 'TẮT' }}</div>
          <div class="gar-master-sub">
            Mỗi giờ tự rà: nhóm nào Thầy tự nhắn từ 10 tin trở lên trong 30 ngày, 20 đến 300 thành viên, có người nhắn trong tuần,
            thì tự bật (xưng Thầy, luôn trả lời, học lịch sử). Bỏ qua nhóm khách doanh nghiệp, coaching riêng, nội bộ, đối tác.
            Nhóm đã tự tắt thì không bao giờ tự bật lại.
          </div>
        </div>
      </v-card-text>
    </v-card>

    <v-alert v-if="loadError" type="error" density="compact" class="mb-4">{{ loadError }}</v-alert>

    <!-- ════════ Danh sách nhóm ════════ -->
    <v-card variant="outlined">
      <v-card-text>
        <div class="d-flex align-center flex-wrap mb-3" style="gap: 12px;">
          <v-text-field
            v-model="search"
            placeholder="Tìm tên nhóm…"
            prepend-inner-icon="mdi-magnify"
            density="compact" hide-details clearable
            style="max-width: 320px;"
          />
          <v-checkbox v-model="onlyEnabled" label="Chỉ nhóm đang bật" density="compact" hide-details />
          <v-spacer />
          <span class="gar-count">{{ filtered.length }} nhóm</span>
        </div>

        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-2" />

        <v-table density="compact" class="gar-table">
          <thead>
            <tr>
              <th style="width: 70px;">Bật</th>
              <th>Nhóm</th>
              <th>Nick</th>
              <th class="text-center">Thành viên</th>
              <th>Chế độ</th>
              <th class="text-center">Đã trả lời 24h</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in filtered" :key="g.conversationId" :class="{ 'gar-row--on': g.enabled }">
              <td>
                <v-switch
                  :model-value="g.enabled"
                  color="success" inset hide-details density="compact"
                  :disabled="busy.has(g.conversationId)"
                  @update:model-value="(v) => toggleGroup(g, !!v)"
                />
              </td>
              <td>
                <div class="gar-name">{{ g.groupName }} <span v-if="g.enrolledBy === 'auto'" class="gar-tag-auto">tự bật</span></div>
                <div v-if="g.nickPrivate" class="gar-tag-private">nick Riêng tư</div>
              </td>
              <td class="gar-muted">{{ g.nick || '—' }}</td>
              <td class="text-center gar-muted">{{ g.members ?? '—' }}</td>
              <td class="gar-muted">
                <span v-if="g.alwaysReply" class="gar-tag-always">Luôn trả lời</span>
                <template v-else>{{ modeLabel(g.triggerMode) }}</template>
              </td>
              <td class="text-center">{{ g.sentLast24h }}</td>
              <td class="text-right">
                <v-btn size="small" variant="text" prepend-icon="mdi-tune" @click="openGroup(g)">Cấu hình</v-btn>
              </td>
            </tr>
            <tr v-if="!loading && filtered.length === 0">
              <td colspan="7" class="text-center gar-muted pa-6">Không có nhóm nào khớp.</td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <!-- ════════ Hộp cấu hình một nhóm ════════ -->
    <v-dialog v-model="dialog" max-width="760" scrollable>
      <v-card v-if="current" class="gar-dialog">
        <v-card-title class="d-flex align-center">
          <span class="gar-dialog-title">{{ current.groupName }}</span>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="dialog = false" />
        </v-card-title>

        <v-card-text>
          <v-alert v-if="formError" type="error" density="compact" class="mb-3">{{ formError }}</v-alert>

          <v-switch v-model="rule.enabled" color="success" inset hide-details
            :label="rule.enabled ? 'AI đang tự trả lời trong nhóm này' : 'Đang tắt với nhóm này'" class="mb-3" />

          <!-- Danh tính & xưng hô -->
          <div class="gar-label">Danh tính &amp; xưng hô</div>
          <p class="gar-muted gar-small mb-2">
            Tin gửi đi dưới nick của ai thì AI nói đúng vai người đó. Chọn mẫu rồi sửa nếu cần.
          </p>
          <div class="gar-presets mb-3">
            <button
              v-for="pr in personaPresets" :key="pr.key" type="button"
              class="gar-preset" :class="{ 'gar-preset--on': isPreset(pr) }"
              @click="applyPreset(pr)"
            >
              <strong>{{ pr.label }}</strong>
              <span>xưng "{{ pr.self }}" · gọi "{{ pr.group }}"</span>
            </button>
          </div>
          <div class="gar-grid mb-1">
            <v-text-field v-model="rule.speakerRole" label="Vai trò của người đứng tên nick" density="comfortable"
              placeholder="vd: Giảng viên khoá AI Business System" style="grid-column: 1 / -1;" />
            <v-text-field v-model="rule.selfPronoun" label="Tự xưng là" density="comfortable" placeholder="Thầy" />
            <v-text-field v-model="rule.groupPronoun" label="Gọi cả nhóm là" density="comfortable" placeholder="các bạn" />
            <v-text-field v-model="rule.memberPronoun" label="Gọi riêng một người là" density="comfortable" placeholder="bạn" />
          </div>
          <div v-if="rule.selfPronoun" class="gar-persona-preview mb-4">
            Ví dụ AI sẽ viết: <em>"@Minh Anh câu này hay, {{ rule.selfPronoun }} sẽ giải đáp kỹ trong buổi học nhé {{ rule.memberPronoun || 'bạn' }}."</em>
          </div>
          <div v-else class="gar-persona-preview gar-persona-preview--warn mb-4">
            Chưa cài xưng hô, AI sẽ xưng "em" như trợ lý. Nếu nick này là của giảng viên hoặc chủ nhóm, hãy chọn mẫu ở trên.
          </div>

          <v-switch v-model="rule.alwaysReply" color="deep-orange" inset hide-details class="mb-1"
            :label="rule.alwaysReply ? 'Luôn trả lời — AI không im lặng' : 'AI được quyền im lặng khi không cần thiết'" />
          <p class="gar-muted gar-small mb-3" style="margin-left: 4px;">
            Luôn trả lời: mọi tin đều được đáp. Câu không có thông tin thì AI ghi nhận và hẹn người thật trả lời,
            không bịa. Nhiều người hỏi dồn thì gộp thành một tin gọi tên từng người.
          </p>

          <div class="gar-label">Khi nào AI mới xét tin</div>
          <v-radio-group v-model="rule.triggerMode" hide-details class="mb-3">
            <v-radio value="mention" label="Chỉ khi được gọi tên — an toàn nhất, hợp nhóm đông người" />
            <v-radio value="question" label="Khi được gọi tên hoặc có người đặt câu hỏi (mặc định)" />
            <v-radio value="all" label="Mọi tin — AI tự quyết có nên chen vào không (tốn quota nhất)" />
          </v-radio-group>

          <v-combobox
            v-model="rule.callNames"
            label="Tên gọi AI trong nhóm"
            multiple chips closable-chips
            hint="Ngoài @tên nick, thành viên gọi những tên này thì AI hiểu là đang gọi mình. Ví dụ: ad, trợ lý, admin ơi"
            persistent-hint
            class="mb-4"
          />

          <v-textarea
            v-model="rule.instruction"
            label="Lời dặn riêng cho nhóm này"
            rows="4" counter="3000"
            hint="Vai trò của AI trong nhóm, giọng điệu, điều được và không được nói. Ưu tiên cao nhất khi AI viết."
            persistent-hint
            class="mb-4"
          />

          <div class="gar-grid">
            <v-text-field v-model.number="rule.maxRepliesPerHour" type="number" min="1" max="60"
              label="Tối đa tin mỗi giờ" density="comfortable" hint="Chặn AI nói quá nhiều" persistent-hint />
            <v-text-field v-model.number="rule.minGapSeconds" type="number" min="30"
              label="Nghỉ tối thiểu giữa 2 tin (giây)" density="comfortable" hint="Dưới 30 giây dễ bị Zalo đánh dấu spam" persistent-hint />
            <v-text-field v-model.number="rule.hourStart" type="number" min="0" max="23" label="Từ giờ" density="comfortable" />
            <v-text-field v-model.number="rule.hourEnd" type="number" min="0" max="23" label="Đến giờ" density="comfortable" />
          </div>
          <v-checkbox v-model="rule.quoteOriginal" hide-details density="compact"
            label="Trả lời dạng trích dẫn tin người hỏi (để cả nhóm biết AI đang nói với ai)" class="mt-1" />

          <!-- Bộ não nhóm -->
          <v-divider class="my-4" />
          <div class="d-flex align-center mb-1" style="gap: 10px;">
            <div class="gar-label mb-0">Bộ não nhóm · {{ brain.filter((b) => b.enabled).length }} điều đã biết</div>
            <v-spacer />
            <v-switch v-model="rule.brainEnabled" color="primary" inset hide-details density="compact"
              :label="rule.brainEnabled ? 'Tự học: bật' : 'Tự học: tắt'" />
          </div>
          <p class="gar-muted gar-small mb-2">
            AI tự rút điều chắc chắn từ tin <strong>chính {{ rule.selfPronoun || 'người phụ trách' }} gõ tay</strong> trong nhóm (lịch học, link,
            câu trả lời chuyên môn), 10 phút học một lần. Không học từ tin thành viên, không học từ tin AI tự gửi.
            Điều nào sai thì tắt hoặc xoá.
          </p>
          <div class="d-flex mb-2" style="gap: 8px;">
            <v-text-field v-model="newFact" density="compact" hide-details placeholder="Thêm tay một điều AI cần biết…"
              @keydown.enter.prevent="addFact" />
            <v-btn variant="tonal" :disabled="!newFact.trim()" @click="addFact">Thêm</v-btn>
            <v-btn variant="tonal" color="primary" prepend-icon="mdi-brain" :loading="learning" @click="learnNow">Học từ 30 ngày</v-btn>
          </div>
          <div v-if="learnMsg" class="gar-muted gar-small mb-2">{{ learnMsg }}</div>
          <div class="gar-brain">
            <div v-if="brain.length === 0" class="gar-muted gar-small pa-2">Chưa học được gì. Bấm "Học từ 30 ngày" hoặc thêm tay.</div>
            <div v-for="b in brain" :key="b.id" class="gar-brain-row" :class="{ 'gar-brain-row--off': !b.enabled }">
              <v-checkbox-btn :model-value="b.enabled" density="compact" @update:model-value="(v) => toggleFact(b, !!v)" />
              <div class="gar-brain-text">{{ b.content }}</div>
              <span class="gar-brain-src">{{ b.source === 'manual' ? 'thêm tay' : 'tự học' }}</span>
              <v-btn icon="mdi-delete-outline" size="x-small" variant="text" color="error" @click="removeFact(b)" />
            </div>
          </div>

          <!-- Chạy thử -->
          <v-divider class="my-4" />
          <div class="d-flex align-center mb-2">
            <div class="gar-label mb-0">Chạy thử với tin mới nhất trong nhóm</div>
            <v-spacer />
            <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-flask-outline"
              :loading="dryRunning" @click="dryRun">Chạy thử</v-btn>
          </div>
          <p class="gar-muted gar-small">Chỉ xem AI sẽ làm gì — <strong>không gửi</strong> tin nào vào nhóm. Chạy được cả khi đang tắt.</p>

          <div v-if="dryResult" class="gar-dry" :class="dryResult.shouldReply ? 'gar-dry--reply' : 'gar-dry--silent'">
            <div class="gar-dry-head">
              <strong>{{ dryHeadline }}</strong>
              <span v-if="dryResult.latencyMs" class="gar-muted"> · {{ (dryResult.latencyMs / 1000).toFixed(1) }}s</span>
            </div>
            <div v-if="dryResult.content" class="gar-dry-text">{{ dryResult.content }}</div>
            <div class="gar-dry-why">{{ dryResult.reason }}</div>
            <div v-if="dryResult.wouldTrigger === false" class="gar-dry-warn">
              Lưu ý: với chế độ đang chọn, tin này sẽ KHÔNG được AI xét khi chạy thật.
            </div>
          </div>

          <!-- Nhật ký -->
          <v-divider class="my-4" />
          <div class="gar-label">Nhật ký gần đây</div>
          <div v-if="logs.length === 0" class="gar-muted gar-small">Chưa có lượt nào.</div>
          <div v-for="l in logs" :key="l.id" class="gar-log">
            <span class="gar-log-badge" :class="`gar-log--${l.decision}`">{{ decisionLabel(l.decision) }}</span>
            <span class="gar-log-time">{{ formatTime(l.createdAt) }}</span>
            <div v-if="l.content" class="gar-log-text">{{ l.content }}</div>
            <div class="gar-log-why">{{ l.reason }}</div>
          </div>
        </v-card-text>

        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">Đóng</v-btn>
          <v-btn color="primary" :loading="saving" @click="saveRule">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '@/api';
import { useToast } from '@/composables/use-toast';

type TriggerMode = 'mention' | 'question' | 'all';

interface GroupRow {
  conversationId: string;
  groupName: string;
  members: number | null;
  nick: string | null;
  nickPrivate: boolean;
  enabled: boolean;
  triggerMode: TriggerMode;
  alwaysReply: boolean;
  enrolledBy: string | null;
  sentLast24h: number;
}

interface LogRow { id: string; decision: string; reason: string | null; content: string | null; latencyMs: number | null; createdAt: string }

const toast = useToast();

const groupEnabled = ref(false);
const autoEnroll = ref(false);
const savingMaster = ref(false);
const groups = ref<GroupRow[]>([]);
const loading = ref(false);
const loadError = ref('');
const search = ref('');
const onlyEnabled = ref(false);
const busy = reactive(new Set<string>());

const dialog = ref(false);
const current = ref<GroupRow | null>(null);
const rule = reactive({
  enabled: false,
  triggerMode: 'question' as TriggerMode,
  callNames: [] as string[],
  instruction: '' as string | null,
  maxRepliesPerHour: 6,
  minGapSeconds: 120,
  hourStart: 7,
  hourEnd: 22,
  quoteOriginal: true,
  alwaysReply: false,
  speakerRole: '' as string | null,
  selfPronoun: '' as string | null,
  groupPronoun: '' as string | null,
  memberPronoun: '' as string | null,
  brainEnabled: true,
});

interface BrainItem { id: string; content: string; source: string; enabled: boolean }
const brain = ref<BrainItem[]>([]);
const newFact = ref('');
const learning = ref(false);
const learnMsg = ref('');

async function loadBrain() {
  if (!current.value) return;
  try {
    const res = await api.get(`/group-auto-reply/groups/${current.value.conversationId}/brain`);
    brain.value = res.data;
  } catch { brain.value = []; }
}

async function learnNow() {
  if (!current.value) return;
  learning.value = true;
  learnMsg.value = '';
  try {
    const res = await api.post(`/group-auto-reply/groups/${current.value.conversationId}/brain/learn`, { days: 30 }, { timeout: 180000 });
    const r = res.data;
    learnMsg.value = r.reason
      ? r.reason
      : `Đọc ${r.scanned} tin, học thêm ${r.learned} điều, cập nhật ${r.updated} điều.`;
    await loadBrain();
  } catch (err) {
    learnMsg.value = errorText(err, 'Học thất bại');
  } finally {
    learning.value = false;
  }
}

async function addFact() {
  if (!current.value || !newFact.value.trim()) return;
  try {
    await api.post(`/group-auto-reply/groups/${current.value.conversationId}/brain`, { content: newFact.value.trim() });
    newFact.value = '';
    await loadBrain();
  } catch (err) {
    toast.push(errorText(err, 'Không thêm được'), 'error');
  }
}

async function toggleFact(b: BrainItem, enabled: boolean) {
  try {
    await api.put(`/group-auto-reply/brain/${b.id}`, { enabled });
    b.enabled = enabled;
  } catch (err) {
    toast.push(errorText(err, 'Không đổi được'), 'error');
  }
}

async function removeFact(b: BrainItem) {
  if (!confirm('Xoá điều này khỏi bộ não?')) return;
  try {
    await api.delete(`/group-auto-reply/brain/${b.id}`);
    brain.value = brain.value.filter((x) => x.id !== b.id);
  } catch (err) {
    toast.push(errorText(err, 'Không xoá được'), 'error');
  }
}

/* Mẫu xưng hô hay dùng. Bấm là điền sẵn cả 4 ô, vẫn sửa tay được. */
const personaPresets = [
  { key: 'teacher', label: 'Giảng viên (Thầy)', role: 'Giảng viên đào tạo', self: 'Thầy', group: 'các bạn', member: 'bạn' },
  { key: 'teacher-f', label: 'Giảng viên (Cô)', role: 'Giảng viên đào tạo', self: 'Cô', group: 'các bạn', member: 'bạn' },
  { key: 'owner', label: 'Chủ nhóm / Admin', role: 'Chủ nhóm', self: 'mình', group: 'mọi người', member: 'bạn' },
  { key: 'assistant', label: 'Trợ lý lớp', role: 'Trợ lý lớp học', self: 'em', group: 'cả nhà', member: 'anh/chị' },
];

function rulePayload() {
  const blank = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return {
    ...rule,
    instruction: blank(rule.instruction),
    speakerRole: blank(rule.speakerRole),
    selfPronoun: blank(rule.selfPronoun),
    groupPronoun: blank(rule.groupPronoun),
    memberPronoun: blank(rule.memberPronoun),
  };
}

function applyPreset(pr: typeof personaPresets[number]) {
  rule.speakerRole = pr.role;
  rule.selfPronoun = pr.self;
  rule.groupPronoun = pr.group;
  rule.memberPronoun = pr.member;
}

function isPreset(pr: typeof personaPresets[number]) {
  return rule.selfPronoun === pr.self && rule.groupPronoun === pr.group && rule.memberPronoun === pr.member;
}
const saving = ref(false);
const formError = ref('');
const dryRunning = ref(false);
const dryResult = ref<{ shouldReply?: boolean; wouldTrigger?: boolean; content?: string | null; reason: string; latencyMs?: number; decision: string } | null>(null);
const logs = ref<LogRow[]>([]);

const enabledCount = computed(() => groups.value.filter((g) => g.enabled).length);

const filtered = computed(() => {
  const q = (search.value || '').trim().toLowerCase();
  return groups.value.filter((g) =>
    (!onlyEnabled.value || g.enabled) && (!q || g.groupName.toLowerCase().includes(q)),
  );
});

const dryHeadline = computed(() => {
  const r = dryResult.value;
  if (!r) return '';
  if (r.decision !== 'dry_run') return 'Bị chặn trước khi tới AI';
  return r.shouldReply ? 'AI sẽ trả lời:' : 'AI sẽ im lặng';
});

function modeLabel(m: string) {
  return m === 'mention' ? 'Khi gọi tên' : m === 'all' ? 'Mọi tin' : 'Gọi tên / câu hỏi';
}

function decisionLabel(d: string) {
  return ({ sent: 'Đã gửi', ai_declined: 'AI im lặng', skipped: 'Bỏ qua', failed: 'Lỗi', dry_run: 'Chạy thử' } as Record<string, string>)[d] ?? d;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

function errorText(err: unknown, fallback: string) {
  const res = (err as { response?: { data?: { error?: string } } })?.response;
  return res?.data?.error || fallback;
}

async function loadAll() {
  loading.value = true;
  loadError.value = '';
  try {
    const [cfg, list] = await Promise.all([
      api.get('/group-auto-reply/config'),
      api.get('/group-auto-reply/groups'),
    ]);
    groupEnabled.value = !!cfg.data.groupEnabled;
    autoEnroll.value = !!cfg.data.autoEnrollGroups;
    groups.value = list.data;
  } catch (err) {
    loadError.value = errorText(err, 'Không tải được danh sách nhóm');
  } finally {
    loading.value = false;
  }
}

async function toggleMaster(value: boolean | null) {
  const next = !!value;
  if (next && enabledCount.value === 0) {
    toast.push('Chưa chọn nhóm nào — bật công tắc ở từng nhóm trước', 'warning', 3500);
  }
  savingMaster.value = true;
  try {
    const res = await api.put('/group-auto-reply/config', { groupEnabled: next });
    groupEnabled.value = !!res.data.groupEnabled;
    toast.push(next ? 'Đã bật trả lời tự động trong nhóm' : 'Đã tắt — mọi nhóm dừng ngay', next ? 'success' : 'default');
  } catch (err) {
    toast.push(errorText(err, 'Không đổi được công tắc tổng'), 'error');
  } finally {
    savingMaster.value = false;
  }
}

async function toggleAutoEnroll(value: boolean | null) {
  try {
    const res = await api.put('/group-auto-reply/config', { autoEnrollGroups: !!value });
    autoEnroll.value = !!res.data.autoEnrollGroups;
    toast.push(autoEnroll.value ? 'Đã bật tự động, đang rà nhóm…' : 'Đã tắt tự bật nhóm', 'success');
    if (autoEnroll.value) setTimeout(loadAll, 4000);
  } catch (err) {
    toast.push(errorText(err, 'Không đổi được'), 'error');
  }
}

async function toggleGroup(g: GroupRow, value: boolean) {
  busy.add(g.conversationId);
  try {
    const res = await api.put(`/group-auto-reply/groups/${g.conversationId}`, { enabled: value });
    g.enabled = !!res.data.enabled;
    if (value && !groupEnabled.value) {
      toast.push(`Đã chọn "${g.groupName}" — công tắc tổng đang tắt nên chưa chạy`, 'warning', 3500);
    } else {
      toast.push(value ? `AI bắt đầu trả lời "${g.groupName}"` : `Đã tắt "${g.groupName}"`, value ? 'success' : 'default');
    }
  } catch (err) {
    toast.push(errorText(err, 'Không đổi được trạng thái nhóm'), 'error');
  } finally {
    busy.delete(g.conversationId);
  }
}

async function openGroup(g: GroupRow) {
  current.value = g;
  formError.value = '';
  dryResult.value = null;
  logs.value = [];
  dialog.value = true;
  try {
    const [r, l] = await Promise.all([
      api.get(`/group-auto-reply/groups/${g.conversationId}`),
      api.get(`/group-auto-reply/groups/${g.conversationId}/logs`),
    ]);
    Object.assign(rule, r.data, {
      instruction: r.data.instruction ?? '',
      speakerRole: r.data.speakerRole ?? '',
      selfPronoun: r.data.selfPronoun ?? '',
      groupPronoun: r.data.groupPronoun ?? '',
      memberPronoun: r.data.memberPronoun ?? '',
    });
    logs.value = l.data;
    learnMsg.value = '';
    await loadBrain();
  } catch (err) {
    formError.value = errorText(err, 'Không tải được cấu hình nhóm');
  }
}

async function saveRule() {
  if (!current.value) return;
  saving.value = true;
  formError.value = '';
  try {
    const res = await api.put(`/group-auto-reply/groups/${current.value.conversationId}`, {
      ...rulePayload(),
    });
    current.value.enabled = !!res.data.enabled;
    current.value.triggerMode = res.data.triggerMode;
    current.value.alwaysReply = !!res.data.alwaysReply;
    toast.push('Đã lưu cấu hình nhóm', 'success');
    dialog.value = false;
  } catch (err) {
    formError.value = errorText(err, 'Không lưu được');
  } finally {
    saving.value = false;
  }
}

async function dryRun() {
  if (!current.value) return;
  dryRunning.value = true;
  dryResult.value = null;
  try {
    // Lưu trước để chạy thử phản ánh đúng lời dặn và chế độ vừa sửa
    await api.put(`/group-auto-reply/groups/${current.value.conversationId}`, {
      ...rulePayload(),
    });
    const res = await api.post(`/group-auto-reply/groups/${current.value.conversationId}/dry-run`, {}, { timeout: 120000 });
    dryResult.value = res.data;
    const l = await api.get(`/group-auto-reply/groups/${current.value.conversationId}/logs`);
    logs.value = l.data;
  } catch (err) {
    formError.value = errorText(err, 'Chạy thử thất bại');
  } finally {
    dryRunning.value = false;
  }
}

onMounted(loadAll);
</script>

<style scoped>
.gar { padding: 4px 2px 32px; }
.gar-title h2 { font-size: 19px; font-weight: 600; margin-bottom: 4px; }
.gar-title p { font-size: 13px; opacity: 0.72; max-width: 780px; margin-bottom: 16px; line-height: 1.55; }

.gar-master--on { border-color: #2e7d32 !important; background: rgba(46, 125, 50, 0.05); }
.gar-master-label { font-weight: 700; font-size: 14px; }
.gar-master-sub { font-size: 12.5px; opacity: 0.7; }

.gar-count { font-size: 12px; opacity: 0.6; }
.gar-table :deep(td) { vertical-align: middle; }
.gar-row--on { background: rgba(46, 125, 50, 0.05); }
.gar-name { font-weight: 600; font-size: 13px; }
.gar-muted { opacity: 0.65; font-size: 12.5px; }
.gar-small { font-size: 12px; }
.gar-tag-private {
  display: inline-block; font-size: 10px; margin-top: 2px;
  padding: 1px 6px; border-radius: 8px; background: rgba(198, 40, 40, 0.1); color: #c62828;
}

.gar-dialog-title { font-weight: 600; font-size: 16px; }
.gar-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.6; margin-bottom: 6px; }
.gar-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 4px 16px; }

.gar-dry { border-radius: 10px; padding: 10px 12px; margin-top: 8px; border: 1px solid; }
.gar-dry--reply { border-color: rgba(46, 125, 50, 0.4); background: rgba(46, 125, 50, 0.06); }
.gar-dry--silent { border-color: rgba(0, 0, 0, 0.15); background: rgba(0, 0, 0, 0.03); }
.gar-dry-head { font-size: 13px; margin-bottom: 4px; }
.gar-dry-text { font-size: 13px; line-height: 1.55; white-space: pre-wrap; background: var(--smax-bg, #fff); border-radius: 7px; padding: 7px 10px; margin: 4px 0; }
.gar-dry-why { font-size: 12px; opacity: 0.7; font-style: italic; }
.gar-dry-warn { font-size: 12px; color: #e65100; margin-top: 6px; }

.gar-log { padding: 7px 0; border-bottom: 1px solid rgba(0, 0, 0, 0.06); }
.gar-log-badge { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 8px; margin-right: 6px; }
.gar-log--sent { background: rgba(46, 125, 50, 0.14); color: #2e7d32; }
.gar-log--ai_declined { background: rgba(0, 0, 0, 0.07); color: #555; }
.gar-log--skipped { background: rgba(255, 152, 0, 0.14); color: #e65100; }
.gar-log--failed { background: rgba(198, 40, 40, 0.12); color: #c62828; }
.gar-log--dry_run { background: rgba(0, 119, 182, 0.12); color: #0077b6; }
.gar-log-time { font-size: 11px; opacity: 0.55; }
.gar-log-text { font-size: 12.5px; margin-top: 3px; white-space: pre-wrap; }
.gar-log-why { font-size: 11.5px; opacity: 0.6; font-style: italic; }

/* Theme sáng của repo tô rãnh công tắc lúc TẮT gần như trắng → vô hình trên nền trắng.
   Ép màu xám rõ cho trạng thái tắt; lúc bật để Vuetify tô theo color. */
.gar :deep(.v-selection-control:not(.v-selection-control--dirty) .v-switch__track) {
  background-color: #aeb6c2 !important;
  opacity: 1 !important;
}
.gar :deep(.v-switch__thumb) { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35); }
/* hộp thoại hiển thị tách khỏi trang → cần áp riêng */
.gar-dialog :deep(.v-selection-control:not(.v-selection-control--dirty) .v-switch__track) {
  background-color: #aeb6c2 !important;
  opacity: 1 !important;
}
.gar-dialog :deep(.v-switch__thumb) { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35); }
.gar-tag-always {
  display: inline-block; font-size: 11px; font-weight: 600;
  padding: 1px 8px; border-radius: 8px; background: rgba(230, 81, 0, 0.12); color: #e65100;
}
.gar-presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.gar-preset {
  text-align: left; cursor: pointer;
  border: 1px solid rgba(0, 0, 0, 0.14); border-radius: 9px;
  padding: 8px 10px; background: transparent; color: inherit;
  display: flex; flex-direction: column; gap: 2px;
}
.gar-preset strong { font-size: 12.5px; }
.gar-preset span { font-size: 11px; opacity: 0.65; }
.gar-preset:hover { border-color: #0077b6; }
.gar-preset--on { border-color: #0077b6; background: rgba(0, 119, 182, 0.08); }
.gar-persona-preview { font-size: 12px; padding: 7px 10px; border-radius: 7px; background: rgba(0, 119, 182, 0.07); }
.gar-persona-preview--warn { background: rgba(230, 81, 0, 0.08); color: #bf360c; }
.gar-brain { max-height: 260px; overflow-y: auto; border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 9px; }
.gar-brain-row { display: flex; align-items: flex-start; gap: 4px; padding: 5px 8px 5px 2px; border-bottom: 1px solid rgba(0, 0, 0, 0.05); }
.gar-brain-row:last-child { border-bottom: none; }
.gar-brain-row--off .gar-brain-text { opacity: 0.45; text-decoration: line-through; }
.gar-brain-text { flex: 1; font-size: 12.5px; line-height: 1.5; padding-top: 6px; }
.gar-brain-src { font-size: 10.5px; opacity: 0.55; padding-top: 8px; white-space: nowrap; }
.gar-tag-auto { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px; background: rgba(0, 119, 182, 0.12); color: #0077b6; margin-left: 4px; }
</style>
