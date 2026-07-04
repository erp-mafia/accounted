import type {
  SalesInvoiceDto, InvoiceStatusCode,
  LegalMonetaryTotalDto, PaymentStatusDto,
  SupplierInvoiceDto,
  CustomerDto,
  SupplierDto,
  JournalDto, AccountingEntryDto,
  AccountingAccountDto, AccountType,
  CompanyInformationDto,
  AmountType, PartyDto,
} from '../dto';

function amount(value: number | undefined | null, currency: string = 'SEK'): AmountType {
  return { value: value ?? 0, currencyCode: currency };
}

/**
 * Derive an invoice lifecycle status from BL's fields.
 *
 * Sandbox-verified: `status` is an ARRAY of numeric codes. Documented for
 * customer invoices (supplier invoices observed to follow the same scheme):
 * 0 Unpaid, 1 Overdue, 2 Fully paid, 3 Partially paid, 4 Overpaid,
 * 5 Deleted, 6 Customer loss, 7 Marked for collection, 8 Sent for collection.
 * Codes ≥40 are ROT/RUT, factoring ("Invoier") and e-invoice transport noise:
 * ignored here. The `paid`/`preliminary` booleans are the primary signals;
 * the codes refine terminal states the booleans can't express.
 */
function deriveBLInvoiceStatus(raw: Record<string, unknown>): InvoiceStatusCode {
  const codes = Array.isArray(raw['status'])
    ? (raw['status'] as unknown[]).map(Number).filter(Number.isFinite)
    : [];
  // Terminal states win over payment flags: a deleted (makulerad) or
  // written-off (kundförlust) invoice must not be imported as open/paid.
  if (codes.includes(5) || codes.includes(6)) return 'cancelled';
  if (raw['paid'] === true) return 'paid';
  if (raw['preliminary'] === true) return 'draft';
  if (codes.includes(2) || codes.includes(4)) return 'paid';
  if (codes.includes(1) || codes.includes(7) || codes.includes(8)) return 'overdue';
  // Defensive: handle a plain string status should BL ever send one
  const status = typeof raw['status'] === 'string' ? raw['status'].toLowerCase() : undefined;
  if (status === 'cancelled') return 'cancelled';
  if (status === 'credited') return 'credited';
  if (status === 'sent') return 'sent';
  return 'booked';
}

/**
 * Map BL Customer Invoice to SalesInvoiceDto.
 *
 * BL fields: entityId, invoiceNumber, invoiceDate, dueDate, currency,
 * customerId, customerName, amount, amountInLocalCurrency,
 * amountPaidInLocalCurrency, paid, preliminary, status
 */
export function mapBLToSalesInvoice(raw: Record<string, unknown>): SalesInvoiceDto {
  const currency = (raw['currency'] as string) ?? 'SEK';
  const totalAmount = (raw['amountInLocalCurrency'] as number) ?? (raw['amount'] as number) ?? 0;
  const paidAmount = (raw['amountPaidInLocalCurrency'] as number) ?? 0;
  const balance = totalAmount - paidAmount;

  const customer: PartyDto = {
    name: (raw['customerName'] as string) ?? '',
    identifications: raw['customerId'] ? [{ id: String(raw['customerId']), schemeId: 'BL:CUSTOMER_ID' }] : [],
  };

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: amount(totalAmount, currency),
    taxInclusiveAmount: amount(totalAmount, currency),
    payableAmount: amount(totalAmount, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid: raw['paid'] === true,
    balance: amount(balance, currency),
  };

  return {
    id: String(raw['entityId'] ?? raw['invoiceNumber'] ?? ''),
    invoiceNumber: String(raw['invoiceNumber'] ?? ''),
    issueDate: (raw['invoiceDate'] as string) ?? '',
    dueDate: raw['dueDate'] as string | undefined,
    currencyCode: currency,
    status: deriveBLInvoiceStatus(raw),
    supplier: { name: '', identifications: [] },
    customer,
    lines: [], // BL doesn't include line items in list responses
    legalMonetaryTotal,
    paymentStatus,
    _raw: raw,
  };
}

/**
 * Map BL Supplier Invoice to SupplierInvoiceDto.
 *
 * BL fields: entityId, invoiceNumber, invoiceDate, dueDate, currency,
 * supplierId, supplierName, amountInLocalCurrency,
 * amountPaidInLocalCurrency, amountRemainingInLocalCurrency, paid, preliminary, status
 */
export function mapBLToSupplierInvoice(raw: Record<string, unknown>): SupplierInvoiceDto {
  const currency = (raw['currency'] as string) ?? 'SEK';
  const totalAmount = (raw['amountInLocalCurrency'] as number) ?? 0;
  const paidAmount = (raw['amountPaidInLocalCurrency'] as number) ?? 0;
  const remaining = (raw['amountRemainingInLocalCurrency'] as number) ?? (totalAmount - paidAmount);

  const supplier: PartyDto = {
    name: (raw['supplierName'] as string) ?? '',
    identifications: raw['supplierId'] ? [{ id: String(raw['supplierId']), schemeId: 'BL:SUPPLIER_ID' }] : [],
  };

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: amount(totalAmount, currency),
    taxInclusiveAmount: amount(totalAmount, currency),
    payableAmount: amount(totalAmount, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid: raw['paid'] === true,
    balance: amount(remaining, currency),
  };

  return {
    id: String(raw['entityId'] ?? raw['invoiceNumber'] ?? ''),
    invoiceNumber: String(raw['invoiceNumber'] ?? ''),
    issueDate: (raw['invoiceDate'] as string) ?? '',
    dueDate: raw['dueDate'] as string | undefined,
    currencyCode: currency,
    status: deriveBLInvoiceStatus(raw),
    supplier,
    buyer: { name: '', identifications: [] },
    lines: [], // BL doesn't include line items in list responses
    legalMonetaryTotal,
    paymentStatus,
    _raw: raw,
  };
}

/**
 * Map BL Customer to CustomerDto.
 *
 * BL fields: entityId, id, name, organisationNumber, street, box, zip, city,
 * country, phone, email, currency, vatNumber, paymentTerms, closed
 */
export function mapBLToCustomer(raw: Record<string, unknown>): CustomerDto {
  const name = (raw['name'] as string) ?? '';
  const orgNumber = raw['organisationNumber'] as string | undefined;

  const party: PartyDto = {
    name,
    identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [],
    postalAddress: {
      streetName: raw['street'] as string | undefined,
      additionalStreetName: raw['box'] as string | undefined,
      postalZone: raw['zip'] as string | undefined,
      cityName: raw['city'] as string | undefined,
      countryCode: raw['country'] as string | undefined,
    },
    legalEntity: orgNumber ? {
      registrationName: name,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    } : undefined,
    contact: {
      telephone: raw['phone'] as string | undefined,
      email: raw['email'] as string | undefined,
    },
  };

  return {
    id: String(raw['id'] ?? raw['entityId'] ?? ''),
    customerNumber: String(raw['id'] ?? ''),
    type: 'company',
    party,
    active: raw['closed'] !== true,
    vatNumber: raw['vatNumber'] as string | undefined,
    defaultPaymentTermsDays: raw['paymentTerms'] != null ? Number(raw['paymentTerms']) : undefined,
    _raw: raw,
  };
}

/**
 * Map BL Supplier to SupplierDto.
 *
 * BL fields: entityId, id, name, organisationId, address1, address2, zipCode, city,
 * countryCode, phone, email, bg, pg, iban, vatNr, paymentTerms, closed
 */
export function mapBLToSupplier(raw: Record<string, unknown>): SupplierDto {
  const name = (raw['name'] as string) ?? '';
  const orgNumber = raw['organisationId'] as string | undefined;

  const party: PartyDto = {
    name,
    identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [],
    postalAddress: {
      streetName: raw['address1'] as string | undefined,
      additionalStreetName: raw['address2'] as string | undefined,
      postalZone: raw['zipCode'] as string | undefined,
      cityName: raw['city'] as string | undefined,
      countryCode: raw['countryCode'] as string | undefined,
    },
    legalEntity: orgNumber ? {
      registrationName: name,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    } : undefined,
    contact: {
      telephone: raw['phone'] as string | undefined,
      email: raw['email'] as string | undefined,
    },
  };

  return {
    id: String(raw['id'] ?? raw['entityId'] ?? ''),
    supplierNumber: String(raw['id'] ?? ''),
    party,
    active: raw['closed'] !== true,
    vatNumber: raw['vatNr'] as string | undefined,
    bankGiro: raw['bg'] as string | undefined,
    plusGiro: raw['pg'] as string | undefined,
    bankAccount: raw['iban'] as string | undefined,
    defaultPaymentTermsDays: raw['paymentTerms'] != null ? Number(raw['paymentTerms']) : undefined,
    _raw: raw,
  };
}

/**
 * Map BL Journal/Ledger Entry to JournalDto.
 *
 * BL fields: entityId, journalId, journalEntryId, journalEntryDate,
 * journalEntryText, financialYearId, ledgerEntries[{ accountId, amount, text }],
 * totalCreditSum, totalDebitSum
 */
export function mapBLToJournal(raw: Record<string, unknown>): JournalDto {
  const rawEntries = (raw['ledgerEntries'] as Record<string, unknown>[] | undefined) ?? [];
  const entries: AccountingEntryDto[] = rawEntries.map((entry) => {
    // BL LedgerEntry has a single `amount` field: positive = debit, negative = credit
    const amt = (entry['amount'] as number) ?? 0;
    return {
      accountNumber: String(entry['accountId'] ?? ''),
      debit: amt > 0 ? amt : 0,
      credit: amt < 0 ? Math.abs(amt) : 0,
      description: entry['text'] as string | undefined,
    };
  });

  const totalCredit = (raw['totalCreditSum'] as number) ?? 0;
  const totalDebit = (raw['totalDebitSum'] as number) ?? entries.reduce((sum, e) => sum + e.debit, 0);

  return {
    id: String(raw['entityId'] ?? raw['journalEntryId'] ?? ''),
    journalNumber: String(raw['journalId'] ?? raw['journalEntryId'] ?? ''),
    description: raw['journalEntryText'] as string | undefined,
    registrationDate: (raw['journalEntryDate'] as string) ?? '',
    fiscalYear: raw['financialYearId'] != null ? Number(raw['financialYearId']) : undefined,
    entries,
    totalDebit: { value: totalDebit, currencyCode: 'SEK' },
    totalCredit: { value: totalCredit, currencyCode: 'SEK' },
    _raw: raw,
  };
}

/** BL's own account `type` values (sandbox-verified) → our AccountType. */
const BL_ACCOUNT_TYPE_MAP: Record<string, AccountType> = {
  asset: 'asset',
  liability: 'liability',
  income: 'revenue',
  cost: 'expense',
};

/**
 * Map BL Account to AccountingAccountDto.
 *
 * BL fields: entityId, id (account number), name, vatCode, sruCode, closed, type
 * BL sends an explicit `type` (asset|liability|income|cost): prefer it, since
 * it also covers off-plan accounts like 0099 "Konvertering"; fall back to BAS
 * number ranges when absent.
 */
export function mapBLToAccountingAccount(raw: Record<string, unknown>): AccountingAccountDto {
  const num = Number(raw['id']);

  let type: AccountType | undefined = BL_ACCOUNT_TYPE_MAP[String(raw['type'] ?? '').toLowerCase()];
  if (!type) {
    if (num >= 1000 && num < 2000) type = 'asset';
    else if (num >= 2000 && num < 3000) type = 'liability';
    else if (num >= 3000 && num < 4000) type = 'revenue';
    else if (num >= 4000 && num < 9000) type = 'expense';
  }

  return {
    accountNumber: String(raw['id'] ?? ''),
    name: (raw['name'] as string) ?? '',
    type,
    vatCode: raw['vatCode'] as string | undefined,
    sruCode: raw['sruCode'] != null ? String(raw['sruCode']) : undefined,
    active: raw['closed'] !== true,
    balanceCarriedForward: (raw['debit'] != null || raw['credit'] != null)
      ? (Number(raw['debit'] ?? 0) - Number(raw['credit'] ?? 0))
      : undefined,
    _raw: raw,
  };
}

/**
 * Map BL Company Details to CompanyInformationDto.
 *
 * BL fields: name, orgNumber, street, box, zip, city, country,
 * phone, email, bg, pg, iban, vatNumber, preferredSettings.currency
 */
export function mapBLToCompanyInformation(raw: Record<string, unknown>): CompanyInformationDto {
  const settings = raw['preferredSettings'] as Record<string, unknown> | undefined;

  return {
    companyName: (raw['name'] as string) ?? '',
    organizationNumber: raw['orgNumber'] as string | undefined,
    legalEntity: {
      registrationName: (raw['name'] as string) ?? '',
      companyId: raw['orgNumber'] as string | undefined,
      companyIdSchemeId: 'SE:ORGNR',
    },
    address: {
      streetName: raw['street'] as string | undefined,
      additionalStreetName: raw['box'] as string | undefined,
      postalZone: raw['zip'] as string | undefined,
      cityName: raw['city'] as string | undefined,
      countryCode: raw['country'] as string | undefined,
    },
    contact: {
      telephone: raw['phone'] as string | undefined,
      email: raw['email'] as string | undefined,
    },
    vatNumber: raw['vatNumber'] as string | undefined,
    baseCurrency: (settings?.['currency'] as string) ?? 'SEK',
    _raw: raw,
  };
}
