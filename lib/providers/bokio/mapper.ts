import type {
  SalesInvoiceDto, SalesInvoiceLineDto, InvoiceStatusCode,
  LegalMonetaryTotalDto, PaymentStatusDto,
  CustomerDto,
  SupplierDto,
  SupplierInvoiceDto, SupplierInvoiceLineDto,
  JournalDto, AccountingEntryDto,
  AccountingAccountDto, AccountType,
  CompanyInformationDto,
  AmountType, PartyDto,
} from '../dto';

function amount(value: number | undefined | null, currency: string = 'SEK'): AmountType {
  return { value: value ?? 0, currencyCode: currency };
}

function deriveInvoiceStatus(raw: Record<string, unknown>): InvoiceStatusCode {
  const status = (raw['status'] as string | undefined)?.toLowerCase();
  if (status === 'cancelled') return 'cancelled';
  if (status === 'paid') return 'paid';
  if (status === 'overdue') return 'overdue';
  if (status === 'published') return 'sent';
  if (status === 'draft') return 'draft';
  return 'draft';
}

function buildParty(name: string, orgNumber?: string, address?: Record<string, unknown>): PartyDto {
  return {
    name,
    identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [],
    postalAddress: address ? {
      streetName: address['line1'] as string | undefined,
      additionalStreetName: address['line2'] as string | undefined,
      cityName: address['city'] as string | undefined,
      postalZone: address['postalCode'] as string | undefined,
      countryCode: address['country'] as string | undefined,
    } : undefined,
    legalEntity: orgNumber ? {
      registrationName: name,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    } : undefined,
  };
}

/**
 * Map Bokio Invoice to SalesInvoiceDto.
 *
 * Bokio Invoice fields:
 * - id, invoiceNumber, status (draft|published|paid|overdue|cancelled)
 * - invoiceDate, dueDate, currency, totalAmount, totalTax, paidAmount
 * - customerRef: { id, name }, lineItems: [{ id, description, quantity, unitPrice, taxRate, unitType }]
 */
export function mapBokioToSalesInvoice(raw: Record<string, unknown>): SalesInvoiceDto {
  const currency = (raw['currency'] as string) ?? 'SEK';
  const totalAmount = (raw['totalAmount'] as number) ?? 0;
  const totalTax = (raw['totalTax'] as number) ?? 0;
  const paidAmount = (raw['paidAmount'] as number) ?? 0;
  const balance = totalAmount - paidAmount;

  const customerRef = raw['customerRef'] as Record<string, unknown> | undefined;
  const rawLines = (raw['lineItems'] as Record<string, unknown>[] | undefined) ?? [];

  const lines: SalesInvoiceLineDto[] = rawLines.map((line, idx) => {
    const unitPrice = line['unitPrice'] as number | undefined;
    const quantity = line['quantity'] as number | undefined;
    const lineTotal = unitPrice != null && quantity != null ? unitPrice * quantity : 0;

    return {
      id: String(line['id'] ?? idx + 1),
      description: line['description'] as string | undefined,
      quantity,
      unitCode: line['unitType'] as string | undefined,
      unitPrice: unitPrice != null ? amount(unitPrice, currency) : undefined,
      lineExtensionAmount: amount(lineTotal, currency),
      taxPercent: line['taxRate'] as number | undefined,
    };
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: amount(totalAmount - totalTax, currency),
    taxInclusiveAmount: amount(totalAmount, currency),
    payableAmount: amount(totalAmount, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid: paidAmount >= totalAmount && totalAmount > 0,
    balance: amount(balance, currency),
  };

  return {
    id: String(raw['id'] ?? ''),
    invoiceNumber: String(raw['invoiceNumber'] ?? raw['id'] ?? ''),
    issueDate: (raw['invoiceDate'] as string) ?? '',
    dueDate: raw['dueDate'] as string | undefined,
    currencyCode: currency,
    status: deriveInvoiceStatus(raw),
    supplier: buildParty(''),
    customer: buildParty(
      (customerRef?.['name'] as string) ?? '',
    ),
    lines,
    legalMonetaryTotal,
    paymentStatus,
    _raw: raw,
  };
}

/**
 * Map Bokio Customer to CustomerDto.
 *
 * Bokio Customer fields:
 * - id, name, type (company|individual), orgNumber, vatNumber, paymentTerms
 * - address: { line1, line2, city, postalCode, country }
 * - contactsDetails: [{ email, phone, name }]
 */
export function mapBokioToCustomer(raw: Record<string, unknown>): CustomerDto {
  const name = (raw['name'] as string) ?? '';
  const orgNumber = raw['orgNumber'] as string | undefined;
  const address = raw['address'] as Record<string, unknown> | undefined;
  const contacts = (raw['contactsDetails'] as Record<string, unknown>[] | undefined) ?? [];
  const firstContact = contacts[0];

  const party = buildParty(name, orgNumber, address);
  if (firstContact) {
    party.contact = {
      email: firstContact['email'] as string | undefined,
      telephone: firstContact['phone'] as string | undefined,
      name: firstContact['name'] as string | undefined,
    };
  }

  return {
    id: String(raw['id'] ?? ''),
    customerNumber: String(raw['id'] ?? ''),
    type: (raw['type'] === 'individual' || raw['type'] === 'person') ? 'private' : 'company',
    party,
    active: true,
    vatNumber: raw['vatNumber'] as string | undefined,
    defaultPaymentTermsDays: raw['paymentTerms'] != null && !isNaN(Number(raw['paymentTerms']))
      ? Number(raw['paymentTerms'])
      : undefined,
    _raw: raw,
  };
}

/**
 * Map Bokio JournalEntry to JournalDto.
 *
 * Bokio JournalEntry fields:
 * - id, date, title, number (int), createdAt
 * - items: [{ accountNumber (int), debit, credit, description }]
 */
export function mapBokioToJournal(raw: Record<string, unknown>): JournalDto {
  const rawItems = (raw['items'] as Record<string, unknown>[] | undefined) ?? [];
  const entries: AccountingEntryDto[] = rawItems.map((item) => ({
    accountNumber: String(item['account'] ?? item['accountNumber'] ?? ''),
    debit: (item['debit'] as number) ?? 0,
    credit: (item['credit'] as number) ?? 0,
    description: item['description'] as string | undefined,
  }));

  return {
    id: String(raw['id'] ?? ''),
    journalNumber: String(raw['journalEntryNumber'] ?? raw['number'] ?? raw['id'] ?? ''),
    description: raw['title'] as string | undefined,
    registrationDate: (raw['date'] as string) ?? '',
    entries,
    createdAt: raw['createdAt'] as string | undefined,
    _raw: raw,
  };
}

/**
 * Map Bokio Account to AccountingAccountDto.
 *
 * Bokio Account fields:
 * - number (int, used as ID), name, category (asset|liability|income|cost), isActive
 */
export function mapBokioToAccountingAccount(raw: Record<string, unknown>): AccountingAccountDto {
  // Bokio uses 'account' (int) as field name, not 'number' or 'accountNumber'
  const rawNum = raw['account'] ?? raw['accountNumber'] ?? raw['number'];
  const num = Number(rawNum);

  // Bokio returns accountType: 'basePlanAccount': derive type from BAS plan number range
  let type: AccountType | undefined;
  if (num >= 1000 && num < 2000) type = 'asset';
  else if (num >= 2000 && num < 3000) type = 'liability';
  else if (num >= 3000 && num < 4000) type = 'revenue';
  else if (num >= 4000 && num < 9000) type = 'expense';

  return {
    accountNumber: String(rawNum ?? ''),
    name: (raw['name'] as string) ?? '',
    type,
    active: raw['isActive'] !== false,
    balanceCarriedForward: raw['accountBalance'] != null ? Number(raw['accountBalance']) : undefined,
    _raw: raw,
  };
}

/**
 * Map Bokio Supplier to SupplierDto.
 *
 * Bokio Supplier fields:
 * - id, name, orgNumber, vatNumber, paymentTerms
 * - address: { line1, line2, city, postalCode, country }
 * - contactsDetails: [{ email, phone, name }]
 * - bankAccount, bankgiro, plusgiro
 */
export function mapBokioToSupplier(raw: Record<string, unknown>): SupplierDto {
  const name = (raw['name'] as string) ?? '';
  const orgNumber = raw['orgNumber'] as string | undefined;
  const address = raw['address'] as Record<string, unknown> | undefined;
  const contacts = (raw['contactsDetails'] as Record<string, unknown>[] | undefined) ?? [];
  const firstContact = contacts[0];

  const party = buildParty(name, orgNumber, address);
  if (firstContact) {
    party.contact = {
      email: firstContact['email'] as string | undefined,
      telephone: firstContact['phone'] as string | undefined,
      name: firstContact['name'] as string | undefined,
    };
  }

  return {
    id: String(raw['id'] ?? ''),
    supplierNumber: String(raw['id'] ?? ''),
    party,
    active: true,
    vatNumber: raw['vatNumber'] as string | undefined,
    bankAccount: raw['bankAccount'] as string | undefined,
    bankGiro: raw['bankgiro'] as string | undefined,
    plusGiro: raw['plusgiro'] as string | undefined,
    defaultPaymentTermsDays: raw['paymentTerms'] != null && !isNaN(Number(raw['paymentTerms']))
      ? Number(raw['paymentTerms'])
      : undefined,
    _raw: raw,
  };
}

/**
 * Map Bokio Supplier Invoice to SupplierInvoiceDto.
 *
 * Bokio Supplier Invoice fields:
 * - id, invoiceNumber, status (draft|published|paid|overdue|cancelled)
 * - invoiceDate, dueDate, currency, totalAmount, totalTax, paidAmount
 * - supplierRef: { id, name }, lineItems: [{ id, description, quantity, unitPrice, taxRate, unitType }]
 * - ocrNumber
 */
export function mapBokioToSupplierInvoice(raw: Record<string, unknown>): SupplierInvoiceDto {
  const currency = (raw['currency'] as string) ?? 'SEK';
  const totalAmount = (raw['totalAmount'] as number) ?? 0;
  const totalTax = (raw['totalTax'] as number) ?? 0;
  const paidAmount = (raw['paidAmount'] as number) ?? 0;
  const balance = totalAmount - paidAmount;

  const supplierRef = raw['supplierRef'] as Record<string, unknown> | undefined;
  const rawLines = (raw['lineItems'] as Record<string, unknown>[] | undefined) ?? [];

  const lines: SupplierInvoiceLineDto[] = rawLines.map((line, idx) => {
    const unitPrice = line['unitPrice'] as number | undefined;
    const quantity = line['quantity'] as number | undefined;
    const lineTotal = unitPrice != null && quantity != null ? unitPrice * quantity : 0;

    return {
      id: String(line['id'] ?? idx + 1),
      description: line['description'] as string | undefined,
      quantity,
      unitCode: line['unitType'] as string | undefined,
      unitPrice: unitPrice != null ? amount(unitPrice, currency) : undefined,
      lineExtensionAmount: amount(lineTotal, currency),
      taxPercent: line['taxRate'] as number | undefined,
    };
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: amount(totalAmount - totalTax, currency),
    taxInclusiveAmount: amount(totalAmount, currency),
    payableAmount: amount(totalAmount, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid: paidAmount >= totalAmount && totalAmount > 0,
    balance: amount(balance, currency),
  };

  return {
    id: String(raw['id'] ?? ''),
    invoiceNumber: String(raw['invoiceNumber'] ?? raw['id'] ?? ''),
    issueDate: (raw['invoiceDate'] as string) ?? '',
    dueDate: raw['dueDate'] as string | undefined,
    currencyCode: currency,
    status: deriveInvoiceStatus(raw),
    supplier: buildParty(
      (supplierRef?.['name'] as string) ?? '',
    ),
    buyer: buildParty(''),
    lines,
    legalMonetaryTotal,
    paymentStatus,
    ocrNumber: raw['ocrNumber'] as string | undefined,
    _raw: raw,
  };
}

/**
 * Map Bokio Company to CompanyInformationDto.
 *
 * Bokio Company fields:
 * - id, name, orgNumber, vatNumber, currency, country
 * - address: { line1, line2, city, postalCode, country }
 */
export function mapBokioToCompanyInformation(raw: Record<string, unknown>): CompanyInformationDto {
  const address = raw['address'] as Record<string, unknown> | undefined;

  return {
    companyName: (raw['name'] as string) ?? '',
    organizationNumber: raw['orgNumber'] as string | undefined,
    legalEntity: {
      registrationName: (raw['name'] as string) ?? '',
      companyId: raw['orgNumber'] as string | undefined,
      companyIdSchemeId: 'SE:ORGNR',
    },
    address: address ? {
      streetName: address['line1'] as string | undefined,
      additionalStreetName: address['line2'] as string | undefined,
      cityName: address['city'] as string | undefined,
      postalZone: address['postalCode'] as string | undefined,
      countryCode: address['country'] as string | undefined,
    } : undefined,
    vatNumber: raw['vatNumber'] as string | undefined,
    baseCurrency: raw['currency'] as string | undefined,
    _raw: raw,
  };
}
