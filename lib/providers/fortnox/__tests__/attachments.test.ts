import { describe, expect, it, vi } from 'vitest';

import {
  downloadFortnoxArchiveFile,
  fetchFortnoxFileConnections,
  fetchFortnoxFinancialYears,
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
});
