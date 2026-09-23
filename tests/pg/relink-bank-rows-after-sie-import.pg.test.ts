import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  insertCashAccount,
  insertDraftJournalEntry,
  insertBalancedLines,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { tryReconcileTransaction, type UnlinkedGLLine } from '@/lib/reconciliation/bank-reconciliation'
import type { Transaction } from '@/types'

/**
 * Covers 20260921230500_relink_bank_rows_after_sie_import (issue #2835).
 *
 * Part 1, relink_stranded_transactions: the selection rule. A stranded row
 * (is_business = true, no anchor) is re-linked only to an unlinked posted 19xx
 * line of the same signed amount, date and cash-account ledger account, and
 * only when the pairing is not a guess. Dry run is the default. The write is
 * on the transaction side only and leaves a reversible record.
 *
 * Part 2, the durable replacement chain on real SQL: a replacement import
 * releases the bank row, the re-imported verifikat is a matcher candidate for
 * it again, a bank link is refused until the import has completed (which is
 * why the matcher runs after completion and not as a job phase), and the
 * bank_sweep receipt is single-flight, service_role only, and recoverable.
 */

interface PgError extends Error {
  code?: string
}

const ACTOR = JSON.stringify({ type: 'user', id: randomUUID(), label: 'pg-real' })
const SIGNATURE = 'public.relink_stranded_transactions(uuid, boolean, boolean, jsonb, uuid)'

let voucherNo = 1000

/** A posted verifikat with one bank line: amount > 0 is money in (debit). */
async function ledgerEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  amount: number
  date?: string
  account?: string
  sourceType?: string
}): Promise<string> {
  const abs = Math.abs(params.amount)
  const bank = params.account ?? '1930'
  return insertPostedJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: params.date ?? '2026-06-01',
    voucherNumber: voucherNo++,
    sourceType: params.sourceType ?? 'import',
    lines:
      params.amount > 0
        ? [
            { accountNumber: bank, debitAmount: abs, creditAmount: 0 },
            { accountNumber: '3001', debitAmount: 0, creditAmount: abs },
          ]
        : [
            { accountNumber: '5010', debitAmount: abs, creditAmount: 0 },
            { accountNumber: bank, debitAmount: 0, creditAmount: abs },
          ],
  })
}

/** The shape the retired hard-delete replace left behind. */
async function strandedRow(params: {
  companyId: string
  userId: string
  amount: number
  date?: string
  currency?: string
  cashAccountId?: string | null
  isBusiness?: boolean | null
  isIgnored?: boolean
}): Promise<string> {
  const id = await insertTransaction({
    companyId: params.companyId,
    userId: params.userId,
    amount: params.amount,
    date: params.date ?? '2026-06-01',
    currency: params.currency,
    cashAccountId: params.cashAccountId ?? null,
    isIgnored: params.isIgnored ?? false,
  })
  await getPool().query(
    `UPDATE public.transactions
        SET is_business = $2, category = 'expense_office', reconciliation_method = 'manual'
      WHERE id = $1`,
    [id, params.isBusiness === undefined ? true : params.isBusiness],
  )
  return id
}

interface RelinkRow {
  transaction_id: string
  ledger_account: string
  lock_state: string
  competing_rows: number
  candidate_lines: number
  outcome: string
  journal_entry_id: string | null
  selected: boolean
  relinked: boolean
}

async function relink(
  client: PoolClient,
  params: { companyId: string | null; dryRun?: boolean; pairBalanced?: boolean; actor?: string | null; correlationId?: string },
): Promise<RelinkRow[]> {
  const { rows } = await client.query<RelinkRow>(
    `SELECT transaction_id, ledger_account, lock_state, competing_rows, candidate_lines,
            outcome, journal_entry_id, selected, relinked
       FROM public.relink_stranded_transactions($1, $2, $3, $4::jsonb, $5)`,
    [
      params.companyId,
      params.dryRun ?? true,
      params.pairBalanced ?? false,
      params.actor === undefined ? ACTOR : params.actor,
      params.correlationId ?? null,
    ],
  )
  return rows
}

async function txState(id: string) {
  const { rows } = await getPool().query<{
    is_business: boolean | null
    category: string | null
    reconciliation_method: string | null
    is_ignored: boolean
    journal_entry_id: string | null
  }>(
    `SELECT is_business, category, reconciliation_method, is_ignored, journal_entry_id
       FROM public.transactions WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function ledgerFingerprint(companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ fingerprint: string }>(
    `SELECT md5(coalesce(string_agg(
              (to_jsonb(j) - 'updated_at')::text || coalesce(
                (SELECT string_agg(to_jsonb(l)::text, '|' ORDER BY l.id)
                   FROM public.journal_entry_lines l WHERE l.journal_entry_id = j.id), ''),
              '#' ORDER BY j.id), '')) AS fingerprint
       FROM public.journal_entries j WHERE j.company_id = $1`,
    [companyId],
  )
  return rows[0].fingerprint
}

describe('relink_stranded_transactions (issue #2835)', () => {
  it('lists by default, then links a unique pairing with a reversible record, and never touches the ledger', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entry = await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -250 })
    const row = await strandedRow({ companyId, userId, amount: -250 })
    const before = await ledgerFingerprint(companyId)

    const dry = await runAsServiceRole((c) => relink(c, { companyId }))
    expect(dry).toEqual([
      {
        transaction_id: row,
        ledger_account: '1930',
        lock_state: 'open',
        competing_rows: 1,
        candidate_lines: 1,
        outcome: 'unique',
        journal_entry_id: entry,
        selected: true,
        relinked: false,
      },
    ])
    expect((await txState(row)).journal_entry_id).toBeNull()

    const correlationId = randomUUID()
    const written = await runAsServiceRole((c) => relink(c, { companyId, dryRun: false, correlationId }))
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ transaction_id: row, journal_entry_id: entry, relinked: true })
    // The row keeps what the user decided (business, category); only the
    // anchor and the method are written.
    expect(await txState(row)).toEqual({
      is_business: true,
      category: 'expense_office',
      reconciliation_method: 'auto_exact',
      is_ignored: false,
      journal_entry_id: entry,
    })
    expect(await ledgerFingerprint(companyId)).toBe(before)

    const { rows: history } = await getPool().query<{
      aggregate_type: string
      company_id: string
      correlation_id: string
      payload: Record<string, unknown>
      actor: { type: string }
    }>(
      `SELECT aggregate_type, company_id, correlation_id, payload, actor
         FROM public.processing_history
        WHERE event_type = 'BankTransactionStrandedRelinked' AND aggregate_id = $1`,
      [row],
    )
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      aggregate_type: 'BankTransaction',
      company_id: companyId,
      correlation_id: correlationId,
      actor: { type: 'user' },
      payload: {
        issue: 2835,
        rule: 'auto_exact_unique',
        lock_state: 'open',
        previous: { journal_entry_id: null, reconciliation_method: 'manual' },
        after: { journal_entry_id: entry, reconciliation_method: 'auto_exact' },
      },
    })

    // Idempotent: the row is anchored now, so a second write finds nothing.
    expect(await runAsServiceRole((c) => relink(c, { companyId, dryRun: false }))).toEqual([])
  })

  it('requires the same signed amount, the same date, the row own ledger account, and a verifikat no bank row holds', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const card = await insertCashAccount({ companyId, ledgerAccount: '1940' })

    // One day off.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -101, date: '2026-06-02' })
    const dayOff = await strandedRow({ companyId, userId, amount: -101, date: '2026-06-01' })
    // One ore off.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -102.01 })
    const oreOff = await strandedRow({ companyId, userId, amount: -102 })
    // Same magnitude, opposite direction.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: 103 })
    const wrongSign = await strandedRow({ companyId, userId, amount: -103 })
    // The line sits on 1930, the row belongs to the card account 1940.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -104 })
    const otherAccount = await strandedRow({ companyId, userId, amount: -104, cashAccountId: card })
    // The verifikat is already held by another bank row, directly ...
    const held = await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -105 })
    await insertTransaction({ companyId, userId, amount: -105, journalEntryId: held })
    const heldDirect = await strandedRow({ companyId, userId, amount: -105 })
    // ... or through the junction.
    const split = await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -106 })
    const holder = await insertTransaction({ companyId, userId, amount: -500 })
    await getPool().query(
      `INSERT INTO public.transaction_voucher_links
         (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
       VALUES ($1, $2, $3, $4, -106, 'other')`,
      [userId, companyId, holder, split],
    )
    const heldByJunction = await strandedRow({ companyId, userId, amount: -106 })
    // Not a matcher candidate: a storno and a draft.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -107, sourceType: 'storno' })
    const stornoOnly = await strandedRow({ companyId, userId, amount: -107 })
    const draft = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertBalancedLines(draft, 108)
    const draftOnly = await strandedRow({ companyId, userId, amount: 108 })
    // Foreign currency is out of scope for the one-off.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -109 })
    const eur = await strandedRow({ companyId, userId, amount: -109, currency: 'EUR' })
    // The positive control on the card account.
    const cardEntry = await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -110, account: '1940' })
    const onCard = await strandedRow({ companyId, userId, amount: -110, cashAccountId: card })

    const written = await runAsServiceRole((c) => relink(c, { companyId, dryRun: false, pairBalanced: true }))
    const outcome = new Map(written.map((r) => [r.transaction_id, r]))

    for (const id of [dayOff, oreOff, wrongSign, otherAccount, heldDirect, heldByJunction, stornoOnly, draftOnly]) {
      expect(outcome.get(id)).toMatchObject({ outcome: 'no_counterpart', selected: false, relinked: false })
      expect((await txState(id)).journal_entry_id).toBeNull()
    }
    expect(outcome.get(otherAccount)?.ledger_account).toBe('1940')
    expect(outcome.get(eur)).toMatchObject({ outcome: 'unsupported_currency', relinked: false })
    expect((await txState(eur)).journal_entry_id).toBeNull()
    expect(outcome.get(onCard)).toMatchObject({ outcome: 'unique', ledger_account: '1940', relinked: true })
    expect((await txState(onCard)).journal_entry_id).toBe(cardEntry)
  })

  it('leaves every guess to a human, with or without the balanced-group switch', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // One row, two verifikat.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -201 })
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -201 })
    const oneRowTwoLines = await strandedRow({ companyId, userId, amount: -201 })
    // Two rows, one verifikat.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -202 })
    const twoRowsA = await strandedRow({ companyId, userId, amount: -202 })
    const twoRowsB = await strandedRow({ companyId, userId, amount: -202 })
    // Numbers balance, but one of the rows is an open row in Att bokfora:
    // which of the two the verifikat belong to is not this tool's call.
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -203 })
    await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: -203 })
    const besideOpen = await strandedRow({ companyId, userId, amount: -203 })
    const open = await insertTransaction({ companyId, userId, amount: -203 })

    const written = await runAsServiceRole((c) => relink(c, { companyId, dryRun: false, pairBalanced: true }))

    expect(written.map((r) => r.transaction_id).sort()).toEqual(
      [oneRowTwoLines, twoRowsA, twoRowsB, besideOpen].sort(),
    )
    for (const r of written) {
      expect(r).toMatchObject({ outcome: 'ambiguous', journal_entry_id: null, selected: false, relinked: false })
    }
    for (const id of [oneRowTwoLines, twoRowsA, twoRowsB, besideOpen, open]) {
      expect((await txState(id)).journal_entry_id).toBeNull()
    }
    const { rows: events } = await getPool().query(
      `SELECT 1 FROM public.processing_history
        WHERE company_id = $1 AND event_type = 'BankTransactionStrandedRelinked'`,
      [companyId],
    )
    expect(events).toHaveLength(0)
  })

  it('pairs a balanced group only when asked to, one verifikat per row', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entries = [
      await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: 300 }),
      await ledgerEntry({ companyId, userId, fiscalPeriodId, amount: 300 }),
    ]
    const rows = [
      await strandedRow({ companyId, userId, amount: 300 }),
      await strandedRow({ companyId, userId, amount: 300 }),
    ]

    const strict = await runAsServiceRole((c) => relink(c, { companyId, dryRun: false }))
    expect(strict).toHaveLength(2)
    for (const r of strict) {
      expect(r).toMatchObject({ outcome: 'balanced_group', competing_rows: 2, candidate_lines: 2, selected: false, relinked: false })
    }
    for (const id of rows) expect((await txState(id)).journal_entry_id).toBeNull()

    const paired = await runAsServiceRole((c) => relink(c, { companyId, dryRun: false, pairBalanced: true }))
    expect(paired.every((r) => r.relinked)).toBe(true)
    const linked = await Promise.all(rows.map(async (id) => (await txState(id)).journal_entry_id))
    expect([...linked].sort()).toEqual([...entries].sort())

    const { rows: events } = await getPool().query<{ rule: string }>(
      `SELECT payload->>'rule' AS rule FROM public.processing_history
        WHERE company_id = $1 AND event_type = 'BankTransactionStrandedRelinked'`,
      [companyId],
    )
    expect(events.map((e) => e.rule)).toEqual(['auto_exact_balanced_group', 'auto_exact_balanced_group'])
  })

  it('only ever considers the stranded shape, and only in the named company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    for (const amount of [-401, -402, -403]) {
      await ledgerEntry({ ...a, amount })
    }
    const untriaged = await insertTransaction({ companyId: a.companyId, userId: a.userId, amount: -401 })
    const privateRow = await strandedRow({ companyId: a.companyId, userId: a.userId, amount: -402, isBusiness: false })
    const ignored = await strandedRow({ companyId: a.companyId, userId: a.userId, amount: -403, isIgnored: true })
    await ledgerEntry({ ...b, amount: -404 })
    const otherCompany = await strandedRow({ companyId: b.companyId, userId: b.userId, amount: -404 })

    expect(await runAsServiceRole((c) => relink(c, { companyId: a.companyId, dryRun: false }))).toEqual([])
    for (const id of [untriaged, privateRow, ignored, otherCompany]) {
      expect((await txState(id)).journal_entry_id).toBeNull()
    }
  })

  it('links behind a lock, as the matcher does: the link is not a ledger write', async () => {
    const { userId, companyId } = await seedCompany()
    const closed = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    const entry = await ledgerEntry({ companyId, userId, fiscalPeriodId: closed, amount: -500, date: '2025-03-10' })
    await getPool().query(
      `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`,
      [closed],
    )
    const row = await strandedRow({ companyId, userId, amount: -500, date: '2025-03-10' })

    const written = await runAsServiceRole((c) => relink(c, { companyId, dryRun: false }))
    expect(written[0]).toMatchObject({ transaction_id: row, lock_state: 'closed', relinked: true })
    expect((await txState(row)).journal_entry_id).toBe(entry)
  })

  it('refuses a call without a company and a write without an actor', async () => {
    const { companyId } = await seedCompany()
    const noCompany = await runAsServiceRole((c) =>
      relink(c, { companyId: null }).then(
        () => null,
        (e: PgError) => e,
      ),
    )
    expect(noCompany?.code).toBe('22023')
    const noActor = await runAsServiceRole((c) =>
      relink(c, { companyId, dryRun: false, actor: null }).then(
        () => null,
        (e: PgError) => e,
      ),
    )
    expect(noActor?.code).toBe('22023')
  })

  it('is executable by service_role only', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query<{ role: string; can: boolean }>(
      `SELECT r AS role, has_function_privilege(r, '${SIGNATURE}', 'EXECUTE') AS can
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.role, r.can]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    })
    const denied = await withUserContext(userId, (c) =>
      relink(c, { companyId }).then(
        () => null,
        (e: PgError) => e,
      ),
    )
    expect(denied?.code).toBe('42501')
  })
})

describe('a replacement SIE import and the post-import bank sweep receipt (issue #2835)', () => {
  let client: PoolClient
  let company: string
  let actor: string
  let period: string
  let worker: string
  let accounts: string[]
  const manifest = {
    input: { filename: 'synthetic.se', options: {}, mappings: [], fiscalYear: { start: '2026-01-01', end: '2026-12-31' } },
    file_storage_path: 'synthetic.se',
  }

  beforeAll(async () => {
    client = await getPool().connect()
    await client.query('BEGIN')
  })
  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK')
      client.release()
    }
  })
  beforeEach(async () => {
    await client.query('SAVEPOINT scenario')
    ;[company, actor, period, worker] = Array.from({ length: 4 }, () => randomUUID())
    await client.query(
      `INSERT INTO auth.users(id,email,instance_id) VALUES($1,$2,'00000000-0000-0000-0000-000000000000')`,
      [actor, `relink-${actor}@test.invalid`],
    )
    await client.query(`INSERT INTO companies(id,name,entity_type,created_by) VALUES($1,'Synthetic Relink AB','aktiebolag',$2)`, [company, actor])
    await client.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`, [company, actor])
    await client.query(
      `INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES($1,$2,$3,'2026','2026-01-01','2026-12-31')`,
      [period, company, actor],
    )
    accounts = [randomUUID(), randomUUID()]
    for (const [i, number] of ['1930', '3001'].entries()) {
      await client.query(
        `INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
         VALUES($1,$2,$3,$4,'Synthetic account',$5,$6,$7)`,
        [accounts[i], company, actor, number, i ? 'revenue' : 'asset', i ? 3 : 1, i ? 'credit' : 'debit'],
      )
    }
    await asService()
  })
  afterEach(async () => {
    await client.query('ROLLBACK TO SAVEPOINT scenario')
  })

  async function asService() {
    await client.query(`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`)
    await client.query('SET LOCAL ROLE service_role')
  }
  async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
    await client.query('RESET ROLE')
    try {
      return await fn()
    } finally {
      await asService()
    }
  }
  async function claimJob(importId: string): Promise<number> {
    const claimed = await client.query('SELECT j.* FROM claim_sie_import_job($1,$2) j', [worker, importId])
    expect(claimed.rows[0].id).toBe(importId)
    return claimed.rows[0].job_attempt
  }
  /** Save, seal and post one voucher: 100 kr into the bank on 2026-02-01. */
  async function postVoucher(importId: string, attempt: number) {
    const payload = [
      {
        sourceId: 'A1', sourceOrdinal: 0, sieImportId: importId, series: 'A', date: '2026-02-01',
        description: 'Synthetic voucher', sourceSeries: 'A', sourceNumber: 1, sourceType: 'import',
        lines: [
          { account_number: '1930', account_id: accounts[0], debit_amount: 100, credit_amount: 0, dimensions: {} },
          { account_number: '3001', account_id: accounts[1], debit_amount: 0, credit_amount: 100, dimensions: {} },
        ],
      },
    ]
    await client.query('SELECT save_sie_import_chunk($1,$2,$3,$4,$5,$6,$7)', [company, importId, worker, attempt, 'vouchers', 0, JSON.stringify(payload)])
    await client.query('SELECT seal_sie_import_preparation($1,$2,$3,$4,$5,$6)', [company, importId, worker, attempt, JSON.stringify(manifest), 1])
    await client.query('SELECT import_sie_chunk($1,$2,$3,$4,$5,$6)', [company, importId, worker, attempt, 'vouchers', 0])
  }
  async function complete(importId: string, attempt: number) {
    await client.query('SELECT complete_sie_import_job($1,$2,$3,$4,$5,$6)', [
      company, importId, worker, attempt, JSON.stringify({ success: true, journalEntriesCreated: 1, warnings: [] }), '{}',
    ])
  }
  async function batchEntry(importId: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE import_batch_id = $1 AND source_type = 'import'`,
      [importId],
    )
    expect(rows).toHaveLength(1)
    return rows[0].id
  }
  async function claimSweep(importId: string): Promise<boolean> {
    return (await client.query<{ ok: boolean }>('SELECT claim_sie_import_bank_sweep($1,$2) ok', [company, importId])).rows[0].ok
  }
  async function bankSweep(importId: string) {
    return (await client.query<{ bank_sweep: Record<string, unknown> | null }>('SELECT bank_sweep FROM sie_imports WHERE id=$1', [importId])).rows[0].bank_sweep
  }
  async function rejects(query: () => Promise<unknown>, message: RegExp) {
    await client.query('SAVEPOINT expected_error')
    await expect(query()).rejects.toThrow(message)
    await client.query('ROLLBACK TO SAVEPOINT expected_error')
  }
  async function firstImport(): Promise<{ importId: string; attempt: number }> {
    const started = await client.query('SELECT (start_sie_import_job($1,$2,$3,$4,$5,$6)).id', [
      company, actor, period, 'synthetic.se', 'a'.repeat(64), JSON.stringify(manifest),
    ])
    const importId = started.rows[0].id as string
    const attempt = await claimJob(importId)
    await postVoucher(importId, attempt)
    return { importId, attempt }
  }

  it('releases the bank row, offers the re-imported verifikat to the matcher again, and refuses the link until completion', async () => {
    const first = await firstImport()
    await complete(first.importId, first.attempt)
    const oldEntry = await batchEntry(first.importId)

    // A bank row matched to the first import's verifikat.
    const tx = randomUUID()
    await asOwner(() =>
      client.query(
        `INSERT INTO transactions(id,company_id,user_id,currency,amount,date,description,category,
                                  journal_entry_id,is_business,reconciliation_method)
         VALUES($1,$2,$3,'SEK',100,'2026-02-01','Synthetic deposit','income_other',$4,true,'auto_exact')`,
        [tx, company, actor, oldEntry],
      ),
    )

    // Replace: the old batch is stornoed and its bank row released.
    const next = (
      await client.query('SELECT j.* FROM replace_sie_import_job($1,$2,$3,$4,$5,$6,$7) j', [
        company, actor, period, 'synthetic.se', 'a'.repeat(64), JSON.stringify(manifest), first.importId,
      ])
    ).rows[0]
    const undoAttempt = await claimJob(first.importId)
    for (let i = 0; i < 2; i++) {
      await client.query('SELECT undo_sie_import_chunk($1,$2,$3,$4)', [company, first.importId, worker, undoAttempt])
    }
    const released = (await client.query('SELECT journal_entry_id,is_business,category,reconciliation_method,is_ignored FROM transactions WHERE id=$1', [tx])).rows[0]
    expect(released).toEqual({ journal_entry_id: null, is_business: null, category: null, reconciliation_method: null, is_ignored: false })

    // The replacement posts the same bank event on a new verifikat.
    const nextAttempt = await claimJob(next.id)
    await postVoucher(next.id, nextAttempt)
    const newEntry = await batchEntry(next.id)
    expect(newEntry).not.toBe(oldEntry)

    // While the batch holds the period a bank link to it is refused, so the
    // matcher cannot be a phase of the job, and no sweep can be claimed yet.
    await rejects(
      () => client.query('UPDATE transactions SET journal_entry_id=$1 WHERE id=$2', [newEntry, tx]),
      /SIE_IMPORT_HOLD/,
    )
    expect(await claimSweep(next.id)).toBe(false)

    await complete(next.id, nextAttempt)

    // Exactly the matcher's inputs: the unlinked lines RPC and the open row.
    const { rows: lines } = await client.query<UnlinkedGLLine>(
      `SELECT line_id, journal_entry_id, debit_amount::float8 AS debit_amount, credit_amount::float8 AS credit_amount,
              line_description, entry_date::text AS entry_date, voucher_number, voucher_series, entry_description, source_type
         FROM get_unlinked_gl_lines($1,'1930','2026-01-01','2026-12-31')`,
      [company],
    )
    expect(lines.map((l) => l.journal_entry_id)).toEqual([newEntry])
    const { rows: open } = await client.query(
      `SELECT id, amount::float8 AS amount, date::text AS date, currency, reference
         FROM transactions WHERE company_id=$1 AND journal_entry_id IS NULL AND is_ignored = false`,
      [company],
    )
    expect(open.map((r) => r.id)).toEqual([tx])
    const match = tryReconcileTransaction(open[0] as unknown as Transaction, lines)
    expect(match).toMatchObject({ method: 'auto_exact', confidence: 0.95 })
    expect(match?.glLine.journal_entry_id).toBe(newEntry)

    // What the sweep then writes is accepted now that the hold is gone.
    await client.query(
      `UPDATE transactions SET journal_entry_id=$1, reconciliation_method='auto_exact', is_business=true
        WHERE id=$2 AND journal_entry_id IS NULL`,
      [newEntry, tx],
    )
    expect((await client.query('SELECT public.is_transaction_booked($1) booked', [tx])).rows[0].booked).toBe(true)
  })

  it('keeps the sweep single-flight, records its receipt once, and lets a dead claim be taken over a bounded number of times', async () => {
    const first = await firstImport()
    expect(await claimSweep(first.importId)).toBe(false) // not completed yet
    await complete(first.importId, first.attempt)

    expect(await claimSweep(randomUUID())).toBe(false)
    expect(await claimSweep(first.importId)).toBe(true)
    expect(await bankSweep(first.importId)).toMatchObject({ state: 'running', attempt: 1 })
    expect(await claimSweep(first.importId)).toBe(false) // a live claim is respected

    const summary = { auto_linked: 2, suggested: 1, unmatched: 0, errors: 0, date_from: '2026-01-01', date_to: '2026-12-31', ran_at: '2026-09-21T00:00:00.000Z' }
    const record = () =>
      client.query<{ ok: boolean }>('SELECT record_sie_import_bank_sweep($1,$2,$3::jsonb) ok', [company, first.importId, JSON.stringify(summary)])
    expect((await record()).rows[0].ok).toBe(true)
    expect(await bankSweep(first.importId)).toEqual({ ...summary, state: 'done', attempt: 1 })
    expect((await record()).rows[0].ok).toBe(false) // nothing is running any more
    expect(await claimSweep(first.importId)).toBe(false) // done is final

    // The import itself is exactly as complete_sie_import_job left it.
    const job = (await client.query('SELECT job_state,status,error_message FROM sie_imports WHERE id=$1', [first.importId])).rows[0]
    expect(job).toEqual({ job_state: 'completed', status: 'completed', error_message: null })

    // A claim whose function died goes stale and is taken over, up to five attempts.
    const stale = (attempt: number) =>
      asOwner(() =>
        client.query(`UPDATE sie_imports SET bank_sweep = $2::jsonb WHERE id = $1`, [
          first.importId,
          JSON.stringify({ state: 'running', started_at: new Date(Date.now() - 11 * 60_000).toISOString(), attempt }),
        ]),
      )
    await stale(1)
    expect(await claimSweep(first.importId)).toBe(true)
    expect(await bankSweep(first.importId)).toMatchObject({ state: 'running', attempt: 2 })
    await stale(5)
    expect(await claimSweep(first.importId)).toBe(false)
  })

  it('cannot be forged: the receipt is written by the two service_role RPCs and nothing else', async () => {
    const first = await firstImport()
    await complete(first.importId, first.attempt)

    await rejects(
      () => client.query(`UPDATE sie_imports SET bank_sweep = '{"state":"done"}'::jsonb WHERE id = $1`, [first.importId]),
      /authorized RPC/,
    )
    await rejects(
      () => client.query('SELECT record_sie_import_bank_sweep($1,$2,$3::jsonb)', [company, first.importId, '[]']),
      /must be a JSON object/,
    )
    const { rows } = await asOwner(() =>
      client.query<{ fn: string; role: string; can: boolean }>(
        `SELECT f AS fn, r AS role, has_function_privilege(r, f, 'EXECUTE') AS can
           FROM unnest(ARRAY['public.claim_sie_import_bank_sweep(uuid, uuid)',
                             'public.record_sie_import_bank_sweep(uuid, uuid, jsonb)']) AS f,
                unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`,
      ),
    )
    for (const row of rows) expect(row.can).toBe(row.role === 'service_role')
  })
})
