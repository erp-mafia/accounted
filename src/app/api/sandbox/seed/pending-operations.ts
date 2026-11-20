/**
 * Pre-staged pending_operations for the sandbox, so /pending isn't empty.
 *
 * These are the kind of operation the AI agent would stage; pre-seeded so the
 * demo user can see the approval queue UI (preview, period status, risk level)
 * without invoking the AI, which the sandbox blocks outright.
 *
 * Two shapes have to be right or the row is worse than absent:
 *   params: executor-complete. The commit executors in
 *     lib/pending-operations/commit.ts validate required fields on "Godkänn",
 *     so a display-only preview with a hollow params object fails to save.
 *   preview_data: whatever the operation's preview component in
 *     app/(dashboard)/pending/page.tsx actually reads. Most types fall through
 *     to GenericPreview, which renders a kontering under `preview_lines`;
 *     categorize_transaction has a dedicated CategorizePreview that reads
 *     `lines` + a summary `amount` instead.
 *
 * Extracted from route.ts so both shapes are assertable in a unit test: the
 * seed handler itself is one long Supabase-bound function.
 */

import {
  SANDBOX_REPRESENTATION_ACCOUNT,
  SANDBOX_REPRESENTATION_LINE,
  SANDBOX_STAGED_REPRESENTATION_NOTES,
} from './representation'

export interface SandboxPendingOperationsInput {
  userId: string
  companyId: string
  /** invoice_inbox_items row the supplier-invoice operation converts. */
  inboxItemId: string
  supplierId: string
  invoiceDate: string
  dueDate: string
  /** The uncategorized 1 200 kr bankgiro deposit. */
  transactionId: string
}

export function buildSandboxPendingOperations({
  userId,
  companyId,
  inboxItemId,
  supplierId,
  invoiceDate,
  dueDate,
  transactionId,
}: SandboxPendingOperationsInput) {
  return [
    {
      user_id: userId,
      company_id: companyId,
      operation_type: 'create_supplier_invoice_from_inbox',
      status: 'pending',
      // actor_type='agent_chat' + risk_level on the row itself is required by
      // pending_operations_chat_insert (the only RLS policy that lets a
      // user-scoped client INSERT into this table).
      actor_type: 'agent_chat',
      risk_level: 'low',
      // Uses a distinct supplier_invoice_number so approving this pending
      // operation creates a NEW supplier_invoices row instead of colliding
      // with the Demokafé '88245' already booked by the seed (BFL 5 kap: each
      // affärshändelse must be recorded exactly once).
      title: 'Registrera leverantörsfaktura, Demokafé (representation, nytt underlag)',
      // Mirrors what gnubok_create_supplier_invoice_from_inbox would stage:
      // every field commitCreateSupplierInvoiceFromInbox requires
      // (inbox_item_id, supplier_id, supplier_invoice_number, invoice_date,
      // finite subtotal/vat_amount/total, and a non-empty items array).
      params: {
        inbox_item_id: inboxItemId,
        supplier_id: supplierId,
        document_id: null,
        supplier_invoice_number: 'INKOMMANDE-2026-001',
        invoice_date: invoiceDate,
        due_date: dueDate,
        currency: 'SEK',
        exchange_rate: null,
        vat_treatment: 'reduced_12',
        subtotal: SANDBOX_REPRESENTATION_LINE.net,
        vat_amount: SANDBOX_REPRESENTATION_LINE.vat,
        total: SANDBOX_REPRESENTATION_LINE.total,
        // Syfte and deltagare, as a written note (crm#1342).
        notes: SANDBOX_STAGED_REPRESENTATION_NOTES,
        items: [
          {
            line_number: 1,
            description: SANDBOX_REPRESENTATION_LINE.description,
            quantity: 1,
            unit: 'st',
            unit_price: SANDBOX_REPRESENTATION_LINE.net,
            line_total: SANDBOX_REPRESENTATION_LINE.net,
            account_number: SANDBOX_REPRESENTATION_ACCOUNT,
            vat_rate: SANDBOX_REPRESENTATION_LINE.vatRatePercent,
            vat_amount: SANDBOX_REPRESENTATION_LINE.vat,
          },
        ],
      },
      preview_data: {
        // A customer lunch for two at 12 % (./representation): 6072, since a
        // måltid is not income-tax deductible, and the VAT is deductible on a
        // base of at most 300 kr per person (ML 13 kap. 24-25 §§), 36 kr per
        // person at 12 %. 28,80 kr is under 2 × 36 kr, so it all goes to 2641,
        // which is what approving books (the registration path debits the
        // invoice's full VAT and warns when a 607x line could exceed the cap).
        // GenericPreview renders this key, so the `account`/`debit`/`credit`
        // spelling is the right one here.
        preview_lines: [
          {
            account: SANDBOX_REPRESENTATION_ACCOUNT,
            description: 'Representation, ej avdragsgill (kundlunch)',
            debit: SANDBOX_REPRESENTATION_LINE.net,
            credit: 0,
          },
          { account: '2641', description: 'Ingående moms', debit: SANDBOX_REPRESENTATION_LINE.vat, credit: 0 },
          { account: '2440', description: 'Leverantörsskulder', debit: 0, credit: SANDBOX_REPRESENTATION_LINE.total },
        ],
      },
    },
    {
      user_id: userId,
      company_id: companyId,
      operation_type: 'categorize_transaction',
      status: 'pending',
      actor_type: 'agent_chat',
      risk_level: 'low',
      title: 'Bokför insättning, bankgiro',
      // commitCategorizeTransaction needs a real uncategorized transaction_id
      // + a category that resolves to an account mapping. income_services →
      // 3001 (Försäljning tjänster 25%), matching the 1930 / 2611 / 3001 split
      // below for the 1 200 kr deposit.
      params: {
        transaction_id: transactionId,
        category: 'income_services',
        vat_treatment: 'standard_25',
      },
      // CategorizePreview reads `lines`, NOT the generic `preview_lines` the
      // operation above uses. Seeding the generic shape here dropped the card
      // onto its legacy summary branch: blank Debetkonto/Kreditkonto and
      // "NaN kr" from formatCurrency(undefined) on the missing `amount`.
      // Mirror exactly what gnubok_categorize_transaction stages.
      preview_data: {
        debit_account: '1930',
        credit_account: '3001',
        amount: 1200,
        currency: 'SEK',
        lines: [
          { account_number: '1930', debit_amount: 1200, credit_amount: 0, description: 'Företagskonto' },
          { account_number: '2611', debit_amount: 0, credit_amount: 240, description: 'Utgående moms 25%' },
          { account_number: '3001', debit_amount: 0, credit_amount: 960, description: 'Försäljning 25% moms' },
        ],
        vat_lines: [
          { account_number: '2611', debit_amount: 0, credit_amount: 240, description: 'Utgående moms 25%' },
        ],
        category: 'income_services',
      },
    },
  ]
}
