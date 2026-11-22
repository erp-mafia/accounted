import { FortnoxApiError, type FortnoxClient } from './client';
import { fortnoxSupplierInvoiceSettled } from './mapper';
import {
  fortnoxSupplierInvoiceBookingParts,
  fortnoxSupplierInvoiceCashBookingParts,
  fortnoxSupplierInvoicePaymentParts,
} from './supplier-invoice-voucher';

/**
 * Fortnox attachment resource config + fetchers.
 *
 * Voucher file connections identify the archive file and the target voucher
 * directly. VoucherYear is Fortnox's financial-year ID, not a calendar year,
 * so callers must resolve it through /financialyears before matching the
 * SIE-preserved voucher series and number.
 *
 * Supplier-invoice file connections name the supplier invoice instead; the
 * verifikat is the one that booked that invoice. Scopes (Fortnox's scope
 * table, developer guide "Scopes"): both file-connection registers are
 * `connectfile`, /archive is `archive`, /supplierinvoices is
 * `supplierinvoice`. Customer-invoice files have no file-connection register
 * there: they live in the separate fileattachments service, keyed per
 * invoice id, so they are not read here.
 *
 * A customer invoice's own document is read here: its preview PDF
 * (`/invoices/{DocumentNumber}/preview`, the action that renders without
 * marking the invoice sent; `/print` and `/email` are never called) and the
 * booking voucher its detail form names. Scope: invoice.
 */

const PAGE_SIZE = 500;

/**
 * The supplier-invoice list is read at Fortnox's default page size, not 500.
 * Its items are whole invoices with their vouchers, and a 500-item page of a
 * large register took longer than the client's 15 s per request: in production
 * (2026-11-03) that list timed out six attempts in a row on 3 of 65 slices of
 * one company's runs, while the file-connection registers at 500 never did.
 * A smaller page is a shorter request.
 */
const SUPPLIER_INVOICE_PAGE_SIZE = 100;

export interface FortnoxFinancialYear {
  id: number;
  fromDate: string;
  toDate: string;
  /** The year's bookkeeping method, when Fortnox states it: CASH is kontantmetoden. */
  accountingMethod?: 'ACCRUAL' | 'CASH';
}

export interface FortnoxFileConnection {
  fileId: string;
  name: string | null;
  series: string;
  number: number;
  financialYearId: number;
}

function finiteInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** Fetch every Fortnox financial year available to the consent. */
export async function fetchFortnoxFinancialYears(
  client: FortnoxClient,
  accessToken: string,
): Promise<FortnoxFinancialYear[]> {
  const rawYears = await client.getPaginated<Record<string, unknown>>(
    accessToken,
    '/financialyears',
    'FinancialYears',
    { pageSize: PAGE_SIZE },
  );

  const years: FortnoxFinancialYear[] = [];
  for (const raw of rawYears) {
    const id = finiteInteger(raw.Id);
    const fromDate = typeof raw.FromDate === 'string' ? raw.FromDate.trim() : '';
    const toDate = typeof raw.ToDate === 'string' ? raw.ToDate.trim() : '';
    if (id == null || !fromDate || !toDate) continue;
    const method = typeof raw.AccountingMethod === 'string' ? raw.AccountingMethod.trim().toUpperCase() : '';
    years.push({
      id,
      fromDate,
      toDate,
      ...(method === 'ACCRUAL' || method === 'CASH' ? { accountingMethod: method } : {}),
    });
  }
  return years;
}

/**
 * Fetch and deduplicate voucher file connections for each financial year.
 *
 * Fortnox is asked per financial year first. If it answers 400 to the
 * `financialyear` filter (seen live 2026-08-20: the resource took the filter
 * in the docs' POST example but rejected the list call), one unfiltered
 * listing is fetched instead and rows are selected on their own VoucherYear.
 * A 400 that is really a missing scope/licence surfaces again on the
 * unfiltered call and propagates to the caller's permission handling.
 */
export async function fetchFortnoxFileConnections(
  client: FortnoxClient,
  accessToken: string,
  financialYearIds: number[],
): Promise<FortnoxFileConnection[]> {
  const connections: FortnoxFileConnection[] = [];
  const seen = new Set<string>();
  const wantedYears = new Set(financialYearIds);

  const collect = (rawConnections: Record<string, unknown>[]) => {
    for (const raw of rawConnections) {
      const fileId = typeof raw.FileId === 'string' ? raw.FileId.trim() : '';
      const series = typeof raw.VoucherSeries === 'string' ? raw.VoucherSeries.trim() : '';
      const number = finiteInteger(raw.VoucherNumber);
      const itemFinancialYearId = finiteInteger(raw.VoucherYear);
      if (!fileId || !series || number == null || itemFinancialYearId == null) continue;
      if (!wantedYears.has(itemFinancialYearId)) continue;

      const key = `${fileId}|${itemFinancialYearId}|${series}|${number}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const name = typeof raw.Name === 'string' && raw.Name.trim() ? raw.Name.trim() : null;
      connections.push({
        fileId,
        name,
        series,
        number,
        financialYearId: itemFinancialYearId,
      });
    }
  };

  for (const financialYearId of wantedYears) {
    let rawConnections: Record<string, unknown>[];
    try {
      rawConnections = await client.getPaginated<Record<string, unknown>>(
        accessToken,
        `/voucherfileconnections?financialyear=${financialYearId}`,
        'VoucherFileConnections',
        { pageSize: PAGE_SIZE },
      );
    } catch (error) {
      if (!(error instanceof FortnoxApiError) || error.statusCode !== 400) throw error;
      collect(
        await client.getPaginated<Record<string, unknown>>(
          accessToken,
          '/voucherfileconnections',
          'VoucherFileConnections',
          { pageSize: PAGE_SIZE },
        ),
      );
      break;
    }
    collect(rawConnections);
  }

  return connections;
}

/**
 * A file Fortnox keeps on a supplier invoice rather than on its verifikat.
 *
 * Fortnox stores the scanned invoice on the supplier invoice itself
 * (Leverantörsfakturor), so the verifikat that books it (D series by
 * default) has no voucher file connection: a voucher-only sweep never sees
 * these files. `givenNumber` is the invoice's löpnummer (GivenNumber), the
 * key the connection names it by (`SupplierInvoiceNumber`).
 */
export interface FortnoxSupplierInvoiceFileConnection {
  fileId: string;
  name: string | null;
  givenNumber: string;
}

/** The verifikat that booked a supplier invoice, as Fortnox numbers it. */
export interface FortnoxBookingVoucher {
  series: string;
  number: number;
  /** Fortnox's financial-year ID, resolved through /financialyears like VoucherYear. */
  financialYearId: number;
}

/**
 * What the supplier-invoice register says about one invoice's booking.
 *  - `booked`: one booking voucher named exactly.
 *  - `unbooked`: Fortnox says the invoice was cancelled, or never booked and
 *    never paid, so no verifikat exists to carry its file.
 *  - `unknown`: the list form named no single booking voucher; only the
 *    detail form can tell (fetchFortnoxSupplierInvoiceBookingVoucher).
 */
export type FortnoxSupplierInvoiceBooking =
  | { state: 'booked'; voucher: FortnoxBookingVoucher }
  | { state: 'unbooked' }
  | { state: 'unknown' };

function bookingVoucherFrom(
  series: unknown,
  number: unknown,
  year: unknown,
): FortnoxBookingVoucher | null {
  const seriesText = typeof series === 'string' ? series.trim() : '';
  const voucherNumber = finiteInteger(number);
  const financialYearId = finiteInteger(year);
  if (!seriesText || voucherNumber == null || financialYearId == null) return null;
  return { series: seriesText, number: voucherNumber, financialYearId };
}

function givenNumberOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/**
 * Every supplier-invoice file connection in the company. The register takes
 * no year filter (the API reference lists none), so one paged listing covers
 * all years. Scope: connectfile, the same as voucher file connections.
 */
export async function fetchFortnoxSupplierInvoiceFileConnections(
  client: FortnoxClient,
  accessToken: string,
): Promise<FortnoxSupplierInvoiceFileConnection[]> {
  const rawConnections = await client.getPaginated<Record<string, unknown>>(
    accessToken,
    '/supplierinvoicefileconnections',
    'SupplierInvoiceFileConnections',
    { pageSize: PAGE_SIZE },
  );

  const connections: FortnoxSupplierInvoiceFileConnection[] = [];
  const seen = new Set<string>();
  for (const raw of rawConnections) {
    const fileId = typeof raw.FileId === 'string' ? raw.FileId.trim() : '';
    const givenNumber = givenNumberOf(raw.SupplierInvoiceNumber);
    if (!fileId || !/^\d+$/.test(givenNumber)) continue;

    const key = `${fileId}|${givenNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const name = typeof raw.Name === 'string' && raw.Name.trim() ? raw.Name.trim() : null;
    connections.push({ fileId, name, givenNumber });
  }
  return connections;
}

/**
 * The booking voucher of every supplier invoice, read from the register's
 * list form (paid invoices included), by fortnoxSupplierInvoiceBookingParts.
 * An invoice it names no single booking for is `unknown`, never a guess: the
 * caller asks the detail form. So is an unbooked invoice Fortnox names a
 * payment for: under kontantmetoden that payment booked it, and only the
 * detail form carries the balance that tells (crm#2112). Scope:
 * supplierinvoice.
 */
export async function fetchFortnoxSupplierInvoiceBookings(
  client: FortnoxClient,
  accessToken: string,
): Promise<Map<string, FortnoxSupplierInvoiceBooking>> {
  const rawInvoices = await client.getPaginated<Record<string, unknown>>(
    accessToken,
    '/supplierinvoices',
    'SupplierInvoices',
    { pageSize: SUPPLIER_INVOICE_PAGE_SIZE },
  );

  const bookings = new Map<string, FortnoxSupplierInvoiceBooking>();
  for (const raw of rawInvoices) {
    const givenNumber = givenNumberOf(raw.GivenNumber);
    if (!givenNumber) continue;

    // The list form spells cancellation `Cancel`, the detail form `Cancelled`.
    if (raw.Cancel === true || raw.Cancelled === true) {
      bookings.set(givenNumber, { state: 'unbooked' });
      continue;
    }

    // Never booked at registration. A paid one may be kontantmetod, booked by
    // its payment: the detail form decides. Such files used to be dropped
    // here uncounted.
    if (raw.Booked === false) {
      const paid = fortnoxSupplierInvoicePaymentParts(raw).length > 0;
      bookings.set(givenNumber, { state: paid ? 'unknown' : 'unbooked' });
      continue;
    }

    const parts = fortnoxSupplierInvoiceBookingParts(raw);
    const booking = parts ? bookingVoucherFrom(parts.series, parts.number, parts.year) : null;
    bookings.set(givenNumber, booking ? { state: 'booked', voucher: booking } : { state: 'unknown' });
  }
  return bookings;
}

/**
 * The booking voucher from one supplier invoice's detail form, or null when
 * Fortnox names none (no booking reference: never booked; cancelled; an
 * invoice the register no longer has). An invoice Fortnox marks never booked
 * (`Booked: false`) has no booking reference, whatever else it names.
 *
 * An invoice with no booking reference that is paid in full by one payment
 * in a kontantmetod year (`cashYearIds`, Fortnox's financial-year ids whose
 * AccountingMethod is CASH) was booked by that payment
 * (fortnoxSupplierInvoiceCashBookingParts): that payment is returned. A
 * payment in any other year, a part payment or part refund (a balance not
 * zero), a balance Fortnox does not state, or an invoice Fortnox marks
 * booked stays null.
 */
export async function fetchFortnoxSupplierInvoiceBookingVoucher(
  client: FortnoxClient,
  accessToken: string,
  givenNumber: string,
  cashYearIds: ReadonlySet<number> = new Set(),
): Promise<FortnoxBookingVoucher | null> {
  let response: Record<string, unknown>;
  try {
    response = await client.get<Record<string, unknown>>(
      accessToken,
      `/supplierinvoices/${encodeURIComponent(givenNumber)}`,
    );
  } catch (error) {
    if (error instanceof FortnoxApiError && error.statusCode === 404) return null;
    throw error;
  }
  const invoice = (response?.SupplierInvoice ?? {}) as Record<string, unknown>;
  if (invoice.Cancelled === true || invoice.Cancel === true) return null;
  // Never booked at registration, as in the list form: only the kontantmetod
  // payment below can carry the file, never a voucher named some other way.
  const parts = invoice.Booked === false ? null : fortnoxSupplierInvoiceBookingParts(invoice);
  const booking = parts ? bookingVoucherFrom(parts.series, parts.number, parts.year) : null;
  if (booking) return booking;

  const cash = fortnoxSupplierInvoiceCashBookingParts(invoice);
  const payment = cash ? bookingVoucherFrom(cash.series, cash.number, cash.year) : null;
  // Marked booked yet naming no SUPPLIERINVOICE voucher: what booked it is
  // unknown, and the payment may only have cleared 2440.
  if (!payment || invoice.Booked === true || !cashYearIds.has(payment.financialYearId)) return null;
  if (!fortnoxSupplierInvoiceSettled(invoice)) return null;
  return payment;
}

/**
 * The verifikat that booked one customer invoice, from its detail form
 * (`/invoices/{DocumentNumber}`): VoucherSeries, VoucherNumber and
 * VoucherYear (Fortnox's financial-year ID, as Year is in a supplier
 * invoice's Vouchers). Null when Fortnox names none: never booked
 * (VoucherNumber 0 or absent), cancelled, or an invoice the register no
 * longer has. Scope: invoice.
 */
export async function fetchFortnoxInvoiceBookingVoucher(
  client: FortnoxClient,
  accessToken: string,
  documentNumber: string,
): Promise<FortnoxBookingVoucher | null> {
  let response: Record<string, unknown>;
  try {
    response = await client.get<Record<string, unknown>>(
      accessToken,
      `/invoices/${encodeURIComponent(documentNumber)}`,
    );
  } catch (error) {
    if (error instanceof FortnoxApiError && error.statusCode === 404) return null;
    throw error;
  }
  const invoice = (response?.Invoice ?? {}) as Record<string, unknown>;
  if (invoice.Cancelled === true) return null;
  return bookingVoucherFrom(invoice.VoucherSeries, invoice.VoucherNumber, invoice.VoucherYear);
}

/**
 * A customer invoice rendered by Fortnox as PDF, through the preview action:
 * unlike `/print` it does not mark the invoice sent. Scope: invoice.
 */
export async function fetchFortnoxInvoicePreview(
  client: FortnoxClient,
  accessToken: string,
  documentNumber: string,
): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  return client.getBinary(accessToken, `/invoices/${encodeURIComponent(documentNumber)}/preview`);
}

/** Download a Fortnox archive object, including the inbox-compatible fallback. */
export async function downloadFortnoxArchiveFile(
  client: FortnoxClient,
  accessToken: string,
  fileId: string,
): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  const encodedFileId = encodeURIComponent(fileId);
  try {
    return await client.getBinary(accessToken, `/archive/${encodedFileId}`);
  } catch (error) {
    if (!(error instanceof FortnoxApiError) || error.statusCode !== 404) throw error;
    return client.getBinary(accessToken, `/archive/?fileid=${encodedFileId}`);
  }
}
