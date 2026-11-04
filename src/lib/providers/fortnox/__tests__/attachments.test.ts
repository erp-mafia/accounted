import { describe, expect, it, vi } from 'vitest';

import {
  downloadFortnoxArchiveFile,
  fetchFortnoxFileConnections,
  fetchFortnoxFinancialYears,
  fetchFortnoxSupplierInvoiceBookings,
  fetchFortnoxSupplierInvoiceBookingVoucher,
  fetchFortnoxSupplierInvoiceFileConnections,
} from '../attachments';
import { FortnoxApiError, type FortnoxClient } from '../client';

function clientWith(methods: Partial<FortnoxClient>): FortnoxClient {
  return methods as FortnoxClient;
}

describe('Fortnox attachments', () => {
  it('maps financial years and skips malformed rows', async () => {
    const getPaginated = vi.fn().mockResolvedValue([
      { Id: 3, FromDate: '2021-01-01', ToDate: '2021-12-31' },
      { Id: '4', FromDate: '2022-01-01', ToDate: '2022-12-31' },
      { Id: null, FromDate: '2023-01-01', ToDate: '2023-12-31' },
    ]);
    const client = clientWith({ getPaginated } as Partial<FortnoxClient>);

    await expect(fetchFortnoxFinancialYears(client, 'token')).resolves.toEqual([
      { id: 3, fromDate: '2021-01-01', toDate: '2021-12-31' },
      { id: 4, fromDate: '2022-01-01', toDate: '2022-12-31' },
    ]);
    expect(getPaginated).toHaveBeenCalledWith(
      'token',
      '/financialyears',
      'FinancialYears',
      { pageSize: 500 },
    );
  });

  it('queries each financial year, coerces fields, skips malformed rows, and deduplicates', async () => {
    const duplicate = {
      FileId: 'file-1',
      Name: 'kvitto.pdf',
      VoucherSeries: 'A',
      VoucherNumber: '12',
      VoucherYear: '3',
    };
    const getPaginated = vi
      .fn()
      .mockResolvedValueOnce([
        duplicate,
        duplicate,
        { FileId: '', VoucherSeries: 'A', VoucherNumber: '13', VoucherYear: '3' },
      ])
      .mockResolvedValueOnce([
        {
          FileId: 'file-2',
          Name: ' faktura.png ',
          VoucherSeries: 'B',
          VoucherNumber: 7,
          VoucherYear: 4,
        },
      ]);
    const client = clientWith({ getPaginated } as Partial<FortnoxClient>);

    await expect(fetchFortnoxFileConnections(client, 'token', [3, 4])).resolves.toEqual([
      {
        fileId: 'file-1',
        name: 'kvitto.pdf',
        series: 'A',
        number: 12,
        financialYearId: 3,
      },
      {
        fileId: 'file-2',
        name: 'faktura.png',
        series: 'B',
        number: 7,
        financialYearId: 4,
      },
    ]);
    expect(getPaginated).toHaveBeenNthCalledWith(
      1,
      'token',
      '/voucherfileconnections?financialyear=3',
      'VoucherFileConnections',
      { pageSize: 500 },
    );
    expect(getPaginated).toHaveBeenNthCalledWith(
      2,
      'token',
      '/voucherfileconnections?financialyear=4',
      'VoucherFileConnections',
      { pageSize: 500 },
    );
  });

  it('falls back to one unfiltered listing when Fortnox rejects the financialyear filter with 400', async () => {
    const getPaginated = vi
      .fn()
      .mockRejectedValueOnce(new FortnoxApiError('Fortnox API error: 400 Bad Request', 400, ''))
      .mockResolvedValueOnce([
        { FileId: 'file-1', Name: 'kvitto.pdf', VoucherSeries: 'A', VoucherNumber: 12, VoucherYear: 3 },
        { FileId: 'file-2', Name: 'faktura.png', VoucherSeries: 'B', VoucherNumber: 7, VoucherYear: 4 },
        { FileId: 'file-9', Name: 'gammalt.pdf', VoucherSeries: 'A', VoucherNumber: 1, VoucherYear: 1 },
      ]);
    const client = clientWith({ getPaginated } as Partial<FortnoxClient>);

    await expect(fetchFortnoxFileConnections(client, 'token', [3, 4])).resolves.toEqual([
      { fileId: 'file-1', name: 'kvitto.pdf', series: 'A', number: 12, financialYearId: 3 },
      { fileId: 'file-2', name: 'faktura.png', series: 'B', number: 7, financialYearId: 4 },
    ]);
    expect(getPaginated).toHaveBeenCalledTimes(2);
    expect(getPaginated).toHaveBeenNthCalledWith(
      2,
      'token',
      '/voucherfileconnections',
      'VoucherFileConnections',
      { pageSize: 500 },
    );
  });

  it('propagates a 400 from the unfiltered fallback and non-400 failures untouched', async () => {
    const scopeError = new FortnoxApiError('Fortnox API error: 400 Bad Request', 400, 'behörighet');
    const getPaginated = vi
      .fn()
      .mockRejectedValueOnce(new FortnoxApiError('Fortnox API error: 400 Bad Request', 400, ''))
      .mockRejectedValueOnce(scopeError);
    const client = clientWith({ getPaginated } as Partial<FortnoxClient>);
    await expect(fetchFortnoxFileConnections(client, 'token', [3])).rejects.toBe(scopeError);

    const forbidden = new FortnoxApiError('forbidden', 403);
    const client403 = clientWith({
      getPaginated: vi.fn().mockRejectedValue(forbidden),
    } as Partial<FortnoxClient>);
    await expect(fetchFortnoxFileConnections(client403, 'token', [3])).rejects.toBe(forbidden);
  });

  it('downloads through the archive path without fallback when it succeeds', async () => {
    const response = { bytes: new ArrayBuffer(2), contentType: 'application/pdf' };
    const getBinary = vi.fn().mockResolvedValue(response);
    const client = clientWith({ getBinary } as Partial<FortnoxClient>);

    await expect(downloadFortnoxArchiveFile(client, 'token', 'file-1')).resolves.toBe(response);
    expect(getBinary).toHaveBeenCalledTimes(1);
    expect(getBinary).toHaveBeenCalledWith('token', '/archive/file-1');
  });

  it('retries the query-form archive endpoint once after a 404', async () => {
    const response = { bytes: new ArrayBuffer(2), contentType: 'image/jpeg' };
    const getBinary = vi
      .fn()
      .mockRejectedValueOnce(new FortnoxApiError('not found', 404))
      .mockResolvedValueOnce(response);
    const client = clientWith({ getBinary } as Partial<FortnoxClient>);

    await expect(downloadFortnoxArchiveFile(client, 'token', 'file-1')).resolves.toBe(response);
    expect(getBinary).toHaveBeenNthCalledWith(1, 'token', '/archive/file-1');
    expect(getBinary).toHaveBeenNthCalledWith(2, 'token', '/archive/?fileid=file-1');
  });

  it('propagates non-404 archive failures without trying the fallback', async () => {
    const error = new FortnoxApiError('server error', 500);
    const getBinary = vi.fn().mockRejectedValue(error);
    const client = clientWith({ getBinary } as Partial<FortnoxClient>);

    await expect(downloadFortnoxArchiveFile(client, 'token', 'file-1')).rejects.toBe(error);
    expect(getBinary).toHaveBeenCalledTimes(1);
  });
  it('lists supplier-invoice file connections by löpnummer, skipping malformed and duplicate rows', async () => {
    const row = { FileId: 'file-1', Name: ' faktura.pdf ', SupplierInvoiceNumber: '112', SupplierName: 'Leverantören AB' };
    const getPaginated = vi.fn().mockResolvedValue([
      row,
      row,
      { FileId: 'file-2', Name: '', SupplierInvoiceNumber: 113 },
      { FileId: '', SupplierInvoiceNumber: '114' },
      { FileId: 'file-3', SupplierInvoiceNumber: 'F-115' },
    ]);
    const client = clientWith({ getPaginated } as Partial<FortnoxClient>);

    await expect(fetchFortnoxSupplierInvoiceFileConnections(client, 'token')).resolves.toEqual([
      { fileId: 'file-1', name: 'faktura.pdf', givenNumber: '112' },
      { fileId: 'file-2', name: null, givenNumber: '113' },
    ]);
    expect(getPaginated).toHaveBeenCalledWith(
      'token',
      '/supplierinvoicefileconnections',
      'SupplierInvoiceFileConnections',
      { pageSize: 500 },
    );
  });

  it('reads the booking voucher from the list form only when exactly one SUPPLIERINVOICE voucher names it', async () => {
    const getPaginated = vi.fn().mockResolvedValue([
      {
        GivenNumber: '112',
        Booked: true,
        Vouchers: [
          { Number: 9, Series: 'E', ReferenceType: 'SUPPLIERPAYMENT', Year: 5 },
          { Number: 17, Series: 'D', ReferenceType: 'SUPPLIERINVOICE', Year: 5 },
        ],
      },
      { GivenNumber: '113', Booked: true },
      {
        GivenNumber: 114,
        Booked: true,
        Vouchers: [
          { Number: 3, Series: 'D', ReferenceType: 'SUPPLIERINVOICE', Year: 5 },
          { Number: 4, Series: 'D', ReferenceType: 'SUPPLIERINVOICE', Year: 5 },
        ],
      },
      { GivenNumber: '115', Booked: false, Vouchers: [] },
      { GivenNumber: '116', Booked: true, Cancel: true },
      { GivenNumber: '117', Booked: true, Vouchers: [{ Number: 0, Series: 'D', ReferenceType: 'SUPPLIERINVOICE', Year: 5 }] },
    ]);
    const client = clientWith({ getPaginated } as Partial<FortnoxClient>);

    const bookings = await fetchFortnoxSupplierInvoiceBookings(client, 'token');

    expect(Object.fromEntries(bookings)).toEqual({
      '112': { state: 'booked', voucher: { series: 'D', number: 17, financialYearId: 5 } },
      '113': { state: 'unknown' },
      '114': { state: 'unknown' },
      '115': { state: 'unbooked' },
      '116': { state: 'unbooked' },
      '117': { state: 'unknown' },
    });
    // Fortnox's default page: a 500-item page of whole invoices outlasted the 15 s request timeout (crm#1642).
    expect(getPaginated).toHaveBeenCalledWith('token', '/supplierinvoices', 'SupplierInvoices', { pageSize: 100 });
  });

  it('reads the booking voucher from the detail form, null when Fortnox names none', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ SupplierInvoice: { GivenNumber: '113', VoucherSeries: 'D', VoucherNumber: '3', VoucherYear: 6 } })
      .mockResolvedValueOnce({ SupplierInvoice: { GivenNumber: '114', VoucherSeries: 'D', VoucherNumber: 0, VoucherYear: 6 } })
      .mockResolvedValueOnce({ SupplierInvoice: { GivenNumber: '115', Cancelled: true, VoucherSeries: 'D', VoucherNumber: 8, VoucherYear: 6 } })
      .mockRejectedValueOnce(new FortnoxApiError('not found', 404));
    const client = clientWith({ get } as Partial<FortnoxClient>);

    await expect(fetchFortnoxSupplierInvoiceBookingVoucher(client, 'token', '113')).resolves.toEqual({
      series: 'D',
      number: 3,
      financialYearId: 6,
    });
    await expect(fetchFortnoxSupplierInvoiceBookingVoucher(client, 'token', '114')).resolves.toBeNull();
    await expect(fetchFortnoxSupplierInvoiceBookingVoucher(client, 'token', '115')).resolves.toBeNull();
    await expect(fetchFortnoxSupplierInvoiceBookingVoucher(client, 'token', '116')).resolves.toBeNull();
    expect(get).toHaveBeenNthCalledWith(1, 'token', '/supplierinvoices/113');
  });

  it('propagates a refused detail form so the caller can name the scope', async () => {
    const forbidden = new FortnoxApiError('forbidden', 403);
    const client = clientWith({ get: vi.fn().mockRejectedValue(forbidden) } as Partial<FortnoxClient>);

    await expect(fetchFortnoxSupplierInvoiceBookingVoucher(client, 'token', '113')).rejects.toBe(forbidden);
  });
});
