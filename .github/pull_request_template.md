## Change

<!-- Explain the concrete problem, resulting behavior, and any companion PR. -->

## Validation

<!-- List exact commands, results/counts, and applicable unit, frontend, API,
PostgreSQL integration, typecheck/build, and contract drift checks. Explain N/A. -->

## Playwright evidence

<!-- Required for user-visible changes and important integrated workflows.
Docs-only/internal-only changes: state why browser evidence is not applicable.
Do not leave sample PASS claims. Link committed, reviewed artifacts directly.
See AGENTS.md for minimum evidence by scope and the draft-only exception. -->

| Journey | Result | Evidence and what it proves |
| --- | --- | --- |
| <!-- workflow --> | <!-- PASS / FAIL / BLOCKED / N/A --> | <!-- screenshot, video, trace, machine-readable results --> |

- Browser and version:
- Desktop/mobile viewport:
- Frontend commit:
- Backend commit:
- Test environment:
- Data mode (deterministic fixture/test-chain or read-only live):
- Reproduction command:

<!-- Embed a representative screenshot and link short videos/traces where
required. For paired PRs, link shared evidence with exact tested commit SHAs.
Explain trace sanitization or why a safe trace cannot be committed. -->

## Remaining blockers and rollout

<!-- Record missing/failed evidence, limitations, migrations, and deployment
requirements. Important missing/failing browser journeys require draft status. -->

## Completion checklist

- [ ] Relevant tests and typecheck/build/contract checks passed (or N/A explained).
- [ ] Required Playwright journeys passed; otherwise this PR is draft with blockers listed.
- [ ] Required screenshots, videos, traces, and machine-readable results are linked (or N/A explained).
- [ ] Every artifact was reviewed for correctness, secrets, session data, and personal information.
- [ ] Exact changed files were reported before opening the PR.
