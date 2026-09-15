/* Manual review UI. The backend must enforce authentication and authorization. */
const REVIEW_API = {
    pending: '/api/review/pending',
    approve: '/api/review/approve',
    reject: '/api/review/reject',
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
    },
    {
        id: 'demo-prod-002', site: 'prod', message_id: 'demo-prod-002',
        error_message: 'Connection pool exhausted while connecting to PostgreSQL',
        traceback: 'TimeoutError: connection pool exhausted\n  File "db/pool.py", line 142, in acquire',
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
        this.demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
        this.bindEvents();
        this.load();
    }

    bindEvents() {
        document.getElementById('refresh-btn').addEventListener('click', () => this.load());
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
        this.setList('<div class="loading-state">正在載入待審核資料...</div>');
        try {
            const response = this.demoMode ? null : await fetch(REVIEW_API.pending, { headers: { Accept: 'application/json' } });
            if (this.demoMode) {
                this.items = [...demoItems];
            } else {
                if (!response.ok) throw new Error(`API ${response.status}`);
                const payload = await response.json();
                this.items = Array.isArray(payload) ? payload : (payload.items || payload.pending || []);
            }
            this.selected.clear();
            this.render();
            this.updateSummary();
            if (this.demoMode) this.showToast('Demo 模式：不會寫回任何資料。', 'success');
        } catch (error) {
            console.error(error);
            this.setList('<div class="error-state">無法載入待審核資料。請確認 Review API 已部署，或使用網址參數 <code>?demo=1</code> 預覽頁面。</div>');
            this.updateSummary();
        }
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
        document.getElementById('modal-review-summary').innerHTML = `<p>候選 Jira：<strong>${this.escape(candidateKeys.join(', ') || '未指定')}</strong></p><p>選取 ${items.length} 筆 log。${action === 'approve' ? '核准後會寫入候選 embedding reference。' : '拒絕後不會自動建立 Jira，需後續另行處理。'}</p>`;
        document.getElementById('review-reason').value = '';
        document.getElementById('reason-hint').textContent = action === 'reject' ? '（必填）' : '（選填）';
        document.getElementById('modal-warning').textContent = action === 'approve' ? '請確認候選 issue 與環境、服務及根因一致。此操作會修改 error log association。' : '拒絕不會建立新 Jira，也不會自動重試；請在備註記錄原因。';
        document.getElementById('modal-confirm').textContent = action === 'approve' ? '確認核准' : '確認拒絕';
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
        const endpoint = action === 'approve' ? REVIEW_API.approve : REVIEW_API.reject;
        const payload = { items: records.map((item) => ({
            index_name: item.index_name, message_id: item.message_id || item.id,
            review_candidate_reference: item.review_candidate_reference,
            review_candidate_key: item.review_candidate_key,
        })), reason };
        const button = document.getElementById('modal-confirm');
        button.disabled = true;
        try {
            const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
            if (!response.ok) throw new Error(`API ${response.status}`);
            this.closeModal();
            await this.load();
            this.showToast(`已${action === 'approve' ? '核准' : '拒絕'} ${records.length} 筆。`, 'success');
        } catch (error) {
            console.error(error);
            this.showToast('操作失敗，資料未確認是否已寫入，請重新整理後再檢查。', 'error');
        } finally { button.disabled = false; }
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
