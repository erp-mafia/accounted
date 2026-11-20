/**
 * A migrated supplier invoice row is never given an account the source did
 * not name. The mapper used to write '4000' (Inköp av varor) on every row
 * without one: every Bokio row, since Bokio's invoice lines carry no account,
 * and any Briox, Fortnox or Visma row that omits it. Such an invoice now
 * imports as a header, without rows, and the mapper says so.
 *
 * Runs the real provider mappers and the real importer mapper.
 */
import { describe, it, expect } from 'vitest'
import { mapBokioToSupplierInvoice } from '@/lib/providers/bokio/mapper'
import { enrichBokioSupplierInvoice } from '@/lib/providers/bokio/supplier-evidence'
import { mapFortnoxToSupplierInvoice } from '@/lib/providers/fortnox/mapper'
import { mapSupplierInvoice } from '../entity-mapper'
import type { SupplierInvoiceDto } from '@/lib/providers/dto'

const map = (dto: SupplierInvoiceDto) => mapSupplierInvoice(dto, 'user-1', 'company-1', 'supplier-1')

function fortnox(rows: Array<{ Account?: number; Total: number }>) {
  return mapFortnoxToSupplierInvoice({
    GivenNumber: '311', SupplierName: 'Leverantör AB', InvoiceDate: '2026-06-01', DueDate: '2026-06-30',
    Currency: 'SEK', Booked: true, Cancelled: false, Balance: 1250, Total: 1250,
    SupplierInvoiceRows: rows,
  })
}

describe('mapSupplierInvoice: a row is never given a guessed account', () => {
  it('imports a Bokio invoice whose lines name no account as a header, not as rows on 4000', () => {
    // Complete preview lines (stated rates that add up to the total), so the
    // rows are not withheld for their VAT: only the missing account stops them.
    const dto = enrichBokioSupplierInvoice(mapBokioToSupplierInvoice({
      id: 'bokio-1', invoiceNumber: '1001', invoiceDate: '2026-01-02', dueDate: '2026-02-01', currency: 'SEK',
      totalAmount: 1250, remainingAmount: 1250, supplierRef: { id: 'party-1', name: 'Leverantör AB' },
      lineItems: [{ description: 'Konsulttimmar', quantity: 10, unitPrice: 100, taxRate: 25 }],
    }))
    expect(dto.supplierEvidence?.itemsComplete).toBe(true)
    expect(dto.lines[0].accountNumber).toBeUndefined()

    const mapped = map(dto)

    expect(mapped.items).toEqual([])
    expect(mapped.rowsUnaccounted).toBe(true)
    // Not a mismatch: the job worker keeps a row-less Bokio invoice instead
    // of refusing it, as it keeps one whose rows were withheld.
    expect(mapped.rowsMismatch).toBe(false)
    expect(mapped.invoice).toMatchObject({ subtotal: 1000, vat_amount: 250, total: 1250 })
  })

  it('drops the whole row set when one row names no account, rather than booking that row to 4000', () => {
    const mapped = map(fortnox([{ Account: 6540, Total: 800 }, { Total: 200 }, { Account: 2640, Total: 250 }, { Account: 2440, Total: -1250 }]))

    expect(mapped.items).toEqual([])
    expect(mapped.rowsUnaccounted).toBe(true)
    expect(mapped.rowsMismatch).toBe(false)
    expect(mapped.invoice).toMatchObject({ total: 1250 })
  })

  it('keeps a row set in which every row names its account', () => {
    const mapped = map(fortnox([{ Account: 6540, Total: 1000 }, { Account: 2640, Total: 250 }, { Account: 2440, Total: -1250 }]))

    expect(mapped.items.map((item) => item.account_number)).toEqual(['6540', '2640'])
    expect(mapped.rowsUnaccounted).toBe(false)
  })

  it('reports a row set that does not add up as a mismatch, not as unaccounted', () => {
    // 200 kr of rows for a 1 250 kr invoice, one of them without an account.
    const mapped = map(fortnox([{ Total: 200 }, { Account: 2440, Total: -1250 }]))

    expect(mapped.items).toEqual([])
    expect(mapped.rowsMismatch).toBe(true)
    expect(mapped.rowsUnaccounted).toBe(false)
  })
})
