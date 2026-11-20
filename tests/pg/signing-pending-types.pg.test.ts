import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The staged doors of BankID document signing (20261025200100,
 * lib/operations/signing-requests.ts): their pending operation types are
 * accepted, and the constraint still refuses a type nobody declared.
 */
describe('signing pending operation types', () => {
  it.each(['request_signature', 'remind_signature'])('accepts %s as a pending operation type', async (type) => {
    const c = await seedCompany()
    await expect(getPool().query(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title) VALUES ($1, $2, $3, 'pg') RETURNING id`,
      [c.userId, c.companyId, type],
    )).resolves.toMatchObject({ rowCount: 1 })
  })

  it('still refuses an undeclared type and keeps the types added before it', async () => {
    const c = await seedCompany()
    await expect(getPool().query(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title) VALUES ($1, $2, 'sign_on_behalf', 'pg')`,
      [c.userId, c.companyId],
    )).rejects.toThrow(/pending_operations_operation_type_check/)
    await expect(getPool().query(
      `INSERT INTO public.pending_operations (user_id, company_id, operation_type, title) VALUES ($1, $2, 'merge_customers', 'pg') RETURNING id`,
      [c.userId, c.companyId],
    )).resolves.toMatchObject({ rowCount: 1 })
  })
})
