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
        subtotal: 240,
        vat_amount: 28.80,
        total: 268.80,
        notes: 'Representation, kundmöte (demo)',
        items: [
          {
            line_number: 1,
            description: 'Kundmöte Demokafé (representation)',
            quantity: 1,
            unit: 'st',
            unit_price: 240,
            line_total: 240,
            account_number: '5810',
            vat_rate: 12,
            vat_amount: 28.80,
          },
        ],
      },
      preview_data: {
        // Representation @ 12% VAT (café meal), 240 SEK excl. VAT for a single
        // attendee. The avdragsrätt cap is 25% × 300 SEK × antal_personer =
        // 75 SEK / person (ML 8 kap. 9 §); since the VAT here is 28.80 SEK the
        // full amount is deductible and the cost lands in 5810: no split.
        // GenericPreview renders this key, so the `account`/`debit`/`credit`
        // spelling is the right one here.
        preview_lines: [
          { account: '5810', description: 'Representation (12% moms, ≤ 75 SEK moms/pers)', debit: 240, credit: 0 },
          { account: '2641', description: 'Ingående moms', debit: 28.80, credit: 0 },
          { account: '2440', description: 'Leverantörsskulder', debit: 0, credit: 268.80 },
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
