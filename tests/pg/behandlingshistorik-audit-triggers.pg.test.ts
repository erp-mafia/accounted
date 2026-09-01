import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'
import { getPool, withUserContext } from './setup'

/**
 * Behandlingshistorik, part 3 (migration 20260901103000): the behandlingsregler
 * tables and the import logs write to the immutable audit_log, learning-only
 * updates on categorization_templates are filtered, the global payroll
 * constants are logged without a company, and app_releases is an append-only,
 * read-for-all, service-role-written version log.
 */

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

async function auditActions(table: string, recordId: string): Promise<string[]> {
  const res = await getPool().query<{ action: string }>(
    `SELECT action FROM public.audit_log
      WHERE table_name = $1 AND record_id = $2
      ORDER BY created_at, id`,
    [table, recordId],
  )
  return res.rows.map((r) => r.action)
}

describe('behandlingshistorik audit triggers (BFNAR 2013:2 p. 9.16)', () => {
  it('logs mapping_rules insert, update and delete with the company id', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const ruleId = randomUUID()
    await getPool().query(
      `INSERT INTO public.mapping_rules (id, user_id, company_id, rule_name, rule_type, debit_account, credit_account)
       VALUES ($1, $2, $3, 'Kontorsmaterial', 'merchant_name', '6110', '1930')`,
      [ruleId, userId, companyId],
    )
    await getPool().query(`UPDATE public.mapping_rules SET debit_account = '6540' WHERE id = $1`, [ruleId])
    await getPool().query(`DELETE FROM public.mapping_rules WHERE id = $1`, [ruleId])

    const rows = await getPool().query<{ action: string; company_id: string | null; old_debit: string | null; new_debit: string | null }>(
      `SELECT action, company_id, old_state->>'debit_account' AS old_debit, new_state->>'debit_account' AS new_debit
         FROM public.audit_log WHERE table_name = 'mapping_rules' AND record_id = $1
        ORDER BY created_at, id`,
      [ruleId],
    )
    expect(rows.rows).toEqual([
      { action: 'INSERT', company_id: companyId, old_debit: null, new_debit: '6110' },
      { action: 'UPDATE', company_id: companyId, old_debit: '6110', new_debit: '6540' },
      { action: 'DELETE', company_id: companyId, old_debit: '6540', new_debit: null },
    ])
  })

  it('logs categorization_templates rule changes but not learning-only updates', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const templateId = randomUUID()
    await getPool().query(
      `INSERT INTO public.categorization_templates (id, user_id, company_id, counterparty_name, debit_account, credit_account)
       VALUES ($1, $2, $3, 'Spotify AB', '6540', '1930')`,
      [templateId, userId, companyId],
    )
    // Learning on every booking: occurrence_count / confidence / last_seen_date.
    await getPool().query(
      `UPDATE public.categorization_templates
          SET occurrence_count = occurrence_count + 1, confidence = 0.9, last_seen_date = CURRENT_DATE
        WHERE id = $1`,
      [templateId],
    )
    expect(await auditActions('categorization_templates', templateId)).toEqual(['INSERT'])

    // A rule change (the account) is logged.
    await getPool().query(`UPDATE public.categorization_templates SET debit_account = '6212' WHERE id = $1`, [templateId])
    expect(await auditActions('categorization_templates', templateId)).toEqual(['INSERT', 'UPDATE'])

    await getPool().query(`DELETE FROM public.categorization_templates WHERE id = $1`, [templateId])
    expect(await auditActions('categorization_templates', templateId)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
  })

  it('logs booking_template_library changes (no user_id column: actor falls back to auth.uid())', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    // btl_insert requires current_user_can_write() and company_id =
    // current_active_company_id(), so the membership and the active-company
    // preference both have to exist before the authenticated insert.
    await insertCompanyMember({ companyId, userId })
    await setActiveCompany(userId, companyId)
    const templateId = randomUUID()
    // Asserted INSIDE the user transaction: withUserContext always rolls back,
    // so the audit row the trigger writes is gone by the time an outside
    // connection could look for it. The row is what is under test, not its
    // persistence, and the trigger fires in the same transaction as the write.
    const rows = await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.booking_template_library (id, company_id, created_by, name, lines)
         VALUES ($1, $2, $3, 'Hyra', '[{"account":"5010","side":"debit"}]'::jsonb)`,
        [templateId, companyId, userId],
      )
      const audit = await client.query<{ action: string; company_id: string | null; user_id: string | null }>(
        `SELECT action, company_id, user_id FROM public.audit_log
          WHERE table_name = 'booking_template_library' AND record_id = $1`,
        [templateId],
      )
      return audit.rows
    })
    // booking_template_library has no user_id column, so write_audit_log()
    // falls back to auth.uid(): the actor is the authenticated writer.
    expect(rows).toEqual([{ action: 'INSERT', company_id: companyId, user_id: userId }])
  })

  it('logs the global payroll constants without a company (read via service role by the report)', async () => {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_payroll_config (
         id, config_year, avgifter_total, avgifter_alderspension, avgifter_sjukforsakring,
         avgifter_foraldraforsakring, avgifter_efterlevandepension, avgifter_arbetsmarknad,
         avgifter_arbetsskada, avgifter_allman_loneavgift, avgifter_reduced_65plus,
         avgifter_minimum_annual, egenavgifter_total, slp_rate, prisbasbelopp, inkomstbasbelopp,
         max_pgi, sgi_ceiling, statlig_skatt_brytpunkt, traktamente_heldag, traktamente_halvdag,
         traktamente_natt, milersattning_egen_bil, milersattning_formansbil_fossil,
         milersattning_formansbil_el, kostforman_heldag, kostforman_lunch, kostforman_frukost,
         friskvard_cap, bilforman_slr, reduced_avgift_age
       ) VALUES (
         $1, 2099, 0.3142, 0.1021, 0.0355, 0.026, 0.006, 0.0264, 0.002, 0.1162, 0.1021,
         1000, 0.2897, 0.2426, 60000, 85000, 600000, 500000, 650000, 290, 145, 145, 25, 12, 9.5,
         110, 55, 55, 5000, 0.0196, 66
       )`,
      [id],
    )
    await getPool().query(`UPDATE public.salary_payroll_config SET prisbasbelopp = 61000 WHERE id = $1`, [id])
    const rows = await getPool().query<{ action: string; company_id: string | null; new_pbb: string | null }>(
      `SELECT action, company_id, new_state->>'prisbasbelopp' AS new_pbb FROM public.audit_log
        WHERE table_name = 'salary_payroll_config' AND record_id = $1 ORDER BY created_at, id`,
      [id],
    )
    expect(rows.rows.map((r) => [r.action, r.company_id])).toEqual([
      ['INSERT', null],
      ['UPDATE', null],
    ])
    expect(Number(rows.rows[1].new_pbb)).toBe(61000)
    await getPool().query(`DELETE FROM public.salary_payroll_config WHERE id = $1`, [id])
  })

  it('logs sie_imports and bank_file_imports rows incl. the undo status change', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const sieId = randomUUID()
    const bankId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports (id, user_id, company_id, filename, file_hash, sie_type, status)
       VALUES ($1, $2, $3, 'bokio.se', $4, 4, 'completed')`,
      [sieId, userId, companyId, randomUUID()],
    )
    await getPool().query(
      `UPDATE public.sie_imports SET status = 'undone', replaced_at = now() WHERE id = $1`,
      [sieId],
    )
    await getPool().query(
      `INSERT INTO public.bank_file_imports (id, user_id, company_id, filename, file_hash, file_format)
       VALUES ($1, $2, $3, 'seb.csv', $4, 'seb')`,
      [bankId, userId, companyId, randomUUID()],
    )
    const sie = await getPool().query<{ action: string; new_status: string | null }>(
      `SELECT action, new_state->>'status' AS new_status FROM public.audit_log
        WHERE table_name = 'sie_imports' AND record_id = $1 ORDER BY created_at, id`,
      [sieId],
    )
    expect(sie.rows).toEqual([
      { action: 'INSERT', new_status: 'completed' },
      { action: 'UPDATE', new_status: 'undone' },
    ])
    expect(await auditActions('bank_file_imports', bankId)).toEqual(['INSERT'])
  })

  it('app_releases: readable by any signed-in user, writable only by the service role, immutable', async () => {
    const userId = await insertAuthUser()
    const version = `test-${randomUUID().slice(0, 8)}`
    await getPool().query(`INSERT INTO public.app_releases (version) VALUES ($1)`, [version])

    const seen = await withUserContext(userId, async (client) => {
      const res = await client.query<{ version: string }>(
        `SELECT version FROM public.app_releases WHERE version = $1`,
        [version],
      )
      return res.rows.map((r) => r.version)
    })
    expect(seen).toEqual([version])

    await expect(
      withUserContext(userId, (client) =>
        client.query(`INSERT INTO public.app_releases (version) VALUES ($1)`, [`${version}-user`]),
      ),
    ).rejects.toThrow(/row-level security/i)

    await expect(
      getPool().query(`UPDATE public.app_releases SET source = 'edited' WHERE version = $1`, [version]),
    ).rejects.toThrow()
    await expect(
      getPool().query(`DELETE FROM public.app_releases WHERE version = $1`, [version]),
    ).rejects.toThrow()
  })
})
