/**
 * crm#1849: a person marks a verifikat the momsredovisning shapes catch as a
 * correction (vat_momsredovisning_marks, migration 20261115090244), and the
 * momsdeklaration reads it.
 *
 * The customer's case: a quarter with a sale and a correction booked
 * 2611 D / 3011 D / 3988 K / 1650 K. Shape 1 (a declaration account and a
 * 2650/1650 line) takes the correction for the period's momsredovisning: the
 * rutor drop it and the Moms page counts the quarter as settled. Marked, the
 * figure reads it and it is no momsredovisning any more; withdrawn, the shape
 * decides again; annulled by storno after the mark, the storno follows the
 * original. The table is append-only and only the server writes it (after
 * the checks in lib/vat/momsredovisning-marks.ts); a browser session reads.
 */
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertPostedJournalEntry,
  seedCompany,
  setActiveCompany,
} from './fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { stornoEntry, type CashCompany } from './kontantmetod-carry-fixtures'
import { VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS } from '@/lib/reports/vat-declaration'
import { roundOre } from '@/lib/money'

const ALL_ACCOUNTS = [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS, '3011']
const START = '2026-07-01'
const END = '2026-09-30'

const INSERT = `INSERT INTO public.vat_momsredovisning_marks (company_id, journal_entry_id, action, actor)
  VALUES ($1, $2, $3, $4) RETURNING id`

type Line = [account: string, debit: number, credit: number]

async function post(company: { userId: string; companyId: string; fiscalPeriodId: string }, date: string, lines: Line[], n: number) {
  return insertPostedJournalEntry({
    userId: company.userId,
    companyId: company.companyId,
    fiscalPeriodId: company.fiscalPeriodId,
    voucherNumber: n,
    entryDate: date,
    description: 'crm#1849 mark',
    sourceType: 'manual',
    lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
  })
}

async function seedQuarter() {
  const company = await seedCompany()
  await setActiveCompany(company.userId, company.companyId)
  const sale = await post(company, '2026-07-10', [['1930', 50000, 0], ['3001', 0, 40000], ['2611', 0, 10000]], 1)
  const correction = await post(
    company, '2026-09-30', [['2611', 3203.2, 0], ['3011', 3203.2, 0], ['3988', 0, 3203.2], ['1650', 0, 3203.2]], 2,
  )
  return { ...company, sale, correction }
}

async function figure(companyId: string) {
  const { rows } = await getPool().query(
    'SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload',
    [companyId, START, END, ALL_ACCOUNTS, VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
  )
  const payload = rows[0].payload as {
    totals: Array<{ account_number: string; debit: number; credit: number }>
    settlement_shaped_entries: Array<{ id: string }>
  }
  return {
    totals: new Map(payload.totals.map((t) => [t.account_number, { debit: Number(t.debit), credit: Number(t.credit) }])),
    shaped: new Set(payload.settlement_shaped_entries.map((e) => e.id)),
  }
}

async function drilled(companyId: string, accounts: string[]) {
  const { rows } = await getPool().query<{ journal_entry_id: string }>(
    'SELECT journal_entry_id FROM public.get_vat_ruta_source_lines($1,$2,$3,$4,$5,$6)',
    [companyId, START, END, accounts, VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
  )
  return new Set(rows.map((r) => r.journal_entry_id))
}

describe('vat_momsredovisning_marks.pg: a correction the shapes catch, marked by a person, is read (crm#1849)', () => {
  it('reads a marked correction in the figure and the drill-down, and gives it back to the shape when withdrawn', async () => {
    const q = await seedQuarter()

    const before = await figure(q.companyId)
    expect(before.shaped.has(q.correction)).toBe(true)
    expect(before.totals.get('2611')).toEqual({ debit: 0, credit: 10000 })

    await getPool().query(INSERT, [q.companyId, q.correction, 'not_momsredovisning', q.userId])
    const marked = await figure(q.companyId)
    expect(marked.shaped.has(q.correction)).toBe(false)
    expect(marked.totals.get('2611')).toEqual({ debit: 3203.2, credit: 10000 })
    expect(marked.totals.get('3011')).toEqual({ debit: 3203.2, credit: 0 })
    expect((await drilled(q.companyId, ['2611'])).has(q.correction)).toBe(true)

    await getPool().query(INSERT, [q.companyId, q.correction, 'withdrawn', q.userId])
    const withdrawn = await figure(q.companyId)
    expect(withdrawn.shaped.has(q.correction)).toBe(true)
    expect(withdrawn.totals.get('2611')).toEqual({ debit: 0, credit: 10000 })
    expect((await drilled(q.companyId, ['2611'])).has(q.correction)).toBe(false)
  })

  it('withdrawn after the quarter\'s momsredovisning was booked, the correction settles what that one left: the declared VAT is what the momsredovisningar moved', async () => {
    const q = await seedQuarter()
    await getPool().query(INSERT, [q.companyId, q.correction, 'not_momsredovisning', q.userId])
    // Booked while the mark holds: the momsredovisning clears what the
    // declaration then reads on 2611.
    const owed = (await figure(q.companyId)).totals.get('2611')!
    const cleared = roundOre(owed.credit - owed.debit)
    const settlement = await insertPostedJournalEntry({
      userId: q.userId,
      companyId: q.companyId,
      fiscalPeriodId: q.fiscalPeriodId,
      voucherNumber: 3,
      entryDate: END,
      description: 'Momsredovisning Kvartal 3 2026',
      sourceType: 'vat_settlement',
      lines: [
        { accountNumber: '2611', debitAmount: cleared, creditAmount: 0 },
        { accountNumber: '2650', debitAmount: 0, creditAmount: cleared },
      ],
    })

    await getPool().query(INSERT, [q.companyId, q.correction, 'withdrawn', q.userId])
    const withdrawn = await figure(q.companyId)
    // The correction is a momsredovisning again, so the rutor read the sale
    // alone...
    expect(withdrawn.shaped.has(q.correction)).toBe(true)
    expect(withdrawn.totals.get('2611')).toEqual({ debit: 0, credit: 10000 })
    // ...and what the declaration says is owed on 2611 is exactly what the
    // quarter's momsredovisningar (the booked one and every shaped one) moved
    // off it: nothing is left to settle and nothing is settled twice.
    const declared = withdrawn.totals.get('2611')!
    const { rows } = await getPool().query<{ moved: string }>(
      `SELECT sum(debit_amount - credit_amount) AS moved FROM public.journal_entry_lines
        WHERE journal_entry_id = ANY ($1::uuid[]) AND account_number = '2611'`,
      [[settlement, ...withdrawn.shaped]],
    )
    expect(roundOre(declared.credit - declared.debit)).toBe(roundOre(Number(rows[0]!.moved)))
  })

  it('reads the storno of a marked correction with it, so the annulled pair nets to nothing', async () => {
    const q = await seedQuarter()
    await getPool().query(INSERT, [q.companyId, q.correction, 'not_momsredovisning', q.userId])
    const company: CashCompany = { userId: q.userId, companyId: q.companyId, fiscalPeriodId: q.fiscalPeriodId, nextPeriodId: q.fiscalPeriodId }
    const storno = await stornoEntry(company, q.correction, { date: '2026-09-30' })

    const after = await figure(q.companyId)
    expect(after.shaped.has(q.correction)).toBe(false)
    expect(after.shaped.has(storno)).toBe(false)
    expect(after.totals.get('2611')).toEqual({ debit: 3203.2, credit: 13203.2 })
  })

  it('lets only the server write a mark: a browser session, even the owner\'s, has no INSERT; members read their company\'s marks', async () => {
    const q = await seedQuarter()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: q.companyId, userId: member, role: 'member' })
    await setActiveCompany(member, q.companyId)
    for (const actor of [q.userId, member]) {
      await withUserContext(actor, async (client) => {
        await expect(
          client.query(INSERT, [q.companyId, q.correction, 'not_momsredovisning', actor]),
        ).rejects.toThrow(/permission denied/i)
      })
    }
    // The server records the mark after its checks, as the person who asked.
    await runAsServiceRole(async (service) => {
      const inserted = await service.query(INSERT, [q.companyId, q.correction, 'not_momsredovisning', member])
      expect(inserted.rowCount).toBe(1)
    })
    await withUserContext(member, async (client) => {
      const read = await client.query<{ actor: string }>(
        `SELECT actor FROM public.vat_momsredovisning_marks WHERE company_id = $1`,
        [q.companyId],
      )
      expect(read.rows.map((r) => r.actor)).toEqual([member])
    })
  })

  it('is append-only for a browser session, hidden from other companies and anon, and checks its action', async () => {
    const q = await seedQuarter()
    const { rows } = await getPool().query<{ id: string }>(INSERT, [q.companyId, q.correction, 'not_momsredovisning', q.userId])
    const id = rows[0]!.id
    await withUserContext(q.userId, async (client) => {
      await expect(
        client.query(`UPDATE public.vat_momsredovisning_marks SET action = 'withdrawn' WHERE id = $1`, [id]),
      ).rejects.toThrow(/permission denied/i)
    })
    await withUserContext(q.userId, async (client) => {
      await expect(client.query(`DELETE FROM public.vat_momsredovisning_marks WHERE id = $1`, [id])).rejects.toThrow(/permission denied/i)
    })
    const outsider = await insertAuthUser()
    const outsiderCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: outsiderCompany, userId: outsider, role: 'owner' })
    await withUserContext(outsider, async (client) => {
      const read = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.vat_momsredovisning_marks`)
      expect(read.rows[0]!.n).toBe(0)
    })
    const anon = await getClient()
    try {
      await anon.query('BEGIN')
      await anon.query('SET LOCAL ROLE anon')
      await expect(anon.query(`SELECT id FROM public.vat_momsredovisning_marks`)).rejects.toThrow(/permission denied/i)
    } finally {
      await anon.query('ROLLBACK').catch(() => {})
      anon.release()
    }
    await expect(
      getPool().query(INSERT, [q.companyId, q.correction, 'momsredovisning', q.userId]),
    ).rejects.toThrow(/check constraint/i)
  })
})
