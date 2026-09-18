import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool } from './setup'

const balance = { as_of_date: '2037-07-31', year_start: '2037-01-01', annual_entitlement: 25, tracking: true,
  paid: 8, extra_paid: 2, unpaid: 10, advance: 7, saved_by_year: { '2036': 3.5 }, source_reference: 'Synthetic source', review_notes: [] }

describe('categorized cutover balances (rollback-only fixtures)', () => {
  it.each([
    [balance, true], [{ ...balance, paid: -1 }, false], [{ ...balance, saved_by_year: { '2031': 1 } }, false],
    [{ ...balance, tracking: false }, false], [{ ...balance, unpaid: null }, false], [{ ...balance, as_of_date: '2037-02-31' }, false],
  ])('validates the native database shape', async (value, valid) => {
    const result = await getPool().query('select public.valid_payroll_vacation_balance($1::jsonb) as valid', [JSON.stringify(value)])
    expect(result.rows[0].valid).toBe(valid)
  })
  it.each([
    [[{ date: '2037-08-01', category: 'extra_paid', days: .5 }], true],
    [[{ date: '2037-08-01', category: 'saved', days: .5 }], false],
    [[{ date: '2037-08-01', category: 'saved', saved_year: '2036', days: .5 }], true],
    [[{ date: '2037-08-01', category: 'paid', days: -1 }], false],
  ])('validates dated withdrawals', async (value, valid) => {
    const result = await getPool().query('select public.valid_payroll_vacation_movements($1::jsonb) as valid', [JSON.stringify(value)])
    expect(result.rows[0].valid).toBe(valid)
  })
  it('stores unknown money without zero coercion and enforces the category check on real rows', async () => {
    const client = await getClient()
    try {
      await client.query('begin')
      const user = randomUUID(), company = randomUUID(), employee = randomUUID()
      await client.query('insert into auth.users(id,email) values($1,$2)', [user, `${user}@test.invalid`])
      await client.query("insert into companies(id,name,entity_type,created_by) values($1,'Synthetic AB','aktiebolag',$2)", [company, user])
      await client.query("insert into employees(id,company_id,user_id,first_name,last_name,personnummer,personnummer_last4,employment_start) values($1,$2,$3,'Test','Example','encrypted','0000','2037-01-01')", [employee, company, user])
      const result = await client.query(`insert into employee_opening_balances(company_id,employee_id,cutover_date,ytd_net,opening_semester_liability,opening_semester_liability_avgifter,vacation_balance)
        values($1,$2,'2037-08-01',null,null,null,$3) returning ytd_net,opening_semester_liability,vacation_balance`, [company, employee, JSON.stringify(balance)])
      expect(result.rows[0].ytd_net).toBeNull()
      expect(result.rows[0].opening_semester_liability).toBeNull()
      expect(result.rows[0].vacation_balance).toEqual(balance)
      await expect(client.query('update employee_opening_balances set vacation_balance=$1 where company_id=$2', [JSON.stringify({ ...balance, paid: -1 }), company])).rejects.toMatchObject({ code: '23514' })
    } finally { await client.query('rollback'); client.release() }
  })
})
