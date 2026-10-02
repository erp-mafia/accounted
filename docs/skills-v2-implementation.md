# Skills v2 implementation

Scope confirmed by Emil: full `dev_docs/skills_plan_v2.md`, excluding receipt hunting. Claude is the primary client; ChatGPT/Grok acceptance runs were explicitly waived. Work stays in `feat/contextual-ai-accounting`, with no push or publishing.

Worktree: `/home/emilm/Projekt/arcim/wt/contextual-ai-accounting`, based on `5ecb35e15`. The original checkout and `main` were not changed. Main has advanced separately since this branch was created; it has not been merged into this worktree.

## Delivery checklist

- [x] A implementation: generated public mirror, registry links, provider attribution, observed skill retrievals on proposals, live registry kill switch.
- [x] B implementation: company/team instructions, scoped MCP discovery and loading, `accounted_get_task` / `gnubok_get_task`, contextual handoff, `/skills`, and settings redirect.
- [x] C implementation: community bodies, shared Markdown validator, consent and frozen submissions, local reviewer tools, publication verification, withdrawal and honest review labels.
- [x] D decision: plugin remains conditional on demand, as specified. No Codex plugin was added.
- [x] Local verification: unit suite, staging SQL fixture, lint/type ratchets, guards, registry validation, skill generation and fixture-backed browser smoke checks.
- [ ] Live acceptance: the app is not deployed, the public mirror is not published, and the reviewer loop is not scheduled. No live Claude-to-ledger run has been performed.

## What is available locally

The shared handoff appears on the transaction inbox, VAT report, reconciliation/month close, year-end and payroll, as well as dashboard worklist tasks. It carries company identity, the selected period and account where applicable, distinct bank/skattekonto record IDs, and optional user instructions. Selections over 200 records fail visibly rather than being truncated. An empty explicit selection never means all records.

The dialog previews an editable, detailed prompt and the relevant catalog metadata. The AI gets current skill bodies from MCP, not a copied snapshot. Claude is first and preferred when connected; ChatGPT and Grok use the same copy/open-site flow. Claude Code and Codex can use the copied prompt in an MCP-connected session. Custom application deep links are not shipped without local verification; no accounting context is placed in an external URL.

`/skills` exposes Accounted workflows, catalog additions, private company/firm instructions and community entries. Company instructions and firm instructions are additive to existing agent profiles. Team instructions inherit into the firm's companies, but only firm administrators may edit them. Submitted text is immutable; withdrawal preserves its audit evidence. Sharing requests stay in the database until a human reviewer prepares a public PR.

Private MCP bodies require an authenticated, authorized tenant key with `agent:read`. Public workflow/catalog discovery remains anonymous. A killed registry atom disappears on the next load, including attempts to load its reference children. Instructions already present in a third-party chat cannot be recalled.

## Implementation decisions

- Reuse the existing explicit-copy handoff and clean external URLs. Context never travels in third-party URL parameters.
- Preserve OAuth key classification. Derive display attribution separately from the key name.
- Public catalog discovery remains anonymous; company tasks and private bodies require authentication and tenant authorization.
- Skills fetched over MCP are recorded with their body hash and registry version where available. Evidence comes from the durable event log, scoped to company, user, API key and session, over the last 24 hours, capped at 100 retrievals. Missing sessions, unavailable evidence and truncation are represented explicitly. This records retrieval, not proof that the model followed the instructions.
- Community instructions are opt-in and cannot grant authority to bypass existing write approval or accounting controls.
- The tools/list ceiling stays at 60,500 approximate tokens. Repeated list/load/briefing descriptions were shortened; no tool was demoted. Measured projections: gnubok 60,282; accounted 60,491.
- The deployed staging tier constraint already includes `product`. The migration adds `community` without replacing existing allowed tiers.
- Vendor acceptance tests are separate from implementation checks. Local development does not establish that every hosted AI client completes the workflow. ChatGPT/Grok runs are not a release gate for this implementation, per Emil's clarification.

## Fix from first principles

1. The gap is disconnected context: short prompts, client-specific plugin instructions and a read-only knowledge panel do not supply one consistent task and skill source to the app and MCP.
2. Reuse the existing handoff, onboarding connections, registry and pending operations. Keep one company/team skills table and one shared workflow source.
3. Contextual prompts plus server-fetched workflows serve existing AI clients with current knowledge. A separate AI prompt generator or automation engine would add cost and state without being needed for this plan.

## Verification evidence

- Full unit suite passed: 24,140 tests across 1,808 files, with 5 tests and 3 files skipped. Coverage includes MCP schemas, payload budget, namespace aliases, auth, API validation, scope guards, catalog loading, provenance, review lifecycle and the schema scanner.
- Type ratchet passed without changing its baseline: 533 pre-existing errors, zero added. ESLint: zero errors, 304 existing warnings. Guard baselines were not relaxed.
- Registry validator: 21 entries, 3 authors, zero failures. Skill-body generator/check: 108 atoms, no seed drift. Developer and firm community submissions exercise the same generator in isolated fixtures; no pretend public submission was created.
- The migration was applied only to erp-base staging (`metjnjrhvujscngnpzdv`). The exact rollback-only SQL fixture from `tests/pg/company-skills.sql` passed there: tenant isolation, firm inheritance, viewer/admin permissions, scope exclusivity, UTF-8 size cap, frozen submissions, withdrawal and auditing. The pg-real wrapper is committed; the local pg runner was not used, and no local database or Docker was started.
- Applied migration: `20260923211559_company_skills.sql` (first written as `20260917194716`, renamed before merge so it sorts after main's newest; the staging history row was renamed to match). Local SQL SHA-256 matched staging: `d79248a555b4960d6f3411f3b17477f53d0eae6ff22b97e672dba16155f42627`. Do not edit this applied migration.
- Read-only production-history check on September 17 found all 881 production migration versions locally. This branch's only additional SQL migration was the new staging-only migration. No production writes were performed.
- Browser smoke checks used the real new components, translations and styles with fixture API responses, not production data: Skills list, Claude-first handoff, exact scope/instructions, clipboard copy, Markdown rejection, editor save failure/retry and sharing consent UI. This was not an authenticated full-app or live AI-to-ledger test. A production Next.js build was not run.
- The public mirror script ran against a fresh local clone of `erp-mafia/swedish-accounting-agents`: 71 managed files changed, then `--check` reported zero drift. Nothing was pushed. The generator now includes all discovered Swedish skills, including e-invoicing, rather than freezing the old count of 11.

## Try it locally

1. Use this worktree and Node 22+. Its ignored `node_modules` symlink reuses the original checkout's dependencies; no dependencies were added. Run `npm run setup:extensions` if needed.
2. Supply staging configuration for this worktree using the project's existing environment setup. Do not blindly copy the original `.env.local`, which is treated as production. The new schema already exists on staging.
3. Start with `npm run dev -- --port 3017`. Sign into a staging company and open `/skills`. Create a private instruction, inspect its detail, edit it, and check it does not appear after switching to another unrelated company.
4. In the transaction inbox, choose a small batch and use the AI button. Inspect the company, period and both kinds of selected IDs. Add instructions, copy the prompt, and paste it into Claude connected to this same staging-backed app. A production connector cannot exercise unshipped local tools.
5. Verify `accounted_get_task`, private discovery/loading, staged proposals and the proposal's actor/skill source line. Approve only deliberately chosen sandbox operations. A prompt copy or opened chat must not mark work complete.
6. Check VAT, reconciliation, year-end and payroll handoffs. Check the old `/settings/assistant?view=skills` link redirects. Repeat the relevant UI checks in English.
7. For sharing, use synthetic text only: submit with consent, verify the frozen state, then withdraw. The app must not create a GitHub PR or claim immediate publication.

## Activation still required

- Emil: review/test the branch, reconcile it with current main, and decide when to merge/deploy. No push, PR, merge or production migration was performed by this session.
- Repository maintainer: configure `PUBLIC_SKILLS_SYNC_TOKEN` with narrowly scoped write access to the public mirror, review the first generated diff, then run the new workflow. The script itself never pushes; the workflow publishes only after activation on main or a deliberate manual invocation.
- Reviewer: invoke `.claude/skills/loop-skill-review/SKILL.md` locally on the agreed weekly cadence. It is implemented but not scheduled or exercised on a real submission. Use `npm run skills:admin -- --help`; credentials and the target project must be supplied explicitly. Production mutations need Emil's specific approval.
- Reviewer and human merger: inspect privacy/accounting content, run the existing compliance review, merge the registry PR, deploy its generated migration, then record publication. `skills:admin published` verifies the merged files, author/hash, live body and review date first. A withdrawn submission is disabled before its removal PR is prepared.
- Accounted maintainer: record first-party review dates only after a real full review. Existing undated skills correctly say that no verified date is recorded. Community dates describe publication review, not ongoing regulatory maintenance.
- Claude end-to-end acceptance remains a local/manual check for Emil. ChatGPT/Grok live tests were explicitly waived; no cross-provider completion promise is made.
