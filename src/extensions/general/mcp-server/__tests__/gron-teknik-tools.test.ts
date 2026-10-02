import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

/**
 * The MCP surface with grön teknik (crm#209, #3135): update_invoice stages
 * grön teknik lines and refuses at staging what the write path would refuse
 * at approval; the HUS file tool stays ROT/RUT and says where grön teknik is
 * requested; the payout-request list accepts the kind.
 */

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const tool = (name: string) => tools.find((candidate) => candidate.name === name)!

function draftInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: null,
    status: 'draft',
    document_type: 'invoice',
    journal_entry_id: null,
    is_self_billed: false,
    credited_invoice_id: null,
    total: 125000,
    currency: 'SEK',
    customer_id: CUSTOMER_ID,
    customer: { name: 'Kund' },
    deduction_personnummer_encrypted: 'CIPHERTEXT',
    ...overrides,
  }
}

const CUSTOMER = { customer_type: 'individual', vat_number_validated: false }

const LABOUR = {
  description: 'Montage batterilager',
  quantity: 8,
  unit: 'tim',
  unit_price: 750,
  vat_rate: 25,
  deduction_type: 'gron_teknik',
  labor_hours: 8,
  work_type: 'INSTALLATION_LAGRING',
  housing_designation: 'Exempelby 1:1',
  apartment_number: null,
  brf_org_number: null,
}
const BATTERY = { ...LABOUR, description: 'Batteri 10 kWh', quantity: 1, unit: 'st', unit_price: 90000, labor_hours: null }

type StagedResult = {
  staged: boolean
  preview: { items?: Array<Record<string, unknown>>; changes?: { items?: Array<Record<string, unknown>> } }
}

describe('gnubok_update_invoice: grön teknik', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stages labour and material rows of one installation, hours on the labour row only', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    enqueue({ data: [] }) // current rows snapshot
    enqueue({ data: { id: 'op-1' } })

    const result = (await tool('gnubok_update_invoice').execute(
      { invoice_id: INVOICE_ID, items: [LABOUR, BATTERY] },
      'company-1',
      'user-1',
      supabase as never,
    )) as StagedResult

    expect(result.staged).toBe(true)
    expect(result.preview.changes?.items?.map((i) => [i.deduction_type, i.work_type, i.labor_hours])).toEqual([
      ['gron_teknik', 'INSTALLATION_LAGRING', 8],
      ['gron_teknik', 'INSTALLATION_LAGRING', null],
    ])
    expect(JSON.stringify(result)).not.toContain('CIPHERTEXT')
  })

  it('fails at staging when the grön teknik set names no property', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })

    await expect(
      tool('gnubok_update_invoice').execute(
        { invoice_id: INVOICE_ID, items: [{ ...LABOUR, housing_designation: null }] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
      message: expect.stringMatching(/grön teknik.*housing_designation/),
    })
    expect(supabase.from).not.toHaveBeenCalledWith('pending_operations')
  })

  it('fails at staging when an installation type has no hours on any row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })

    await expect(
      tool('gnubok_update_invoice').execute(
        { invoice_id: INVOICE_ID, items: [BATTERY] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
      message: expect.stringContaining('minst en rad per typ av installation'),
    })
  })

  it('fails at staging when grön teknik and ROT share the invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: draftInvoice() })
    enqueue({ data: CUSTOMER })
    const rot = { ...LABOUR, deduction_type: 'rot', work_type: 'EL' }

    await expect(
      tool('gnubok_update_invoice').execute(
        { invoice_id: INVOICE_ID, items: [LABOUR, rot] },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
      message: expect.stringContaining('kan inte kombineras med ROT- eller RUT-rader'),
    })
  })

  it('documents gron_teknik on the round-trip line shape', () => {
    const items = (tool('gnubok_update_invoice').inputSchema.properties as Record<string, unknown>).items as {
      items: { properties: Record<string, { description?: string }> }
    }
    expect(items.items.properties.deduction_type.description).toContain('gron_teknik')
    expect(items.items.properties.housing_designation.description).toContain('gron_teknik')
  })
})

describe('gnubok_generate_rot_rut_file stays a ROT/RUT (HUS) file', () => {
  it('keeps its enum to rot and rut', () => {
    const schema = (tool('gnubok_generate_rot_rut_file').inputSchema.properties as Record<string, unknown>)
      .deduction_type as { enum: string[] }
    expect(schema.enum).toEqual(['rot', 'rut'])
  })

  it('refuses gron_teknik with a pointer to the e-tjänst, before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool('gnubok_generate_rot_rut_file').execute({ deduction_type: 'gron_teknik' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/e-tjänst for grön teknik/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('reports grön teknik invoices as other_type_counts when listing ROT', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    const gron = {
      id: 'inv-1',
      invoice_number: '7',
      status: 'paid',
      paid_at: '2026-09-20T10:00:00Z',
      deduction_total: 10000,
      items: [{ id: 'i', invoice_id: 'inv-1', line_type: 'product', deduction_type: 'gron_teknik', work_type: 'INSTALLATION_LADDPUNKT' }],
    }
    enqueueMany([{ data: [gron] }, { data: [] }, { data: [] }])
    const result = (await tool('gnubok_generate_rot_rut_file').execute(
      { deduction_type: 'rot', list_only: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { eligible: unknown[]; blocked: unknown[]; other_type_counts: Record<string, number> }
    expect(result.eligible).toEqual([])
    expect(result.blocked).toEqual([])
    expect(result.other_type_counts).toEqual({ gron_teknik: 1 })
  })
})

describe('gnubok_list_rot_rut_payout_requests accepts gron_teknik', () => {
  it('declares the kind in its input enum and filters on it', async () => {
    const listTool = tool('gnubok_list_rot_rut_payout_requests')
    const input = (listTool.inputSchema.properties as Record<string, unknown>).deduction_type as { enum: string[] }
    expect(input.enum).toEqual(['rot', 'rut', 'gron_teknik'])

    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [], count: 0 })
    await listTool.execute({ deduction_type: 'gron_teknik' }, 'company-1', 'user-1', supabase as never)
    expect(findCalls('rot_rut_payout_requests', 'eq')).toContainEqual(['deduction_type', 'gron_teknik'])
  })
})
