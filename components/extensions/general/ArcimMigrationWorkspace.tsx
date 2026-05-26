'use client'

import { useState, useCallback, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import Link from 'next/link'
import { FallbackPrompt } from '@/components/ui/fallback-prompt'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  AlertCircle,
  CheckCircle,
  Building2,
  Users,
  Truck,
  FileText,
  Database,
  ExternalLink,
  Info,
  RotateCcw,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Calendar,
  XCircle,
  BookOpen,
} from 'lucide-react'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'

type ArcimProvider = 'fortnox' | 'visma' | 'briox' | 'bokio' | 'bjornlunden'

const ARCIM_PROVIDERS: { id: ArcimProvider; name: string; authType: 'oauth' | 'token' }[] = [
  { id: 'fortnox', name: 'Fortnox', authType: 'oauth' },
  { id: 'visma', name: 'Visma eEkonomi', authType: 'oauth' },
  { id: 'bokio', name: 'Bokio', authType: 'token' },
  { id: 'bjornlunden', name: 'Björn Lundén', authType: 'token' },
  { id: 'briox', name: 'Briox', authType: 'token' },
]

interface SkipReasons {
  duplicate?: number
  inactive?: number
  failed?: number
  noMatch?: number
}

interface MigrationResults {
  companyInfo?: { imported: boolean }
  customers?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons }
  suppliers?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons }
  salesInvoices?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons }
  supplierInvoices?: { total: number; imported: number; skipped: number; skipReasons?: SkipReasons }
}
import AccountMappingStep from '@/components/import/AccountMappingStep'
import type { AccountMapping, ImportResult, ParsedSIEFile } from '@/lib/import/types'
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

const MONTH_NAMES = [
  'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
]

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
  // Legacy field for older builds — read previousImport instead.
  alreadyImported: boolean
  importedAt: string | null
  // New (period-based) detection. When present, this fiscal year already has a
  // completed import in gnubok and a re-sync will replace it (cancelling the
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
  basAccounts: BASAccount[]
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

const COMING_SOON_PROVIDERS = new Set<ArcimProvider>(['bjornlunden', 'briox'])

const PROVIDER_LOGOS: Record<ArcimProvider, string> = {
  fortnox: '/logos/fortnox.svg',
  visma: '/logos/visma.jpeg',
  bokio: '/logos/bokio.png',
  bjornlunden: '/logos/bjornlunden.png',
  briox: '/logos/Briox_logo.png',
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
  const allFortnox = activeConsents.length > 0 && activeConsents.every(c => c.provider === 'fortnox')
  const showSieRequiredBanner = !isLoadingStatus && !hasSieImport && !allFortnox

  return (
    <div className="space-y-4">
      {/* SIE-required banner (not relevant for Fortnox — it fetches SIE itself) */}
      {showSieRequiredBanner && (
        <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">SIE-import krävs först</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bokio, Visma, Björn Lundén och Briox hämtar endast kunder, leverantörer och fakturor via API:et. Bokföringsdata (kontoplan, verifikationer och balanser) måste importeras via SIE-fil först. Gäller inte Fortnox — där hämtar vi SIE direkt via API:et.
            </p>
            <Link
              href="/import?mode=sie"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}
            >
              <BookOpen className="mr-2 h-4 w-4" />
              Ladda upp SIE-fil
              <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}

      {/* Existing connections */}
      {activeConsents.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Aktiva anslutningar</CardTitle>
            <CardDescription>
              Du har redan anslutna leverantörer. Synka igen för att hämta ny data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {activeConsents.map((consent) => {
              const providerInfo = ARCIM_PROVIDERS.find(p => p.id === consent.provider)
              const completedImports = connectionStatus?.sieImports.filter(i => i.status === 'completed') ?? []
              const lastImport = completedImports[0]

              return (
                <div
                  key={consent.id}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex items-start gap-3 sm:items-center sm:gap-4">
                    <img
                      src={PROVIDER_LOGOS[consent.provider]}
                      alt={providerInfo?.name ?? consent.provider}
                      className="h-10 w-10 shrink-0 rounded-lg object-contain"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{providerInfo?.name ?? consent.provider}</p>
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          <CheckCircle className="h-3 w-3" />
                          Ansluten
                        </span>
                      </div>
                      <div className="mt-0.5 space-y-0.5">
                        {consent.companyName && (
                          <p className="text-xs text-muted-foreground">{consent.companyName}</p>
                        )}
                        {lastImport ? (
                          <p className="text-xs text-muted-foreground">
                            Senaste import: {new Date(lastImport.imported_at ?? lastImport.created_at).toLocaleDateString('sv-SE')}
                            {lastImport.transactions_count != null && ` — ${lastImport.transactions_count} verifikationer`}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Ansluten {consent.createdAt ? new Date(consent.createdAt).toLocaleDateString('sv-SE') : ''}
                          </p>
                        )}
                        {(connectionStatus?.entityCounts.customers ?? 0) > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {connectionStatus?.entityCounts.customers} kunder, {connectionStatus?.entityCounts.suppliers} leverantörer, {connectionStatus?.entityCounts.invoices} fakturor
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="hidden shrink-0 text-muted-foreground hover:text-destructive sm:inline-flex"
                      onClick={() => onDisconnect(consent.id)}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="mt-3 flex items-center gap-2 sm:mt-0 sm:pl-[52px]">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 sm:flex-none"
                      onClick={() => onResync(consent.provider, consent.id)}
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      Synka igen
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive sm:hidden"
                      onClick={() => onDisconnect(consent.id)}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Provider selection */}
      <Card>
        <CardHeader>
          <CardTitle>{activeConsents.length > 0 ? 'Anslut ytterligare system' : 'Välj ditt nuvarande bokföringssystem'}</CardTitle>
          <CardDescription>
            Vi hämtar bokföringsdata via SIE och kunder, leverantörer och fakturor via API:et.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingStatus ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {ARCIM_PROVIDERS.map((provider) => {
                const comingSoon = COMING_SOON_PROVIDERS.has(provider.id)
                const alreadyConnected = activeConsents.some(c => c.provider === provider.id)
                return (
                  <button
                    key={provider.id}
                    disabled={comingSoon || alreadyConnected}
                    className={`relative flex items-center gap-4 rounded-lg border p-4 text-left transition-all ${
                      comingSoon || alreadyConnected
                        ? 'cursor-not-allowed border-border/50 opacity-60'
                        : 'border-border hover:border-primary/50 hover:bg-accent/50 active:scale-[0.98]'
                    }`}
                    onClick={() => !comingSoon && !alreadyConnected && onSelect(provider.id)}
                  >
                    <img
                      src={PROVIDER_LOGOS[provider.id]}
                      alt={provider.name}
                      className="h-10 w-10 shrink-0 rounded-lg object-contain"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{provider.name}</p>
                        {comingSoon && (
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Kommer snart
                          </span>
                        )}
                        {alreadyConnected && (
                          <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            Ansluten
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {alreadyConnected ? 'Använd "Synka igen" ovan' : provider.authType === 'oauth' ? 'Anslut via inloggning' : 'Anslut med API-nyckel'}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
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
  const providerName = ARCIM_PROVIDERS.find(p => p.id === provider)?.name ?? provider
  const [apiToken, setApiToken] = useState('')
  const [companyId, setCompanyId] = useState('')

  // BL uses server-side client credentials — only needs company ID, no API key
  const isClientCredentials = provider === 'bjornlunden'
  const needsApiToken = !isClientCredentials
  const needsCompanyId = provider === 'bokio' || provider === 'bjornlunden'

  const tokenDescription = isClientCredentials
    ? `Ange ditt företags-ID (GUID) från Björn Lundén. ${branding.appName.toLowerCase()} ansluter automatiskt via sin integrationspartner-åtkomst.`
    : `Ange din API-nyckel från ${providerName} för att ge ${branding.appName.toLowerCase()} tillgång att läsa din bokföringsdata.`

  const tokenHelpText = isClientCredentials
    ? `Hittas i Björn Lundén under Inställningar \u2192 Företagsinformation (GUID-format).`
    : provider === 'bokio'
      ? `Du hittar din API-nyckel i ${providerName} under Inställningar \u2192 Integrationer \u2192 API. Ditt företags-ID är det GUID som syns i URL:en när du är inloggad, t.ex. https://app.bokio.se/ditt-företags-id/settings-r/private-integrations.`
      : `Du hittar din applikationstoken i ${providerName} under Administration \u2192 Integrationer.`

  const canSubmit = isClientCredentials
    ? !!companyId
    : !!(apiToken && (!needsCompanyId || companyId))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Anslut till {providerName}</CardTitle>
          <CardDescription>
            {authType === 'token'
              ? tokenDescription
              : `Logga in i ${providerName} för att ge ${branding.appName.toLowerCase()} tillgång att läsa din bokföringsdata.`
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <p>Förbereder anslutning...</p>
            </div>
          )}

          {error && (
            <>
              <div className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <div>
                  <p className="font-medium text-destructive">Anslutning misslyckades</p>
                  <p className="text-sm text-muted-foreground">{error}</p>
                  {provider === 'fortnox' && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Obs: Fortnox kräver ett aktivt integrationstillägg (tillkostnadsbelagd tilläggstjänst) för att kunna använda integrationer. Kontrollera att detta är aktiverat i ditt Fortnox-konto.
                    </p>
                  )}
                </div>
              </div>
              <FallbackPrompt
                message="Du kan också importera din bokföringsdata manuellt via en SIE-fil."
                linkHref="/import?mode=sie"
                linkLabel="Ladda upp SIE-fil"
              />
            </>
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
                  window.open(authUrl, 'arcim-oauth', `width=${w},height=${h},left=${left},top=${top}`)
                }}
              >
                Logga in i {providerName}
                <ExternalLink className="ml-2 h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Token-based flow */}
          {authType === 'token' && consentId && !isLoading && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {tokenHelpText}
              </p>
              <div className="space-y-3">
                {needsApiToken && (
                  <div>
                    <label htmlFor="apiToken" className="text-sm font-medium">
                      {provider === 'briox' ? 'Applikationstoken' : 'API-nyckel'}
                    </label>
                    <Input
                      id="apiToken"
                      name="apiToken_nocomplete"
                      type="password"
                      autoComplete="new-password"
                      placeholder={provider === 'briox' ? 'Klistra in din applikationstoken' : 'Klistra in din API-nyckel'}
                      value={apiToken}
                      onChange={(e) => setApiToken(e.target.value)}
                    />
                  </div>
                )}
                {needsCompanyId && (
                  <div>
                    <label htmlFor="companyId" className="text-sm font-medium">
                      Företags-ID
                    </label>
                    <Input
                      id="companyId"
                      name="companyId_nocomplete"
                      autoComplete="new-password"
                      placeholder={isClientCredentials ? 'GUID från företagsinställningar' : 'GUID från URL:en, t.ex. 14ccad83-67f6-49bd-...'}
                      value={companyId}
                      onChange={(e) => setCompanyId(e.target.value)}
                    />
                  </div>
                )}
                <Button
                  className="min-h-11"
                  onClick={() => onTokenSubmit(apiToken, companyId)}
                  disabled={!canSubmit}
                >
                  Anslut
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex">
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
  onContinue,
  onBack,
}: {
  preview: PreviewData | null
  isLoading: boolean
  error: string | null
  onContinue: () => void
  onBack: () => void
}) {
  const providerName = preview
    ? ARCIM_PROVIDERS.find(p => p.id === preview.consent.provider)?.name ?? preview.consent.provider
    : ''

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Anslutet till {providerName}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <p>Hämtar bokföringsdata...</p>
            </div>
          )}

          {error && (
            <>
              <div className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
              <FallbackPrompt
                message="Du kan också importera din bokföringsdata manuellt via en SIE-fil."
                linkHref="/import?mode=sie"
                linkLabel="Ladda upp SIE-fil"
              />
            </>
          )}

          {/* SIE stats summary */}
          {preview?.sieAvailable && preview.sieStats && (
            <div className="flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
              <Database className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium">
                  Hittade {preview.sieStats.accountCount} konton och {preview.sieStats.transactionCount} verifikationer
                </p>
                <p className="text-xs text-muted-foreground">
                  {preview.sieStats.fiscalYears.length === 1
                    ? `Räkenskapsår ${preview.sieStats.fiscalYears[0]}`
                    : `${preview.sieStats.fiscalYears.length} räkenskapsår: ${preview.sieStats.fiscalYears.join(', ')}`
                  }
                </p>
              </div>
            </div>
          )}

          {preview && !preview.sieAvailable && !isLoading && preview.hasSieData && (
            <div className="flex gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
              <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
              <div>
                <p className="text-sm font-medium">SIE-data redan importerad</p>
                <p className="text-xs text-muted-foreground">
                  Bokföringsdata har redan importerats via SIE-fil. Du kan fortsätta med att importera kunder, leverantörer och fakturor.
                </p>
              </div>
            </div>
          )}

          {preview && !preview.sieAvailable && !isLoading && !preview.hasSieData && (
            <div className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-medium text-destructive">SIE-import krävs</p>
                <p className="text-xs text-muted-foreground">
                  Bokföringsdata (kontoplan, verifikationer och balanser) måste importeras via SIE-fil innan kunder, leverantörer och fakturor kan hämtas. Exportera en SIE-fil från {ARCIM_PROVIDERS.find(p => p.id === preview.consent.provider)?.name ?? 'ditt bokföringssystem'} och ladda upp den i {branding.appName.toLowerCase()}.
                </p>
                <Link
                  href="/import?mode=sie"
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-3')}
                >
                  <BookOpen className="mr-2 h-4 w-4" />
                  Gå till SIE-importen
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
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

function InfoItem({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value || '—'}</p>
    </div>
  )
}

// ── Mapping step (wraps AccountMappingStep) ─────────────────────

function MappingStep({
  sieData,
  isLoading,
  error,
  onMappingChange,
  onContinue,
  onBack,
}: {
  sieData: SIEData | null
  isLoading: boolean
  error: string | null
  onMappingChange: (sourceAccount: string, targetAccount: string, targetName: string) => void
  onContinue: () => void
  onBack: () => void
}) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <p>Analyserar bokföringsdata och förbereder kontomappning...</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="font-medium text-destructive">Kunde inte ladda SIE-data</p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <FallbackPrompt
          message="Om problemet kvarstår kan du importera din SIE-fil manuellt istället."
          linkHref="/import?mode=sie"
          linkLabel="Ladda upp SIE-fil"
        />
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
      </div>
    )
  }

  if (!sieData) return null

  return (
    <AccountMappingStep
      mappings={sieData.mappings}
      basAccounts={sieData.basAccounts}
      onMappingChange={onMappingChange}
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

  const selectedItems: string[] = []
  if (options.importCompanyInfo) selectedItems.push('Företagsinformation')
  if (sieAvailable && options.importSIEData) selectedItems.push('Bokföringsdata (SIE)')
  if (options.importCustomers) selectedItems.push('Kunder')
  if (options.importSuppliers) selectedItems.push('Leverantörer')
  if (options.importSalesInvoices) selectedItems.push('Kundfakturor')
  if (options.importSupplierInvoices) selectedItems.push('Leverantörsfakturor')

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Vad vill du importera?</CardTitle>
          <CardDescription>
            Bokföringsdata importeras via SIE-fil. Kunder, leverantörer och fakturor hämtas via API:et.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <OptionRow
            icon={<Building2 className="h-4 w-4" />}
            label="Företagsinformation"
            description="Namn, organisationsnummer, adress"
            checked={options.importCompanyInfo}
            onChange={() => toggleOption('importCompanyInfo')}
          />

          {sieAvailable && (
            <>
              <OptionRow
                icon={<Database className="h-4 w-4" />}
                label="Bokföringsdata (SIE)"
                description={
                  replacedFileCount > 0 && newFileCount > 0
                    ? `${newFileCount} nya och ${replacedFileCount} uppdaterade räkenskapsår`
                    : replacedFileCount > 0
                      ? `${replacedFileCount} räkenskapsår med uppdaterad data — tidigare import ersätts`
                      : newFileCount > 0
                        ? `${newFileCount} ny(a) räkenskapsår att importera`
                        : 'Kontoplan, ingående balanser och verifikationer'
                }
                checked={options.importSIEData}
                onChange={() => toggleOption('importSIEData')}
              />
              {/* Per-file import status */}
              {fileStatuses.length > 0 && (
                <div className="ml-4 space-y-1.5">
                  {fileStatuses.map((fs) => (
                    <div key={fs.fiscalYear} className="flex items-center gap-2 text-xs">
                      {fs.previousImport ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 text-amber-500" />
                          <span className="text-muted-foreground">
                            Räkenskapsår {fs.fiscalYear} — ersätter tidigare import
                            {fs.previousImport.importedAt
                              ? ` från ${new Date(fs.previousImport.importedAt).toLocaleDateString('sv-SE')}`
                              : ''}
                          </span>
                        </>
                      ) : (
                        <>
                          <Calendar className="h-3.5 w-3.5 text-primary" />
                          <span className="font-medium">Räkenskapsår {fs.fiscalYear} — ny data att importera</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {options.importSIEData && (
                <div className="flex items-center gap-3 rounded-lg border border-border p-3 ml-4">
                  <div className="text-muted-foreground">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Verifikationsserie</p>
                    <p className="text-xs text-muted-foreground">Serie för importerade verifikationer</p>
                  </div>
                  <Input
                    className="w-16 text-center"
                    value={options.voucherSeries}
                    onChange={(e) => onChange({ ...options, voucherSeries: e.target.value.toUpperCase() || 'B' })}
                    maxLength={2}
                  />
                </div>
              )}
            </>
          )}

          <OptionRow
            icon={<Users className="h-4 w-4" />}
            label="Kunder"
            description="Kund-register med kontaktuppgifter"
            checked={options.importCustomers}
            onChange={() => toggleOption('importCustomers')}
          />
          <OptionRow
            icon={<Truck className="h-4 w-4" />}
            label="Leverantörer"
            description="Leverantör-register med bankuppgifter"
            checked={options.importSuppliers}
            onChange={() => toggleOption('importSuppliers')}
          />
          <OptionRow
            icon={<FileText className="h-4 w-4" />}
            label="Kundfakturor"
            description="Alla kundfakturor (betalda och obetalda)"
            checked={options.importSalesInvoices}
            onChange={() => toggleOption('importSalesInvoices')}
          />
          <OptionRow
            icon={<FileText className="h-4 w-4" />}
            label="Leverantörsfakturor"
            description={provider === 'fortnox'
              ? 'Endast obetalda leverantörsfakturor hämtas. Historiska betalda fakturor finns kvar i Fortnox.'
              : 'Alla leverantörsfakturor (betalda och obetalda)'}
            checked={options.importSupplierInvoices}
            onChange={() => toggleOption('importSupplierInvoices')}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
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
        warningText={`Bokföringsdata, kunder, leverantörer och fakturor importeras till ${branding.appName.toLowerCase()}. Se till att ingen annan import pågår.`}
        confirmLabel="Starta migrering"
      >
        <div className="space-y-3">
          <div className="space-y-2">
            <p className="text-sm font-medium">Följande importeras:</p>
            <ul className="space-y-1">
              {selectedItems.map((item) => (
                <li key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle className="h-3.5 w-3.5 text-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {options.importSIEData && yearsToReplace.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-50/50 p-3 dark:bg-amber-950/20">
              <div className="flex items-start gap-2">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {yearsToReplace.length === 1
                      ? `Räkenskapsår ${yearsToReplace[0]} ersätts`
                      : `Räkenskapsår ${yearsToReplace.join(', ')} ersätts`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Tidigare importerade verifikationer markeras som annullerade och ersätts av
                    uppdaterad data från källsystemet. Verifikationer som du själv skapat i {branding.appName.toLowerCase()}
                    (kategoriserade banktransaktioner, fakturor m.m.) påverkas inte.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </ConfirmationDialog>
    </div>
  )
}

function OptionRow({
  icon,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  description: string
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-border p-3 transition-colors',
        disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-accent/50'
      )}
      onClick={() => !disabled && onChange()}
    >
      <div className="text-muted-foreground">{icon}</div>
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
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
    <Card>
      <CardHeader>
        <CardTitle>Migrering pågår</CardTitle>
        <CardDescription>
          Vänta medan vi hämtar och importerar din bokföringsdata. Det kan ta några minuter.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <div className="flex justify-end">
            <span className="text-xs text-muted-foreground">{progress}%</span>
          </div>
          <Progress value={progress} className="h-3" />
        </div>
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <p className="text-sm">{currentStep}</p>
        </div>
      </CardContent>
    </Card>
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
  return { icon: 'success', label: 'Importerad' }
}

const StatusIcon = ({ status }: { status: 'success' | 'warning' | 'error' }) => {
  if (status === 'error') return <XCircle className="h-4 w-4 text-destructive" />
  if (status === 'warning') return <AlertTriangle className="h-4 w-4 text-amber-500" />
  return <CheckCircle className="h-4 w-4 text-green-600" />
}

/** Expandable per-fiscal-year detail card */
function FiscalYearResult({ result, index }: { result: ImportResult; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const status = getFYStatus(result)
  const d = result.details
  const fyLabel = d?.fiscalYear
    ? formatFiscalYearLabel(d.fiscalYear.start, d.fiscalYear.end)
    : `Räkenskapsår ${index + 1}`

  return (
    <div className="rounded-lg border border-border">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-accent/50"
      >
        <StatusIcon status={status.icon} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{fyLabel}</span>
            <span className={`text-sm ${
              status.icon === 'error' ? 'text-destructive' :
              status.icon === 'warning' ? 'text-amber-600' :
              'text-muted-foreground'
            }`}>
              {status.label}
            </span>
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {result.journalEntriesCreated.toLocaleString('sv-SE')} verifikationer importerade
            {d?.skippedVouchers && d.skippedVouchers.total > 0 && (
              <span className="text-amber-600">
                {' · '}{d.skippedVouchers.total} hoppade över
              </span>
            )}
            {result.replacedPriorImport && result.replacedPriorImport.cancelledEntries > 0 && (
              <span>
                {' · '}ersatte {result.replacedPriorImport.cancelledEntries.toLocaleString('sv-SE')} tidigare importerade verifikationer
              </span>
            )}
          </p>
        </div>
        {expanded
          ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        }
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          {/* Errors — shown prominently */}
          {result.errors.length > 0 && (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="space-y-1.5">
                  <p className="text-sm font-medium text-destructive">
                    {result.errors.length === 1 ? '1 fel vid import' : `${result.errors.length} fel vid import`}
                  </p>
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-sm text-muted-foreground">{e}</p>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Opening balance adjustment */}
          {d?.openingBalance && (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-start gap-2">
                <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Ingående balanser justerade</p>
                  <p className="text-sm text-muted-foreground">
                    {d.openingBalance.explanation === 'unallocated_result' && (
                      <>
                        Differens på <span className="tabular-nums font-medium">{Math.abs(d.openingBalance.imbalance).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK</span> bokförd
                        på konto {d.openingBalance.bookedToAccount}. Detta beror troligen på att föregående
                        års resultat inte allokerats till eget kapital i källsystemet — vanligt vid byte
                        av bokföringsprogram.
                      </>
                    )}
                    {d.openingBalance.explanation === 'excluded_accounts' && (
                      <>
                        Exkluderade systemkonton (t.ex. Fortnox 0099) hade ingående saldon. Differensen
                        (<span className="tabular-nums font-medium">{Math.abs(d.openingBalance.imbalance).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK</span>)
                        bokförd på konto {d.openingBalance.bookedToAccount}.
                      </>
                    )}
                    {d.openingBalance.explanation === 'rounding' && (
                      <>
                        Avrundningsdifferens (<span className="tabular-nums font-medium">{Math.abs(d.openingBalance.imbalance).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK</span>)
                        bokförd på konto {d.openingBalance.bookedToAccount}.
                      </>
                    )}
                    {!d.openingBalance.explanation && (
                      <>
                        Differens på <span className="tabular-nums font-medium">{Math.abs(d.openingBalance.imbalance).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK</span> bokförd
                        på konto {d.openingBalance.bookedToAccount}.
                      </>
                    )}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Skipped vouchers breakdown */}
          {d?.skippedVouchers && d.skippedVouchers.total > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900/30 dark:bg-amber-950/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div>
                  <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                    {d.skippedVouchers.total} verifikationer hoppades över
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Ofullständiga verifikationer i källsystemet som inte kan importeras.
                    Saldon har justerats automatiskt via omföringsverifikation.
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-muted-foreground tabular-nums">
                    {d.skippedVouchers.unbalanced > 0 && (
                      <div className="flex justify-between">
                        <span>Obalanserade</span>
                        <span className="font-medium">{d.skippedVouchers.unbalanced}</span>
                      </div>
                    )}
                    {d.skippedVouchers.unmapped > 0 && (
                      <div className="flex justify-between">
                        <span>Ej mappade konton</span>
                        <span className="font-medium">{d.skippedVouchers.unmapped}</span>
                      </div>
                    )}
                    {d.skippedVouchers.singleLine > 0 && (
                      <div className="flex justify-between">
                        <span>Enradsverifikationer</span>
                        <span className="font-medium">{d.skippedVouchers.singleLine}</span>
                      </div>
                    )}
                    {d.skippedVouchers.empty > 0 && (
                      <div className="flex justify-between">
                        <span>Tomma</span>
                        <span className="font-medium">{d.skippedVouchers.empty}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Migration adjustment info */}
          {d?.migrationAdjustment?.created && (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Omföringsverifikation skapad</p>
                  <p className="text-sm text-muted-foreground">
                    {d.migrationAdjustment.accountsAdjusted} konton justerade för att saldon ska matcha
                    källsystemet. Verifikationen kompenserar för hoppade verifikationer så att dina
                    balansräkning och resultaträkning stämmer.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Retry info (only shown if retries happened) */}
          {d && d.retriedBatches > 0 && (
            <p className="text-xs text-muted-foreground">
              {d.retriedBatches} {d.retriedBatches === 1 ? 'batch' : 'batcher'} behövde omförsök
              {d.failedBatches > 0 && (
                <span className="text-destructive">
                  {' · '}{d.failedBatches} misslyckades trots omförsök
                </span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ResultStep({
  results,
  sieResults,
  error,
  onDone,
  onRetry,
}: {
  results: MigrationResults | null
  sieResults: ImportResult[]
  error: string | null
  onDone: () => void
  onRetry: () => void
}) {
  if (error) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-base font-medium text-destructive">Migreringen misslyckades</p>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <FallbackPrompt
          message="Du kan istället importera din bokföringsdata manuellt via en SIE-fil."
          linkHref="/import?mode=sie"
          linkLabel="Ladda upp SIE-fil"
        />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
          <Button variant="outline" className="min-h-11" onClick={onDone}>Klar</Button>
          <Button className="min-h-11" onClick={onRetry}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Försök igen
          </Button>
        </div>
      </div>
    )
  }

  const hasResults = results || sieResults.length > 0
  if (!hasResults) return null

  // Compute combined SIE stats
  const totalJournalEntries = sieResults.reduce((sum, r) => sum + r.journalEntriesCreated, 0)
  const totalErrors = sieResults.reduce((sum, r) => sum + r.errors.length, 0)
  const totalSkipped = sieResults.reduce((sum, r) => (r.details?.skippedVouchers?.total || 0) + sum, 0)
  const allSieSucceeded = sieResults.length > 0 && sieResults.every(r => r.success)
  const anySieFailed = sieResults.some(r => r.errors.length > 0 && r.journalEntriesCreated === 0)

  // Check if anything meaningful was imported via entities
  // Company info is always re-fetched (upsert) so it doesn't count as "new"
  const entityImported = results && (
    (results.customers && (results.customers.imported > 0 || results.customers.skipped > 0)) ||
    (results.suppliers && (results.suppliers.imported > 0 || results.suppliers.skipped > 0)) ||
    (results.salesInvoices && (results.salesInvoices.imported > 0 || results.salesInvoices.skipped > 0)) ||
    (results.supplierInvoices && (results.supplierInvoices.imported > 0 || results.supplierInvoices.skipped > 0))
  )
  const nothingNew = sieResults.length === 0 && !entityImported

  // Overall status
  const overallIcon = anySieFailed ? 'error' as const :
    (!allSieSucceeded || totalErrors > 0) ? 'warning' as const : 'success' as const

  return (
    <div className="space-y-4">
      {/* ── Header card with overall summary ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5">
            <StatusIcon status={nothingNew ? 'success' : overallIcon} />
            {nothingNew ? 'Allt är uppdaterat' :
             anySieFailed ? 'Migrering delvis genomförd' :
             !allSieSucceeded ? 'Migrering klar med anmärkningar' :
             'Migrering klar'}
          </CardTitle>
          <CardDescription className="text-sm">
            {nothingNew ? (
              'Det finns ingen ny data att importera från leverantören.'
            ) : totalJournalEntries > 0 ? (
              <>
                <span className="tabular-nums font-medium text-foreground">
                  {totalJournalEntries.toLocaleString('sv-SE')}
                </span>
                {' verifikationer importerade'}
                {sieResults.length > 1 && ` över ${sieResults.length} räkenskapsår`}
                {totalSkipped > 0 && (
                  <span className="text-amber-600">
                    {' · '}{totalSkipped} hoppade över
                  </span>
                )}
              </>
            ) : null}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* ── Per-fiscal-year SIE breakdown ── */}
      {sieResults.length > 0 && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Database className="h-4 w-4" />
            Bokföringsdata (SIE)
          </h3>
          <div className="space-y-2">
            {sieResults.map((r, i) => (
              <FiscalYearResult key={i} result={r} index={i} />
            ))}
          </div>
        </div>
      )}

      {/* ── API import results (company info, customers, etc.) ── */}
      {results && (() => {
        const hasCompanyInfo = results.companyInfo?.imported
        const hasCustomers = results.customers && (results.customers.imported > 0 || results.customers.skipped > 0)
        const hasSuppliers = results.suppliers && (results.suppliers.imported > 0 || results.suppliers.skipped > 0)
        const hasSalesInvoices = results.salesInvoices && (results.salesInvoices.imported > 0 || results.salesInvoices.skipped > 0)
        const hasSupplierInvoices = results.supplierInvoices && (results.supplierInvoices.imported > 0 || results.supplierInvoices.skipped > 0)
        const hasAnything = hasCompanyInfo || hasCustomers || hasSuppliers || hasSalesInvoices || hasSupplierInvoices

        if (!hasAnything) return null

        return (
          <div className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FileText className="h-4 w-4" />
              Övriga data
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {hasCompanyInfo && (
                <EntityResultRow
                  icon={<Building2 className="h-4 w-4" />}
                  label="Företagsinformation"
                  status="success"
                  statusText="Importerad"
                />
              )}
              {hasCustomers && (
                <EntityResultRow
                  icon={<Users className="h-4 w-4" />}
                  label="Kunder"
                  status="success"
                  statusText={`${results.customers!.imported} importerade`}
                  detail={results.customers!.skipped > 0 ? formatSkipReasons(results.customers!.skipReasons, 'customer') ?? `${results.customers!.skipped} hoppades över` : undefined}
                />
              )}
              {hasSuppliers && (
                <EntityResultRow
                  icon={<Truck className="h-4 w-4" />}
                  label="Leverantörer"
                  status="success"
                  statusText={`${results.suppliers!.imported} importerade`}
                  detail={results.suppliers!.skipped > 0 ? formatSkipReasons(results.suppliers!.skipReasons, 'supplier') ?? `${results.suppliers!.skipped} hoppades över` : undefined}
                />
              )}
              {hasSalesInvoices && (
                <EntityResultRow
                  icon={<FileText className="h-4 w-4" />}
                  label="Kundfakturor"
                  status="success"
                  statusText={`${results.salesInvoices!.imported} importerade`}
                  detail={results.salesInvoices!.skipped > 0 ? formatSkipReasons(results.salesInvoices!.skipReasons, 'invoice') ?? `${results.salesInvoices!.skipped} hoppades över` : undefined}
                />
              )}
              {hasSupplierInvoices && (
                <EntityResultRow
                  icon={<FileText className="h-4 w-4" />}
                  label="Leverantörsfakturor"
                  status="success"
                  statusText={`${results.supplierInvoices!.imported} importerade`}
                  detail={results.supplierInvoices!.skipped > 0 ? formatSkipReasons(results.supplierInvoices!.skipReasons, 'invoice') ?? `${results.supplierInvoices!.skipped} hoppades över` : undefined}
                />
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Next steps ── */}
      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="text-base">Nästa steg</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
              1
            </div>
            <div>
              <p className="font-medium">Granska importerade verifikationer</p>
              <p className="text-sm text-muted-foreground">Kontrollera att bokföringen ser korrekt ut i huvudboken</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
              2
            </div>
            <div>
              <p className="font-medium">Stäm av balansräkningen</p>
              <p className="text-sm text-muted-foreground">Jämför ingående balanser och saldon mot ditt tidigare system</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">
              3
            </div>
            <div>
              <p className="font-medium">Kontrollera kunder och leverantörer</p>
              <p className="text-sm text-muted-foreground">Verifiera kontaktuppgifter, organisationsnummer och bankinfo</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
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

function formatSkipReasons(reasons?: SkipReasons, entityType?: 'customer' | 'supplier' | 'invoice'): string | undefined {
  if (!reasons) return undefined
  const parts: string[] = []
  if (reasons.duplicate) parts.push(`${reasons.duplicate} fanns redan`)
  if (reasons.inactive) parts.push(`${reasons.inactive} inaktiv${reasons.inactive > 1 ? 'a' : ''}`)
  if (reasons.noMatch) {
    const matchLabel = entityType === 'invoice' ? 'utan matchning' : 'utan matchning'
    parts.push(`${reasons.noMatch} ${matchLabel}`)
  }
  if (reasons.failed) parts.push(`${reasons.failed} misslyckades`)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Simple row for non-SIE entity results (customers, invoices, etc.) */
function EntityResultRow({
  icon,
  label,
  status,
  statusText,
  detail,
}: {
  icon: React.ReactNode
  label: string
  status: 'success' | 'skipped'
  statusText: string
  detail?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className="text-muted-foreground">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">{statusText}</p>
        {detail && <p className="text-sm text-muted-foreground/70">{detail}</p>}
      </div>
      <StatusIcon status={status === 'success' ? 'success' : 'warning'} />
    </div>
  )
}

// ── Main wizard ─────────────────────────────────────────────────

export default function ArcimMigrationWorkspace(_props: WorkspaceComponentProps) {
  const { toast } = useToast()

  const [step, setStep] = useState<WizardStep>('provider')
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Connection status (existing connections + import history)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null)

  // Connection state
  const [selectedProvider, setSelectedProvider] = useState<ArcimProvider | null>(null)
  const [consentId, setConsentId] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [authType, setAuthType] = useState<'oauth' | 'token' | null>(null)

  // Preview state
  const [preview, setPreview] = useState<PreviewData | null>(null)

  // SIE data state (held between mapping and execution steps)
  const [sieData, setSieData] = useState<SIEData | null>(null)

  // Options state
  const [migrationOptions, setMigrationOptions] = useState<MigrationOptions>(DEFAULT_OPTIONS)

  // Migration state
  const [migrationStep, setMigrationStep] = useState('')
  const [migrationProgress, setMigrationProgress] = useState(0)
  const [migrationResults, setMigrationResults] = useState<MigrationResults | null>(null)
  const [sieImportResults, setSieImportResults] = useState<ImportResult[]>([])

  // Wizard progress — only user-interactive steps
  const userSteps = STEPS.filter(s => {
    if (s === 'migrating' || s === 'result') return false
    if (s === 'mapping' && !preview?.sieAvailable) return false
    return true
  })
  const currentUserStepIndex = userSteps.indexOf(step)
  const isInteractiveStep = currentUserStepIndex !== -1
  const progressPercent = isInteractiveStep
    ? ((currentUserStepIndex + 1) / userSteps.length) * 100
    : 100

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
      // Non-critical — just means we can't show existing connections
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

    try {
      const res = await fetch(`/api/extensions/ext/arcim-migration/preview?consentId=${cId}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      setPreview(data)
      setConsentId(cId)

      // If SIE is not available, disable SIE import by default
      if (!data.sieAvailable) {
        setMigrationOptions(prev => ({ ...prev, importSIEData: false }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte hämta förhandsgranskning')
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
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      setConsentId(data.consentId)
      setAuthType(data.authType)

      if (data.alreadyConnected) {
        // Existing connection — skip auth, go straight to preview
        await loadPreview(data.consentId)
        return
      }

      if (data.authType === 'oauth' && data.authUrl) {
        setAuthUrl(data.authUrl)
      }
      // Token-based providers stay on connect step for credential input
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anslutning misslyckades')
    } finally {
      setIsLoading(false)
    }
  }, [loadPreview])

  // Re-sync with existing consent — go straight to preview
  const handleResync = useCallback(async (provider: ArcimProvider, existingConsentId: string) => {
    setSelectedProvider(provider)
    setConsentId(existingConsentId)
    setMigrationOptions(DEFAULT_OPTIONS)
    setMigrationResults(null)
    setSieImportResults([])
    setSieData(null)
    await loadPreview(existingConsentId)
  }, [loadPreview])

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
        throw new Error(data.error || 'Kunde inte koppla från')
      }
      toast({ title: 'Frånkopplad', description: 'Anslutningen har tagits bort.' })
      await fetchStatus()
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : 'Något gick fel', variant: 'destructive' })
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
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      // Token stored — consent is now accepted, proceed to preview
      await loadPreview(consentId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte ansluta')
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

    if (migrationStatus === 'connected' && callbackConsentId) {
      // Clean URL
      url.searchParams.delete('migration')
      url.searchParams.delete('consentId')
      window.history.replaceState({}, '', url.pathname)

      await loadPreview(callbackConsentId)
    } else if (migrationStatus === 'error') {
      const callbackProvider = url.searchParams.get('provider') as ArcimProvider | null
      const reason = url.searchParams.get('reason') || 'OAuth-anslutningen misslyckades. Försök igen.'
      url.searchParams.delete('migration')
      url.searchParams.delete('provider')
      url.searchParams.delete('reason')
      window.history.replaceState({}, '', url.pathname)
      setError(reason)
      toast({ title: 'Anslutning misslyckades', description: reason, variant: 'destructive' })
      if (callbackProvider) {
        setSelectedProvider(callbackProvider)
        setStep('connect')
      } else {
        setStep('provider')
      }
    }
  }, [loadPreview, toast])

  // Check for OAuth callback on mount (fallback for non-popup flow)
  useEffect(() => {
    handleOAuthReturn()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Listen for postMessage from OAuth popup
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return
      if (event.data?.type === 'arcim-oauth-success' && event.data.consentId) {
        loadPreview(event.data.consentId)
      } else if (event.data?.type === 'arcim-oauth-error') {
        const reason = typeof event.data.reason === 'string' && event.data.reason
          ? event.data.reason
          : 'OAuth-anslutningen misslyckades. Försök igen.'
        setError(reason)
        toast({ title: 'Anslutning misslyckades', description: reason, variant: 'destructive' })
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [loadPreview, toast])

  // Load SIE data when entering mapping step
  const loadSIEData = useCallback(async () => {
    if (!consentId) return

    setStep('mapping')
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/extensions/ext/arcim-migration/sie-data?consentId=${consentId}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      setSieData(data)

      // If all SIE files are already imported, disable SIE import by default
      if (data.allImported) {
        setMigrationOptions(prev => ({ ...prev, importSIEData: false }))
      }

      // Auto-skip mapping step if all accounts are mapped or all files already imported
      if (data.mappingStats.unmapped === 0 || data.allImported) {
        setStep('options')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunde inte hämta SIE-data')
    } finally {
      setIsLoading(false)
    }
  }, [consentId])

  const handlePreviewContinue = useCallback(() => {
    if (preview?.sieAvailable) {
      // Load SIE data for mapping step
      loadSIEData()
    } else {
      // Skip mapping step — no SIE available
      setStep('options')
    }
  }, [preview, loadSIEData])

  const handleMappingChange = useCallback((sourceAccount: string, targetAccount: string, targetName: string) => {
    if (!sieData) return

    const updatedMappings = sieData.mappings.map(m =>
      m.sourceAccount === sourceAccount
        ? { ...m, targetAccount, targetName, isOverride: true, matchType: 'manual' as const, confidence: 1 }
        : m
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

  const handleStartMigration = useCallback(async () => {
    if (!consentId) return

    setStep('migrating')
    setMigrationStep('Startar migrering...')
    setMigrationProgress(5)
    setError(null)

    try {
      // ── Phase 1: SIE import ──────────────────────────────────
      if (migrationOptions.importSIEData && sieData && sieData.rawContent.length > 0) {
        setMigrationStep('Importerar bokföringsdata (SIE)...')
        setMigrationProgress(10)
        setSieImportResults([])

        // Send every file to the engine. The Fortnox endpoint runs in
        // replace-mode, so a year that already has a completed import
        // gets its prior import marked 'replaced' (imported entries
        // cancelled, user-created entries untouched) before the new
        // SIE is loaded. The per-file result reports replacedPriorImport.
        const filesToImport = sieData.rawContent.map((content, i) => ({
          content,
          status: sieData.fileStatuses?.[i],
        }))

        for (let i = 0; i < filesToImport.length; i++) {
          const progress = 10 + Math.round((i / filesToImport.length) * 40)
          setMigrationProgress(progress)
          setMigrationStep(`Importerar bokföringsdata (SIE) — fil ${i + 1} av ${filesToImport.length}...`)

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
            throw new Error(data.error || `SIE import HTTP ${res.status}`)
          }

          const result = await res.json() as ImportResult
          setSieImportResults(prev => [...prev, result])
        }
      }

      // ── Phase 2: API import (customers, suppliers, invoices) ──
      const hasApiImport = migrationOptions.importCompanyInfo ||
        migrationOptions.importCustomers ||
        migrationOptions.importSuppliers ||
        migrationOptions.importSalesInvoices ||
        migrationOptions.importSupplierInvoices

      if (hasApiImport) {
        setMigrationStep('Importerar kunder, leverantörer och fakturor...')
        setMigrationProgress(55)

        const res = await fetch('/api/extensions/ext/arcim-migration/migrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          throw new Error(data.error || `HTTP ${res.status}`)
        }

        const data = await res.json()
        setMigrationResults(data.results)
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

      toast({
        title: 'Migrering klar',
        description: 'Din bokföringsdata har importerats.',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Migrering misslyckades'
      setError(msg)
      setStep('result')
    }
  }, [consentId, migrationOptions, sieData, toast])

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
    setError(null)
    // Refresh status so provider step shows updated import history
    fetchStatus()
  }, [fetchStatus])

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Progress bar — only during interactive steps */}
      {step !== 'provider' && isInteractiveStep && (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="sm:hidden text-primary font-medium">
                  Steg {currentUserStepIndex + 1}/{userSteps.length}: {STEP_LABELS[step]}
                </span>
                {userSteps.map((s) => (
                  <span
                    key={s}
                    className={cn(
                      'hidden sm:inline',
                      userSteps.indexOf(s) <= currentUserStepIndex ? 'font-medium text-primary' : 'text-muted-foreground'
                    )}
                  >
                    {STEP_LABELS[s]}
                  </span>
                ))}
              </div>
              <Progress value={progressPercent} className="h-2" />
            </div>
          </CardContent>
        </Card>
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
          onContinue={handlePreviewContinue}
          onBack={() => setStep('provider')}
        />
      )}

      {step === 'mapping' && (
        <MappingStep
          sieData={sieData}
          isLoading={isLoading}
          error={error}
          onMappingChange={handleMappingChange}
          onContinue={() => setStep('options')}
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
        <MigratingStep currentStep={migrationStep} progress={migrationProgress} />
      )}

      {step === 'result' && (
        <ResultStep
          results={migrationResults}
          sieResults={sieImportResults}
          error={error}
          onDone={handleDone}
          onRetry={() => {
            setError(null)
            setStep('options')
          }}
        />
      )}
    </div>
  )
}
