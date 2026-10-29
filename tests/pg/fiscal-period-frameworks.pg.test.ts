import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from './fixtures'
import { ENTITY_TYPES, supportsAccountingFramework } from '@/lib/company/entity-type'
import type { EntityType } from '@/types'

// The K2/K3 framework per räkenskapsår (migration 20261030040201,
// BFNAR 2012:4). The framework lives in its own table so closed and locked
// years keep their value without any write to fiscal_periods; every change
// goes through set_fiscal_period_framework, which refuses closed or locked
// years and years with a locked årsredovisning, and applies the K3 to K2 rules.

interface Seed {
  ownerId: string
  companyId: string
}

async function seedCompany(framework: 'k2' | 'k3' = 'k2', entityType: EntityType = 'aktiebolag'): Promise<Seed> {
  const ownerId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId, entityType })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  await getPool().query(`UPDATE public.companies SET accounting_framework = $2 WHERE id = $1`, [companyId, framework])
  return { ownerId, companyId }
}

async function year(seed: Seed, y: number, opts: { isClosed?: boolean } = {}): Promise<string> {
  return insertFiscalPeriod({
    userId: seed.ownerId,
    companyId: seed.companyId,
    name: String(y),
    periodStart: `${y}-01-01`,
    periodEnd: `${y}-12-31`,
    isClosed: opts.isClosed,
  })
}

async function lockedVersion(seed: Seed, fiscalPeriodId: string, framework: 'k2' | 'k3', status = 'signed', versionNumber = 1) {
  await getPool().query(
    `INSERT INTO public.annual_report_versions
       (company_id, fiscal_period_id, user_id, version_number, schema_version, framework,
        status, report_data, content_hash, validation_summary, finalized_at, finalized_by)
     VALUES ($1, $2, $3, $4, '1.0', $5, $6, '{}'::jsonb, $7, '{}'::jsonb,
             CASE WHEN $6 = 'draft' THEN NULL ELSE now() END,
             CASE WHEN $6 = 'draft' THEN NULL ELSE $3::uuid END)`,
    [seed.companyId, fiscalPeriodId, seed.ownerId, versionNumber, framework, status, String(versionNumber).repeat(64).slice(0, 64)],
  )
}

/**
 * The year's row. Inside withUserContext pass its client: that transaction
 * always rolls back, so its writes are visible only to its own connection.
 */
async function frameworkRow(fiscalPeriodId: string, client: Pick<PoolClient, 'query'> = getPool()) {
  const { rows } = await client.query(
    `SELECT framework, source, previous_framework, change_reason, previously_applied_k2, special_reasons_confirmed,
            stated_previous_year_framework, user_id
       FROM public.fiscal_period_frameworks WHERE fiscal_period_id = $1`,
    [fiscalPeriodId],
  )
  return rows[0] ?? null
}

interface SetArgs {
  framework: 'k2' | 'k3'
  reason?: string | null
  previouslyAppliedK2?: boolean | null
  specialReasons?: boolean | null
  dryRun?: boolean
  previousYear?: 'k2' | 'k3' | 'none' | null
}

async function setFramework(client: PoolClient, seed: Seed, fiscalPeriodId: string, args: SetArgs) {
  const { rows } = await client.query(
    `SELECT public.set_fiscal_period_framework($1, $2, $3, $4, $5, $6, NULL, $7, $8) AS result`,
    [
      seed.companyId,
      fiscalPeriodId,
      args.framework,
      args.reason ?? null,
      args.previouslyAppliedK2 ?? null,
      args.specialReasons ?? null,
      args.dryRun ?? false,
      args.previousYear ?? null,
    ],
  )
  return rows[0].result as Record<string, unknown>
}

describe('fiscal_period_frameworks', () => {
  it('seeds a new year from the company default, and the next year from the year before', async () => {
    const seed = await seedCompany('k3')
    const y2025 = await year(seed, 2025)
    expect(await frameworkRow(y2025)).toMatchObject({ framework: 'k3', source: 'company_default' })
    // The company default changing later does not touch the year, and the
    // next year follows the year before it, not the company column.
    await getPool().query(`UPDATE public.companies SET accounting_framework = 'k2' WHERE id = $1`, [seed.companyId])
    const y2026 = await year(seed, 2026)
    expect(await frameworkRow(y2025)).toMatchObject({ framework: 'k3' })
    // It follows a year that is only a default, so it is only a default too:
    // the doubt is not laundered into previous_year.
    expect(await frameworkRow(y2026)).toMatchObject({ framework: 'k3', source: 'company_default' })
    // After an election, the next year follows a reliable year. The service
    // role commits (withUserContext rolls back), so 2027 sees the election.
    await runAsServiceRole(async (client) => {
      const { rows } = await client.query(
        `SELECT public.set_fiscal_period_framework($1, $2, 'k3', NULL, NULL, NULL, $3, false) AS result`,
        [seed.companyId, y2026, seed.ownerId],
      )
      expect(rows[0].result).toMatchObject({ ok: true })
    })
    expect(await frameworkRow(y2026)).toMatchObject({ framework: 'k3', source: 'election' })
    const y2027 = await year(seed, 2027)
    expect(await frameworkRow(y2027)).toMatchObject({ framework: 'k3', source: 'previous_year' })
  })

  it('backfills a year with a locked årsredovisning from that version, and any other year as a company default', async () => {
    const seed = await seedCompany('k3')
    const signed = await year(seed, 2024, { isClosed: true })
    const draftOnly = await year(seed, 2025, { isClosed: true })
    await lockedVersion(seed, signed, 'k2', 'signed', 1)
    await lockedVersion(seed, signed, 'k3', 'superseded', 2)
    await lockedVersion(seed, draftOnly, 'k2', 'draft', 1)
    const evidence = async (id: string) =>
      (await getPool().query(`SELECT framework, source FROM public.fiscal_period_framework_evidence($1)`, [id])).rows[0]
    // The latest version past draft (a superseded one is not) decides: the
    // year was signed under K2 although the company setting says K3 today.
    expect(await evidence(signed)).toEqual({ framework: 'k2', source: 'annual_report' })
    expect(await evidence(draftOnly)).toEqual({ framework: 'k3', source: 'company_default' })
    // Not callable through the API.
    await withUserContext(seed.ownerId, async (client) => {
      await expect(
        client.query(`SELECT * FROM public.fiscal_period_framework_evidence($1)`, [signed]),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('members read the rows; nobody writes them except through the RPC', async () => {
    const seed = await seedCompany()
    const y2026 = await year(seed, 2026)
    await withUserContext(seed.ownerId, async (client) => {
      const { rows } = await client.query(`SELECT framework FROM public.fiscal_period_frameworks WHERE fiscal_period_id = $1`, [y2026])
      expect(rows).toEqual([{ framework: 'k2' }])
      await expect(
        client.query(`UPDATE public.fiscal_period_frameworks SET framework = 'k3' WHERE fiscal_period_id = $1`, [y2026]),
      ).rejects.toMatchObject({ code: '42501' })
    })
    const outsider = await insertAuthUser()
    await withUserContext(outsider, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM public.fiscal_period_frameworks WHERE fiscal_period_id = $1`, [y2026])
      expect(rows).toEqual([])
    })
  })

  it('switches an open year to K3, cascades to the years that followed it and moves the company default', async () => {
    const seed = await seedCompany('k2')
    const y2025 = await year(seed, 2025, { isClosed: true })
    const y2026 = await year(seed, 2026)
    const y2027 = await year(seed, 2027)
    await withUserContext(seed.ownerId, async (client) => {
      const result = await setFramework(client, seed, y2026, { framework: 'k3' })
      expect(result).toMatchObject({ ok: true, changed: true, framework: 'k3', previous_framework: 'k2', company_framework: 'k3' })
      expect(result.cascaded_period_ids).toEqual([y2027])
      const { rows } = await client.query(
        `SELECT fiscal_period_id, framework, source FROM public.fiscal_period_frameworks WHERE company_id = $1`,
        [seed.companyId],
      )
      const byPeriod = Object.fromEntries(rows.map((r) => [r.fiscal_period_id, r]))
      // The closed year is history and keeps K2.
      expect(byPeriod[y2025]).toMatchObject({ framework: 'k2' })
      expect(byPeriod[y2026]).toMatchObject({ framework: 'k3', source: 'election' })
      expect(byPeriod[y2027]).toMatchObject({ framework: 'k3', source: 'previous_year' })
      const company = await client.query(`SELECT accounting_framework FROM public.companies WHERE id = $1`, [seed.companyId])
      expect(company.rows[0].accounting_framework).toBe('k3')
      // Every change is in audit_log.
      const audit = await client.query(
        `SELECT count(*)::int AS n FROM public.audit_log
          WHERE table_name = 'fiscal_period_frameworks' AND action = 'UPDATE' AND company_id = $1`,
        [seed.companyId],
      )
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(2)
    })
  })

  it('refuses a closed year, a locked year and a year whose bookkeeping is locked through its end', async () => {
    const seed = await seedCompany('k2')
    const closed = await year(seed, 2024, { isClosed: true })
    const locked = await year(seed, 2025)
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [locked])
    const open = await year(seed, 2026)
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, user_id, bookkeeping_locked_through)
       VALUES ($1, $2, '2026-12-31')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [seed.companyId, seed.ownerId],
    )
    await withUserContext(seed.ownerId, async (client) => {
      expect(await setFramework(client, seed, closed, { framework: 'k3' })).toMatchObject({ ok: false, code: 'FRAMEWORK_PERIOD_CLOSED' })
      expect(await setFramework(client, seed, locked, { framework: 'k3' })).toMatchObject({ ok: false, code: 'FRAMEWORK_PERIOD_CLOSED' })
      expect(await setFramework(client, seed, open, { framework: 'k3' })).toMatchObject({ ok: false, code: 'FRAMEWORK_PERIOD_CLOSED' })
    })
    expect(await frameworkRow(closed)).toMatchObject({ framework: 'k2' })
  })

  it('refuses a year whose årsredovisning version is locked for signing', async () => {
    const seed = await seedCompany('k2')
    const y2026 = await year(seed, 2026)
    await getPool().query(
      `INSERT INTO public.annual_report_versions
         (company_id, fiscal_period_id, user_id, version_number, schema_version, framework,
          status, report_data, content_hash, validation_summary, finalized_at, finalized_by)
       VALUES ($1, $2, $3, 1, '1.0', 'k2', 'ready_for_signature', '{}'::jsonb, $4, '{}'::jsonb, now(), $3)`,
      [seed.companyId, y2026, seed.ownerId, 'c'.repeat(64)],
    )
    await withUserContext(seed.ownerId, async (client) => {
      expect(await setFramework(client, seed, y2026, { framework: 'k3' })).toMatchObject({ ok: false, code: 'FRAMEWORK_REPORT_LOCKED' })
    })
  })

  it('a switch from K3 to K2 needs reasons, an answer about earlier K2 and särskilda skäl after earlier K2', async () => {
    const seed = await seedCompany('k3')
    const y2025 = await year(seed, 2025, { isClosed: true })
    const y2026 = await year(seed, 2026)
    expect(await frameworkRow(y2025)).toMatchObject({ framework: 'k3', source: 'company_default' })
    await withUserContext(seed.ownerId, async (client) => {
      // 2025 is K3 only by the company default: the previous årsredovisning's
      // framework must be stated before anything else is judged.
      expect(await setFramework(client, seed, y2026, { framework: 'k2' })).toMatchObject({
        ok: false,
        code: 'FRAMEWORK_PREVIOUS_YEAR_UNKNOWN',
      })
      // "No previous årsredovisning" contradicts the 2025 year in the books.
      expect(await setFramework(client, seed, y2026, { framework: 'k2', previousYear: 'none' })).toMatchObject({
        ok: false,
        code: 'FRAMEWORK_INVALID',
      })
      const k3 = { framework: 'k2' as const, previousYear: 'k3' as const }
      expect(await setFramework(client, seed, y2026, k3)).toMatchObject({ ok: false, code: 'FRAMEWORK_REASON_REQUIRED' })
      expect(await setFramework(client, seed, y2026, { ...k3, reason: '  ' })).toMatchObject({
        ok: false,
        code: 'FRAMEWORK_REASON_REQUIRED',
      })
      expect(await setFramework(client, seed, y2026, { ...k3, reason: 'Verksamheten har minskat.' })).toMatchObject({
        ok: false,
        code: 'FRAMEWORK_PREVIOUS_K2_UNKNOWN',
      })
      expect(
        await setFramework(client, seed, y2026, { ...k3, reason: 'Verksamheten har minskat.', previouslyAppliedK2: true }),
      ).toMatchObject({ ok: false, code: 'FRAMEWORK_SPECIAL_REASONS_REQUIRED' })
      // A dry run checks and writes nothing.
      const dry = await setFramework(client, seed, y2026, {
        ...k3,
        reason: 'Verksamheten har minskat.',
        previouslyAppliedK2: true,
        specialReasons: true,
        dryRun: true,
      })
      expect(dry).toMatchObject({ ok: true, dry_run: true, k3_to_k2: true, previous_year_basis: 'k3' })
      const unchanged = await client.query(`SELECT framework FROM public.fiscal_period_frameworks WHERE fiscal_period_id = $1`, [y2026])
      expect(unchanged.rows[0].framework).toBe('k3')

      const done = await setFramework(client, seed, y2026, {
        ...k3,
        reason: 'Verksamheten har minskat.',
        previouslyAppliedK2: true,
        specialReasons: true,
      })
      expect(done).toMatchObject({ ok: true, changed: true, k3_to_k2: true })
      const row = await client.query(
        `SELECT framework, change_reason, previously_applied_k2, special_reasons_confirmed
           FROM public.fiscal_period_frameworks WHERE fiscal_period_id = $1`,
        [y2026],
      )
      expect(row.rows[0]).toEqual({
        framework: 'k2',
        change_reason: 'Verksamheten har minskat.',
        previously_applied_k2: true,
        special_reasons_confirmed: true,
      })
      expect(await frameworkRow(y2026, client)).toMatchObject({ stated_previous_year_framework: 'k3' })
      // Back to K3 (always allowed): the K2 reasons no longer apply.
      expect(await setFramework(client, seed, y2026, { framework: 'k3' })).toMatchObject({ ok: true })
      const back = await client.query(`SELECT change_reason FROM public.fiscal_period_frameworks WHERE fiscal_period_id = $1`, [y2026])
      expect(back.rows[0].change_reason).toBeNull()
    })
  })

  it('judges a switch year over year, and derives earlier K2 from an elected earlier year', async () => {
    const seed = await seedCompany('k2')
    const y2024 = await year(seed, 2024)
    const y2025 = await year(seed, 2025)
    const y2026 = await year(seed, 2026)
    await withUserContext(seed.ownerId, async (client) => {
      // 2026 to K3 and straight back: 2025 is K2, so 2026 never left K3
      // year over year and no reasons are asked.
      expect(await setFramework(client, seed, y2026, { framework: 'k3' })).toMatchObject({ ok: true })
      // Leaving K3 again: 2025 is K2 only by default, so it is asked; stated
      // K2, the year never left K3 year over year and no reasons are asked.
      expect(await setFramework(client, seed, y2026, { framework: 'k2' })).toMatchObject({
        ok: false,
        code: 'FRAMEWORK_PREVIOUS_YEAR_UNKNOWN',
      })
      expect(await setFramework(client, seed, y2026, { framework: 'k2', previousYear: 'k2' })).toMatchObject({
        ok: true,
        k3_to_k2: false,
      })
      // 2024 elected K2; 2025 elected K3 takes 2026 with it (2026 is an
      // election now, so it stays: elect it K3 too).
      expect(await setFramework(client, seed, y2024, { framework: 'k2' })).toMatchObject({ ok: true })
      expect(await setFramework(client, seed, y2025, { framework: 'k3' })).toMatchObject({ ok: true })
      expect(await setFramework(client, seed, y2026, { framework: 'k3' })).toMatchObject({ ok: true })
      // 2026 leaving K3 after a K3 year is a switch; the elected K2 of 2024
      // means särskilda skäl whatever the caller says about earlier K2.
      expect(
        await setFramework(client, seed, y2026, { framework: 'k2', reason: 'Skäl.', previouslyAppliedK2: false }),
      ).toMatchObject({ ok: false, code: 'FRAMEWORK_SPECIAL_REASONS_REQUIRED' })
    })
  })

  it('refuses a member who is not owner or admin, and a company the caller does not belong to', async () => {
    const seed = await seedCompany('k2')
    const y2026 = await year(seed, 2026)
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: member, role: 'member' })
    await withUserContext(member, async (client) => {
      expect(await setFramework(client, seed, y2026, { framework: 'k3' })).toMatchObject({ ok: false, code: 'FRAMEWORK_FORBIDDEN' })
    })
    const other = await seedCompany('k2')
    await withUserContext(other.ownerId, async (client) => {
      expect(await setFramework(client, seed, y2026, { framework: 'k3' })).toMatchObject({ ok: false, code: 'FRAMEWORK_FORBIDDEN' })
      // Its own company, another company's year.
      expect(await setFramework(client, other, y2026, { framework: 'k3' })).toMatchObject({
        ok: false,
        code: 'FRAMEWORK_PERIOD_NOT_FOUND',
      })
    })
  })

  it('the service role writes with the acting user recorded', async () => {
    const seed = await seedCompany('k2')
    const y2026 = await year(seed, 2026)
    await runAsServiceRole(async (client) => {
      const { rows } = await client.query(
        `SELECT public.set_fiscal_period_framework($1, $2, 'k3', NULL, NULL, NULL, $3, false) AS result`,
        [seed.companyId, y2026, seed.ownerId],
      )
      expect(rows[0].result).toMatchObject({ ok: true, changed: true })
    })
    const { rows } = await getPool().query(
      `SELECT framework, source, user_id FROM public.fiscal_period_frameworks WHERE fiscal_period_id = $1`,
      [y2026],
    )
    expect(rows[0]).toEqual({ framework: 'k3', source: 'election', user_id: seed.ownerId })
  })

  it('a legal-form correction moves the open years with the form; closed years keep theirs', async () => {
    const seed = await seedCompany('k3')
    const y2025 = await year(seed, 2025, { isClosed: true })
    const y2026 = await year(seed, 2026)
    await getPool().query(
      `UPDATE public.companies SET entity_type = 'ekonomisk_forening', accounting_framework = 'k2' WHERE id = $1`,
      [seed.companyId],
    )
    expect(await frameworkRow(y2025)).toMatchObject({ framework: 'k3' })
    expect(await frameworkRow(y2026)).toMatchObject({ framework: 'k2', source: 'company_default', previous_framework: 'k3' })
  })

  it('a company that filed K2 and later set K3 is not told it leaves K3 (no false switch note)', async () => {
    // Filed 2025 under K2 (a signed version), then switched the setting to
    // K3 before this table existed: 2025 and 2026 both default to K3.
    const seed = await seedCompany('k3')
    const y2025 = await year(seed, 2025, { isClosed: true })
    const y2026 = await year(seed, 2026)
    await lockedVersion(seed, y2025, 'k2')
    // The backfill would have taken 2025 from its signed version; the seeded
    // row stands in for it here.
    await getPool().query(
      `UPDATE public.fiscal_period_frameworks f SET framework = e.framework, source = e.source
         FROM public.fiscal_period_framework_evidence($1) e WHERE f.fiscal_period_id = $1`,
      [y2025],
    )
    expect(await frameworkRow(y2025)).toMatchObject({ framework: 'k2', source: 'annual_report' })
    await withUserContext(seed.ownerId, async (client) => {
      const result = await setFramework(client, seed, y2026, { framework: 'k2' })
      expect(result).toMatchObject({ ok: true, k3_to_k2: false, previous_year_basis: 'k2' })
      expect(await frameworkRow(y2026, client)).toMatchObject({
        framework: 'k2',
        change_reason: null,
        stated_previous_year_framework: null,
      })
    })
  })

  it('asks for the previous årsredovisning of a first year leaving K3, and takes "none" when there is no year before', async () => {
    const seed = await seedCompany('k3')
    const y2026 = await year(seed, 2026)
    await withUserContext(seed.ownerId, async (client) => {
      expect(await setFramework(client, seed, y2026, { framework: 'k2' })).toMatchObject({
        ok: false,
        code: 'FRAMEWORK_PREVIOUS_YEAR_UNKNOWN',
      })
      expect(await setFramework(client, seed, y2026, { framework: 'k2', previousYear: 'none' })).toMatchObject({
        ok: true,
        k3_to_k2: false,
      })
      expect(await frameworkRow(y2026, client)).toMatchObject({ framework: 'k2', stated_previous_year_framework: 'none' })
    })
  })

  it('refuses K3 in the database for every legal form whose profile does not offer it', async () => {
    for (const entityType of ENTITY_TYPES) {
      const seed = await seedCompany('k2', entityType)
      const y2026 = await year(seed, 2026)
      await withUserContext(seed.ownerId, async (client) => {
        const result = await setFramework(client, seed, y2026, { framework: 'k3' })
        if (supportsAccountingFramework(entityType, 'K3')) {
          expect(result, entityType).toMatchObject({ ok: true })
        } else {
          expect(result, entityType).toMatchObject({ ok: false, code: 'FRAMEWORK_FORM_UNSUPPORTED' })
        }
      })
    }
  })

  // The bostadsrättsförening arrives with !914 (ENTITY_TYPES and the
  // companies.entity_type CHECK); until then this case does not run.
  const BRF = 'bostadsrattsforening'
  it.runIf((ENTITY_TYPES as readonly string[]).includes(BRF))(
    'refuses K2 for a bostadsrättsförening in a year BFNAR 2025:2 applies to, not in an earlier one',
    async () => {
      const seed = await seedCompany('k3', BRF as EntityType)
      const y2025 = await year(seed, 2025)
      const y2026 = await year(seed, 2026)
      await withUserContext(seed.ownerId, async (client) => {
        expect(await setFramework(client, seed, y2026, { framework: 'k3' })).toMatchObject({ ok: true })
        expect(await setFramework(client, seed, y2026, { framework: 'k2', previousYear: 'k2' })).toMatchObject({
          ok: false,
          code: 'FRAMEWORK_K2_NOT_ALLOWED',
        })
        expect(await setFramework(client, seed, y2025, { framework: 'k2', previousYear: 'none' })).toMatchObject({
          ok: true,
        })
      })
    },
  )

  it('a legal-form correction leaves a year locked through its end, and records who changed the form', async () => {
    const seed = await seedCompany('k3')
    const y2025 = await year(seed, 2025)
    const y2026 = await year(seed, 2026)
    // 2026 elected K3 by another user (through the service role).
    const elector = await insertAuthUser()
    await runAsServiceRole(async (client) => {
      const { rows } = await client.query(
        `SELECT public.set_fiscal_period_framework($1, $2, 'k3', NULL, NULL, NULL, $3, false) AS result`,
        [seed.companyId, y2026, elector],
      )
      expect(rows[0].result).toMatchObject({ ok: true })
    })
    expect(await frameworkRow(y2026)).toMatchObject({ source: 'election', user_id: elector })
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, user_id, bookkeeping_locked_through)
       VALUES ($1, $2, '2025-12-31')
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [seed.companyId, seed.ownerId],
    )
    await withUserContext(seed.ownerId, async (client) => {
      const { rows } = await client.query(
        `SELECT public.correct_company_entity_type($1::uuid, 'ekonomisk_forening', 'k2') AS result`,
        [seed.companyId],
      )
      expect(rows[0].result).toMatchObject({ ok: true })
      // Read in the same (rolled back) transaction.
      // 2025's bookkeeping is locked through its last day: it keeps K3, as
      // set_fiscal_period_framework would refuse to change it.
      expect(await frameworkRow(y2025, client)).toMatchObject({ framework: 'k3' })
      // 2026 follows the form, attributed to the owner who changed it, not to
      // the user who elected K3.
      expect(await frameworkRow(y2026, client)).toMatchObject({
        framework: 'k2',
        source: 'company_default',
        user_id: seed.ownerId,
      })
      const audit = await client.query(
        `SELECT a.user_id FROM public.audit_log a
           JOIN public.fiscal_period_frameworks f ON f.id = a.record_id
          WHERE a.table_name = 'fiscal_period_frameworks' AND a.action = 'UPDATE'
            AND f.fiscal_period_id = $1 AND a.new_state->>'source' = 'company_default'`,
        [y2026],
      )
      expect(audit.rows.map((r: { user_id: string }) => r.user_id)).toEqual([seed.ownerId])
    })
  })
})
