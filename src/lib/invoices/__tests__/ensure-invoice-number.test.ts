import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ensureInvoiceNumber,
  invoiceNumberingFailure,
  InvoiceNumberSeriesBehindError,
} from '@/lib/invoices/ensure-invoice-number'

type MockChain = {
  from: ReturnType<typeof vi.fn>
  rpc: ReturnType<typeof vi.fn>
}

function buildMockSupabase(): MockChain {
  return {
    from: vi.fn(),
    rpc: vi.fn(),
  }
}

describe('ensureInvoiceNumber', () => {
  let supabase: MockChain

  beforeEach(() => {
    supabase = buildMockSupabase()
  })

  it('returns existing number without RPC when invoice already has one', async () => {
    const invoice = { id: 'inv-1', invoice_number: 'F-2026001' }

    const result = await ensureInvoiceNumber(supabase as never, 'company-1', invoice)

    expect(result).toBe('F-2026001')
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(invoice.invoice_number).toBe('F-2026001')
  })

  it('calls RPC with invoice id and document_type=invoice when number is null', async () => {
    const invoice: { id: string; invoice_number: string | null } = {
      id: 'inv-1',
      invoice_number: null,
    }

    supabase.rpc.mockResolvedValue({ data: 'F2026005', error: null })

    const result = await ensureInvoiceNumber(supabase as never, 'company-1', invoice)

    expect(result).toBe('F2026005')
    expect(supabase.rpc).toHaveBeenCalledWith('generate_invoice_number', {
      p_company_id: 'company-1',
      p_invoice_id: 'inv-1',
      p_document_type: 'invoice',
    })
    expect(invoice.invoice_number).toBe('F2026005')
  })

  it('passes document_type=proforma so the RPC produces a PF- prefix', async () => {
    const invoice = {
      id: 'inv-2',
      invoice_number: null,
      document_type: 'proforma' as const,
    }

    supabase.rpc.mockResolvedValue({ data: 'PF-2026005', error: null })

    const result = await ensureInvoiceNumber(supabase as never, 'company-1', invoice)

    expect(result).toBe('PF-2026005')
    expect(supabase.rpc).toHaveBeenCalledWith('generate_invoice_number', {
      p_company_id: 'company-1',
      p_invoice_id: 'inv-2',
      p_document_type: 'proforma',
    })
    expect(invoice.invoice_number).toBe('PF-2026005')
  })

  it('throws when RPC fails', async () => {
    const invoice = { id: 'inv-1', invoice_number: null }
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'RPC failed' } })

    await expect(
      ensureInvoiceNumber(supabase as never, 'company-1', invoice)
    ).rejects.toThrow('Failed to assign invoice number')
  })

  it('throws when RPC returns no data even without an error', async () => {
    const invoice = { id: 'inv-1', invoice_number: null }
    supabase.rpc.mockResolvedValue({ data: null, error: null })

    await expect(
      ensureInvoiceNumber(supabase as never, 'company-1', invoice)
    ).rejects.toThrow('no value returned')
  })

  it("turns the RPC's series refusal into InvoiceNumberSeriesBehindError with its numbers", async () => {
    const invoice: { id: string; invoice_number: string | null } = { id: 'inv-1', invoice_number: null }
    supabase.rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'PT409',
        message: 'INVOICE_NUMBER_SERIES_BEHIND',
        details: JSON.stringify({ prefix: '', next_invoice_number: 1, highest_number: 1002, first_allowed: 1003 }),
      },
    })

    const err = await ensureInvoiceNumber(supabase as never, 'company-1', invoice).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(InvoiceNumberSeriesBehindError)
    const behind = err as InvoiceNumberSeriesBehindError
    expect(behind.code).toBe('INVOICE_NUMBER_SERIES_BEHIND')
    expect(behind.details).toEqual({ prefix: '', highest_number: 1002, first_allowed: 1003 })
    expect(behind.message).toContain('upp till 1002')
    expect(behind.message).toContain('1003 eller högre')
    // Nothing was written back.
    expect(invoice.invoice_number).toBeNull()
  })

  it('keeps other RPC failures a plain error', async () => {
    const invoice = { id: 'inv-1', invoice_number: null }
    supabase.rpc.mockResolvedValue({ data: null, error: { code: 'PT409', message: 'SOMETHING_ELSE', details: null } })

    const err = await ensureInvoiceNumber(supabase as never, 'company-1', invoice).catch((e: unknown) => e)

    expect(err).not.toBeInstanceOf(InvoiceNumberSeriesBehindError)
    expect((err as Error).message).toContain('Failed to assign invoice number')
  })

  it('answers a series refusal with its own code and sentence, anything else with the fallback', () => {
    const behind = new InvoiceNumberSeriesBehindError({ prefix: 'F-', highest_number: 42, first_allowed: 43 })
    expect(invoiceNumberingFailure(behind, 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED')).toEqual({
      code: 'INVOICE_NUMBER_SERIES_BEHIND',
      messageSv: behind.message,
      messageEn: behind.messageEn,
      details: { prefix: 'F-', highest_number: 42, first_allowed: 43 },
    })
    expect(invoiceNumberingFailure(new Error('boom'), 'INVOICE_SEND_NUMBER_ASSIGN_FAILED')).toEqual({
      code: 'INVOICE_SEND_NUMBER_ASSIGN_FAILED',
    })
  })

  it('returns the external number for a self-billed invoice without touching the RPC', async () => {
    // A received self-billing invoice carries the counterparty's number; we must
    // never consume our own löpnummerserie (BFL 5 kap 6§).
    const invoice = {
      id: 'inv-1',
      invoice_number: null,
      is_self_billed: true,
      external_invoice_number: 'KUND-55012',
    }

    const result = await ensureInvoiceNumber(supabase as never, 'company-1', invoice)

    expect(result).toBe('KUND-55012')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('throws when a self-billed invoice is missing the external number', async () => {
    const invoice = {
      id: 'inv-1',
      invoice_number: null,
      is_self_billed: true,
      external_invoice_number: null,
    }

    await expect(
      ensureInvoiceNumber(supabase as never, 'company-1', invoice)
    ).rejects.toThrow('missing external_invoice_number')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

// accounted#58: generate_invoice_number puts every type but a proforma in the
// invoice series, and the series' position counts invoices only, so an
// unnumbered följesedel issued through it left a permanent hole in the F series.
describe('ensureInvoiceNumber: a följesedel and an offert never take an invoice number', () => {
  /** An update chain (.update().eq().eq().is().select()) and a read chain (.select().eq().eq().maybeSingle()). */
  function invoicesTable(opts: {
    written: Array<{ invoice_number: string | null }> | null
    writeError?: { message: string } | null
    current?: { invoice_number: string | null } | null
  }) {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const chain: Record<string, unknown> = {}
    for (const method of ['update', 'select', 'eq', 'is']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        calls.push({ method, args })
        return chain
      })
    }
    // The update chain ends in select('invoice_number') and is awaited.
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: opts.written, error: opts.writeError ?? null })
    chain.maybeSingle = vi.fn(async () => ({ data: opts.current ?? null, error: null }))
    return { chain, calls }
  }

  it('draws the number from the FS- series and writes it only while the row has none', async () => {
    const table = invoicesTable({ written: [{ invoice_number: 'FS-2026004' }] })
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 'FS-2026004', error: null }),
      from: vi.fn(() => table.chain),
    }
    const invoice = { id: 'dn-1', invoice_number: null as string | null, document_type: 'delivery_note' as const }

    const result = await ensureInvoiceNumber(supabase as never, 'company-1', invoice)

    expect(result).toBe('FS-2026004')
    expect(invoice.invoice_number).toBe('FS-2026004')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('generate_delivery_note_number', { p_company_id: 'company-1' })
    expect(supabase.from).toHaveBeenCalledWith('invoices')
    expect(table.calls).toContainEqual({ method: 'update', args: [{ invoice_number: 'FS-2026004' }] })
    expect(table.calls).toContainEqual({ method: 'eq', args: ['id', 'dn-1'] })
    expect(table.calls).toContainEqual({ method: 'eq', args: ['company_id', 'company-1'] })
    expect(table.calls).toContainEqual({ method: 'is', args: ['invoice_number', null] })
  })

  it('returns the number a concurrent issue wrote when it lost the write', async () => {
    const table = invoicesTable({ written: [], current: { invoice_number: 'FS-2026003' } })
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 'FS-2026004', error: null }),
      from: vi.fn(() => table.chain),
    }
    const invoice = { id: 'dn-1', invoice_number: null as string | null, document_type: 'delivery_note' as const }

    await expect(ensureInvoiceNumber(supabase as never, 'company-1', invoice)).resolves.toBe('FS-2026003')
    expect(invoice.invoice_number).toBe('FS-2026003')
  })

  it('throws when the FS- number cannot be drawn, and writes nothing', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'Company settings not found' } }),
      from: vi.fn(),
    }
    const invoice = { id: 'dn-1', invoice_number: null as string | null, document_type: 'delivery_note' as const }

    await expect(ensureInvoiceNumber(supabase as never, 'company-1', invoice)).rejects.toThrow(
      'Failed to assign delivery note number',
    )
    expect(supabase.from).not.toHaveBeenCalled()
    expect(invoice.invoice_number).toBeNull()
  })

  it('throws when the write fails', async () => {
    const table = invoicesTable({ written: null, writeError: { message: 'permission denied' } })
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 'FS-2026004', error: null }),
      from: vi.fn(() => table.chain),
    }
    const invoice = { id: 'dn-1', invoice_number: null as string | null, document_type: 'delivery_note' as const }

    await expect(ensureInvoiceNumber(supabase as never, 'company-1', invoice)).rejects.toThrow('permission denied')
    expect(invoice.invoice_number).toBeNull()
  })

  it('keeps a numbered följesedel as it is', async () => {
    const supabase = { rpc: vi.fn(), from: vi.fn() }
    const invoice = { id: 'dn-1', invoice_number: 'FS-2026001', document_type: 'delivery_note' as const }

    await expect(ensureInvoiceNumber(supabase as never, 'company-1', invoice)).resolves.toBe('FS-2026001')
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses an offert without its OF- number instead of drawing from the invoice series', async () => {
    const supabase = { rpc: vi.fn(), from: vi.fn() }
    const invoice = { id: 'q-1', invoice_number: null as string | null, document_type: 'quote' as const }

    await expect(ensureInvoiceNumber(supabase as never, 'company-1', invoice)).rejects.toThrow('Failed to assign invoice number')
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(invoice.invoice_number).toBeNull()
  })
})
