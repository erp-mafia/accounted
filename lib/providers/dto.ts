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
  invoiceTypeCode?: string;
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
  invoiceTypeCode?: string;
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

// ============================================
// Accounting Period
// ============================================

export type PeriodStatus = 'open' | 'closed' | 'locked';

export interface AccountingPeriodDto {
  id: string;
  fiscalYear: number;
  fromDate: string;
  toDate: string;
  status?: PeriodStatus;
  description?: string;
  _raw?: Record<string, unknown>;
}

// ============================================
// Financial Dimension
// ============================================

export interface FinancialDimensionValueDto {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export interface FinancialDimensionDto {
  id: string;
  name: string;
  description?: string;
  values: FinancialDimensionValueDto[];
  _raw?: Record<string, unknown>;
}

// ============================================
// Reports
// ============================================

export interface FinancialReportCategoryDto {
  name: string;
  amount: AmountType;
  children?: FinancialReportCategoryDto[];
  accounts?: { accountNumber: string; name?: string; amount: AmountType }[];
}

export interface BalanceSheetDto {
  fiscalYear: number;
  periodEnd: string;
  baseCurrency: string;
  assets: FinancialReportCategoryDto;
  liabilities: FinancialReportCategoryDto;
  equity: FinancialReportCategoryDto;
  _raw?: Record<string, unknown>;
}

export interface IncomeStatementDto {
  fiscalYear: number;
  periodStart: string;
  periodEnd: string;
  baseCurrency: string;
  revenue: FinancialReportCategoryDto;
  expenses: FinancialReportCategoryDto;
  netIncome: AmountType;
  _raw?: Record<string, unknown>;
}

export interface TrialBalanceEntryDto {
  accountNumber: string;
  accountName?: string;
  openingDebit: number;
  openingCredit: number;
  periodDebit: number;
  periodCredit: number;
  closingDebit: number;
  closingCredit: number;
}

export interface TrialBalanceDto {
  fiscalYear: number;
  periodStart: string;
  periodEnd: string;
  baseCurrency: string;
  entries: TrialBalanceEntryDto[];
  _raw?: Record<string, unknown>;
}

// ============================================
// Attachment
// ============================================

export type AttachmentType = 'pdf' | 'image' | 'xml' | 'other';

export interface AttachmentDto {
  id: string;
  fileName: string;
  mimeType?: string;
  type?: AttachmentType;
  size?: number;
  downloadUrl?: string;
  createdAt?: string;
  _raw?: Record<string, unknown>;
}
