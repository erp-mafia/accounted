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
