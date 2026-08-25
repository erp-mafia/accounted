import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, InvoiceItem } from '@/types'
import { makeInvoice, createQueuedMockSupabase } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import { listRotRutCandidates } from '@/lib/invoices/rot-rut-service'

/**
 * listRotRutCandidates: the begäran-dialog list must never drop an invoice
 * silently (#1884). Each of the four historical drop paths lands in blocked
 * with a reason, or in eligible where the drop was wrong to begin with:
 *   1. deduction lines without a header deduction_total  → DEDUCTION_TOTAL_MISSING
 *   2. partially_paid with the customer share settled    → eligible
 *   3. deduction of the other type                       → NO_DEDUCTION_OF_TYPE (kept, with pointer)
 *   4. held by an in-flight begäran                      → ALREADY_REQUESTED
 */

// Synthetic test identity from Skatteverket's official example files.
const PNR = '198406012388'
const TODAY = '2026-07-02'

function makeRotItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    description: 'Arbete',
    quantity: 1,
    unit: 'tim',
    unit_price: 10000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    deduction_type: 'rot',
    deduction_amount: 3000,
    labor_hours: 25,
    work_type: 'BYGG',
    housing_designation: 'Stockholm Vasastan 1:23',
    apartment_number: null,
    brf_org_number: null,
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

type Row = Omit<Invoice, 'customer'> & {
  customer?: { id: string; name: string | null } | null
}

function makeRotRow(overrides: Partial<Row> = {}, items?: InvoiceItem[]): Row {
  return {
    ...makeInvoice({
      status: 'paid',
      paid_at: '2026-06-20T10:00:00Z',
      deduction_total: 3000,
      deduction_personnummer_encrypted: encryptPersonnummer(PNR),
      deduction_personnummer_last4: PNR.slice(-4),
      items: items ?? [makeRotItem()],
    }),
    customer: { id: 'customer-1', name: 'Kund AB' },
    ...overrides,
  }
}

function makeRutRow(overrides: Partial<Row> = {}): Row {
  return makeRotRow(
    { deduction_total: 6250, ...overrides },
    [
      makeRotItem({
        deduction_type: 'rut',
        work_type: 'STAD',
        deduction_amount: 6250,
        labor_hours: 10,
        housing_designation: null,
      }),
    ],
  )
}

type ActiveItemRow = {
  invoice_id: string
  request: { id: string; name: string | null; status: string; company_id: string }
}

function activeItem(invoiceId: string, status: string, name = 'ROT 2026-01-15'): ActiveItemRow {
  return {
    invoice_id: invoiceId,
    request: { id: 'request-1', name, status, company_id: 'company-1' },
  }
}

/** Queue the three queries the service runs: byHeader, byLines, activeItems. */
function mockedSupabase(
  byHeader: Row[],
  byLines: Row[],
  active: ActiveItemRow[],
): SupabaseClient {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  enqueueMany([{ data: byHeader }, { data: byLines }, { data: active }])
  return supabase as unknown as SupabaseClient
}

describe('listRotRutCandidates', () => {
  it('lists a paid rot invoice as eligible with the file amounts', async () => {
    const invoice = makeRotRow()
    const result = await listRotRutCandidates(mockedSupabase([invoice], [invoice], []), 'company-1', 'rot', TODAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked).toHaveLength(0)
    expect(result.eligible).toHaveLength(1)
    expect(result.eligible[0]).toMatchObject({
      invoice_id: invoice.id,
      customer_name: 'Kund AB',
      personnummer_last4: PNR.slice(-4),
      betalnings_datum: '2026-06-20',
      pris_for_arbete: 12500,
      begart_belopp: 3000,
    })
  })

  it('keeps a paid RUT invoice visible under rot as blocked with a pointer to RUT', async () => {
    // Drop path 3: NO_DEDUCTION_OF_TYPE used to be filtered out entirely, so
    // the ROT view (the dialog default) showed nothing at all.
    const invoice = makeRutRow()
    const result = await listRotRutCandidates(mockedSupabase([invoice], [invoice], []), 'company-1', 'rot', TODAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible).toHaveLength(0)
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0].code).toBe('NO_DEDUCTION_OF_TYPE')
    expect(result.blocked[0].message).toContain('RUT')
  })

  it('lists the same RUT invoice as eligible under rut', async () => {
    const invoice = makeRutRow()
    const result = await listRotRutCandidates(mockedSupabase([invoice], [invoice], []), 'company-1', 'rut', TODAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked).toHaveLength(0)
    expect(result.eligible).toHaveLength(1)
    expect(result.eligible[0].begart_belopp).toBe(6250)
  })

  it('accepts partially_paid with remaining 0 and blocks a genuine partial with the amount', async () => {
    // Drop path 2: the customer paid their share but the status never
    // flipped to paid (older settlement paths). remaining_amount decides.
    const settled = makeRotRow({ id: 'inv-settled', status: 'partially_paid', remaining_amount: 0, paid_amount: 9500 })
    const partial = makeRotRow({ id: 'inv-partial', status: 'partially_paid', remaining_amount: 4000, paid_amount: 5500 })
    const result = await listRotRutCandidates(
      mockedSupabase([settled, partial], [], []),
      'company-1',
      'rot',
      TODAY,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible.map((e) => e.invoice_id)).toEqual(['inv-settled'])
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0]).toMatchObject({ invoice_id: 'inv-partial', code: 'NOT_PAID' })
    expect(result.blocked[0].message).toContain('delbetald')
  })

  it('surfaces header-less deduction invoices from the line query as DEDUCTION_TOTAL_MISSING', async () => {
    // Drop path 1: deduction lines but deduction_total NULL/0 on the header.
    // The old query filtered on deduction_total > 0, so these never appeared.
    const invoice = makeRotRow({ deduction_total: 0 })
    const result = await listRotRutCandidates(mockedSupabase([], [invoice], []), 'company-1', 'rot', TODAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible).toHaveLength(0)
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0].code).toBe('DEDUCTION_TOTAL_MISSING')
  })

  it('blocks an invoice held by a generated begäran as ALREADY_REQUESTED, naming the request', async () => {
    // Drop path 4: generated-but-never-uploaded requests silently consumed
    // the invoice.
    const invoice = makeRotRow()
    const result = await listRotRutCandidates(
      mockedSupabase([invoice], [invoice], [activeItem(invoice.id, 'generated')]),
      'company-1',
      'rot',
      TODAY,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible).toHaveLength(0)
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0].code).toBe('ALREADY_REQUESTED')
    expect(result.blocked[0].message).toContain('ROT 2026-01-15')
    expect(result.blocked[0].message).toContain('inte uppladdad')
  })

  it('says a submitted begäran awaits Skatteverket instead of suggesting cancellation', async () => {
    const invoice = makeRotRow()
    const result = await listRotRutCandidates(
      mockedSupabase([invoice], [invoice], [activeItem(invoice.id, 'submitted')]),
      'company-1',
      'rot',
      TODAY,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0].code).toBe('ALREADY_REQUESTED')
    expect(result.blocked[0].message).toContain('väntar på Skatteverkets beslut')
    expect(result.blocked[0].message).not.toContain('avbryt')
  })

  it('omits invoices whose begäran is decided: finished business, not a drop-out', async () => {
    const invoice = makeRotRow()
    const result = await listRotRutCandidates(
      mockedSupabase([invoice], [invoice], [activeItem(invoice.id, 'paid')]),
      'company-1',
      'rot',
      TODAY,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible).toHaveLength(0)
    expect(result.blocked).toHaveLength(0)
  })

  it('omits decided invoices of the OTHER type too: no eternal wrong-type pointer', async () => {
    // A rut invoice whose begäran was decided years ago must not resurface
    // forever as NO_DEDUCTION_OF_TYPE under the rot view: decided means
    // finished on every tab (skeptic finding on #1884).
    const invoice = makeRutRow()
    const result = await listRotRutCandidates(
      mockedSupabase([invoice], [invoice], [activeItem(invoice.id, 'paid', 'RUT gammal')]),
      'company-1',
      'rot',
      TODAY,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible).toHaveLength(0)
    expect(result.blocked).toHaveLength(0)
  })

  it('lets the other-type pointer win over ALREADY_REQUESTED under the wrong type', async () => {
    const invoice = makeRutRow()
    const result = await listRotRutCandidates(
      mockedSupabase([invoice], [invoice], [activeItem(invoice.id, 'generated', 'RUT jan')]),
      'company-1',
      'rot',
      TODAY,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0].code).toBe('NO_DEDUCTION_OF_TYPE')
  })

  it('merges the header and line queries without duplicating an invoice', async () => {
    const invoice = makeRotRow()
    const result = await listRotRutCandidates(mockedSupabase([invoice], [invoice], []), 'company-1', 'rot', TODAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible).toHaveLength(1)
    expect(result.blocked).toHaveLength(0)
  })

  it('orders merged candidates by payment date', async () => {
    const older = makeRotRow({ id: 'inv-old', paid_at: '2026-03-01T10:00:00Z' })
    const newer = makeRotRow({ id: 'inv-new', paid_at: '2026-06-20T10:00:00Z' })
    // The header query returns the newer one, the line query the older one:
    // the merged list must still come out oldest first.
    const result = await listRotRutCandidates(mockedSupabase([newer], [older], []), 'company-1', 'rot', TODAY)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.eligible.map((e) => e.invoice_id)).toEqual(['inv-old', 'inv-new'])
  })

  it('propagates a database error', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: null, error: { message: 'boom' } }])
    const result = await listRotRutCandidates(
      supabase as unknown as SupabaseClient,
      'company-1',
      'rot',
      TODAY,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.dbError).toMatchObject({ message: 'boom' })
  })
})
