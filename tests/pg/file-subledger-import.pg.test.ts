import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext, getClient } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember, insertPostedJournalEntry, insertFiscalPeriod } from './fixtures'

type Kind = 'customer' | 'supplier'
/** Build a synthetic open invoice with preserved source identifiers. */
const sourceRow = (party: string) => ({ counterparty: party, invoice_number: '000123', invoice_date: '2026-06-01',
  due_date: '2026-06-30', currency: 'SEK', vat_treatment: 'standard_25', total: 1250, vat_amount: 250,
  remaining_amount: 1250, voucher_series: 'A', voucher_number: 17, voucher_year: 2026, payment_reference: '0012345' })

/** Seed an accrual company and an existing registration voucher for either ledger. */
async function fixture(kind: Kind = 'customer') {
  const f = await seedCompany()
  await getPool().query('INSERT INTO company_settings(company_id,user_id,accounting_method) VALUES($1,$2,$3)', [f.companyId, f.userId, 'accrual'])
  const party = randomUUID()
  await getPool().query(`INSERT INTO ${kind === 'customer' ? 'customers' : 'suppliers'}(id,company_id,user_id,name) VALUES($1,$2,$3,$4)`, [party, f.companyId, f.userId, 'Synthetic party'])
  const voucher = await insertPostedJournalEntry({ ...f, voucherNumber: 17, entryDate: '2026-06-01', lines: kind === 'customer'
    ? [{ accountNumber: '1510', debitAmount: 1250, creditAmount: 0 }, { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 }, { accountNumber: '2611', debitAmount: 0, creditAmount: 250 }]
    : [{ accountNumber: '2440', debitAmount: 0, creditAmount: 1250 }, { accountNumber: '4000', debitAmount: 1000, creditAmount: 0 }, { accountNumber: '2641', debitAmount: 250, creditAmount: 0 }] })
  return { ...f, party, voucher, row: sourceRow(party), kind }
}
/** Invoke the real import RPC with the fixture snapshot and reviewed rows. */
async function run(client: PoolClient, f: Awaited<ReturnType<typeof fixture>>, execute = false, token: string | null = null, rows = [f.row]) {
  return (await client.query('SELECT import_file_subledger($1,$2,$3,$4::jsonb,$5,$6) AS result',
    [f.companyId, f.kind, '2026-06-30', JSON.stringify(rows), execute, token])).rows[0].result
}
/** Capture complete journal contents to detect unintended bookkeeping writes. */
async function journalSnapshot(client: PoolClient, companyId: string) {
  return (await client.query(`SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) AS entries,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1) AS lines
    FROM journal_entries e WHERE e.company_id=$1`, [companyId])).rows[0]
}

/** A committed session is needed to test concurrent retry receipts. */
async function committedUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.sub',$2,true)", [JSON.stringify({ sub: userId, role: 'authenticated' }), userId])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}

describe('file subledger RPC', () => {
  it('pins temporary relations after public without losing definer settings', async () => {
    const result = await getPool().query(`SELECT prosecdef, proconfig FROM pg_proc
      WHERE oid='public.import_file_subledger(uuid,text,date,jsonb,boolean,text)'::regprocedure`)
    expect(result.rows[0].prosecdef).toBe(true)
    expect(result.rows[0].proconfig).toEqual(expect.arrayContaining([
      'search_path=public, pg_temp', 'statement_timeout=15s', 'lock_timeout=2s',
    ]))
  })
  it.each([false, true])('rejects forged temporary membership with execute=%s', async execute => {
    const f = await fixture()
    const stranger = await insertAuthUser()
    const preview = await withUserContext(f.userId, client => run(client, f))
    await expect(withUserContext(stranger, async client => {
      await client.query(`CREATE TEMP TABLE company_members (
        company_id uuid, user_id uuid, role text
      ) ON COMMIT DROP`)
      await client.query("INSERT INTO pg_temp.company_members VALUES ($1,$2,'owner')", [f.companyId, stranger])
      return run(client, f, execute, preview.token)
    })).rejects.toThrow('SUBLEDGER_FORBIDDEN')
    expect((await getPool().query('SELECT count(*)::int AS n FROM invoices WHERE company_id=$1', [f.companyId])).rows[0].n).toBe(0)
    expect((await getPool().query('SELECT count(*)::int AS n FROM subledger_file_imports WHERE company_id=$1', [f.companyId])).rows[0].n).toBe(0)
  })
  it('uses real membership for an owner despite an empty temporary shadow', async () => {
    const f = await fixture()
    await withUserContext(f.userId, async client => {
      await client.query(`CREATE TEMP TABLE company_members (
        company_id uuid, user_id uuid, role text
      ) ON COMMIT DROP`)
      expect((await run(client, f)).difference).toBe(0)
    })
  })

  it.each<Kind>(['customer', 'supplier'])('imports %s balances and preserves every journal byte', async kind => {
    const f = await fixture(kind)
    await withUserContext(f.userId, async client => {
      const before = await journalSnapshot(client, f.companyId)
      const preview = await run(client, f)
      expect(preview.difference).toBe(0)
      expect((await client.query('SELECT count(*)::int AS n FROM subledger_file_imports WHERE company_id=$1', [f.companyId])).rows[0].n).toBe(0)
      const result = await run(client, f, true, preview.token)
      expect(result.imported).toBe(1)
      const table = kind === 'customer' ? 'invoices' : 'supplier_invoices'
      const link = kind === 'customer' ? 'journal_entry_id' : 'registration_journal_entry_id'
      const saved = (await client.query(`SELECT * FROM ${table} WHERE company_id=$1`, [f.companyId])).rows[0]
      expect(saved[link]).toBe(f.voucher)
      expect(Number(saved.remaining_amount)).toBe(1250)
      expect(saved.paid_at).toBeNull()
      expect(await journalSnapshot(client, f.companyId)).toEqual(before)
      expect((await run(client, f, true, preview.token)).already_imported).toBe(true)
      expect((await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id=$1`, [f.companyId])).rows[0].n).toBe(1)
    })
  })
  it.each([
    { prefix: '', number: '001', before: 1, after: 2 },
    { prefix: 'INV-', number: 'INV-099', before: 1, after: 100 },
    { prefix: '', number: '001', before: 500, after: 500 },
    { prefix: 'NEW-', number: 'OLD-099', before: 1, after: 1 },
    { prefix: '', number: '000001', before: 1, after: 1 },
  ])('preserves $number and advances numbering from $before to $after', async ({ prefix, number, before, after }) => {
    const f = await fixture()
    f.row.invoice_number = number
    await getPool().query('UPDATE company_settings SET invoice_prefix=$1,next_invoice_number=$2 WHERE company_id=$3', [prefix, before, f.companyId])
    await withUserContext(f.userId, async client => {
      const preview = await run(client, f)
      expect(preview.next_invoice_number_before).toBe(before)
      expect(preview.next_invoice_number_after).toBe(after)
      const counter = async () => (await client.query('SELECT next_invoice_number FROM company_settings WHERE company_id=$1', [f.companyId])).rows[0].next_invoice_number
      expect(await counter()).toBe(before)
      await run(client, f, true, preview.token)
      expect(await counter()).toBe(after)
      expect((await client.query('SELECT invoice_number FROM invoices WHERE company_id=$1', [f.companyId])).rows[0].invoice_number).toBe(number)
      await run(client, f, true, preview.token)
      expect(await counter()).toBe(after)
      const draft = randomUUID()
      await client.query("INSERT INTO invoices(id,company_id,user_id,customer_id,invoice_date,due_date,status,subtotal,vat_amount,total) VALUES($1,$2,$3,$4,'2026-06-01','2026-06-30','draft',1000,250,1250)", [draft,f.companyId,f.userId,f.party])
      const assigned = (await client.query("SELECT public.generate_invoice_number($1,$2,'invoice') AS number", [f.companyId,draft])).rows[0].number
      expect(assigned).toBe(prefix + String(after).padStart(3, '0'))
      expect(assigned).not.toBe(number)
    })
  })
  it('invalidates the preview when invoice numbering changes', async () => {
    const f = await fixture(); f.row.invoice_number = '001'
    const preview = await withUserContext(f.userId, client => run(client, f))
    await getPool().query('UPDATE company_settings SET next_invoice_number=500 WHERE company_id=$1', [f.companyId])
    await expect(withUserContext(f.userId, client => run(client, f, true, preview.token))).rejects.toThrow('SUBLEDGER_PREVIEW_STALE')
    expect((await getPool().query('SELECT next_invoice_number FROM company_settings WHERE company_id=$1', [f.companyId])).rows[0].next_invoice_number).toBe(500)
  })
  it('rolls back the numbering advance when the import does not reconcile', async () => {
    const f = await fixture(); f.row.invoice_number = '099'; f.row.remaining_amount = 1000
    const before = (await getPool().query('SELECT next_invoice_number FROM company_settings WHERE company_id=$1', [f.companyId])).rows[0].next_invoice_number
    await expect(withUserContext(f.userId, async client => {
      const preview = await run(client, f)
      return run(client, f, true, preview.token)
    })).rejects.toThrow('SUBLEDGER_UNRECONCILED')
    expect((await getPool().query('SELECT next_invoice_number FROM company_settings WHERE company_id=$1', [f.companyId])).rows[0].next_invoice_number).toBe(before)
  })
  it('preserves a partially settled balance without creating payment records', async () => {
    const f = await fixture()
    await insertPostedJournalEntry({ ...f, voucherNumber: 18, entryDate: '2026-06-10', lines: [
      { accountNumber: '1930', debitAmount: 625, creditAmount: 0 }, { accountNumber: '1510', debitAmount: 0, creditAmount: 625 },
    ] })
    f.row.remaining_amount = 625
    await withUserContext(f.userId, async client => {
      const p = await run(client, f); expect(p.difference).toBe(0)
      await run(client, f, true, p.token)
      const invoice = (await client.query('SELECT paid_amount,remaining_amount,paid_at FROM invoices WHERE company_id=$1', [f.companyId])).rows[0]
      expect(Number(invoice.paid_amount)).toBe(625); expect(Number(invoice.remaining_amount)).toBe(625); expect(invoice.paid_at).toBeNull()
    })
  })
  it('rejects viewers and cross-company calls at the database boundary', async () => {
    const f = await fixture(); const stranger = await insertAuthUser()
    await expect(withUserContext(stranger, c => run(c, f))).rejects.toThrow('SUBLEDGER_FORBIDDEN')
    await insertCompanyMember({ companyId: f.companyId, userId: stranger, role: 'viewer' })
    await expect(withUserContext(stranger, c => run(c, f))).rejects.toThrow('SUBLEDGER_FORBIDDEN')
  })
  it('rejects cross-company counterparties and vouchers', async () => {
    const f = await fixture(); const other = await fixture()
    await expect(withUserContext(f.userId, c => run(c, f, false, null, [{ ...f.row, counterparty: other.party }]))).rejects.toThrow('SUBLEDGER_PARTY_UNRESOLVED')
    await expect(withUserContext(f.userId, c => run(c, f, false, null, [{ ...f.row, voucher_number: 99 }]))).rejects.toThrow('SUBLEDGER_VOUCHER_UNRESOLVED')
  })
  it('rejects a duplicated invoice before writing either row', async () => {
    const f = await fixture()
    await expect(withUserContext(f.userId, c => run(c, f, true, 'x', [f.row, f.row]))).rejects.toThrow('SUBLEDGER_DUPLICATE')
    expect((await getPool().query('SELECT count(*)::int AS n FROM invoices WHERE company_id=$1', [f.companyId])).rows[0].n).toBe(0)
  })
  it('refuses an unexplained difference even with the correct preview token', async () => {
    const f = await fixture(); f.row.remaining_amount = 1000
    await expect(withUserContext(f.userId, async client => {
      const p = await run(client, f); expect(p.difference).toBe(250)
      return run(client, f, true, p.token)
    })).rejects.toThrow('SUBLEDGER_UNRECONCILED')
  })
  it('rejects a stale token', async () => {
    const f = await fixture()
    await expect(withUserContext(f.userId, c => run(c, f, true, 'a'.repeat(32)))).rejects.toThrow('SUBLEDGER_PREVIEW_STALE')
  })
  it('rejects unsupported currency and credits through direct RPC calls', async () => {
    const f = await fixture()
    for (const patch of [{ currency: 'EUR' }, { total: -1250 }, { vat_amount: 300 }]) {
      await expect(withUserContext(f.userId, c => run(c, f, false, null, [{ ...f.row, ...patch }]))).rejects.toThrow('SUBLEDGER_ROW_INVALID')
    }
  })
  it('serializes two concurrent submissions into one durable receipt', async () => {
    const f = await fixture()
    const p = await withUserContext(f.userId, c => run(c, f))
    const results = await Promise.all([1, 2].map(() => committedUser(f.userId, c => run(c, f, true, p.token))))
    expect(results.map(r => r.already_imported).sort()).toEqual([false, true])
    expect((await getPool().query('SELECT count(*)::int AS n FROM invoices WHERE company_id=$1', [f.companyId])).rows[0].n).toBe(1)
  })
  it('rejects a snapshot with later posted control-account movements', async () => {
    const f = await fixture()
    await insertPostedJournalEntry({ ...f, voucherNumber: 18, entryDate: '2026-07-01', lines: [
      { accountNumber: '1930', debitAmount: 1250, creditAmount: 0 }, { accountNumber: '1510', debitAmount: 0, creditAmount: 1250 },
    ] })
    await expect(withUserContext(f.userId, c => run(c, f))).rejects.toThrow('SUBLEDGER_SNAPSHOT_OUTDATED')
  })
  it('allows the same invoice number from two different suppliers', async () => {
    const f = await fixture('supplier')
    const secondParty = randomUUID()
    await getPool().query('INSERT INTO suppliers(id,company_id,user_id,name) VALUES($1,$2,$3,$4)', [secondParty, f.companyId, f.userId, 'Other synthetic supplier'])
    await insertPostedJournalEntry({ ...f, voucherNumber: 18, entryDate: '2026-06-01', lines: [
      { accountNumber: '2440', debitAmount: 0, creditAmount: 1250 }, { accountNumber: '4000', debitAmount: 1250, creditAmount: 0 },
    ] })
    await withUserContext(f.userId, async client => {
      const rows = [f.row, { ...f.row, counterparty: secondParty, voucher_number: 18 }]
      const p = await run(client, f, false, null, rows)
      expect(p.difference).toBe(0)
      expect((await run(client, f, true, p.token, rows)).imported).toBe(2)
    })
  })
  it('uses explicit opening balances without counting the previous year twice', async () => {
    const f = await seedCompany()
    await getPool().query("INSERT INTO company_settings(company_id,user_id,accounting_method) VALUES($1,$2,'accrual')", [f.companyId, f.userId])
    const party = randomUUID()
    await getPool().query('INSERT INTO customers(id,company_id,user_id,name) VALUES($1,$2,$3,$4)', [party, f.companyId, f.userId, 'Historical customer'])
    const prior = await insertFiscalPeriod({ ...f, periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    const voucher = await insertPostedJournalEntry({ ...f, fiscalPeriodId: prior, voucherNumber: 17, entryDate: '2025-12-01', lines: [
      { accountNumber: '1510', debitAmount: 1250, creditAmount: 0 }, { accountNumber: '3001', debitAmount: 0, creditAmount: 1250 },
    ] })
    const opening = await insertPostedJournalEntry({ ...f, voucherNumber: 1, entryDate: '2026-01-01', sourceType: 'opening_balance', lines: [
      { accountNumber: '1510', debitAmount: 1250, creditAmount: 0 }, { accountNumber: '2091', debitAmount: 0, creditAmount: 1250 },
    ] })
    await getPool().query('UPDATE fiscal_periods SET opening_balance_entry_id=$1 WHERE id=$2', [opening, f.fiscalPeriodId])
    const historical = { ...f, party, voucher, kind: 'customer' as const, row: { ...sourceRow(party), invoice_date: '2025-12-01', due_date: '2025-12-31', voucher_year: 2025 } }
    await withUserContext(f.userId, async client => {
      const p = await run(client, historical)
      expect(p.ledger_balance).toBe(1250); expect(p.difference).toBe(0)
      await run(client, historical, true, p.token)
    })
  })

})
