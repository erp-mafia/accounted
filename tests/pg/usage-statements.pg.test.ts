import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Priced usage (migration 20261101190000_usage_statements.sql): members read
 * their own company's acceptances and statements and write neither, one open
 * acceptance per company and kind, one statement per company, month and
 * kind, and a statement's amount is always the unit price times what is
 * billable.
 */

async function insertStatement(params: {
  companyId: string
  period?: string
  kind?: string
  used?: number
  included?: number | null
  billable?: number
  unitPriceOre?: number | null
  amountOre?: number
  status?: string
  stripeInvoiceItemId?: string | null
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.usage_statements
       (company_id, period, kind, used, included, billable, unit_price_ore, amount_ore, status, stripe_invoice_item_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      params.companyId,
      params.period ?? '2026-10',
      params.kind ?? 'bank_payment',
      params.used ?? 14,
      params.included === undefined ? 10 : params.included,
      params.billable ?? 4,
      params.unitPriceOre === undefined ? 200 : params.unitPriceOre,
      params.amountOre ?? 800,
      params.status ?? 'preview',
      params.stripeInvoiceItemId ?? null,
    ],
  )
  return rows[0]!.id
}

async function insertConsent(params: { companyId: string; kind?: string; acceptedBy?: string | null; revoked?: boolean }): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.usage_consents (company_id, kind, unit_price_ore, included, accepted_by, revoked_at)
     VALUES ($1, $2, 200, 10, $3, $4) RETURNING id`,
    [params.companyId, params.kind ?? 'bank_payment', params.acceptedBy ?? null, params.revoked ? new Date().toISOString() : null],
  )
  return rows[0]!.id
}

describe('usage_consents (pg)', () => {
  it('lets members read their own company only, and write nothing', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: member, role: 'admin' })
    const idA = await insertConsent({ companyId: a.companyId, acceptedBy: member })
    await insertConsent({ companyId: b.companyId })

    await withUserContext(member, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.usage_consents`)
      expect(rows.map((r) => r.id)).toEqual([idA])
    })
    await withUserContext(member, async (client) => {
      await expect(client.query(`UPDATE public.usage_consents SET revoked_at = now() WHERE id = $1`, [idA])).rejects.toThrow(/permission denied/)
    })
    await withUserContext(member, async (client) => {
      await expect(
        client.query(`INSERT INTO public.usage_consents (company_id, kind, unit_price_ore, included) VALUES ($1, 'peppol_send', 100, 10)`, [
          a.companyId,
        ]),
      ).rejects.toThrow(/permission denied/)
    })
  })

  it('keeps one open acceptance per company and kind, and the closed ones beside it', async () => {
    const a = await seedCompany()
    await insertConsent({ companyId: a.companyId, revoked: true })
    await insertConsent({ companyId: a.companyId, revoked: true })
    await insertConsent({ companyId: a.companyId })
    await insertConsent({ companyId: a.companyId, kind: 'peppol_send' })
    await expect(insertConsent({ companyId: a.companyId })).rejects.toThrow(/usage_consents_one_open/)
  })

  it('refuses an acceptance of nothing, or closed by someone at no time', async () => {
    const a = await seedCompany()
    await expect(
      getPool().query(`INSERT INTO public.usage_consents (company_id, kind, unit_price_ore, included) VALUES ($1, 'bank_payment', 0, 10)`, [a.companyId]),
    ).rejects.toThrow(/check/)
    const user = await insertAuthUser()
    await expect(
      getPool().query(
        `INSERT INTO public.usage_consents (company_id, kind, unit_price_ore, included, revoked_by) VALUES ($1, 'bank_payment', 200, 10, $2)`,
        [a.companyId, user],
      ),
    ).rejects.toThrow(/usage_consents_revoked_shape/)
  })
})

describe('usage_statements (pg)', () => {
  it('lets members read their own company only, and write nothing', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const idA = await insertStatement({ companyId: a.companyId })
    await insertStatement({ companyId: b.companyId })

    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: member, role: 'member' })

    await withUserContext(member, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.usage_statements`)
      expect(rows.map((r) => r.id)).toEqual([idA])
    })
    await withUserContext(member, async (client) => {
      await expect(client.query(`UPDATE public.usage_statements SET status = 'billed' WHERE id = $1`, [idA])).rejects.toThrow(/permission denied/)
    })
    await withUserContext(member, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.usage_statements (company_id, period, kind, used, billable, amount_ore, status)
           VALUES ($1, '2026-11', 'peppol_send', 1, 0, 0, 'preview')`,
          [a.companyId],
        ),
      ).rejects.toThrow(/permission denied/)
    })
  })

  it('keeps one statement per company, month and kind', async () => {
    const a = await seedCompany()
    await insertStatement({ companyId: a.companyId, kind: 'bank_payment' })
    await insertStatement({ companyId: a.companyId, kind: 'peppol_send', used: 12, billable: 2, unitPriceOre: 100, amountOre: 200 })
    await insertStatement({ companyId: a.companyId, kind: 'bank_payment', period: '2026-11' })
    await expect(insertStatement({ companyId: a.companyId, kind: 'bank_payment' })).rejects.toThrow(/usage_statements_company_period_kind_key/)
  })

  it('refuses an amount that is not the unit price times what is billable', async () => {
    const a = await seedCompany()
    await expect(insertStatement({ companyId: a.companyId, amountOre: 801 })).rejects.toThrow(/usage_statements_amount_shape/)
    await expect(
      insertStatement({ companyId: a.companyId, kind: 'kivra_send', unitPriceOre: null, included: null, amountOre: 800 }),
    ).rejects.toThrow(/usage_statements_amount_shape/)
    await insertStatement({ companyId: a.companyId, kind: 'kivra_send', unitPriceOre: null, included: null, billable: 0, amountOre: 0 })
  })

  it('refuses a billed statement without its Stripe line, and a malformed month or kind', async () => {
    const a = await seedCompany()
    await expect(insertStatement({ companyId: a.companyId, status: 'billed' })).rejects.toThrow(/usage_statements_billed_shape/)
    await insertStatement({ companyId: a.companyId, status: 'billed', stripeInvoiceItemId: 'ii_1' })
    await expect(insertStatement({ companyId: a.companyId, period: '2026-13' })).rejects.toThrow(/check/)
    await expect(insertStatement({ companyId: a.companyId, kind: 'fax' })).rejects.toThrow(/check/)
  })
})
