import type { BokioClient } from './client';

/**
 * Bokio document (upload) resource config + fetchers.
 *
 * Bokio exposes receipts/underlag via two endpoints:
 *   - GET /companies/{cid}/uploads               : list, carries journalEntryId
 *   - GET /companies/{cid}/uploads/{id}/download : raw bytes (octet-stream)
 *
 * The list does NOT include a filename, and the download is served as
 * application/octet-stream, so the real file type comes from the list item's
 * `contentType`, and a filename has to be synthesised by the caller.
 *
 * The link between an upload and a gnubok verifikat is recovered from the
 * Bokio journal entry's human voucher number (e.g. "V342"): the SIE import
 * preserves it on journal_entries.source_voucher_series / source_voucher_number.
 * Bokio restarts numbering at V1 every fiscal year, so the number alone is not
 * unique: callers must scope the match by fiscal year (the entry's date).
 */

const UPLOADS_PATH = '/uploads';
const JOURNAL_ENTRIES_PATH = '/journal-entries';

/** Bokio's pageSize caps at 100. */
const PAGE_SIZE = 100;

/** A `V342`-style voucher number: one or more letters (series) + digits. */
const VOUCHER_NUMBER_RE = /^([A-Za-z]+)(\d+)$/;

export interface BokioUpload {
  id: string;
  description: string | null;
  contentType: string | null;
  journalEntryId: string | null;
}

interface BokioJournalEntry {
  id: string;
  journalEntryNumber: string | null;
  date: string;
}

/** A Bokio voucher reference parsed from its journalEntryNumber. */
export interface BokioVoucherRef {
  /** Voucher series letter(s), e.g. "V". */
  series: string;
  /** Numeric part of the voucher number, e.g. 342. */
  number: number;
  /** Entry date (YYYY-MM-DD), used to scope the match by fiscal year. */
  date: string;
}

async function paginate<T>(
  client: BokioClient,
  accessToken: string,
  companyId: string,
  path: string,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await client.getPage<T>(accessToken, companyId, path, {
      page,
      pageSize: PAGE_SIZE,
    });
    all.push(...result.items);
    totalPages = result.totalPages;
    page++;
  } while (page <= totalPages);

  return all;
}

/** Page every upload (receipt) for a company. */
export function fetchBokioUploads(
  client: BokioClient,
  accessToken: string,
  companyId: string,
): Promise<BokioUpload[]> {
  return paginate<BokioUpload>(client, accessToken, companyId, UPLOADS_PATH);
}

/**
 * Build a GUID → voucher-reference index from Bokio's journal entries.
 * An upload only carries the entry's GUID; this resolves it to the human
 * voucher number (and date) that gnubok preserved from the SIE import.
 * Entries with an unparseable number are skipped.
 */
export async function fetchBokioVoucherIndex(
  client: BokioClient,
  accessToken: string,
  companyId: string,
): Promise<Map<string, BokioVoucherRef>> {
  const entries = await paginate<BokioJournalEntry>(
    client,
    accessToken,
    companyId,
    JOURNAL_ENTRIES_PATH,
  );

  const index = new Map<string, BokioVoucherRef>();
  for (const entry of entries) {
    const match = VOUCHER_NUMBER_RE.exec(entry.journalEntryNumber ?? '');
    if (!match) continue;
    index.set(entry.id, {
      series: match[1],
      number: Number(match[2]),
      date: entry.date,
    });
  }
  return index;
}

/** Download a single upload's bytes. */
export function downloadBokioUpload(
  client: BokioClient,
  accessToken: string,
  companyId: string,
  uploadId: string,
): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  return client.getBytes(accessToken, companyId, `${UPLOADS_PATH}/${uploadId}/download`);
}
