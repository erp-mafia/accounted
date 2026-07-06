import type {
  SalesInvoiceDto, SalesInvoiceLineDto, InvoiceStatusCode,
  LegalMonetaryTotalDto, PaymentStatusDto,
  SupplierInvoiceDto, SupplierInvoiceLineDto,
  CustomerDto, SupplierDto,
  JournalDto, AccountingEntryDto,
  AccountingAccountDto, AccountType,
  CompanyInformationDto,
  AmountType, PartyDto,
} from '../dto';

function amount(value: number | undefined | null, currency: string = 'SEK'): AmountType {
  return { value: value ?? 0, currencyCode: currency };
}

/** Briox often serializes numbers as strings ("250.00"): coerce defensively. */
function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Single source of truth for "is this invoice fully settled?", used by BOTH
 * deriveInvoiceStatus and the paymentStatus.paid flag so they can never
 * diverge (mirrors the Fortnox mapper). An ABSENT balance is treated as NOT
 * paid: only an explicit paid status/flag, or a present non-positive balance
 * on a positive-total invoice, counts as paid.
 */
function isFullyPaid(raw: Record<string, unknown>): boolean {
  if (raw['status'] === 'paid' || raw['fully_paid'] === true) return true;
  const total = num(raw['total_amount']);
  const balance = num(raw['balance']);
  return total != null && total > 0 && balance != null && balance <= 0;
}

function deriveInvoiceStatus(raw: Record<string, unknown>): InvoiceStatusCode {
  const status = raw['status'] as string | undefined;
  if (status === 'cancelled') return 'cancelled';
  if (status === 'credited') return 'credited';
  if (isFullyPaid(raw)) return 'paid';
  if (status === 'booked' || raw['booked'] === true) return 'booked';
  if (status === 'sent' || raw['sent'] === true) return 'sent';
  if (status === 'overdue') return 'overdue';
  return 'draft';
}

function buildParty(name: string, orgNumber?: string, raw?: Record<string, unknown>): PartyDto {
  return {
    name,
    identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [],
    postalAddress: raw ? {
      streetName: (raw['address1'] ?? raw['address']) as string | undefined,
      additionalStreetName: raw['address2'] as string | undefined,
      cityName: raw['city'] as string | undefined,
      postalZone: (raw['zip_code'] ?? raw['postal_code']) as string | undefined,
      countryCode: raw['country'] as string | undefined,
    } : undefined,
    legalEntity: orgNumber ? {
      registrationName: name,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    } : undefined,
    contact: {
      email: raw?.['email'] as string | undefined,
      telephone: raw?.['phone'] as string | undefined,
    },
  };
}

export function mapBrioxToSalesInvoice(raw: Record<string, unknown>): SalesInvoiceDto {
  const currency = (raw['currency_code'] as string) ?? 'SEK';
  const total = num(raw['total_amount']) ?? 0;
  // Default an ABSENT balance to the full total (= fully unpaid), never 0, so
  // a missing balance never silently reads as paid. When paid, force balance
  // to 0 so the DTO is internally consistent (paid ⇒ nothing outstanding).
  const paid = isFullyPaid(raw);
  const balance = paid ? 0 : (num(raw['balance']) ?? total);

  const rows = (raw['rows'] as Record<string, unknown>[] | undefined) ?? [];
  // Line-level amounts arrive from the same string-serializing API as the
  // header amounts: coerce ALL numerics through num(), never blind casts.
  const lines: SalesInvoiceLineDto[] = rows.map((row, idx) => ({
    id: String(row['id'] ?? idx + 1),
    description: row['description'] as string | undefined,
    quantity: num(row['quantity']),
    unitCode: row['unit'] as string | undefined,
    unitPrice: row['price'] != null ? amount(num(row['price']), currency) : undefined,
    lineExtensionAmount: amount(num(row['total']), currency),
    taxPercent: num(row['vat_rate']),
    accountNumber: row['account_number'] != null ? String(row['account_number']) : undefined,
    articleNumber: row['article_number'] as string | undefined,
    itemName: row['description'] as string | undefined,
  }));

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: amount(num(raw['net_amount']) ?? total, currency),
    taxInclusiveAmount: amount(total, currency),
    payableAmount: amount(total, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid,
    balance: amount(balance, currency),
  };

  return {
    id: String(raw['id'] ?? ''),
    invoiceNumber: String(raw['invoice_number'] ?? raw['id'] ?? ''),
    issueDate: (raw['invoice_date'] as string) ?? '',
    dueDate: raw['due_date'] as string | undefined,
    currencyCode: currency,
    status: deriveInvoiceStatus(raw),
    supplier: buildParty(''),
    customer: buildParty(
      (raw['customer_name'] ?? '') as string,
      raw['customer_org_number'] as string | undefined,
    ),
    lines,
    legalMonetaryTotal,
    paymentStatus,
    paymentTerms: raw['payment_terms'] as string | undefined,
    note: raw['remarks'] as string | undefined,
    buyerReference: raw['your_reference'] as string | undefined,
    orderReference: raw['your_order_number'] as string | undefined,
    updatedAt: raw['modified_date'] as string | undefined,
    _raw: raw,
  };
}

export function mapBrioxToSupplierInvoice(raw: Record<string, unknown>): SupplierInvoiceDto {
  const currency = (raw['currency_code'] as string) ?? 'SEK';
  const total = num(raw['total_amount']) ?? 0;
  // Same absent-balance hardening as the sales path: missing balance reads as
  // fully unpaid, paid forces balance to 0.
  const paid = isFullyPaid(raw);
  const balance = paid ? 0 : (num(raw['balance']) ?? total);

  const rows = (raw['rows'] as Record<string, unknown>[] | undefined) ?? [];
  // Same string-coercion hardening as the sales path (Briox serializes
  // numbers as strings): route every numeric line field through num().
  const lines: SupplierInvoiceLineDto[] = rows.map((row, idx) => ({
    id: String(row['id'] ?? idx + 1),
    description: row['description'] as string | undefined,
    quantity: num(row['quantity']),
    unitPrice: row['price'] != null ? amount(num(row['price']), currency) : undefined,
    lineExtensionAmount: amount(num(row['total']), currency),
    accountNumber: row['account_number'] != null ? String(row['account_number']) : undefined,
  }));

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: amount(num(raw['net_amount']) ?? total, currency),
    taxInclusiveAmount: amount(total, currency),
    payableAmount: amount(total, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid,
    balance: amount(balance, currency),
  };

  return {
    id: String(raw['id'] ?? ''),
    invoiceNumber: String(raw['invoice_number'] ?? raw['id'] ?? ''),
    issueDate: (raw['invoice_date'] as string) ?? '',
    dueDate: raw['due_date'] as string | undefined,
    currencyCode: currency,
    status: deriveInvoiceStatus(raw),
    supplier: buildParty(
      (raw['supplier_name'] ?? '') as string,
      raw['supplier_org_number'] as string | undefined,
    ),
    buyer: buildParty(''),
    lines,
    legalMonetaryTotal,
    paymentStatus,
    ocrNumber: raw['ocr'] as string | undefined,
    updatedAt: raw['modified_date'] as string | undefined,
    _raw: raw,
  };
}

export function mapBrioxToCustomer(raw: Record<string, unknown>): CustomerDto {
  const name = (raw['name'] as string) ?? '';
  const orgNumber = raw['org_number'] as string | undefined;

  return {
    id: String(raw['id'] ?? ''),
    customerNumber: String(raw['customer_number'] ?? raw['id'] ?? ''),
    type: raw['type'] === 'private' ? 'private' : 'company',
    party: buildParty(name, orgNumber, raw),
    active: raw['active'] !== false,
    vatNumber: raw['vat_number'] as string | undefined,
    defaultPaymentTermsDays: raw['payment_terms_days'] != null ? Number(raw['payment_terms_days']) : undefined,
    note: raw['note'] as string | undefined,
    updatedAt: raw['modified_date'] as string | undefined,
    _raw: raw,
  };
}

export function mapBrioxToSupplier(raw: Record<string, unknown>): SupplierDto {
  const name = (raw['name'] as string) ?? '';
  const orgNumber = raw['org_number'] as string | undefined;

  return {
    id: String(raw['id'] ?? ''),
    supplierNumber: String(raw['supplier_number'] ?? raw['id'] ?? ''),
    party: buildParty(name, orgNumber, raw),
    active: raw['active'] !== false,
    vatNumber: raw['vat_number'] as string | undefined,
    bankAccount: raw['bank_account'] as string | undefined,
    bankGiro: raw['bank_giro'] as string | undefined,
    plusGiro: raw['plus_giro'] as string | undefined,
    defaultPaymentTermsDays: raw['payment_terms_days'] != null ? Number(raw['payment_terms_days']) : undefined,
    note: raw['note'] as string | undefined,
    updatedAt: raw['modified_date'] as string | undefined,
    _raw: raw,
  };
}

export function mapBrioxToJournal(raw: Record<string, unknown>): JournalDto {
  // Briox detail API returns rows as "journal_rows" (list endpoint omits them)
  const rows = (raw['journal_rows'] as Record<string, unknown>[] | undefined)
    ?? (raw['journalrows'] as Record<string, unknown>[] | undefined) ?? [];
  const entries: AccountingEntryDto[] = rows.map((row) => ({
    // Briox uses "account" (not "account_number") for the account field
    accountNumber: String(row['account'] ?? row['account_number'] ?? ''),
    accountName: row['account_name'] as string | undefined,
    // Briox returns debit/credit as strings
    debit: Number(row['debit'] ?? 0),
    credit: Number(row['credit'] ?? 0),
    transactionDate: (row['transactiondate'] ?? row['transaction_date']) as string | undefined,
    description: (row['transactioninfo'] ?? row['description']) as string | undefined,
  }));

  return {
    id: String(raw['id'] ?? ''),
    journalNumber: String(raw['id'] ?? raw['journal_number'] ?? ''),
    series: raw['series'] ? {
      id: String(raw['series']),
    } : undefined,
    // Briox uses "descr" for the journal description
    description: (raw['descr'] ?? raw['description']) as string | undefined,
    // Briox uses "transactiondate" for the date
    registrationDate: ((raw['transactiondate'] ?? raw['journal_date'] ?? raw['date']) as string) ?? '',
    fiscalYear: raw['year'] != null ? Number(raw['year']) : (raw['financial_year'] != null ? Number(raw['financial_year']) : undefined),
    entries,
    _raw: raw,
  };
}

export function mapBrioxToAccountingAccount(raw: Record<string, unknown>): AccountingAccountDto {
  // Briox uses "id" as the account number field
  const num = Number(raw['id'] ?? raw['account_number'] ?? raw['number']);
  let type: AccountType | undefined;
  if (num >= 1000 && num < 2000) type = 'asset';
  else if (num >= 2000 && num < 3000) type = 'liability';
  else if (num >= 3000 && num < 4000) type = 'revenue';
  else if (num >= 4000 && num < 9000) type = 'expense';

  return {
    accountNumber: String(raw['id'] ?? raw['account_number'] ?? raw['number'] ?? ''),
    // Briox uses "description" for the account name
    name: ((raw['description'] ?? raw['name']) as string) ?? '',
    type,
    // Briox returns active as "1"/"0" strings
    active: raw['active'] !== false && raw['active'] !== '0' && raw['active'] !== 0,
    vatCode: raw['vat_code'] != null ? String(raw['vat_code']) : undefined,
    // Briox uses "incoming_balance" for opening balance
    balanceCarriedForward: raw['incoming_balance'] != null ? Number(raw['incoming_balance']) : undefined,
    _raw: raw,
  };
}

export function mapBrioxToCompanyInformation(raw: Record<string, unknown>): CompanyInformationDto {
  // /user/info returns { info: { company_name, accounts: [...] } }
  const info = (raw['info'] as Record<string, unknown> | undefined) ?? raw;
  const accounts = (info['accounts'] as Record<string, unknown>[] | undefined) ?? [];
  const account = accounts[0] as Record<string, unknown> | undefined;
  const addr = account?.['address'] as Record<string, unknown> | undefined;

  const companyName = (info['company_name'] ?? account?.['database_label'] ?? '') as string;
  const orgNumber = account?.['organization_number'] as string | undefined;

  return {
    companyName,
    organizationNumber: orgNumber,
    legalEntity: {
      registrationName: companyName,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    },
    address: {
      streetName: addr?.['addressline1'] as string | undefined,
      additionalStreetName: addr?.['addressline2'] as string | undefined,
      cityName: addr?.['city'] as string | undefined,
      postalZone: addr?.['zip'] as string | undefined,
      countryCode: (addr?.['countrycode'] ?? addr?.['country']) as string | undefined,
    },
    contact: {
      email: (account?.['email'] ?? info['email']) as string | undefined,
      telephone: (account?.['phone'] ?? info['phone']) as string | undefined,
      website: account?.['website'] as string | undefined,
    },
    _raw: raw,
  };
}
