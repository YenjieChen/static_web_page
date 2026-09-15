/* Direct OpenSearch mode. Credentials stay in memory only and are sent to OpenSearch by the browser. */
const ERROR_INDEXES = 'error_log_dev_*,error_log_stage_*,error_log_prod_*';
const CANDIDATE_INDEX = 'jira_issue_embedding*';
const PENDING_STATUS = 'PENDING_REVIEW';

const demoItems = [
    {
        id: 'demo-stage-001', site: 'stage', message_id: 'demo-stage-001',
        error_message: 'ERROR: relation "OBJECT_TRACE_13792_2026_8_17" does not exist at character 8',
        traceback: 'psycopg.errors.UndefinedTable: relation does not exist\n  File "app/query.py", line 88, in execute',
        error_type: 'UndefinedTable', log_group: '/aws/rds/cluster/example/postgresql', count: 7,
        timestamp: '2026-09-14T01:00:00Z', review_candidate_key: 'VEL-2146',
        review_candidate_reference: 'demo-embedding-vel-2146', review_similarity: 0.8234,
        review_reason: 'SIMILARITY_IN_GREY_ZONE', index_name: 'error_log_stage_2026_9',
    },
    {
        id: 'demo-prod-002', site: 'prod', message_id: 'demo-prod-002',
        error_message: 'Connection pool exhausted while connecting to PostgreSQL',
        traceback: 'TimeoutError: connection pool exhausted\n  File "db/pool.py", line 142, acquire',
        error_type: 'TimeoutError', log_group: '/ecs/example-api', count: 3,
        timestamp: '2026-09-14T02:15:00Z', review_candidate_key: 'VEL-2033',
        review_candidate_reference: 'demo-embedding-vel-2033', review_similarity: 0.8071,
        review_reason: 'SIMILARITY_IN_GREY_ZONE', index_name: 'error_log_prod_2026_9',
    },
];

class ReviewPage {
    constructor() {
        this.items = [];
        this.selected = new Set();
        this.pendingAction = null;
        this.connection = null;
        this.demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
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
        document.getElementById('search-input').addEventListener('input', () => this.render());
        document.getElementById('site-filter').addEventListener('change', () => this.render());
        document.getElementById('sort-filter').addEventListener('change', () => this.render());
        document.getElementById('group-candidates').addEventListener('change', () => this.render());
        document.getElementById('select-all').addEventListener('change', (event) => this.toggleAll(event.target.checked));
        document.getElementById('bulk-approve-btn').addEventListener('click', () => this.openBulkApprove());
        document.getElementById('modal-close').addEventListener('click', () => this.closeModal());
        document.getElementById('modal-cancel').addEventListener('click', () => this.closeModal());
        document.getElementById('modal-confirm').addEventListener('click', () => this.confirmAction());
        document.getElementById('review-modal').addEventListener('click', (event) => {
            if (event.target.id === 'review-modal') this.closeModal();
        });
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
        this.setList('<div class="loading-state">正在直接查詢 OpenSearch 的待審核資料...</div>');
        try {
            this.items = await this.fetchPendingItems();
            this.selected.clear();
            this.render();
            this.updateSummary();
            this.setConnectedState(`已查詢 ${this.items.length} 筆 PENDING_REVIEW`, 'success');
        } catch (error) {
            console.error('OpenSearch request failed:', error);
            this.setList(`<div class="error-state">${this.escape(this.describeConnectionError(error))}</div>`);
            this.updateSummary();
            this.setConnectedState('查詢失敗', 'error');
        }
    }

    async fetchPendingItems() {
        const site = document.getElementById('site-filter').value;
        const indexes = site ? `error_log_${site}_*` : ERROR_INDEXES;
        const body = {
            size: 1000,
            sort: [{ timestamp: { order: 'desc' } }],
            query: {
                bool: {
                    filter: [{
                        bool: {
                            should: [
                                { term: { 'association_status.keyword': PENDING_STATUS } },
                                { term: { association_status: PENDING_STATUS } },
                            ],
                            minimum_should_match: 1,
                        },
                    }],
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
        this.setConnectedState('正在直接查詢 OpenSearch...', 'pending');
        document.getElementById('connection-details').textContent = `Host：${parsed.host}｜帳號：已輸入｜密碼：已輸入（不顯示）｜credentials 僅存在本頁記憶體`;
        await this.load();
    }

    clearConnectionSettings() {
        this.connection = null;
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

    async assertCandidateExists(candidateReference) {
        if (!candidateReference) throw new Error('此項目沒有候選 embedding reference，不能核准。');
        const body = { size: 1, query: { ids: { values: [candidateReference] } } };
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, { method: 'POST', body: JSON.stringify(body) });
        if (!payload.hits?.hits?.length) throw new Error('找不到候選 Jira embedding document，不能核准。');
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

    async applyDecision(item, action, reason) {
        const current = await this.getCurrentLog(item);
        const source = current.source;
        if (source.association_status !== PENDING_STATUS) {
            throw new Error(`資料狀態已變更為 ${source.association_status || '未設定'}，請重新整理。`);
        }
        if (source.review_candidate_reference !== item.review_candidate_reference) {
            throw new Error('候選 reference 已變更，請重新整理後再審核。');
        }
        if (action === 'approve') {
            await this.assertCandidateExists(source.review_candidate_reference);
            await this.updateLog(item, {
                jira_reference: source.review_candidate_reference,
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
        const grouped = document.getElementById('group-candidates').checked;
        if (!visible.length) {
            this.setList('<div class="empty-state">目前沒有符合條件的待審核項目。</div>');
            this.updateSelectionUI([]);
            return;
        }
        const content = grouped ? this.renderGrouped(visible) : visible.map((item) => this.renderCard(item)).join('');
        this.setList(content);
        this.bindCardEvents();
        this.updateSelectionUI(visible);
    }

    renderGrouped(items) {
        const groups = new Map();
        items.forEach((item) => {
            const key = item.review_candidate_key || item.review_candidate_reference || '未指定候選';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        });
        return [...groups.values()].map((group) => {
            const header = `<div class="group-heading"><strong>候選 ${this.escape(group[0].review_candidate_key || group[0].review_candidate_reference || '未指定')}</strong><span>${group.length} 筆 logs</span></div>`;
            return `${header}${group.map((item) => this.renderCard(item)).join('')}`;
        }).join('');
    }

    renderCard(item) {
        const selected = this.selected.has(item.id);
        const site = (item.site || 'unknown').toLowerCase();
        const similarity = Number.isFinite(Number(item.review_similarity)) ? `${(Number(item.review_similarity) * 100).toFixed(2)}%` : '未提供';
        return `
            <article class="review-card ${selected ? 'is-selected' : ''}" data-id="${this.escape(item.id)}">
                <div class="card-top">
                    <div class="card-title">
                        <input class="card-check" type="checkbox" data-select-id="${this.escape(item.id)}" ${selected ? 'checked' : ''} aria-label="選取此 log">
                        <div><h2>${this.escape(item.review_candidate_key || '未指定候選')}</h2><p>${this.escape(item.message_id || item.id || '')}</p></div>
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
                        <div class="candidate-box"><h3>系統候選</h3><div class="candidate-key">${this.escape(item.review_candidate_key || '未指定')}</div><small>${this.escape(item.review_reason || '—')}</small></div>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="btn btn-danger reject-btn" type="button" data-action-id="${this.escape(item.id)}">拒絕候選</button>
                    <button class="btn btn-success approve-btn" type="button" data-action-id="${this.escape(item.id)}">核准關聯</button>
                </div>
            </article>`;
    }

    meta(label, value) { return `<div class="meta-item"><span>${this.escape(label)}</span><strong>${this.escape(String(value))}</strong></div>`; }

    bindCardEvents() {
        document.querySelectorAll('[data-select-id]').forEach((checkbox) => checkbox.addEventListener('change', (event) => {
            const id = event.target.dataset.selectId;
            if (event.target.checked) this.selected.add(id); else this.selected.delete(id);
            this.render();
        }));
        document.querySelectorAll('.approve-btn').forEach((button) => button.addEventListener('click', () => this.openAction('approve', button.dataset.actionId)));
        document.querySelectorAll('.reject-btn').forEach((button) => button.addEventListener('click', () => this.openAction('reject', button.dataset.actionId)));
    }

    toggleAll(checked) {
        this.getVisibleItems().forEach((item) => checked ? this.selected.add(item.id) : this.selected.delete(item.id));
        this.render();
    }

    openBulkApprove() {
        if (!this.selected.size) return;
        this.openAction('approve', [...this.selected]);
    }

    openAction(action, ids) {
        const idList = Array.isArray(ids) ? ids : [ids];
        const items = idList.map((id) => this.items.find((item) => item.id === id)).filter(Boolean);
        if (!items.length) return;
        this.pendingAction = { action, ids: idList };
        const candidateKeys = [...new Set(items.map((item) => item.review_candidate_key).filter(Boolean))];
        document.getElementById('modal-title').textContent = action === 'approve' ? '核准候選關聯' : '拒絕候選關聯';
        document.getElementById('modal-eyebrow').textContent = `${items.length} 筆待審核 logs`;
        document.getElementById('modal-review-summary').innerHTML = `<p>候選 Jira：<strong>${this.escape(candidateKeys.join(', ') || '未指定')}</strong></p><p>選取 ${items.length} 筆 log。${action === 'approve' ? '核准會直接更新 OpenSearch 中的 error log。' : '拒絕會直接更新 OpenSearch 為人工拒絕，不會建立 Jira。'}</p>`;
        document.getElementById('review-reason').value = '';
        document.getElementById('reason-hint').textContent = action === 'reject' ? '（必填）' : '（選填）';
        document.getElementById('modal-warning').textContent = action === 'approve' ? '請確認候選 issue 與環境、服務及根因一致。此操作會直接修改 OpenSearch。' : '拒絕會直接寫入 MANUAL_REJECTED，不會建立新 Jira；請在備註記錄原因。';
        document.getElementById('modal-confirm').textContent = action === 'approve' ? '確認直接更新' : '確認直接拒絕';
        document.getElementById('review-modal').classList.remove('hidden');
    }

    closeModal() { this.pendingAction = null; document.getElementById('review-modal').classList.add('hidden'); }

    async confirmAction() {
        if (!this.pendingAction) return;
        const { action, ids } = this.pendingAction;
        const reason = document.getElementById('review-reason').value.trim();
        if (action === 'reject' && !reason) {
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
                    await this.applyDecision(item, action, reason);
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
                this.showToast(`已直接${action === 'approve' ? '核准' : '拒絕'} ${updated} 筆 OpenSearch error log。`, 'success');
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
