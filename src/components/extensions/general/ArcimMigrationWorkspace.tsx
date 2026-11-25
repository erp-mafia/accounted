'use client'

import { SIEJobFailedError, waitForSIEJob } from '@/lib/import/sie-job-client'
import InvoiceCompletionRecovery from './InvoiceCompletionRecovery'
import { FortnoxTopupSwitch } from './FortnoxTopupSwitch'
import { describeImportResponseFailure, formatImportFailure } from '@/lib/import/import-failure'
import { createContext, useState, useCallback, useContext, useEffect, useReducer, useRef } from 'react'
import { useOAuthPopup } from '@/lib/hooks/use-oauth-popup'
import { useAccounts } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useTranslations } from 'next-intl'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatDate } from '@/lib/utils'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AttnLine } from '@/components/ui/attn-line'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { HelpPopover } from '@/components/ui/help-popover'
import Link from 'next/link'
import { getBranding } from '@/lib/branding/service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const branding = getBranding()
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUturnLeftIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
  LockClosedIcon,
  PaperClipIcon,
  SpinnerIcon,
  TrashIcon,
  XCircleIcon,
  type Icon as AppIcon,
} from '@/components/icons'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import { supportsUnderlagImport } from '@/lib/providers/underlag-import'
import { previewCountsForSelection, type ProviderPreviewCounts } from '@/lib/providers/preview-counts'
import { defaultFiscalYearSelection, fiscalYearSelectionProblem, needsSeveralRuns, toggleFiscalYear } from '@/lib/providers/year-selection'
import {
  ARCIM_DOCUMENT_OAUTH_RESUME_KEY,
  INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
  ArcimDocumentImportRequestError,
  arcimDocumentImportReducer,
  arcimDocumentReconnectPlan,
  documentImportProgress,
  documentImportRunNote,
  documentOAuthProblemFromReason,
  documentReconnectRefused,
  fetchResumableDocumentImport,
  parseArcimDocumentResumeMarker,
  PROVIDER_CONNECTION_REFUSED_CODES,
  PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE,
  PROVIDER_IMPORT_DOCUMENTS_RUNNING_ON_SERVER,
  requestArcimDocumentImport,
  resumableDocumentImport,
  runArcimDocumentImportToCompletion,
  resolveArcimDocumentFollowUpProvider,
  serializeArcimDocumentResumeMarker,
  watchArcimOAuthPopup,
  type ArcimDocumentImportPhase,
  type ArcimDocumentImportProblem,
  type ArcimDocumentImportResult,
  type ArcimDocumentImportState,
  type ArcimUnreachableDocumentSource,
} from './arcim-document-import-flow'
import { MIGRATION_PROVIDERS, missingTokenCredential, tokenCredentials } from '@/lib/providers/catalog'
import type { ProviderName } from '@/lib/providers/types'
import {
  trackMigrationConnectClicked,
  trackMigrationConnectFinished,
  type MigrationConnectOutcome,
} from './arcim-connect-track'

type ArcimProvider = ProviderName

// One catalog for the workspace, the extension and the MCP connect card. WINT
// is env-gated server-side (WINT_MIGRATION_ENABLED): GET /status names the
// providers this deployment can connect and the provider list shows only
// those (offeredProviders below).
const ARCIM_PROVIDERS = MIGRATION_PROVIDERS

/**
 * Extract a human-readable message from an API error body. Routes answer in
 * two shapes: legacy `{ error: 'text' }` and the structured envelope
 * `{ error: { code, message } }`: naively rendering the latter shows
 * "[object Object]".
 */
function apiErrorMessage(data: unknown, fallback: string): string {
  const err = (data as { error?: unknown } | null)?.error
  if (typeof err === 'string' && err) return err
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

/**
 * Marks an error whose message is already user-facing Swedish (server
 * envelopes, ImportResult.errors). The catch blocks must show these
 * verbatim: routing them through getErrorMessage would test them against
 * its Swedish-pattern heuristic and swallow any miss into the generic
 * "Något gick fel. Försök igen.", hiding the real reason the migration
 * stopped.
 */
class UserFacingError extends Error {}

/**
 * Build the throwable for a failed API response: an extracted server
 * message passes through to the UI verbatim, while the technical fallback
 * (e.g. "HTTP 500") stays a plain Error so getErrorMessage maps it to a
 * friendly message.
 */
function apiError(data: unknown, fallback: string): Error {
  const extracted = apiErrorMessage(data, '')
  return extracted ? new UserFacingError(extracted) : new Error(fallback)
}

/** Resolve the message a catch block should display. */
function displayError(err: unknown, nonErrorFallback?: string): string {
  if (err instanceof UserFacingError) return err.message
  if (!(err instanceof Error) && nonErrorFallback) return nonErrorFallback
  return getUserErrorMessage(err)
}

function documentImportProblem(error: unknown): ArcimDocumentImportProblem {
  if (error instanceof ArcimDocumentImportRequestError) return error.problem
  return { code: null, requestId: null, reconnectRequired: false }
}

function storeDocumentOAuthResume(
  action: 'discover' | 'import',
  standalone: boolean,
): void {
  try {
    window.sessionStorage.setItem(
      ARCIM_DOCUMENT_OAUTH_RESUME_KEY,
      serializeArcimDocumentResumeMarker({ action, standalone }),
    )
  } catch {
    // Full-page recovery is best-effort when browser storage is unavailable.
  }
}

function readDocumentOAuthResume() {
  try {
    return parseArcimDocumentResumeMarker(
      window.sessionStorage.getItem(ARCIM_DOCUMENT_OAUTH_RESUME_KEY),
    )
  } catch {
    return null
  }
}

function clearDocumentOAuthResume(): void {
  try {
    window.sessionStorage.removeItem(ARCIM_DOCUMENT_OAUTH_RESUME_KEY)
  } catch {
    // Nothing else is required when browser storage is unavailable.
  }
}

// A connect click whose popup was blocked continues as a full-page redirect
// and leaves this page: the provider rides along in session storage so the
// return can report how the attempt ended (migration_connect_finished).
const ARCIM_CONNECT_ATTEMPT_KEY = 'arcim-connect-attempt'

function storeConnectAttempt(provider: ArcimProvider): void {
  try {
    window.sessionStorage.setItem(ARCIM_CONNECT_ATTEMPT_KEY, provider)
  } catch {
    // Telemetry is best-effort when browser storage is unavailable.
  }
}

function takeConnectAttempt(): ArcimProvider | null {
  try {
    const stored = window.sessionStorage.getItem(ARCIM_CONNECT_ATTEMPT_KEY)
    window.sessionStorage.removeItem(ARCIM_CONNECT_ATTEMPT_KEY)
    return ARCIM_PROVIDERS.find(p => p.id === stored)?.id ?? null
  } catch {
    return null
  }
}

/**
 * Read the /migrate NDJSON stream: one JSON object per line. `progress`
 * events carry the orchestrator's real step labels and anchors; the stream
 * ends with a terminal `done` line (results) or `error` line (the same
 * structured envelope the JSON path answers with, thrown here so the catch
 * block shows it verbatim).
 */
async function consumeMigrationStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (currentStep: string | undefined, progress: number) => void,
): Promise<MigrationResults> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let results: MigrationResults | undefined

  const handleLine = (line: string) => {
    if (!line.trim()) return
    let event: {
      kind?: string
      currentStep?: string
      progress?: number
      results?: MigrationResults
    }
    try {
      event = JSON.parse(line)
    } catch {
      return // torn line from an intermediary flush; terminal lines are whole
    }
    if (event.kind === 'progress' && typeof event.progress === 'number') {
      onProgress(
        typeof event.currentStep === 'string' && event.currentStep ? event.currentStep : undefined,
        event.progress,
      )
    } else if (event.kind === 'done') {
      results = event.results ?? {}
    } else if (event.kind === 'error') {
      throw apiError(event, 'Migreringen misslyckades.')
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    buffer += decoder.decode()
    if (buffer) handleLine(buffer)
  } finally {
    reader.releaseLock()
  }

  if (!results) {
    // The connection dropped before the terminal line. The migration keeps
    // running server-side, so a blind retry could double-import.
    throw new UserFacingError(
      'Anslutningen bröts innan migreringen bekräftades. Ladda om sidan och kontrollera om kunder och fakturor redan har importerats innan du försöker igen.'
    )
  }
  return results
}

/** Pull the structured error `code` from an envelope, if present. */
function apiErrorCode(data: unknown): string | null {
  const err = (data as { error?: unknown } | null)?.error
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return null
}

// The migration result contract is owned by the extension: a second
// hand-written copy here would drift from the API. Type-only import, same
// pattern as the other extension workspaces.
import type {
  MigrationResults,
  MigrationStepError,
  SkipReasons,
  AssetSkipReasons,
} from '@/extensions/general/arcim-migration/types'
import type { SieFetchFailure } from '@/extensions/general/arcim-migration/lib/sie-fetcher'
import type { DocumentImportRunStatus } from '@/extensions/general/arcim-migration/lib/document-import-run'
import type { FortnoxTopupView } from '@/extensions/general/arcim-migration/lib/fortnox-topup'
import {
  buildMigrateRequests,
  mergeMigrationResults,
} from '@/extensions/general/arcim-migration/lib/migrate-plan'
import { canSkipMappingStep } from '@/extensions/general/arcim-migration/lib/mapping-step'
import AccountMappingStep from '@/components/import/AccountMappingStep'
import ProviderMigrationProgress from './ProviderMigrationProgress'
import ProviderMigrationIssues from './ProviderMigrationIssues'
import {
  MIGRATION_RESOURCES, emptyMigrationRegisters, migrationRefusalMessageValues, migrationRefusals,
  USER_RIGHT_REFUSAL_MESSAGE_KEY, type MigrationResource, type ProviderMigrationIssue, type ProviderMigrationStatus,
} from '@/lib/providers/migration-contract'
import ArcimMigrationTheater from '@/components/extensions/general/ArcimMigrationTheater'
import TheaterCanvas from '@/components/import/TheaterCanvas'
import {
  applyVatTreatmentReview,
  applyVatTreatmentReviewAll,
  enrichChangedAccountMappingWithVat,
  enrichAccountMappingsWithVat,
} from '@/lib/import/account-vat-treatment'
import type { TheaterModel } from '@/lib/import/theater-model'
import type { AccountMapping, ImportResult } from '@/lib/import/types'
import type { AccountVatTreatment } from '@/lib/vat/account-vat-treatment'
import type { BASAccount } from '@/types'

// ── Types ────────────────────────────────────────────────────────

type WizardStep = 'provider' | 'connect' | 'preview' | 'mapping' | 'options' | 'migrating' | 'result'

const STEPS: WizardStep[] = ['provider', 'connect', 'preview', 'mapping', 'options', 'migrating', 'result']

const STEP_LABELS: Record<WizardStep, string> = {
  provider: 'Välj system',
  connect: 'Anslut',
  preview: 'Förhandsgranskning',
  mapping: 'Kontomappning',
  options: 'Alternativ',
  migrating: 'Migrerar',
  result: 'Resultat',
}

interface MigrationOptions {
  importCompanyInfo: boolean
  importSIEData: boolean
  importCustomers: boolean
  importSuppliers: boolean
  importSalesInvoices: boolean
  importSupplierInvoices: boolean
  /** Fortnox: paid supplier invoices too, for this sync only (crm#1114). */
  importPaidSupplierInvoices: boolean
  importAssets: boolean
  voucherSeries: string
  /**
   * Fiscal years a completed import already holds that this run imports
   * again, each ticked by hand (PH 185, PH 180). Empty by default and reset
   * with the options on every run, so a replacement is never carried over.
   */
  replaceImportedYears: number[]
  /** Leave out the BAS accounts no SIE file uses (#63). On by default here:
   *  a provider export is that provider's whole chart template. The
   *  company's own (non-BAS) accounts are created either way. */
  onlyUsedAccounts: boolean
}

export const DEFAULT_OPTIONS: MigrationOptions = {
  importCompanyInfo: true,
  importSIEData: true,
  importCustomers: true,
  importSuppliers: true,
  importSalesInvoices: true,
  importSupplierInvoices: true,
  importPaidSupplierInvoices: false,
  importAssets: true,
  voucherSeries: 'B',
  replaceImportedYears: [],
  onlyUsedAccounts: true,
}

/**
 * The options a freshly loaded preview leaves for the options step: the SIE
 * import follows what this preview could fetch, both ways. A retry or a
 * reconnect after a failed fetch (crm#1118) must tick it again, or the
 * options step would open with the ledger unticked.
 */
export function optionsAfterPreview(options: MigrationOptions, sieAvailable: boolean): MigrationOptions {
  return { ...options, importSIEData: sieAvailable }
}

/**
 * The options once /sie-data has said which fetched years a completed
 * import already holds: the ledger is ticked only when at least one year is
 * new, and no year is set to be replaced. Replacing a year reverses
 * (makulerar) every verifikat of the earlier import and books the year again
 * under new numbers, so it is never what a re-run does by itself: a Fortnox
 * run after an SIE upload, or a run to add older years or underlag, left
 * hundreds to thousands of reversed verifikat (PH 185, PH 180, PH 163). The
 * onboarding books act skips those years the same way (planProviderYears).
 */
export function optionsAfterSieData(
  options: MigrationOptions,
  fileStatuses: Pick<SIEFileStatus, 'previousImport'>[],
): MigrationOptions {
  return {
    ...options,
    importSIEData: fileStatuses.some((fs) => !fs.previousImport),
    replaceImportedYears: [],
  }
}

/**
 * The fetched years the ledger phase imports, oldest first: each new year
 * while the ledger is ticked, and each already imported year only when its
 * replacement was ticked by hand. A replaced year carries the import it
 * supersedes; a new one never does.
 */
export function sieFilesToImport<T extends Pick<SIEFileStatus, 'fiscalYear' | 'previousImport'>>(
  fileStatuses: T[],
  options: Pick<MigrationOptions, 'importSIEData' | 'replaceImportedYears'>,
): T[] {
  return fileStatuses
    .filter((fs) => fs.previousImport
      ? options.replaceImportedYears.includes(fs.fiscalYear)
      : options.importSIEData)
    .sort((a, b) => a.fiscalYear - b.fiscalYear)
}

interface PreviewData {
  consent: {
    id: string
    provider: ArcimProvider
    status: number
    companyName?: string
  }
  companyInfo: {
    company_name: string | null
    org_number: string | null
    vat_number: string | null
    fiscal_year_start_month: number
    address_line1: string | null
    postal_code: string | null
    city: string | null
    phone: string | null
    email: string | null
  } | null
  sieAvailable: boolean
  // Counts over the default years the preview read, naming them: shown only
  // while exactly those years are ticked (previewCountsForSelection).
  sieStats: ProviderPreviewCounts | null
  // Why a provider that serves SIE over the API could not hand it over
  // (crm#1118). Null when the fetch worked, and for Visma and Bokio.
  sieError?: SieFetchFailure | null
  // Every fiscal year the source has, oldest first, with the default
  // selection marked: rendered as the year picker so the user chooses
  // before the import runs and no year is left out silently (#2211, #2238).
  sourceYears?: SourceFiscalYear[]
  // The most years one run may select: /sie-data refuses more. Read from
  // the server so the picker never drifts from the route.
  maxSelectedYears?: number
  // Start years the company's completed SIE imports hold: a history longer
  // than one run starts from the oldest year not among them (crm#1686).
  importedFiscalYears?: number[]
  assetStats: {
    total: number
    importable: number
  } | null
  hasSieData: boolean
}

interface SIEFileStatus {
  fiscalYear: number
  // Where /sie-data archived this year's file: the import is posted this
  // path, never the content (a body over 4.5 MB never reached the server).
  storagePath: string
  filename: string
  bytes: number
  voucherCount: number
  // Legacy field for older builds: read previousImport instead.
  alreadyImported: boolean
  importedAt: string | null
  // New (period-based) detection. When present, this fiscal year already has a
  // completed import in Accounted and a re-sync will replace it (cancelling the
  // imported journal entries; user-created entries are untouched).
  previousImport: {
    id: string
    importedAt: string | null
    fiscalYearStart: string | null
    fiscalYearEnd: string | null
  } | null
}

interface SIEData {
  // Built on the server from every selected year: the parse it comes from
  // is as large as the files and stays there with them.
  theater: TheaterModel
  mappings: AccountMapping[]
  mappingStats: { total: number; mapped: number; unmapped: number }
  // One entry per fetched file, oldest first.
  fileStatuses: SIEFileStatus[]
  allImported: boolean
  newFileCount: number
  replacedFileCount?: number
  // Fiscal years whose provider export failed. Importing the remaining years
  // anyway leaves an IB/UB gap: the options step warns before proceeding.
  failedYears?: { year: number; error: string }[]
  // Source fiscal years outside the selection: not fetched, named in the
  // result so nobody believes the books are complete (#2211).
  omittedYears?: SourceFiscalYear[]
  basAccounts: BASAccount[]
  // Definitions no selected year uses (#63), for the options step's count.
  preview?: { unusedAccounts?: { number: string; name: string }[] }
}

/**
 * A fiscal year as the source reports it. Mirrors SourceFiscalYear in
 * extensions/general/arcim-migration/lib/sie-fetcher.ts (deliberate
 * duplication: core must not import from @/extensions/).
 */
interface SourceFiscalYear {
  year: number
  fromDate: string | null
  toDate: string | null
  inDefaultSelection: boolean
}

/** "2022-09-01 till 2023-12-31" when the provider gave bounds, else the start year. */
function useFiscalYearSpanLabel(): (fy: SourceFiscalYear) => string {
  const t = useTranslations('extensions')
  return (fy) =>
    fy.fromDate && fy.toDate
      ? t('ext_arcim_fiscal_year_span', { from: fy.fromDate, to: fy.toDate })
      : String(fy.year)
}

// ── Shared step chrome ───────────────────────────────────────────
// Living Paper: step content sits directly on the page. The serif headline
// is the step's one display element; sections are kickers over hairline
// rows; attention is one ochre sentence (AttnLine); the SIE escape hatch is
// a quiet underlined link, never a boxed prompt.

function StepHeading({ title, lede }: { title: string; lede?: string }) {
  return (
    <div>
      <h2 className="text-xl text-balance">{title}</h2>
      {lede && <p className="mt-2 text-sm text-muted-foreground">{lede}</p>}
    </div>
  )
}

function SectionKicker({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium text-muted-foreground">
      {children}
    </h3>
  )
}

function SieFallbackLine({ message, label = 'Ladda upp SIE-fil' }: { message: string; label?: string }) {
  return (
    <p className="text-[13px] text-muted-foreground">
      {message}{' '}
      <Link
        href="/import?mode=sie"
        className="underline decoration-foreground/25 underline-offset-4 transition-colors duration-150 hover:text-foreground"
      >
        {label}
      </Link>
    </p>
  )
}

function SpinnerLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      <SpinnerIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

/**
 * The quiet step indicator that replaces the boxed progress card: the step
 * labels as an uppercase tracking kicker row (done steps muted with a small
 * check, the current step in foreground ink) over a hairline thread whose
 * ink segment is the progress. No card, no fat bar.
 */
function StepRail({ steps, currentIndex }: { steps: WizardStep[]; currentIndex: number }) {
  const progressPercent = ((currentIndex + 1) / steps.length) * 100
  return (
    <nav aria-label="Migreringens steg">
      <p className="text-xs font-medium sm:hidden">
        Steg {currentIndex + 1} av {steps.length}: {STEP_LABELS[steps[currentIndex]]}
      </p>
      <ol className="hidden flex-wrap items-center gap-x-6 gap-y-1 sm:flex">
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={i === currentIndex ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1 text-xs font-medium transition-colors duration-150',
              i === currentIndex
                ? 'text-foreground'
                : i < currentIndex
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground'
            )}
          >
            {i < currentIndex && <CheckIcon className="h-3 w-3" aria-hidden="true" />}
            {STEP_LABELS[s]}
          </li>
        ))}
      </ol>
      <div className="mt-3 h-px w-full bg-border">
        <div
          className="h-px bg-foreground transition-[width] duration-300 ease-out"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </nav>
  )
}

// ── Provider selection step ──────────────────────────────────────

interface SieImportSummary {
  id: string
  filename: string
  status: string
  accounts_count: number | null
  transactions_count: number | null
  company_name: string | null
  fiscal_year_start: string | null
  fiscal_year_end: string | null
  imported_at: string | null
  created_at: string
}

interface ConnectionStatus {
  consents: {
    id: string
    provider: ArcimProvider
    status: number
    companyName?: string
    createdAt?: string
    /**
     * Whether the stored key still has work to do (lib/key-use.ts, crm#1476).
     * Absent when the server could not tell or predates the field: then the
     * row says nothing about it.
     */
    keyUse?: 'migration' | 'invoice_rows' | 'supplier_rows' | 'topup' | 'idle'
  }[]
  /** The 10 newest imports of any status: display only. */
  sieImports: SieImportSummary[]
  /**
   * Whether ANY completed import exists, asked of the server: failed and
   * replaced rows can push the completed one out of the 10-row history.
   * Optional only for a server that predates the field.
   */
  hasCompletedSieImport?: boolean
  latestCompletedSieImport?: SieImportSummary | null
  /**
   * The latest connect that never got a token (older than 30 minutes, not
   * followed by a completed SIE import or an accepted connection). Optional
   * only for a server that predates the field.
   */
  unfinishedConnect?: { provider: ArcimProvider; startedAt: string } | null
  /**
   * The latest underlag run, as the server kept it (crm#1410). Optional only
   * for a server that predates the field.
   */
  latestDocumentImport?: DocumentImportRunStatus | null
  /**
   * Live verifikat without underlag whose reversed copy from an earlier
   * import holds it (#51): a re-run migration left the files there.
   * Optional only for a server that predates the field.
   */
  underlagOnReplacedCopies?: number
  /**
   * The nightly top-up from Fortnox: its switch and latest run. Null when it
   * was never turned on; optional only for a server that predates the field.
   */
  fortnoxTopup?: FortnoxTopupView | null
  entityCounts: {
    customers: number
    suppliers: number
    invoices: number
  }
  /**
   * The providers this deployment can connect (WINT only behind
   * WINT_MIGRATION_ENABLED). Optional only for a server that predates the
   * field.
   */
  enabledProviders?: ArcimProvider[]
}

// Providers listed here render as a disabled "Kommer snart" card. WINT was
// the last entry: it is released now, so the set is empty. WINT still depends
// on WINT_MIGRATION_ENABLED=true, the server-side /connect gate.
const COMING_SOON_PROVIDERS = new Set<ArcimProvider>([])

/**
 * The provider cards to show: the ones the server says it can connect. Until
 * it has said (no status yet, or a server that predates the field), WINT, the
 * one provider that ships dark, stays hidden rather than offering a connection
 * the /connect gate would refuse.
 */
export function offeredProviders(status: Pick<ConnectionStatus, 'enabledProviders'> | null) {
  const enabled = status?.enabledProviders
  return ARCIM_PROVIDERS.filter((provider) => (enabled ? enabled.includes(provider.id) : provider.id !== 'wint'))
}

export interface ReplacedCopyUnderlagOffer {
  consentId: string
  provider: ArcimProvider
  /** Live verifikat whose underlag sits on a reversed copy. */
  count: number
  /** The latest run on this connection stopped for a reconnect (B11). */
  reconnect: boolean
}

/**
 * The connection to run "Hämta underlag" again with, when live verifikat lack
 * the underlag an earlier run left on the copy a re-run migration reversed
 * (#51). The run links each file to the live copy and leaves the reversed one
 * as it is. The connection the latest run used comes first: its files are
 * the ones left behind. Null when nothing is left there, before a ledger
 * import, without a connection that serves underlag, and while a run is
 * moving on that connection (its line under the connection says so).
 */
export function replacedCopyUnderlagOffer(
  status: Pick<ConnectionStatus, 'consents' | 'underlagOnReplacedCopies' | 'latestDocumentImport'> | null,
  hasSieImport: boolean,
): ReplacedCopyUnderlagOffer | null {
  const count = status?.underlagOnReplacedCopies ?? 0
  if (!status || !hasSieImport || count <= 0) return null
  const connections = status.consents.filter(c => c.status === 1 && supportsUnderlagImport(c.provider))
  const run = status.latestDocumentImport ?? null
  const consent = connections.find(c => c.provider === run?.provider) ?? connections[0]
  if (!consent) return null
  const runHere = run?.provider === consent.provider ? run : null
  const note = documentImportRunNote(runHere)
  if (note?.kind === 'running' || note?.kind === 'resuming') return null
  return { consentId: consent.id, provider: consent.provider, count, reconnect: note?.kind === 'reconnect' }
}

/** Visma has no logo on purpose (2026-10-29): ProviderMark shows its initial. */
const PROVIDER_LOGOS: Partial<Record<ArcimProvider, string>> = {
  fortnox: '/logos/fortnox.svg',
  bokio: '/logos/bokio.png',
  bjornlunden: '/logos/bjornlunden.png',
  briox: '/logos/Briox_logo.png',
  wint: '/logos/wint.png',
}

function ProviderMark({
  provider,
  name,
  alt = '',
  className,
}: {
  provider: ArcimProvider
  name: string
  alt?: string
  className?: string
}) {
  const logo = PROVIDER_LOGOS[provider]
  if (!logo) {
    return (
      <span
        role={alt ? 'img' : undefined}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border text-sm font-semibold',
          className,
        )}
        aria-hidden={alt ? undefined : true}
        aria-label={alt || undefined}
      >
        {name.charAt(0)}
      </span>
    )
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logo} alt={alt} className={cn('h-8 w-8 shrink-0 rounded-sm object-contain', className)} />
}

/** The latest underlag run under its connection: what came in, and what did not. */
export function DocumentImportRunLine({ run }: { run: DocumentImportRunStatus }) {
  const t = useTranslations('extensions')
  const note = documentImportRunNote(run)
  if (!note) return null
  const line = 'mt-0.5 text-xs text-muted-foreground tabular-nums'
  if (note.kind === 'reconnect') {
    const provider = ARCIM_PROVIDERS.find(p => p.id === note.provider)?.name ?? note.provider
    return <p className={line}>{t('ext_arcim_documents_last_run_reconnect', { date: formatDate(note.date), provider })}</p>
  }
  if (note.kind !== 'complete') {
    return (
      <p className={line}>
        {note.kind === 'stopped'
          ? t('ext_arcim_documents_last_run_stopped', { date: formatDate(note.date), scanned: note.scanned, total: note.total })
          : note.kind === 'resuming'
            ? t('ext_arcim_documents_last_run_resuming', { scanned: note.scanned, total: note.total })
            : t('ext_arcim_documents_last_run_running', { scanned: note.scanned, total: note.total })}
      </p>
    )
  }
  const left = [
    note.unmatched > 0 ? t('ext_arcim_documents_last_run_unmatched', { count: note.unmatched }) : null,
    note.locked > 0 ? t('ext_arcim_documents_last_run_locked', { count: note.locked, years: note.lockedYears }) : null,
    note.failed > 0 ? t('ext_arcim_documents_last_run_failed', { count: note.failed }) : null,
    note.unreachable ? t('ext_arcim_documents_last_run_unreachable') : null,
  ].filter((item): item is string => item !== null)
  return (
    <>
      <p className={line}>
        {t('ext_arcim_documents_last_run_complete', { date: formatDate(note.date), present: note.present, total: note.total })}
      </p>
      {left.length > 0 && <p className={line}>{t('ext_arcim_documents_last_run_left', { items: left.join(', ') })}</p>}
    </>
  )
}

export function ProviderStep({
  onSelect,
  onResync,
  onFetchDocuments,
  onReconnectDocuments,
  onDisconnect,
  onTopupChanged,
  connectionStatus,
  isLoadingStatus,
}: {
  onSelect: (provider: ArcimProvider) => void
  onResync: (provider: ArcimProvider, consentId: string) => void
  /** Run the underlag import on its own against an active consent whose provider serves underlag. */
  onFetchDocuments: (consentId: string, provider: ArcimProvider) => void
  /**
   * Reconnect a connection the latest underlag run found refused (B11), then
   * look for underlag again. Without it the row falls back to onFetchDocuments.
   */
  onReconnectDocuments?: (consentId: string, provider: ArcimProvider) => void
  onDisconnect: (consentId: string) => void
  /** The nightly top-up was switched: read the connections again (the key's line depends on it). */
  onTopupChanged?: () => void
  connectionStatus: ConnectionStatus | null
  isLoadingStatus: boolean
}) {
  const t = useTranslations('extensions')
  const activeConsents = connectionStatus?.consents.filter(c => c.status === 1) ?? []
  const hasSieImport = connectionStatus?.hasCompletedSieImport
    ?? ((connectionStatus?.sieImports.filter(i => i.status === 'completed').length ?? 0) > 0)
  const sieViaApi = (id: ArcimProvider) => ARCIM_PROVIDERS.find(p => p.id === id)?.sieViaApi === true
  const allSieViaApi = activeConsents.length > 0 && activeConsents.every(c => sieViaApi(c.provider))
  const showSieRequiredBanner = !isLoadingStatus && !hasSieImport && !allSieViaApi
  // A returning customer whose last connect stalled gets it back here. The
  // retry follows the same gate as the provider list below: Visma and Bokio
  // stay behind "SIE krävs först", so only the upload is offered for them.
  const unfinished = connectionStatus?.unfinishedConnect ?? null
  const unfinishedInfo = unfinished ? ARCIM_PROVIDERS.find(p => p.id === unfinished.provider) : undefined
  const unfinishedCanRetry = !!unfinishedInfo
    && !COMING_SOON_PROVIDERS.has(unfinishedInfo.id)
    && (hasSieImport || unfinishedInfo.sieViaApi)
  // Until the company has a completed ledger import, a connection that
  // fetches the ledger itself does not "sync again": its button opens the
  // import's remaining steps, and nothing moves until "Starta migrering" at
  // the end of them (crm#1118). Visma and Bokio cannot fetch the ledger, so
  // theirs keeps "Synka igen" and the SIE upload above is the way forward.
  // The provider list quotes the same label.
  const continuesImport = (provider: ArcimProvider) => !hasSieImport && sieViaApi(provider)
  const documentRunNeedsReconnect = (provider: ArcimProvider) => {
    const run = connectionStatus?.latestDocumentImport
    return run?.provider === provider && !run.complete && run.needsReconnect === true
  }
  const connectionAction = (provider: ArcimProvider) =>
    continuesImport(provider) ? t('ext_arcim_continue_import') : t('ext_arcim_resync')
  const replacedCopyOffer = isLoadingStatus ? null : replacedCopyUnderlagOffer(connectionStatus, !!hasSieImport)
  const replacedCopyProviderName = replacedCopyOffer
    ? ARCIM_PROVIDERS.find(p => p.id === replacedCopyOffer.provider)?.name ?? replacedCopyOffer.provider
    : ''

  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title={activeConsents.length === 0
          ? 'Välj ditt nuvarande bokföringssystem'
          : hasSieImport
            ? 'Anslut ytterligare system'
            : t('ext_arcim_continue_import_heading')}
        lede="Vi hämtar bokföringsdata via SIE och kunder, leverantörer och fakturor via API:et."
      />

      {/* SIE-required attention (not relevant for Fortnox/Briox: they fetch
          SIE via API): one ochre sentence with the action embedded, never a
          banner. */}
      {showSieRequiredBanner && (
        <AttnLine action={{ label: 'Ladda upp SIE-fil', href: '/import?mode=sie' }}>
          Bokio och Visma hämtar endast kunder, leverantörer och fakturor via API:et: importera
          bokföringsdatan (kontoplan, verifikationer och balanser) via SIE-fil först. Gäller inte
          Fortnox, Briox, Björn Lundén och WINT, där hämtas bokföringen direkt via API:et.
        </AttnLine>
      )}

      {/* Underlag an earlier run left on the copy a re-run migration then
          reversed (#51): the same "Hämta underlag" run links them to the
          live verifikat. Never with the line above: that one needs a ledger
          import still to come, this one an import already there. */}
      {replacedCopyOffer && (
        <AttnLine
          action={{
            label: replacedCopyOffer.reconnect
              ? t('ext_arcim_documents_reconnect_provider', { provider: replacedCopyProviderName })
              : t('ext_arcim_documents_fetch_action'),
            onClick: () =>
              (replacedCopyOffer.reconnect ? (onReconnectDocuments ?? onFetchDocuments) : onFetchDocuments)(
                replacedCopyOffer.consentId,
                replacedCopyOffer.provider,
              ),
          }}
        >
          {t('ext_arcim_documents_on_replaced_copies', { count: replacedCopyOffer.count })}
        </AttnLine>
      )}

      {/* Unfinished connect: one hairline row in the shape of the active
          connections below, with the two ways forward. */}
      {!isLoadingStatus && unfinished && unfinishedInfo && (
        <div className="flex flex-wrap items-center gap-3 border-y border-border py-3 sm:flex-nowrap sm:gap-4">
          <ProviderMark provider={unfinishedInfo.id} name={unfinishedInfo.name} />
          <p className="min-w-0 flex-1 text-sm font-medium">
            {t('ext_arcim_unfinished_connect', { provider: unfinishedInfo.name })}
          </p>
          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
            {unfinishedCanRetry && (
              <Button onClick={() => onSelect(unfinishedInfo.id)}>
                <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
                {t('ext_arcim_unfinished_connect_retry')}
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link href="/import?mode=sie">{t('ext_arcim_unfinished_connect_sie')}</Link>
            </Button>
          </div>
        </div>
      )}

      {/* Existing connections: quiet hairline rows, no cards. Being connected
          is the normal state here, so it reads as muted text, not a chip. */}
      {activeConsents.length > 0 && (
        <section className="space-y-3">
          <SectionKicker>Aktiva anslutningar</SectionKicker>
          <div className="stagger-enter divide-y divide-border" data-no-stagger>
            {activeConsents.map((consent) => {
              const providerInfo = ARCIM_PROVIDERS.find(p => p.id === consent.provider)
              const completedImports = connectionStatus?.sieImports.filter(i => i.status === 'completed') ?? []
              const lastImport = connectionStatus?.latestCompletedSieImport ?? completedImports[0]
              const underlagWaitsForLedger = !hasSieImport && supportsUnderlagImport(consent.provider)

              return (
                <div key={consent.id} className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap sm:gap-4">
                  <ProviderMark
                    provider={consent.provider}
                    name={providerInfo?.name ?? consent.provider}
                    alt={providerInfo?.name ?? consent.provider}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{providerInfo?.name ?? consent.provider}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {consent.companyName && <>{consent.companyName} · </>}
                      {lastImport ? (
                        <>
                          Senaste import {new Date(lastImport.imported_at ?? lastImport.created_at).toLocaleDateString('sv-SE')}
                          {lastImport.transactions_count != null && (
                            <span className="tabular-nums">, {lastImport.transactions_count} verifikationer</span>
                          )}
                        </>
                      ) : (
                        <>Ansluten {consent.createdAt ? new Date(consent.createdAt).toLocaleDateString('sv-SE') : ''}</>
                      )}
                    </p>
                    {(connectionStatus?.entityCounts.customers ?? 0) > 0 && (
                      <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {connectionStatus?.entityCounts.customers} kunder, {connectionStatus?.entityCounts.suppliers} leverantörer, {connectionStatus?.entityCounts.invoices} fakturor
                      </p>
                    )}
                    {/* The outcome of the latest "Hämta underlag" outlives
                        the tab that ran it: a reload used to leave a byrå
                        unable to tell whether every underlag came in. */}
                    {supportsUnderlagImport(consent.provider)
                      && connectionStatus?.latestDocumentImport?.provider === consent.provider && (
                      <DocumentImportRunLine run={connectionStatus.latestDocumentImport} />
                    )}
                    {/* What the stored key is for now (crm#1476): customers
                        asked whether it is still used and whether Accounted
                        can change anything in the source. It only reads. */}
                    {consent.keyUse === 'idle' && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('ext_arcim_key_idle', { provider: providerInfo?.name ?? consent.provider })}
                      </p>
                    )}
                    {(consent.keyUse === 'invoice_rows' || consent.keyUse === 'supplier_rows') && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('ext_arcim_key_in_use_rows', { provider: providerInfo?.name ?? consent.provider })}
                      </p>
                    )}
                    {/* A company still booking in Fortnox after the move
                        tops the imported years up every night. */}
                    {hasSieImport && consent.provider === 'fortnox' && (
                      <FortnoxTopupSwitch
                        consentId={consent.id}
                        initial={connectionStatus?.fortnoxTopup ?? null}
                        onChanged={onTopupChanged}
                      />
                    )}
                    {underlagWaitsForLedger && (
                      <p id={`underlag-after-ledger-${consent.id}`} className="mt-0.5 text-xs text-muted-foreground">
                        {/* Visma and Bokio cannot fetch the ledger: theirs
                            comes in as a SIE file, so the line says so. */}
                        {t(sieViaApi(consent.provider)
                          ? 'ext_arcim_documents_fetch_after_ledger'
                          : 'ext_arcim_documents_fetch_after_sie')}
                      </p>
                    )}
                  </div>
                  {/* Full width on a phone, so the buttons wrap under the name
                      instead of squeezing the date into a column; the
                      disconnect icon then sits beside the name (order-1). */}
                  <div className="order-2 flex w-full shrink-0 flex-wrap items-center gap-2 sm:order-none sm:w-auto sm:flex-nowrap">
                    {/* The underlag offer used to live only in the result step
                        of the run that just finished; closing or reloading
                        lost it. From here it runs on its own, with the same
                        consent, without repeating the migration. Not before
                        a ledger import: underlag link to the imported
                        verifikat by voucher number, so with none there every
                        file comes back unmatched. Until then it stays on the
                        row, disabled and after the row's other button, with
                        a line saying the bookkeeping comes first: a hidden
                        button left customers looking for it. It comes first and filled:
                        customers re-ran the whole migration to get their
                        files (PH 185, PH 180), so the safe way to get more
                        from the source has to be the obvious one, and the
                        re-run says plainly what it is. */}
                    {hasSieImport && supportsUnderlagImport(consent.provider) && (
                      // The latest run stopped because the provider refused
                      // the connection: fetching again would meet the same
                      // refusal, so the one way on is the reconnect (B11).
                      documentRunNeedsReconnect(consent.provider) ? (
                        <Button
                          onClick={() => (onReconnectDocuments ?? onFetchDocuments)(consent.id, consent.provider)}
                        >
                          <ArrowPathIcon className="h-3.5 w-3.5" />
                          {t('ext_arcim_documents_reconnect_provider', { provider: providerInfo?.name ?? consent.provider })}
                        </Button>
                      ) : (
                        <Button
                          onClick={() => onFetchDocuments(consent.id, consent.provider)}
                        >
                          <PaperClipIcon className="h-3.5 w-3.5" />
                          {t('ext_arcim_documents_fetch_action')}
                        </Button>
                      )
                    )}
                    {continuesImport(consent.provider) ? (
                      <Button onClick={() => onResync(consent.provider, consent.id)}>
                        {connectionAction(consent.provider)}
                        <ArrowRightIcon className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => onResync(consent.provider, consent.id)}
                      >
                        <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
                        {connectionAction(consent.provider)}
                      </Button>
                    )}
                    {underlagWaitsForLedger && (
                      <Button
                        variant="outline"
                        disabled
                        aria-describedby={`underlag-after-ledger-${consent.id}`}
                      >
                        <PaperClipIcon className="h-3.5 w-3.5" />
                        {t('ext_arcim_documents_fetch_action')}
                      </Button>
                    )}
                    {/* A key nothing needs any more gets a named way out
                        instead of the bare icon below. */}
                    {consent.keyUse === 'idle' && (
                      <Button variant="outline" onClick={() => onDisconnect(consent.id)}>
                        <TrashIcon className="h-3.5 w-3.5" />
                        {t('ext_arcim_key_remove')}
                      </Button>
                    )}
                  </div>
                  {consent.keyUse !== 'idle' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="order-1 shrink-0 self-start text-muted-foreground hover:text-destructive sm:order-none sm:self-auto"
                      aria-label={`Koppla från ${providerInfo?.name ?? consent.provider}`}
                      onClick={() => onDisconnect(consent.id)}
                    >
                      <XCircleIcon className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Provider selection: quiet list rows on the page, hairline-divided. */}
      {isLoadingStatus ? (
        <LateReveal className="divide-y divide-border">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 py-3">
              <Skeleton className="h-8 w-8 shrink-0 rounded-sm" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </LateReveal>
      ) : (
        <div className="stagger-enter divide-y divide-border" data-no-stagger>
          {offeredProviders(connectionStatus).map((provider) => {
            const comingSoon = COMING_SOON_PROVIDERS.has(provider.id)
            const alreadyConnected = activeConsents.some(c => c.provider === provider.id)
            // Providers without SIE-over-API only expose entity data
            // (customers, suppliers, invoices): the ledger must arrive via
            // SIE upload first. Gate the connection entry until a completed
            // SIE import exists so users don't authenticate into a flow that
            // can't import anything yet. The /migrate route enforces this
            // server-side regardless; this is just the matching UX. Never
            // gate on a status that has not arrived yet (same guard as the
            // banner above).
            const needsSieFirst = !isLoadingStatus && !hasSieImport && !provider.sieViaApi
            const isDisabled = comingSoon || alreadyConnected || needsSieFirst
            return (
              <button
                key={provider.id}
                type="button"
                disabled={isDisabled}
                className={cn(
                  'group flex w-full items-center gap-4 py-3 text-left transition-colors duration-150',
                  isDisabled
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-secondary/35'
                )}
                onClick={() => !isDisabled && onSelect(provider.id)}
              >
                <ProviderMark provider={provider.id} name={provider.name} alt={provider.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{provider.name}</p>
                    {comingSoon && (
                      <Badge variant="secondary">Kommer snart</Badge>
                    )}
                    {alreadyConnected && (
                      <span className="text-xs text-muted-foreground">Ansluten</span>
                    )}
                    {needsSieFirst && !comingSoon && !alreadyConnected && (
                      <Badge variant="warning">SIE krävs först</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {/* Points at the row above, not at its re-run: that
                        pointer is how customers ended up re-running the
                        migration to fetch files. */}
                    {alreadyConnected
                      ? continuesImport(provider.id)
                        ? t('ext_arcim_use_action_above', { action: connectionAction(provider.id) })
                        : t('ext_arcim_connected_above')
                      : needsSieFirst
                        ? 'Importera SIE-fil först'
                        : provider.authType === 'oauth'
                          ? 'Anslut via inloggning'
                          : provider.id === 'bjornlunden'
                            ? 'Anslut med företagsnyckel'
                            : 'Anslut med API-nyckel'}
                  </p>
                </div>
                {!isDisabled && (
                  <ChevronRightIcon
                    className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Connect step (OAuth redirect or token input) ────────────────

function ConnectStep({
  provider,
  authType,
  isLoading,
  error,
  authUrl,
  activationUrl,
  consentId,
  onOpenProviderWindow,
  onTokenSubmit,
  onBack,
}: {
  provider: ArcimProvider
  authType: 'oauth' | 'token' | null
  isLoading: boolean
  error: string | null
  authUrl: string | null
  /** Björn Lundén only: Lundify's activation redirect, when BL issued us a key. */
  activationUrl: string | null
  consentId: string | null
  /** Opens the provider login (or Lundify activation) popup: the parent owns
   *  it so the click and its outcome can be counted. */
  onOpenProviderWindow: (url: string) => void
  onTokenSubmit: (apiToken: string, companyId: string) => void
  onBack: () => void
}) {
  const t = useTranslations('extensions')
  const providerName = ARCIM_PROVIDERS.find(p => p.id === provider)?.name ?? provider
  // What the provider requires before its login can succeed, shown before the
  // click instead of only after a failure. Wording follows the error registry
  // (PROVIDER_LICENSE_MISSING, PROVIDER_API_MODULE_INACTIVE).
  const requirement = provider === 'fortnox'
    ? t('ext_arcim_requirement_fortnox')
    : provider === 'visma'
      ? t('ext_arcim_requirement_visma')
      : null
  const [apiToken, setApiToken] = useState('')
  const [companyId, setCompanyId] = useState('')
  // With the Lundify redirect on offer, the User-Key field is the fallback for
  // a customer who activated inside Lundify already, so it starts folded.
  const [showManualKey, setShowManualKey] = useState(false)

  // BL uses server-side client credentials: only needs company ID, no API key
  const isClientCredentials = provider === 'bjornlunden'
  const hasLundifyActivation = isClientCredentials && !!activationUrl
  const manualKeyVisible = !hasLundifyActivation || showManualKey

  // WINT has no API keys: the "token" is the user's WINT login (e-post +
  // lösenord), exchanged server-side for ett tokenpar; lösenordet sparas aldrig.
  const isWintLogin = provider === 'wint'
  // The fields come from the catalog rule /submit-token checks. Briox: the
  // account ID is the `clientid` half of the token exchange; WINT reuses the
  // company field for the login e-mail.
  const { secret: needsApiToken, companyId: needsCompanyId } = tokenCredentials(provider)
  const companyIdLabel = provider === 'briox'
    ? 'Konto-ID'
    : provider === 'bjornlunden'
      ? 'Företagsnyckel (User-Key)'
      : provider === 'wint'
        ? 'E-postadress'
        : provider === 'bokio'
          ? t('ext_arcim_bokio_company_id_label')
          : 'Företags-ID'

  const tokenDescription = hasLundifyActivation
    ? t('ext_arcim_bl_activate_description', { appName: branding.appName })
    : isClientCredentials
    ? t('ext_arcim_bl_token_description', { appName: branding.appName })
    : isWintLogin
      ? `Logga in med dina WINT-uppgifter för att ge ${branding.appName.toLowerCase()} tillgång att läsa din bokföringsdata. Lösenordet används en gång för att skapa anslutningen och sparas aldrig.`
      : provider === 'briox'
        ? `Ange ditt konto-ID och din applikationstoken från Briox för att ge ${branding.appName.toLowerCase()} tillgång att läsa din bokföringsdata.`
        : provider === 'bokio'
          ? t('ext_arcim_bokio_token_description', {
              appName: branding.appName.toLowerCase(),
            })
        : `Ange din API-nyckel från ${providerName} för att ge ${branding.appName.toLowerCase()} tillgång att läsa din bokföringsdata.`

  const tokenHelpText = isClientCredentials
    ? t('ext_arcim_bl_token_help')
    : isWintLogin
      ? `Använd samma e-postadress och lösenord som när du loggar in på app.wint.se. Kräver ditt WINT-konto BankID-inloggning kan anslutningen inte skapas ännu: be i så fall WINT om en SIE-fil och importera den manuellt.`
      : provider === 'bokio'
      ? t('ext_arcim_bokio_token_help')
      : provider === 'briox'
        ? `Skapa din applikationstoken i Briox under Admin \u2192 Anv\u00e4ndare \u2192 kugghjulet vid din anv\u00e4ndare \u2192 Applikationstoken. Ditt konto-ID \u00e4r det l\u00e5nga numret inom parentes bredvid f\u00f6retagsnamnet under "Ditt konto" i menyn till h\u00f6ger.`
        : `Du hittar din applikationstoken i ${providerName} under Administration \u2192 Integrationer.`

  const canSubmit = missingTokenCredential(provider, { apiToken, companyId }) === null

  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title={`Anslut till ${providerName}`}
        lede={authType === 'token'
          ? tokenDescription
          : `Logga in i ${providerName} för att ge ${branding.appName.toLowerCase()} tillgång att läsa din bokföringsdata.`}
      />

      {isLoading && <SpinnerLine>Förbereder anslutning...</SpinnerLine>}

      {error && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-destructive">Anslutning misslyckades</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      )}

      {/* OAuth flow */}
      {authType === 'oauth' && authUrl && !isLoading && (
        <div className="space-y-4">
          {requirement && <p className="text-sm">{requirement}</p>}
          <p className="text-sm text-muted-foreground">
            Klicka nedan för att logga in i {providerName}.
            Fönstret stängs automatiskt när du är klar.
          </p>
          <Button onClick={() => onOpenProviderWindow(authUrl)}>
            Logga in i {providerName}
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Björn Lundén: Lundify's activation redirect returns the User-Key
          itself. The popup posts arcim-oauth-success like the OAuth
          providers, so the same listener resumes the wizard. */}
      {authType === 'token' && consentId && !isLoading && hasLundifyActivation && activationUrl && (
        <div className="space-y-4">
          <Button onClick={() => onOpenProviderWindow(activationUrl)}>
            {t('ext_arcim_bl_activate_button')}
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          </Button>
          {!showManualKey && (
            <Button
              variant="link"
              className="h-auto px-0 text-sm text-muted-foreground"
              onClick={() => setShowManualKey(true)}
            >
              {t('ext_arcim_bl_manual_key_toggle')}
            </Button>
          )}
        </div>
      )}

      {/* Token-based flow */}
      {authType === 'token' && consentId && !isLoading && manualKeyVisible && (
        <div className="max-w-md space-y-4">
          <p className="text-sm text-muted-foreground">
            {tokenHelpText}
          </p>
          {/* WINT is a login form: e-mail reads above password (CSS order;
              the button keeps its place). Other token providers keep
              token-first order. */}
          <div className={cn('space-y-3', isWintLogin && 'flex flex-col gap-3 space-y-0')}>
            {needsApiToken && (
              <div className={cn(isWintLogin && 'order-2')}>
                <label htmlFor="apiToken" className="text-sm font-medium">
                  {provider === 'briox'
                    ? 'Applikationstoken'
                    : isWintLogin
                      ? 'Lösenord'
                      : provider === 'bokio'
                        ? t('ext_arcim_bokio_token_label')
                        : 'API-nyckel'}
                </label>
                <Input
                  id="apiToken"
                  name="apiToken_nocomplete"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    provider === 'briox'
                      ? 'Klistra in din applikationstoken'
                      : isWintLogin
                        ? 'Ditt lösenord hos WINT'
                        : provider === 'bokio'
                          ? t('ext_arcim_bokio_token_placeholder')
                        : 'Klistra in din API-nyckel'
                  }
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                />
              </div>
            )}
            {needsCompanyId && (
              <div className={cn(isWintLogin && 'order-1')}>
                <label htmlFor="companyId" className="text-sm font-medium">
                  {companyIdLabel}
                </label>
                <Input
                  id="companyId"
                  name="companyId_nocomplete"
                  type={isWintLogin ? 'email' : 'text'}
                  autoComplete="new-password"
                  placeholder={
                    isClientCredentials
                      ? 'Företagsnyckel, t.ex. 1f0e2d3c-4b5a-...'
                      : provider === 'briox'
                        ? 'Det långa numret inom parentes, t.ex. 35649125'
                        : isWintLogin
                          ? 'namn@foretaget.se'
                          : 'GUID från URL:en, t.ex. 14ccad83-67f6-49bd-...'
                  }
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                />
              </div>
            )}
            <Button
              className={cn(isWintLogin && 'order-3')}
              onClick={() => onTokenSubmit(apiToken, companyId)}
              disabled={!canSubmit}
            >
              Anslut
              <ArrowRightIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* The manual route is offered up front, not only after a failure:
          most customers whose connect stalled never saw it. */}
      <SieFallbackLine message="Du kan också importera din bokföringsdata manuellt via en SIE-fil." />

      <div className="flex border-t-hairline pt-6">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeftIcon className="h-4 w-4" />
          Tillbaka
        </Button>
      </div>
    </div>
  )
}

// ── Preview step ────────────────────────────────────────────────

/**
 * What a failed SIE fetch asks of the user: the sentence that names the cause
 * (ext_arcim_sie_error_<kind>, or for a permission the user-right sentence
 * every refusal shares), the one action, and where a SIE file would
 * come from (null where reconnecting is the whole fix). The classification is
 * the server's (classifyProviderError, the same one /sie-data and the
 * migration job use); this only picks the remedy for it.
 */
export interface SieErrorRemedy {
  kind: 'reconnect' | 'permission' | 'module' | 'license' | 'rate_limited' | 'unavailable' | 'failed'
  action: 'reconnect' | 'retry'
  file: 'provider' | 'elsewhere' | null
}

export function sieErrorRemedy(sieError: SieFetchFailure): SieErrorRemedy {
  switch (sieError.code) {
    case 'PROVIDER_AUTH_EXPIRED':
      return { kind: 'reconnect', action: 'reconnect', file: null }
    case 'PROVIDER_RESOURCE_FORBIDDEN':
      // Fortnox 2001101: the plan lacks Bokföring. A company that keeps its
      // books in another program has no ledger here, so its file comes from
      // that program, not from the provider.
      return sieError.reason === 'license'
        ? { kind: 'module', action: 'retry', file: 'elsewhere' }
        : { kind: 'permission', action: 'reconnect', file: 'provider' }
    case 'PROVIDER_LICENSE_MISSING':
    case 'PROVIDER_API_MODULE_INACTIVE':
      return { kind: 'license', action: 'retry', file: 'provider' }
    case 'PROVIDER_RATE_LIMITED':
      return { kind: 'rate_limited', action: 'retry', file: 'provider' }
    case 'PROVIDER_UPSTREAM_ERROR':
    case 'PROVIDER_UNREACHABLE':
      return { kind: 'unavailable', action: 'retry', file: 'provider' }
    default:
      // PROVIDER_SIE_FETCH_FAILED: a timeout, an empty export, an error the
      // classifier has no class for. Nothing says it will pass, so the
      // sentence does not promise that it is temporary.
      return { kind: 'failed', action: 'retry', file: 'provider' }
  }
}

/**
 * A provider that serves SIE over the API did not hand the bookkeeping over:
 * the cause and the way forward, in place of "SIE-import krävs", which asked
 * for a file the provider can serve (crm#1118). The SIE upload stays on offer
 * as the way around, except after an expired connection, where reconnecting
 * is the whole fix (as in the error block above).
 */
function SieFetchErrorNotice({
  sieError,
  providerName,
  onReconnect,
  onRetry,
}: {
  sieError: SieFetchFailure
  providerName: string
  onReconnect: () => void
  onRetry: () => void
}) {
  const t = useTranslations('extensions')
  const { kind, action, file } = sieErrorRemedy(sieError)
  return (
    <div className="animate-fade-in space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-destructive">
          {t('ext_arcim_sie_error_title', { provider: providerName })}
        </p>
        <p className="text-sm text-muted-foreground">
          {kind === 'permission'
            ? t(USER_RIGHT_REFUSAL_MESSAGE_KEY, { provider: providerName, what: t('ext_arcim_refused_what_bookkeeping') })
            : t(`ext_arcim_sie_error_${kind}`, { provider: providerName })}
        </p>
      </div>
      {action === 'reconnect' ? (
        <Button onClick={onReconnect}>
          <ArrowUturnLeftIcon className="h-4 w-4" />
          {t('ext_arcim_sie_error_reconnect_action', { provider: providerName })}
        </Button>
      ) : (
        <Button onClick={onRetry}>
          <ArrowPathIcon className="h-4 w-4" />
          {t('ext_arcim_sie_error_retry_action')}
        </Button>
      )}
      {file && (
        <SieFallbackLine
          message={t(file === 'elsewhere' ? 'ext_arcim_sie_error_file_elsewhere' : 'ext_arcim_sie_error_file', {
            provider: providerName,
          })}
          label={t('ext_arcim_sie_error_file_link')}
        />
      )}
    </div>
  )
}

export function PreviewStep({
  preview,
  isLoading,
  error,
  authExpired,
  licenseMissing,
  selectedYears,
  onSelectedYearsChange,
  onReconnect,
  onRetry,
  onContinue,
  onBack,
}: {
  preview: PreviewData | null
  isLoading: boolean
  error: string | null
  authExpired: boolean
  licenseMissing: boolean
  /** Fiscal years (start years) ticked in the picker; default = the three latest. */
  selectedYears: number[]
  onSelectedYearsChange: (years: number[]) => void
  onReconnect: () => void
  /** Load the preview again: the way forward after a passing provider failure. */
  onRetry: () => void
  onContinue: () => void
  onBack: () => void
}) {
  const t = useTranslations('extensions')
  const fiscalYearSpanLabel = useFiscalYearSpanLabel()
  const providerName = preview
    ? ARCIM_PROVIDERS.find(p => p.id === preview.consent.provider)?.name ?? preview.consent.provider
    : ''
  const sourceYears = preview?.sieAvailable ? preview.sourceYears ?? [] : []
  const showYearPicker = sourceYears.length > 0 && !isLoading
  const maxSelectable = preview?.maxSelectedYears ?? null
  const selectionProblem = showYearPicker ? fiscalYearSelectionProblem(selectedYears, maxSelectable) : null
  const noYearSelected = selectionProblem === 'none'
  const tooManySelected = selectionProblem === 'too_many'
  const toggleYear = (year: number) => onSelectedYearsChange(toggleFiscalYear(selectedYears, year))

  return (
    <div className="stagger-enter space-y-8">
      <div>
        <h2 className="text-xl text-balance">
          {preview ? `Anslutet till ${providerName}` : 'Förhandsgranskning'}
        </h2>

        {isLoading && (
          <div className="mt-3">
            <SpinnerLine>Hämtar bokföringsdata...</SpinnerLine>
          </div>
        )}

        {/* SIE + asset stats: one quiet statline, the same grammar as the
            import reveal, instead of a boxed summary. It speaks for the
            ticked years (crm#1037): the account and voucher counts were read
            from the default years only, so they show while exactly those
            years are ticked; any other selection names its years and says
            the counts come when the years are fetched. The asset count
            renders on its own when the SIE fetch failed: the preview
            endpoint sets them independently. */}
        {(() => {
          const parts: string[] = []
          if (preview?.sieAvailable && selectedYears.length > 0) {
            const counts = previewCountsForSelection(preview.sieStats, selectedYears)
            if (counts) {
              parts.push(t('ext_arcim_preview_accounts', { count: counts.accounts }))
              parts.push(t('ext_arcim_preview_vouchers', { count: counts.vouchers }))
            }
            parts.push(t('ext_arcim_preview_years', { count: selectedYears.length, years: selectedYears.join(', ') }))
            if (!counts) parts.push(t('ext_arcim_preview_counted_on_fetch'))
          }
          const assetCount = preview?.assetStats?.importable ?? 0
          if (assetCount > 0) {
            parts.push(t('ext_arcim_preview_assets', { count: assetCount }))
          }
          if (parts.length === 0) return null
          return (
            <p className="animate-fade-in mt-3 text-[13px] text-muted-foreground tabular-nums">
              {parts.join(' · ')}
            </p>
          )
        })()}

        {preview && !preview.sieAvailable && !isLoading && preview.hasSieData && (
          <p className="animate-fade-in mt-3 text-[13px] text-muted-foreground">
            Bokföringsdatan är redan importerad via SIE-fil. Du kan fortsätta med att importera
            kunder, leverantörer och fakturor.
          </p>
        )}
      </div>

      {/* ── The year picker (issues #2211, #2238) ──
          Every fiscal year the source has, as hairline rows with a checkbox.
          The three latest are ticked by default (the limit that used to be a
          silent cap); older years are the user's own choice and their own
          wait: each one is another SIE export fetched in the next step. A
          history longer than one run starts from the oldest years instead
          (defaultFiscalYearSelection, crm#1686). */}
      {showYearPicker && (
        <section className="space-y-3">
          <SectionKicker>{t('ext_arcim_year_select_kicker')}</SectionKicker>
          <p className="text-[13px] text-muted-foreground">
            {needsSeveralRuns(sourceYears, maxSelectable)
              ? t('ext_arcim_year_select_oldest_first', { max: maxSelectable ?? 0 })
              : t('ext_arcim_year_select_lede')}
          </p>
          <div className="stagger-enter divide-y divide-border" data-no-stagger>
            {sourceYears.map((fy) => {
              const id = `arcim-year-${fy.year}-${fy.fromDate ?? ''}`
              return (
                <label
                  key={id}
                  htmlFor={id}
                  className="flex min-h-10 cursor-pointer items-center gap-3 py-2 text-sm transition-colors duration-150 hover:bg-secondary/35"
                >
                  <Checkbox
                    id={id}
                    checked={selectedYears.includes(fy.year)}
                    onCheckedChange={() => toggleYear(fy.year)}
                    aria-label={fiscalYearSpanLabel(fy)}
                  />
                  <span className="tabular-nums">{fiscalYearSpanLabel(fy)}</span>
                  {!fy.inDefaultSelection && (
                    <span className="text-xs text-muted-foreground">{t('ext_arcim_year_select_older')}</span>
                  )}
                </label>
              )
            })}
          </div>
          {noYearSelected && <AttnLine>{t('ext_arcim_year_select_none')}</AttnLine>}
          {tooManySelected && maxSelectable != null && (
            <AttnLine>{t('ext_arcim_year_select_too_many', { max: maxSelectable })}</AttnLine>
          )}
        </section>
      )}

      {error && (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">Kunde inte hämta bokföringsdata</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          {authExpired && (
            <Button onClick={onReconnect} disabled={isLoading}>
              <ArrowUturnLeftIcon className="h-4 w-4" />
              Återanslut {providerName}
            </Button>
          )}
          {/* License-missing keeps the SIE fallback visible: re-auth loops
              until the customer re-orders the Fortnox Integration license,
              so a manual SIE import is the reliable escape hatch. */}
          {(!authExpired || licenseMissing) && (
            <SieFallbackLine message="Du kan också importera din bokföringsdata manuellt via en SIE-fil." />
          )}
        </div>
      )}

      {/* A failed preview reload keeps the previous preview in state: the
          error block above speaks for it then. */}
      {preview?.sieError && !isLoading && !error && (
        <SieFetchErrorNotice
          sieError={preview.sieError}
          providerName={providerName}
          onReconnect={onReconnect}
          onRetry={onRetry}
        />
      )}

      {preview && !preview.sieAvailable && !preview.sieError && !isLoading && !preview.hasSieData && (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">SIE-import krävs</p>
            <p className="text-sm text-muted-foreground">
              Bokföringsdata (kontoplan, verifikationer och balanser) måste importeras via SIE-fil innan kunder, leverantörer och fakturor kan hämtas. Exportera en SIE-fil från {ARCIM_PROVIDERS.find(p => p.id === preview.consent.provider)?.name ?? 'ditt bokföringssystem'} och ladda upp den i {branding.appName.toLowerCase()}.
            </p>
          </div>
          <SieFallbackLine message="När filen är exporterad:" label="Gå till SIE-importen" />
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 border-t-hairline pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeftIcon className="h-4 w-4" />
          Tillbaka
        </Button>
        <Button
          onClick={onContinue}
          disabled={isLoading || noYearSelected || tooManySelected || (!!preview && !preview.sieAvailable && !preview.hasSieData)}
        >
          Fortsätt
          <ArrowRightIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

// ── Mapping step (wraps AccountMappingStep) ─────────────────────

function MappingStep({
  sieData,
  isLoading,
  error,
  errorDetails,
  onMappingChange,
  onVatTreatmentChange,
  onConfirmAllVatTreatments,
  onContinue,
  onBack,
}: {
  sieData: SIEData | null
  isLoading: boolean
  error: string | null
  errorDetails: string[] | null
  onMappingChange: (sourceAccount: string, targetAccount: string, targetName: string) => void
  onVatTreatmentChange: (
    sourceAccount: string,
    treatment: AccountVatTreatment | null,
    rate: number | null,
  ) => void
  onConfirmAllVatTreatments: () => void
  onContinue: () => void
  onBack: () => void
}) {
  if (isLoading) {
    return <SpinnerLine>Analyserar bokföringsdata och förbereder kontomappning...</SpinnerLine>
  }

  if (error) {
    return (
      <div className="stagger-enter space-y-8">
        <div className="space-y-1">
          <p className="text-sm font-medium text-destructive">Kunde inte ladda SIE-data</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          {errorDetails && errorDetails.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              {errorDetails.slice(0, 8).map((detail, i) => (
                <li key={i} className="break-words">{detail}</li>
              ))}
              {errorDetails.length > 8 && (
                <li>… och {errorDetails.length - 8} fel till</li>
              )}
            </ul>
          )}
        </div>
        <SieFallbackLine message="Om problemet kvarstår kan du importera din SIE-fil manuellt istället." />
        <div className="flex border-t-hairline pt-6">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeftIcon className="h-4 w-4" />
            Tillbaka
          </Button>
        </div>
      </div>
    )
  }

  if (!sieData) return null

  return (
    <AccountMappingStep
      mappings={sieData.mappings}
      basAccounts={sieData.basAccounts}
      onMappingChange={onMappingChange}
      onVatTreatmentChange={onVatTreatmentChange}
      onConfirmAllVatTreatments={onConfirmAllVatTreatments}
      onContinue={onContinue}
      onBack={onBack}
    />
  )
}

// ── Options step ────────────────────────────────────────────────

export function OptionsStep({
  options,
  sieAvailable,
  sieData,
  hasSieData,
  provider,
  isStarting,
  onChange,
  onStart,
  onBack,
}: {
  options: MigrationOptions
  sieAvailable: boolean
  sieData: SIEData | null
  /** The company already has a completed SIE import (any origin). */
  hasSieData: boolean
  provider: ArcimProvider | null
  /** A run is in flight: the submit stays disabled until it settles. */
  isStarting: boolean
  onChange: (options: MigrationOptions) => void
  onStart: () => void
  onBack: () => void
}) {
  const t = useTranslations('extensions')
  const [showConfirm, setShowConfirm] = useState(false)

  const toggleOption = (key: keyof MigrationOptions) => {
    onChange({ ...options, [key]: !options[key] })
  }

  const fileStatuses = sieData?.fileStatuses ?? []
  const newFileCount = fileStatuses.filter(fs => !fs.previousImport).length
  // Years a completed import already holds: kept as they are unless the
  // user ticks one to import it again (PH 185, PH 180).
  const importedYears = fileStatuses.filter(fs => fs.previousImport).map(fs => fs.fiscalYear)
  const yearsToReplace = importedYears.filter(year => options.replaceImportedYears.includes(year))
  const yearsKept = importedYears.filter(year => !options.replaceImportedYears.includes(year))
  // Without a fetched file list (no SIE data yet) the toggle alone decides.
  const importsLedger = fileStatuses.length > 0
    ? sieFilesToImport(fileStatuses, options).length > 0
    : options.importSIEData
  const failedYears = sieData?.failedYears ?? []
  const unusedAccountCount = sieData?.preview?.unusedAccounts?.length ?? 0

  const toggleReplaceYear = (year: number) => {
    onChange({
      ...options,
      replaceImportedYears: options.replaceImportedYears.includes(year)
        ? options.replaceImportedYears.filter(y => y !== year)
        : [...options.replaceImportedYears, year],
    })
  }

  const selectedItems: string[] = []
  if (options.importCompanyInfo) selectedItems.push('Företagsinformation')
  if (sieAvailable && importsLedger) selectedItems.push('Bokföringsdata (SIE)')
  if (options.importCustomers) selectedItems.push('Kunder')
  if (options.importSuppliers) selectedItems.push('Leverantörer')
  if (options.importSalesInvoices) selectedItems.push('Kundfakturor')
  if (options.importSupplierInvoices) selectedItems.push('Leverantörsfakturor')
  if (provider === 'fortnox' && options.importAssets) selectedItems.push('Anläggningstillgångar')

  // Entities without the SIE-derived ledger leave an incomplete bokföring:
  // POST /migrate refuses with PROVIDER_SIE_IMPORT_REQUIRED unless a completed
  // SIE import exists. Say so here, before the run, when the user has
  // unchecked SIE for a company that has never imported it (#2000).
  // Company info (name, org number, VAT number) writes no ledger data and is
  // not gated, matching the route.
  const hasApiImport = options.importCustomers ||
    options.importSuppliers ||
    options.importSalesInvoices ||
    options.importSupplierInvoices
  const sieRequiredButUnchecked = sieAvailable && !options.importSIEData && !hasSieData && hasApiImport

  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title="Vad vill du importera?"
        lede="Bokföringsdata importeras via SIE-fil. Kunder, leverantörer och fakturor hämtas via API:et."
      />

      {/* Years whose provider export failed: must be visible before the user
          proceeds, otherwise an IB/UB gap slips through. One ochre sentence.
          Yields to the SIE-required line below: with SIE unchecked no year is
          imported, and the page carries at most one attn line. */}
      {sieAvailable && failedYears.length > 0 && !sieRequiredButUnchecked && (
        <AttnLine>
          {failedYears.length === 1
            ? `Räkenskapsår ${failedYears[0].year} kunde inte hämtas från källsystemet: om du fortsätter importeras övriga år, men ingående och utgående balanser kan sakna kontinuitet. Försök igen senare eller ladda upp en SIE-fil för det saknade året manuellt.`
            : `Räkenskapsår ${failedYears.map(f => f.year).join(', ')} kunde inte hämtas från källsystemet: om du fortsätter importeras övriga år, men ingående och utgående balanser kan sakna kontinuitet. Försök igen senare eller ladda upp SIE-filer för de saknade åren manuellt.`}
        </AttnLine>
      )}

      {/* Clean hairline rows with the toggle on the right: no bordered box
          per row, no nested boxes. */}
      <div className="stagger-enter divide-y divide-border" data-no-stagger>
        <OptionRow
          label="Företagsinformation"
          description="Namn, organisationsnummer, adress"
          checked={options.importCompanyInfo}
          onChange={() => toggleOption('importCompanyInfo')}
        />

        {sieAvailable && (
          <div>
            {/* The toggle covers the new years. With none, there is nothing
                for it to import: an already imported year is only imported
                again through its own checkbox below, and the row then says
                so (on, still locked). Left off with "every year is already
                imported", a ticked year read as not taken, and people
                ticked it on and off again. */}
            <OptionRow
              label="Bokföringsdata (SIE)"
              description={
                fileStatuses.length === 0
                  ? 'Kontoplan, ingående balanser och verifikationer'
                  : newFileCount === 0
                    ? yearsToReplace.length > 0
                      ? t('ext_arcim_option_sie_desc_replacing', { count: yearsToReplace.length })
                      : t('ext_arcim_option_sie_desc_all_kept')
                    : importedYears.length > 0
                      ? t('ext_arcim_option_sie_desc_new_and_kept', { newCount: newFileCount, keptCount: importedYears.length })
                      : t('ext_arcim_option_sie_desc_new', { count: newFileCount })
              }
              checked={fileStatuses.length > 0 && newFileCount === 0 ? yearsToReplace.length > 0 : options.importSIEData}
              disabled={fileStatuses.length > 0 && newFileCount === 0}
              onChange={() => toggleOption('importSIEData')}
            />
            {/* Per-file import status: quiet muted lines. A year that is
                already imported is kept unless its box is ticked: importing
                it again makulerar the earlier import's verifikat. */}
            {fileStatuses.length > 0 && (
              <div className="space-y-1 pb-3">
                {fileStatuses.map((fs) => fs.previousImport ? (
                  <label
                    key={fs.fiscalYear}
                    htmlFor={`arcim-replace-year-${fs.fiscalYear}`}
                    className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground tabular-nums"
                  >
                    <Checkbox
                      id={`arcim-replace-year-${fs.fiscalYear}`}
                      checked={options.replaceImportedYears.includes(fs.fiscalYear)}
                      onCheckedChange={() => toggleReplaceYear(fs.fiscalYear)}
                    />
                    <span>
                      {options.replaceImportedYears.includes(fs.fiscalYear)
                        ? t('ext_arcim_option_sie_year_replacing', { year: fs.fiscalYear })
                        : t('ext_arcim_option_sie_year_kept', { year: fs.fiscalYear })}
                    </span>
                  </label>
                ) : (
                  <p key={fs.fiscalYear} className="text-xs text-muted-foreground tabular-nums">
                    {t('ext_arcim_option_sie_year_new', { year: fs.fiscalYear })}
                  </p>
                ))}
                {importedYears.length > 0 && (
                  <p className="pt-1 text-xs text-muted-foreground">{t('ext_arcim_option_sie_replace_help')}</p>
                )}
              </div>
            )}
            {/* Verifikationsserie: one aligned row, not a nested box. */}
            {importsLedger && (
              <div className="flex items-center gap-3 border-t-hairline py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Verifikationsserie</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('ext_arcim_option_series_help')}</p>
                </div>
                <Input
                  className="w-16 text-center"
                  aria-label="Verifikationsserie"
                  value={options.voucherSeries}
                  onChange={(e) => onChange({ ...options, voucherSeries: e.target.value.toUpperCase() || 'B' })}
                  maxLength={2}
                />
              </div>
            )}
            {/* #63: the source system's export carries its whole chart. */}
            {importsLedger && unusedAccountCount > 0 && (
              <div className="border-t-hairline">
                <OptionRow
                  label={t('ext_arcim_option_only_used_accounts')}
                  description={t('ext_arcim_option_only_used_accounts_desc', { count: unusedAccountCount })}
                  checked={options.onlyUsedAccounts}
                  onChange={() => toggleOption('onlyUsedAccounts')}
                />
              </div>
            )}
          </div>
        )}

        <OptionRow
          label="Kunder"
          description="Kund-register med kontaktuppgifter"
          checked={options.importCustomers}
          onChange={() => toggleOption('importCustomers')}
        />
        <OptionRow
          label="Leverantörer"
          description="Leverantör-register med bankuppgifter"
          checked={options.importSuppliers}
          onChange={() => toggleOption('importSuppliers')}
        />
        <OptionRow
          label="Kundfakturor"
          description="Alla kundfakturor (betalda och obetalda)"
          checked={options.importSalesInvoices}
          onChange={() => toggleOption('importSalesInvoices')}
        />
        <div>
          <OptionRow
            label="Leverantörsfakturor"
            description={provider === 'fortnox'
              ? t('ext_arcim_supplier_invoices_unpaid_only')
              : 'Alla leverantörsfakturor (betalda och obetalda)'}
            checked={options.importSupplierInvoices}
            onChange={() => toggleOption('importSupplierInvoices')}
          />
          {/* Deliberately quiet: the paid ones are already in the ledger as
              verifikat, and listing them costs one Fortnox call each. For a
              member who wants the whole register, e.g. when leaving Fortnox. */}
          {provider === 'fortnox' && options.importSupplierInvoices && (
            <label
              htmlFor="arcim-paid-supplier-invoices"
              className="flex cursor-pointer items-center gap-2 pb-3 text-xs text-muted-foreground"
            >
              <Checkbox
                id="arcim-paid-supplier-invoices"
                checked={options.importPaidSupplierInvoices}
                onCheckedChange={() => toggleOption('importPaidSupplierInvoices')}
              />
              <span>{t('ext_arcim_supplier_invoices_include_paid')}</span>
            </label>
          )}
        </div>
        {provider === 'fortnox' && (
          <OptionRow
            label="Anläggningstillgångar"
            description="Anläggningsregistret med avskrivningsplaner. Bokförda värden kommer via SIE; registret gör att avskrivningarna fortsätter automatiskt."
            checked={options.importAssets}
            onChange={() => toggleOption('importAssets')}
          />
        )}
      </div>

      {sieRequiredButUnchecked && (
        <AttnLine>{t('ext_arcim_option_sie_required_hint')}</AttnLine>
      )}

      <div className="flex flex-col-reverse gap-3 border-t-hairline pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeftIcon className="h-4 w-4" />
          Tillbaka
        </Button>
        <Button onClick={() => setShowConfirm(true)} disabled={selectedItems.length === 0 || sieRequiredButUnchecked || isStarting}>
          Starta migrering
          <ArrowRightIcon className="h-4 w-4" />
        </Button>
      </div>

      <ConfirmationDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        onConfirm={() => {
          setShowConfirm(false)
          onStart()
        }}
        isSubmitting={isStarting}
        title="Starta migrering"
        confirmLabel="Starta migrering"
      >
        {/* One sentence naming what happens, the selection as a compact muted
            line list. The one consequence spelled out in full text is a year
            ticked to be imported again: its earlier verifikat are makulerade. */}
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm">
              Det här hämtas från källsystemet och importeras till {branding.appName.toLowerCase()}:
            </p>
            <ul className="space-y-1">
              {selectedItems.map((item) => (
                <li key={item} className="text-sm text-muted-foreground">{item}</li>
              ))}
            </ul>
          </div>

          {sieAvailable && yearsKept.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('ext_arcim_confirm_sie_kept', { count: yearsKept.length, years: yearsKept.join(', ') })}
            </p>
          )}

          {sieAvailable && yearsToReplace.length > 0 && (
            <p className="text-sm">
              {t('ext_arcim_confirm_sie_replace', {
                count: yearsToReplace.length,
                years: yearsToReplace.join(', '),
                appName: branding.appName.toLowerCase(),
              })}
            </p>
          )}
        </div>
      </ConfirmationDialog>
    </div>
  )
}

function OptionRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string
  description: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 py-3 transition-colors duration-150',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-secondary/35'
      )}
      onClick={() => !disabled && onChange()}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={() => !disabled && onChange()}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

// ── Migrating step (progress) ───────────────────────────────────

function MigratingStep({ currentStep, progress }: { currentStep: string; progress: number }) {
  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title="Migrering pågår"
        lede="Vänta medan vi hämtar och importerar din bokföringsdata. Det kan ta några minuter."
      />
      <div className="max-w-md space-y-3">
        <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <SpinnerIcon className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
            <span className="truncate" role="status" aria-live="polite">{currentStep}</span>
          </span>
          <span className="shrink-0 tabular-nums">{progress}%</span>
        </div>
        <Progress value={progress} className="h-1" />
      </div>
    </div>
  )
}

// ── Result step ─────────────────────────────────────────────────

/** Format a fiscal year label from ISO dates, e.g. "2024-01-01" → "2024" or "2024/2025" */
function formatFiscalYearLabel(start: string, end: string): string {
  const startYear = start.slice(0, 4)
  const endYear = end.slice(0, 4)
  return startYear === endYear ? startYear : `${startYear}/${endYear}`
}

/**
 * Per-year status. "Importerad" is the resting state: warnings alone never
 * change it (they were never year-status, and painting them ochre made
 * users read a correct import as broken). "Delvis importerad" only when
 * vouchers were actually lost; "Misslyckades" when nothing landed.
 */
function getFYStatus(r: ImportResult): { tone: 'success' | 'warning' | 'error'; label: string } {
  if (r.errors.length > 0 && r.journalEntriesCreated === 0) {
    return { tone: 'error', label: 'Misslyckades' }
  }
  if (r.errors.length > 0 || (r.details?.skippedVouchers && r.details.skippedVouchers.total > 0)) {
    return { tone: 'warning', label: 'Delvis importerad' }
  }
  return { tone: 'success', label: 'Importerad' }
}

/** Compose the opening-balance adjustment into one quiet sentence. */
function openingBalanceSentence(ob: NonNullable<NonNullable<ImportResult['details']>['openingBalance']>): string {
  const amount = `${Math.abs(ob.imbalance).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK`
  if (ob.explanation === 'unallocated_result') {
    return `Ingående balanser justerade: differens på ${amount} bokförd på konto ${ob.bookedToAccount}, troligen för att föregående års resultat inte allokerats till eget kapital i källsystemet (vanligt vid byte av bokföringsprogram).`
  }
  if (ob.explanation === 'excluded_accounts') {
    return `Ingående balanser justerade: exkluderade systemkonton (t.ex. Fortnox 0099) hade ingående saldon, differensen (${amount}) bokförd på konto ${ob.bookedToAccount}.`
  }
  if (ob.explanation === 'rounding') {
    return `Ingående balanser justerade: avrundningsdifferens (${amount}) bokförd på konto ${ob.bookedToAccount}.`
  }
  return `Ingående balanser justerade: differens på ${amount} bokförd på konto ${ob.bookedToAccount}.`
}

/**
 * What the import did that is worth knowing but needs no action: shown
 * behind a small info icon next to the status label, never as lines.
 */
function fiscalYearInfoLines(result: ImportResult): string[] {
  const d = result.details
  const lines: string[] = []
  if (result.accountsCreated && result.accountsCreated > 0) {
    lines.push(
      result.accountsCreated === 1
        ? '1 nytt konto lades till i kontoplanen med namn från källsystemet.'
        : `${result.accountsCreated} nya konton lades till i kontoplanen med namn från källsystemet.`
    )
  }
  if (result.accountsRenamed && result.accountsRenamed > 0) {
    lines.push(
      result.accountsRenamed === 1
        ? '1 konto fick sitt namn från källsystemet.'
        : `${result.accountsRenamed} konton fick sina namn från källsystemet.`
    )
  }
  if (d?.openingBalanceSkipped === 'prior_activity') {
    lines.push(
      'Ingående balanser härleddes från föregående års utgående balans, eftersom bolaget redan hade bokförda verifikationer.'
    )
  }
  if (d?.openingBalance) lines.push(openingBalanceSentence(d.openingBalance))
  if (d?.migrationAdjustment?.created) {
    lines.push(
      `Omföringsverifikation skapad: ${d.migrationAdjustment.accountsAdjusted} konton justerade så att balansräkning och resultaträkning matchar källsystemet.`
    )
  }
  if (d && d.retriedBatches > 0 && d.failedBatches === 0) {
    lines.push(`${d.retriedBatches} ${d.retriedBatches === 1 ? 'batch' : 'batcher'} behövde omförsök.`)
  }
  return lines
}

/**
 * Raw warnings whose fact is already carried by `details` (and rendered
 * from there, or hoisted to the section-level line): dropped here so nothing
 * is said twice. The substring matches mirror the strings sie-import.ts
 * pushes; phase 2 (#2461) replaces them with codes.
 */
function remainingWarnings(result: ImportResult): string[] {
  const d = result.details
  return result.warnings.filter((w) => {
    if (d?.skippedVouchers && d.skippedVouchers.total > 0 && w.includes('hoppades över')) return false
    if (d?.untransferredResults && d.untransferredResults.length > 0 && w.includes('förts om till eget kapital')) return false
    if (d?.migrationAdjustment?.created && w.startsWith('Migreringsjustering skapad')) return false
    if (d?.openingBalance && w.includes('konto 2099')) return false
    return true
  })
}

/**
 * One culprit, one sentence: the untransferred-result check is company
 * scoped, so the same year would otherwise be named under every later year
 * of a multi-year migration (#2462).
 */
function untransferredResultSentences(results: ImportResult[]): string[] {
  const seen = new Map<string, string>()
  for (const r of results) {
    for (const u of r.details?.untransferredResults ?? []) {
      if (seen.has(u.fiscal_period_id)) continue
      seen.set(
        u.fiscal_period_id,
        `${u.period_name}: årets resultat på ${u.pl_net.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK är inte omfört till eget kapital i det året; året efter öppnar ändå med resultatet i eget kapital.`
      )
    }
  }
  return [...seen.values()]
}

/**
 * Per-fiscal-year outcome as a line: year, count, status. At most one ochre
 * sentence per year (vouchers that were lost); errors keep strong color;
 * everything else sits behind a muted "N anmärkningar" expander, and what
 * the import did (renames, new accounts, derived IB, adjustments) behind
 * the info icon next to the status. Nothing gets a box.
 */
function FiscalYearLine({ result, index }: { result: ImportResult; index: number }) {
  const [showRemarks, setShowRemarks] = useState(false)
  const status = getFYStatus(result)
  const d = result.details
  const fyLabel = d?.fiscalYear
    ? formatFiscalYearLabel(d.fiscalYear.start, d.fiscalYear.end)
    : `Räkenskapsår ${index + 1}`

  // The one ochre sentence: vouchers the import could not carry over.
  let skippedSentence: string | null = null
  if (d?.skippedVouchers && d.skippedVouchers.total > 0) {
    const parts: string[] = []
    if (d.skippedVouchers.empty > 0) parts.push(`${d.skippedVouchers.empty} tomma`)
    if (d.skippedVouchers.unbalanced > 0) parts.push(`${d.skippedVouchers.unbalanced} obalanserade`)
    if (d.skippedVouchers.singleLine > 0) parts.push(`${d.skippedVouchers.singleLine} enradiga`)
    if (d.skippedVouchers.unmapped > 0) {
      // Name the accounts (issue #2212): a count alone sends the user to diff
      // the general ledger against the source system by hand.
      const perAccount = (d.skippedVouchers.unmappedAccounts ?? [])
        .map((a) => `konto ${a.account}: ${a.vouchers}`)
        .join(', ')
      parts.push(
        `${d.skippedVouchers.unmapped} med ej kopplade konton${perAccount ? ` (${perAccount})` : ''}`
      )
    }
    skippedSentence = `${d.skippedVouchers.total} verifikationer hoppades över (${parts.join(', ')}): saldon har justerats automatiskt via omföringsverifikation.`
  }

  const remarks = remainingWarnings(result)
  const infoLines = fiscalYearInfoLines(result)

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm font-medium tabular-nums">{fyLabel}</span>
        <span className="text-sm text-muted-foreground tabular-nums">
          {result.journalEntriesCreated.toLocaleString('sv-SE')} verifikationer
          {result.replacedPriorImport && result.replacedPriorImport.deletedEntries > 0 && (
            <> · ersatte {result.replacedPriorImport.deletedEntries.toLocaleString('sv-SE')} tidigare importerade</>
          )}
        </span>
        <span className="ml-auto inline-flex items-center gap-2 text-xs">
          {remarks.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRemarks((v) => !v)}
              aria-expanded={showRemarks}
              className="text-muted-foreground underline-offset-2 hover:underline"
            >
              {remarks.length === 1 ? '1 anmärkning' : `${remarks.length} anmärkningar`}
            </button>
          )}
          <span
            className={cn(
              status.tone === 'error'
                ? 'font-medium text-destructive'
                : status.tone === 'warning'
                  ? 'text-attn'
                  : 'text-muted-foreground'
            )}
          >
            {status.label}
          </span>
          {infoLines.length > 0 && (
            <InfoTooltip
              side="left"
              maxWidth="360px"
              content={
                <ul className="space-y-1 text-left">
                  {infoLines.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              }
            />
          )}
        </span>
      </div>
      {result.errors.length > 0 && (
        <div className="mt-1 space-y-1">
          {result.errors.map((e, i) => (
            <p key={i} className="text-sm text-destructive">{e}</p>
          ))}
        </div>
      )}
      {skippedSentence && <AttnLine className="mt-1">{skippedSentence}</AttnLine>}
      {showRemarks && remarks.length > 0 && (
        <ul className="mt-1 space-y-1">
          {remarks.map((w, i) => (
            <li key={i} className="text-xs leading-5 text-muted-foreground">{w}</li>
          ))}
        </ul>
      )}
      {d && d.failedBatches > 0 && (
        <p className="mt-1 text-xs leading-5 text-destructive">
          {d.retriedBatches} {d.retriedBatches === 1 ? 'batch' : 'batcher'} behövde omförsök, {d.failedBatches} misslyckades trots omförsök.
        </p>
      )}
    </div>
  )
}

/**
 * Where underlag go up as files: the way forward when the source system
 * cannot hand them over (none attached there, or no file access yet).
 */
const UNDERLAG_UPLOAD_HREF = '/import?mode=underlag'

/**
 * A quiet note under a documents state: an icon and a short sentence, muted.
 * Notes say why some underlag stay behind (locked years, a Fortnox
 * permission); none of them is a failure, so none of them is red. A note the
 * user can resolve from here carries its one action under the text, in ink.
 */
function DocumentNote({
  icon: Icon,
  action,
  children,
}: {
  icon: AppIcon
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 space-y-2">
        <div className="space-y-1 text-[13px] leading-5 text-muted-foreground">{children}</div>
        {action && <div>{action}</div>}
      </div>
    </li>
  )
}

/**
 * Detail that belongs one level down (the remedy for a Fortnox permission,
 * what Fortnox answered, the request id for support): behind a disclosure, so
 * the main line speaks to the user and the detail is still one click away.
 */
function DocumentDisclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group text-xs leading-5 text-muted-foreground">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          className="h-3 w-3 transition-transform duration-150 group-open:rotate-90"
          aria-hidden="true"
        />
        {summary}
      </summary>
      <div className="mt-1 space-y-1 pl-4 [overflow-wrap:anywhere]">{children}</div>
    </details>
  )
}

/** The icon column of a documents state, aligned with the first line of its lead. */
const DOCUMENT_STATE_ICON = 'mt-1 h-4 w-4 shrink-0'

/** True on the standalone page, where states line up under the provider logo and title. */
const DocumentStateAlignedContext = createContext(false)

/**
 * One documents state: an optional icon (spinner, check, failure), the lead
 * sentence, a muted line under it, and whatever the state offers below, all
 * on the lead's left edge.
 */
function DocumentState({
  icon,
  lead,
  sub,
  trailing,
  children,
}: {
  icon?: React.ReactNode
  lead: React.ReactNode
  sub?: React.ReactNode
  /** Right of the lead, on its line: the running count while importing. */
  trailing?: React.ReactNode
  children?: React.ReactNode
}) {
  // On the standalone page the state sits on the title's left edge, its icon
  // in the provider logo's column; after a migration it starts at the
  // section's edge like the sections around it.
  const aligned = useContext(DocumentStateAlignedContext)
  return (
    <div className={cn('flex gap-3', aligned && 'sm:gap-4')}>
      {(icon || aligned) && (
        <div className={cn('shrink-0 justify-center', icon ? 'flex' : 'hidden sm:flex', aligned && 'sm:w-8')}>
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="space-y-1">
          <div className="flex items-baseline gap-3">
            <p className="min-w-0 flex-1 text-[15px] leading-6">{lead}</p>
            {trailing}
          </div>
          {sub && <div className="text-[13px] leading-5 text-muted-foreground">{sub}</div>}
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * One exception under a finished import, as a hairline row: the count, what
 * it means, and the one thing to do about it. Only rows above zero render.
 */
function DocumentOutcomeRow({
  count,
  label,
  hint,
  tone = 'muted',
  children,
}: {
  count: number
  label: string
  hint: string
  /** `failed` is the one count that is a failure, so the one in the failure colour. */
  tone?: 'muted' | 'failed'
  children?: React.ReactNode
}) {
  return (
    <li className="flex gap-4 py-3">
      <span
        className={cn(
          'w-10 shrink-0 text-right text-[15px] leading-5 tabular-nums',
          tone === 'failed' ? 'text-destructive' : 'text-foreground',
        )}
      >
        {count.toLocaleString('sv-SE')}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-5">{label}</p>
          <p className="text-xs leading-5 text-muted-foreground">{hint}</p>
        </div>
        {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
      </div>
    </li>
  )
}

/** The phases that wait on the source: the panel is busy for assistive tech. */
const DOCUMENT_BUSY_PHASES = new Set<ArcimDocumentImportState['phase']>(['discovering', 'importing', 'reconnecting'])

export function DocumentImportFollowUp({
  state,
  standalone = false,
  onDiscover,
  onImport,
  onDismiss,
  onReconnect,
}: {
  state: ArcimDocumentImportState
  /** Started from an active connection rather than as the tail of a migration: the copy must not claim a migration just ran. */
  standalone?: boolean
  onDiscover: () => void
  onImport: () => void
  onDismiss: () => void
  onReconnect: () => void
}) {
  const t = useTranslations('extensions')

  if (state.phase === 'hidden' || state.phase === 'dismissed') return null

  const provider = ARCIM_PROVIDERS.find(p => p.id === state.provider)?.name ?? state.provider ?? ''

  // Underlag whose verifikat sits in a klarmarkerat or locked year: the
  // database refuses those links, so a retry cannot help. Say which years and
  // where to reopen them, before the import (dry run) and after it (crm#251).
  const lockedCount = state.result?.locked ?? 0
  const lockedYears = (state.result?.lockedPeriods ?? []).join(', ')
  const openYearsLink = (
    <Link
      href="/settings/fiscal-years"
      className="underline decoration-foreground/25 underline-offset-4 transition-colors duration-150 hover:text-foreground"
    >
      {t('ext_arcim_documents_locked_open_years')}
    </Link>
  )

  // Files Fortnox keeps on supplier invoices come from a second register with
  // its own scope: when Fortnox refused it, the voucher files still ran, and
  // the panel says which permission or licence held the rest back. The
  // remedy and Fortnox's own answer sit one click down. A permission is the
  // one refusal a reconnect can resolve (as a user who has it, or after the
  // user was given it), so that note carries the same reconnect as the
  // approval state; afterwards the panel looks again. A licence cannot be
  // changed from here and an error needs a later look, not a new login, so
  // those stay plain notes. One reconnect covers every refused scope: only
  // the first permission note offers it.
  const unreachableSources = state.result?.unreachableSources ?? []
  const reconnectScope = unreachableSources.find((entry) => entry.reason === 'permission')?.scope
  const unreachableNotes = unreachableSources.map(
    (entry: ArcimUnreachableDocumentSource) => {
      const scope = t(`ext_arcim_documents_scope_${entry.scope}`)
      const answer = entry.providerMessage
        ? t('ext_arcim_documents_provider_message', { provider: 'Fortnox', message: entry.providerMessage })
        : null
      return (
        <DocumentNote
          key={entry.scope}
          icon={InformationCircleIcon}
          action={entry.scope === reconnectScope ? (
            <Button variant="outline" onClick={onReconnect}>
              <ArrowPathIcon className="h-3.5 w-3.5" />
              {t('ext_arcim_documents_reconnect_action')}
            </Button>
          ) : undefined}
        >
          <p>
            {entry.source === 'customer_invoice_files'
              ? t(`ext_arcim_documents_customer_invoice_files_${entry.reason}`, { scope })
              : t(`ext_arcim_documents_supplier_files_${entry.reason}`, { scope })}
          </p>
          {entry.reason === 'permission' ? (
            <DocumentDisclosure summary={t('ext_arcim_documents_supplier_files_how')}>
              <p>{t('ext_arcim_documents_supplier_files_remedy', { provider: 'Fortnox', scope })}</p>
              {answer && <p>{answer}</p>}
            </DocumentDisclosure>
          ) : answer ? (
            <DocumentDisclosure summary={t('ext_arcim_documents_technical_details')}>
              <p>{answer}</p>
            </DocumentDisclosure>
          ) : null}
        </DocumentNote>
      )
    },
  )

  const uploadInstead = (
    <p className="text-[13px] leading-5 text-muted-foreground">
      {t('ext_arcim_documents_upload_instead')}{' '}
      <Link
        href={UNDERLAG_UPLOAD_HREF}
        className="underline decoration-foreground/25 underline-offset-4 transition-colors duration-150 hover:text-foreground"
      >
        {t('ext_arcim_documents_upload_link')}
      </Link>
    </p>
  )

  let body: React.ReactNode

  if (state.phase === 'discovering' || state.phase === 'reconnecting') {
    body = (
      <DocumentState
        icon={<SpinnerIcon className={cn(DOCUMENT_STATE_ICON, 'animate-spin text-muted-foreground')} aria-hidden="true" />}
        lead={state.phase === 'discovering'
          ? t('ext_arcim_documents_discovering', { provider })
          : t('ext_arcim_documents_reconnecting', { provider })}
        sub={state.phase === 'reconnecting' ? t('ext_arcim_documents_reconnecting_hint', { provider }) : undefined}
      >
        {/* The offer's button lands here: hold its place so the page does
            not jump when the count arrives. */}
        {state.phase === 'discovering' && <Skeleton className="h-8 w-40 rounded-md" />}
      </DocumentState>
    )
  } else if (state.phase === 'importing') {
    const progress = documentImportProgress(state)
    body = (
      <DocumentState
        icon={<SpinnerIcon className={cn(DOCUMENT_STATE_ICON, 'animate-spin text-muted-foreground')} aria-hidden="true" />}
        lead={t('ext_arcim_documents_importing', { provider })}
        trailing={progress ? (
          <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">
            {t('ext_arcim_documents_import_progress', progress)}
          </span>
        ) : undefined}
      >
        {progress && (
          <Progress
            value={(progress.done / progress.total) * 100}
            className="h-1"
            aria-label={t('ext_arcim_documents_importing', { provider })}
          />
        )}
        <p className="text-[13px] leading-5 tabular-nums text-muted-foreground">
          {t('ext_arcim_documents_import_hint', { linked: state.result?.linked ?? 0 })}
        </p>
      </DocumentState>
    )
  } else if (state.phase === 'offered') {
    const notes = [
      ...(lockedCount > 0
        ? [
            <DocumentNote key="locked" icon={LockClosedIcon}>
              <p>
                {t('ext_arcim_documents_locked_offer', { count: lockedCount, years: lockedYears })}{' '}
                {openYearsLink}
              </p>
            </DocumentNote>,
          ]
        : []),
      ...unreachableNotes,
    ]
    // After a migration, say once that the files can come later on their
    // own: re-running the migration for them is what this replaces.
    body = (
      <DocumentState
        lead={standalone
          ? t('ext_arcim_documents_prompt_standalone', { count: state.found, provider })
          : t('ext_arcim_documents_prompt', { count: state.found, provider })}
        sub={standalone ? undefined : t('ext_arcim_documents_prompt_later')}
      >
        {notes.length > 0 && <ul className="space-y-2">{notes}</ul>}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button onClick={onImport}>
            <PaperClipIcon className="h-4 w-4" />
            {t('ext_arcim_documents_import_action', { count: state.found })}
          </Button>
          {/* Standalone, "not now" is the page's own Tillbaka. */}
          {!standalone && (
            <Button variant="ghost" onClick={onDismiss}>
              {t('ext_arcim_documents_not_now')}
            </Button>
          )}
        </div>
      </DocumentState>
    )
  } else if (state.phase === 'empty') {
    body = (
      <DocumentState lead={t('ext_arcim_documents_empty', { provider })} sub={uploadInstead}>
        {unreachableNotes.length > 0 && <ul className="space-y-2">{unreachableNotes}</ul>}
        <div>
          <Button variant="outline" onClick={onDiscover}>
            <ArrowUturnLeftIcon className="h-4 w-4" />
            {t('ext_arcim_documents_retry_discovery')}
          </Button>
        </div>
      </DocumentState>
    )
  } else if (state.phase === 'complete') {
    if (!state.result) {
      body = <DocumentState lead={t('ext_arcim_documents_result_description')} />
    } else {
      // The run is a success with exceptions, never a scoreboard: what landed
      // leads, and only the counts above zero follow, each with its own way
      // forward.
      const { linked, skipped, unmatched, failed, customerInvoicePdfs } = state.result
      // Customer invoice copies (Fortnox) say where they went: a copy on the
      // invoice only is archived but not on a verifikat, so the lead, which
      // counts what is on the verifikat, leaves it out.
      const invoiceOnly = customerInvoicePdfs?.invoiceOnly ?? 0
      const customerParts = [
        (customerInvoicePdfs?.linked ?? 0) > 0
          ? t('ext_arcim_documents_customer_invoice_pdfs_linked', { count: customerInvoicePdfs?.linked ?? 0 })
          : null,
        invoiceOnly > 0 ? t('ext_arcim_documents_customer_invoice_pdfs_invoice_only', { count: invoiceOnly }) : null,
        (customerInvoicePdfs?.skipped ?? 0) > 0
          ? t('ext_arcim_documents_customer_invoice_pdfs_skipped', { count: customerInvoicePdfs?.skipped ?? 0 })
          : null,
        // Among "Kunde inte hämtas" below: the ones a retry will not bring.
        (customerInvoicePdfs?.refused ?? 0) > 0
          ? t('ext_arcim_documents_customer_invoice_pdfs_refused', { count: customerInvoicePdfs?.refused ?? 0 })
          : null,
      ].filter((part): part is string => part !== null)
      const customerSummary = customerParts.length > 0
        ? t('ext_arcim_documents_customer_invoice_pdfs', { items: customerParts.join(', ') })
        : null
      const skippedLine = skipped > 0 ? t('ext_arcim_documents_result_skipped', { count: skipped }) : null
      body = (
        <DocumentState
          icon={<CheckCircleIcon className={cn(DOCUMENT_STATE_ICON, 'text-foreground')} aria-hidden="true" />}
          lead={t('ext_arcim_documents_result_lead', { count: linked - invoiceOnly })}
          sub={skippedLine || customerSummary ? (
            <>
              {skippedLine}
              {customerSummary ? <span className="block">{customerSummary}</span> : null}
            </>
          ) : undefined}
        >
          {(failed > 0 || lockedCount > 0 || unmatched > 0) && (
            <ul className="divide-y divide-border border-y border-border">
              {failed > 0 && (
                <DocumentOutcomeRow
                  count={failed}
                  tone="failed"
                  label={t('ext_arcim_documents_failed')}
                  hint={t('ext_arcim_documents_partial_failure')}
                >
                  <Button variant="outline" onClick={onImport}>
                    <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
                    {t('ext_arcim_documents_retry_import')}
                  </Button>
                </DocumentOutcomeRow>
              )}
              {lockedCount > 0 && (
                <DocumentOutcomeRow
                  count={lockedCount}
                  label={t('ext_arcim_documents_locked', { years: lockedYears })}
                  hint={t('ext_arcim_documents_locked_result')}
                >
                  <Button variant="ghost" asChild>
                    <Link href="/settings/fiscal-years">{t('ext_arcim_documents_locked_open_years')}</Link>
                  </Button>
                  <Button variant="outline" onClick={onDiscover}>
                    <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
                    {t('ext_arcim_documents_retry_discovery')}
                  </Button>
                </DocumentOutcomeRow>
              )}
              {unmatched > 0 && (
                <DocumentOutcomeRow
                  count={unmatched}
                  label={t('ext_arcim_documents_unmatched')}
                  hint={t('ext_arcim_documents_unmatched_help')}
                />
              )}
            </ul>
          )}
          {unreachableNotes.length > 0 && <ul className="space-y-2">{unreachableNotes}</ul>}
        </DocumentState>
      )
    }
  } else {
    const reconnectRequired = state.problem?.reconnectRequired === true
    // The provider refused the connection itself (B11), as opposed to the
    // Fortnox file permissions the approval state below asks for.
    const connectionRefused =
      state.problem?.code != null && PROVIDER_CONNECTION_REFUSED_CODES.includes(state.problem.code)
    const discoveryFailed = state.phase === 'discovery-error'
    // Fortnox has not granted the file permissions to the integration itself, so
    // neither reconnecting nor retrying can succeed: state it and offer nothing.
    const scopesUnavailable =
      state.problem?.code === PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE
    // The server carries this run on by itself (crm#1581): nothing failed and
    // there is nothing for this tab to retry.
    const runningOnServer =
      state.problem?.code === PROVIDER_IMPORT_DOCUMENTS_RUNNING_ON_SERVER
    // What the source answered and the request id are for support: one level
    // down, never the main line.
    const technical = [
      state.problem?.providerMessage
        ? t('ext_arcim_documents_provider_message', { provider, message: state.problem.providerMessage })
        : null,
      state.problem?.requestId
        ? t('ext_arcim_documents_error_reference', { requestId: state.problem.requestId })
        : null,
    ].filter((line): line is string => line !== null)
    const technicalDetails = technical.length > 0 && (
      <DocumentDisclosure summary={t('ext_arcim_documents_technical_details')}>
        {technical.map((line) => <p key={line}>{line}</p>)}
      </DocumentDisclosure>
    )

    if (runningOnServer) {
      body = (
        <DocumentState
          lead={t('ext_arcim_documents_running_on_server', { provider })}
          sub={t('ext_arcim_documents_running_on_server_hint')}
        />
      )
    } else if (scopesUnavailable) {
      // Waiting on Fortnox, not a fault: neutral, and the way forward
      // meanwhile is the file upload.
      body = (
        <DocumentState
          lead={t('ext_arcim_documents_scope_unavailable_title', { provider })}
          sub={t('ext_arcim_documents_scope_unavailable', { provider })}
        >
          {uploadInstead}
        </DocumentState>
      )
    } else if (reconnectRequired) {
      // A permission to approve, or a connection to renew, is a step to take,
      // not an error.
      body = (
        <DocumentState
          lead={connectionRefused
            ? t('ext_arcim_documents_refused_title', { provider })
            : t('ext_arcim_documents_scope_error_title', { provider })}
          sub={state.problem?.message ?? (connectionRefused
            ? t('ext_arcim_documents_refused', { provider })
            : t('ext_arcim_documents_scope_error', { provider }))}
        >
          <div>
            <Button onClick={onReconnect}>
              <ArrowPathIcon className="h-4 w-4" />
              {connectionRefused
                ? t('ext_arcim_documents_reconnect_provider', { provider })
                : t('ext_arcim_documents_reconnect_action')}
            </Button>
          </div>
          {technicalDetails}
        </DocumentState>
      )
    } else {
      // A real failure: the one place the failure colour appears, on the
      // icon, with the sentence in ink and the retry right under it.
      body = (
        <DocumentState
          icon={<ExclamationCircleIcon className={cn(DOCUMENT_STATE_ICON, 'text-destructive')} aria-hidden="true" />}
          lead={discoveryFailed
            ? standalone
              ? t('ext_arcim_documents_discovery_error_standalone', { provider })
              : t('ext_arcim_documents_discovery_error', { provider })
            : standalone
              ? t('ext_arcim_documents_import_error_standalone')
              : t('ext_arcim_documents_import_error')}
          sub={state.problem?.message
            ?? (discoveryFailed
              ? t('ext_arcim_documents_discovery_error_hint')
              : t('ext_arcim_documents_import_error_hint'))}
        >
          <div>
            <Button onClick={discoveryFailed ? onDiscover : onImport}>
              <ArrowUturnLeftIcon className="h-4 w-4" />
              {t('ext_arcim_documents_retry_import')}
            </Button>
          </div>
          {technicalDetails}
        </DocumentState>
      )
    }
  }

  return (
    // A readable measure: the counts, their actions and the progress bar stay
    // within reach of the sentence they belong to on a wide panel.
    <section className="max-w-3xl space-y-3" aria-live="polite" aria-busy={DOCUMENT_BUSY_PHASES.has(state.phase) || undefined}>
      {!standalone && <SectionKicker>{t('ext_arcim_documents_title', { provider })}</SectionKicker>}
      {/* Keyed by phase: each new state fades in as one block, while the
          running counts inside a phase update in place. */}
      <div key={state.phase} className="animate-fade-in space-y-4">
        <DocumentStateAlignedContext.Provider value={standalone}>{body}</DocumentStateAlignedContext.Provider>
      </div>
    </section>
  )
}

const NEXT_STEPS: { title: string; sub: string }[] = [
  { title: 'Granska importerade verifikationer', sub: 'Kontrollera att bokföringen ser korrekt ut i huvudboken' },
  { title: 'Stäm av balansräkningen', sub: 'Jämför ingående balanser och saldon mot ditt tidigare system' },
  { title: 'Kontrollera kunder och leverantörer', sub: 'Verifiera kontaktuppgifter, organisationsnummer och bankinfo' },
]

/** What an accepted provider import left for review, as its result lists it. */
interface ProviderReviewResult {
  issues: ProviderMigrationIssue[]
  total: number
  truncated: boolean
  provider: string
  acceptedAt: string | null
}

export function ResultStep({
  provider,
  results,
  sieResults,
  omittedYears,
  error,
  documentImportState,
  documentsOnly,
  theaterModel,
  review,
  onDone,
  onRetry,
  onDiscoverDocuments,
  onImportDocuments,
  onDismissDocuments,
  onReconnectDocuments,
}: {
  /** The source system, for the copy that differs per provider. */
  provider: string | null
  results: MigrationResults | null
  /**
   * Records an accepted provider import left out or could not link: listed
   * here with their reasons, so finishing the import never hides them.
   */
  review: ProviderReviewResult | null
  sieResults: ImportResult[]
  /** Source fiscal years outside the selection: not fetched in this run. */
  omittedYears: SourceFiscalYear[]
  error: string | null
  documentImportState: ArcimDocumentImportState
  /** Only the underlag import ran, from an active connection: no migration verdict to show. */
  documentsOnly: boolean
  theaterModel: TheaterModel | null
  onDone: () => void
  onRetry: () => void
  onDiscoverDocuments: () => void
  onImportDocuments: () => void
  onDismissDocuments: () => void
  onReconnectDocuments: () => void
}) {
  const t = useTranslations('extensions')
  const fiscalYearSpanLabel = useFiscalYearSpanLabel()
  if (error) {
    // Steps run one request each (#2469), so a failure in a later request
    // leaves earlier steps' rows in place. Name them: the user must not
    // re-import what already landed, and must see what still needs a rerun.
    const completed = completedStepLines(results)
    return (
      <div className="stagger-enter space-y-8">
        <div>
          <h2 className="text-xl text-balance">
            {completed.length > 0 ? 'Migreringen avbröts' : 'Migreringen misslyckades'}
          </h2>
          <p className="mt-3 whitespace-pre-line text-sm text-destructive">{error}</p>
        </div>
        {completed.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">
              Hann slutföras innan felet
            </h3>
            <ul className="mt-3 space-y-1 text-sm">
              {completed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted-foreground">
              Kör migreringen igen med de steg som saknas: det som redan finns hoppas över.
            </p>
          </div>
        )}
        <SieFallbackLine message="Du kan istället importera din bokföringsdata manuellt via en SIE-fil." />
        <div className="flex flex-col-reverse gap-3 border-t-hairline pt-6 sm:flex-row sm:justify-between">
          <Button variant="outline" onClick={onDone}>Klar</Button>
          <Button onClick={onRetry}>
            <ArrowUturnLeftIcon className="h-4 w-4" />
            Försök igen
          </Button>
        </div>
      </div>
    )
  }

  if (documentsOnly) {
    // Nothing was migrated in this run, so no verdict, stats or next steps:
    // the underlag flow is the whole page.
    const documentProvider =
      ARCIM_PROVIDERS.find(p => p.id === documentImportState.provider)?.name ?? documentImportState.provider ?? ''
    // One title, one short promise (the bookkeeping does not change), the
    // mechanics behind the "?": the page says what it does before the user
    // presses anything.
    return (
      <div className="stagger-enter space-y-8">
        <div className="flex items-start gap-4">
          {documentImportState.provider && (
            <ProviderMark provider={documentImportState.provider} name={documentProvider} className="mt-1" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xl text-balance">
                {t('ext_arcim_documents_title_standalone', { provider: documentProvider })}
              </h2>
              <HelpPopover>
                <p>{t('ext_arcim_documents_standalone_help', { provider: documentProvider })}</p>
              </HelpPopover>
            </div>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {t('ext_arcim_documents_standalone_lede', { provider: documentProvider })}
            </p>
          </div>
        </div>
        <DocumentImportFollowUp
          state={documentImportState}
          standalone
          onDiscover={onDiscoverDocuments}
          onImport={onImportDocuments}
          onDismiss={onDismissDocuments}
          onReconnect={onReconnectDocuments}
        />
        {/* Tillbaka is always there; the way on to the vouchers only once
            the files are on them, so no state has two primary actions. */}
        <div className="flex flex-col-reverse gap-3 border-t-hairline pt-6 sm:flex-row sm:justify-between">
          <Button variant="outline" onClick={onDone}>
            <ArrowLeftIcon className="h-4 w-4" />
            {t('ext_arcim_documents_standalone_back')}
          </Button>
          {documentImportState.phase === 'complete' && (
            <Button asChild>
              <Link href="/bookkeeping">
                {t('ext_arcim_documents_view_entries')}
                <ArrowRightIcon className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          )}
        </div>
      </div>
    )
  }

  const hasResults =
    results ||
    sieResults.length > 0 ||
    (documentImportState.phase !== 'hidden' && documentImportState.phase !== 'dismissed')
  if (!hasResults) return null

  // Compute combined SIE stats
  const totalJournalEntries = sieResults.reduce((sum, r) => sum + r.journalEntriesCreated, 0)
  const totalErrors = sieResults.reduce((sum, r) => sum + r.errors.length, 0)
  const allSieSucceeded = sieResults.length > 0 && sieResults.every(r => r.success)
  const anySieFailed = sieResults.some(r => r.errors.length > 0 && r.journalEntriesCreated === 0)

  // Check if anything meaningful was imported via entities
  // Company info is always re-fetched (upsert) so it doesn't count as "new"
  const entityImported = results && (
    (results.customers && (results.customers.imported > 0 || (results.customers.updated ?? 0) > 0 || results.customers.skipped > 0)) ||
    (results.suppliers && (results.suppliers.imported > 0 || results.suppliers.skipped > 0)) ||
    (results.salesInvoices && (results.salesInvoices.imported > 0 || results.salesInvoices.skipped > 0)) ||
    (results.supplierInvoices && (results.supplierInvoices.imported > 0 || results.supplierInvoices.skipped > 0)) ||
    (results.assets && (results.assets.imported > 0 || results.assets.skipped > 0 || results.assets.scopesMissing))
  )

  // Steps that failed against the provider API. An empty sync with failed
  // steps must never present as "Allt är uppdaterat": that reading sent a
  // real subscription problem to the bug tracker as a sync bug.
  const stepErrors = results?.stepErrors ?? []
  const apiFailed = stepErrors.length > 0
  const reviewCount = review?.issues.length ?? 0
  const nothingNew = sieResults.length === 0 && !entityImported && !apiFailed && reviewCount === 0

  // ── The reveal: a serif verdict derived from the real results ──
  const fyCount = sieResults.length
  const verdict = nothingNew
    ? 'Allt är redan uppdaterat.'
    : (anySieFailed || apiFailed)
      ? 'Migreringen är delvis genomförd.'
      : totalJournalEntries > 0
        ? fyCount === 1
          ? `${totalJournalEntries.toLocaleString('sv-SE')} verifikationer är på plats.`
          : `${totalJournalEntries.toLocaleString('sv-SE')} verifikationer över ${fyCount} räkenskapsår är på plats.`
        : (sieResults.length > 0 && !allSieSucceeded) || totalErrors > 0 || reviewCount > 0
          ? 'Migreringen är klar, med anmärkningar.'
          : 'Migreringen är klar.'

  const statParts: string[] = []
  if (totalJournalEntries > 0) statParts.push(`${totalJournalEntries.toLocaleString('sv-SE')} verifikat`)
  if (fyCount > 0) statParts.push(`${fyCount} räkenskapsår`)
  const customerCount = (results?.customers?.imported ?? 0) + (results?.customers?.updated ?? 0)
  if (customerCount > 0) statParts.push(`${customerCount.toLocaleString('sv-SE')} kunder`)
  if ((results?.suppliers?.imported ?? 0) > 0) statParts.push(`${results!.suppliers!.imported.toLocaleString('sv-SE')} leverantörer`)
  const invoiceCount = (results?.salesInvoices?.imported ?? 0) + (results?.supplierInvoices?.imported ?? 0)
  if (invoiceCount > 0) statParts.push(`${invoiceCount.toLocaleString('sv-SE')} fakturor`)

  // The settled constellation only appears over a story that is true:
  // it needs the model and actually imported entries.
  const showCanvas = !!theaterModel && totalJournalEntries > 0

  // Övriga data as a quiet line list, not a card grid.
  const entityLines: { label: string; value: string; detail?: string; failed: boolean }[] = []
  // The provider job knows how many records it skipped but not why (see
  // SkipReasons.reasonUnknown): one neutral line says what skipping means.
  const hasSkippedWithoutReason = MIGRATION_RESOURCES.some(
    (resource) => (results?.[resource]?.skipReasons?.reasonUnknown ?? 0) > 0,
  )
  // A register the provider answered with no records at all (crm#1516): its
  // line says so and what to check, instead of the line going missing.
  const providerName = ARCIM_PROVIDERS.find(p => p.id === provider)?.name ?? provider ?? ''
  const emptyRegister = (resource: MigrationResource) => ({
    label: t(`ext_arcim_job_resource_${resource}`),
    value: t('ext_arcim_register_empty_value'),
    detail: t('ext_arcim_register_empty_detail', {
      provider: providerName,
      what: t(`ext_arcim_job_resource_${resource}`).toLowerCase(),
    }),
    failed: false,
  })
  if (results) {
    if (results.companyInfo?.imported) {
      entityLines.push({ label: 'Företagsinformation', value: 'Importerad', failed: false })
    }
    if (results.customers?.total === 0) {
      entityLines.push(emptyRegister('customers'))
    } else if (results.customers && (results.customers.imported > 0 || (results.customers.updated ?? 0) > 0 || results.customers.skipped > 0)) {
      entityLines.push({
        label: 'Kunder',
        value: results.customers.updated
          ? `${results.customers.imported} importerade, ${results.customers.updated} kompletterade`
          : `${results.customers.imported} importerade`,
        detail: results.customers.skipped > 0
          ? formatSkipReasons(results.customers.skipReasons, 'customer', results.customers.errorSample) ?? `${results.customers.skipped} hoppades över`
          : undefined,
        failed: entityRowStatus(results.customers.imported, results.customers.skipReasons) === 'error',
      })
    }
    if (results.suppliers?.total === 0) {
      entityLines.push(emptyRegister('suppliers'))
    } else if (results.suppliers && (results.suppliers.imported > 0 || results.suppliers.skipped > 0)) {
      entityLines.push({
        label: 'Leverantörer',
        value: `${results.suppliers.imported} importerade`,
        detail: results.suppliers.skipped > 0
          ? formatSkipReasons(results.suppliers.skipReasons, 'supplier', results.suppliers.errorSample) ?? `${results.suppliers.skipped} hoppades över`
          : undefined,
        failed: entityRowStatus(results.suppliers.imported, results.suppliers.skipReasons) === 'error',
      })
    }
    if (results.salesInvoices?.total === 0) {
      entityLines.push(emptyRegister('salesInvoices'))
    } else if (results.salesInvoices && (results.salesInvoices.imported > 0 || results.salesInvoices.skipped > 0)) {
      entityLines.push({
        label: 'Kundfakturor',
        value: `${results.salesInvoices.imported} importerade`,
        detail: results.salesInvoices.skipped > 0
          ? formatSkipReasons(results.salesInvoices.skipReasons, 'invoice', results.salesInvoices.errorSample) ?? `${results.salesInvoices.skipped} hoppades över`
          : undefined,
        failed: entityRowStatus(results.salesInvoices.imported, results.salesInvoices.skipReasons) === 'error',
      })
    }
    const lineHydration = results.salesInvoices?.hydration
    const linesMissing = lineHydration ? lineHydration.needed - lineHydration.hydrated : 0
    if (lineHydration && linesMissing > 0) {
      // The detail fetch that carries the rows and the VAT split runs inside
      // a fixed budget, open invoices first. Whatever it did not reach was
      // imported as a header with a total and no rows; an hourly pass fills
      // those in afterwards. Say so here, or the user finds out on the
      // invoice page ("fakturorna finns med en total men utan rader").
      entityLines.push({
        label: t('ext_arcim_invoice_lines_label'),
        value: t('ext_arcim_invoice_lines_value', { hydrated: lineHydration.hydrated, needed: lineHydration.needed }),
        detail: t('ext_arcim_invoice_lines_pending_detail', { count: linesMissing }),
        failed: false,
      })
    }
    if (results.salesInvoices?.creditNotesUnlinked || results.salesInvoices?.creditNotesLinked) {
      // Credit notes land as ordinary invoice rows with reversed amounts and,
      // when the provider named the invoice they credit (Bokio does), a
      // credited_invoice_id. Say which ones could not be paired rather than
      // leaving the user to notice a kreditfaktura that points at nothing.
      const unlinked = results.salesInvoices.creditNotesUnlinked ?? 0
      const linked = results.salesInvoices.creditNotesLinked ?? 0
      entityLines.push({
        label: t('ext_arcim_credit_notes_label'),
        value: `${unlinked + linked} importerade`,
        detail: [
          linked > 0 ? t('ext_arcim_credit_notes_linked_detail', { count: linked }) : null,
          unlinked > 0 ? t('ext_arcim_credit_notes_unlinked_detail', { count: unlinked }) : null,
        ].filter(Boolean).join(' '),
        failed: false,
      })
    }
    if (results.supplierInvoices) {
      // Shown even at zero: the Fortnox import keeps only open supplier
      // invoices unless the member asked for all (fortnoxSupplierInvoiceNotOpen
      // in lib/providers/fortnox/mapper.ts), so a register with every invoice
      // paid imports none, and a hidden row read as "the supplier invoices
      // were lost" (crm#251). The paid ones are in the ledger as the SIE
      // file's verifikat.
      const skipDetail = results.supplierInvoices.skipped > 0
        ? formatSkipReasons(results.supplierInvoices.skipReasons, 'invoice', results.supplierInvoices.errorSample) ?? `${results.supplierInvoices.skipped} hoppades över`
        : undefined
      const scopeDetail = provider === 'fortnox' && !results.supplierInvoices.paidIncluded
        ? t('ext_arcim_supplier_invoices_unpaid_only') : undefined
      entityLines.push({
        label: 'Leverantörsfakturor',
        value: `${results.supplierInvoices.imported} importerade`,
        detail: [skipDetail, scopeDetail].filter(Boolean).join(' ') || undefined,
        failed: entityRowStatus(results.supplierInvoices.imported, results.supplierInvoices.skipReasons) === 'error',
      })
    }
    for (const [key, count] of [
      ['vat', (results.salesInvoices?.vatUnresolved ?? 0) + (results.supplierInvoices?.vatUnresolved ?? 0)],
      ['fx', (results.salesInvoices?.fxUnresolved ?? 0) + (results.supplierInvoices?.fxUnresolved ?? 0)],
      ['rows', results.supplierInvoices?.rowsMismatch ?? 0],
      ['rows_account', results.supplierInvoices?.rowsUnaccounted ?? 0],
    ] as const) {
      if (count > 0) entityLines.push({ label: t(`ext_arcim_job_warning_${key}`),
        value: t('ext_arcim_job_warning_count', { count }), failed: false })
    }
    if (results.registrationLinks && results.registrationLinks.scanned > 0) {
      const links = results.registrationLinks
      // An invoice that already carried its link (a rerun over invoices an
      // earlier run linked) is done, not failed: it counts towards the
      // displayed total and gets its own detail line, so the value and the
      // details agree. Without this a rerun read "0 av 2" with no explanation.
      const done = links.linked + links.alreadyLinked
      const unlinked = links.scanned - done
      const details: string[] = []
      if (links.alreadyLinked > 0) {
        details.push(t('ext_arcim_registration_links_already_linked', { count: links.alreadyLinked }))
      }
      if (unlinked > 0) {
        details.push(t('ext_arcim_registration_links_detail', {
          unlinked,
          noRef: links.noRef,
          refNotFetched: links.refNotFetched ?? 0,
          unresolved: links.unresolved + links.ambiguous,
          amountMismatch: links.amountMismatch,
        }))
      }
      entityLines.push({
        label: t('ext_arcim_registration_links_label'),
        value: t('ext_arcim_registration_links_value', { linked: done, scanned: links.scanned }),
        detail: details.length > 0 ? details.join('. ') : undefined,
        failed: false,
      })
    }
    if (results.assets && (results.assets.imported > 0 || results.assets.skipped > 0 || results.assets.scopesMissing)) {
      entityLines.push({
        label: 'Anläggningstillgångar',
        value: results.assets.scopesMissing ? 'Hoppades över' : `${results.assets.imported} importerade`,
        detail: results.assets.scopesMissing
          ? 'Fortnox-anslutningen saknar behörighet till anläggningsregistret (assets-scope). Bokförda värden är ändå med via SIE.'
          : [
              results.assets.skipped > 0
                ? formatSkipReasons(results.assets.skipReasons, 'asset', results.assets.errorSample) ?? `${results.assets.skipped} hoppades över`
                : undefined,
              // Imported, not skipped: on category default accounts because
              // the source's asset type did not resolve.
              (results.assets.skipReasons?.typeUnresolved ?? 0) > 0
                ? t('ext_arcim_assets_type_unresolved', { count: results.assets.skipReasons?.typeUnresolved ?? 0 })
                : undefined,
            ].filter(Boolean).join(', ') || undefined,
        failed: !results.assets.scopesMissing &&
          entityRowStatus(results.assets.imported, results.assets.skipReasons) === 'error',
      })
    }
  }

  return (
    <div className="stagger-enter space-y-8">
      {/* ── The reveal: settled constellation beside the serif verdict ── */}
      <div className={cn('grid items-center gap-6', showCanvas && 'md:grid-cols-[minmax(280px,380px)_1fr]')}>
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Migrering
          </p>
          <h2 className="mt-2 text-xl text-balance">
            {verdict}
          </h2>
          {nothingNew ? (
            <p className="mt-3 text-[13px] text-muted-foreground">
              Det finns ingen ny data att importera från leverantören.
            </p>
          ) : statParts.length > 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground tabular-nums">
              {statParts.join(' · ')}
            </p>
          ) : null}
        </div>
        {showCanvas && theaterModel && (
          <div className="relative hidden min-h-[360px] md:block">
            <TheaterCanvas model={theaterModel} settled />
          </div>
        )}
      </div>

      {/* ── Steps that failed against the provider API: strong color, no box ── */}
      {stepErrors.length > 0 && (
        <div className="space-y-3">
          {groupStepErrors(stepErrors).map((group, i) => (
            <div key={i} className="space-y-1">
              <p className="text-sm font-medium text-destructive">
                Kunde inte hämta: {group.steps.map((s) => STEP_ERROR_LABELS[s]).join(', ')}
              </p>
              <p className="text-sm text-muted-foreground">{group.message}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Per-fiscal-year outcomes as lines ── */}
      {sieResults.length > 0 && (
        <section className="space-y-3">
          <SectionKicker>Bokföringsdata (SIE)</SectionKicker>
          <div className="stagger-enter divide-y divide-border" data-no-stagger>
            {sieResults.map((r, i) => (
              <FiscalYearLine key={i} result={r} index={i} />
            ))}
          </div>
          {/* Company-level fact, said once: a prior year whose result was
              never transferred to equity skews every later opening balance. */}
          {untransferredResultSentences(sieResults).map((sentence, i) => (
            <AttnLine key={i}>{sentence}</AttnLine>
          ))}
        </section>
      )}

      {/* ── Source fiscal years outside the selection (#2211) ──
          Named here so nobody believes the books are complete: a new run
          with those years ticked fetches them (documents come along), or
          the SIE path does. */}
      {sieResults.length > 0 && omittedYears.length > 0 && (
        <section className="space-y-3">
          <SectionKicker>{t('ext_arcim_omitted_years_kicker')}</SectionKicker>
          <div className="stagger-enter divide-y divide-border" data-no-stagger>
            {omittedYears.map((fy) => (
              <p key={`${fy.year}-${fy.fromDate ?? ''}`} className="py-3 text-sm tabular-nums">
                {fiscalYearSpanLabel(fy)}
              </p>
            ))}
          </div>
          <SieFallbackLine
            message={t('ext_arcim_omitted_years_result', { count: omittedYears.length })}
            label={t('ext_arcim_omitted_years_sie_link')}
          />
        </section>
      )}

      {/* ── API import results: quiet two-column line list ── */}
      {entityLines.length > 0 && (
        <section className="space-y-3">
          <SectionKicker>Övriga data</SectionKicker>
          <div className="stagger-enter grid gap-x-10 sm:grid-cols-2" data-no-stagger>
            {/* Label and value only: the detail (skip reasons, why a
                credit note has no link, when missing rows arrive) explains
                rather than asks for action, so it sits behind the row's "?".
                A failed row keeps its destructive value. */}
            {entityLines.map((line) => (
              <div key={line.label} className="flex items-center justify-between gap-4 border-b-hairline py-2">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  {line.label}
                  {line.detail && <HelpPopover className="shrink-0">{line.detail}</HelpPopover>}
                </span>
                <span
                  className={cn(
                    'text-right text-sm tabular-nums',
                    line.failed ? 'font-medium text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {line.value}
                </span>
              </div>
            ))}
          </div>
          {hasSkippedWithoutReason && (
            <p className="text-[13px] text-muted-foreground">{t('ext_arcim_job_skipped_explanation')}</p>
          )}
        </section>
      )}

      {/* ── Records the accepted provider import left for review ── */}
      {review && reviewCount > 0 && (
        <section className="space-y-3">
          <SectionKicker>{t('ext_arcim_review_result_kicker')}</SectionKicker>
          <p className="text-[13px] text-muted-foreground">
            {review.acceptedAt
              ? t('ext_arcim_review_result_lede_accepted', { date: formatDate(review.acceptedAt) })
              : t('ext_arcim_review_result_lede')}
          </p>
          <ProviderMigrationIssues issues={review.issues} provider={review.provider}
            total={review.total} truncated={review.truncated} />
        </section>
      )}

      <DocumentImportFollowUp
        state={documentImportState}
        onDiscover={onDiscoverDocuments}
        onImport={onImportDocuments}
        onDismiss={onDismissDocuments}
        onReconnect={onReconnectDocuments}
      />

      {/* ── Next steps: quiet numbered lines, no card, no filled discs ── */}
      {!nothingNew && (
        <section className="space-y-3">
          <SectionKicker>Nästa steg</SectionKicker>
          <ol className="stagger-enter divide-y divide-border" data-no-stagger>
            {NEXT_STEPS.map((step, i) => (
              <li key={step.title} className="flex items-baseline gap-4 py-3">
                <span className="text-[13px] text-muted-foreground tabular-nums">{i + 1}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{step.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{step.sub}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="flex flex-col-reverse gap-3 border-t-hairline pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onDone}>
          <ArrowUturnLeftIcon className="h-4 w-4" />
          Ny migrering
        </Button>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" asChild>
            <Link href="/customers">
              Visa kunder
              <ArrowTopRightOnSquareIcon className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild>
            <Link href="/bookkeeping">
              Visa bokföring
              <ArrowTopRightOnSquareIcon className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}

const STEP_ERROR_LABELS: Record<MigrationStepError['step'], string> = {
  companyInfo: 'Företagsinformation',
  customers: 'Kunder',
  suppliers: 'Leverantörer',
  salesInvoices: 'Kundfakturor',
  supplierInvoices: 'Leverantörsfakturor',
  assets: 'Anläggningstillgångar',
  registrationLinks: 'Koppling till verifikationer',
  reconciliation: 'Avstämning av betalningar',
}

/**
 * Group step errors that share the same message (a provider outage hits every
 * step identically) so the result shows one card per cause, not one per step.
 */
function groupStepErrors(errors: MigrationStepError[]): { message: string; steps: MigrationStepError['step'][] }[] {
  const groups = new Map<string, MigrationStepError['step'][]>()
  for (const e of errors) {
    const steps = groups.get(e.message) ?? []
    steps.push(e.step)
    groups.set(e.message, steps)
  }
  return [...groups.entries()].map(([message, steps]) => ({ message, steps }))
}

function formatSkipReasons(
  reasons?: AssetSkipReasons,
  entityType?: 'customer' | 'supplier' | 'invoice' | 'asset',
  errorSample?: string,
): string | undefined {
  if (!reasons) return undefined
  const parts: string[] = []
  if (reasons.duplicate) parts.push(`${reasons.duplicate} fanns redan`)
  if (reasons.outsideFiscalYears) {
    parts.push(
      `${reasons.outsideFiscalYears} utanför importerade räkenskapsår`,
    )
  }
  // The source returned the record without an amount and without rader, so
  // there is nothing to import: say that, rather than let the count vanish
  // into an unexplained "hoppades över".
  if (reasons.zeroTotal) parts.push(`${reasons.zeroTotal} saknar belopp hos leverantören`)
  if (reasons.inactive) {
    parts.push(
      entityType === 'asset'
        ? `${reasons.inactive} avyttrad${reasons.inactive > 1 ? 'e' : ''} eller annullerad${reasons.inactive > 1 ? 'e' : ''}`
        : `${reasons.inactive} inaktiv${reasons.inactive > 1 ? 'a' : ''}`,
    )
  }
  if (reasons.unsupported) parts.push(`${reasons.unsupported} kunde inte tolkas`)
  if (reasons.reasonUnknown) parts.push(`${reasons.reasonUnknown} hoppades över`)
  if (reasons.noMatch) {
    const matchLabel = entityType === 'invoice' ? 'utan matchning' : 'utan matchning'
    parts.push(`${reasons.noMatch} ${matchLabel}`)
  }
  if (reasons.failed) {
    parts.push(
      errorSample
        ? `${reasons.failed} misslyckades: ${errorSample.slice(0, 140)}`
        : `${reasons.failed} misslyckades`
    )
  }
  return parts.length > 0 ? parts.join(', ') : undefined
}

/**
 * One line per step that reported a result: what the earlier per-step
 * requests already wrote before a later one failed.
 */
function completedStepLines(results: MigrationResults | null): string[] {
  if (!results) return []
  const lines: string[] = []
  const count = (label: string, r?: { imported: number; skipped: number }) => {
    if (!r) return
    lines.push(`${label}: ${r.imported} importerade${r.skipped > 0 ? `, ${r.skipped} hoppades över` : ''}`)
  }
  if (results.companyInfo?.imported) lines.push('Företagsinformation: uppdaterad')
  count('Kunder', results.customers)
  count('Leverantörer', results.suppliers)
  count('Kundfakturor', results.salesInvoices)
  count('Leverantörsfakturor', results.supplierInvoices)
  count('Anläggningstillgångar', results.assets)
  return lines
}

/** A step that failed everything it tried is an error, not a quiet count. */
function entityRowStatus(imported: number, reasons?: SkipReasons): 'success' | 'error' {
  return imported === 0 && (reasons?.failed ?? 0) > 0 ? 'error' : 'success'
}

// ── Main wizard ─────────────────────────────────────────────────

export default function ArcimMigrationWorkspace({
  initialProvider,
}: WorkspaceComponentProps & {
  /** Deep-linked old system (onboarding branch question): jump straight to
   *  its connect step instead of showing the provider list. */
  initialProvider?: string
}) {
  const { toast } = useToast()
  const t = useTranslations('extensions')

  const [step, setStep] = useState<WizardStep>('provider')
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)
  // One migration run at a time. A second submit while the first request is
  // still inserting re-runs the same step against a register snapshot that
  // predates the first run's rows: 987 duplicate customers in one company
  // (2026-09-10). The ref closes the same-tick race; the state disables the
  // submit and the confirm button.
  const migrationInFlightRef = useRef(false)
  const [isStartingMigration, setIsStartingMigration] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-item details behind `error`: e.g. the SIE validation errors from
  // /sie-data, which would otherwise be swallowed (the envelope's `error`
  // field is just the string "validation").
  const [errorDetails, setErrorDetails] = useState<string[] | null>(null)

  // Connection status (existing connections + import history)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null)

  // Connection state
  const [selectedProvider, setSelectedProvider] = useState<ArcimProvider | null>(null)
  const [consentId, setConsentId] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  // Björn Lundén: Lundify activation URL from /connect (null when BL has not
  // issued an activation key, in which case only the User-Key field shows).
  const [activationUrl, setActivationUrl] = useState<string | null>(null)
  const [authType, setAuthType] = useState<'oauth' | 'token' | null>(null)

  // Preview state
  const [preview, setPreview] = useState<PreviewData | null>(null)
  // Fiscal years (start years) ticked in the preview step's picker. Set from
  // the preview's default selection on load; sent to /sie-data as `years`.
  const [selectedYears, setSelectedYears] = useState<number[]>([])
  // Set when a preview/sync fails because the provider connection expired
  // (dead refresh token → PROVIDER_AUTH_EXPIRED). Drives the "Återanslut"
  // affordance so the user can re-authorize in place instead of disconnecting.
  const [authExpired, setAuthExpired] = useState(false)
  // Set when the failure is specifically a missing/inactive Fortnox integration
  // license (PROVIDER_LICENSE_MISSING). Re-auth alone can't fix it, so the SIE
  // fallback stays available alongside the "Återanslut" CTA.
  const [licenseMissing, setLicenseMissing] = useState(false)

  // SIE data state (held between mapping and execution steps)
  const [sieData, setSieData] = useState<SIEData | null>(null)
  const companyAccountsForVatRef = useRef<BASAccount[]>([])
  // Chart of accounts incl. inactive, from the session cache
  // (lib/reference-data). Re-read when the mapping step opens because the
  // preview may have created accounts; the SIE import invalidates it too.
  const { refresh: refreshCompanyAccounts } = useAccounts(false)

  // Options state
  const [migrationOptions, setMigrationOptions] = useState<MigrationOptions>(DEFAULT_OPTIONS)

  // Migration state
  const reconnectJobRef = useRef<string | null>(null)
  const [latestJobId, setLatestJobId] = useState<string | null>(null)
  const [providerJobId, setProviderJobId] = useState<string | null>(null)
  const [providerReview, setProviderReview] = useState<ProviderReviewResult | null>(null)
  const [migrationStep, setMigrationStep] = useState('')
  const [migrationProgress, setMigrationProgress] = useState(0)
  const [migrationResults, setMigrationResults] = useState<MigrationResults | null>(null)
  const [sieImportResults, setSieImportResults] = useState<ImportResult[]>([])
  const [documentImportState, dispatchDocumentImport] = useReducer(
    arcimDocumentImportReducer,
    INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
  )
  // True while the result step shows an underlag run started on its own from
  // an active Fortnox connection (no migration ran in this pass).
  const [documentsOnly, setDocumentsOnly] = useState(false)
  const documentReconnectActionRef = useRef<'discover' | 'import' | null>(null)
  // Where a reconnect started from a note returns when the login fails (see
  // arcimDocumentReconnectPlan); null when it started from an error state.
  // Set and read together with documentReconnectActionRef.
  const documentReconnectReturnRef = useRef<ArcimDocumentImportPhase | null>(null)
  const documentReconnectFailureCleanupRef = useRef<number | null>(null)
  const stopOAuthPopupWatchRef = useRef<(() => void) | null>(null)
  // Listen for postMessage from the OAuth popup: only the window this
  // workspace opened (handleOpenProviderWindow, handleReconnect) is heard.
  // Declared before those callbacks so they can list the ref; the handler
  // runs on a message, after every function it calls is defined.
  const oauthPopupRef = useOAuthPopup<{ type?: string; consentId?: string; reason?: unknown; cancelled?: unknown }>((data) => {
    if (data?.type === 'arcim-oauth-success' && data.consentId) {
      clearOAuthPopupWatch()
      clearDocumentReconnectFailureCleanup()
      const reconnectAction = documentReconnectActionRef.current
      if (reconnectAction) {
        documentReconnectActionRef.current = null
        clearDocumentOAuthResume()
        setConsentId(data.consentId)
        setSelectedProvider('fortnox')
        setStep('result')
        if (reconnectAction === 'discover') {
          void runDocumentDiscovery(data.consentId, 'fortnox', true)
        } else {
          // Continue after the last file the stopped run handled, as the
          // reconnect copy promises, instead of downloading everything again.
          void runDocumentImport(data.consentId, documentImportState.result)
        }
        return
      }
      finishConnectAttempt('success')
      loadPreview(data.consentId)
    } else if (data?.type === 'arcim-oauth-error') {
      clearOAuthPopupWatch()
      clearDocumentReconnectFailureCleanup()
      const reason = typeof data.reason === 'string' && data.reason
        ? data.reason
        : 'OAuth-anslutningen misslyckades. Försök igen.'
      const reconnectAction = documentReconnectActionRef.current
      if (reconnectAction) {
        documentReconnectActionRef.current = null
        clearDocumentOAuthResume()
        // Started from a note: nothing failed, the panel goes back to it. A
        // refusal still says why (a missing licence); the customer's own
        // cancel needs no telling.
        const returnTo = documentReconnectReturnRef.current
        if (returnTo) {
          dispatchDocumentImport({ type: 'reconnect-cancelled', phase: returnTo })
          if (data.cancelled !== true) toast({ title: 'Anslutning misslyckades', description: reason, variant: 'destructive' })
          return
        }
        dispatchDocumentImport(documentReconnectRefused(reconnectAction, reason, documentImportState.problem))
        return
      }
      // access_denied at the provider arrives flagged `cancelled` by the
      // callback: the customer chose to stop, the provider did not fail.
      finishConnectAttempt(data.cancelled === true ? 'cancelled' : 'provider_error')
      setError(reason)
      toast({ title: 'Anslutning misslyckades', description: reason, variant: 'destructive' })
    }
  })
  // Knowledge-graph theater for the migrating step, built from the already
  // client-held parsed SIE. Null falls back to the plain progress card.
  const [theaterModel, setTheaterModel] = useState<TheaterModel | null>(null)

  // Wizard progress: only user-interactive steps
  const userSteps = STEPS.filter(s => {
    if (s === 'migrating' || s === 'result') return false
    if (s === 'mapping' && !preview?.sieAvailable) return false
    return true
  })
  const currentUserStepIndex = userSteps.indexOf(step)
  const isInteractiveStep = currentUserStepIndex !== -1

  // ── Fetch connection status on mount ───────────────────────────

  const fetchStatus = useCallback(async (options: { quiet?: boolean } = {}) => {
    try {
      // A quiet read keeps the page as it is until the answer is in.
      if (!options.quiet) setIsLoadingStatus(true)
      const res = await fetch('/api/extensions/ext/arcim-migration/status')
      if (res.ok) {
        const data = await res.json()
        setConnectionStatus(data)
      }
    } catch {
      // Non-critical: just means we can't show existing connections
    } finally {
      if (!options.quiet) setIsLoadingStatus(false)
    }
  }, [])
  const refreshStatusQuietly = useCallback(() => { void fetchStatus({ quiet: true }) }, [fetchStatus])

  useEffect(() => {
    fetchStatus()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Jobs belong to the company, so a refresh, new tab or another consultant
  // can recover progress without browser storage or a surviving response stream.
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/extensions/ext/arcim-migration/migration-jobs', { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) return
        const { data } = await response.json() as { data: ProviderMigrationStatus | null }
        if (!controller.signal.aborted && data) setLatestJobId(data.job.id)
        if (!controller.signal.aborted && data && data.job.state !== 'completed') {
          setProviderJobId(data.job.id)
          setConsentId(data.job.consent_id)
          setSelectedProvider(data.job.provider as ArcimProvider)
        }
      }).catch(() => {})
    return () => controller.abort()
  }, [])

  // ── Step handlers ──────────────────────────────────────────────

  // `previewOnly`: the preview step's own "Försök igen" after a failed SIE
  // fetch (crm#1118) reloads the preview. Every other caller (connect, the
  // OAuth return, the token submit, Synka igen) resumes a pending job instead.
  const loadPreview = useCallback(async (cId: string, options?: { previewOnly?: boolean }) => {
    setStep('preview')
    setIsLoading(true)
    setError(null)
    setAuthExpired(false)
    setLicenseMissing(false)
    setConsentId(cId)

    try {
      if (reconnectJobRef.current && !options?.previewOnly) {
        const jobId = reconnectJobRef.current
        const response = await fetch('/api/extensions/ext/arcim-migration/migration-jobs/retry', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, consentId: cId }),
        })
        if (!response.ok) throw apiError(await response.json(), 'Kunde inte återuppta importen')
        reconnectJobRef.current = null
        setProviderJobId(jobId)
        return
      }
      const res = await fetch(`/api/extensions/ext/arcim-migration/preview?consentId=${cId}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        // A dead connection (expired/revoked refresh token) is recoverable in
        // place: flag it so the UI offers "Återanslut" instead of a dead end.
        // A missing Fortnox integration license or an inactive Visma API
        // module shows the same CTA but keeps the SIE fallback, because
        // re-auth loops until the customer fixes the subscription (re-orders
        // the license / activates the API module).
        const code = apiErrorCode(data)
        if (
          code === 'PROVIDER_AUTH_EXPIRED' ||
          code === 'PROVIDER_LICENSE_MISSING' ||
          code === 'PROVIDER_API_MODULE_INACTIVE'
        ) {
          setAuthExpired(true)
        }
        if (code === 'PROVIDER_LICENSE_MISSING' || code === 'PROVIDER_API_MODULE_INACTIVE') {
          setLicenseMissing(true)
        }
        throw new Error(apiErrorMessage(data, `HTTP ${res.status}`))
      }

      const data = await res.json() as PreviewData
      setPreview(data)
      setSelectedYears(
        defaultFiscalYearSelection(data.sourceYears ?? [], data.maxSelectedYears, data.importedFiscalYears),
      )
      const previewProvider = data?.consent?.provider
      if (ARCIM_PROVIDERS.some((provider) => provider.id === previewProvider)) {
        setSelectedProvider(previewProvider as ArcimProvider)
      }

      setMigrationOptions(prev => optionsAfterPreview(prev, data.sieAvailable))
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte hämta förhandsgranskning')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const handleSelectProvider = useCallback(async (provider: ArcimProvider) => {
    setSelectedProvider(provider)
    setDocumentsOnly(false)
    setStep('connect')
    setIsLoading(true)
    setError(null)
    // Drop the previous attempt's consent and one-time URLs before asking for
    // new ones: if /connect fails, the step must not keep offering a stale
    // activation link that completes the earlier consent.
    setConsentId(null)
    setAuthType(null)
    setAuthUrl(null)
    setActivationUrl(null)

    try {
      const res = await fetch('/api/extensions/ext/arcim-migration/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(apiErrorMessage(data, `HTTP ${res.status}`))
      }

      const data = await res.json()
      setConsentId(data.consentId)
      setAuthType(data.authType)
      setActivationUrl(typeof data.activationUrl === 'string' ? data.activationUrl : null)

      if (data.alreadyConnected) {
        // Existing connection: skip auth, go straight to preview
        await loadPreview(data.consentId)
        return
      }

      if (data.authType === 'oauth' && data.authUrl) {
        setAuthUrl(data.authUrl)
      }
      // Token-based providers stay on connect step for credential input
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : 'Anslutning misslyckades')
    } finally {
      setIsLoading(false)
    }
  }, [loadPreview])

  // Re-sync with existing consent: go straight to preview
  const handleResync = useCallback(async (provider: ArcimProvider, existingConsentId: string) => {
    setSelectedProvider(provider)
    setDocumentsOnly(false)
    setConsentId(existingConsentId)
    setMigrationOptions(DEFAULT_OPTIONS)
    setMigrationResults(null)
    setProviderReview(null)
    setSieImportResults([])
    setSieData(null)
    await loadPreview(existingConsentId)
  }, [loadPreview])

  const clearOAuthPopupWatch = useCallback(() => {
    stopOAuthPopupWatchRef.current?.()
    stopOAuthPopupWatchRef.current = null
  }, [])

  // The connect click being measured (migration_connect_clicked). The first
  // outcome clears it, so one click reports at most one
  // migration_connect_finished.
  const connectAttemptRef = useRef<ArcimProvider | null>(null)
  const startConnectAttempt = useCallback((provider: ArcimProvider) => {
    connectAttemptRef.current = provider
    trackMigrationConnectClicked(provider)
  }, [])
  const finishConnectAttempt = useCallback((outcome: MigrationConnectOutcome) => {
    const provider = connectAttemptRef.current
    if (!provider) return
    connectAttemptRef.current = null
    trackMigrationConnectFinished(provider, outcome)
  }, [])

  // First connect: the provider login, or Lundify's activation for Björn
  // Lundén. Both answer through the same popup and postMessage listener.
  const handleOpenProviderWindow = useCallback((url: string) => {
    if (selectedProvider) startConnectAttempt(selectedProvider)
    const w = 600
    const h = 700
    const left = window.screenX + (window.outerWidth - w) / 2
    const top = window.screenY + (window.outerHeight - h) / 2
    const popup = window.open(url, 'arcim-oauth', `width=${w},height=${h},left=${left},top=${top}`)
    if (!popup) {
      // Popup blocked: with the return value discarded, a blocked
      // popup looked exactly like a successful one (nothing opens,
      // nothing is said, the user clicks again). Fall back to the
      // full-page flow instead. The callback already supports it:
      // with no window.opener it redirects to
      // /import?migration=connected&consentId=..., which
      // handleOAuthReturn consumes and resumes the wizard at the
      // preview step. Same treatment as SkatteverketConnectPanel.
      if (selectedProvider) storeConnectAttempt(selectedProvider)
      window.location.href = url
      return
    }
    oauthPopupRef.current = popup
    // Closing the login window before it answers is an outcome of its own.
    // The popup posts its result and then closes, but the message can reach
    // this window after the close is observed. Here the close only records
    // telemetry, so the watch waits 3 s instead of the default 0.5 s: a late
    // success or error stops it first and is recorded as what it was.
    clearOAuthPopupWatch()
    stopOAuthPopupWatchRef.current = watchArcimOAuthPopup(popup, () => {
      stopOAuthPopupWatchRef.current = null
      finishConnectAttempt('window_closed')
    }, 500, 3000)
  }, [selectedProvider, startConnectAttempt, clearOAuthPopupWatch, finishConnectAttempt, oauthPopupRef])

  const clearDocumentReconnectFailureCleanup = useCallback(() => {
    if (documentReconnectFailureCleanupRef.current) {
      window.clearTimeout(documentReconnectFailureCleanupRef.current)
      documentReconnectFailureCleanupRef.current = null
    }
  }, [])

  useEffect(() => () => {
    clearOAuthPopupWatch()
    clearDocumentReconnectFailureCleanup()
  }, [clearDocumentReconnectFailureCleanup, clearOAuthPopupWatch])

  // Re-authorize a dead connection in place. Re-runs provider auth against the
  // SAME consent so fresh tokens overwrite the expired pair: no disconnect.
  // OAuth providers open the login popup (the existing postMessage listener
  // reloads the preview on success); token providers drop to the credential
  // form. Triggered from the "Återanslut" CTA after a sync hits
  // PROVIDER_AUTH_EXPIRED.
  const handleReconnect = useCallback(async (
    provider: ArcimProvider,
    existingConsentId: string,
    options?: { onFailure?: () => void; documentScopes?: boolean },
  ) => {
    setError(null)
    setAuthExpired(false)
    setLicenseMissing(false)
    setIsLoading(true)
    setSelectedProvider(provider)

    // Pre-open the OAuth popup inside the click's user activation: opening it
    // after the fetch below is popup-blocked when the response is slow (the
    // activation expires after ~5s). Kept open only for OAuth providers; the
    // token path and every failure path close it again. The opener reference
    // stays intact: the provider popup posts back via postMessage.
    const w = 600
    const h = 700
    const left = window.screenX + (window.outerWidth - w) / 2
    const top = window.screenY + (window.outerHeight - h) / 2
    const popup = window.open('', 'arcim-oauth', `width=${w},height=${h},left=${left},top=${top}`)

    try {
      const res = await fetch('/api/extensions/ext/arcim-migration/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          reconnect: true,
          documentScopes: options?.documentScopes === true,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(apiErrorMessage(data, `HTTP ${res.status}`))
      }

      const data = await res.json()
      setConsentId(data.consentId ?? existingConsentId)
      setAuthType(data.authType)

      if (data.authType === 'oauth' && data.authUrl) {
        let activePopup: Window | null = null
        if (popup && !popup.closed) {
          popup.location.href = data.authUrl
          activePopup = popup
        } else {
          // The pre-opened popup was blocked or closed; retrying here is a
          // long shot (the activation may be gone) but strictly better than
          // dropping the flow. If the retry is blocked too, take the same
          // full-page fallback as the first-connect button rather than leaving
          // "Återanslut" looking like it worked.
          const retry = window.open(data.authUrl, 'arcim-oauth', `width=${w},height=${h},left=${left},top=${top}`)
          if (!retry) {
            window.location.href = data.authUrl
          } else {
            activePopup = retry
          }
        }
        if (activePopup) {
          oauthPopupRef.current = activePopup
          clearOAuthPopupWatch()
          stopOAuthPopupWatchRef.current = watchArcimOAuthPopup(activePopup, () => {
            stopOAuthPopupWatchRef.current = null
            if (options?.onFailure) {
              options.onFailure()
            } else {
              setError('Inloggningsfönstret stängdes innan anslutningen var klar. Försök igen.')
              setAuthExpired(true)
            }
          })
        }
        setAuthUrl(data.authUrl)
      } else {
        popup?.close()
        if (data.authType === 'token') {
          // Re-enter credentials for token-based providers
          setActivationUrl(typeof data.activationUrl === 'string' ? data.activationUrl : null)
          setStep('connect')
        }
      }
    } catch (err) {
      popup?.close()
      if (options?.onFailure) {
        options.onFailure()
      } else {
        setError(err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte återansluta')
        setAuthExpired(true)
      }
    } finally {
      setIsLoading(false)
    }
  }, [clearOAuthPopupWatch, oauthPopupRef])

  const runDocumentDiscovery = useCallback(async (
    currentConsentId: string,
    provider: ArcimProvider | null,
    migrationSucceeded: boolean,
  ) => {
    dispatchDocumentImport({
      type: 'discovery-started',
      provider,
      migrationSucceeded,
    })
    if (!supportsUnderlagImport(provider) || !migrationSucceeded) return

    try {
      const result = await requestArcimDocumentImport(currentConsentId, true)
      dispatchDocumentImport({ type: 'discovery-succeeded', result })
    } catch (documentError) {
      dispatchDocumentImport({
        type: 'discovery-failed',
        problem: documentImportProblem(documentError),
      })
    }
  }, [])

  const runDocumentImport = useCallback(async (
    currentConsentId: string,
    /** The totals of a run that stopped: continue after its last file instead of from the top. */
    resumeFrom: ArcimDocumentImportResult | null = null,
  ) => {
    dispatchDocumentImport({ type: 'import-started', resumeFrom })
    try {
      // A run this tab did not see stop (a reload, a closed laptop, a tab
      // that gave up) is kept on the server: continue it after its last
      // file instead of downloading every linked one again (crm#1581).
      const kept = resumableDocumentImport(resumeFrom) ? null : await fetchResumableDocumentImport(currentConsentId)
      if (kept) dispatchDocumentImport({ type: 'import-progress', result: kept })
      // One route call per time-budgeted slice; the helper loops until the
      // server reports the end and feeds running totals back for the UI.
      const result = await runArcimDocumentImportToCompletion(currentConsentId, {
        resumeFrom: kept ?? resumeFrom,
        onProgress: (progress) =>
          dispatchDocumentImport({ type: 'import-progress', result: progress }),
      })
      dispatchDocumentImport({ type: 'import-succeeded', result })
    } catch (documentError) {
      dispatchDocumentImport({
        type: 'import-failed',
        problem: documentImportProblem(documentError),
      })
    }
  }, [])

  // Run the underlag import on its own against an active consent (Fortnox or
  // Bokio). Same discovery, import and, for Fortnox, scope-reconnect path as
  // the tail of a migration; only the surrounding page differs (no migration
  // verdict).
  const handleFetchDocuments = useCallback(async (existingConsentId: string, provider: ArcimProvider) => {
    setSelectedProvider(provider)
    setConsentId(existingConsentId)
    setError(null)
    setMigrationResults(null)
    setProviderReview(null)
    setSieImportResults([])
    setSieData(null)
    setTheaterModel(null)
    clearDocumentReconnectFailureCleanup()
    documentReconnectActionRef.current = null
    setDocumentsOnly(true)
    setStep('result')
    await runDocumentDiscovery(existingConsentId, provider, true)
  }, [clearDocumentReconnectFailureCleanup, runDocumentDiscovery])

  /** The Fortnox login for the underlag run, coming back to `reconnectAction`. */
  const startDocumentReconnect = useCallback((
    targetConsentId: string,
    reconnectAction: 'discover' | 'import',
    returnTo: ArcimDocumentImportPhase | null,
    priorProblem: ArcimDocumentImportProblem,
    standalone: boolean,
  ) => {
    clearDocumentReconnectFailureCleanup()
    documentReconnectActionRef.current = reconnectAction
    documentReconnectReturnRef.current = returnTo
    storeDocumentOAuthResume(reconnectAction, standalone)
    dispatchDocumentImport({ type: 'reconnect-started' })
    void handleReconnect('fortnox', targetConsentId, {
      // The whole point of this reconnect is the attachment permissions, so
      // this is the one path that asks Fortnox for them.
      documentScopes: true,
      onFailure: () => {
        dispatchDocumentImport(
          returnTo
            ? { type: 'reconnect-cancelled', phase: returnTo }
            : reconnectAction === 'discover'
              ? { type: 'discovery-failed', problem: priorProblem }
              : { type: 'import-failed', problem: priorProblem },
        )
        // Keep the action briefly after the popup-close grace period. Some
        // browsers deliver the successful postMessage after reporting the
        // popup as closed; that success must remain authoritative.
        documentReconnectFailureCleanupRef.current = window.setTimeout(() => {
          documentReconnectActionRef.current = null
          clearDocumentOAuthResume()
          documentReconnectFailureCleanupRef.current = null
        }, 30_000)
      },
    })
  }, [clearDocumentReconnectFailureCleanup, handleReconnect])

  const handleDocumentReconnect = useCallback(() => {
    if (!consentId) return
    // A Bokio integration token is replaced in the credential form, not in a
    // Fortnox login (B11: a refused Bokio token stops the run too).
    if (documentImportState.provider === 'bokio') {
      void handleReconnect('bokio', consentId)
      return
    }
    const { resume: reconnectAction, returnTo } = arcimDocumentReconnectPlan(documentImportState.phase)
    startDocumentReconnect(
      consentId,
      reconnectAction,
      returnTo,
      documentImportState.problem ?? { code: null, requestId: null, reconnectRequired: false },
      documentsOnly,
    )
  }, [
    consentId,
    documentImportState.phase,
    documentImportState.problem,
    documentImportState.provider,
    documentsOnly,
    handleReconnect,
    startDocumentReconnect,
  ])

  // "Koppla Fortnox igen" on a connection whose latest underlag run the
  // provider refused (B11): straight to the login, then a fresh look for
  // underlag, on the standalone documents page. The popup opens inside the
  // click, so nothing is awaited before startDocumentReconnect.
  const handleReconnectDocuments = useCallback((existingConsentId: string, provider: ArcimProvider) => {
    if (provider !== 'fortnox') {
      void handleReconnect(provider, existingConsentId)
      return
    }
    setSelectedProvider('fortnox')
    setConsentId(existingConsentId)
    setError(null)
    setMigrationResults(null)
    setProviderReview(null)
    setSieImportResults([])
    setSieData(null)
    setTheaterModel(null)
    setDocumentsOnly(true)
    setStep('result')
    dispatchDocumentImport({ type: 'discovery-started', provider: 'fortnox', migrationSucceeded: true })
    startDocumentReconnect(
      existingConsentId,
      'discover',
      null,
      { code: 'PROVIDER_AUTH_EXPIRED', requestId: null, reconnectRequired: true },
      true,
    )
  }, [handleReconnect, startDocumentReconnect])

  // Disconnect an existing consent
  const handleDisconnect = useCallback(async (consentIdToDelete: string) => {
    try {
      const res = await fetch('/api/extensions/ext/arcim-migration/disconnect', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentId: consentIdToDelete }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(apiErrorMessage(data, 'Kunde inte koppla från'))
      }
      toast({ title: 'Frånkopplad', description: 'Anslutningen har tagits bort.' })
      await fetchStatus()
    } catch (err) {
      toast({ title: err instanceof Error ? getUserErrorMessage(err) : 'Något gick fel', variant: 'destructive' })
    }
  }, [toast, fetchStatus])

  // Handle token submission for token-based providers (Bokio, etc.)
  const handleTokenSubmit = useCallback(async (apiToken: string, companyId: string) => {
    if (!consentId || !selectedProvider) return

    startConnectAttempt(selectedProvider)
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/extensions/ext/arcim-migration/submit-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consentId,
          provider: selectedProvider,
          apiToken,
          companyId: companyId || undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw apiError(data, `HTTP ${res.status}`)
      }

      // Token stored: consent is now accepted, proceed to preview
      finishConnectAttempt('success')
      await loadPreview(consentId)
    } catch (err) {
      finishConnectAttempt('provider_error')
      setError(displayError(err, 'Kunde inte ansluta'))
    } finally {
      setIsLoading(false)
    }
  }, [consentId, selectedProvider, loadPreview, startConnectAttempt, finishConnectAttempt])

  // Handle OAuth callback via URL params
  const handleOAuthReturn = useCallback(async () => {
    // Check URL for migration callback params
    const url = new URL(window.location.href)
    const migrationStatus = url.searchParams.get('migration')
    const callbackConsentId = url.searchParams.get('consentId')
    const documentResume = readDocumentOAuthResume()

    if (migrationStatus === 'connected' && callbackConsentId) {
      // Clean URL
      url.searchParams.delete('migration')
      url.searchParams.delete('consentId')
      window.history.replaceState({}, '', url.pathname)

      clearDocumentOAuthResume()
      if (documentResume) {
        clearDocumentReconnectFailureCleanup()
        documentReconnectActionRef.current = null
        setConsentId(callbackConsentId)
        setSelectedProvider('fortnox')
        setDocumentsOnly(documentResume.standalone)
        setStep('result')
        if (documentResume.action === 'discover') {
          await runDocumentDiscovery(callbackConsentId, 'fortnox', true)
        } else {
          await runDocumentImport(callbackConsentId)
        }
      } else {
        const attempt = takeConnectAttempt()
        if (attempt) trackMigrationConnectFinished(attempt, 'success')
        await loadPreview(callbackConsentId)
      }
    } else if (migrationStatus === 'error') {
      const callbackProvider = url.searchParams.get('provider') as ArcimProvider | null
      const reason = url.searchParams.get('reason') || 'OAuth-anslutningen misslyckades. Försök igen.'
      const cancelled = url.searchParams.get('cancelled') === '1'
      url.searchParams.delete('migration')
      url.searchParams.delete('provider')
      url.searchParams.delete('reason')
      url.searchParams.delete('consentId')
      url.searchParams.delete('cancelled')
      window.history.replaceState({}, '', url.pathname)
      clearDocumentOAuthResume()
      if (documentResume && callbackConsentId) {
        clearDocumentReconnectFailureCleanup()
        setConsentId(callbackConsentId)
        setSelectedProvider('fortnox')
        setStep('result')
        const problem = documentOAuthProblemFromReason(reason)
        dispatchDocumentImport(
          documentResume.action === 'discover'
            ? { type: 'discovery-failed', problem }
            : { type: 'import-failed', problem },
        )
        return
      }
      const attempt = takeConnectAttempt()
      if (attempt) trackMigrationConnectFinished(attempt, cancelled ? 'cancelled' : 'provider_error')
      setError(reason)
      toast({ title: 'Anslutning misslyckades', description: reason, variant: 'destructive' })
      if (callbackProvider) {
        setSelectedProvider(callbackProvider)
        setStep('connect')
      } else {
        setStep('provider')
      }
    }
  }, [
    clearDocumentReconnectFailureCleanup,
    loadPreview,
    runDocumentDiscovery,
    runDocumentImport,
    toast,
  ])

  // Check for OAuth callback on mount (fallback for non-popup flow)
  useEffect(() => {
    handleOAuthReturn()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deep-linked provider preselect (onboarding branch question, and the
  // unfinished-connect retry). Only when this mount is not an OAuth return
  // (that flow owns the wizard state). Visma and Bokio need a completed SIE
  // import first, so for them the preselect waits for the connection status
  // and leaves the provider list with its "SIE krävs först" gate in place
  // when that import is missing.
  const preselectedRef = useRef(false)
  useEffect(() => {
    if (preselectedRef.current || !initialProvider) return
    if (new URL(window.location.href).searchParams.get('migration')) return
    const provider = ARCIM_PROVIDERS.find((p) => p.id === initialProvider)
    if (!provider || COMING_SOON_PROVIDERS.has(provider.id)) return
    if (isLoadingStatus) return
    // A migration from this provider already ran: stay on the provider list,
    // whose row offers "Hämta underlag" next to the re-run. Preselecting
    // started a fresh migration instead, and a customer who came for the
    // underlag went through the mapping again and never saw the button (PH 245).
    if (
      connectionStatus?.hasCompletedSieImport &&
      connectionStatus.consents.some((consent) => consent.provider === provider.id)
    ) {
      preselectedRef.current = true
      return
    }
    if (!provider.sieViaApi && !connectionStatus?.hasCompletedSieImport) {
      preselectedRef.current = true
      return
    }
    preselectedRef.current = true
    void handleSelectProvider(provider.id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProvider, isLoadingStatus, connectionStatus])

  // Load SIE data when entering mapping step
  const loadSIEData = useCallback(async () => {
    if (!consentId) return

    setStep('mapping')
    setIsLoading(true)
    setError(null)
    setErrorDetails(null)

    try {
      // The picker's selection travels as `years`; without a picker (no
      // source years known) the route falls back to its default selection.
      const yearsQuery = selectedYears.length > 0 ? `&years=${selectedYears.join(',')}` : ''
      const res = await fetch(`/api/extensions/ext/arcim-migration/sie-data?consentId=${consentId}${yearsQuery}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as {
          error?: unknown
          validation?: { errors?: unknown }
        }
        const validationErrors = data?.error === 'validation' ? data.validation?.errors : undefined
        if (Array.isArray(validationErrors)) {
          setErrorDetails(validationErrors.filter((e): e is string => typeof e === 'string'))
          throw new UserFacingError(
            'Bokföringsdatan hos leverantören klarade inte valideringen. Felen nedan måste rättas i källsystemet innan importen kan fortsätta.'
          )
        }
        throw apiError(data, `HTTP ${res.status}`)
      }

      const data = await res.json() as SIEData
      // Bound SWR mutate resolves with the revalidated list.
      const companyAccounts = ((await refreshCompanyAccounts()) ?? []) as BASAccount[]
      companyAccountsForVatRef.current = companyAccounts
      const enrichedMappings = enrichAccountMappingsWithVat(data.mappings, companyAccounts)
      setSieData({ ...data, mappings: enrichedMappings })

      // A year a completed import already holds is kept unless the user
      // ticks it on the options step (PH 185, PH 180). The route always
      // answered allImported: false, so the old check here never fired and
      // every re-run replaced the years it found.
      setMigrationOptions(prev => optionsAfterSieData(prev, data.fileStatuses))

      // Auto-skip only when the page has nothing to ask: no blank target, no
      // VAT review, and no class 9 account suggested onto 2999 OBS-konto.
      if (canSkipMappingStep(enrichedMappings, { unmapped: data.mappingStats.unmapped, allImported: data.allImported })) {
        setStep('options')
      }
    } catch (err) {
      setError(displayError(err, 'Kunde inte hämta SIE-data'))
    } finally {
      setIsLoading(false)
    }
  }, [consentId, refreshCompanyAccounts, selectedYears])

  const handlePreviewContinue = useCallback(() => {
    if (preview?.sieAvailable) {
      // Load SIE data for mapping step
      loadSIEData()
    } else {
      // Skip mapping step: no SIE available
      setStep('options')
    }
  }, [preview, loadSIEData])

  const handleMappingChange = useCallback((sourceAccount: string, targetAccount: string, targetName: string) => {
    if (!sieData) return

    const updatedMappings = enrichChangedAccountMappingWithVat(
      sieData.mappings.map(m =>
        m.sourceAccount === sourceAccount
          ? { ...m, targetAccount, targetName, isOverride: true, matchType: 'manual' as const, confidence: 1 }
          : m
      ),
      sourceAccount,
      companyAccountsForVatRef.current,
    )
    setSieData(prev => prev ? {
      ...prev,
      mappings: updatedMappings,
      mappingStats: {
        ...prev.mappingStats,
        unmapped: updatedMappings.filter(m => !m.targetAccount).length,
        mapped: updatedMappings.filter(m => m.targetAccount).length,
      },
    } : null)
  }, [sieData])

  const handleVatTreatmentChange = useCallback((
    sourceAccount: string,
    treatment: AccountVatTreatment | null,
    rate: number | null,
  ) => {
    setSieData(prev => prev ? {
      ...prev,
      mappings: applyVatTreatmentReview(prev.mappings, sourceAccount, treatment, rate),
    } : null)
  }, [])

  const handleConfirmAllVatTreatments = useCallback(() => {
    setSieData(prev => prev ? {
      ...prev,
      mappings: applyVatTreatmentReviewAll(prev.mappings),
    } : null)
  }, [])

  const handleMappingContinue = useCallback(() => {
    setStep('options')
  }, [])

  /**
   * Open the company's register fetch that is still open, if there is one,
   * and say why: true when it was opened. The job route allows one open
   * fetch per company, and a finished one stays open until its review is
   * accepted (migration_jobs_one_active_company).
   */
  const openActiveProviderJob = useCallback(async (): Promise<boolean> => {
    const response = await fetch('/api/extensions/ext/arcim-migration/migration-jobs', { cache: 'no-store' }).catch(() => null) // caller falls back to its error
    if (!response?.ok) return false
    const { data } = await response.json().catch(() => ({ data: null })) as { data: ProviderMigrationStatus | null }
    if (!data || data.job.state === 'completed') return false
    const waitingForReview = data.job.state === 'needs_attention'
    toast({
      title: t(waitingForReview ? 'ext_arcim_job_open_review_title' : 'ext_arcim_job_open_running_title'),
      description: t(waitingForReview ? 'ext_arcim_job_open_review_description' : 'ext_arcim_job_open_running_description'),
    })
    setLatestJobId(data.job.id)
    setProviderJobId(data.job.id)
    return true
  }, [t, toast])

  const handleStartMigration = useCallback(async () => {
    if (!consentId) return
    if (migrationInFlightRef.current) return
    migrationInFlightRef.current = true
    setIsStartingMigration(true)

    setStep('migrating')
    setDocumentsOnly(false)
    setMigrationStep('Startar migrering...')
    setMigrationProgress(5)
    setError(null)
    dispatchDocumentImport({ type: 'reset' })

    // The theater /sie-data built over every selected year. Without one, or
    // when every year is already imported and kept, the plain progress card
    // stays: a run that books no ledger must not animate one.
    setTheaterModel(sieData && sieFilesToImport(sieData.fileStatuses, migrationOptions).length > 0
      ? sieData.theater
      : null)

    try {
      // ── Phase 1: SIE import ──────────────────────────────────
      // Complete fiscal years chronologically: the new years, plus only
      // those already imported years the user ticked to replace (PH 185,
      // PH 180). Replacement is pinned to the execution reviewed in the
      // preview, including on retries.
      const filesToImport = sieData ? sieFilesToImport(sieData.fileStatuses, migrationOptions) : []
      if (sieData && filesToImport.length > 0) {
        setMigrationStep('Importerar bokföringsdata (SIE)...')
        setMigrationProgress(10)
        setSieImportResults([])

        for (let i = 0; i < filesToImport.length; i++) {
          const progress = 10 + Math.round((i / filesToImport.length) * 40)
          setMigrationProgress(progress)
          setMigrationStep(`Importerar bokföringsdata (SIE): fil ${i + 1} av ${filesToImport.length}...`)

          // Name the year in every per-file failure: a multi-year re-sync
          // that dies on ONE year must say which, or the user cannot act on
          // it (issue #1667: the current year re-imported, the prior year
          // refused, and the error never said so).
          const { fiscalYear, storagePath, filename } = filesToImport[i]
          const yearLabel = fiscalYear ? `Räkenskapsår ${fiscalYear}: ` : ''

          const res = await fetch('/api/extensions/ext/arcim-migration/import-sie', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              storagePath,filename,
              mappings: sieData.mappings,
              options: {
                createFiscalPeriod: true,
                importOpeningBalances: true,
                importTransactions: true,
                voucherSeries: migrationOptions.voucherSeries,
                supersedesImportId:filesToImport[i].previousImport?.id,
                ...(migrationOptions.onlyUsedAccounts ? { onlyUsedAccounts: true } : {}),
              },
            }),
          })

          if (!res.ok) {
            // The envelope's sentence, the details the route attached (the
            // voucher that failed validation, the accounts without a target)
            // and the reference for support: never the fallback text alone.
            const data = await res.json().catch(() => ({}))
            const failure = describeImportResponseFailure({ status: res.status, body: data })
            throw new UserFacingError(`${yearLabel}${formatImportFailure(failure)}`)
          }

          const submitted = await res.json() as {importId:string}
          let result: ImportResult
          try {
            result = await waitForSIEJob(submitted.importId,job => {
              setMigrationStep(yearLabel+'SIE: '+job.chunks_done+'/'+job.chunks_total)
            })
          } catch (err) {
            // The job's own reason is already user-facing; displayError must
            // not route it through the Swedish-pattern heuristic.
            if (err instanceof SIEJobFailedError) throw new UserFacingError(`${yearLabel}${err.message}`)
            throw err
          }
          setSieImportResults(prev => [...prev, result])
          // The import creates accounts and a räkenskapsår: every cached
          // picker must see them.
          void invalidateReferenceData(['ref:accounts', 'ref:fiscal-periods'])

          // The endpoint returns HTTP 200 with success:false when the import
          // itself failed (e.g. räkenskapsår mismatch). Stop here: continuing
          // to /migrate would hit its SIE-guard, whose "SIE måste importeras
          // först" message masks the real error.
          if (!result.success) {
            throw new UserFacingError(result.errors.length > 0
              ? `${yearLabel}${result.errors.join('\n')}`
              : `${yearLabel}SIE-importen misslyckades utan felmeddelande.`)
          }
        }
      }

      // ── Phase 2: API import (customers, suppliers, invoices) ──
      // The asset toggle is only rendered for Fortnox (the one provider with
      // an asset register API), but its DEFAULT_OPTIONS value stays true for
      // everyone. Gate it on the provider here too, so a hidden option can
      // never be the reason /migrate starts for a user who deselected every
      // visible API import.
      const effectiveImportAssets =
        selectedProvider === 'fortnox' && migrationOptions.importAssets
      const hasApiImport = migrationOptions.importCompanyInfo ||
        migrationOptions.importCustomers ||
        migrationOptions.importSuppliers ||
        migrationOptions.importSalesInvoices ||
        migrationOptions.importSupplierInvoices ||
        effectiveImportAssets

      let hadStepErrors = false
      if (hasApiImport) {
        setMigrationStep('Importerar kunder, leverantörer och fakturor...')
        setMigrationProgress(55)

        // Company metadata and the optional asset register retain their existing
        // paths. The growing customer/supplier/invoice registers belong to the
        // durable worker. Contact suggestions have their own nightly resolver.
        const requests = buildMigrateRequests(consentId, {
          importCompanyInfo: migrationOptions.importCompanyInfo,
          importAssets: effectiveImportAssets,
        })
        let merged: MigrationResults = {}
        for (const request of requests) {
          setMigrationStep(request.label)
          const res = await fetch('/api/extensions/ext/arcim-migration/migrate', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
            body: JSON.stringify({ ...request.body, reconcileVouchers: false, suggestParties: false }),
          })
          if (!res.ok) throw apiError(await res.json().catch(() => ({})), `HTTP ${res.status}`)
          const results = res.headers.get('content-type')?.includes('application/x-ndjson') && res.body
            ? await consumeMigrationStream(res.body, label => { if (label) setMigrationStep(label) })
            : (await res.json()).results as MigrationResults
          merged = mergeMigrationResults(merged, results)
          setMigrationResults(merged)
        }
        const selected = {
          customers: migrationOptions.importCustomers, suppliers: migrationOptions.importSuppliers,
          salesInvoices: migrationOptions.importSalesInvoices, supplierInvoices: migrationOptions.importSupplierInvoices,
        }
        const resources = MIGRATION_RESOURCES.filter(resource => selected[resource])
        if (resources.length) {
          const allSupplierInvoices = selectedProvider === 'fortnox'
            && migrationOptions.importSupplierInvoices && migrationOptions.importPaidSupplierInvoices
          const response = await fetch('/api/extensions/ext/arcim-migration/migration-jobs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ consentId, resources, ...(allSupplierInvoices ? { allSupplierInvoices: true } : {}) }),
          })
          const body = await response.json()
          if (!response.ok) {
            // One register fetch per company at a time: an earlier one still
            // open (finished but waiting for its review to be accepted, or
            // still running) refuses this one. The SIE import above is done
            // already, so open that fetch instead of a dead-end error
            // (crm#1660).
            if (apiErrorCode(body) === 'MIGRATION_ALREADY_ACTIVE' && await openActiveProviderJob()) return
            throw apiError(body, `HTTP ${response.status}`)
          }
          setProviderJobId(body.data.jobId)
          return
        }
        hadStepErrors = (merged.stepErrors?.length ?? 0) > 0
      }

      // Mark consent as fully accepted now that import is complete
      if (consentId) {
        await fetch('/api/extensions/ext/arcim-migration/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ consentId }),
        }).catch(() => { /* best-effort */ })
      }

      setMigrationProgress(100)
      setStep('result')

      const documentProvider = resolveArcimDocumentFollowUpProvider(
        preview?.consent.provider,
        selectedProvider,
      )
      if (documentProvider) {
        void runDocumentDiscovery(consentId, documentProvider, true)
      }

      if (hadStepErrors) {
        toast({
          title: 'Migrering delvis genomförd',
          description: 'Vissa delar kunde inte hämtas från leverantören. Se detaljerna i resultatet.',
          variant: 'destructive',
        })
      } else {
        toast({
          title: 'Migrering klar',
          description: 'Din bokföringsdata har importerats.',
        })
      }
    } catch (err) {
      setError(displayError(err))
      setStep('result')
    } finally {
      migrationInFlightRef.current = false
      setIsStartingMigration(false)
    }
  }, [consentId, migrationOptions, openActiveProviderJob, preview, runDocumentDiscovery, selectedProvider, sieData, toast])

  const handleDone = useCallback(() => {
    // Reset wizard
    setStep('provider')
    setSelectedProvider(null)
    setConsentId(null)
    setAuthUrl(null)
    setAuthType(null)
    setPreview(null)
    setSieData(null)
    setMigrationOptions(DEFAULT_OPTIONS)
    setMigrationResults(null)
    setProviderReview(null)
    setSieImportResults([])
    dispatchDocumentImport({ type: 'reset' })
    setDocumentsOnly(false)
    clearDocumentReconnectFailureCleanup()
    documentReconnectActionRef.current = null
    setTheaterModel(null)
    setError(null)
    // Refresh status so provider step shows updated import history
    fetchStatus()
  }, [clearDocumentReconnectFailureCleanup, fetchStatus])

  // ── Render ─────────────────────────────────────────────────────

  if (providerJobId) {
    return <ProviderMigrationProgress jobId={providerJobId} onReconnect={status => {
      reconnectJobRef.current = status.job.id
      setStep('preview')
      setProviderJobId(null)
      void handleReconnect(status.job.provider as ArcimProvider, status.job.consent_id ?? '')
    }} onResult={status => {
      const results: MigrationResults = {}
      for (const count of status.counts) {
        // skipped counts every record not imported, failures included, as the
        // per-step path does; without the job's skipped records here, a
        // resource with failures showed only "N misslyckades" and the skipped
        // ones vanished (agent feedback seq 939430).
        results[count.resource] = {
          total: count.total, imported: count.imported, skipped: count.skipped + count.needs_attention,
          skipReasons: { failed: count.needs_attention, reasonUnknown: count.skipped },
          ...(['salesInvoices', 'supplierInvoices'].includes(count.resource) ? {
            fxUnresolved: count.fx_unresolved, vatUnresolved: count.vat_unresolved, creditNotesUnlinked: count.credit_notes_unlinked,
            creditNotesLinked: count.credit_notes_linked ?? 0,
          } : {}),
        }
      }
      // A register that came back empty has no counts row: it still gets its
      // line, so an empty register no longer reads as one never asked for
      // (crm#1516).
      for (const resource of emptyMigrationRegisters(status.job, status.counts)) {
        results[resource] = { total: 0, imported: 0, skipped: 0 }
      }
      // The job, not this session's options, says whether Fortnox's paid
      // supplier invoices were listed too (crm#1114).
      if (results.supplierInvoices && status.job.fiscal_year_scope?.allSupplierInvoices) {
        results.supplierInvoices.paidIncluded = true
      }
      // A register the provider refused is a step that could not be fetched:
      // the result names it with the remedy, the same way /migrate reports one.
      const providerName = ARCIM_PROVIDERS.find(p => p.id === status.job.provider)?.name ?? status.job.provider
      const refused: MigrationStepError[] = migrationRefusals(status.job).flatMap(group => group.resources.map(resource => ({
        step: resource, code: 'PROVIDER_RESOURCE_FORBIDDEN', message: t(group.messageKey,
          migrationRefusalMessageValues(group.resources, providerName, r => t(`ext_arcim_job_resource_${r}`))),
      })))
      if (refused.length) results.stepErrors = refused
      setMigrationResults(previous => mergeMigrationResults(previous ?? {}, results))
      setProviderReview(status.issues.length ? {
        issues: status.issues, total: status.review.total, truncated: status.review.truncated,
        provider: status.job.provider, acceptedAt: status.job.review_accepted_at ?? null,
      } : null)
      setLatestJobId(status.job.id)
      setProviderJobId(null)
      setMigrationProgress(100)
      setStep('result')
      void fetchStatus()
      const provider = resolveArcimDocumentFollowUpProvider(preview?.consent.provider, selectedProvider)
      if (provider && status.job.consent_id) void runDocumentDiscovery(status.job.consent_id, provider, true)
    }} />
  }

  return (
    <div className="space-y-8">
      {step === 'provider' && <InvoiceCompletionRecovery onReconnect={id => {
        setStep('preview')
        void handleReconnect('fortnox', id)
      }} />}
      {step === 'provider' && latestJobId && <Button variant="outline" onClick={() => setProviderJobId(latestJobId)}>{t('ext_arcim_job_latest')}</Button>}
      {/* Step indicator: only during interactive steps */}
      {step !== 'provider' && isInteractiveStep && (
        <StepRail steps={userSteps} currentIndex={currentUserStepIndex} />
      )}

      {/* Step content */}
      {step === 'provider' && (
        <ProviderStep
          onSelect={handleSelectProvider}
          onResync={handleResync}
          onFetchDocuments={handleFetchDocuments}
          onReconnectDocuments={handleReconnectDocuments}
          onDisconnect={handleDisconnect}
          onTopupChanged={refreshStatusQuietly}
          connectionStatus={connectionStatus}
          isLoadingStatus={isLoadingStatus}
        />
      )}

      {step === 'connect' && selectedProvider && (
        <ConnectStep
          provider={selectedProvider}
          authType={authType}
          isLoading={isLoading}
          error={error}
          authUrl={authUrl}
          activationUrl={activationUrl}
          consentId={consentId}
          onOpenProviderWindow={handleOpenProviderWindow}
          onTokenSubmit={handleTokenSubmit}
          onBack={() => {
            setStep('provider')
            setError(null)
          }}
        />
      )}

      {step === 'preview' && (
        <PreviewStep
          preview={preview}
          isLoading={isLoading}
          error={error}
          authExpired={authExpired}
          licenseMissing={licenseMissing}
          selectedYears={selectedYears}
          onSelectedYearsChange={setSelectedYears}
          onReconnect={() => {
            if (selectedProvider && consentId) handleReconnect(selectedProvider, consentId)
          }}
          onRetry={() => {
            if (consentId) void loadPreview(consentId, { previewOnly: true })
          }}
          onContinue={handlePreviewContinue}
          onBack={() => setStep('provider')}
        />
      )}

      {step === 'mapping' && (
        <MappingStep
          sieData={sieData}
          isLoading={isLoading}
          error={error}
          errorDetails={errorDetails}
          onMappingChange={handleMappingChange}
          onVatTreatmentChange={handleVatTreatmentChange}
          onConfirmAllVatTreatments={handleConfirmAllVatTreatments}
          onContinue={handleMappingContinue}
          onBack={() => setStep('preview')}
        />
      )}

      {step === 'options' && (
        <OptionsStep
          options={migrationOptions}
          sieAvailable={preview?.sieAvailable ?? false}
          sieData={sieData}
          hasSieData={(preview?.hasSieData ?? false) || sieImportResults.some(r => r.success)}
          provider={preview?.consent.provider ?? null}
          isStarting={isStartingMigration}
          onChange={setMigrationOptions}
          onStart={handleStartMigration}
          onBack={() => preview?.sieAvailable ? setStep('mapping') : setStep('preview')}
        />
      )}

      {step === 'migrating' && (
        theaterModel ? (
          <ArcimMigrationTheater
            model={theaterModel}
            currentStep={migrationStep}
            progress={migrationProgress}
          />
        ) : (
          <MigratingStep currentStep={migrationStep} progress={migrationProgress} />
        )
      )}

      {step === 'result' && (
        <ResultStep
          provider={preview?.consent.provider ?? selectedProvider}
          results={migrationResults}
          sieResults={sieImportResults}
          omittedYears={sieData?.omittedYears ?? []}
          error={error}
          documentImportState={documentImportState}
          documentsOnly={documentsOnly}
          theaterModel={theaterModel}
          review={providerReview}
          onDone={handleDone}
          onRetry={() => {
            setError(null)
            setStep('options')
          }}
          onDiscoverDocuments={() => {
            if (consentId) void runDocumentDiscovery(consentId, documentImportState.provider, true)
          }}
          onImportDocuments={() => {
            // "Försök igen" after a run that stopped continues where it
            // stopped. An offer continues the run the server kept when one
            // stopped part-way (crm#1581); otherwise (no such run, failed
            // files in a finished run) the import runs from the top.
            if (consentId) {
              void runDocumentImport(
                consentId,
                documentImportState.phase === 'import-error' ? documentImportState.result : null,
              )
            }
          }}
          onDismissDocuments={() => {
            // A dismissed standalone run has nothing left to show: back to
            // the connections list instead of an empty result page.
            if (documentsOnly) {
              handleDone()
              return
            }
            dispatchDocumentImport({ type: 'dismissed' })
          }}
          onReconnectDocuments={handleDocumentReconnect}
        />
      )}
    </div>
  )
}
