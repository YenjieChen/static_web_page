# Error Log Review 靜態頁面

本目錄目前保存錯誤日誌人工 Review 的靜態前端頁面。頁面用於檢視 `PENDING_REVIEW` 錯誤日誌、查看系統建議的 Jira candidate，並由人工核准或拒絕候選關聯。

## 目前狀態

- 靜態 Review 頁面已完成，可由一般靜態檔案伺服器提供服務。
- `error_log_review/` 是目前主要的 Review 頁面目錄。
- 正式 Review API 尚未部署；非 Demo 模式會嘗試呼叫 `/api/review/*`，若 API 不存在會顯示載入失敗。
- 前端不直接連線 OpenSearch，也不包含 OpenSearch credentials、Jira token 或其他 secrets。
- 拒絕候選只會送出拒絕操作，不會由瀏覽器自行建立 Jira 或產生 embedding。

## 目錄結構

```text
static_web_page/
├── README.md
├── error_log_review/
│   ├── index.html              # Review 目錄入口，導向 review.html
│   ├── review.html             # 人工 Review 頁面
│   ├── review.css              # Review 頁面樣式
│   ├── review.js               # Review UI、Demo 與 API client
│   └── MANUAL_REVIEW_API.md    # 後端 API contract 與安全要求
├── reports/                    # 可由其他流程放置報表資料
├── show_error.html             # 既有錯誤顯示頁面
└── show_error_zip.html         # 既有錯誤 ZIP 顯示頁面
```

根目錄目前沒有 `index.html`、`script.js`、`styles.css`、`nginx.conf`、`404.html` 或 `50x.html`；這些檔案已依部署需求移除。

## 使用方式

假設靜態伺服器的 document root 是本目錄：

```text
http://localhost:<port>/error_log_review/
```

也可以直接開啟：

```text
http://localhost:<port>/error_log_review/review.html
```

### Demo 模式

在尚未部署後端 API 時，可使用 Demo 模式預覽 UI：

```text
http://localhost:<port>/error_log_review/review.html?demo=1
```

Demo 模式會載入頁面內的範例資料。核准與拒絕只會模擬操作，不會寫入 OpenSearch 或建立 Jira。

### OpenSearch 測試設定欄位

頁面提供 OpenSearch URL、帳號與密碼欄位，預設 URL 為 `https://43.207.106.51`。按下「暫存於本頁」後，設定只保存在目前頁面的 JavaScript 記憶體中；重新整理、關閉頁面或按下「清除帳密」後即清除，不會寫入 Cookie、localStorage、sessionStorage 或 URL。

目前這些欄位不會讓瀏覽器直接連線 OpenSearch，也不會取代後端 API。正式環境應由受保護的後端驗證帳密並建立短效 session；不要將 OpenSearch credentials 交給前端持久保存。

本機臨時啟動靜態伺服器的範例：

```bash
cd /home/jerry/venv311/prj_error_message_processor/static_web_page
python -m http.server 8765
```

啟動後開啟：

```text
http://127.0.0.1:8765/error_log_review/review.html?demo=1
```

## Review 功能

頁面目前支援：

- 顯示待審核 logs、Prod、Stage 與候選 Jira 數量。
- 依錯誤訊息、Jira key、message ID、log group 或錯誤類型搜尋。
- 依環境篩選。
- 依相似度、時間或發生次數排序。
- 依候選 Jira 分組。
- 單筆核准、單筆拒絕與批次核准。
- 拒絕候選時要求填寫審核原因。
- 對外部資料進行 HTML escaping，避免直接插入未處理字串造成 XSS。
- API 失敗時顯示錯誤，不假裝操作成功。

## 後端 API contract

正式模式預期使用以下 same-origin API：

```text
GET  /api/review/pending
POST /api/review/approve
POST /api/review/reject
```

完整 request/response 格式與安全要求請參考：

```text
error_log_review/MANUAL_REVIEW_API.md
```

後端實作至少必須：

1. 從 OpenSearch 重新讀取指定 error log，不信任瀏覽器傳入的 candidate reference。
2. 核准前確認當前狀態仍為 `PENDING_REVIEW`，避免 stale update。
3. 確認 candidate embedding document 存在，且 candidate 與 error log 的環境一致。
4. 核准既有候選時寫入 `jira_reference` 與 `MANUAL_LINKED`。
5. 拒絕候選時使用明確的人工拒絕狀態，例如 `MANUAL_REJECTED`，避免 periodic worker 再次重複標記。
6. 記錄 reviewer、時間、決定、候選與審核備註。
7. 實作 authentication、authorization 與必要的 CSRF protection。

## 驗證紀錄

Review 頁面已完成以下靜態驗證：

- `review.js` JavaScript syntax check 通過。
- `index.html` 與 `review.html` HTML parse 通過。
- `review.html` 引用的 `review.css` 與 `review.js` 均存在。
- Review 目錄入口、Review HTML、CSS 與 JS 以本機 HTTP server smoke test 回應 `200`。
- 前端檔案未包含 credentials、password、token 或 webhook URL。

## 安全注意事項

- 不要將 OpenSearch credentials、Jira token、OpenAI key 或 Teams webhook 放入本目錄。
- 不要讓瀏覽器直接連線 OpenSearch。
- 不要讓前端直接接受任意 OpenSearch update body。
- `manual_merge_jira_issues.py` 是既有 Jira 合併／刪除工具，不可當作 Review API 使用。
