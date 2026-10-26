/**
 * gnubok_create_voucher: lines[].vat_code (crm#1096).
 *
 * The tool takes the momskod the manual verifikat form and the v1 voucher
 * routes take, parsed by the same schema and expanded by the same derivation
 * (expandVoucherLineVatCodes). The generated lines are staged as ordinary
 * lines, so the preview is what posts and the commit executor needs no
 * momskod of its own; a code that cannot post as asked is refused before
 * anything is staged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { VOUCHER_LINE_VAT_KINDS, VOUCHER_LINE_VAT_RATES } from '@/lib/bookkeeping/voucher-line-vat-code'

vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, findFiscalPeriod: vi.fn() }
})

// The momsdeklaration impact has its own tests
// (src/lib/vat/__tests__/voucher-vat-impact.test.ts); here it is a fixed
// answer so the queued reads below stay the tool's own.
vi.mock('@/lib/vat/voucher-vat-impact', () => ({
  previewVoucherVatDeclaration: vi.fn().mockResolvedValue({
    status: 'ok', vat_period: null, counted: true, excluded_as: null, rutor_change: {},
    summary: 'Påverkar ingen ruta i momsdeklarationen.',
  }),
}))

import { tools } from '../server'

const createVoucher = tools.find((t) => t.name === 'gnubok_create_voucher')!

const NON_EU_25 = { kind: 'non_eu_services', rate: 0.25 }

const PERIOD = { id: 'fp-1', is_closed: false, period_start: '2026-01-01', period_end: '2026-12-31', name: '2026' }

const PURCHASE = {
  entry_date: '2026-05-12',
  description: 'Licens, leverantör utanför EU',
  fiscal_period_id: 'fp-1',
  lines: [
    { account_number: '6540', debit_amount: 1000, vat_code: NON_EU_25, dimensions: { '6': 'P001' } },
    { account_number: '1930', credit_amount: 1000 },
  ],
}

type StagedLine = { account_number: string; debit_amount: number; credit_amount: number; dimensions?: unknown }

/** A tool failure as the dispatch reads it: code, message_en and the Swedish issues. */
type ToolError = Error & { code?: string; issues?: Array<{ field: string; message: string }> }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_create_voucher: lines[].vat_code', () => {
  it('declares vat_code on a line with the kinds and rates the server accepts', () => {
    const items = (createVoucher.inputSchema as {
      properties: { lines: { items: { properties: Record<string, { enum?: unknown[]; properties?: Record<string, { enum?: unknown[] }>; required?: string[] }> } } }
    }).properties.lines.items
    const vatCode = items.properties.vat_code
    expect(vatCode.properties?.kind.enum).toEqual([...VOUCHER_LINE_VAT_KINDS])
    expect(vatCode.properties?.rate.enum).toEqual([...VOUCHER_LINE_VAT_RATES])
    expect(vatCode.required).toEqual(['kind', 'rate'])
    expect(createVoucher.description).toContain('vat_code')
  })

  it('stages the expanded verifikat: the preview is what posts', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // company_settings: dimensions off, the P001 tag passes through
    enqueue({ data: PERIOD }) // fiscal_periods (explicit id)
    enqueue({ data: [] }) // chart_of_accounts momskoder: none configured
    enqueue({
      data: [
        { account_number: '6540', account_name: 'IT-tjänster', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
    }) // chart_of_accounts: the account gate over every line, generated ones too
    enqueue({ data: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-rc' } }) // pending_operations insert

    const result = (await createVoucher.execute(PURCHASE, 'company-1', 'user-1', supabase as never)) as {
      staged: boolean
      preview: {
        total_debit: number
        total_credit: number
        line_count: number
        lines: Array<StagedLine & { account_name: string | null }>
        will_activate_accounts?: string[]
      }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6540', 1000, 0],
      ['2645', 250, 0],
      ['2614', 0, 250],
      ['4531', 1000, 0],
      ['4598', 0, 1000],
      ['1930', 0, 1000],
    ])
    expect([result.preview.total_debit, result.preview.total_credit, result.preview.line_count]).toEqual([2250, 2250, 6])
    // The generated accounts are not in this chart yet: BAS accounts the engine seeds at commit.
    expect(result.preview.will_activate_accounts).toEqual(['2645', '2614', '4531', '4598'])
    expect(result.preview.lines.every((l) => l.account_name)).toBe(true)

    // The kontoplan's momskoder were read for the code, and the account gate saw every line.
    expect(findCalls('chart_of_accounts', 'select').map(([columns]) => columns)).toEqual([
      'account_number, default_vat_treatment, default_vat_rate',
      'account_number, account_name, is_active',
    ])
    expect(findCalls('chart_of_accounts', 'in')[1]).toEqual(['account_number', ['6540', '2645', '2614', '4531', '4598', '1930']])

    // Staged as plain lines: the typed line keeps its dimensions, the generated ones carry none.
    const [insert] = findCall('pending_operations', 'insert') as [{ params: { lines: StagedLine[] } }]
    const staged = insert.params.lines
    expect(staged.map((l) => l.account_number)).toEqual(['6540', '2645', '2614', '4531', '4598', '1930'])
    expect(staged[0].dimensions).toEqual({ '6': 'P001' })
    expect(staged.slice(1, 5).every((l) => l.dimensions === undefined)).toBe(true)
    expect(staged.every((l) => !('vat_code' in l))).toBe(true)
  })

  it('refuses a code on an account that takes none before staging anything', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: [] })

    const err = await createVoucher
      .execute(
        {
          ...PURCHASE,
          lines: [
            { account_number: '6540', debit_amount: 1000 },
            { account_number: '1930', credit_amount: 1000, vat_code: NON_EU_25 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      )
      .catch((e: unknown) => e) as ToolError

    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toContain('lines.1.vat_code: Account 1930 takes no vat_code')
    expect(err.issues).toEqual([{ field: 'lines.1.vat_code', message: expect.stringContaining('Konto 1930 kan inte ha en momskod') }])
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a code beside hand-typed fiktiv moms, as the form does', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: [] })

    await expect(
      createVoucher.execute(
        {
          ...PURCHASE,
          lines: [
            { account_number: '6540', debit_amount: 1000, vat_code: NON_EU_25 },
            { account_number: '2645', debit_amount: 250 },
            { account_number: '2614', credit_amount: 250 },
            { account_number: '1930', credit_amount: 1000 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/lines\.0\.vat_code: The vat_code creates 2614, 2645 itself/)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a code whose basis account the kontoplan sets to another ruta, before staging anything', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    // The kontoplan reports 4531, the BAS basis account for tjänst utanför EU, in ruta 21.
    enqueue({ data: [{ account_number: '4531', default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0.25 }] })

    const err = await createVoucher
      .execute(
        {
          ...PURCHASE,
          lines: [
            { account_number: '6540', debit_amount: 1000, vat_code: NON_EU_25 },
            { account_number: '1930', credit_amount: 1000 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      )
      .catch((e: unknown) => e) as ToolError

    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toContain('lines.0.vat_code: The vat_code books its basis on 4531')
    expect(err.issues).toEqual([
      { field: 'lines.0.vat_code', message: expect.stringContaining('redovisar ruta 21 med 25 %, inte ruta 22 med 25 %') },
    ])
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('refuses a percent-shaped rate with the v1 schema\'s own message, before any read', async () => {
    const { supabase } = createQueuedMockSupabase()

    const err = await createVoucher
      .execute(
        {
          ...PURCHASE,
          lines: [
            { account_number: '6540', debit_amount: 1000, vat_code: { kind: 'non_eu_services', rate: 25 } },
            { account_number: '1930', credit_amount: 1000 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      )
      .catch((e: unknown) => e) as ToolError

    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toContain('lines.0.vat_code.rate: rate måste vara ett decimaltal, inte procent: 0.25, 0.12 eller 0.06')
    // message_sv carries the hint too, not a generic "Ogiltigt värde.".
    expect(err.issues).toEqual([
      { field: 'lines.0.vat_code.rate', message: 'rate måste vara ett decimaltal, inte procent: 0.25, 0.12 eller 0.06' },
    ])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('refuses a vat_code without a rate as a missing field, with no percent hint', async () => {
    const { supabase } = createQueuedMockSupabase()

    const err = await createVoucher
      .execute(
        {
          ...PURCHASE,
          lines: [
            { account_number: '6540', debit_amount: 1000, vat_code: { kind: 'non_eu_services' } },
            { account_number: '1930', credit_amount: 1000 },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
      )
      .catch((e: unknown) => e) as ToolError

    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.issues).toEqual([{ field: 'lines.0.vat_code.rate', message: 'rate krävs: 0.25, 0.12 eller 0.06' }])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('reads no momskoder when no line carries a vat_code', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({
      data: [
        { account_number: '4531', account_name: 'Inköp av tjänster från land utanför EU', is_active: true },
        { account_number: '1930', account_name: 'Företagskonto', is_active: true },
      ],
    })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'op-plain' } })

    const result = (await createVoucher.execute(
      {
        ...PURCHASE,
        lines: [
          { account_number: '4531', debit_amount: 1000 },
          { account_number: '1930', credit_amount: 1000 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: { lines: StagedLine[] } }

    // Explicit only: 4531 gets no fiktiv moms of its own, unlike the form.
    expect(result.preview.lines.map((l) => l.account_number)).toEqual(['4531', '1930'])
    expect(findCalls('chart_of_accounts', 'select').map(([columns]) => columns)).toEqual([
      'account_number, account_name, is_active',
    ])
  })
})
