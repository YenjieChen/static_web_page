# Error Log Review 靜態頁面

本目錄保存錯誤日誌人工 Review 的靜態前端頁面。頁面可直接由瀏覽器以使用者輸入的 OpenSearch credentials 查詢與更新 `PENDING_REVIEW` 錯誤日誌，不依賴 Lambda 或 `/api/review/*` 後端 API。

## 目前狀態

- 靜態 Review 頁面已完成，可由 GitHub Pages 或其他靜態檔案伺服器提供服務。
- 非 Demo 模式會直接由 `review.js` 呼叫 OpenSearch REST API。
- OpenSearch URL 與帳號會保存於瀏覽器 `localStorage`；密碼只保存於目前分頁的 `sessionStorage`，關閉分頁後清除。三者都不會寫入 Cookie 或 URL。
- 這個架構會讓瀏覽器持有 OpenSearch 權限；請使用最小權限帳號，並限制可連線的 origin、索引與網路範圍。
- 拒絕候選會直接更新 error log 為 `MANUAL_REJECTED`，不會由瀏覽器建立 Jira 或 embedding。

## 直連必要條件

使用直連功能前，OpenSearch 必須：

1. 允許 Review 網頁 origin 的 CORS，包含 `Authorization` 與 `Content-Type` request headers。
2. 使用瀏覽器信任且 hostname 匹配的 TLS 憑證；IP 位址憑證不匹配時，瀏覽器會拒絕連線。
3. 提供受限的帳號權限，只允許指定 `error_log_*` 與 `jira_issue_embedding*` 索引的必要查詢／更新操作。
4. 允許使用者瀏覽器所在網路連到 OpenSearch。

若未滿足 CORS、TLS 或網路條件，瀏覽器會顯示查詢失敗；這不是前端可以繞過的限制。

## 目錄結構

```text
static_web_page/
├── README.md
├── error_log_review/
│   ├── index.html              # Review 目錄入口，導向 review.html
│   ├── review.html             # 人工 Review 頁面
│   ├── review.css              # Review 頁面樣式
│   ├── review.js               # Review UI、Demo 與 API client
│   └── MANUAL_REVIEW_API.md    # 直連 OpenSearch contract 與安全要求
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

使用 Demo 模式可預覽 UI，不會連線 OpenSearch：

```text
http://localhost:<port>/error_log_review/review.html?demo=1
```

Demo 模式會載入頁面內的範例資料。核准與拒絕只會模擬操作，不會寫入 OpenSearch 或建立 Jira。

### OpenSearch 測試設定欄位

頁面提供 OpenSearch URL、帳號與密碼欄位，但不在公開檔案中設定或記錄任何預設 OpenSearch endpoint。使用者需在頁面自行輸入 URL，按下「直接查詢 OpenSearch」後，瀏覽器會直接查詢 `error_log_dev_*`、`error_log_stage_*`、`error_log_prod_*` 中的 `PENDING_REVIEW` 文件。

核准與拒絕也會由瀏覽器直接呼叫 OpenSearch REST API。核准前會重新讀取原始文件，確認仍為 `PENDING_REVIEW`，並確認候選 embedding 存在；拒絕會寫入 `MANUAL_REJECTED`。這些操作會直接修改資料，請先確認帳號權限、CORS、TLS 與索引限制。

帳號與 URL 會保存於目前瀏覽器的 `localStorage`，密碼保存於目前分頁的 `sessionStorage`，因此重新整理同一分頁會恢復三個欄位，關閉分頁後密碼會清除。按下「清除帳密」會同步清除畫面與儲存值，不會寫入 Cookie 或 URL。

目前直連功能不使用 `/api/review/*` 或 Lambda。
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
- OpenSearch 查詢或更新失敗時顯示錯誤，不假裝操作成功。

## OpenSearch REST 操作

正式模式由 `review.js` 直接呼叫 OpenSearch，不使用 `/api/review/*` 或 Lambda：

- 查詢：`POST /error_log_{site}_*/_search`
- 讀取單筆：`GET /{index_name}/_doc/{document_id}`
- 檢查候選：`POST /jira_issue_embedding*/_search`，以 candidate document ID 查詢
- 更新：`POST /{index_name}/_update/{document_id}`

查詢只篩選 `association_status = PENDING_REVIEW`。核准前會重新讀取原始文件，確認狀態與 candidate reference 沒有變更，並查詢 `jira_issue_embedding*` 取得候選 hit 的 `_id`。核准會將該 embedding document `_id` 寫入 `jira_reference`，而不是將 Jira key（例如 `VEL-1462`）寫入；同時寫入 `MANUAL_LINKED`。拒絕會寫入 `MANUAL_REJECTED`。

瀏覽器直連需要 OpenSearch 允許目前頁面 origin 的 CORS、有效 TLS 憑證，以及具備最小必要權限的帳號。完整注意事項請參考 `error_log_review/MANUAL_REVIEW_API.md`。

## 驗證紀錄

Review 頁面已完成以下靜態驗證：

- `review.js` JavaScript syntax check 通過。
- `index.html` 與 `review.html` HTML parse 通過。
- `review.html` 引用的 `review.css` 與 `review.js` 均存在。
- Review 目錄入口、Review HTML、CSS 與 JS 以本機 HTTP server smoke test 回應 `200`。
- 前端檔案未包含 credentials、password、token 或 webhook URL。

## 安全注意事項

- 不要將 OpenSearch credentials、Jira token、OpenAI key 或 Teams webhook 放入本目錄。
- 直連模式必須使用最小權限 OpenSearch 帳號，不要使用 administrator 帳號。
- 限制 OpenSearch CORS、TLS、網路來源與可存取索引。
- 直連瀏覽器不是可信任的安全邊界；使用者可以在 DevTools 檢視或修改 request。
- `manual_merge_jira_issues.py` 是既有 Jira 合併／刪除工具，不可當作 Review API 使用。

## 未關聯 logs 與待建立 Jira 流程

「審核佇列」提供三種模式：

- `PENDING_REVIEW`：檢視系統候選並核准或拒絕。
- `UNASSOCIATED`：查詢沒有 `jira_reference` 或 `jira_reference` 為空的 logs，先依錯誤特徵 clustering。
- `MANUAL_NEEDS_NEW_JIRA`：查看已人工標記、等待後續建立 Jira 的 logs。

在 `UNASSOCIATED` 模式按下「標記需建立新 Jira」只會寫入：

```json
{
  "association_status": "MANUAL_NEEDS_NEW_JIRA",
  "review_decision": "CREATE_NEW_JIRA_REQUESTED",
  "review_note": "人工備註",
  "reviewed_at": "..."
}
```

此操作不會建立 Jira、不會產生 embedding，也不會呼叫 Jira API。後續應由受信任的 backfill／worker 依 cluster 逐批建立，避免大量重複建單。`MANUAL_NEEDS_NEW_JIRA` 佇列目前是檢視用途，尚未提供自動建立新 Jira 功能。
