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
import {
  readNumber,
  resolveVatTriple,
  lineVatFromPercent,
  multiplyIfBothPresent,
} from '../amounts';
import { parseSourceVoucherRef } from '../source-voucher';

function amount(value: number | undefined | null, currency: string = 'SEK'): AmountType {
  return { value: value ?? 0, currencyCode: currency };
}

/**
 * eAccounting states the VAT total on the invoice header (`TotalVatAmount`)
 * and the ex-VAT amount per row (`AmountNoVat`), alongside the rate as
 * `PercentVat`. None of the three was read: the header net was taken straight
 * from `TotalAmount`, which is the amount INCLUDING VAT, so every migrated
 * Visma invoice recorded its gross as its net and 0 kr of VAT. The row reader
 * asked for `LineTotal` and `VatRatePercent`, neither of which exists in the
 * schema, so every line landed with a 0 amount and the hardcoded 25 % default.
 *
 * `TotalAmount` and `TotalVatAmount` are both in the company's accounting
 * currency, while `currencyCode` below reports the INVOICE currency; the
 * `*InvoiceCurrency` twins carry the invoice-currency figures. What matters
 * for VAT is reading a consistent pair, so both come from the
 * accounting-currency family here. The currency-label mismatch on foreign
 * invoices predates this change and is deliberately left alone:
 * `RemainingAmount` and the paid/balance logic read that same family, and
 * switching only the totals would desync payment status.
 */
const VISMA_INVOICE_VAT_KEYS = ['TotalVatAmount'] as const;

// CustomerInvoiceApi.PaymentStatus: 0 = Paid, 1 = Unpaid, 2 = Overdue.
const CUSTOMER_PS_PAID = 0;
const CUSTOMER_PS_OVERDUE = 2;

// SupplierInvoiceApi.PaymentStatus: Unpaid = 3, PartiallyPaidOverDue = 4,
// PartiallyPaid = 5, Paid = 6, OverDue = 7, PaidInBank = 9; the remaining
// values (8, 10-17) are bank-integration in-flight states where the money has
// NOT verifiably left the account, so they must stay open payables.
const SUPPLIER_PS_SETTLED = new Set([6, 9]);
const SUPPLIER_PS_OVERDUE = new Set([4, 7]);

/**
 * RemainingAmount is nullable in the eAccounting schema, and in practice the
 * /supplierinvoices LIST payload omits it entirely: reading a missing value as
 * 0 made every migrated supplier invoice look fully settled (ElvaSmultron,
 * 290/290 imported as paid). Distinguish "0" from "absent" and let the caller
 * fall back to the PaymentStatus enum / TotalAmount instead.
 */
function readRemaining(raw: Record<string, unknown>): number | null {
  const company = raw['RemainingAmount'];
  if (typeof company === 'number') return company;
  const invoiceCurrency = raw['RemainingAmountInvoiceCurrency'];
  if (typeof invoiceCurrency === 'number') return invoiceCurrency;
  return null;
}

function deriveInvoiceStatus(raw: Record<string, unknown>): InvoiceStatusCode {
  const remaining = readRemaining(raw);
  const total = raw['TotalAmount'] as number ?? 0;
  const ps = raw['PaymentStatus'] as number | undefined;
  if (raw['IsCancelled'] === true) return 'cancelled';
  // A credit invoice has a negative TotalAmount, so the `total > 0` paid check
  // below can never match it: without this it fell all the way through to
  // 'draft' and surfaced on the dashboard as an overdue unsent invoice.
  if (raw['IsCreditInvoice'] === true) return 'credited';
  if (ps === CUSTOMER_PS_PAID) return 'paid';
  if (ps === CUSTOMER_PS_OVERDUE) return 'overdue';
  if (ps == null && remaining === 0 && total !== 0) return 'paid';
  if (raw['IsBooked'] === true) return 'booked';
  if (raw['IsSent'] === true || raw['SendType'] != null) return 'sent';
  return 'draft';
}

/**
 * SupplierInvoiceApi carries none of the customer-invoice flags
 * (IsCancelled/IsBooked/IsSent): its lifecycle lives in `Status`
 * (0 = Draft, 1 = Normal, 2 = Deleted) plus the PaymentStatus enum.
 */
function deriveSupplierInvoiceStatus(
  raw: Record<string, unknown>,
  paid: boolean,
): InvoiceStatusCode {
  const status = raw['Status'] as number | undefined;
  if (status === 2) return 'cancelled';
  if (raw['IsCreditInvoice'] === true) return 'credited';
  if (paid) return 'paid';
  if (status === 0) return 'draft';
  const ps = raw['PaymentStatus'] as number | undefined;
  if (ps != null && SUPPLIER_PS_OVERDUE.has(ps)) return 'overdue';
  return 'booked';
}

function buildParty(name: string, orgNumber?: string, raw?: Record<string, unknown>): PartyDto {
  return {
    name,
    identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [],
    postalAddress: raw ? {
      streetName: (raw['InvoiceAddress1'] ?? raw['Address1']) as string | undefined,
      additionalStreetName: (raw['InvoiceAddress2'] ?? raw['Address2']) as string | undefined,
      cityName: (raw['InvoiceCity'] ?? raw['City']) as string | undefined,
      postalZone: (raw['InvoicePostalCode'] ?? raw['PostalCode']) as string | undefined,
      countryCode: raw['CountryCode'] as string | undefined,
    } : undefined,
    legalEntity: orgNumber ? {
      registrationName: name,
      companyId: orgNumber,
      companyIdSchemeId: 'SE:ORGNR',
    } : undefined,
    contact: {
      email: (raw?.['EmailAddress'] ?? raw?.['Email']) as string | undefined,
      telephone: (raw?.['Telephone'] ?? raw?.['Phone']) as string | undefined,
    },
  };
}

export function mapVismaToSalesInvoice(raw: Record<string, unknown>): SalesInvoiceDto {
  const currency = (raw['CurrencyCode'] as string) ?? 'SEK';
  const total = raw['TotalAmount'] as number ?? 0;
  const remaining = readRemaining(raw);
  const ps = raw['PaymentStatus'] as number | undefined;
  const paid = ps != null
    ? ps === CUSTOMER_PS_PAID
    : remaining === 0 && total !== 0;

  const rows = (raw['Rows'] as Record<string, unknown>[] | undefined) ?? [];
  const lines: SalesInvoiceLineDto[] = rows.map((row, idx) => {
    // `AmountNoVat` is the row amount excluding VAT. Fall back to
    // UnitPrice x Quantity only when the schema field is absent, never to 0.
    const lineNet = readNumber(row, ['AmountNoVat'])
      ?? multiplyIfBothPresent(readNumber(row, ['UnitPrice']), readNumber(row, ['Quantity']));
    const taxPercent = readNumber(row, ['PercentVat']);
    const lineVat = lineNet !== undefined ? lineVatFromPercent(lineNet, taxPercent) : undefined;

    return {
      id: String(row['LineNumber'] ?? idx + 1),
      description: row['Text'] as string | undefined,
      quantity: row['Quantity'] as number | undefined,
      unitCode: row['UnitAbbreviation'] as string | undefined,
      unitPrice: row['UnitPrice'] != null ? amount(row['UnitPrice'] as number, currency) : undefined,
      lineExtensionAmount: amount(lineNet ?? 0, currency),
      taxPercent,
      taxAmount: lineVat !== undefined ? amount(lineVat, currency) : undefined,
      accountNumber: row['AccountNumber'] != null ? String(row['AccountNumber']) : undefined,
      articleNumber: row['ArticleNumber'] as string | undefined,
    };
  });

  const vat = resolveVatTriple({
    gross: total,
    vat: readNumber(raw, VISMA_INVOICE_VAT_KEYS),
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: vat.net !== undefined ? amount(vat.net, currency) : undefined,
    taxInclusiveAmount: amount(total, currency),
    payableAmount: amount(total, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid,
    // When the payload omits RemainingAmount the honest open balance for an
    // unpaid invoice is its total, not 0: 0 would read as fully settled.
    balance: amount(remaining ?? (paid ? 0 : total), currency),
    lastPaymentDate: raw['PaymentDate'] as string | undefined,
  };

  return {
    id: String(raw['Id'] ?? ''),
    invoiceNumber: String(raw['InvoiceNumber'] ?? ''),
    issueDate: (raw['InvoiceDate'] as string) ?? '',
    dueDate: raw['DueDate'] as string | undefined,
    currencyCode: currency,
    status: deriveInvoiceStatus(raw),
    invoiceTypeCode: raw['IsCreditInvoice'] === true ? '381' : undefined,
    supplier: buildParty(''),
    customer: buildParty(
      (raw['InvoiceCustomerName'] ?? '') as string,
      undefined,
    ),
    lines,
    taxTotal: vat.vat !== undefined ? { taxAmount: amount(vat.vat, currency) } : undefined,
    legalMonetaryTotal,
    paymentStatus,
    // eAccounting names the booking voucher on the invoice itself
    // (`VoucherNumber`, "A329"). Kept only when it parses cleanly.
    sourceVoucher: parseSourceVoucherRef(raw['VoucherNumber']) ?? undefined,
    createdAt: raw['CreatedUtc'] as string | undefined,
    updatedAt: raw['ModifiedUtc'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToSupplierInvoice(raw: Record<string, unknown>): SupplierInvoiceDto {
  const currency = (raw['CurrencyCode'] as string) ?? 'SEK';
  const total = raw['TotalAmount'] as number ?? 0;
  const remaining = readRemaining(raw);
  const ps = raw['PaymentStatus'] as number | undefined;
  // The PaymentStatus enum is the reliable signal here: the /supplierinvoices
  // LIST payload omits RemainingAmount, and reading that absence as 0 imported
  // every supplier invoice as fully paid. Fall back to RemainingAmount only
  // when the enum itself is missing.
  const paid = ps != null
    ? SUPPLIER_PS_SETTLED.has(ps)
    : remaining === 0 && total !== 0;
  // A partially paid invoice without a RemainingAmount cannot be represented
  // faithfully: report the full total as open (visible and correctable)
  // rather than inventing a split.
  const balance = remaining ?? (paid ? 0 : total);

  const rows = (raw['Rows'] as Record<string, unknown>[] | undefined) ?? [];
  const lines: SupplierInvoiceLineDto[] = rows.map((row, idx) => {
    const debit = (row['DebetAmount'] as number) ?? 0;
    const credit = (row['CreditAmount'] as number) ?? 0;
    const rowAmount = debit || credit;
    return {
      id: String(row['LineNumber'] ?? idx + 1),
      description: row['TransactionText'] as string | undefined,
      quantity: row['Quantity'] as number | undefined,
      lineExtensionAmount: amount(rowAmount, currency),
      accountNumber: row['AccountNumber'] != null ? String(row['AccountNumber']) : undefined,
    };
  });

  // Supplier-invoice `Rows` are accounting rows (debit/credit per account),
  // not invoice lines, so the VAT total cannot be summed off them: one of the
  // rows IS the VAT account. The header field is the only usable source.
  const vat = resolveVatTriple({
    gross: total,
    vat: readNumber(raw, VISMA_INVOICE_VAT_KEYS),
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: vat.net !== undefined ? amount(vat.net, currency) : undefined,
    taxInclusiveAmount: amount(total, currency),
    payableAmount: amount(total, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid,
    balance: amount(balance, currency),
    lastPaymentDate: raw['PaymentDate'] as string | undefined,
  };

  return {
    id: String(raw['Id'] ?? ''),
    invoiceNumber: String(raw['InvoiceNumber'] ?? ''),
    issueDate: (raw['InvoiceDate'] as string) ?? '',
    dueDate: raw['DueDate'] as string | undefined,
    currencyCode: currency,
    status: deriveSupplierInvoiceStatus(raw, paid),
    invoiceTypeCode: raw['IsCreditInvoice'] === true ? '381' : undefined,
    supplier: buildParty((raw['SupplierName'] ?? '') as string),
    buyer: buildParty(''),
    lines,
    taxTotal: vat.vat !== undefined ? { taxAmount: amount(vat.vat, currency) } : undefined,
    legalMonetaryTotal,
    paymentStatus,
    sourceVoucher: parseSourceVoucherRef(raw['VoucherNumber']) ?? undefined,
    updatedAt: raw['ModifiedUtc'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToCustomer(raw: Record<string, unknown>): CustomerDto {
  return {
    id: String(raw['Id'] ?? ''),
    customerNumber: String(raw['CustomerNumber'] ?? ''),
    type: raw['IsPrivatePerson'] === true ? 'private' : 'company',
    party: buildParty(
      (raw['Name'] as string) ?? '',
      raw['CorporateIdentityNumber'] as string | undefined,
      raw,
    ),
    active: raw['IsActive'] !== false,
    note: raw['Note'] as string | undefined,
    updatedAt: raw['ChangedUtc'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToSupplier(raw: Record<string, unknown>): SupplierDto {
  return {
    id: String(raw['Id'] ?? ''),
    supplierNumber: String(raw['SupplierNumber'] ?? ''),
    party: buildParty(
      (raw['Name'] as string) ?? '',
      raw['CorporateIdentityNumber'] as string | undefined,
      raw,
    ),
    active: raw['IsActive'] !== false,
    bankAccount: raw['BankAccountNumber'] as string | undefined,
    bankGiro: raw['BankGiro'] as string | undefined,
    plusGiro: raw['PlusGiro'] as string | undefined,
    updatedAt: raw['ModifiedUtc'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToAccountingAccount(raw: Record<string, unknown>): AccountingAccountDto {
  const num = Number(raw['Number']);
  let type: AccountType | undefined;
  if (num >= 1000 && num < 2000) type = 'asset';
  else if (num >= 2000 && num < 3000) type = 'liability';
  else if (num >= 3000 && num < 4000) type = 'revenue';
  else if (num >= 4000 && num < 9000) type = 'expense';

  return {
    accountNumber: String(raw['Number'] ?? ''),
    name: (raw['Name'] as string) ?? '',
    type,
    vatCode: raw['VatCodeId'] != null ? String(raw['VatCodeId']) : undefined,
    active: raw['IsActive'] !== false,
    _raw: raw,
  };
}

export function mapVismaToCompanyInformation(raw: Record<string, unknown>): CompanyInformationDto {
  return {
    companyName: (raw['Name'] as string) ?? '',
    organizationNumber: raw['CorporateIdentityNumber'] as string | undefined,
    legalEntity: {
      registrationName: (raw['Name'] as string) ?? '',
      companyId: raw['CorporateIdentityNumber'] as string | undefined,
      companyIdSchemeId: 'SE:ORGNR',
    },
    address: {
      streetName: raw['Address1'] as string | undefined,
      cityName: raw['City'] as string | undefined,
      postalZone: raw['PostalCode'] as string | undefined,
      countryCode: raw['CountryCode'] as string | undefined,
    },
    contact: {
      email: raw['Email'] as string | undefined,
      telephone: raw['Phone'] as string | undefined,
    },
    baseCurrency: raw['CurrencyCode'] as string | undefined,
    _raw: raw,
  };
}

export function mapVismaToJournal(raw: Record<string, unknown>): JournalDto {
  const rows = (raw['Rows'] as Record<string, unknown>[] | undefined) ?? [];
  const entries: AccountingEntryDto[] = rows.map((row) => ({
    accountNumber: String(row['AccountNumber'] ?? ''),
    accountName: row['AccountName'] as string | undefined,
    debit: (row['DebitAmount'] as number) ?? 0,
    credit: (row['CreditAmount'] as number) ?? 0,
    description: row['Description'] as string | undefined,
  }));

  return {
    id: String(raw['Id'] ?? ''),
    journalNumber: String(raw['VoucherNumber'] ?? raw['Number'] ?? ''),
    description: raw['Description'] as string | undefined,
    registrationDate: (raw['VoucherDate'] as string) ?? '',
    entries,
    _raw: raw,
  };
}
