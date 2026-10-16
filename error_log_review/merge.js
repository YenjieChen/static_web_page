/* The browser only queries OpenSearch and directly invokes the controlled Lambda with AWS SDK v3.
 * Temporary AWS credentials are memory-only: never persisted, logged, or included in the payload.
 */
import { LambdaClient, InvokeCommand } from 'https://esm.sh/@aws-sdk/client-lambda@3.1010.0?bundle';
import { STSClient, GetCallerIdentityCommand } from 'https://esm.sh/@aws-sdk/client-sts@3.1010.0?bundle';

const AWS_REGION = 'ap-northeast-1';
const LAMBDA_FUNCTION_NAME = 'vortex-ai-ErrorMessageDailyReport';
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
        this.awsCredentials = null;
        this.awsIdentity = null;
        this.target = null;
        this.candidates = [];
        this.restoreConnectionFields();
        this.bindEvents();
    }

    bindEvents() {
        document.getElementById('connection-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.applyConnectionSettings();
        });
        document.getElementById('clear-connection-btn').addEventListener('click', () => this.clearConnectionSettings());
        document.getElementById('aws-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.applyAwsCredentials();
        });
        document.getElementById('aws-clear-btn').addEventListener('click', () => this.clearAwsCredentials());
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

    restoreConnectionFields() {
        document.getElementById('opensearch-url').value = this.readStorage(localStorage, CONNECTION_STORAGE_KEYS.url);
        document.getElementById('opensearch-username').value = this.readStorage(localStorage, CONNECTION_STORAGE_KEYS.username);
        document.getElementById('opensearch-password').value = this.readStorage(sessionStorage, CONNECTION_STORAGE_KEYS.password);
    }

    readStorage(storage, key) {
        try { return storage.getItem(key) || ''; } catch { return ''; }
    }

    writeStorage(storage, key, value) {
        try {
            if (value) storage.setItem(key, value); else storage.removeItem(key);
        } catch (error) {
            console.warn('Unable to persist setting:', error);
        }
    }

    async applyConnectionSettings() {
        const url = document.getElementById('opensearch-url').value.trim().replace(/\/$/, '');
        const username = document.getElementById('opensearch-username').value;
        const password = document.getElementById('opensearch-password').value;
        let parsed;
        try {
            parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('invalid endpoint');
        } catch {
            this.showToast('請輸入不含帳密、查詢參數或 hash 的 HTTPS OpenSearch URL。', 'error');
            return;
        }
        if (!username || !password) {
            this.showToast('OpenSearch 查詢需要帳號與密碼。', 'error');
            return;
        }
        this.connection = { url, authorization: `Basic ${this.toBasicAuth(username, password)}` };
        this.writeStorage(localStorage, CONNECTION_STORAGE_KEYS.url, url);
        this.writeStorage(localStorage, CONNECTION_STORAGE_KEYS.username, username);
        this.writeStorage(sessionStorage, CONNECTION_STORAGE_KEYS.password, password);
        this.setStatus('connection-status', '查詢設定已套用', 'success');
        document.getElementById('connection-details').textContent = `Host：${parsed.host}｜只允許查詢｜credentials 不執行 mutation`;
    }

    clearConnectionSettings() {
        this.connection = null;
        this.writeStorage(localStorage, CONNECTION_STORAGE_KEYS.url, '');
        this.writeStorage(localStorage, CONNECTION_STORAGE_KEYS.username, '');
        this.writeStorage(sessionStorage, CONNECTION_STORAGE_KEYS.password, '');
        ['opensearch-url', 'opensearch-username', 'opensearch-password'].forEach((id) => { document.getElementById(id).value = ''; });
        this.setStatus('connection-status', '尚未套用設定');
        document.getElementById('connection-details').textContent = '尚未提供連線設定';
        this.resetSearchState();
        this.showToast('OpenSearch 查詢設定已清除。', 'success');
    }

    async applyAwsCredentials() {
        const text = document.getElementById('aws-credentials').value;
        try {
            this.awsCredentials = this.parseAwsCredentials(text);
        const sts = new STSClient({ region: AWS_REGION, credentials: this.awsCredentials });
            const identity = await sts.send(new GetCallerIdentityCommand({}));
            this.awsIdentity = identity;
            const arn = identity.Arn || '';
            document.getElementById('aws-details').textContent = `Account：${identity.Account || 'unknown'}｜Arn：${arn}｜credentials 僅存在本頁記憶體`;
            this.setStatus('aws-status', 'AWS 身份已驗證', 'success');
            document.getElementById('aws-credentials').value = '';
            this.showToast('AWS 身份驗證成功，可以直接 Invoke Lambda。', 'success');
        } catch (error) {
            this.awsCredentials = null;
            this.awsIdentity = null;
            this.setStatus('aws-status', '驗證失敗', 'error');
            document.getElementById('aws-details').textContent = this.describeAwsError(error);
            this.showToast(this.describeAwsError(error), 'error');
        }
    }

    parseAwsCredentials(text) {
        const read = (name) => {
            const match = String(text || '').match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'mi'));
            return match ? match[1].trim() : '';
        };
        const credentials = {
            accessKeyId: read('aws_access_key_id'),
            secretAccessKey: read('aws_secret_access_key'),
            sessionToken: read('aws_session_token'),
        };
        if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken) {
            throw new Error('AWS credentials 必須包含 aws_access_key_id、aws_secret_access_key、aws_session_token。');
        }
        return credentials;
    }

    clearAwsCredentials() {
        this.awsCredentials = null;
        this.awsIdentity = null;
        document.getElementById('aws-credentials').value = '';
        this.setStatus('aws-status', '未設定');
        document.getElementById('aws-details').textContent = 'AWS credentials 已從本頁記憶體清除。';
        this.showToast('AWS credentials 已清除。', 'success');
    }

    describeAwsError(error) {
        return `AWS SDK：${error?.name || 'Error'}：${error?.message || '身份驗證失敗'}；請確認 temporary credentials 尚未過期，且允許 sts:GetCallerIdentity。`;
    }

    setStatus(id, message, type = '') {
        const element = document.getElementById(id);
        element.textContent = message;
        element.className = `connection-status ${type ? `is-${type}` : ''}`;
    }

    toBasicAuth(username, password) {
        const bytes = new TextEncoder().encode(`${username}:${password}`);
        let binary = '';
        bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
        return btoa(binary);
    }

    encodeIndex(index) { return encodeURIComponent(index).replace(/%2A/gi, '*').replace(/%2C/gi, ','); }

    async openSearchRequest(path, options = {}) {
        if (!this.connection) throw new Error('尚未設定 OpenSearch 查詢連線');
        const headers = { Accept: 'application/json', Authorization: this.connection.authorization };
        if (options.body) headers['Content-Type'] = 'application/json';
        let response;
        try {
            response = await fetch(`${this.connection.url}${path}`, { ...options, headers, credentials: 'omit' });
        } catch (error) {
            throw new Error(`無法連線 OpenSearch（${error.message}）；請檢查 TLS、CORS 與網路。`);
        }
        return this.parseResponse(response, 'OpenSearch');
    }

    async invokeMergeLambda(source, targets) {
        if (!this.awsCredentials) throw new Error('尚未驗證 AWS credentials。');
        const lambda = new LambdaClient({ region: AWS_REGION, credentials: this.awsCredentials });
        const command = new InvokeCommand({
            FunctionName: LAMBDA_FUNCTION_NAME,
            InvocationType: 'RequestResponse',
            Payload: new TextEncoder().encode(JSON.stringify({ task: 'merge_jira', source, target: targets })),
        });
        let response;
        try {
            response = await lambda.send(command);
        } catch (error) {
            throw new Error(`AWS Lambda Invoke 失敗：${error.name || 'Error'}：${error.message || 'unknown error'}`);
        }
        const payloadText = response.Payload ? new TextDecoder().decode(response.Payload) : '{}';
        let payload;
        try { payload = payloadText ? JSON.parse(payloadText) : {}; } catch { payload = { raw: payloadText }; }
        if (response.FunctionError) {
            throw new Error(`Lambda execution error：${payload.errorMessage || payload.error || JSON.stringify(payload)}`);
        }
        if (payload.body && typeof payload.body === 'string') {
            try { return JSON.parse(payload.body); } catch { return payload; }
        }
        return payload;
    }

    async parseResponse(response, service) {
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
        if (!response.ok) {
            throw new Error(`${service} ${response.status}: ${payload.error || payload.message || payload.body || text || 'request failed'}`);
        }
        if (payload.body && typeof payload.body === 'string') {
            try { return JSON.parse(payload.body); } catch { return payload; }
        }
        return payload;
    }

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
        if (!this.connection) return this.showToast('請先套用 OpenSearch 查詢設定。', 'error');
        const rawKey = document.getElementById('target-key').value.trim();
        if (!JIRA_KEY_PATTERN.test(rawKey)) return this.showToast('請輸入有效的 Jira key，例如 VEL-2176。', 'error');
        this.resetSearchState();
        document.getElementById('target-summary').classList.remove('hidden');
        document.getElementById('target-summary').innerHTML = '<p class="loading-state">正在查詢保留的 Jira embedding...</p>';
        try {
            this.target = await this.fetchTargetIssue(rawKey);
            this.renderTargetSummary(this.target);
            document.getElementById('candidate-section').classList.remove('hidden');
            document.getElementById('candidate-list').innerHTML = '<p class="loading-state">正在搜尋相似 candidates...</p>';
            this.candidates = await this.fetchSimilarCandidates(this.target);
            await this.attachAffectedLogCounts(this.candidates);
            this.renderCandidateList();
        } catch (error) {
            console.error('Merge search failed:', error);
            document.getElementById('target-summary').innerHTML = `<div class="error-state">${this.escape(error.message)}</div>`;
            document.getElementById('candidate-section').classList.add('hidden');
        }
    }

    async fetchTargetIssue(key) {
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            body: JSON.stringify({ size: 50, _source: ['key', 'summary', 'error_message', 'error_type', 'site', 'log_group', 'status', 'embedding'], query: { bool: { should: [{ term: { 'key.keyword': key } }, { term: { key } }], minimum_should_match: 1 } } }),
        });
        const hits = (payload.hits?.hits || []).filter((hit) => hit._source?.key === key);
        if (hits.length !== 1) throw new Error(`找不到唯一 Jira ${key} 對應的 embedding document。`);
        const source = hits[0]._source || {};
        if (!Array.isArray(source.embedding) || !source.embedding.length) throw new Error(`Jira ${key} 缺少 embedding vector。`);
        return { ...source, document_id: hits[0]._id, index: hits[0]._index };
    }

    async fetchSimilarCandidates(target) {
        const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, {
            method: 'POST',
            body: JSON.stringify({
                size: CANDIDATE_POOL_SIZE,
                _source: ['key', 'summary', 'error_message', 'error_type', 'traceback', 'site', 'log_group', 'status'],
                query: { knn: { embedding: { vector: target.embedding, k: CANDIDATE_POOL_SIZE } } },
                post_filter: { bool: { must: [{ term: { site: target.site } }, { term: { log_group: target.log_group } }], must_not: [{ term: { status: 'SUB ISSUES' } }] } },
            }),
        });
        return (payload.hits?.hits || []).filter((hit) => hit._id !== target.document_id && JIRA_KEY_PATTERN.test(hit._source?.key || '')).map((hit) => ({
            score: hit._score, similarity: Number.isFinite(hit._score) ? hit._score - 1 : null, ...(hit._source || {}), document_id: hit._id, index: hit._index,
        })).slice(0, SUGGESTION_LIMIT);
    }

    async attachAffectedLogCounts(candidates) {
        await Promise.all(candidates.map(async (candidate) => {
            try {
                const payload = await this.openSearchRequest(`/${this.encodeIndex(ERROR_INDEXES)}/_search`, { method: 'POST', body: JSON.stringify({ size: 0, query: { term: { 'jira_reference.keyword': candidate.document_id } } }) });
                candidate.affectedLogCount = payload.hits?.total?.value ?? 0;
            } catch (error) {
                candidate.affectedLogCount = null;
                console.warn('Failed to count affected logs', candidate.document_id, error);
            }
        }));
    }

    async addManualCandidate() {
        if (!this.target) return this.showToast('請先搜尋 source Jira。', 'error');
        const key = document.getElementById('manual-add-key').value.trim();
        if (!JIRA_KEY_PATTERN.test(key)) return this.showToast('請輸入有效的 Jira key。', 'error');
        if (key === this.target.key || this.candidates.some((candidate) => candidate.key === key)) return this.showToast('此 Jira key 已是 source 或 candidate。', 'error');
        const button = document.getElementById('manual-add-btn');
        button.disabled = true;
        try {
            const payload = await this.openSearchRequest(`/${CANDIDATE_INDEX}/_search`, { method: 'POST', body: JSON.stringify({ size: 1, _source: ['key', 'summary', 'error_message', 'error_type', 'traceback', 'site', 'log_group', 'status'], query: { bool: { should: [{ term: { 'key.keyword': key } }, { term: { key } }], minimum_should_match: 1 } } }) });
            const hit = payload.hits?.hits?.find((item) => item._source?.key === key);
            if (!hit) throw new Error(`找不到 Jira ${key} 對應的 embedding document。`);
            const candidate = { ...(hit._source || {}), document_id: hit._id, index: hit._index, manuallyAdded: true, score: null, similarity: null };
            await this.attachAffectedLogCounts([candidate]);
            this.candidates = [candidate, ...this.candidates];
            document.getElementById('manual-add-key').value = '';
            this.renderCandidateList();
        } catch (error) {
            this.showToast(error.message, 'error');
        } finally {
            button.disabled = false;
        }
    }

    renderTargetSummary(target) {
        document.getElementById('target-summary').innerHTML = `<div class="target-summary-card"><div><strong>${this.escape(target.key)}</strong><span class="badge badge-${this.escape((target.site || 'unknown').toLowerCase())}">${this.escape((target.site || '').toUpperCase())}</span></div><p>${this.escape(target.summary || '未提供 summary')}</p><p class="target-summary-meta">doc_id：${this.escape(target.document_id)}　Log group：${this.escape(target.log_group || '未提供')}</p></div>`;
    }

    renderCandidateList() {
        const list = document.getElementById('candidate-list');
        document.getElementById('candidate-count').textContent = `找到 ${this.candidates.length} 筆 candidate`;
        if (!this.candidates.length) {
            list.innerHTML = '<p class="empty-state">沒有找到符合條件的 candidate。</p>';
            this.updateSubmitButtonState();
            return;
        }
        list.innerHTML = this.candidates.map((candidate, index) => {
            const similarity = Number.isFinite(candidate.similarity) ? `${(candidate.similarity * 100).toFixed(2)}%` : '手動加入';
            const count = candidate.affectedLogCount === null ? '查詢失敗' : `${candidate.affectedLogCount} 筆`;
            return `<label class="candidate-merge-item"><input type="checkbox" data-candidate-checkbox data-index="${index}"><div class="candidate-merge-body"><div class="candidate-merge-top"><span class="badge badge-similarity">${candidate.manuallyAdded ? '手動加入' : `相似度 ${similarity}`}</span><span class="candidate-merge-count">影響 error log：${count}</span><span class="badge badge-warning">刪除 Jira ${this.escape(candidate.key || '無 key')}</span></div><p class="candidate-merge-summary">${this.escape(candidate.summary || candidate.error_message || '未提供 summary')}</p><p class="candidate-merge-meta">doc_id：${this.escape(candidate.document_id)}　site：${this.escape(candidate.site || '')}　log_group：${this.escape(candidate.log_group || '')}</p></div></label>`;
        }).join('');
        this.updateSubmitButtonState();
    }

    updateSubmitButtonState() {
        document.getElementById('submit-merge-btn').disabled = !this.getSelectedCandidates().length;
    }

    getSelectedCandidates() {
        return [...document.querySelectorAll('#candidate-list [data-candidate-checkbox]:checked')].map((box) => this.candidates[Number(box.dataset.index)]).filter(Boolean);
    }

    openConfirmModal() {
        const selected = this.getSelectedCandidates();
        if (!selected.length) return;
        if (!this.awsCredentials) return this.showToast('請先貼上並驗證 AWS temporary credentials。', 'error');
        document.getElementById('confirm-modal-body').innerHTML = `<p>保留 source：<strong>${this.escape(this.target.key)}</strong></p><p>送給 Lambda 刪除的 targets：</p><ul class="confirm-candidate-list">${selected.map((candidate) => `<li>${this.escape(candidate.key)}（doc_id：${this.escape(candidate.document_id)}，${candidate.affectedLogCount ?? '?'} 筆 log）</li>`).join('')}</ul><p>Lambda event：<code>{"task":"merge_jira","source":"${this.escape(this.target.key)}","target":[${selected.map((candidate) => `"${this.escape(candidate.key)}"`).join(',')}]}</code></p>`;
        document.getElementById('confirm-modal').classList.remove('hidden');
    }

    closeConfirmModal() { document.getElementById('confirm-modal').classList.add('hidden'); }

    async submitMerge() {
        const selected = this.getSelectedCandidates();
        this.closeConfirmModal();
        if (!selected.length || !this.awsCredentials) return;
        document.getElementById('submit-merge-btn').disabled = true;
        const resultEl = document.getElementById('merge-result');
        resultEl.classList.remove('hidden');
        resultEl.innerHTML = '<p class="loading-state">正在呼叫 Merge Lambda；等待 Jira、OpenSearch 與 embedding 驗證結果...</p>';
        try {
            const result = await this.invokeMergeLambda(this.target.key, selected.map((candidate) => candidate.key));
            this.renderLambdaResult(result);
        } catch (error) {
            this.renderLambdaResult({ status: 'FAILED', errors: [{ error: error.message }] });
        }
    }

    renderLambdaResult(result) {
        const resultEl = document.getElementById('merge-result');
        const rows = (result.results || []).map((item) => `<li class="is-ok">✓ ${this.escape(item.duplicate_key)}：source_doc_id=${this.escape(item.source_doc_id)}；duplicate_doc_id=${this.escape(item.duplicate_doc_id)}；更新 ${item.references_updated ?? 0} 筆；remaining reference=${item.references_remaining ?? '?'}；Jira deleted=${item.jira_delete_verified_absent === true}；embedding deleted=${item.embedding_delete_verified_absent === true}</li>`).join('');
        const errors = (result.errors || []).map((item) => `<li class="is-fail">✗ ${this.escape(item.target || '')}：${this.escape(item.error || 'unknown error')}</li>`).join('');
        resultEl.innerHTML = `<div class="merge-result-summary"><strong>Merge Lambda：${this.escape(result.status || 'UNKNOWN')}</strong><p>source：${this.escape(result.source || this.target?.key || '')}；embedding index：${this.escape(result.embedding_index || CANDIDATE_INDEX)}</p><p>下列紀錄由 Lambda 回傳，包含 doc id、reference 更新、Jira deletion 與 embedding deletion 驗證。</p></div>${rows ? `<ul class="merge-result-list">${rows}</ul>` : ''}${errors ? `<ul class="merge-result-list">${errors}</ul>` : ''}<details><summary>Lambda execution result / log</summary><pre>${this.escape(JSON.stringify(result, null, 2))}</pre></details>`;
        this.setStatus('aws-status', `最近執行：${result.status || 'UNKNOWN'}`, result.status === 'COMPLETED' ? 'success' : 'error');
        this.showToast(result.status === 'COMPLETED' ? 'Merge Lambda 執行完成。' : 'Merge Lambda 執行失敗或部分完成，請查看說明區。', result.status === 'COMPLETED' ? 'success' : 'error');
    }

    showToast(message, type = '') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type ? `is-${type}` : ''}`;
        toast.classList.remove('hidden');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => toast.classList.add('hidden'), 5000);
    }

    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
}

document.addEventListener('DOMContentLoaded', () => new MergePage());
