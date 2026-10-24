<p><a href="https://cybernative.ai/"><img src="https://raw.githubusercontent.com/CyberNative-AI/paperclip-run-report/main/assets/cybernative-cn-mark.svg" width="32" height="32" alt="" align="absmiddle"> CyberNative AI LLC</a></p>

# Paperclip run report

A local, read-only report for operators of self-hosted Paperclip. It groups runs by agent, invocation source and Paperclip's recorded liveness state, then lists issues with repeated runs that merit inspection. It makes no network requests except GETs to the Paperclip URL you provide. It does not estimate savings.

## Install and run

Requires Node.js 20 or newer. Clone or download this directory, then run from it:

```sh
npm install --ignore-scripts
PAPERCLIP_API_KEY='your-own-read-token' node report.mjs --company 'your-company-id' --days 7
```

There are no package dependencies and `npm install` does not need a registry. You can also use `npm link` to expose `paperclip-run-report` as a command. Set `PAPERCLIP_URL` if the instance is not at `http://127.0.0.1:3100`. Instead of an environment token, use `--token-file /path/to/token` (a file containing only the token). If `--company` is omitted, the command requests the accessible company list and exits; some agent tokens lack permission for this listing, so pass the company ID directly. `--since 2026-09-20T00:00:00Z` selects an absolute start time in place of `--days 7`.

```sh
PAPERCLIP_API_KEY='your-own-read-token' node report.mjs --company 'your-company-id' --since '2026-09-20T00:00:00Z' --share ./run-share.json
```

`--share` writes a JSON file with mode 0600. It includes counts, minutes, output-token counts, state mixes and salted hashes of agent and issue IDs. The salt is generated per report and is not included, so hashes cannot be joined across reports. It excludes agent names, issue titles and text, run logs, comments, instructions, API URLs, tokens and raw API records. Review the file before sharing it.

The tool requests up to 1,000 runs for each listed agent, then cross-checks the newest 1,000 company summary runs for agents absent from the agent list. Per-agent reads use the standard projection because `summary=true` replaces `usageJson` with null in the tested source version. `--limit N` lowers the per-agent limit for a faster but potentially incomplete report. A per-agent window is complete when fewer than the limit are returned, or the oldest returned run predates the requested start. A capped agent whose oldest run is inside the window is incomplete. The overall verdict says when any agent is capped or when the company sample contains an unlisted agent. Even a complete verdict covers listed agents only: older runs from deleted or unlisted agents may be absent from the newest company sample. Server retention and concurrent writes are not verified.

## Reading the report

- Run minutes use `startedAt` (or `createdAt` when absent) through `finishedAt`. Unfinished runs count in the table but have no minutes. The report shows how many runs were unfinished.
- Output tokens are summed only when `usageJson.outputTokens` is a nonnegative integer. Zero is a measured zero; missing usage stays missing. The coverage count appears beside every token sum.
- `livenessState` is the upstream classification. `none` means the field is absent. An unrecognized label appears as `unknown`. The same rule applies to invocation source; upstream sources are `timer`, `assignment`, `on_demand`, and `automation`. The `lastUsefulActionAt` marker is counted separately.
- An issue enters the inspection list when at least three **finished** runs in the window ended `blocked` or lack a recorded useful-action marker. A run meeting both conditions counts once. A null marker means recorded evidence is absent; it does not prove no useful work occurred. A blocked classification can be a correct outcome. This list measures neither waste nor savings.
- The window uses `createdAt` and is filtered locally after fetching. The report gives the requested window, fetched count, in-window count and observed timestamp span. A zero in a category describes the fetched window only.

When the same issue keeps reappearing in the inspection list, [paperclip-guardrails](https://github.com/CyberNative-AI/paperclip-guardrails) has free agent skills for three failures we hit ourselves: the same failing step retried, work marked `blocked` with nothing blocking it, and timers or routines that wake agents with nothing to do. Each skill states its limits.

## API coverage and privacy

At [Paperclip source commit `640dee18029f7651d56ae0f1828d04228f9ab044`](https://github.com/paperclipai/paperclip/tree/640dee18029f7651d56ae0f1828d04228f9ab044), the [run list route](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/server/src/routes/agents.ts) accepts `agentId`, `summary=true`, and `limit`, but no `offset` or cursor. Explicit `limit` is capped at 1,000. This tool requests `/api/companies/{id}/agents` once, one standard run list per agent, and one newest-1,000 company summary list as a cross-check. The [heartbeat service](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/server/src/services/heartbeat.ts) removes usage from summary rows. Standard run lists include usage and limited result metadata; this tool reads only the fields needed for aggregate output and does not query issue bodies, run logs or cost endpoints. The API response is not saved. The server may still have retention rules, and reads during active writes are not a transactionally frozen snapshot. Other Paperclip versions can differ; check their API before treating coverage as complete.

## Source semantics tested

Source version: upstream commit [`640dee18029f7651d56ae0f1828d04228f9ab044`](https://github.com/paperclipai/paperclip/tree/640dee18029f7651d56ae0f1828d04228f9ab044), inspected September 2026.

- [Run liveness](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/server/src/services/run-liveness.ts) assigns states `advanced`, `completed`, `blocked`, `empty_response`, `plan_only`, `needs_followup`, or `failed`. It supplies `lastUsefulActionAt` only for `advanced`, `completed`, or `blocked` **when** concrete action evidence has a latest evidence timestamp. Consequently, state and timestamp are different observations.
- [Shared constants](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/shared/src/constants.ts) define the four invocation sources and seven liveness states displayed by this report.
- [Heartbeat persistence](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/server/src/services/heartbeat.ts) writes `inputTokens`, `cachedInputTokens`, and `outputTokens` from normalized usage. It writes `rawInputTokens`, `rawCachedInputTokens`, and `rawOutputTokens` from the adapter before normalization. For session-cumulative usage, normalization subtracts prior session totals; adapters declaring per-run usage pass through. Raw fields are not an additional token category.
- The [Codex adapter](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/adapters/codex-local/src/server/parse.ts) maps provider `input_tokens`, `cached_input_tokens`, and `output_tokens` directly. The [Claude adapter](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/adapters/claude-local/src/server/execute.ts) maps `input_tokens` and `cache_read_input_tokens` separately. The [Gemini adapter](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/adapters/gemini-local/src/server/parse.ts) maps `promptTokenCount` and `cachedContentTokenCount`. The [ACPX adapter utility](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/adapter-utils/src/acpx-engine/execute.ts) adds cache-write tokens to input and places cache-read tokens in cached input. These source mappings do not establish one safe cross-adapter rule for adding input and cached counts. This report therefore shows output tokens, not an invented combined token total.

For agent and model billing visibility, see [paperclip-cost-audit](https://github.com/georgenijo/paperclip-cost-audit). This report's additional operator decision is where to inspect repeated runs by source and liveness state. A timer × `empty_response` fixture is in the test suite; it is synthetic and says nothing about the prevalence of that combination on an operator's instance.

## Test

```sh
npm test
```

Tests use synthetic fixtures and mocked GET requests. They cover timer × `empty_response`, `on_demand`, absent and unknown labels, separate marker counts, missing usage, unfinished runs, repeat-issue overlap, per-agent coverage, unlisted agents, share-file privacy and the request contract. They do not assert a live instance's historical completeness.
