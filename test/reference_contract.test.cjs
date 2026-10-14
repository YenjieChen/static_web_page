const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function page(file, name) {
  const context = vm.createContext({document: {addEventListener() {}}, window: {}, console});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../error_log_review', file), 'utf8') + `\nglobalThis.Page = ${name};`, context);
  return Object.create(context.Page.prototype);
}
(async () => {
  const review = page('review.js', 'ReviewPage');
  let response = [{_id: 'actual-document-id', _source: {key: 'VEL-2020', site: 'prod', log_group: 'service'}}];
  review.openSearchRequest = async url => {assert(url.startsWith('/jira_issue_embedding_titan_v2/')); return {hits: {hits: response}};};
  const expected = {site: 'prod', log_group: 'service'};
  assert.equal((await review.assertCandidateExists('actual-document-id', 'VEL-2020', expected)).document_id, 'actual-document-id');
  await assert.rejects(review.assertCandidateExists('actual-document-id', 'VEL-2020', {site: 'stage', log_group: 'service'}));
  response.push({_id: 'duplicate-id', _source: response[0]._source});
  await assert.rejects(review.assertCandidateExists('missing-id', 'VEL-2020', expected));
  const merge = page('merge.js', 'MergePage');
  merge.openSearchRequest = async url => {assert(url.startsWith('/jira_issue_embedding_titan_v2/')); return {hits: {hits: [{_id: 'actual-id', _index: 'jira_issue_embedding_titan_v2', _source: {document_id: 'VEL-2020', index: 'backup', site: 'prod', log_group: 'service', embedding: [1]}}]}};};
  const target = await merge.fetchTargetIssue('VEL-2020');
  assert.equal(target.document_id, 'actual-id');
  assert.equal(target.index, 'jira_issue_embedding_titan_v2');
  console.log('Reference contract tests passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
