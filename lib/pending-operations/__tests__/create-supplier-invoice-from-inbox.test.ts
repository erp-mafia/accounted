/**
 * Unit tests for commitCreateSupplierInvoiceFromInbox: driven through the
 * public commitPendingOperation dispatcher (the executor itself is module-
 * private).
 *
 * Covers: happy path (accrual), idempotent re-commit on already-linked inbox,
 * missing inbox / supplier, duplicate invoice number, cash method skipping
 * the registration JE, and items-insert rollback of the parent invoice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, makeJournalEntry, makeSupplierInvoice } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>(
    '@/lib/bookkeeping/supplier-invoice-entries'
  )
  return {
    ...actual,
    createSupplierInvoiceRegistrationEntry: vi.fn(),
  }
})

vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service'
  )
  return {
    ...actual,
    linkToJournalEntry: vi.fn(),
  }
})

import { commitPendingOperation } from '../commit'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'

function makePendingOp(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_supplier_invoice_from_inbox',
    status: 'pending',
    title: 'test',
    params: {
      inbox_item_id: 'inbox-1',
      supplier_id: 'supplier-1',
      document_id: 'doc-1',
      supplier_invoice_number: 'INV-100',
      invoice_date: '2026-05-15',
      due_date: '2026-06-14',
      currency: 'SEK',
      exchange_rate: null,
      vat_treatment: 'standard_25',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      notes: null,
      items: [
        {
          line_number: 1,
          description: 'Konsulttjänst',
          quantity: 1,
          unit: 'st',
          unit_price: 1000,
          line_total: 1000,
          account_number: '6530',
          vat_rate: 0.25,
          vat_amount: 250,
        },
      ],
    },
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-15T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-15T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_supplier_invoice_from_inbox', () => {
  it('happy path (accrual): inserts invoice + items + JE, links document, marks inbox confirmed', async () => {
    vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-100', voucher_number: 7, voucher_series: 'L' })
    )
    vi.mocked(linkToJournalEntry).mockResolvedValueOnce({
      id: 'doc-1',
      journal_entry_id: 'je-100',
    } as never)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // dispatcher CAS claim
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    }) // inbox fetch
    enqueue({
      data: { id: 'supplier-1', name: 'Acme AB', supplier_type: 'swedish_business' },
      error: null,
    }) // supplier fetch
    enqueue({ data: 42, error: null }) // get_next_arrival_number RPC
    enqueue({
      data: makeSupplierInvoice({ id: 'inv-1', supplier_invoice_number: 'INV-100' }),
      error: null,
    }) // supplier_invoices insert
    enqueue({ data: null, error: null }) // supplier_invoice_items insert
    enqueue({ data: { accounting_method: 'accrual' }, error: null }) // company_settings
    enqueue({ data: null, error: null }) // supplier_invoices update with JE id
    enqueue({ data: null, error: null }) // invoice_inbox_items update
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      supplier_invoice_id: 'inv-1',
      inbox_item_id: 'inbox-1',
      registration_journal_entry_id: 'je-100',
      arrival_number: 42,
    })
    expect(createSupplierInvoiceRegistrationEntry).toHaveBeenCalledTimes(1)
    expect(linkToJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'doc-1',
      'je-100',
    )
  })

  it('idempotency: re-fired commit on an already-converted inbox returns the existing invoice without rework', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: 'inv-existing', status: 'confirmed' },
      error: null,
    }) // inbox already linked
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      supplier_invoice_id: 'inv-existing',
      idempotent: true,
    })
    expect(createSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 404 when the inbox item does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: { message: 'not found' } }) // inbox fetch: empty
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
    expect(result.error).toMatch(/Inbox item not found/)
    expect(createSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('returns 404 when the supplier no longer exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    })
    enqueue({ data: null, error: { message: 'not found' } }) // supplier fetch: empty
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
    expect(result.error).toMatch(/Supplier not found/)
  })

  it('returns 409 with Swedish message on duplicate invoice number (PG 23505)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    })
    enqueue({
      data: { id: 'supplier-1', name: 'Acme AB', supplier_type: 'swedish_business' },
      error: null,
    })
    enqueue({ data: 42, error: null }) // arrival number
    enqueue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    }) // invoice insert fails
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/finns redan registrerad/)
  })

  it('skips the registration JE and document link for cash-method companies', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    })
    enqueue({
      data: { id: 'supplier-1', name: 'Acme AB', supplier_type: 'swedish_business' },
      error: null,
    })
    enqueue({ data: 42, error: null }) // arrival number
    enqueue({
      data: makeSupplierInvoice({ id: 'inv-cash', supplier_invoice_number: 'INV-100' }),
      error: null,
    }) // invoice insert
    enqueue({ data: null, error: null }) // items insert
    enqueue({ data: { accounting_method: 'cash' }, error: null }) // company_settings → cash
    enqueue({ data: null, error: null }) // invoice_inbox_items update
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      supplier_invoice_id: 'inv-cash',
      registration_journal_entry_id: null,
    })
    expect(createSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('persists document_id on the supplier_invoices row (so it can carry to the payment verifikat under cash method)', async () => {
    let capturedInsert: Record<string, unknown> | null = null
    const { supabase, enqueue } = createQueuedMockSupabase()
    const originalFrom = supabase.from
    ;(supabase as { from: unknown }).from = vi.fn().mockImplementation((table: string) => {
      if (table === 'supplier_invoices') {
        return {
          insert: (row: Record<string, unknown>) => {
            capturedInsert = row
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: makeSupplierInvoice({ id: 'inv-cash', supplier_invoice_number: 'INV-100' }),
                    error: null,
                  }),
              }),
            }
          },
        }
      }
      return (originalFrom as (t: string) => unknown)(table)
    })

    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    }) // inbox fetch
    enqueue({
      data: { id: 'supplier-1', name: 'Acme AB', supplier_type: 'swedish_business' },
      error: null,
    }) // supplier fetch
    enqueue({ data: 42, error: null }) // arrival number
    // supplier_invoices insert handled by the override above
    enqueue({ data: null, error: null }) // items insert
    enqueue({ data: { accounting_method: 'cash' }, error: null }) // company_settings → cash
    enqueue({ data: null, error: null }) // invoice_inbox_items update
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('committed')
    // The inbox document id from the staged params must land on the row so
    // mark-paid can attach it to the kontantmetoden cash verifikat.
    expect(capturedInsert).toMatchObject({ document_id: 'doc-1' })
  })

  it('rolls back the parent invoice when item insert fails (no orphan supplier_invoices row)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    })
    enqueue({
      data: { id: 'supplier-1', name: 'Acme AB', supplier_type: 'swedish_business' },
      error: null,
    })
    enqueue({ data: 42, error: null })
    enqueue({
      data: makeSupplierInvoice({ id: 'inv-doomed', supplier_invoice_number: 'INV-100' }),
      error: null,
    })
    enqueue({ data: null, error: { message: 'items constraint violation' } }) // items insert fails
    enqueue({ data: null, error: null }) // rollback delete
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(result.error).toMatch(/items/)
    // JE should never have been attempted given items failed
    expect(createSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('returns 400 when subtotal/vat_amount/total are non-finite (tampered staged params)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          inbox_item_id: 'inbox-1',
          supplier_id: 'supplier-1',
          supplier_invoice_number: 'INV-100',
          invoice_date: '2026-05-15',
          currency: 'SEK',
          // String values where numbers are required: Number(x) || 0 used to
          // silently produce a zero-value invoice.
          subtotal: 'not a number',
          vat_amount: null,
          total: undefined,
          items: [{ description: 'x', line_total: 100, account_number: '6530' }],
        },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/finite numbers/)
  })

  it('zeroes per-line VAT when vat_treatment is reverse_charge (RC invariant)', async () => {
    vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-rc', voucher_number: 9 })
    )

    let capturedItems: unknown = null
    const { supabase, enqueue } = createQueuedMockSupabase()
    // We intercept the supplier_invoice_items insert by overriding the .from
    // handler on a per-table basis.
    const originalFrom = supabase.from
    ;(supabase as { from: unknown }).from = vi.fn().mockImplementation((table: string) => {
      if (table === 'supplier_invoice_items') {
        return {
          insert: (rows: unknown) => {
            capturedItems = rows
            return Promise.resolve({ data: null, error: null })
          },
        }
      }
      return (originalFrom as (t: string) => unknown)(table)
    })

    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    })
    enqueue({
      data: { id: 'supplier-1', name: 'EU Vendor SA', supplier_type: 'eu_business' },
      error: null,
    })
    enqueue({ data: 50, error: null }) // arrival number
    enqueue({
      data: makeSupplierInvoice({
        id: 'inv-rc',
        supplier_invoice_number: 'INV-RC-1',
        vat_treatment: 'reverse_charge',
        reverse_charge: true,
      }),
      error: null,
    })
    // supplier_invoice_items.insert handled by the override above
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    enqueue({ data: null, error: null }) // supplier_invoices update with JE id
    enqueue({ data: null, error: null }) // invoice_inbox_items update
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          inbox_item_id: 'inbox-1',
          supplier_id: 'supplier-1',
          document_id: null,
          supplier_invoice_number: 'INV-RC-1',
          invoice_date: '2026-05-15',
          due_date: '2026-06-14',
          currency: 'EUR',
          exchange_rate: 11.5,
          vat_treatment: 'reverse_charge',
          subtotal: 1000,
          vat_amount: 0,
          total: 1000,
          notes: null,
          // Tampered: vat_rate and vat_amount set despite RC. Executor must
          // zero these so the per-line VAT doesn't sneak into 2641.
          items: [
            {
              line_number: 1,
              description: 'Konsulttjänst EU',
              quantity: 1,
              unit: 'st',
              unit_price: 1000,
              line_total: 1000,
              account_number: '4535',
              vat_rate: 0.25,
              vat_amount: 250,
            },
          ],
        },
      }),
    )

    expect(result.status).toBe('committed')
    const items = capturedItems as Array<{ vat_rate: number; vat_amount: number }>
    expect(items[0].vat_rate).toBe(0)
    expect(items[0].vat_amount).toBe(0)
  })

  it('JE-failure rollback deletes items BEFORE the parent invoice (FK ordering)', async () => {
    // The parent has line items at this point: the rollback must reverse
    // insertion order or the FK on supplier_invoice_items blocks the parent
    // delete and we're left with an orphan understating leverantörsskuld.
    vi.mocked(createSupplierInvoiceRegistrationEntry).mockRejectedValueOnce(
      new Error('engine error: balance check failed')
    )

    const deleteCalls: string[] = []
    const { supabase, enqueue } = createQueuedMockSupabase()
    const originalFrom = supabase.from
    ;(supabase as { from: unknown }).from = vi.fn().mockImplementation((table: string) => {
      const chain = (originalFrom as (t: string) => unknown)(table) as {
        delete?: () => unknown
      } & Record<string, unknown>
      if (table === 'supplier_invoice_items' || table === 'supplier_invoices') {
        // Trap delete calls so we can assert order.
        return new Proxy(chain, {
          get(target, prop) {
            if (prop === 'delete') {
              return () => {
                deleteCalls.push(table)
                return target.delete!()
              }
            }
            return (target as Record<string | symbol, unknown>)[prop]
          },
        })
      }
      return chain
    })

    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    })
    enqueue({
      data: { id: 'supplier-1', name: 'Acme AB', supplier_type: 'swedish_business' },
      error: null,
    })
    enqueue({ data: 42, error: null })
    enqueue({
      data: makeSupplierInvoice({ id: 'inv-rollback', supplier_invoice_number: 'INV-X' }),
      error: null,
    })
    enqueue({ data: null, error: null }) // items insert succeeds
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    // JE throws: rollback path runs
    enqueue({ data: null, error: null }) // items delete
    enqueue({ data: null, error: null }) // parent delete
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    // Critical assertion: items BEFORE the parent.
    expect(deleteCalls).toEqual(['supplier_invoice_items', 'supplier_invoices'])
  })

  it('returns 400 when required staged params are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          // Tampered or partial staged params: missing supplier_id + items
          inbox_item_id: 'inbox-1',
          supplier_invoice_number: 'INV-100',
          invoice_date: '2026-05-15',
        },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(createSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })
})

describe('commitPendingOperation: create_supplier_invoice_from_inbox: dimensions propagation (PR7)', () => {
  /**
   * Capture both the supplier_invoices parent insert and the
   * supplier_invoice_items rows (cash method: no JE, shortest queue).
   */
  function withInsertCapture(supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']) {
    const captured: {
      invoice: Record<string, unknown> | null
      items: Array<Record<string, unknown>> | null
    } = { invoice: null, items: null }

    const originalFrom = supabase.from
    ;(supabase as { from: unknown }).from = vi.fn().mockImplementation((table: string) => {
      if (table === 'supplier_invoices') {
        return {
          insert: (row: Record<string, unknown>) => {
            captured.invoice = row
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: makeSupplierInvoice({ id: 'inv-dims', supplier_invoice_number: 'INV-100' }),
                    error: null,
                  }),
              }),
            }
          },
        }
      }
      if (table === 'supplier_invoice_items') {
        return {
          insert: (rows: Array<Record<string, unknown>>) => {
            captured.items = rows
            return Promise.resolve({ data: null, error: null })
          },
        }
      }
      return (originalFrom as (t: string) => unknown)(table)
    })

    return captured
  }

  /** Queue for the cash-method path with both inserts intercepted above. */
  function enqueueCashFlow(enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue']) {
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({
      data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' },
      error: null,
    }) // inbox fetch
    enqueue({
      data: { id: 'supplier-1', name: 'Acme AB', supplier_type: 'swedish_business' },
      error: null,
    }) // supplier fetch
    enqueue({ data: 42, error: null }) // arrival number RPC
    enqueue({ data: { accounting_method: 'cash' }, error: null }) // company_settings
    enqueue({ data: null, error: null }) // invoice_inbox_items update
    enqueue({ data: null, error: null }) // dispatcher's commit update
  }

  it('staged default_dimensions lands on the supplier_invoices row and item bags on the item rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const captured = withInsertCapture(supabase)
    enqueueCashFlow(enqueue)

    const op = makePendingOp()
    op.params = {
      ...(op.params as Record<string, unknown>),
      default_dimensions: { '1': 'KS01' },
      items: [
        {
          line_number: 1,
          description: 'Konsulttjänst',
          quantity: 1,
          unit: 'st',
          unit_price: 1000,
          line_total: 1000,
          account_number: '6530',
          vat_rate: 0.25,
          vat_amount: 250,
          dimensions: { '6': 'P001' },
        },
        {
          line_number: 2,
          description: 'Frakt',
          quantity: 1,
          unit: 'st',
          unit_price: 100,
          line_total: 100,
          account_number: '5710',
          vat_rate: 0.25,
          vat_amount: 25,
          // No dims staged on this row.
        },
      ],
    }

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(captured.invoice).toMatchObject({ default_dimensions: { '1': 'KS01' } })
    expect(captured.items).toHaveLength(2)
    expect(captured.items![0]).toMatchObject({ account_number: '6530', dimensions: { '6': 'P001' } })
    // Absent bag defaults to {} on the row.
    expect(captured.items![1]).toMatchObject({ account_number: '5710', dimensions: {} })
  })

  it('defaults to {} when absent and coerces an INVALID staged bag away (drift/tamper gate)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const captured = withInsertCapture(supabase)
    enqueueCashFlow(enqueue)

    const op = makePendingOp()
    op.params = {
      ...(op.params as Record<string, unknown>),
      // '0' is not a valid SIE dimension number: the whole bag is rejected.
      default_dimensions: { '0': 'X' },
      items: [
        {
          line_number: 1,
          description: 'Konsulttjänst',
          quantity: 1,
          unit: 'st',
          unit_price: 1000,
          line_total: 1000,
          account_number: '6530',
          vat_rate: 0.25,
          vat_amount: 250,
          // Empty code fails the schema: the whole bag is rejected.
          dimensions: { '1': '' },
        },
      ],
    }

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(captured.invoice).toMatchObject({ default_dimensions: {} })
    expect(captured.items![0]).toMatchObject({ dimensions: {} })
  })
})
