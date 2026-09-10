import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser } from './fixtures'

/**
 * Migration 20260908120000: counterparty_profiles.
 *
 * Company-scoped through user_company_ids(); one live profile per company
 * and counterparty key, with superseded rows kept as history; the vocabulary
 * for source_kind and confidence is enforced.
 */
const profile = { name: 'Higgsfield Inc.', country: 'US', kind: 'company', sells: 'AI-videogenerering', industry: null, typical_account: '5420', recurrence: 'monthly', vat_posture: 'reverse_charge_non_eu' }

describe('counterparty_profiles (pg)', () => {
  it('is visible to the company and invisible to a stranger', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.counterparty_profiles (company_id, user_id, counterparty_key, ledger_key, source_kind, model, confidence, profile, evidence)
       VALUES ($1, $2, 'higgsfield inc', 'higgsfield inc', 'document', 'test-model', 'high', $3, '[{"field":"country","quote":"United States"}]')`,
      [companyId, userId, JSON.stringify(profile)],
    )
    const own = await withUserContext(userId, (client) =>
      client.query(`SELECT profile->>'country' AS country FROM public.counterparty_profiles WHERE company_id = $1`, [companyId]),
    )
    expect(own.rows).toHaveLength(1)
    expect(own.rows[0].country).toBe('US')

    const stranger = await insertAuthUser()
    const other = await withUserContext(stranger, (client) =>
      client.query(`SELECT count(*)::int AS n FROM public.counterparty_profiles WHERE company_id = $1`, [companyId]),
    )
    expect(other.rows[0].n).toBe(0)
  })

  it('allows one live profile per key, and a superseded one beside it', async () => {
    const { userId, companyId } = await seedCompany()
    const insert = `INSERT INTO public.counterparty_profiles (company_id, user_id, counterparty_key, source_kind, model, confidence, profile)
                    VALUES ($1, $2, 'openai', 'bank_text', 'test-model', 'medium', $3)`
    await getPool().query(insert, [companyId, userId, JSON.stringify(profile)])
    await expect(getPool().query(insert, [companyId, userId, JSON.stringify(profile)])).rejects.toThrow(/duplicate key/)
    await getPool().query(`UPDATE public.counterparty_profiles SET superseded_at = now() WHERE company_id = $1 AND counterparty_key = 'openai'`, [companyId])
    await expect(getPool().query(insert, [companyId, userId, JSON.stringify(profile)])).resolves.toBeDefined()
  })

  it('rejects a source or confidence outside the vocabulary', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.counterparty_profiles (company_id, user_id, counterparty_key, source_kind, model, confidence, profile)
         VALUES ($1, $2, 'x', 'guess', 'test-model', 'high', '{}')`,
        [companyId, userId],
      ),
    ).rejects.toThrow(/check constraint/)
  })
})
