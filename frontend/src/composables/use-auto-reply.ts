/**
 * use-auto-reply.ts — nháp trả lời tự động cho hội thoại đang mở.
 *
 * Nháp do backend soạn sẵn khi khách nhắn tin. Composable này chỉ lo lấy nháp,
 * nghe socket để nháp mới hiện ngay, và đánh dấu đã dùng / bỏ. Việc gửi tin vẫn
 * do khung chat làm như bình thường — ở đây không có đường gửi nào.
 */
import { ref, watch } from 'vue';
import { io, type Socket } from 'socket.io-client';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth';

export interface AutoReplyDraft {
  id: string;
  content: string;
  rationale: string | null;
  playbookUsed: string[];
  provider: string | null;
  model: string | null;
  createdAt: string;
}

/** Hình dạng gói tin socket backend đẩy xuống khi có nháp mới. */
export interface DraftPush {
  draftId: string;
  conversationId: string;
  content: string;
  rationale: string | null;
  playbookUsed: string[];
  createdAt: string;
}

/* Một socket dùng chung cho mọi nơi gọi composable này. */
let socket: Socket | null = null;
const listeners = new Set<(payload: DraftPush) => void>();

function ensureSocket(orgId: string | undefined) {
  if (socket) return;
  socket = io({ transports: ['websocket', 'polling'] });
  const join = () => { if (orgId) socket?.emit('org:join', { orgId }); };
  socket.on('connect', join);
  if (socket.connected) join();
  socket.on('autoreply:draft', (payload: DraftPush) => {
    listeners.forEach((fn) => fn(payload));
  });
}

export function useAutoReply(conversationId: () => string | null) {
  const auth = useAuthStore();
  const draft = ref<AutoReplyDraft | null>(null);
  const enabled = ref(false);
  const loading = ref(false);
  const error = ref('');

  function errorText(err: unknown, fallback: string) {
    const res = (err as { response?: { data?: { error?: string } } })?.response;
    return res?.data?.error || fallback;
  }

  async function fetchDraft() {
    const convId = conversationId();
    draft.value = null;
    error.value = '';
    if (!convId) return;
    try {
      const res = await api.get('/auto-reply/drafts', { params: { conversationId: convId } });
      enabled.value = !!res.data.enabled;
      draft.value = res.data.draft ?? null;
    } catch {
      /* Không lấy được nháp thì im lặng — đây là tiện ích phụ, không chặn việc chat. */
      draft.value = null;
    }
  }

  /** Bảo AI viết lại cho hội thoại đang mở. */
  async function regenerate() {
    const convId = conversationId();
    if (!convId || loading.value) return;
    loading.value = true;
    error.value = '';
    try {
      await api.post('/auto-reply/drafts/generate', { conversationId: convId }, { timeout: 120000 });
      await fetchDraft();
    } catch (err) {
      error.value = errorText(err, 'Không soạn được nháp');
    } finally {
      loading.value = false;
    }
  }

  /** Trả về nội dung để chèn vào ô soạn tin, đồng thời đánh dấu đã dùng. */
  async function useDraft(): Promise<string | null> {
    const current = draft.value;
    if (!current) return null;
    draft.value = null;
    try {
      await api.post(`/auto-reply/drafts/${current.id}/use`);
    } catch {
      /* Đánh dấu hỏng cũng không sao — nội dung đã tới tay nhân viên rồi. */
    }
    return current.content;
  }

  async function dismiss() {
    const current = draft.value;
    draft.value = null;
    if (!current) return;
    try {
      await api.post(`/auto-reply/drafts/${current.id}/dismiss`);
    } catch {
      /* im lặng */
    }
  }

  /* Nháp mới từ socket — chỉ nhận nếu đúng hội thoại đang mở. */
  const onPush = (payload: DraftPush) => {
    if (payload.conversationId !== conversationId()) return;
    draft.value = {
      id: payload.draftId,
      content: payload.content,
      rationale: payload.rationale ?? null,
      playbookUsed: payload.playbookUsed ?? [],
      provider: null,
      model: null,
      createdAt: payload.createdAt,
    };
  };

  ensureSocket(auth.user?.orgId);
  listeners.add(onPush);

  watch(() => conversationId(), () => { void fetchDraft(); }, { immediate: true });

  function teardown() {
    listeners.delete(onPush);
  }

  return { draft, enabled, loading, error, fetchDraft, regenerate, useDraft, dismiss, teardown };
}
