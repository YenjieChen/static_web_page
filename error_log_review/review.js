/* Direct OpenSearch mode. Credentials stay in memory only and are sent to OpenSearch by the browser. */
const ERROR_INDEXES = 'error_log_dev_*,error_log_stage_*,error_log_prod_*';
const CANDIDATE_INDEX = 'jira_issue_embedding_titan_v2';
const PENDING_STATUS = 'PENDING_REVIEW';
const CLUSTER_TOKEN_SIMILARITY = 0.45;
const CONNECTION_STORAGE_KEYS = {
    url: 'errorLogReview.opensearchUrl',
    username: 'errorLogReview.opensearchUsername',
    password: 'errorLogReview.opensearchPassword',
};

const demoItems = [
    {
        id: 'demo-stage-001', site: 'stage', message_id: 'demo-stage-001',
        error_message: 'ERROR: relation "OBJECT_TRACE_13792_2026_8_17" does not exist at character 8',
        traceback: 'psycopg.errors.UndefinedTable: relation does not exist\n  File "app/query.py", line 88, in execute',
        error_type: 'UndefinedTable', log_group: '/aws/rds/cluster/example/postgresql', count: 7,
        timestamp: '2026-09-14T01:00:00Z', review_candidate_key: 'VEL-2146',
        review_candidate_reference: 'demo-embedding-vel-2146', review_similarity: 0.8234,
        review_reason: 'SIMILARITY_IN_GREY_ZONE', index_name: 'error_log_stage_2026_9',
        candidate: {
            key: 'VEL-2146', summary: 'PostgreSQL schema migration missing OBJECT_TRACE table',
            error_message: 'relation "OBJECT_TRACE_*" does not exist', error_type: 'UndefinedTable',
            traceback: 'psycopg.errors.UndefinedTable: relation does not exist\n  File "app/query.py", line 88, in execute',
        },
    },
    {
        id: 'demo-prod-002', site: 'prod', message_id: 'demo-prod-002',
        error_message: 'Connection pool exhausted while connecting to PostgreSQL',
        traceback: 'TimeoutError: connection pool exhausted\n  File "db/pool.py", line 142, acquire',
        error_type: 'TimeoutError', log_group: '/ecs/example-api', count: 3,
        timestamp: '2026-09-14T02:15:00Z', review_candidate_key: 'VEL-2033',
        review_candidate_reference: 'demo-embedding-vel-2033', review_similarity: 0.8071,
        review_reason: 'SIMILARITY_IN_GREY_ZONE', index_name: 'error_log_prod_2026_9',
        candidate: {
            key: 'VEL-2033', summary: 'PostgreSQL connection pool exhaustion',
            error_message: 'Database connection pool exhausted', error_type: 'TimeoutError',
            traceback: 'TimeoutError: connection pool exhausted\n  File "db/pool.py", line 142, acquire',
        },
    },
];

class ReviewPage {
    constructor() {
        this.items = [];
        this.selected = new Set();
        this.pendingAction = null;
        this.connection = null;
        this.visibleItems = [];
        this.clusterGroups = new Map();
        this.demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
        this.restoreConnectionFields();
        this.bindEvents();
        this.load();
    }

    bindEvents() {
        document.getElementById('refresh-btn').addEventListener('click', () => this.load());
        document.getElementById('connection-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.applyConnectionSettings();
        });
        document.getElementById('clear-connection-btn').addEventListener('click', () => this.clearConnectionSettings());
        document.getElementById('review-list').addEventListener('change', (event) => {
            if (event.target.matches('[data-cluster-id]')) {
                const cluster = this.clusterGroups.get(event.target.dataset.clusterId);
                if (cluster) {
                    cluster.forEach((item) => event.target.checked ? this.selected.add(item.id) : this.selected.delete(item.id));
                    this.updateSelectionUI(this.visibleItems);
                }
                return;
            }
            if (!event.target.matches('[data-select-id]')) return;
            const id = event.target.dataset.selectId;
            if (event.target.checked) this.selected.add(id); else this.selected.delete(id);
            event.target.closest('.review-card')?.classList.toggle('is-selected', event.target.checked);
            this.updateSelectionUI(this.visibleItems);
        });
        document.getElementById('review-list').addEventListener('click', (event) => {
            const toggle = event.target.closest('.cluster-toggle');
            const approveButton = event.target.closest('.approve-btn, .needs-jira-btn, .link-existing-btn, .cluster-approve-btn, .cluster-needs-jira-btn, .cluster-link-existing-btn');
            const rejectButton = event.target.closest('.reject-btn, .cluster-reject-btn');
            if (toggle) {
                const target = document.getElementById(toggle.dataset.target);
                const cluster = this.clusterGroups.get(toggle.dataset.clusterId);
                if (target && cluster) {
                    const willOpen = target.classList.contains('hidden');
                    if (willOpen && target.dataset.loaded !== 'true') {
                        const representative = cluster[0];
                        target.innerHTML = `<div class="cluster-representative">代表錯誤：${this.escape(representative.error_message || '未提供')}<br>Traceback：${this.escape(representative.traceback || '未提供')}</div>${cluster.map((item) => this.renderCard(item)).join('')}`;
                        target.dataset.loaded = 'true';
                    }
                    target.classList.toggle('hidden', !willOpen);
                    toggle.textContent = willOpen ? '收合 cluster logs' : '展開 cluster logs';
                }
            }
            if (approveButton) {
                const cluster = approveButton.dataset.clusterId ? this.clusterGroups.get(approveButton.dataset.clusterId) : null;
                const action = approveButton.dataset.reviewAction || 'approve';
                this.openAction(action, cluster ? cluster.map((item) => item.id) : approveButton.dataset.actionId);
            }
            if (rejectButton) {
                const cluster = rejectButton.dataset.clusterId ? this.clusterGroups.get(rejectButton.dataset.clusterId) : null;
                const action = rejectButton.dataset.reviewAction || 'reject';
                this.openAction(action, cluster ? cluster.map((item) => item.id) : rejectButton.dataset.actionId);
            }
        });
        document.getElementById('search-input').addEventListener('input', () => this.render());
        document.getElementById('site-filter').addEventListener('change', () => this.render());
        document.getElementById('time-range').addEventListener('change', () => this.load());
        document.getElementById('review-mode').addEventListener('change', () => this.load());
        document.getElementById('sort-filter').addEventListener('change', () => this.render());
        document.getElementById('group-candidates').addEventListener('change', () => this.render());
        document.getElementById('cluster-candidates').addEventListener('change', () => this.render());
        document.getElementById('select-all').addEventListener('change', (event) => this.toggleAll(event.target.checked));
        document.getElementById('bulk-approve-btn').addEventListener('click', () => this.openBulkApprove());
        document.getElementById('modal-close').addEventListener('click', () => this.closeModal());
        document.getElementById('modal-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('modal-confirm').addEventListener('click', () => this.confirmAction());
        document.getElementById('review-modal').addEventListener('click', (event) => {
            if (event.target.id === 'review-modal') this.closeModal();
        });
    }

    restoreConnectionFields() {
        const url = this.readStorage(localStorage, CONNECTION_STORAGE_KEYS.url);
        const username = this.readStorage(localStorage, CONNECTION_STORAGE_KEYS.username);
        const password = this.readStorage(sessionStorage, CONNECTION_STORAGE_KEYS.password);
        document.getElementById('opensearch-url').value = url;
        document.getElementById('opensearch-username').value = username;
        document.getElementById('opensearch-password').value = password;
        if (url || username || password) {
            document.getElementById('connection-details').textContent = '已恢復上次輸入；請按「直接查詢 OpenSearch」重新建立本頁連線。';
        }
    }

    persistConnectionFields(url, username, password) {
        this.writeStorage(localStorage, CONNECTION_STORAGE_KEYS.url, url);
        this.writeStorage(localStorage, CONNECTION_STORAGE_KEYS.username, username);
        this.writeStorage(sessionStorage, CONNECTION_STORAGE_KEYS.password, password);
    }

    readStorage(storage, key) {
        try { return storage.getItem(key) || ''; } catch { return ''; }
    }

    writeStorage(storage, key, value) {
        try {
            if (value) storage.setItem(key, value); else storage.removeItem(key);
        } catch (error) {
            console.warn('Unable to persist connection setting:', error);
        }
    }

    clearStoredConnectionFields() {
        this.writeStorage(localStorage, CONNECTION_STORAGE_KEYS.url, '');
        this.writeStorage(localStorage, CONNECTION_STORAGE_KEYS.username, '');
        this.writeStorage(sessionStorage, CONNECTION_STORAGE_KEYS.password, '');
    }

    async load() {
        if (this.demoMode) {
            this.items = [...demoItems];
            this.selected.clear();
            this.render();
            this.updateSummary();
            this.showToast('Demo 模式：不會連線或寫入 OpenSearch。', 'success');
            return;
        }
        if (!this.connection) {
            this.items = [];
            this.selected.clear();
            this.setList('<div class="empty-state">請先輸入 OpenSearch URL、帳號與密碼，再按「直接查詢 OpenSearch」。</div>');
            this.updateSummary();
            return;
        }
        const mode = document.getElementById('review-mode').value;
        const title = mode === 'UNASSOCIATED' ? '待標記需建立新 Jira' : mode === 'MANUAL_NEEDS_NEW_JIRA' ? '待建立新 Jira' : '待審核資料';
        this.setList(`<div class="loading-state">正在直接查詢 OpenSearch 的${title}...</div>`);
        try {
            this.items = await this.fetchQueueItems();
            if (document.getElementById('review-mode').value === 'UNASSOCIATED') {
                this.items = await this.filterInvalidReferences(this.items);
            }
            await this.attachCandidateDetails(this.items);
            this.selected.clear();
            this.render();
            this.updateSummary();
            this.setConnectedState(`已查詢 ${this.items.length} 筆 ${document.getElementById('review-mode').value}（最近 ${this.getTimeRangeDays()} 天）${this.items.length >= 10000 ? '（已達單批上限，請使用 site 篩選或縮短時間區間）' : ''}`, 'success');
        } catch (error) {
            console.error('OpenSearch request failed:', error);
            this.setList(`<div class="error-state">${this.escape(this.describeConnectionError(error))}</div>`);
            this.updateSummary();
            this.setConnectedState('查詢失敗', 'error');
        }
    }


    getTimeRangeDays() {
        return Number(document.getElementById('time-range').value || 1);
    }

    getTimeRangeFilter() {
        const end = new Date();
        const start = new Date(end.getTime() - this.getTimeRangeDays() * 24 * 60 * 60 * 1000);
        return { range: { timestamp: { gte: start.toISOString(), lte: end.toISOString() } } };
    }

    async fetchQueueItems() {
        const mode = document.getElementById('review-mode').value;
        if (mode === 'PENDING_REVIEW') return this.fetchPendingItems();
        const site = document.getElementById('site-filter').value;
        // Dev-site error logs are intentionally excluded from automated Jira
        // association (see update_embedding_with_error_logs in report_shared.py);
        // dev uses a separate email-only monitoring flow instead. Without this,
        // every dev log with no jira_reference piles up in the UNASSOCIATED
        // queue and can never have a suggested candidate, which drowns out the
        // handful of prod/stage logs that actually need a reviewer decision.
        const indexes = site ? `error_log_${site}_*`
            : mode === 'UNASSOCIATED' ? 'error_log_stage_*,error_log_prod_*'
            : ERROR_INDEXES;
        const statusFilter = { term: { 'association_status.keyword': mode } };
        const queueQuery = mode === 'UNASSOCIATED' ? { match_all: {} } : statusFilter;
        const body = {
            size: 10000,
            sort: [{ timestamp: { order: 'desc' } }],
            query: { bool: { filter: [this.getTimeRangeFilter(), queueQuery] } },
        };
        const payload = await this.openSearchRequest(`/${this.encodeIndex(indexes)}/_search`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        return (payload.hits?.hits || []).map((hit) => this.normalizeHit(hit));
    }

    async filterInvalidReferences(items) {
        const references = [...new Set(items.map((item) => item.jira_reference).filter((value) => value && value !== 'null' && value !== 'None'))];
        if (!references.length) return items;
        const validReferences = new Set();
        for (let offset = 0; offset < references.length; offset += 500) {
            const batch = references.slice(offset, offset + 500);
            const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
                method: 'POST',
                body: JSON.stringify({
                    size: batch.length,
                    _source: ['key'],
                    query: { ids: { values: batch } },
                }),
            });
            (payload.hits?.hits || []).forEach((hit) => {
                if (hit._source?.key) validReferences.add(hit._id);
            });
        }
        return items.filter((item) => {
            const reference = item.jira_reference;
            return !reference || reference === 'null' || reference === 'None' || !validReferences.has(reference);
        });
    }
    async fetchPendingItems() {
        const site = document.getElementById('site-filter').value;
        const indexes = site ? `error_log_${site}_*` : ERROR_INDEXES;
        const body = {
            size: 10000,
            sort: [{ timestamp: { order: 'desc' } }],
            query: {
                bool: {
                    filter: [
                        this.getTimeRangeFilter(),
                        {
                            bool: {
                                should: [
                                    { term: { 'association_status.keyword': PENDING_STATUS } },
                                    { term: { association_status: PENDING_STATUS } },
                                ],
                                minimum_should_match: 1,
                            },
                        },
                    ],
                },
            },
        };
        const payload = await this.openSearchRequest(`/${this.encodeIndex(indexes)}/_search`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        return (payload.hits?.hits || []).map((hit) => this.normalizeHit(hit));
    }

    normalizeHit(hit) {
        const source = hit._source || {};
        const indexName = hit._index || '';
        const indexSite = indexName.match(/^error_log_(dev|stage|prod)_/)?.[1];
        return {
            ...source,
            id: hit._id,
            document_id: hit._id,
            message_id: source.message_id || hit._id,
            index_name: indexName,
            site: source.site || indexSite || 'unknown',
        };
    }

    async attachCandidateDetails(items) {
        // review_candidate_reference/key cover the PENDING_REVIEW queue.
        // jira_reference covers the UNASSOCIATED queue: once a high-similarity
        // no-key candidate is found, _mark_pending_new_jira() points the log's
        // jira_reference straight at that candidate (no review_candidate_*
        // fields are set in that path), so it must also be resolved here or
        // the dashboard shows "no suggested issue" even though a candidate
        // already exists and is waiting for a PENDING_CREATE decision.
        const references = [...new Set(items.map((item) => item.review_candidate_reference || item.jira_reference).filter((value) => value && value !== 'null' && value !== 'None'))];
        const keys = [...new Set(items.map((item) => item.review_candidate_key).filter(Boolean))];
        if (!references.length && !keys.length) return;
        const should = [];
        if (references.length) should.push({ ids: { values: references } });
        if (keys.length) {
            should.push({ terms: { 'key.keyword': keys } });
            should.push({ terms: { key: keys } });
        }
        const body = {
            size: Math.max(references.length, keys.length),
            _source: ['key', 'summary', 'description', 'error_message', 'error_type', 'traceback', 'site', 'status', 'log_group', 'embedding'],
            query: { bool: { should, minimum_should_match: 1 } },
        };
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const candidates = payload.hits?.hits || [];
        items.forEach((item) => {
            const reference = item.review_candidate_reference || item.jira_reference;
            const hit = candidates.find((candidateHit) => {
                const source = candidateHit._source || {};
                return candidateHit._id === reference
                    || (item.review_candidate_key && source.key === item.review_candidate_key);
            });
            item.candidate = hit ? {
                document_id: hit._id,
                ...(hit._source || {}),
            } : {
                key: item.review_candidate_key,
                summary: reference ? '找不到候選 Jira embedding document' : '尚無系統候選，可自行輸入既有 Jira 或標記需建立新 Jira',
                error_message: '',
                error_type: '',
                traceback: '',
            };
        });
    }

    async openSearchRequest(path, options = {}) {
        if (!this.connection) throw new Error('尚未設定 OpenSearch 連線');
        const headers = {
            Accept: 'application/json',
            Authorization: `Basic ${this.connection.authorization}`,
        };
        if (options.body) headers['Content-Type'] = 'application/json';
        let response;
        try {
            response = await fetch(`${this.connection.url}${path}`, {
                ...options,
                headers,
                credentials: 'omit',
            });
        } catch (error) {
            throw new Error(`無法連線 OpenSearch。請檢查 TLS 憑證、CORS 與網路設定（${error.message}）。`);
        }
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
        if (!response.ok) {
            const reason = payload.error?.reason || payload.message || `HTTP ${response.status}`;
            throw new Error(`OpenSearch ${response.status}: ${reason}`);
        }
        return payload;
    }

    async applyConnectionSettings() {
        const url = document.getElementById('opensearch-url').value.trim().replace(/\/$/, '');
        const username = document.getElementById('opensearch-username').value;
        const password = document.getElementById('opensearch-password').value;
        let parsed;
        try {
            parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
                throw new Error('invalid endpoint');
            }
        } catch {
            this.showToast('請輸入不含帳密、查詢參數或 hash 的 HTTPS OpenSearch URL。', 'error');
            return;
        }
        if (!username || !password) {
            this.showToast('直接查詢 OpenSearch 需要帳號與密碼。', 'error');
            return;
        }
        this.connection = { url, username, authorization: this.toBasicAuth(username, password) };
        this.persistConnectionFields(url, username, password);
        this.setConnectedState('正在直接查詢 OpenSearch...', 'pending');
        document.getElementById('connection-details').textContent = `Host：${parsed.host}｜帳號：已輸入｜密碼：已輸入（本分頁保存）｜credentials 僅存在本頁記憶體`;
        await this.load();
    }

    clearConnectionSettings() {
        this.connection = null;
        this.clearStoredConnectionFields();
        this.items = [];
        this.selected.clear();
        document.getElementById('opensearch-url').value = '';
        document.getElementById('opensearch-username').value = '';
        document.getElementById('opensearch-password').value = '';
        document.getElementById('connection-status').textContent = '尚未套用設定';
        document.getElementById('connection-status').className = 'connection-status';
        document.getElementById('connection-details').textContent = '尚未提供連線設定';
        this.setList('<div class="empty-state">請先輸入 OpenSearch URL、帳號與密碼，再按「直接查詢 OpenSearch」。</div>');
        this.updateSummary();
        this.showToast('本頁記憶體中的連線設定已清除。', 'success');
    }

    setConnectedState(message, type = '') {
        const status = document.getElementById('connection-status');
        status.textContent = message;
        status.className = `connection-status ${type ? `is-${type}` : ''}`;
    }

    toBasicAuth(username, password) {
        const bytes = new TextEncoder().encode(`${username}:${password}`);
        let binary = '';
        bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
        return btoa(binary);
    }

    encodeIndex(index) { return encodeURIComponent(index).replace(/%2A/gi, '*').replace(/%2C/gi, ','); }
    encodeId(id) { return encodeURIComponent(id); }

    async getCurrentLog(item) {
        this.assertErrorIndex(item.index_name);
        const payload = await this.openSearchRequest(`/${this.encodeIndex(item.index_name)}/_doc/${this.encodeId(item.document_id || item.id)}`);
        if (!payload.found) throw new Error('找不到原始 error log，可能已被刪除。');
        return { source: payload._source || {}, seqNo: payload._seq_no, primaryTerm: payload._primary_term };
    }

    async assertCandidateExists(candidateReference, candidateKey) {
        if (!candidateReference && !candidateKey) throw new Error('此項目沒有候選 embedding reference 或 Jira key，不能核准。');
        const should = [];
        if (candidateReference) should.push({ ids: { values: [candidateReference] } });
        if (candidateKey) {
            should.push({ term: { 'key.keyword': candidateKey } });
            should.push({ term: { key: candidateKey } });
        }
        const body = {
            size: 1,
            _source: ['key', 'summary', 'error_message', 'error_type', 'traceback', 'description', 'site', 'status'],
            query: { bool: { should, minimum_should_match: 1 } },
        };
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, { method: 'POST', body: JSON.stringify(body) });
        const hit = payload.hits?.hits?.[0];
        if (!hit?._id) throw new Error('找不到候選 Jira embedding document，不能核准。');
        return { document_id: hit._id, source: hit._source || {} };
    }

    async findSimilarKeyedCandidates(embedding, site, logGroup, limit = 3, excludeDocumentId = "") {
        if (!Array.isArray(embedding) || !embedding.length) return [];
        // Candidates without a key (including the source document itself,
        // which always scores highest against its own vector) are common in
        // the nearest neighbors and get dropped by the post-fetch filter
        // below. Fetching only `limit` results and filtering afterwards
        // regularly leaves 0-1 usable suggestions even when keyed matches
        // exist further down the ranking, so fetch a much larger candidate
        // pool (k) and only cap the *filtered* result at `limit`.
        const candidatePoolSize = Math.max(limit * 20, 100);
        const body = {
            size: candidatePoolSize,
            _source: ['key', 'summary', 'error_message', 'error_type', 'site', 'log_group', 'status'],
            query: {
                knn: { embedding: { vector: embedding, k: candidatePoolSize } },
            },
            post_filter: {
                bool: {
                    must: [{ term: { site } }],
                    must_not: [{ term: { status: 'SUB ISSUES' } }],
                },
            },
        };
        let payload;
        try {
            payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
                method: 'POST',
                body: JSON.stringify(body),
            });
        } catch (error) {
            console.warn('kNN suggestion query failed:', error);
            return [];
        }
        return (payload.hits?.hits || [])
            .map((hit) => ({ document_id: hit._id, score: hit._score, ...(hit._source || {}) }))
            .filter((candidate) => candidate.key && candidate.document_id !== excludeDocumentId && (!logGroup || candidate.log_group === logGroup))
            .slice(0, limit);
    }

    async assertExistingJiraByKey(jiraKey, item, source) {
        const normalizedKey = String(jiraKey || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(normalizedKey)) {
            throw new Error('請輸入有效的 Jira key，例如 VEL-1276。');
        }
        const body = {
            size: 50,
            _source: ['key', 'summary', 'site', 'log_group', 'status'],
            query: {
                bool: {
                    should: [
                        { term: { 'key.keyword': normalizedKey } },
                        { term: { key: normalizedKey } },
                    ],
                    minimum_should_match: 1,
                },
            },
        };
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const expectedSite = source.site || item.site;
        const expectedLogGroup = source.log_group || item.log_group;
        if (!expectedSite || !expectedLogGroup) {
            throw new Error('原始 error log 缺少 site 或 log group，無法安全驗證既有 Jira。');
        }
        const hit = (payload.hits?.hits || []).find((candidateHit) => {
            const candidate = candidateHit._source || {};
            return candidateHit._id
                && candidate.key === normalizedKey
                && candidate.site === expectedSite
                && candidate.log_group === expectedLogGroup;
        });
        if (!hit) {
            throw new Error(`找不到 Jira ${normalizedKey} 對應的 embedding document，或 site/log group 不一致。`);
        }
        return { document_id: hit._id, source: hit._source || {} };
    }

    async updateLog(item, updates, current) {
        this.assertErrorIndex(item.index_name);
        const version = current.seqNo !== undefined && current.primaryTerm !== undefined
            ? `?if_seq_no=${encodeURIComponent(current.seqNo)}&if_primary_term=${encodeURIComponent(current.primaryTerm)}` : '';
        return this.openSearchRequest(`/${this.encodeIndex(item.index_name)}/_update/${this.encodeId(item.document_id || item.id)}${version}`, {
            method: 'POST',
            body: JSON.stringify({ doc: updates }),
        });
    }

    assertErrorIndex(indexName) {
        if (!/^error_log_(dev|stage|prod)_\d{4}_\d{1,2}$/.test(indexName || '')) {
            throw new Error('拒絕更新非 error log 月索引。');
        }
    }

    async markCandidatePendingCreate(item, source) {
        const candidateId = source.jira_reference;
        if (!candidateId || candidateId === 'null' || candidateId === 'None') {
            throw new Error('此 log 沒有指向任何候選 embedding document，無法標記建立新 Jira。');
        }
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            body: JSON.stringify({
                size: 1,
                seq_no_primary_term: true,
                _source: ['key', 'jira_creation_status'],
                query: { ids: { values: [candidateId] } },
            }),
        });
        const hit = payload.hits?.hits?.[0];
        if (!hit) {
            throw new Error('候選 embedding document 不存在，請重新整理後再試。');
        }
        const candidateSource = hit._source || {};
        if (candidateSource.key) {
            throw new Error(`候選 embedding document 已經有 Jira key ${candidateSource.key}，不需要再標記建立新 Jira。`);
        }
        if (candidateSource.jira_creation_status === 'CREATING') {
            throw new Error('此候選已標記為待建立新 Jira，請等待後端任務處理。');
        }
        await this.openSearchRequest(
            `/${this.encodeIndex(hit._index)}/_update/${this.encodeId(candidateId)}?if_seq_no=${encodeURIComponent(hit._seq_no)}&if_primary_term=${encodeURIComponent(hit._primary_term)}`,
            {
                method: 'POST',
                body: JSON.stringify({ doc: { jira_creation_status: 'PENDING_CREATE' } }),
            },
        );
    }

    async applyDecision(item, action, reason, existingJiraKey = '', createNewJira = false) {
        const mode = document.getElementById('review-mode').value;
        const current = await this.getCurrentLog(item);
        const source = current.source;
        if (mode === 'UNASSOCIATED' && action === 'mark-new-jira') {
            await this.updateLog(item, {
                association_status: 'MANUAL_NEEDS_NEW_JIRA',
                review_decision: 'CREATE_NEW_JIRA_REQUESTED',
                review_note: reason || '',
                reviewed_at: new Date().toISOString(),
            }, current);
            return;
        }
        if (mode === 'UNASSOCIATED' && action === 'link-existing' && createNewJira) {
            if ((source.jira_reference || '') !== (item.jira_reference || '')) {
                throw new Error('此 log 的 jira_reference 已變更，請重新整理後再標記。');
            }
            await this.markCandidatePendingCreate(item, source);
            return;
        }
        if (mode === 'UNASSOCIATED' && action === 'link-existing') {
            if ((source.jira_reference || '') !== (item.jira_reference || '')) {
                throw new Error('此 log 的 jira_reference 已變更，請重新整理後再連結。');
            }
            const candidate = await this.assertExistingJiraByKey(existingJiraKey, item, source);
            await this.updateLog(item, {
                jira_reference: candidate.document_id,
                association_status: 'MANUAL_LINKED',
                review_decision: 'LINK_EXISTING',
                review_note: reason || `人工判定連結既有 Jira ${existingJiraKey.trim()}`,
                reviewed_at: new Date().toISOString(),
                review_candidate_reference: null,
                review_candidate_key: null,
                review_similarity: null,
                review_reason: null,
            }, current);
            return;
        }
        if (source.association_status !== PENDING_STATUS) {
            throw new Error(`資料狀態已變更為 ${source.association_status || '未設定'}，請重新整理。`);
        }
        if (source.review_candidate_reference !== item.review_candidate_reference
            && source.review_candidate_key !== item.review_candidate_key) {
            throw new Error('候選 reference 與 Jira key 都已變更，請重新整理後再審核。');
        }
        if (action === 'approve') {
            const candidate = await this.assertCandidateExists(
                source.review_candidate_reference,
                source.review_candidate_key || item.review_candidate_key,
            );
            await this.updateLog(item, {
                // jira_reference is the OpenSearch embedding document _id,
                // never the Jira/incident key such as VEL-1462.
                jira_reference: candidate.document_id,
                association_status: 'MANUAL_LINKED',
                review_decision: 'LINK_EXISTING',
                review_note: reason || '',
                reviewed_at: new Date().toISOString(),
                review_candidate_reference: null,
                review_candidate_key: null,
                review_similarity: null,
                review_reason: null,
            }, current);
        } else {
            await this.updateLog(item, {
                association_status: 'MANUAL_REJECTED',
                review_decision: 'REJECT_CANDIDATE',
                review_note: reason,
                reviewed_at: new Date().toISOString(),
            }, current);
        }
    }

    describeConnectionError(error) {
        const message = error?.message || '未知錯誤';
        if (/Failed to fetch|CORS|TLS|憑證|NetworkError/i.test(message)) {
            return `${message}；瀏覽器直連需要 OpenSearch 允許此 GitHub Pages origin 的 CORS，且 TLS 憑證必須被瀏覽器信任。`;
        }
        return message;
    }

    getVisibleItems() {
        const search = document.getElementById('search-input').value.trim().toLowerCase();
        const site = document.getElementById('site-filter').value;
        const sort = document.getElementById('sort-filter').value;
        return this.items.filter((item) => {
            if (site && item.site !== site) return false;
            if (!search) return true;
            return [item.error_message, item.message_id, item.review_candidate_key, item.log_group, item.error_type]
                .filter(Boolean).join(' ').toLowerCase().includes(search);
        }).sort((a, b) => {
            if (sort === 'latest') return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
            if (sort === 'count') return (b.count || 0) - (a.count || 0);
            return (a.review_similarity ?? 1) - (b.review_similarity ?? 1);
        });
    }

    render() {
        const visible = this.getVisibleItems();
        this.visibleItems = visible;
        const grouped = document.getElementById('group-candidates').checked;
        if (!visible.length) {
            this.setList('<div class="empty-state">目前沒有符合條件的待審核項目。</div>');
            this.updateSelectionUI([]);
            return;
        }
        const content = grouped ? this.renderGrouped(visible) : visible.map((item) => this.renderCard(item)).join('');
        this.setList(content);
        this.updateSelectionUI(visible);
    }

    renderCandidateDetails(candidate) {
        return `<div class="candidate-details"><div class="candidate-detail-header"><h3>系統候選根因</h3><span>${this.escape(candidate.status || 'Jira embedding')}</span></div><div class="candidate-detail-grid"><div><h4>Summary</h4><p>${this.escape(candidate.summary || '未提供')}</p><h4>Error message</h4><p>${this.escape(candidate.error_message || '未提供')}</p><h4>Error type</h4><p>${this.escape(candidate.error_type || '未提供')}</p></div><div><h4>Traceback</h4><pre>${this.escape(candidate.traceback || candidate.description || '未提供')}</pre></div></div></div>`;
    }

    formatSimilarity(items) {
        const values = items.map((item) => Number(item.review_similarity)).filter(Number.isFinite);
        return values.length ? `${(Math.max(...values) * 100).toFixed(2)}%` : '未提供';
    }

    renderGrouped(items) {
        const groups = new Map();
        items.forEach((item) => {
            // UNASSOCIATED-queue items have no review_candidate_* fields (see
            // attachCandidateDetails); group by the resolved candidate loaded
            // from jira_reference so they don't all collapse into one
            // "未指定候選" bucket.
            const key = item.review_candidate_key || item.review_candidate_reference
                || (item.candidate && (item.candidate.key || item.candidate.document_id))
                || item.jira_reference || '未指定候選';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        });
        this.clusterGroups = new Map();
        return [...groups.entries()].map(([candidateKey, group]) => {
            const candidate = group[0].candidate || {};
            const content = document.getElementById('cluster-candidates').checked
                ? this.renderCandidateClusters(candidateKey, group)
                : `${this.renderCandidateDetails(candidate)}<div class="candidate-logs">${group.map((item) => this.renderCard(item)).join('')}</div>`;
            return `<section class="candidate-group"><div class="group-heading"><div><strong>候選 ${this.escape(candidate.key || candidateKey || '未指定')}</strong><span class="candidate-group-count">${group.length} 筆 error logs</span></div><span class="badge badge-similarity">相似度最高 ${this.formatSimilarity(group)}</span></div>${content}</section>`;
        }).join('');
    }

    renderCandidateClusters(candidateKey, items) {
        const clusters = [];
        items.forEach((item) => {
            const match = clusters.find((cluster) => this.clusterSimilarity(item, cluster.representative) >= CLUSTER_TOKEN_SIMILARITY);
            if (match) match.members.push(item);
            else clusters.push({ representative: item, members: [item] });
        });
        return clusters.map((cluster, index) => {
            const members = cluster.members;
            const clusterKey = this.clusterKey(cluster.representative);
            const clusterId = `cluster-${this.slug(clusterKey)}-${index}`;
            this.clusterGroups.set(clusterId, members);
            const representative = cluster.representative;
            const detailId = `${clusterId}-details`;
            const totalCount = members.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
            const selectedCount = members.filter((item) => this.selected.has(item.id)).length;
            const mode = document.getElementById('review-mode').value;
            const clusterAction = mode === 'UNASSOCIATED';
            const clusterActionButton = clusterAction ? `<button class="btn btn-primary cluster-link-existing-btn" type="button" data-review-action="link-existing" data-cluster-id="${this.escape(clusterId)}">連結既有 Jira</button><button class="btn btn-warning cluster-needs-jira-btn" type="button" data-review-action="mark-new-jira" data-cluster-id="${this.escape(clusterId)}">標記需建立新 Jira</button>` : `<button class="btn btn-success cluster-approve-btn" type="button" data-review-action="approve" data-cluster-id="${this.escape(clusterId)}">核准 cluster</button>`;
            const clusterRejectButton = clusterAction ? '' : `<button class="btn btn-danger cluster-reject-btn" type="button" data-review-action="reject" data-cluster-id="${this.escape(clusterId)}">拒絕 cluster</button>`;
            return `<article class="review-cluster"><div class="cluster-summary"><label class="checkbox-field"><input type="checkbox" data-cluster-id="${this.escape(clusterId)}" ${selectedCount === members.length ? 'checked' : ''}><span>選取 cluster</span></label><div class="cluster-main"><strong>Cluster ${index + 1}</strong><span>${members.length} 筆 logs｜總發生次數 ${totalCount}</span><small>${this.escape(this.clusterLabel(representative))}</small></div><div class="cluster-actions"><button class="btn btn-ghost cluster-toggle" type="button" data-target="${this.escape(detailId)}" data-cluster-id="${this.escape(clusterId)}">展開 cluster logs</button>${clusterRejectButton}${clusterActionButton}</div></div><div id="${this.escape(detailId)}" class="cluster-details hidden"></div></article>`;
        }).join('');
    }

    clusterKey(item) {
        return `${this.normalizeClusterText(item.error_type)}|${this.normalizeClusterText(item.error_message)}`;
    }

    normalizeClusterText(value) {
        return String(value || '').toLowerCase()
            .replace(/[0-9a-f]{8,}/g, '<id>')
            .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
            .replace(/["'`]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    clusterTokens(item) {
        const text = `${this.normalizeClusterText(item.error_type)} ${this.normalizeClusterText(item.error_message)} ${this.normalizeClusterText(item.traceback)}`;
        return new Set(text.split(/[^a-z0-9_<>]+/).filter((token) => token.length > 1));
    }

    clusterSimilarity(left, right) {
        const leftTokens = this.clusterTokens(left);
        const rightTokens = this.clusterTokens(right);
        if (!leftTokens.size || !rightTokens.size) return 0;
        const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
        const union = new Set([...leftTokens, ...rightTokens]).size;
        return union ? intersection / union : 0;
    }

    clusterLabel(item) { return `${item.error_type || 'Unknown'}：${item.error_message || '未提供 error message'}`; }
    slug(value) { return String(value).replace(/[^a-z0-9]+/gi, '-').slice(0, 32) || 'cluster'; }

    renderCard(item) {
        const mode = document.getElementById('review-mode').value;
        const isUnassociated = mode === 'UNASSOCIATED';
        const isNewJiraQueue = mode === 'MANUAL_NEEDS_NEW_JIRA';
        const selected = this.selected.has(item.id);
        const site = (item.site || 'unknown').toLowerCase();
        const similarity = Number.isFinite(Number(item.review_similarity)) ? `${(Number(item.review_similarity) * 100).toFixed(2)}%` : '未提供';
        const actionMarkup = isNewJiraQueue
            ? '<span class="queue-state">已標記待建立新 Jira</span>'
            : isUnassociated
                ? `<button class="btn btn-primary link-existing-btn" type="button" data-review-action="link-existing" data-action-id="${this.escape(item.id)}">連結既有 Jira</button><button class="btn btn-warning needs-jira-btn" type="button" data-review-action="mark-new-jira" data-action-id="${this.escape(item.id)}">標記需建立新 Jira</button>`
                : `<button class="btn btn-danger reject-btn" type="button" data-review-action="reject" data-action-id="${this.escape(item.id)}">拒絕候選</button><button class="btn btn-success approve-btn" type="button" data-review-action="approve" data-action-id="${this.escape(item.id)}">核准關聯</button>`;
        return `
            <article class="review-card ${selected ? 'is-selected' : ''}" data-id="${this.escape(item.id)}">
                <div class="card-top">
                    <div class="card-title">
                        <input class="card-check" type="checkbox" data-select-id="${this.escape(item.id)}" ${selected ? 'checked' : ''} aria-label="選取此 log">
                        <div><h2>${this.escape(item.review_candidate_key || (item.candidate && (item.candidate.key || item.candidate.document_id)) || '未指定候選')}</h2><p>${this.escape(item.message_id || item.id || '')}</p></div>
                    </div>
                    <div><span class="badge badge-${this.escape(site)}">${this.escape(site.toUpperCase())}</span> <span class="badge badge-similarity">相似度 ${similarity}</span></div>
                </div>
                <div class="card-grid">
                    <div class="detail-block">
                        <h3>Error message</h3><p class="error-message">${this.escape(item.error_message || '—')}</p>
                        <h3>Traceback</h3><div class="traceback">${this.escape(item.traceback || '未提供')}</div>
                    </div>
                    <div class="detail-block">
                        <div class="meta-grid">
                            ${this.meta('發生次數', item.count ?? '—')}
                            ${this.meta('發生時間', this.formatDate(item.timestamp))}
                            ${this.meta('服務 / Log group', item.log_group || item.service || '—')}
                            ${this.meta('錯誤類型', item.error_type || '—')}
                        </div>
                        <div class="candidate-box"><h3>系統候選：${this.escape((item.candidate && item.candidate.key) || item.review_candidate_key || '未指定')}</h3><p class="candidate-summary">${this.escape((item.candidate && item.candidate.summary) || '未提供候選摘要')}</p><p class="candidate-error"><strong>Error message：</strong>${this.escape((item.candidate && item.candidate.error_message) || '未提供')}</p><p class="candidate-error"><strong>Error type：</strong>${this.escape((item.candidate && item.candidate.error_type) || '未提供')}</p><details class="candidate-traceback"><summary>候選 Traceback</summary><pre>${this.escape((item.candidate && (item.candidate.traceback || item.candidate.description)) || '未提供')}</pre></details><small>${this.escape(item.review_reason || '—')}</small></div>
                    </div>
                </div>
                <div class="card-actions">${actionMarkup}</div>
            </article>`;
    }

    meta(label, value) { return `<div class="meta-item"><span>${this.escape(label)}</span><strong>${this.escape(String(value))}</strong></div>`; }

    bindCardEvents() {
        // Card events are delegated from #review-list in bindEvents().
        // Kept as a no-op for compatibility with callers from older versions.
    }

    toggleAll(checked) {
        for (const item of this.visibleItems) {
            if (checked) this.selected.add(item.id);
            else this.selected.delete(item.id);
        }
        document.querySelectorAll('#review-list [data-cluster-id]').forEach((checkbox) => {
            checkbox.checked = checked;
        });
        document.querySelectorAll('#review-list [data-select-id]').forEach((checkbox) => {
            checkbox.checked = checked;
            checkbox.closest('.review-card')?.classList.toggle('is-selected', checked);
        });
        this.updateSelectionUI(this.visibleItems);
    }

    openBulkApprove() {
        if (!this.selected.size) return;
        const mode = document.getElementById('review-mode').value;
        this.openAction(mode === 'UNASSOCIATED' ? 'link-existing' : 'approve', [...this.selected]);
    }

    openAction(action, ids) {
        const idList = Array.isArray(ids) ? ids : [ids];
        const items = idList.map((id) => this.items.find((item) => item.id === id)).filter(Boolean);
        if (!items.length) return;
        this.pendingAction = { action, ids: idList };
        const candidateKeys = [...new Set(items.map((item) => item.review_candidate_key).filter(Boolean))];
        const mode = document.getElementById('review-mode').value;
        const isUnassociated = mode === 'UNASSOCIATED';
        const isLinkExisting = action === 'link-existing';
        const actionButton = isLinkExisting ? '確認連結既有 Jira' : action === 'approve' ? '確認直接更新' : isUnassociated ? '標記需建立新 Jira' : '確認直接拒絕';
        const actionText = isLinkExisting ? '可從下方建議候選人選擇，或自行輸入既有 Jira key；也可改為標記需建立新 Jira。' : action === 'approve' ? '核准會直接更新 OpenSearch 中的 error log。' : isUnassociated ? '此操作只會標記為 MANUAL_NEEDS_NEW_JIRA，不會建立 Jira 或 embedding。' : '拒絕會直接更新 OpenSearch 為人工拒絕，不會建立 Jira。';
        document.getElementById('modal-title').textContent = isLinkExisting ? '連結既有 Jira' : action === 'approve' ? '核准候選關聯' : isUnassociated ? '標記需建立新 Jira' : '拒絕候選關聯';
        document.getElementById('modal-eyebrow').textContent = `${items.length} 筆待審核 logs`;
        document.getElementById('modal-review-summary').innerHTML = `<p>${isLinkExisting ? '既有 Jira：可選擇下方建議或自行輸入' : `候選 Jira：<strong>${this.escape(candidateKeys.join(', ') || '未指定')}</strong>`}</p><p>選取 ${items.length} 筆 log。${actionText}</p>`;
        document.getElementById('existing-jira-field').classList.toggle('hidden', !isLinkExisting);
        document.getElementById('existing-jira-key').value = '';
        document.getElementById('create-new-jira-field').classList.toggle('hidden', !isLinkExisting);
        document.getElementById('create-new-jira-checkbox').checked = false;
        document.getElementById('knn-suggestions-field').classList.toggle('hidden', !isLinkExisting);
        document.getElementById('knn-suggestions-list').innerHTML = '';
        document.getElementById('review-reason').value = '';
        document.getElementById('reason-hint').textContent = action === 'reject' && !isUnassociated ? '（必填）' : '（選填）';
        document.getElementById('modal-warning').textContent = isLinkExisting ? '只會連結已存在的 Jira，不會建立新 Jira；site 與 log group 不一致時會拒絕更新。「標記需建立新 Jira」只會設定候選文件為待建立，實際建立 Jira 需要後端手動執行任務。' : action === 'approve' ? '請確認候選 issue 與環境、服務及根因一致。此操作會直接修改 OpenSearch。' : isUnassociated ? '請確認這些 logs 確實需要後續建立新 Jira；目前只會標記，不會自動建單。' : '拒絕會直接寫入 MANUAL_REJECTED，不會建立新 Jira；請在備註記錄原因。';
        document.getElementById('modal-confirm').textContent = actionButton;
        document.getElementById('review-modal').classList.remove('hidden');
        if (isLinkExisting) this.loadKnnSuggestions(items);
    }

    async loadKnnSuggestions(items) {
        const listEl = document.getElementById('knn-suggestions-list');
        const records = Array.isArray(items) ? items : [items];
        const candidateSources = new Map();
        records.forEach((item) => {
            const candidate = item.candidate || {};
            if (!Array.isArray(candidate.embedding) || !candidate.embedding.length) return;
            const sourceId = candidate.document_id || candidate.key || `${item.site}:${candidate.log_group || item.log_group}`;
            if (!candidateSources.has(sourceId)) candidateSources.set(sourceId, { item, candidate });
        });
        if (!candidateSources.size) {
            listEl.innerHTML = '<p class="knn-suggestions-empty">此 cluster 沒有可用於相似度搜尋的候選向量，請自行輸入 Jira key 或標記需建立新 Jira。</p>';
            return;
        }
        listEl.innerHTML = '<p class="knn-suggestions-empty">正在搜尋此 cluster 最接近的既有 Jira...</p>';
        const resultSets = await Promise.all([...candidateSources.values()].map(({ item, candidate }) => (
            this.findSimilarKeyedCandidates(
                candidate.embedding,
                item.site,
                candidate.log_group || item.log_group,
                3,
                candidate.document_id,
            )
        )));
        if (!this.pendingAction || document.getElementById('review-modal').classList.contains('hidden')) return;

        const byKey = new Map();
        resultSets.flat().forEach((suggestion) => {
            if (!suggestion.key) return;
            const previous = byKey.get(suggestion.key);
            if (!previous || Number(suggestion.score) > Number(previous.score)) {
                byKey.set(suggestion.key, suggestion);
            }
        });
        const suggestions = [...byKey.values()]
            .sort((left, right) => Number(right.score) - Number(left.score))
            .slice(0, 3);
        if (!suggestions.length) {
            listEl.innerHTML = '<p class="knn-suggestions-empty">找不到此 cluster 相似的既有 Jira，請自行輸入 Jira key 或標記需建立新 Jira。</p>';
            return;
        }
        listEl.innerHTML = suggestions.map((suggestion) => {
            const similarity = Number.isFinite(suggestion.score) ? `${((suggestion.score - 1) * 100).toFixed(2)}%` : '未知';
            return `<label class="knn-suggestion"><input type="radio" name="knn-suggestion" value="${this.escape(suggestion.key)}"><span class="knn-suggestion-body"><span class="knn-suggestion-title">${this.escape(suggestion.key)}</span><span class="knn-suggestion-meta">相似度 ${similarity} ｜ ${this.escape(suggestion.error_type || '')}</span><span class="knn-suggestion-summary">${this.escape(suggestion.summary || suggestion.error_message || '')}</span></span></label>`;
        }).join('');
        listEl.querySelectorAll('input[name="knn-suggestion"]').forEach((radio) => {
            radio.addEventListener('change', () => {
                document.getElementById('existing-jira-key').value = radio.value;
                document.getElementById('create-new-jira-checkbox').checked = false;
            });
        });
    }

    closeModal() { this.pendingAction = null; document.getElementById('review-modal').classList.add('hidden'); }

    async confirmAction() {
        if (!this.pendingAction) return;
        const { action, ids } = this.pendingAction;
        const reason = document.getElementById('review-reason').value.trim();
        const existingJiraKey = document.getElementById('existing-jira-key').value.trim();
        const createNewJira = action === 'link-existing' && document.getElementById('create-new-jira-checkbox').checked;
        if (action === 'link-existing' && !createNewJira && !existingJiraKey) {
            this.showToast('請選擇建議候選人、自行輸入既有 Jira key，或勾選標記需建立新 Jira。', 'error');
            return;
        }
        if (action === 'reject' && !reason && document.getElementById('review-mode').value !== 'UNASSOCIATED') {
            this.showToast('拒絕候選時必須填寫審核備註。', 'error');
            return;
        }
        const records = ids.map((id) => this.items.find((item) => item.id === id)).filter(Boolean);
        if (this.demoMode) {
            this.items = this.items.filter((item) => !ids.includes(item.id));
            this.closeModal(); this.render(); this.updateSummary();
            this.showToast(`Demo：已模擬${action === 'approve' ? '核准' : '拒絕'} ${records.length} 筆。`, 'success');
            return;
        }
        const button = document.getElementById('modal-confirm');
        button.disabled = true;
        let updated = 0;
        const failures = [];
        try {
            for (const item of records) {
                try {
                    await this.applyDecision(item, action, reason, existingJiraKey, createNewJira);
                    updated += 1;
                } catch (error) {
                    failures.push(`${item.message_id || item.id}: ${error.message}`);
                }
            }
            this.closeModal();
            await this.load();
            if (failures.length) {
                this.showToast(`已更新 ${updated} 筆；${failures.length} 筆失敗，請查看錯誤並重新整理。`, 'error');
                console.error('Review update failures:', failures);
            } else {
                const actionLabel = createNewJira ? '標記需建立新 Jira' : action === 'link-existing' ? '連結既有 Jira' : action === 'approve' ? '核准' : '拒絕';
                this.showToast(`已直接${actionLabel} ${updated} 筆 OpenSearch error log。`, 'success');
            }
        } finally {
            button.disabled = false;
        }
    }

    updateSummary() {
        const count = this.items.length;
        document.getElementById('pending-count').textContent = count;
        document.getElementById('prod-count').textContent = this.items.filter((item) => item.site === 'prod').length;
        document.getElementById('stage-count').textContent = this.items.filter((item) => item.site === 'stage').length;
        document.getElementById('candidate-count').textContent = new Set(this.items.map((item) => item.review_candidate_key || item.review_candidate_reference).filter(Boolean)).size;
    }

    updateSelectionUI(visible) {
        const selectedVisible = visible.filter((item) => this.selected.has(item.id)).length;
        document.getElementById('selection-count').textContent = selectedVisible ? `已選取 ${selectedVisible} 筆` : '未選取項目';
        document.getElementById('bulk-approve-btn').disabled = selectedVisible === 0;
        document.getElementById('bulk-approve-btn').textContent = document.getElementById('review-mode').value === 'UNASSOCIATED' ? '連結選取項目到既有 Jira' : '核准選取項目';
        const selectAll = document.getElementById('select-all');
        selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
        selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    }

    setList(html) { document.getElementById('review-list').innerHTML = html; }
    formatDate(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-TW'); }
    escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
    showToast(message, type = '') { const toast = document.getElementById('toast'); toast.textContent = message; toast.className = `toast ${type}`; clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4500); }
}

document.addEventListener('DOMContentLoaded', () => { window.reviewPage = new ReviewPage(); });
