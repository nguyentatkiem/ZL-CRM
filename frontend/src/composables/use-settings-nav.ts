// Đã sửa bởi TAKI Academy (09/2026): thêm tính năng AI trả lời tự động. Xem NGUON-GOC.md.
/**
 * use-settings-nav.ts — Central config cho Settings sidebar.
 *
 * Định nghĩa 5 group. Mỗi item:
 *   - permission: ai thấy được (everyone / admin / owner)
 *   - route: deep-link path
 *
 * Thêm item mới chỉ cần edit file này + tạo component + register route.
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

export type SettingsPermission = 'everyone' | 'admin' | 'owner';

export interface SettingsItem {
  id: string;
  label: string;
  icon: string;
  route: string;
  permission: SettingsPermission;
  /** Search alias bổ sung (vd "phân quyền" → tìm "roles") */
  aliases?: string[];
}

export interface SettingsGroup {
  id: string;
  label: string;
  icon: string;
  permission: SettingsPermission;
  items: SettingsItem[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  // ─── 👤 CÁ NHÂN ──────────────────────────────────────
  {
    id: 'personal',
    label: 'Cá nhân',
    icon: '👤',
    permission: 'everyone',
    items: [
      { id: 'profile', label: 'Hồ sơ của tôi', icon: '👤', route: '/settings/personal/profile', permission: 'everyone' },
      { id: 'password', label: 'Đổi mật khẩu', icon: '🔑', route: '/settings/personal/password', permission: 'everyone' },
      // Phase Riêng Tư 2026-05-22 — per-user PIN gate (Privacy phase)
      { id: 'privacy', label: 'Riêng tư & PIN', icon: '🔒', route: '/settings/privacy', permission: 'everyone', aliases: ['privacy', 'pin', 'riêng tư', 'blur', 'nick chính'] },
    ],
  },

  // ─── 🏢 TỔ CHỨC ──────────────────────────────────────
  // Variant C 2026-05-22: gộp 'Tổ chức' + 'Nhân sự' cũ thành 1 group.
  // RBAC phase shipped → "Sơ đồ tổ chức" replace "Đội nhóm", "Phân quyền" replace "Vai trò".
  // Legacy routes /settings/team/* 301 redirect → /settings/rbac/* (xem router/index.ts).
  {
    id: 'org',
    label: 'Tổ chức',
    icon: '🏢',
    permission: 'admin',
    items: [
      { id: 'profile', label: 'Hồ sơ tổ chức', icon: '🏢', route: '/settings/org/profile', permission: 'admin' },
      { id: 'departments', label: 'Sơ đồ tổ chức', icon: '🌳', route: '/settings/rbac/departments', permission: 'admin', aliases: ['phòng ban', 'department', 'tree', 'đội nhóm', 'team'] },
      { id: 'users', label: 'Nhân viên', icon: '👤', route: '/settings/rbac/users', permission: 'admin', aliases: ['user', 'sale', 'nhân sự'] },
      { id: 'permission-groups', label: 'Phân quyền', icon: '🛡', route: '/settings/rbac/permission-groups', permission: 'owner', aliases: ['phân quyền', 'permission', 'role', 'vai trò', 'nhóm quyền'] },
    ],
  },

  // ─── ⚙ CRM CONFIG ───────────────────────────────────
  {
    id: 'crm',
    label: 'CRM Config',
    icon: '⚙',
    permission: 'admin',
    items: [
      { id: 'statuses', label: 'Trạng thái KH', icon: '🎯', route: '/settings/crm/statuses', permission: 'admin', aliases: ['stage', 'pipeline'] },
      { id: 'tags', label: 'Tag CRM', icon: '🏷', route: '/settings/crm/tags', permission: 'admin' },
      { id: 'zalo-labels', label: 'Tag Zalo native', icon: '⚑', route: '/settings/crm/zalo-labels', permission: 'admin', aliases: ['zalo label'] },
      { id: 'scoring', label: 'Lead scoring', icon: '📊', route: '/settings/crm/scoring', permission: 'admin', aliases: ['điểm', 'chấm điểm'] },
      { id: 'auto-reply', label: 'Trả lời tự động', icon: '🤖', route: '/settings/crm/auto-reply', permission: 'admin', aliases: ['auto reply', 'trả lời tự động', 'nháp', 'ai reply', 'kịch bản', 'playbook'] },
      { id: 'group-auto-reply', label: 'AI trả lời nhóm', icon: '👥', route: '/settings/crm/group-auto-reply', permission: 'admin', aliases: ['nhóm', 'group', 'ai nhóm', 'trả lời nhóm', 'bot nhóm'] },
    ],
  },

  // ─── 🔌 KÊNH & TÍCH HỢP ─────────────────────────────
  {
    id: 'channels',
    label: 'Kênh & Tích hợp',
    icon: '🔌',
    permission: 'admin',
    items: [
      { id: 'zalo', label: 'Tài khoản Zalo', icon: '💬', route: '/settings/channels/zalo', permission: 'admin', aliases: ['nick', 'zalo account'] },
      { id: 'facebook', label: 'Facebook Lead Ads', icon: '📘', route: '/settings/channels/facebook', permission: 'admin', aliases: ['facebook', 'fb', 'lead ads', 'meta'] },
      { id: 'integrations', label: 'Tích hợp 3rd party', icon: '🔗', route: '/settings/channels/integrations', permission: 'admin' },
    ],
  },

  // ─── 🛠 DEV & API ───────────────────────────────────
  {
    id: 'dev',
    label: 'Dev & API',
    icon: '🛠',
    permission: 'owner',
    items: [
      { id: 'api', label: 'API Key & Webhook', icon: '🔌', route: '/settings/dev/api', permission: 'owner', aliases: ['webhook', 'api key'] },
    ],
  },
];

// ─── Helpers ────────────────────────────────────────────

function meetsPermission(required: SettingsPermission, userRole: string | undefined): boolean {
  if (required === 'everyone') return true;
  if (required === 'admin') return userRole === 'admin' || userRole === 'owner';
  if (required === 'owner') return userRole === 'owner';
  return false;
}

export function useSettingsNav() {
  const auth = useAuthStore();
  const route = useRoute();

  /** Groups + items đã filter theo role user hiện tại */
  const visibleGroups = computed<SettingsGroup[]>(() => {
    const role = auth.user?.role;
    return SETTINGS_GROUPS
      .filter((g) => meetsPermission(g.permission, role))
      .map((g) => ({
        ...g,
        items: g.items.filter((item) => meetsPermission(item.permission, role)),
      }))
      .filter((g) => g.items.length > 0);
  });

  /** Find item by route path */
  const activeItem = computed<{ group: SettingsGroup; item: SettingsItem } | null>(() => {
    const path = route.path;
    for (const g of visibleGroups.value) {
      const found = g.items.find((it) => it.route === path);
      if (found) return { group: g, item: found };
    }
    return null;
  });

  /** Search filter (live filter sidebar items) */
  function searchItems(query: string): SettingsItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: SettingsItem[] = [];
    for (const g of visibleGroups.value) {
      for (const item of g.items) {
        const matchLabel = item.label.toLowerCase().includes(q);
        const matchGroup = g.label.toLowerCase().includes(q);
        const matchAlias = item.aliases?.some((a) => a.toLowerCase().includes(q));
        if (matchLabel || matchGroup || matchAlias) results.push(item);
      }
    }
    return results;
  }

  /** Default route when user lands on /settings */
  const defaultRoute = computed<string>(() => {
    const role = auth.user?.role;
    if (meetsPermission('admin', role)) return '/settings/team/users';
    return '/settings/personal/profile';
  });

  return { visibleGroups, activeItem, searchItems, defaultRoute };
}
