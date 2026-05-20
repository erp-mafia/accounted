#!/usr/bin/env npx tsx
/**
 * One-off BAS96 -> BAS2025 chart-of-accounts remap for Krister Sundling.
 *
 * Context: Krister imported a SIE from SPCS into gnubok. Balances are correct
 * but account numbers use BAS96, which gnubok's reports interpret against
 * BAS2025 -- so classification in BR/RR is wrong. Krister only has IB data
 * and is travelling, giving us a clean window to fix the chart before he
 * enters real vouchers.
 *
 * Strategy (UUID-based, no UPDATE on chart_of_accounts.account_number):
 *   1. Resolve the company from auth.users by email + company_members.
 *   2. Hard-check the resolved company's name contains EXPECTED_COMPANY_NAME_FRAGMENT.
 *   3. Snapshot chart_of_accounts; build (oldId -> targetId) plan, inserting
 *      target rows where missing.
 *   4. In one transaction with SET LOCAL gnubok.allow_delete='true':
 *        - INSERT new chart_of_accounts rows for target numbers that don't
 *          exist yet.
 *        - UPDATE journal_entry_lines.account_id/account_number from old UUIDs
 *          to target UUIDs.
 *        - DELETE old chart_of_accounts rows that no longer have lines.
 *   5. Pre/post per-account-class debit/credit totals must match.
 *
 * Why pg directly: the immutability bypass GUC is transaction-local
 * (current_setting('gnubok.allow_delete', true)). supabase-js issues
 * each call on its own pooled connection, so the flag wouldn't persist.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npx tsx scripts/remap-krister-bas96-to-bas2025.ts            # dry run
 *   DATABASE_URL=postgresql://... npx tsx scripts/remap-krister-bas96-to-bas2025.ts --commit   # apply
 *   Flags: --email <addr> overrides the default, --company-id <uuid> picks
 *   one when the user owns multiple companies.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { Pool, type PoolClient } from 'pg'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

// ──────────────────────────────────────────────────────────────────
// Hard-coded identity. The script aborts if these don't match.
// No --force, no override.
// ──────────────────────────────────────────────────────────────────

const EXPECTED_EMAIL = 'ks@sundlingwarn.com'
const EXPECTED_COMPANY_NAME_FRAGMENT = 'cesu' // Krister's holding company: CeSu Invest AB
const CONFIRM_PHRASE = 'remap krister'

// ──────────────────────────────────────────────────────────────────
// Mapping (BAS96 -> BAS2025), agreed with Krister 2026-05-15.
// Order does not matter -- mapping is keyed by old account UUID.
// ──────────────────────────────────────────────────────────────────

type AccountType = 'asset' | 'equity' | 'liability' | 'revenue' | 'expense'
type NormalBalance = 'debit' | 'credit'

interface Mapping {
  oldNumber: string
  newNumber: string
  newName: string
  accountClass: number
  accountType: AccountType
  normalBalance: NormalBalance
  accountGroup: string | null
}

const MAPPINGS: ReadonlyArray<Mapping> = [
  // Bank och likvida medel
  { oldNumber: '1040', newNumber: '1930', newName: 'Företagskonto',           accountClass: 1, accountType: 'asset',     normalBalance: 'debit',  accountGroup: '19' },
  { oldNumber: '1050', newNumber: '1940', newName: 'Likviditetskonto',        accountClass: 1, accountType: 'asset',     normalBalance: 'debit',  accountGroup: '19' },
  { oldNumber: '1051', newNumber: '1941', newName: 'Valutakonto GBP',         accountClass: 1, accountType: 'asset',     normalBalance: 'debit',  accountGroup: '19' },
  { oldNumber: '1052', newNumber: '1942', newName: 'Valutakonto EUR',         accountClass: 1, accountType: 'asset',     normalBalance: 'debit',  accountGroup: '19' },
  { oldNumber: '1053', newNumber: '1943', newName: 'Fasträntekonto',          accountClass: 1, accountType: 'asset',     normalBalance: 'debit',  accountGroup: '19' },
  { oldNumber: '1055', newNumber: '1944', newName: 'Sparkonto SBAB',          accountClass: 1, accountType: 'asset',     normalBalance: 'debit',  accountGroup: '19' },

  // Värdepapper och placeringar
  { oldNumber: '1056', newNumber: '1361', newName: 'Depå Carnegie',                          accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1060', newNumber: '1385', newName: 'Kapitalförsäkring (Avanza)',             accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1061', newNumber: '1386', newName: 'Kapitalförsäkring (Movestic)',           accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1210', newNumber: '1510', newName: 'Kundfordringar',                         accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '15' },
  { oldNumber: '1360', newNumber: '1760', newName: 'Upplupna ränteintäkter',                 accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '17' },
  { oldNumber: '1623', newNumber: '1330', newName: 'Andelar i intresseföretag',              accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1624', newNumber: '1311', newName: 'Andelar i dotterföretag — Divigen',     accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1625', newNumber: '1350', newName: 'Andelar i andra företag',                accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1626', newNumber: '1351', newName: 'Andelar i andra utländska företag',      accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1627', newNumber: '1352', newName: 'Andelar — Impilo',                      accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1628', newNumber: '1353', newName: 'Andelar — Röko',                        accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1629', newNumber: '1354', newName: 'Andelar — Altor V',                     accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1630', newNumber: '1360', newName: 'Aktiefonder (HB Microcap)',              accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1631', newNumber: '1355', newName: 'Andelar — Altor VI',                    accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },
  { oldNumber: '1632', newNumber: '1356', newName: 'Andelar — Impilo Orphan',               accountClass: 1, accountType: 'asset', normalBalance: 'debit', accountGroup: '13' },

  // Skatt och moms (merge: 2210 + 2211 -> 1630 Skattekonto)
  { oldNumber: '2210', newNumber: '1630', newName: 'Skattekonto',                            accountClass: 1, accountType: 'asset',     normalBalance: 'debit',  accountGroup: '16' },
  { oldNumber: '2211', newNumber: '1630', newName: 'Skattekonto',                            accountClass: 1, accountType: 'asset',     normalBalance: 'debit',  accountGroup: '16' },
  { oldNumber: '2330', newNumber: '2941', newName: 'Upplupna lagstadgade soc. avgifter',     accountClass: 2, accountType: 'liability', normalBalance: 'credit', accountGroup: '29' },
  { oldNumber: '2480', newNumber: '2650', newName: 'Redovisningskonto för moms',             accountClass: 2, accountType: 'liability', normalBalance: 'credit', accountGroup: '26' },
  { oldNumber: '2510', newNumber: '2710', newName: 'Personalens källskatt',                  accountClass: 2, accountType: 'liability', normalBalance: 'credit', accountGroup: '27' },

  // Övriga skulder och reserver
  { oldNumber: '2690', newNumber: '2890', newName: 'Övriga kortfristiga skulder',            accountClass: 2, accountType: 'liability', normalBalance: 'credit', accountGroup: '28' },
  { oldNumber: '2864', newNumber: '2126', newName: 'Periodiseringsfond avsatt vid taxering 2026', accountClass: 2, accountType: 'equity', normalBalance: 'credit', accountGroup: '21' },

  // Eget kapital
  { oldNumber: '2991', newNumber: '2081', newName: 'Aktiekapital',                           accountClass: 2, accountType: 'equity', normalBalance: 'credit', accountGroup: '20' },
  { oldNumber: '2992', newNumber: '2086', newName: 'Reservfond',                             accountClass: 2, accountType: 'equity', normalBalance: 'credit', accountGroup: '20' },
  { oldNumber: '2997', newNumber: '2091', newName: 'Balanserat resultat',                    accountClass: 2, accountType: 'equity', normalBalance: 'credit', accountGroup: '20' },
  { oldNumber: '2999', newNumber: '2099', newName: 'Årets resultat',                         accountClass: 2, accountType: 'equity', normalBalance: 'credit', accountGroup: '20' },
]

// ──────────────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const COMMIT = process.argv.includes('--commit')
const EMAIL_OVERRIDE = arg('email')
const COMPANY_ID_OVERRIDE = arg('company-id')

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error(
    'Missing DATABASE_URL. Set it to the Supabase Postgres connection string ' +
      '(Project Settings -> Database -> Connection string -> URI, with the service password).',
  )
  process.exit(1)
}

const targetEmail = EMAIL_OVERRIDE ?? EXPECTED_EMAIL

// ──────────────────────────────────────────────────────────────────
// Identity resolution
// ──────────────────────────────────────────────────────────────────

interface UserRow { id: string; email: string }
interface CompanyRow { id: string; name: string; entity_type: string | null }

async function resolveUser(client: PoolClient): Promise<UserRow> {
  const res = await client.query<UserRow>(
    `SELECT id, email FROM auth.users WHERE LOWER(email) = LOWER($1) LIMIT 2`,
    [targetEmail],
  )
  if (res.rows.length === 0) throw new Error(`No auth.users row for email ${targetEmail}`)
  if (res.rows.length > 1) throw new Error(`Multiple auth.users rows for email ${targetEmail} -- aborting`)
  return res.rows[0]
}

async function resolveCompany(client: PoolClient, userId: string): Promise<CompanyRow> {
  const res = await client.query<CompanyRow>(
    `SELECT c.id, c.name, c.entity_type
     FROM public.companies c
     JOIN public.company_members cm ON cm.company_id = c.id
     WHERE cm.user_id = $1 AND cm.role IN ('owner', 'admin')
     ORDER BY c.created_at ASC`,
    [userId],
  )
  if (res.rows.length === 0) {
    throw new Error(`User ${userId} owns/admins no companies`)
  }
  if (COMPANY_ID_OVERRIDE) {
    const pick = res.rows.find(r => r.id === COMPANY_ID_OVERRIDE)
    if (!pick) {
      throw new Error(
        `--company-id ${COMPANY_ID_OVERRIDE} is not among this user's owned companies: ` +
          res.rows.map(r => `${r.id} (${r.name})`).join(', '),
      )
    }
    return pick
  }
  if (res.rows.length > 1) {
    const list = res.rows.map(r => `  ${r.id}  ${r.name}`).join('\n')
    throw new Error(
      `User ${userId} owns/admins multiple companies -- pick one with --company-id <uuid>:\n${list}`,
    )
  }
  return res.rows[0]
}

function assertIdentity(user: UserRow, company: CompanyRow): void {
  if (user.email.toLowerCase() !== EXPECTED_EMAIL.toLowerCase()) {
    throw new Error(
      `Identity check FAILED: resolved user email ${user.email} != expected ${EXPECTED_EMAIL}`,
    )
  }
  if (!company.name.toLowerCase().includes(EXPECTED_COMPANY_NAME_FRAGMENT.toLowerCase())) {
    throw new Error(
      `Identity check FAILED: resolved company "${company.name}" does not contain "${EXPECTED_COMPANY_NAME_FRAGMENT}"`,
    )
  }
}

// ──────────────────────────────────────────────────────────────────
// Plan construction
// ──────────────────────────────────────────────────────────────────

interface AccountSnapshotRow {
  id: string
  account_number: string
  account_name: string
  account_class: number
  account_type: AccountType
  normal_balance: NormalBalance
}

interface PlanItem {
  mapping: Mapping
  oldId: string
  targetId: string | null    // null means INSERT new row
  targetExisted: boolean      // true if a row with newNumber already existed
  lineCountEstimate: number   // # of journal_entry_lines that will be moved
}

async function snapshotAccounts(client: PoolClient, companyId: string): Promise<Map<string, AccountSnapshotRow>> {
  const res = await client.query<AccountSnapshotRow>(
    `SELECT id, account_number, account_name, account_class, account_type, normal_balance
     FROM public.chart_of_accounts
     WHERE company_id = $1`,
    [companyId],
  )
  const map = new Map<string, AccountSnapshotRow>()
  for (const r of res.rows) map.set(r.account_number, r)
  return map
}

async function countLines(client: PoolClient, accountId: string, companyId: string): Promise<number> {
  // Scope by company_id via parent journal_entries to defend against any
  // accidental cross-tenant account_id reuse (should be impossible since
  // UUIDs are unique, but a free defense-in-depth check).
  const res = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
     FROM public.journal_entry_lines l
     JOIN public.journal_entries je ON je.id = l.journal_entry_id
     WHERE l.account_id = $1 AND je.company_id = $2`,
    [accountId, companyId],
  )
  return Number(res.rows[0]?.n ?? '0')
}

async function buildPlan(client: PoolClient, companyId: string): Promise<PlanItem[]> {
  const snapshot = await snapshotAccounts(client, companyId)
  const items: PlanItem[] = []
  for (const m of MAPPINGS) {
    const src = snapshot.get(m.oldNumber)
    if (!src) continue // already migrated or never existed
    const tgt = snapshot.get(m.newNumber)
    const lineCount = await countLines(client, src.id, companyId)
    items.push({
      mapping: m,
      oldId: src.id,
      targetId: tgt?.id ?? null,
      targetExisted: !!tgt,
      lineCountEstimate: lineCount,
    })
  }
  return items
}

// ──────────────────────────────────────────────────────────────────
// Pre/post invariants. The remap reclassifies accounts (that's the whole
// point), so per-class sums shift -- the merge 2210+2211 -> 1630 moves
// money from class 2 to class 1. The invariant that MUST hold is the
// company-wide debit/credit sum: the script never touches debit_amount
// or credit_amount on any line, so those sums must be byte-identical
// before/after. Per-class breakdown is informational.
// ──────────────────────────────────────────────────────────────────

interface GrandTotal { total_debit: string; total_credit: string }
interface ClassTotal { account_class: number; account_number: string | null; total_debit: string; total_credit: string }

async function grandTotals(client: PoolClient, companyId: string): Promise<GrandTotal> {
  const res = await client.query<GrandTotal>(
    `SELECT COALESCE(SUM(l.debit_amount), 0)::text  AS total_debit,
            COALESCE(SUM(l.credit_amount), 0)::text AS total_credit
     FROM public.journal_entry_lines l
     JOIN public.journal_entries je ON je.id = l.journal_entry_id
     WHERE je.company_id = $1`,
    [companyId],
  )
  return res.rows[0]
}

async function classTotals(client: PoolClient, companyId: string): Promise<ClassTotal[]> {
  const res = await client.query<ClassTotal>(
    `SELECT coa.account_class,
            NULL::text AS account_number,
            COALESCE(SUM(l.debit_amount), 0)::text  AS total_debit,
            COALESCE(SUM(l.credit_amount), 0)::text AS total_credit
     FROM public.journal_entry_lines l
     JOIN public.journal_entries je ON je.id = l.journal_entry_id
     JOIN public.chart_of_accounts coa ON coa.id = l.account_id
     WHERE je.company_id = $1
     GROUP BY coa.account_class
     ORDER BY coa.account_class`,
    [companyId],
  )
  return res.rows
}

function grandTotalsEqual(a: GrandTotal, b: GrandTotal): boolean {
  return a.total_debit === b.total_debit && a.total_credit === b.total_credit
}

// ──────────────────────────────────────────────────────────────────
// Period lock pre-flight
// ──────────────────────────────────────────────────────────────────

async function assertNoLockedPeriods(client: PoolClient, companyId: string): Promise<void> {
  const res = await client.query<{ name: string; is_closed: boolean; locked_at: string | null }>(
    `SELECT name, is_closed, locked_at::text
     FROM public.fiscal_periods
     WHERE company_id = $1 AND (is_closed = true OR locked_at IS NOT NULL)`,
    [companyId],
  )
  if (res.rows.length > 0) {
    const list = res.rows.map(r => `  ${r.name} (closed=${r.is_closed}, locked_at=${r.locked_at ?? '—'})`).join('\n')
    throw new Error(
      `Refusing to run: ${res.rows.length} fiscal_periods are closed/locked. ` +
        `gnubok.allow_delete does not bypass period locks. Unlock first, or escalate:\n${list}`,
    )
  }
}

// ──────────────────────────────────────────────────────────────────
// Plan execution (inside one transaction)
// ──────────────────────────────────────────────────────────────────

interface ExecResult {
  inserted: number
  updatedLines: number
  deletedAccounts: number
  newTargetIds: Map<string, string>  // newNumber -> id
}

async function executePlan(
  client: PoolClient,
  companyId: string,
  ownerUserId: string,
  plan: PlanItem[],
): Promise<ExecResult> {
  await client.query("SELECT set_config('gnubok.allow_delete', 'true', true)")

  const result: ExecResult = { inserted: 0, updatedLines: 0, deletedAccounts: 0, newTargetIds: new Map() }

  // Phase 1: INSERT all missing target accounts, dedup by newNumber.
  const newNumbersNeeded = new Map<string, Mapping>()
  for (const p of plan) {
    if (!p.targetExisted && !newNumbersNeeded.has(p.mapping.newNumber)) {
      newNumbersNeeded.set(p.mapping.newNumber, p.mapping)
    }
  }
  for (const [, m] of newNumbersNeeded) {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO public.chart_of_accounts (
         user_id, company_id, account_number, account_name, account_class,
         account_group, account_type, normal_balance, plan_type, is_active, is_system_account
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'full_bas', true, false)
       RETURNING id`,
      [ownerUserId, companyId, m.newNumber, m.newName, m.accountClass, m.accountGroup, m.accountType, m.normalBalance],
    )
    result.newTargetIds.set(m.newNumber, ins.rows[0].id)
    result.inserted++
  }

  // Phase 2: resolve every plan item's final targetId.
  for (const p of plan) {
    if (!p.targetId) {
      const inserted = result.newTargetIds.get(p.mapping.newNumber)
      if (!inserted) throw new Error(`Internal: no inserted id for new account ${p.mapping.newNumber}`)
      p.targetId = inserted
    }
  }

  // Phase 3: move journal lines from old account_id -> targetId.
  for (const p of plan) {
    if (!p.targetId) throw new Error('Internal: missing targetId')
    if (p.targetId === p.oldId) continue // idempotent no-op

    // Defense-in-depth: confirm old account still belongs to this company.
    const own = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public.chart_of_accounts WHERE id = $1 AND company_id = $2`,
      [p.oldId, companyId],
    )
    if (Number(own.rows[0].n) !== 1) {
      throw new Error(
        `Pre-write check failed: old account ${p.oldId} (${p.mapping.oldNumber}) not owned by company ${companyId}`,
      )
    }

    const upd = await client.query<{ id: string }>(
      `UPDATE public.journal_entry_lines AS l
       SET account_id = $1, account_number = $2
       FROM public.journal_entries AS je
       WHERE l.journal_entry_id = je.id
         AND je.company_id = $3
         AND l.account_id = $4
       RETURNING l.id`,
      [p.targetId, p.mapping.newNumber, companyId, p.oldId],
    )
    result.updatedLines += upd.rowCount ?? 0
  }

  // Phase 4: account_balances was dropped in migration
  // 20240101000027_drop_unused_module_tables.sql -- no cache to clean.

  // Phase 5: delete old accounts that no longer have any lines.
  const oldIds = Array.from(new Set(plan.map(p => p.oldId)))
  for (const oldId of oldIds) {
    const remaining = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
       FROM public.journal_entry_lines l
       JOIN public.journal_entries je ON je.id = l.journal_entry_id
       WHERE l.account_id = $1 AND je.company_id = $2`,
      [oldId, companyId],
    )
    if (Number(remaining.rows[0].n) !== 0) {
      throw new Error(`Refusing to delete account ${oldId}: ${remaining.rows[0].n} lines still reference it`)
    }
    const del = await client.query(
      `DELETE FROM public.chart_of_accounts WHERE id = $1 AND company_id = $2`,
      [oldId, companyId],
    )
    result.deletedAccounts += del.rowCount ?? 0
  }

  return result
}

// ──────────────────────────────────────────────────────────────────
// Pretty-print plan
// ──────────────────────────────────────────────────────────────────

function printPlan(plan: PlanItem[]): void {
  console.log('\nRemap plan:')
  const renames = plan.filter(p => p.mapping.oldNumber !== p.mapping.newNumber)
  const merges  = new Map<string, PlanItem[]>()
  for (const p of plan) {
    const k = p.mapping.newNumber
    if (!merges.has(k)) merges.set(k, [])
    merges.get(k)!.push(p)
  }

  const lineWidth = 6
  for (const p of renames) {
    const tag = p.targetExisted ? 'merge into existing' : 'rename'
    console.log(
      `  ${p.mapping.oldNumber.padEnd(lineWidth)} ` +
      `-> ${p.mapping.newNumber.padEnd(lineWidth)} ` +
      `${p.mapping.newName.padEnd(48)} ` +
      `(${p.lineCountEstimate} lines, ${tag})`,
    )
  }

  const mergeTargets = [...merges.entries()].filter(([, items]) => items.length > 1)
  if (mergeTargets.length > 0) {
    console.log('\nMerges (multiple old -> one new):')
    for (const [newNumber, items] of mergeTargets) {
      console.log(`  ${items.map(i => i.mapping.oldNumber).join(' + ')} -> ${newNumber}`)
    }
  }

  const newAccounts = new Set(plan.filter(p => !p.targetExisted).map(p => p.mapping.newNumber))
  if (newAccounts.size > 0) {
    console.log(`\nNew chart_of_accounts rows to insert: ${newAccounts.size}`)
    for (const n of [...newAccounts].sort()) {
      const m = plan.find(p => p.mapping.newNumber === n)!.mapping
      console.log(`  ${n}  ${m.newName}`)
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const client = await pool.connect()
  try {
    console.log('─────────────────────────────────────────────────────────')
    console.log('BAS96 -> BAS2025 remap (one-off, Krister Sundling)')
    console.log('─────────────────────────────────────────────────────────')
    console.log('Mode :', COMMIT ? 'COMMIT (writes)' : 'DRY RUN (no writes)')
    console.log('Email:', targetEmail)

    const user = await resolveUser(client)
    const company = await resolveCompany(client, user.id)
    assertIdentity(user, company)
    console.log('User :', `${user.email} (${user.id})`)
    console.log('Co.  :', `${company.name} (${company.id}, ${company.entity_type ?? '?'})`)

    await assertNoLockedPeriods(client, company.id)

    const plan = await buildPlan(client, company.id)
    if (plan.length === 0) {
      console.log('\nNothing to remap -- no BAS96 source accounts found. (Already migrated?)')
      return
    }
    printPlan(plan)

    const totalLines = plan.reduce((n, p) => n + p.lineCountEstimate, 0)
    console.log(`\nTotal journal_entry_lines that will move: ${totalLines}`)

    const grandBefore = await grandTotals(client, company.id)
    console.log(`\nPre-flight grand totals (must be unchanged by remap):`)
    console.log(`  total_debit=${grandBefore.total_debit}  total_credit=${grandBefore.total_credit}`)
    console.log(`\nPre-flight per-class totals (these WILL shift as accounts are reclassified):`)
    const classBefore = await classTotals(client, company.id)
    for (const r of classBefore) {
      console.log(`  class ${r.account_class}: debit=${r.total_debit} credit=${r.total_credit}`)
    }

    if (!COMMIT) {
      console.log('\n[dry-run] No changes made. Re-run with --commit to apply.')
      return
    }

    const rl = readline.createInterface({ input, output })
    const phrase = await rl.question(
      `\nAbout to apply the remap above for ${company.name} (${company.id}).\n` +
      `Type '${CONFIRM_PHRASE}' to proceed: `,
    )
    rl.close()
    if (phrase.trim().toLowerCase() !== CONFIRM_PHRASE) {
      console.log('Confirmation phrase did not match. Aborting.')
      process.exit(1)
    }

    // Single transaction: bypass flag is transaction-local.
    await client.query('BEGIN')
    let result: ExecResult
    try {
      result = await executePlan(client, company.id, user.id, plan)
      const grandAfter = await grandTotals(client, company.id)
      console.log(`\nPost-flight grand totals (still inside transaction):`)
      console.log(`  total_debit=${grandAfter.total_debit}  total_credit=${grandAfter.total_credit}`)
      if (!grandTotalsEqual(grandBefore, grandAfter)) {
        throw new Error(
          `INVARIANT BROKEN: grand debit/credit sums diverge after remap. ` +
            `Before debit=${grandBefore.total_debit} credit=${grandBefore.total_credit}; ` +
            `After debit=${grandAfter.total_debit} credit=${grandAfter.total_credit}. Rolling back.`,
        )
      }
      const classAfter = await classTotals(client, company.id)
      console.log('\nPost-flight per-class totals (reclassified -- shifts expected):')
      for (const r of classAfter) {
        console.log(`  class ${r.account_class}: debit=${r.total_debit} credit=${r.total_credit}`)
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }

    console.log('\n─────────────────────────────────────────────────────────')
    console.log('Done.')
    console.log('─────────────────────────────────────────────────────────')
    console.log(`Inserted accounts : ${result.inserted}`)
    console.log(`Updated lines     : ${result.updatedLines}`)
    console.log(`Deleted accounts  : ${result.deletedAccounts}`)
    console.log('\nNext: open the balance sheet and trial balance in gnubok as Krister to confirm classification.')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
