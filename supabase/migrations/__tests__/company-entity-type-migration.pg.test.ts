import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * 20260915160300_company_entity_type_migrations.sql: an owner migrates a
 * company WITH posted history to another legal form in two guarded steps.
 * The RPC flips the form, adds the target form's missing seeded accounts
 * and records the plan; it never posts a verifikat and never deletes an
 * account. A stale plan (decision accounts moved since planning) is refused.
 */

async function seededCompany(entityType: 'aktiebolag' | 'ekonomisk_forening' | 'ideell_forening' = 'aktiebolag') {
  const ownerId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId, entityType, name: 'Growhub' })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, entityType])
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, user_id, company_name, entity_type)
     VALUES ($1, $2, 'Growhub', $3)
     ON CONFLICT (company_id) DO UPDATE SET entity_type = EXCLUDED.entity_type`,
    [companyId, ownerId, entityType],
  )
  const fiscalPeriodId = await insertFiscalPeriod({
    userId: ownerId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  return { ownerId, companyId, fiscalPeriodId }
}

/** Posted share capital: Dr 1930 / Cr 2081, the classic decision account. */
async function postShareCapital(params: { ownerId: string; companyId: string; fiscalPeriodId: string; amount?: number }) {
  const amount = params.amount ?? 25_000
  return insertPostedJournalEntry({
    userId: params.ownerId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    entryDate: '2026-01-02',
    description: 'Aktiekapital',
    lines: [
      { accountNumber: '1930', debitAmount: amount, creditAmount: 0 },
      { accountNumber: '2081', debitAmount: 0, creditAmount: amount },
    ],
  })
}

type Client = Parameters<Parameters<typeof withUserContext>[1]>[0]

/** withUserContext rolls back at the end, so every scenario runs its steps
 * and reads its state on the same client. The planned row is inserted by the
 * pool (committed) because the RPC reads it in its own session. */
async function preview(client: Client, companyId: string, target: string): Promise<Record<string, unknown>> {
  const res = await client.query<{ result: Record<string, unknown> }>(
    `SELECT public.preview_company_entity_type_change($1::uuid, $2::text) AS result`,
    [companyId, target],
  )
  return res.rows[0].result
}

async function plan(userId: string, companyId: string, target: string, snapshot: Record<string, unknown>) {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.company_entity_type_migrations
       (company_id, user_id, from_entity_type, to_entity_type, preview, remap_plan, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, '[]'::jsonb, 'planned')
     RETURNING id`,
    [companyId, userId, snapshot.current_entity_type, target, JSON.stringify(snapshot)],
  )
  return res.rows[0].id
}

async function apply(client: Client, migrationId: string, remapPlan: unknown[]) {
  const res = await client.query<{ result: Record<string, unknown> }>(
    `SELECT public.apply_company_entity_type_migration($1::uuid, $2::jsonb) AS result`,
    [migrationId, JSON.stringify(remapPlan)],
  )
  return res.rows[0].result
}

async function rollback(client: Client, migrationId: string) {
  const res = await client.query<{ result: Record<string, unknown> }>(
    `SELECT public.rollback_company_entity_type_migration($1::uuid) AS result`,
    [migrationId],
  )
  return res.rows[0].result
}

async function state(client: Client, companyId: string, migrationId: string) {
  const company = await client.query<{ entity_type: string; settings_type: string | null }>(
    `SELECT c.entity_type, s.entity_type AS settings_type
       FROM public.companies c LEFT JOIN public.company_settings s ON s.company_id = c.id
      WHERE c.id = $1`,
    [companyId],
  )
  const accounts = await client.query<{ account_number: string; is_system_account: boolean; account_name: string }>(
    `SELECT account_number, is_system_account, account_name FROM public.chart_of_accounts WHERE company_id = $1 ORDER BY account_number`,
    [companyId],
  )
  const migration = await client.query<{ status: string; applied_by: string | null; remap_plan: unknown[] }>(
    `SELECT status, applied_by, remap_plan FROM public.company_entity_type_migrations WHERE id = $1`,
    [migrationId],
  )
  const entries = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM public.journal_entries WHERE company_id = $1`,
    [companyId],
  )
  return {
    company: company.rows[0],
    accounts: accounts.rows,
    migration: migration.rows[0],
    journalEntries: Number(entries.rows[0].n),
  }
}

const CONFIRM_2081 = [{ account_from: '2081', account_to: '2083', amount: 25_000, decision: 'confirmed', reason: 'insatser' }]

describe('apply_company_entity_type_migration: posted history', () => {
  it('flips the form, adds the missing association accounts, keeps every existing account and posts nothing', async () => {
    const { ownerId, companyId, fiscalPeriodId } = await seededCompany('aktiebolag')
    await postShareCapital({ ownerId, companyId, fiscalPeriodId })
    // A user-created account must survive untouched.
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
       VALUES ($1, $2, '1931', 'Extra bankkonto', 1, '19', 'asset', 'debit', 'k1', false)`,
      [ownerId, companyId],
    )
    const snapshot = await withUserContext(ownerId, (client) => preview(client, companyId, 'ekonomisk_forening'))
    expect(snapshot).toMatchObject({ ok: true, empty_books_path_available: false })
    expect(snapshot.decision_accounts).toEqual([{ account: '2081', balance: 25_000 }])
    const migrationId = await plan(ownerId, companyId, 'ekonomisk_forening', snapshot)

    await withUserContext(ownerId, async (client) => {
      const result = await apply(client, migrationId, CONFIRM_2081)
      expect(result).toMatchObject({ ok: true, previous_entity_type: 'aktiebolag', entity_type: 'ekonomisk_forening' })
      expect(Number(result.added_accounts)).toBeGreaterThan(0)

      const after = await state(client, companyId, migrationId)
      expect(after.company).toEqual({ entity_type: 'ekonomisk_forening', settings_type: 'ekonomisk_forening' })
      const numbers = after.accounts.map((a) => a.account_number)
      expect(numbers).toEqual(expect.arrayContaining(['2081', '2893', '1931', '2083', '2084', '2086', '2890', '3901']))
      expect(after.accounts.find((a) => a.account_number === '1931')).toMatchObject({ is_system_account: false, account_name: 'Extra bankkonto' })
      // 2091/2099 existed in the AB seed and are not duplicated (unique per company).
      expect(numbers.filter((n) => n === '2091')).toHaveLength(1)
      expect(after.migration).toMatchObject({ status: 'applied', applied_by: ownerId })
      expect(after.migration.remap_plan).toEqual(CONFIRM_2081)
      // The RPC never posts: the reclassification is the application's job.
      expect(after.journalEntries).toBe(1)

      const audit = await client.query<{ new_state: Record<string, unknown> }>(
        `SELECT new_state FROM public.audit_log WHERE company_id = $1 AND table_name = 'companies' ORDER BY created_at DESC LIMIT 1`,
        [companyId],
      )
      expect(audit.rows[0].new_state).toMatchObject({ entity_type: 'ekonomisk_forening', migration_id: migrationId })
    })
  })

  it('refuses a non-owner and an outsider', async () => {
    const { ownerId, companyId, fiscalPeriodId } = await seededCompany('aktiebolag')
    await postShareCapital({ ownerId, companyId, fiscalPeriodId })
    const snapshot = await withUserContext(ownerId, (client) => preview(client, companyId, 'ekonomisk_forening'))
    const migrationId = await plan(ownerId, companyId, 'ekonomisk_forening', snapshot)

    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
    await withUserContext(adminId, async (client) => {
      expect(await apply(client, migrationId, CONFIRM_2081)).toMatchObject({ ok: false, code: 'ENTITY_TYPE_MIGRATION_FORBIDDEN' })
      const after = await state(client, companyId, migrationId)
      expect(after.company.entity_type).toBe('aktiebolag')
      expect(after.migration.status).toBe('planned')
    })

    const outsiderId = await insertAuthUser()
    await withUserContext(outsiderId, async (client) => {
      expect(await apply(client, migrationId, CONFIRM_2081)).toMatchObject({ ok: false, code: 'ENTITY_TYPE_MIGRATION_NOT_FOUND' })
    })
  })

  it('refuses a stale plan when a decision account moved since planning', async () => {
    const { ownerId, companyId, fiscalPeriodId } = await seededCompany('aktiebolag')
    await postShareCapital({ ownerId, companyId, fiscalPeriodId })
    const snapshot = await withUserContext(ownerId, (client) => preview(client, companyId, 'ekonomisk_forening'))
    const migrationId = await plan(ownerId, companyId, 'ekonomisk_forening', snapshot)

    // A nyemission lands between planning and applying.
    await postShareCapital({ ownerId, companyId, fiscalPeriodId, amount: 5_000 })

    await withUserContext(ownerId, async (client) => {
      const result = await apply(client, migrationId, CONFIRM_2081)
      expect(result).toMatchObject({ ok: false, code: 'ENTITY_TYPE_MIGRATION_STALE', reason: 'decision_accounts' })
      expect(result.decision_accounts).toEqual([{ account: '2081', balance: 30_000 }])
      const after = await state(client, companyId, migrationId)
      expect(after.company.entity_type).toBe('aktiebolag')
      expect(after.migration.status).toBe('planned')
      expect(after.accounts.map((a) => a.account_number)).not.toContain('2083')
    })
  })

  it('refuses a remap that points outside the decision accounts and a second apply', async () => {
    const { ownerId, companyId, fiscalPeriodId } = await seededCompany('aktiebolag')
    await postShareCapital({ ownerId, companyId, fiscalPeriodId })
    const snapshot = await withUserContext(ownerId, (client) => preview(client, companyId, 'ekonomisk_forening'))
    const migrationId = await plan(ownerId, companyId, 'ekonomisk_forening', snapshot)

    await withUserContext(ownerId, async (client) => {
      expect(
        await apply(client, migrationId, [{ account_from: '1930', account_to: '1940', amount: 1, decision: 'confirmed' }]),
      ).toMatchObject({ ok: false, code: 'ENTITY_TYPE_MIGRATION_INVALID_PLAN', account: '1930' })
      expect(await apply(client, migrationId, [{ account_from: '2081', account_to: '2083', decision: 'later' }])).toMatchObject({
        ok: false,
        code: 'ENTITY_TYPE_MIGRATION_INVALID_PLAN',
      })

      expect(await apply(client, migrationId, CONFIRM_2081)).toMatchObject({ ok: true })
      expect(await apply(client, migrationId, CONFIRM_2081)).toMatchObject({
        ok: false,
        code: 'ENTITY_TYPE_MIGRATION_NOT_PLANNED',
        status: 'applied',
      })
    })
  })

  it('rolls back once the reclassification is reversed, keeping the added accounts', async () => {
    const { ownerId, companyId, fiscalPeriodId } = await seededCompany('aktiebolag')
    await postShareCapital({ ownerId, companyId, fiscalPeriodId })
    const snapshot = await withUserContext(ownerId, (client) => preview(client, companyId, 'ekonomisk_forening'))
    const migrationId = await plan(ownerId, companyId, 'ekonomisk_forening', snapshot)
    // Stand-ins for the verifikat the application books through the engine.
    const reclassId = await insertPostedJournalEntry({
      userId: ownerId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-09-15',
      sourceType: 'system',
      sourceId: migrationId,
      lines: [
        { accountNumber: '2081', debitAmount: 25_000, creditAmount: 0 },
        { accountNumber: '2083', debitAmount: 0, creditAmount: 25_000 },
      ],
    })
    const stornoId = await insertPostedJournalEntry({
      userId: ownerId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-09-16',
      sourceType: 'storno',
      lines: [
        { accountNumber: '2083', debitAmount: 25_000, creditAmount: 0 },
        { accountNumber: '2081', debitAmount: 0, creditAmount: 25_000 },
      ],
    })
    // Those two postings changed the 2081 balance to zero and 2083 to zero:
    // re-snapshot so the plan is not stale.
    const fresh = await withUserContext(ownerId, (client) => preview(client, companyId, 'ekonomisk_forening'))
    await getPool().query(`UPDATE public.company_entity_type_migrations SET preview = $2::jsonb WHERE id = $1`, [
      migrationId,
      JSON.stringify(fresh),
    ])

    await withUserContext(ownerId, async (client) => {
      expect(await rollback(client, migrationId)).toMatchObject({ ok: false, code: 'ENTITY_TYPE_MIGRATION_NOT_APPLIED', status: 'planned' })
      expect(await apply(client, migrationId, [])).toMatchObject({ ok: true })

      // The application links the reclassification (column-level grant).
      await client.query(
        `UPDATE public.company_entity_type_migrations SET reclassification_journal_entry_id = $2 WHERE id = $1`,
        [migrationId, reclassId],
      )
      // Rollback before the storno is linked: refused.
      expect(await rollback(client, migrationId)).toMatchObject({
        ok: false,
        code: 'ENTITY_TYPE_MIGRATION_RECLASSIFICATION_NOT_REVERSED',
      })
      await client.query(
        `UPDATE public.company_entity_type_migrations SET rollback_journal_entry_id = $2 WHERE id = $1`,
        [migrationId, stornoId],
      )
      expect(await rollback(client, migrationId)).toMatchObject({ ok: true, entity_type: 'aktiebolag' })

      const after = await state(client, companyId, migrationId)
      expect(after.company).toEqual({ entity_type: 'aktiebolag', settings_type: 'aktiebolag' })
      expect(after.migration.status).toBe('rolled_back')
      expect(after.accounts.map((a) => a.account_number)).toContain('2083')
      expect(await rollback(client, migrationId)).toMatchObject({ ok: false, code: 'ENTITY_TYPE_MIGRATION_NOT_APPLIED' })
    })
  })
})

describe('company_entity_type_migrations: row-level security', () => {
  it("hides another company's migrations, refuses delete and limits update to the verifikat links", async () => {
    const { ownerId, companyId, fiscalPeriodId } = await seededCompany('aktiebolag')
    await postShareCapital({ ownerId, companyId, fiscalPeriodId })
    const snapshot = await withUserContext(ownerId, (client) => preview(client, companyId, 'ekonomisk_forening'))
    const migrationId = await plan(ownerId, companyId, 'ekonomisk_forening', snapshot)

    const other = await seededCompany('aktiebolag')
    const visible = await withUserContext(other.ownerId, async (client) => {
      const res = await client.query(`SELECT id FROM public.company_entity_type_migrations WHERE id = $1`, [migrationId])
      return res.rowCount
    })
    expect(visible).toBe(0)

    await expect(
      withUserContext(ownerId, async (client) => {
        await client.query(`DELETE FROM public.company_entity_type_migrations WHERE id = $1`, [migrationId])
      }),
    ).rejects.toThrow(/permission denied/)

    await expect(
      withUserContext(ownerId, async (client) => {
        await client.query(`UPDATE public.company_entity_type_migrations SET status = 'applied' WHERE id = $1`, [migrationId])
      }),
    ).rejects.toThrow(/permission denied/)

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    await expect(
      withUserContext(viewerId, async (client) => {
        await client.query(
          `INSERT INTO public.company_entity_type_migrations (company_id, user_id, from_entity_type, to_entity_type, preview)
           VALUES ($1, $2, 'aktiebolag', 'ekonomisk_forening', '{}'::jsonb)`,
          [companyId, viewerId],
        )
      }),
    ).rejects.toThrow(/row-level security/)
  })
})
