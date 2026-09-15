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
  "jira_reference": "review_candidate_reference",
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

## Important limitations

- This is direct browser-to-OpenSearch access, not a security boundary. A reviewer can inspect or modify requests in browser developer tools.
- OpenSearch credentials are not stored persistently, but they are necessarily present in browser memory while the page is open.
- There is no trusted server-side reviewer identity or centralized audit trail in this static-only design.
- The frontend cannot bypass CORS, TLS, network, or OpenSearch permission errors.
- `?demo=1` bypasses OpenSearch and uses built-in sample records; demo decisions never write data.
