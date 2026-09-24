'use client'

import { SIEJobFailedError, uploadSIEFile, waitForSIEJob } from '@/lib/import/sie-job-client'
import InvoiceCompletionRecovery from './InvoiceCompletionRecovery'
import { describeImportResponseFailure, formatImportFailure } from '@/lib/import/import-failure'
import { useState, useCallback, useEffect, useReducer, useRef } from 'react'
import { useAccounts } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AttnLine } from '@/components/ui/attn-line'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import Link from 'next/link'
import { getBranding } from '@/lib/branding/service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const branding = getBranding()
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  Loader2,
  Paperclip,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import {
  ARCIM_DOCUMENT_OAUTH_RESUME_KEY,
  INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
  ArcimDocumentImportRequestError,
  arcimDocumentImportReducer,
  documentOAuthProblemFromReason,
  parseArcimDocumentResumeMarker,
  PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE,
  requestArcimDocumentImport,
  runArcimDocumentImportToCompletion,
  resolveArcimDocumentFollowUpProvider,
  serializeArcimDocumentResumeMarker,
  watchArcimOAuthPopup,
  type ArcimDocumentImportProblem,
  type ArcimDocumentImportState,
} from './arcim-document-import-flow'

type ArcimProvider = 'fortnox' | 'visma' | 'briox' | 'bokio' | 'bjornlunden' | 'wint'

// `sieViaApi`: the provider serves its general ledger as SIE over the API:
// no manual SIE upload needed. Deliberately duplicated from
// extensions/general/arcim-migration/types.ts (core code must not import from
// @/extensions/: CI enforces it). Keep both lists in sync.
// WINT is env-gated server-side (WINT_MIGRATION_ENABLED): the wizard renders
// whatever GET /providers returns, so no client-side gate is needed here.
const ARCIM_PROVIDERS: { id: ArcimProvider; name: string; authType: 'oauth' | 'token'; sieViaApi: boolean }[] = [
  { id: 'fortnox', name: 'Fortnox', authType: 'oauth', sieViaApi: true },
  { id: 'visma', name: 'Visma', authType: 'oauth', sieViaApi: false },
  { id: 'bokio', name: 'Bokio', authType: 'token', sieViaApi: false },
  { id: 'bjornlunden', name: 'Björn Lundén', authType: 'token', sieViaApi: true },
  { id: 'briox', name: 'Briox', authType: 'token', sieViaApi: true },
  { id: 'wint', name: 'WINT', authType: 'token', sieViaApi: true },
]

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
  messages: { failed: string; connectionDropped: string },
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
      throw apiError(event, messages.failed)
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
    throw new UserFacingError(messages.connectionDropped)
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
import {
  buildMigrateRequests,
  mergeMigrationResults,
} from '@/extensions/general/arcim-migration/lib/migrate-plan'
import AccountMappingStep from '@/components/import/AccountMappingStep'
import ProviderMigrationProgress from './ProviderMigrationProgress'
import { MIGRATION_RESOURCES, type ProviderMigrationStatus } from '@/lib/providers/migration-contract'
import ArcimMigrationTheater from '@/components/extensions/general/ArcimMigrationTheater'
import TheaterCanvas from '@/components/import/TheaterCanvas'
import {
  applyVatTreatmentReview,
  applyVatTreatmentReviewAll,
  enrichChangedAccountMappingWithVat,
  enrichAccountMappingsWithVat,
} from '@/lib/import/account-vat-treatment'
import type { TheaterModel } from '@/lib/import/theater-model'
import type { AccountMapping, ImportResult, ParsedSIEFile } from '@/lib/import/types'
import type { AccountVatTreatment } from '@/lib/vat/account-vat-treatment'
import type { BASAccount } from '@/types'

// ── Types ────────────────────────────────────────────────────────

type WizardStep = 'provider' | 'connect' | 'preview' | 'mapping' | 'options' | 'migrating' | 'result'

const STEPS: WizardStep[] = ['provider', 'connect', 'preview', 'mapping', 'options', 'migrating', 'result']

type Translator = ReturnType<typeof useTranslations>

function stepLabel(t: Translator, step: WizardStep): string {
  switch (step) {
    case 'provider': return t('ext_arcim_step_provider')
    case 'connect': return t('ext_arcim_step_connect')
    case 'preview': return t('ext_arcim_step_preview')
    case 'mapping': return t('ext_arcim_step_mapping')
    case 'options': return t('ext_arcim_step_options')
    case 'migrating': return t('ext_arcim_step_migrating')
    case 'result': return t('ext_arcim_step_result')
  }
}

interface MigrationOptions {
  importCompanyInfo: boolean
  importSIEData: boolean
  importCustomers: boolean
  importSuppliers: boolean
  importSalesInvoices: boolean
  importSupplierInvoices: boolean
  importAssets: boolean
  voucherSeries: string
}

const DEFAULT_OPTIONS: MigrationOptions = {
  importCompanyInfo: true,
  importSIEData: true,
  importCustomers: true,
  importSuppliers: true,
  importSalesInvoices: true,
  importSupplierInvoices: true,
  importAssets: true,
  voucherSeries: 'B',
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
  sieStats: {
    accountCount: number
    transactionCount: number
    fiscalYears: number[]
  } | null
  // Every fiscal year the source has, oldest first, with the default
  // selection marked: rendered as the year picker so the user chooses
  // before the import runs and no year is left out silently (#2211, #2238).
  sourceYears?: SourceFiscalYear[]
  // The most years one run may select: /sie-data refuses more. Read from
  // the server so the picker never drifts from the route.
  maxSelectedYears?: number
  assetStats: {
    total: number
    importable: number
  } | null
  hasSieData: boolean
}

interface SIEFileStatus {
  fiscalYear: number
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
  parsed: ParsedSIEFile
  mappings: AccountMapping[]
  mappingStats: { total: number; mapped: number; unmapped: number }
  rawContent: string[]
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
      <h2 className="font-display text-2xl leading-8 tracking-tight text-balance">{title}</h2>
      {lede && <p className="mt-2 text-sm text-muted-foreground">{lede}</p>}
    </div>
  )
}

function SectionKicker({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  )
}

function SieFallbackLine({ message, label }: { message: string; label?: string }) {
  const t = useTranslations('extensions')
  return (
    <p className="text-[13px] text-muted-foreground">
      {message}{' '}
      <Link
        href="/import?mode=sie"
        className="underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground"
      >
        {label ?? t('ext_arcim_upload_sie_file')}
      </Link>
    </p>
  )
}

function SpinnerLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
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
  const t = useTranslations('extensions')
  const progressPercent = ((currentIndex + 1) / steps.length) * 100
  return (
    <nav aria-label={t('ext_arcim_steps_aria')}>
      <p className="text-[11px] font-medium uppercase tracking-wider sm:hidden">
        {t('ext_arcim_step_of', { current: currentIndex + 1, total: steps.length, label: stepLabel(t, steps[currentIndex]) })}
      </p>
      <ol className="hidden flex-wrap items-center gap-x-6 gap-y-1 sm:flex">
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={i === currentIndex ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider transition-colors duration-150',
              i === currentIndex
                ? 'text-foreground'
                : i < currentIndex
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/60'
            )}
          >
            {i < currentIndex && <Check className="h-3 w-3" aria-hidden="true" />}
            {stepLabel(t, s)}
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
  entityCounts: {
    customers: number
    suppliers: number
    invoices: number
  }
}

// Providers listed here render as a disabled "Kommer snart" card. WINT was
// the last entry: it is released now, so the set is empty. WINT still depends
// on WINT_MIGRATION_ENABLED=true, the server-side /connect gate.
const COMING_SOON_PROVIDERS = new Set<ArcimProvider>([])

const PROVIDER_LOGOS: Record<ArcimProvider, string> = {
  fortnox: '/logos/fortnox.svg',
  visma: '/logos/visma.jpeg',
  bokio: '/logos/bokio.png',
  bjornlunden: '/logos/bjornlunden.png',
  briox: '/logos/Briox_logo.png',
  wint: '/logos/wint.png',
}

function ProviderStep({
  onSelect,
  onResync,
  onFetchDocuments,
  onDisconnect,
  connectionStatus,
  isLoadingStatus,
}: {
  onSelect: (provider: ArcimProvider) => void
  onResync: (provider: ArcimProvider, consentId: string) => void
  /** Run the underlag import on its own against an active Fortnox consent. */
  onFetchDocuments: (consentId: string) => void
  onDisconnect: (consentId: string) => void
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

  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title={activeConsents.length > 0 ? t('ext_arcim_provider_title_additional') : t('ext_arcim_provider_title')}
        lede={t('ext_arcim_provider_lede')}
      />

      {/* SIE-required attention (not relevant for Fortnox/Briox: they fetch
          SIE via API): one ochre sentence with the action embedded, never a
          banner. */}
      {showSieRequiredBanner && (
        <AttnLine action={{ label: t('ext_arcim_upload_sie_file'), href: '/import?mode=sie' }}>
          {t('ext_arcim_sie_required_banner')}
        </AttnLine>
      )}

      {/* Existing connections: quiet hairline rows, no cards. Being connected
          is the normal state here, so it reads as muted text, not a chip. */}
      {activeConsents.length > 0 && (
        <section className="space-y-3">
          <SectionKicker>{t('ext_arcim_active_connections')}</SectionKicker>
          <div className="stagger-enter divide-y divide-border" data-no-stagger>
            {activeConsents.map((consent) => {
              const providerInfo = ARCIM_PROVIDERS.find(p => p.id === consent.provider)
              const completedImports = connectionStatus?.sieImports.filter(i => i.status === 'completed') ?? []
              const lastImport = connectionStatus?.latestCompletedSieImport ?? completedImports[0]

              return (
                <div key={consent.id} className="flex flex-wrap items-center gap-3 py-3 sm:flex-nowrap sm:gap-4">
                  <img
                    src={PROVIDER_LOGOS[consent.provider]}
                    alt={providerInfo?.name ?? consent.provider}
                    className="h-8 w-8 shrink-0 rounded-sm object-contain"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{providerInfo?.name ?? consent.provider}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {consent.companyName && <>{consent.companyName} · </>}
                      {lastImport ? (
                        <>
                          {t('ext_arcim_latest_import', { date: new Date(lastImport.imported_at ?? lastImport.created_at).toLocaleDateString('sv-SE') })}
                          {lastImport.transactions_count != null && (
                            <span className="tabular-nums">{t('ext_arcim_latest_import_vouchers', { count: lastImport.transactions_count })}</span>
                          )}
                        </>
                      ) : (
                        <>{t('ext_arcim_connected_on', { date: consent.createdAt ? new Date(consent.createdAt).toLocaleDateString('sv-SE') : '' })}</>
                      )}
                    </p>
                    {(connectionStatus?.entityCounts.customers ?? 0) > 0 && (
                      <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {t('ext_arcim_entity_counts', { customers: connectionStatus?.entityCounts.customers ?? 0, suppliers: connectionStatus?.entityCounts.suppliers ?? 0, invoices: connectionStatus?.entityCounts.invoices ?? 0 })}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onResync(consent.provider, consent.id)}
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      {t('ext_arcim_resync')}
                    </Button>
                    {/* The underlag offer used to live only in the result step
                        of the run that just finished; closing or reloading
                        lost it. From here it runs on its own, with the same
                        consent, without repeating the migration. */}
                    {consent.provider === 'fortnox' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onFetchDocuments(consent.id)}
                      >
                        <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                        {t('ext_arcim_documents_fetch_action')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t('ext_arcim_disconnect_aria', { provider: providerInfo?.name ?? consent.provider })}
                      onClick={() => onDisconnect(consent.id)}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Provider selection: quiet list rows on the page, hairline-divided. */}
      {isLoadingStatus ? (
        <div className="divide-y divide-border" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 py-3">
              <Skeleton className="h-8 w-8 shrink-0 rounded-sm" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
      ) : (
        <div className="stagger-enter divide-y divide-border" data-no-stagger>
          {ARCIM_PROVIDERS.map((provider) => {
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
                <img
                  src={PROVIDER_LOGOS[provider.id]}
                  alt={provider.name}
                  className="h-8 w-8 shrink-0 rounded-sm object-contain"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{provider.name}</p>
                    {comingSoon && (
                      <Badge variant="secondary">{t('ext_arcim_coming_soon')}</Badge>
                    )}
                    {alreadyConnected && (
                      <span className="text-xs text-muted-foreground">{t('ext_arcim_connected')}</span>
                    )}
                    {needsSieFirst && !comingSoon && !alreadyConnected && (
                      <Badge variant="warning">{t('ext_arcim_sie_required_first')}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {alreadyConnected
                      ? t('ext_arcim_use_resync_above')
                      : needsSieFirst
                        ? t('ext_arcim_import_sie_first')
                        : provider.authType === 'oauth'
                          ? t('ext_arcim_connect_via_login')
                          : provider.id === 'bjornlunden'
                            ? t('ext_arcim_connect_with_company_key')
                            : t('ext_arcim_connect_with_api_key')}
                  </p>
                </div>
                {!isDisabled && (
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground"
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
  onTokenSubmit: (apiToken: string, companyId: string) => void
  onBack: () => void
}) {
  const t = useTranslations('extensions')
  const providerName = ARCIM_PROVIDERS.find(p => p.id === provider)?.name ?? provider
  const [apiToken, setApiToken] = useState('')
  const [companyId, setCompanyId] = useState('')
  // With the Lundify redirect on offer, the User-Key field is the fallback for
  // a customer who activated inside Lundify already, so it starts folded.
  const [showManualKey, setShowManualKey] = useState(false)

  // BL uses server-side client credentials: only needs company ID, no API key
  const isClientCredentials = provider === 'bjornlunden'
  const hasLundifyActivation = isClientCredentials && !!activationUrl
  const manualKeyVisible = !hasLundifyActivation || showManualKey

  const openProviderWindow = (url: string) => {
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
      window.location.href = url
    }
  }
  // WINT has no API keys: the "token" is the user's WINT login (e-post +
  // lösenord), exchanged server-side for ett tokenpar; lösenordet sparas aldrig.
  const isWintLogin = provider === 'wint'
  const needsApiToken = !isClientCredentials
  // Briox: the account ID is the `clientid` half of the token exchange;
  // WINT reuses the same field for the login e-mail.
  const needsCompanyId = provider === 'bokio' || provider === 'bjornlunden' || provider === 'briox' || provider === 'wint'
  const companyIdLabel = provider === 'briox'
    ? t('ext_arcim_account_id_label')
    : provider === 'bjornlunden'
      ? t('ext_arcim_company_key_label')
      : provider === 'wint'
        ? t('ext_arcim_email_label')
        : provider === 'bokio'
          ? t('ext_arcim_bokio_company_id_label')
          : t('ext_arcim_company_id_label')

  const tokenDescription = hasLundifyActivation
    ? t('ext_arcim_bl_activate_description', { appName: branding.appName })
    : isClientCredentials
    ? t('ext_arcim_bl_token_description', { appName: branding.appName })
    : isWintLogin
      ? t('ext_arcim_wint_token_description', { appName: branding.appName.toLowerCase() })
      : provider === 'briox'
        ? t('ext_arcim_briox_token_description', { appName: branding.appName.toLowerCase() })
        : provider === 'bokio'
          ? t('ext_arcim_bokio_token_description', {
              appName: branding.appName.toLowerCase(),
            })
        : t('ext_arcim_api_key_token_description', { provider: providerName, appName: branding.appName.toLowerCase() })

  const tokenHelpText = isClientCredentials
    ? t('ext_arcim_bl_token_help')
    : isWintLogin
      ? t('ext_arcim_wint_token_help')
      : provider === 'bokio'
      ? t('ext_arcim_bokio_token_help')
      : provider === 'briox'
        ? t('ext_arcim_briox_token_help')
        : t('ext_arcim_generic_token_help', { provider: providerName })

  const canSubmit = isClientCredentials
    ? !!companyId
    : !!(apiToken && (!needsCompanyId || companyId))

  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title={t('ext_arcim_connect_to', { provider: providerName })}
        lede={authType === 'token'
          ? tokenDescription
          : t('ext_arcim_oauth_description', { provider: providerName, appName: branding.appName.toLowerCase() })}
      />

      {isLoading && <SpinnerLine>{t('ext_arcim_preparing_connection')}</SpinnerLine>}

      {error && (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">{t('ext_arcim_connection_failed')}</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            {provider === 'fortnox' && (
              <p className="text-sm text-muted-foreground">
                {t('ext_arcim_fortnox_integration_note')}
              </p>
            )}
          </div>
          <SieFallbackLine message={t('ext_arcim_sie_fallback_also')} />
        </div>
      )}

      {/* OAuth flow */}
      {authType === 'oauth' && authUrl && !isLoading && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('ext_arcim_oauth_click_below', { provider: providerName })}
          </p>
          <Button onClick={() => openProviderWindow(authUrl)}>
            {t('ext_arcim_oauth_login_button', { provider: providerName })}
            <ExternalLink className="ml-2 h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Björn Lundén: Lundify's activation redirect returns the User-Key
          itself. The popup posts arcim-oauth-success like the OAuth
          providers, so the same listener resumes the wizard. */}
      {authType === 'token' && consentId && !isLoading && hasLundifyActivation && activationUrl && (
        <div className="space-y-4">
          <Button onClick={() => openProviderWindow(activationUrl)}>
            {t('ext_arcim_bl_activate_button')}
            <ExternalLink className="ml-2 h-4 w-4" />
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
                    ? t('ext_arcim_app_token_label')
                    : isWintLogin
                      ? t('ext_arcim_password_label')
                      : provider === 'bokio'
                        ? t('ext_arcim_bokio_token_label')
                        : t('ext_arcim_api_key_label')}
                </label>
                <Input
                  id="apiToken"
                  name="apiToken_nocomplete"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    provider === 'briox'
                      ? t('ext_arcim_app_token_placeholder')
                      : isWintLogin
                        ? t('ext_arcim_wint_password_placeholder')
                        : provider === 'bokio'
                          ? t('ext_arcim_bokio_token_placeholder')
                        : t('ext_arcim_api_key_placeholder')
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
                      ? t('ext_arcim_company_key_placeholder')
                      : provider === 'briox'
                        ? t('ext_arcim_briox_account_id_placeholder')
                        : isWintLogin
                          ? t('ext_arcim_email_placeholder')
                          : t('ext_arcim_guid_placeholder')
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
              {t('ext_arcim_connect_button')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <div className="flex border-t border-border pt-6">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('ext_arcim_back')}
        </Button>
      </div>
    </div>
  )
}

// ── Preview step ────────────────────────────────────────────────

function PreviewStep({
  preview,
  isLoading,
  error,
  authExpired,
  licenseMissing,
  selectedYears,
  onSelectedYearsChange,
  onReconnect,
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
  const noYearSelected = showYearPicker && selectedYears.length === 0
  const maxSelectable = preview?.maxSelectedYears ?? null
  const tooManySelected = showYearPicker && maxSelectable != null && selectedYears.length > maxSelectable
  const toggleYear = (year: number) => {
    onSelectedYearsChange(
      selectedYears.includes(year)
        ? selectedYears.filter((y) => y !== year)
        : [...selectedYears, year].sort((a, b) => a - b),
    )
  }

  return (
    <div className="stagger-enter space-y-8">
      <div>
        <h2 className="font-display text-2xl leading-8 tracking-tight text-balance">
          {preview ? t('ext_arcim_connected_to', { provider: providerName }) : t('ext_arcim_step_preview')}
        </h2>

        {isLoading && (
          <div className="mt-3">
            <SpinnerLine>{t('ext_arcim_fetching_bookkeeping')}</SpinnerLine>
          </div>
        )}

        {/* SIE + asset stats: one quiet statline, the same grammar as the
            import reveal, instead of a boxed summary. The asset count renders
            on its own when the SIE fetch failed: the preview endpoint sets
            them independently. */}
        {(() => {
          const sieStats = preview?.sieAvailable ? preview.sieStats : null
          const assetCount = preview?.assetStats?.importable ?? 0
          if (!sieStats && assetCount === 0) return null
          const parts: string[] = []
          if (sieStats) {
            parts.push(t('ext_arcim_stat_accounts', { count: sieStats.accountCount.toLocaleString('sv-SE') }))
            parts.push(t('ext_arcim_stat_vouchers', { count: sieStats.transactionCount.toLocaleString('sv-SE') }))
            parts.push(
              sieStats.fiscalYears.length === 1
                ? t('ext_arcim_stat_fiscal_year_single', { year: sieStats.fiscalYears[0] })
                : t('ext_arcim_stat_fiscal_years', { count: sieStats.fiscalYears.length, years: sieStats.fiscalYears.join(', ') }),
            )
          }
          if (assetCount > 0) {
            parts.push(t('ext_arcim_stat_assets', { count: assetCount.toLocaleString('sv-SE') }))
          }
          return (
            <p className="animate-fade-in mt-3 text-[13px] text-muted-foreground tabular-nums">
              {parts.join(' · ')}
            </p>
          )
        })()}

        {preview && !preview.sieAvailable && !isLoading && preview.hasSieData && (
          <p className="animate-fade-in mt-3 text-[13px] text-muted-foreground">
            {t('ext_arcim_already_imported_via_sie')}
          </p>
        )}
      </div>

      {/* ── The year picker (issues #2211, #2238) ──
          Every fiscal year the source has, as hairline rows with a checkbox.
          The three latest are ticked by default (the limit that used to be a
          silent cap); older years are the user's own choice and their own
          wait: each one is another SIE export fetched in the next step. */}
      {showYearPicker && (
        <section className="space-y-3">
          <SectionKicker>{t('ext_arcim_year_select_kicker')}</SectionKicker>
          <p className="text-[13px] text-muted-foreground">{t('ext_arcim_year_select_lede')}</p>
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
            <p className="text-sm font-medium text-destructive">{t('ext_arcim_fetch_bookkeeping_failed')}</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          {authExpired && (
            <Button size="sm" onClick={onReconnect} disabled={isLoading}>
              <RotateCcw className="mr-2 h-4 w-4" />
              {t('ext_arcim_reconnect_provider', { provider: providerName })}
            </Button>
          )}
          {/* License-missing keeps the SIE fallback visible: re-auth loops
              until the customer re-orders the Fortnox Integration license,
              so a manual SIE import is the reliable escape hatch. */}
          {(!authExpired || licenseMissing) && (
            <SieFallbackLine message={t('ext_arcim_sie_fallback_also')} />
          )}
        </div>
      )}

      {preview && !preview.sieAvailable && !isLoading && !preview.hasSieData && (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">{t('ext_arcim_sie_import_required')}</p>
            <p className="text-sm text-muted-foreground">
              {t('ext_arcim_sie_import_required_body', {
                provider: ARCIM_PROVIDERS.find(p => p.id === preview.consent.provider)?.name ?? t('ext_arcim_your_accounting_system'),
                appName: branding.appName.toLowerCase(),
              })}
            </p>
          </div>
          <SieFallbackLine message={t('ext_arcim_when_exported')} label={t('ext_arcim_go_to_sie_import')} />
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('ext_arcim_back')}
        </Button>
        <Button
          onClick={onContinue}
          disabled={isLoading || noYearSelected || tooManySelected || (!!preview && !preview.sieAvailable && !preview.hasSieData)}
        >
          {t('ext_arcim_continue')}
          <ArrowRight className="ml-2 h-4 w-4" />
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
  const t = useTranslations('extensions')
  if (isLoading) {
    return <SpinnerLine>{t('ext_arcim_analyzing')}</SpinnerLine>
  }

  if (error) {
    return (
      <div className="stagger-enter space-y-8">
        <div className="space-y-1">
          <p className="text-sm font-medium text-destructive">{t('ext_arcim_load_sie_failed')}</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          {errorDetails && errorDetails.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              {errorDetails.slice(0, 8).map((detail, i) => (
                <li key={i} className="break-words">{detail}</li>
              ))}
              {errorDetails.length > 8 && (
                <li>{t('ext_arcim_more_errors', { count: errorDetails.length - 8 })}</li>
              )}
            </ul>
          )}
        </div>
        <SieFallbackLine message={t('ext_arcim_sie_fallback_persisting')} />
        <div className="flex border-t border-border pt-6">
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('ext_arcim_back')}
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

function OptionsStep({
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
  const newFileCount = sieData?.newFileCount ?? 0
  const replacedFileCount = fileStatuses.filter(fs => fs.previousImport).length
  const yearsToReplace = fileStatuses
    .filter(fs => fs.previousImport)
    .map(fs => fs.fiscalYear)
  const failedYears = sieData?.failedYears ?? []

  const selectedItems: string[] = []
  if (options.importCompanyInfo) selectedItems.push(t('ext_arcim_item_company_info'))
  if (sieAvailable && options.importSIEData) selectedItems.push(t('ext_arcim_item_sie'))
  if (options.importCustomers) selectedItems.push(t('ext_arcim_item_customers'))
  if (options.importSuppliers) selectedItems.push(t('ext_arcim_item_suppliers'))
  if (options.importSalesInvoices) selectedItems.push(t('ext_arcim_item_sales_invoices'))
  if (options.importSupplierInvoices) selectedItems.push(t('ext_arcim_item_supplier_invoices'))
  if (provider === 'fortnox' && options.importAssets) selectedItems.push(t('ext_arcim_item_assets'))

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
        title={t('ext_arcim_options_title')}
        lede={t('ext_arcim_options_lede')}
      />

      {/* Years whose provider export failed: must be visible before the user
          proceeds, otherwise an IB/UB gap slips through. One ochre sentence.
          Yields to the SIE-required line below: with SIE unchecked no year is
          imported, and the page carries at most one attn line. */}
      {sieAvailable && failedYears.length > 0 && !sieRequiredButUnchecked && (
        <AttnLine>
          {failedYears.length === 1
            ? t('ext_arcim_failed_year_single', { year: failedYears[0].year })
            : t('ext_arcim_failed_years', { years: failedYears.map(f => f.year).join(', ') })}
        </AttnLine>
      )}

      {/* Clean hairline rows with the toggle on the right: no bordered box
          per row, no nested boxes. */}
      <div className="stagger-enter divide-y divide-border" data-no-stagger>
        <OptionRow
          label={t('ext_arcim_item_company_info')}
          description={t('ext_arcim_option_company_info_desc')}
          checked={options.importCompanyInfo}
          onChange={() => toggleOption('importCompanyInfo')}
        />

        {sieAvailable && (
          <div>
            <OptionRow
              label={t('ext_arcim_item_sie')}
              description={
                replacedFileCount > 0 && newFileCount > 0
                  ? t('ext_arcim_option_sie_new_and_replaced', { newCount: newFileCount, replacedCount: replacedFileCount })
                  : replacedFileCount > 0
                    ? t('ext_arcim_option_sie_replaced', { count: replacedFileCount })
                    : newFileCount > 0
                      ? t('ext_arcim_option_sie_new', { count: newFileCount })
                      : t('ext_arcim_option_sie_desc')
              }
              checked={options.importSIEData}
              onChange={() => toggleOption('importSIEData')}
            />
            {/* Per-file import status: quiet muted lines. */}
            {fileStatuses.length > 0 && (
              <div className="space-y-1 pb-3">
                {fileStatuses.map((fs) => (
                  <p key={fs.fiscalYear} className="text-xs text-muted-foreground tabular-nums">
                    {fs.previousImport
                      ? fs.previousImport.importedAt
                        ? t('ext_arcim_file_replaces_import_from', { year: fs.fiscalYear, date: new Date(fs.previousImport.importedAt).toLocaleDateString('sv-SE') })
                        : t('ext_arcim_file_replaces_import', { year: fs.fiscalYear })
                      : t('ext_arcim_file_new_data', { year: fs.fiscalYear })}
                  </p>
                ))}
              </div>
            )}
            {/* Verifikationsserie: one aligned row, not a nested box. */}
            {options.importSIEData && (
              <div className="flex items-center gap-3 border-t border-border py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t('ext_arcim_voucher_series')}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('ext_arcim_option_series_help')}</p>
                </div>
                <Input
                  className="w-16 text-center"
                  aria-label={t('ext_arcim_voucher_series')}
                  value={options.voucherSeries}
                  onChange={(e) => onChange({ ...options, voucherSeries: e.target.value.toUpperCase() || 'B' })}
                  maxLength={2}
                />
              </div>
            )}
          </div>
        )}

        <OptionRow
          label={t('ext_arcim_item_customers')}
          description={t('ext_arcim_option_customers_desc')}
          checked={options.importCustomers}
          onChange={() => toggleOption('importCustomers')}
        />
        <OptionRow
          label={t('ext_arcim_item_suppliers')}
          description={t('ext_arcim_option_suppliers_desc')}
          checked={options.importSuppliers}
          onChange={() => toggleOption('importSuppliers')}
        />
        <OptionRow
          label={t('ext_arcim_item_sales_invoices')}
          description={t('ext_arcim_option_sales_invoices_desc')}
          checked={options.importSalesInvoices}
          onChange={() => toggleOption('importSalesInvoices')}
        />
        <OptionRow
          label={t('ext_arcim_item_supplier_invoices')}
          description={provider === 'fortnox'
            ? t('ext_arcim_option_supplier_invoices_fortnox_desc')
            : t('ext_arcim_option_supplier_invoices_desc')}
          checked={options.importSupplierInvoices}
          onChange={() => toggleOption('importSupplierInvoices')}
        />
        {provider === 'fortnox' && (
          <OptionRow
            label={t('ext_arcim_item_assets')}
            description={t('ext_arcim_option_assets_desc')}
            checked={options.importAssets}
            onChange={() => toggleOption('importAssets')}
          />
        )}
      </div>

      {sieRequiredButUnchecked && (
        <AttnLine>{t('ext_arcim_option_sie_required_hint')}</AttnLine>
      )}

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('ext_arcim_back')}
        </Button>
        <Button onClick={() => setShowConfirm(true)} disabled={selectedItems.length === 0 || sieRequiredButUnchecked || isStarting}>
          {t('ext_arcim_start_migration')}
          <ArrowRight className="ml-2 h-4 w-4" />
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
        title={t('ext_arcim_start_migration')}
        confirmLabel={t('ext_arcim_start_migration')}
      >
        {/* One sentence naming what happens, the selection as a compact muted
            line list, no caution: nothing here needs one. */}
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm">
              {t('ext_arcim_confirm_intro', { appName: branding.appName.toLowerCase() })}
            </p>
            <ul className="space-y-1">
              {selectedItems.map((item) => (
                <li key={item} className="text-sm text-muted-foreground">{item}</li>
              ))}
            </ul>
          </div>

          {options.importSIEData && yearsToReplace.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('ext_arcim_confirm_replace', { years: yearsToReplace.join(', '), appName: branding.appName.toLowerCase() })}
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
  const t = useTranslations('extensions')
  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title={t('ext_arcim_migrating_title')}
        lede={t('ext_arcim_migrating_lede')}
      />
      <div className="max-w-md space-y-3">
        <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
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
function getFYStatus(t: Translator, r: ImportResult): { tone: 'success' | 'warning' | 'error'; label: string } {
  if (r.errors.length > 0 && r.journalEntriesCreated === 0) {
    return { tone: 'error', label: t('ext_arcim_fy_status_failed') }
  }
  if (r.errors.length > 0 || (r.details?.skippedVouchers && r.details.skippedVouchers.total > 0)) {
    return { tone: 'warning', label: t('ext_arcim_fy_status_partial') }
  }
  return { tone: 'success', label: t('ext_arcim_fy_status_imported') }
}

/** Compose the opening-balance adjustment into one quiet sentence. */
function openingBalanceSentence(t: Translator, ob: NonNullable<NonNullable<ImportResult['details']>['openingBalance']>): string {
  const amount = `${Math.abs(ob.imbalance).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK`
  const account = ob.bookedToAccount ?? ''
  if (ob.explanation === 'unallocated_result') {
    return t('ext_arcim_ob_unallocated_result', { amount, account })
  }
  if (ob.explanation === 'excluded_accounts') {
    return t('ext_arcim_ob_excluded_accounts', { amount, account })
  }
  if (ob.explanation === 'rounding') {
    return t('ext_arcim_ob_rounding', { amount, account })
  }
  return t('ext_arcim_ob_generic', { amount, account })
}

/**
 * What the import did that is worth knowing but needs no action: shown
 * behind a small info icon next to the status label, never as lines.
 */
function fiscalYearInfoLines(t: Translator, result: ImportResult): string[] {
  const d = result.details
  const lines: string[] = []
  if (result.accountsCreated && result.accountsCreated > 0) {
    lines.push(t('ext_arcim_info_accounts_created', { count: result.accountsCreated }))
  }
  if (result.accountsRenamed && result.accountsRenamed > 0) {
    lines.push(t('ext_arcim_info_accounts_renamed', { count: result.accountsRenamed }))
  }
  if (d?.openingBalanceSkipped === 'prior_activity') {
    lines.push(t('ext_arcim_info_ob_derived'))
  }
  if (d?.openingBalance) lines.push(openingBalanceSentence(t, d.openingBalance))
  if (d?.migrationAdjustment?.created) {
    lines.push(t('ext_arcim_info_adjustment_created', { count: d.migrationAdjustment.accountsAdjusted }))
  }
  if (d && d.retriedBatches > 0 && d.failedBatches === 0) {
    lines.push(t('ext_arcim_info_batches_retried', { count: d.retriedBatches }))
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
function untransferredResultSentences(t: Translator, results: ImportResult[]): string[] {
  const seen = new Map<string, string>()
  for (const r of results) {
    for (const u of r.details?.untransferredResults ?? []) {
      if (seen.has(u.fiscal_period_id)) continue
      seen.set(
        u.fiscal_period_id,
        t('ext_arcim_untransferred_result', {
          period: u.period_name,
          amount: u.pl_net.toLocaleString('sv-SE', { minimumFractionDigits: 2 }),
        })
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
  const t = useTranslations('extensions')
  const [showRemarks, setShowRemarks] = useState(false)
  const status = getFYStatus(t, result)
  const d = result.details
  const fyLabel = d?.fiscalYear
    ? formatFiscalYearLabel(d.fiscalYear.start, d.fiscalYear.end)
    : t('ext_arcim_fiscal_year_n', { n: index + 1 })

  // The one ochre sentence: vouchers the import could not carry over.
  let skippedSentence: string | null = null
  if (d?.skippedVouchers && d.skippedVouchers.total > 0) {
    const parts: string[] = []
    if (d.skippedVouchers.empty > 0) parts.push(t('ext_arcim_skipped_empty', { count: d.skippedVouchers.empty }))
    if (d.skippedVouchers.unbalanced > 0) parts.push(t('ext_arcim_skipped_unbalanced', { count: d.skippedVouchers.unbalanced }))
    if (d.skippedVouchers.singleLine > 0) parts.push(t('ext_arcim_skipped_single_line', { count: d.skippedVouchers.singleLine }))
    if (d.skippedVouchers.unmapped > 0) {
      // Name the accounts (issue #2212): a count alone sends the user to diff
      // the general ledger against the source system by hand.
      const perAccount = (d.skippedVouchers.unmappedAccounts ?? [])
        .map((a) => t('ext_arcim_skipped_account_entry', { account: a.account, count: a.vouchers }))
        .join(', ')
      parts.push(
        perAccount
          ? t('ext_arcim_skipped_unmapped_accounts', { count: d.skippedVouchers.unmapped, accounts: perAccount })
          : t('ext_arcim_skipped_unmapped', { count: d.skippedVouchers.unmapped })
      )
    }
    skippedSentence = t('ext_arcim_skipped_sentence', { count: d.skippedVouchers.total, parts: parts.join(', ') })
  }

  const remarks = remainingWarnings(result)
  const infoLines = fiscalYearInfoLines(t, result)

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-sm font-medium tabular-nums">{fyLabel}</span>
        <span className="text-sm text-muted-foreground tabular-nums">
          {t('ext_arcim_stat_vouchers', { count: result.journalEntriesCreated.toLocaleString('sv-SE') })}
          {result.replacedPriorImport && result.replacedPriorImport.deletedEntries > 0 && (
            <>{t('ext_arcim_replaced_prior', { count: result.replacedPriorImport.deletedEntries.toLocaleString('sv-SE') })}</>
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
              {t('ext_arcim_remarks', { count: remarks.length })}
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
            <li key={i} className="text-[12.5px] leading-5 text-muted-foreground">{w}</li>
          ))}
        </ul>
      )}
      {d && d.failedBatches > 0 && (
        <p className="mt-1 text-[12.5px] leading-5 text-destructive">
          {t('ext_arcim_batches_failed', { retried: d.retriedBatches, failed: d.failedBatches })}
        </p>
      )}
    </div>
  )
}

function DocumentImportFollowUp({
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

  const title = (
    <SectionKicker>
      {standalone ? t('ext_arcim_documents_title_standalone') : t('ext_arcim_documents_title')}
    </SectionKicker>
  )

  if (
    state.phase === 'discovering' ||
    state.phase === 'importing' ||
    state.phase === 'reconnecting'
  ) {
    const label =
      state.phase === 'discovering'
        ? t('ext_arcim_documents_discovering')
        : state.phase === 'importing'
          ? t('ext_arcim_documents_importing')
          : t('ext_arcim_documents_reconnecting')

    // Running totals arrive after each server slice of a real import; the
    // dry-run result that sits in state while the first slice runs is not
    // progress, so it stays silent.
    const progress =
      state.phase === 'importing' && state.result && !state.result.dryRun && state.result.total > 0
        ? state.result
        : null

    return (
      <section className="space-y-3" aria-live="polite">
        {title}
        <SpinnerLine>{label}</SpinnerLine>
        {progress && (
          <p className="text-sm tabular-nums text-muted-foreground">
            {t('ext_arcim_documents_import_progress', {
              done: progress.scanned,
              total: progress.total,
            })}
          </p>
        )}
      </section>
    )
  }

  if (state.phase === 'offered') {
    return (
      <section className="space-y-3" aria-live="polite">
        {title}
        <p className="text-sm text-muted-foreground">
          {standalone
            ? t('ext_arcim_documents_prompt_standalone', { count: state.found })
            : t('ext_arcim_documents_prompt', { count: state.found })}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button onClick={onImport}>
            {t('ext_arcim_documents_import_action')}
          </Button>
          <Button variant="ghost" onClick={onDismiss}>
            {t('ext_arcim_documents_not_now')}
          </Button>
        </div>
      </section>
    )
  }

  if (state.phase === 'empty') {
    return (
      <section className="space-y-3" aria-live="polite">
        {title}
        <p className="text-sm text-muted-foreground">{t('ext_arcim_documents_empty')}</p>
        <Button variant="outline" onClick={onDiscover}>
          <RotateCcw className="mr-2 h-4 w-4" />
          {t('ext_arcim_documents_retry_discovery')}
        </Button>
      </section>
    )
  }

  if (state.phase === 'complete') {
    if (!state.result) {
      return (
        <section className="space-y-3" aria-live="polite">
          {title}
          <p className="text-sm text-muted-foreground">{t('ext_arcim_documents_result_description')}</p>
        </section>
      )
    }

    const { linked, skipped, unmatched, failed } = state.result
    const outcomes = [
      {
        label: t('ext_arcim_documents_imported'),
        value: linked,
        valueClassName: 'text-foreground',
      },
      {
        label: t('ext_arcim_documents_skipped'),
        value: skipped,
        valueClassName: 'text-foreground',
      },
      {
        label: t('ext_arcim_documents_unmatched'),
        value: unmatched,
        valueClassName: 'text-foreground',
      },
      {
        label: t('ext_arcim_documents_failed'),
        value: failed,
        valueClassName: failed > 0 ? 'text-destructive' : 'text-foreground',
      },
    ]

    return (
      <section className="space-y-4" aria-live="polite">
        {title}
        <p className="text-sm text-muted-foreground">{t('ext_arcim_documents_result_description')}</p>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {outcomes.map(({ label, value, valueClassName }) => (
            <div key={label} className="flex flex-col">
              <dt className="order-2 text-xs text-muted-foreground">{label}</dt>
              <dd className={cn('order-1 font-display text-xl tabular-nums', valueClassName)}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {unmatched > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('ext_arcim_documents_unmatched_help')}
          </p>
        )}
        {failed > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-destructive">
              {t('ext_arcim_documents_partial_failure')}
            </p>
            <Button variant="outline" onClick={onImport}>
              <RotateCcw className="mr-2 h-4 w-4" />
              {t('ext_arcim_documents_retry_import')}
            </Button>
          </div>
        )}
      </section>
    )
  }

  const reconnectRequired = state.problem?.reconnectRequired === true
  const discoveryFailed = state.phase === 'discovery-error'
  // Fortnox has not granted the file permissions to the integration itself, so
  // neither reconnecting nor retrying can succeed: state it and offer nothing.
  const scopesUnavailable =
    state.problem?.code === PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE
  return (
    <section className="space-y-3" aria-live="polite">
      {title}
      <p className="text-sm text-destructive">
        {scopesUnavailable
          ? t('ext_arcim_documents_scope_unavailable')
          : state.problem?.message
          ? state.problem.message
          : reconnectRequired
          ? t('ext_arcim_documents_scope_error')
          : discoveryFailed
            ? standalone
              ? t('ext_arcim_documents_discovery_error_standalone')
              : t('ext_arcim_documents_discovery_error')
            : standalone
              ? t('ext_arcim_documents_import_error_standalone')
              : t('ext_arcim_documents_import_error')}
      </p>
      {state.problem?.providerMessage && (
        <p className="text-xs text-muted-foreground">
          {t('ext_arcim_documents_provider_message', {
            message: state.problem.providerMessage,
          })}
        </p>
      )}
      {state.problem?.requestId && (
        <p className="text-xs text-muted-foreground">
          {t('ext_arcim_documents_error_reference', {
            requestId: state.problem.requestId,
          })}
        </p>
      )}
      {!scopesUnavailable && (
        <Button
          onClick={reconnectRequired ? onReconnect : discoveryFailed ? onDiscover : onImport}
        >
          {reconnectRequired ? (
            <RefreshCw className="mr-2 h-4 w-4" />
          ) : (
            <RotateCcw className="mr-2 h-4 w-4" />
          )}
          {reconnectRequired
            ? t('ext_arcim_documents_reconnect_action')
            : discoveryFailed
              ? t('ext_arcim_documents_retry_discovery')
              : t('ext_arcim_documents_retry_import')}
        </Button>
      )}
    </section>
  )
}

function nextSteps(t: Translator): { title: string; sub: string }[] {
  return [
    { title: t('ext_arcim_next_review_title'), sub: t('ext_arcim_next_review_sub') },
    { title: t('ext_arcim_next_balance_title'), sub: t('ext_arcim_next_balance_sub') },
    { title: t('ext_arcim_next_parties_title'), sub: t('ext_arcim_next_parties_sub') },
  ]
}

function ResultStep({
  results,
  sieResults,
  omittedYears,
  error,
  documentImportState,
  documentsOnly,
  theaterModel,
  onDone,
  onRetry,
  onDiscoverDocuments,
  onImportDocuments,
  onDismissDocuments,
  onReconnectDocuments,
}: {
  results: MigrationResults | null
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
    const completed = completedStepLines(t, results)
    return (
      <div className="stagger-enter space-y-8">
        <div>
          <h2 className="font-display text-2xl leading-8 tracking-tight text-balance">
            {completed.length > 0 ? t('ext_arcim_migration_aborted') : t('ext_arcim_migration_failed_title')}
          </h2>
          <p className="mt-3 whitespace-pre-line text-sm text-destructive">{error}</p>
        </div>
        {completed.length > 0 && (
          <div>
            <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              {t('ext_arcim_completed_before_error')}
            </h3>
            <ul className="mt-3 space-y-1 text-sm">
              {completed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted-foreground">
              {t('ext_arcim_rerun_missing_steps')}
            </p>
          </div>
        )}
        <SieFallbackLine message={t('ext_arcim_sie_fallback_instead')} />
        <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
          <Button variant="outline" onClick={onDone}>{t('ext_arcim_done')}</Button>
          <Button onClick={onRetry}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {t('ext_arcim_try_again')}
          </Button>
        </div>
      </div>
    )
  }

  if (documentsOnly) {
    // Nothing was migrated in this run, so no verdict, stats or next steps:
    // the underlag flow is the whole page.
    return (
      <div className="stagger-enter space-y-8">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('ext_arcim_documents_standalone_kicker')}
          </p>
          <h2 className="mt-2 font-display text-2xl leading-8 tracking-tight text-balance">
            {t('ext_arcim_documents_title_standalone')}
          </h2>
          <p className="mt-3 text-[13px] text-muted-foreground">
            {t('ext_arcim_documents_standalone_lede')}
          </p>
        </div>
        <DocumentImportFollowUp
          state={documentImportState}
          standalone
          onDiscover={onDiscoverDocuments}
          onImport={onImportDocuments}
          onDismiss={onDismissDocuments}
          onReconnect={onReconnectDocuments}
        />
        <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
          <Button variant="outline" onClick={onDone}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('ext_arcim_documents_standalone_back')}
          </Button>
          <Button asChild>
            <Link href="/bookkeeping">
              {t('ext_arcim_view_bookkeeping')}
              <ExternalLink className="ml-2 h-4 w-4" />
            </Link>
          </Button>
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
  const nothingNew = sieResults.length === 0 && !entityImported && !apiFailed

  // ── The reveal: a serif verdict derived from the real results ──
  const fyCount = sieResults.length
  const verdict = nothingNew
    ? t('ext_arcim_verdict_up_to_date')
    : (anySieFailed || apiFailed)
      ? t('ext_arcim_verdict_partial')
      : totalJournalEntries > 0
        ? fyCount === 1
          ? t('ext_arcim_verdict_vouchers', { count: totalJournalEntries.toLocaleString('sv-SE') })
          : t('ext_arcim_verdict_vouchers_years', { count: totalJournalEntries.toLocaleString('sv-SE'), years: fyCount })
        : (sieResults.length > 0 && !allSieSucceeded) || totalErrors > 0
          ? t('ext_arcim_verdict_done_with_remarks')
          : t('ext_arcim_verdict_done')

  const statParts: string[] = []
  if (totalJournalEntries > 0) statParts.push(t('ext_arcim_result_stat_vouchers', { count: totalJournalEntries.toLocaleString('sv-SE') }))
  if (fyCount > 0) statParts.push(t('ext_arcim_result_stat_fiscal_years', { count: fyCount }))
  const customerCount = (results?.customers?.imported ?? 0) + (results?.customers?.updated ?? 0)
  if (customerCount > 0) statParts.push(t('ext_arcim_result_stat_customers', { count: customerCount.toLocaleString('sv-SE') }))
  if ((results?.suppliers?.imported ?? 0) > 0) statParts.push(t('ext_arcim_result_stat_suppliers', { count: results!.suppliers!.imported.toLocaleString('sv-SE') }))
  const invoiceCount = (results?.salesInvoices?.imported ?? 0) + (results?.supplierInvoices?.imported ?? 0)
  if (invoiceCount > 0) statParts.push(t('ext_arcim_result_stat_invoices', { count: invoiceCount.toLocaleString('sv-SE') }))

  // The settled constellation only appears over a story that is true:
  // it needs the model and actually imported entries.
  const showCanvas = !!theaterModel && totalJournalEntries > 0

  // Övriga data as a quiet line list, not a card grid.
  const entityLines: { label: string; value: string; detail?: string; failed: boolean }[] = []
  if (results) {
    if (results.companyInfo?.imported) {
      entityLines.push({ label: t('ext_arcim_item_company_info'), value: t('ext_arcim_fy_status_imported'), failed: false })
    }
    if (results.customers && (results.customers.imported > 0 || (results.customers.updated ?? 0) > 0 || results.customers.skipped > 0)) {
      entityLines.push({
        label: t('ext_arcim_item_customers'),
        value: results.customers.updated
          ? t('ext_arcim_imported_and_completed', { imported: results.customers.imported, updated: results.customers.updated })
          : t('ext_arcim_imported_count', { count: results.customers.imported }),
        detail: results.customers.skipped > 0
          ? formatSkipReasons(t, results.customers.skipReasons, 'customer', results.customers.errorSample) ?? t('ext_arcim_skipped_count', { count: results.customers.skipped })
          : undefined,
        failed: entityRowStatus(results.customers.imported, results.customers.skipReasons) === 'error',
      })
    }
    if (results.suppliers && (results.suppliers.imported > 0 || results.suppliers.skipped > 0)) {
      entityLines.push({
        label: t('ext_arcim_item_suppliers'),
        value: t('ext_arcim_imported_count', { count: results.suppliers.imported }),
        detail: results.suppliers.skipped > 0
          ? formatSkipReasons(t, results.suppliers.skipReasons, 'supplier', results.suppliers.errorSample) ?? t('ext_arcim_skipped_count', { count: results.suppliers.skipped })
          : undefined,
        failed: entityRowStatus(results.suppliers.imported, results.suppliers.skipReasons) === 'error',
      })
    }
    if (results.salesInvoices && (results.salesInvoices.imported > 0 || results.salesInvoices.skipped > 0)) {
      entityLines.push({
        label: t('ext_arcim_item_sales_invoices'),
        value: t('ext_arcim_imported_count', { count: results.salesInvoices.imported }),
        detail: results.salesInvoices.skipped > 0
          ? formatSkipReasons(t, results.salesInvoices.skipReasons, 'invoice', results.salesInvoices.errorSample) ?? t('ext_arcim_skipped_count', { count: results.salesInvoices.skipped })
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
        value: t('ext_arcim_imported_count', { count: unlinked + linked }),
        detail: [
          linked > 0 ? t('ext_arcim_credit_notes_linked_detail', { count: linked }) : null,
          unlinked > 0 ? t('ext_arcim_credit_notes_unlinked_detail', { count: unlinked }) : null,
        ].filter(Boolean).join(' '),
        failed: false,
      })
    }
    if (results.supplierInvoices && (results.supplierInvoices.imported > 0 || results.supplierInvoices.skipped > 0)) {
      entityLines.push({
        label: t('ext_arcim_item_supplier_invoices'),
        value: t('ext_arcim_imported_count', { count: results.supplierInvoices.imported }),
        detail: results.supplierInvoices.skipped > 0
          ? formatSkipReasons(t, results.supplierInvoices.skipReasons, 'invoice', results.supplierInvoices.errorSample) ?? t('ext_arcim_skipped_count', { count: results.supplierInvoices.skipped })
          : undefined,
        failed: entityRowStatus(results.supplierInvoices.imported, results.supplierInvoices.skipReasons) === 'error',
      })
    }
    for (const [key, count] of [
      ['vat', (results.salesInvoices?.vatUnresolved ?? 0) + (results.supplierInvoices?.vatUnresolved ?? 0)],
      ['fx', (results.salesInvoices?.fxUnresolved ?? 0) + (results.supplierInvoices?.fxUnresolved ?? 0)],
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
        label: t('ext_arcim_item_assets'),
        value: results.assets.scopesMissing ? t('ext_arcim_skipped_label') : t('ext_arcim_imported_count', { count: results.assets.imported }),
        detail: results.assets.scopesMissing
          ? t('ext_arcim_assets_scope_missing')
          : results.assets.skipped > 0
            ? formatSkipReasons(t, results.assets.skipReasons, 'asset', results.assets.errorSample) ?? t('ext_arcim_skipped_count', { count: results.assets.skipped })
            : undefined,
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
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('ext_arcim_result_kicker')}
          </p>
          <h2 className="mt-2 font-display text-2xl leading-8 tracking-tight text-balance">
            {verdict}
          </h2>
          {nothingNew ? (
            <p className="mt-3 text-[13px] text-muted-foreground">
              {t('ext_arcim_no_new_data')}
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
                {t('ext_arcim_could_not_fetch', { steps: group.steps.map((s) => stepErrorLabel(t, s)).join(', ') })}
              </p>
              <p className="text-sm text-muted-foreground">{group.message}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Per-fiscal-year outcomes as lines ── */}
      {sieResults.length > 0 && (
        <section className="space-y-3">
          <SectionKicker>{t('ext_arcim_item_sie')}</SectionKicker>
          <div className="stagger-enter divide-y divide-border" data-no-stagger>
            {sieResults.map((r, i) => (
              <FiscalYearLine key={i} result={r} index={i} />
            ))}
          </div>
          {/* Company-level fact, said once: a prior year whose result was
              never transferred to equity skews every later opening balance. */}
          {untransferredResultSentences(t, sieResults).map((sentence, i) => (
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
          <SectionKicker>{t('ext_arcim_other_data')}</SectionKicker>
          <div className="stagger-enter grid gap-x-10 sm:grid-cols-2" data-no-stagger>
            {entityLines.map((line) => (
              <div key={line.label} className="border-b border-border py-2">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm">{line.label}</span>
                  <span
                    className={cn(
                      'text-right text-sm tabular-nums',
                      line.failed ? 'font-medium text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {line.value}
                  </span>
                </div>
                {line.detail && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{line.detail}</p>
                )}
              </div>
            ))}
          </div>
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
          <SectionKicker>{t('ext_arcim_next_steps')}</SectionKicker>
          <ol className="stagger-enter divide-y divide-border" data-no-stagger>
            {nextSteps(t).map((step, i) => (
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

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onDone}>
          <RotateCcw className="mr-2 h-4 w-4" />
          {t('ext_arcim_new_migration')}
        </Button>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" asChild>
            <Link href="/customers">
              {t('ext_arcim_view_customers')}
              <ExternalLink className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild>
            <Link href="/bookkeeping">
              {t('ext_arcim_view_bookkeeping')}
              <ExternalLink className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}

function stepErrorLabel(t: Translator, step: MigrationStepError['step']): string {
  switch (step) {
    case 'companyInfo': return t('ext_arcim_item_company_info')
    case 'customers': return t('ext_arcim_item_customers')
    case 'suppliers': return t('ext_arcim_item_suppliers')
    case 'salesInvoices': return t('ext_arcim_item_sales_invoices')
    case 'supplierInvoices': return t('ext_arcim_item_supplier_invoices')
    case 'assets': return t('ext_arcim_item_assets')
    case 'registrationLinks': return t('ext_arcim_step_error_registration_links')
    case 'reconciliation': return t('ext_arcim_step_error_reconciliation')
  }
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
  t: Translator,
  reasons?: AssetSkipReasons,
  entityType?: 'customer' | 'supplier' | 'invoice' | 'asset',
  errorSample?: string,
): string | undefined {
  if (!reasons) return undefined
  const parts: string[] = []
  if (reasons.duplicate) parts.push(t('ext_arcim_skip_duplicate', { count: reasons.duplicate }))
  if (reasons.outsideFiscalYears) {
    parts.push(t('ext_arcim_skip_outside_fiscal_years', { count: reasons.outsideFiscalYears }))
  }
  // The source returned the record without an amount and without rader, so
  // there is nothing to import: say that, rather than let the count vanish
  // into an unexplained "hoppades över".
  if (reasons.zeroTotal) parts.push(t('ext_arcim_skip_zero_total', { count: reasons.zeroTotal }))
  if (reasons.inactive) {
    parts.push(
      entityType === 'asset'
        ? t('ext_arcim_skip_disposed', { count: reasons.inactive })
        : t('ext_arcim_skip_inactive', { count: reasons.inactive }),
    )
  }
  if (reasons.unsupported) parts.push(t('ext_arcim_skip_unsupported', { count: reasons.unsupported }))
  if (reasons.noMatch) {
    parts.push(t('ext_arcim_skip_no_match', { count: reasons.noMatch }))
  }
  if (reasons.failed) {
    parts.push(
      errorSample
        ? t('ext_arcim_skip_failed_sample', { count: reasons.failed, sample: errorSample.slice(0, 140) })
        : t('ext_arcim_skip_failed', { count: reasons.failed })
    )
  }
  return parts.length > 0 ? parts.join(', ') : undefined
}

/**
 * One line per step that reported a result: what the earlier per-step
 * requests already wrote before a later one failed.
 */
function completedStepLines(t: Translator, results: MigrationResults | null): string[] {
  if (!results) return []
  const lines: string[] = []
  const count = (label: string, r?: { imported: number; skipped: number }) => {
    if (!r) return
    lines.push(
      r.skipped > 0
        ? t('ext_arcim_completed_line_skipped', { label, imported: r.imported, skipped: r.skipped })
        : t('ext_arcim_completed_line', { label, imported: r.imported }),
    )
  }
  if (results.companyInfo?.imported) lines.push(t('ext_arcim_completed_company_info'))
  count(t('ext_arcim_item_customers'), results.customers)
  count(t('ext_arcim_item_suppliers'), results.suppliers)
  count(t('ext_arcim_item_sales_invoices'), results.salesInvoices)
  count(t('ext_arcim_item_supplier_invoices'), results.supplierInvoices)
  count(t('ext_arcim_item_assets'), results.assets)
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
  const documentReconnectFailureCleanupRef = useRef<number | null>(null)
  const stopOAuthPopupWatchRef = useRef<(() => void) | null>(null)
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

  const fetchStatus = useCallback(async () => {
    try {
      setIsLoadingStatus(true)
      const res = await fetch('/api/extensions/ext/arcim-migration/status')
      if (res.ok) {
        const data = await res.json()
        setConnectionStatus(data)
      }
    } catch {
      // Non-critical: just means we can't show existing connections
    } finally {
      setIsLoadingStatus(false)
    }
  }, [])

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

  const loadPreview = useCallback(async (cId: string) => {
    setStep('preview')
    setIsLoading(true)
    setError(null)
    setAuthExpired(false)
    setLicenseMissing(false)
    setConsentId(cId)

    try {
      if (reconnectJobRef.current) {
        const jobId = reconnectJobRef.current
        const response = await fetch('/api/extensions/ext/arcim-migration/migration-jobs/retry', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, consentId: cId }),
        })
        if (!response.ok) throw apiError(await response.json(), t('ext_arcim_resume_failed'))
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
        (data.sourceYears ?? []).filter((fy) => fy.inDefaultSelection).map((fy) => fy.year),
      )
      const previewProvider = data?.consent?.provider
      if (ARCIM_PROVIDERS.some((provider) => provider.id === previewProvider)) {
        setSelectedProvider(previewProvider as ArcimProvider)
      }

      // If SIE is not available, disable SIE import by default
      if (!data.sieAvailable) {
        setMigrationOptions(prev => ({ ...prev, importSIEData: false }))
      }
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : t('ext_arcim_preview_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [t])

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
      setError(err instanceof Error ? getUserErrorMessage(err) : t('ext_arcim_connection_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [loadPreview, t])

  // Re-sync with existing consent: go straight to preview
  const handleResync = useCallback(async (provider: ArcimProvider, existingConsentId: string) => {
    setSelectedProvider(provider)
    setDocumentsOnly(false)
    setConsentId(existingConsentId)
    setMigrationOptions(DEFAULT_OPTIONS)
    setMigrationResults(null)
    setSieImportResults([])
    setSieData(null)
    await loadPreview(existingConsentId)
  }, [loadPreview])

  const clearOAuthPopupWatch = useCallback(() => {
    stopOAuthPopupWatchRef.current?.()
    stopOAuthPopupWatchRef.current = null
  }, [])

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
          clearOAuthPopupWatch()
          stopOAuthPopupWatchRef.current = watchArcimOAuthPopup(activePopup, () => {
            stopOAuthPopupWatchRef.current = null
            if (options?.onFailure) {
              options.onFailure()
            } else {
              setError(t('ext_arcim_login_window_closed'))
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
        setError(err instanceof Error ? getUserErrorMessage(err) : t('ext_arcim_reconnect_failed'))
        setAuthExpired(true)
      }
    } finally {
      setIsLoading(false)
    }
  }, [clearOAuthPopupWatch, t])

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
    if (provider !== 'fortnox' || !migrationSucceeded) return

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

  const runDocumentImport = useCallback(async (currentConsentId: string) => {
    dispatchDocumentImport({ type: 'import-started' })
    try {
      // One route call per time-budgeted slice; the helper loops until the
      // server reports the end and feeds running totals back for the UI.
      const result = await runArcimDocumentImportToCompletion(currentConsentId, {
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

  // Run the underlag import on its own against an active Fortnox consent.
  // Same discovery, import and scope-reconnect path as the tail of a
  // migration; only the surrounding page differs (no migration verdict).
  const handleFetchDocuments = useCallback(async (existingConsentId: string) => {
    setSelectedProvider('fortnox')
    setConsentId(existingConsentId)
    setError(null)
    setMigrationResults(null)
    setSieImportResults([])
    setSieData(null)
    setTheaterModel(null)
    clearDocumentReconnectFailureCleanup()
    documentReconnectActionRef.current = null
    setDocumentsOnly(true)
    setStep('result')
    await runDocumentDiscovery(existingConsentId, 'fortnox', true)
  }, [clearDocumentReconnectFailureCleanup, runDocumentDiscovery])

  const handleDocumentReconnect = useCallback(() => {
    if (!consentId) return
    clearDocumentReconnectFailureCleanup()
    const reconnectAction =
      documentImportState.phase === 'discovery-error' ? 'discover' : 'import'
    const priorProblem = documentImportState.problem ?? {
      code: null,
      requestId: null,
      reconnectRequired: false,
    }

    documentReconnectActionRef.current = reconnectAction
    storeDocumentOAuthResume(reconnectAction, documentsOnly)
    dispatchDocumentImport({ type: 'reconnect-started' })
    void handleReconnect('fortnox', consentId, {
      // The whole point of this reconnect is the attachment permissions, so
      // this is the one path that asks Fortnox for them.
      documentScopes: true,
      onFailure: () => {
        dispatchDocumentImport(
          reconnectAction === 'discover'
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
  }, [
    clearDocumentReconnectFailureCleanup,
    consentId,
    documentImportState.phase,
    documentImportState.problem,
    documentsOnly,
    handleReconnect,
  ])

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
        throw new Error(apiErrorMessage(data, t('ext_arcim_disconnect_failed')))
      }
      toast({ title: t('ext_arcim_disconnected_title'), description: t('ext_arcim_disconnected_description') })
      await fetchStatus()
    } catch (err) {
      toast({ title: err instanceof Error ? getUserErrorMessage(err) : t('ext_arcim_something_went_wrong'), variant: 'destructive' })
    }
  }, [toast, fetchStatus, t])

  // Handle token submission for token-based providers (Bokio, etc.)
  const handleTokenSubmit = useCallback(async (apiToken: string, companyId: string) => {
    if (!consentId || !selectedProvider) return

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
      await loadPreview(consentId)
    } catch (err) {
      setError(displayError(err, t('ext_arcim_connect_failed')))
    } finally {
      setIsLoading(false)
    }
  }, [consentId, selectedProvider, loadPreview, t])

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
        await loadPreview(callbackConsentId)
      }
    } else if (migrationStatus === 'error') {
      const callbackProvider = url.searchParams.get('provider') as ArcimProvider | null
      const reason = url.searchParams.get('reason') || t('ext_arcim_oauth_failed')
      url.searchParams.delete('migration')
      url.searchParams.delete('provider')
      url.searchParams.delete('reason')
      url.searchParams.delete('consentId')
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
      setError(reason)
      toast({ title: t('ext_arcim_connection_failed'), description: reason, variant: 'destructive' })
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
    t,
  ])

  // Check for OAuth callback on mount (fallback for non-popup flow)
  useEffect(() => {
    handleOAuthReturn()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deep-linked provider preselect (onboarding branch question). Only when
  // this mount is not an OAuth return (that flow owns the wizard state), and
  // only for providers whose SIE comes via API: visma/bokio must first see
  // the provider list with its "SIE krävs först" gate, which depends on
  // async connection status.
  const preselectedRef = useRef(false)
  useEffect(() => {
    if (preselectedRef.current || !initialProvider) return
    if (new URL(window.location.href).searchParams.get('migration')) return
    const provider = ARCIM_PROVIDERS.find((p) => p.id === initialProvider)
    if (!provider || COMING_SOON_PROVIDERS.has(provider.id) || !provider.sieViaApi) return
    preselectedRef.current = true
    void handleSelectProvider(provider.id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProvider])

  // Listen for postMessage from OAuth popup
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.data?.type === 'arcim-oauth-success' && event.data.consentId) {
        clearOAuthPopupWatch()
        clearDocumentReconnectFailureCleanup()
        const reconnectAction = documentReconnectActionRef.current
        if (reconnectAction) {
          documentReconnectActionRef.current = null
          clearDocumentOAuthResume()
          setConsentId(event.data.consentId)
          setSelectedProvider('fortnox')
          setStep('result')
          if (reconnectAction === 'discover') {
            void runDocumentDiscovery(event.data.consentId, 'fortnox', true)
          } else {
            void runDocumentImport(event.data.consentId)
          }
          return
        }
        loadPreview(event.data.consentId)
      } else if (event.data?.type === 'arcim-oauth-error') {
        clearOAuthPopupWatch()
        clearDocumentReconnectFailureCleanup()
        const reason = typeof event.data.reason === 'string' && event.data.reason
          ? event.data.reason
          : t('ext_arcim_oauth_failed')
        const reconnectAction = documentReconnectActionRef.current
        if (reconnectAction) {
          documentReconnectActionRef.current = null
          clearDocumentOAuthResume()
          const problem = documentImportState.problem ?? {
            code: null,
            requestId: null,
            reconnectRequired: true,
          }
          dispatchDocumentImport(
            reconnectAction === 'discover'
              ? { type: 'discovery-failed', problem }
              : { type: 'import-failed', problem },
          )
          return
        }
        setError(reason)
        toast({ title: t('ext_arcim_connection_failed'), description: reason, variant: 'destructive' })
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [
    clearOAuthPopupWatch,
    clearDocumentReconnectFailureCleanup,
    documentImportState.problem,
    loadPreview,
    runDocumentDiscovery,
    runDocumentImport,
    toast,
    t,
  ])

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
            t('ext_arcim_validation_failed')
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

      // If all SIE files are already imported, disable SIE import by default
      if (data.allImported) {
        setMigrationOptions(prev => ({ ...prev, importSIEData: false }))
      }

      const needsVatReview = enrichedMappings.some(mapping =>
        mapping.requiresVatTreatmentReview && !mapping.vatTreatmentReviewed
      )
      // Auto-skip only when there is neither account mapping nor VAT review work.
      if ((data.mappingStats.unmapped === 0 && !needsVatReview) || data.allImported) {
        setStep('options')
      }
    } catch (err) {
      setError(displayError(err, t('ext_arcim_fetch_sie_failed')))
    } finally {
      setIsLoading(false)
    }
  }, [consentId, refreshCompanyAccounts, selectedYears, t])

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

  const handleStartMigration = useCallback(async () => {
    if (!consentId) return
    if (migrationInFlightRef.current) return
    migrationInFlightRef.current = true
    setIsStartingMigration(true)

    setStep('migrating')
    setDocumentsOnly(false)
    setMigrationStep(t('ext_arcim_progress_starting'))
    setMigrationProgress(5)
    setError(null)
    dispatchDocumentImport({ type: 'reset' })

    // Build the theater from the parsed SIE the client already holds.
    // Best-effort: any failure just leaves the plain progress card.
    if (sieData?.parsed) {
      try {
        const { buildTheaterModel } = await import('@/lib/import/theater-model')
        setTheaterModel(buildTheaterModel(sieData.parsed))
      } catch {
        setTheaterModel(null)
      }
    } else {
      setTheaterModel(null)
    }

    try {
      // ── Phase 1: SIE import ──────────────────────────────────
      if (migrationOptions.importSIEData && sieData && sieData.rawContent.length > 0) {
        setMigrationStep(t('ext_arcim_progress_importing_sie'))
        setMigrationProgress(10)
        setSieImportResults([])

        // Complete fiscal years chronologically. Replacement is pinned to
        // the execution reviewed in the preview, including on retries.
        const filesToImport = sieData.rawContent.map((content, i) => ({
          content,
          status: sieData.fileStatuses?.[i],
        })).sort((a,b) => (a.status?.fiscalYear ?? 0)-(b.status?.fiscalYear ?? 0))

        for (let i = 0; i < filesToImport.length; i++) {
          const progress = 10 + Math.round((i / filesToImport.length) * 40)
          setMigrationProgress(progress)
          setMigrationStep(t('ext_arcim_progress_importing_sie_file', { current: i + 1, total: filesToImport.length }))

          // Name the year in every per-file failure: a multi-year re-sync
          // that dies on ONE year must say which, or the user cannot act on
          // it (issue #1667: the current year re-imported, the prior year
          // refused, and the error never said so).
          const fiscalYear = filesToImport[i].status?.fiscalYear
          const yearLabel = fiscalYear ? t('ext_arcim_year_prefix', { year: fiscalYear }) + ' ' : ''

          const filename = 'migration-sie-'+(fiscalYear ?? i)+'.se'
          const storagePath = await uploadSIEFile(new File([filesToImport[i].content],filename,{type:'text/plain'}))
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
                supersedesImportId:filesToImport[i].status?.previousImport?.id,
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
              : `${yearLabel}${t('ext_arcim_sie_import_failed_no_message')}`)
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
        setMigrationStep(t('ext_arcim_progress_importing_entities'))
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
            ? await consumeMigrationStream(res.body, label => { if (label) setMigrationStep(label) }, {
                failed: t('ext_arcim_migration_failed'),
                connectionDropped: t('ext_arcim_stream_dropped'),
              })
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
          const response = await fetch('/api/extensions/ext/arcim-migration/migration-jobs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ consentId, resources }),
          })
          const body = await response.json()
          if (!response.ok) throw apiError(body, `HTTP ${response.status}`)
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
          title: t('ext_arcim_toast_partial_title'),
          description: t('ext_arcim_toast_partial_description'),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('ext_arcim_toast_done_title'),
          description: t('ext_arcim_toast_done_description'),
        })
      }
    } catch (err) {
      setError(displayError(err))
      setStep('result')
    } finally {
      migrationInFlightRef.current = false
      setIsStartingMigration(false)
    }
  }, [consentId, migrationOptions, preview, runDocumentDiscovery, selectedProvider, sieData, toast, t])

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
        results[count.resource] = {
          total: count.total, imported: count.imported, skipped: count.skipped,
          skipReasons: { failed: count.needs_attention },
          ...(['salesInvoices', 'supplierInvoices'].includes(count.resource) ? {
            fxUnresolved: count.fx_unresolved, vatUnresolved: count.vat_unresolved, creditNotesUnlinked: count.credit_notes_unlinked,
            creditNotesLinked: count.credit_notes_linked ?? 0,
          } : {}),
        }
      }
      setMigrationResults(previous => mergeMigrationResults(previous ?? {}, results))
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
          onDisconnect={handleDisconnect}
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
          results={migrationResults}
          sieResults={sieImportResults}
          omittedYears={sieData?.omittedYears ?? []}
          error={error}
          documentImportState={documentImportState}
          documentsOnly={documentsOnly}
          theaterModel={theaterModel}
          onDone={handleDone}
          onRetry={() => {
            setError(null)
            setStep('options')
          }}
          onDiscoverDocuments={() => {
            if (consentId) void runDocumentDiscovery(consentId, 'fortnox', true)
          }}
          onImportDocuments={() => {
            if (consentId) void runDocumentImport(consentId)
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
