/**
 * Deterministic generator for the installable `accounted-api` agent skill
 * (skills/accounted-api/), the consumer-side skill that teaches coding
 * agents to build against the v1 REST API.
 *
 * Renders straight from the same endpoint registry that serves the API and
 * its OpenAPI spec, so the skill cannot drift from the server. Hand-authored
 * knowledge (auth, conventions, domain gotchas) lives in
 * scripts/api-skill/overlays/*.md and is stitched in verbatim.
 *
 * Run with the react-server condition so the `server-only` guards in the
 * route import chain resolve (see package.json):
 *
 *   npm run apiskill:generate          # write skills/accounted-api/
 *   npm run apiskill:check             # CI staleness gate (no writes)
 *
 * The per-operation rendering is done by the portable inventory tool that
 * ships inside the sibling `openapi-to-skill` skill: the generic tool has to
 * be good enough to build our own skill, or it is not good enough to ship.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import '@/lib/api/v1/load-routes'
import { generateOpenApiSpec } from '@/lib/api/v1/registry'
import { API_V1_VERSION } from '@/lib/api/v1/version'

import {
  listOperations,
  formatOpLine,
  renderOperationMd,
  type OperationEntry,
} from '../../skills/openapi-to-skill/scripts/openapi-inventory.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OVERLAY_DIR = join(ROOT, 'scripts', 'api-skill', 'overlays')
const OUT_DIR = join(ROOT, 'skills', 'accounted-api')

/** Base URL shown in examples: the permanent machine host (see lib/api/v1/base-url.ts). */
const MACHINE_BASE = 'https://app.gnubok.se'

/**
 * Reference-file layout: every derived path group must be claimed by exactly
 * one file. A new v1 resource fails apiskill:check until it is mapped here,
 * which is the point: grouping is an editorial decision, not a default.
 */
const GROUPS: Array<{ file: string; title: string; members: string[]; blurb: string }> = [
  {
    file: 'core.md',
    title: 'Core',
    members: ['health', 'api-key', 'companies', 'capabilities', 'packages', 'operations', 'settings', 'peppol', 'service-accounts'],
    blurb:
      'Connectivity, the calling key\'s own grant, company discovery, which modules a company can use (capabilities), its packages with their status and the staged switch (packages), async-operation polling, company settings, and service accounts (an integration\'s own principal, with a human sponsor). ' +
      'Every session starts with GET /companies to resolve the companyId that all other URLs need.',
  },
  {
    file: 'journal-entries.md',
    title: 'Journal entries',
    members: ['journal-entries', 'voucher-gap-explanations'],
    blurb:
      'The ledger itself: journal entries follow draft -> commit -> immutable. There is no ' +
      'edit or delete after commit; undo via reverse (storno) or correct. Voucher numbers are ' +
      'server-assigned and gapless; explain unavoidable gaps via voucher-gap-explanations.',
  },
  {
    file: 'periods.md',
    title: 'Periods and registers',
    members: [
      'fiscal-periods',
      'accrual-schedules',
      'accounts',
      'compliance',
      'dimensions',
      'skatteverket',
      'skattekonto',
      'tax-loss-carryforwards',
      'agreements',
      'agreement-obligations',
      'securities',
      'group-links',
    ],
    blurb:
      'Fiscal periods and their lock/close/year-end lifecycle (async operations), accrual ' +
      'schedules (periodiseringar: re-plan the months not yet posted), the BAS ' +
      'chart of accounts, cost-center/project dimensions, the compliance pre-flight check, ' +
      'reading filed VAT declarations (and beslut) from Skatteverket, the register of prior ' +
      'years\' tax losses (underskott, IL 40 kap.) per fiscal year, and the company\'s ' +
      'commitments: agreements with their expected payments, ställda säkerheter and ' +
      'eventualförpliktelser, and the group structure.',
  },
  {
    file: 'invoices.md',
    title: 'Invoices (AR)',
    members: ['invoices', 'collections', 'setoffs'],
    blurb:
      'Accounts receivable invoices: draft -> send -> paid/credited; the F-series number is ' +
      'assigned at send, not create. Supplier bills you receive are a different resource: see ' +
      'suppliers.md. Customer and article registers: customers.md. Collections: overdue invoices ' +
      'handed to the collections provider the company activated (the handover and escalations are ' +
      'staged for a person to approve in Accounted), the case on each invoice, and booking what the ' +
      'provider collected and paid out. Setting a customer invoice off against a supplier invoice ' +
      'of the same counterparty: setoffs.',
  },
  {
    file: 'customers.md',
    title: 'Customers and articles',
    members: ['customers', 'articles'],
    blurb:
      'The customer register (bulk-create supported, archive via DELETE) and the read-only ' +
      'article register used for invoice line linkage.',
  },
  {
    file: 'suppliers.md',
    title: 'Suppliers (AP)',
    members: ['suppliers', 'supplier-invoices', 'supplier-payment-batches', 'payment-orders', 'payments', 'expense-claims'],
    blurb:
      'Accounts payable: supplier register, received supplier invoices ' +
      '(register -> approve -> book if deferred -> pay via a supplier payment file, ' +
      'a bank payment order signed with BankID in Accounted, or mark-paid, or credit), ' +
      'the Bankgiro Lookup checks (the registered name behind a payee giro, the company\'s own giro numbers), ' +
      'and expense claims (utlägg) with their payouts.',
  },
  {
    file: 'documents.md',
    title: 'Documents',
    members: ['documents', 'inbox-items', 'signing-requests'],
    blurb:
      'The WORM document archive (7-year legal retention: uploads are permanent) and inbox-item stamping. ' +
      'Link every uploaded receipt/invoice document to its journal entry. ' +
      'Signing requests send an archived PDF for BankID signing; each signer signs in person, and the signed copy and evidence package land in the archive.',
  },
  {
    file: 'company-registers.md',
    title: 'Company registers (Bolaget)',
    members: ['share-register', 'share-classes', 'company-roles', 'signatory-rules', 'beneficial-owners', 'corporate-meetings'],
    blurb:
      'The aktiebok (share register, ABL 5 kap.) as of any date with its dated history, the share classes and their förbehåll, ' +
      'the board, VD, firmatecknare and revisor over time with the firmateckning, and the verkliga huvudmän derived from the aktiebok. ' +
      'Entries are permanent (a mistake is voided by a rattelse entry); a personnummer is never sent here, it is completed in Accounted. ' +
      'Meetings (corporate-meetings) hold the stämmor and board meetings with their decisions and minutes; an adopted election changes the roles when a person signs the minutes in Accounted. ' +
      'Every endpoint answers 404 BOLAGET_DISABLED outside the rollout.',
  },
  {
    file: 'capital-events.md',
    title: 'Capital events (Bolaget)',
    members: ['capital-events', 'ku31', 'dividends', 'shareholder-contributions', 'capital-changes'],
    blurb:
      'Dividends from the stämma decision to the payout, split per holder from the aktiebok and checked against fritt eget kapital (ABL 17:3), ' +
      'the KU31 status per income year, aktieägartillskott (K2 15.5-15.6) and nyemission, fondemission and minskning av aktiekapitalet with their Bolagsverket deadlines. ' +
      'Every booking posts through the bookkeeping engine and is high risk. The KU31 file itself carries personnummer and is downloaded in Accounted only. ' +
      'Every endpoint answers 404 BOLAGET_DISABLED outside the rollout.',
  },
  {
    file: 'owner-tax.md',
    title: 'Owner tax (Bolaget)',
    members: ['k10', 'owner-loans', 'ku20'],
    blurb:
      'The K10 underlag per owner and income year under the 3:12 rules from 2026 (grundbelopp, lönebaserat utrymme, interest on the omkostnadsbelopp, dividend and sparat utdelningsutrymme, each line with its source), ' +
      'the owner loan register with the loan prohibition check (ABL 21 kap.), the 21:10 special list and the ledger reconciliation, and the KU20 status for interest paid to owners. ' +
      'Nothing books. The KU20 file carries personnummer and is downloaded in Accounted only. Every endpoint answers 404 BOLAGET_DISABLED outside the rollout.',
  },
  {
    file: 'banking.md',
    title: 'Banking',
    members: ['transactions', 'cash-accounts', 'bank-connections', 'bank-feed', 'reconciliation', 'imports', 'pos-sales', 'webshop-orders'],
    blurb:
      'Bank transactions (ingest, categorize, match against invoices), cash accounts with the ' +
      'bank-reported balance, PSD2 connection health (sync freshness, consent expiry), the Open ' +
      'Payments bank feed (reachable banks, connections, the switch from Enable Banking, the signatory link), ' +
      'bank reconciliation runs, file imports (SIE, bank statements), the point-of-sale ' +
      'business days a connected POS system delivers, booked as daily takings vouchers, and the ' +
      'webshop orders the Shopify, WooCommerce and Zettle syncs deliver, booked one by one with your own lines.',
  },
  {
    file: 'employees.md',
    title: 'Employees',
    members: ['employees', 'salary'],
    blurb:
      'The employee register plus absence (frånvaro), worked days (tidrapport for hourly staff ' +
      'and OB), benefits (förmåner), recurring lines (standing monthly rows), vacation balances ' +
      'and year close, payroll cutover opening balances, and the company salary settings (pay ' +
      'day, avvikelseperiod, payment file format). Running payroll itself: salary-runs.md.',
  },
  {
    file: 'salary-runs.md',
    title: 'Salary runs',
    members: ['salary-runs'],
    blurb:
      'Swedish payroll runs: create -> calculate -> approve -> payment-file (pain.001 / LB) -> ' +
      'mark-paid -> book -> generate-agi (arbetsgivardeklaration), with per-employee payslips, ' +
      'draft-only line edits and :correct (rättelsekörning) for a booked run.',
  },
  {
    file: 'reports.md',
    title: 'Reports',
    members: ['reports', 'audit-trail', 'vat', 'measures', 'unexplained', 'budgets'],
    blurb:
      'Read-only statutory and management reports: trial balance, balance sheet, income statement, ' +
      'general ledger, VAT declaration, AR/AP ledgers, salary journal, and SIE export. Budgets ' +
      '(GET/POST /budgets, amounts per resultatkonto, month and dimension in the SIE sign, revenue ' +
      'negative, a file read in by POST /budgets/{id}/import from SIE #PBUDGET or Excel/CSV) are compared ' +
      'with the books by GET /reports/budget-vs-actual. Only ' +
      'income-statement, general-ledger, monthly-breakdown, kpi and budget-vs-actual take the dim_no + dim_code filter; ' +
      'every other report answers a dimension filter with 400 VALIDATION_ERROR, never an unfiltered ' +
      'report. Any other query parameter a report does not list is not applied and is named in the ' +
      'X-Ignored-Query-Params response header. Defined measures (GET /measures/{id}) answer one figure ' +
      'equal to its report (moms att betala, kundfordringar, banksaldo, resultat ...) with its definition, ' +
      'caveats and an explain call down to every journal line; they refuse unknown parameters. The ' +
      'unexplained queue (GET /unexplained) runs the checks of differences that should be zero (reskontra ' +
      'against the ledger, bank and skattekonto against the outside balance, declared moms not settled, ' +
      'overdue unbooked bank rows) and explains each down to the records behind it.',
  },
  {
    file: 'assets.md',
    title: 'Fixed assets',
    members: ['assets'],
    blurb:
      'The anläggningsregister: register an asset (no voucher, the purchase is already booked), ' +
      'correct it while no depreciation is posted, and dispose it (sale, scrap or business transfer) ' +
      'which posts the avyttring voucher with gain/loss, VAT and jämkning. Depreciation itself is ' +
      'proposed and posted per fiscal period through the year-end flow.',
  },
  {
    file: 'pending-operations.md',
    title: 'Pending operations (approvals)',
    members: ['pending-operations'],
    blurb:
      'The approval door for staged writes: a write sent with `?stage=true` (or staged by an agent over MCP) ' +
      'waits here as a pending operation until it is approved (committed, answering the outcome) or rejected. ' +
      'Each one carries `status` and `task_state` (working, completed, failed, cancelled), so an attest flow ' +
      'built outside Accounted follows it like any other task. Approving twice never commits twice.',
  },
  {
    file: 'webhooks.md',
    title: 'Webhooks',
    members: ['webhooks', 'webhook-deliveries'],
    blurb:
      'HMAC-signed event subscriptions with delivery logs, test pings, retries, and secret rotation.',
  },
  {
    file: 'portfolio.md',
    title: 'Portfolio',
    members: ['portfolio'],
    blurb:
      'Cross-company reads for keys that reach more than one company (consultants, byrå team ' +
      'members, multi-company owners): one call over a membership-checked company scope instead ' +
      'of one call per company. The scope is capped at 25 companies per call; the response names ' +
      'the ids beyond the cap so the next call can list them explicitly.',
  },
]

/**
 * The standard error line every operation shares; lifted into the
 * conventions overlay once instead of repeated 124 times. Operations with
 * additional codes keep their (then non-matching) line.
 */
const STANDARD_ERRORS_LINE =
  'Errors: `400` (Validation error), `401` (Unauthorized), `403` (Insufficient scope), ' +
  '`404` (Not found), `429` (Rate limited), `500` (Internal error)'

const GENERATED_NOTE =
  '<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. ' +
  'Regenerate with `npm run apiskill:generate`. -->'

function overlay(name: string): string {
  return readFileSync(join(OVERLAY_DIR, name), 'utf8').trim()
}

function methodRank(method: string): number {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method)
}

/**
 * The spec without its per-operation module tags (lib/modules): the
 * inventory groups by tag when one is present, and the reference files keep
 * the editorial path grouping in GROUPS above.
 */
function withoutOperationTags(spec: ReturnType<typeof generateOpenApiSpec>): ReturnType<typeof generateOpenApiSpec> {
  const paths = Object.fromEntries(
    Object.entries(spec.paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item).map(([method, op]) => {
          const copy = { ...(op as Record<string, unknown>) }
          delete copy.tags
          return [method, copy]
        }),
      ),
    ]),
  )
  return { ...spec, paths }
}

function buildFiles(): Map<string, string> {
  const spec = withoutOperationTags(generateOpenApiSpec(MACHINE_BASE))
  const ops = listOperations(spec)

  const memberToFile = new Map<string, (typeof GROUPS)[number]>()
  for (const group of GROUPS) {
    for (const member of group.members) {
      if (memberToFile.has(member)) throw new Error(`group member mapped twice: ${member}`)
      memberToFile.set(member, group)
    }
  }

  const byFile = new Map<string, OperationEntry[]>()
  for (const entry of ops) {
    const group = memberToFile.get(entry.group)
    if (!group) {
      throw new Error(
        `Unmapped endpoint group "${entry.group}" (${entry.method} ${entry.path}). ` +
          'Add it to a reference file in scripts/api-skill/generate.ts GROUPS.',
      )
    }
    if (!byFile.has(group.file)) byFile.set(group.file, [])
    byFile.get(group.file)!.push(entry)
  }
  for (const list of byFile.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path) || methodRank(a.method) - methodRank(b.method))
  }

  const files = new Map<string, string>()

  // Reference files.
  for (const group of GROUPS) {
    const members = byFile.get(group.file) ?? []
    if (members.length === 0) throw new Error(`reference file with no operations: ${group.file}`)
    const blocks = members.map((entry) =>
      renderOperationMd(spec, entry).replace(STANDARD_ERRORS_LINE, '').trimEnd(),
    )
    files.set(
      join('references', group.file),
      [
        GENERATED_NOTE,
        '',
        `# ${group.title} endpoints`,
        '',
        group.blurb,
        '',
        'Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)',
        'are in SKILL.md and are not repeated per endpoint.',
        '',
        blocks.join('\n\n---\n\n'),
        '',
      ].join('\n'),
    )
  }

  // SKILL.md: frontmatter + overlays + endpoint index.
  const indexSections = GROUPS.map((group) => {
    const members = byFile.get(group.file)!
    const lines = members.map((entry) =>
      formatOpLine(entry).replace(` ${entry.path} `, ` ${entry.path.replace('/api/v1', '')} `),
    )
    return [
      `### ${group.title} (${members.length})`,
      '',
      `Full detail: [references/${group.file}](references/${group.file})`,
      '',
      '```text',
      ...lines,
      '```',
    ].join('\n')
  })

  const frontmatter = [
    '---',
    'name: accounted-api',
    'description: >-',
    '  Consume the Accounted REST API (Swedish double-entry bookkeeping SaaS,',
    `  ${MACHINE_BASE}/api/v1). Use when building an integration, app, backend`,
    '  job, or agent tool layer against Accounted: invoices, customers,',
    '  suppliers, supplier invoices, journal entries (bokföring), bank',
    '  transactions and reconciliation, payroll (lön), VAT/moms and financial',
    '  reports, SIE import/export, documents, webhooks. Covers auth with',
    `  gnubok_sk_ API keys, conventions (dry-run, idempotency, cursor`,
    `  pagination, scopes), and all ${ops.length} endpoints.`,
    '---',
  ].join('\n')

  files.set(
    'SKILL.md',
    [
      frontmatter,
      '',
      GENERATED_NOTE,
      '',
      overlay('intro.md'),
      '',
      overlay('quickstart.md'),
      '',
      overlay('conventions.md'),
      '',
      '## Endpoint index',
      '',
      `API version \`${API_V1_VERSION}\`, ${ops.length} operations. Paths are shown without`,
      `their \`/api/v1\` prefix (full base URL: \`${MACHINE_BASE}/api/v1\`).`,
      '',
      indexSections.join('\n\n'),
      '',
      overlay('gotchas.md'),
      '',
      overlay('verification.md'),
      '',
    ].join('\n'),
  )

  return files
}

function listMarkdownFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? join(prefix, dirent.name) : dirent.name
    if (dirent.isDirectory()) out.push(...listMarkdownFiles(join(dir, dirent.name), rel))
    else if (dirent.name.endsWith('.md')) out.push(rel)
  }
  return out
}

function main() {
  const check = process.argv.includes('--check')
  const files = buildFiles()

  const existing = listMarkdownFiles(OUT_DIR)
  const orphans = existing.filter((rel) => !files.has(rel))

  if (check) {
    const stale: string[] = []
    for (const [rel, content] of files) {
      const abs = join(OUT_DIR, rel)
      if (!existsSync(abs)) stale.push(`${rel} (missing)`)
      else if (readFileSync(abs, 'utf8') !== content) stale.push(`${rel} (outdated)`)
    }
    stale.push(...orphans.map((rel) => `${rel} (orphaned)`))
    if (stale.length > 0) {
      console.error('skills/accounted-api is stale relative to the endpoint registry/overlays:')
      for (const entry of stale) console.error(`  - ${entry}`)
      console.error('Run `npm run apiskill:generate` and commit the result.')
      process.exit(1)
    }
    console.log(`skills/accounted-api is up to date (${files.size} files).`)
    return
  }

  for (const [rel, content] of files) {
    const abs = join(OUT_DIR, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  for (const rel of orphans) {
    rmSync(join(OUT_DIR, rel))
    console.log(`removed orphan: ${rel}`)
  }
  console.log(`wrote ${files.size} files to skills/accounted-api/`)
}

main()
