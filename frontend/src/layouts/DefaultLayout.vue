<!-- Đã sửa bởi TAKI Academy (09/2026): thêm tính năng AI trả lời tự động. Xem NGUON-GOC.md. -->
<template>
  <v-app class="smax-app">
    <!-- ════════ TOP NAV (Smax-style dark, h=52px) ════════ -->
    <header class="smax-topnav">
      <!-- Logo + Workspace selector -->
      <RouterLink to="/" class="logo" title="ZaloCRM">
        <img src="/brand/zalocrm-logo.png" alt="ZaloCRM" />
      </RouterLink>

      <div class="workspace workspace--static">
        <span class="ws-logo">{{ workspaceShort }}</span>
        <span>{{ workspaceName }}</span>
      </div>

      <!-- Primary nav tabs (Excel structure). nav-wrap cắt phần thừa; số tab hiển thị
           do JS tính theo chiều rộng khả dụng, tab không vừa → gom vào menu "Thêm ▾". -->
      <div ref="navWrapRef" class="nav-wrap">
        <nav ref="navTabsRef" class="nav-tabs">
          <RouterLink
            v-for="tab in visibleTabs"
            :key="tab.path"
            :to="tab.path"
            class="nav-tab"
            :class="{ active: isActive(tab) }"
          >
            <span class="ic">{{ tab.icon }}</span>{{ tab.label }}
          </RouterLink>

          <!-- Overflow: các tab không vừa chiều ngang dồn vào đây -->
          <v-menu v-if="overflowTabs.length" open-on-hover>
            <template #activator="{ props: act }">
              <button class="nav-tab" :class="{ active: overflowTabs.some(isActive) }" v-bind="act">
                <span class="ic">⋯</span>Thêm<span class="caret">▾</span>
              </button>
            </template>
            <v-list density="compact" min-width="200">
              <v-list-item
                v-for="tab in overflowTabs"
                :key="tab.path"
                :to="tab.path"
                :title="tab.label"
                :active="isActive(tab)"
              >
                <template #prepend><span class="overflow-ic">{{ tab.icon }}</span></template>
              </v-list-item>
            </v-list>
          </v-menu>
        </nav>
      </div>

      <!-- Trailing dropdowns (luôn hiển thị, không bị overflow) -->
      <div class="nav-trailing">
        <!-- Legacy automation dropdown (kept for backward compat — Phase 7 Bot-Auto
             is now a top-level primary tab via primaryTabs array above) -->
        <v-menu open-on-hover>
          <template #activator="{ props: act }">
            <button
              class="nav-tab"
              :class="{ active: isLegacyAutomationActive }"
              v-bind="act"
            >
              <span class="ic">⚡</span>Automation<span class="caret">▾</span>
            </button>
          </template>
          <v-list density="compact" min-width="220">
            <v-list-item to="/automation" title="Rules &amp; Templates (legacy)" prepend-icon="mdi-chart-box-outline" />
          </v-list>
        </v-menu>

        <v-menu open-on-hover>
          <template #activator="{ props: act }">
            <button class="nav-tab" :class="{ active: isSettingsActive }" v-bind="act">
              <span class="ic">⚙</span>Cài đặt<span class="caret">▾</span>
            </button>
          </template>
          <v-list density="compact" min-width="240">
            <v-list-item to="/settings/personal/profile" title="Hồ sơ của tôi" prepend-icon="mdi-account-circle-outline" />
            <v-divider />
            <v-list-subheader>Tổ chức &amp; Nhân sự</v-list-subheader>
            <v-list-item to="/settings/team/users" title="Nhân viên" prepend-icon="mdi-account-cog-outline" />
            <v-list-item to="/settings/team/teams" title="Đội nhóm" prepend-icon="mdi-account-group-outline" />
            <v-list-item to="/settings/team/roles" title="Vai trò &amp; Phân quyền" prepend-icon="mdi-shield-account-outline" />
            <v-divider />
            <v-list-subheader>CRM &amp; Kênh</v-list-subheader>
            <v-list-item to="/settings/crm/tags" title="Tag CRM" prepend-icon="mdi-tag-multiple-outline" />
            <v-list-item to="/settings/crm/scoring" title="Lead scoring" prepend-icon="mdi-chart-line" />
            <v-list-item to="/settings/channels/zalo" title="Tài khoản Zalo" prepend-icon="mdi-cellphone-link" />
            <v-list-item to="/settings/channels/integrations" title="Tích hợp" prepend-icon="mdi-connection" />
            <v-divider />
            <v-list-item to="/settings/dev/api" title="API &amp; Webhook" prepend-icon="mdi-api" />
            <v-divider />
            <v-list-item to="/settings" title="📋 Xem tất cả cài đặt" prepend-icon="mdi-cog-outline" />
          </v-list>
        </v-menu>
      </div>

      <!-- Flexible spacer pushes everything after it to the right edge. -->
      <div ref="spacerRef" class="topnav-spacer" />

      <!--
        ATTRIBUTION BANNER — moved into DashboardView per copyright holder
        (dmman16pn@gmail.com). Rendering still required by Apache 2.0 §4(d);
        see src/views/DashboardView.vue and src/composables/use-attribution.ts.
      -->

      <!-- Global search trigger -->
      <GlobalSearch class="topnav-search" />

      <!-- Right icon buttons -->
      <RouterLink to="/groups" class="icon-btn" title="Nhóm">
        <v-icon size="18">mdi-account-group-outline</v-icon>
      </RouterLink>

      <!-- Điểm mở rộng UI: plugin có thể chèn action vào topbar. Rỗng nếu không có plugin. -->
      <ExtensionSlot name="topbar.actions" />

      <NotificationBell class="icon-btn-wrap" />

      <v-menu>
        <template #activator="{ props: act }">
          <button class="user-avatar" v-bind="act" :title="authStore.user?.fullName || 'Tài khoản'">
            {{ initials }}
          </button>
        </template>
        <v-list density="compact" min-width="200">
          <v-list-item :title="authStore.user?.fullName || ''" :subtitle="authStore.user?.email || ''" />
          <v-divider />
          <v-list-item to="/profile" title="Hồ sơ" prepend-icon="mdi-account-circle-outline" />
          <v-list-item @click="toggleTheme" :title="isDark ? 'Theme sáng' : 'Theme tối (legacy)'" :prepend-icon="isDark ? 'mdi-weather-sunny' : 'mdi-weather-night'" />
          <v-divider />
          <v-list-item @click="logout" title="Đăng xuất" prepend-icon="mdi-logout" />
        </v-list>
      </v-menu>
    </header>

    <!-- ════════ MAIN ════════ -->
    <v-main class="smax-main">
      <slot />
    </v-main>

    <!-- Popup nổi: hỏi AI về tình trạng khách hàng hôm nay -->
    <DailyBriefFab />

    <!-- Global toast queue -->
    <ToastContainer />
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useTheme } from 'vuetify';
import { useRoute, RouterLink } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import NotificationBell from '@/components/NotificationBell.vue';
import GlobalSearch from '@/components/GlobalSearch.vue';
import ToastContainer from '@/components/ui/ToastContainer.vue';
import ExtensionSlot from '@/components/ExtensionSlot.vue';
import DailyBriefFab from '@/components/ai/DailyBriefFab.vue';
const theme = useTheme();
const route = useRoute();
const authStore = useAuthStore();
const router = useRouter();

const isDark = ref((localStorage.getItem('theme') || 'smax-light') === 'legacy-dark');

onMounted(() => {
  const saved = localStorage.getItem('theme') || 'smax-light';
  theme.global.name.value = saved;
  isDark.value = saved === 'legacy-dark';
});

interface NavTab {
  path: string;
  label: string;
  icon: string;
  matchPrefix?: string;
}

// Excel-driven menu (cấp 1) — Automation/Cài đặt được render riêng với dropdown.
// Bot-Auto (Phase 7) là tab top-level riêng (giống smax.ai), tách hẳn khỏi
// legacy Automation dropdown để user không bị nhầm 2 hệ thống.
const primaryTabs: NavTab[] = [
  { path: '/',                       label: 'Dashboard',   icon: '🏠', matchPrefix: '/$' },
  { path: '/chat',                   label: 'Tin nhắn',    icon: '💬' },
  { path: '/friends',                label: 'Bạn bè',      icon: '👥' },
  { path: '/contacts',               label: 'Khách hàng',  icon: '🧑' },
  { path: '/leads/stuck',            label: 'KH đình trệ', icon: '🚨' },
  { path: '/appointments',           label: 'Lịch hẹn',    icon: '📅' },
  { path: '/automation/bot/triggers', label: 'Bot-Auto',   icon: '🤖', matchPrefix: '/automation/bot' },
  { path: '/analytics',              label: 'Phân tích',   icon: '📈' },
  { path: '/reports',                label: 'Báo cáo',     icon: '📊' },
  { path: '/group-posts',            label: 'Đăng nhóm',   icon: '📢' },
  { path: '/chao-hang',              label: 'Chào hàng',   icon: '🛍️' },
];

function isActive(tab: NavTab): boolean {
  if (tab.matchPrefix === '/$') return route.path === '/';
  if (tab.matchPrefix) {
    return route.path === tab.matchPrefix || route.path.startsWith(tab.matchPrefix + '/');
  }
  return route.path === tab.path || route.path.startsWith(tab.path + '/');
}
const isSettingsActive = computed(() =>
  route.path === '/settings' || route.path.startsWith('/settings/'),
);
// Highlight legacy Automation dropdown ONLY when on /automation (exact) — do NOT
// activate when on /automation/bot/* (that's the top-level Bot-Auto tab).
const isLegacyAutomationActive = computed(
  () => route.path === '/automation' || (route.path.startsWith('/automation') && !route.path.startsWith('/automation/bot')),
);

// ── Responsive overflow: tab nào không vừa chiều ngang → dồn vào menu "Thêm ▾" ──
// Đo chiều rộng tự nhiên của từng tab MỘT LẦN (lúc render đầy đủ), rồi tính số tab
// vừa khít theo chiều rộng vùng nav hiện tại; phần dư hiển thị trong dropdown.
const navWrapRef = ref<HTMLElement | null>(null);
const navTabsRef = ref<HTMLElement | null>(null);
const spacerRef = ref<HTMLElement | null>(null);
const tabWidths = ref<number[]>([]);
const containerW = ref(0);

const visibleCount = computed(() => {
  const widths = tabWidths.value;
  const avail = containerW.value;
  if (!widths.length || !avail) return primaryTabs.length; // chưa đo → render đủ
  const GAP = 2, SAFE = 6, THEM_W = 64; // nút "Thêm" ~64px
  let total = SAFE;
  for (const w of widths) total += w + GAP;
  if (total <= avail) return primaryTabs.length; // vừa hết, không cần "Thêm"
  let used = SAFE + THEM_W;
  let count = 0;
  for (const w of widths) {
    if (used + w + GAP > avail) break;
    used += w + GAP;
    count++;
  }
  return Math.max(1, count); // luôn chừa ít nhất 1 tab
});
const visibleTabs = computed(() => primaryTabs.slice(0, visibleCount.value));
const overflowTabs = computed(() => primaryTabs.slice(visibleCount.value));

function measureTabs() {
  const el = navTabsRef.value;
  if (!el) return;
  const ws: number[] = [];
  el.querySelectorAll('.nav-tab').forEach((n) => ws.push((n as HTMLElement).offsetWidth));
  // Chỉ ghi khi đo được TOÀN BỘ tập tab (lúc chưa cắt) — tránh ghi đè bằng tập đã cắt.
  if (ws.length >= primaryTabs.length) tabWidths.value = ws.slice(0, primaryTabs.length);
}
// Chiều rộng KHẢ DỤNG cho dải tab = nav-wrap + spacer (bất biến: cắt tab thì nav-wrap
// co lại, spacer giãn ra → tổng không đổi) → tránh vòng lặp dao động khi cắt/thêm.
function updateContainer() {
  const wrap = navWrapRef.value?.clientWidth ?? 0;
  const slack = spacerRef.value?.clientWidth ?? 0;
  containerW.value = wrap + slack;
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  nextTick(() => {
    measureTabs();
    updateContainer();
  });
  ro = new ResizeObserver(() => updateContainer());
  if (navWrapRef.value) ro.observe(navWrapRef.value);
  if (spacerRef.value) ro.observe(spacerRef.value);
});
onBeforeUnmount(() => ro?.disconnect());

// Workspace — placeholder single-tenant cho Phase 1
const workspaceName = computed(() => authStore.user?.fullName?.split(' ')[0] || 'hsholding');
const workspaceShort = computed(() =>
  workspaceName.value.slice(0, 2).toUpperCase(),
);

const initials = computed(() => {
  const name = authStore.user?.fullName || 'U';
  return name.split(' ').map(p => p[0]).slice(-2).join('').toUpperCase();
});

function toggleTheme() {
  const next = isDark.value ? 'smax-light' : 'legacy-dark';
  isDark.value = !isDark.value;
  theme.global.name.value = next;
  localStorage.setItem('theme', next);
}

function logout() {
  authStore.logout();
  router.push('/login');
}
</script>

<style scoped>
.smax-topnav {
  background: var(--smax-header-bg);
  color: white;
  height: var(--smax-topnav-h);
  display: flex; align-items: center;
  padding: 0 13px; gap: 4px;
  flex-shrink: 0;
  position: sticky; top: 0; z-index: 100;
}

.logo {
  width: 35px; height: 35px;
  background: white; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  margin-right: 4px;
  text-decoration: none;
  overflow: hidden;
  padding: 2px;
}
.logo img {
  width: 100%; height: 100%;
  object-fit: contain;
}

.workspace {
  background: rgba(255,255,255,0.06);
  border: none;
  display: flex; align-items: center; gap: 7px;
  padding: 7px 11px; border-radius: 7px;
  margin-right: 13px;
  cursor: pointer; color: white;
  font-size: 13px;
}
.workspace:hover { background: rgba(255,255,255,0.10); }
.workspace--static { cursor: default; }
.workspace--static:hover { background: rgba(255,255,255,0.06); }
.ws-logo {
  width: 24px; height: 24px;
  background: linear-gradient(135deg, #ff5722, #d84315);
  border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  color: white; font-size: 11px; font-weight: 600;
}
.opacity-50 { opacity: 0.5; }

/* nav-wrap chiếm hết khoảng trống còn lại + cắt phần thừa; số tab hiển thị do JS
   tính theo chiều rộng, phần dư nằm trong menu "Thêm" → KHÔNG bao giờ tràn. */
.nav-wrap {
  flex: 0 1 auto; min-width: 0;
  overflow: hidden;
  display: flex; align-items: center;
}
.nav-trailing {
  display: flex; align-items: center; gap: 2px;
  flex-shrink: 0;
}
.nav-tabs {
  display: flex; align-items: center; gap: 2px;
  flex-wrap: nowrap;
}
.overflow-ic { font-size: 15px; margin-right: 4px; }
.nav-tab {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 9px 13px; border-radius: 7px;
  cursor: pointer;
  color: rgba(255,255,255,0.75);
  font-size: 13px;
  background: transparent; border: none;
  white-space: nowrap;
  text-decoration: none;
}

/* Compact nav progressively as viewport shrinks so all tabs stay visible */
@media (max-width: 1500px) {
  .nav-tab { padding: 9px 9px; gap: 4px; font-size: 12.5px; }
}
@media (max-width: 1280px) {
  .nav-tab { padding: 8px 7px; font-size: 12px; }
  .nav-tab .ic { font-size: 13px; }
  .workspace { padding: 6px 9px; margin-right: 8px; font-size: 12px; }
}
@media (max-width: 1100px) {
  .nav-tab { padding: 7px 6px; gap: 3px; }
  .nav-tab .ic { display: none; } /* drop emoji icons, keep labels */
  .workspace span:nth-of-type(2) { display: none; } /* workspace name → only logo */
}
.nav-tab .ic { font-size: 14px; line-height: 1; }
.nav-tab .caret { font-size: 10px; opacity: 0.7; margin-left: 2px; }
.nav-tab:hover { background: rgba(255,255,255,0.06); color: white; }
.nav-tab.active { background: rgba(255,255,255,0.12); color: white; font-weight: 500; }

.topnav-spacer { flex: 1; min-width: 0; }

.contact-marquee {
  flex: 0 0 320px;
  margin-right: 12px;
  height: 32px;
  display: flex;
  align-items: center;
  overflow: hidden;
  background: linear-gradient(90deg, rgba(0,242,255,0.12), rgba(0,119,182,0.12));
  border: 1px solid rgba(0,242,255,0.30);
  border-radius: 6px;
  text-decoration: none;
  color: #00F2FF;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
}
.contact-marquee:hover {
  background: linear-gradient(90deg, rgba(0,242,255,0.20), rgba(0,119,182,0.20));
  border-color: rgba(0,242,255,0.50);
}
.marquee-track {
  display: inline-block;
  white-space: nowrap;
  animation: marquee-scroll 32s linear infinite;
  will-change: transform;
}
.contact-marquee:hover .marquee-track {
  animation-play-state: paused;
}
@keyframes marquee-scroll {
  0%   { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}
@media (max-width: 1280px) {
  .contact-marquee { display: none; }
}

.topnav-search {
  max-width: 240px;
  flex-shrink: 1;
}
@media (max-width: 1500px) {
  .topnav-search { max-width: 180px; }
}
@media (max-width: 1280px) {
  .topnav-search { max-width: 140px; }
}
@media (max-width: 1100px) {
  .topnav-search { display: none; } /* prioritize menu over inline search */
}
.topnav-search :deep(.v-field) {
  background: rgba(255,255,255,0.06) !important;
  color: white;
  border-radius: 7px !important;
}
.topnav-search :deep(input) { color: white !important; }

.icon-btn,
:deep(.icon-btn-wrap) > * {
  width: 39px; height: 39px;
  border-radius: 50%;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: rgba(255,255,255,0.78);
  position: relative;
  font-size: 16px;
  text-decoration: none;
  background: transparent; border: none;
}
.icon-btn:hover,
:deep(.icon-btn-wrap) > *:hover {
  background: rgba(255,255,255,0.08);
  color: white;
}

.user-avatar {
  width: 35px; height: 35px;
  border-radius: 50%;
  background: linear-gradient(135deg,#fbc02d,#f57c00);
  color: white; font-weight: 600;
  border: none; cursor: pointer;
  margin-left: 9px;
  font-size: 12px;
  display: flex; align-items: center; justify-content: center;
}

.smax-main {
  background: var(--smax-grey-100);
}
.smax-main :deep(.v-main__wrap) { min-height: calc(100vh - var(--smax-topnav-h)); }

/* Vuetify menus rendered from v-menu inherit theme automatically.
   Force light surface in case parent has legacy-dark applied. */
:deep(.v-overlay__content > .v-list) {
  background: var(--smax-bg);
  color: var(--smax-text);
}
</style>
