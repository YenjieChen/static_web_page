/* Direct browser mode. OpenSearch credentials follow the existing page behavior. Jira credentials are
 * deliberately memory-only and are used only for explicit deletion of keyed source issues.
 *
 * Merge flow:
 *   1. Look up the target embedding document.
 *   2. Search similar candidates in the same site + log_group.
 *   3. Re-read each candidate immediately before mutation.
 *   4. For keyed candidates, verify source and target Jira issues, then move OpenSearch references,
 *      delete the source Jira issue, verify it is absent, and finally delete the source embedding.
 *   5. For no-key candidates, move references and delete only the orphan embedding.
 *
 * Jira token is never written to localStorage/sessionStorage, URL, console, or result markup.
 */
const CANDIDATE_INDEX = 'jira_issue_embedding_titan_v2';
const ERROR_INDEXES = 'error_log_dev_*,error_log_stage_*,error_log_prod_*';
const CONNECTION_STORAGE_KEYS = {
    url: 'errorLogReview.opensearchUrl',
    username: 'errorLogReview.opensearchUsername',
    password: 'errorLogReview.opensearchPassword',
};
const CANDIDATE_POOL_SIZE = 100;
const SUGGESTION_LIMIT = 30;
const JIRA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

class MergePage {
    constructor() {
        this.connection = null;
        this.jiraConnection = null;
        this.target = null;
        this.candidates = [];
        this.pendingSubmit = null;
        this.restoreConnectionFields();
        this.bindEvents();
    }

    bindEvents() {
        document.getElementById('connection-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.applyConnectionSettings();
        });
        document.getElementById('clear-connection-btn').addEventListener('click', () => this.clearConnectionSettings());
        document.getElementById('jira-connection-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.applyJiraConnectionSettings();
        });
        document.getElementById('jira-clear-btn').addEventListener('click', () => this.clearJiraConnectionSettings());
        document.getElementById('target-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.searchSimilarCandidates();
        });
        document.getElementById('candidate-list').addEventListener('change', (event) => {
            if (event.target.matches('[data-candidate-checkbox]')) this.updateSubmitButtonState();
        });
        document.getElementById('manual-add-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.addManualCandidate();
        });
        document.getElementById('submit-merge-btn').addEventListener('click', () => this.openConfirmModal());
        document.getElementById('confirm-modal-close').addEventListener('click', () => this.closeConfirmModal());
        document.getElementById('confirm-modal-cancel').addEventListener('click', () => this.closeConfirmModal());
        document.getElementById('confirm-modal-confirm').addEventListener('click', () => this.submitMerge());
        document.getElementById('confirm-modal').addEventListener('click', (event) => {
            if (event.target.id === 'confirm-modal') this.closeConfirmModal();
        });
    }

    // --- Connection handling (mirrors review.js so credentials/UX stay consistent) ---

    restoreConnectionFields() {
        const url = this.readStorage(localStorage, CONNECTION_STORAGE_KEYS.url);
        const username = this.readStorage(localStorage, CONNECTION_STORAGE_KEYS.username);
        const password = this.readStorage(sessionStorage, CONNECTION_STORAGE_KEYS.password);
        document.getElementById('opensearch-url').value = url;
        document.getElementById('opensearch-username').value = username;
        document.getElementById('opensearch-password').value = password;
        if (url || username || password) {
            document.getElementById('connection-details').textContent = '已恢復上次輸入；請按「套用連線設定」重新建立本頁連線。';
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
        this.setConnectedState('連線設定已套用', 'success');
        document.getElementById('connection-details').textContent = `Host：${parsed.host}｜帳號：已輸入｜密碼：已輸入（本分頁保存）｜credentials 僅存在本頁記憶體`;
    }

    clearConnectionSettings() {
        this.connection = null;
        this.clearStoredConnectionFields();
        document.getElementById('opensearch-url').value = '';
        document.getElementById('opensearch-username').value = '';
        document.getElementById('opensearch-password').value = '';
        document.getElementById('connection-status').textContent = '尚未套用設定';
        document.getElementById('connection-status').className = 'connection-status';
        document.getElementById('connection-details').textContent = '尚未提供連線設定';
        this.resetSearchState();
        this.showToast('本頁記憶體中的 OpenSearch 連線設定已清除。', 'success');
    }

    async applyJiraConnectionSettings() {
        const url = document.getElementById('jira-url').value.trim().replace(/\/$/, '');
        const username = document.getElementById('jira-username').value.trim();
        const token = document.getElementById('jira-api-token').value;
        let parsed;
        try {
            parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
                throw new Error('invalid endpoint');
            }
        } catch {
            this.showToast('請輸入不含帳密、查詢參數或 hash 的 HTTPS Jira URL。', 'error');
            return;
        }
        if (!username || !token) {
            this.showToast('Jira 直接刪除需要帳號與 API token。', 'error');
            return;
        }
        this.jiraConnection = { url, username, authorization: `Basic ${this.toBasicAuth(username, token)}` };
        // Clear the token input immediately. The encoded authorization remains only in memory.
        document.getElementById('jira-api-token').value = '';
        document.getElementById('jira-connection-status').textContent = '已套用（記憶體）';
        document.getElementById('jira-connection-status').className = 'connection-status is-success';
        document.getElementById('jira-connection-details').textContent = `Host：${parsed.host}｜帳號：已輸入｜API token：只存在本頁記憶體，不會保存`;
        this.showToast('Jira 設定已套用；尚未執行任何刪除。', 'success');
    }

    clearJiraConnectionSettings() {
        this.jiraConnection = null;
        document.getElementById('jira-url').value = '';
        document.getElementById('jira-username').value = '';
        document.getElementById('jira-api-token').value = '';
        document.getElementById('jira-connection-status').textContent = '未設定';
        document.getElementById('jira-connection-status').className = 'connection-status';
        document.getElementById('jira-connection-details').textContent = '尚未提供 Jira credentials；沒有 Jira key 的候選不需要此設定。';
        this.showToast('Jira credentials 已從本頁記憶體清除。', 'success');
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

    async openSearchRequest(path, options = {}) {
        if (!this.connection) throw new Error('尚未設定 OpenSearch 連線');
        const headers = {
            Accept: 'application/json',
            Authorization: `Basic ${this.connection.authorization}`,
        };
        if (options.body) headers['Content-Type'] = 'application/json';
        let response;
        try {
            response = await fetch(`${this.connection.url}${path}`, { ...options, headers, credentials: 'omit' });
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

    async openJiraRequest(path, options = {}) {
        if (!this.jiraConnection) throw new Error('尚未設定 Jira credentials；請先套用 Jira 設定。');
        const headers = {
            Accept: 'application/json',
            Authorization: this.jiraConnection.authorization,
        };
        if (options.body) headers['Content-Type'] = 'application/json';
        let response;
        try {
            response = await fetch(`${this.jiraConnection.url}${path}`, { ...options, headers, credentials: 'omit' });
        } catch (error) {
            throw new Error(`無法連線 Jira。請檢查 Jira CORS、TLS 與網路設定（${error.message}）。`);
        }
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
        if (!response.ok) {
            const reason = payload.errorMessages?.join('; ') || payload.message || `HTTP ${response.status}`;
            throw new Error(`Jira ${response.status}: ${reason}`);
        }
        return { response, payload };
    }

    async verifyJiraIssue(key) {
        if (!JIRA_KEY_PATTERN.test(key)) throw new Error(`無效的 Jira key：${key}`);
        const { payload } = await this.openJiraRequest(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,project`, { method: 'GET' });
        const fields = payload.fields || {};
        return { key: payload.key || key, summary: fields.summary || '', status: fields.status?.name || '', project: fields.project?.key || '' };
    }

    async deleteAndVerifyJiraIssue(sourceKey, targetKey) {
        if (!this.jiraConnection) throw new Error(`候選 ${sourceKey} 有 Jira key，但尚未設定 Jira credentials。`);
        if (sourceKey === targetKey) throw new Error('source Jira 與 target Jira 不可相同。');
        await this.verifyJiraIssue(targetKey);
        await this.verifyJiraIssue(sourceKey);
        await this.openJiraRequest(`/rest/api/3/issue/${encodeURIComponent(sourceKey)}`, { method: 'DELETE' });
        try {
            await this.verifyJiraIssue(sourceKey);
        } catch (error) {
            if (/Jira 404/.test(error.message)) return { verified: true };
            throw new Error(`Jira source 已送出刪除，但無法確認是否刪除完成：${error.message}`);
        }
        throw new Error(`Jira source ${sourceKey} 刪除請求完成，但 issue 仍存在；已停止清理 OpenSearch embedding。`);
    }

    // --- Target lookup + similarity search ---

    resetSearchState() {
        this.target = null;
        this.candidates = [];
        document.getElementById('target-summary').classList.add('hidden');
        document.getElementById('candidate-section').classList.add('hidden');
        document.getElementById('merge-result').classList.add('hidden');
        document.getElementById('candidate-list').innerHTML = '';
        this.updateSubmitButtonState();
    }

    async searchSimilarCandidates() {
        if (!this.connection) {
            this.showToast('請先套用 OpenSearch 連線設定。', 'error');
            return;
        }
        const rawKey = document.getElementById('target-key').value.trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(rawKey)) {
            this.showToast('請輸入有效的 Jira key，例如 VEL-2148。', 'error');
            return;
        }
        this.resetSearchState();
        document.getElementById('target-summary').classList.remove('hidden');
        document.getElementById('target-summary').innerHTML = '<p class="loading-state">正在查詢目標 Jira issue...</p>';
        try {
            const target = await this.fetchTargetIssue(rawKey);
            this.target = target;
            this.renderTargetSummary(target);

            document.getElementById('candidate-section').classList.remove('hidden');
            document.getElementById('candidate-list').innerHTML = '<p class="loading-state">正在搜尋相似候選...</p>';
            const candidates = await this.fetchSimilarCandidates(target);
            this.candidates = candidates;
            await this.attachAffectedLogCounts(this.candidates);
            this.renderCandidateList();
        } catch (error) {
            console.error('Merge search failed:', error);
            document.getElementById('target-summary').innerHTML = `<div class="error-state">${this.escape(this.describeConnectionError(error))}</div>`;
            document.getElementById('candidate-section').classList.add('hidden');
        }
    }

    async fetchTargetIssue(key) {
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            body: JSON.stringify({
                size: 50,
                _source: ['key', 'summary', 'error_message', 'error_type', 'site', 'log_group', 'status', 'embedding'],
                query: {
                    bool: {
                        should: [{ term: { 'key.keyword': key } }, { term: { key } }],
                        minimum_should_match: 1,
                    },
                },
            }),
        });
        const hits = payload.hits?.hits || [];
        const hit = hits.length === 1 ? hits[0] : null;
        if (!hit) throw new Error(`找不到唯一 Jira ${key} 對應的 embedding document。`);
        const source = hit._source || {};
        if (!Array.isArray(source.embedding) || !source.embedding.length) {
            throw new Error(`Jira ${key} 對應的 embedding document 沒有向量資料，無法搜尋相似候選。`);
        }
        if (!source.site || !source.log_group) {
            throw new Error(`Jira ${key} 對應的 embedding document 缺少 site 或 log group，無法安全限定合併範圍。`);
        }
        return { ...source, document_id: hit._id, index: hit._index };
    }

    async fetchSimilarCandidates(target) {
        const body = {
            size: CANDIDATE_POOL_SIZE,
            _source: ['key', 'summary', 'error_message', 'error_type', 'traceback', 'site', 'log_group', 'status', 'jira_creation_status'],
            query: { knn: { embedding: { vector: target.embedding, k: CANDIDATE_POOL_SIZE } } },
            post_filter: {
                bool: {
                    must: [{ term: { site: target.site } }, { term: { log_group: target.log_group } }],
                    must_not: [{ term: { status: 'SUB ISSUES' } }],
                },
            },
        };
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        const hits = payload.hits?.hits || [];
        return hits
            .filter((hit) => hit._id !== target.document_id)
            .map((hit) => ({
                score: hit._score,
                similarity: Number.isFinite(hit._score) ? hit._score - 1 : null,
                ...(hit._source || {}),
                document_id: hit._id,
                index: hit._index,
            }))
            .slice(0, SUGGESTION_LIMIT);
    }

    async attachAffectedLogCounts(candidates) {
        await Promise.all(candidates.map(async (candidate) => {
            try {
                const payload = await this.openSearchRequest(`/${this.encodeIndex(ERROR_INDEXES)}/_search`, {
                    method: 'POST',
                    body: JSON.stringify({
                        size: 0,
                        query: { term: { 'jira_reference.keyword': candidate.document_id } },
                    }),
                });
                candidate.affectedLogCount = payload.hits?.total?.value ?? 0;
            } catch (error) {
                console.warn('Failed to count affected logs for candidate', candidate.document_id, error);
                candidate.affectedLogCount = null;
            }
        }));
    }

    // --- Manual candidate addition (for candidates the kNN search didn't surface,
    // e.g. different log_group naming for what is actually the same service) ---

    async addManualCandidate() {
        if (!this.target) {
            this.showToast('請先搜尋目標 Jira issue。', 'error');
            return;
        }
        const rawKey = document.getElementById('manual-add-key').value.trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(rawKey)) {
            this.showToast('請輸入有效的 Jira key，例如 VEL-1888。', 'error');
            return;
        }
        if (rawKey === this.target.key) {
            this.showToast('不能把目標 issue 自己加入候選清單。', 'error');
            return;
        }
        if (this.candidates.some((c) => c.key === rawKey)) {
            this.showToast(`${rawKey} 已經在候選清單中。`, 'error');
            return;
        }
        const addBtn = document.getElementById('manual-add-btn');
        addBtn.disabled = true;
        try {
            const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
                method: 'POST',
                body: JSON.stringify({
                    size: 1,
                    _source: ['key', 'summary', 'error_message', 'error_type', 'traceback', 'site', 'log_group', 'status'],
                    query: { bool: { should: [{ term: { 'key.keyword': rawKey } }, { term: { key: rawKey } }], minimum_should_match: 1 } },
                }),
            });
            const hit = payload.hits?.hits?.[0];
            if (!hit) {
                this.showToast(`找不到 Jira ${rawKey} 對應的 embedding document。`, 'error');
                return;
            }
            const candidate = {
                score: null,
                similarity: null,
                manuallyAdded: true,
                ...(hit._source || {}),
                document_id: hit._id,
                index: hit._index,
            };
            const siteMismatch = candidate.site && this.target.site && candidate.site !== this.target.site;
            const logGroupMismatch = candidate.log_group && this.target.log_group && candidate.log_group !== this.target.log_group;
            if (siteMismatch || logGroupMismatch) {
                candidate.manualMismatchWarning = [
                    siteMismatch ? `site 不同（候選：${candidate.site}，目標：${this.target.site}）` : null,
                    logGroupMismatch ? `log group 不同（候選：${candidate.log_group}，目標：${this.target.log_group}）` : null,
                ].filter(Boolean).join('；');
            }
            await this.attachAffectedLogCounts([candidate]);
            this.candidates = [candidate, ...this.candidates];
            this.renderCandidateList();
            document.getElementById('manual-add-key').value = '';
            this.showToast(`已加入 ${rawKey}，請確認 site/log group 後再勾選。`, 'success');
        } catch (error) {
            console.error('Failed to add manual candidate:', error);
            this.showToast(this.describeConnectionError(error), 'error');
        } finally {
            addBtn.disabled = false;
        }
    }

    // --- Rendering ---

    renderTargetSummary(target) {
        document.getElementById('target-summary').innerHTML = `
            <div class="target-summary-card">
                <div><strong>${this.escape(target.key)}</strong><span class="badge badge-${this.escape((target.site || 'unknown').toLowerCase())}">${this.escape((target.site || '').toUpperCase())}</span></div>
                <p>${this.escape(target.summary || '未提供 summary')}</p>
                <p class="target-summary-meta">Log group：${this.escape(target.log_group || '未提供')}　Status：${this.escape(target.status || '未提供')}</p>
            </div>`;
    }

    renderCandidateList() {
        const listEl = document.getElementById('candidate-list');
        const manualCount = this.candidates.filter((c) => c.manuallyAdded).length;
        const autoCount = this.candidates.length - manualCount;
        document.getElementById('candidate-count').textContent = `找到 ${autoCount} 筆相似候選（site + log group 與目標一致）${manualCount ? `，另手動加入 ${manualCount} 筆` : ''}`;
        if (!this.candidates.length) {
            listEl.innerHTML = '<p class="empty-state">沒有找到符合條件的相似候選。</p>';
            this.updateSubmitButtonState();
            return;
        }
        listEl.innerHTML = this.candidates.map((candidate, index) => {
            const hasKey = Boolean(candidate.key);
            const similarityText = Number.isFinite(candidate.similarity) ? `${(candidate.similarity * 100).toFixed(2)}%` : '手動加入';
            const countText = candidate.affectedLogCount === null ? '（查詢失敗）' : `${candidate.affectedLogCount} 筆`;
            const keyNote = hasKey
                ? `<span class="candidate-keyed-note">⚠ 已對應真實 Jira ${this.escape(candidate.key)}：若已設定 Jira credentials，提交時會先把 error log 指向目標，再刪除 Jira source issue，最後清理 embedding。若未設定 Jira credentials，系統會拒絕此候選，避免只刪除 OpenSearch 紀錄。</span>`
                : '';
            const mismatchNote = candidate.manualMismatchWarning
                ? `<span class="candidate-mismatch-note">⚠ 手動加入的候選與目標不完全一致：${this.escape(candidate.manualMismatchWarning)}。請確認這確實是同一個根因才合併。</span>`
                : '';
            return `
                <label class="candidate-merge-item">
                    <input type="checkbox" data-candidate-checkbox data-index="${index}">
                    <div class="candidate-merge-body">
                        <div class="candidate-merge-top">
                            <span class="badge badge-similarity">${candidate.manuallyAdded ? '手動加入' : `相似度 ${similarityText}`}</span>
                            <span class="candidate-merge-count">影響 error log：${countText}</span>
                            ${hasKey ? `<span class="badge badge-warning">key: ${this.escape(candidate.key)}</span>` : '<span class="badge badge-muted">無 key</span>'}
                        </div>
                        <p class="candidate-merge-summary">${this.escape(candidate.summary || candidate.error_message || '未提供 summary')}</p>
                        <p class="candidate-merge-meta">doc_id：${this.escape(candidate.document_id)}</p>
                        ${keyNote}
                        ${mismatchNote}
                    </div>
                </label>`;
        }).join('');
        this.updateSubmitButtonState();
    }

    updateSubmitButtonState() {
        const checked = this.getSelectedCandidates();
        document.getElementById('submit-merge-btn').disabled = checked.length === 0;
    }

    getSelectedCandidates() {
        const boxes = document.querySelectorAll('#candidate-list [data-candidate-checkbox]:checked');
        return [...boxes].map((box) => this.candidates[Number(box.dataset.index)]).filter(Boolean);
    }

    // --- Confirm + submit ---

    openConfirmModal() {
        const selected = this.getSelectedCandidates();
        if (!selected.length) return;
        const totalLogs = selected.reduce((sum, c) => sum + (c.affectedLogCount || 0), 0);
        const keyedSelected = selected.filter((c) => c.key);
        const reason = document.getElementById('merge-reason').value.trim();
        document.getElementById('confirm-modal-body').innerHTML = `
            <p>即將把 <strong>${selected.length}</strong> 個候選合併到 <strong>${this.escape(this.target.key)}</strong>：</p>
            <ul class="confirm-candidate-list">
                ${selected.map((c) => `<li>${this.escape(c.document_id)}${c.key ? ` (${this.escape(c.key)})` : ''}（${c.affectedLogCount ?? '?'} 筆 log）</li>`).join('')}
            </ul>
            <p>總計影響 <strong>${totalLogs}</strong> 筆 error log 的 jira_reference，並清理上述 ${selected.length} 個候選 embedding 文件。</p>
            ${keyedSelected.length ? `<p class="confirm-keyed-warning">⚠ 其中 ${keyedSelected.length} 個候選（${keyedSelected.map((c) => this.escape(c.key)).join(', ')}）會進一步呼叫 Jira DELETE，永久刪除 source issue。目標 ${this.escape(this.target.key)} 不會被刪除。${this.jiraConnection ? '' : '目前尚未設定 Jira credentials，因此這些 keyed candidate 會被拒絕。'}</p>` : ''}
            <p>合併理由：${this.escape(reason || '（尚未填寫；若沒有 keyed candidate 可留白）')}</p>`;
        document.getElementById('confirm-modal').classList.remove('hidden');
    }

    closeConfirmModal() {
        document.getElementById('confirm-modal').classList.add('hidden');
    }

    async submitMerge() {
        const selected = this.getSelectedCandidates();
        this.closeConfirmModal();
        if (!selected.length) return;
        const reason = document.getElementById('merge-reason').value.trim();
        if (selected.some((candidate) => candidate.key) && reason.length < 5) {
            this.showToast('選取了有 Jira key 的候選，請先填寫至少 5 個字元的合併理由。', 'error');
            return;
        }
        if (selected.some((candidate) => candidate.key) && !this.jiraConnection) {
            this.showToast('選取了有 Jira key 的候選，請先套用 Jira credentials。', 'error');
            return;
        }
        document.getElementById('submit-merge-btn').disabled = true;
        const resultEl = document.getElementById('merge-result');
        resultEl.classList.remove('hidden');
        resultEl.innerHTML = '<p class="loading-state">正在執行合併...</p>';

        const results = [];
        for (const candidate of selected) {
            try {
                const mergeResult = await this.mergeOneCandidate(candidate);
                results.push({ candidate, ok: true, ...mergeResult });
            } catch (error) {
                console.error('Failed to merge candidate', candidate.document_id, error);
                results.push({ candidate, ok: false, error: error.message });
            }
        }
        this.renderMergeResult(results);
        // Refresh candidate list/log counts so the UI reflects the new state
        // (merged/deleted candidates disappear, counts update for the rest).
        try {
            const candidates = await this.fetchSimilarCandidates(this.target);
            this.candidates = candidates;
            await this.attachAffectedLogCounts(this.candidates);
            this.renderCandidateList();
        } catch (error) {
            console.warn('Failed to refresh candidate list after merge:', error);
        }
    }

    async mergeOneCandidate(candidate) {
        if (candidate.document_id === this.target.document_id) {
            throw new Error('候選與目標 issue 是同一個文件，已跳過。');
        }
        if (candidate.key && candidate.key === this.target.key) {
            throw new Error('候選與目標 Jira key 相同，已拒絕刪除。');
        }
        // Re-read the candidate right before mutating it: the key/index shown in the UI
        // may be stale by the time the user confirms the merge.
        const fresh = await this.rereadCandidate(candidate.document_id);
        if (!fresh) throw new Error('候選文件已不存在，可能已被其他人處理，請重新整理。');
        if ((fresh.key || null) !== (candidate.key || null)) {
            throw new Error(`候選的 key 已變更為 ${fresh.key || '(null)'}（畫面顯示為 ${candidate.key || '(null)'}），請重新整理後再試。`);
        }
        if (fresh.index !== candidate.index) {
            throw new Error('候選所在索引與預期不符，已中止以避免誤刪。');
        }

        // Validate both Jira issues before changing OpenSearch. This avoids moving logs
        // when credentials, CORS, permissions, or either key is already invalid.
        if (candidate.key) {
            await this.verifyJiraIssue(this.target.key);
            await this.verifyJiraIssue(candidate.key);
        }

        const updateResult = await this.openSearchRequest(
            // refresh=true forces the affected shards to refresh before this call
            // returns, so the immediately-following verification search (and the
            // UI's log-count refresh) see the update instead of racing OpenSearch's
            // default ~1s refresh interval and finding stale "still referenced" hits.
            `/${this.encodeIndex(ERROR_INDEXES)}/_update_by_query?conflicts=proceed&refresh=true`,
            {
                method: 'POST',
                body: JSON.stringify({
                    query: { term: { 'jira_reference.keyword': candidate.document_id } },
                    script: {
                        lang: 'painless',
                        source: "ctx._source.jira_reference = params.target; ctx._source.association_status = 'MANUAL_MERGED';",
                        params: { target: this.target.document_id },
                    },
                }),
            },
        );
        const updatedCount = updateResult.updated ?? 0;

        // Confirm no error log still references the candidate before deleting it;
        // update_by_query can skip documents on version conflicts (conflicts=proceed).
        const remaining = await this.openSearchRequest(`/${this.encodeIndex(ERROR_INDEXES)}/_search`, {
            method: 'POST',
            body: JSON.stringify({ size: 0, query: { term: { 'jira_reference.keyword': candidate.document_id } } }),
        });
        if ((remaining.hits?.total?.value ?? 0) > 0) {
            throw new Error(`合併後仍有 ${remaining.hits.total.value} 筆 log 指向此候選（可能發生版本衝突），已停止刪除候選文件；請重新整理後再試一次。`);
        }

        // Jira deletion must succeed and be verified before the source embedding is removed.
        let jira = null;
        if (candidate.key) {
            jira = await this.deleteAndVerifyJiraIssue(candidate.key, this.target.key);
        }

        await this.openSearchRequest(
            `/${this.encodeIndex(fresh.index)}/_doc/${this.encodeId(candidate.document_id)}?if_seq_no=${encodeURIComponent(fresh.seqNo)}&if_primary_term=${encodeURIComponent(fresh.primaryTerm)}`,
            { method: 'DELETE' },
        );
        return { updated: updatedCount, jira };
    }

    async rereadCandidate(docId) {
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            body: JSON.stringify({
                size: 1,
                seq_no_primary_term: true,
                _source: ['key'],
                query: { ids: { values: [docId] } },
            }),
        });
        const hit = payload.hits?.hits?.[0];
        if (!hit) return null;
        return { key: hit._source?.key || null, index: hit._index, seqNo: hit._seq_no, primaryTerm: hit._primary_term };
    }

    renderMergeResult(results) {
        const resultEl = document.getElementById('merge-result');
        const okResults = results.filter((r) => r.ok);
        const failResults = results.filter((r) => !r.ok);
        const totalUpdated = okResults.reduce((sum, r) => sum + (r.updated || 0), 0);
        const mergedKeys = okResults.filter((r) => r.candidate.key).map((r) => r.candidate.key);
        const title = failResults.length ? '部分完成／有失敗' : '合併完成';
        resultEl.innerHTML = `
            <div class="merge-result-summary">
                <strong>${title}</strong>
                <p>成功合併 ${okResults.length} 個候選，共更新 ${totalUpdated} 筆 error log 並完成對應清理。${failResults.length ? `${failResults.length} 個候選失敗，請依錯誤處理。` : ''}</p>
            </div>
            ${okResults.length ? `<ul class="merge-result-list">${okResults.map((r) => `<li class="is-ok">✓ ${this.escape(r.candidate.document_id)}${r.candidate.key ? ` (${this.escape(r.candidate.key)})：Jira source 已驗證刪除` : ''}：更新 ${r.updated} 筆 log</li>`).join('')}</ul>` : ''}
            ${failResults.length ? `<ul class="merge-result-list">${failResults.map((r) => `<li class="is-fail">✗ ${this.escape(r.candidate.document_id)}：${this.escape(r.error)}</li>`).join('')}</ul>` : ''}
            ${mergedKeys.length ? `<p class="confirm-keyed-warning">已驗證刪除 Jira source：${mergedKeys.map((k) => this.escape(k)).join(', ')}；target ${this.escape(this.target.key)} 未被刪除。</p>` : ''}
        `;
        if (failResults.length) {
            this.showToast(`${failResults.length} 個候選合併失敗，請查看結果清單。`, 'error');
        } else {
            this.showToast('合併完成。', 'success');
        }
    }

    // --- Shared helpers ---

    describeConnectionError(error) {
        const message = error?.message || '未知錯誤';
        if (/Failed to fetch|CORS|TLS|憑證|NetworkError/i.test(message)) {
            return `${message}；瀏覽器直連需要 OpenSearch 允許此 GitHub Pages origin 的 CORS，且 TLS 憑證必須被瀏覽器信任。`;
        }
        return message;
    }

    showToast(message, type = '') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type ? `is-${type}` : ''}`;
        toast.classList.remove('hidden');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
    }

    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }
}

document.addEventListener('DOMContentLoaded', () => new MergePage());
