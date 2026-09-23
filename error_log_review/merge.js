/* Direct OpenSearch mode. Credentials stay in memory only and are sent to OpenSearch by the browser.
 *
 * Merges no-key Jira embedding candidates into a user-specified target Jira issue:
 *   1. Look up the target issue by key.
 *   2. kNN-search the 30 most similar candidates (restricted to the same site + log_group).
 *   3. Only candidates with no key can be selected (a keyed candidate is a real, already
 *      tracked Jira issue; merging it here would silently drop it from future kNN lookups
 *      without touching Jira itself, which is a much bigger, separate decision).
 *   4. On submit: for every selected candidate, repoint all error logs referencing it to the
 *      target issue's document id, then delete the now-orphaned candidate document.
 * No Jira Cloud API call is made anywhere in this flow.
 */
const CANDIDATE_INDEX = 'jira_issue_embedding*';
const ERROR_INDEXES = 'error_log_dev_*,error_log_stage_*,error_log_prod_*';
const CONNECTION_STORAGE_KEYS = {
    url: 'errorLogReview.opensearchUrl',
    username: 'errorLogReview.opensearchUsername',
    password: 'errorLogReview.opensearchPassword',
};
const CANDIDATE_POOL_SIZE = 100;
const SUGGESTION_LIMIT = 30;

class MergePage {
    constructor() {
        this.connection = null;
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
                size: 1,
                _source: ['key', 'summary', 'error_message', 'error_type', 'site', 'log_group', 'status', 'embedding'],
                query: {
                    bool: {
                        should: [{ term: { 'key.keyword': key } }, { term: { key } }],
                        minimum_should_match: 1,
                    },
                },
            }),
        });
        const hit = payload.hits?.hits?.[0];
        if (!hit) throw new Error(`找不到 Jira ${key} 對應的 embedding document。`);
        const source = hit._source || {};
        if (!Array.isArray(source.embedding) || !source.embedding.length) {
            throw new Error(`Jira ${key} 對應的 embedding document 沒有向量資料，無法搜尋相似候選。`);
        }
        if (!source.site || !source.log_group) {
            throw new Error(`Jira ${key} 對應的 embedding document 缺少 site 或 log group，無法安全限定合併範圍。`);
        }
        return { document_id: hit._id, index: hit._index, ...source };
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
                document_id: hit._id,
                index: hit._index,
                score: hit._score,
                similarity: Number.isFinite(hit._score) ? hit._score - 1 : null,
                ...(hit._source || {}),
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
                document_id: hit._id,
                index: hit._index,
                score: null,
                similarity: null,
                manuallyAdded: true,
                ...(hit._source || {}),
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
            // Merging a keyed candidate deletes its embedding document but does NOT
            // touch the real Jira issue on Jira Cloud (this tool never calls the Jira
            // API) — the issue itself will keep existing there with no new logs
            // pointing at it. That cleanup on the Jira side is the reviewer's
            // responsibility after merging; the note below exists to make that
            // explicit rather than silently deleting a still-tracked issue's record.
            const keyNote = hasKey
                ? `<span class="candidate-keyed-note">⚠ 已對應真實 Jira ${this.escape(candidate.key)}：合併只會刪除這裡的 embedding 紀錄並搬移 error log，不會呼叫 Jira API；${this.escape(candidate.key)} 在 Jira 平台上仍會保留，請合併後自行到 Jira 關閉或標記為 duplicate。</span>`
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
        document.getElementById('confirm-modal-body').innerHTML = `
            <p>即將把 <strong>${selected.length}</strong> 個候選合併到 <strong>${this.escape(this.target.key)}</strong>：</p>
            <ul class="confirm-candidate-list">
                ${selected.map((c) => `<li>${this.escape(c.document_id)}${c.key ? ` (${this.escape(c.key)})` : ''}（${c.affectedLogCount ?? '?'} 筆 log）</li>`).join('')}
            </ul>
            <p>總計影響 <strong>${totalLogs}</strong> 筆 error log 的 jira_reference，並刪除上述 ${selected.length} 個候選文件。</p>
            ${keyedSelected.length ? `<p class="confirm-keyed-warning">⚠ 其中 ${keyedSelected.length} 個候選已對應真實 Jira（${keyedSelected.map((c) => this.escape(c.key)).join(', ')}）。此工具不會呼叫 Jira API，這些 issue 在 Jira 平台上仍會保留，合併後請自行到 Jira 上關閉或標記為 duplicate。</p>` : ''}`;
        document.getElementById('confirm-modal').classList.remove('hidden');
    }

    closeConfirmModal() {
        document.getElementById('confirm-modal').classList.add('hidden');
    }

    async submitMerge() {
        const selected = this.getSelectedCandidates();
        this.closeConfirmModal();
        if (!selected.length) return;
        document.getElementById('submit-merge-btn').disabled = true;
        const resultEl = document.getElementById('merge-result');
        resultEl.classList.remove('hidden');
        resultEl.innerHTML = '<p class="loading-state">正在執行合併...</p>';

        const results = [];
        for (const candidate of selected) {
            try {
                const updated = await this.mergeOneCandidate(candidate);
                results.push({ candidate, ok: true, updated });
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
        // Re-read the candidate right before mutating it: the key/index shown in the UI
        // may be stale by the time the user confirms the merge (someone else could have
        // changed it, or it could already have been merged in a previous run).
        const fresh = await this.rereadCandidate(candidate.document_id);
        if (!fresh) throw new Error('候選文件已不存在，可能已被其他人處理，請重新整理。');
        if ((fresh.key || null) !== (candidate.key || null)) {
            throw new Error(`候選的 key 已變更為 ${fresh.key || '(null)'}（畫面顯示為 ${candidate.key || '(null)'}），請重新整理後再試。`);
        }
        if (fresh.index !== candidate.index) {
            // Defensive: candidate documents are only ever created in the current
            // year's index, but guard against acting on an unexpected index anyway.
            throw new Error('候選所在索引與預期不符，已中止以避免誤刪。');
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

        await this.openSearchRequest(
            `/${this.encodeIndex(fresh.index)}/_doc/${this.encodeId(candidate.document_id)}?if_seq_no=${encodeURIComponent(fresh.seqNo)}&if_primary_term=${encodeURIComponent(fresh.primaryTerm)}`,
            { method: 'DELETE' },
        );
        return updatedCount;
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
        resultEl.innerHTML = `
            <div class="merge-result-summary">
                <strong>合併完成</strong>
                <p>成功合併 ${okResults.length} 個候選，共更新 ${totalUpdated} 筆 error log 並刪除對應候選文件。${failResults.length ? `${failResults.length} 個候選失敗，未刪除。` : ''}</p>
            </div>
            ${okResults.length ? `<ul class="merge-result-list">${okResults.map((r) => `<li class="is-ok">✓ ${this.escape(r.candidate.document_id)}${r.candidate.key ? ` (${this.escape(r.candidate.key)})` : ''}：更新 ${r.updated} 筆 log</li>`).join('')}</ul>` : ''}
            ${failResults.length ? `<ul class="merge-result-list">${failResults.map((r) => `<li class="is-fail">✗ ${this.escape(r.candidate.document_id)}：${this.escape(r.error)}</li>`).join('')}</ul>` : ''}
            ${mergedKeys.length ? `<p class="confirm-keyed-warning">⚠ 請記得到 Jira 平台手動關閉或標記以下 issue 為 duplicate：${mergedKeys.map((k) => this.escape(k)).join(', ')}（這裡的刪除只影響 OpenSearch，不會呼叫 Jira API）。</p>` : ''}
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
