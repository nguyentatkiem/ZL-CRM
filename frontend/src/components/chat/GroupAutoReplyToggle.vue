<!--
  GroupAutoReplyToggle.vue — công tắc nhanh "AI tự trả lời nhóm này", nằm trong
  khung chat của nhóm. Bật/tắt ngay tại chỗ, không phải vào trang cài đặt.

  Chỉ owner/admin mới đổi được (nhóm là TỰ GỬI). Người khác chỉ xem trạng thái.
-->
<template>
  <div v-if="loaded" class="gat" :class="{ 'gat--on': live, 'gat--armed': enabled && !masterOn }">
    <span class="gat-dot" />
    <span class="gat-text">
      <template v-if="live">AI đang tự trả lời nhóm này</template>
      <template v-else-if="enabled">Đã chọn nhóm này, nhưng công tắc tổng đang tắt</template>
      <template v-else>AI không trả lời nhóm này</template>
    </span>
    <span class="gat-spacer" />
    <v-switch
      v-if="canEdit"
      :model-value="enabled"
      color="success" inset hide-details density="compact"
      :loading="saving" :disabled="saving"
      class="gat-switch"
      @update:model-value="toggle"
    />
    <RouterLink v-if="canEdit" to="/settings/crm/group-auto-reply" class="gat-link">Cấu hình</RouterLink>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/use-toast';

const props = defineProps<{ conversationId: string }>();

const auth = useAuthStore();
const toast = useToast();

const enabled = ref(false);
const masterOn = ref(false);
const loaded = ref(false);
const saving = ref(false);

const canEdit = computed(() => ['owner', 'admin'].includes(auth.user?.role || ''));
const live = computed(() => enabled.value && masterOn.value);

async function load() {
  loaded.value = false;
  try {
    const res = await api.get(`/group-auto-reply/groups/${props.conversationId}`);
    enabled.value = !!res.data.enabled;
    masterOn.value = !!res.data.groupEnabled;
    loaded.value = true;
  } catch {
    /* không đọc được thì ẩn — tiện ích phụ, không chặn việc chat */
  }
}

async function toggle(value: boolean | null) {
  const next = !!value;
  saving.value = true;
  try {
    const res = await api.put(`/group-auto-reply/groups/${props.conversationId}`, { enabled: next });
    enabled.value = !!res.data.enabled;
    if (next && !masterOn.value) {
      toast.push('Đã chọn nhóm này — bật công tắc tổng ở trang Cấu hình để AI bắt đầu chạy', 'warning', 4000);
    } else {
      toast.push(next ? 'AI bắt đầu tự trả lời nhóm này' : 'Đã tắt AI trong nhóm này', next ? 'success' : 'default');
    }
  } catch (err) {
    const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
    toast.push(msg || 'Không đổi được trạng thái', 'error');
  } finally {
    saving.value = false;
  }
}

watch(() => props.conversationId, load, { immediate: true });
</script>

<style scoped>
.gat {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 17px;
  font-size: 12px;
  border-top: 1px solid var(--smax-grey-200);
  background: rgba(0, 0, 0, 0.02);
  flex-shrink: 0;
  min-height: 34px;
}
.gat--on { background: rgba(46, 125, 50, 0.08); }
.gat--armed { background: rgba(255, 152, 0, 0.08); }
.gat-dot { width: 8px; height: 8px; border-radius: 50%; background: #9e9e9e; flex-shrink: 0; }
.gat--on .gat-dot { background: #2e7d32; box-shadow: 0 0 0 3px rgba(46, 125, 50, 0.2); }
.gat--armed .gat-dot { background: #ef6c00; }
.gat-text { opacity: 0.8; }
.gat--on .gat-text { color: #1b5e20; font-weight: 600; opacity: 1; }
.gat-spacer { flex: 1; }
.gat-switch { flex: 0 0 auto; }
.gat-switch :deep(.v-selection-control) { min-height: 28px; }
.gat-link { font-size: 11.5px; color: var(--smax-primary, #0077b6); text-decoration: none; }
.gat-link:hover { text-decoration: underline; }

/* Theme sáng của repo tô rãnh công tắc lúc TẮT gần như trắng → vô hình trên nền trắng.
   Ép màu xám rõ cho trạng thái tắt; lúc bật để Vuetify tô theo color. */
.gat :deep(.v-selection-control:not(.v-selection-control--dirty) .v-switch__track) {
  background-color: #aeb6c2 !important;
  opacity: 1 !important;
}
.gat :deep(.v-switch__thumb) { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35); }
</style>
