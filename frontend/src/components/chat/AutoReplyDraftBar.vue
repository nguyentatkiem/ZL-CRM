<!--
  AutoReplyDraftBar.vue — thanh nháp trả lời tự động, nằm ngay trên ô soạn tin.

  Khi khách nhắn tin, backend soạn sẵn một câu trả lời dựa trên lịch sử chat,
  hồ sơ CRM, kịch bản bán hàng và mẫu tin có sẵn. Thanh này hiện nháp đó.

  KHÔNG có nút nào ở đây gửi tin cho khách. "Dùng câu này" chỉ chèn nội dung vào
  ô soạn tin — nhân viên đọc lại, sửa nếu cần, rồi tự bấm Gửi như bình thường.
-->
<template>
  <div v-if="visible" class="ar-bar">
    <div class="ar-head">
      <span class="ar-badge">AI soạn sẵn</span>
      <span v-if="draft?.playbookUsed?.length" class="ar-source" :title="draft.playbookUsed.join(' · ')">
        theo kịch bản: {{ draft.playbookUsed.join(' · ') }}
      </span>
      <span v-else-if="draft" class="ar-source">chưa bám kịch bản nào</span>
      <span class="ar-spacer" />
      <button class="ar-ghost" :disabled="loading" title="Bảo AI viết lại" @click="onRegenerate">
        <v-icon size="15">mdi-refresh</v-icon>
      </button>
      <button v-if="draft" class="ar-ghost" title="Bỏ nháp này" @click="onDismiss">
        <v-icon size="16">mdi-close</v-icon>
      </button>
    </div>

    <div v-if="loading" class="ar-loading">
      <v-progress-circular indeterminate size="15" width="2" color="primary" class="mr-2" />
      AI đang đọc lại hội thoại…
    </div>

    <template v-else-if="draft">
      <div class="ar-text">{{ draft.content }}</div>
      <div v-if="draft.rationale" class="ar-why">{{ draft.rationale }}</div>
      <div class="ar-actions">
        <button class="ar-primary" @click="onUse">Dùng câu này</button>
        <span class="ar-note">Chèn vào ô soạn tin, bạn đọc lại rồi mới gửi</span>
      </div>
    </template>

    <p v-if="error" class="ar-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, toRef } from 'vue';
import { useAutoReply } from '@/composables/use-auto-reply';

const props = defineProps<{ conversationId: string | null }>();
const emit = defineEmits<{ use: [text: string] }>();

const convId = toRef(props, 'conversationId');
const { draft, enabled, loading, error, regenerate, useDraft, dismiss, teardown } =
  useAutoReply(() => convId.value);

/* Ẩn hẳn khi tính năng tắt và cũng không có gì để hiện — tránh chiếm chỗ vô ích. */
const visible = computed(() => enabled.value && (!!draft.value || loading.value || !!error.value));

async function onUse() {
  const text = await useDraft();
  if (text) emit('use', text);
}

function onDismiss() { void dismiss(); }
function onRegenerate() { void regenerate(); }

onBeforeUnmount(teardown);
</script>

<style scoped>
.ar-bar {
  background: linear-gradient(90deg, rgba(0, 150, 136, 0.07), rgba(0, 119, 182, 0.07));
  border-top: 1px solid var(--smax-grey-200);
  padding: 8px 17px 10px;
  flex-shrink: 0;
}

.ar-head {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 5px;
}
.ar-badge {
  font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.4px;
  color: #00695c;
  background: rgba(0, 150, 136, 0.14);
  border-radius: 10px;
  padding: 2px 8px;
  flex-shrink: 0;
}
.ar-source {
  font-size: 11px; opacity: 0.65;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 45%;
}
.ar-spacer { flex: 1; }
.ar-ghost {
  width: 26px; height: 26px; border-radius: 6px;
  border: none; background: transparent; cursor: pointer;
  color: var(--smax-grey-700);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.ar-ghost:hover:not(:disabled) { background: rgba(0, 0, 0, 0.06); }
.ar-ghost:disabled { opacity: 0.45; cursor: default; }

.ar-loading { font-size: 12px; opacity: 0.72; display: flex; align-items: center; }

.ar-text {
  font-size: 13px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
  background: var(--smax-bg);
  border: 1px solid rgba(0, 150, 136, 0.28);
  border-radius: 9px;
  padding: 8px 11px;
}
.ar-why {
  font-size: 11px; opacity: 0.6;
  margin-top: 4px; font-style: italic;
}

.ar-actions { display: flex; align-items: center; gap: 9px; margin-top: 7px; }
.ar-primary {
  background: #00796b; color: white;
  border: none; border-radius: 7px;
  padding: 6px 14px; font-size: 12.5px; font-weight: 600;
  cursor: pointer;
}
.ar-primary:hover { background: #00695c; }
.ar-note { font-size: 11px; opacity: 0.6; }

.ar-error {
  font-size: 11.5px; color: #c62828;
  background: #fdecea; border-radius: 6px;
  padding: 6px 9px; margin: 6px 0 0;
}
</style>
