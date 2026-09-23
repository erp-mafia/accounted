import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260906170107_repair_stranded_transactions (issue #2057).
 *
 * A row stranded before #1990 (is_business = true, no verifikat anchor in any
 * of the three booking locations, not ignored) is the ONLY shape the RPC
 * touches. Rows anchored through journal_entry_id or transaction_voucher_links,
 * untriaged rows, ignored rows and private rows are left alone. The write
 * resets the storno triple (is_business, category, reconciliation_method),
 * keeps is_ignored, logs one BankTransactionStrandedRepaired event per row,
 * and is idempotent. Dry run is the default and writes nothing. Rows in a
 * locked or closed period are listed but skipped unless p_skip_locked is
 * false. A write needs a company id and an actor. Only service_role may
 * execute it.
 */

interface PgError extends Error {
  code?: string
}

const ACTOR = JSON.stringify({ type: 'user', id: randomUUID(), label: 'pg-real' })

async function insertStranded(params: {
  companyId: string
  userId: string
  date?: string
  category?: string
  isIgnored?: boolean
  isBusiness?: boolean | null
}): Promise<string> {
  const id = await insertTransaction({
    companyId: params.companyId,
    userId: params.userId,
    date: params.date ?? '2026-06-01',
    isIgnored: params.isIgnored ?? false,
  })
  await getPool().query(
    `UPDATE public.transactions
        SET is_business = $2, category = $3, reconciliation_method = 'manual'
      WHERE id = $1`,
    [id, params.isBusiness === undefined ? true : params.isBusiness, params.category ?? 'expense_office'],
  )
  return id
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

async function callRepair(
  client: PoolClient,
  params: { companyId: string | null; dryRun: boolean; skipLocked?: boolean; actor?: string | null },
) {
  const { rows } = await client.query<{
    transaction_id: string
    company_id: string
    is_sandbox: boolean
    lock_state: string
    previous_category: string | null
    repaired: boolean
  }>(
    `SELECT transaction_id, company_id, is_sandbox, lock_state, previous_category, repaired
       FROM public.repair_stranded_transactions($1, $2, $3, $4::jsonb, NULL)`,
    [
      params.companyId,
      params.dryRun,
      params.skipLocked ?? true,
      params.actor === undefined ? ACTOR : params.actor,
    ],
  )
  return rows
}

describe('repair_stranded_transactions (issue #2057)', () => {
  it('lists only the stranded shape and repairs it with a behandlingshistorik record, idempotently', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const stranded = await insertStranded({ companyId, userId, category: 'expense_office' })
    const untriaged = await insertTransaction({ companyId, userId })
    const ignored = await insertStranded({ companyId, userId, isIgnored: true })
    const privateRow = await insertStranded({ companyId, userId, isBusiness: false })

    const entryId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const direct = await insertStranded({ companyId, userId })
    await getPool().query(`UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`, [
      direct,
      entryId,
    ])

    const viaJunction = await insertStranded({ companyId, userId })
    await getPool().query(
      `INSERT INTO public.transaction_voucher_links
         (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
       VALUES ($1, $2, $3, $4, -100, 'other')`,
      [userId, companyId, viaJunction, entryId],
    )

    // Dry run: the stranded row only, nothing written.
    const dry = await runAsServiceRole((c) => callRepair(c, { companyId, dryRun: true }))
    expect(dry.map((r) => r.transaction_id)).toEqual([stranded])
    expect(dry[0]).toMatchObject({
      company_id: companyId,
      is_sandbox: false,
      lock_state: 'open',
      previous_category: 'expense_office',
      repaired: false,
    })
    expect((await txState(stranded)).is_business).toBe(true)

    // Write: the storno triple is reset, is_ignored stays, the rest untouched.
    const written = await runAsServiceRole((c) => callRepair(c, { companyId, dryRun: false }))
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ transaction_id: stranded, repaired: true })
    expect(await txState(stranded)).toEqual({
      is_business: null,
      category: null,
      reconciliation_method: null,
      is_ignored: false,
      journal_entry_id: null,
    })
    expect((await txState(untriaged)).is_business).toBeNull()
    expect((await txState(ignored)).is_business).toBe(true)
    expect((await txState(privateRow)).is_business).toBe(false)
    expect((await txState(direct)).is_business).toBe(true)
    expect((await txState(direct)).journal_entry_id).toBe(entryId)
    expect((await txState(viaJunction)).is_business).toBe(true)

    // The journal entry is untouched.
    const { rows: entries } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entries[0].status).toBe('posted')

    // One event per repaired row, ids and the previous triple only.
    const { rows: history } = await getPool().query<{
      aggregate_type: string
      company_id: string
      payload: { previous: { category: string }; issue: number }
      actor: { type: string }
    }>(
      `SELECT aggregate_type, company_id, payload, actor
         FROM public.processing_history
        WHERE event_type = 'BankTransactionStrandedRepaired' AND aggregate_id = $1`,
      [stranded],
    )
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      aggregate_type: 'BankTransaction',
      company_id: companyId,
      payload: { issue: 2057, previous: { category: 'expense_office' } },
      actor: { type: 'user' },
    })

    // Idempotent: a second write finds nothing.
    const again = await runAsServiceRole((c) => callRepair(c, { companyId, dryRun: false }))
    expect(again).toHaveLength(0)
  })

  it('names the lock state, skips locked rows by default and resets them only on request', async () => {
    const { userId, companyId } = await seedCompany()
    await insertFiscalPeriod({
      userId,
      companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      isClosed: true,
    })
    const inClosed = await insertStranded({ companyId, userId, date: '2025-03-10' })
    const inOpen = await insertStranded({ companyId, userId, date: '2026-03-10' })
    const noPeriod = await insertStranded({ companyId, userId, date: '2020-03-10' })

    const dry = await runAsServiceRole((c) => callRepair(c, { companyId, dryRun: true }))
    const byId = new Map(dry.map((r) => [r.transaction_id, r.lock_state]))
    expect(byId.get(inClosed)).toBe('closed')
    expect(byId.get(inOpen)).toBe('open')
    expect(byId.get(noPeriod)).toBe('no_period')

    // Default write: only the open row moves; closed and no-period rows stay.
    const written = await runAsServiceRole((c) => callRepair(c, { companyId, dryRun: false }))
    expect(written.filter((r) => r.repaired).map((r) => r.transaction_id)).toEqual([inOpen])
    expect((await txState(inClosed)).is_business).toBe(true)
    expect((await txState(noPeriod)).is_business).toBe(true)
    expect((await txState(inOpen)).is_business).toBeNull()

    // Explicit p_skip_locked = false resets the rest as well.
    const forced = await runAsServiceRole((c) =>
      callRepair(c, { companyId, dryRun: false, skipLocked: false }),
    )
    expect(forced.filter((r) => r.repaired).map((r) => r.transaction_id).sort()).toEqual(
      [inClosed, noPeriod].sort(),
    )
    expect((await txState(inClosed)).is_business).toBeNull()
    expect((await txState(noPeriod)).is_business).toBeNull()
  })

  it('scopes a write to one company and flags sandbox companies', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, true)
       ON CONFLICT (company_id) DO UPDATE SET is_sandbox = true`,
      [b.userId, b.companyId],
    )
    const rowA = await insertStranded({ companyId: a.companyId, userId: a.userId })
    const rowB = await insertStranded({ companyId: b.companyId, userId: b.userId })

    const all = await runAsServiceRole((c) => callRepair(c, { companyId: null, dryRun: true }))
    expect(all.find((r) => r.transaction_id === rowA)?.is_sandbox).toBe(false)
    expect(all.find((r) => r.transaction_id === rowB)?.is_sandbox).toBe(true)

    await runAsServiceRole((c) => callRepair(c, { companyId: a.companyId, dryRun: false }))
    expect((await txState(rowA)).is_business).toBeNull()
    expect((await txState(rowB)).is_business).toBe(true)
  })

  it('refuses a write without a company id or without an actor', async () => {
    const { companyId } = await seedCompany()
    const noCompany = await runAsServiceRole((c) =>
      callRepair(c, { companyId: null, dryRun: false }).then(
        () => null,
        (e: PgError) => e,
      ),
    )
    expect(noCompany?.code).toBe('22023')
    const noActor = await runAsServiceRole((c) =>
      callRepair(c, { companyId, dryRun: false, actor: null }).then(
        () => null,
        (e: PgError) => e,
      ),
    )
    expect(noActor?.code).toBe('22023')
  })

  it('is executable by service_role only', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query<{ role: string; can: boolean }>(
      `SELECT r AS role,
              has_function_privilege(r, 'public.repair_stranded_transactions(uuid, boolean, boolean, jsonb, uuid)', 'EXECUTE') AS can
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.role, r.can]))).toEqual({
      anon: false,
      authenticated: false,
      service_role: true,
    })

    const denied = await withUserContext(userId, (c) =>
      callRepair(c, { companyId, dryRun: true }).then(
        () => null,
        (e: PgError) => e,
      ),
    )
    expect(denied?.code).toBe('42501')
  })
})
