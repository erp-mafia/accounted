// Canonical DTO types for provider data normalization

// ============================================
// Resource Type
// ============================================

export const ResourceType = {
  SalesInvoices: 'salesinvoices',
  SupplierInvoices: 'supplierinvoices',
  Customers: 'customers',
  Suppliers: 'suppliers',
  Journals: 'journals',
  AccountingAccounts: 'accountingaccounts',
  CompanyInformation: 'companyinformation',
  /**
   * Kreditfakturor kept on a resource of their own by the provider (Bokio's
   * /credit-notes). Their mapper still yields a SalesInvoiceDto with
   * invoiceTypeCode 381, so consumers see one sales register.
   */
  CreditNotes: 'creditnotes',
  AccountingPeriods: 'accountingperiods',
  FinancialDimensions: 'financialdimensions',
  BalanceSheet: 'balancesheet',
  IncomeStatement: 'incomestatement',
  TrialBalances: 'trialbalances',
  Payments: 'payments',
  Attachments: 'attachments',
} as const;

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

// ============================================
// Common
// ============================================

export interface AmountType {
  value: number;
  currencyCode: string;
}

export interface PostalAddress {
  streetName?: string;
  additionalStreetName?: string;
  buildingNumber?: string;
  cityName?: string;
  postalZone?: string;
  countrySubentity?: string;
  countryCode?: string;
}

export interface Contact {
  name?: string;
  telephone?: string;
  email?: string;
  website?: string;
}

export interface PartyIdentification {
  id: string;
  schemeId?: string;
}

export interface PartyLegalEntity {
  registrationName: string;
  companyId?: string;
  companyIdSchemeId?: string;
}

export interface PartyDto {
  name: string;
  identifications: PartyIdentification[];
  postalAddress?: PostalAddress;
  legalEntity?: PartyLegalEntity;
  contact?: Contact;
}

export interface FinancialDimensionRef {
  dimensionId: string;
  dimensionValueId: string;
  name?: string;
}

export interface AllowanceChargeDto {
  chargeIndicator: boolean;
  reason?: string;
  amount: AmountType;
  taxPercent?: number;
}

export interface TaxTotalDto {
  taxAmount: AmountType;
  taxSubtotals?: TaxSubtotalDto[];
}

export interface TaxSubtotalDto {
  taxableAmount: AmountType;
  taxAmount: AmountType;
  taxCategory?: string;
  percent?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
}

/**
 * The verifikat that booked the invoice in the SOURCE system, as the provider
 * reports it ("A329"). Optional: only providers that expose it (Visma
 * eAccounting, Fortnox) set it, and only on booked invoices. The migration
 * uses it to link the imported invoice to the SIE-imported registration
 * voucher; see lib/providers/source-voucher.ts for the parsing rules.
 */
export interface SourceVoucherRefDto {
  series: string | null;
  number: number;
}

/**
 * The invoice a kreditfaktura credits, as the PROVIDER states it: the
 * provider's own id of that invoice and its number as printed. Never an
 * Accounted id. The importer resolves it against the invoices it has
 * imported (this run or an earlier one) and pairs the rows through
 * `invoices.credited_invoice_id` when it can; when it cannot, the number is
 * still written onto the credit note so the pairing stays legible.
 * Set only beside `invoiceTypeCode` 381.
 */
export interface CreditedInvoiceRefDto {
  /** The provider's id of the credited invoice, when it names one. */
  id?: string;
  /** The credited invoice's number as the provider prints it. */
  invoiceNumber?: string;
}

/** UNCL1001 document type of a kreditfaktura: the value `invoiceTypeCode` is read for. */
export const CREDIT_NOTE_TYPE_CODE = '381';

/**
 * The `invoiceTypeCode` a sales or a supplier document carries: 381 for a
 * credit note, nothing for an ordinary invoice. The sales mappers whose
 * provider sends negative credit amounts (Fortnox, Briox, Björn Lundén, WINT)
 * and EVERY supplier mapper set the field through this function, so the rule
 * is stated once; the Visma and Bokio sales mappers set it from their own
 * credit flag, which the contract test pins.
 *
 * A document is a credit note when the provider flags it as one, OR when its
 * payable total is negative. The second half is not a guess: a sales document
 * that owes the customer money cannot be a claim on them, and a supplier
 * document that owes US money cannot be a payable, whatever the source
 * system calls it. It is the only signal several payloads carry at all
 * (Fortnox's list form has no `Credit` field; Briox, Björn Lundén and WINT
 * document no credit flag this code could be verified against; Bokio's
 * supplier invoice has none). It is also
 * what keeps a wrong guess about the flag's wire format from failing silently:
 * the Fortnox mapper tested `Credit === true` while Fortnox's schema types the
 * flag as the string "true", and 3 200 credit notes reached production as
 * paid invoices without a single one ever reading as credited (#2789). The
 * supplier side had the mirror defect: about 40 supplier credit notes reached
 * production as ordinary invoices with a negative total (#2838).
 *
 * `flaggedByProvider` must mean "this document IS a credit note". A status
 * that says the document HAS BEEN credited (Bokio `credited`, WINT
 * `CreditStatus`) describes the original and must not be passed here: typing
 * the original 381 would reverse the sign of a real receivable.
 */
export function creditNoteTypeCode(
  flaggedByProvider: boolean,
  payableTotal: number,
): typeof CREDIT_NOTE_TYPE_CODE | undefined {
  return flaggedByProvider || payableTotal < 0 ? CREDIT_NOTE_TYPE_CODE : undefined;
}

// ============================================
// Sales Invoice
// ============================================

export type InvoiceStatusCode = 'draft' | 'sent' | 'booked' | 'paid' | 'overdue' | 'cancelled' | 'credited';

export interface LegalMonetaryTotalDto {
  /**
   * Sum of the line amounts, excluding VAT.
   *
   * Optional because several providers omit it from their list payloads
   * (Fortnox `Net`, Briox `net_amount`) and one never exposes it at all.
   * Absent means "the net was not established", NOT "the net equals the
   * gross": mappers must leave it undefined rather than fall back to
   * `payableAmount`, which silently turns every such invoice into a 0 kr VAT
   * record that still balances and so goes unnoticed.
   */
  lineExtensionAmount?: AmountType;
  taxExclusiveAmount?: AmountType;
  taxInclusiveAmount?: AmountType;
  allowanceTotalAmount?: AmountType;
  chargeTotalAmount?: AmountType;
  payableRoundingAmount?: AmountType;
  payableAmount: AmountType;
}

export interface PaymentStatusDto {
  paid: boolean;
  balance: AmountType;
  lastPaymentDate?: string;
  /**
   * Where `paid` came from. 'enum': the provider's explicit payment-status
   * enum (Visma PaymentStatus), which is authoritative: a zero balance beside
   * paid = false is a payload artefact, not a settlement, and consumers must
   * not let it override the flag. Absent or 'balance': `paid` was derived
   * from the balance itself, so a non-positive balance keeps its
   * drift-tolerant meaning (a residual öre resolves to paid).
   */
  source?: 'enum' | 'balance';
}

export interface SalesInvoiceLineDto {
  id: string;
  description?: string;
  quantity?: number;
  unitCode?: string;
  unitPrice?: AmountType;
  lineExtensionAmount: AmountType;
  taxPercent?: number;
  taxAmount?: AmountType;
  accountNumber?: string;
  itemName?: string;
  articleNumber?: string;
  financialDimensions?: FinancialDimensionRef[];
}

export interface SalesInvoiceDto {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string;
  deliveryDate?: string;
  /**
   * UNCL1001 document type: '381' marks a kreditfaktura. Every provider
   * mapper MUST set it for a credit note (see creditNoteTypeCode); it is
   * the one signal the importer reads
   * (extensions/general/arcim-migration/lib/entity-mapper.ts), and a mapper
   * that leaves it unset lands the credit note as an ordinary invoice.
   * Enforced for every registered sales mapper by
   * lib/providers/__tests__/credit-note-contract.test.ts.
   *
   * Amounts keep the sign the provider states them with (Fortnox and Visma
   * negative, Bokio magnitudes): the importer resolves the convention once.
   */
  invoiceTypeCode?: string;
  /** The invoice this credit note credits, when the provider names it. */
  creditedInvoiceRef?: CreditedInvoiceRefDto;
  currencyCode: string;
  status: InvoiceStatusCode;
  supplier: PartyDto;
  customer: PartyDto;
  lines: SalesInvoiceLineDto[];
  allowanceCharges?: AllowanceChargeDto[];
  taxTotal?: TaxTotalDto;
  legalMonetaryTotal: LegalMonetaryTotalDto;
  paymentStatus: PaymentStatusDto;
  paymentTerms?: string;
  note?: string;
  buyerReference?: string;
  orderReference?: string;
  financialDimensions?: FinancialDimensionRef[];
  sourceVoucher?: SourceVoucherRefDto;
  createdAt?: string;
  updatedAt?: string;
  _raw?: Record<string, unknown>;
}

// ============================================
// Supplier Invoice
// ============================================

export interface SupplierInvoiceLineDto {
  id: string;
  description?: string;
  quantity?: number;
  unitCode?: string;
  unitPrice?: AmountType;
  lineExtensionAmount: AmountType;
  taxPercent?: number;
  taxAmount?: AmountType;
  accountNumber?: string;
  itemName?: string;
  articleNumber?: string;
  financialDimensions?: FinancialDimensionRef[];
}

export interface SupplierInvoiceDto {
  id: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string;
  deliveryDate?: string;
  /**
   * UNCL1001 document type: '381' marks a supplier kreditfaktura. Every
   * supplier mapper MUST set it through creditNoteTypeCode; it is the one
   * signal the importer reads, and a mapper that leaves it unset lands the
   * credit note as an ordinary payable with a negative total (#2838).
   * Enforced for every registered supplier mapper by
   * lib/providers/__tests__/credit-note-contract.test.ts.
   *
   * Amounts keep the sign the provider states them with: the importer
   * resolves the convention once, to the magnitudes beside
   * `is_credit_note` that an in-app supplier credit note carries.
   */
  invoiceTypeCode?: string;
  /** The supplier invoice this credit note credits, when the provider names it. */
  creditedInvoiceRef?: CreditedInvoiceRefDto;
  currencyCode: string;
  status: InvoiceStatusCode;
  supplier: PartyDto;
  buyer: PartyDto;
  lines: SupplierInvoiceLineDto[];
  allowanceCharges?: AllowanceChargeDto[];
  taxTotal?: TaxTotalDto;
  legalMonetaryTotal: LegalMonetaryTotalDto;
  paymentStatus: PaymentStatusDto;
  paymentTerms?: string;
  note?: string;
  ocrNumber?: string;
  financialDimensions?: FinancialDimensionRef[];
  sourceVoucher?: SourceVoucherRefDto;
  createdAt?: string;
  updatedAt?: string;
  _raw?: Record<string, unknown>;
}

// ============================================
// Customer
// ============================================

export type CustomerType = 'company' | 'private';

export interface CustomerDto {
  id: string;
  customerNumber: string;
  type?: CustomerType;
  party: PartyDto;
  invoiceEmailCcAddresses?: string[];
  invoiceEmailBccAddresses?: string[];
  deliveryAddresses?: PostalAddress[];
  financialDimensions?: FinancialDimensionRef[];
  active: boolean;
  vatNumber?: string;
  defaultPaymentTermsDays?: number;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
  _raw?: Record<string, unknown>;
}

// ============================================
// Supplier
// ============================================

export interface SupplierDto {
  id: string;
  supplierNumber: string;
  party: PartyDto;
  deliveryAddresses?: PostalAddress[];
  financialDimensions?: FinancialDimensionRef[];
  active: boolean;
  vatNumber?: string;
  bankAccount?: string;
  bankGiro?: string;
  plusGiro?: string;
  defaultPaymentTermsDays?: number;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
  _raw?: Record<string, unknown>;
}

// ============================================
// Journal
// ============================================

export interface AccountingEntryDto {
  accountNumber: string;
  accountName?: string;
  debit: number;
  credit: number;
  transactionDate?: string;
  description?: string;
  financialDimensions?: FinancialDimensionRef[];
}

export interface AccountingSeriesDto {
  id: string;
  description?: string;
}

export interface JournalDto {
  id: string;
  journalNumber: string;
  series?: AccountingSeriesDto;
  description?: string;
  registrationDate: string;
  fiscalYear?: number;
  entries: AccountingEntryDto[];
  totalDebit?: AmountType;
  totalCredit?: AmountType;
  createdAt?: string;
  updatedAt?: string;
  _raw?: Record<string, unknown>;
}

// ============================================
// Accounting Account
// ============================================

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'other';

export interface AccountingAccountDto {
  accountNumber: string;
  name: string;
  description?: string;
  type?: AccountType;
  vatCode?: string;
  active: boolean;
  balanceBroughtForward?: number;
  balanceCarriedForward?: number;
  sruCode?: string;
  createdAt?: string;
  updatedAt?: string;
  _raw?: Record<string, unknown>;
}

// ============================================
// Company Information
// ============================================

export interface CompanyInformationDto {
  companyName: string;
  organizationNumber?: string;
  legalEntity?: PartyLegalEntity;
  address?: PostalAddress;
  contact?: Contact;
  vatNumber?: string;
  fiscalYearStart?: string;
  baseCurrency?: string;
  _raw?: Record<string, unknown>;
}

// ============================================
// Payment
// ============================================

export type PaymentMethodCode = 'bank_transfer' | 'card' | 'cash' | 'autogiro' | 'bankgiro' | 'plusgiro' | 'swish' | 'other';

export interface PaymentDto {
  id: string;
  paymentNumber?: string;
  invoiceId: string;
  paymentDate: string;
  amount: AmountType;
  paymentMethod?: PaymentMethodCode;
  reference?: string;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
  _raw?: Record<string, unknown>;
}
