/**
 * The two gates of the service-role doors over a real PostgREST and a real
 * Postgres: the embedded filter of readLiveMembership is PostgREST's grammar,
 * which no mock can vouch for, and writeCompanySettings answers from the rows
 * a real UPDATE ... RETURNING matched.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { insertAuthUser, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { readLiveMembership } from '@/lib/company/company-access'
import { writeCompanySettings } from '@/lib/company/settings-writer'
import { createToolPgClient } from './client'

const log = { info() {}, warn() {}, error() {} } as never

async function company(): Promise<{ companyId: string; ownerId: string }> {
  const { userId: ownerId, companyId } = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, company_name) VALUES ($1, $2, 'Bolaget AB')
     ON CONFLICT (company_id) DO UPDATE SET company_name = 'Bolaget AB'`,
    [ownerId, companyId],
  )
  return { companyId, ownerId }
}

const archive = (companyId: string) =>
  getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [companyId])

const logoOf = async (companyId: string) =>
  (await getPool().query<{ logo_url: string | null }>(`SELECT logo_url FROM public.company_settings WHERE company_id = $1`, [companyId]))
    .rows[0]?.logo_url

describe('readLiveMembership', () => {
  const supabase: SupabaseClient = createToolPgClient()

  it('answers the role and the settings name of a live company', async () => {
    const { companyId, ownerId } = await company()
    await expect(readLiveMembership(supabase, ownerId, companyId)).resolves.toEqual({
      role: 'owner',
      companyName: 'Bolaget AB',
    })
  })

  it('reads an archived company as no membership, the row still being there', async () => {
    const { companyId, ownerId } = await company()
    await archive(companyId)

    await expect(readLiveMembership(supabase, ownerId, companyId)).resolves.toBeNull()
    const { rows } = await getPool().query(
      `SELECT 1 FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
      [companyId, ownerId],
    )
    expect(rows).toHaveLength(1)
  })

  it('reads a company the user never joined as no membership', async () => {
    const { companyId } = await company()
    await expect(readLiveMembership(supabase, randomUUID(), companyId)).resolves.toBeNull()
  })
})

describe('writeCompanySettings on a service-role client, where RLS holds nothing', () => {
  const supabase: SupabaseClient = createToolPgClient()
  const ctx = (companyId: string, userId: string) => ({ supabase, companyId, userId, log })

  it('writes for the owner and answers the row', async () => {
    const { companyId, ownerId } = await company()

    const outcome = await writeCompanySettings(ctx(companyId, ownerId), { logo_url: 'https://x/logo.png' })

    expect(outcome).toMatchObject({ ok: true, data: { logo_url: 'https://x/logo.png' } })
    expect(await logoOf(companyId)).toBe('https://x/logo.png')
  })

  it('refuses a member and leaves the row as it was', async () => {
    const { companyId } = await company()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const outcome = await writeCompanySettings(ctx(companyId, memberId), { logo_url: 'https://x/logo.png' })

    expect(outcome).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await logoOf(companyId)).toBeNull()
  })

  it('says so when there is no row to write', async () => {
    const { companyId, ownerId } = await company()
    await getPool().query(`DELETE FROM public.company_settings WHERE company_id = $1`, [companyId])

    const outcome = await writeCompanySettings(ctx(companyId, ownerId), { logo_url: 'https://x/logo.png' })

    expect(outcome).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })
})
