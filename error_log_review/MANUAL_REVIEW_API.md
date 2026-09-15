# Manual Review API contract

`review.html` is a static frontend. The browser must not connect directly to OpenSearch or receive OpenSearch/Jira credentials. Deploy the API behind the same origin (or a tightly restricted reverse proxy) and enforce authentication/authorization server-side.

## Endpoints

### `GET /api/review/pending`

Returns only error logs whose `association_status` is `PENDING_REVIEW`.

```json
{
  "items": [
    {
      "id": "OpenSearch document id",
      "index_name": "error_log_prod_2026_9",
      "message_id": "OpenSearch document id",
      "site": "prod",
      "error_message": "...",
      "traceback": "...",
      "error_type": "...",
      "log_group": "...",
      "count": 3,
      "timestamp": "2026-09-14T02:15:00Z",
      "review_candidate_key": "VEL-1234",
      "review_candidate_reference": "Jira embedding document id",
      "review_similarity": 0.8234,
      "review_reason": "SIMILARITY_IN_GREY_ZONE"
    }
  ]
}
```

The API should paginate or cap the response for large queues, for example with `?limit=100&cursor=...`.

### `POST /api/review/approve`

Approves the supplied candidate association. The backend must re-read each source document and verify that it is still `PENDING_REVIEW`; do not trust a stale browser payload.

Request:

```json
{
  "items": [
    {
      "index_name": "error_log_prod_2026_9",
      "message_id": "OpenSearch document id",
      "review_candidate_reference": "Jira embedding document id",
      "review_candidate_key": "VEL-1234"
    }
  ],
  "reason": "Same prod service and same root cause"
}
```

For an approved item, the backend should atomically update the error log with:

```json
{
  "jira_reference": "review_candidate_reference",
  "association_status": "MANUAL_LINKED",
  "review_decision": "LINK_EXISTING",
  "review_note": "..."
}
```

The backend should clear the pending candidate fields after persisting an audit record. The candidate reference must point to an existing current-year Jira embedding document, and the candidate site must match the error log site.

### `POST /api/review/reject`

Rejects the candidate without creating a Jira issue.

Request shape is the same as approve, but `reason` is required. A safe implementation should set an explicit terminal/manual state such as `MANUAL_REJECTED` and retain the candidate plus reason in an audit record. Do not simply clear `PENDING_REVIEW` and invoke the periodic worker: it can rediscover the same candidate and mark the log pending again.

## Security and audit requirements

- Require authenticated users with an operator/reviewer role.
- Validate `index_name` against the configured `error_log_{site}_{year}_{month}` pattern; never accept arbitrary index names.
- Validate that `message_id`, candidate reference, and candidate key belong to the same pending document.
- Use an allow-list for update fields; never accept an arbitrary OpenSearch update body from the browser.
- Record reviewer identity, decision, timestamp, old status, candidate, reason, and update result.
- Use CSRF protection if the API uses cookie authentication.
- Do not return or log credentials, webhook URLs, authorization headers, or full sensitive environment variables.

## Current repository limitation

This repository currently serves the dashboard with Nginx only and does not contain an HTTP API server. The page therefore supports `review.html?demo=1` for UI preview, but normal mode displays an API connection error until these endpoints are implemented and reverse-proxied. The existing `manual_merge_jira_issues.py` is destructive Jira-merge tooling and must not be used as the Review API.
