import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertCashAccount, seedCompany } from '@/tests/pg/fixtures'
import { voucherDisplayAmount } from '@/lib/bookkeeping/voucher-display-amount'
import {
  VOUCHER_SHAPES,
  type ShapeLine,
} from '@/lib/bookkeeping/__tests__/voucher-display-amount.shapes'

// crm#1280: the verifikat list's Belopp column shows the money line of a
// voucher that records one payment (src/lib/bookkeeping/voucher-display-amount.ts),
// and its amount sort orders by the display_amount computed column (migration
// 20261018135300), the SQL mirror of that helper. The two must agree on every
// shape, or the list sorts by a number it does not show. Everything is read
// as the company's member, the way the list reads it.
describe('display_amount computed column', () => {
  // Header and lines in ONE transaction: check_balance_on_posted_insert is
  // deferred to commit, so a posted header committed alone is rejected. A
  // bank_transaction voucher needs its bank row (BANK_BOOKING_CONTEXT_REQUIRED),
  // so it is stored as manual: the rule reads source_type only to tell an
  // opening balance apart, and the helper is fed the stored row either way.
  async function insertEntry(p: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    voucherNumber: number
    sourceType: string
    lines: ShapeLine[]
    status?: 'draft' | 'posted'
  }): Promise<string> {
    const id = randomUUID()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         VALUES ($1,$2,$3,$4,$5,'A','2026-06-01','display amount',$6,$7)`,
        [
          id,
          p.userId,
          p.companyId,
          p.fiscalPeriodId,
          p.voucherNumber,
          p.sourceType === 'bank_transaction' ? 'manual' : p.sourceType,
          p.status ?? 'posted',
        ],
      )
      for (const [account, debit, credit] of p.lines) {
        await client.query(
          `INSERT INTO public.journal_entry_lines
             (journal_entry_id, account_number, debit_amount, credit_amount)
           VALUES ($1, $2, $3, $4)`,
          [id, account, debit, credit],
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    return id
  }

  // What the list feeds the helper, read under the member's RLS: the entry
  // and its lines as stored (pg returns numeric as strings, as PostgREST may)
  // and the company's cash ledgers. Returns the helper's amount next to the
  // SQL column's.
  async function bothAmounts(
    client: PoolClient,
    entryId: string,
  ): Promise<{ helper: number; sql: number }> {
    const { rows: entries } = await client.query<{
      company_id: string
      source_type: string
      sql_amount: string
    }>(
      `SELECT je.company_id, je.source_type, public.display_amount(je.*)::text AS sql_amount
         FROM public.journal_entries je WHERE je.id = $1`,
      [entryId],
    )
    const { rows: lines } = await client.query<{
      account_number: string
      debit_amount: string
      credit_amount: string
    }>(
      `SELECT account_number, debit_amount, credit_amount
         FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
      [entryId],
    )
    const { rows: cash } = await client.query<{ ledger_account: string }>(
      `SELECT ledger_account FROM public.cash_accounts
        WHERE company_id = $1 AND ledger_account IS NOT NULL`,
      [entries[0].company_id],
    )
    const helper = voucherDisplayAmount(
      { source_type: entries[0].source_type, lines },
      new Set(cash.map((c) => c.ledger_account)),
    )
    return { helper: helper.amount, sql: Number(entries[0].sql_amount) }
  }

  it('agrees with voucherDisplayAmount on every shape the helper is tested with', async () => {
    // One company per set of extra cash ledgers: a cash account on 1686 makes
    // that ledger a money account for every voucher of its company.
    const groups = new Map<string, typeof VOUCHER_SHAPES>()
    for (const shape of VOUCHER_SHAPES) {
      const key = (shape.extraMoneyAccounts ?? []).join(',')
      groups.set(key, [...(groups.get(key) ?? []), shape])
    }

    const results: Array<{ name: string; expected: number; helper: number; sql: number }> = []
    for (const [key, shapes] of groups) {
      const { userId, companyId, fiscalPeriodId } = await seedCompany()
      for (const ledger of key ? key.split(',') : []) {
        await insertCashAccount({ companyId, ledgerAccount: ledger, source: 'manual' })
      }
      const ids: Array<{ id: string; shape: (typeof shapes)[number] }> = []
      let voucherNumber = 0
      for (const shape of shapes) {
        voucherNumber += 1
        const id = await insertEntry({
          userId,
          companyId,
          fiscalPeriodId,
          voucherNumber,
          sourceType: shape.source_type,
          lines: shape.lines,
        })
        ids.push({ id, shape })
      }
      await withUserContext(userId, async (client) => {
        for (const { id, shape } of ids) {
          results.push({ name: shape.name, expected: shape.expected.amount, ...(await bothAmounts(client, id)) })
        }
      })
    }

    expect(results).toHaveLength(VOUCHER_SHAPES.length)
    for (const r of results) {
      expect({ name: r.name, sql: r.sql }).toEqual({ name: r.name, sql: r.helper })
      expect({ name: r.name, sql: r.sql }).toEqual({ name: r.name, sql: r.expected })
    }
  })

  it('returns 0 for an entry without lines, like the helper', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const empty = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 0, sourceType: 'manual',
      status: 'draft', lines: [],
    })
    const amounts = await withUserContext(userId, (client) => bothAmounts(client, empty))
    expect(amounts).toEqual({ helper: 0, sql: 0 })
  })

  it('orders by the amount the list shows, not the omslutning', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const shape = (name: string) => VOUCHER_SHAPES.find((s) => s.name === name)!

    // Omslutning 450, shows 200 (the bank payment).
    const reverseCharge = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, sourceType: 'bank_transaction',
      lines: shape('reverse-charge bank payment').lines,
    })
    // Omslutning 300, shows 300 (no money line).
    const accrual = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 2, sourceType: 'manual',
      lines: [
        ['1790', 300, 0],
        ['5010', 0, 300],
      ],
    })
    // Omslutning 39 426, shows 23 000 (net pay).
    const salary = await insertEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 3, sourceType: 'salary_payment',
      lines: shape('salary payment (net pay left the bank)').lines,
    })

    // The ORDER BY PostgREST builds for order=<computed column>.desc.
    const orders = await withUserContext(userId, async (client) => {
      const order = async (fn: 'total_amount' | 'display_amount') =>
        (
          await client.query<{ id: string }>(
            `SELECT je.id FROM public.journal_entries je
              WHERE je.company_id = $1
              ORDER BY public.${fn}(je.*) DESC, je.voucher_number ASC`,
            [companyId],
          )
        ).rows.map((r) => r.id)
      return { total: await order('total_amount'), display: await order('display_amount') }
    })

    // The omslutning order the sort used before: 39 426, 450, 300.
    expect(orders.total).toEqual([salary, reverseCharge, accrual])
    // The order of the numbers on screen: 23 000, 300, 200.
    expect(orders.display).toEqual([salary, accrual, reverseCharge])
  })

  it('answers only for an entry the caller may read, whatever row value is passed in', async () => {
    const owner = await seedCompany()
    const other = await seedCompany()
    await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1686', source: 'manual' })
    const ownEntry = await insertEntry({
      userId: owner.userId, companyId: owner.companyId, fiscalPeriodId: owner.fiscalPeriodId,
      voucherNumber: 1, sourceType: 'bank_transaction',
      lines: [
        ['2645', 50, 0],
        ['2614', 0, 50],
        ['6540', 200, 0],
        ['1686', 0, 200],
      ],
    })
    const foreignEntry = await insertEntry({
      userId: other.userId, companyId: other.companyId, fiscalPeriodId: other.fiscalPeriodId,
      voucherNumber: 1, sourceType: 'bank_transaction',
      lines: [
        ['1930', 777, 0],
        ['3001', 0, 777],
      ],
    })

    const seen = await withUserContext(owner.userId, async (client) => {
      // The definer function takes the company and lines from the stored
      // entry: its own entry reads the company's 1686 cash account.
      const own = await client.query<{ amount: string | null }>(
        `SELECT public.display_amount(je.*)::text AS amount
           FROM public.journal_entries je WHERE je.id = $1`,
        [ownEntry],
      )
      // A forged row value: another company's entry id dressed in the
      // caller's own company id. Neither the id nor the company id passed
      // in is trusted, so it answers NULL instead of that entry's amount.
      const forged = await client.query<{ amount: string | null }>(
        `SELECT public.display_amount(
                  json_populate_record(
                    null::public.journal_entries,
                    json_build_object('id', $1::uuid, 'company_id', $2::uuid, 'source_type', 'manual')
                  )
                )::text AS amount`,
        [foreignEntry, owner.companyId],
      )
      return {
        own: own.rows.map((r) => r.amount),
        forged: forged.rows.map((r) => r.amount),
      }
    })

    expect(seen.own).toEqual(['200.00'])
    expect(seen.forged).toEqual([null])
  })

  it('is not executable by anon', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean }>(
      `SELECT has_function_privilege('anon', 'public.display_amount(public.journal_entries)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.display_amount(public.journal_entries)', 'EXECUTE') AS authenticated`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true })
  })
})
