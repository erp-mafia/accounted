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
    members: ['health', 'companies', 'operations', 'settings'],
    blurb:
      'Connectivity, company discovery, async-operation polling, and company settings. ' +
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
    members: ['fiscal-periods', 'accounts', 'compliance', 'dimensions', 'skatteverket'],
    blurb:
      'Fiscal periods and their lock/close/year-end lifecycle (async operations), the BAS ' +
      'chart of accounts, cost-center/project dimensions, the compliance pre-flight check, ' +
      'and reading filed VAT declarations (and beslut) from Skatteverket.',
  },
  {
    file: 'invoices.md',
    title: 'Invoices (AR)',
    members: ['invoices'],
    blurb:
      'Accounts receivable invoices: draft -> send -> paid/credited; the F-series number is ' +
      'assigned at send, not create. Supplier bills you receive are a different resource: see ' +
      'suppliers.md. Customer and article registers: customers.md.',
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
    members: ['suppliers', 'supplier-invoices'],
    blurb:
      'Accounts payable: supplier register and received supplier invoices ' +
      '(register -> approve -> mark-paid, or credit).',
  },
  {
    file: 'documents.md',
    title: 'Documents',
    members: ['documents', 'inbox-items'],
    blurb:
      'The WORM document archive (7-year legal retention: uploads are permanent) and inbox-item stamping. ' +
      'Link every uploaded receipt/invoice document to its journal entry.',
  },
  {
    file: 'banking.md',
    title: 'Banking',
    members: ['transactions', 'cash-accounts', 'bank-connections', 'reconciliation', 'imports'],
    blurb:
      'Bank transactions (ingest, categorize, match against invoices), cash accounts with the ' +
      'bank-reported balance, PSD2 connection health (sync freshness, consent expiry), ' +
      'bank reconciliation runs, and file imports (SIE, bank statements).',
  },
  {
    file: 'employees.md',
    title: 'Employees',
    members: ['employees', 'salary'],
    blurb:
      'The employee register plus absence (frånvaro), vacation balances and year close, and ' +
      'payroll cutover opening balances. Running payroll itself: salary-runs.md.',
  },
  {
    file: 'salary-runs.md',
    title: 'Salary runs',
    members: ['salary-runs'],
    blurb:
      'Swedish payroll runs: create -> calculate -> approve -> book/mark-paid -> generate-agi ' +
      '(arbetsgivardeklaration), with per-employee payslips and draft-only line edits.',
  },
  {
    file: 'reports.md',
    title: 'Reports',
    members: ['reports'],
    blurb:
      'Read-only statutory and management reports: trial balance, balance sheet, income statement, ' +
      'general ledger, VAT declaration, AR/AP ledgers, salary journal, and SIE export.',
  },
  {
    file: 'webhooks.md',
    title: 'Webhooks',
    members: ['webhooks', 'webhook-deliveries'],
    blurb:
      'HMAC-signed event subscriptions with delivery logs, test pings, retries, and secret rotation.',
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

function buildFiles(): Map<string, string> {
  const spec = generateOpenApiSpec(MACHINE_BASE)
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
