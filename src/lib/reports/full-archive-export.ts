import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { withSIEPeriodRead } from '@/lib/import/sie-period-read'
import { ArchiveFolder, ArchiveTooLargeError, collectBytes, readAhead, type ArchiveRead } from './archive-folder'
import { generateSIEExport } from './sie-export'
import { generateTrialBalance } from './trial-balance'
import { generateIncomeStatement } from './income-statement'
import { balanceSheetFromTrialBalance } from './balance-sheet'
import { generateGeneralLedger } from './general-ledger'
import { generateJournalRegister } from './journal-register'
import { calculateVatDeclaration } from './vat-declaration'
import { getAuditLog, type AuditLogCursor } from '@/lib/core/audit/audit-service'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import { listAttachmentRowsInRange } from '@/lib/reconciliation/attachments-store'
import { generateBokslutsbilagor } from './bokslutsbilagor'
import { generateSystemdokumentation } from './systemdokumentation'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getBranding } from '@/lib/branding/service'
import {
  trialBalanceToCsv,
  incomeStatementToCsv,
  balanceSheetToCsv,
  generalLedgerToCsv,
  type TrialBalanceLike,
} from './archive-csv'
import { buildArchiveReadme, buildDriveFolderReadme } from './archive-readme'
import {
  ANNUAL_REPORT_RULES,
  ARCHIVE_RULES,
  BEHANDLINGSHISTORIK_RULES,
  INVOICE_NUMBER_RULES,
  SIE_IMPORT_RULES,
  SUPPLIER_INVOICE_ROUNDING_RULES,
  SUPPLIER_PAYMENT_RULES,
  VOUCHER_SERIES_RULES,
} from './system-rules'
import { currentAppVersion } from './app-version'
import type { GeneralLedgerReport } from './general-ledger'
import type {
  AuditLogEntry,
  BalanceSheetReport,
  IncomeStatementReport,
} from '@/types'

export type FullArchiveOptions = (
  | { scope: 'period'; period_id: string; include_documents?: boolean }
  | { scope: 'all'; include_documents?: boolean }
) & {
  /**
   * generateFullArchive only: the most the caller can keep. Past it the build
   * stops with ArchiveTooLargeError, before the behandlingshistorik or the
   * ZIP is held whole (crm#1703: a period with 50 000 audit rows ran the
   * function out of memory). The streamed download has no ceiling.
   */
  max_bytes?: number
}

export type ArchiveScope = FullArchiveOptions['scope']

/**
 * Storage reads kept in flight ahead of the ZIP writer. A document is at most
 * MAX_DOCUMENT_SIZE (10 MB; a few older ones reach 20 MB), so this holds well
 * under 200 MB while the round trips overlap.
 */
const STORAGE_READ_AHEAD = 6

/**
 * A storage object that goes into the archive when the writer reaches it. A
 * failed read leaves the file out and is reported to `failed` for the
 * manifest; it never aborts the archive.
 */
function storageRead(
  download: () => Promise<{ data: Blob | null; error: { message?: string } | null }>,
  failed: (message: string) => void,
  verify?: (bytes: ArrayBuffer) => void,
): ArchiveRead {
  return async () => {
    try {
      const { data, error } = await download()
      if (error || !data) {
        failed(error?.message || 'Download returned no data')
        return null
      }
      const bytes = await data.arrayBuffer()
      verify?.(bytes)
      return bytes
    } catch (err) {
      failed(err instanceof Error ? err.message : 'Unknown error')
      return null
    }
  }
}

/** Add deferred files in their order, the reads overlapping a few ahead of the writer. */
function addStorageFiles(folder: ArchiveFolder, files: { path: string; read: ArchiveRead }[]): void {
  const reads = readAhead(files.map((f) => f.read), STORAGE_READ_AHEAD)
  files.forEach((f, i) => folder.file(f.path, reads[i]))
}

interface DocumentManifestEntry {
  document_id: string
  file_name: string
  storage_path: string
  sha256_hash: string
  journal_entry_id: string | null
  fiscal_period_id: string | null
  version: number
  digitization_date: string | null
  upload_source: string | null
  mime_type: string | null
  file_size_bytes: number | null
  // New fields (added to make ZIP entries sortable by verifikatnummer)
  voucher_number: string | null
  entry_date: string | null
  zip_path: string | null
  status: 'downloaded' | 'missing' | 'error'
  error?: string
}

interface FiscalPeriodRow {
  id: string
  period_start: string
  period_end: string
  opening_balance_entry_id: string | null
}

interface CompanyInfo {
  company_name: string | null
  org_number: string | null
  moms_period: string | null
}

interface DocumentRow {
  id: string
  file_name: string
  storage_path: string
  journal_entry_id: string | null
  sha256_hash: string
  version: number
  digitization_date: string | null
  upload_source: string | null
  mime_type: string | null
  file_size_bytes: number | null
  // Joined from journal_entries via journal_entry_id. May be null when the
  // entry is a draft (no voucher_number yet) or when the doc is orphaned.
  // PostgREST returns a single row as an object, not an array, when the FK
  // is many-to-one, but we tolerate both shapes defensively.
  journal_entries?:
    | { voucher_number: number | null; voucher_series: string | null; entry_date: string | null }
    | { voucher_number: number | null; voucher_series: string | null; entry_date: string | null }[]
    | null
}

interface PeriodReports {
  trialBalance: unknown
  incomeStatement: unknown
  balanceSheet: unknown
  generalLedger: unknown
  journalRegister: unknown
  vatDeclaration: unknown | null
}

const REPORT_CONCURRENCY = 3
// 5 MB for SIE + reports + audit + system doc, +3 MB headroom for master-data
// JSON dumps and raw imported SIE files (the bucket caps each file at 50 MB,
// but typical SIE4 files are tens of KB so a few MB covers most companies).
export const ARCHIVE_OVERHEAD_BYTES = 8 * 1024 * 1024

/** Documents included in an archive: per-period, everything, or only the rest. */
type DocumentMode = ArchiveScope | 'unlinked'

/**
 * Generate a full archive ZIP for a company.
 *
 * `scope: 'period'` produces the single-period archive used by account/company
 * deletion flows: `bokforing.se`, flat `rapporter/*.json`, `dokument/*`, and
 * `revision/*`.
 *
 * `scope: 'all'` produces the "säkerhetsbackup" covering the entire company
 * history: one SIE4 file per period under `sie/`, per-period `rapporter/`
 * subfolders, a flat `dokument/` with manifest tagged by fiscal_period_id,
 * and an unfiltered `revision/behandlingshistorik.json`.
 *
 * The whole ZIP is held in memory: for callers with their own size cap
 * (cloud backup, the MCP audit package). Downloads use streamFullArchive.
 */
export async function generateFullArchive(
  supabase: SupabaseClient,
  companyId: string,
  options: FullArchiveOptions
): Promise<ArrayBuffer> {
  return collectBytes(streamFullArchive(supabase, companyId, options), options.max_bytes)
}

/**
 * The full archive as ZIP bytes, produced while they are read: what the
 * download routes send, so an archive has no size ceiling but time.
 *
 * The ledger part (SIE, reports, master data, behandlingshistorik,
 * systemdokumentation, and which underlag exist) is read inside one SIE read
 * lease before the first byte. The underlag files are read from storage after
 * the lease, when the writer reaches them and a few ahead of it, so memory
 * holds a handful of files rather than the archive. The lease guards the
 * ledger against a half-run SIE import; an import never rewrites a stored
 * file, and one gone by the time it is read lands in the manifest as a failed
 * read, as before.
 */
export async function* streamFullArchive(
  supabase: SupabaseClient,
  companyId: string,
  options: FullArchiveOptions
): AsyncGenerator<Uint8Array> {
  const archive = await withSIEPeriodRead(supabase, companyId, 'report_export', () =>
    buildFullArchive(supabase, companyId, options))
  yield* archive.zip()
}

async function buildFullArchive(
  supabase: SupabaseClient,
  companyId: string,
  options: FullArchiveOptions
): Promise<ArchiveFolder> {
  const company = await fetchCompany(supabase, companyId)
  const periods =
    options.scope === 'all'
      ? await fetchAllPeriods(supabase, companyId)
      : [await fetchSinglePeriod(supabase, companyId, options.period_id)]

  // A retained source can have documents and company history before its first
  // fiscal year. An all-company archive must keep that material accessible too.

  const zip = ArchiveFolder.root()

  if (options.scope === 'all') {
    const sieFolder = zip.folder('sie')
    const rapporterFolder = zip.folder('rapporter')

    for (let i = 0; i < periods.length; i += REPORT_CONCURRENCY) {
      const batch = periods.slice(i, i + REPORT_CONCURRENCY)
      await Promise.all(
        batch.map(async (period) => {
          const sie = await generateSIEExport(supabase, companyId, {
            fiscal_period_id: period.id,
            company_name: company.company_name || 'Unknown',
            org_number: company.org_number,
          })
          sieFolder.file(`${periodLabel(period)}.se`, sie)

          const reports = await generatePeriodReports(supabase, companyId, period)
          const periodFolder = rapporterFolder.folder(periodLabel(period))
          writeReports(periodFolder, reports)
          await writeBokslutsbilagor(periodFolder, supabase, companyId, period.id)
        })
      )
    }
  } else {
    const period = periods[0]
    const sie = await generateSIEExport(supabase, companyId, {
      fiscal_period_id: period.id,
      company_name: company.company_name || 'Unknown',
      org_number: company.org_number,
    })
    zip.file('bokforing.se', sie)

    const reports = await generatePeriodReports(supabase, companyId, period)
    const rapporter = zip.folder('rapporter')
    writeReports(rapporter, reports)
    await writeBokslutsbilagor(rapporter, supabase, companyId, period.id)
  }

  if (options.include_documents !== false) {
    await writeDocuments(zip, supabase, companyId, periods, options.scope)
    if (periods.length) await writeReconciliationAttachments(zip, supabase, companyId, periods)
  }

  if (options.scope === 'all') {
    await writeSieSourceFiles(zip, supabase, companyId, options.include_documents !== false)
    await writeMasterData(zip, supabase, companyId)
  }

  const revision = zip.folder('revision')

  const budget = options.max_bytes !== undefined ? auditBudget(options.max_bytes) : undefined
  const auditEntries =
    options.scope === 'period'
      ? await fetchPeriodAuditEntries(supabase, companyId, periods[0], budget)
      : await fetchAllAuditEntries(supabase, companyId, {}, budget)
  revision.file('behandlingshistorik.json', JSON.stringify(auditEntries, null, 2))

  const systemDoc = await buildSystemDoc(supabase, companyId, periods, options.scope)
  revision.file('systemdokumentation.json', JSON.stringify(systemDoc, null, 2))
  // The snapshot per räkenskapsår (BFNAR 2013:2 kap. 9): the report as it
  // stood when the archive was made, since members, keys and integrations
  // change later and the live report would then differ from the archive.
  for (const period of periods) {
    await writeSystemdokumentation(revision, supabase, companyId, period)
  }

  zip.file(
    'LÄSMIG.txt',
    buildArchiveReadme({
      companyName: company.company_name || 'Okänt företag',
      orgNumber: company.org_number,
      generatedAt: new Date().toISOString(),
      scope: options.scope,
      periodLabel: options.scope === 'period' ? periodLabel(periods[0]) : undefined,
      appName: getBranding().appName,
    })
  )

  return zip
}

/**
 * Generate the "Grunddata" archive for the per-fiscal-year Drive backup:
 * everything that is not tied to a single fiscal year. Master-data JSON
 * dumps, original imported SIE files, documents no period archive carries
 * (unlinked/draft), the full behandlingshistorik and the system
 * documentation. Complements one `generateFullArchive(scope='period')` ZIP
 * per räkenskapsår.
 */
export async function generateBaseDataArchive(
  supabase: SupabaseClient,
  companyId: string,
  options: { include_documents?: boolean } = {}
): Promise<ArrayBuffer> {
  const archive = await withSIEPeriodRead(supabase, companyId, 'report_export', () =>
    buildBaseDataArchive(supabase, companyId, options))
  return collectBytes(archive.zip())
}

async function buildBaseDataArchive(
  supabase: SupabaseClient,
  companyId: string,
  options: { include_documents?: boolean }
): Promise<ArchiveFolder> {
  const company = await fetchCompany(supabase, companyId)
  const periods = await fetchAllPeriods(supabase, companyId)
  const includeDocuments = options.include_documents !== false

  const zip = ArchiveFolder.root()

  if (includeDocuments) {
    await writeDocuments(zip, supabase, companyId, periods, 'unlinked')
  }
  await writeSieSourceFiles(zip, supabase, companyId, includeDocuments)
  await writeMasterData(zip, supabase, companyId)

  const revision = zip.folder('revision')
  const auditEntries = await fetchAllAuditEntries(supabase, companyId, {})
  revision.file('behandlingshistorik.json', JSON.stringify(auditEntries, null, 2))
  const systemDoc = await buildSystemDoc(supabase, companyId, periods, 'all')
  revision.file('systemdokumentation.json', JSON.stringify(systemDoc, null, 2))

  zip.file(
    'LÄSMIG.txt',
    buildDriveFolderReadme({
      companyName: company.company_name || 'Okänt företag',
      orgNumber: company.org_number,
      generatedAt: new Date().toISOString(),
      appName: getBranding().appName,
    })
  )

  return zip
}

/**
 * Estimate the uncompressed size of the archive in bytes.
 *
 * Sums `file_size_bytes` across all documents in scope plus a fixed overhead
 * for SIE, reports, audit trail, and system documentation. Shown before a
 * download, and the cap for callers that hold the whole ZIP in memory (cloud
 * backup, the MCP audit package).
 */
export async function estimateArchiveSize(
  supabase: SupabaseClient,
  companyId: string,
  scope: ArchiveScope,
  periodId?: string
): Promise<{ total_bytes: number; document_bytes: number; document_count: number }> {
  // Scope=all counts every document (linked or not), mirroring writeDocuments.
  let rows: { file_size_bytes: number | null }[]

  if (scope === 'period') {
    if (!periodId) {
      throw new Error('period_id is required for scope=period')
    }
    const periodEntryIds = await fetchAllRows<{ id: string }>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', periodId)
        .in('status', ['posted', 'reversed'])
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to)
    )
    const ids = periodEntryIds.map((e) => e.id)
    if (ids.length === 0) {
      return { total_bytes: ARCHIVE_OVERHEAD_BYTES, document_bytes: 0, document_count: 0 }
    }
    // A busy year holds thousands of entries and can hold more than a page of
    // documents: chunk the IN() list (PostgREST URL limit) and paginate every
    // chunk (PostgREST row cap). One flat IN() + single read undercounts as
    // soon as either limit is hit.
    rows = []
    for (let i = 0; i < ids.length; i += CHILD_FK_CHUNK) {
      const chunk = ids.slice(i, i + CHILD_FK_CHUNK)
      const chunkRows = await fetchAllRows<{ file_size_bytes: number | null }>(({ from, to }) =>
        supabase
          .from('document_attachments')
          .select('id, file_size_bytes')
          .eq('company_id', companyId)
          .in('journal_entry_id', chunk)
          .order('id', { ascending: true })
          .range(from, to)
      )
      rows.push(...chunkRows)
    }
  } else {
    rows = await fetchAllRows<{ file_size_bytes: number | null }>(({ from, to }) =>
      supabase
        .from('document_attachments')
        .select('id, file_size_bytes')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to)
    )
  }

  const documentBytes = rows.reduce((sum, r) => sum + (Number(r.file_size_bytes) || 0), 0)

  return {
    total_bytes: documentBytes + ARCHIVE_OVERHEAD_BYTES,
    document_bytes: documentBytes,
    document_count: rows.length,
  }
}

async function fetchCompany(supabase: SupabaseClient, companyId: string): Promise<CompanyInfo> {
  const { data } = await supabase
    .from('company_settings')
    .select('company_name, org_number, moms_period')
    .eq('company_id', companyId)
    .single()

  if (!data) {
    throw new Error('Company settings not found')
  }
  return data as CompanyInfo
}

async function fetchSinglePeriod(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string
): Promise<FiscalPeriodRow> {
  const { data } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, opening_balance_entry_id')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()

  if (!data) {
    throw new Error('Fiscal period not found')
  }
  return data as FiscalPeriodRow
}

async function fetchAllPeriods(
  supabase: SupabaseClient,
  companyId: string
): Promise<FiscalPeriodRow[]> {
  const rows = await fetchAllRows<FiscalPeriodRow>(({ from, to }) =>
    supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end, opening_balance_entry_id')
      .eq('company_id', companyId)
      .order('period_start', { ascending: true })
      .range(from, to)
  )
  return rows
}

async function generatePeriodReports(
  supabase: SupabaseClient,
  companyId: string,
  period: FiscalPeriodRow
): Promise<PeriodReports> {
  const [trialBalance, incomeStatement, generalLedger, journalRegister] =
    await Promise.all([
      generateTrialBalance(supabase, companyId, period.id, { closingEntry: 'include' }),
      generateIncomeStatement(supabase, companyId, period.id),
      generateGeneralLedger(supabase, companyId, period.id),
      generateJournalRegister(supabase, companyId, period.id),
    ])
  // The balance sheet reads the same 'include' trial balance: built from it.
  const balanceSheet = await balanceSheetFromTrialBalance(supabase, companyId, period.id, trialBalance.rows)

  let vatDeclaration: unknown = null
  try {
    const startDate = new Date(period.period_start)
    // Annual VAT for an archive must cover the whole räkenskapsår, which may be
    // extended/shortened: pass the fiscal period so the span isn't truncated to
    // the calendar year that period_start happens to fall in.
    vatDeclaration = await calculateVatDeclaration(
      supabase,
      companyId,
      'yearly',
      startDate.getFullYear(),
      1,
      { fiscalPeriodId: period.id }
    )
  } catch {
    // VAT declaration may fail if no relevant entries exist, skip gracefully
  }

  return { trialBalance, incomeStatement, balanceSheet, generalLedger, journalRegister, vatDeclaration }
}

function writeReports(folder: ArchiveFolder, reports: PeriodReports): void {
  folder.file('saldobalans.json', JSON.stringify(reports.trialBalance, null, 2))
  folder.file('resultatrakning.json', JSON.stringify(reports.incomeStatement, null, 2))
  folder.file('balansrakning.json', JSON.stringify(reports.balanceSheet, null, 2))
  folder.file('huvudbok.json', JSON.stringify(reports.generalLedger, null, 2))
  folder.file('grundbok.json', JSON.stringify(reports.journalRegister, null, 2))
  if (reports.vatDeclaration) {
    folder.file('momsdeklaration.json', JSON.stringify(reports.vatDeclaration, null, 2))
  }
  // CSV twins for humans: the JSON is complete but unreadable in Excel.
  // Never let a formatting bug take down the archive (the JSON stays
  // canonical), and never let one broken report take down the other CSVs.
  const tryCsv = (file: string, make: () => string) => {
    try {
      folder.file(file, make())
    } catch {
      // Skip this CSV on shape mismatch.
    }
  }
  tryCsv('saldobalans.csv', () => trialBalanceToCsv(reports.trialBalance as TrialBalanceLike))
  tryCsv('resultatrakning.csv', () =>
    incomeStatementToCsv(reports.incomeStatement as IncomeStatementReport)
  )
  tryCsv('balansrakning.csv', () =>
    balanceSheetToCsv(reports.balanceSheet as BalanceSheetReport)
  )
  tryCsv('huvudbok.csv', () => generalLedgerToCsv(reports.generalLedger as GeneralLedgerReport))
}

async function writeDocuments(
  zip: ArchiveFolder,
  supabase: SupabaseClient,
  companyId: string,
  periods: FiscalPeriodRow[],
  scope: DocumentMode
): Promise<void> {
  const dokument = zip.folder('dokument')
  const manifest: DocumentManifestEntry[] = []
  const files: { path: string; read: ArchiveRead }[] = []

  try {
    const documents = await fetchAllRows<DocumentRow>(({ from, to }) => {
      let q = supabase
        .from('document_attachments')
        .select(
          'id, file_name, storage_path, journal_entry_id, sha256_hash, version, digitization_date, upload_source, mime_type, file_size_bytes, journal_entries:journal_entry_id(voucher_number, voucher_series, entry_date)'
        )
        .eq('company_id', companyId)
      // Backups (scope=all/unlinked) include every document, even those not
      // yet linked to an entry: inbox items and unbooked receipts are
      // räkenskapsinformation too. The per-period archive keeps the
      // linked-only filter.
      if (scope === 'period') {
        q = q.not('journal_entry_id', 'is', null)
      }
      // Stable total order for correct paging (see fetch-all.ts).
      return q.order('id', { ascending: true }).range(from, to)
    })

    if (documents.length > 0) {
      const entryIdToPeriodId = await buildEntryToPeriodMap(
        supabase,
        companyId,
        periods,
        scope === 'period' ? 'period' : 'all'
      )

      const inScopeDocuments =
        scope === 'period'
          ? documents.filter((d) => d.journal_entry_id && entryIdToPeriodId.has(d.journal_entry_id))
          : scope === 'unlinked'
            ? // Grunddata mode: only what no period archive carries (orphans
              // and docs linked to draft/unposted entries).
              documents.filter(
                (d) => !d.journal_entry_id || !entryIdToPeriodId.has(d.journal_entry_id)
              )
            : documents // all-mode: keep every doc, linked or not

      // Track used paths so we can disambiguate collisions (two documents with
      // identical voucher prefix + filename) by appending a short id suffix.
      const usedPaths = new Set<string>()

      for (const doc of inScopeDocuments) {
        const fiscalPeriodId = doc.journal_entry_id
          ? entryIdToPeriodId.get(doc.journal_entry_id) ?? null
          : null

        const entryInfo = extractJoinedEntry(doc.journal_entries)
        // A draft (no voucher number yet) is an orphan in the ZIP layout.
        const voucherLabel = entryInfo?.voucher_number ? formatVoucher(entryInfo) : null
        const zipPath = buildDocumentZipPath(doc, voucherLabel, entryInfo?.entry_date ?? null, usedPaths)

        const baseManifest: Omit<DocumentManifestEntry, 'status'> = {
          document_id: doc.id,
          file_name: doc.file_name,
          storage_path: doc.storage_path,
          sha256_hash: doc.sha256_hash,
          journal_entry_id: doc.journal_entry_id,
          fiscal_period_id: fiscalPeriodId,
          version: doc.version,
          digitization_date: doc.digitization_date,
          upload_source: doc.upload_source,
          mime_type: doc.mime_type,
          file_size_bytes: doc.file_size_bytes,
          voucher_number: voucherLabel,
          entry_date: entryInfo?.entry_date ?? null,
          zip_path: zipPath,
        }

        // Entered as downloaded and replaced if the read fails: the manifest
        // is written after every document, so it holds the outcome.
        const index = manifest.push({ ...baseManifest, status: 'downloaded' }) - 1
        files.push({
          // zipPath is fully qualified (`dokument/<year>/<voucher>_<file>` etc.),
          // so it is added at the archive root: `dokument.file(zipPath)`
          // would double-prefix to `dokument/dokument/...`.
          path: zipPath,
          // Dual-layout download: the document batch is snapshotted up
          // front, and a concurrent Phase B backfill can re-home an object
          // (legacy uploader-scoped -> company-scoped) and later remove the
          // source mid-run, leaving the stored pointer stale. The helper
          // tries the stored pointer first, then the alternate layout, so a
          // healthy document never lands in the manifest as an error.
          read: storageRead(
            async () => {
              const { blob, error } = await downloadDocumentObject(supabase, doc.storage_path, companyId)
              return { data: blob, error }
            },
            (error) => { manifest[index] = { ...baseManifest, status: 'error', error } },
          ),
        })
      }
    }
  } catch {
    // Document fetch failed: archive will still contain reports and audit trail
  }

  addStorageFiles(zip, files)
  dokument.file('manifest.json', async () => JSON.stringify(manifest, null, 2))
}

/**
 * The bokslutsbilagor pärm for one period, as JSON and PDF next to the other
 * reports. Archive runs have no acting user, so the checklist's
 * readiness-derived items are left as stored. Best-effort like the reports:
 * a failure is logged into the folder rather than aborting the archive.
 */
/**
 * The systemdokumentation for one räkenskapsår as it stands at archive time,
 * JSON and PDF under revision/systemdokumentation/. Never fails the archive:
 * a failure leaves an .error.txt beside the other files, like the pärm.
 */
async function writeSystemdokumentation(
  revision: ArchiveFolder,
  supabase: SupabaseClient,
  companyId: string,
  period: FiscalPeriodRow
): Promise<void> {
  const base = `systemdokumentation/${periodLabel(period)}`
  try {
    const report = await generateSystemdokumentation(supabase, companyId, period.id, { appVersion: currentAppVersion() })
    if (!report) {
      // The period vanished between enumeration and generation: say so
      // rather than leave the referenced snapshot silently missing.
      revision.file(`${base}.error.txt`, 'Räkenskapsåret hittades inte när arkivet skapades.')
      return
    }
    revision.file(`${base}.json`, JSON.stringify(report, null, 2))
    const [{ SystemdokumentationPDF }, { renderToBuffer }] = await Promise.all([
      import('./systemdokumentation-pdf-template'),
      import('@react-pdf/renderer'),
    ])
    const pdf = await renderToBuffer(SystemdokumentationPDF({ report }))
    revision.file(`${base}.pdf`, new Uint8Array(pdf))
  } catch (err) {
    revision.file(`${base}.error.txt`, err instanceof Error ? err.message : 'Unknown error')
  }
}

async function writeBokslutsbilagor(
  folder: ArchiveFolder,
  supabase: SupabaseClient,
  companyId: string,
  periodId: string
): Promise<void> {
  try {
    const report = await generateBokslutsbilagor(supabase, companyId, periodId, { appVersion: currentAppVersion() })
    if (!report) return
    folder.file('bokslutsbilagor.json', JSON.stringify(report, null, 2))
    // The renderer and the template load on demand: the template registers
    // styles at import time, and this module is imported far more widely
    // than the pärm is rendered (tests stub @react-pdf/renderer partially).
    const [{ BokslutsbilagorPDF }, { renderToBuffer }] = await Promise.all([
      import('./bokslutsbilagor-pdf-template'),
      import('@react-pdf/renderer'),
    ])
    const pdf = await renderToBuffer(BokslutsbilagorPDF({ report }))
    folder.file('bokslutsbilagor.pdf', new Uint8Array(pdf))
  } catch (err) {
    folder.file('bokslutsbilagor.error.txt', err instanceof Error ? err.message : 'Unknown error')
  }
}

interface ReconciliationAttachmentManifestEntry {
  attachment_id: string
  account_key: string
  through_date: string
  file_name: string
  storage_path: string
  sha256: string
  mime_type: string
  size_bytes: number
  note: string | null
  uploaded_at: string
  removed_at: string | null
  removed_reason: string | null
  zip_path: string | null
  status: 'downloaded' | 'removed' | 'error'
  error?: string
}

/**
 * The underlag behind the reconciliation sign-offs (bokslutsbilagor): every
 * file attached to a balansdag inside the archived periods, laid out as
 * `bilagor/<period>/<account_key>/<through_date>_<file>`, plus a manifest
 * with the content hashes. Removed files are listed (with their stamp) but
 * not copied: the manifest is the record that they were attached and then
 * withdrawn. A failed read lands in the manifest rather than aborting the
 * archive, like writeDocuments.
 */
async function writeReconciliationAttachments(
  zip: ArchiveFolder,
  supabase: SupabaseClient,
  companyId: string,
  periods: FiscalPeriodRow[]
): Promise<void> {
  const manifest: ReconciliationAttachmentManifestEntry[] = []
  const files: { path: string; read: ArchiveRead }[] = []
  const usedPaths = new Set<string>()
  const sorted = [...periods].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const from = sorted[0].period_start
  const to = sorted[sorted.length - 1].period_end

  try {
    const rows = await listAttachmentRowsInRange(supabase, companyId, from, to, { includeRemoved: true })
    for (const row of rows) {
      const period = sorted.find((p) => row.through_date >= p.period_start && row.through_date <= p.period_end)
      const base = {
        attachment_id: row.id,
        account_key: row.account_key,
        through_date: row.through_date,
        file_name: row.file_name,
        storage_path: row.storage_path,
        sha256: row.sha256,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        note: row.note,
        uploaded_at: row.uploaded_at,
        removed_at: row.removed_at,
        removed_reason: row.removed_reason,
      }
      if (row.removed_at) {
        manifest.push({ ...base, zip_path: null, status: 'removed' })
        continue
      }
      if (!period) continue
      let zipPath = `bilagor/${periodLabel(period)}/${row.account_key.replace(':', '_')}/${row.through_date}_${row.file_name}`
      if (usedPaths.has(zipPath)) {
        const dot = zipPath.lastIndexOf('.')
        const suffix = `_${row.id.slice(0, 8)}`
        zipPath = dot > zipPath.lastIndexOf('/') ? `${zipPath.slice(0, dot)}${suffix}${zipPath.slice(dot)}` : `${zipPath}${suffix}`
      }
      usedPaths.add(zipPath)
      // Entered as downloaded and replaced if the read fails (writeDocuments).
      const index = manifest.push({ ...base, zip_path: zipPath, status: 'downloaded' }) - 1
      files.push({
        path: zipPath,
        read: storageRead(
          () => supabase.storage.from(row.storage_bucket).download(row.storage_path),
          (error) => { manifest[index] = { ...base, zip_path: null, status: 'error', error } },
        ),
      })
    }
  } catch {
    // Attachment listing failed: the archive still carries everything else.
  }

  addStorageFiles(zip, files)
  zip.folder('bilagor').file('manifest.json', async () => JSON.stringify(manifest, null, 2))
}

/**
 * PostgREST returns a many-to-one embedded resource as either an object or an
 * array depending on schema introspection (FK is unique vs not). Normalize.
 */
function extractJoinedEntry(
  raw: DocumentRow['journal_entries']
): { voucher_number: number | null; voucher_series: string | null; entry_date: string | null } | null {
  if (!raw) return null
  if (Array.isArray(raw)) return raw[0] ?? null
  return raw
}

/**
 * Build the in-ZIP path for a document.
 *
 *   - Linked to a posted entry with a date: `dokument/<year>/<voucher>_<file>`
 *   - Linked to a posted entry without a date (defensive): `dokument/_okant-ar/<voucher>_<file>`
 *   - Orphan (no entry) or draft (no voucher_number): `dokument/_okopplade/<file>`
 *
 * Collisions are resolved by appending `_<short-id>` before the file extension.
 */
function buildDocumentZipPath(
  doc: { id: string; file_name: string },
  voucherLabel: string | null,
  entryDate: string | null,
  usedPaths: Set<string>
): string {
  const safeName = sanitizeFileName(doc.file_name || `${doc.id}.bin`)

  let folder: string
  let prefix: string
  if (voucherLabel) {
    const year = entryDate ? new Date(entryDate).getUTCFullYear() : NaN
    folder = Number.isFinite(year) ? `dokument/${year}` : 'dokument/_okant-ar'
    prefix = `${voucherLabel}_`
  } else {
    folder = 'dokument/_okopplade'
    prefix = ''
  }

  const candidate = `${folder}/${prefix}${safeName}`
  if (!usedPaths.has(candidate)) {
    usedPaths.add(candidate)
    return candidate
  }

  // Collision: disambiguate with a short id suffix before the extension.
  const dotIdx = safeName.lastIndexOf('.')
  const stem = dotIdx > 0 ? safeName.slice(0, dotIdx) : safeName
  const ext = dotIdx > 0 ? safeName.slice(dotIdx) : ''
  const suffix = doc.id.slice(0, 8)
  const disambiguated = `${folder}/${prefix}${stem}_${suffix}${ext}`
  usedPaths.add(disambiguated)
  return disambiguated
}

interface SieImportRow {
  id: string
  user_id: string
  filename: string | null
  file_hash: string | null
  file_storage_path: string | null
  org_number: string | null
  company_name: string | null
  sie_type: number | null
  fiscal_year_start: string | null
  fiscal_year_end: string | null
  accounts_count: number | null
  transactions_count: number | null
  status: string | null
  fiscal_period_id: string | null
  imported_at: string | null
  created_at: string | null
  manifest?: { originalSource?: { format?: string; path?: string; sha256?: string } } | null
}

interface SieSourceManifestEntry {
  import_id: string
  filename: string | null
  storage_path: string | null
  sha256_hash: string | null
  sie_type: number | null
  fiscal_year_start: string | null
  fiscal_year_end: string | null
  imported_at: string | null
  status: 'downloaded' | 'missing' | 'skipped'
  zip_file_name: string | null
  error?: string
}

/**
 * Copy raw imported SIE files from the `sie-files` storage bucket into the
 * archive under `sie/original/`. Preserves the byte-identical source that the
 * user uploaded (vs the `sie/<period>.se` files which Accounted re-generates from
 * the current journal entries).
 *
 * `sie/imports.json` and `sie/account_mappings.json` are written regardless of
 * `includeFiles`: they're small and critical for reconstructing the import
 * history. Blob download is gated behind `includeFiles` since the files can be
 * large and share the documents opt-out.
 */
async function writeSieSourceFiles(
  zip: ArchiveFolder,
  supabase: SupabaseClient,
  companyId: string,
  includeFiles: boolean
): Promise<void> {
  const sieFolder = zip.folder('sie')

  try {
    const imports = await fetchAllRows<SieImportRow>(({ from, to }) =>
      supabase
        .from('sie_imports')
        .select(
          'id, user_id, filename, file_hash, file_storage_path, org_number, company_name, sie_type, fiscal_year_start, fiscal_year_end, accounts_count, transactions_count, status, fiscal_period_id, imported_at, created_at, job_state, manifest, supersedes_import_id, migration_documentation'
        )
        .eq('company_id', companyId)
        .order('created_at', { ascending: true })
        .range(from, to)
    )

    sieFolder.file('imports.json', JSON.stringify(imports, null, 2))

    const manifest: SieSourceManifestEntry[] = []
    const files: { path: string; read: ArchiveRead }[] = []

    if (includeFiles && imports.length > 0) {
      const originalFolder = sieFolder.folder('original')

      for (const imp of imports) {
        const original = imp.manifest?.originalSource
        const storagePath = original?.format === 'original_bytes' ? original.path : imp.file_storage_path
        const sourceHash = original?.format === 'original_bytes' ? original.sha256 : imp.file_hash
        if (!imp.file_storage_path) {
          manifest.push({
            import_id: imp.id,
            filename: imp.filename,
            storage_path: null,
            sha256_hash: sourceHash ?? null,
            sie_type: imp.sie_type,
            fiscal_year_start: imp.fiscal_year_start,
            fiscal_year_end: imp.fiscal_year_end,
            imported_at: imp.imported_at,
            status: 'skipped',
            zip_file_name: null,
            error: 'No storage path on record',
          })
          continue
        }

        const zipFileName = `${imp.id}_${sanitizeFileName(imp.filename || `${imp.id}.se`)}`
        const source = {
          import_id: imp.id,
          filename: imp.filename,
          storage_path: storagePath ?? null,
          sha256_hash: sourceHash ?? null,
          sie_type: imp.sie_type,
          fiscal_year_start: imp.fiscal_year_start,
          fiscal_year_end: imp.fiscal_year_end,
          imported_at: imp.imported_at,
        }
        const missing = (error: string): SieSourceManifestEntry =>
          ({ ...source, status: 'missing', zip_file_name: null, error })

        if (original?.format === 'original_bytes' &&
          (!sourceHash || !/^[a-f0-9]{64}$/.test(sourceHash) ||
            storagePath !== `${companyId}/sie-originals/${sourceHash}.se`)) {
          manifest.push(missing('Invalid original SIE source reference'))
          continue
        }
        // Archive generation uses a service-role client. Both legacy rows
        // and submitted job manifests can contain caller-supplied paths.
        // Accept only the object identities our import writers generate.
        // Before multi-tenancy, the writer used the persisted user id as
        // its prefix. Keep that exact path bound to this retained import id.
        if (original?.format !== 'original_bytes' &&
          storagePath !== `${companyId}/${imp.id}.se` &&
          (!imp.user_id || storagePath !== `${imp.user_id}/${imp.id}.se`) &&
          (!imp.file_hash || !/^[a-f0-9]{64}$/.test(imp.file_hash) ||
            storagePath !== `${companyId}/sie-jobs/${imp.file_hash}.se`)) {
          manifest.push(missing('Invalid SIE source reference'))
          continue
        }

        // Entered as downloaded and replaced if the read fails (writeDocuments).
        const index = manifest.push({ ...source, status: 'downloaded', zip_file_name: zipFileName }) - 1
        files.push({
          path: zipFileName,
          read: storageRead(
            () => supabase.storage.from('sie-files').download(storagePath!),
            (error) => { manifest[index] = missing(error) },
            original?.format === 'original_bytes'
              ? (bytes) => {
                if (createHash('sha256').update(Buffer.from(bytes)).digest('hex') !== sourceHash) {
                  throw new Error('Original SIE source checksum mismatch')
                }
              }
              : undefined,
          ),
        })
      }

      addStorageFiles(originalFolder, files)
      originalFolder.file('manifest.json', async () => JSON.stringify(manifest, null, 2))
    }

    // Paged on a unique order: without one a page boundary can repeat or
    // skip rows past the first 1000 (the #58 class).
    const mappings = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('sie_account_mappings')
        .select('*')
        .eq('company_id', companyId)
        .order('source_account', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    )
    sieFolder.file('account_mappings.json', JSON.stringify(mappings, null, 2))
  } catch {
    // SIE metadata fetch failed: archive will still contain the re-generated SIE files
  }
}

export interface MasterDataTableSpec {
  name: string
  file: string
  orderBy?: string
  /**
   * Unique column used as the paging/dedupe key. Defaults to 'id'; override
   * for tables whose PK has another name (e.g. journal_entry_no_doc_required).
   */
  pageKey?: string
  /**
   * Child tables without a company_id column: rows are fetched by first
   * collecting the parent table's ids for the company, then paging the child
   * table through `fk IN (...)` chunks.
   */
  via?: { parent: string; fk: string }
  /**
   * PostgREST select list for a narrow projection. Defaults to `*`.
   *
   * Only for tables where part of the row is räkenskapsinformation and the
   * rest is workflow state that has no place in a portable archive (see
   * invoice_inbox_items). Must include the page key.
   *
   * Additive only, like `denormalize`: an archive already handed to a revisor
   * must keep every key it shipped with, so append columns and never drop
   * one.
   */
  columns?: string
  /**
   * Parent columns copied onto every child row as `<prefix><column>`.
   *
   * A child line row carries money but no unit: `invoice_items.line_total` is
   * denominated in the parent invoice's currency, and the row's own `unit`
   * column means "st"/"timmar", not the money unit. Parent dumps are fine
   * (`select('*')` carries `currency`, `exchange_rate` and the `*_sek` twins
   * side by side), so this is the only place where a reader of a single file
   * cannot tell SEK from EUR. Denormalising the parent's currency makes each
   * line self-describing instead of requiring a join back to the parent file.
   *
   * Copy the conversion basis (currency + exchange_rate), never the parent's
   * totals: a line's SEK value is not the invoice's `total_sek`. Leave unset
   * when the parent has no currency column (nothing to copy, and inventing
   * one would put a fabricated unit into a statutory archive).
   *
   * Additive only. Archives already handed to a revisor must keep every key
   * they shipped with, so append new keys and never rename or drop one.
   */
  denormalize?: { prefix: string; columns: string[] }
}

/**
 * Tables dumped as JSON under `data/` in the scope='all' backup.
 *
 * This list is a contract enforced by tests/pg/full-archive-coverage.pg.test.ts:
 * every public table with a company_id column must appear here, in
 * ARCHIVE_COVERED_ELSEWHERE_TABLES, or in ARCHIVE_EXCLUDED_TABLES. A migration
 * that adds a company-scoped table fails that test until the table is
 * classified, so the backup can never silently fall behind the schema again.
 */
export const MASTER_DATA_DUMP_TABLES: MasterDataTableSpec[] = [
  { name: 'sie_import_chunks', file: 'sie_import_chunks.json', orderBy: 'created_at' },
  { name: 'sie_duplicate_repair_items', file: 'sie_duplicate_repair_items.json', orderBy: 'created_at' },
  // Counterparties and articles
  { name: 'customers', file: 'customers.json', orderBy: 'created_at' },
  { name: 'suppliers', file: 'suppliers.json', orderBy: 'created_at' },
  // The party layer above customers and suppliers: identities, facts with
  // provenance, payment identities and the human decisions that shaped them.
  { name: 'parties', file: 'parties.json', orderBy: 'created_at' },
  { name: 'party_facts', file: 'party_facts.json', orderBy: 'recorded_at' },
  { name: 'party_identities', file: 'party_identities.json', orderBy: 'created_at' },
  // Bank-side counterpart names, including the person's own corrections.
  { name: 'counterparty_aliases', file: 'counterparty_aliases.json', orderBy: 'created_at' },
  { name: 'party_decisions', file: 'party_decisions.json', orderBy: 'created_at' },
  // Customer merges: which duplicate card was folded into which, by whom,
  // and which invoices moved (crm#1299): the behandlingshistorik of the
  // buyer each issued invoice names.
  { name: 'customer_merges', file: 'customer_merges.json', orderBy: 'created_at' },
  { name: 'articles', file: 'articles.json', orderBy: 'created_at' },
  // Customer invoicing
  { name: 'invoices', file: 'invoices.json', orderBy: 'invoice_date' },
  {
    name: 'invoice_items',
    file: 'invoice_items.json',
    via: { parent: 'invoices', fk: 'invoice_id' },
    denormalize: { prefix: 'invoice_', columns: ['currency', 'exchange_rate'] },
  },
  { name: 'migration_source_records', file: 'migration_source_records.json' },
  { name: 'invoice_payments', file: 'invoice_payments.json', orderBy: 'payment_date' },
  { name: 'invoice_reminders', file: 'invoice_reminders.json' },
  // Delivery metadata proves which recipient received the archived PDF and
  // when, so it is räkenskapsinformation alongside the invoice itself.
  { name: 'invoice_deliveries', file: 'invoice_deliveries.json', orderBy: 'created_at' },
  // The documents emailed with an invoice after its PDF (crm#1269): which
  // archived files the customer received with which invoice.
  { name: 'invoice_attachments', file: 'invoice_attachments.json', orderBy: 'created_at' },
  // Peppol archive evidence is split so the exact staged UBL, every verified
  // asynchronous event, and provider evidence stay independently auditable.
  { name: 'peppol_deliveries', file: 'peppol_deliveries.json', orderBy: 'created_at' },
  { name: 'peppol_delivery_events', file: 'peppol_delivery_events.json', orderBy: 'created_at' },
  {
    name: 'peppol_delivery_evidence',
    file: 'peppol_delivery_evidence.json',
    orderBy: 'created_at',
  },
  // Receiving side: which identifiers the company published, and every
  // inbound e-invoice with the exact received XML (the underlag itself).
  { name: 'peppol_registrations', file: 'peppol_registrations.json', orderBy: 'created_at' },
  {
    name: 'peppol_inbound_documents',
    file: 'peppol_inbound_documents.json',
    orderBy: 'received_at',
  },
  // Invoices sent to the customer's Kivra or Billo mailbox: which recipient
  // received the archived PDF through which provider, and when.
  {
    name: 'digital_mailbox_dispatches',
    file: 'digital_mailbox_dispatches.json',
    orderBy: 'created_at',
  },
  // Autogiro: the agreement, the mandates (customer and payer number, never
  // the payer's account), each debit of an invoice with Bankgirot's outcome,
  // and the files written for and read from Bankgirot (content only where it
  // carries no personal data).
  { name: 'autogiro_settings', file: 'autogiro_settings.json', orderBy: 'created_at', pageKey: 'company_id' },
  { name: 'autogiro_mandates', file: 'autogiro_mandates.json', orderBy: 'created_at' },
  { name: 'autogiro_debits', file: 'autogiro_debits.json', orderBy: 'debit_date' },
  { name: 'autogiro_files', file: 'autogiro_files.json', orderBy: 'created_at' },
  { name: 'recurring_invoice_schedules', file: 'recurring_invoice_schedules.json' },
  // The liquidity forecast's own rows (src/lib/forecast): planning data, never
  // posted, cancelled rows included so what a forecast showed stays readable.
  { name: 'cash_forecast_rows', file: 'cash_forecast_rows.json', orderBy: 'created_at' },
  // Supplier invoicing
  { name: 'supplier_invoices', file: 'supplier_invoices.json', orderBy: 'invoice_date' },
  {
    name: 'supplier_invoice_items',
    file: 'supplier_invoice_items.json',
    via: { parent: 'supplier_invoices', fk: 'supplier_invoice_id' },
    denormalize: { prefix: 'supplier_invoice_', columns: ['currency', 'exchange_rate'] },
  },
  { name: 'supplier_invoice_payments', file: 'supplier_invoice_payments.json' },
  // The attest trail: who approved or rejected each supplier invoice, when, from where and why.
  { name: 'supplier_invoice_attestations', file: 'supplier_invoice_attestations.json', orderBy: 'decided_at' },
  // Payment batches (betalfil): the immutable instruction snapshots a
  // generated bank payment file derives from; underlag for the payments it
  // initiated, so they leave with the archive.
  {
    name: 'supplier_payment_batches',
    file: 'supplier_payment_batches.json',
    orderBy: 'created_at',
  },
  {
    name: 'supplier_payment_batch_items',
    file: 'supplier_payment_batch_items.json',
    orderBy: 'created_at',
  },
  // Bank payments (payment initiation): the instruction a person approved and
  // signed with BankID, what the bank reported about it, and the signing it
  // was part of; underlag for the payments they initiated, like the betalfil.
  { name: 'payment_orders', file: 'payment_orders.json', orderBy: 'created_at' },
  { name: 'payment_order_batches', file: 'payment_order_batches.json', orderBy: 'created_at' },
  { name: 'payment_order_events', file: 'payment_order_events.json', orderBy: 'occurred_at' },
  // Who confirmed or rejected a supplier account an invoice stated, and when:
  // the payment control behind which account a supplier was paid to.
  { name: 'supplier_payee_confirmations', file: 'supplier_payee_confirmations.json', orderBy: 'decided_at' },
  // Underlag intake: the chat answers behind a verifikat.
  //
  // A projection, not the whole table. `channel_context` holds the human
  // answers the WhatsApp bot collected (representation deltagare + syfte +
  // raw_answer), and it is the ONLY complete copy: the verifikat line carries
  // a 220-char render that drops whole names ("… och N till"), and Skatte-
  // verket's dokumentationskrav wants every deltagare. Without this file a
  // company that leaves with its archive keeps an incomplete representation
  // trail. The booking columns come along so each answer can be tied to the
  // verifikat it belongs to.
  //
  // Everything else on the row (email bodies, OCR output, error messages,
  // retry state) is inbox workflow state and stays out; the documents
  // themselves are in dokument/.
  {
    name: 'invoice_inbox_items',
    file: 'invoice_inbox_items.json',
    orderBy: 'created_at',
    columns:
      'id, created_at, source, status, document_id, matched_transaction_id, ' +
      'created_journal_entry_id, created_supplier_invoice_id, channel_context',
  },
  // How each underlag came in (the mail, the chat message, the e-invoice, the
  // upload) and what each delivery produced. The originals' bytes stay in
  // Storage under documents/<company>/arrivals/; the rows say where.
  { name: 'arrivals', file: 'arrivals.json', orderBy: 'received_at' },
  { name: 'arrival_outputs', file: 'arrival_outputs.json', orderBy: 'created_at' },
  // Arkiv: what each archived document is and whether it belongs to the
  // company, the model's reading and every person's decision, oldest first.
  { name: 'document_classifications', file: 'document_classifications.json', orderBy: 'created_at' },
  // Arkiv: the typed record of each document, every version including a
  // person's corrections, and the extraction runs and reviews behind them.
  { name: 'document_extractions', file: 'document_extractions.json', orderBy: 'created_at' },
  { name: 'activities', file: 'activities.json', orderBy: 'started_at' },
  // Arkiv: what each document is tied to, and the agreements with the
  // payments they imply, as derived and as a person or the bank confirmed.
  { name: 'document_links', file: 'document_links.json', orderBy: 'created_at' },
  { name: 'agreements', file: 'agreements.json', orderBy: 'created_at' },
  // Every decision on a bank line or inbox item: the suggestions on offer,
  // the one acted on, what was booked and who decided, oldest first.
  { name: 'suggestion_log', file: 'suggestion_log.json', orderBy: 'created_at' },
  { name: 'agreement_obligations', file: 'agreement_obligations.json', orderBy: 'due_on' },
  // Arkiv: the dated, sourced facts about the company and its agreements,
  // every reading kept (superseded and deprecated rows included).
  { name: 'company_facts', file: 'company_facts.json', orderBy: 'sys_from' },
  // Receipts
  { name: 'receipts', file: 'receipts.json', orderBy: 'receipt_date' },
  // `receipts` has no exchange_rate column, so only the currency is copied:
  // enough to read the unit, which is what the line was missing.
  {
    name: 'receipt_line_items',
    file: 'receipt_line_items.json',
    via: { parent: 'receipts', fk: 'receipt_id' },
    denormalize: { prefix: 'receipt_', columns: ['currency'] },
  },
  // Bank and categorization
  // NOTE: the date column on transactions is `date` (a previous spec said
  // booking_date, which does not exist: every backup got an error stub).
  { name: 'transactions', file: 'transactions.json', orderBy: 'date' },
  // The Bankgirot split of a bank row (payer, OCR, amount per part): the
  // underlag for settling several invoices from one deposit, so it travels
  // with the transactions it explains.
  { name: 'bank_transaction_parts', file: 'bank_transaction_parts.json', orderBy: 'created_at' },
  // Webshop order rows are booking underlag (and carry customer personal
  // data), so they belong in the archive like transactions do.
  { name: 'webshop_orders', file: 'webshop_orders.json', orderBy: 'order_date' },
  // A point-of-sale day is the basis of its daily takings voucher: the day
  // model and the provider's answer verbatim (BFL 7 kap) belong in the archive.
  { name: 'pos_sales_days', file: 'pos_sales_days.json', orderBy: 'business_date' },
  // Kundorder: non-ledger sales documents. Not räkenskapsinformation on
  // their own, but the provenance of invoices created from them
  // (invoices.sales_order_id / invoice_items.sales_order_item_id) points
  // here, so a revisor reading the archive can follow the link.
  { name: 'sales_orders', file: 'sales_orders.json', orderBy: 'order_date' },
  // Direct dump (the coverage contract requires it for a table with its own
  // company_id); the line's currency is the parent order's, one file over,
  // joined by sales_order_id.
  { name: 'sales_order_items', file: 'sales_order_items.json', orderBy: 'created_at' },
  { name: 'webshop_store_settings', file: 'webshop_store_settings.json' },
  { name: 'transaction_voucher_links', file: 'transaction_voucher_links.json' },
  { name: 'bank_file_imports', file: 'bank_file_imports.json', orderBy: 'created_at' },
  // Customer/supplier/article imports and their undo: what each import
  // created and the field values it overwrote. Customers carry no per-row
  // audit trigger, so this is the only record of what an import changed on
  // a counterparty's details; it travels with the registers it describes.
  { name: 'register_import_runs', file: 'register_import_runs.json', orderBy: 'created_at' },
  { name: 'cash_accounts', file: 'cash_accounts.json' },
  // Which bank account customer invoices pay to, per currency; the payee
  // fields themselves are columns on cash_accounts one file up.
  { name: 'invoice_payee_defaults', file: 'invoice_payee_defaults.json' },
  // Collections through a provider the company activated: the rules applied
  // when invoices are handed over and when collected payments and payouts
  // are booked (behandlingsregler, audited in behandlingshistorik), and the
  // connection's own state trail.
  { name: 'collection_connections', file: 'collection_connections.json', orderBy: 'created_at' },
  { name: 'collection_connection_events', file: 'collection_connection_events.json', orderBy: 'created_at' },
  // The invoices handed over to that provider and each case's trail: what was
  // demanded of which customer, when, and on whose decision.
  { name: 'collection_cases', file: 'collection_cases.json', orderBy: 'created_at' },
  { name: 'collection_case_events', file: 'collection_case_events.json', orderBy: 'created_at' },
  // Every payment and credit note reported to that provider for a case, and
  // whether it was dropped again.
  { name: 'collection_payment_forwards', file: 'collection_payment_forwards.json', orderBy: 'created_at' },
  // Bank rows that may have paid an invoice under collection, and the
  // automatic pause and the answer to each.
  { name: 'collection_sweep_hits', file: 'collection_sweep_hits.json', orderBy: 'created_at' },
  // Payments the debtor made to that provider, the provider's payouts with
  // each line, and how each was booked (steps C and D).
  { name: 'collection_collected_payments', file: 'collection_collected_payments.json', orderBy: 'created_at' },
  { name: 'collection_settlements', file: 'collection_settlements.json', orderBy: 'created_at' },
  { name: 'collection_settlement_lines', file: 'collection_settlement_lines.json', orderBy: 'created_at' },
  // Kundförlust decisions: why a receivable was reserved, written off or
  // recovered, on whose decision and with which evidence (BFL 5 kap 6 §).
  { name: 'invoice_write_offs', file: 'invoice_write_offs.json', orderBy: 'decided_at' },
  // Kvittningar: which customer invoice was set off against which supplier
  // invoice of the same counterparty, for how much, by whom, and whether the
  // set-off was reversed (BFL 5 kap 7 §).
  { name: 'counterparty_setoffs', file: 'counterparty_setoffs.json', orderBy: 'created_at' },
  { name: 'mapping_rules', file: 'mapping_rules.json' },
  { name: 'categorization_templates', file: 'categorization_templates.json' },
  { name: 'booking_template_library', file: 'booking_template_library.json' },
  { name: 'skattekonto_rules', file: 'skattekonto_rules.json' },
  // Rules for automatic booking (grants): every version with what it
  // permitted, who accepted it and when it was revoked, and which postings
  // each rule let through without a person (BFNAR 2013:2 p. 9.16).
  { name: 'company_grants', file: 'company_grants.json', orderBy: 'created_at' },
  { name: 'company_grant_uses', file: 'company_grant_uses.json', orderBy: 'created_at' },
  // Salary (räkenskapsinformation with 7-year retention)
  { name: 'employees', file: 'employees.json', orderBy: 'created_at' },
  { name: 'employee_benefits', file: 'employee_benefits.json', orderBy: 'created_at' },
  { name: 'employee_recurring_lines', file: 'employee_recurring_lines.json', orderBy: 'created_at' },
  { name: 'salary_runs', file: 'salary_runs.json', orderBy: 'created_at' },
  { name: 'salary_run_employees', file: 'salary_run_employees.json', orderBy: 'created_at' },
  { name: 'salary_line_items', file: 'salary_line_items.json', orderBy: 'created_at' },
  { name: 'salary_absence_days', file: 'salary_absence_days.json' },
  // Cutover state (payroll gap-closure 2.1): part of the payroll underlag a
  // switching company brings; belongs in the archive like the run data it
  // seeds.
  { name: 'employee_opening_balances', file: 'employee_opening_balances.json' },
  // Vacation ledger + year closures (payroll gap-closure 3.1). The closure
  // report is the underlag for the drift-adjustment verifikation (BFL 7 kap).
  { name: 'employee_vacation_balances', file: 'employee_vacation_balances.json' },
  { name: 'vacation_year_closures', file: 'vacation_year_closures.json' },
  // The frozen calculation behind each semesterlöneskuld remeasurement
  // verifikat (salary_vacation_liability_method 'remeasure'): its underlag.
  { name: 'vacation_liability_remeasurements', file: 'vacation_liability_remeasurements.json' },
  { name: 'salary_worked_days', file: 'salary_worked_days.json' },
  { name: 'salary_payslip_links', file: 'salary_payslip_links.json' },
  // Archived bank payment files (pain.001 / Bankgirot LB) exactly as handed
  // to the bank: underlag for the salary payments, BFL 7 kap. 1 §.
  { name: 'salary_payment_files', file: 'salary_payment_files.json', orderBy: 'generated_at' },
  { name: 'shift_premium_rules', file: 'shift_premium_rules.json' },
  { name: 'agi_declarations', file: 'agi_declarations.json', orderBy: 'created_at' },
  // Every AGI kvittens as received, an original's beside its correction's:
  // the filing receipts, kept as received (BFL 7 kap. 1 §).
  { name: 'agi_kvittenser', file: 'agi_kvittenser.json', orderBy: 'recorded_at' },
  // Körjournal: trip log underlag for milersättning verifikat (BFL 7-year
  // retention per Skatteverket's körjournal documentation requirement).
  { name: 'mileage_trips', file: 'mileage_trips.json', orderBy: 'trip_date' },
  { name: 'expense_claims', file: 'expense_claims.json', orderBy: 'expense_date' },
  { name: 'expense_payout_batches', file: 'expense_payout_batches.json', orderBy: 'payout_date' },
  // Assets and accruals
  { name: 'assets', file: 'assets.json', orderBy: 'created_at' },
  { name: 'depreciation_schedules', file: 'depreciation_schedules.json', orderBy: 'created_at' },
  // K3 components and what each was charged in a posted avskrivning: the
  // per-component register BFNAR 2013:2 punkt 4.8 presumes.
  { name: 'asset_components', file: 'asset_components.json', orderBy: 'created_at' },
  { name: 'depreciation_schedule_components', file: 'depreciation_schedule_components.json', orderBy: 'created_at' },
  // Nedskrivningar and their reversals (ÅRL 4:5, K3 27), with the
  // recoverable amount and the assessment each rests on.
  { name: 'asset_value_adjustments', file: 'asset_value_adjustments.json', orderBy: 'created_at' },
  // Uppskjuten skatt (K3 kap. 29): the inputs of each year and the
  // temporary differences each posted voucher was computed from.
  { name: 'deferred_tax_assessments', file: 'deferred_tax_assessments.json', orderBy: 'created_at' },
  { name: 'deferred_tax_items', file: 'deferred_tax_items.json', orderBy: 'created_at' },
  // The transition to K3 (kap. 35): the first K3 year, the relief rules and
  // changed principles the notes state, the opening deferred tax, and the
  // assets split on components at the transition (35.18).
  { name: 'k3_transitions', file: 'k3_transitions.json', orderBy: 'created_at' },
  { name: 'asset_transition_splits', file: 'asset_transition_splits.json', orderBy: 'created_at', pageKey: 'asset_id' },
  // Finansiella leasingavtal (K3 kapitel 20): the terms each start and
  // year-end verifikat was computed from, and which years are booked:
  // underlag for those verifikat (BFL 7 kap. 1 §).
  { name: 'finance_leases', file: 'finance_leases.json', orderBy: 'created_at' },
  { name: 'finance_lease_postings', file: 'finance_lease_postings.json', orderBy: 'created_at' },
  // Bolaget: the meetings with their minutes (ABL 7:49, 8:26 "förvaras på ett
  // betryggande sätt") and each decision with its terms. Names only.
  { name: 'corporate_meetings', file: 'corporate_meetings.json', orderBy: 'created_at' },
  { name: 'corporate_decisions', file: 'corporate_decisions.json', orderBy: 'created_at' },
  // Bolaget: the aktiebok (kept ten years after dissolution, ABL 5:3), its
  // classes and settings, the roles over time, the firmateckning and the
  // LRVH 2:1 assessments. Names and masked identities only; the
  // personnummer stay in party_person_private (excluded below).
  { name: 'share_register_settings', file: 'share_register_settings.json', orderBy: 'created_at' },
  { name: 'share_classes', file: 'share_classes.json', orderBy: 'created_at' },
  { name: 'share_register_events', file: 'share_register_events.json', orderBy: 'created_at' },
  { name: 'company_roles', file: 'company_roles.json', orderBy: 'created_at' },
  { name: 'company_signatory_rules', file: 'company_signatory_rules.json', orderBy: 'created_at' },
  { name: 'beneficial_owner_assessments', file: 'beneficial_owner_assessments.json', orderBy: 'created_at' },
  // Bolaget capital events: the dividend decisions with each holder's part
  // (the KU31 rests on them), the KU31 answers and field 570 numbers, the
  // aktieägartillskott and the changes of aktiekapital. Each points at the
  // verifikat it posted. No personnummer is held in any of them.
  { name: 'dividends', file: 'dividends.json', orderBy: 'created_at' },
  { name: 'dividend_distributions', file: 'dividend_distributions.json', orderBy: 'created_at' },
  { name: 'ku31_filings', file: 'ku31_filings.json', orderBy: 'created_at' },
  { name: 'ku31_specification_numbers', file: 'ku31_specification_numbers.json', orderBy: 'created_at' },
  { name: 'shareholder_contributions', file: 'shareholder_contributions.json', orderBy: 'created_at' },
  { name: 'capital_changes', file: 'capital_changes.json', orderBy: 'created_at' },
  // Bolaget owner tax: what each delägare entered for their K10 underlag,
  // the owner loan register (the ABL 21:10 special list is kept ten years),
  // the interest per year and the KU20 field 570 numbers. No personnummer
  // is held in any of them.
  { name: 'k10_owner_inputs', file: 'k10_owner_inputs.json', orderBy: 'created_at' },
  { name: 'owner_loans', file: 'owner_loans.json', orderBy: 'created_at' },
  { name: 'owner_loan_interest', file: 'owner_loan_interest.json', orderBy: 'created_at' },
  { name: 'ku20_specification_numbers', file: 'ku20_specification_numbers.json', orderBy: 'created_at' },
  // Ställda säkerheter and eventualförpliktelser, and the group structure
  // (Avtal och åtaganden): what the årsredovisning notes (ÅRL 5 kap. 14-16 §§)
  // and the koncernförhållanden note were written from.
  { name: 'securities_and_contingencies', file: 'securities_and_contingencies.json', orderBy: 'created_at' },
  { name: 'company_group_links', file: 'company_group_links.json', orderBy: 'created_at' },
  // Year-end stock counts (LIV 1955:257): the inventeringslista, its rows and
  // its signature; underlag for the lagerförändring verifikat (BFL 7 kap. 1 §).
  { name: 'inventory_counts', file: 'inventory_counts.json', orderBy: 'created_at' },
  { name: 'inventory_count_rows', file: 'inventory_count_rows.json', orderBy: 'created_at' },
  { name: 'accrual_schedules', file: 'accrual_schedules.json', orderBy: 'created_at' },
  { name: 'accrual_schedule_installments', file: 'accrual_schedule_installments.json', orderBy: 'created_at' },
  // Dimensions
  { name: 'dimensions', file: 'dimensions.json', orderBy: 'created_at' },
  { name: 'dimension_values', file: 'dimension_values.json', orderBy: 'created_at' },
  { name: 'account_dimension_rules', file: 'account_dimension_rules.json' },
  // Budgets (accounted#134): planning data, not räkenskapsinformation, kept
  // in the backup because it is the company's own data.
  { name: 'budgets', file: 'budgets.json', orderBy: 'created_at' },
  { name: 'budget_lines', file: 'budget_lines.json', orderBy: 'created_at' },
  // Compliance records
  { name: 'voucher_gap_explanations', file: 'voucher_gap_explanations.json', orderBy: 'created_at' },
  // Inline rättelse trail (BFL 5 kap 5 § / 9 §): holds the struck original
  // lines and the old description/date, i.e. the preserved side of every
  // in-verifikat rättelse — räkenskapsinformation, not an operation log.
  { name: 'journal_entry_rattelse_log', file: 'journal_entry_rattelse_log.json', orderBy: 'created_at' },
  // Posting port (src/lib/posting): what each posting meant in business
  // terms, the rule version that produced its lines, and which verifikat it
  // produced. Append-only and kept with the verifikat it explains.
  { name: 'business_events', file: 'business_events.json', orderBy: 'created_at' },
  { name: 'business_event_entries', file: 'business_event_entries.json', orderBy: 'created_at' },
  // Reconciliation sign-offs ("avstämt t.o.m."): who attested which account
  // through which date with the numbers as they stood, plus reopen stamps.
  // Part of the avstämningsdokumentation an auditor asks for; kept.
  { name: 'account_reconciliations', file: 'account_reconciliations.json', orderBy: 'signed_at' },
  // Reviews of momsdeklaration warnings: who accepted which WARNING for which
  // VAT period, with the fingerprint of the figures and the note. Part of the
  // record of how the declaration was checked, so it is kept (crm#1171).
  { name: 'vat_check_reviews', file: 'vat_check_reviews.json', orderBy: 'created_at' },
  // Verifikat settled against each other in a reconciliation (a wrong
  // verifikat and the rättelse booked by hand): which, by whom, when, and the
  // undo stamps. The reason those verifikat are not open items; kept with the
  // sign-offs they explain.
  {
    name: 'account_reconciliation_settlements',
    file: 'account_reconciliation_settlements.json',
    orderBy: 'settled_at',
  },
  // The bokslut checklist per räkenskapsår (which closing steps were done,
  // by whom, when): the konsult's documented bokslutsarbete (Reko 760); kept.
  { name: 'bokslut_checklist_items', file: 'bokslut_checklist_items.json', orderBy: 'updated_at', pageKey: 'item_key' },
  // Pågående arbeten (K3 kapitel 23): the method and adjustment account, the
  // uppdrag as stated today, and per posted year_end verifikat what it was
  // computed from (each uppdrag's figures for that balansdag, the positions
  // and the targets): underlag for that verifikat (BFL 7 kap. 1 §).
  { name: 'contract_revenue_settings', file: 'contract_revenue_settings.json', orderBy: 'created_at' },
  { name: 'contract_revenue_contracts', file: 'contract_revenue_contracts.json', orderBy: 'created_at' },
  { name: 'contract_revenue_bookings', file: 'contract_revenue_bookings.json', orderBy: 'created_at' },
  { name: 'journal_entry_no_doc_required', file: 'journal_entry_no_doc_required.json', pageKey: 'journal_entry_id' },
  { name: 'rot_rut_payout_requests', file: 'rot_rut_payout_requests.json', orderBy: 'created_at' },
  // No `denormalize`: rot_rut_payout_requests has no currency column either.
  // A HUS-avdrag claim to Skatteverket is SEK by statute, so there is no unit
  // to copy down and asserting one here would fabricate it.
  { name: 'rot_rut_payout_request_items', file: 'rot_rut_payout_request_items.json', via: { parent: 'rot_rut_payout_requests', fk: 'request_id' } },
  { name: 'fiscal_period_tax_adjustments', file: 'fiscal_period_tax_adjustments.json', orderBy: 'created_at' },
  // What an ideell förening entered for its INK3 underlag per räkenskapsår:
  // the allmännyttig statement, the exempt/taxable/shared treatment per
  // account and the ruta overrides. The bridge from the books to the return.
  { name: 'ink3_underlag_inputs', file: 'ink3_underlag_inputs.json', orderBy: 'created_at' },
  // The underskottsregister (IL 40 kap.): per räkenskapsår the deficit
  // brought forward (INK2S 4.14 a), the spärrar and the deficit carried
  // forward, with the ownership change behind a spärr. No personal data.
  { name: 'tax_loss_carryforwards', file: 'tax_loss_carryforwards.json', orderBy: 'created_at' },
  { name: 'tax_assessment_notices', file: 'tax_assessment_notices.json', orderBy: 'created_at' },
  { name: 'arsredovisning_narratives', file: 'arsredovisning_narratives.json' },
  { name: 'annual_report_profiles', file: 'annual_report_profiles.json', orderBy: 'created_at' },
  // The K2/K3 framework each räkenskapsår was prepared under, with who chose it
  // and, for a switch from K3 to K2, the stated reasons (BFNAR 2012:4).
  { name: 'fiscal_period_frameworks', file: 'fiscal_period_frameworks.json', orderBy: 'created_at' },
  { name: 'annual_report_versions', file: 'annual_report_versions.json', orderBy: 'created_at' },
  { name: 'annual_report_validation_runs', file: 'annual_report_validation_runs.json', orderBy: 'created_at' },
  { name: 'arsredovisning_signature_requests', file: 'arsredovisning_signature_requests.json', orderBy: 'created_at' },
  // BankID signing (lib/signing): which document was sent for signing, to
  // whom, and who signed when with which BankID name. The signed copy and the
  // evidence package (the signatures themselves) are archive documents and
  // export with the documents. The signer projection leaves out the link's
  // token hash and the live BankID session.
  { name: 'signing_requests', file: 'signing_requests.json', orderBy: 'created_at' },
  {
    name: 'signing_request_signers',
    file: 'signing_request_signers.json',
    orderBy: 'created_at',
    columns:
      'id, company_id, signing_request_id, position, name, email, role_label, user_id, lock_kind, annual_report_signature_id, link_sent_at, last_reminded_at, status, signed_at, bankid_given_name, bankid_surname, user_visible_data, declined_at, decline_reason, created_at, updated_at',
  },
  { name: 'arsredovisning_submissions', file: 'arsredovisning_submissions.json' },
  // The förenklat årsbokslut's own inputs per räkenskapsår (BFNAR 2010:1):
  // the eligibility confirmation with who and when, tilläggsupplysningar and
  // signatories. Part of the årsbokslut kept with the books (BFL 7 kap. 2 §).
  { name: 'forenklat_arsbokslut_inputs', file: 'forenklat_arsbokslut_inputs.json', orderBy: 'created_at' },
  // Which four verifikat are the kontantmetod year-end cut-off, and which two
  // of them are the vändningar a momsdeklaration leaves out (20260914150109).
  // Dumped rather than treated as covered by the verifikat themselves: that
  // classification used to be readable off the Swedish description, and the
  // whole point of the marker table is that it no longer has to be.
  {
    name: 'kontantmetod_cutoff_entries',
    file: 'kontantmetod_cutoff_entries.json',
    orderBy: 'created_at',
  },
  // Settings
  { name: 'company_settings', file: 'company_settings.json' },
  // The attest policy the trail above was decided under.
  { name: 'company_attest_policies', file: 'company_attest_policies.json', pageKey: 'company_id' },
  // The attesters' limits under that policy (20261030140000): how much one
  // approval covered. The trail keeps each approval's own snapshot too.
  { name: 'company_attest_limits', file: 'company_attest_limits.json', orderBy: 'created_at' },
  // Hard blocks (20261031150000): every dated version of what was never
  // booked without a person's review, and the review stamps that let such a
  // booking through (who reviewed which verifikat, on what amount and limit).
  { name: 'booking_review_rules', file: 'booking_review_rules.json', orderBy: 'created_at' },
  { name: 'booking_review_stamps', file: 'booking_review_stamps.json', orderBy: 'reviewed_at', pageKey: 'journal_entry_id' },
]

/**
 * Company-scoped tables whose content reaches the archive through another
 * section, so they are deliberately not part of the `data/` dump.
 */
export const ARCHIVE_COVERED_ELSEWHERE_TABLES: Record<string, string> = {
  journal_entries: 'sie/<period>.se + rapporter/<period>/grundbok.json',
  fiscal_periods: 'revision/systemdokumentation.json + SIE #RAR',
  chart_of_accounts: 'revision/systemdokumentation.json (kontoplan)',
  voucher_sequences: 'revision/systemdokumentation.json (verifikationsserier)',
  audit_log: 'revision/behandlingshistorik.json',
  document_attachments: 'dokument/ + dokument/manifest.json',
  account_reconciliation_attachments: 'bilagor/ + bilagor/manifest.json',
  sie_imports: 'sie/imports.json + sie/original/',
  sie_account_mappings: 'sie/account_mappings.json',
  company_grant_settings: 'revision/behandlingshistorik.json (every pause and resumption of the rules for automatic booking, dated)',
}

/**
 * Company-scoped tables deliberately kept out of the archive, with the reason.
 * Platform state, secrets, telemetry and re-fetchable mirrors do not belong in
 * a portable räkenskapsinformation backup.
 */
export const ARCHIVE_EXCLUDED_TABLES: Record<string, string> = {
  ledger_account_days: 'sums of the journal per account and day, derived by triggers and rebuilt from it; the journal itself is exported',
  ledger_dimension_days: 'the same sums per dimension value, derived from the journal lines exported here',
  ledger_account_days_companies: 'which companies the derived ledger sums are built for; no accounting content',
  ledger_account_entries: 'which verifikat have lines on which account, derived by triggers from the journal exported here',
  ledger_dimension_entries: 'the same per dimension value, derived from the journal lines exported here',
  ledger_tagset_days: 'the same sums per account, day and the lines\' whole dimension tag set, derived by triggers from the journal lines exported here',
  ledger_tagset_days_companies: 'which companies the tag set sums are built for; no accounting content',
  bokio_supplier_completion_work: 'opt-in provider recovery scheduling and leases; no accounting content',
  bokio_supplier_completion_entries: 'retry receipts; completed invoices, source identities and processing history are exported separately',
  invoice_completion_work: 'provider scan cursors and scheduling leases; no accounting content',
  invoice_completion_entries: 're-fetchable matching evidence and retry receipts; completed invoices and processing history are exported separately',
  sie_period_read_leases: 'short-lived coordination leases; no accounting content',
  fortnox_terms_backfill_progress: 'one-off backfill cursor and the ids of customer and supplier cards it changed; the cards themselves are exported',
  register_repair_progress: 'one-off repair cursor and what it changed on customer and supplier cards; the cards themselves are exported',
  // Operator-side Peppol access grant and sending cap: platform configuration, not the company's räkenskapsinformation.
  peppol_access: 'platform access grant (status, sending cap); no bookkeeping content',
  peppol_alerts: 'which Peppol problems the health check already mailed about (dedupe claims); the deliveries and inbound documents themselves are exported',
  agent_conversations: 'AI assistant state, not räkenskapsinformation',
  agent_memory: 'AI assistant state, not räkenskapsinformation',
  agent_profiles: 'AI assistant state, not räkenskapsinformation',
  company_skills: 'Company/team AI instructions; proposal provenance is retained in pending_operations and audit_log',
  company_agent_knowledge: 'which knowledge packs each AI agent carries for the company; configuration, not räkenskapsinformation',
  community_feedback: 'upvotes on shared community agent instructions; not räkenskapsinformation',
  api_keys: 'secrets',
  api_key_companies: 'per-key company allowlist (API access control), not räkenskapsinformation',
  permission_shadow_log: 'where a permission check run in shadow mode disagreed with the live one (ids and codes, kept 7 days); diagnostics, not räkenskapsinformation',
  service_accounts:
    'non-human principals and their sponsors (API access control), not räkenskapsinformation; their creation and revocation are in audit_log and every write names the account by label',
  bank_connect_invites: 'signatory link tokens (secrets, hashed) for a bank consent; expire in 7 days, not räkenskapsinformation',
  supplier_invoice_attest_links: 'attest mail link tokens (secrets, hashed) for one attester and one invoice; expire in 7 days, not räkenskapsinformation (every decision made through them is exported in supplier_invoice_attestations)',
  supplier_invoice_attest_batches: 'batched attest mail link tokens (secrets, hashed) for one attester and the invoices one mail listed; expire in 7 days, not räkenskapsinformation (every decision made through them is exported in supplier_invoice_attestations)',
  supplier_invoice_attest_mail_state: 'which attest mails (request, reminders, notices) have gone out for an invoice, so each goes once; mail bookkeeping, not räkenskapsinformation (the decisions are exported in supplier_invoice_attestations)',
  party_person_private: 'the personnummer (ciphertext and keyed HMAC) and postal address of the people in the aktiebok and the roles; personal data, never exported as a table (an owner or admin prints them in the aktiebok PDF)',
  signing_signer_private: 'per signer the personnummer lock (hash and ciphertext) and the BankID signature with the full personnummer; operational personal data, never exported as a table (the signatures are in each completed request\'s evidence package, an archive document)',
  payment_signing_links: 'signing link tokens (secrets, hashed) for a basket of bank payments; expire in 72 hours, not räkenskapsinformation (the payment orders and their events, who approved and who signed, are exported)',
  bank_connections: 'PSD2 connection state and tokens, not portable',
  bank_connection_psus: 'the personnummer (encrypted) a bank consent was created with, kept only to send it again on later calls to that consent; operational personal data, never exported, not räkenskapsinformation',
  payment_batch_psus: 'the personnummer (encrypted) a signing\'s bank payments were created with, and the IP address the signing was started from (cleared once none of its payments is at the bank), kept only to send them again on their status reads and cancels; operational personal data, never exported, not räkenskapsinformation (the payment orders and their events are exported)',
  company_payment_verifications: 'the payment provider\'s KYC status of the company as last read plus a 24-hour form link (sensitive); re-readable from the provider, not räkenskapsinformation',
  company_bank_payment_allowances: 'platform configuration: how many bank payments a month the company may send through the payment provider; not räkenskapsinformation (the payment orders and their events are exported)',
  bank_payment_allowance_requests: 'support requests for more included bank payments a month; platform correspondence, not räkenskapsinformation',
  bolagsverket_avtal_acceptances: 'service agreement acceptance state',
  bolagsverket_subscriptions: 'integration subscription state',
  booking_template_hidden: 'per-company UI preference (hidden system templates); no bookkeeping content',
  booking_template_usage: 'usage telemetry',
  calendar_feeds: 'feed tokens (secrets)',
  capability_grants: 'entitlement state',
  categorize_calibration_samples: 'anonymous auto-booking confidence telemetry; no company_id since 20260922173222, so nothing company-scoped to archive',
  transaction_assistant_reads: "the assistant's proposal for an unbooked transaction, recomputed on demand; no bookkeeping content",
  chat_messages: 'AI assistant state, not räkenskapsinformation',
  chat_sessions: 'AI assistant state, not räkenskapsinformation',
  company_capability_config: 'entitlement state',
  legal_acceptances:
    "which person accepted which version of Accounted's terms and DPA, the provider relationship rather than räkenskapsinformation; company_id is context only",
  company_suggestions:
    'which suggestions are open, snoozed or declined; the proposals and decisions are pending_operations rows and every package switch an audit_log row',
  company_inbound_domains: 'inbound-mail infrastructure',
  company_inboxes: 'inbound-mail infrastructure',
  company_sending_domains: 'outbound-mail infrastructure (sender domain verification state)',
  company_invitations: 'membership state, meaningless outside the platform',
  company_members: 'membership state, meaningless outside the platform',
  company_subscriptions: 'billing state',
  usage_statements: "billing state: Accounted's monthly usage statements and invoice ids, not räkenskapsinformation (the usage itself is in the exported payment orders, deliveries and signings)",
  usage_consents: 'billing state: the charge for use above what the plan includes, opened for the company, by whom and at what price; not räkenskapsinformation',
  usage_requests: 'support requests for more of a priced service than the month includes; platform correspondence, not räkenskapsinformation',
  deadlines: 'regenerable operational calendar state',
  dimension_retag_log: 'operation log',
  // Page text Arkiv reads out of each archived document (text layer or model
  // transcription). Derived from the originals that ship under dokument/ and
  // re-readable from them, so it is not räkenskapsinformation of its own.
  document_pages: 'page text derived from the originals in dokument/; re-readable',
  document_jobs: 'pipeline queue state (read, classify and extract jobs); no bookkeeping content',
  arkiv_findings: 'nightly lint findings, recomputed from the archive and the settings; no bookkeeping content',
  arkiv_autonomy: 'audit tallies per document type, recomputed nightly from activities',
  arkiv_graph_snapshots: 'the last build of the company graph, recomputed from the ledger, the agreements, the documents and the facts; no content of its own',
  arkiv_usage_daily: 'daily counts of what the pipeline read and answered for the company; operational, not räkenskapsinformation',
  ai_usage_events: 'token counts per model call, kept internally to see what AI costs; operational, not räkenskapsinformation',
  // Verification metadata ABOUT räkenskapsinformation, not räkenskapsinformation
  // itself: one row per nightly SHA-256 recompute of an archived document
  // (migration 20260901130000). The documents ship under dokument/ with their
  // upload-time hash in dokument/manifest.json, so a recipient can re-verify
  // every file from the archive alone, without our check log. The checks that
  // do carry legal weight are the failures, and those are already written to
  // audit_log as INTEGRITY_FAILURE and exported in
  // revision/behandlingshistorik.json; a passing check is evidence that our
  // cron ran, which belongs to the platform and not to the company's books.
  // Erasure needs nothing either: the ledger holds no personal data of its own
  // (company_id, document_id, hashes, storage key), it inherits
  // document_attachments' posture on the user id embedded in a legacy storage
  // key, and its rows go with the ON DELETE CASCADE from companies and
  // document_attachments when the underlying data is legally removed.
  document_integrity_checks:
    'WORM verification log (SHA-256 recompute outcomes); failures reach the archive via audit_log in revision/behandlingshistorik.json',
  email_change_requests:
    'per-user in-flight login-email change claim (migration 20260903083000); gates token re-issue, not räkenskapsinformation',
  event_log: '30-day TTL event bus log',
  agent_telemetry_daily: 'anonymous daily counts of agent telemetry across all companies; no company_id, so nothing company-scoped to archive',
  agent_tool_transitions_daily: 'anonymous daily counts of which MCP tool followed which across all companies; no company_id, so nothing company-scoped to archive',
  agent_telemetry_rollup_days: 'which days the agent telemetry rollup has counted; platform bookkeeping, no company data',
  event_outbox:
    'event delivery queue (raw internal event payloads, pruned after 7 days; event_deliveries has no company_id), not räkenskapsinformation',
  extension_data: 'extension runtime state (includes this backup\'s own state)',
  idempotency_keys: 'infrastructure',
  sandbox_seed_attempts: 'infrastructure: disposable demo seed coordination, no accounting records',
  inbox_rate_counters: 'infrastructure',
  mail_connections:
    'mailbox OAuth grants (live refresh tokens), not portable. The receipts they find are archived as documents.',
  digital_mailbox_connections:
    'Kivra and Billo connection state (provider keys, sync cursor, sender switch); the documents read from the mailbox are archived as arrivals',
  migration_jobs: 'provider worker leases and cursors tied to nonportable provider consents',
  migration_job_chunks: 'encrypted provider replay snapshots and worker receipts; imported documents are archived in their registers',
  mcp_tasks: 'MCP task handles: transient tool-call state with a 1-hour TTL',
  notice_dismissals: 'per-user UI notice dismissal state, not räkenskapsinformation',
  company_portals:
    'links to the pages where suppliers keep their invoices (Inkorg navigation, never credentials); the invoices fetched from them are archived as documents',
  oauth_flows:
    'in-flight browser OAuth flow state (migration 20260907120000): state, origin, encrypted PKCE verifier and handoff; consumed by the callback, not räkenskapsinformation',
  notification_log: 'notification dedup log',
  bank_switch_notifications: 'send log of the bank switch campaign mails (announcement, reminders, byrå nudge), not räkenskapsinformation',
  operations: 'staged-operation workflow state',
  payment_match_log: 'derived matching log',
  pending_operations: 'staged-operation workflow state',
  collection_batch_removals:
    'staged-operation workflow state: items taken out of a pending collections batch; each removal is in audit_log, and what was sent is in collection_cases',
  processing_history: 'internal processing log; behandlingshistorik exports from audit_log',
  provider_consents: 'consent tokens, not portable',
  salary_payslip_deliveries: 'delivery log',
  skattekonto_file_imports:
    'import log for the skattekonto mirror below; the statement is re-downloadable from Skatteverket',
  skattekonto_transactions: 'mirror of Skatteverket skattekonto, re-fetchable at source',
  skatteverket_api_audit_log: 'integration audit log',
  skatteverket_company_connections: 'integration connection state',
  skatteverket_tokens: 'secrets',
  stripe_connections: 'Stripe OAuth state (secrets)',
  stripe_payment_events: 'mirror of Stripe data, re-fetchable at source',
  stripe_payouts: 'mirror of Stripe data, re-fetchable at source',
  webhook_deliveries: 'automation delivery log',
  whatsapp_conversations:
    'WhatsApp bot conversation state (company_id is only a which-company pin); receipts live in document_attachments',
  webhooks: 'automation config with signing secrets',
  woocommerce_connections: 'WooCommerce connection state (encrypted API secrets)',
  shopify_connections: 'Shopify connection state (encrypted API secrets)',
  zettle_connections: 'Zettle connection state (encrypted OAuth refresh token)',
  pos_connections: 'POS connection state (venue, fetch schedule, account mapping); the days and their vouchers are dumped',
}

/** Max parent ids per `IN (...)` chunk: keeps the PostgREST URL well under limits. */
const CHILD_FK_CHUNK = 100

async function fetchChildTableRows(
  supabase: SupabaseClient,
  companyId: string,
  spec: MasterDataTableSpec
): Promise<Record<string, unknown>[]> {
  const via = spec.via!
  const denormalize = spec.denormalize
  // Narrow select (id + only the denormalized columns): the parent table can
  // be large and `*` would pull every invoice column just to read a currency.
  const parentSelect = ['id', ...(denormalize?.columns ?? [])].join(', ')
  const parents = await fetchAllRows<Record<string, unknown>>(
    ({ from, to }) =>
      supabase
        .from(via.parent)
        .select(parentSelect)
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        // The select list is built at runtime, so PostgREST's literal-string
        // type inference cannot resolve it and falls back to an error type.
        // The runtime shape is id + the declared columns, by construction.
        .range(from, to) as unknown as PromiseLike<{
        data: Record<string, unknown>[] | null
        error: { message: string } | null
      }>
  )

  const parentById = new Map<string, Record<string, unknown>>()
  if (denormalize) {
    for (const parent of parents) parentById.set(String(parent.id), parent)
  }

  const pageKey = spec.pageKey ?? 'id'
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < parents.length; i += CHILD_FK_CHUNK) {
    const chunk = parents.slice(i, i + CHILD_FK_CHUNK).map((p) => String(p.id))
    const chunkRows = await fetchAllRows<Record<string, unknown>>(
      ({ from, to }) => {
        let q = supabase.from(spec.name).select('*').in(via.fk, chunk)
        if (spec.orderBy) q = q.order(spec.orderBy, { ascending: true })
        return q.order(pageKey, { ascending: true }).range(from, to)
      },
      { dedupeBy: (r) => String(r[pageKey]) }
    )
    if (denormalize) {
      for (const row of chunkRows) {
        const parent = parentById.get(String(row[via.fk]))
        for (const column of denormalize.columns) {
          const key = `${denormalize.prefix}${column}`
          // Never clobber a real child column that happens to share the name:
          // the table's own data always wins over the copied parent value.
          if (key in row) continue
          // `?? null` is load-bearing: JSON.stringify drops undefined keys, so
          // a missing parent would silently produce a row with no unit again.
          row[key] = parent?.[column] ?? null
        }
      }
    }
    rows.push(...chunkRows)
  }
  return rows
}

/**
 * Dump structured master data as JSON under `data/`. These records are implicit
 * in the SIE export (as journal entries) but not recoverable as domain objects
 * without this dump, critical for disaster recovery of a company's state.
 */
async function writeMasterData(
  zip: ArchiveFolder,
  supabase: SupabaseClient,
  companyId: string
): Promise<void> {
  const data = zip.folder('data')

  // Sequential on purpose: ~50 fast queries in series are gentler on
  // PostgREST than 50 concurrent ones, and the deterministic order keeps the
  // queued-mock tests stable.
  for (const t of MASTER_DATA_DUMP_TABLES) {
    const pageKey = t.pageKey ?? 'id'
    try {
      const rows = t.name === 'invoice_deliveries'
        ? await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
            supabase
              .rpc('export_invoice_delivery_evidence', { p_company_id: companyId })
              .order('created_at', { ascending: true })
              .order('id', { ascending: true })
              .range(from, to),
          { dedupeBy: (row) => String(row.id) })
        : t.via
          ? await fetchChildTableRows(supabase, companyId, t)
          : await fetchAllRows<Record<string, unknown>>(({ from, to }) => {
            let q = supabase.from(t.name).select(t.columns ?? '*').eq('company_id', companyId)
            if (t.orderBy) {
              q = q.order(t.orderBy, { ascending: true })
            }
            // Always end on the unique PK so paging has a stable TOTAL order. A
            // non-unique display order (e.g. created_at) or no order at all
            // silently SKIPS/DUPLICATES rows across page boundaries: data loss in
            // a statutory 7-year retention archive. dedupeBy is defense-in-depth
            // against the duplicate case.
            //
            // The select list is built at runtime (spec.columns), so
            // PostgREST's literal-string type inference cannot resolve it and
            // falls back to an error type; the runtime shape is the declared
            // columns, by construction. Same cast as fetchChildTableRows.
            return q.order(pageKey, { ascending: true }).range(from, to) as unknown as PromiseLike<{
              data: Record<string, unknown>[] | null
              error: { message: string } | null
            }>
          }, { dedupeBy: (r) => String(r[pageKey]) })
      data.file(t.file, JSON.stringify(rows, null, 2))
    } catch (err) {
      if (t.name === 'invoice_deliveries') throw err
      data.file(
        t.file,
        JSON.stringify(
          { error: err instanceof Error ? err.message : 'Fetch failed', rows: [] },
          null,
          2
        )
      )
    }
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
}

async function buildEntryToPeriodMap(
  supabase: SupabaseClient,
  companyId: string,
  periods: FiscalPeriodRow[],
  scope: ArchiveScope
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const periodIds = periods.map((p) => p.id)
  if (periodIds.length === 0) return map

  let query = supabase
    .from('journal_entries')
    .select('id, fiscal_period_id')
    .eq('company_id', companyId)
    .in('status', ['posted', 'reversed'])

  if (scope === 'period') {
    query = query.eq('fiscal_period_id', periodIds[0])
  } else {
    query = query.in('fiscal_period_id', periodIds)
  }

  // Stable total order for correct paging (see fetch-all.ts).
  query = query.order('id', { ascending: true })

  const entries = await fetchAllRows<{ id: string; fiscal_period_id: string }>(({ from, to }) =>
    query.range(from, to)
  )

  for (const entry of entries) {
    map.set(entry.id, entry.fiscal_period_id)
  }
  return map
}

/**
 * Behandlingshistorik for a single räkenskapsår.
 *
 * A date window alone is not enough: bokslut entries and stornos for the year
 * are routinely committed months after period_end, so their audit rows fall
 * outside [period_start, period_end]. BFNAR 2013:2 kap 8 expects the year's
 * archive to carry the treatment history of the year's bokföringsposter, so
 * the window is complemented with every audit row touching the period's
 * journal entries and lines, regardless of when it was logged.
 */
/**
 * What the behandlingshistorik may take of an archive with a ceiling: each
 * page of audit rows is charged its JSON length as read, so the build stops
 * at the ceiling instead of holding every row and then their text. The
 * archive writes the rows indented, longer than charged, so the charge never
 * refuses a file that would have fit.
 */
interface AuditBudget {
  charge(rows: AuditLogEntry[]): void
}

function auditBudget(maxBytes: number): AuditBudget {
  let used = 0
  return {
    charge(rows) {
      for (const row of rows) used += JSON.stringify(row).length
      if (used > maxBytes) throw new ArchiveTooLargeError(maxBytes)
    },
  }
}

async function fetchPeriodAuditEntries(
  supabase: SupabaseClient,
  companyId: string,
  period: FiscalPeriodRow,
  budget?: AuditBudget
): Promise<AuditLogEntry[]> {
  const windowed = await fetchAllAuditEntries(supabase, companyId, {
    from_date: period.period_start,
    to_date: `${period.period_end}T23:59:59.999Z`,
  }, budget)

  const entryIds = (
    await fetchAllRows<{ id: string }>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', period.id)
        .in('status', ['posted', 'reversed'])
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to)
    )
  ).map((r) => r.id)
  if (entryIds.length === 0) return windowed

  // journal_entry_lines has no company_id column; tenant scoping comes from
  // the entry ids fetched above.
  const lineIds: string[] = []
  for (let i = 0; i < entryIds.length; i += CHILD_FK_CHUNK) {
    const chunk = entryIds.slice(i, i + CHILD_FK_CHUNK)
    const lines = await fetchAllRows<{ id: string }>(({ from, to }) =>
      supabase
        .from('journal_entry_lines')
        .select('id')
        .in('journal_entry_id', chunk)
        .order('id', { ascending: true })
        .range(from, to)
    )
    lineIds.push(...lines.map((r) => r.id))
  }

  const byId = new Map<string, AuditLogEntry>()
  for (const row of windowed) byId.set(row.id, row)

  // write_audit_log derives company_id from the audited row, and
  // journal_entry_lines has no such column, so line audit rows carry
  // company_id NULL: a plain company filter would drop them. The record-id
  // set above is already tenant-scoped; the OR admits NULL-company rows only
  // for journal_entry_lines. Under RLS (manual download) those rows stay
  // invisible; the service-role backup path (Drive cron) sees them.
  const recordIds = [...entryIds, ...lineIds]
  for (let i = 0; i < recordIds.length; i += CHILD_FK_CHUNK) {
    const chunk = recordIds.slice(i, i + CHILD_FK_CHUNK)
    const rows = await fetchAllRows<AuditLogEntry>(({ from, to }) =>
      supabase
        .from('audit_log')
        .select('*')
        .in('record_id', chunk)
        .or(
          `company_id.eq.${companyId},and(company_id.is.null,table_name.eq.journal_entry_lines)`
        )
        .order('id', { ascending: true })
        .range(from, to)
    )
    budget?.charge(rows.filter((row) => !byId.has(row.id)))
    for (const row of rows) byId.set(row.id, row)
  }

  // Newest first, matching getAuditLog's output order.
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

async function fetchAllAuditEntries(
  supabase: SupabaseClient,
  companyId: string,
  filters: { from_date?: string; to_date?: string },
  budget?: AuditBudget
): Promise<AuditLogEntry[]> {
  const all: AuditLogEntry[] = []
  const pageSize = 500
  // Keyset, not page numbers: each page starts after the last row of the one
  // before, so page 400 costs what page 1 does (getAuditLog's `after`).
  let after: AuditLogCursor | undefined

  while (true) {
    const result = await getAuditLog(supabase, companyId, {
      ...filters,
      pageSize,
      includeCount: false,
      ...(after ? { after } : {}),
    })
    budget?.charge(result.data)
    all.push(...result.data)
    if (result.data.length < pageSize) {
      break
    }
    const last = result.data[result.data.length - 1]
    after = { created_at: last.created_at, id: last.id }
  }
  return all
}

async function buildSystemDoc(
  supabase: SupabaseClient,
  companyId: string,
  periods: FiscalPeriodRow[],
  scope: ArchiveScope
): Promise<Record<string, unknown>> {
  let voucherSeriesQuery = supabase
    .from('voucher_sequences')
    .select('voucher_series, last_number, fiscal_period_id')
    .eq('company_id', companyId)

  if (scope === 'period') {
    voucherSeriesQuery = voucherSeriesQuery.eq('fiscal_period_id', periods[0].id)
  }

  const [accounts, voucherSeriesResult] = await Promise.all([
    fetchAllRows(({ from, to }) => supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, account_class, account_type, sru_code, description, is_active')
      .eq('company_id', companyId)
      .order('account_number').range(from, to)),
    voucherSeriesQuery,
  ])

  const branding = getBranding()
  return {
    system: {
      name: branding.appName.toLowerCase(),
      description: 'Bokforingssystem for enskild firma och aktiebolag',
      url: branding.appUrl,
      // BFNAR 2013:2 p. 9.16 second paragraph: program versions are system
      // changes that affect processing; the archive names the running build.
      version: currentAppVersion(),
    },
    kontoplan: {
      standard: 'BAS 2026',
      accounts,
      sie_import_regler: SIE_IMPORT_RULES,
    },
    leverantorsfakturor_avrundning_regler: SUPPLIER_INVOICE_ROUNDING_RULES,
    verifikationsserier: (voucherSeriesResult.data || []).map(
      (vs: { voucher_series: string; last_number: number; fiscal_period_id?: string }) => ({
        serie: vs.voucher_series,
        senaste_nummer: vs.last_number,
        fiscal_period_id: vs.fiscal_period_id ?? null,
      })
    ),
    // BFNAR 2013:2 p. 9.2-9.15: how verifikationer are assigned to a series
    // is a behandlingsregel the systemdokumentation has to spell out, incl.
    // the exceptions. The concrete mappings live in the data tables named
    // here (company_settings.default_voucher_series_per_source_type and
    // cash_accounts.voucher_series); changes to both are in behandlingshistorik.
    verifikationsserier_regler: VOUCHER_SERIES_RULES,
    // ML 17 kap 24 § p. 2: how a sales invoice gets its löpnummer.
    fakturanummer_regler: INVOICE_NUMBER_RULES,
    leverantorsbetalningar_regler: SUPPLIER_PAYMENT_RULES,
    arkivering: ARCHIVE_RULES,
    arsredovisning: ANNUAL_REPORT_RULES,
    // Access, delsystem and integrations are company state, not archive
    // constants: the generated Systemdokumentation report carries them.
    fullstandig_dokumentation: {
      arkiverad_kopia: 'revision/systemdokumentation/<räkenskapsår>.json och .pdf i detta arkiv: kontoplan, delsystem, verifikationsserier, behandlingsregler, behörigheter och integrationer som de var när arkivet skapades',
      aktuell_rapport: 'Rapporter > Export & arkiv > Systemdokumentation: samma dokument framtaget ur företagets inställningar just nu, inte en ögonblicksbild',
    },
    // BFNAR 2013:2 p. 9.15: where and how the behandlingshistorik is produced.
    behandlingshistorik: BEHANDLINGSHISTORIK_RULES,
    generated_at: new Date().toISOString(),
    fiscal_periods: periods.map((p) => ({
      id: p.id,
      start: p.period_start,
      end: p.period_end,
    })),
  }
}

function periodLabel(period: FiscalPeriodRow): string {
  return `${period.period_start}_${period.period_end}`
}
