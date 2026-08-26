import type {
  SalesInvoiceDto, SalesInvoiceLineDto, InvoiceStatusCode,
  LegalMonetaryTotalDto, PaymentStatusDto,
  CustomerDto,
  AccountingAccountDto, AccountType,
  CompanyInformationDto,
  AmountType, PartyDto, PostalAddress,
} from '../dto';

// Field names follow WINT's v1 swagger exactly (PascalCase). Amounts arrive as
// JSON numbers; account numbers arrive as INTEGERS and must leave every mapper
// as strings (they are identifiers, never quantities).

function amount(value: number | undefined | null, currency: string = 'SEK'): AmountType {
  return { value: round2(value ?? 0), currencyCode: currency };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** WINT date-times are ISO with a time part; our DTOs carry date-only strings. */
function dateOnly(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.slice(0, 10);
}

function mapAddress(raw: Record<string, unknown> | undefined | null): PostalAddress | undefined {
  if (!raw) return undefined;
  return {
    streetName: raw['Street1'] as string | undefined,
    additionalStreetName: raw['Street2'] as string | undefined,
    cityName: raw['City'] as string | undefined,
    postalZone: raw['ZipCode'] as string | undefined,
    countryCode: raw['CountryCode'] as string | undefined,
  };
}

function buildParty(
  name: string,
  orgNumber?: string,
  opts?: { address?: Record<string, unknown> | null; email?: string; phone?: string },
): PartyDto {
  return {
    name,
    identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [],
    postalAddress: mapAddress(opts?.address),
    legalEntity: orgNumber ? {
      registrationName: name,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    } : undefined,
    contact: (opts?.email || opts?.phone) ? {
      email: opts?.email,
      telephone: opts?.phone,
    } : undefined,
  };
}

/**
 * WINT invoice Status enum: NotSent | Unpaid | OverdueReminderSent |
 * OverdueReminderNotSent | Paid | Cancelled | Collection |
 * ReminderFeeNotFullyPaid | Expires. PaymentState refines it: Unpaid | Paid |
 * OverdueSoon | Overdue | PartiallyPaid | PartiallyPaidOverdue.
 */
function deriveWintInvoiceStatus(raw: Record<string, unknown>): InvoiceStatusCode {
  const status = raw['Status'] as string | undefined;
  const creditStatus = raw['CreditStatus'] as string | undefined;

  if (status === 'Cancelled') return 'cancelled';
  if (creditStatus === 'Credited') return 'credited';
  if (isWintInvoicePaid(raw)) return 'paid';
  if (status === 'NotSent') return 'draft';

  const paymentState = raw['PaymentState'] as string | undefined;
  if (
    paymentState === 'Overdue' ||
    paymentState === 'PartiallyPaidOverdue' ||
    status === 'OverdueReminderSent' ||
    status === 'OverdueReminderNotSent' ||
    status === 'Collection'
  ) {
    return 'overdue';
  }

  return 'sent';
}

/**
 * Paid means WINT says so, from either enum. LeftToPay corroborates but a
 * missing LeftToPay never reads as paid (mirrors the Fortnox/Briox absent-
 * balance hardening).
 */
function isWintInvoicePaid(raw: Record<string, unknown>): boolean {
  if (raw['Status'] === 'Paid' || raw['PaymentState'] === 'Paid') return true;
  const total = num(raw['TotalAmount']);
  const leftToPay = num(raw['LeftToPay']);
  return total != null && total > 0 && leftToPay != null && leftToPay <= 0;
}

export function mapWintToSalesInvoice(raw: Record<string, unknown>): SalesInvoiceDto {
  const currency = (raw['Currency'] as string) || 'SEK';
  const total = num(raw['TotalAmount']) ?? 0;
  const totalTax = num(raw['TotalTax']);
  const paid = isWintInvoicePaid(raw);
  const balance = paid ? 0 : (num(raw['LeftToPay']) ?? total);

  const rows = (raw['Rows'] as Record<string, unknown>[] | undefined) ?? [];
  const lines: SalesInvoiceLineDto[] = rows.map((row, idx) => {
    const quantity = num(row['Quantity']);
    const unitPrice = num(row['OverriddenUnitPrice']) ?? num(row['UnitPrice']);
    const lineTotal = quantity != null && unitPrice != null ? round2(quantity * unitPrice) : 0;
    const unit = row['Unit'] as Record<string, unknown> | undefined;
    return {
      id: String(row['Id'] ?? idx + 1),
      description: (row['OverriddenDescription'] ?? row['Description']) as string | undefined,
      quantity,
      unitCode: unit?.['Text'] as string | undefined,
      unitPrice: unitPrice != null ? amount(unitPrice, currency) : undefined,
      lineExtensionAmount: amount(lineTotal, currency),
      taxPercent: num(row['OverriddenVat']) ?? num(row['Vat']),
      itemName: row['Description'] as string | undefined,
      articleNumber: row['ArticleId'] != null ? String(row['ArticleId']) : undefined,
    };
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    // Undefined rather than `total` when WINT omits the tax total: reporting
    // the gross as the net is what makes an invoice read as 0 kr VAT.
    lineExtensionAmount: totalTax != null ? amount(round2(total - totalTax), currency) : undefined,
    taxInclusiveAmount: amount(total, currency),
    payableAmount: amount(total, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid,
    balance: amount(balance, currency),
    lastPaymentDate: dateOnly(raw['PaymentDate']),
  };

  return {
    id: String(raw['Id'] ?? ''),
    invoiceNumber: String(raw['SerialNumber'] ?? raw['Id'] ?? ''),
    // WINT's list item has no separate invoice-date field: PostingDate is the
    // date the invoice was posted/issued.
    issueDate: dateOnly(raw['PostingDate']) ?? '',
    dueDate: dateOnly(raw['DueDate']),
    deliveryDate: dateOnly(raw['DeliveryDate']),
    currencyCode: currency,
    status: deriveWintInvoiceStatus(raw),
    supplier: buildParty(''),
    customer: buildParty(
      (raw['CustomerName'] ?? '') as string,
      (raw['CustomerOrgNo'] as string | undefined) || undefined,
    ),
    lines,
    taxTotal: totalTax != null ? { taxAmount: amount(totalTax, currency) } : undefined,
    legalMonetaryTotal,
    paymentStatus,
    paymentTerms: raw['PaymentTerms'] != null ? `${raw['PaymentTerms']} dagar` : undefined,
    note: raw['Notes'] as string | undefined,
    buyerReference: raw['CustomerReference'] as string | undefined,
    updatedAt: raw['LastUpdated'] as string | undefined,
    _raw: raw,
  };
}

export function mapWintToCustomer(raw: Record<string, unknown>): CustomerDto {
  const name = (raw['Name'] as string) ?? '';
  const orgNumber = (raw['OrgNumber'] as string | undefined) || undefined;

  return {
    id: String(raw['Id'] ?? ''),
    // WINT has no separate customer number on the v1 surface: the Id is the
    // stable identifier their own invoices reference.
    customerNumber: String(raw['Id'] ?? ''),
    type: raw['Type'] === 'PrivatePerson' ? 'private' : 'company',
    party: buildParty(name, orgNumber, {
      address: raw['BillingAddress'] as Record<string, unknown> | null,
      email: (raw['EmailAddress'] as string | undefined) || undefined,
      phone: (raw['PhoneNumber'] as string | undefined) || undefined,
    }),
    deliveryAddresses: raw['DeliveryAddress']
      ? [mapAddress(raw['DeliveryAddress'] as Record<string, unknown>)!]
      : undefined,
    active: raw['Inactive'] !== true,
    vatNumber: (raw['VatNumber'] as string | undefined) || undefined,
    defaultPaymentTermsDays: num(raw['PaymentTerms']),
    updatedAt: raw['LastUpdated'] as string | undefined,
    _raw: raw,
  };
}

export function mapWintToAccountingAccount(raw: Record<string, unknown>): AccountingAccountDto {
  // WINT serves Number as an INTEGER: stringify immediately, arithmetic on
  // account numbers is always a bug. The classification below may only look
  // at the numeric value, never store it.
  const numberValue = num(raw['Number']);
  let type: AccountType | undefined;
  if (numberValue != null) {
    if (numberValue >= 1000 && numberValue < 2000) type = 'asset';
    // 20xx is eget kapital, not a liability; 21xx+ (obeskattade reserver,
    // avsättningar, skulder) stays 'liability' at this metadata granularity.
    else if (numberValue >= 2000 && numberValue < 2100) type = 'equity';
    else if (numberValue >= 2100 && numberValue < 3000) type = 'liability';
    else if (numberValue >= 3000 && numberValue < 4000) type = 'revenue';
    // 83xx is financial income (ränteintäkter m.m.), not an expense.
    else if (numberValue >= 8300 && numberValue < 8400) type = 'revenue';
    else if (numberValue >= 4000 && numberValue < 9000) type = 'expense';
  }

  return {
    accountNumber: raw['Number'] != null ? String(raw['Number']) : '',
    name: (raw['Name'] as string) ?? '',
    type,
    active: true,
    balanceBroughtForward: raw['Ib'] != null ? round2(Number(raw['Ib'])) : undefined,
    sruCode: raw['SRU'] != null ? String(raw['SRU']) : undefined,
    _raw: raw,
  };
}

export function mapWintToCompanyInformation(raw: Record<string, unknown>): CompanyInformationDto {
  const companyName = (raw['Name'] as string) ?? '';
  const orgNumber = (raw['Org'] as string | undefined) || undefined;
  const financialYears = (raw['FinancialYears'] as Record<string, unknown>[] | undefined) ?? [];
  const firstYear = financialYears[0];

  return {
    companyName,
    organizationNumber: orgNumber,
    legalEntity: {
      registrationName: companyName,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    },
    contact: raw['Url'] ? { website: raw['Url'] as string } : undefined,
    fiscalYearStart: firstYear ? dateOnly(firstYear['Start']) : undefined,
    baseCurrency: 'SEK',
    _raw: raw,
  };
}
