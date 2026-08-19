'use client'

import { useState, useCallback, useEffect, useReducer, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AttnLine } from '@/components/ui/attn-line'
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
  parseArcimDocumentOAuthResume,
  requestArcimDocumentImport,
  resolveArcimDocumentFollowUpProvider,
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
): void {
  try {
    window.sessionStorage.setItem(
      ARCIM_DOCUMENT_OAUTH_RESUME_KEY,
      action,
    )
  } catch {
    // Full-page recovery is best-effort when browser storage is unavailable.
  }
}

function readDocumentOAuthResume() {
  try {
    return parseArcimDocumentOAuthResume(
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

interface SkipReasons {
  duplicate?: number
  inactive?: number
  failed?: number
  noMatch?: number
}

interface MigrationStepError {
  step: 'companyInfo' | 'customers' | 'suppliers' | 'salesInvoices' | 'supplierInvoices' | 'reconciliation'
  code: string | null
  message: string
}

interface MigrationResults {
  companyInfo?: { imported: boolean }
  customers?: { total: number; imported: number; updated?: number; skipped: number; skipReasons?: SkipReasons; errorSample?: string }
  suppliers?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons; errorSample?: string }
  salesInvoices?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons; errorSample?: string }
  supplierInvoices?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons; errorSample?: string }
  stepErrors?: MigrationStepError[]
}
import AccountMappingStep from '@/components/import/AccountMappingStep'
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
  voucherSeries: string
}

const DEFAULT_OPTIONS: MigrationOptions = {
  importCompanyInfo: true,
  importSIEData: true,
  importCustomers: true,
  importSuppliers: true,
  importSalesInvoices: true,
  importSupplierInvoices: true,
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
  basAccounts: BASAccount[]
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

function SieFallbackLine({ message, label = 'Ladda upp SIE-fil' }: { message: string; label?: string }) {
  return (
    <p className="text-[13px] text-muted-foreground">
      {message}{' '}
      <Link
        href="/import?mode=sie"
        className="underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground"
      >
        {label}
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
  const progressPercent = ((currentIndex + 1) / steps.length) * 100
  return (
    <nav aria-label="Migreringens steg">
      <p className="text-[11px] font-medium uppercase tracking-wider sm:hidden">
        Steg {currentIndex + 1} av {steps.length}: {STEP_LABELS[steps[currentIndex]]}
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

interface ConnectionStatus {
  consents: {
    id: string
    provider: ArcimProvider
    status: number
    companyName?: string
    createdAt?: string
  }[]
  sieImports: {
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
  }[]
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
  onDisconnect,
  connectionStatus,
  isLoadingStatus,
}: {
  onSelect: (provider: ArcimProvider) => void
  onResync: (provider: ArcimProvider, consentId: string) => void
  onDisconnect: (consentId: string) => void
  connectionStatus: ConnectionStatus | null
  isLoadingStatus: boolean
}) {
  const activeConsents = connectionStatus?.consents.filter(c => c.status === 1) ?? []
  const hasSieImport = (connectionStatus?.sieImports.filter(i => i.status === 'completed').length ?? 0) > 0
  const sieViaApi = (id: ArcimProvider) => ARCIM_PROVIDERS.find(p => p.id === id)?.sieViaApi === true
  const allSieViaApi = activeConsents.length > 0 && activeConsents.every(c => sieViaApi(c.provider))
  const showSieRequiredBanner = !isLoadingStatus && !hasSieImport && !allSieViaApi

  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title={activeConsents.length > 0 ? 'Anslut ytterligare system' : 'Välj ditt nuvarande bokföringssystem'}
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

      {/* Existing connections: quiet hairline rows, no cards. Being connected
          is the normal state here, so it reads as muted text, not a chip. */}
      {activeConsents.length > 0 && (
        <section className="space-y-3">
          <SectionKicker>Aktiva anslutningar</SectionKicker>
          <div className="stagger-enter divide-y divide-border" data-no-stagger>
            {activeConsents.map((consent) => {
              const providerInfo = ARCIM_PROVIDERS.find(p => p.id === consent.provider)
              const completedImports = connectionStatus?.sieImports.filter(i => i.status === 'completed') ?? []
              const lastImport = completedImports[0]

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
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onResync(consent.provider, consent.id)}
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      Synka igen
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Koppla från ${providerInfo?.name ?? consent.provider}`}
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
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
            // server-side regardless; this is just the matching UX.
            const needsSieFirst = !hasSieImport && !provider.sieViaApi
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
                      <Badge variant="secondary">Kommer snart</Badge>
                    )}
                    {alreadyConnected && (
                      <Badge variant="success">Ansluten</Badge>
                    )}
                    {needsSieFirst && !comingSoon && !alreadyConnected && (
                      <Badge variant="warning">SIE krävs först</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {alreadyConnected
                      ? 'Använd "Synka igen" ovan'
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
  consentId,
  onTokenSubmit,
  onBack,
}: {
  provider: ArcimProvider
  authType: 'oauth' | 'token' | null
  isLoading: boolean
  error: string | null
  authUrl: string | null
  consentId: string | null
  onTokenSubmit: (apiToken: string, companyId: string) => void
  onBack: () => void
}) {
  const t = useTranslations('extensions')
  const providerName = ARCIM_PROVIDERS.find(p => p.id === provider)?.name ?? provider
  const [apiToken, setApiToken] = useState('')
  const [companyId, setCompanyId] = useState('')

  // BL uses server-side client credentials: only needs company ID, no API key
  const isClientCredentials = provider === 'bjornlunden'
  // WINT has no API keys: the "token" is the user's WINT login (e-post +
  // lösenord), exchanged server-side for ett tokenpar; lösenordet sparas aldrig.
  const isWintLogin = provider === 'wint'
  const needsApiToken = !isClientCredentials
  // Briox: the account ID is the `clientid` half of the token exchange;
  // WINT reuses the same field for the login e-mail.
  const needsCompanyId = provider === 'bokio' || provider === 'bjornlunden' || provider === 'briox' || provider === 'wint'
  const companyIdLabel = provider === 'briox'
    ? 'Konto-ID'
    : provider === 'bjornlunden'
      ? 'Företagsnyckel (User-Key)'
      : provider === 'wint'
        ? 'E-postadress'
        : provider === 'bokio'
          ? t('ext_arcim_bokio_company_id_label')
          : 'Företags-ID'

  const tokenDescription = isClientCredentials
    ? `Ange din företagsnyckel (User-Key) från Björn Lundén. ${branding.appName.toLowerCase()} ansluter automatiskt via sin integrationspartner-åtkomst.`
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
    ? `Företagsnyckeln (User-Key) är ett GUID som du hittar i Lundify under Integrationer → kugghjulet vid integrationen, eller i aktiveringsmejlet från Björn Lundén.`
    : isWintLogin
      ? `Använd samma e-postadress och lösenord som när du loggar in på app.wint.se. Kräver ditt WINT-konto BankID-inloggning kan anslutningen inte skapas ännu: be i så fall WINT om en SIE-fil och importera den manuellt.`
      : provider === 'bokio'
      ? t('ext_arcim_bokio_token_help')
      : provider === 'briox'
        ? `Skapa din applikationstoken i Briox under Admin \u2192 Anv\u00e4ndare \u2192 kugghjulet vid din anv\u00e4ndare \u2192 Applikationstoken. Ditt konto-ID \u00e4r det l\u00e5nga numret inom parentes bredvid f\u00f6retagsnamnet under "Ditt konto" i menyn till h\u00f6ger.`
        : `Du hittar din applikationstoken i ${providerName} under Administration \u2192 Integrationer.`

  const canSubmit = isClientCredentials
    ? !!companyId
    : !!(apiToken && (!needsCompanyId || companyId))

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
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">Anslutning misslyckades</p>
            <p className="text-sm text-muted-foreground">{error}</p>
            {provider === 'fortnox' && (
              <p className="text-sm text-muted-foreground">
                Obs: Fortnox kräver ett aktivt integrationstillägg (tillkostnadsbelagd tilläggstjänst) för att kunna använda integrationer. Kontrollera att detta är aktiverat i ditt Fortnox-konto.
              </p>
            )}
          </div>
          <SieFallbackLine message="Du kan också importera din bokföringsdata manuellt via en SIE-fil." />
        </div>
      )}

      {/* OAuth flow */}
      {authType === 'oauth' && authUrl && !isLoading && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Klicka nedan för att logga in i {providerName}.
            Fönstret stängs automatiskt när du är klar.
          </p>
          <Button
            className="min-h-11"
            onClick={() => {
              const w = 600
              const h = 700
              const left = window.screenX + (window.outerWidth - w) / 2
              const top = window.screenY + (window.outerHeight - h) / 2
              const popup = window.open(authUrl, 'arcim-oauth', `width=${w},height=${h},left=${left},top=${top}`)
              if (!popup) {
                // Popup blocked: with the return value discarded, a blocked
                // popup looked exactly like a successful one (nothing opens,
                // nothing is said, the user clicks again). Fall back to the
                // full-page flow instead. The callback already supports it:
                // with no window.opener it redirects to
                // /import?migration=connected&consentId=..., which
                // handleOAuthReturn consumes and resumes the wizard at the
                // preview step. Same treatment as SkatteverketConnectPanel.
                window.location.href = authUrl
              }
            }}
          >
            Logga in i {providerName}
            <ExternalLink className="ml-2 h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Token-based flow */}
      {authType === 'token' && consentId && !isLoading && (
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
              className={cn('min-h-11', isWintLogin && 'order-3')}
              onClick={() => onTokenSubmit(apiToken, companyId)}
              disabled={!canSubmit}
            >
              Anslut
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <div className="flex border-t border-border pt-6">
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka
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
  onReconnect,
  onContinue,
  onBack,
}: {
  preview: PreviewData | null
  isLoading: boolean
  error: string | null
  authExpired: boolean
  licenseMissing: boolean
  onReconnect: () => void
  onContinue: () => void
  onBack: () => void
}) {
  const providerName = preview
    ? ARCIM_PROVIDERS.find(p => p.id === preview.consent.provider)?.name ?? preview.consent.provider
    : ''

  return (
    <div className="stagger-enter space-y-8">
      <div>
        <h2 className="font-display text-2xl leading-8 tracking-tight text-balance">
          {preview ? `Anslutet till ${providerName}` : 'Förhandsgranskning'}
        </h2>

        {isLoading && (
          <div className="mt-3">
            <SpinnerLine>Hämtar bokföringsdata...</SpinnerLine>
          </div>
        )}

        {/* SIE stats: one quiet statline, the same grammar as the import
            reveal, instead of a boxed summary. */}
        {preview?.sieAvailable && preview.sieStats && (
          <p className="animate-fade-in mt-3 text-[13px] text-muted-foreground tabular-nums">
            {preview.sieStats.accountCount.toLocaleString('sv-SE')} konton
            {' · '}
            {preview.sieStats.transactionCount.toLocaleString('sv-SE')} verifikationer
            {' · '}
            {preview.sieStats.fiscalYears.length === 1
              ? `räkenskapsåret ${preview.sieStats.fiscalYears[0]}`
              : `${preview.sieStats.fiscalYears.length} räkenskapsår: ${preview.sieStats.fiscalYears.join(', ')}`}
          </p>
        )}

        {preview && !preview.sieAvailable && !isLoading && preview.hasSieData && (
          <p className="animate-fade-in mt-3 text-[13px] text-muted-foreground">
            Bokföringsdatan är redan importerad via SIE-fil. Du kan fortsätta med att importera
            kunder, leverantörer och fakturor.
          </p>
        )}
      </div>

      {error && (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">Kunde inte hämta bokföringsdata</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          {authExpired && (
            <Button size="sm" className="min-h-9" onClick={onReconnect} disabled={isLoading}>
              <RotateCcw className="mr-2 h-4 w-4" />
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

      {preview && !preview.sieAvailable && !isLoading && !preview.hasSieData && (
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

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
        <Button className="min-h-11" onClick={onContinue} disabled={isLoading || (!!preview && !preview.sieAvailable && !preview.hasSieData)}>
          Fortsätt
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
        <div className="flex border-t border-border pt-6">
          <Button variant="outline" className="min-h-11" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
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

function OptionsStep({
  options,
  sieAvailable,
  sieData,
  provider,
  onChange,
  onStart,
  onBack,
}: {
  options: MigrationOptions
  sieAvailable: boolean
  sieData: SIEData | null
  provider: ArcimProvider | null
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
  if (options.importCompanyInfo) selectedItems.push('Företagsinformation')
  if (sieAvailable && options.importSIEData) selectedItems.push('Bokföringsdata (SIE)')
  if (options.importCustomers) selectedItems.push('Kunder')
  if (options.importSuppliers) selectedItems.push('Leverantörer')
  if (options.importSalesInvoices) selectedItems.push('Kundfakturor')
  if (options.importSupplierInvoices) selectedItems.push('Leverantörsfakturor')

  return (
    <div className="stagger-enter space-y-8">
      <StepHeading
        title="Vad vill du importera?"
        lede="Bokföringsdata importeras via SIE-fil. Kunder, leverantörer och fakturor hämtas via API:et."
      />

      {/* Years whose provider export failed: must be visible before the user
          proceeds, otherwise an IB/UB gap slips through. One ochre sentence. */}
      {sieAvailable && failedYears.length > 0 && (
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
            <OptionRow
              label="Bokföringsdata (SIE)"
              description={
                replacedFileCount > 0 && newFileCount > 0
                  ? `${newFileCount} nya och ${replacedFileCount} uppdaterade räkenskapsår`
                  : replacedFileCount > 0
                    ? `${replacedFileCount} räkenskapsår med uppdaterad data: tidigare import ersätts`
                    : newFileCount > 0
                      ? `${newFileCount} ny(a) räkenskapsår att importera`
                      : 'Kontoplan, ingående balanser och verifikationer'
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
                      ? `Räkenskapsår ${fs.fiscalYear}: ersätter tidigare import${
                          fs.previousImport.importedAt
                            ? ` från ${new Date(fs.previousImport.importedAt).toLocaleDateString('sv-SE')}`
                            : ''
                        }`
                      : `Räkenskapsår ${fs.fiscalYear}: ny data att importera`}
                  </p>
                ))}
              </div>
            )}
            {/* Verifikationsserie: one aligned row, not a nested box. */}
            {options.importSIEData && (
              <div className="flex items-center gap-3 border-t border-border py-3">
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
        <OptionRow
          label="Leverantörsfakturor"
          description={provider === 'fortnox'
            ? 'Endast obetalda leverantörsfakturor hämtas. Historiska betalda fakturor finns kvar i Fortnox.'
            : 'Alla leverantörsfakturor (betalda och obetalda)'}
          checked={options.importSupplierInvoices}
          onChange={() => toggleOption('importSupplierInvoices')}
        />
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
        <Button className="min-h-11" onClick={() => setShowConfirm(true)} disabled={selectedItems.length === 0}>
          Starta migrering
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
        isSubmitting={false}
        title="Starta migrering"
        warningText="Se till att ingen annan import pågår."
        confirmLabel="Starta migrering"
      >
        {/* One sentence naming what happens, the selection as a compact muted
            line list; the ochre caution above the actions is the dialog's
            only colored element. */}
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

          {options.importSIEData && yearsToReplace.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {yearsToReplace.length === 1
                ? `Räkenskapsår ${yearsToReplace[0]} ersätts:`
                : `Räkenskapsår ${yearsToReplace.join(', ')} ersätts:`}{' '}
              tidigare importerade verifikationer markeras som annullerade och ersätts av
              uppdaterad data från källsystemet. Verifikationer som du själv skapat i {branding.appName.toLowerCase()}{' '}
              (kategoriserade banktransaktioner, fakturor m.m.) påverkas inte.
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

/** Determine the overall status icon and color for a single FY import */
function getFYStatus(r: ImportResult): { icon: 'success' | 'warning' | 'error'; label: string } {
  if (r.errors.length > 0 && r.journalEntriesCreated === 0) {
    return { icon: 'error', label: 'Misslyckades' }
  }
  if (r.errors.length > 0 || (r.details?.skippedVouchers && r.details.skippedVouchers.total > 0)) {
    return { icon: 'warning', label: 'Delvis importerad' }
  }
  if (r.details?.untransferredResults && r.details.untransferredResults.length > 0) {
    return { icon: 'warning', label: 'Importerad med varning' }
  }
  return { icon: 'success', label: 'Importerad' }
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
 * Per-fiscal-year outcome as a line: year, count, status. Warnings are one
 * ochre sentence each (AttnLine), neutral adjustments are quiet muted lines,
 * errors keep strong color. Nothing folds away, nothing gets a box.
 */
function FiscalYearLine({ result, index }: { result: ImportResult; index: number }) {
  const status = getFYStatus(result)
  const d = result.details
  const fyLabel = d?.fiscalYear
    ? formatFiscalYearLabel(d.fiscalYear.start, d.fiscalYear.end)
    : `Räkenskapsår ${index + 1}`

  // One ochre sentence per warning (the #1562 idiom).
  const warningSentences: string[] = []
  if (d?.skippedVouchers && d.skippedVouchers.total > 0) {
    const parts: string[] = []
    if (d.skippedVouchers.empty > 0) parts.push(`${d.skippedVouchers.empty} tomma`)
    if (d.skippedVouchers.unbalanced > 0) parts.push(`${d.skippedVouchers.unbalanced} obalanserade`)
    if (d.skippedVouchers.singleLine > 0) parts.push(`${d.skippedVouchers.singleLine} enradiga`)
    if (d.skippedVouchers.unmapped > 0) parts.push(`${d.skippedVouchers.unmapped} med ej kopplade konton`)
    warningSentences.push(
      `${d.skippedVouchers.total} verifikationer hoppades över (${parts.join(', ')}): saldon har justerats automatiskt via omföringsverifikation.`
    )
  }
  if (d?.untransferredResults && d.untransferredResults.length > 0) {
    for (const u of d.untransferredResults) {
      warningSentences.push(
        `${u.period_name}: årets resultat på ${u.pl_net.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK är inte omfört till eget kapital, senare års balansräkning visar en differens tills omföringen bokförs (konto 8999 mot t.ex. 2099).`
      )
    }
  }
  // Remaining raw warnings; strings covered by the sentences above are
  // filtered out.
  warningSentences.push(
    ...result.warnings.filter(
      (w) =>
        !(d?.skippedVouchers && d.skippedVouchers.total > 0 && w.includes('hoppades över')) &&
        !(d?.untransferredResults && d.untransferredResults.length > 0 && w.includes('förts om till eget kapital'))
    )
  )

  const infoLines: string[] = []
  if (d?.openingBalance) infoLines.push(openingBalanceSentence(d.openingBalance))
  if (d?.migrationAdjustment?.created) {
    infoLines.push(
      `Omföringsverifikation skapad: ${d.migrationAdjustment.accountsAdjusted} konton justerade så att balansräkning och resultaträkning matchar källsystemet.`
    )
  }
  if (d && d.retriedBatches > 0 && d.failedBatches === 0) {
    infoLines.push(`${d.retriedBatches} ${d.retriedBatches === 1 ? 'batch' : 'batcher'} behövde omförsök.`)
  }

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
        <span
          className={cn(
            'ml-auto text-xs',
            status.icon === 'error'
              ? 'font-medium text-destructive'
              : status.icon === 'warning'
                ? 'text-attn'
                : 'text-muted-foreground'
          )}
        >
          {status.label}
        </span>
      </div>
      {result.errors.length > 0 && (
        <div className="mt-1 space-y-1">
          {result.errors.map((e, i) => (
            <p key={i} className="text-sm text-destructive">{e}</p>
          ))}
        </div>
      )}
      {warningSentences.map((w, i) => (
        <AttnLine key={i} className="mt-1">{w}</AttnLine>
      ))}
      {infoLines.map((l, i) => (
        <p key={i} className="mt-1 text-[12.5px] leading-5 text-muted-foreground">{l}</p>
      ))}
      {d && d.failedBatches > 0 && (
        <p className="mt-1 text-[12.5px] leading-5 text-destructive">
          {d.retriedBatches} {d.retriedBatches === 1 ? 'batch' : 'batcher'} behövde omförsök, {d.failedBatches} misslyckades trots omförsök.
        </p>
      )}
    </div>
  )
}

function DocumentImportFollowUp({
  state,
  onDiscover,
  onImport,
  onDismiss,
  onReconnect,
}: {
  state: ArcimDocumentImportState
  onDiscover: () => void
  onImport: () => void
  onDismiss: () => void
  onReconnect: () => void
}) {
  const t = useTranslations('extensions')

  if (state.phase === 'hidden' || state.phase === 'dismissed') return null

  const title = <SectionKicker>{t('ext_arcim_documents_title')}</SectionKicker>

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

    return (
      <section className="space-y-3" aria-live="polite">
        {title}
        <SpinnerLine>{label}</SpinnerLine>
      </section>
    )
  }

  if (state.phase === 'offered') {
    return (
      <section className="space-y-3" aria-live="polite">
        {title}
        <p className="text-sm text-muted-foreground">
          {t('ext_arcim_documents_prompt', { count: state.found })}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button className="min-h-11" onClick={onImport}>
            {t('ext_arcim_documents_import_action')}
          </Button>
          <Button variant="ghost" className="min-h-11" onClick={onDismiss}>
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
        <Button variant="outline" className="min-h-11" onClick={onDiscover}>
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
            <Button variant="outline" className="min-h-11" onClick={onImport}>
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
  return (
    <section className="space-y-3" aria-live="polite">
      {title}
      <p className="text-sm text-destructive">
        {state.problem?.message
          ? state.problem.message
          : reconnectRequired
          ? t('ext_arcim_documents_scope_error')
          : discoveryFailed
            ? t('ext_arcim_documents_discovery_error')
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
      <Button
        className="min-h-11"
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
    </section>
  )
}

const NEXT_STEPS: { title: string; sub: string }[] = [
  { title: 'Granska importerade verifikationer', sub: 'Kontrollera att bokföringen ser korrekt ut i huvudboken' },
  { title: 'Stäm av balansräkningen', sub: 'Jämför ingående balanser och saldon mot ditt tidigare system' },
  { title: 'Kontrollera kunder och leverantörer', sub: 'Verifiera kontaktuppgifter, organisationsnummer och bankinfo' },
]

function ResultStep({
  results,
  sieResults,
  error,
  documentImportState,
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
  error: string | null
  documentImportState: ArcimDocumentImportState
  theaterModel: TheaterModel | null
  onDone: () => void
  onRetry: () => void
  onDiscoverDocuments: () => void
  onImportDocuments: () => void
  onDismissDocuments: () => void
  onReconnectDocuments: () => void
}) {
  if (error) {
    return (
      <div className="stagger-enter space-y-8">
        <div>
          <h2 className="font-display text-2xl leading-8 tracking-tight text-balance">
            Migreringen misslyckades
          </h2>
          <p className="mt-3 whitespace-pre-line text-sm text-destructive">{error}</p>
        </div>
        <SieFallbackLine message="Du kan istället importera din bokföringsdata manuellt via en SIE-fil." />
        <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
          <Button variant="outline" className="min-h-11" onClick={onDone}>Klar</Button>
          <Button className="min-h-11" onClick={onRetry}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Försök igen
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
    (results.supplierInvoices && (results.supplierInvoices.imported > 0 || results.supplierInvoices.skipped > 0))
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
    ? 'Allt är redan uppdaterat.'
    : (anySieFailed || apiFailed)
      ? 'Migreringen är delvis genomförd.'
      : totalJournalEntries > 0
        ? fyCount === 1
          ? `${totalJournalEntries.toLocaleString('sv-SE')} verifikationer är på plats.`
          : `${totalJournalEntries.toLocaleString('sv-SE')} verifikationer över ${fyCount} räkenskapsår är på plats.`
        : !allSieSucceeded || totalErrors > 0
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
  if (results) {
    if (results.companyInfo?.imported) {
      entityLines.push({ label: 'Företagsinformation', value: 'Importerad', failed: false })
    }
    if (results.customers && (results.customers.imported > 0 || (results.customers.updated ?? 0) > 0 || results.customers.skipped > 0)) {
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
    if (results.suppliers && (results.suppliers.imported > 0 || results.suppliers.skipped > 0)) {
      entityLines.push({
        label: 'Leverantörer',
        value: `${results.suppliers.imported} importerade`,
        detail: results.suppliers.skipped > 0
          ? formatSkipReasons(results.suppliers.skipReasons, 'supplier', results.suppliers.errorSample) ?? `${results.suppliers.skipped} hoppades över`
          : undefined,
        failed: entityRowStatus(results.suppliers.imported, results.suppliers.skipReasons) === 'error',
      })
    }
    if (results.salesInvoices && (results.salesInvoices.imported > 0 || results.salesInvoices.skipped > 0)) {
      entityLines.push({
        label: 'Kundfakturor',
        value: `${results.salesInvoices.imported} importerade`,
        detail: results.salesInvoices.skipped > 0
          ? formatSkipReasons(results.salesInvoices.skipReasons, 'invoice', results.salesInvoices.errorSample) ?? `${results.salesInvoices.skipped} hoppades över`
          : undefined,
        failed: entityRowStatus(results.salesInvoices.imported, results.salesInvoices.skipReasons) === 'error',
      })
    }
    if (results.supplierInvoices && (results.supplierInvoices.imported > 0 || results.supplierInvoices.skipped > 0)) {
      entityLines.push({
        label: 'Leverantörsfakturor',
        value: `${results.supplierInvoices.imported} importerade`,
        detail: results.supplierInvoices.skipped > 0
          ? formatSkipReasons(results.supplierInvoices.skipReasons, 'invoice', results.supplierInvoices.errorSample) ?? `${results.supplierInvoices.skipped} hoppades över`
          : undefined,
        failed: entityRowStatus(results.supplierInvoices.imported, results.supplierInvoices.skipReasons) === 'error',
      })
    }
  }

  return (
    <div className="stagger-enter space-y-8">
      {/* ── The reveal: settled constellation beside the serif verdict ── */}
      <div className={cn('grid items-center gap-6', showCanvas && 'md:grid-cols-[minmax(280px,380px)_1fr]')}>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Migrering
          </p>
          <h2 className="mt-2 font-display text-2xl leading-8 tracking-tight text-balance">
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
        </section>
      )}

      {/* ── API import results: quiet two-column line list ── */}
      {entityLines.length > 0 && (
        <section className="space-y-3">
          <SectionKicker>Övriga data</SectionKicker>
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

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-between">
        <Button variant="outline" className="min-h-11" onClick={onDone}>
          <RotateCcw className="mr-2 h-4 w-4" />
          Ny migrering
        </Button>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" className="min-h-11" asChild>
            <Link href="/customers">
              Visa kunder
              <ExternalLink className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button className="min-h-11" asChild>
            <Link href="/bookkeeping">
              Visa bokföring
              <ExternalLink className="ml-2 h-4 w-4" />
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
  reasons?: SkipReasons,
  entityType?: 'customer' | 'supplier' | 'invoice',
  errorSample?: string,
): string | undefined {
  if (!reasons) return undefined
  const parts: string[] = []
  if (reasons.duplicate) parts.push(`${reasons.duplicate} fanns redan`)
  if (reasons.inactive) parts.push(`${reasons.inactive} inaktiv${reasons.inactive > 1 ? 'a' : ''}`)
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

  const [step, setStep] = useState<WizardStep>('provider')
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)
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
  const [authType, setAuthType] = useState<'oauth' | 'token' | null>(null)

  // Preview state
  const [preview, setPreview] = useState<PreviewData | null>(null)
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

  // Options state
  const [migrationOptions, setMigrationOptions] = useState<MigrationOptions>(DEFAULT_OPTIONS)

  // Migration state
  const [migrationStep, setMigrationStep] = useState('')
  const [migrationProgress, setMigrationProgress] = useState(0)
  const [migrationResults, setMigrationResults] = useState<MigrationResults | null>(null)
  const [sieImportResults, setSieImportResults] = useState<ImportResult[]>([])
  const [documentImportState, dispatchDocumentImport] = useReducer(
    arcimDocumentImportReducer,
    INITIAL_ARCIM_DOCUMENT_IMPORT_STATE,
  )
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

  // ── Step handlers ──────────────────────────────────────────────

  const loadPreview = useCallback(async (cId: string) => {
    setStep('preview')
    setIsLoading(true)
    setError(null)
    setAuthExpired(false)
    setLicenseMissing(false)
    setConsentId(cId)

    try {
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

      const data = await res.json()
      setPreview(data)
      const previewProvider = data?.consent?.provider
      if (ARCIM_PROVIDERS.some((provider) => provider.id === previewProvider)) {
        setSelectedProvider(previewProvider as ArcimProvider)
      }

      // If SIE is not available, disable SIE import by default
      if (!data.sieAvailable) {
        setMigrationOptions(prev => ({ ...prev, importSIEData: false }))
      }
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte hämta förhandsgranskning')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const handleSelectProvider = useCallback(async (provider: ArcimProvider) => {
    setSelectedProvider(provider)
    setStep('connect')
    setIsLoading(true)
    setError(null)

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
    options?: { onFailure?: () => void },
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
        body: JSON.stringify({ provider, reconnect: true }),
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
  }, [clearOAuthPopupWatch])

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
      const result = await requestArcimDocumentImport(currentConsentId, false)
      dispatchDocumentImport({ type: 'import-succeeded', result })
    } catch (documentError) {
      dispatchDocumentImport({
        type: 'import-failed',
        problem: documentImportProblem(documentError),
      })
    }
  }, [])

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
    storeDocumentOAuthResume(reconnectAction)
    dispatchDocumentImport({ type: 'reconnect-started' })
    void handleReconnect('fortnox', consentId, {
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
      setError(displayError(err, 'Kunde inte ansluta'))
    } finally {
      setIsLoading(false)
    }
  }, [consentId, selectedProvider, loadPreview])

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
      const reason = url.searchParams.get('reason') || 'OAuth-anslutningen misslyckades. Försök igen.'
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
          : 'OAuth-anslutningen misslyckades. Försök igen.'
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
        toast({ title: 'Anslutning misslyckades', description: reason, variant: 'destructive' })
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
  ])

  // Load SIE data when entering mapping step
  const loadSIEData = useCallback(async () => {
    if (!consentId) return

    setStep('mapping')
    setIsLoading(true)
    setError(null)
    setErrorDetails(null)

    try {
      const res = await fetch(`/api/extensions/ext/arcim-migration/sie-data?consentId=${consentId}`)
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
      const accountsRes = await fetch('/api/bookkeeping/accounts?active=false')
      const accountsBody = await accountsRes.json().catch(() => ({})) as {
        data?: BASAccount[]
        error?: unknown
      }
      if (!accountsRes.ok) {
        throw apiError(accountsBody, `HTTP ${accountsRes.status}`)
      }
      companyAccountsForVatRef.current = accountsBody.data ?? []
      const enrichedMappings = enrichAccountMappingsWithVat(data.mappings, accountsBody.data ?? [])
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
      setError(displayError(err, 'Kunde inte hämta SIE-data'))
    } finally {
      setIsLoading(false)
    }
  }, [consentId])

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

    setStep('migrating')
    setMigrationStep('Startar migrering...')
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
        setMigrationStep('Importerar bokföringsdata (SIE)...')
        setMigrationProgress(10)
        setSieImportResults([])

        // Send every file to the engine. The Fortnox endpoint runs in
        // replace-mode, so a year that already has a completed import
        // gets its prior import marked 'replaced' (imported entries
        // deleted, user-created entries untouched) before the new
        // SIE is loaded. The per-file result reports replacedPriorImport.
        const filesToImport = sieData.rawContent.map((content, i) => ({
          content,
          status: sieData.fileStatuses?.[i],
        }))

        for (let i = 0; i < filesToImport.length; i++) {
          const progress = 10 + Math.round((i / filesToImport.length) * 40)
          setMigrationProgress(progress)
          setMigrationStep(`Importerar bokföringsdata (SIE): fil ${i + 1} av ${filesToImport.length}...`)

          // Name the year in every per-file failure: a multi-year re-sync
          // that dies on ONE year must say which, or the user cannot act on
          // it (issue #1667: the current year re-imported, the prior year
          // refused, and the error never said so).
          const fiscalYear = filesToImport[i].status?.fiscalYear
          const yearLabel = fiscalYear ? `Räkenskapsår ${fiscalYear}: ` : ''

          const res = await fetch('/api/extensions/ext/arcim-migration/import-sie', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rawContent: filesToImport[i].content,
              mappings: sieData.mappings,
              options: {
                createFiscalPeriod: true,
                importOpeningBalances: true,
                importTransactions: true,
                voucherSeries: migrationOptions.voucherSeries,
              },
            }),
          })

          if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            const err = apiError(data, `SIE import HTTP ${res.status}`)
            throw err instanceof UserFacingError
              ? new UserFacingError(`${yearLabel}${err.message}`)
              : err
          }

          const result = await res.json() as ImportResult
          setSieImportResults(prev => [...prev, result])

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
      const hasApiImport = migrationOptions.importCompanyInfo ||
        migrationOptions.importCustomers ||
        migrationOptions.importSuppliers ||
        migrationOptions.importSalesInvoices ||
        migrationOptions.importSupplierInvoices

      let hadStepErrors = false
      if (hasApiImport) {
        setMigrationStep('Importerar kunder, leverantörer och fakturor...')
        setMigrationProgress(55)

        const res = await fetch('/api/extensions/ext/arcim-migration/migrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
          body: JSON.stringify({
            consentId,
            importCompanyInfo: migrationOptions.importCompanyInfo,
            importCustomers: migrationOptions.importCustomers,
            importSuppliers: migrationOptions.importSuppliers,
            importSalesInvoices: migrationOptions.importSalesInvoices,
            importSupplierInvoices: migrationOptions.importSupplierInvoices,
          }),
        })

        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw apiError(data, `HTTP ${res.status}`)
        }

        const contentType = res.headers.get('content-type') ?? ''
        let results: MigrationResults | undefined
        if (contentType.includes('application/x-ndjson') && res.body) {
          results = await consumeMigrationStream(res.body, (currentStep, progress) => {
            if (currentStep) setMigrationStep(currentStep)
            // The orchestrator reports 0-100 on its own scale; the wizard bar
            // reserves 55-100 for the entity phase (SIE holds 10-50).
            setMigrationProgress(55 + Math.round(progress * 0.45))
          })
        } else {
          // Pre-stream server (or a proxy that stripped the stream): the
          // original single-JSON contract.
          const data = await res.json()
          results = data.results as MigrationResults | undefined
        }
        setMigrationResults(results ?? null)
        hadStepErrors = (results?.stepErrors?.length ?? 0) > 0
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
    }
  }, [consentId, migrationOptions, preview, runDocumentDiscovery, selectedProvider, sieData, toast])

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
    clearDocumentReconnectFailureCleanup()
    documentReconnectActionRef.current = null
    setTheaterModel(null)
    setError(null)
    // Refresh status so provider step shows updated import history
    fetchStatus()
  }, [clearDocumentReconnectFailureCleanup, fetchStatus])

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* Step indicator: only during interactive steps */}
      {step !== 'provider' && isInteractiveStep && (
        <StepRail steps={userSteps} currentIndex={currentUserStepIndex} />
      )}

      {/* Step content */}
      {step === 'provider' && (
        <ProviderStep
          onSelect={handleSelectProvider}
          onResync={handleResync}
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
          provider={preview?.consent.provider ?? null}
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
          error={error}
          documentImportState={documentImportState}
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
          onDismissDocuments={() => dispatchDocumentImport({ type: 'dismissed' })}
          onReconnectDocuments={handleDocumentReconnect}
        />
      )}
    </div>
  )
}
