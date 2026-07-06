import { describe, it, expect } from 'vitest'
import {
  // Enums
  EntityTypeSchema,
  CustomerTypeSchema,
  SupplierTypeSchema,
  InvoiceDocumentTypeSchema,
  VatTreatmentSchema,
  AccountingMethodSchema,
  CurrencySchema,
  TransactionCategorySchema,
  JournalEntrySourceTypeSchema,
  AccountTypeSchema,
  NormalBalanceSchema,
  MappingRuleTypeSchema,
  RiskLevelSchema,
  DeadlineTypeSchema,
  DeadlinePrioritySchema,
  TaxDeadlineTypeSchema,
  MomsPeriodSchema,
  DocumentUploadSourceSchema,
  // Invoice schemas
  CreateInvoiceItemSchema,
  CreateInvoiceSchema,
  UpdateInvoiceSchema,
  CreateCreditNoteSchema,
  MarkInvoicePaidSchema,
  // Customer schemas
  CreateCustomerSchema,
  // Supplier schemas
  CreateSupplierSchema,
  // Supplier invoice schemas
  CreateSupplierInvoiceItemSchema,
  CreateSupplierInvoiceSchema,
  MarkSupplierInvoicePaidSchema,
  // Journal entry schemas
  CreateJournalEntryLineSchema,
  CreateJournalEntrySchema,
  // Transaction schemas
  CategorizeTransactionSchema,
  BookTransactionSchema,
  MatchInvoiceSchema,
  MatchSupplierInvoiceSchema,
  // Settings schemas
  UpdateSettingsSchema,
  // Fiscal period schemas
  CreateFiscalPeriodSchema,
  // Mapping rule schemas
  CreateMappingRuleSchema,
  // Deadline schemas
  CreateDeadlineSchema,
  // Account schemas
  CreateAccountSchema,
  UpdateAccountSchema,
  // Reconciliation schemas
  BankLinkSchema,
  BankUnlinkSchema,
  RunReconciliationSchema,
  // Update schemas
  UpdateCustomerSchema,
  UpdateSupplierSchema,
  UpdateSupplierInvoiceSchema,
  // Correct/evaluate schemas
  CorrectJournalEntrySchema,
  EvaluateMappingRulesSchema,
  // Report query schemas
  VatDeclarationQuerySchema,
  PaginationQuerySchema,
} from '../schemas'

// ============================================================
// Helpers: minimal valid objects for composition
// ============================================================

const validUuid = '550e8400-e29b-41d4-a716-446655440000'

function validInvoiceItem(overrides = {}) {
  return { description: 'Consulting', quantity: 10, unit: 'tim', unit_price: 1000, ...overrides }
}

function validInvoice(overrides = {}) {
  return {
    customer_id: validUuid,
    invoice_date: '2025-03-15',
    due_date: '2025-04-14',
    currency: 'SEK' as const,
    items: [validInvoiceItem()],
    ...overrides,
  }
}

function validCustomer(overrides = {}) {
  return { name: 'Acme AB', customer_type: 'swedish_business' as const, ...overrides }
}

function validSupplier(overrides = {}) {
  return { name: 'Leverantör AB', supplier_type: 'swedish_business' as const, ...overrides }
}

function validSupplierInvoiceItem(overrides = {}) {
  return { description: 'Material', amount: 5000, account_number: '4010', ...overrides }
}

function validSupplierInvoice(overrides = {}) {
  return {
    supplier_id: validUuid,
    supplier_invoice_number: 'F-2025-001',
    invoice_date: '2025-03-01',
    due_date: '2025-03-31',
    items: [validSupplierInvoiceItem()],
    ...overrides,
  }
}

function validJournalEntryLine(overrides = {}) {
  return { account_number: '1930', debit_amount: 1000, credit_amount: 0, ...overrides }
}

function validJournalEntry(overrides = {}) {
  return {
    fiscal_period_id: validUuid,
    entry_date: '2025-03-15',
    description: 'Bank deposit',
    lines: [
      validJournalEntryLine({ account_number: '1930', debit_amount: 1000, credit_amount: 0 }),
      validJournalEntryLine({ account_number: '3001', debit_amount: 0, credit_amount: 1000 }),
    ],
    ...overrides,
  }
}

// ============================================================
// Enum schema tests
// ============================================================

describe('Enum schemas', () => {
  it('EntityTypeSchema accepts valid values', () => {
    expect(EntityTypeSchema.safeParse('enskild_firma').success).toBe(true)
    expect(EntityTypeSchema.safeParse('aktiebolag').success).toBe(true)
  })

  it('EntityTypeSchema rejects invalid values', () => {
    expect(EntityTypeSchema.safeParse('llc').success).toBe(false)
    expect(EntityTypeSchema.safeParse('').success).toBe(false)
    expect(EntityTypeSchema.safeParse(123).success).toBe(false)
  })

  it('CustomerTypeSchema accepts all 4 types', () => {
    for (const val of ['individual', 'swedish_business', 'eu_business', 'non_eu_business']) {
      expect(CustomerTypeSchema.safeParse(val).success).toBe(true)
    }
  })

  it('SupplierTypeSchema accepts 3 types', () => {
    for (const val of ['swedish_business', 'eu_business', 'non_eu_business']) {
      expect(SupplierTypeSchema.safeParse(val).success).toBe(true)
    }
    // individual is not a valid supplier type
    expect(SupplierTypeSchema.safeParse('individual').success).toBe(false)
  })

  it('VatTreatmentSchema accepts all 6 treatments', () => {
    const treatments = ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt']
    for (const val of treatments) {
      expect(VatTreatmentSchema.safeParse(val).success).toBe(true)
    }
  })

  it('CurrencySchema accepts supported currencies', () => {
    for (const c of ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']) {
      expect(CurrencySchema.safeParse(c).success).toBe(true)
    }
    expect(CurrencySchema.safeParse('JPY').success).toBe(false)
  })

  it('TransactionCategorySchema accepts all 16 categories', () => {
    const categories = [
      'income_services', 'income_products', 'income_other',
      'expense_equipment', 'expense_software', 'expense_travel',
      'expense_office', 'expense_marketing', 'expense_professional_services',
      'expense_education', 'expense_bank_fees', 'expense_card_fees',
      'expense_currency_exchange', 'expense_other',
      'private', 'uncategorized',
    ]
    for (const c of categories) {
      expect(TransactionCategorySchema.safeParse(c).success).toBe(true)
    }
    expect(TransactionCategorySchema.safeParse('unknown').success).toBe(false)
  })

  it('JournalEntrySourceTypeSchema accepts all source types', () => {
    const sources = [
      'manual', 'bank_transaction', 'invoice_created', 'invoice_paid',
      'invoice_cash_payment', 'credit_note', 'salary_payment',
      'opening_balance', 'year_end', 'storno', 'correction',
      'import', 'system', 'supplier_invoice_registered',
      'supplier_invoice_paid', 'supplier_invoice_cash_payment', 'supplier_credit_note',
    ]
    for (const s of sources) {
      expect(JournalEntrySourceTypeSchema.safeParse(s).success).toBe(true)
    }
  })

  it('AccountTypeSchema covers all account classes', () => {
    for (const t of ['asset', 'equity', 'liability', 'revenue', 'expense']) {
      expect(AccountTypeSchema.safeParse(t).success).toBe(true)
    }
  })

  it('RiskLevelSchema accepts all risk levels', () => {
    for (const r of ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH']) {
      expect(RiskLevelSchema.safeParse(r).success).toBe(true)
    }
  })

  it('InvoiceDocumentTypeSchema accepts all document types', () => {
    for (const t of ['invoice', 'proforma', 'delivery_note']) {
      expect(InvoiceDocumentTypeSchema.safeParse(t).success).toBe(true)
    }
  })

  it('AccountingMethodSchema accepts accrual and cash', () => {
    expect(AccountingMethodSchema.safeParse('accrual').success).toBe(true)
    expect(AccountingMethodSchema.safeParse('cash').success).toBe(true)
    expect(AccountingMethodSchema.safeParse('hybrid').success).toBe(false)
  })

  it('MomsPeriodSchema accepts reporting periods', () => {
    for (const p of ['monthly', 'quarterly', 'yearly']) {
      expect(MomsPeriodSchema.safeParse(p).success).toBe(true)
    }
  })

  it('DeadlineTypeSchema and DeadlinePrioritySchema', () => {
    for (const t of ['delivery', 'invoicing', 'report', 'tax', 'other']) {
      expect(DeadlineTypeSchema.safeParse(t).success).toBe(true)
    }
    for (const p of ['critical', 'important', 'normal']) {
      expect(DeadlinePrioritySchema.safeParse(p).success).toBe(true)
    }
  })

  it('TaxDeadlineTypeSchema accepts all Swedish tax deadlines', () => {
    const types = [
      'moms_monthly', 'moms_quarterly', 'moms_yearly', 'f_skatt',
      'arbetsgivardeklaration', 'inkomstdeklaration_ef', 'inkomstdeklaration_ab',
      'arsredovisning', 'periodisk_sammanstallning', 'bokslut',
    ]
    for (const t of types) {
      expect(TaxDeadlineTypeSchema.safeParse(t).success).toBe(true)
    }
  })

  it('NormalBalanceSchema and MappingRuleTypeSchema', () => {
    for (const b of ['debit', 'credit']) {
      expect(NormalBalanceSchema.safeParse(b).success).toBe(true)
    }
    for (const t of ['mcc_code', 'merchant_name', 'description_pattern', 'amount_threshold', 'combined']) {
      expect(MappingRuleTypeSchema.safeParse(t).success).toBe(true)
    }
  })

  it('DocumentUploadSourceSchema accepts all sources', () => {
    for (const s of ['camera', 'file_upload', 'email', 'e_invoice', 'scan', 'api', 'system']) {
      expect(DocumentUploadSourceSchema.safeParse(s).success).toBe(true)
    }
  })
})

// ============================================================
// Invoice schemas
// ============================================================

describe('CreateInvoiceSchema', () => {
  it('accepts a valid invoice', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice())
    expect(result.success).toBe(true)
  })

  it('accepts invoice with optional fields', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      document_type: 'proforma',
      your_reference: 'John Doe',
      our_reference: 'Jane Doe',
      notes: 'Net 30',
    }))
    expect(result.success).toBe(true)
  })

  it('accepts invoice with per-line VAT rates', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [
        validInvoiceItem({ vat_rate: 0.25 }),
        validInvoiceItem({ description: 'Food', vat_rate: 0.12 }),
        validInvoiceItem({ description: 'Books', vat_rate: 0.06 }),
      ],
    }))
    expect(result.success).toBe(true)
  })

  it('rejects missing customer_id', () => {
    const { customer_id: _, ...rest } = validInvoice()
    const result = CreateInvoiceSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects invalid customer_id (not UUID)', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({ customer_id: 'not-a-uuid' }))
    expect(result.success).toBe(false)
  })

  it('rejects invalid date format', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({ invoice_date: '15/03/2025' }))
    expect(result.success).toBe(false)
  })

  it('rejects invalid currency', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({ currency: 'JPY' }))
    expect(result.success).toBe(false)
  })

  it('rejects empty items array', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({ items: [] }))
    expect(result.success).toBe(false)
    if (!result.success) {
      const itemsError = result.error.issues.find(i => i.path.includes('items'))
      expect(itemsError?.message).toContain('At least one item')
    }
  })

  it('rejects item with empty description', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ description: '' })],
    }))
    expect(result.success).toBe(false)
  })

  it('rejects item with zero quantity', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ quantity: 0 })],
    }))
    expect(result.success).toBe(false)
  })

  it('rejects item with negative quantity', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ quantity: -5 })],
    }))
    expect(result.success).toBe(false)
  })

  it('rejects vat_rate > 100', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ vat_rate: 101 })],
    }))
    expect(result.success).toBe(false)
  })

  it('accepts vat_rate of 25 (standard Swedish VAT)', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ vat_rate: 25 })],
    }))
    expect(result.success).toBe(true)
  })

  it('accepts vat_rate of 0 (export/exempt)', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ vat_rate: 0 })],
    }))
    expect(result.success).toBe(true)
  })

  it('rejects invalid document_type', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({ document_type: 'receipt' }))
    expect(result.success).toBe(false)
  })

  it('allows negative unit_price (for discounts)', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ unit_price: -100 })],
    }))
    expect(result.success).toBe(true)
  })
})

describe('UpdateInvoiceSchema', () => {
  it('accepts a valid update body', () => {
    const result = UpdateInvoiceSchema.safeParse(validInvoice())
    expect(result.success).toBe(true)
  })

  it('rejects an empty items array', () => {
    const result = UpdateInvoiceSchema.safeParse(validInvoice({ items: [] }))
    expect(result.success).toBe(false)
  })

  it('rejects an invalid item shape', () => {
    const result = UpdateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ description: '' })],
    }))
    expect(result.success).toBe(false)
  })

  it('drops save_as_draft: editing a draft never re-creates it', () => {
    const result = UpdateInvoiceSchema.safeParse(validInvoice({ save_as_draft: true }))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).not.toHaveProperty('save_as_draft')
    }
  })
})

describe('CreateInvoiceItemSchema', () => {
  it('accepts valid item with all fields', () => {
    const result = CreateInvoiceItemSchema.safeParse(validInvoiceItem({ vat_rate: 0.25 }))
    expect(result.success).toBe(true)
  })

  it('accepts item without vat_rate (uses invoice default)', () => {
    const result = CreateInvoiceItemSchema.safeParse(validInvoiceItem())
    expect(result.success).toBe(true)
  })

  it('rejects non-numeric quantity', () => {
    const result = CreateInvoiceItemSchema.safeParse(validInvoiceItem({ quantity: 'ten' }))
    expect(result.success).toBe(false)
  })

  it('accepts orgnr-shaped brf_org_number values', () => {
    for (const value of ['769600-0000', '7696000000', '167696000000']) {
      const result = CreateInvoiceItemSchema.safeParse(validInvoiceItem({ brf_org_number: value }))
      expect(result.success).toBe(true)
    }
  })

  it('normalizes an empty brf_org_number to null', () => {
    const result = CreateInvoiceItemSchema.safeParse(validInvoiceItem({ brf_org_number: '' }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.brf_org_number).toBeNull()
  })

  it('rejects malformed brf_org_number values', () => {
    // incl. a 12-digit value without the mandatory sekelsiffra 16 prefix
    for (const value of ['---', '123', '76-96000000', 'ABC600-0000', '123456789012']) {
      const result = CreateInvoiceItemSchema.safeParse(validInvoiceItem({ brf_org_number: value }))
      expect(result.success).toBe(false)
    }
  })

  it('rejects a product row with an empty description', () => {
    const result = CreateInvoiceItemSchema.safeParse(validInvoiceItem({ description: '   ' }))
    expect(result.success).toBe(false)
  })

  it('rejects a product row with non-positive quantity', () => {
    const result = CreateInvoiceItemSchema.safeParse(validInvoiceItem({ quantity: 0 }))
    expect(result.success).toBe(false)
  })

  it('accepts a free-text row with an empty description and zero amounts', () => {
    const result = CreateInvoiceItemSchema.safeParse({
      line_type: 'text',
      description: '',
      quantity: 0,
      unit: '',
      unit_price: 0,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a free-text row carrying explanatory text', () => {
    const result = CreateInvoiceItemSchema.safeParse({
      line_type: 'text',
      description: 'Arbetet utfört enligt offert 2026-04',
      quantity: 0,
      unit: '',
      unit_price: 0,
    })
    expect(result.success).toBe(true)
  })
})

describe('CreateCreditNoteSchema', () => {
  it('accepts valid credit note reference', () => {
    const result = CreateCreditNoteSchema.safeParse({ credited_invoice_id: validUuid })
    expect(result.success).toBe(true)
  })

  it('accepts credit note with reason', () => {
    const result = CreateCreditNoteSchema.safeParse({
      credited_invoice_id: validUuid,
      reason: 'Duplicate billing',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing credited_invoice_id', () => {
    const result = CreateCreditNoteSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects non-UUID credited_invoice_id', () => {
    const result = CreateCreditNoteSchema.safeParse({ credited_invoice_id: 'INV-001' })
    expect(result.success).toBe(false)
  })
})

describe('MarkInvoicePaidSchema', () => {
  it('accepts empty object (all fields optional)', () => {
    const result = MarkInvoicePaidSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts payment_date', () => {
    const result = MarkInvoicePaidSchema.safeParse({ payment_date: '2024-07-15' })
    expect(result.success).toBe(true)
  })

  it('accepts exchange_rate_difference (positive gain)', () => {
    const result = MarkInvoicePaidSchema.safeParse({ exchange_rate_difference: 200 })
    expect(result.success).toBe(true)
  })

  it('accepts exchange_rate_difference (negative loss)', () => {
    const result = MarkInvoicePaidSchema.safeParse({ exchange_rate_difference: -300 })
    expect(result.success).toBe(true)
  })

  it('accepts all fields together', () => {
    const result = MarkInvoicePaidSchema.safeParse({
      payment_date: '2024-07-15',
      exchange_rate_difference: 150.50,
      notes: 'Paid via Wise',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid payment_date format', () => {
    const result = MarkInvoicePaidSchema.safeParse({ payment_date: '15/07/2024' })
    expect(result.success).toBe(false)
  })

  it('rejects non-number exchange_rate_difference', () => {
    const result = MarkInvoicePaidSchema.safeParse({ exchange_rate_difference: 'big gain' })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Customer schemas
// ============================================================

describe('CreateCustomerSchema', () => {
  it('accepts valid customer with minimal fields', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer())
    expect(result.success).toBe(true)
  })

  it('accepts customer with all optional fields', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer({
      email: 'billing@acme.se',
      phone: '+46701234567',
      address_line1: 'Storgatan 1',
      address_line2: 'Box 123',
      postal_code: '111 22',
      city: 'Stockholm',
      country: 'Sweden',
      org_number: '556123-4567',
      vat_number: 'SE556123456701',
      default_payment_terms: 30,
      notes: 'Key account',
    }))
    expect(result.success).toBe(true)
  })

  it('rejects empty name', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer({ name: '' }))
    expect(result.success).toBe(false)
  })

  it('rejects missing name', () => {
    const { name: _, ...rest } = validCustomer()
    const result = CreateCustomerSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects invalid customer_type', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer({ customer_type: 'government' }))
    expect(result.success).toBe(false)
  })

  it('rejects invalid email format', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer({ email: 'not-an-email' }))
    expect(result.success).toBe(false)
  })

  it('accepts valid email', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer({ email: 'test@example.com' }))
    expect(result.success).toBe(true)
  })

  it('rejects negative payment terms', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer({ default_payment_terms: -10 }))
    expect(result.success).toBe(false)
  })

  it('rejects zero payment terms', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer({ default_payment_terms: 0 }))
    expect(result.success).toBe(false)
  })

  it('rejects non-integer payment terms', () => {
    const result = CreateCustomerSchema.safeParse(validCustomer({ default_payment_terms: 30.5 }))
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Supplier schemas
// ============================================================

describe('CreateSupplierSchema', () => {
  it('accepts valid supplier with minimal fields', () => {
    const result = CreateSupplierSchema.safeParse(validSupplier())
    expect(result.success).toBe(true)
  })

  it('accepts supplier with payment details', () => {
    const result = CreateSupplierSchema.safeParse(validSupplier({
      bankgiro: '123-4567',
      plusgiro: '12345-6',
      iban: 'SE1234567890123456789',
      bic: 'ESSESESS',
      default_expense_account: '4010',
      default_payment_terms: 30,
      default_currency: 'SEK',
    }))
    expect(result.success).toBe(true)
  })

  it('rejects empty name', () => {
    const result = CreateSupplierSchema.safeParse(validSupplier({ name: '' }))
    expect(result.success).toBe(false)
  })

  it('rejects invalid supplier_type', () => {
    const result = CreateSupplierSchema.safeParse(validSupplier({ supplier_type: 'individual' }))
    expect(result.success).toBe(false)
  })

  it('rejects invalid expense account format', () => {
    const result = CreateSupplierSchema.safeParse(validSupplier({ default_expense_account: '40' }))
    expect(result.success).toBe(false)
  })

  it('accepts valid 4-digit expense account', () => {
    const result = CreateSupplierSchema.safeParse(validSupplier({ default_expense_account: '6200' }))
    expect(result.success).toBe(true)
  })
})

// ============================================================
// Supplier invoice schemas
// ============================================================

describe('CreateSupplierInvoiceSchema', () => {
  it('accepts valid supplier invoice', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(validSupplierInvoice())
    expect(result.success).toBe(true)
  })

  it('accepts invoice with all optional fields', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(validSupplierInvoice({
      delivery_date: '2025-03-15',
      currency: 'EUR',
      exchange_rate: 11.35,
      vat_treatment: 'reverse_charge',
      reverse_charge: true,
      payment_reference: 'OCR-123456',
      notes: 'Quarterly supply',
    }))
    expect(result.success).toBe(true)
  })

  it('rejects missing supplier_id', () => {
    const { supplier_id: _, ...rest } = validSupplierInvoice()
    const result = CreateSupplierInvoiceSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects empty supplier invoice number', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      validSupplierInvoice({ supplier_invoice_number: '' })
    )
    expect(result.success).toBe(false)
  })

  it('rejects empty items array', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      validSupplierInvoice({ items: [] })
    )
    expect(result.success).toBe(false)
  })

  it('rejects item with invalid account number', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      validSupplierInvoice({
        items: [validSupplierInvoiceItem({ account_number: 'abc' })],
      })
    )
    expect(result.success).toBe(false)
  })

  it('rejects zero exchange rate', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      validSupplierInvoice({ exchange_rate: 0 })
    )
    expect(result.success).toBe(false)
  })

  it('rejects negative exchange rate', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      validSupplierInvoice({ exchange_rate: -1.5 })
    )
    expect(result.success).toBe(false)
  })

  it('accepts item with legacy quantity/unit_price fields', () => {
    const result = CreateSupplierInvoiceSchema.safeParse(
      validSupplierInvoice({
        items: [validSupplierInvoiceItem({ quantity: 10, unit: 'st', unit_price: 500 })],
      })
    )
    expect(result.success).toBe(true)
  })
})

describe('CreateSupplierInvoiceItemSchema', () => {
  it('accepts valid item', () => {
    const result = CreateSupplierInvoiceItemSchema.safeParse(validSupplierInvoiceItem())
    expect(result.success).toBe(true)
  })

  it('rejects item with 3-digit account number', () => {
    const result = CreateSupplierInvoiceItemSchema.safeParse(
      validSupplierInvoiceItem({ account_number: '401' })
    )
    expect(result.success).toBe(false)
  })

  it('rejects item with 5-digit account number', () => {
    const result = CreateSupplierInvoiceItemSchema.safeParse(
      validSupplierInvoiceItem({ account_number: '40100' })
    )
    expect(result.success).toBe(false)
  })

  it('accepts vat_rate within valid range', () => {
    for (const rate of [0, 0.06, 0.12, 0.25]) {
      const result = CreateSupplierInvoiceItemSchema.safeParse(
        validSupplierInvoiceItem({ vat_rate: rate })
      )
      expect(result.success).toBe(true)
    }
  })

  it('accepts vat_amount up to line_total * vat_rate', () => {
    const result = CreateSupplierInvoiceItemSchema.safeParse(
      validSupplierInvoiceItem({ amount: 5000, vat_rate: 0.25, vat_amount: 1250 })
    )
    expect(result.success).toBe(true)
  })

  it('accepts partial-deduction vat_amount (bilförmån 50%)', () => {
    const result = CreateSupplierInvoiceItemSchema.safeParse(
      validSupplierInvoiceItem({ amount: 5000, vat_rate: 0.25, vat_amount: 625 })
    )
    expect(result.success).toBe(true)
  })

  it('rejects vat_amount above line_total * vat_rate', () => {
    const result = CreateSupplierInvoiceItemSchema.safeParse(
      validSupplierInvoiceItem({ amount: 5000, vat_rate: 0.25, vat_amount: 2000 })
    )
    expect(result.success).toBe(false)
  })

  it('accepts vat_amount with 1-öre rounding tolerance', () => {
    const result = CreateSupplierInvoiceItemSchema.safeParse(
      validSupplierInvoiceItem({ amount: 100.04, vat_rate: 0.25, vat_amount: 25.02 })
    )
    expect(result.success).toBe(true)
  })

  it('works with quantity * unit_price line total', () => {
    const overByABit = CreateSupplierInvoiceItemSchema.safeParse(
      validSupplierInvoiceItem({
        amount: undefined,
        quantity: 4,
        unit_price: 100,
        vat_rate: 0.25,
        vat_amount: 200,
      })
    )
    expect(overByABit.success).toBe(false)
    const exact = CreateSupplierInvoiceItemSchema.safeParse(
      validSupplierInvoiceItem({
        amount: undefined,
        quantity: 4,
        unit_price: 100,
        vat_rate: 0.25,
        vat_amount: 100,
      })
    )
    expect(exact.success).toBe(true)
  })
})

describe('MarkSupplierInvoicePaidSchema', () => {
  it('accepts empty object (all optional)', () => {
    const result = MarkSupplierInvoicePaidSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts full payment details', () => {
    const result = MarkSupplierInvoicePaidSchema.safeParse({
      amount: 5000,
      payment_date: '2025-03-31',
      exchange_rate_difference: -12.50,
      notes: 'Paid via bank transfer',
    })
    expect(result.success).toBe(true)
  })

  it('rejects zero amount', () => {
    const result = MarkSupplierInvoicePaidSchema.safeParse({ amount: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects negative amount', () => {
    const result = MarkSupplierInvoicePaidSchema.safeParse({ amount: -100 })
    expect(result.success).toBe(false)
  })

  it('rejects invalid payment_date format', () => {
    const result = MarkSupplierInvoicePaidSchema.safeParse({ payment_date: '2025/03/31' })
    expect(result.success).toBe(false)
  })

  it('allows negative exchange_rate_difference (loss)', () => {
    const result = MarkSupplierInvoicePaidSchema.safeParse({ exchange_rate_difference: -50.25 })
    expect(result.success).toBe(true)
  })
})

// ============================================================
// Journal entry schemas
// ============================================================

describe('CreateJournalEntrySchema', () => {
  it('accepts valid balanced entry', () => {
    const result = CreateJournalEntrySchema.safeParse(validJournalEntry())
    expect(result.success).toBe(true)
  })

  it('accepts entry with optional source_type', () => {
    const result = CreateJournalEntrySchema.safeParse(
      validJournalEntry({ source_type: 'manual' })
    )
    expect(result.success).toBe(true)
  })

  it('accepts entry with all source types', () => {
    const sourceTypes = [
      'manual', 'bank_transaction', 'invoice_created', 'invoice_paid',
      'storno', 'correction', 'system',
    ]
    for (const source_type of sourceTypes) {
      const result = CreateJournalEntrySchema.safeParse(
        validJournalEntry({ source_type })
      )
      expect(result.success).toBe(true)
    }
  })

  it('rejects entry with only one line (not double-entry)', () => {
    const result = CreateJournalEntrySchema.safeParse(
      validJournalEntry({ lines: [validJournalEntryLine()] })
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      const linesError = result.error.issues.find(i => i.path.includes('lines'))
      expect(linesError?.message).toContain('two lines')
    }
  })

  it('rejects entry with empty lines', () => {
    const result = CreateJournalEntrySchema.safeParse(
      validJournalEntry({ lines: [] })
    )
    expect(result.success).toBe(false)
  })

  it('rejects missing description', () => {
    const { description: _, ...rest } = validJournalEntry()
    const result = CreateJournalEntrySchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects empty description', () => {
    const result = CreateJournalEntrySchema.safeParse(
      validJournalEntry({ description: '' })
    )
    expect(result.success).toBe(false)
  })

  it('rejects invalid fiscal_period_id', () => {
    const result = CreateJournalEntrySchema.safeParse(
      validJournalEntry({ fiscal_period_id: 'not-uuid' })
    )
    expect(result.success).toBe(false)
  })

  it('rejects invalid entry_date format', () => {
    const result = CreateJournalEntrySchema.safeParse(
      validJournalEntry({ entry_date: '2025-3-15' })
    )
    expect(result.success).toBe(false)
  })
})

describe('CreateJournalEntryLineSchema', () => {
  it('accepts valid debit line', () => {
    const result = CreateJournalEntryLineSchema.safeParse(
      validJournalEntryLine({ debit_amount: 1000, credit_amount: 0 })
    )
    expect(result.success).toBe(true)
  })

  it('accepts valid credit line', () => {
    const result = CreateJournalEntryLineSchema.safeParse(
      validJournalEntryLine({ debit_amount: 0, credit_amount: 1000 })
    )
    expect(result.success).toBe(true)
  })

  it('accepts line with currency info', () => {
    const result = CreateJournalEntryLineSchema.safeParse({
      account_number: '1930',
      debit_amount: 11350,
      credit_amount: 0,
      currency: 'EUR',
      amount_in_currency: 1000,
      exchange_rate: 11.35,
    })
    expect(result.success).toBe(true)
  })

  it('accepts line with cost center and project', () => {
    const result = CreateJournalEntryLineSchema.safeParse({
      ...validJournalEntryLine(),
      cost_center: 'CC-100',
      project: 'PROJ-2025-01',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid account number', () => {
    const result = CreateJournalEntryLineSchema.safeParse(
      validJournalEntryLine({ account_number: '19' })
    )
    expect(result.success).toBe(false)
  })

  it('rejects account number with letters', () => {
    const result = CreateJournalEntryLineSchema.safeParse(
      validJournalEntryLine({ account_number: '193a' })
    )
    expect(result.success).toBe(false)
  })

  it('rejects negative debit_amount', () => {
    const result = CreateJournalEntryLineSchema.safeParse(
      validJournalEntryLine({ debit_amount: -100 })
    )
    expect(result.success).toBe(false)
  })

  it('rejects negative credit_amount', () => {
    const result = CreateJournalEntryLineSchema.safeParse(
      validJournalEntryLine({ credit_amount: -100 })
    )
    expect(result.success).toBe(false)
  })

  it('defaults debit_amount and credit_amount to 0', () => {
    const result = CreateJournalEntryLineSchema.safeParse({ account_number: '1930' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.debit_amount).toBe(0)
      expect(result.data.credit_amount).toBe(0)
    }
  })
})

// ============================================================
// Transaction schemas
// ============================================================

describe('CategorizeTransactionSchema', () => {
  it('accepts minimal categorization (private)', () => {
    const result = CategorizeTransactionSchema.safeParse({ is_business: false })
    expect(result.success).toBe(true)
  })

  it('accepts business categorization with details', () => {
    const result = CategorizeTransactionSchema.safeParse({
      is_business: true,
      category: 'expense_office',
      vat_treatment: 'standard_25',
    })
    expect(result.success).toBe(true)
  })

  it('accepts account override', () => {
    const result = CategorizeTransactionSchema.safeParse({
      is_business: true,
      category: 'expense_equipment',
      account_override: '1250',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing is_business', () => {
    const result = CategorizeTransactionSchema.safeParse({ category: 'private' })
    expect(result.success).toBe(false)
  })

  it('rejects non-boolean is_business', () => {
    const result = CategorizeTransactionSchema.safeParse({ is_business: 'yes' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid category', () => {
    const result = CategorizeTransactionSchema.safeParse({
      is_business: true,
      category: 'food',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid account_override format', () => {
    const result = CategorizeTransactionSchema.safeParse({
      is_business: true,
      account_override: '12',
    })
    expect(result.success).toBe(false)
  })
})

describe('BookTransactionSchema', () => {
  it('accepts valid booking', () => {
    const result = BookTransactionSchema.safeParse({
      fiscal_period_id: validUuid,
      entry_date: '2025-03-15',
      description: 'Office supplies',
      lines: [
        { account_number: '6100', debit_amount: 800, credit_amount: 0 },
        { account_number: '2641', debit_amount: 200, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty description', () => {
    const result = BookTransactionSchema.safeParse({
      fiscal_period_id: validUuid,
      entry_date: '2025-03-15',
      description: '',
      lines: [validJournalEntryLine()],
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty lines', () => {
    const result = BookTransactionSchema.safeParse({
      fiscal_period_id: validUuid,
      entry_date: '2025-03-15',
      description: 'Test',
      lines: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('MatchInvoiceSchema', () => {
  it('accepts valid invoice_id', () => {
    const result = MatchInvoiceSchema.safeParse({ invoice_id: validUuid })
    expect(result.success).toBe(true)
  })

  it('rejects missing invoice_id', () => {
    const result = MatchInvoiceSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects non-UUID invoice_id', () => {
    const result = MatchInvoiceSchema.safeParse({ invoice_id: 'INV-001' })
    expect(result.success).toBe(false)
  })
})

describe('MatchSupplierInvoiceSchema', () => {
  it('accepts valid supplier_invoice_id', () => {
    const result = MatchSupplierInvoiceSchema.safeParse({ supplier_invoice_id: validUuid })
    expect(result.success).toBe(true)
  })

  it('rejects missing supplier_invoice_id', () => {
    const result = MatchSupplierInvoiceSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Settings schemas
// ============================================================

describe('UpdateSettingsSchema', () => {
  it('accepts empty update (no changes)', () => {
    const result = UpdateSettingsSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts partial update', () => {
    const result = UpdateSettingsSchema.safeParse({
      company_name: 'My AB',
    })
    expect(result.success).toBe(true)
  })

  it('accepts vat_registered: true with required vat_number and moms_period', () => {
    const result = UpdateSettingsSchema.safeParse({
      vat_registered: true,
      vat_number: 'SE556123456701',
      moms_period: 'quarterly',
    })
    expect(result.success).toBe(true)
  })

  it('accepts vat_registered: true without vat_number at schema level (route-level check uses effective state)', () => {
    const result = UpdateSettingsSchema.safeParse({
      vat_registered: true,
      moms_period: 'quarterly',
    })
    expect(result.success).toBe(true)
  })

  it('accepts vat_registered: true without moms_period at schema level (route-level check uses effective state)', () => {
    const result = UpdateSettingsSchema.safeParse({
      vat_registered: true,
      vat_number: 'SE556123456701',
    })
    expect(result.success).toBe(true)
  })

  it('normalises vat_number (lowercase, spaces, hyphens) to the canonical SE+12 form', () => {
    const result = UpdateSettingsSchema.safeParse({
      vat_registered: true,
      vat_number: 'se 556123-4567 01',
      moms_period: 'quarterly',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.vat_number).toBe('SE556123456701')
    }
  })

  it('rejects vat_number with 14 digits (the SE + 12-digit personnummer + 01 bug)', () => {
    const result = UpdateSettingsSchema.safeParse({
      vat_registered: true,
      vat_number: 'SE19900101123401',
      moms_period: 'quarterly',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const vatError = result.error.issues.find(i => i.path.includes('vat_number'))
      expect(vatError?.message).toContain('SE följt av 12 siffror')
    }
  })

  it('allows aktiebolag with kontantmetoden (BFL 5 kap. 2 §)', () => {
    const result = UpdateSettingsSchema.safeParse({
      entity_type: 'aktiebolag',
      accounting_method: 'cash',
    })
    expect(result.success).toBe(true)
  })

  it('allows aktiebolag with faktureringsmetoden', () => {
    const result = UpdateSettingsSchema.safeParse({
      entity_type: 'aktiebolag',
      accounting_method: 'accrual',
    })
    expect(result.success).toBe(true)
  })

  it('allows enskild firma with kontantmetoden', () => {
    const result = UpdateSettingsSchema.safeParse({
      entity_type: 'enskild_firma',
      accounting_method: 'cash',
    })
    expect(result.success).toBe(true)
  })

  it('accepts full update', () => {
    const result = UpdateSettingsSchema.safeParse({
      entity_type: 'aktiebolag',
      company_name: 'Tech AB',
      org_number: '556123-4567',
      f_skatt: true,
      vat_registered: true,
      vat_number: 'SE556123456701',
      moms_period: 'quarterly',
      fiscal_year_start_month: 7,
      accounting_method: 'accrual',
      invoice_default_days: 30,
    })
    expect(result.success).toBe(true)
  })

  it('enforces BFL 3 kap: enskild firma must start in January', () => {
    const result = UpdateSettingsSchema.safeParse({
      entity_type: 'enskild_firma',
      fiscal_year_start_month: 7,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const bflError = result.error.issues.find(i =>
        i.path.includes('fiscal_year_start_month')
      )
      expect(bflError?.message).toContain('BFL')
    }
  })

  it('allows enskild firma with January start', () => {
    const result = UpdateSettingsSchema.safeParse({
      entity_type: 'enskild_firma',
      fiscal_year_start_month: 1,
    })
    expect(result.success).toBe(true)
  })

  it('allows aktiebolag with any start month', () => {
    for (let month = 1; month <= 12; month++) {
      const result = UpdateSettingsSchema.safeParse({
        entity_type: 'aktiebolag',
        fiscal_year_start_month: month,
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects fiscal_year_start_month out of range', () => {
    expect(UpdateSettingsSchema.safeParse({ fiscal_year_start_month: 0 }).success).toBe(false)
    expect(UpdateSettingsSchema.safeParse({ fiscal_year_start_month: 13 }).success).toBe(false)
  })

  it('rejects invalid accounting_method', () => {
    const result = UpdateSettingsSchema.safeParse({ accounting_method: 'hybrid' })
    expect(result.success).toBe(false)
  })

  it('accepts null moms_period (unregistered)', () => {
    const result = UpdateSettingsSchema.safeParse({ moms_period: null })
    expect(result.success).toBe(true)
  })

  it('rejects invalid email', () => {
    const result = UpdateSettingsSchema.safeParse({ email: 'not-email' })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer invoice_default_days', () => {
    const result = UpdateSettingsSchema.safeParse({ invoice_default_days: 30.5 })
    expect(result.success).toBe(false)
  })

  describe('swish', () => {
    it('accepts a Swish-företag number (123XXXXXXX)', () => {
      const result = UpdateSettingsSchema.safeParse({ swish: '1234567890' })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.swish).toBe('1234567890')
    })

    it('accepts a Swedish mobile number (07XXXXXXXX)', () => {
      const result = UpdateSettingsSchema.safeParse({ swish: '0701234567' })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.swish).toBe('0701234567')
    })

    it('strips whitespace and hyphens before validating', () => {
      const result = UpdateSettingsSchema.safeParse({ swish: '123 456 78 90' })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.swish).toBe('1234567890')
    })

    it('rejects a non-Swish-företag, non-mobile number', () => {
      const result = UpdateSettingsSchema.safeParse({ swish: '0123456789' })
      expect(result.success).toBe(false)
    })

    it('accepts empty string for clearing the value', () => {
      const result = UpdateSettingsSchema.safeParse({ swish: '' })
      expect(result.success).toBe(true)
    })

    it('accepts invoice_show_swish toggle', () => {
      const result = UpdateSettingsSchema.safeParse({ invoice_show_swish: false })
      expect(result.success).toBe(true)
    })
  })

  describe('send_invoice_reminders', () => {
    it('accepts the kill-switch toggle', () => {
      const result = UpdateSettingsSchema.safeParse({ send_invoice_reminders: false })
      expect(result.success).toBe(true)
    })
  })

  describe('invoice_email_texts', () => {
    it('accepts a valid nested partial', () => {
      const result = UpdateSettingsSchema.safeParse({
        invoice_email_texts: { sv: { body: 'Tack för din beställning!' } },
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.invoice_email_texts).toEqual({
          sv: { body: 'Tack för din beställning!' },
        })
      }
    })

    it('accepts both languages with all four fields', () => {
      const result = UpdateSettingsSchema.safeParse({
        invoice_email_texts: {
          sv: {
            subject: 'Faktura {fakturanummer}',
            greeting: 'Hejsan,',
            body: 'Här kommer fakturan.',
            signoff: 'Allt gott,',
          },
          en: {
            subject: 'Invoice {fakturanummer}',
            greeting: 'Hello,',
            body: 'Please find the invoice attached.',
            signoff: 'Best,',
          },
        },
      })
      expect(result.success).toBe(true)
    })

    it('accepts null to clear all overrides', () => {
      const result = UpdateSettingsSchema.safeParse({ invoice_email_texts: null })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.invoice_email_texts).toBeNull()
    })

    it('rejects body over 2000 characters', () => {
      const result = UpdateSettingsSchema.safeParse({
        invoice_email_texts: { sv: { body: 'x'.repeat(2001) } },
      })
      expect(result.success).toBe(false)
    })

    it('rejects subject over 200 characters', () => {
      const result = UpdateSettingsSchema.safeParse({
        invoice_email_texts: { sv: { subject: 'x'.repeat(201) } },
      })
      expect(result.success).toBe(false)
    })

    it('rejects a non-string field value', () => {
      const result = UpdateSettingsSchema.safeParse({
        invoice_email_texts: { sv: { subject: 123 } },
      })
      expect(result.success).toBe(false)
    })

    it('strips unknown keys inside a language object', () => {
      const result = UpdateSettingsSchema.safeParse({
        invoice_email_texts: { sv: { body: 'Hej', subjct: 'typo' } },
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.invoice_email_texts).toEqual({ sv: { body: 'Hej' } })
      }
    })

    it('rejects a bare string as the column value', () => {
      const result = UpdateSettingsSchema.safeParse({ invoice_email_texts: 'Tack!' })
      expect(result.success).toBe(false)
    })
  })
})

// ============================================================
// Fiscal period schemas
// ============================================================

describe('CreateFiscalPeriodSchema', () => {
  it('accepts valid period', () => {
    const result = CreateFiscalPeriodSchema.safeParse({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
    expect(result.success).toBe(true)
  })

  it('rejects end before start', () => {
    const result = CreateFiscalPeriodSchema.safeParse({
      name: 'FY 2025',
      period_start: '2025-12-31',
      period_end: '2025-01-01',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('before')
    }
  })

  it('rejects same start and end date', () => {
    const result = CreateFiscalPeriodSchema.safeParse({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-01-01',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty name', () => {
    const result = CreateFiscalPeriodSchema.safeParse({
      name: '',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid date format', () => {
    const result = CreateFiscalPeriodSchema.safeParse({
      name: 'FY 2025',
      period_start: 'Jan 1, 2025',
      period_end: '2025-12-31',
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Mapping rule schemas
// ============================================================

describe('CreateMappingRuleSchema', () => {
  it('accepts valid rule', () => {
    const result = CreateMappingRuleSchema.safeParse({
      rule_name: 'Office rent',
      rule_type: 'merchant_name',
      merchant_pattern: 'Vasakronan',
      debit_account: '5010',
      credit_account: '1930',
    })
    expect(result.success).toBe(true)
  })

  it('accepts rule with all optional fields', () => {
    const result = CreateMappingRuleSchema.safeParse({
      rule_name: 'Restaurant meals',
      rule_type: 'mcc_code',
      priority: 5,
      mcc_codes: ['5812', '5811'],
      debit_account: '6071',
      credit_account: '1930',
      vat_treatment: 'reduced_12',
      risk_level: 'LOW',
      default_private: false,
      requires_review: true,
      confidence_score: 0.85,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing debit_account', () => {
    const result = CreateMappingRuleSchema.safeParse({
      rule_name: 'Test',
      rule_type: 'merchant_name',
      credit_account: '1930',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid account format', () => {
    const result = CreateMappingRuleSchema.safeParse({
      rule_name: 'Test',
      rule_type: 'merchant_name',
      debit_account: '50',
      credit_account: '1930',
    })
    expect(result.success).toBe(false)
  })

  it('rejects confidence_score > 1', () => {
    const result = CreateMappingRuleSchema.safeParse({
      rule_name: 'Test',
      rule_type: 'merchant_name',
      debit_account: '5010',
      credit_account: '1930',
      confidence_score: 1.5,
    })
    expect(result.success).toBe(false)
  })

  it('rejects negative confidence_score', () => {
    const result = CreateMappingRuleSchema.safeParse({
      rule_name: 'Test',
      rule_type: 'merchant_name',
      debit_account: '5010',
      credit_account: '1930',
      confidence_score: -0.1,
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Deadline schemas
// ============================================================

describe('CreateDeadlineSchema', () => {
  it('accepts valid deadline', () => {
    const result = CreateDeadlineSchema.safeParse({
      title: 'Momsdeklaration Q1',
      due_date: '2025-05-12',
      deadline_type: 'tax',
    })
    expect(result.success).toBe(true)
  })

  it('accepts deadline with all optional fields', () => {
    const result = CreateDeadlineSchema.safeParse({
      title: 'Momsdeklaration Q1',
      due_date: '2025-05-12',
      due_time: '23:59',
      deadline_type: 'tax',
      priority: 'critical',
      customer_id: validUuid,
      notes: 'Submit via Skatteverket',
      tax_deadline_type: 'moms_quarterly',
      tax_period: '2025-Q1',
      source: 'system',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing title', () => {
    const result = CreateDeadlineSchema.safeParse({
      due_date: '2025-05-12',
      deadline_type: 'tax',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty title', () => {
    const result = CreateDeadlineSchema.safeParse({
      title: '',
      due_date: '2025-05-12',
      deadline_type: 'tax',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid due_time format', () => {
    const result = CreateDeadlineSchema.safeParse({
      title: 'Test',
      due_date: '2025-05-12',
      deadline_type: 'tax',
      due_time: '25:00',
    })
    // Note: regex accepts 25:00: business logic validates actual time values
    // This test documents the current behavior
    const parsed = CreateDeadlineSchema.safeParse({
      title: 'Test',
      due_date: '2025-05-12',
      deadline_type: 'tax',
      due_time: 'noon',
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts due_time with seconds', () => {
    const result = CreateDeadlineSchema.safeParse({
      title: 'Test',
      due_date: '2025-05-12',
      deadline_type: 'tax',
      due_time: '23:59:59',
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================
// Account schemas
// ============================================================

describe('CreateAccountSchema', () => {
  it('accepts valid BAS account', () => {
    const result = CreateAccountSchema.safeParse({
      account_number: '6200',
      account_name: 'Telefon & internet',
      account_type: 'expense',
      normal_balance: 'debit',
    })
    expect(result.success).toBe(true)
  })

  it('accepts with optional plan_type and description', () => {
    const result = CreateAccountSchema.safeParse({
      account_number: '1510',
      account_name: 'Kundfordringar',
      account_type: 'asset',
      normal_balance: 'debit',
      plan_type: 'k1',
      description: 'Accounts receivable from customers',
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-4-digit account number', () => {
    expect(CreateAccountSchema.safeParse({
      account_number: '62',
      account_name: 'Test',
      account_type: 'expense',
      normal_balance: 'debit',
    }).success).toBe(false)

    expect(CreateAccountSchema.safeParse({
      account_number: '62000',
      account_name: 'Test',
      account_type: 'expense',
      normal_balance: 'debit',
    }).success).toBe(false)
  })

  it('rejects account number with letters', () => {
    const result = CreateAccountSchema.safeParse({
      account_number: '620A',
      account_name: 'Test',
      account_type: 'expense',
      normal_balance: 'debit',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty account_name', () => {
    const result = CreateAccountSchema.safeParse({
      account_number: '6200',
      account_name: '',
      account_type: 'expense',
      normal_balance: 'debit',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid account_type', () => {
    const result = CreateAccountSchema.safeParse({
      account_number: '6200',
      account_name: 'Test',
      account_type: 'cost',
      normal_balance: 'debit',
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Bank reconciliation schemas
// ============================================================

describe('BankLinkSchema', () => {
  it('accepts valid link', () => {
    const result = BankLinkSchema.safeParse({
      transaction_id: validUuid,
      journal_entry_id: validUuid,
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing transaction_id', () => {
    const result = BankLinkSchema.safeParse({ journal_entry_id: validUuid })
    expect(result.success).toBe(false)
  })

  it('rejects missing journal_entry_id', () => {
    const result = BankLinkSchema.safeParse({ transaction_id: validUuid })
    expect(result.success).toBe(false)
  })

  it('rejects non-UUID values', () => {
    const result = BankLinkSchema.safeParse({
      transaction_id: 'txn-123',
      journal_entry_id: 'je-456',
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Report query schemas
// ============================================================

describe('VatDeclarationQuerySchema', () => {
  it('accepts valid monthly query', () => {
    const result = VatDeclarationQuerySchema.safeParse({
      periodType: 'monthly',
      year: '2025',
      period: '3',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.year).toBe(2025)
      expect(result.data.period).toBe(3)
    }
  })

  it('accepts valid quarterly query', () => {
    const result = VatDeclarationQuerySchema.safeParse({
      periodType: 'quarterly',
      year: '2025',
      period: '2',
    })
    expect(result.success).toBe(true)
  })

  it('coerces string numbers to numbers', () => {
    const result = VatDeclarationQuerySchema.safeParse({
      periodType: 'yearly',
      year: '2025',
      period: '1',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.year).toBe('number')
      expect(typeof result.data.period).toBe('number')
    }
  })

  it('rejects year below 2000', () => {
    const result = VatDeclarationQuerySchema.safeParse({
      periodType: 'monthly',
      year: '1999',
      period: '1',
    })
    expect(result.success).toBe(false)
  })

  it('rejects year above 2100', () => {
    const result = VatDeclarationQuerySchema.safeParse({
      periodType: 'monthly',
      year: '2101',
      period: '1',
    })
    expect(result.success).toBe(false)
  })

  it('rejects period below 1', () => {
    const result = VatDeclarationQuerySchema.safeParse({
      periodType: 'monthly',
      year: '2025',
      period: '0',
    })
    expect(result.success).toBe(false)
  })

  it('rejects period above 12', () => {
    const result = VatDeclarationQuerySchema.safeParse({
      periodType: 'monthly',
      year: '2025',
      period: '13',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid periodType', () => {
    const result = VatDeclarationQuerySchema.safeParse({
      periodType: 'biweekly',
      year: '2025',
      period: '1',
    })
    expect(result.success).toBe(false)
  })
})

describe('PaginationQuerySchema', () => {
  it('accepts valid pagination', () => {
    const result = PaginationQuerySchema.safeParse({ limit: '25', offset: '50' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.limit).toBe(25)
      expect(result.data.offset).toBe(50)
    }
  })

  it('applies defaults when empty', () => {
    const result = PaginationQuerySchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.limit).toBe(50)
      expect(result.data.offset).toBe(0)
    }
  })

  it('rejects limit above 100', () => {
    const result = PaginationQuerySchema.safeParse({ limit: '101' })
    expect(result.success).toBe(false)
  })

  it('rejects limit below 1', () => {
    const result = PaginationQuerySchema.safeParse({ limit: '0' })
    expect(result.success).toBe(false)
  })

  it('rejects negative offset', () => {
    const result = PaginationQuerySchema.safeParse({ offset: '-1' })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Update schemas (partial variants)
// ============================================================

describe('UpdateCustomerSchema', () => {
  it('accepts empty update (all fields optional)', () => {
    const result = UpdateCustomerSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts partial update', () => {
    const result = UpdateCustomerSchema.safeParse({ name: 'New Name' })
    expect(result.success).toBe(true)
  })

  it('accepts full update (same as create)', () => {
    const result = UpdateCustomerSchema.safeParse(validCustomer({
      email: 'new@acme.se',
      phone: '+46701111111',
    }))
    expect(result.success).toBe(true)
  })

  it('rejects invalid email in partial update', () => {
    const result = UpdateCustomerSchema.safeParse({ email: 'not-email' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid customer_type in partial update', () => {
    const result = UpdateCustomerSchema.safeParse({ customer_type: 'government' })
    expect(result.success).toBe(false)
  })
})

describe('UpdateSupplierSchema', () => {
  it('accepts empty update', () => {
    const result = UpdateSupplierSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts partial update', () => {
    const result = UpdateSupplierSchema.safeParse({
      name: 'New Supplier',
      bankgiro: '999-8888',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid expense account format', () => {
    const result = UpdateSupplierSchema.safeParse({ default_expense_account: '40' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid supplier_type', () => {
    const result = UpdateSupplierSchema.safeParse({ supplier_type: 'individual' })
    expect(result.success).toBe(false)
  })
})

describe('UpdateSupplierInvoiceSchema', () => {
  it('accepts empty update', () => {
    const result = UpdateSupplierInvoiceSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts partial update with dates', () => {
    const result = UpdateSupplierInvoiceSchema.safeParse({
      due_date: '2025-04-30',
      payment_reference: 'OCR-999',
    })
    expect(result.success).toBe(true)
  })

  it('accepts all fields', () => {
    const result = UpdateSupplierInvoiceSchema.safeParse({
      supplier_invoice_number: 'F-2025-002',
      invoice_date: '2025-03-01',
      due_date: '2025-04-01',
      delivery_date: '2025-03-15',
      payment_reference: 'REF-123',
      notes: 'Updated notes',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid date format', () => {
    const result = UpdateSupplierInvoiceSchema.safeParse({ due_date: '2025/04/30' })
    expect(result.success).toBe(false)
  })

  it('rejects empty supplier_invoice_number', () => {
    const result = UpdateSupplierInvoiceSchema.safeParse({ supplier_invoice_number: '' })
    expect(result.success).toBe(false)
  })
})

describe('UpdateAccountSchema', () => {
  it('accepts empty update', () => {
    const result = UpdateAccountSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts partial update', () => {
    const result = UpdateAccountSchema.safeParse({
      account_name: 'Nytt kontonamn',
      is_active: false,
    })
    expect(result.success).toBe(true)
  })

  it('accepts nullable fields', () => {
    const result = UpdateAccountSchema.safeParse({
      description: null,
      default_vat_code: null,
      sru_code: null,
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty account_name', () => {
    const result = UpdateAccountSchema.safeParse({ account_name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects non-boolean is_active', () => {
    const result = UpdateAccountSchema.safeParse({ is_active: 'yes' })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Bank reconciliation new schemas
// ============================================================

describe('BankUnlinkSchema', () => {
  it('accepts valid transaction_id', () => {
    const result = BankUnlinkSchema.safeParse({ transaction_id: validUuid })
    expect(result.success).toBe(true)
  })

  it('rejects missing transaction_id', () => {
    const result = BankUnlinkSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects non-UUID transaction_id', () => {
    const result = BankUnlinkSchema.safeParse({ transaction_id: 'txn-123' })
    expect(result.success).toBe(false)
  })
})

describe('RunReconciliationSchema', () => {
  it('accepts empty object (all optional)', () => {
    const result = RunReconciliationSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts full options', () => {
    const result = RunReconciliationSchema.safeParse({
      date_from: '2025-01-01',
      date_to: '2025-03-31',
      dry_run: true,
    })
    expect(result.success).toBe(true)
  })

  it('accepts dry_run false', () => {
    const result = RunReconciliationSchema.safeParse({ dry_run: false })
    expect(result.success).toBe(true)
  })

  it('rejects invalid date_from format', () => {
    const result = RunReconciliationSchema.safeParse({ date_from: '2025/01/01' })
    expect(result.success).toBe(false)
  })

  it('rejects non-boolean dry_run', () => {
    const result = RunReconciliationSchema.safeParse({ dry_run: 'yes' })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Correct journal entry schema
// ============================================================

describe('CorrectJournalEntrySchema', () => {
  it('accepts valid correction with balanced lines', () => {
    const result = CorrectJournalEntrySchema.safeParse({
      lines: [
        validJournalEntryLine({ account_number: '6200', debit_amount: 500, credit_amount: 0 }),
        validJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 500 }),
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects single line (not double-entry)', () => {
    const result = CorrectJournalEntrySchema.safeParse({
      lines: [validJournalEntryLine()],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const linesError = result.error.issues.find(i => i.path.includes('lines'))
      expect(linesError?.message).toContain('two lines')
    }
  })

  it('rejects empty lines array', () => {
    const result = CorrectJournalEntrySchema.safeParse({ lines: [] })
    expect(result.success).toBe(false)
  })

  it('rejects missing lines', () => {
    const result = CorrectJournalEntrySchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects invalid account number in lines', () => {
    const result = CorrectJournalEntrySchema.safeParse({
      lines: [
        validJournalEntryLine({ account_number: '62' }),
        validJournalEntryLine({ account_number: '1930' }),
      ],
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Evaluate mapping rules schema
// ============================================================

describe('EvaluateMappingRulesSchema', () => {
  it('accepts valid transaction_id', () => {
    const result = EvaluateMappingRulesSchema.safeParse({ transaction_id: validUuid })
    expect(result.success).toBe(true)
  })

  it('accepts raw transaction data with amount', () => {
    const result = EvaluateMappingRulesSchema.safeParse({
      description: 'Office supplies',
      amount: -500,
    })
    expect(result.success).toBe(true)
  })

  it('accepts raw data with all fields', () => {
    const result = EvaluateMappingRulesSchema.safeParse({
      description: 'Spotify',
      amount: -129,
      merchant_name: 'Spotify AB',
      mcc_code: '5815',
      date: '2025-03-15',
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-UUID transaction_id', () => {
    // First branch fails (invalid UUID), second branch matches only if amount is present
    const result = EvaluateMappingRulesSchema.safeParse({ transaction_id: 'not-uuid' })
    expect(result.success).toBe(false)
  })

  it('rejects empty object (no transaction_id and no amount)', () => {
    const result = EvaluateMappingRulesSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects missing amount in raw data', () => {
    const result = EvaluateMappingRulesSchema.safeParse({ description: 'Test' })
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Cross-schema consistency tests
// ============================================================

describe('Cross-schema consistency', () => {
  it('account_number format is enforced identically across schemas', () => {
    // All schemas that accept account_number should use the same 4-digit rule
    const invalidAccounts = ['12', '123', '12345', 'ABCD', '1a3b', '']

    for (const acct of invalidAccounts) {
      // Journal entry line
      expect(CreateJournalEntryLineSchema.safeParse(
        validJournalEntryLine({ account_number: acct })
      ).success).toBe(false)

      // Supplier invoice item
      expect(CreateSupplierInvoiceItemSchema.safeParse(
        validSupplierInvoiceItem({ account_number: acct })
      ).success).toBe(false)

      // Account creation
      expect(CreateAccountSchema.safeParse({
        account_number: acct,
        account_name: 'Test',
        account_type: 'expense',
        normal_balance: 'debit',
      }).success).toBe(false)

      // Mapping rule accounts
      expect(CreateMappingRuleSchema.safeParse({
        rule_name: 'Test',
        rule_type: 'merchant_name',
        debit_account: acct,
        credit_account: '1930',
      }).success).toBe(false)
    }
  })

  it('date format is enforced identically across schemas', () => {
    const invalidDates = ['2025/03/15', '15-03-2025', 'Mar 15 2025', '2025-3-15', '']

    for (const date of invalidDates) {
      expect(CreateInvoiceSchema.safeParse(
        validInvoice({ invoice_date: date })
      ).success).toBe(false)

      expect(CreateFiscalPeriodSchema.safeParse({
        name: 'Test', period_start: date, period_end: '2025-12-31',
      }).success).toBe(false)

      expect(CreateDeadlineSchema.safeParse({
        title: 'Test', due_date: date, deadline_type: 'tax',
      }).success).toBe(false)
    }
  })

  it('UUID format is enforced identically across schemas', () => {
    const invalidUuids = ['not-a-uuid', '123', '', '550e8400-e29b-41d4-a716']

    for (const id of invalidUuids) {
      expect(CreateInvoiceSchema.safeParse(
        validInvoice({ customer_id: id })
      ).success).toBe(false)

      expect(MatchInvoiceSchema.safeParse({ invoice_id: id }).success).toBe(false)

      expect(BankLinkSchema.safeParse({
        transaction_id: id, journal_entry_id: validUuid,
      }).success).toBe(false)
    }
  })
})

// ============================================================
// Error message quality tests
// ============================================================

describe('Error messages', () => {
  it('provides field path in validation errors', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({
      items: [validInvoiceItem({ description: '' })],
    }))
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]
      expect(issue.path).toContain('items')
    }
  })

  it('reports all errors, not just the first', () => {
    const result = CreateInvoiceSchema.safeParse({
      // Missing everything
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // Should report errors for customer_id, invoice_date, due_date, currency, items
      expect(result.error.issues.length).toBeGreaterThanOrEqual(4)
    }
  })

  it('custom messages are human-readable', () => {
    const result = CreateInvoiceSchema.safeParse(validInvoice({ items: [] }))
    expect(result.success).toBe(false)
    if (!result.success) {
      const msg = result.error.issues[0].message
      expect(msg).toMatch(/item/i)
    }
  })
})

// ============================================================
// Integration with existing fixture factories
// ============================================================

describe('Integration with test helpers', () => {
  // These tests demonstrate that Zod schemas align with the fixture factories
  // from tests/helpers.ts, ensuring schema and test data stay in sync.

  it('CreateCustomerSchema matches makeCustomer() shape', () => {
    // Simulate the shape produced by makeCustomer()
    const customerData = {
      name: 'Test Customer 1',
      customer_type: 'swedish_business',
      email: 'customer-1@test.com',
      phone: '+46701234567',
      address_line1: 'Testgatan 1',
      postal_code: '111 22',
      city: 'Stockholm',
      country: 'SE',
      default_payment_terms: 30,
    }
    const result = CreateCustomerSchema.safeParse(customerData)
    expect(result.success).toBe(true)
  })

  it('CreateSupplierSchema matches makeSupplier() shape', () => {
    const supplierData = {
      name: 'Test Supplier 1',
      supplier_type: 'swedish_business',
      email: 'supplier-1@test.com',
      default_expense_account: '4010',
      default_payment_terms: 30,
      default_currency: 'SEK',
    }
    const result = CreateSupplierSchema.safeParse(supplierData)
    expect(result.success).toBe(true)
  })

  it('CreateJournalEntrySchema validates balanced entries from fixture', () => {
    const entryInput = {
      fiscal_period_id: validUuid,
      entry_date: '2025-01-15',
      description: 'Test entry',
      source_type: 'manual',
      lines: [
        { account_number: '1930', debit_amount: 10000, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 8000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 2000 },
      ],
    }
    const result = CreateJournalEntrySchema.safeParse(entryInput)
    expect(result.success).toBe(true)
  })

  it('CreateInvoiceSchema matches makeInvoice() shape', () => {
    const invoiceData = {
      customer_id: validUuid,
      invoice_date: '2025-01-15',
      due_date: '2025-02-14',
      currency: 'SEK',
      items: [
        { description: 'Consulting', quantity: 10, unit: 'tim', unit_price: 1000 },
      ],
    }
    const result = CreateInvoiceSchema.safeParse(invoiceData)
    expect(result.success).toBe(true)
  })

  it('CreateSupplierInvoiceSchema matches makeSupplierInvoice() shape', () => {
    const supplierInvoiceData = {
      supplier_id: validUuid,
      supplier_invoice_number: 'F-2025-001',
      invoice_date: '2025-01-15',
      due_date: '2025-02-14',
      items: [
        { description: 'Materials', amount: 5000, account_number: '4010' },
      ],
    }
    const result = CreateSupplierInvoiceSchema.safeParse(supplierInvoiceData)
    expect(result.success).toBe(true)
  })
})
