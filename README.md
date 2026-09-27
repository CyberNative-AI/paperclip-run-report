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

The default request uses `--limit 1000`. If it returns exactly 1,000 rows, the report labels the result as a newest-run sample. You may request a smaller sample with `--limit N`, or use `--all` for an uncapped request when your instance can handle a potentially large response. An uncapped read can take a long time; it has no server-side date filter on the tested version.

## Reading the report

- Run minutes use `startedAt` (or `createdAt` when absent) through `finishedAt`. Unfinished runs count in the table but have no minutes. The report shows how many runs were unfinished.
- Output tokens are summed only when `usageJson.outputTokens` is a nonnegative integer. Zero is a measured zero; missing usage stays missing. The coverage count appears beside every token sum.
- `livenessState` is the upstream classification. `none` means the field is absent. An unrecognized label appears as `unknown`. The same rule applies to invocation source. The `lastUsefulActionAt` marker is counted separately.
- An issue enters the inspection list when at least three **finished** runs in the window ended `blocked` or lack a recorded useful-action marker. A run meeting both conditions counts once. A null marker means recorded evidence is absent; it does not prove no useful work occurred. A blocked classification can be a correct outcome. This list measures neither waste nor savings.
- The window uses `createdAt` and is filtered locally after fetching. The report gives the requested window, fetched count, in-window count and observed timestamp span. A zero in a category describes the fetched window only.

## API coverage and privacy

At [Paperclip source commit `640dee18029f7651d56ae0f1828d04228f9ab044`](https://github.com/paperclipai/paperclip/tree/640dee18029f7651d56ae0f1828d04228f9ab044), the [run list route](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/server/src/routes/agents.ts) accepts `limit` but no `offset` or cursor. Explicit `limit` is capped at 1,000; omitting it asks for the full list. This tool requests `/api/companies/{id}/heartbeat-runs` once, plus `/api/companies/{id}/agents` once. It does not query issues or cost endpoints. The API response is not saved. The server may still have retention rules, and a list fetched during active writes is not a transactionally frozen snapshot. Other Paperclip versions can differ; check their API before treating coverage as complete. This endpoint can be large on long-running instances.

## Source semantics tested

Source version: upstream commit [`640dee18029f7651d56ae0f1828d04228f9ab044`](https://github.com/paperclipai/paperclip/tree/640dee18029f7651d56ae0f1828d04228f9ab044), inspected September 2026.

- [Run liveness](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/server/src/services/run-liveness.ts) assigns states `advanced`, `completed`, `blocked`, `empty_response`, `plan_only`, `needs_followup`, or `failed`. It supplies `lastUsefulActionAt` only for `advanced`, `completed`, or `blocked` **when** concrete action evidence has a latest evidence timestamp. Consequently, state and timestamp are different observations.
- [Heartbeat persistence](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/server/src/services/heartbeat.ts) writes `inputTokens`, `cachedInputTokens`, and `outputTokens` from normalized usage. It writes `rawInputTokens`, `rawCachedInputTokens`, and `rawOutputTokens` from the adapter before normalization. For session-cumulative usage, normalization subtracts prior session totals; adapters declaring per-run usage pass through. Raw fields are not an additional token category.
- The [Codex adapter](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/adapters/codex-local/src/server/parse.ts) maps provider `input_tokens`, `cached_input_tokens`, and `output_tokens` directly. The [Claude adapter](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/adapters/claude-local/src/server/execute.ts) maps `input_tokens` and `cache_read_input_tokens` separately. The [Gemini adapter](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/adapters/gemini-local/src/server/parse.ts) maps `promptTokenCount` and `cachedContentTokenCount`. The [ACPX adapter utility](https://github.com/paperclipai/paperclip/blob/640dee18029f7651d56ae0f1828d04228f9ab044/packages/adapter-utils/src/acpx-engine/execute.ts) adds cache-write tokens to input and places cache-read tokens in cached input. These source mappings do not establish one safe cross-adapter rule for adding input and cached counts. This report therefore shows output tokens, not an invented combined token total.

For agent and model billing visibility, see [paperclip-cost-audit](https://github.com/georgenijo/paperclip-cost-audit). This report's additional operator decision is where to inspect repeated runs by source and liveness state. A timer × `empty_response` fixture is in the test suite; it is synthetic and says nothing about the prevalence of that combination on an operator's instance.

## Test

```sh
npm test
```

Tests use a synthetic fixture and a mocked GET request. They cover timer × `empty_response`, absent and unknown labels, separate marker counts, missing usage, unfinished runs, repeat-issue overlap, share-file privacy and the request contract. They do not assert a live instance's historical completeness.
