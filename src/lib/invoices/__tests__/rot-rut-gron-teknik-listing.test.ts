import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, InvoiceItem } from '@/types'
import { makeInvoice, createQueuedMockSupabase } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { buildRotRutFile, evaluateInvoiceForFile } from '@/lib/invoices/rot-rut-file'
import { listGronTeknikCandidates, listRotRutCandidates } from '@/lib/invoices/rot-rut-service'

/**
 * The /invoices/rot-rut surfaces and grön teknik: a grön teknik invoice is
 * listed honestly on its own list, with the figures Skatteverkets e-tjänst
 * asks for, and never enters a HUS (ROT/RUT) file. ROT/RUT listings count it
 * instead of repeating a pointer row per invoice.
 */

// Synthetic test identity from Skatteverket's official example files.
const PNR = '198406012388'
// Encrypted once: every encrypt runs scrypt, and the paging test builds
// more than a thousand rows.
const PNR_ENCRYPTED = encryptPersonnummer(PNR)
const TODAY = '2026-09-30'

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Solceller med montage',
    quantity: 1,
    unit: 'st',
    unit_price: 40000,
    line_total: 40000,
    vat_rate: 25,
    vat_amount: 10000,
    deduction_type: 'gron_teknik',
    deduction_amount: 7500,
    labor_hours: 16,
    work_type: 'INSTALLATION_SOLCELLER',
    housing_designation: 'Exempelby 1:1',
    apartment_number: null,
    brf_org_number: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

type Row = Omit<Invoice, 'customer'> & { customer?: { id: string; name: string | null } | null }

function row(id: string, items: InvoiceItem[], overrides: Partial<Row> = {}): Row {
  return {
    ...makeInvoice({
      id,
      status: 'paid',
      paid_at: '2026-09-20T10:00:00Z',
      deduction_total: items.reduce((sum, i) => sum + (i.deduction_amount ?? 0), 0),
      deduction_personnummer_encrypted: PNR_ENCRYPTED,
      deduction_personnummer_last4: PNR.slice(-4),
      items: items.map((i) => ({ ...i, invoice_id: id })),
    }),
    customer: { id: 'customer-1', name: 'Kund' },
    ...overrides,
  }
}

const gron = (id = 'inv-gron') => row(id, [item()])
const rot = (id = 'inv-rot') =>
  row(id, [item({ deduction_type: 'rot', work_type: 'EL', unit_price: 10000, line_total: 10000, vat_amount: 2500, deduction_amount: 3750 })])

/** Queue the three queries the listing runs: byHeader, byLines, activeItems. */
function mockedSupabase(invoices: Row[]): SupabaseClient {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  enqueueMany([{ data: invoices }, { data: invoices }, { data: [] }])
  return supabase as unknown as SupabaseClient
}

describe('HUS file: a grön teknik invoice never enters it', () => {
  it('evaluating a grön teknik invoice as ROT or RUT points at the grön teknik e-tjänst', () => {
    for (const type of ['rot', 'rut'] as const) {
      const result = evaluateInvoiceForFile(type, gron() as Invoice, { today: TODAY })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.blocker.code).toBe('NO_DEDUCTION_OF_TYPE')
      expect(result.blocker.message).toContain('e-tjänst för grön teknik')
    }
  })

  it('buildRotRutFile produces no file for grön teknik invoices, even alongside a ROT one', () => {
    const onlyGron = buildRotRutFile({ type: 'rot', name: 'ROT', invoices: [gron() as Invoice], today: TODAY })
    expect(onlyGron.xml).toBeNull()
    expect(onlyGron.arenden).toEqual([])

    const both = buildRotRutFile({ type: 'rot', name: 'ROT', invoices: [gron() as Invoice, rot() as Invoice], today: TODAY })
    expect(both.arenden.map((a) => a.invoice_id)).toEqual(['inv-rot'])
    expect(both.blockers.map((b) => b.invoice_id)).toEqual(['inv-gron'])
    expect(both.xml).not.toContain('INSTALLATION')
  })

  it('an invoice mixing ROT and grön teknik is blocked as mixed, naming grön teknik', () => {
    const mixed = row('inv-mixed', [item({ deduction_type: 'rot', work_type: 'EL' }), item({ id: 'item-2' })])
    const result = evaluateInvoiceForFile('rot', mixed as Invoice, { today: TODAY })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.blocker.code).toBe('MIXED_DEDUCTION_TYPES')
    expect(result.blocker.message).toContain('grön teknik')
  })

  it('keeps the ROT/RUT pointer text unchanged', () => {
    const result = evaluateInvoiceForFile('rut', rot() as Invoice, { today: TODAY })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.blocker.message).toBe('Fakturans avdrag är ROT: fakturan hanteras under ROT, inte RUT.')
  })
})

describe('listRotRutCandidates: grön teknik is counted, not listed', () => {
  it('a ROT list counts grön teknik invoices in other_type_counts and never lists them', async () => {
    const result = await listRotRutCandidates(mockedSupabase([gron(), rot(), gron('inv-gron-2')]), 'company-1', 'rot', TODAY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible.map((e) => e.invoice_id)).toEqual(['inv-rot'])
    expect(result.blocked).toEqual([])
    expect(result.other_type_counts).toEqual({ gron_teknik: 2 })
  })
})

describe('listGronTeknikCandidates', () => {
  it('lists a paid grön teknik invoice with the e-tjänst figures and counts ROT/RUT invoices', async () => {
    const result = await listGronTeknikCandidates(mockedSupabase([gron(), rot()]), 'company-1', TODAY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked).toEqual([])
    expect(result.other_type_counts).toEqual({ rot: 1 })
    expect(result.eligible).toHaveLength(1)
    expect(result.eligible[0]).toMatchObject({
      invoice_id: 'inv-gron',
      customer_name: 'Kund',
      personnummer_last4: PNR.slice(-4),
      betalnings_datum: '2026-09-20',
      begart_belopp: 7500,
      ovrig_kostnad: 0,
    })
    expect(result.eligible[0].installations).toEqual([
      {
        work_type: 'INSTALLATION_SOLCELLER',
        label: 'Installation av solceller',
        antal_timmar: 16,
        kostnad: 50000,
        begart_belopp: 7500,
        betalt_belopp: 42500,
      },
    ])
  })

  it('shows why an invoice cannot be requested yet', async () => {
    const unpaid = row('inv-unpaid', [item()], { status: 'partially_paid', paid_at: null, paid_amount: 1000, total: 50000 })
    const noProperty = row('inv-no-property', [item({ housing_designation: null })])
    const noHours = row('inv-no-hours', [item({ labor_hours: null })])
    const noPnr = row('inv-no-pnr', [item()], { deduction_personnummer_encrypted: null })
    const result = await listGronTeknikCandidates(
      mockedSupabase([unpaid, noProperty, noHours, noPnr]),
      'company-1',
      TODAY,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible).toEqual([])
    expect(Object.fromEntries(result.blocked.map((b) => [b.invoice_id, b.code]))).toEqual({
      'inv-unpaid': 'NOT_PAID',
      'inv-no-property': 'MISSING_PROPERTY',
      'inv-no-hours': 'MISSING_HOURS',
      'inv-no-pnr': 'MISSING_PERSONNUMMER',
    })
  })

  it('surfaces a database error instead of an empty list', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: null, error: { message: 'boom' } }])
    const result = await listGronTeknikCandidates(supabase as unknown as SupabaseClient, 'company-1', TODAY)
    expect(result.ok).toBe(false)
  })
})

describe('listGronTeknikCandidates: order and what a row carries', () => {
  it('lists the newest payment first, so the next e-tjänst entry is on top', async () => {
    const older = row('inv-older', [item()], { paid_at: '2026-03-02T10:00:00Z' })
    const newer = row('inv-newer', [item()], { paid_at: '2026-09-02T10:00:00Z' })
    const middle = row('inv-middle', [item()], { paid_at: '2026-06-02T10:00:00Z' })
    const result = await listGronTeknikCandidates(mockedSupabase([older, middle, newer]), 'company-1', TODAY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible.map((e) => e.invoice_id)).toEqual(['inv-newer', 'inv-middle', 'inv-older'])
  })

  it('carries the property the e-tjänst asks for', async () => {
    const brf = row('inv-brf', [item({ housing_designation: null, apartment_number: '1201', brf_org_number: '769600-1234' })])
    const result = await listGronTeknikCandidates(mockedSupabase([gron(), brf]), 'company-1', TODAY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byId = Object.fromEntries(result.eligible.map((e) => [e.invoice_id, e.property]))
    expect(byId['inv-gron']).toEqual({ fastighet: 'Exempelby 1:1' })
    expect(byId['inv-brf']).toEqual({ lagenhetsNr: '1201', brfOrgNr: '167696001234' })
  })
})

describe('listGronTeknikCandidates: the request window', () => {
  it('marks an invoice paid before last year as past the 31 January deadline', async () => {
    const late = row('inv-2024', [item()], { paid_at: '2024-11-20T10:00:00Z' })
    const lastYear = row('inv-2025', [item()], { paid_at: '2025-12-20T10:00:00Z' })
    const thisYear = row('inv-2026', [item()], { paid_at: '2026-01-10T10:00:00Z' })
    const inJanuary = await listGronTeknikCandidates(mockedSupabase([late, lastYear, thisYear]), 'company-1', '2026-01-31')
    const inFebruary = await listGronTeknikCandidates(mockedSupabase([late, lastYear, thisYear]), 'company-1', '2026-02-01')
    expect(inJanuary.ok && inFebruary.ok).toBe(true)
    if (!inJanuary.ok || !inFebruary.ok) return
    const pastOn = (list: typeof inJanuary.eligible) => Object.fromEntries(list.map((e) => [e.invoice_id, e.past_deadline]))
    expect(pastOn(inJanuary.eligible)).toEqual({ 'inv-2024': true, 'inv-2025': false, 'inv-2026': false })
    expect(pastOn(inFebruary.eligible)).toEqual({ 'inv-2024': true, 'inv-2025': true, 'inv-2026': false })
  })
})

describe('paging: the newest paid invoices are never cut off at 1000 rows', () => {
  // A company past 1000 paid deduction invoices. The first page is full of
  // old invoices whose begäran is already decided (both lists skip them
  // before any evaluation); the second page holds one more decided invoice
  // and the two newest paid invoices, the ones still to request. The
  // begäran read pages too: the decided request of the 1001st old invoice
  // sits on its second page.
  const OLD_COUNT = 1001
  const oldInvoices: Row[] = Array.from({ length: OLD_COUNT }, (_, i) => {
    const id = `old-${String(i).padStart(4, '0')}`
    return i % 2 === 0
      ? row(id, [item()], { paid_at: '2026-01-15T10:00:00Z' })
      : row(id, [item({ deduction_type: 'rot', work_type: 'EL', deduction_amount: 3750 })], { paid_at: '2026-01-15T10:00:00Z' })
  })
  const decidedItems = oldInvoices.map((invoice, i) => ({
    id: `item-${String(i).padStart(4, '0')}`,
    invoice_id: invoice.id,
    request: { id: `request-${i}`, name: 'Begäran', status: 'paid', company_id: 'company-1' },
  }))
  const newestGron = gron('inv-gron-newest')
  const newestRot = rot('inv-rot-newest')

  function pagedSupabase() {
    const mock = createQueuedMockSupabase()
    const invoicePages = [
      { data: oldInvoices.slice(0, 1000) },
      { data: [...oldInvoices.slice(1000), newestGron, newestRot] },
    ]
    mock.enqueueMany([
      ...invoicePages, // by header total
      ...invoicePages, // by deduction lines
      { data: decidedItems.slice(0, 1000) },
      { data: decidedItems.slice(1000) },
    ])
    return mock
  }

  it('lists the newest grön teknik invoice and still skips every decided one', async () => {
    const mock = pagedSupabase()
    const result = await listGronTeknikCandidates(mock.supabase as unknown as SupabaseClient, 'company-1', TODAY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible.map((e) => e.invoice_id)).toEqual(['inv-gron-newest'])
    expect(result.blocked).toEqual([])
    expect(result.other_type_counts).toEqual({ rot: 1 })
  })

  it('lists the newest ROT invoice on the ROT list and counts the newest grön teknik one', async () => {
    const mock = pagedSupabase()
    const result = await listRotRutCandidates(mock.supabase as unknown as SupabaseClient, 'company-1', 'rot', TODAY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible.map((e) => e.invoice_id)).toEqual(['inv-rot-newest'])
    expect(result.blocked).toEqual([])
    expect(result.other_type_counts).toEqual({ gron_teknik: 1 })
  })

  it('pages every read on a stable total order', async () => {
    const mock = pagedSupabase()
    await listGronTeknikCandidates(mock.supabase as unknown as SupabaseClient, 'company-1', TODAY)
    expect(mock.findCalls('invoices', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
      [0, 999],
      [1000, 1999],
    ])
    expect(mock.findCalls('rot_rut_payout_request_items', 'range')).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    for (const table of ['invoices', 'rot_rut_payout_request_items']) {
      expect(mock.findCalls(table, 'order')).toContainEqual(['id', { ascending: true }])
    }
  })
})
