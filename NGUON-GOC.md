# ZL CRM: nguồn gốc mã nguồn và giấy phép

ZL CRM là bản phát triển tiếp của **[dmman16pn/ZaloCRM](https://github.com/dmman16pn/ZaloCRM)**,
do TAKI Academy bổ sung các tính năng AI trả lời tự động.

## Nguồn

- Clone tháng 09/2026 từ `https://github.com/dmman16pn/ZaloCRM`, phát hành dưới **Apache License 2.0**.
- Giữ nguyên `LICENSE`, `NOTICE` và **toàn bộ lịch sử commit gốc**, không viết lại, để truy được ai viết dòng nào.
- Các commit gốc mang tên nhiều tác giả: `thanhpc-dongduong`, `locphamnguyen`, `Nguyễn Tiến Lộc`,
  `dmman16pn`, `binhvuong` và những người khác. Bản quyền phần gốc thuộc về các tác giả đó.

## Phần TAKI Academy thêm vào

Phát hành theo cùng giấy phép Apache 2.0 của kho này.

**Tệp mới:**

| Tính năng | Tệp |
|---|---|
| Popup "Khách hàng hôm nay" | `backend/src/modules/ai/daily-brief-service.ts`, `backend/src/modules/ai/prompts/daily-brief.ts`, `frontend/src/components/ai/DailyBriefFab.vue` |
| Trả lời 1-1 theo ngữ cảnh (soạn nháp chờ duyệt) | `backend/src/modules/ai/auto-reply/{config-service,context-builder,draft-service,listener,routes}.ts`, `backend/src/modules/ai/prompts/auto-reply.ts`, `frontend/src/components/chat/AutoReplyDraftBar.vue`, `frontend/src/composables/use-auto-reply.ts`, `frontend/src/views/settings/AutoReplySettingsView.vue` |
| AI tự trả lời trong nhóm được chỉ định | `backend/src/modules/ai/auto-reply/{group-service,group-routes}.ts`, `backend/src/modules/ai/prompts/group-auto-reply.ts`, `frontend/src/components/chat/GroupAutoReplyToggle.vue`, `frontend/src/views/settings/GroupAutoReplySettingsView.vue` |
| Bộ não nhóm tự học | `backend/src/modules/ai/auto-reply/brain-service.ts` |

**Tệp gốc đã sửa** (mỗi tệp có dòng ghi chú "Đã sửa bởi TAKI Academy" ở đầu, theo mục 4(b) của Apache 2.0):
`.gitignore`, `backend/prisma/schema/schema.prisma`, `backend/src/app.ts`,
`backend/src/modules/ai/{ai-routes,ai-service,index}.ts`, `frontend/src/components/chat/MessageThread.vue`,
`frontend/src/composables/use-settings-nav.ts`, `frontend/src/layouts/{DefaultLayout,MobileLayout}.vue`,
`frontend/src/router/index.ts`.

## Nguyên tắc an toàn của phần AI

- **Chat 1-1 chỉ soạn nháp**, không tự gửi. Nhân viên đọc rồi mới bấm gửi.
- **Nhóm chỉ tự gửi ở nhóm được chỉ định**, bật/tắt hai tầng (công tắc tổng và từng nhóm).
- **AI không bao giờ được chối là AI.** Khi có người hỏi thẳng, câu trả lời phải nói rõ đây là trợ lý AI.
  Quy tắc này được khoá bằng code, chạy sau khi AI viết và trước khi gửi, không chỉ dặn trong prompt.
- Bộ não nhóm **chỉ học từ tin người thật của tổ chức gõ tay**, không học từ tin thành viên
  (tránh bị "dạy" sai) và không học từ tin AI tự gửi (tránh tự củng cố lỗi).
- Lọc số điện thoại, số tài khoản, mật khẩu khỏi bộ não.

## Lưu ý giấy phép chưa giải quyết

Trên GitHub có kho **[locphamnguyen/ZaloCRM](https://github.com/locphamnguyen/ZaloCRM)** cùng codebase,
phát hành dưới **GNU AGPL-3.0**. Hai kho không có commit chung, nhưng cấu trúc và tài liệu trùng khớp.
Quan hệ giữa hai kho và quyền đổi giấy phép **chưa được làm rõ**. Trước khi dùng cho mục đích thương mại,
hãy tự đánh giá hoặc liên hệ các tác giả gốc.

## Cài đặt

Làm theo `HUONG-DAN-CAI-DAT.md` của bản gốc. Tệp `.env` **không** nằm trong kho: tạo từ `.env.example`
và tự sinh khoá bí mật. Phần AI cần cấu hình nhà cung cấp AI ở **Cài đặt → AI** trong ứng dụng.

Phần mềm cung cấp "nguyên trạng", không kèm bảo hành, theo điều khoản của Apache License 2.0.
