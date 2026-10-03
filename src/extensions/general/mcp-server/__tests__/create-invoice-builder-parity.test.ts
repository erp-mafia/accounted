/**
 * gnubok_create_invoice builds through the shared invoice builder.
 *
 * The staging preview and the approval used to carry their own copies of the
 * invoice rules, and every rule added to buildInvoiceWriteData later never
 * reached them: a 25 % sale booked to 1660 (output VAT on 2611, the base
 * missing from ruta 05), ROT/RUT line fields staged and then dropped at
 * approval, and a preview that showed VAT a non-VAT-registered company's
 * invoice never got. Both sides now run buildStagedInvoice on the same staged
 * params, so the preview IS a dry run of the commit.
 *
 * The supabase mock routes by table instead of by call order, so one fixture
 * drives both the staging call and the commit of the params it staged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeCustomer } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { DEFAULT_DEFERRED_REVENUE_ACCOUNT } from '@/lib/bookkeeping/accruals/account-suggestions'
import { roundOre } from '@/lib/money'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { Customer, PendingOperation } from '@/types'
import { tools } from '../server'

const createInvoice = tools.find((t) => t.name === 'gnubok_create_invoice')!

interface Fixture {
  customer: Customer
  settings?: Record<string, unknown>
  /** Active class 1-3 accounts in the chart (for revenue_account overrides). */
  accounts?: string[]
}

function createRoutingSupabase(fixture: Fixture) {
  const inserts: Record<string, Array<Record<string, unknown>>> = {}
  const settings = { vat_registered: true, accounting_method: 'accrual', ...fixture.settings }

  const from = vi.fn((table: string) => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const result = () => {
      switch (table) {
        case 'customers':
          return { data: fixture.customer, error: null }
        case 'company_settings':
          return { data: settings, error: null }
        case 'chart_of_accounts': {
          const requested = (calls.find((c) => c.method === 'in')?.args[1] as string[] | undefined) ?? []
          return {
            data: requested.filter((a) => (fixture.accounts ?? []).includes(a)).map((a) => ({ account_number: a })),
            error: null,
          }
        }
        case 'pending_operations':
          return { data: { id: 'op-1' }, error: null }
        case 'invoices':
          return { data: { id: 'inv-1', invoice_number: null }, error: null }
        default:
          return { data: null, error: null }
      }
    }
    const chain: object = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result())
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            if (prop === 'insert') (inserts[table] ??= []).push(args[0] as Record<string, unknown>)
            return chain
          }
        },
      },
    )
    return chain
  })

  const rpc = vi.fn().mockResolvedValue({ data: 'OF-001', error: null })
  return { supabase: { from, rpc }, inserts }
}

type Staged = {
  staged: boolean
  preview: {
    items: Array<Record<string, unknown>>
    subtotal: number
    vat_amount: number
    total: number
    vat_treatment: string
    deduction_total?: number
  }
}

async function stage(fixture: Fixture, args: Record<string, unknown>) {
  const { supabase, inserts } = createRoutingSupabase(fixture)
  const result = (await createInvoice.execute(args, 'company-1', 'user-1', supabase as never)) as Staged
  const params = inserts.pending_operations?.[0]?.params as Record<string, unknown>
  return { result, params }
}

async function commit(fixture: Fixture, params: Record<string, unknown>) {
  const { supabase, inserts } = createRoutingSupabase(fixture)
  const op = {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_invoice',
    status: 'pending',
    title: 'test',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
  } as PendingOperation
  const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)
  return {
    result,
    invoice: inserts.invoices?.[0],
    items: inserts.invoice_items?.[0] as unknown as Array<Record<string, unknown>> | undefined,
  }
}

const domestic = makeCustomer({ id: 'cust-1', name: 'Synthetic Kund AB', customer_type: 'swedish_business' })
const euBusiness = makeCustomer({
  id: 'cust-eu',
  name: 'Muster GmbH',
  customer_type: 'eu_business',
  country: 'DE',
  vat_number: 'DE811234567',
  vat_number_validated: true,
})
// Synthetic, Luhn-valid test personnummer on the customer card: ROT/RUT
// lines take it from there, the MCP surface never carries one.
const privatePerson = makeCustomer({
  id: 'cust-p',
  name: 'Privatperson',
  customer_type: 'individual',
  org_number: null,
  vat_number: null,
  vat_number_validated: false,
  personal_number: encryptPersonnummer('199001019802'),
})

const rotLine = {
  description: 'Snickeriarbete',
  quantity: 10,
  unit: 'tim',
  unit_price: 500,
  vat_rate: 25,
  deduction_type: 'rot',
  work_type: 'BYGG',
  labor_hours: 10,
  housing_designation: 'Exempelby 1:23',
}

const accrualLine = {
  description: 'Supportavtal juli-december',
  quantity: 1,
  unit: 'st',
  unit_price: 6000,
  vat_rate: 25,
  accrual_period_start: '2026-07-01',
  accrual_period_end: '2026-12-31',
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('gnubok_create_invoice: the shared builder rules apply at staging', () => {
  it('refuses a balance-sheet account (1660) on a 25 % line before anything is staged', async () => {
    const { supabase, inserts } = createRoutingSupabase({ customer: domestic, accounts: ['1660'] })

    await expect(
      createInvoice.execute(
        {
          customer_id: 'cust-1',
          invoice_date: '2026-06-01',
          items: [{ description: 'Konsultarvode', quantity: 1, unit: 'st', unit_price: 105000, vat_rate: 25, revenue_account: '1660' }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT',
      message: expect.stringMatching(/1660.*ruta 05/),
    })
    expect(inserts.pending_operations).toBeUndefined()
  })

  it('refuses an unknown line field instead of staging it and dropping it at approval', async () => {
    const { supabase, inserts } = createRoutingSupabase({ customer: domestic })

    await expect(
      createInvoice.execute(
        {
          customer_id: 'cust-1',
          items: [{ description: 'Konsultarvode', quantity: 1, unit: 'st', unit_price: 1000, vat: 25 }],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('items.0.vat') })
    expect(inserts.pending_operations).toBeUndefined()
  })

  it('shows no VAT in the preview for a company that is not VAT-registered', async () => {
    const { result } = await stage(
      { customer: domestic, settings: { vat_registered: false } },
      {
        customer_id: 'cust-1',
        invoice_date: '2026-06-01',
        items: [{ description: 'Konsultarvode', quantity: 2, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
      },
    )

    expect(result.staged).toBe(true)
    expect(result.preview.vat_amount).toBe(0)
    expect(result.preview.total).toBe(2000)
    expect(result.preview.vat_treatment).toBe('exempt')
    expect(result.preview.items[0]).toMatchObject({ vat_rate: 0, line_total: 2000 })
  })
})

describe('gnubok_create_invoice: ROT/RUT and periodisering fields reach the stored invoice', () => {
  it('stores the ROT line fields and the deduction, with the personnummer from the customer card', async () => {
    const fixture = { customer: privatePerson }
    const { result, params } = await stage(fixture, {
      customer_id: 'cust-p',
      invoice_date: '2026-06-01',
      items: [rotLine, { description: 'Material', quantity: 1, unit: 'st', unit_price: 2000, vat_rate: 25 }],
    })
    expect(result.staged).toBe(true)
    expect(result.preview.deduction_total).toBeGreaterThan(0)

    const { result: committed, invoice, items } = await commit(fixture, params)

    expect(committed.status).toBe('committed')
    expect(items?.[0]).toMatchObject({
      deduction_type: 'rot',
      work_type: 'BYGG',
      labor_hours: 10,
      housing_designation: 'Exempelby 1:23',
    })
    expect(items?.[0].deduction_amount).toBe(result.preview.deduction_total)
    expect(items?.[1]).toMatchObject({ deduction_type: null, deduction_amount: 0 })
    expect(invoice).toMatchObject({
      deduction_total: result.preview.deduction_total,
      deduction_personnummer_last4: '9802',
      remaining_amount: roundOre(result.preview.total - (result.preview.deduction_total ?? 0)),
    })
  })

  it('refuses a ROT line at staging when the customer card has no personnummer', async () => {
    const { supabase, inserts } = createRoutingSupabase({ customer: { ...privatePerson, personal_number: null } })

    await expect(
      createInvoice.execute(
        { customer_id: 'cust-p', invoice_date: '2026-06-01', items: [rotLine] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
      message: expect.stringContaining('customer card'),
    })
    expect(inserts.pending_operations).toBeUndefined()
  })

  it('stores the accrual period and the default interim account', async () => {
    const fixture = { customer: domestic }
    const { params } = await stage(fixture, {
      customer_id: 'cust-1',
      invoice_date: '2026-06-01',
      items: [accrualLine],
    })

    const { result: committed, items } = await commit(fixture, params)

    expect(committed.status).toBe('committed')
    expect(items?.[0]).toMatchObject({
      accrual_period_start: '2026-07-01',
      accrual_period_end: '2026-12-31',
      accrual_balance_account: DEFAULT_DEFERRED_REVENUE_ACCOUNT,
    })
  })
})

describe('gnubok_create_invoice: the preview is a dry run of the commit', () => {
  const fixtures: Array<{ name: string; fixture: Fixture; args: Record<string, unknown> }> = [
    {
      name: 'domestic mixed rates, discount and a text row',
      fixture: { customer: domestic },
      args: {
        items: [
          { description: 'Konsultarvode', quantity: 3, unit: 'tim', unit_price: 1150, vat_rate: 25, discount_percent: 10 },
          { line_type: 'text', description: 'Avser vecka 23', quantity: 0 },
          { description: 'Hotellnatt', quantity: 2, unit: 'st', unit_price: 1333.33, vat_rate: 12 },
          { description: 'Tidskrift', quantity: 1, unit: 'st', unit_price: 99.9, vat_rate: 6 },
        ],
      },
    },
    {
      name: 'EU business, reverse charge by default',
      fixture: { customer: euBusiness },
      args: { items: [{ description: 'Konsultarvode', quantity: 8, unit: 'tim', unit_price: 1200 }] },
    },
    {
      name: 'EU business, a hotel night taxed where performed next to a reverse-charge line',
      fixture: { customer: euBusiness },
      args: {
        items: [
          { description: 'Hotellnatt Stockholm', quantity: 1, unit: 'st', unit_price: 1800, vat_rate: 12 },
          { description: 'Konsultarvode', quantity: 4, unit: 'tim', unit_price: 1200 },
        ],
      },
    },
    {
      name: 'company not VAT-registered',
      fixture: { customer: domestic, settings: { vat_registered: false } },
      args: { items: [{ description: 'Konsultarvode', quantity: 1, unit: 'st', unit_price: 4000, vat_rate: 25 }] },
    },
    {
      name: 'ROT line with material',
      fixture: { customer: privatePerson },
      args: { items: [rotLine, { description: 'Material', quantity: 3, unit: 'st', unit_price: 412.5, vat_rate: 25 }] },
    },
    {
      name: 'periodisering line',
      fixture: { customer: domestic },
      args: { items: [accrualLine] },
    },
    {
      name: 'deposit on a balance-sheet account at 0 %',
      fixture: { customer: domestic, accounts: ['2420'] },
      args: {
        items: [
          { description: 'Förskott', quantity: 1, unit: 'st', unit_price: 5000, vat_rate: 0, revenue_account: '2420' },
          { description: 'Konsultarvode', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 },
        ],
      },
    },
  ]

  for (const { name, fixture, args } of fixtures) {
    it(`${name}: preview totals, treatment and lines equal what the commit writes`, async () => {
      const { result, params } = await stage(fixture, {
        customer_id: fixture.customer.id,
        invoice_date: '2026-06-01',
        ...args,
      })
      expect(result.staged).toBe(true)

      const { result: committed, invoice, items } = await commit(fixture, params)

      expect(committed.status).toBe('committed')
      expect(roundOre(invoice!.subtotal as number)).toBe(result.preview.subtotal)
      expect(roundOre(invoice!.vat_amount as number)).toBe(result.preview.vat_amount)
      expect(roundOre(invoice!.total as number)).toBe(result.preview.total)
      expect(invoice!.vat_treatment).toBe(result.preview.vat_treatment)
      expect(roundOre(invoice!.deduction_total as number)).toBe(result.preview.deduction_total ?? 0)
      expect(items).toHaveLength(result.preview.items.length)
      items!.forEach((row, i) => {
        expect(row.vat_rate).toBe(result.preview.items[i].vat_rate)
        expect(row.line_total).toBe(result.preview.items[i].line_total)
        expect(row.vat_amount).toBe(result.preview.items[i].vat_amount)
      })
    })
  }

  it('drops the reverse-charge notice when the EU invoice only carries Swedish VAT', async () => {
    // "Omvänd betalningsskyldighet" next to charged Swedish VAT tells the buyer
    // to self-assess tax the seller already collected (ML 17 kap 24 §).
    const fixture = { customer: euBusiness }
    const { params } = await stage(fixture, {
      customer_id: 'cust-eu',
      invoice_date: '2026-06-01',
      items: [{ description: 'Hotellnatt Stockholm', quantity: 1, unit: 'st', unit_price: 1800, vat_rate: 12 }],
    })

    const { result: committed, invoice } = await commit(fixture, params)

    expect(committed.status).toBe('committed')
    expect(invoice).toMatchObject({ vat_amount: 216, reverse_charge_text: null })
  })
})
