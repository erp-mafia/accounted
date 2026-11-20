import type {
  SalesInvoiceDto, SalesInvoiceLineDto, InvoiceStatusCode,
  LegalMonetaryTotalDto, PaymentStatusDto, CreditedInvoiceRefDto,
  CustomerDto,
  SupplierDto,
  SupplierInvoiceDto, SupplierInvoiceLineDto,
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
import { salesDocumentNumber, statedDocumentNumber } from '../dto';
import { documentPayment, documentState } from '../document-state';

/**
 * Bokio's live payloads have repeatedly differed from its published spec (the
 * company-information body was the previous case), and `totalTax` is absent
 * from the supplier-invoice payload in practice: defaulting it to 0 recorded
 * every such invoice with its gross as its net and no VAT. Candidates cover
 * the spellings seen across Bokio's endpoints; none matching leaves the VAT
 * unknown, which the migration reports, rather than zero, which it cannot see.
 */
const BOKIO_VAT_KEYS = ['totalTax', 'totalVat', 'vatAmount', 'taxAmount'] as const;

function amount(value: number | undefined | null, currency: string = 'SEK'): AmountType {
  return { value: value ?? 0, currencyCode: currency };
}

/**
 * Bokio's SALES invoice lifecycle enum, as the published company-api spec
 * states it (bokio/bokio-api, branch v1, schema `invoice.status`): draft,
 * published, paid, overPaid, underPaid, overdue, credited, credit.
 *
 * Every value has to land somewhere deliberate, because the fallthrough is
 * 'draft' and a migrated 'draft' renders as "Ej skickad": that is how a
 * customer's credited invoices and credit notes showed up as unsent
 * invoices (crm#110). `credited` is an invoice a credit note has been issued
 * against; `credit` is undocumented beyond the enum, and the one reading
 * consistent with its sibling is that the row IS a credit document (see
 * mapBokioToSalesInvoice). `overPaid` is settled; `underPaid` is open with a
 * partial payment, which the balance carries.
 *
 * Supplier invoices carry no `status` at all (see mapBokioToSupplierInvoice),
 * so this must not be used for them: every one of them would fall through
 * to 'draft'.
 */
function deriveInvoiceStatus(status: string | undefined): InvoiceStatusCode {
  switch (status) {
    case 'paid':
    case 'overpaid': return 'paid';
    case 'overdue': return 'overdue';
    case 'published':
    case 'underpaid': return 'sent';
    case 'credited': return 'credited';
    default: return 'draft';
  }
}

/**
 * Is this payload Bokio's `creditNote` schema rather than its `invoice`?
 *
 * The two share their line-item shape and most header fields, but a credit
 * note is dated by `creditDate` and names the invoice it credits in
 * `invoiceRef`; an invoice is dated by `invoiceDate` and has neither. The
 * shape is checked rather than the endpoint the payload came from because
 * the same resource mapper re-maps the detail form during hydration
 * (lib/providers/provider-data-fetcher.ts), and a credit note re-mapped as
 * an invoice would lose its type code.
 */
export function isBokioCreditNotePayload(raw: Record<string, unknown> | undefined | null): boolean {
  if (!raw || typeof raw !== 'object') return false;
  if ('creditDate' in raw) return true;
  const invoiceRef = raw['invoiceRef'];
  return typeof invoiceRef === 'object' && invoiceRef !== null && !Array.isArray(invoiceRef);
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
 * Bokio's `unitType` enum (company-api, salesInvoiceItem.unitType, default
 * `unspecified`) to the unit Accounted stores and prints. The enum values are
 * identifiers, not labels: copied verbatim they printed "2 unspecified" and
 * "1 piece" on migrated invoices (crm#1084). The codes are the Swedish ones
 * the invoice editor offers (lib/invoices/units.ts), and the conventional
 * abbreviation where the editor offers none. `mile` is the Scandinavian mil
 * (10 km): Bokio is a Swedish product and the unit is what milersättning is
 * invoiced in. `unspecified` is no unit at all, so it stays empty rather
 * than becoming "st". `custom` carries its text in `customUnitType`. A value
 * this table does not know is kept as Bokio sent it.
 */
const BOKIO_UNIT_TYPES: Record<string, string> = {
  unspecified: '',
  piece: 'st',
  hour: 'tim',
  minute: 'min',
  day: 'dag',
  week: 'vecka',
  month: 'månad',
  year: 'år',
  gram: 'g',
  kilogram: 'kg',
  ton: 'ton',
  liter: 'l',
  millimeter: 'mm',
  centimeter: 'cm',
  meter: 'm',
  kilometer: 'km',
  mile: 'mil',
  meterSquared: 'kvm',
  meterCubic: 'm3',
  hectar: 'ha',
  megabyte: 'MB',
  gigabyte: 'GB',
  words: 'ord',
};

/** Same cap as invoice_items.unit takes through the API (lib/invoices/units.ts UNIT_MAX_LENGTH). */
const BOKIO_CUSTOM_UNIT_MAX_LENGTH = 32;

/**
 * The unit of one Bokio line item, or undefined when the line states none
 * (a descriptionOnlyItem has no unitType; the importer then applies its own
 * default). An empty string is a stated "no unit".
 */
export function bokioUnit(line: Record<string, unknown>): string | undefined {
  const unitType = line['unitType'];
  if (typeof unitType !== 'string') return undefined;
  if (unitType === 'custom') {
    const custom = line['customUnitType'];
    return typeof custom === 'string'
      ? custom.trim().replace(/\s+/g, ' ').slice(0, BOKIO_CUSTOM_UNIT_MAX_LENGTH).trim()
      : '';
  }
  return Object.prototype.hasOwnProperty.call(BOKIO_UNIT_TYPES, unitType)
    ? BOKIO_UNIT_TYPES[unitType]
    : unitType;
}

/**
 * The row kind Bokio states for a line item: `itemType` is `salesItem` or
 * `descriptionOnlyItem` (the oneOf in the company-api spec). Undefined when
 * the field is absent or unknown, so the importer falls back to inferring a
 * text row from its missing amounts.
 */
function bokioLineType(line: Record<string, unknown>): SalesInvoiceLineDto['lineType'] {
  const itemType = line['itemType'];
  if (itemType === 'descriptionOnlyItem') return 'text';
  if (itemType === 'salesItem') return 'product';
  return undefined;
}

/**
 * Bokio's sales line items in the order Bokio prints them on the invoice.
 *
 * A line item has no position field, and the array's order is not stable
 * between calls. On 2026-10-04 and 10-07 the /invoices list served four of
 * one company's invoices with their lines in strictly descending line id; a
 * week later the same endpoint served them in ascending id, the order their
 * PDFs print (crm#1190, proven against the import's payload hashes). A line
 * id is assigned when the line is added, so an invoice nobody rearranged
 * prints in ascending id. The fifth multi-line invoice, rearranged in Bokio
 * (its first line was added last), was served in its printed order on every
 * call. So a strictly descending id sequence is Bokio's backwards reading of
 * an unarranged invoice and is turned round; any other order is kept as
 * served. The one order this misreads is lines a user arranged in exactly
 * reverse creation order.
 */
function bokioLinesInPrintOrder(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  if (lines.length < 2) return lines;
  const ids = lines.map((line) => line['id']);
  if (!ids.every((id): id is number => typeof id === 'number' && Number.isSafeInteger(id))) return lines;
  return ids.every((id, i) => i === 0 || ids[i - 1] > id) ? [...lines].reverse() : lines;
}

/**
 * Bokio's sales line items (`salesInvoiceItem` and
 * `descriptionOnlyInvoiceItem`), shared by invoices and credit notes:
 * itemType, description, quantity, unitPrice, taxRate, unitType. The
 * line's `discount` is not applied here; the header totals come from
 * Bokio's own totalAmount/totalTax, which already include it.
 *
 * `itemRef` (the Bokio item a line was made from) is not carried: Bokio's
 * item register is not imported, and its items have no article number, so
 * there is no Accounted article it could point at (crm#1084).
 */
function mapBokioSalesLines(
  rawLines: Record<string, unknown>[] | undefined,
  currency: string,
): SalesInvoiceLineDto[] {
  return bokioLinesInPrintOrder(rawLines ?? []).map((line, idx) => {
    const unitPrice = readNumber(line, ['unitPrice']);
    const quantity = readNumber(line, ['quantity']);
    const lineTotal = multiplyIfBothPresent(unitPrice, quantity);
    const taxPercent = readNumber(line, ['taxRate']);
    const lineVat = lineTotal !== undefined ? lineVatFromPercent(lineTotal, taxPercent) : undefined;

    return {
      id: String(line['id'] ?? idx + 1),
      lineType: bokioLineType(line),
      description: line['description'] as string | undefined,
      quantity,
      unitCode: bokioUnit(line),
      unitPrice: unitPrice != null ? amount(unitPrice, currency) : undefined,
      lineExtensionAmount: amount(lineTotal, currency),
      taxPercent,
      taxAmount: lineVat !== undefined ? amount(lineVat, currency) : undefined,
    };
  });
}

/**
 * Map Bokio Invoice to SalesInvoiceDto.
 *
 * Bokio Invoice fields (company-api spec, schema `invoice`):
 * - id, invoiceNumber, status (see deriveInvoiceStatus)
 * - invoiceDate, dueDate, currency, totalAmount, totalTax, paidAmount
 * - customerRef: { id, name }, lineItems: [{ id, itemType, description, quantity, unitPrice, taxRate, unitType }]
 * - creditNoteRefs: [{ id }] on an invoice that has been credited
 *
 * A payload in the `creditNote` shape is handed to mapBokioToCreditNote:
 * this is the mapper the fetcher applies to every sales document, list
 * form and detail form alike, so it has to recognise both schemas.
 */
export function mapBokioToSalesInvoice(raw: Record<string, unknown>): SalesInvoiceDto {
  if (isBokioCreditNotePayload(raw)) return mapBokioToCreditNote(raw);

  const currency = (raw['currency'] as string) ?? 'SEK';
  const totalAmount = (raw['totalAmount'] as number) ?? 0;
  const paidAmount = (raw['paidAmount'] as number) ?? 0;

  const bokioStatus = (raw['status'] as string | undefined)?.toLowerCase();
  // An /invoices row Bokio itself labels `credit` is a credit document,
  // stated in magnitudes like everything else Bokio sends; the importer
  // applies the sign. The /credit-notes form of the same document is
  // preferred when both are listed (it names the credited invoice), see
  // provider-data-fetcher.
  const doc = documentState({
    issued: bokioStatus !== 'draft',
    cancelled: bokioStatus === 'cancelled',
    creditFlag: bokioStatus === 'credit',
    total: totalAmount,
  });
  const lifecycle = deriveInvoiceStatus(bokioStatus);
  // Bokio's enum saying paid settles the invoice as its amount does: a paid
  // row whose paidAmount is absent or short of the total owes nothing.
  const statedPaid = lifecycle === 'paid' || (paidAmount >= totalAmount && totalAmount > 0);
  const { paid, balance } = documentPayment(doc, totalAmount, {
    paid: statedPaid,
    balance: lifecycle === 'paid' ? 0 : totalAmount - paidAmount,
  });

  const customerRef = raw['customerRef'] as Record<string, unknown> | undefined;
  const lines = mapBokioSalesLines(raw['lineItems'] as Record<string, unknown>[] | undefined, currency);

  const vat = resolveVatTriple({
    gross: totalAmount,
    vat: readNumber(raw, BOKIO_VAT_KEYS),
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: vat.net !== undefined ? amount(vat.net, currency) : undefined,
    taxInclusiveAmount: amount(totalAmount, currency),
    payableAmount: amount(totalAmount, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid,
    balance: amount(balance, currency),
  };

  const status = doc.status ?? lifecycle;

  return {
    id: String(raw['id'] ?? ''),
    invoiceNumber: salesDocumentNumber(raw['invoiceNumber'], raw['id'], status),
    issueDate: (raw['invoiceDate'] as string) ?? '',
    dueDate: raw['dueDate'] as string | undefined,
    invoiceTypeCode: doc.invoiceTypeCode,
    currencyCode: currency,
    status,
    supplier: buildParty(''),
    customer: buildParty(
      (customerRef?.['name'] as string) ?? '',
    ),
    lines,
    taxTotal: vat.vat !== undefined ? { taxAmount: amount(vat.vat, currency) } : undefined,
    legalMonetaryTotal,
    paymentStatus,
    _raw: raw,
  };
}

/**
 * Map a Bokio credit note (`creditNote` in the published company-api spec,
 * listed on GET /companies/{companyId}/credit-notes, scope
 * `credit-notes:read`) to a SalesInvoiceDto with invoiceTypeCode 381.
 *
 * What Bokio sends on a credit note:
 * - id, invoiceNumber (the credit note's OWN number, null while draft)
 * - invoiceRef { id, invoiceNumber }: the invoice being credited
 * - customerRef { id, name, customerNumber }, status (draft | published)
 * - creditDate, dueDate, currency, currencyRate
 * - totalAmount, totalTax, paidAmount: MAGNITUDES, never negative
 * - lineItems: the same salesInvoiceItem shape as an invoice
 * - journalEntryRef { id } once recorded
 *
 * The amounts stay positive here: the shared importer states every credit
 * note in magnitudes and applies the sign once (entity-mapper
 * withAbsoluteAmounts), so a provider that negates and one that does not
 * land on the same row. `invoiceRef` is what lets the importer pair the
 * credit note with the invoice it credits.
 */
export function mapBokioToCreditNote(raw: Record<string, unknown>): SalesInvoiceDto {
  const currency = (raw['currency'] as string) ?? 'SEK';
  const totalAmount = (raw['totalAmount'] as number) ?? 0;
  const paidAmount = (raw['paidAmount'] as number) ?? 0;

  // Bokio's credit-note enum is draft | published. A draft has not been
  // issued and stays a draft; anything else is a terminal credit.
  const doc = documentState({
    issued: (raw['status'] as string | undefined)?.toLowerCase() !== 'draft',
    cancelled: false,
    creditFlag: true,
    total: totalAmount,
  });
  const { paid, balance } = documentPayment(doc, totalAmount, {
    paid: paidAmount >= totalAmount && totalAmount > 0,
    balance: totalAmount - paidAmount,
  });

  const customerRef = raw['customerRef'] as Record<string, unknown> | undefined;
  const invoiceRef = raw['invoiceRef'] as Record<string, unknown> | null | undefined;
  const lines = mapBokioSalesLines(raw['lineItems'] as Record<string, unknown>[] | undefined, currency);

  const vat = resolveVatTriple({
    gross: totalAmount,
    vat: readNumber(raw, BOKIO_VAT_KEYS),
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: vat.net !== undefined ? amount(vat.net, currency) : undefined,
    taxInclusiveAmount: amount(totalAmount, currency),
    payableAmount: amount(totalAmount, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid,
    balance: amount(balance, currency),
  };

  const creditedId = invoiceRef?.['id'];
  const creditedNumber = invoiceRef?.['invoiceNumber'];
  const creditedInvoiceRef: CreditedInvoiceRefDto | undefined =
    (typeof creditedId === 'string' && creditedId) || (typeof creditedNumber === 'string' && creditedNumber)
      ? {
          id: typeof creditedId === 'string' && creditedId ? creditedId : undefined,
          invoiceNumber: typeof creditedNumber === 'string' && creditedNumber ? creditedNumber : undefined,
        }
      : undefined;

  const status = doc.status ?? 'credited';

  return {
    id: String(raw['id'] ?? ''),
    invoiceNumber: salesDocumentNumber(raw['invoiceNumber'], raw['id'], status),
    issueDate: (raw['creditDate'] as string) ?? '',
    dueDate: raw['dueDate'] as string | undefined,
    invoiceTypeCode: doc.invoiceTypeCode,
    creditedInvoiceRef,
    currencyCode: currency,
    status,
    supplier: buildParty(''),
    customer: buildParty(
      (customerRef?.['name'] as string) ?? '',
    ),
    lines,
    taxTotal: vat.vat !== undefined ? { taxAmount: amount(vat.vat, currency) } : undefined,
    legalMonetaryTotal,
    paymentStatus,
    _raw: raw,
  };
}

/**
 * Map Bokio Customer to CustomerDto.
 *
 * Bokio Customer fields (`customer` in Bokio's published company-api spec):
 * - id, name, type (company|private), orgNumber, vatNumber, paymentTerms
 * - address: { line1, line2, city, postalCode, country }
 * - contactsDetails: [{ email, phone, name, isDefault }]
 *
 * The type was read as individual or person, words Bokio does not use, so
 * every private customer arrived as a company with its personnummer in
 * plain text as the org number (crm#1436).
 */
export function mapBokioToCustomer(raw: Record<string, unknown>): CustomerDto {
  const name = (raw['name'] as string) ?? '';
  const orgNumber = raw['orgNumber'] as string | undefined;
  const address = raw['address'] as Record<string, unknown> | undefined;
  const contacts = (raw['contactsDetails'] as Record<string, unknown>[] | undefined) ?? [];
  const contact = contacts.find((c) => c['isDefault'] === true) ?? contacts[0];

  const party = buildParty(name, orgNumber, address);
  if (contact) {
    party.contact = {
      email: contact['email'] as string | undefined,
      telephone: contact['phone'] as string | undefined,
      name: contact['name'] as string | undefined,
    };
  }

  return {
    id: String(raw['id'] ?? ''),
    customerNumber: String(raw['id'] ?? ''),
    type: raw['type'] === 'private' ? 'private' : 'company',
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
 * Bokio Supplier fields (`supplier` in Bokio's published company-api spec):
 * - id, name, orgNumber, vatNumber, currency
 * - address: { line1, line2, city, postalCode, country }
 * - paymentDetails: one of { type: bankgiro, bankgiroNumber },
 *   { type: plusgiro, plusgiroNumber }, { type: transfer, clearingNumber,
 *   accountNumber } and { type: internationalPayment, iban, bic }
 *
 * A Bokio supplier has no contacts and no payment terms. The giro and
 * account numbers were read from the top level, where Bokio has none, so no
 * Bokio supplier arrived with them (crm#1436).
 */
export function mapBokioToSupplier(raw: Record<string, unknown>): SupplierDto {
  const name = (raw['name'] as string) ?? '';
  const orgNumber = raw['orgNumber'] as string | undefined;
  const address = raw['address'] as Record<string, unknown> | undefined;
  const currency = raw['currency'];

  return {
    id: String(raw['id'] ?? ''),
    supplierNumber: String(raw['id'] ?? ''),
    party: buildParty(name, orgNumber, address),
    active: true,
    vatNumber: raw['vatNumber'] as string | undefined,
    ...supplierPaymentDetails(raw['paymentDetails']),
    currencyCode: typeof currency === 'string' && currency.trim() ? currency.trim() : undefined,
    _raw: raw,
  };
}

/** The one way a Bokio supplier is paid, as the giro or account it names. */
function supplierPaymentDetails(value: unknown): Pick<SupplierDto, 'bankGiro' | 'plusGiro' | 'bankAccount' | 'clearingNumber' | 'iban' | 'bic'> {
  if (!value || typeof value !== 'object') return {};
  const details = value as Record<string, unknown>;
  const text = (key: string) => {
    const v = details[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  switch (details['type']) {
    case 'bankgiro': return { bankGiro: text('bankgiroNumber') };
    case 'plusgiro': return { plusGiro: text('plusgiroNumber') };
    case 'transfer': return { clearingNumber: text('clearingNumber'), bankAccount: text('accountNumber') };
    case 'internationalPayment': return { iban: text('iban'), bic: text('bic') };
    default: return {};
  }
}

/**
 * Map Bokio Supplier Invoice (`supplierInvoiceGet` in Bokio's published
 * company-api spec) to SupplierInvoiceDto.
 *
 * What Bokio actually sends on a supplier invoice:
 * - id, supplierRef { id, name }, invoiceNumber, invoiceDate, dueDate
 * - totalAmount, remainingAmount (readOnly: the OPEN balance), currency, currencyRate
 * - journalEntryRef { id } (nullable: the voucher that booked it)
 * - lineItems (preview): description, quantity, unitPrice, unitType, taxRate
 * - uploadRefs
 *
 * There is no `status`, no `paidAmount` and no `totalTax` on this schema:
 * those belong to Bokio's SALES invoice. Reading them here anyway is what
 * made every migrated Bokio supplier invoice land as "Registrerad" with its
 * whole total still outstanding, because an absent field read as 0.
 * `remainingAmount` is the one payment field Bokio publishes, so it is the
 * one the payment state comes from.
 *
 * The schema carries no credit flag and no reference to a credited invoice
 * either. A supplier kreditfaktura arrives as a supplier invoice with a
 * negative `totalAmount` (10 such rows in production on 2026-09-21, imported
 * as open payables with a negative total, #2838), so the amount is the
 * signal and the credit note lands unpaired.
 */
export function mapBokioToSupplierInvoice(raw: Record<string, unknown>): SupplierInvoiceDto {
  const currency = (raw['currency'] as string) ?? 'SEK';
  const totalAmount = (raw['totalAmount'] as number) ?? 0;
  // The open balance, per the spec. Absent means an older or trimmed payload
  // said nothing about payment at all: fall back to the pre-fix reading (the
  // whole total outstanding, nothing settled) rather than invent a zero.
  const remaining = readNumber(raw, ['remainingAmount']);
  const balance = remaining ?? totalAmount;
  // Bokio ships no paid flag. A settled invoice is one that has an amount and
  // nothing left of it; a 0 kr record is amount-less, not settled.
  const paid = remaining !== undefined && totalAmount > 0 && remaining <= 0;

  const supplierRef = raw['supplierRef'] as Record<string, unknown> | undefined;
  // The hydration pass resolves this UUID to sourceVoucher through Bokio's
  // journal endpoint. Here it only establishes whether Bokio booked it.
  const journalEntryRef = raw['journalEntryRef'] as Record<string, unknown> | null | undefined;
  const rawLines = (raw['lineItems'] as Record<string, unknown>[] | undefined) ?? [];

  const lines: SupplierInvoiceLineDto[] = rawLines.map((line, idx) => {
    const unitPrice = readNumber(line, ['unitPrice']);
    const quantity = readNumber(line, ['quantity']);
    const lineTotal = multiplyIfBothPresent(unitPrice, quantity);
    const taxPercent = readNumber(line, ['taxRate']);
    const lineVat = lineTotal !== undefined ? lineVatFromPercent(lineTotal, taxPercent) : undefined;

    return {
      id: String(line['id'] ?? idx + 1),
      description: line['description'] as string | undefined,
      quantity,
      unitCode: bokioUnit(line),
      unitPrice: unitPrice != null ? amount(unitPrice, currency) : undefined,
      lineExtensionAmount: amount(lineTotal, currency),
      taxPercent,
      taxAmount: lineVat !== undefined ? amount(lineVat, currency) : undefined,
    };
  });

  const vat = resolveVatTriple({
    gross: totalAmount,
    vat: readNumber(raw, BOKIO_VAT_KEYS),
  });

  const legalMonetaryTotal: LegalMonetaryTotalDto = {
    lineExtensionAmount: vat.net !== undefined ? amount(vat.net, currency) : undefined,
    taxInclusiveAmount: amount(totalAmount, currency),
    payableAmount: amount(totalAmount, currency),
  };

  const paymentStatus: PaymentStatusDto = {
    paid,
    balance: amount(balance, currency),
    // Derived from the balance, never from a provider enum: Bokio publishes
    // no payment-status enum on a supplier invoice.
    source: 'balance',
  };

  // Bokio publishes no lifecycle status here either, so state the one thing
  // the payload does establish: settled, or booked (it named a journal
  // entry), or merely registered. 'sent' and 'booked' both land as
  // 'registered' in the migration; the distinction is kept because the DTO
  // has it and the next consumer may not collapse them.
  // The schema has no lifecycle: the total alone says what the document is.
  const doc = documentState({ issued: true, cancelled: false, creditFlag: false, total: totalAmount });
  const status: InvoiceStatusCode = doc.status ?? (paid
    ? 'paid'
    : (journalEntryRef?.['id'] ? 'booked' : 'sent'));

  return {
    id: String(raw['id'] ?? ''),
    // The supplier's own number, or nothing. Bokio's record id is not an
    // invoice number: substituting it put a UUID in "Fakturanummer" on every
    // number-less invoice. Empty becomes NULL at the insert, and the import
    // recognises a number-less invoice by supplier, date and amount instead.
    invoiceNumber: statedDocumentNumber(raw['invoiceNumber']),
    issueDate: (raw['invoiceDate'] as string) ?? '',
    dueDate: raw['dueDate'] as string | undefined,
    invoiceTypeCode: doc.invoiceTypeCode,
    currencyCode: currency,
    status,
    supplier: buildParty(
      (supplierRef?.['name'] as string) ?? '',
    ),
    buyer: buildParty(''),
    lines,
    taxTotal: vat.vat !== undefined ? { taxAmount: amount(vat.vat, currency) } : undefined,
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
 * - id, name, organizationNumber, companyType
 * - address: { line1, line2, city, postalCode, country }
 */
export function mapBokioToCompanyInformation(raw: Record<string, unknown>): CompanyInformationDto {
  const address = raw['address'] as Record<string, unknown> | undefined;

  return {
    companyName: (raw['name'] as string) ?? '',
    organizationNumber: raw['organizationNumber'] as string | undefined,
    legalEntity: {
      registrationName: (raw['name'] as string) ?? '',
      companyId: raw['organizationNumber'] as string | undefined,
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
