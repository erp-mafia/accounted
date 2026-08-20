import { FortnoxApiError, type FortnoxClient } from './client';

/**
 * Fortnox voucher attachment resource config + fetchers.
 *
 * Voucher file connections identify the archive file and the target voucher
 * directly. VoucherYear is Fortnox's financial-year ID, not a calendar year,
 * so callers must resolve it through /financialyears before matching the
 * SIE-preserved voucher series and number.
 */

const PAGE_SIZE = 500;

export interface FortnoxFinancialYear {
  id: number;
  fromDate: string;
  toDate: string;
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
    years.push({ id, fromDate, toDate });
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
