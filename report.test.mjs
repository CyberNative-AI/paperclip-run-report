import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, getJson, parseArgs, render } from './report.mjs';

const now = Date.parse('2026-09-27T12:00:00Z');
const run = (n, extras = {}) => ({
  id: `run-${n}`, agentId: 'agent-secret', invocationSource: 'timer', livenessState: 'empty_response',
  status: 'succeeded', createdAt: `2026-09-27T0${n}:00:00Z`, startedAt: `2026-09-27T0${n}:00:00Z`,
  finishedAt: `2026-09-27T0${n}:02:00Z`, lastUsefulActionAt: null,
  usageJson: { outputTokens: 10 }, contextSnapshot: { issueId: 'issue-secret', instructions: 'PRIVATE INSTRUCTIONS' },
  resultJson: { summary: 'PRIVATE RESULT' }, stdoutExcerpt: 'PRIVATE LOG', ...extras
});

test('timer and empty response stay distinct; repeat issue includes overlap once', () => {
  const runs = [run(1), run(2, { livenessState: 'blocked', lastUsefulActionAt: '2026-09-27T02:01:00Z' }), run(3, { livenessState: 'blocked' })];
  const result = aggregate(runs, [{ id: 'agent-secret', name: 'Private Agent' }], now - 86400000, now, 'test-salt');
  assert.equal(result.share.totals.inWindow, 3);
  assert.equal(result.share.totals.runMinutes, 6);
  assert.equal(result.share.totals.outputTokens, 30);
  assert.equal(result.repeated[0].flaggedRuns, 3);
  assert.equal(result.repeated[0].blocked, 2);
  assert.equal(result.repeated[0].markerMissing, 2);
  assert.equal(result.rows.find(x => x.state === 'empty_response').source, 'timer');
  assert.match(render(result), /inspection flags, not measured waste or savings/);
});

test('unknowns, absent usage and unfinished runs retain separate coverage', () => {
  const runs = [
    run(1, { invocationSource: null, livenessState: null, usageJson: null }),
    run(2, { invocationSource: 'unexpected private text', livenessState: 'surprise private text', status: 'running', finishedAt: null, usageJson: null }),
    run(3, { lastUsefulActionAt: '2026-09-27T03:01:00Z', livenessState: 'completed' })
  ];
  const result = aggregate(runs, [], now - 86400000, now, 'test-salt');
  assert.deepEqual(result.rows.map(x => [x.source,x.state]), [['none','none'],['timer','completed'],['unknown','unknown']]);
  assert.equal(result.share.totals.running, 1);
  assert.equal(result.share.totals.runMinutes, 4);
  assert.equal(result.share.totals.missingUsage, 2);
  assert.equal(result.share.totals.markerMissing, 2);
  assert.equal(result.repeated.length, 0);
});

test('share has only aggregates and hashes, no private API fields', () => {
  const result = aggregate([run(1),run(2),run(3)], [{ id: 'agent-secret', name: 'Private Agent' }], now - 86400000, now, 'test-salt');
  const json = JSON.stringify(result.share);
  for (const forbidden of ['agent-secret', 'issue-secret', 'Private Agent', 'PRIVATE INSTRUCTIONS', 'PRIVATE RESULT', 'PRIVATE LOG', 'http']) assert.equal(json.includes(forbidden), false, forbidden);
  assert.match(result.share.rows[0].agentHash, /^[a-f0-9]{16}$/);
  assert.match(result.share.repeatedIssues[0].issueHash, /^[a-f0-9]{16}$/);
});

test('request contract is GET only with no limit or offset, redirects rejected', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push([String(url), options]); return { ok: true, json: async () => [] }; };
  await getJson('http://127.0.0.1:3100', 'secret', '/api/companies/id/heartbeat-runs', fetcher);
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(new URL(calls[0][0]).search, '');
  await assert.rejects(getJson('http://127.0.0.1:3100', 'secret', 'https://example.com/steal', fetcher), /Cross-origin/);
  assert.equal(calls.length, 1);
});

test('invalid input fails before network access', () => {
  assert.throws(() => parseArgs(['--url','https://user:pass@example.com'], {}), /plain http/);
  assert.throws(() => parseArgs(['--days','0'], {}), /positive/);
});
