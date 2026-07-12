import type { SupabaseClient } from '@supabase/supabase-js'
import JSZip from 'jszip'
import { generateSIEExport } from './sie-export'
import { generateTrialBalance } from './trial-balance'
import { generateIncomeStatement } from './income-statement'
import { generateBalanceSheet } from './balance-sheet'
import { generateGeneralLedger } from './general-ledger'
import { generateJournalRegister } from './journal-register'
import { calculateVatDeclaration } from './vat-declaration'
import { getAuditLog } from '@/lib/core/audit/audit-service'
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
import type { GeneralLedgerReport } from './general-ledger'
import type {
  AuditLogEntry,
  BalanceSheetReport,
  IncomeStatementReport,
} from '@/types'

export type FullArchiveOptions =
  | { scope: 'period'; period_id: string; include_documents?: boolean }
  | { scope: 'all'; include_documents?: boolean }

export type ArchiveScope = FullArchiveOptions['scope']

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
 */
export async function generateFullArchive(
  supabase: SupabaseClient,
  companyId: string,
  options: FullArchiveOptions
): Promise<ArrayBuffer> {
  const company = await fetchCompany(supabase, companyId)
  const periods =
    options.scope === 'all'
      ? await fetchAllPeriods(supabase, companyId)
      : [await fetchSinglePeriod(supabase, companyId, options.period_id)]

  if (periods.length === 0) {
    throw new Error('No fiscal periods found')
  }

  const zip = new JSZip()

  if (options.scope === 'all') {
    const sieFolder = zip.folder('sie')!
    const rapporterFolder = zip.folder('rapporter')!

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
          const periodFolder = rapporterFolder.folder(periodLabel(period))!
          writeReports(periodFolder, reports)
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
    const rapporter = zip.folder('rapporter')!
    writeReports(rapporter, reports)
  }

  if (options.include_documents !== false) {
    await writeDocuments(zip, supabase, companyId, periods, options.scope)
  }

  if (options.scope === 'all') {
    await writeSieSourceFiles(zip, supabase, companyId, options.include_documents !== false)
    await writeMasterData(zip, supabase, companyId)
  }

  const revision = zip.folder('revision')!

  const auditFilters =
    options.scope === 'period'
      ? {
          from_date: periods[0].period_start,
          to_date: `${periods[0].period_end}T23:59:59.999Z`,
        }
      : {}
  const auditEntries = await fetchAllAuditEntries(supabase, companyId, auditFilters)
  revision.file('behandlingshistorik.json', JSON.stringify(auditEntries, null, 2))

  const systemDoc = await buildSystemDoc(supabase, companyId, periods, options.scope)
  revision.file('systemdokumentation.json', JSON.stringify(systemDoc, null, 2))

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

  return zip.generateAsync({ type: 'arraybuffer' })
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
  const company = await fetchCompany(supabase, companyId)
  const periods = await fetchAllPeriods(supabase, companyId)
  const includeDocuments = options.include_documents !== false

  const zip = new JSZip()

  if (includeDocuments) {
    await writeDocuments(zip, supabase, companyId, periods, 'unlinked')
  }
  await writeSieSourceFiles(zip, supabase, companyId, includeDocuments)
  await writeMasterData(zip, supabase, companyId)

  const revision = zip.folder('revision')!
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

  return zip.generateAsync({ type: 'arraybuffer' })
}

/**
 * Estimate the uncompressed size of the archive in bytes.
 *
 * Sums `file_size_bytes` across all documents in scope plus a fixed overhead
 * for SIE, reports, audit trail, and system documentation. Used by the API
 * route to short-circuit generation when the payload would exceed the
 * platform's response-size ceiling.
 */
export async function estimateArchiveSize(
  supabase: SupabaseClient,
  companyId: string,
  scope: ArchiveScope,
  periodId?: string
): Promise<{ total_bytes: number; document_bytes: number; document_count: number }> {
  // Scope=all counts every document (linked or not), mirroring writeDocuments.
  let query = supabase
    .from('document_attachments')
    .select('file_size_bytes, journal_entry_id', { count: 'exact' })
    .eq('company_id', companyId)

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
    query = query.in('journal_entry_id', ids)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to estimate archive size: ${error.message}`)
  }

  const rows = (data as { file_size_bytes: number | null }[]) || []
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
  const [trialBalance, incomeStatement, balanceSheet, generalLedger, journalRegister] =
    await Promise.all([
      generateTrialBalance(supabase, companyId, period.id),
      generateIncomeStatement(supabase, companyId, period.id),
      generateBalanceSheet(supabase, companyId, period.id),
      generateGeneralLedger(supabase, companyId, period.id),
      generateJournalRegister(supabase, companyId, period.id),
    ])

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
      'accrual',
      { fiscalPeriodId: period.id }
    )
  } catch {
    // VAT declaration may fail if no relevant entries exist, skip gracefully
  }

  return { trialBalance, incomeStatement, balanceSheet, generalLedger, journalRegister, vatDeclaration }
}

function writeReports(folder: JSZip, reports: PeriodReports): void {
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
  zip: JSZip,
  supabase: SupabaseClient,
  companyId: string,
  periods: FiscalPeriodRow[],
  scope: DocumentMode
): Promise<void> {
  const dokument = zip.folder('dokument')!
  const manifest: DocumentManifestEntry[] = []

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
        const voucherLabel = formatVoucherLabel(entryInfo)
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

        try {
          const { data: fileData, error } = await supabase.storage
            .from('documents')
            .download(doc.storage_path)

          if (error || !fileData) {
            manifest.push({
              ...baseManifest,
              status: 'error',
              error: error?.message || 'Download returned no data',
            })
            continue
          }

          const buffer = await fileData.arrayBuffer()
          // zipPath is fully qualified (`dokument/<year>/<voucher>_<file>` etc.),
          // so write at the archive root: calling `dokument.file(zipPath)`
          // would double-prefix to `dokument/dokument/...`.
          zip.file(zipPath, buffer)
          manifest.push({ ...baseManifest, status: 'downloaded' })
        } catch (err) {
          manifest.push({
            ...baseManifest,
            status: 'error',
            error: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      }
    }
  } catch {
    // Document fetch failed: archive will still contain reports and audit trail
  }

  dokument.file('manifest.json', JSON.stringify(manifest, null, 2))
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
 * Format the voucher label as `<series><number>` (e.g. `A23`, `B12`). Returns
 * null if the entry is a draft (no voucher_number assigned yet), in which case
 * the doc is treated as orphaned in the ZIP layout.
 */
function formatVoucherLabel(
  entry: { voucher_number: number | null; voucher_series: string | null } | null
): string | null {
  if (!entry || entry.voucher_number == null) return null
  const series = entry.voucher_series ?? ''
  return `${series}${entry.voucher_number}`
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
  zip: JSZip,
  supabase: SupabaseClient,
  companyId: string,
  includeFiles: boolean
): Promise<void> {
  const sieFolder = zip.folder('sie')!

  try {
    const imports = await fetchAllRows<SieImportRow>(({ from, to }) =>
      supabase
        .from('sie_imports')
        .select(
          'id, filename, file_hash, file_storage_path, org_number, company_name, sie_type, fiscal_year_start, fiscal_year_end, accounts_count, transactions_count, status, fiscal_period_id, imported_at, created_at'
        )
        .eq('company_id', companyId)
        .order('created_at', { ascending: true })
        .range(from, to)
    )

    sieFolder.file('imports.json', JSON.stringify(imports, null, 2))

    const manifest: SieSourceManifestEntry[] = []

    if (includeFiles && imports.length > 0) {
      const originalFolder = sieFolder.folder('original')!

      for (const imp of imports) {
        if (!imp.file_storage_path) {
          manifest.push({
            import_id: imp.id,
            filename: imp.filename,
            storage_path: null,
            sha256_hash: imp.file_hash,
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

        try {
          const { data: fileData, error } = await supabase.storage
            .from('sie-files')
            .download(imp.file_storage_path)

          if (error || !fileData) {
            manifest.push({
              import_id: imp.id,
              filename: imp.filename,
              storage_path: imp.file_storage_path,
              sha256_hash: imp.file_hash,
              sie_type: imp.sie_type,
              fiscal_year_start: imp.fiscal_year_start,
              fiscal_year_end: imp.fiscal_year_end,
              imported_at: imp.imported_at,
              status: 'missing',
              zip_file_name: null,
              error: error?.message || 'Download returned no data',
            })
            continue
          }

          const buffer = await fileData.arrayBuffer()
          originalFolder.file(zipFileName, buffer)
          manifest.push({
            import_id: imp.id,
            filename: imp.filename,
            storage_path: imp.file_storage_path,
            sha256_hash: imp.file_hash,
            sie_type: imp.sie_type,
            fiscal_year_start: imp.fiscal_year_start,
            fiscal_year_end: imp.fiscal_year_end,
            imported_at: imp.imported_at,
            status: 'downloaded',
            zip_file_name: zipFileName,
          })
        } catch (err) {
          manifest.push({
            import_id: imp.id,
            filename: imp.filename,
            storage_path: imp.file_storage_path,
            sha256_hash: imp.file_hash,
            sie_type: imp.sie_type,
            fiscal_year_start: imp.fiscal_year_start,
            fiscal_year_end: imp.fiscal_year_end,
            imported_at: imp.imported_at,
            status: 'missing',
            zip_file_name: null,
            error: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      }

      originalFolder.file('manifest.json', JSON.stringify(manifest, null, 2))
    }

    const mappings = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('sie_account_mappings')
        .select('*')
        .eq('company_id', companyId)
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
  // Counterparties and articles
  { name: 'customers', file: 'customers.json', orderBy: 'created_at' },
  { name: 'suppliers', file: 'suppliers.json', orderBy: 'created_at' },
  { name: 'articles', file: 'articles.json', orderBy: 'created_at' },
  // Customer invoicing
  { name: 'invoices', file: 'invoices.json', orderBy: 'invoice_date' },
  { name: 'invoice_items', file: 'invoice_items.json', via: { parent: 'invoices', fk: 'invoice_id' } },
  { name: 'invoice_payments', file: 'invoice_payments.json', orderBy: 'payment_date' },
  { name: 'invoice_reminders', file: 'invoice_reminders.json' },
  { name: 'recurring_invoice_schedules', file: 'recurring_invoice_schedules.json' },
  // Supplier invoicing
  { name: 'supplier_invoices', file: 'supplier_invoices.json', orderBy: 'invoice_date' },
  { name: 'supplier_invoice_items', file: 'supplier_invoice_items.json', via: { parent: 'supplier_invoices', fk: 'supplier_invoice_id' } },
  { name: 'supplier_invoice_payments', file: 'supplier_invoice_payments.json' },
  // Receipts
  { name: 'receipts', file: 'receipts.json', orderBy: 'receipt_date' },
  { name: 'receipt_line_items', file: 'receipt_line_items.json', via: { parent: 'receipts', fk: 'receipt_id' } },
  // Bank and categorization
  // NOTE: the date column on transactions is `date` (a previous spec said
  // booking_date, which does not exist: every backup got an error stub).
  { name: 'transactions', file: 'transactions.json', orderBy: 'date' },
  { name: 'transaction_voucher_links', file: 'transaction_voucher_links.json' },
  { name: 'bank_file_imports', file: 'bank_file_imports.json', orderBy: 'created_at' },
  { name: 'cash_accounts', file: 'cash_accounts.json' },
  { name: 'mapping_rules', file: 'mapping_rules.json' },
  { name: 'categorization_templates', file: 'categorization_templates.json' },
  { name: 'booking_template_library', file: 'booking_template_library.json' },
  { name: 'skattekonto_rules', file: 'skattekonto_rules.json' },
  // Salary (räkenskapsinformation with 7-year retention)
  { name: 'employees', file: 'employees.json', orderBy: 'created_at' },
  { name: 'employee_benefits', file: 'employee_benefits.json', orderBy: 'created_at' },
  { name: 'salary_runs', file: 'salary_runs.json', orderBy: 'created_at' },
  { name: 'salary_run_employees', file: 'salary_run_employees.json', orderBy: 'created_at' },
  { name: 'salary_line_items', file: 'salary_line_items.json', orderBy: 'created_at' },
  { name: 'salary_absence_days', file: 'salary_absence_days.json' },
  { name: 'salary_worked_days', file: 'salary_worked_days.json' },
  { name: 'salary_payslip_links', file: 'salary_payslip_links.json' },
  { name: 'shift_premium_rules', file: 'shift_premium_rules.json' },
  { name: 'agi_declarations', file: 'agi_declarations.json', orderBy: 'created_at' },
  // Assets and accruals
  { name: 'assets', file: 'assets.json', orderBy: 'created_at' },
  { name: 'depreciation_schedules', file: 'depreciation_schedules.json', orderBy: 'created_at' },
  { name: 'accrual_schedules', file: 'accrual_schedules.json', orderBy: 'created_at' },
  { name: 'accrual_schedule_installments', file: 'accrual_schedule_installments.json', orderBy: 'created_at' },
  // Dimensions
  { name: 'dimensions', file: 'dimensions.json', orderBy: 'created_at' },
  { name: 'dimension_values', file: 'dimension_values.json', orderBy: 'created_at' },
  { name: 'cost_centers', file: 'cost_centers.json', orderBy: 'created_at' },
  { name: 'projects', file: 'projects.json', orderBy: 'created_at' },
  { name: 'account_dimension_rules', file: 'account_dimension_rules.json' },
  // Compliance records
  { name: 'voucher_gap_explanations', file: 'voucher_gap_explanations.json', orderBy: 'created_at' },
  { name: 'journal_entry_no_doc_required', file: 'journal_entry_no_doc_required.json', pageKey: 'journal_entry_id' },
  { name: 'rot_rut_payout_requests', file: 'rot_rut_payout_requests.json', orderBy: 'created_at' },
  { name: 'rot_rut_payout_request_items', file: 'rot_rut_payout_request_items.json', via: { parent: 'rot_rut_payout_requests', fk: 'request_id' } },
  { name: 'arsredovisning_narratives', file: 'arsredovisning_narratives.json' },
  { name: 'arsredovisning_submissions', file: 'arsredovisning_submissions.json' },
  // Settings
  { name: 'company_settings', file: 'company_settings.json' },
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
  sie_imports: 'sie/imports.json + sie/original/',
  sie_account_mappings: 'sie/account_mappings.json',
}

/**
 * Company-scoped tables deliberately kept out of the archive, with the reason.
 * Platform state, secrets, telemetry and re-fetchable mirrors do not belong in
 * a portable räkenskapsinformation backup.
 */
export const ARCHIVE_EXCLUDED_TABLES: Record<string, string> = {
  agent_conversations: 'AI assistant state, not räkenskapsinformation',
  agent_memory: 'AI assistant state, not räkenskapsinformation',
  agent_profiles: 'AI assistant state, not räkenskapsinformation',
  api_keys: 'secrets',
  arsredovisning_signature_requests: 'signing workflow state',
  bank_connections: 'PSD2 connection state and tokens, not portable',
  bolagsverket_avtal_acceptances: 'service agreement acceptance state',
  bolagsverket_subscriptions: 'integration subscription state',
  booking_template_usage: 'usage telemetry',
  calendar_feeds: 'feed tokens (secrets)',
  capability_grants: 'entitlement state',
  chat_messages: 'AI assistant state, not räkenskapsinformation',
  chat_sessions: 'AI assistant state, not räkenskapsinformation',
  company_capability_config: 'entitlement state',
  company_inbound_domains: 'inbound-mail infrastructure',
  company_inboxes: 'inbound-mail infrastructure',
  company_invitations: 'membership state, meaningless outside the platform',
  company_members: 'membership state, meaningless outside the platform',
  company_subscriptions: 'billing state',
  deadlines: 'regenerable operational calendar state',
  dimension_retag_log: 'operation log',
  event_log: '30-day TTL event bus log',
  extension_data: 'extension runtime state (includes this backup\'s own state)',
  graph_counterparties: 'derived AI context graph, regenerable',
  graph_transaction_counterparties: 'derived AI context graph, regenerable',
  idempotency_keys: 'infrastructure',
  inbox_rate_counters: 'infrastructure',
  invoice_inbox_items: 'inbox workflow state; the files live in document_attachments',
  metered_events: 'billing telemetry',
  notification_log: 'notification dedup log',
  operations: 'staged-operation workflow state',
  payment_match_log: 'derived matching log',
  pending_operations: 'staged-operation workflow state',
  processing_history: 'internal processing log; behandlingshistorik exports from audit_log',
  provider_consents: 'consent tokens, not portable',
  salary_payslip_deliveries: 'delivery log',
  skattekonto_transactions: 'mirror of Skatteverket skattekonto, re-fetchable at source',
  skatteverket_api_audit_log: 'integration audit log',
  skatteverket_company_connections: 'integration connection state',
  skatteverket_tokens: 'secrets',
  stripe_connections: 'Stripe OAuth state (secrets)',
  stripe_payment_events: 'mirror of Stripe data, re-fetchable at source',
  stripe_payouts: 'mirror of Stripe data, re-fetchable at source',
  webhook_deliveries: 'automation delivery log',
  webhooks: 'automation config with signing secrets',
}

/** Max parent ids per `IN (...)` chunk: keeps the PostgREST URL well under limits. */
const CHILD_FK_CHUNK = 100

async function fetchChildTableRows(
  supabase: SupabaseClient,
  companyId: string,
  spec: MasterDataTableSpec
): Promise<Record<string, unknown>[]> {
  const via = spec.via!
  const parents = await fetchAllRows<{ id: string }>(({ from, to }) =>
    supabase
      .from(via.parent)
      .select('id')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to)
  )

  const pageKey = spec.pageKey ?? 'id'
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < parents.length; i += CHILD_FK_CHUNK) {
    const chunk = parents.slice(i, i + CHILD_FK_CHUNK).map((p) => p.id)
    const chunkRows = await fetchAllRows<Record<string, unknown>>(
      ({ from, to }) => {
        let q = supabase.from(spec.name).select('*').in(via.fk, chunk)
        if (spec.orderBy) q = q.order(spec.orderBy, { ascending: true })
        return q.order(pageKey, { ascending: true }).range(from, to)
      },
      { dedupeBy: (r) => String(r[pageKey]) }
    )
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
  zip: JSZip,
  supabase: SupabaseClient,
  companyId: string
): Promise<void> {
  const data = zip.folder('data')!

  // Sequential on purpose: ~50 fast queries in series are gentler on
  // PostgREST than 50 concurrent ones, and the deterministic order keeps the
  // queued-mock tests stable.
  for (const t of MASTER_DATA_DUMP_TABLES) {
    const pageKey = t.pageKey ?? 'id'
    try {
      const rows = t.via
        ? await fetchChildTableRows(supabase, companyId, t)
        : await fetchAllRows<Record<string, unknown>>(({ from, to }) => {
            let q = supabase.from(t.name).select('*').eq('company_id', companyId)
            if (t.orderBy) {
              q = q.order(t.orderBy, { ascending: true })
            }
            // Always end on the unique PK so paging has a stable TOTAL order. A
            // non-unique display order (e.g. created_at) or no order at all
            // silently SKIPS/DUPLICATES rows across page boundaries: data loss in
            // a statutory 7-year retention archive. dedupeBy is defense-in-depth
            // against the duplicate case.
            return q.order(pageKey, { ascending: true }).range(from, to)
          }, { dedupeBy: (r) => String(r[pageKey]) })
      data.file(t.file, JSON.stringify(rows, null, 2))
    } catch (err) {
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

async function fetchAllAuditEntries(
  supabase: SupabaseClient,
  companyId: string,
  filters: { from_date?: string; to_date?: string }
): Promise<AuditLogEntry[]> {
  const all: AuditLogEntry[] = []
  let page = 1
  const pageSize = 500

  while (true) {
    const result = await getAuditLog(supabase, companyId, { ...filters, page, pageSize })
    all.push(...result.data)
    if (all.length >= result.count || result.data.length < pageSize) {
      break
    }
    page++
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

  const [accountsResult, voucherSeriesResult] = await Promise.all([
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name, account_type, is_active')
      .eq('company_id', companyId)
      .order('account_number'),
    voucherSeriesQuery,
  ])

  const branding = getBranding()
  return {
    system: {
      name: branding.appName.toLowerCase(),
      description: 'Bokforingssystem for enskild firma och aktiebolag',
      url: branding.appUrl,
    },
    kontoplan: {
      standard: 'BAS 2026',
      accounts: accountsResult.data || [],
    },
    verifikationsserier: (voucherSeriesResult.data || []).map(
      (vs: { voucher_series: string; last_number: number; fiscal_period_id?: string }) => ({
        serie: vs.voucher_series,
        senaste_nummer: vs.last_number,
        fiscal_period_id: vs.fiscal_period_id ?? null,
      })
    ),
    behorighetskontroll: {
      description: 'Rollbaserad atkomstkontroll med owner/admin/member/viewer',
      mfa_stod: true,
      rls_aktiv: true,
    },
    arkivering: {
      lagringstid_ar: 7,
      format: 'WORM (Write Once, Read Many)',
      integritetskontroll: 'SHA-256 hashning vid uppladdning, regelbunden verifiering',
      lagringsplats: 'Supabase Storage (krypterad)',
    },
    integrationer: {
      bank: 'Enable Banking (PSD2)',
      email: 'Resend',
      export_format: 'SIE4',
    },
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
