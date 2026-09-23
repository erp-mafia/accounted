import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient } from './setup'

let owner: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient
let entryId: string
let transactionId: string
let cashId: string
let bankLineId: string
let expenseLineId: string
beforeEach(async () => {
  owner = await seedCompany(); client = await getClient(); await client.query('BEGIN')
  entryId = randomUUID(); transactionId = randomUUID(); cashId = randomUUID()
  await client.query("INSERT INTO cash_accounts(id,company_id,ledger_account,currency,is_primary) VALUES($1,$2,'1930','SEK',true)", [cashId,owner.companyId])
  await client.query(`INSERT INTO transactions(id,company_id,user_id,date,amount,currency,description,cash_account_id)
    VALUES($1,$2,$3,'2026-06-01',-1000,'SEK','PG inline bank origin',$4)`, [transactionId,owner.companyId,owner.userId,cashId])
  await client.query(`INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,entry_date,description,status,source_type,source_id,bank_booking_context,voucher_number)
    VALUES($1,$2,$3,$4,'2026-06-01','PG inline origin','draft','bank_transaction',$5,$6,0)`,
  [entryId,owner.companyId,owner.userId,owner.fiscalPeriodId,transactionId,JSON.stringify([{ transaction_id: transactionId,
    cash_account_id: cashId, settlement_account: '1930', date: '2026-06-01', amount: -1000, currency: 'SEK' }])])
  const lines = (await client.query(`INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
    VALUES($1,'1930',0,500),($1,'5010',500,0) RETURNING id,account_number`, [entryId])).rows
  bankLineId = lines.find(l => l.account_number === '1930').id; expenseLineId = lines.find(l => l.account_number === '5010').id
  await client.query(`INSERT INTO chart_of_accounts(company_id,user_id,account_number,account_name,account_class,account_type,normal_balance)
    SELECT $1,$2,number,'Test '||number,substr(number,1,1)::int,'expense','debit' FROM unnest(ARRAY['1930','1932','5010','5420']) number`, [owner.companyId,owner.userId])
})
afterEach(async () => { await client.query('ROLLBACK'); client.release() })
async function post(type = 'bank_transaction') {
  await client.query('UPDATE journal_entries SET source_type=$2 WHERE id=$1', [entryId,type])
  await client.query('SELECT commit_journal_entry($1,$2)', [owner.companyId,entryId])
}
async function correct(ids: string[], lines: unknown[]) {
  return (await client.query('SELECT correct_entry_lines_inline($1,$2,$3,$4,$5) AS result',
    [owner.companyId,entryId,ids,JSON.stringify(lines),owner.userId])).rows[0].result
}
async function preserved() {
  return (await client.query(`SELECT jsonb_build_object('entry',(SELECT to_jsonb(j) FROM journal_entries j WHERE id=$1),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM journal_entry_lines l WHERE journal_entry_id=$1),
    'logs',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM journal_entry_rattelse_log l WHERE journal_entry_id=$1)) AS state`, [entryId])).rows[0].state
}

describe('inline correction recognizes bank origins before linking', () => {
  it.each(['bank_transaction','invoice_paid','supplier_invoice_paid','invoice_cash_payment','supplier_invoice_cash_payment','inbox_item'])(
    'refuses changing the bank ledger for an unlinked %s origin', async type => {
      await post(type); const before = await preserved(); await client.query('SAVEPOINT refused')
      await expect(correct([bankLineId], [{ account_number: '1932', credit_amount: 500 }])).rejects.toThrow(/kopplad till en banktransaktion/)
      await client.query('ROLLBACK TO SAVEPOINT refused'); expect(await preserved()).toEqual(before)
    })
  it('does not mistake a partial-payment origin for authority to increase the voucher to the full source amount', async () => {
    await post('invoice_paid')
    await expect(correct([bankLineId,expenseLineId], [{ account_number: '1930', credit_amount: 1000 }, { account_number: '5010', debit_amount: 1000 }]))
      .rejects.toThrow(/kopplad till en banktransaktion/)
  })
  it('allows a bank description correction with identical net and records its actor', async () => {
    await post()
    const result = await correct([bankLineId], [{ account_number: '1930', credit_amount: 500, line_description: 'Corrected description' }])
    expect(result).toMatchObject({ struck_count: 1, added_count: 1 })
    const after = await preserved(); expect(after.logs[0].actor).toBe(owner.userId)
    expect(after.entry.bank_booking_context[0].transaction_id).toBe(transactionId)
  })
  it('allows expense reclassification while preserving the bank line and voucher identity', async () => {
    await post(); const before = await preserved()
    await correct([expenseLineId], [{ account_number: '5420', debit_amount: 500 }])
    const after = await preserved()
    expect(after.lines.find((l: { id: string }) => l.id === bankLineId)).toEqual(before.lines.find((l: { id: string }) => l.id === bankLineId))
    expect(after.entry.id).toBe(before.entry.id); expect(after.entry.voucher_number).toBe(before.entry.voucher_number)
    expect(after.entry.bank_booking_context).toEqual(before.entry.bank_booking_context)
  })
  it('keeps ordinary manual corrections available when no bank origin exists', async () => {
    await client.query("UPDATE journal_entries SET bank_booking_context='[]',source_id=null WHERE id=$1", [entryId]); await post('manual')
    expect(await correct([bankLineId], [{ account_number: '1932', credit_amount: 500 }])).toMatchObject({ struck_count: 1 })
  })
  it('uses the existing allocated bank amount after a partial voucher is linked', async () => {
    await post('invoice_paid')
    await client.query(`INSERT INTO transaction_voucher_links(company_id,transaction_id,journal_entry_id,role,allocated_amount,user_id)
      VALUES($1,$2,$3,'bank_line',-500,$4)`, [owner.companyId,transactionId,entryId,owner.userId])
    await expect(correct([bankLineId,expenseLineId], [{ account_number: '1930', credit_amount: 1000 }, { account_number: '5010', debit_amount: 1000 }]))
      .rejects.toThrow(/kopplad till en banktransaktion på -500/)
  })
  it('does not treat one completed link as completion of a multi-origin voucher', async () => {
    const other = randomUUID()
    await client.query(`INSERT INTO transactions(id,company_id,user_id,date,amount,currency,description,cash_account_id)
      VALUES($1,$2,$3,'2026-06-01',-500,'SEK','PG second inline origin',$4)`, [other,owner.companyId,owner.userId,cashId])
    await client.query(`UPDATE journal_entries SET bank_booking_context=bank_booking_context || jsonb_build_array(
      jsonb_build_object('transaction_id',$2::uuid,'cash_account_id',$3::uuid,'settlement_account','1930',
      'date','2026-06-01','amount',-500,'currency','SEK')) WHERE id=$1`, [entryId,other,cashId])
    await post()
    await client.query(`INSERT INTO transaction_voucher_links(company_id,transaction_id,journal_entry_id,role,allocated_amount,user_id)
      VALUES($1,$2,$3,'bank_line',-250,$4)`, [owner.companyId,transactionId,entryId,owner.userId])
    await expect(correct([bankLineId,expenseLineId], [{ account_number: '1930', credit_amount: 250 }, { account_number: '5010', debit_amount: 250 }]))
      .rejects.toThrow(/kopplad till en banktransaktion eller betalning/)
  })
})
