<!--
  AutoReplySettingsView.vue — cài đặt trả lời tự động theo ngữ cảnh + kho kịch bản.

  Tính năng chạy ở chế độ SOẠN NHÁP: AI viết sẵn câu trả lời khi khách nhắn tin,
  nhân viên đọc rồi mới gửi. Trang này bật/tắt, đặt hàng rào an toàn, và quản lý
  kho kịch bản bán hàng mà AI phải bám theo khi nói về giá và chính sách.
-->
<template>
  <div class="ar-settings">
    <div class="ar-title">
      <h2>Trả lời tự động theo ngữ cảnh</h2>
      <p>
        AI đọc lịch sử chat, hồ sơ khách và kho kịch bản bên dưới rồi soạn sẵn câu trả lời.
        Nháp hiện ngay trong khung chat — nhân viên đọc lại rồi mới bấm gửi.
        <strong>Phần mềm không tự gửi tin cho khách.</strong>
      </p>
    </div>

    <v-alert v-if="loadError" type="error" density="compact" class="mb-4">{{ loadError }}</v-alert>

    <!-- ════════ Bật/tắt + hàng rào ════════ -->
    <v-card variant="outlined" class="mb-5">
      <v-card-text>
        <v-switch
          v-model="config.enabled"
          color="primary"
          inset
          hide-details
          class="mb-2"
          :label="config.enabled ? 'Đang bật — AI soạn nháp khi khách nhắn tin' : 'Đang tắt'"
        />

        <v-divider class="my-4" />

        <div class="ar-grid">
          <v-select
            v-model="config.accountIds"
            :items="accountItems"
            label="Áp dụng cho nick Zalo"
            multiple
            chips
            closable-chips
            hint="Để trống = mọi nick. Nick đang bật Riêng tư luôn bị loại."
            persistent-hint
          />

          <div class="ar-hours">
            <v-text-field v-model.number="config.hourStart" type="number" label="Từ giờ" min="0" max="23" density="comfortable" />
            <span class="ar-dash">→</span>
            <v-text-field v-model.number="config.hourEnd" type="number" label="Đến giờ" min="0" max="23" density="comfortable" />
          </div>

          <v-text-field
            v-model.number="config.maxDraftsPerDay"
            type="number" min="1"
            label="Tối đa bao nhiêu nháp mỗi ngày"
            hint="Chặn đốt quota AI khi tin về dồn dập"
            persistent-hint
          />

          <v-text-field
            v-model.number="config.skipIfStaffRepliedWithinMin"
            type="number" min="0"
            label="Bỏ qua nếu nhân viên vừa trả lời (phút)"
            hint="Đang có người trực thì để người trực làm"
            persistent-hint
          />

          <v-text-field
            v-model.number="config.minGapSeconds"
            type="number" min="0"
            label="Nghỉ giữa hai nháp cùng hội thoại (giây)"
            hint="Khách nhắn liên tiếp thì không soạn dồn"
            persistent-hint
          />

          <v-text-field
            v-model.number="config.draftTtlMinutes"
            type="number" min="5"
            label="Nháp hết hạn sau (phút)"
            hint="Quá hạn thì không hiện nữa vì ngữ cảnh đã cũ"
            persistent-hint
          />
        </div>

        <v-combobox
          v-model="config.blockedKeywords"
          label="Từ khoá để người thật xử lý"
          multiple chips closable-chips
          class="mt-4"
          hint="Khách nhắn trúng những từ này thì AI không soạn nháp. Gõ rồi nhấn Enter để thêm."
          persistent-hint
        />

        <v-textarea
          v-model="config.extraInstruction"
          label="Lời dặn riêng cho AI"
          rows="3"
          class="mt-4"
          counter="2000"
          hint="Ví dụ: xưng em gọi khách là anh/chị, không nêu giá qua chat, luôn mời khách để lại số điện thoại."
          persistent-hint
        />
      </v-card-text>
      <v-card-actions>
        <div v-if="stats" class="ar-stats">
          7 ngày qua: {{ stats.total }} nháp · dùng {{ stats.used }} ({{ stats.usedRate }}%) · bỏ {{ stats.dismissed }}
        </div>
        <v-spacer />
        <v-btn color="primary" :loading="saving" @click="save">Lưu cài đặt</v-btn>
      </v-card-actions>
    </v-card>

    <!-- ════════ Kho kịch bản ════════ -->
    <v-card variant="outlined">
      <v-card-title class="d-flex align-center text-body-1">
        Kho kịch bản bán hàng
        <v-spacer />
        <v-btn size="small" color="primary" variant="tonal" @click="openNew">Thêm mục</v-btn>
      </v-card-title>
      <v-card-text>
        <p class="ar-hint">
          AI chỉ được nêu giá, chính sách và cam kết dựa trên những mục ở đây. Kho trống thì AI sẽ
          tránh mọi con số và hẹn khách để nhân viên trả lời.
        </p>

        <v-alert v-if="playbook.length === 0" type="info" density="compact" variant="tonal">
          Chưa có mục nào. Thêm ít nhất bảng giá và cách xử lý từ chối thường gặp.
        </v-alert>

        <v-table v-else density="compact">
          <thead>
            <tr>
              <th>Tiêu đề</th>
              <th>Nhóm</th>
              <th>Từ khoá kích hoạt</th>
              <th class="text-center">Ưu tiên</th>
              <th class="text-center">Bật</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in playbook" :key="entry.id">
              <td class="ar-cell-title">{{ entry.title }}</td>
              <td>{{ entry.category || '—' }}</td>
              <td class="ar-cell-kw">
                <span v-if="!entry.keywords?.length" class="text-grey">luôn cân nhắc</span>
                <v-chip v-for="kw in entry.keywords" :key="kw" size="x-small" class="mr-1">{{ kw }}</v-chip>
              </td>
              <td class="text-center">{{ entry.priority }}</td>
              <td class="text-center">
                <v-icon size="18" :color="entry.enabled ? 'success' : 'grey'">
                  {{ entry.enabled ? 'mdi-check-circle' : 'mdi-minus-circle-outline' }}
                </v-icon>
              </td>
              <td class="text-right">
                <v-btn size="x-small" variant="text" icon="mdi-pencil" @click="openEdit(entry)" />
                <v-btn size="x-small" variant="text" icon="mdi-delete-outline" color="error" @click="remove(entry)" />
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <!-- ════════ Hộp thoại soạn mục kịch bản ════════ -->
    <v-dialog v-model="dialog" max-width="640">
      <v-card class="ar-dialog">
        <v-card-title>{{ editing?.id ? 'Sửa mục kịch bản' : 'Thêm mục kịch bản' }}</v-card-title>
        <v-card-text>
          <v-alert v-if="formError" type="error" density="compact" class="mb-3">{{ formError }}</v-alert>
          <v-text-field v-model="form.title" label="Tiêu đề" counter="200" class="mb-2" />
          <v-text-field v-model="form.category" label="Nhóm (tuỳ chọn)" placeholder="bảng giá / chính sách / xử lý từ chối" class="mb-2" />
          <v-combobox
            v-model="form.keywords"
            label="Từ khoá kích hoạt"
            multiple chips closable-chips
            class="mb-2"
            hint="Khách nhắn trúng một trong các từ này thì mục được ưu tiên đưa cho AI. Để trống nếu luôn muốn dùng."
            persistent-hint
          />
          <v-textarea v-model="form.content" label="Nội dung" rows="8" counter="8000" class="mt-3" />
          <div class="d-flex align-center" style="gap: 24px;">
            <v-text-field v-model.number="form.priority" type="number" label="Ưu tiên (0-100)" min="0" max="100" density="compact" style="max-width: 180px;" />
            <v-switch v-model="form.enabled" color="primary" inset label="Đang bật" hide-details />
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="savingEntry" @click="saveEntry">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { api } from '@/api';
import { useToast } from '@/composables/use-toast';

interface PlaybookEntry {
  id: string;
  title: string;
  category: string | null;
  keywords: string[];
  content: string;
  priority: number;
  enabled: boolean;
}

const toast = useToast();

const config = reactive({
  enabled: false,
  accountIds: [] as string[],
  hourStart: 7,
  hourEnd: 22,
  maxDraftsPerDay: 200,
  minGapSeconds: 90,
  skipIfStaffRepliedWithinMin: 3,
  draftTtlMinutes: 120,
  blockedKeywords: [] as string[],
  extraInstruction: '' as string | null,
});

const accountItems = ref<Array<{ title: string; value: string }>>([]);
const playbook = ref<PlaybookEntry[]>([]);
const stats = ref<{ total: number; used: number; dismissed: number; usedRate: number } | null>(null);
const saving = ref(false);
const loadError = ref('');

const dialog = ref(false);
const savingEntry = ref(false);
const formError = ref('');
const editing = ref<PlaybookEntry | null>(null);
const form = reactive({
  title: '', category: '', keywords: [] as string[], content: '', priority: 0, enabled: true,
});

function errorText(err: unknown, fallback: string) {
  const res = (err as { response?: { data?: { error?: string } } })?.response;
  return res?.data?.error || fallback;
}

async function loadAll() {
  try {
    const [cfg, pb, st, accounts] = await Promise.all([
      api.get('/auto-reply/config'),
      api.get('/auto-reply/playbook'),
      api.get('/auto-reply/stats').catch(() => ({ data: null })),
      api.get('/zalo-accounts').catch(() => ({ data: [] })),
    ]);
    Object.assign(config, cfg.data, { extraInstruction: cfg.data.extraInstruction ?? '' });
    playbook.value = pb.data;
    stats.value = st.data;
    const list = Array.isArray(accounts.data) ? accounts.data : (accounts.data?.items ?? []);
    accountItems.value = list.map((a: { id: string; displayName?: string; phone?: string }) => ({
      title: a.displayName || a.phone || a.id.slice(0, 8),
      value: a.id,
    }));
  } catch (err) {
    loadError.value = errorText(err, 'Không tải được cài đặt');
  }
}

async function save() {
  saving.value = true;
  try {
    const res = await api.put('/auto-reply/config', {
      ...config,
      extraInstruction: config.extraInstruction?.trim() ? config.extraInstruction : null,
    });
    Object.assign(config, res.data, { extraInstruction: res.data.extraInstruction ?? '' });
    toast.push('Đã lưu cài đặt', 'success');
  } catch (err) {
    toast.push(errorText(err, 'Không lưu được cài đặt'), 'error');
  } finally {
    saving.value = false;
  }
}

function openNew() {
  editing.value = null;
  formError.value = '';
  Object.assign(form, { title: '', category: '', keywords: [], content: '', priority: 0, enabled: true });
  dialog.value = true;
}

function openEdit(entry: PlaybookEntry) {
  editing.value = entry;
  formError.value = '';
  Object.assign(form, {
    title: entry.title,
    category: entry.category ?? '',
    keywords: [...(entry.keywords ?? [])],
    content: entry.content,
    priority: entry.priority,
    enabled: entry.enabled,
  });
  dialog.value = true;
}

async function saveEntry() {
  formError.value = '';
  savingEntry.value = true;
  try {
    const body = {
      title: form.title,
      category: form.category || null,
      keywords: form.keywords,
      content: form.content,
      priority: form.priority,
      enabled: form.enabled,
    };
    if (editing.value) {
      await api.put(`/auto-reply/playbook/${editing.value.id}`, body);
    } else {
      await api.post('/auto-reply/playbook', body);
    }
    dialog.value = false;
    await loadAll();
    toast.push('Đã lưu mục kịch bản', 'success');
  } catch (err) {
    formError.value = errorText(err, 'Không lưu được');
  } finally {
    savingEntry.value = false;
  }
}

async function remove(entry: PlaybookEntry) {
  if (!confirm(`Xoá mục "${entry.title}"?`)) return;
  try {
    await api.delete(`/auto-reply/playbook/${entry.id}`);
    await loadAll();
    toast.push('Đã xoá', 'success');
  } catch (err) {
    toast.push(errorText(err, 'Không xoá được'), 'error');
  }
}

onMounted(loadAll);
</script>

<style scoped>
.ar-settings { padding: 4px 2px 32px; }
.ar-title h2 { font-size: 19px; font-weight: 600; margin-bottom: 4px; }
.ar-title p { font-size: 13px; opacity: 0.72; max-width: 760px; margin-bottom: 18px; line-height: 1.55; }

.ar-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 4px 20px;
}
.ar-hours { display: flex; align-items: center; gap: 10px; }
.ar-dash { opacity: 0.5; margin-top: -18px; }

.ar-stats { font-size: 12px; opacity: 0.7; padding-left: 8px; }
.ar-hint { font-size: 12.5px; opacity: 0.7; margin-bottom: 12px; line-height: 1.5; }
.ar-cell-title { font-weight: 600; font-size: 13px; }
.ar-cell-kw { max-width: 280px; }

/* Theme sáng của repo tô rãnh công tắc lúc TẮT gần như trắng → vô hình trên nền trắng.
   Ép màu xám rõ cho trạng thái tắt; lúc bật để Vuetify tô theo color. */
.ar-settings :deep(.v-selection-control:not(.v-selection-control--dirty) .v-switch__track) {
  background-color: #aeb6c2 !important;
  opacity: 1 !important;
}
.ar-settings :deep(.v-switch__thumb) { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35); }
/* hộp thoại hiển thị tách khỏi trang → cần áp riêng */
.ar-dialog :deep(.v-selection-control:not(.v-selection-control--dirty) .v-switch__track) {
  background-color: #aeb6c2 !important;
  opacity: 1 !important;
}
.ar-dialog :deep(.v-switch__thumb) { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35); }
</style>
