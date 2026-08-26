import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertAuthUser, insertCompany, insertFiscalPeriod } from './fixtures'

describe('BFL retention expiry', () => {
  it('runs the corrected retention trigger after the original migration 017 trigger', async () => {
    const result = await getPool().query<{
      trigger_name: string
      trigger_definition: string
    }>(
      `SELECT
         trigger.tgname AS trigger_name,
         pg_get_triggerdef(trigger.oid) AS trigger_definition
       FROM pg_trigger trigger
       JOIN pg_class target ON target.oid = trigger.tgrelid
       JOIN pg_namespace schema ON schema.oid = target.relnamespace
       WHERE schema.nspname = 'public'
         AND target.relname = 'fiscal_periods'
         AND NOT trigger.tgisinternal
         AND trigger.tgname IN (
           'calculate_retention_expiry',
           'zz_set_bfl_retention_expiry',
           'enforce_period_start_day'
         )
       ORDER BY trigger.tgname`,
    )

    expect(result.rows).toEqual([
      {
        trigger_name: 'calculate_retention_expiry',
        trigger_definition:
          'CREATE TRIGGER calculate_retention_expiry BEFORE INSERT OR UPDATE ON public.fiscal_periods FOR EACH ROW EXECUTE FUNCTION calculate_retention_expiry()',
      },
      {
        trigger_name: 'enforce_period_start_day',
        trigger_definition:
          'CREATE TRIGGER enforce_period_start_day BEFORE INSERT OR UPDATE OF company_id, period_start ON public.fiscal_periods FOR EACH ROW EXECUTE FUNCTION enforce_first_of_month_for_subsequent_periods()',
      },
      {
        trigger_name: 'zz_set_bfl_retention_expiry',
        trigger_definition:
          'CREATE TRIGGER zz_set_bfl_retention_expiry BEFORE INSERT OR UPDATE ON public.fiscal_periods FOR EACH ROW EXECUTE FUNCTION set_bfl_retention_expiry()',
      },
    ])
  })

  it('retains a fiscal year through the end of the seventh following calendar year', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2025-07-01',
      periodEnd: '2026-06-30',
      name: '2025/2026',
    })

    const result = await getPool().query<{ retention_expires_at: string }>(
      `SELECT retention_expires_at::text
       FROM public.fiscal_periods
       WHERE id = $1`,
      [fiscalPeriodId],
    )

    expect(result.rows[0].retention_expires_at).toBe('2034-01-01')
  })

  it('recalculates the first allowed deletion date when an open period end changes', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    await getPool().query(
      `UPDATE public.fiscal_periods
       SET period_end = '2027-03-31'
       WHERE id = $1`,
      [fiscalPeriodId],
    )
    const result = await getPool().query<{ retention_expires_at: string }>(
      `SELECT retention_expires_at::text
       FROM public.fiscal_periods
       WHERE id = $1`,
      [fiscalPeriodId],
    )

    expect(result.rows[0].retention_expires_at).toBe('2035-01-01')
  })

  it('does not restore the old expiry calculation on unrelated updates', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2025-07-01',
      periodEnd: '2026-06-30',
      name: '2025/2026',
    })

    await getPool().query(
      `UPDATE public.fiscal_periods
       SET name = 'Updated 2025/2026'
       WHERE id = $1`,
      [fiscalPeriodId],
    )

    const result = await getPool().query<{ retention_expires_at: string }>(
      `SELECT retention_expires_at::text
       FROM public.fiscal_periods
       WHERE id = $1`,
      [fiscalPeriodId],
    )

    expect(result.rows[0].retention_expires_at).toBe('2034-01-01')
  })

  it('allows retention backfills when a historical mid-month start is unchanged', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const historicalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2025-10-20',
      periodEnd: '2025-12-31',
      name: 'Historical period',
    })

    // Adding an earlier period makes the existing mid-month row match the
    // historical state that used to abort unrelated fiscal-period updates.
    await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2024-01-01',
      periodEnd: '2024-12-31',
      name: 'Earlier period',
    })

    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods
         SET retention_expires_at = make_date(
           extract(year FROM period_end)::integer + 8,
           1,
           1
         )
         WHERE id = $1`,
        [historicalPeriodId],
      ),
    ).resolves.toBeDefined()

    const result = await getPool().query<{ retention_expires_at: string }>(
      `SELECT retention_expires_at::text
       FROM public.fiscal_periods
       WHERE id = $1`,
      [historicalPeriodId],
    )

    expect(result.rows[0].retention_expires_at).toBe('2033-01-01')
  })
})
