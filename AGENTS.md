# OnlyPump agent instructions

## Mandatory PR visual evidence policy

This permanent policy applies to every meaningful frontend, full-stack, trading,
market-data, wallet, auth, discovery, launch, and user journey PR in
`Dante9988/only-pump-me` and `Dante9988/Solana-sniper-moralis-api`.
It is part of Definition of Done, independent of the current phase.

For changes to user-visible behavior or an important integrated workflow, run
Playwright against the actual application and attach reviewed visual evidence
to the PR. Unit, component, API, database, and log checks remain useful but do not
alone verify a user-facing workflow. Manually composed screenshots are not
workflow evidence. Do not replace the production data path with fixtures and
claim that the real integration passed.

### Evidence required by scope

| Change | Minimum evidence |
| --- | --- |
| Documentation only | No Playwright requirement |
| Pure backend internals without browser-visible effects | Relevant API/integration results may suffice; explain applicability |
| Small UI change | Playwright screenshot and relevant browser test |
| Important user workflow | Screenshots, concise Playwright video, and Playwright assertions |
| Critical realtime, trading, auth, or chart flow | Screenshots, video, trace, and deterministic integrated assertions |

Include machine-readable results and explain what each artifact proves. Combine
read-only live observations with deterministic assertions where appropriate;
label fixture/test-chain, injected failures, and live data accurately. Backend
changes affecting the UI require evidence from the actual frontend; paired PRs
may link to one shared evidence set with both tested commits identified.

### What to record

Capture meaningful checkpoints and the complete important journey:

- Market terminal: loaded terminal, historical candles, genuine live changes,
  interval switching, recent trades, chart remaining mounted, and no browser error.
- Screener: filter drawer, applied filters, resulting list, URL state, reset,
  and mobile behavior.
- Trading: quote, review, wallet approval/signing, submission, confirmed/reverted
  state, and portfolio/position update, when applicable and authorized.
- Auth: sign in, signed-in state, private data, and sign out.
- Launch: form, validation, preview, wallet/transaction step when applicable,
  and final state.
- Responsive UI: desktop and relevant mobile viewports.

For dynamic behavior, save the shortest Playwright video that demonstrates the
important sequence from beginning to end. This includes live charts, realtime
updates, pan/zoom/drag, drawers, transaction states, wallet flows, and transitions
that still images cannot prove. Do not speed up or edit a recording in a way that
misrepresents latency or continuity; describe any excerpt.

Save Playwright traces when useful for reproduction, and always for race/flaky
fixes, realtime/WebSocket reconnect, history recovery, wallet/trading integration,
and failures where network calls matter.

### Artifact handling

Store safe evidence in `docs/<phase>/playwright/` or an equivalent documented
location. Use meaningful names, such as `01-explore.png`, `02-filter-open.png`,
`03-filtered-results.png`, `live-candle-before.png`, `live-candle-after.png`,
`mobile-terminal.png`, `live-chart.webm`, and `live-chart-trace.zip`.

Review every screenshot, video, trace, and result before committing. Never expose
private keys, passwords, API keys, access tokens, authorization headers, session
cookies, wallet secrets, or personal test-user information. Trace review must
include network bodies, headers, URLs, storage, DOM snapshots, and embedded files;
scanning just the archive filename is insufficient. Keep credential entry out of
recordings. Sanitize sensitive traces or supply a sanitized alternative; if a
trace cannot safely be committed, document why and what evidence replaces it.
Do not use a blanket ignore rule as a substitute for supplying required evidence.

### PR body

Use `.github/pull_request_template.md`. Every relevant PR must contain the exact
section heading `## Playwright evidence` and a table:

| Journey | Result | Evidence |
| --- | --- | --- |
| Changed workflow | PASS / FAIL / BLOCKED | Direct screenshot, video, trace, and results links; what each proves |

Use repository-relative artifact links where they resolve correctly. For PR
renderers or evidence in the companion repository, use working commit-pinned
links. Embed a representative screenshot when helpful. A filesystem path that
reviewers cannot access is not an attached artifact.

State browser/version, viewport, frontend commit, backend commit, test environment,
data mode (fixture/test-chain or read-only live), exact commands, result counts,
and remaining blockers. Do not label unavailable evidence as PASS.

### Completion gate

Before opening a non-draft PR or marking a draft ready:

1. Run relevant unit tests.
2. Run backend API/integration/PostgreSQL tests where applicable.
3. Run frontend tests where applicable.
4. Run relevant TypeScript/typecheck/build and contract drift checks.
5. Run the important integrated Playwright journeys against the actual app.
6. Review screenshots, videos, traces, and results for correctness and secrets.
7. Commit safe evidence and link directly to it in the PR body.
8. Report the exact changed files to the user before opening the PR.

A missing or failing important Playwright journey blocks a non-draft PR. If a PR
is intentionally opened as a draft, name the missing evidence and blocker
explicitly. A policy/docs-only PR does not need fabricated browser evidence.

If Playwright exposes a real defect, fix it or report the blocker. Never hide the
failure, weaken an assertion, or remove a test just to make CI green. Retain safe
failure evidence with its status clearly labeled. Passing a browser journey does
not waive other phase-specific verification gates.
