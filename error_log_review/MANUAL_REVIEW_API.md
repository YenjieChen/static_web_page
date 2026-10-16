# Manual Review direct OpenSearch contract

`review.html` is a static frontend that directly calls OpenSearch from the browser. It does not require Lambda or `/api/review/*`.

## Browser configuration

The reviewer enters an HTTPS OpenSearch URL, username, and password in the page. The URL and username are kept in browser `localStorage`. The password is kept only in `sessionStorage`, so it survives a reload in the same tab but is cleared when the tab is closed. The values are not written to cookies or URLs, and the Clear button removes all three values.

The browser sends an HTTP Basic Authorization header to the configured OpenSearch URL. This means the browser holds OpenSearch privileges and the OpenSearch account must be least-privilege. Do not use an administrative account.

## Required OpenSearch configuration

- CORS must allow the exact Review page origin.
- CORS must allow request headers `Authorization` and `Content-Type`.
- CORS must allow methods `GET`, `POST`, `OPTIONS`.
- TLS certificate validation must pass in the browser and match the configured hostname.
- The browser network must be allowed to reach OpenSearch.
- Permissions should be restricted to the required `error_log_dev_*`, `error_log_stage_*`, `error_log_prod_*`, and `jira_issue_embedding*` indexes.

If CORS or TLS is not configured, the browser will report a network failure even when the credentials are correct.

## Read operation

The page sends a search request to:

```text
POST /error_log_{site}_*/_search
```

or, when no site filter is selected:

```text
POST /error_log_dev_*,error_log_stage_*,error_log_prod_*/_search
```

The query filters for:

```json
{
  "association_status": "PENDING_REVIEW"
}
```

The page maps each hit using its `_index`, `_id`, and `_source` fields. The source fields include `review_candidate_reference`, `review_candidate_key`, `review_similarity`, and the error details.

## Approve operation

For each selected item, the page:

1. Reads `GET /{index_name}/_doc/{document_id}` again.
2. Verifies the document exists and still has `association_status = PENDING_REVIEW`.
3. Verifies the stored `review_candidate_reference` matches the selected item.
4. Searches `jira_issue_embedding*` by candidate document ID and requires a hit.
5. Updates only an allow-listed error-log monthly index with optimistic concurrency parameters:

```text
POST /{index_name}/_update/{message_id}?if_seq_no=...&if_primary_term=...
```

The update writes:

```json
{
  "jira_reference": "candidate embedding document _id",
  "association_status": "MANUAL_LINKED",
  "review_decision": "LINK_EXISTING",
  "review_note": "...",
  "reviewed_at": "...",
  "review_candidate_reference": null,
  "review_candidate_key": null,
  "review_similarity": null,
  "review_reason": null
}
```

## Reject operation

The page performs the same status and candidate consistency checks, then writes:

```json
{
  "association_status": "MANUAL_REJECTED",
  "review_decision": "REJECT_CANDIDATE",
  "review_note": "required reason",
  "reviewed_at": "..."
}
```

It does not create a Jira issue or embedding.

## Post-create Jira merge（純前端可選功能）

`merge.html` / `merge.js` 可選擇由 reviewer 在目前瀏覽器輸入 Jira URL、帳號與 API token，直接呼叫 Jira REST API。Jira credentials 僅保存在 JavaScript memory，不會寫入 `localStorage`、`sessionStorage`、Cookie、URL、console 或結果頁面；重新整理或關閉分頁後消失。

使用方式：

1. 輸入並套用 OpenSearch credentials。
2. 在 Jira 連線設定輸入 HTTPS Jira URL、Jira email/帳號與 API token。
3. 查詢 target Jira、選取候選，並填寫合併理由。
4. 有 Jira key 的候選在提交時會先驗證 target/source issue，再更新 OpenSearch error-log reference，呼叫 `DELETE /rest/api/3/issue/{sourceKey}`，確認 source 不存在後才刪除 source embedding。
5. 沒有 Jira key 的候選不呼叫 Jira API，只執行原本的 OpenSearch merge。

安全與限制：

- 這是 browser direct API，token 在操作期間可被該瀏覽器的 DevTools、extension 或惡意頁面程式看到；請使用權限受限、可撤銷的 Jira token，不要使用 administrator token。
- Jira endpoint 必須允許 `https://yenjiechen.github.io` 的 CORS，且允許 `GET`、`DELETE` 與 `Authorization` request header；否則純前端流程會因瀏覽器 CORS 而失敗。
- target issue 永遠不會被刪除；source 與 target 相同時拒絕。
- Jira delete 未成功或無法驗證時，不會刪除 source embedding，但 OpenSearch error-log reference 可能已經更新；畫面會標示該候選失敗，需人工 reconciliation。
- 這個功能不會將 Jira token 傳到 OpenSearch，也不會把 token 寫入 audit/result。
