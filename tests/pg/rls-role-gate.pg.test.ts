import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertBalancedLines,
  seedCompany,
} from './fixtures'

// Validates migration 20260702093000_rls_role_gate_and_voucher_rpc_guards:
//   1. current_user_can_write() + the write-side RLS policies block `viewer`
//      members (and non-members) from mutating tenant data via a direct
//      (PostgREST-style) connection, while non-viewer members can write.
//   2. commit_journal_entry() refuses an authenticated caller who is not a
//      member of the target company (42501), the cross-tenant hole this
//      migration closes, while a member commits normally.

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

describe('write-authorization role gate', () => {
  it('current_user_can_write() is true for a non-viewer member', async () => {
    const { userId, companyId } = await seedCompany() // owner
    await setActiveCompany(userId, companyId)
    await withUserContext(userId, async (client) => {
      const res = await client.query<{ can_write: boolean }>(
        `SELECT public.current_user_can_write() AS can_write`,
      )
      expect(res.rows[0].can_write).toBe(true)
    })
  })

  it('current_user_can_write() is false for a viewer member', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'viewer' })
    await setActiveCompany(userId, companyId)
    await withUserContext(userId, async (client) => {
      const res = await client.query<{ can_write: boolean }>(
        `SELECT public.current_user_can_write() AS can_write`,
      )
      expect(res.rows[0].can_write).toBe(false)
    })
  })

  it('lets a non-viewer member INSERT a customer under RLS', async () => {
    const { userId, companyId } = await seedCompany() // owner
    await setActiveCompany(userId, companyId)
    await withUserContext(userId, async (client) => {
      const res = await client.query(
        `INSERT INTO public.customers (company_id, user_id, name)
         VALUES ($1, $2, 'Acme AB') RETURNING id`,
        [companyId, userId],
      )
      expect(res.rows).toHaveLength(1)
    })
  })

  it('blocks a viewer from INSERTing a customer under RLS', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'viewer' })
    await setActiveCompany(userId, companyId)
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.customers (company_id, user_id, name)
           VALUES ($1, $2, 'Blocked AB')`,
          [companyId, userId],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })
})

describe('commit_journal_entry tenant guard', () => {
  it('lets a member commit their own draft and assigns a voucher number', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId)
    await withUserContext(userId, async (client) => {
      const res = await client.query<{ voucher_number: number }>(
        `SELECT voucher_number FROM public.commit_journal_entry($1, $2)`,
        [companyId, entryId],
      )
      expect(Number(res.rows[0].voucher_number)).toBeGreaterThan(0)
    })
  })

  it('blocks an authenticated non-member from committing another company draft', async () => {
    const { userId: ownerId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId: ownerId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId)

    const outsider = await insertAuthUser()
    await withUserContext(outsider, async (client) => {
      await expect(
        client.query(`SELECT voucher_number FROM public.commit_journal_entry($1, $2)`, [
          companyId,
          entryId,
        ]),
      ).rejects.toThrow(/unauthorized: caller is not a member/i)
    })
  })
})
