/**
 * Where a company's own invoice series stands (migration 20261012161600): the
 * invoices decide, and a series already past the counter is a refusal that
 * names the number the company sets, never a guess.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  formatSeriesNumber,
  invoiceSeriesBehindMessages,
  readInvoiceSeries,
  seriesNumberOf,
} from '../invoice-number-series'

describe('seriesNumberOf', () => {
  it('reads bare digits and digits after the company prefix', () => {
    expect(seriesNumberOf('70', null)).toBe(70)
    expect(seriesNumberOf('0070', '')).toBe(70)
    expect(seriesNumberOf('F-0123', 'F-')).toBe(123)
  })

  it('under a prefixed series counts only prefixed numbers', () => {
    // generate_invoice_number writes the prefix: bare digits are another series.
    expect(seriesNumberOf('123', 'F-')).toBeNull()
    expect(seriesNumberOf('535883', 'A')).toBeNull()
    expect(seriesNumberOf('A535', 'A')).toBe(535)
  })

  it('leaves numbers outside the series alone', () => {
    expect(seriesNumberOf('KR-1042', '')).toBeNull()
    expect(seriesNumberOf('2025-001', null)).toBeNull()
    expect(seriesNumberOf('PF-004', 'F-')).toBeNull()
    expect(seriesNumberOf('F-12A', 'F-')).toBeNull()
    expect(seriesNumberOf('', null)).toBeNull()
    expect(seriesNumberOf(null, null)).toBeNull()
    expect(seriesNumberOf('0', null)).toBeNull()
    // Past what the integer counter can hold.
    expect(seriesNumberOf('99999999999', null)).toBeNull()
  })
})

describe('formatSeriesNumber', () => {
  it('prints a value the way generate_invoice_number does', () => {
    expect(formatSeriesNumber('', 7)).toBe('007')
    expect(formatSeriesNumber('F-', 668)).toBe('F-668')
    expect(formatSeriesNumber('PF-', 1)).toBe('PF-001')
    expect(formatSeriesNumber('', 114647)).toBe('114647')
  })
})

describe('invoiceSeriesBehindMessages', () => {
  it('names the highest number and the next one to set, in both languages', () => {
    const messages = invoiceSeriesBehindMessages({ prefix: '', highest_number: 668, first_allowed: 669 })
    expect(messages.sv).toContain('upp till 668')
    expect(messages.sv).toContain('Nästa fakturanummer på 669 eller högre')
    expect(messages.sv).toContain('Inställningar > Fakturor')
    expect(messages.en).toContain('next_invoice_number to 669 or higher')
  })

  it('prints the highest number with the series prefix', () => {
    const messages = invoiceSeriesBehindMessages({ prefix: 'F-', highest_number: 42, first_allowed: 43 })
    expect(messages.sv).toContain('upp till F-042')
  })
})

describe('readInvoiceSeries', () => {
  it('asks invoice_number_series_status for the stored setting by default', async () => {
    const state = {
      prefix: '',
      next_invoice_number: 667,
      next_number: '669',
      highest_number: 668,
      behind: false,
      first_allowed: 669,
    }
    const rpc = vi.fn().mockResolvedValue({ data: state, error: null })

    await expect(readInvoiceSeries({ rpc } as never, 'company-1')).resolves.toEqual(state)
    expect(rpc).toHaveBeenCalledWith('invoice_number_series_status', {
      p_company_id: 'company-1',
      p_document_type: 'invoice',
      p_prefix: null,
      p_next_number: null,
    })
  })

  it('passes a proposed prefix and next number through for the settings check', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })

    await expect(readInvoiceSeries({ rpc } as never, 'company-1', { prefix: '', nextNumber: 669 })).resolves.toBeNull()
    expect(rpc).toHaveBeenCalledWith('invoice_number_series_status', {
      p_company_id: 'company-1',
      p_document_type: 'invoice',
      p_prefix: '',
      p_next_number: 669,
    })
  })

  it('throws the database error so a check fails closed', async () => {
    const error = { code: '42501', message: 'unauthorized' }
    const rpc = vi.fn().mockResolvedValue({ data: null, error })

    await expect(readInvoiceSeries({ rpc } as never, 'company-1')).rejects.toBe(error)
  })
})
