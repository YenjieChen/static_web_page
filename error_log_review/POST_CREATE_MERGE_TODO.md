# Jira 建立後人工 Merge TODO

## 目的

AI 判定需要建立 Jira 後，Jira 可以直接建立，不需要人工 approval。人工 review 發生在建立之後，用來處理錯建或 duplicate Jira。

目前頁面：

- `merge.html` / `merge.js` 可搜尋相似 embedding candidate。
- 可將 error logs 指向目標 embedding document。
- 對已經有 Jira key 的 candidate，目前只會提醒 reviewer 到 Jira Cloud 手動關閉或標記 duplicate。
- static page 直接寫 OpenSearch，沒有可信的 server-side reviewer identity 或集中 audit trail。

## 實作 TODO

### 1. 定義 post-create merge contract

- [ ] 定義 `source_jira_key`、`target_jira_key`、source/target embedding document id、site、log group、reviewer、reason、request id。
- [ ] 明確規定只允許同一 site；log group 不同時必須要求 reviewer 明確確認。
- [ ] request 必須攜帶 source/target embedding 與所有 affected error-log 的 `_seq_no` / `_primary_term` snapshot。
- [ ] 禁止把 Jira project id/key 從 browser request 傳入覆寫受控設定；Jira project 由 backend configuration 決定。

### 2. 建立受信任的 backend merge endpoint

- [ ] 不讓 browser 直接執行完整 merge mutation；由 backend 驗證 reviewer identity、權限與 request fingerprint。
- [ ] 先 dry-run/read-back，再以 CAS 更新所有 affected error logs。
- [ ] source Jira 已存在時，使用 Jira Cloud API 將 source 標記為 duplicate / closed，並留下指向 target 的 comment 或 link。
- [ ] target Jira 不可被刪除或覆寫；source 與 target 相同時拒絕。
- [ ] Jira API ambiguous outcome 必須進入 reconciliation，不得自動 retry。

### 3. OpenSearch 與 embedding merge

- [ ] 將 affected error logs 的 `jira_reference` 指向 target embedding document。
- [ ] 將 source embedding 標記為 `MANUAL_MERGED`，保存 `merged_into`、`merge_operation_id`、`merged_by`、`merged_at`、`merge_reason`。
- [ ] 不直接刪除 source embedding；先保留 audit/redirect document，避免 historical reference 失效。
- [ ] 使用 source/target version CAS；任一 version conflict 時整筆 merge 進入 `CONFLICT`，不可部分完成後靜默成功。
- [ ] 驗證 `linked_log_count`、target embedding 存在、source redirect 存在，以及 Jira source/target 狀態。

### 4. Reviewer UX

- [ ] 顯示 source Jira 與 target Jira 的 summary、site、log group、affected log count。
- [ ] 對有 Jira key 的 source 顯示不可逆警告，要求輸入 merge reason。
- [ ] 顯示 dry-run 結果與預計更新的 log count。
- [ ] submit 後顯示 `VERIFIED`、`CONFLICT`、`JIRA_MERGE_UNKNOWN`、`PARTIAL` 等狀態與 reconciliation id。
- [ ] 不在 browser 儲存或輸出 Jira token、password、webhook。

### 5. Audit / idempotency / tests

- [ ] 建立 `JIRA_MERGE_OPERATION` operation document 與 deterministic idempotency key。
- [ ] 相同 idempotency replay 不可建立第二次 Jira merge，也不可重複搬移 logs。
- [ ] 測試 source/target 相同、site mismatch、CAS conflict、Jira timeout、權限不足、partial recovery、replay。
- [ ] 更新 `MANUAL_REVIEW_API.md`，說明 post-create merge contract 與安全限制。

## 非目標

- 不把 post-create merge 變成 AI Jira creation 的 approval gate。
- 不在 static page 內保存 Jira credentials。
- 不使用 `JIRA_PROJECT_ID` 取代受控的 `JIRA_PROJECT_KEY=VEL`。
