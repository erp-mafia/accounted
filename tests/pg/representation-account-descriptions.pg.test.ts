import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20261023011000_representation_account_descriptions.sql
 * (accounted#92): charts seeded before !765 keep the old 6072, 7631 and 7632
 * descriptions; the migration gives them today's BAS reference text.
 *
 *  - a description that is still the exact old seed text becomes the new one,
 *    on a renamed account too, and the name stays
 *  - an edited description, a NULL one and other accounts stay
 *  - a migration-reset source company is skipped
 *  - one audit row per changed account, as the system and this migration
 *  - idempotent: a second run changes nothing
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261023011000_representation_account_descriptions.sql'),
  'utf8',
)

const OLD_TEXT: Record<string, string> = {
  '6072': 'Representation som överstiger avdragsgilla beloppet. Inte skattemässigt avdragsgill.',
  '7631': 'Avdragsgill intern representation, t.ex. personalfester och jullunch.',
  '7632': 'Personalrepresentation, ej avdragsgill',
}
const newText = (account: string) => getBASReference(account)!.description

async function runMigration(): Promise<void> {
  await getPool().query(MIGRATION_SQL)
}

async function insertAccount(params: {
  userId: string
  companyId: string
  number: string
  name?: string
  description: string | null
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_group,
        account_type, normal_balance, plan_type, is_system_account, description)
     VALUES ($1, $2, $3, $4, $5, $6, 'expense', 'debit', 'full_bas', false, $7)
     RETURNING id`,
    [
      params.userId,
      params.companyId,
      params.number,
      params.name ?? `Konto ${params.number}`,
      Number(params.number[0]),
      params.number.slice(0, 2),
      params.description,
    ],
  )
  return rows[0].id
}

async function readAccount(id: string): Promise<{ account_name: string; description: string | null; updated_at: Date }> {
  const { rows } = await getPool().query(
    `SELECT account_name, description, updated_at FROM public.chart_of_accounts WHERE id = $1`,
    [id],
  )
  return rows[0]
}

describe('representation_account_descriptions', () => {
  it('replaces the untouched old seed text with the BAS text and keeps the name', async () => {
    const { userId, companyId } = await seedCompany()
    const ids: Record<string, string> = {}
    for (const number of Object.keys(OLD_TEXT)) {
      ids[number] = await insertAccount({
        userId,
        companyId,
        number,
        name: `Eget namn ${number}`,
        description: OLD_TEXT[number],
      })
    }

    await runMigration()

    for (const number of Object.keys(OLD_TEXT)) {
      const after = await readAccount(ids[number])
      expect(after.description, number).toBe(newText(number))
      expect(after.account_name, number).toBe(`Eget namn ${number}`)
    }
  })

  it('leaves an edited description, a NULL one and other accounts alone', async () => {
    const { userId, companyId } = await seedCompany()
    const edited = await insertAccount({ userId, companyId, number: '6072', description: 'Kundmiddagar, egen text' })
    const blank = await insertAccount({ userId, companyId, number: '7631', description: null })
    // The old 6072 text on another account is not this migration's business.
    const other = await insertAccount({ userId, companyId, number: '6071', description: OLD_TEXT['6072'] })

    await runMigration()

    expect((await readAccount(edited)).description).toBe('Kundmiddagar, egen text')
    expect((await readAccount(blank)).description).toBeNull()
    expect((await readAccount(other)).description).toBe(OLD_TEXT['6072'])
  })

  it('skips a migration-reset source company', async () => {
    const source = await seedCompany()
    const replacement = await seedCompany()
    const id = await insertAccount({ ...source, number: '6072', description: OLD_TEXT['6072'] })
    await getPool().query(
      `INSERT INTO public.company_migration_resets
         (source_company_id, replacement_company_id, actor_id, reason,
          confirmation_snapshot, source_counts)
       VALUES ($1, $2, $3, 'pg test: archived by a migration reset', '{}'::jsonb, '{}'::jsonb)`,
      [source.companyId, replacement.companyId, source.userId],
    )

    await runMigration()

    expect((await readAccount(id)).description).toBe(OLD_TEXT['6072'])
  })

  it('audits each change as the system and is a no-op on re-run', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertAccount({ userId, companyId, number: '7631', description: OLD_TEXT['7631'] })
    const pool = getPool()
    const updateAudits = async () =>
      (
        await pool.query<{ actor_type: string; actor_label: string | null; company_id: string; old_desc: string; new_desc: string }>(
          `SELECT actor_type, actor_label, company_id,
                  old_state->>'description' AS old_desc, new_state->>'description' AS new_desc
             FROM public.audit_log
            WHERE table_name = 'chart_of_accounts' AND record_id = $1 AND action = 'UPDATE'`,
          [id],
        )
      ).rows

    expect(await updateAudits()).toHaveLength(0)
    await runMigration()
    const audits = await updateAudits()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actor_type: 'system',
      actor_label: 'migration 20261023011000 representation_account_descriptions',
      company_id: companyId,
      old_desc: OLD_TEXT['7631'],
      new_desc: newText('7631'),
    })

    const first = await readAccount(id)
    await runMigration()
    const second = await readAccount(id)
    expect(second.updated_at.toISOString()).toBe(first.updated_at.toISOString())
    expect(await updateAudits()).toHaveLength(1)
  })
})
