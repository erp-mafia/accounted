import { describe, it, expect } from 'vitest'
import { recentActivityResource } from '../resources/recent-activity'

/**
 * Real column names, verified against information_schema on the production
 * database. The mocked Supabase harness happily returns rows for columns that
 * do not exist, so the only way to catch a phantom column (PostgREST 42703 in
 * production) is to assert the column list the resource actually asks for.
 */
const REAL_COLUMNS: Record<string, Set<string>> = {
  journal_entries: new Set(
    `id user_id fiscal_period_id voucher_number voucher_series entry_date description
     source_type source_id status attachment_urls created_at updated_at committed_at
     reversed_by_id reverses_id correction_of_id company_id notes commit_method
     rubric_version source_voucher_series source_voucher_number created_via
     source_proposal_id committed_actor_type committed_actor_label`.split(/\s+/)
  ),
  invoices: new Set(
    `id user_id customer_id invoice_number invoice_date due_date status currency
     exchange_rate exchange_rate_date subtotal subtotal_sek vat_amount vat_amount_sek
     total total_sek vat_treatment vat_rate moms_ruta your_reference our_reference notes
     reverse_charge_text credited_invoice_id paid_at paid_amount created_at updated_at
     ocr_number bankgiro_number plusgiro_number payment_type is_recurring
     recurring_invoice_id document_type converted_from_id remaining_amount company_id
     delivery_date deduction_total deduction_personnummer_encrypted
     deduction_personnummer_last4 is_self_billed external_invoice_number
     self_billing_agreement_ref received_date journal_entry_id ore_rounding
     default_dimensions payment_link_url stripe_payment_link_id payment_link_auto
     creation_complete`.split(/\s+/)
  ),
  transactions: new Set(
    `id user_id bank_connection_id external_id date description amount currency amount_sek
     exchange_rate exchange_rate_date category is_business invoice_id potential_invoice_id
     journal_entry_id mcc_code merchant_name receipt_id notes created_at updated_at
     supplier_invoice_id import_source reference reconciliation_method
     potential_supplier_invoice_id company_id document_id counterparty_iban
     counterparty_account is_ignored original_description title_edited_at cash_account_id
     enrichment`.split(/\s+/)
  ),
}

type TableResult = { data?: unknown; error?: { message: string } }

function createRecordingSupabase(results: Record<string, TableResult> = {}) {
  const selects: Record<string, string> = {}

  const supabase = {
    from(table: string) {
      const result = results[table] ?? { data: [] }
      const chain: Record<string, unknown> = {}
      const passthrough = () => chain
      chain.select = (columns: string) => {
        selects[table] = columns
        return chain
      }
      chain.eq = passthrough
      chain.in = passthrough
      chain.order = passthrough
      chain.limit = passthrough
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: result.data ?? null, error: result.error ?? null })
      return chain
    },
  }

  return { supabase, selects }
}

const ctx = (supabase: unknown, query?: URLSearchParams) => ({
  supabase: supabase as never,
  companyId: 'company-1',
  userId: 'user-1',
  scopes: [],
  query,
})

describe('Accounted://recent-activity', () => {
  it('only requests columns that exist on the queried tables', async () => {
    const { supabase, selects } = createRecordingSupabase()

    await recentActivityResource.read(ctx(supabase))

    expect(Object.keys(selects).sort()).toEqual([
      'invoices',
      'journal_entries',
      'transactions',
    ])

    for (const [table, columns] of Object.entries(selects)) {
      const requested = columns.split(',').map((c) => c.trim())
      const phantom = requested.filter((c) => !REAL_COLUMNS[table].has(c))
      expect(phantom, `phantom column(s) selected from ${table}`).toEqual([])
    }
  })

  it('selects the invoice total as "total", never "total_amount"', async () => {
    const { supabase, selects } = createRecordingSupabase()

    await recentActivityResource.read(ctx(supabase))

    const invoiceColumns = selects.invoices.split(',').map((c) => c.trim())
    expect(invoiceColumns).toContain('total')
    expect(invoiceColumns).not.toContain('total_amount')
  })

  it('returns the rows and counts uncategorized transactions', async () => {
    const { supabase } = createRecordingSupabase({
      journal_entries: { data: [{ id: 'je-1', voucher_number: 1 }] },
      invoices: { data: [{ id: 'inv-1', invoice_number: '1', total: 1250, currency: 'SEK' }] },
      transactions: {
        data: [
          { id: 't-1', journal_entry_id: 'je-1' },
          { id: 't-2', journal_entry_id: null },
        ],
      },
    })

    const result = (await recentActivityResource.read(
      ctx(supabase, new URLSearchParams('limit=5'))
    )) as {
      limit: number
      journal_entries: unknown[]
      invoices: Array<{ total: number }>
      transactions: unknown[]
      uncategorized_transaction_count: number
    }

    expect(result.limit).toBe(5)
    expect(result.journal_entries).toHaveLength(1)
    expect(result.invoices[0].total).toBe(1250)
    expect(result.uncategorized_transaction_count).toBe(1)
  })

  it('does not count a pointer-null row anchored through transaction_voucher_links (bulk-book, 1:N split)', async () => {
    const { supabase, selects } = createRecordingSupabase({
      transactions: {
        data: [
          { id: 't-1', journal_entry_id: 'je-1' },
          { id: 't-split', journal_entry_id: null },
          { id: 't-open', journal_entry_id: null },
        ],
      },
      transaction_voucher_links: { data: [{ transaction_id: 't-split' }] },
    })

    const result = (await recentActivityResource.read(ctx(supabase))) as {
      uncategorized_transaction_count: number
    }

    expect(selects.transaction_voucher_links).toBe('transaction_id')
    expect(result.uncategorized_transaction_count).toBe(1)
  })

  it('surfaces a query failure instead of reporting zero invoices', async () => {
    const { supabase } = createRecordingSupabase({
      invoices: { error: { message: 'column invoices.total_amount does not exist' } },
    })

    await expect(recentActivityResource.read(ctx(supabase))).rejects.toThrow(
      /Failed to read recent invoices/
    )
  })

  it('surfaces journal entry and transaction failures too', async () => {
    const jeFail = createRecordingSupabase({
      journal_entries: { error: { message: 'boom' } },
    })
    await expect(recentActivityResource.read(ctx(jeFail.supabase))).rejects.toThrow(
      /Failed to read recent journal entries/
    )

    const txFail = createRecordingSupabase({
      transactions: { error: { message: 'boom' } },
    })
    await expect(recentActivityResource.read(ctx(txFail.supabase))).rejects.toThrow(
      /Failed to read recent transactions/
    )
  })
})
