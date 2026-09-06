import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * `company_settings.voucher_series_labels` shape rule (migrations
 * 20260906131300 and 20260906134700).
 *
 * The API route validates the map through UpdateSettingsSchema; this CHECK
 * is what stops a write that bypasses the route (admin script, backfill,
 * service-role path) from storing a map the series pickers cannot handle.
 * Under test: `voucher_series_labels_valid(jsonb)` and the constraint that
 * wraps it. Superuser pool on purpose: the object is the CHECK, not RLS.
 */

const CHECK_VIOLATION = '23514'

async function seedSettings(): Promise<string> {
  const { companyId } = await seedCompany()
  // A trigger may already have created the row; either way one exists after this.
  await getPool().query(
    `INSERT INTO public.company_settings (company_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [companyId],
  )
  return companyId
}

async function setLabels(companyId: string, labels: string): Promise<void> {
  await getPool().query(
    `UPDATE public.company_settings SET voucher_series_labels = $2::jsonb WHERE company_id = $1`,
    [companyId, labels],
  )
}

async function expectRejected(companyId: string, labels: string): Promise<void> {
  await expect(setLabels(companyId, labels)).rejects.toMatchObject({ code: CHECK_VIOLATION })
}

describe('voucher_series_labels_valid', () => {
  it('accepts the empty map, single-letter keys and names of 1 to 40 characters', async () => {
    const { rows } = await getPool().query<{ empty: boolean; good: boolean; max: boolean }>(
      `SELECT public.voucher_series_labels_valid('{}'::jsonb) AS empty,
              public.voucher_series_labels_valid('{"L":"Lön","N":"Utlägg"}'::jsonb) AS good,
              public.voucher_series_labels_valid(('{"L":"' || repeat('x', 40) || '"}')::jsonb) AS max`,
    )
    expect(rows[0]).toEqual({ empty: true, good: true, max: true })
  })

  it('rejects every shape the Zod schema rejects', async () => {
    const { rows } = await getPool().query<Record<string, boolean>>(
      `SELECT public.voucher_series_labels_valid('{"l":"Lön"}'::jsonb) AS lowercase_key,
              public.voucher_series_labels_valid('{"AB":"Lön"}'::jsonb) AS two_letter_key,
              public.voucher_series_labels_valid('{"":"Lön"}'::jsonb) AS empty_key,
              public.voucher_series_labels_valid('{"L":""}'::jsonb) AS empty_value,
              public.voucher_series_labels_valid('{"L":"   "}'::jsonb) AS blank_value,
              public.voucher_series_labels_valid(('{"L":"' || repeat('x', 41) || '"}')::jsonb) AS too_long,
              public.voucher_series_labels_valid('{"L":7}'::jsonb) AS number_value,
              public.voucher_series_labels_valid('{"L":null}'::jsonb) AS null_value,
              public.voucher_series_labels_valid('[]'::jsonb) AS array_map,
              public.voucher_series_labels_valid('"Lön"'::jsonb) AS scalar`,
    )
    expect(Object.values(rows[0]).every((v) => v === false)).toBe(true)
  })
})

describe('company_settings.voucher_series_labels CHECK', () => {
  it('defaults to an empty map and stores a valid map', async () => {
    const companyId = await seedSettings()
    const before = await getPool().query<{ voucher_series_labels: unknown }>(
      `SELECT voucher_series_labels FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(before.rows[0].voucher_series_labels).toEqual({})

    await setLabels(companyId, '{"L":"Lön","N":"Utlägg"}')
    const after = await getPool().query<{ voucher_series_labels: unknown }>(
      `SELECT voucher_series_labels FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(after.rows[0].voucher_series_labels).toEqual({ L: 'Lön', N: 'Utlägg' })
  })

  it('refuses a lowercase or multi-letter key', async () => {
    const companyId = await seedSettings()
    await expectRejected(companyId, '{"l":"Lön"}')
    await expectRejected(companyId, '{"FT":"Fortnox"}')
  })

  it('refuses a blank, over-long or non-string name', async () => {
    const companyId = await seedSettings()
    await expectRejected(companyId, '{"L":""}')
    await expectRejected(companyId, '{"L":"   "}')
    await expectRejected(companyId, `{"L":"${'x'.repeat(41)}"}`)
    await expectRejected(companyId, '{"L":7}')
  })

  it('refuses anything that is not an object', async () => {
    const companyId = await seedSettings()
    await expectRejected(companyId, '[]')
    await expectRejected(companyId, '"Lön"')
  })

  it('leaves the row untouched after a refused write', async () => {
    const companyId = await seedSettings()
    await setLabels(companyId, '{"L":"Lön"}')
    await expectRejected(companyId, '{"l":"fel"}')
    const { rows } = await getPool().query<{ voucher_series_labels: unknown }>(
      `SELECT voucher_series_labels FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0].voucher_series_labels).toEqual({ L: 'Lön' })
  })
})
