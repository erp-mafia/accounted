#!/usr/bin/env node
/**
 * Ratchet guard against post-audit antipatterns.
 *
 * The audit found two repository-wide problems that are being remediated in
 * dedicated campaigns (A1 = route auth/MFA, D1 = money rounding). Those touch
 * hundreds of sites and won't land in one PR: so this guard makes sure the
 * count can only go DOWN, never up, while the migrations are in flight.
 *
 * Checks:
 *   1. raw-route-auth : an `app/api/**\/route.ts` that calls
 *      `supabase.auth.getUser()` directly instead of going through
 *      `requireAuth()` / `withRouteContext()` (the only guards that enforce
 *      MFA AAL2 on hosted). Judged per exported handler, not per file: a
 *      wrapped PATCH next to a hand-rolled DELETE in the same file is still
 *      a violation (that exact shape hid two MFA bypasses until 2026-08-26).
 *      Tracked as a file-set so a NEW offending route fails CI even if an
 *      old one was fixed in the same PR.
 *   2. naive-ore-round: `Math.round(x * 100) / 100`, which is subtly wrong on
 *      exact-half values (see lib/money.ts `roundOre`). Tracked as a count.
 *      The canonical rounding modules are excluded.
 *   3. direct-jel-insert: a file that inserts into `journal_entry_lines`
 *      outside the sanctioned writers. During the dimensions dual-write window
 *      every line writer must derive cost_center/project via
 *      lineDimensionColumns() from the dimensions JSONB map
 *      (lib/bookkeeping/dimension-resolver.ts): a new direct insert site can
 *      silently diverge the mirror columns. Tracked as a file-set.
 *   3b. ledger-scanning-report: a statement generator under lib/reports or
 *      lib/bokslut that aggregates `journal_entry_lines` itself instead of
 *      going through generateTrialBalance. Aggregating raw lines means
 *      remembering, per report, that the resultatavslut posts the mirror image
 *      of every P&L account into 2099 inside the same fiscal period. Three
 *      reports forgot (årsredovisning 2026-07-23, INK2R and NE-bilaga
 *      2026-07-29) and each read ZERO revenue for a closed year while the
 *      balance sheet still tied out, so nothing warned. generateTrialBalance
 *      now requires an explicit closingEntry mode, which turns the decision
 *      into a compile error; this guard keeps new reports on that path.
 *      Tracked as a file-set. Voucher/line LISTINGS are sanctioned in
 *      LEDGER_SCAN_SANCTIONED: they have no closingEntry decision to make.
 *   3c. direct-invoice-payment-insert: a file that inserts into
 *      `invoice_payments` or `supplier_invoice_payments` outside
 *      lib/invoices/invoice-payment-row.ts and
 *      lib/invoices/supplier-invoice-payment-row.ts. Five hand-built inserts
 *      each computed their own `amount`, and the bank-match ones stored the
 *      cash received instead of the amount applied to the invoice, so a
 *      whole-krona overshoot absorbed on 3740 made the row exceed the
 *      receivable (#2250). recordInvoicePaymentRow() and
 *      recordSupplierInvoicePaymentRow() are the writers. Tracked as a
 *      file-set, no baseline: the count is 0 today.
 *   3d. consent-token-access: a read of a token column or any write of
 *      `provider_consent_tokens` outside lib/providers/consent-tokens.ts, the
 *      module that seals provider tokens at rest (accounted#58).
 *      Implementation in consent-token-access.mjs. No baseline: 0 today.
 *   4. pinned-dep    : a dependency pinned to an exact version (PINNED_DEPS)
 *      whose package.json spec or locked version drifted from the pin. Guards
 *      against a repeat of the @anthropic-ai/bedrock-sdk 0.32.0 prod outage
 *      (empty Bedrock stream). No baseline: any drift is a hard failure.
 *   5. raw-user-error: raw caught-error messages passed to API response fields,
 *      client error state, or toast fields. Engine, database, and upstream
 *      messages must pass through getErrorMessage() or errorResponse().
 *   5b. hand-read-api-error: client code that reads `body.error` by hand instead of
 *      getErrorMessage(body, { locale, fallback }). Rationale and allowlist in
 *      hand-read-api-error.mjs. No baseline: the count is 0 today.
 *   6. sek-labelled-amount: a single-argument formatCurrency() call on a value
 *      read off a record the same file reads `.currency` from, which prints a
 *      foreign amount with the SEK symbol. Implementation and rationale in
 *      format-currency-sek-label.mjs. No baseline: the count is 0 today.
 *   7. extension-route guards: physical routes under app/api/extensions/<id>/
 *      (the sanctioned core-build carve-out for crons/OAuth callbacks) may
 *      only import their OWN extension (hard fail, 0 today) and must gate on
 *      extensionRegistry.get('<id>') so a disabled extension never exposes a
 *      live surface (allowlisted file-set, may only shrink). Implementation
 *      and rationale in extension-route-guards.mjs.
 *   8. hand-rolled-invariant: a shared format rule (BAS account number, ISO
 *      date, four-digit fiscal year) spelled out inline instead of imported
 *      from lib/invariants/. The BAS account rule was written out at 20 sites
 *      and the ISO date rule at 68, with error messages that differed per site;
 *      the four Skatteverket-bound org-number paths disagreed outright about
 *      what "valid" meant, which is the kind of drift a customer only discovers
 *      when a filing fails at the deadline. Tracked as a count.
 *   9. leaky-supabase-client: server code importing supabase-js's `createClient`
 *      as a value instead of `createServiceRoleClient()`. The default
 *      `autoRefreshToken: true` starts a 30 s setInterval that is never
 *      cleared; `unref()` keeps the process exitable but not the timer
 *      collectable, so each constructed client retains its whole request scope.
 *      Killed a self-hosted instance after 42 idle hours (2026-08-13). No
 *      baseline: the count is 0 today.
 *   10. off-ladder-radius: a border-radius class outside the locked ladder
 *      (pill / rounded-xl overlays / rounded-lg surfaces / rounded-sm leaves;
 *      see .claude/rules/design.md). Before the 2026-08 migration the UI had
 *      seven radii in circulation (4/5/6/8/12/16px + pill) and one toolbar row
 *      could mix four of them. `rounded-md`, bare `rounded`, `rounded-2xl`+
 *      and arbitrary `rounded-[Npx]` are dead vocabulary in app/ and
 *      components/. No baseline: the count is 0, any new one is a hard
 *      failure.
 *  10. folded-public-flag: `process.env.NEXT_PUBLIC_X === 'true'` compared in
 *      place. The Docker image bakes sentinels that docker-entrypoint.sh
 *      substitutes at container start; an in-place comparison is constant-
 *      folded and dead-code-eliminated at build time, erasing both the name
 *      and the sentinel, so the flag is permanently false however the operator
 *      configures it. Every Docker self-host consequently ran with the
 *      entitlement paywall live (diagnosed 2026-08-17). Read flags as values
 *      via lib/env/public-flags. No baseline: the count is 0, any new one is
 *      a hard failure.
 *   11. dialog-overflow-risk: patterns that make a dialog scroll sideways.
 *      (a) a bare `1fr` grid track inside grid-cols-[...] in a file that
 *      imports DialogContent/SheetContent: per the CSS Grid spec a bare fr
 *      track's implicit minimum is auto (its content's min-content size), so
 *      the track refuses to shrink below its content and overflows the dialog
 *      (StrikeLinesDialog and CorrectionEntryDialog shipped this, fixed
 *      2026-08-19; TransactionBookingDialog had the safe minmax(0,1fr) idiom
 *      all along). (b) whitespace-nowrap inside a <DialogContent>/
 *      <SheetContent> JSX region outside DIALOG_NOWRAP_ALLOWED (numeric
 *      columns inside their own overflow-x-auto wrapper are fine and
 *      allowlisted per file). (c) a hand-rolled absolute overlay forcing
 *      min-w-[>=20rem] in a file that never portals anything to
 *      document.body: DialogContent's overflow-y-auto computes overflow-x to
 *      auto as well, so an oversized non-portaled panel grows the dialog a
 *      horizontal scrollbar instead of repositioning (AccountCombobox's
 *      dropdown pre-2026-08-19). Tracked as a per-file baseline set that may
 *      only shrink.
 *   12. ambiguous-embed: a PostgREST `.select()` that embeds a table joined to
 *      the from-table by more than one foreign key, without naming the
 *      relationship. PostgREST answers PGRST201 instead of picking one, and
 *      neither a mocked-Supabase unit test (a mock never resolves a
 *      relationship) nor a pg-real test (it bypasses PostgREST) can see that,
 *      so a static guard is the only thing that catches the class. Two sites
 *      shipped the same journal_entries -> fiscal_periods embed: the nightly
 *      underlag cron (fixed 2026-08-31, ~60 period-lock trigger rejections a
 *      night) and supplier-invoice underlag anchoring, which swallowed the
 *      error and therefore never anchored a single document in production.
 *      The ambiguous pairs are derived from supabase/migrations; both hint
 *      forms PostgREST accepts count as disambiguated. Implementation and
 *      rationale in ambiguous-embed.mjs. No baseline: the count is 0 today.
 *   13. ui-uniformity: the design-system rules that drifted because nothing
 *      checked them (button heights and spinners, motion durations and easing,
 *      Tailwind shadows, faded borders, hover tints, raw colours, native
 *      dialogs, focus rings, off-scale text, decorative animation). A
 *      2026-09-24 scan found the one guarded design rule (radius ladder) clean
 *      and every unguarded one drifted. Implementation, rule list and
 *      rationale in ui-uniformity.mjs. No baseline: the count is 0 today.
 *   14. table-without-grant: a migration that creates a public table, view or
 *      sequence without granting it to service_role and authenticated (or a
 *      reasoned `-- no-grant:` waiver), a serial column without a sequence
 *      grant, or a bulk grant to the API roles. Since 20260929220000 (and on
 *      every Supabase project from 2026-10-30) a new table gets no grants by
 *      default, so it answers 42501 to every supabase-js client. The
 *      migrations written before that relied on the old default and are
 *      grandfathered as a file set that never grows. Implementation and
 *      rationale in table-without-grant.mjs.
 *   15. static-init-import: a server entry point (App Router route, page,
 *      layout or other file convention, 'use server' module, or the root
 *      instrumentation/middleware/proxy file) whose import graph, static or
 *      dynamic, reaches lib/init or the extension list it loads other than
 *      through instrumentation.ts's dynamic import of lib/init, or a
 *      'use client' module that reaches lib/initialized.ts (the event bus's
 *      wait for the loader). instrumentation.ts registers the loader of
 *      lib/init when the server boots; any other import of it compiles every
 *      extension into that entry again (the bundler follows a dynamic import
 *      too), and a client module that reaches the bus ships server state to
 *      the browser. Implementation and rationale in static-init-import.mjs.
 *      No allowlist. Counted beside it, lazy-init-reach: server entries whose
 *      graph reaches lib/init following dynamic imports, each of which
 *      compiles every extension; instrumentation.ts alone since 2026-10-16.
 *      May only go down, and --update cannot raise it.
 *   16. limit-above-page: a PostgREST `.limit(N)` with N above 1000, or a
 *      reader's `{ limit: N }` option above 1000. max-rows
 *      answers it with 1000 rows and no error, so the written cap is a silent
 *      1000 (the Arkiv graph, facts and lint, the counterparty resolver and the
 *      pärm's attachments all summed or matched over a cut list, 2026-10).
 *      Page with fetchAllRows (its maxRows keeps a deliberate cap) or read an
 *      aggregate. Implementation and rationale in limit-above-page.mjs.
 *      Allowlisted file-set, may only shrink.
 *   17. utc-today: "today", this month or this year not read from the one
 *      definition (`new Date().toISOString().slice(0, 10)` and its twins, the
 *      Date getters, `date || new Date()`, wrappers, also read off a `now`
 *      variable or a horizon derived from one), which is yesterday in Sweden
 *      between midnight and 01:00/02:00. Use todayIsoStockholm() or
 *      stockholmYearMonth() from lib/dates/iso, with addDaysIso / addMonthsIso
 *      for horizons.
 *      Implementation and rationale
 *      in utc-today.mjs. Allowlisted file-set, may only shrink.
 *   18. unsigned-provider-names: the name of a provider whose contract is not
 *      signed yet, anywhere in the change against the merge base (added
 *      lines and file paths; committed, uncommitted and untracked). The
 *      names come from the UNSIGNED_PROVIDER_NAMES secret, never from the
 *      repository, so this check names nothing. No baseline: any hit is a
 *      hard failure. Without the secret, or without a merge base (a shallow
 *      CI checkout), it is skipped with a note; the provider-names workflow
 *      runs it with full history and also over the PR text. Implementation
 *      and rationale in unsigned-provider-names.mjs.
 *   19. functiondef-patch: a migration that calls pg_get_functiondef(), the
 *      read half of patching a function body with replace() instead of
 *      stating it. 19 migrations did, and 24 functions ended up in no file.
 *      Grandfathered as a file set that never grows. Implementation and
 *      rationale in functiondef-patch.mjs.
 *   20. hand-written-sie-extensions: a SIE extension list written out by hand
 *      (a `\.(se|sie` regex alternation or a `.se,.sie` accept literal)
 *      instead of imported from lib/import/sie-file-extensions.ts. Every copy
 *      drifted once: `.si` refused by the dashboard (#2546), then `.si` and
 *      extensionless files refused by the onboarding SIE step while every
 *      other surface took `.si` (accounted#32). No baseline: the count is 0.
 *   21. decision-log: a dated line appended to DECISIONS.md, or a decision
 *      file under docs/decisions/YYYY-MM/ not named and dated as a search by
 *      date expects. A decision is a file of its own, because merge requests
 *      that append to one shared file conflict. No allowlist. Implementation
 *      and rationale in decision-log.mjs.
 *   22. bas-account-literal: a BAS account number ('1930') or account-prefix
 *      check (acc.startsWith('19'), /^19\d{2}$/) outside the SE pack
 *      territory. Accounted is going multi-country with Sweden as jurisdiction
 *      pack one (docs/decisions/2026-09.md, 2026-09-30); every such site is a place the next
 *      country's chart cannot reach. Per-file count ratchet: a file's count
 *      may only go down, a new file may not introduce one. Implementation,
 *      territory list and rationale in jurisdiction-welds.mjs.
 *   23. sek-literal: a comparison against the literal 'SEK' outside the
 *      currency-conversion code; the ledger currency becomes a pack setting.
 *      Per-file count ratchet, same rules and module as 22.
 *   24. kernel-import: lib/bookkeeping/engine.ts or lib/core/** importing an
 *      outer business module (invoices, reports, bokslut, import, api, ...).
 *      Tracked as (file, module) edges; a new edge fails. Same module as 22.
 *   25. script-init-condition: a script that loads lib/init (it calls
 *      registerScriptInitLoader()) run with tsx somewhere the repository
 *      writes it down (package.json, a doc, a usage comment, a shebang, a
 *      spawn or fork) without the react-server condition, or a script that
 *      calls registerInitLoader() itself. Without the condition lib/init
 *      cannot load (server-only throws), and until 2026-10-16 every such
 *      script posted with each event reaching no handler; the helper now
 *      stops it at start. No allowlist. Implementation and rationale in
 *      script-init-condition.mjs.
 *   26. posting-port-bypass: code outside src/lib/posting (and the engine's
 *      own files) that imports one of the engine's or the storno service's
 *      posting functions, so its verifikat records no business event (step 3
 *      of the posting port). Tracked as (file, name) edges; a new edge fails,
 *      and --update only ever drops edges. The SIE import job's writers are
 *      allowed for good, with their reason, in PERMANENT_ALLOWLIST.
 *      Implementation, the classified surface and rationale in
 *      posting-port-bypass.mjs.
 *   27. swedish-ui-literal: Swedish text written into a UI file (JSX text,
 *      a placeholder, a toast title, a label map) instead of a message key,
 *      so it renders in Swedish under the English locale (crm#1356). Per-file
 *      count ratchet, same rules as 22: a file's count may only go down, a
 *      new file may not introduce one. Surfaces that stay Swedish by rule are
 *      listed with their reason in SWEDISH_BY_DESIGN. Implementation and
 *      rationale in swedish-ui-literal.mjs.
 *   28. duplicate-block: a block of 10+ meaningful lines copied between two
 *      files under src (tests and generated files excluded). Ratchet per
 *      file pair on shared lines: a new pair fails, a pair may not grow. The
 *      failure names both locations. Implementation and rationale (GitClear
 *      2026: duplicated blocks +81%) in duplicate-blocks.mjs.
 *   29. error-masking: an error caught and dropped without a trace (empty
 *      catch, a catch that only returns, `.catch(() => {})` / `=> null`).
 *      Per-file count ratchet. Implementation and exemptions in
 *      error-masking.mjs.
 *   30. lines-inner-embed: a journal_entry_lines read filtered through a
 *      `journal_entries!inner` embed. PostgREST plans it from the line side
 *      (every tenant's lines) and it ran into the statement timeout again and
 *      again. Read entry first (lib/bookkeeping/entry-lines.ts) or call a
 *      ledger RPC. Allowlisted file-set, may only shrink. Implementation and
 *      rationale in lines-inner-embed.mjs.
 *   31. mcp-bare-error: a bare `throw new Error(` in the MCP server's own
 *      source (src/extensions/general/mcp-server, tests excluded). It reaches
 *      the agent as UNKNOWN_ERROR, "Något gick fel. Försök igen.": retry
 *      advice for a call that fails the same way until something changes. The
 *      2026-10 session autopsy found 303 agent sessions in 30 days refused
 *      that way, 38 of them sending the same call three times or more. Throw
 *      a coded refusal instead (codedRefusal, badArgument or
 *      fieldValidationError from lib/errors/refusal, with a registry code).
 *      Tracked as a count.
 *   32. one-definition: a line that writes a business rule by hand when the
 *      rule already has one definition. One file per rule in
 *      scripts/checks/one-definition/, each naming its home and why it has
 *      one. Implementation and rationale in one-definition.mjs. Allowed
 *      sites may only shrink.
 *   33. migration-version: two files in supabase/migrations with one version,
 *      which aborts the production push after the merge. Implementation and
 *      rationale in migration-version.mjs. No baseline: any hit fails.
 *
 * Usage:
 *   node scripts/checks/no-new-antipatterns.mjs            # check (CI)
 *  11. direct-ai-client: a file outside lib/ai that imports createAiClient,
 *      calls `.messages.create/stream(` on an Anthropic client, or imports
 *      the Vercel AI SDK. Every model call goes through getAiService() so the
 *      backend (Bedrock on hosted, a Swedish OpenAI-compatible endpoint on a
 *      sovereign self-host) stays an environment decision. Allowlist of the
 *      pre-abstraction call sites in this file, may only shrink.
 *
 *   node scripts/checks/no-new-antipatterns.mjs --update   # re-baseline after a migration ratchets the count down
 *
 * Exit code 1 if either check regressed past its baseline.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { findSekLabelledFxAmounts } from './format-currency-sek-label.mjs'
import { findRawReferenceFetches } from './raw-reference-fetch.mjs'
import { findHandReadErrors, HAND_READ_ERROR_HINT } from './hand-read-api-error.mjs'
import { findUtcTodaySites, UTC_TODAY_ALLOWED } from './utc-today.mjs'
import { findLiteralLegalForms } from './literal-legal-form.mjs'
import { findHandBuiltVoucherRefs } from './hand-built-voucher-ref.mjs'
import { findClientNodeBuiltins } from './client-node-builtin.mjs'
import { findClientServerOnlyReachers } from './client-server-only.mjs'
import { findConsentTokenAccess, CONSENT_TOKEN_HINT } from './consent-token-access.mjs'
import { findOneDefinitionFindings, loadOneDefinitionRules, ONE_DEFINITION_HINT } from './one-definition.mjs'
import { findDuplicateMigrationVersions, MIGRATION_VERSION_HINT } from './migration-version.mjs'
import { findAmbiguousEmbeds } from './ambiguous-embed.mjs'
import { findUiUniformityFindings, UI_UNIFORMITY_HINTS } from './ui-uniformity.mjs'
import { findTablesWithoutGrant, grandfatheredFiles, grantHint } from './table-without-grant.mjs'
import { findFunctiondefPatches, FUNCTIONDEF_PATCH_HINT } from './functiondef-patch.mjs'
import { findDecisionLogFindings, DECISION_LOG_HINT } from './decision-log.mjs'
import { findScriptInitConditionFindings, SCRIPT_INIT_CONDITION_HINT } from './script-init-condition.mjs'
import {
  findExtensionRouteFindings,
  UNGATED_EXTENSION_ROUTES,
} from './extension-route-guards.mjs'
import { findInitReach } from './static-init-import.mjs'
import { findLimitsAbovePage, LIMIT_ABOVE_PAGE_ALLOWED } from './limit-above-page.mjs'
import { findLinesInnerEmbeds, LINES_INNER_EMBED_ALLOWED } from './lines-inner-embed.mjs'
import { findLocalTestMocks, LOCAL_SUPABASE_CHAIN_ALLOWED } from './local-test-mock.mjs'
import {
  checkWorkingChange as checkUnsignedProviderNames,
  formatFinding as formatProviderNameFinding,
  HINT as PROVIDER_NAME_HINT,
  NO_NAMES_NOTE as PROVIDER_NAMES_UNSET_NOTE,
} from './unsigned-provider-names.mjs'
import {
  findJurisdictionWelds,
  countByFile,
  compareFileCounts,
  compareFileEdges,
} from './jurisdiction-welds.mjs'
import {
  findPostingPortBypasses,
  countEdges,
  frozenBypassBaseline,
  PERMANENT_ALLOWLIST,
  POSTING_PORT_BYPASS_HINT,
} from './posting-port-bypass.mjs'
import { findSwedishUiLiterals, SWEDISH_UI_LITERAL_HINT } from './swedish-ui-literal.mjs'
import { findDuplicateBlocks, formatDuplicateBlock, WINDOW as DUPLICATE_WINDOW } from './duplicate-blocks.mjs'
import { findErrorMasking, formatErrorMasking } from './error-masking.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE_ROOT = path.join(ROOT, 'src')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'checks', 'antipatterns-baseline.json')

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage'])
// The sanctioned home of the öre-round implementation: must not count against itself.
const ROUND_EXEMPT = new Set(['lib/money.ts', 'lib/bokslut/rounding.ts'])

const RAW_AUTH_RE = /\.auth\.getUser\(/
// Match the guard at its CALL site, not a bare import, so a file that imports
// withRouteContext but still hand-rolls getUser() on another handler is still
// flagged. withRouteContext is usually called with a generic (`withRouteContext<…>(`),
// so accept either `<` or `(` after the name.
const GUARD_RE = /requireAuth\(|withRouteContext[<(]/
// Each top-level `export` starts a new segment, so every handler (and the
// preamble of shared helpers above the first export) is judged on its own.
// Without this split, one wrapped handler exempted the whole file.
const TOP_LEVEL_EXPORT_RE = /^(?=export\s)/m
const NAIVE_ROUND_RE = /Math\.round\([^\n]*\*\s*100\s*\)\s*\/\s*100/

// 8. hand-rolled-invariant. Shared format contracts live in lib/invariants/
// (account number, ISO date, four-digit fiscal year, org number). Before that
// module the BAS account rule was written out at 20 sites and the ISO date rule
// at 68, with error messages that differed per site, and the four
// Skatteverket-bound org-number paths did not agree on what "valid" meant.
//
// Only the two unambiguous regex families are counted. An org-number
// digit-strip is too varied in shape to match reliably by regex; the
// cross-path test in lib/invariants/__tests__/org-number-cross-path.test.ts is
// the guard on that one instead.
const HAND_ROLLED_INVARIANT_RES = [
  // /^\d{4}$/ or /^[0-9]{4}$/  → accountNumberSchema or fiscalYearSchema
  /\/\^(?:\\d|\[0-9\])\{4\}\$\//,
  // /^\d{4}-\d{2}-\d{2}$/      → isoDateSchema or ISO_DATE_RE
  /\/\^(?:\\d|\[0-9\])\{4\}-(?:\\d|\[0-9\])\{2\}-(?:\\d|\[0-9\])\{2\}\$\//,
]
// The sanctioned home of these rules: must not count against itself.
const INVARIANT_EXEMPT_PREFIX = 'lib/invariants/'

function walk(dir, exts, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.well-known') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, exts, out)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full)
    }
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/').replace(/^src\//, '')

/** True when any handler segment calls getUser() without an MFA-enforcing guard. */
function handRollsRouteAuth(src) {
  return src
    .split(TOP_LEVEL_EXPORT_RE)
    .some((segment) => RAW_AUTH_RE.test(segment) && !GUARD_RE.test(segment))
}

/** Route files that hand-roll auth instead of the MFA-enforcing guard. */
function findRawRouteAuth() {
  const apiDir = path.join(SOURCE_ROOT, 'app', 'api')
  return walk(apiDir, ['route.ts'])
    .filter((f) => handRollsRouteAuth(fs.readFileSync(f, 'utf8')))
    .map(rel)
    .sort()
}

// Sanctioned journal_entry_lines insert sites. engine/storno write mirrors via
// dimension-resolver; sie-import and sandbox seed write neither dims nor
// mirrors (DB defaults keep them consistent).
const JEL_INSERT_SANCTIONED = new Set([
  'lib/bookkeeping/engine.ts',
  'lib/core/bookkeeping/storno-service.ts',
  'lib/import/sie-import.ts',
  'app/api/sandbox/seed/route.ts',
])
// Matches an insert CHAINED on the lines table (`.from('journal_entry_lines').insert(`,
// with optional whitespace/newlines in the chain): select-only readers don't count.
const JEL_INSERT_CHAIN_RE = /\.from\(\s*['"]journal_entry_lines['"]\s*\)\s*\.\s*(insert|upsert)\(/

/** Files that insert into journal_entry_lines outside the sanctioned writers. */
function findDirectJelInserts() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  return files
    .filter((f) => {
      const r = rel(f)
      if (JEL_INSERT_SANCTIONED.has(r)) return false
      if (r.includes('__tests__/') || r.endsWith('.test.ts')) return false
      return JEL_INSERT_CHAIN_RE.test(fs.readFileSync(f, 'utf8'))
    })
    .map(rel)
    .sort()
}

// The one writer of each payment table: recordInvoicePaymentRow() and
// recordSupplierInvoicePaymentRow() own the field semantics (amount = applied
// to the invoice, never the cash received) and require a link basis.
const INVOICE_PAYMENT_INSERT_SANCTIONED = new Set([
  'lib/invoices/invoice-payment-row.ts',
  'lib/invoices/supplier-invoice-payment-row.ts',
])
const INVOICE_PAYMENT_INSERT_CHAIN_RE =
  /\.from\(\s*['"](?:supplier_)?invoice_payments['"]\s*\)\s*\.\s*(insert|upsert)\(/

/** Files that insert into a payment table outside its sanctioned writer. */
function findDirectInvoicePaymentInserts() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  return files
    .filter((f) => {
      const r = rel(f)
      if (INVOICE_PAYMENT_INSERT_SANCTIONED.has(r)) return false
      if (r.includes('__tests__/') || r.endsWith('.test.ts')) return false
      return INVOICE_PAYMENT_INSERT_CHAIN_RE.test(fs.readFileSync(f, 'utf8'))
    })
    .map(rel)
    .sort()
}

// The one list of SIE file extensions (accounted#32). A hand-written copy is a
// regex alternation of two SIE extensions (`\.(se|sie`, `\.(sie|se|si`) or an
// accept-style literal (`".se,.sie"`); the shared module derives both.
const SIE_EXTENSIONS_HOME = 'lib/import/sie-file-extensions.ts'
const HAND_WRITTEN_SIE_EXTENSIONS_RES = [
  /\\\.\((?:se|sie|si)\|(?:se|sie|si)\b/i,
  /['"`]\.(?:se|sie|si),\s*\.(?:se|sie|si)\b/i,
]

/** Files that spell out the SIE extension list instead of importing it. */
function findHandWrittenSieExtensions() {
  const files = ['lib', 'app', 'components', 'extensions'].flatMap((dir) =>
    walk(path.join(SOURCE_ROOT, dir), ['.ts', '.tsx']),
  )
  return files
    .filter((f) => {
      const r = rel(f)
      if (r === SIE_EXTENSIONS_HOME || r.includes('__tests__/') || r.endsWith('.test.ts')) return false
      const src = fs.readFileSync(f, 'utf8')
      return HAND_WRITTEN_SIE_EXTENSIONS_RES.some((re) => re.test(src))
    })
    .map(rel)
    .sort()
}

// The one module allowed to import supabase-js's createClient as a value: it
// is the wrapper that applies SERVER_AUTH_OPTIONS.
const LEAKY_CLIENT_SANCTIONED = new Set(['lib/supabase/service-client.ts'])
const SUPABASE_JS_IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@supabase\/supabase-js['"]/g
// A namespace import hands over the whole module, so `sb.createClient(...)` is
// reachable without ever naming it in the import. Treat any value-namespace
// import as leaky rather than trying to track member access.
const SUPABASE_JS_NAMESPACE_RE =
  /import\s+(type\s+)?\*\s+as\s+\w+\s+from\s*['"]@supabase\/supabase-js['"]/g

/**
 * Files that import supabase-js's `createClient` as a VALUE instead of going
 * through createServiceRoleClient().
 *
 * `autoRefreshToken` defaults to true, and auth-js starts the 30 s refresh
 * ticker unconditionally off-browser. The ticker calls unref(), so the process
 * still exits and nothing fails in tests or on Vercel, but unref does not make
 * a timer collectable: it stays a GC root for its callback and retains the
 * client plus the whole request scope around it. A self-hosted instance died of
 * heap exhaustion after 42 idle hours this way (2026-08-13), holding 445
 * request graphs and ~1050 Timeouts in the 30 000 ms bucket.
 *
 * Both named (`{ createClient }`) and namespace (`* as sb`) value imports count:
 * the latter reaches createClient through member access without naming it.
 *
 * Type-only imports are fine; so is the browser client, which needs the ticker
 * and is built on @supabase/ssr's createBrowserClient anyway.
 */
function findLeakySupabaseClients() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  return files
    .filter((f) => {
      const r = rel(f)
      if (LEAKY_CLIENT_SANCTIONED.has(r)) return false
      if (r.includes('__tests__/') || r.endsWith('.test.ts')) return false
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(SUPABASE_JS_IMPORT_RE)) {
        const [, typeOnly, bindings] = m
        if (typeOnly) continue
        const bindsCreateClient = bindings
          .split(',')
          .map((b) => b.trim())
          .some((b) => b === 'createClient' || b.startsWith('createClient as'))
        if (bindsCreateClient) return true
      }
      for (const m of src.matchAll(SUPABASE_JS_NAMESPACE_RE)) {
        if (!m[1]) return true
      }
      return false
    })
    .map(rel)
    .sort()
}

// Statement generators that legitimately read journal_entry_lines directly:
// the trial-balance stack itself, and the reports whose whole job is to list
// vouchers or lines rather than to aggregate a fiscal year's balances.
const LEDGER_SCAN_SANCTIONED = new Set([
  // The shared balance source and its helpers.
  'lib/reports/trial-balance.ts',
  'lib/reports/opening-balances.ts',
  // Voucher/line listings: they must show the ledger as posted, closing
  // verifikat included, so there is no closingEntry decision to get wrong.
  'lib/reports/general-ledger.ts',
  'lib/reports/journal-register.ts',
  'lib/reports/latest-vouchers.ts',
  'lib/reports/source-lines.ts',
  'lib/reports/sie-export.ts',
  'lib/reports/full-archive-export.ts',
  // Aggregate their own dimension-tagged or month-bucketed slice, and each
  // carries an explicit year-end exclusion of its own.
  'lib/reports/dimension-pnl.ts',
  'lib/reports/monthly-breakdown.ts',
  // Tax balances/expenses come from generateTrialBalance; only mixed 2510
  // counterpart evidence needs vouchers, which account totals cannot retain.
  // The kassaflödesanalys reads per-voucher movements for the same reason
  // (gross loans and acquisitions, exchange differences on likvida medel).
  // Both mirror the statement's exclude-final scope (resultatavslut and the
  // linked opening entry left out) through cash-flow-evidence.ts;
  // kassaflodesanalys-tax.test.ts pins those filters.
  'lib/reports/cash-flow-tax.ts',
  'lib/reports/cash-flow-evidence.ts',
  // Reconciliation and diagnostics: they compare against the ledger as posted.
  'lib/reports/ar-reconciliation.ts',
  'lib/reports/supplier-reconciliation.ts',
  'lib/reports/reskontra-payments.ts',
  'lib/reports/imbalance-diagnosis.ts',
  'lib/reports/continuity-check.ts',
  'lib/reports/rc-basis-gaps.ts',
  'lib/reports/vat-settlement.ts',
  // Sums named momsredovisning verifikat and opening-balance vouchers, one by
  // one, to tie each to the period it settles; no closing verifikat is read.
  'lib/reports/vat-settlement-match.ts',
  'lib/reports/vat-declaration.ts',
  'lib/reports/periodisk-sammanstallning.ts',
  'lib/reports/salary-journal.ts',
  'lib/reports/vacation-liability.ts',
  // Classifies each equity verifikat by its counter-accounts (the kind of
  // movement is not in any balance); the balances it opens and closes on come
  // from generateTrialBalance, and the resultatavslut is read on purpose as
  // the year's result (ÅRL 6 kap. 2 §, K3 6.3).
  'lib/bokslut/arsredovisning/equity-specification.ts',
])

const LEDGER_SCAN_RE =
  /\.from\(\s*['"]journal_entry_lines['"]\s*\)|fetchEntryLines\s*[<(]|lines:\s*journal_entry_lines\(/

/**
 * Statement generators that scan journal_entry_lines instead of going through
 * generateTrialBalance.
 *
 * WHY: a generator that aggregates a fiscal year's balances from raw lines has
 * to remember, on its own, that the resultatavslut posts the mirror image of
 * every P&L account into 2099 inside the same period. Three shipped without
 * remembering (årsredovisning 2026-07-23, INK2R and NE-bilaga 2026-07-29) and
 * each reported ZERO revenue for a closed year while the balance sheet still
 * tied out, so nothing warned. generateTrialBalance now REQUIRES a
 * closingEntry mode, which makes the decision a compile error instead: this
 * guard is what keeps new generators on that path.
 */
function findLedgerScanningReports() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'lib', 'reports'), ['.ts']),
    ...walk(path.join(SOURCE_ROOT, 'lib', 'bokslut'), ['.ts']),
  ]
  return files
    .filter((f) => {
      const r = rel(f)
      if (LEDGER_SCAN_SANCTIONED.has(r)) return false
      if (r.includes('__tests__/') || r.endsWith('.test.ts')) return false
      return LEDGER_SCAN_RE.test(fs.readFileSync(f, 'utf8'))
    })
    .map(rel)
    .sort()
}

/** Count of naive Math.round(x*100)/100 occurrences (lines) across source. */
function countNaiveRound() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'components'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  let count = 0
  for (const f of files) {
    if (ROUND_EXEMPT.has(rel(f))) continue
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (NAIVE_ROUND_RE.test(line)) count++
    }
  }
  return count
}

// 31. mcp-bare-error. Spacing variants count too; a test file never does.
const MCP_SERVER_DIR = path.join(SOURCE_ROOT, 'extensions', 'general', 'mcp-server')
const BARE_ERROR_THROW_RE = /\bthrow\s+new\s+Error\s*\(/g

/** Count of bare `throw new Error(` in the MCP server's non-test source. */
function countMcpBareErrorThrows() {
  let count = 0
  for (const f of walk(MCP_SERVER_DIR, ['.ts', '.tsx'])) {
    const r = rel(f)
    if (r.includes('__tests__/') || r.endsWith('.test.ts')) continue
    count += (fs.readFileSync(f, 'utf8').match(BARE_ERROR_THROW_RE) ?? []).length
  }
  return count
}

/**
 * 9. provider-host: files that talk to an external provider API directly.
 * Provider integration logic is moving behind the connector (hosted
 * `app/api/connect/*` today, the Accounted Connect service later): the open
 * repo keeps the ledger, the contract and the manual file paths, and a
 * self-hosted instance reaches every provider through its connector key.
 * Per-file ratchet: the grandfathered set may only shrink. A NEW file naming a
 * provider API host is a boundary violation unless it is the connector's own
 * hosted adapter side.
 */
const PROVIDER_HOST_RE =
  /api\.enablebanking\.com|api\.tilisy\.com|api\.skatteverket\.se|peroauth2\.skatteverket\.se|sso\.skatteverket\.se|api\.qvalia\.com|api-test\.qvalia\.com|api\.fortnox\.se|apps\.fortnox\.se|vismaonline\.com|briox\.services|apigateway\.blinfo\.se|api\.bokio\.se|api\.bolagsverket\.se|api-accept2\.bolagsverket\.se|id\.tic\.io|graph\.facebook\.com|gmail\.googleapis\.com/i

function findProviderHostFiles() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  const found = []
  for (const f of files) {
    const r = rel(f)
    if (r.includes('__tests__/') || r.endsWith('.test.ts') || r.endsWith('.test.tsx')) continue
    if (PROVIDER_HOST_RE.test(fs.readFileSync(f, 'utf8'))) found.push(r)
  }
  return found.sort()
}

/**
 * Occurrences of a shared format rule written out by hand instead of imported
 * from lib/invariants/. Counted, not file-setted: the campaign lowers the
 * number file by file and the count may only go down.
 */
function countHandRolledInvariants() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'components'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  let count = 0
  for (const f of files) {
    const relPath = rel(f)
    if (relPath.startsWith(INVARIANT_EXEMPT_PREFIX)) continue
    // Tests legitimately spell out the pattern they are asserting about.
    if (relPath.includes('__tests__/') || relPath.endsWith('.test.ts')) continue
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (HAND_ROLLED_INVARIANT_RES.some((re) => re.test(line))) count++
    }
  }
  return count
}

// 9. off-ladder-radius. The radius ladder (.claude/rules/design.md) allows
// exactly: rounded-full (interactive toolbar controls, chips, dots),
// rounded-xl (page panel, dialogs, slide-overs, hero surfaces), rounded-lg
// (cards, form fields, popover/menu content, bordered boxes), rounded-sm
// (nested leaf elements), rounded-none, and directional variants of those.
// Everything else is off-ladder. Bare `rounded` is banned as vocabulary: it
// renders the same 4px as rounded-sm but hides from a rounded-sm grep.
const OFF_LADDER_RADIUS_RES = [
  // rounded-md and any directional variant (rounded-t-md, rounded-bl-md, ...)
  /\brounded(?:-[trbl]{1,2})?-(?:md|2xl|3xl|4xl)\b/,
  // arbitrary radius values: rounded-[5px], rounded-t-[10px], ...
  /\brounded(?:-[trbl]{1,2})?-\[/,
]

// Bare `rounded` as a class token (not rounded-*): renders the same 4px as
// rounded-sm but hides from a rounded-sm grep. `rounded` is also a common
// variable name and an ordinary English word, so this one only counts inside
// a quoted string that looks like a Tailwind class list (contains at least
// one other utility-class token).
const BARE_ROUNDED_RE = /(?<![-\w])rounded(?![-\w])/
const CLASS_LIST_HINT_RE =
  /(?:^|\s)(?:[a-z-]+:)*(?:flex|inline-flex|grid|hidden|absolute|relative|sticky|fixed|bg-\S|text-\S|border\b|border-\S|shadow\S*|p-\d|px-\S|py-\S|pl-\S|pr-\S|pt-\S|pb-\S|h-\S|w-\S|gap-\S|items-\S|justify-\S|font-\S|overflow-\S|transition\S*|animate-\S)/

function lineHasBareRoundedClass(line) {
  const strings = line.match(/"[^"]*"|'[^']*'|`[^`]*`/g)
  if (!strings) return false
  return strings.some(
    (s) => BARE_ROUNDED_RE.test(s) && CLASS_LIST_HINT_RE.test(s.slice(1, -1)),
  )
}

/** Off-ladder border-radius classes in UI code. */
function findOffLadderRadii() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'components'), ['.ts', '.tsx']),
  ]
  const findings = []
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Prose mentions of "rounded" in comments are not class tokens.
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      if (OFF_LADDER_RADIUS_RES.some((re) => re.test(line)) || lineHasBareRoundedClass(line)) {
        findings.push(`${rel(f)}:${i + 1}`)
      }
    }
  }
  return findings.sort()
}

// 10. folded-public-flag. The Docker image is built once with sentinel values
// (ENV NEXT_PUBLIC_SELF_HOSTED=__NEXT_PUBLIC_SELF_HOSTED__) that
// docker-entrypoint.sh seds into .next at container start. Comparing the var in
// place defeats that: the bundler inlines the sentinel, the minifier folds
// `"__NEXT_PUBLIC_SELF_HOSTED__" === 'true'` to false and eliminates the
// branch, so BOTH the name and the sentinel vanish and sed has nothing to
// replace. The flag is then permanently false whatever the operator sets.
//
// That shipped and stayed invisible for weeks: every Docker self-host ran with
// the entitlement paywall live, killing ai/bank_sync/skatteverket/email_send 30
// days after company creation. Read public flags as VALUES instead
// (flagEnabled(process.env.NEXT_PUBLIC_X) from lib/env/public-flags), which
// keeps the sentinel in the output as a live string literal.
//
// No baseline: the count is 0, any new one is a hard failure.
const PUBLIC_FLAG_EXEMPT = new Set(['lib/env/public-flags.ts'])

const EQUALITY_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

/** `process.env.NEXT_PUBLIC_ANYTHING` as an expression node. */
function isPublicEnvRead(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env' &&
    ts.isIdentifier(node.name) &&
    node.name.text.startsWith('NEXT_PUBLIC_')
  )
}

/** Public env flags compared in place, which the Docker build folds away. */
function findFoldedPublicFlags() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'components'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'contexts'), ['.ts', '.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  const findings = []
  for (const file of files) {
    const relPath = rel(file)
    if (PUBLIC_FLAG_EXEMPT.has(relPath)) continue
    // Tests never ship in the image, and they legitimately assert on raw env.
    // Both layouts: the __tests__/ convention, and a colocated *.test.ts(x),
    // which would otherwise be a false positive that invites weakening this
    // guard rather than fixing a real call site.
    if (relPath.includes('__tests__/') || /\.test\.tsx?$/.test(relPath)) continue
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('NEXT_PUBLIC_')) continue

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        EQUALITY_OPS.has(node.operatorToken.kind) &&
        (isPublicEnvRead(node.left) || isPublicEnvRead(node.right))
      ) {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
        findings.push(`${relPath}:${pos.line + 1}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...new Set(findings)].sort()
}

// 11. dialog-overflow-risk. See the header comment for the three patterns.
// Files whose whitespace-nowrap cells are fixed-width numeric/tabular columns
// living inside their OWN overflow-x-auto scroll container, so they cannot
// widen the dialog itself:
// - PaymentFileDialog: payment-line table wrapped in an overflow-x-auto div.
// 11. direct-ai-client. Every model call goes through the job-shaped service
// in lib/ai (getAiService): that is what lets hosted stay on Bedrock while a
// sovereign self-host points at an OpenAI-compatible Swedish endpoint, and
// what stops new AI surfaces from hard-wiring one SDK. Outside lib/ai/, a
// file may not import createAiClient, call `.messages.create/stream(` on an
// Anthropic client, or import the Vercel AI SDK (`ai`, `@ai-sdk/*`). The
// allowlist is the pre-abstraction call sites that still speak the Anthropic
// SDK directly (chat loop, composer, receipt hunt, WhatsApp interpreter, the
// legacy smoke script); it may only shrink as they migrate or are deleted.
const DIRECT_AI_CLIENT_ALLOWED = new Set([
  'lib/agent/chat/run-turn.ts',
  'lib/agent/composer/atom-selection.ts',
  'lib/agent/composer/client.ts',
  'lib/agent/composer/narrative.ts',
  'lib/agent/composer/prewarm.ts',
  'lib/receipt-hunt/adjudicate.ts',
  'extensions/general/whatsapp-inbox/lib/interpret-answer.ts',
  'scripts/smoke-ai.ts',
  // Out-of-tree CI reviewer with its own pinned SDK install (see the
  // compliance workflow); deliberately not part of the app's AI layer.
  'scripts/swedish-compliance-review.mjs',
])
const DIRECT_AI_CLIENT_RES = [
  { rule: 'createAiClient-import', re: /import[^;]*\bcreateAiClient\b[^;]*from\s+['"]@\/lib\/ai\/provider['"]/ },
  { rule: 'anthropic-messages-call', re: /\.messages\.(create|stream)\(/ },
  { rule: 'ai-sdk-import', re: /from\s+['"](ai|ai\/[\w-]+|@ai-sdk\/[\w-]+)['"]/ },
]

function findDirectAiClients() {
  const out = []
  for (const dir of ['lib', 'app', 'extensions', 'components', 'scripts']) {
    for (const file of walk(path.join(dir === 'scripts' ? ROOT : SOURCE_ROOT, dir), ['.ts', '.tsx', '.mjs'])) {
      const r = rel(file)
      if (r.startsWith('lib/ai/')) continue
      if (r.includes('/__tests__/') || r.endsWith('.test.ts') || r.endsWith('.test.tsx')) continue
      const src = fs.readFileSync(file, 'utf8')
      for (const { rule, re } of DIRECT_AI_CLIENT_RES) {
        if (re.test(src)) out.push({ file: r, rule })
      }
    }
  }
  return out
}

const DIALOG_NOWRAP_ALLOWED = new Set([
  'components/supplier-invoices/PaymentFileDialog.tsx',
  // Betala via banken: the review table (payee, date, amount) sits in its own
  // overflow-x-auto wrapper, the same shape as PaymentFileDialog's.
  'components/payments/PayViaBankDialog.tsx',
])

const DIALOG_CONTENT_IMPORT_RE =
  /import\s*\{[^}]*\b(?:DialogContent|SheetContent)\b[^}]*\}\s*from\s*['"]@\/components\/ui\/(?:dialog|sheet)['"]/
const GRID_COLS_TEMPLATE_RE = /grid-cols-\[([^\]]+)\]/g
const BARE_FR_TOKEN_RE = /^\d+(?:\.\d+)?fr$/
const WIDE_MIN_W_RE = /min-w-\[(\d+(?:\.\d+)?)(rem|px)\]/g
const PORTAL_HINT_RE = /createPortal|\bPortal\b/
const OVERLAY_ABSOLUTE_RE = /\babsolute\b/
const OVERLAY_Z_RE = /\bz-(?:40|50|\[\d+\])/

/**
 * Overflow-risky patterns in dialog/sheet hosts. Returns
 * { file, where, rule } findings; the ratchet compares the file set.
 */
function findDialogOverflowRisks() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'components'), ['.tsx']),
    ...walk(path.join(SOURCE_ROOT, 'extensions'), ['.tsx']),
  ]
  const findings = []
  for (const f of files) {
    const r = rel(f)
    const src = fs.readFileSync(f, 'utf8')
    const lines = src.split('\n')

    if (DIALOG_CONTENT_IMPORT_RE.test(src)) {
      // (a) bare fr grid tracks anywhere in a dialog-hosting file.
      lines.forEach((line, i) => {
        for (const m of line.matchAll(GRID_COLS_TEMPLATE_RE)) {
          if (m[1].split('_').some((token) => BARE_FR_TOKEN_RE.test(token))) {
            findings.push({ file: r, where: `${r}:${i + 1}`, rule: 'bare-fr-grid-track' })
          }
        }
      })
      // (b) whitespace-nowrap inside the <DialogContent>/<SheetContent>
      // region. Line-based depth tracking is a heuristic, but dialog JSX in
      // this repo keeps the tags on their own lines.
      if (!DIALOG_NOWRAP_ALLOWED.has(r)) {
        let depth = 0
        lines.forEach((line, i) => {
          if (/<(?:Dialog|Sheet)Content\b/.test(line)) depth++
          if (depth > 0 && line.includes('whitespace-nowrap')) {
            findings.push({ file: r, where: `${r}:${i + 1}`, rule: 'nowrap-in-dialog' })
          }
          const closes = (line.match(/<\/(?:Dialog|Sheet)Content>/g) || []).length
          depth = Math.max(0, depth - closes)
        })
      }
    }

    // (c) a hand-rolled absolute overlay forcing a >=20rem minimum width in a
    // file that never portals anything: inside a scrollable DialogContent
    // that minimum becomes a horizontal scrollbar on the dialog.
    if (!PORTAL_HINT_RE.test(src) && OVERLAY_ABSOLUTE_RE.test(src) && OVERLAY_Z_RE.test(src)) {
      lines.forEach((line, i) => {
        for (const m of line.matchAll(WIDE_MIN_W_RE)) {
          const value = parseFloat(m[1])
          if ((m[2] === 'rem' && value >= 20) || (m[2] === 'px' && value >= 320)) {
            findings.push({ file: r, where: `${r}:${i + 1}`, rule: 'unportaled-wide-overlay' })
          }
        }
      })
    }
  }
  return findings.sort((a, b) => a.where.localeCompare(b.where))
}

// Dependencies pinned to an EXACT version on purpose, because a bump broke prod
// and must not silently return via `npm update`, a dependabot bump, or a manual
// install. Any drift (in package.json OR the lockfile) fails CI. See DECISIONS.md.
const PINNED_DEPS = [
  {
    name: '@anthropic-ai/bedrock-sdk',
    version: '0.29.1',
    reason:
      '0.32.0 (grouped dependabot bump #884) broke Bedrock streaming in prod: empty stream, ' +
      '"request ended without sending any chunks", taking down the AI assistant + invoice OCR. ' +
      'Keep 0.29.1 until 0.32.x streaming is verified against Bedrock.',
  },
  {
    name: '@anthropic-ai/sdk',
    version: '0.95.0',
    reason:
      'Declared explicitly at the version bedrock-sdk 0.29.1 pulls in transitively (#1406 Tier 1), so ' +
      'the lockfile dedupes to one copy; a drift here is a second SDK copy and an untested wire surface.',
  },
  {
    name: 'ai',
    version: '6.0.259',
    reason:
      'Vercel AI SDK backs lib/ai/services/openai-compatible.ts (Tier 2 BYO endpoints). Major versions ' +
      'rename core APIs; upgrades are deliberate PRs with the provider test suite, never a silent bump.',
  },
  {
    name: '@ai-sdk/openai-compatible',
    version: '2.0.69',
    reason:
      'Paired with ai 6.x; the provider package follows its own major cadence and must move together with ' +
      'the core pin in one reviewed change.',
  },
  {
    name: 'nodemailer',
    version: '10.3.1',
    reason:
      'SMTP mailer for self-hosts (extensions/general/email/lib/smtp-service.ts), and the addressparser ' +
      'mailparser uses on inbound mail. Zero-dependency MIT-0 package; 10.x requires Node >= 20. Bumps are ' +
      'deliberate, reviewed PRs (audit surface), never silent (#3298). 10.3.1: addressparser advisories ' +
      'GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h (CASA 6.1.1, 2026-11-02).',
  },
  {
    name: 'mailparser',
    version: '3.14.1',
    reason:
      'Inbound-mail parser (extensions/general/invoice-inbox). Each mailparser release depends on an EXACT ' +
      'nodemailer version; 3.14.1 depends on exactly nodemailer 10.3.1, so its nested copy dedupes with the ' +
      'top-level pin. This guard checks the top-level nodemailer only, so a future mailparser bump must move ' +
      'the nodemailer pin in the same PR, or a second nested copy appears. Bump both pins together, on ' +
      'purpose (#2490, #3298).',
  },
]

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Pinned deps whose package.json spec or locked version drifted from the pin.
 *
 * Also scans .github/workflows/*.yml for literal `<name>@<version>` installs:
 * a workflow that installs the SDK by version (e.g. the compliance review's
 * out-of-tree `npm install ...@0.29.1`) bypasses package.json AND the
 * lockfile, so it is exactly where the 0.32.0 regression can drift back in
 * without either file changing.
 */
function findPinnedDepViolations() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const declared = { ...pkg.dependencies, ...pkg.devDependencies }
  const out = []
  const workflowFiles = walk(path.join(ROOT, '.github', 'workflows'), ['.yml', '.yaml'])
  for (const pin of PINNED_DEPS) {
    const spec = declared[pin.name]
    if (spec !== undefined && spec !== pin.version) {
      out.push({ ...pin, where: 'package.json', actual: spec })
    }
    const locked = lock.packages?.[`node_modules/${pin.name}`]?.version
    if (locked !== undefined && locked !== pin.version) {
      out.push({ ...pin, where: 'package-lock.json', actual: locked })
    }
    const literalInstall = new RegExp(
      `${escapeRegExp(pin.name)}@(\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?)`,
      'g',
    )
    for (const wf of workflowFiles) {
      const src = fs.readFileSync(wf, 'utf8')
      for (const match of src.matchAll(literalInstall)) {
        if (match[1] !== pin.version) {
          out.push({ ...pin, where: rel(wf), actual: `${pin.name}@${match[1]}` })
        }
      }
    }
  }
  return out
}

const USER_ERROR_FIELD_NAMES = new Set([
  'description',
  'detail',
  'details',
  'error',
  'message',
  'reason',
  'title',
])

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function propertyPath(node) {
  const parts = []
  let current = node
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text)
    current = current.expression
  }
  if (ts.isIdentifier(current)) parts.unshift(current.text)
  return parts
}

function isRawErrorMessage(node) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'message') return false
  const parts = propertyPath(node)
  if (parts.length < 2) return false
  const root = parts[0]
  return (
    /^(?:e|err|error|cause)$/i.test(root) ||
    /(?:Error|Err)$/.test(root) ||
    parts.slice(0, -1).some((part) => /^(?:error|first_error)$/i.test(part))
  )
}

function isErrorLikeIdentifier(node) {
  return ts.isIdentifier(node) && (
    /^(?:e|err|error|cause)$/i.test(node.text) || /(?:Error|Err)$/.test(node.text)
  )
}

function isRawErrorString(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'String' &&
    node.arguments.length === 1 &&
    isErrorLikeIdentifier(node.arguments[0])
  )
}

function containsRawErrorMessage(node) {
  let found = false
  const visit = (child) => {
    if (found) return
    if (isRawErrorMessage(child) || isRawErrorString(child)) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function enclosingCatch(node) {
  let current = node.parent
  while (current) {
    if (ts.isCatchClause(current)) return current
    if (ts.isFunctionLike(current)) return null
    current = current.parent
  }
  return null
}

const taintedCatchNames = new WeakMap()

function getTaintedNames(catchClause) {
  const cached = taintedCatchNames.get(catchClause)
  if (cached) return cached

  const declarations = []
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declarations.push(node)
    }
    ts.forEachChild(node, collect)
  }
  collect(catchClause.block)

  const names = new Set()

  const isTaintedValue = (node) => {
    if (isRawErrorMessage(node) || isRawErrorString(node)) return true
    if (ts.isCallExpression(node) && callName(node) === 'getErrorMessage') return false
    if (ts.isConditionalExpression(node)) {
      return isTaintedValue(node.whenTrue) || isTaintedValue(node.whenFalse)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
      return false
    }
    let tainted = false
    const visit = (child) => {
      if (tainted) return
      if (isRawErrorMessage(child) || isRawErrorString(child)) {
        tainted = true
        return
      }
      if (ts.isIdentifier(child) && names.has(child.text)) {
        tainted = true
        return
      }
      if (ts.isCallExpression(child) && callName(child) === 'getErrorMessage') return
      ts.forEachChild(child, visit)
    }
    ts.forEachChild(node, visit)
    return tainted
  }

  let changed = true
  while (changed) {
    changed = false
    for (const declaration of declarations) {
      if (names.has(declaration.name.text)) continue
      const tainted = isTaintedValue(declaration.initializer)
      if (tainted) {
        names.add(declaration.name.text)
        changed = true
      }
    }
  }

  taintedCatchNames.set(catchClause, names)
  return names
}

function containsRawOrTaintedError(node) {
  if (containsRawErrorMessage(node)) return true
  const catchClause = enclosingCatch(node)
  if (!catchClause) return false
  const names = getTaintedNames(catchClause)
  let found = false
  const visit = (child) => {
    if (found) return
    if (ts.isIdentifier(child) && names.has(child.text)) {
      found = true
      return
    }
    if (ts.isPropertyAssignment(child)) {
      visit(child.initializer)
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function callName(call) {
  const expression = call.expression
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return ''
}

function isLoggingCall(call) {
  const expression = call.expression
  if (!ts.isPropertyAccessExpression(expression)) return false
  const owner = expression.expression.getText()
  return (
    owner === 'console' ||
    /(?:^|\.)log$/.test(owner) ||
    /Log$/.test(owner) ||
    owner.endsWith('Logger')
  )
}

function ancestorCall(node, predicate = () => true) {
  let current = node.parent
  while (current) {
    if (ts.isCallExpression(current) && predicate(current)) return current
    if (ts.isFunctionLike(current)) return null
    current = current.parent
  }
  return null
}

function isApiResponseCall(call) {
  const name = callName(call)
  if (/^(?:errorResponse|errorResponseFromCode|getErrorMessage)$/.test(name)) return false
  if (/^(?:json|v1ErrorResponse|v1ErrorResponseFromCode)$/.test(name)) return true
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text === 'json'
  }
  return false
}

function isClientErrorSetter(call) {
  const name = callName(call)
  return name === 'toast' || /^set[A-Z].*(?:Error|Message)$/.test(name) || name === 'setError'
}

/**
 * Raw caught-error messages in user-visible sinks. This is deliberately an
 * AST check: line regexes cannot distinguish a logger payload from a JSON
 * response, nor a Zod issue message from err.message.
 */
function findRawUserErrors() {
  const files = [
    ...walk(path.join(SOURCE_ROOT, 'app', 'api'), ['route.ts']),
    ...walk(path.join(SOURCE_ROOT, 'app'), ['.ts', '.tsx']).filter((f) => !rel(f).startsWith('app/api/')),
    ...walk(path.join(SOURCE_ROOT, 'components'), ['.ts', '.tsx']),
  ]
  const findings = []

  for (const file of files) {
    const sourceText = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const isApi = rel(file).startsWith('app/api/')

    const add = (node) => {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
      findings.push(`${rel(file)}:${pos.line + 1}`)
    }

    const visit = (node) => {
      if (ts.isPropertyAssignment(node)) {
        const field = propertyNameText(node.name)
        if (
          field &&
          USER_ERROR_FIELD_NAMES.has(field) &&
          !ts.isObjectLiteralExpression(node.initializer) &&
          containsRawOrTaintedError(node.initializer)
        ) {
          const loggingCall = ancestorCall(node, isLoggingCall)
          const clientSink = ancestorCall(node, isClientErrorSetter)
          if (!loggingCall) {
            if (isApi || clientSink) add(node)
          }
        }
      }

      if (ts.isCallExpression(node) && node.arguments.some(containsRawOrTaintedError)) {
        if (!isLoggingCall(node)) {
          if ((isApi && isApiResponseCall(node)) || (!isApi && isClientErrorSetter(node))) {
            add(node)
          }
        }
      }

      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  return [...new Set(findings)].sort()
}

const initReach = findInitReach(SOURCE_ROOT)
const current = {
  rawRouteAuth: findRawRouteAuth(),
  naiveOreRound: countNaiveRound(),
  mcpBareErrorThrows: countMcpBareErrorThrows(),
  handRolledInvariants: countHandRolledInvariants(),
  providerHosts: findProviderHostFiles(),
  ledgerScanningReports: findLedgerScanningReports(),
  directJelInsert: findDirectJelInserts(),
  directInvoicePaymentInsert: findDirectInvoicePaymentInserts(),
  handWrittenSieExtensions: findHandWrittenSieExtensions(),
  leakySupabaseClients: findLeakySupabaseClients(),
  pinnedDepViolations: findPinnedDepViolations(),
  rawUserErrors: findRawUserErrors(),
  sekLabelledAmounts: findSekLabelledFxAmounts(SOURCE_ROOT),
  extensionRoutes: findExtensionRouteFindings(SOURCE_ROOT),
  staticInitImports: initReach.staticInitImports,
  lazyInitEntries: initReach.lazyInitEntries,
  offLadderRadii: findOffLadderRadii(),
  foldedPublicFlags: findFoldedPublicFlags(),
  dialogOverflowRisk: findDialogOverflowRisks(),
  directAiClients: findDirectAiClients(),
  rawReferenceFetch: findRawReferenceFetches(SOURCE_ROOT),
  handReadErrors: findHandReadErrors(SOURCE_ROOT),
  clientNodeBuiltins: findClientNodeBuiltins(SOURCE_ROOT),
  clientServerOnly: findClientServerOnlyReachers(SOURCE_ROOT),
  consentTokenAccess: findConsentTokenAccess(SOURCE_ROOT),
  ambiguousEmbeds: findAmbiguousEmbeds(ROOT, SOURCE_ROOT),
  literalLegalForm: findLiteralLegalForms(SOURCE_ROOT),
  handBuiltVoucherRef: findHandBuiltVoucherRefs(SOURCE_ROOT),
  uiUniformity: findUiUniformityFindings(SOURCE_ROOT),
  tableWithoutGrant: findTablesWithoutGrant(ROOT),
  limitsAbovePage: findLimitsAbovePage(SOURCE_ROOT),
  linesInnerEmbeds: findLinesInnerEmbeds(SOURCE_ROOT),
  localTestMocks: findLocalTestMocks(ROOT),
  utcToday: findUtcTodaySites(SOURCE_ROOT),
  unsignedProviderNames: checkUnsignedProviderNames(),
  functiondefPatch: findFunctiondefPatches(ROOT),
  decisionLog: findDecisionLogFindings(ROOT),
  scriptInitCondition: findScriptInitConditionFindings(ROOT).findings,
  jurisdictionWelds: findJurisdictionWelds(SOURCE_ROOT),
  postingPort: findPostingPortBypasses(ROOT),
  swedishUiLiterals: findSwedishUiLiterals(SOURCE_ROOT),
  duplicateBlocks: findDuplicateBlocks(SOURCE_ROOT),
  errorMasking: findErrorMasking(SOURCE_ROOT),
}

const dialogOverflowFiles = [...new Set(current.dialogOverflowRisk.map((f) => f.file))].sort()
const tableWithoutGrantFiles = [...new Set(current.tableWithoutGrant.map((f) => f.file))].sort()
const functiondefPatchFiles = [...new Set(current.functiondefPatch.map((f) => f.file))].sort()
const basLiteralCounts = countByFile(current.jurisdictionWelds.basAccountLiteral)
const sekLiteralCounts = countByFile(current.jurisdictionWelds.sekLiteral)
const kernelImportEdges = current.jurisdictionWelds.kernelImports
const kernelImportEdgeCount = Object.values(kernelImportEdges).reduce((n, mods) => n + mods.length, 0)
const postingBypassEdges = current.postingPort.bypasses
const postingBypassEdgeCount = countEdges(postingBypassEdges)
const swedishUiLiteralCounts = countByFile(current.swedishUiLiterals)
const duplicatePairs = current.duplicateBlocks.pairs
const duplicateLineCount = Object.values(duplicatePairs).reduce((n, v) => n + v, 0)
const errorMaskingCounts = countByFile(current.errorMasking)

const isUpdate = process.argv.includes('--update')

if (isUpdate) {
  // table-without-grant is a frozen set, not a ratchet: --update is run to lock
  // in some other count going down, and must never grandfather a migration
  // added since (see grandfatheredFiles).
  // functiondef-patch is frozen the same way.
  const frozenBaseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) : {}
  const frozenGrantFiles = frozenBaseline.tableWithoutGrant?.files
  const grandfatheredGrantFiles = grandfatheredFiles(frozenGrantFiles, tableWithoutGrantFiles)
  const grandfatheredPatchFiles = grandfatheredFiles(frozenBaseline.functiondefPatch?.files, functiondefPatchFiles)
  // lazy-init-reach is frozen too: --update may lower it, never raise it. A
  // rise is what OOM-killed the Vercel build on 2026-10-15.
  const lazyInitNow = current.lazyInitEntries.map((o) => o.entry)
  const frozenLazyInit = frozenBaseline.lazyInitReach
  const lazyInitReach =
    frozenLazyInit && lazyInitNow.length > frozenLazyInit.count
      ? frozenLazyInit
      : { count: lazyInitNow.length, files: lazyInitNow }
  // posting-port-bypass is frozen the same way: --update keeps only the edges
  // the previous baseline already had, so it can drop a moved caller and can
  // never grandfather a new one (a permanent exception goes in
  // PERMANENT_ALLOWLIST with its reason instead).
  const postingBypassFiles = frozenBypassBaseline(frozenBaseline.postingPortBypass?.files, postingBypassEdges)
  const baseline = {
    _comment:
      'Ratchet baseline for scripts/checks/no-new-antipatterns.mjs. These counts may only decrease. Re-run with --update after a migration lowers them. Goal: both reach 0 (A1 route-auth campaign, D1 rounding codemod).',
    rawRouteAuth: { count: current.rawRouteAuth.length, files: current.rawRouteAuth },
    naiveOreRound: { count: current.naiveOreRound },
    mcpBareErrorThrows: { count: current.mcpBareErrorThrows },
    handRolledInvariants: { count: current.handRolledInvariants },
    literalLegalForm: { count: current.literalLegalForm.length },
    handBuiltVoucherRef: { count: current.handBuiltVoucherRef.length },
    ledgerScanningReports: {
      count: current.ledgerScanningReports.length,
      files: current.ledgerScanningReports,
    },
    dialogOverflowRisk: {
      count: dialogOverflowFiles.length,
      files: dialogOverflowFiles,
    },
    rawReferenceFetch: {
      count: current.rawReferenceFetch.length,
      files: current.rawReferenceFetch,
    },
    providerHosts: {
      count: current.providerHosts.length,
      files: current.providerHosts,
    },
    tableWithoutGrant: {
      count: grandfatheredGrantFiles.length,
      files: grandfatheredGrantFiles,
    },
    functiondefPatch: {
      count: grandfatheredPatchFiles.length,
      files: grandfatheredPatchFiles,
    },
    lazyInitReach,
    basAccountLiteral: {
      count: current.jurisdictionWelds.basAccountLiteral.length,
      files: basLiteralCounts,
    },
    sekLiteral: {
      count: current.jurisdictionWelds.sekLiteral.length,
      files: sekLiteralCounts,
    },
    kernelImports: {
      count: kernelImportEdgeCount,
      files: kernelImportEdges,
    },
    postingPortBypass: {
      count: countEdges(postingBypassFiles),
      files: postingBypassFiles,
    },
    swedishUiLiteral: {
      count: current.swedishUiLiterals.length,
      files: swedishUiLiteralCounts,
    },
    duplicateBlocks: {
      count: duplicateLineCount,
      window: DUPLICATE_WINDOW,
      pairs: duplicatePairs,
    },
    errorMasking: {
      count: current.errorMasking.length,
      files: errorMaskingCounts,
    },
  }
  // The jurisdiction-weld ratchets may only be raised with a decision file
  // (docs/decisions/YYYY-MM/): say so loudly when this re-baseline raises any of them. A ratchet
  // the previous baseline did not have yet is being introduced, not raised.
  const previous = frozenBaseline
  const raised = [
    ...(previous.basAccountLiteral
      ? compareFileCounts(previous.basAccountLiteral.files ?? {}, basLiteralCounts).grown.map(
          (g) => `bas-account-literal ${g.file}: ${g.baseline} -> ${g.current}`,
        )
      : []),
    ...(previous.sekLiteral
      ? compareFileCounts(previous.sekLiteral.files ?? {}, sekLiteralCounts).grown.map(
          (g) => `sek-literal ${g.file}: ${g.baseline} -> ${g.current}`,
        )
      : []),
    ...(previous.kernelImports
      ? compareFileEdges(previous.kernelImports.files ?? {}, kernelImportEdges).added.map(
          (e) => `kernel-import ${e.file} -> ${e.module}`,
        )
      : []),
    ...(previous.swedishUiLiteral
      ? compareFileCounts(previous.swedishUiLiteral.files ?? {}, swedishUiLiteralCounts).grown.map(
          (g) => `swedish-ui-literal ${g.file}: ${g.baseline} -> ${g.current}`,
        )
      : []),
  ]
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  console.log(
    `Baseline written: ${current.rawRouteAuth.length} raw-route-auth files, ${current.naiveOreRound} naive-ore-round occurrences.`,
  )
  if (raised.length) {
    console.log(
      `\n! This re-baseline RAISES ${raised.length} jurisdiction-weld baseline ${raised.length === 1 ? 'entry' : 'entries'}. A pure move or\n` +
        '  rename is fine; anything else needs a decision file (docs/decisions/YYYY-MM/) saying why, in the same PR:',
    )
    raised.forEach((r) => console.log(`    ${r}`))
  }
  process.exit(0)
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error('No baseline found. Run: node scripts/checks/no-new-antipatterns.mjs --update')
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
let failed = false

// 1. raw-route-auth: any file not in the baseline set is a NEW violation.
const baselineSet = new Set(baseline.rawRouteAuth.files)
const newAuthFiles = current.rawRouteAuth.filter((f) => !baselineSet.has(f))
const fixedAuthFiles = baseline.rawRouteAuth.files.filter((f) => !current.rawRouteAuth.includes(f))
if (newAuthFiles.length) {
  failed = true
  console.error(
    `\n✗ raw-route-auth: ${newAuthFiles.length} new route(s) call supabase.auth.getUser() directly ` +
      `instead of requireAuth()/withRouteContext() (skips MFA AAL2 enforcement):`,
  )
  newAuthFiles.forEach((f) => console.error(`    ${f}`))
  console.error('  → wrap the route in withRouteContext (or call requireAuth) so MFA is enforced.')
}

// 1b. direct-jel-insert: allowlist lives in this file (JEL_INSERT_SANCTIONED),
// no baseline: any unsanctioned insert site is a hard failure.
if (current.directJelInsert.length) {
  failed = true
  console.error(
    `\n✗ direct-jel-insert: ${current.directJelInsert.length} file(s) insert into journal_entry_lines ` +
      `outside the sanctioned writers:`,
  )
  current.directJelInsert.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → route line writes through lib/bookkeeping/engine.ts, or derive cost_center/project via\n' +
      '    lineDimensionColumns() (lib/bookkeeping/dimension-resolver.ts) and add the file to\n' +
      '    JEL_INSERT_SANCTIONED in this script with a justification.',
  )
}

// 1b1. direct-invoice-payment-insert: allowlist lives in this file
// (INVOICE_PAYMENT_INSERT_SANCTIONED), no baseline: any unsanctioned insert
// site is a hard failure.
if (current.directInvoicePaymentInsert.length) {
  failed = true
  console.error(
    `\n✗ direct-invoice-payment-insert: ${current.directInvoicePaymentInsert.length} file(s) insert a payment row ` +
      `outside its writer:`,
  )
  current.directInvoicePaymentInsert.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → record the payment through recordInvoicePaymentRow() (lib/invoices/invoice-payment-row.ts) or\n' +
      '    recordSupplierInvoicePaymentRow() (lib/invoices/supplier-invoice-payment-row.ts): they own the row\n' +
      '    semantics (amount = applied to the invoice, never the cash received, #2250) and the link basis.',
  )
}

// 1b1b. hand-written-sie-extensions: no baseline, any copy of the SIE extension
// list outside lib/import/sie-file-extensions.ts is a hard failure.
if (current.handWrittenSieExtensions.length) {
  failed = true
  console.error(
    `\n✗ hand-written-sie-extensions: ${current.handWrittenSieExtensions.length} file(s) spell out the SIE ` +
      `extension list instead of importing it:`,
  )
  current.handWrittenSieExtensions.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → import SIE_FILE_EXTENSIONS, SIE_FILE_EXTENSION_PATTERN or hasSIEFileExtension() from\n' +
      '    lib/import/sie-file-extensions.ts: every hand-written copy drifted (#2546, accounted#32).',
  )
}

// 1b3. client-node-builtin: a 'use client' module whose static import closure
// reaches a Node builtin ships the browser polyfill chunk (~327 KB) with every
// route that renders it. No baseline: 0 today, any reacher is a hard failure.
if (current.clientNodeBuiltins.length) {
  failed = true
  console.error(
    `\n✗ client-node-builtin: ${current.clientNodeBuiltins.length} client module(s) reach a Node builtin ` +
      `through their static imports (this ships crypto-browserify/Buffer/vm polyfills to the browser):`,
  )
  current.clientNodeBuiltins.forEach((f) =>
    console.error(`    ${f.file} -> ${f.builtin}\n        ${f.chain.join('\n        > ')}`),
  )
  console.error(
    '  → move the pure part the client needs into a sibling module without the Node import\n' +
      '    (see lib/auth/bankid-flags.ts, lib/import/bank-file/formats.ts, lib/salary/personnummer-format.ts,\n' +
      '    lib/auth/api-key-scopes.ts) and import that from the client. scripts/perf/client-import-closure.mjs\n' +
      '    prints the full chain for any module.',
  )
}

// 1b3a. consent-token-access: provider_consent_tokens read or written outside
// lib/providers/consent-tokens.ts, the one module that seals the tokens
// (accounted#58). No baseline: 0 today, any finding is a hard failure.
const duplicateMigrationVersions = findDuplicateMigrationVersions(ROOT)
if (duplicateMigrationVersions.length) {
  failed = true
  console.error(`\n✗ migration-version: ${duplicateMigrationVersions.length} version(s) held by more than one migration:`)
  for (const d of duplicateMigrationVersions) console.error(`    ${d.version}: ${d.files.join(', ')}`)
  console.error(MIGRATION_VERSION_HINT)
}
const oneDefinition = findOneDefinitionFindings(SOURCE_ROOT, await loadOneDefinitionRules())
if (oneDefinition.findings.length) {
  failed = true
  console.error(`\n✗ one-definition: ${oneDefinition.findings.length} line(s) write a rule that has one definition:`)
  for (const f of oneDefinition.findings) {
    console.error(`    ${f.file}:${f.line} (${f.rule})\n      use ${f.home}\n      ${f.why}`)
  }
  console.error(ONE_DEFINITION_HINT)
}
if (oneDefinition.stale.length) {
  console.log(
    `\n✓ one-definition progress: ${oneDefinition.stale.length} allowed site(s) no longer match.` +
      ' Remove them from `allowed` in the rule file to lock it in:',
  )
  oneDefinition.stale.forEach((s) => console.log(`    ${s.rule}: ${s.file}`))
}

if (current.consentTokenAccess.length) {
  failed = true
  console.error(
    `\n✗ consent-token-access: ${current.consentTokenAccess.length} provider_consent_tokens token read(s) or ` +
      `write(s) outside the sealed accessor:`,
  )
  current.consentTokenAccess.forEach((f) => console.error(`    ${f.file}:${f.line} (${f.kind})`))
  console.error(CONSENT_TOKEN_HINT)
}

// 1b3b. client-server-only: a 'use client' module whose static import closure
// reaches the bookkeeping engine or the BAS reference data ships server-only
// code (and the whole kontoplan) to the browser. No baseline: 0 today.
if (current.clientServerOnly.length) {
  failed = true
  console.error(
    `\n✗ client-server-only: ${current.clientServerOnly.length} client import chain(s) reach the bookkeeping ` +
      `engine or the BAS reference data through static imports:`,
  )
  current.clientServerOnly.forEach((f) =>
    console.error(`    ${f.file} -> ${f.target}\n        ${f.chain.join('\n        > ')}`),
  )
  console.error(
    '  → move the pure part the client needs into a sibling module and import that from the client\n' +
      '    (see lib/bookkeeping/booking-mode.ts, lib/invoices/rot-rut-refused-shares.ts,\n' +
      '    lib/cash-accounts/invoice-payee-rules.ts); account names come from the company chart\n' +
      '    (lib/reference-data) or the server. Rationale in scripts/checks/client-server-only.mjs.',
  )
}

// 1b4. ambiguous-embed: an embed between two tables joined by more than one
// foreign key must name the relationship, or PostgREST answers PGRST201 at
// runtime. No baseline: the count is 0 today, any new one is a hard failure.
if (current.ambiguousEmbeds.length) {
  failed = true
  console.error(
    `\n✗ ambiguous-embed: ${current.ambiguousEmbeds.length} PostgREST embed(s) between a table pair ` +
      `that shares more than one foreign key, with no relationship named:`,
  )
  current.ambiguousEmbeds.forEach((f) =>
    console.error(`    ${f.where}  ${f.from} -> ${f.target}`),
  )
  console.error(
    '  → name the relationship in the embed, either by constraint\n' +
      "    (.select('fiscal_period:fiscal_periods!journal_entries_fiscal_period_id_fkey(...)'))\n" +
      "    or by foreign key column (.select('journal_entries!opening_balance_entry_id(...)')).\n" +
      '    Without it PostgREST returns PGRST201 for every call, and no mocked-Supabase test\n' +
      '    or pg-real test can see it: a mock never resolves a relationship and pg-real does\n' +
      '    not go through PostgREST at all.',
  )
}

// 1b2. leaky-supabase-client: server code must construct clients through
// createServiceRoleClient(). No baseline: the count is 0 today.
if (current.leakySupabaseClients.length) {
  failed = true
  console.error(
    `\n✗ leaky-supabase-client: ${current.leakySupabaseClients.length} file(s) import supabase-js's ` +
      `createClient as a value instead of createServiceRoleClient():`,
  )
  current.leakySupabaseClients.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → import { createServiceRoleClient } from "@/lib/supabase/service-client". Constructing a\n' +
      '    client directly leaves autoRefreshToken on, which starts a 30 s setInterval that is never\n' +
      '    cleared and retains the client plus the whole request scope (heap death after ~42 h).\n' +
      '    Type-only imports are fine: use `import type { SupabaseClient } from "@supabase/supabase-js"`.',
  )
}

// 1c. pinned-dep: a version-pinned dependency must match its pin EXACTLY, in
// both package.json and the lockfile. No baseline: any drift is a hard failure.
if (current.pinnedDepViolations.length) {
  failed = true
  console.error(`\n✗ pinned-dep: ${current.pinnedDepViolations.length} version-pinned dependency change(s):`)
  current.pinnedDepViolations.forEach((v) =>
    console.error(
      `    ${v.name} in ${v.where}: found "${v.actual}", must be exactly "${v.version}".\n      ${v.reason}`,
    ),
  )
  console.error(
    '  → restore the pin (npm install <name>@<version> --save-exact). Only change PINNED_DEPS in\n' +
      '    this script once the upstream regression is confirmed fixed.',
  )
}

// 1d. raw-user-error: user-facing sinks must never receive err.message.
if (current.rawUserErrors.length) {
  failed = true
  console.error(
    `\n✗ raw-user-error: ${current.rawUserErrors.length} user-visible sink(s) expose a raw caught-error message:`,
  )
  current.rawUserErrors.forEach((finding) => console.error(`    ${finding}`))
  console.error(
    '  → map the error through getErrorMessage(), or throw it inside withRouteContext so\n' +
      '    errorResponse() produces the canonical structured envelope.',
  )
}

// 1d2. hand-read-api-error: client code reads an API error through the one
// reader (hand-read-api-error.mjs). No baseline: every hand read was moved to
// getErrorMessage, and files whose `.error` is not an envelope are allowlisted.
if (current.handReadErrors.length) {
  failed = true
  console.error(
    `\n✗ hand-read-api-error: ${current.handReadErrors.length} client site(s) read an API error by hand:`,
  )
  current.handReadErrors.forEach((finding) => console.error(`    ${finding}`))
  console.error(HAND_READ_ERROR_HINT)
}

// 1e. sek-labelled-amount: a foreign amount must never be printed with the SEK
// symbol. No baseline: every current single-argument call formats a SEK twin or
// a ledger column, so the count is 0 and any new one is a hard failure.
if (current.sekLabelledAmounts.length) {
  failed = true
  console.error(
    `\n✗ sek-labelled-amount: ${current.sekLabelledAmounts.length} formatCurrency() call(s) print a possibly-foreign amount as SEK:`,
  )
  current.sekLabelledAmounts.forEach((f) =>
    console.error(`    ${f.where}  formatCurrency(${f.expr})\n      ${f.reason}`),
  )
  console.error(
    '  → pass the record\'s currency as the second argument, formatCurrency(amount, record.currency),\n' +
      '    or format the SEK twin (record.amount_sek / record.total_sek) when one exists.',
  )
}

// 1e1. off-ladder-radius: no baseline, the count is 0 after the 2026-08
// migration and any new off-ladder radius class is a hard failure.
if (current.offLadderRadii.length) {
  failed = true
  console.error(
    `\n✗ off-ladder-radius: ${current.offLadderRadii.length} border-radius class(es) outside the locked ladder:`,
  )
  current.offLadderRadii.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → use the radius ladder (.claude/rules/design.md): rounded-full for toolbar controls/chips,\n' +
      '    rounded-xl for overlays, rounded-lg for cards/fields/menu content, rounded-sm for nested\n' +
      '    leaves. rounded-md, bare `rounded`, rounded-2xl and rounded-[Npx] are dead vocabulary.',
  )
}

// 1e1a. ui-uniformity: no baseline, the 2026-09 sweep brought every rule to
// 0 and any new finding is a hard failure.
if (current.uiUniformity.length) {
  failed = true
  console.error(
    `\n✗ ui-uniformity: ${current.uiUniformity.length} design-system violation(s) (.claude/rules/design.md):`,
  )
  const rules = [...new Set(current.uiUniformity.map((f) => f.rule))]
  for (const rule of rules) {
    console.error(`  ${rule}: ${UI_UNIFORMITY_HINTS[rule]}`)
    current.uiUniformity
      .filter((f) => f.rule === rule)
      .forEach((f) => console.error(`    ${f.where}  ${f.detail}`))
  }
}

// 1e1b. folded-public-flag: no baseline, the count is 0 and any new in-place
// comparison is a hard failure. This one is invisible in dev and in the Vercel
// build (both have real env values); it only misfires in the Docker image, and
// then silently.
if (current.foldedPublicFlags.length) {
  failed = true
  console.error(
    `\n✗ folded-public-flag: ${current.foldedPublicFlags.length} NEXT_PUBLIC_* flag(s) compared in place:`,
  )
  current.foldedPublicFlags.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → read the value instead: flagEnabled(process.env.NEXT_PUBLIC_X) from @/lib/env/public-flags\n' +
      '    (or isSelfHosted()). Comparing in place lets the minifier fold the Docker sentinel to\n' +
      '    false and delete the branch, so the flag can never be switched on by an operator.',
  )
}

// 1e1c. direct-ai-client: allowlist in this file, may only shrink. A file
// outside the allowlist that talks to a model SDK directly is a NEW
// violation; allowlisted files that no longer do are reported as progress.
const newDirectAi = current.directAiClients.filter((f) => !DIRECT_AI_CLIENT_ALLOWED.has(f.file))
const directAiFilesNow = new Set(current.directAiClients.map((f) => f.file))
const migratedDirectAi = [...DIRECT_AI_CLIENT_ALLOWED].filter((f) => !directAiFilesNow.has(f))
if (newDirectAi.length) {
  failed = true
  console.error(
    `\n✗ direct-ai-client: ${newDirectAi.length} file(s) outside lib/ai talk to a model SDK directly:`,
  )
  newDirectAi.forEach((f) => console.error(`    ${f.file}  (${f.rule})`))
  console.error(
    '  → use getAiService() from @/lib/ai (generateText / generateStructured / extractFromDocument).\n' +
      '    Hosted and self-host resolve the backend from the environment there; a direct SDK call\n' +
      '    hard-wires one provider and breaks the sovereign self-host path.',
  )
}

// 1e1d. utc-today: allowlist in utc-today.mjs, may only shrink. A UTC
// "today" outside it is a NEW violation; allowlisted files that no longer
// compute one are reported as progress.
const newUtcToday = current.utcToday.filter((f) => !UTC_TODAY_ALLOWED.has(f.file))
const utcTodayFilesNow = new Set(current.utcToday.map((f) => f.file))
const migratedUtcToday = [...UTC_TODAY_ALLOWED].filter((f) => !utcTodayFilesNow.has(f))
if (newUtcToday.length) {
  failed = true
  console.error(`\n✗ utc-today: ${newUtcToday.length} site(s) read "today" by hand:`)
  newUtcToday.forEach((f) => console.error(`    ${f.file}:${f.line}`))
  console.error(
    '  → use todayIsoStockholm(now) or stockholmYearMonth(now) from @/lib/dates/iso, and\n' +
      '    addDaysIso / addMonthsIso on that ISO date for a horizon. The UTC date, and a\n' +
      "    Date's getters on a server in UTC, are yesterday in Sweden between midnight and\n" +
      '    01:00/02:00, so a default date, a cutoff or an as-of date computed from them\n' +
      '    books, filters or labels against the wrong day.',
  )
}

// 1e2. hand-rolled-invariant: counted, may only go down.
if (current.handRolledInvariants > (baseline.handRolledInvariants?.count ?? Infinity)) {
  failed = true
  console.error(
    `\n✗ hand-rolled-invariant: ${current.handRolledInvariants} inline copies of a shared format rule ` +
      `(baseline ${baseline.handRolledInvariants?.count}):`,
  )
  console.error(
    '  → import the rule instead: accountNumberSchema / isoDateSchema / saneIsoDateSchema /\n' +
      '    fiscalYearSchema from @/lib/invariants/zod, or the ACCOUNT_NUMBER_RE / ISO_DATE_RE\n' +
      '    constants from @/lib/invariants. See lib/invariants/README.md.',
  )
}

// 1f. cross-extension-import: a physical extension route may only import its
// own extension. No baseline: the count is 0 today, any hit is a hard failure.
if (current.extensionRoutes.crossImports.length) {
  failed = true
  console.error(
    `\n✗ cross-extension-import: ${current.extensionRoutes.crossImports.length} route(s) under ` +
      `app/api/extensions/<id>/ import a DIFFERENT extension:`,
  )
  current.extensionRoutes.crossImports.forEach((c) =>
    console.error(`    ${c.file} imports @/extensions/*/${c.imported}/`),
  )
  console.error(
    '  → a physical extension route may only import its own extension; shared logic belongs in lib/\n' +
      '    or behind the Extension.services registry bridge.',
  )
}

// 1g. ungated-extension-route: allowlist lives in extension-route-guards.mjs
// (UNGATED_EXTENSION_ROUTES) and may only shrink. A NEW physical extension
// route must check extensionRegistry.get('<id>') before executing extension
// code, so disabling the extension in extensions.config.json actually
// disarms the deployed route.
const newUngatedRoutes = current.extensionRoutes.ungated.filter(
  (f) => !UNGATED_EXTENSION_ROUTES.has(f),
)
const gatedSinceBaseline = [...UNGATED_EXTENSION_ROUTES].filter(
  (f) => !current.extensionRoutes.ungated.includes(f),
)
if (newUngatedRoutes.length) {
  failed = true
  console.error(
    `\n✗ ungated-extension-route: ${newUngatedRoutes.length} new physical extension route(s) run ` +
      `extension code without checking the registry:`,
  )
  newUngatedRoutes.forEach((f) => console.error(`    ${f}`))
  console.error(
    "  → refuse (503 EXTENSION_DISABLED) when await extensionRegistry.get('<id>')\n" +
      '    is undefined, like app/api/extensions/invoice-inbox/sweep/cron/route.ts.',
  )
}

// 1g2. limit-above-page: allowlist lives in limit-above-page.mjs
// (LIMIT_ABOVE_PAGE_ALLOWED) and may only shrink. PostgREST cuts every read
// at 1000 rows without an error, so a larger .limit() is a silent 1000.
const newLimitsAbovePage = current.limitsAbovePage.filter((f) => !LIMIT_ABOVE_PAGE_ALLOWED.has(f.file))
const limitAbovePageFilesNow = new Set(current.limitsAbovePage.map((f) => f.file))
const pagedSinceBaseline = [...LIMIT_ABOVE_PAGE_ALLOWED].filter((f) => !limitAbovePageFilesNow.has(f))
if (newLimitsAbovePage.length) {
  failed = true
  console.error(
    `\n✗ limit-above-page: ${newLimitsAbovePage.length} .limit() call(s) or limit option(s) above 1000 rows, which PostgREST ` +
      `silently answers with 1000:`,
  )
  newLimitsAbovePage.forEach((f) => console.error(`    ${f.file}:${f.line}  ${f.call} = ${f.limit}`))
  console.error(
    '  → page with fetchAllRows (lib/supabase/fetch-all.ts) after an .order() on a unique column; pass\n' +
      '    { maxRows } to keep a deliberate cap. Read an aggregate for a sum or a count. A sample stays at\n' +
      '    .limit(1000) or below, with a comment saying it is a sample.',
  )
}

// 1g3. lines-inner-embed: allowlist lives in lines-inner-embed.mjs
// (LINES_INNER_EMBED_ALLOWED) and may only shrink. A journal_entry_lines read
// filtered through a journal_entries!inner embed walks every tenant's lines.
const newLinesInnerEmbeds = current.linesInnerEmbeds.filter((f) => !LINES_INNER_EMBED_ALLOWED.has(f.file))
if (newLinesInnerEmbeds.length) {
  failed = true
  console.error(
    `\n✗ lines-inner-embed: ${newLinesInnerEmbeds.length} journal_entry_lines read(s) filtered through a journal_entries!inner ` +
      'embed, which PostgREST plans from every tenant\'s lines:',
  )
  newLinesInnerEmbeds.forEach((f) => console.error(`    ${f.file}:${f.line}  select('${f.select}')`))
  console.error(
    '  → read entry first: fetchEntryLines / fetchLinesByEntryIds (lib/bookkeeping/entry-lines.ts) filter\n' +
      '    journal_entries on its own columns and read the lines by journal_entry_id; or call a ledger RPC.',
  )
}
const linesInnerEmbedFilesNow = new Set(current.linesInnerEmbeds.map((f) => f.file))
const staleLinesInnerEmbedAllowed = [...LINES_INNER_EMBED_ALLOWED].filter((f) => !linesInnerEmbedFilesNow.has(f))
if (staleLinesInnerEmbedAllowed.length) {
  console.log(
    `\n✓ lines-inner-embed progress: ${staleLinesInnerEmbedAllowed.length} allowlisted file(s) no longer embed journal_entries!inner.` +
      ' Remove them from LINES_INNER_EMBED_ALLOWED in scripts/checks/lines-inner-embed.mjs to lock it in:',
  )
  staleLinesInnerEmbedAllowed.forEach((f) => console.log(`    ${f}`))
}

// 1h. static-init-import: no allowlist. lib/init is imported by
// instrumentation.ts alone (a dynamic import in register()); any other import
// of it, static or dynamic, compiles every extension into that entry again,
// and a client module that reaches the bus ships server state to the browser.
// 1h2. lazy-init-reach: counted, may only go down. A server entry whose graph
// reaches lib/init, following dynamic imports, compiles lib/init and every
// extension, about 1,400 modules each. 474 of them OOM-killed the production
// build on 2026-10-15; since 2026-10-16 instrumentation.ts is the only one.
const lazyInitBaseline = baseline.lazyInitReach
if (lazyInitBaseline && current.lazyInitEntries.length > lazyInitBaseline.count) {
  failed = true
  const known = new Set(lazyInitBaseline.files ?? [])
  const added = current.lazyInitEntries.filter((o) => !known.has(o.entry))
  console.error(
    `\n✗ lazy-init-reach: ${current.lazyInitEntries.length} server entries reach lib/init ` +
      `(baseline ${lazyInitBaseline.count}, +${current.lazyInitEntries.length - lazyInitBaseline.count}). ` +
      'Each one compiles lib/init and every extension into the production build:',
  )
  added.slice(0, 30).forEach(({ entry, chain }) => console.error(`    ${entry}\n      via ${chain.join(' -> ')}`))
  if (added.length > 30) console.error(`    ... and ${added.length - 30} more`)
  console.error(
    '  → drop the import of lib/init from the chain: instrumentation.ts registers its loader at boot, and\n' +
      '    eventBus.emit() and the registry getters wait for it (lib/initialized.ts).\n' +
      '  → --update cannot raise this count.',
  )
}

if (current.staticInitImports.length) {
  failed = true
  console.error(
    `\n✗ static-init-import: ${current.staticInitImports.length} module(s) reach lib/init outside instrumentation.ts, ` +
      'or reach the event bus from the browser: a server entry would compile every extension again, a client ' +
      'module would ship server state to the browser:',
  )
  current.staticInitImports.forEach(({ kind, entry, chain }) =>
    console.error(`    ${entry} (${kind})\n      via ${chain.join(' -> ')}`),
  )
  console.error(
    '  → server: drop the import, static or dynamic; instrumentation.ts loads lib/init at boot, and\n' +
      '    eventBus.emit() and the registry getters (await extensionRegistry.get(), await getEmailService(), ...)\n' +
      '    wait for it. Only instrumentation.ts imports it.\n' +
      '  → client: import the pure helper from a module of its own, not from a server module that emits.',
  )
}

// 1h2. decision-log: no allowlist. A decision is a file of its own under
// docs/decisions/YYYY-MM/; an appended line conflicts with every other merge
// request that appends one.
if (current.decisionLog.length) {
  failed = true
  console.error(`\n✗ decision-log: ${current.decisionLog.length} problem(s) in the decision log:`)
  current.decisionLog.forEach(({ file, problem }) => console.error(`    ${file}: ${problem}`))
  console.error(`  → ${DECISION_LOG_HINT}`)
}

// 1h3. script-init-condition: no allowlist. A script that loads lib/init and
// is run without the react-server condition cannot load it; until 2026-10-16
// it then posted with every event reaching no handler.
if (current.scriptInitCondition.length) {
  failed = true
  console.error(
    `\n✗ script-init-condition: ${current.scriptInitCondition.length} invocation(s) of a script that loads lib/init ` +
      'without the react-server condition, or a script registering the server loader itself:',
  )
  current.scriptInitCondition.forEach(({ rule, file, line, text }) =>
    console.error(`    ${file}${line ? `:${line}` : ''} (${rule}): ${text}`),
  )
  console.error(`  → ${SCRIPT_INIT_CONDITION_HINT}`)
}

// 1i. local-test-mock: a test that hand-rolls a helper tests/ already shares
// (local-test-mock.mjs). The thenable-chain allowlist may only shrink; a local
// cronRequest or setActiveCompany is a hard failure.
const { localTestMocks } = current
const newLocalChains = localTestMocks.supabaseChain.filter((f) => !LOCAL_SUPABASE_CHAIN_ALLOWED.has(f))
const sharedSinceBaseline = [...LOCAL_SUPABASE_CHAIN_ALLOWED].filter(
  (f) => !localTestMocks.supabaseChain.includes(f),
)
if (newLocalChains.length) {
  failed = true
  console.error(`\n✗ local-supabase-chain: ${newLocalChains.length} test file(s) build their own thenable Supabase chain:`)
  newLocalChains.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → use createTableMockSupabase / createQueuedMockSupabase / createMockSupabase from\n' +
      '    tests/helpers.ts, and extend them there when a test needs something they lack.',
  )
}
for (const [name, files, fix] of [
  ['local-cron-request', localTestMocks.cronRequest, 'createCronRequest(path) from tests/helpers.ts'],
  ['local-set-active-company', localTestMocks.setActiveCompany, 'setActiveCompany from tests/pg/fixtures.ts'],
]) {
  if (!files.length) continue
  failed = true
  console.error(`\n✗ ${name}: ${files.length} test file(s) define their own copy:`)
  files.forEach((f) => console.error(`    ${f}`))
  console.error(`  → use ${fix}.`)
}

// 1c. ledger-scanning-report: any statement generator not in the baseline set
// is a NEW violation. Grandfathered files stay until they migrate.
const ledgerScanBaseline = new Set(baseline.ledgerScanningReports?.files ?? [])
const newLedgerScans = current.ledgerScanningReports.filter((f) => !ledgerScanBaseline.has(f))
const fixedLedgerScans = (baseline.ledgerScanningReports?.files ?? []).filter(
  (f) => !current.ledgerScanningReports.includes(f),
)
if (newLedgerScans.length) {
  failed = true
  console.error(
    `\n✗ ledger-scanning-report: ${newLedgerScans.length} statement generator(s) aggregate ` +
      `journal_entry_lines directly instead of going through generateTrialBalance:`,
  )
  newLedgerScans.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → call generateTrialBalance with an explicit closingEntry mode. Aggregating raw\n' +
      '    lines means remembering the resultatavslut yourself, and three reports already\n' +
      '    forgot (each read ZERO revenue for a closed year while the balance sheet still\n' +
      '    tied out, so nothing warned). If the report genuinely lists vouchers rather\n' +
      '    than balances, add it to LEDGER_SCAN_SANCTIONED in this file with a reason.',
  )
}

// 1c2. provider-host: a file naming a provider API host outside the
// grandfathered set is a NEW direct integration in the open repo.
const providerHostBaseline = new Set(baseline.providerHosts?.files ?? [])
const newProviderHosts = current.providerHosts.filter((f) => !providerHostBaseline.has(f))
const fixedProviderHosts = (baseline.providerHosts?.files ?? []).filter((f) => !current.providerHosts.includes(f))
if (baseline.providerHosts && newProviderHosts.length) {
  failed = true
  console.error(
    `\n✗ provider-host: ${newProviderHosts.length} new file(s) call a provider API host directly:`,
  )
  newProviderHosts.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → provider integration logic lives behind the connector, not in the open ledger:\n' +
      '    route the call through the hosted connector (app/api/connect/*) and the\n' +
      '    instance-side connector-mode seam (lib/connect/instance/upstreams.ts), or\n' +
      '    keep the manual file path. If this file IS the connector\'s own hosted adapter\n' +
      '    side, re-baseline with --update and say so in the PR.',
  )
}

// 1c3. unsigned-provider-names: no baseline, any hit is a hard failure. The
// findings never print the matched text (CI logs are public).
if (current.unsignedProviderNames.skipped === 'no-names') {
  console.log(`\n· unsigned-provider-names: skipped, ${PROVIDER_NAMES_UNSET_NOTE}.`)
} else if (current.unsignedProviderNames.skipped === 'no-base') {
  console.log(
    `\n· unsigned-provider-names: skipped, no merge base with ${current.unsignedProviderNames.baseRef} in this checkout` +
      ' (the provider-names workflow scans the PR with full history).',
  )
} else if (current.unsignedProviderNames.findings.length) {
  failed = true
  console.error(
    `\n✗ unsigned-provider-names: ${current.unsignedProviderNames.findings.length} place(s) in the change name a provider that is not signed yet:`,
  )
  current.unsignedProviderNames.findings.forEach((f) => console.error(formatProviderNameFinding(f)))
  console.error(PROVIDER_NAME_HINT)
}

// 1d. raw-reference-fetch: per-file ratchet. A file outside the baseline set
// that fetches reference data raw (see raw-reference-fetch.mjs) is a NEW
// violation; grandfathered files stay until they move to the hooks. Once the
// baseline reaches 0, delete the entry so any new site is a hard failure.
const rawRefBaseline = new Set(baseline.rawReferenceFetch?.files ?? [])
const newRawRefs = current.rawReferenceFetch.filter((f) => !rawRefBaseline.has(f))
const fixedRawRefs = (baseline.rawReferenceFetch?.files ?? []).filter(
  (f) => !current.rawReferenceFetch.includes(f),
)
if (newRawRefs.length) {
  failed = true
  console.error(
    `\n✗ raw-reference-fetch: ${newRawRefs.length} file(s) fetch reference data raw ` +
      `(fiscal periods, settings, accounts, cash accounts, dimensions, templates, customers, suppliers, articles):`,
  )
  newRawRefs.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → read it through the hooks in lib/reference-data/hooks.ts (useFiscalPeriods, useAccounts,\n' +
      '    useCashAccounts, useCompanySettings, useDimensions, useBookingTemplates, useCustomers,\n' +
      '    useSuppliers, useArticles) and call invalidateReferenceData() after writes. Those hooks\n' +
      '    share one session cache and are seeded by the dashboard layout, so the fields render\n' +
      '    on first paint instead of after another round trip.',
  )
}

// 1e3. dialog-overflow-risk: per-file ratchet, a finding in a file outside
// the baseline set is a NEW violation. Grandfathered files stay until fixed.
const dialogOverflowBaseline = new Set(baseline.dialogOverflowRisk?.files ?? [])
const newDialogOverflow = current.dialogOverflowRisk.filter(
  (finding) => !dialogOverflowBaseline.has(finding.file),
)
const fixedDialogOverflow = [...dialogOverflowBaseline].filter(
  (file) => !dialogOverflowFiles.includes(file),
)
if (newDialogOverflow.length) {
  failed = true
  console.error(
    `\n✗ dialog-overflow-risk: ${newDialogOverflow.length} overflow-risky pattern(s) in new dialog/sheet file(s):`,
  )
  newDialogOverflow.forEach((finding) => console.error(`    ${finding.where}  (${finding.rule})`))
  console.error(
    '  → bare-fr-grid-track: a bare 1fr track refuses to shrink below its content; use\n' +
      '    minmax(0,1fr), plus min-w-0 on the cell when a combobox/long text lives in it.\n' +
      '    nowrap-in-dialog: give the table/row its own overflow-x-auto wrapper, then allowlist\n' +
      '    the file in DIALOG_NOWRAP_ALLOWED in this script with a reason.\n' +
      '    unportaled-wide-overlay: portal the panel to document.body with viewport-clamped\n' +
      '    geometry, like AccountCombobox\'s dropdown or info-tooltip.tsx.',
  )
}

// 1e4. table-without-grant: the migrations written against Supabase's old
// grant-everything default are grandfathered as a file set. Migration files
// are immutable, so the set never shrinks; any other file with a finding is
// NEW and fails, whatever its timestamp.
const tableWithoutGrantBaseline = new Set(baseline.tableWithoutGrant?.files ?? [])
const newTableWithoutGrant = current.tableWithoutGrant.filter(
  (f) => !tableWithoutGrantBaseline.has(f.file),
)
if (newTableWithoutGrant.length) {
  failed = true
  console.error(
    `\n✗ table-without-grant: ${newTableWithoutGrant.length} relation(s) or grant(s) in new migrations ` +
      'leave the Data API roles without an explicit, named grant:',
  )
  for (const f of newTableWithoutGrant) {
    const what =
      f.kind === 'bulk-grant'
        ? f.detail
        : f.kind === 'serial-without-grant'
          ? `public.${f.relation} has a serial column (${f.sequence}; no grant to ${f.roles.join(', ')})`
          : `public.${f.relation} (${f.relationKind}; no grant to ${f.roles.join(', ')})`
    console.error(`    ${f.file}:${f.line}  ${what}`)
    grantHint(f).forEach((l) => console.error(`        ${l}`))
  }
  console.error(
    '  → new public tables get NO grants by default (migration 20260929220000_own_default_privileges;\n' +
      '    every Supabase project from 2026-10-30), so without the lines above the table answers 42501\n' +
      '    to every supabase-js client, the service-role one included. Put them in the same migration,\n' +
      '    after the CREATE. anon gets a grant only when the table is meant to be public. Template:\n' +
      '    .claude/skills/supabase-migration/SKILL.md.',
  )
}

// 1e5. functiondef-patch: the migrations that patched function bodies through
// pg_get_functiondef are grandfathered as a file set; any other migration
// that calls it fails, whatever its timestamp.
const functiondefPatchBaseline = new Set(baseline.functiondefPatch?.files ?? [])
const newFunctiondefPatch = current.functiondefPatch.filter((f) => !functiondefPatchBaseline.has(f.file))
if (newFunctiondefPatch.length) {
  failed = true
  console.error(
    `\n✗ functiondef-patch: ${newFunctiondefPatch.length} pg_get_functiondef() call(s) in new migrations:`,
  )
  newFunctiondefPatch.forEach((f) => console.error(`    ${f.file}:${f.line}`))
  FUNCTIONDEF_PATCH_HINT.forEach((l, i) => console.error(`  ${i === 0 ? '→' : ' '} ${l}`))
}

// 1f. hand-built-voucher-ref: count may not increase. A voucher reference
// spelled at a call site drifts ("A113", "A-113", "113" for one verifikat);
// formatVoucher is the one format (see hand-built-voucher-ref.mjs).
const handBuiltVoucherRefBaseline = baseline.handBuiltVoucherRef?.count ?? Infinity
if (current.handBuiltVoucherRef.length > handBuiltVoucherRefBaseline) {
  failed = true
  console.error(
    `\n✗ hand-built-voucher-ref: ${current.handBuiltVoucherRef.length} voucher reference(s) built from series and number by hand ` +
      `(baseline ${handBuiltVoucherRefBaseline}, +${current.handBuiltVoucherRef.length - handBuiltVoucherRefBaseline}):`,
  )
  for (const f of current.handBuiltVoucherRef) console.error(`    ${f.file}:${f.line}`)
  console.error(
    "  → format it with formatVoucher(entry) from '@/lib/bookkeeping/voucher-series-resolver': \"A113\",\n" +
      "    'A' for a row without a series, \"-\" for a draft. Guard the draft yourself when the field must be null\n" +
      "    (entry.voucher_number ? formatVoucher(entry) : null). { separator: '-' } is only for the v1 fields\n" +
      '    documented as "A-12".',
  )
}

// 1e. literal-legal-form: count may not increase. A legal form named as a
// string at a call site (see literal-legal-form.mjs) sends every later form
// down the branch it was not written for; docs/LEGAL-FORMS.md has the
// profile reads that replace each shape.
const literalLegalFormBaseline = baseline.literalLegalForm?.count ?? Infinity
if (current.literalLegalForm.length > literalLegalFormBaseline) {
  failed = true
  console.error(
    `\n✗ literal-legal-form: ${current.literalLegalForm.length} site(s) compare, default or tag a legal form ` +
      `as a string literal (baseline ${literalLegalFormBaseline}, +${current.literalLegalForm.length - literalLegalFormBaseline}). ` +
      'Sites in files changed most recently are the likely additions:',
  )
  const byFile = new Map()
  for (const f of current.literalLegalForm) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1)
  for (const [file, n] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    console.error(`    ${file} (${n})`)
  console.error(
    '  → read a capability from lib/company/entity-type.ts instead (filesIncomeReturn, hasOwners,\n' +
      '    resultClosingAccounts, preparesArsredovisning, ...), tag data with an array of forms, and\n' +
      '    never default a missing form: resolveCompanyEntityType() throws instead. docs/LEGAL-FORMS.md.',
  )
}

// 1j. jurisdiction welds (bas-account-literal, sek-literal, kernel-import):
// per-file ratchets from jurisdiction-welds.mjs. A file above its baseline
// count, or a kernel file with an import edge the baseline does not list, is
// a violation. Each file's sites are printed because a count cannot say which
// one is new.
const printSites = (sites, file, baselineCount) => {
  const inFile = sites.filter((s) => s.file === file)
  inFile.slice(0, 40).forEach((s) => console.error(`        :${s.line}  ${s.kind ? `${s.kind}  ` : ''}${s.match}`))
  if (inFile.length > 40) console.error(`        ... ${inFile.length - 40} more`)
  if (baselineCount > 0) console.error('        (a count cannot say which site is new: find it in your diff of this file)')
}
const NEVER_RAISE =
  '    Never raise the baseline to make this pass without a decision file saying why; a pure\n' +
  '    move or rename re-baselines with --update and says so in the PR.'

const basLiteralRatchet = compareFileCounts(baseline.basAccountLiteral?.files ?? {}, basLiteralCounts)
if (baseline.basAccountLiteral && basLiteralRatchet.grown.length) {
  failed = true
  console.error(
    `\n✗ bas-account-literal: ${basLiteralRatchet.grown.length} file(s) gained a BAS account number or ` +
      'account-prefix check outside the SE pack territory:',
  )
  for (const g of basLiteralRatchet.grown) {
    console.error(`    ${g.file}: ${g.current} (baseline ${g.baseline})`)
    printSites(current.jurisdictionWelds.basAccountLiteral, g.file, g.baseline)
  }
  console.error(
    '  → Accounted is going multi-country with Sweden as jurisdiction pack one, and an account number\n' +
      "    at a call site is a place the next country's chart cannot reach. Read the account from one\n" +
      "    named role instead: resolveAccountRole(company, 'accounts_receivable') from\n" +
      '    lib/bookkeeping/account-roles (a new role goes there, its BAS account in se-bas.ts), an\n' +
      '    existing constant (RESULT_ACCOUNT, VAT_SETTLEMENT_ACCOUNT,\n' +
      '    SALARY_ACCOUNTS, ...), the legal-form profile (lib/company/forms), or the chart data\n' +
      '    (getBASReference). If the logic is Swedish-only (a Swedish filing, a BAS-shaped rule), put it,\n' +
      '    or the new named role, in SE pack territory: SE_PACK_TERRITORY in\n' +
      '    scripts/checks/jurisdiction-welds.mjs.\n' +
      NEVER_RAISE,
  )
}

const sekLiteralRatchet = compareFileCounts(baseline.sekLiteral?.files ?? {}, sekLiteralCounts)
if (baseline.sekLiteral && sekLiteralRatchet.grown.length) {
  failed = true
  console.error(
    `\n✗ sek-literal: ${sekLiteralRatchet.grown.length} file(s) gained a comparison against the literal 'SEK' ` +
      'outside the currency-conversion code:',
  )
  for (const g of sekLiteralRatchet.grown) {
    console.error(`    ${g.file}: ${g.current} (baseline ${g.baseline})`)
    printSites(current.jurisdictionWelds.sekLiteral, g.file, g.baseline)
  }
  console.error(
    "  → the ledger currency becomes a per-company jurisdiction setting, and every in-place 'SEK' is a\n" +
      '    site someone has to find then. Let the conversion helpers decide instead\n' +
      '    (resolveSekAmountOrNull / resolveSekAmount / buildCurrencyMetadata in\n' +
      '    lib/bookkeeping/currency-utils.ts, lib/currency/*). If you need a new "is this already the\n' +
      '    ledger currency?" decision, add it there as a named function: CURRENCY_CONVERSION_CODE in\n' +
      '    scripts/checks/jurisdiction-welds.mjs.\n' +
      NEVER_RAISE,
  )
}

const kernelImportRatchet = compareFileEdges(baseline.kernelImports?.files ?? {}, kernelImportEdges)
if (baseline.kernelImports && kernelImportRatchet.added.length) {
  failed = true
  console.error(
    `\n✗ kernel-import: ${kernelImportRatchet.added.length} new import(s) of an outer business module from ` +
      'the ledger kernel (lib/bookkeeping/engine.ts, lib/core/**):',
  )
  kernelImportRatchet.added.forEach((e) => console.error(`    ${e.file} -> ${e.module}`))
  console.error(
    '  → the kernel is what every jurisdiction pack shares, so it must not reach up into features.\n' +
      '    Invert the dependency (the caller passes the value or a callback in), or move the shared\n' +
      '    primitive down into lib/core or lib/bookkeeping. Shared infrastructure without business\n' +
      '    logic may be added to KERNEL_INNER_MODULES in scripts/checks/jurisdiction-welds.mjs, one\n' +
      '    module at a time when its directory also holds features.\n' +
      NEVER_RAISE,
  )
}

// 1k. posting-port-bypass: (file, name) edges from posting-port-bypass.mjs.
// An edge the baseline does not list is a new direct call of the engine's
// posting surface: its verifikat would record no business event. A missing
// baseline key counts as empty, so the guard fails closed.
const postingBypassBaseline = baseline.postingPortBypass?.files ?? {}
const postingBypassRatchet = compareFileEdges(postingBypassBaseline, postingBypassEdges)
if (postingBypassRatchet.added.length) {
  failed = true
  console.error(
    `\n✗ posting-port-bypass: ${postingBypassRatchet.added.length} new call(s) of the engine's posting ` +
      'functions outside src/lib/posting:',
  )
  postingBypassRatchet.added.forEach((e) =>
    console.error(`    ${e.file}: ${e.module === '*' ? '* (the whole module, through a namespace or import())' : e.module}`),
  )
  POSTING_PORT_BYPASS_HINT.forEach((l, i) => console.error(`  ${i === 0 ? '→' : ' '} ${l}`))
  console.error('    --update cannot add an edge to the baseline.')
}
const stalePermanentAllowlist = Object.entries(PERMANENT_ALLOWLIST).flatMap(([file, { names }]) =>
  names.filter((n) => !(current.postingPort.allowlisted[file] ?? []).includes(n)).map((n) => `${file}: ${n}`),
)

// 1l. swedish-ui-literal: per-file ratchet from swedish-ui-literal.mjs. A
// file above its baseline count is a new Swedish string that skipped the
// message catalogue. A missing baseline key counts as empty, so the guard
// fails closed.
const swedishUiLiteralRatchet = compareFileCounts(baseline.swedishUiLiteral?.files ?? {}, swedishUiLiteralCounts)
if (swedishUiLiteralRatchet.grown.length) {
  failed = true
  console.error(
    `\n✗ swedish-ui-literal: ${swedishUiLiteralRatchet.grown.length} file(s) gained Swedish text written ` +
      'straight into the UI instead of a message key:',
  )
  for (const g of swedishUiLiteralRatchet.grown) {
    console.error(`    ${g.file}: ${g.current} (baseline ${g.baseline})`)
    printSites(current.swedishUiLiterals, g.file, g.baseline)
  }
  SWEDISH_UI_LITERAL_HINT.forEach((l, i) => console.error(`  ${i === 0 ? '→' : ' '} ${l}`))
  console.error(NEVER_RAISE)
}

// 1m. duplicate-block: shared normalised lines per file pair from
// duplicate-blocks.mjs. A pair above its baseline, or a pair the baseline
// does not have, is a new copy. The pair's blocks are printed because a count
// cannot say which one is new.
const duplicateRatchet = compareFileCounts(baseline.duplicateBlocks?.pairs ?? {}, duplicatePairs)
if (baseline.duplicateBlocks && baseline.duplicateBlocks.window !== DUPLICATE_WINDOW) {
  failed = true
  console.error(
    `\n✗ duplicate-block: the baseline was measured with a window of ${baseline.duplicateBlocks.window} lines, ` +
      `the check now uses ${DUPLICATE_WINDOW}. Re-baseline with --update and say why in a decision file.`,
  )
} else if (baseline.duplicateBlocks && duplicateRatchet.grown.length) {
  failed = true
  console.error(`\n✗ duplicate-block: ${duplicateRatchet.grown.length} file pair(s) share more copied code than before:`)
  for (const g of duplicateRatchet.grown) {
    console.error(`    ${g.file}: ${g.current} shared line(s) (baseline ${g.baseline})`)
    const [a, b] = g.file.split(' <-> ')
    const inPair = current.duplicateBlocks.blocks.filter((blk) => blk.a === a && blk.b === b)
    inPair.slice(0, 10).forEach((blk) => console.error(`        ${formatDuplicateBlock(blk)}`))
    if (inPair.length > 10) console.error(`        ... ${inPair.length - 10} more`)
    if (g.baseline > 0) console.error('        (a count cannot say which block is new: find it in your diff of these files)')
  }
  console.error(
    '  → Duplicated code drifts: the copy that misses the next fix is the bug (October 2026: twelve posting-line\n' +
      '    types, five payment dialogs). Call the existing code, or extract the shared part into one module both\n' +
      '    files import. A copy you cannot avoid (a generated file, a deliberate fork) needs a decision file\n' +
      '    (docs/decisions/YYYY-MM/) and --update in the same PR.\n' +
      NEVER_RAISE,
  )
}

// 1n. error-masking: swallowed errors per file from error-masking.mjs.
const errorMaskingRatchet = compareFileCounts(baseline.errorMasking?.files ?? {}, errorMaskingCounts)
if (baseline.errorMasking && errorMaskingRatchet.grown.length) {
  failed = true
  console.error(`\n✗ error-masking: ${errorMaskingRatchet.grown.length} file(s) swallow more errors than before:`)
  for (const g of errorMaskingRatchet.grown) {
    console.error(`    ${g.file}: ${g.current} (baseline ${g.baseline})`)
    const inFile = current.errorMasking.filter((s) => s.file === g.file)
    inFile.slice(0, 20).forEach((s) => console.error(`        ${formatErrorMasking(s)}`))
    if (g.baseline > 0) console.error('        (a count cannot say which site is new: find it in your diff of this file)')
  }
  console.error(
    '  → A caught error must leave a trace, or the failure turns into wrong data nobody can find.\n' +
      NEVER_RAISE,
  )
}

// 2. naive-ore-round: count may not increase.
if (current.naiveOreRound > baseline.naiveOreRound.count) {
  failed = true
  console.error(
    `\n✗ naive-ore-round: ${current.naiveOreRound} occurrences of Math.round(x*100)/100 ` +
      `(baseline ${baseline.naiveOreRound.count}, +${current.naiveOreRound - baseline.naiveOreRound.count}).`,
  )
  console.error('  → import roundOre from @/lib/money instead.')
}

// 2b. mcp-bare-error: count may not increase.
const mcpBareErrorBaseline = baseline.mcpBareErrorThrows?.count ?? Infinity
if (current.mcpBareErrorThrows > mcpBareErrorBaseline) {
  failed = true
  console.error(
    `\n✗ mcp-bare-error: ${current.mcpBareErrorThrows} bare \`throw new Error(\` in src/extensions/general/mcp-server ` +
      `(baseline ${mcpBareErrorBaseline}, +${current.mcpBareErrorThrows - mcpBareErrorBaseline}).`,
  )
  console.error(
    '  → A plain Error reaches the agent as UNKNOWN_ERROR, "Något gick fel. Försök igen.", which invites a\n' +
      '    retry. Throw a coded refusal from @/lib/errors/refusal instead: codedRefusal(code, message, remediation?)\n' +
      '    with a code from lib/errors/structured-errors.ts (add one there if none fits), badArgument(field, message)\n' +
      '    or fieldValidationError for an argument, or codedError from ./company-routing for VALIDATION_ERROR,\n' +
      '    NOT_FOUND or FORBIDDEN. An internal invariant that only a bug can break may stay INTERNAL_ERROR:\n' +
      "    codedRefusal('INTERNAL_ERROR', message).",
  )
}

// Report ratchet-down progress (informational, never fails).
if (
  fixedAuthFiles.length ||
  fixedLedgerScans.length ||
  fixedDialogOverflow.length ||
  fixedRawRefs.length ||
  fixedProviderHosts.length ||
  (lazyInitBaseline && current.lazyInitEntries.length < lazyInitBaseline.count) ||
  basLiteralRatchet.shrunk.length ||
  sekLiteralRatchet.shrunk.length ||
  kernelImportRatchet.removed.length ||
  postingBypassRatchet.removed.length ||
  swedishUiLiteralRatchet.shrunk.length ||
  duplicateRatchet.shrunk.length ||
  errorMaskingRatchet.shrunk.length ||
  current.naiveOreRound < baseline.naiveOreRound.count ||
  current.mcpBareErrorThrows < mcpBareErrorBaseline ||
  current.literalLegalForm.length < literalLegalFormBaseline ||
  current.handBuiltVoucherRef.length < handBuiltVoucherRefBaseline
) {
  console.log('\n✓ Progress since baseline:')
  const shrunkBy = (r) => r.shrunk.reduce((n, s) => n + s.baseline - s.current, 0)
  if (basLiteralRatchet.shrunk.length)
    console.log(
      `    bas-account-literal: -${shrunkBy(basLiteralRatchet)} site(s) in ${basLiteralRatchet.shrunk.length} file(s)`,
    )
  if (sekLiteralRatchet.shrunk.length)
    console.log(
      `    sek-literal: -${shrunkBy(sekLiteralRatchet)} site(s) in ${sekLiteralRatchet.shrunk.length} file(s)`,
    )
  if (kernelImportRatchet.removed.length)
    console.log(`    kernel-import: -${kernelImportRatchet.removed.length} import edge(s)`)
  if (swedishUiLiteralRatchet.shrunk.length)
    console.log(
      `    swedish-ui-literal: -${shrunkBy(swedishUiLiteralRatchet)} site(s) in ${swedishUiLiteralRatchet.shrunk.length} file(s)`,
    )
  if (duplicateRatchet.shrunk.length)
    console.log(
      `    duplicate-block: -${shrunkBy(duplicateRatchet)} shared line(s) in ${duplicateRatchet.shrunk.length} file pair(s)`,
    )
  if (errorMaskingRatchet.shrunk.length)
    console.log(
      `    error-masking: -${shrunkBy(errorMaskingRatchet)} site(s) in ${errorMaskingRatchet.shrunk.length} file(s)`,
    )
  if (postingBypassRatchet.removed.length) {
    console.log(
      `    posting-port-bypass: -${postingBypassRatchet.removed.length} edge(s), now through the posting port or gone:`,
    )
    postingBypassRatchet.removed.forEach((e) => console.log(`        ${e.file}: ${e.module}`))
  }
  if (current.handBuiltVoucherRef.length < handBuiltVoucherRefBaseline)
    console.log(
      `    hand-built-voucher-ref: -${handBuiltVoucherRefBaseline - current.handBuiltVoucherRef.length} site(s)`,
    )
  if (current.literalLegalForm.length < literalLegalFormBaseline)
    console.log(
      `    literal-legal-form: -${literalLegalFormBaseline - current.literalLegalForm.length} site(s)`,
    )
  if (fixedAuthFiles.length) console.log(`    raw-route-auth: -${fixedAuthFiles.length} file(s)`)
  if (fixedLedgerScans.length)
    console.log(`    ledger-scanning-report: -${fixedLedgerScans.length} file(s)`)
  if (fixedDialogOverflow.length)
    console.log(`    dialog-overflow-risk: -${fixedDialogOverflow.length} file(s)`)
  if (fixedRawRefs.length)
    console.log(`    raw-reference-fetch: -${fixedRawRefs.length} file(s)`)
  if (current.naiveOreRound < baseline.naiveOreRound.count)
    console.log(`    naive-ore-round: -${baseline.naiveOreRound.count - current.naiveOreRound} occurrence(s)`)
  if (current.mcpBareErrorThrows < mcpBareErrorBaseline)
    console.log(`    mcp-bare-error: -${mcpBareErrorBaseline - current.mcpBareErrorThrows} throw(s)`)
  if (fixedProviderHosts.length)
    console.log(`    provider-host: -${fixedProviderHosts.length} file(s) no longer call a provider directly`)
  if (lazyInitBaseline && current.lazyInitEntries.length < lazyInitBaseline.count)
    console.log(
      `    lazy-init-reach: -${lazyInitBaseline.count - current.lazyInitEntries.length} server entr(ies) no longer compile lib/init`,
    )
  console.log('    Run with --update to ratchet the baseline down and lock in the gains.')
}
if (migratedDirectAi.length) {
  console.log(
    `\n✓ direct-ai-client progress: ${migratedDirectAi.length} allowlisted file(s) no longer call a model SDK directly.` +
      ' Remove them from DIRECT_AI_CLIENT_ALLOWED in this script to lock it in:',
  )
  migratedDirectAi.forEach((f) => console.log(`    ${f}`))
}
if (migratedUtcToday.length) {
  console.log(
    `\n✓ utc-today progress: ${migratedUtcToday.length} allowlisted file(s) no longer compute a UTC "today".` +
      ' Remove them from UTC_TODAY_ALLOWED in scripts/checks/utc-today.mjs to lock it in:',
  )
  migratedUtcToday.forEach((f) => console.log(`    ${f}`))
}
if (gatedSinceBaseline.length) {
  console.log(
    `\n✓ ungated-extension-route progress: ${gatedSinceBaseline.length} allowlisted route(s) now gated or gone.` +
      ' Remove them from UNGATED_EXTENSION_ROUTES in scripts/checks/extension-route-guards.mjs to lock it in:',
  )
  gatedSinceBaseline.forEach((f) => console.log(`    ${f}`))
}

if (pagedSinceBaseline.length) {
  console.log(
    `\n✓ limit-above-page progress: ${pagedSinceBaseline.length} allowlisted file(s) no longer read past a page with .limit().` +
      ' Remove them from LIMIT_ABOVE_PAGE_ALLOWED in scripts/checks/limit-above-page.mjs to lock it in:',
  )
  pagedSinceBaseline.forEach((f) => console.log(`    ${f}`))
}

if (sharedSinceBaseline.length) {
  console.log(
    `\n✓ local-supabase-chain progress: ${sharedSinceBaseline.length} allowlisted test file(s) now use the shared mocks.` +
      ' Remove them from LOCAL_SUPABASE_CHAIN_ALLOWED in scripts/checks/local-test-mock.mjs to lock it in:',
  )
  sharedSinceBaseline.forEach((f) => console.log(`    ${f}`))
}

if (stalePermanentAllowlist.length) {
  console.log(
    `\n✓ posting-port-bypass: ${stalePermanentAllowlist.length} permanently allowlisted call(s) no longer found.` +
      ' Remove them from PERMANENT_ALLOWLIST in scripts/checks/posting-port-bypass.mjs to lock it in:',
  )
  stalePermanentAllowlist.forEach((f) => console.log(`    ${f}`))
}

if (failed) {
  console.error('\nAntipattern guard failed: see above.')
  process.exit(1)
}
console.log(
  `\n✓ Antipattern guard passed (raw-route-auth: ${current.rawRouteAuth.length}, naive-ore-round: ${current.naiveOreRound}, mcp-bare-error: ${current.mcpBareErrorThrows}, hand-rolled-invariant: ${current.handRolledInvariants}, literal-legal-form: ${current.literalLegalForm.length}, hand-built-voucher-ref: ${current.handBuiltVoucherRef.length}, ledger-scanning-report: ${current.ledgerScanningReports.length}, direct-jel-insert: 0, direct-invoice-payment-insert: 0, hand-written-sie-extensions: 0, leaky-supabase-client: 0, pinned-dep: 0, raw-user-error: 0, hand-read-api-error: 0, sek-labelled-amount: 0, off-ladder-radius: 0, ui-uniformity: 0, folded-public-flag: 0, cross-extension-import: 0, ungated-extension-route: ${current.extensionRoutes.ungated.length}/${UNGATED_EXTENSION_ROUTES.size} allowlisted, static-init-import: 0, lazy-init-reach: ${current.lazyInitEntries.length}/${lazyInitBaseline?.count ?? 'no baseline'}, dialog-overflow-risk: ${dialogOverflowFiles.length} file(s), raw-reference-fetch: ${current.rawReferenceFetch.length} file(s), client-node-builtin: ${current.clientNodeBuiltins.length}, client-server-only: ${current.clientServerOnly.length}, consent-token-access: 0, ambiguous-embed: ${current.ambiguousEmbeds.length}, provider-host: ${current.providerHosts.length} file(s), unsigned-provider-names: ${current.unsignedProviderNames.skipped ? 'skipped' : current.unsignedProviderNames.findings.length}, table-without-grant: ${tableWithoutGrantFiles.length}/${tableWithoutGrantBaseline.size} grandfathered file(s), functiondef-patch: ${functiondefPatchFiles.length}/${functiondefPatchBaseline.size} grandfathered file(s), direct-ai-client: ${current.directAiClients.length}/${DIRECT_AI_CLIENT_ALLOWED.size} allowlisted, limit-above-page: ${limitAbovePageFilesNow.size}/${LIMIT_ABOVE_PAGE_ALLOWED.size} allowlisted file(s), utc-today: ${current.utcToday.length} in ${UTC_TODAY_ALLOWED.size} allowlisted file(s), bas-account-literal: ${current.jurisdictionWelds.basAccountLiteral.length} in ${Object.keys(basLiteralCounts).length} file(s), sek-literal: ${current.jurisdictionWelds.sekLiteral.length} in ${Object.keys(sekLiteralCounts).length} file(s), kernel-import: ${kernelImportEdgeCount} edge(s), posting-port-bypass: ${postingBypassEdgeCount}/${countEdges(postingBypassBaseline)} baselined edge(s) + ${countEdges(current.postingPort.allowlisted)} permanent, swedish-ui-literal: ${current.swedishUiLiterals.length} in ${Object.keys(swedishUiLiteralCounts).length} file(s), decision-log: 0, script-init-condition: 0, duplicate-block: ${duplicateLineCount} shared line(s) in ${Object.keys(duplicatePairs).length} file pair(s), error-masking: ${current.errorMasking.length} in ${Object.keys(errorMaskingCounts).length} file(s)).`,
)
