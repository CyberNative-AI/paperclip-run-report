#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const states = new Set(['advanced', 'completed', 'blocked', 'empty_response', 'plan_only', 'needs_followup', 'failed']);
const sources = new Set(['assignment', 'automation', 'timer', 'manual', 'api', 'scheduled', 'event', 'heartbeat']);
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const bucket = (value, allowed) => value == null || value === '' ? 'none' : allowed.has(value) ? value : 'unknown';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const iso = value => { const n = Date.parse(value); return Number.isFinite(n) ? n : null; };
const round = n => Math.round(n * 100) / 100;
const hash = (salt, id) => createHash('sha256').update(salt).update(':').update(id).digest('hex').slice(0, 16);

export function parseArgs(argv, env = process.env) {
  const opts = { url: env.PAPERCLIP_URL || 'http://127.0.0.1:3100', token: env.PAPERCLIP_API_KEY, days: 7, limit: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '--all') { opts[arg.slice(2)] = true; continue; }
    if (!['--company', '--url', '--token-file', '--since', '--days', '--share', '--limit'].includes(arg) || !argv[i + 1]) throw new Error(`Invalid option: ${arg}`);
    opts[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (opts.tokenFile && opts.token) throw new Error('Choose PAPERCLIP_API_KEY or --token-file, not both');
  const url = new URL(opts.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('URL must be a plain http(s) origin');
  opts.url = url.origin;
  if (opts.since && opts.days !== 7) throw new Error('Choose --since or --days');
  if (opts.since && iso(opts.since) === null) throw new Error('--since must be a valid timestamp');
  if (!opts.since && (!Number.isFinite(Number(opts.days)) || Number(opts.days) <= 0)) throw new Error('--days must be positive');
  if (!Number.isInteger(Number(opts.limit)) || Number(opts.limit) < 1 || Number(opts.limit) > 1000) throw new Error('--limit must be an integer from 1 to 1000');
  if (opts.all && Number(opts.limit) !== 1000) throw new Error('Choose --all or --limit');
  return opts;
}

export async function getJson(base, token, path, fetcher = fetch) {
  const url = new URL(path, `${base}/`);
  if (url.origin !== base) throw new Error('Cross-origin request refused');
  const response = await fetcher(url, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}

export function aggregate(runs, agents, sinceMs, untilMs, salt = randomBytes(16).toString('hex'), coverageLabel = 'fetched response; historical retention and server behavior may differ') {
  if (!Array.isArray(runs) || !Array.isArray(agents)) throw new Error('Unexpected API list response');
  const names = new Map(agents.map(a => [a.id, String(a.name || a.id)]));
  const rows = new Map(), issues = new Map();
  const totals = { fetched: runs.length, inWindow: 0, finished: 0, running: 0, missingUsage: 0, outputTokens: 0, outputCoveredRuns: 0, runMinutes: 0, markerPresent: 0, markerMissing: 0, blocked: 0 };
  let minCreated = null, maxCreated = null;
  for (const r of runs) {
    const created = iso(r.createdAt);
    if (created === null || created < sinceMs || created > untilMs) continue;
    totals.inWindow++;
    minCreated = minCreated === null ? created : Math.min(minCreated, created);
    maxCreated = maxCreated === null ? created : Math.max(maxCreated, created);
    const isFinished = terminal.has(r.status) && iso(r.finishedAt) !== null;
    if (isFinished) totals.finished++; else totals.running++;
    const start = iso(r.startedAt) ?? created, end = isFinished ? iso(r.finishedAt) : null;
    const minutes = end !== null && end >= start ? (end - start) / 60000 : 0;
    const output = count(r.usageJson?.outputTokens);
    if (output === null) totals.missingUsage++; else { totals.outputCoveredRuns++; totals.outputTokens += output; }
    totals.runMinutes += minutes;
    const marker = r.lastUsefulActionAt ? 'present' : 'missing';
    totals[marker === 'present' ? 'markerPresent' : 'markerMissing']++;
    const state = bucket(r.livenessState, states), source = bucket(r.invocationSource, sources);
    if (state === 'blocked') totals.blocked++;
    const agentId = typeof r.agentId === 'string' ? r.agentId : 'unknown';
    const key = JSON.stringify([agentId, source, state]);
    const row = rows.get(key) || { agentId, agent: names.get(agentId) || agentId, source, state, runs: 0, finished: 0, runMinutes: 0, outputTokens: 0, outputCoveredRuns: 0, markerPresent: 0, markerMissing: 0 };
    row.runs++; if (isFinished) row.finished++; row.runMinutes += minutes;
    if (output !== null) { row.outputTokens += output; row.outputCoveredRuns++; }
    row[marker === 'present' ? 'markerPresent' : 'markerMissing']++;
    rows.set(key, row);
    const issueId = r.contextSnapshot?.issueId;
    if (isFinished && typeof issueId === 'string' && issueId) {
      const item = issues.get(issueId) || { issueId, runs: 0, blocked: 0, markerMissing: 0, flaggedRuns: 0, stateMix: {} };
      item.runs++; item.stateMix[state] = (item.stateMix[state] || 0) + 1;
      if (state === 'blocked') item.blocked++;
      if (marker === 'missing') item.markerMissing++;
      if (state === 'blocked' || marker === 'missing') item.flaggedRuns++;
      issues.set(issueId, item);
    }
  }
  const sortedRows = [...rows.values()].map(r => ({ ...r, runMinutes: round(r.runMinutes) })).sort((a,b) => a.agent.localeCompare(b.agent) || a.source.localeCompare(b.source) || a.state.localeCompare(b.state));
  totals.runMinutes = round(sortedRows.reduce((sum, row) => sum + row.runMinutes, 0));
  const repeated = [...issues.values()].filter(x => x.flaggedRuns >= 3).sort((a,b) => b.flaggedRuns - a.flaggedRuns || a.issueId.localeCompare(b.issueId));
  const share = {
    schemaVersion: 1,
    coverage: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), firstFetchedInWindow: minCreated === null ? null : new Date(minCreated).toISOString(), lastFetchedInWindow: maxCreated === null ? null : new Date(maxCreated).toISOString(), fetched: totals.fetched, inWindow: totals.inWindow, completeness: coverageLabel },
    totals,
    rows: sortedRows.map(({agentId, agent, ...rest}) => ({ agentHash: hash(salt, agentId), ...rest })),
    repeatedIssues: repeated.map(({issueId, ...rest}) => ({ issueHash: hash(salt, issueId), ...rest })),
    tokenSemantics: 'outputTokens only; missing usage excluded from token sum',
    interpretation: 'State and recorded useful-action marker are separate observations; neither proves waste.'
  };
  return { rows: sortedRows, repeated, share };
}

export function render(result) {
  const { coverage, totals } = result.share;
  const lines = [
    `Window: ${coverage.since} to ${coverage.until}`,
    `Fetched ${totals.fetched} runs; ${totals.inWindow} in window (${totals.finished} finished, ${totals.running} unfinished).`,
    `Observed createdAt range: ${coverage.firstFetchedInWindow ?? 'none'} to ${coverage.lastFetchedInWindow ?? 'none'}.`,
    `Coverage: ${coverage.completeness}.`,
    `Run-minutes: ${totals.runMinutes}; output tokens: ${totals.outputTokens} (${totals.outputCoveredRuns}/${totals.inWindow} runs covered; ${totals.missingUsage} missing usage).`,
    `Recorded useful-action marker: ${totals.markerPresent} present, ${totals.markerMissing} missing. Blocked state: ${totals.blocked}. These are inspection flags, not measured waste or savings.`,
    '', 'Agent | source | liveness state | runs | finished | minutes | output tokens (covered) | marker present/missing'
  ];
  for (const r of result.rows) lines.push(`${r.agent} | ${r.source} | ${r.state} | ${r.runs} | ${r.finished} | ${r.runMinutes} | ${r.outputTokens} (${r.outputCoveredRuns}) | ${r.markerPresent}/${r.markerMissing}`);
  lines.push('', 'Issues with at least 3 finished flagged runs (blocked state OR missing marker):');
  if (!result.repeated.length) lines.push('none observed in fetched window');
  for (const x of result.repeated) lines.push(`${x.issueId}: ${x.flaggedRuns}/${x.runs} flagged; blocked=${x.blocked}; marker missing=${x.markerMissing}; states=${JSON.stringify(x.stateMix)}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env, fetcher = fetch) {
  const opts = parseArgs(argv, env);
  if (opts.help) { console.log('Usage: paperclip-run-report [--url URL] [--token-file PATH] [--company ID] [--since ISO | --days N] [--limit 1..1000 | --all] [--share FILE]'); return; }
  const token = opts.tokenFile ? (await readFile(opts.tokenFile, 'utf8')).trim() : opts.token;
  if (!token) throw new Error('Set PAPERCLIP_API_KEY or --token-file');
  if (!opts.company) {
    const companies = await getJson(opts.url, token, '/api/companies?scope=accessible', fetcher);
    if (!Array.isArray(companies)) throw new Error('Unexpected companies response');
    console.log('Choose --company ID from accessible companies:');
    for (const c of companies) console.log(`${c.id}  ${c.name}`);
    return;
  }
  const until = Date.now(), since = opts.since ? iso(opts.since) : until - Number(opts.days) * 86400000;
  const id = encodeURIComponent(opts.company);
  const [runs, agents] = await Promise.all([
    getJson(opts.url, token, `/api/companies/${id}/heartbeat-runs${opts.all ? '' : `?limit=${opts.limit}`}`, fetcher),
    getJson(opts.url, token, `/api/companies/${id}/agents`, fetcher)
  ]);
  const coverageLabel = opts.all
    ? 'uncapped GET response on this API version; no snapshot isolation or guarantee about historical retention'
    : runs.length >= Number(opts.limit)
      ? `newest ${opts.limit} run sample at server limit; earlier runs may be absent; no paging on tested API version`
      : `fewer than requested ${opts.limit} runs returned; no paging on tested API version; historical retention unknown`;
  const report = aggregate(runs, agents, since, until, randomBytes(16).toString('hex'), coverageLabel);
  console.log(render(report));
  if (opts.share) { await writeFile(opts.share, JSON.stringify(report.share, null, 2) + '\n', { mode: 0o600 }); console.log(`Redacted report written to ${opts.share}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(`Error: ${e.message}`); process.exitCode = 1; });
