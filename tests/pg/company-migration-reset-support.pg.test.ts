import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Support-run migration reset past the self-service window (migration
 * 20261104012126).
 *
 * Locks in:
 *   - support_reset_company_for_migration is the service role's alone;
 *   - it resets a company older than 30 days with a closed year, which the
 *     owner's own reset refuses, archives the source and records the support
 *     case in the reset reason;
 *   - every other blocker stands (a live bank connection still refuses);
 *   - it needs the real owner and a case reference;
 *   - the lift is for that one company and that one call: the setting and
 *     claims are restored, and a setting naming another company lifts nothing.
 */

interface ResetResult {
  ok: boolean
  code?: string
  replacement_company_id?: string
  support_case?: string
  details?: { blockers: Array<{ code: string; count?: number }> }
}

async function oldClosedCompany() {
  const seeded = await seedCompany({ isClosed: true })
  await getPool().query(
    `UPDATE public.companies SET created_at = now() - interval '45 days' WHERE id = $1`,
    [seeded.companyId],
  )
  return seeded
}

async function supportReset(
  companyId: string,
  ownerId: string,
  overrides: Partial<{ caseRef: string; actor: string; name: string }> = {},
): Promise<ResetResult> {
  const { rows } = await getPool().query<{ result: ResetResult }>(
    `SELECT public.support_reset_company_for_migration($1, $2, $3, $4, $5, $6) AS result`,
    [
      companyId,
      ownerId,
      overrides.name ?? 'Test AB',
      overrides.caseRef ?? 'PH 242',
      overrides.actor ?? 'jakob',
      'The re-import shifted every voucher number, the customer starts over.',
    ],
  )
  return rows[0]!.result
}

describe('support migration reset (pg)', () => {
  it('is callable by the service role only', async () => {
    const sig = 'public.support_reset_company_for_migration(uuid,uuid,text,text,text,text)'
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service_role`,
      [sig],
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: true })
  })

  it('resets an old company with a closed year that the owner cannot reset', async () => {
    const { userId, companyId } = await oldClosedCompany()

    const own = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ result: ResetResult }>(
        `SELECT public.reset_company_for_migration($1, 'Test AB', 'The first migration used the wrong fiscal periods.', true, true) AS result`,
        [companyId],
      )
      return rows[0]!.result
    })
    expect(own.ok).toBe(false)
    expect(own.details?.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(['migration_window_expired', 'locked_or_closed_periods']),
    )

    const result = await supportReset(companyId, userId)
    expect(result).toMatchObject({ ok: true, support_case: 'PH 242' })

    const { rows: source } = await getPool().query(
      `SELECT archived_at IS NOT NULL AS archived, archived_by FROM public.companies WHERE id = $1`,
      [companyId],
    )
    expect(source[0]).toEqual({ archived: true, archived_by: userId })

    const { rows: log } = await getPool().query(
      `SELECT reason, replacement_company_id FROM public.company_migration_resets WHERE source_company_id = $1`,
      [companyId],
    )
    expect(log).toHaveLength(1)
    expect(log[0].reason).toMatch(/^Support \(PH 242, jakob\): /)
    expect(log[0].replacement_company_id).toBe(result.replacement_company_id)
  })

  it('keeps every other blocker: a live bank connection still refuses', async () => {
    const { userId, companyId } = await oldClosedCompany()
    await getPool().query(
      `INSERT INTO public.bank_connections (company_id, user_id, provider, bank_name, status)
       VALUES ($1, $2, 'enable_banking', 'Test Bank', 'active')`,
      [companyId, userId],
    )
    const result = await supportReset(companyId, userId)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('COMPANY_RESET_INELIGIBLE')
    const codes = result.details?.blockers.map((b) => b.code) ?? []
    expect(codes).toContain('live_bank_connections')
    expect(codes).not.toContain('migration_window_expired')
    expect(codes).not.toContain('locked_or_closed_periods')
  })

  it('needs the real owner and a case reference', async () => {
    const { userId, companyId } = await oldClosedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    expect(await supportReset(companyId, member)).toMatchObject({ ok: false, code: 'COMPANY_RESET_FORBIDDEN' })
    expect(await supportReset(companyId, userId, { caseRef: ' ' })).toMatchObject({
      ok: false,
      code: 'COMPANY_RESET_SUPPORT_CASE_REQUIRED',
    })
    expect(await supportReset(companyId, userId, { actor: '' })).toMatchObject({
      ok: false,
      code: 'COMPANY_RESET_SUPPORT_CASE_REQUIRED',
    })
    const { rows } = await getPool().query(
      `SELECT archived_at IS NULL AS live FROM public.companies WHERE id = $1`,
      [companyId],
    )
    expect(rows[0].live).toBe(true)
  })

  it('lifts nothing beyond its one company and its one call', async () => {
    const target = await oldClosedCompany()
    const other = await oldClosedCompany()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
      const reset = await client.query<{ result: ResetResult }>(
        `SELECT public.support_reset_company_for_migration($1, $2, 'Test AB', 'PH 248', 'jakob',
           'The customer wants to import the Fortnox books again from scratch.') AS result`,
        [target.companyId, target.userId],
      )
      expect(reset.rows[0]!.result.ok).toBe(true)

      const after = await client.query(
        `SELECT current_setting('app.migration_reset_support_company', true) AS support,
                current_setting('request.jwt.claims', true) AS claims`,
      )
      expect(after.rows[0].support).toBe('')
      expect(after.rows[0].claims).toBe('{"role":"service_role"}')

      const snapshot = await client.query<{ s: { blockers: Array<{ code: string }>; support_override: boolean } }>(
        `SELECT public.company_migration_reset_snapshot($1) AS s`,
        [other.companyId],
      )
      expect(snapshot.rows[0]!.s.support_override).toBe(false)
      expect(snapshot.rows[0]!.s.blockers.map((b) => b.code)).toContain('migration_window_expired')

      await client.query(`SELECT set_config('app.migration_reset_support_company', $1, true)`, [target.companyId])
      const named = await client.query<{ s: { blockers: Array<{ code: string }> } }>(
        `SELECT public.company_migration_reset_snapshot($1) AS s`,
        [other.companyId],
      )
      expect(named.rows[0]!.s.blockers.map((b) => b.code)).toContain('migration_window_expired')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
