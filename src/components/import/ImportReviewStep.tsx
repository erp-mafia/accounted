'use client'

import { useState, useEffect, useRef } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  CheckCircle,
  AlertCircle,
  ArrowRight,
  Loader2,
  Calendar,
  FileText,
  Database,
  Lock,
} from 'lucide-react'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { AttnLine } from '@/components/ui/attn-line'
import ImportTheater from '@/components/import/ImportTheater'
import {
  defaultImportOpeningBalancesOn,
  defaultOpeningBalanceSeries,
} from '@/lib/import/opening-balance-defaults'
import type { ImportPreview, AccountMapping } from '@/lib/import/types'
import type { TheaterModel } from '@/lib/import/theater-model'
import { voucherSeriesLabel } from '@/lib/bookkeeping/voucher-series-resolver'

const SERIES_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

interface ImportReviewStepProps {
  preview: ImportPreview
  mappings: AccountMapping[]
  onExecute: (options: ImportExecuteOptions) => Promise<void>
  onBack: () => void
  isLoading: boolean
  /** Client-parsed graph model for the import theater; null falls back to
   *  the plain spinner takeover (parse failed, oversized file, or pending). */
  theaterModel?: TheaterModel | null
  /** Why the execute request was refused (closed admission, validation).
   *  Rendered beside the action row: the wizard stays on this step after a
   *  rejection, so a message anywhere else is never seen. */
  error?: string | null
}

export interface ImportExecuteOptions {
  createFiscalPeriod: boolean
  importOpeningBalances: boolean
  importTransactions: boolean
  updateAccountNames: boolean
  voucherSeries: string
  /** Series for the Ingående balanser voucher. Defaults to one the file's
   *  own vouchers do not use, so their numbering is never shifted (#1882). */
  openingBalanceSeries: string
  markImportedNoDocRequired: boolean
}

export default function ImportReviewStep({
  preview,
  mappings,
  onExecute,
  onBack,
  isLoading,
  theaterModel = null,
  error = null,
}: ImportReviewStepProps) {
  const { canWrite } = useCanWrite()
  const { company } = useCompany()
  const { settings: companySettings } = useCompanySettings()
  const companyDefaultVoucherSeries = companySettings?.default_voucher_series || null
  // Company-defined series names (presets as fallback) for the two pickers.
  const seriesLabels = companySettings?.voucher_series_labels ?? null
  const t = useTranslations('import')
  const [options, setOptions] = useState<ImportExecuteOptions>({
    createFiscalPeriod: true,
    importOpeningBalances: true,
    importTransactions: true,
    updateAccountNames: true,
    voucherSeries: 'B',
    openingBalanceSeries: defaultOpeningBalanceSeries(preview.voucherSeriesInFile ?? []),
    markImportedNoDocRequired: false,
  })
  const [defaultSeries, setDefaultSeries] = useState<string | null>(null)
  const [existingSeries, setExistingSeries] = useState<Set<string>>(new Set())
  const [seriesLoaded, setSeriesLoaded] = useState(false)
  // Posted opening-balance vouchers already booked in the file's fiscal year.
  // Non-zero means a re-import: the IB toggle then defaults OFF (issue #1882;
  // a field report accumulated five IB vouchers from repeated test imports).
  const [existingIbCount, setExistingIbCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!company?.id) return
    setSeriesLoaded(false)
    const supabase = createClient()

    let cancelled = false
    ;(async () => {
      // Smart IB-toggle default (issue #1882): a posted opening-balance
      // voucher already booked inside the file's fiscal year means this is
      // a re-import, and importing IB again would create a duplicate
      // "Ingående balanser" verifikat.
      const ibCountQuery =
        preview.fiscalYearStart && preview.fiscalYearEnd
          ? supabase
              .from('journal_entries')
              .select('id', { count: 'exact', head: true })
              .eq('company_id', company.id)
              .eq('source_type', 'opening_balance')
              .eq('status', 'posted')
              .gte('entry_date', preview.fiscalYearStart)
              .lte('entry_date', preview.fiscalYearEnd)
          : Promise.resolve({ count: 0, error: null })

      const [
        { data: sequencesData, error: sequencesError },
        { count: ibCount, error: ibCountError },
      ] = await Promise.all([
        supabase
          .from('voucher_sequences')
          .select('voucher_series')
          .eq('company_id', company.id),
        ibCountQuery,
      ])

      if (cancelled) return

      if (sequencesError) {
        console.error('Failed to load voucher sequences', sequencesError)
      }
      if (ibCountError) {
        console.error('Failed to check for existing opening-balance vouchers', ibCountError)
      }

      // From the session-cached settings row (lib/reference-data).
      const companyDefault = companyDefaultVoucherSeries
      const sequences = new Set<string>((sequencesData || []).map((row) => row.voucher_series))
      const existingIb = ibCountError ? 0 : (ibCount ?? 0)

      setDefaultSeries(companyDefault)
      setExistingSeries(sequences)
      setExistingIbCount(existingIb)

      const initial = companyDefault || (sequences.has('B') ? 'B' : Array.from(sequences).sort()[0]) || 'A'
      setOptions((prev) => ({
        ...prev,
        voucherSeries: initial,
        // Recompute with the effective transaction series excluded: file
        // vouchers WITHOUT a series land in that series at import time, so
        // the IB default must avoid it too (issue #1882). Safe to overwrite:
        // the select is disabled until seriesLoaded, so no user choice can
        // be clobbered here.
        openingBalanceSeries: defaultOpeningBalanceSeries([
          ...(preview.voucherSeriesInFile ?? []),
          initial,
        ]),
        importOpeningBalances: defaultImportOpeningBalancesOn({
          hasOpeningBalances: preview.openingBalanceTotal > 0,
          existingIbEntryCount: existingIb,
        }),
      }))
      setSeriesLoaded(true)
    })()

    return () => {
      cancelled = true
    }
  }, [company?.id, companyDefaultVoucherSeries, preview.fiscalYearStart, preview.fiscalYearEnd, preview.openingBalanceTotal])

  // Block browser close/refresh during import
  useUnsavedChanges(isLoading)

  // Elapsed time counter during import
  useEffect(() => {
    if (isLoading) {
      setElapsed(0)
      intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current)
      setElapsed(0)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [isLoading])

  const handleExecute = () => {
    onExecute(options)
  }

  const updateOption = <K extends keyof ImportExecuteOptions>(
    key: K,
    value: ImportExecuteOptions[K]
  ) => {
    setOptions((prev) => ({ ...prev, [key]: value }))
  }

  // Series used by the file's own #VER records, uppercased for comparison.
  // Booking the IB voucher in one of these consumes that series' next
  // number and shifts the file's numbering by one (issue #1882).
  const seriesInFile = new Set(
    (preview.voucherSeriesInFile ?? []).map((s) => s.trim().toUpperCase())
  )

  // Calculate what will be imported
  const mappedCount = mappings.filter((m) => m.targetAccount).length
  const hasOpeningBalances = preview.openingBalanceTotal > 0
  const hasTransactions = preview.voucherCount > 0
  // An import whose fiscal year already ended in a prior calendar year is a
  // historical/migration import: the underlag live in the old system, so the
  // exemption is especially apt. Nudges (does not force) the toggle.
  const isHistoricalImport = (() => {
    if (!preview.fiscalYearEnd) return false
    const end = new Date(preview.fiscalYearEnd)
    const startOfThisYear = new Date(new Date().getFullYear(), 0, 1)
    return !isNaN(end.getTime()) && end < startOfThisYear
  })()
  // Identity-mapped accounts whose #KONTO name differs from the BAS default:
  // mirrors the filter in syncMappedAccounts, so the count matches what the
  // import would actually rename/create with a custom name.
  const customNameCount = mappings.filter(
    (m) =>
      m.targetAccount &&
      m.sourceAccount === m.targetAccount &&
      m.sourceName?.trim() &&
      m.sourceName.trim() !== m.targetName?.trim()
  ).length

  // Full-screen loading takeover during import execution. With a client-parsed
  // model the theater plays (the graph draws itself while the server writes);
  // without one, the plain spinner takeover remains the fallback.
  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-8 pb-8">
            {theaterModel ? (
              <div className="space-y-6">
                <ImportTheater model={theaterModel} preview={preview} elapsed={elapsed} />
                <p className="text-center text-sm text-muted-foreground">
                  {t('review_do_not_close')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center text-center space-y-6">
                <Loader2 className="h-10 w-10 text-primary animate-spin" />
                <div className="space-y-1">
                  <p className="font-medium text-lg">{t('review_importing')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('review_vouchers_processing', { count: preview.voucherCount })}
                  </p>
                </div>
                <div className="text-2xl font-display tabular-nums text-muted-foreground">
                  {elapsed}s
                </div>
                <p className="text-sm text-muted-foreground max-w-sm">
                  {t('review_do_not_close')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-success" />
            {t('review_ready_title')}
            {/* What the import does lives behind the "?" (convention 7)
                instead of a trailing card of numbered steps. */}
            <HelpPopover className="shrink-0">
              <div className="space-y-2">
                <p className="font-medium">{t('review_what_happens')}</p>
                <p>1. {t('review_step_fiscal_year')}</p>
                <p>2. {t('review_step_chart')}</p>
                <p>3. {t('review_step_opening_balance')}</p>
                <p>4. {t('review_step_vouchers')}</p>
                <p>5. {t('review_step_mappings')}</p>
                <p className="pt-2">
                  {t('review_undo_hint')}
                </p>
              </div>
            </HelpPopover>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
              <FileText className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">{preview.companyName || t('review_unknown_company')}</p>
                <p className="text-sm text-muted-foreground">{preview.orgNumber || t('review_no_org_number')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
              <Calendar className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">{t('review_fiscal_year')}</p>
                <p className="text-sm text-muted-foreground">
                  {preview.fiscalYearStart
                    ? formatDate(preview.fiscalYearStart)
                    : '?'}{' '}
                  -{' '}
                  {preview.fiscalYearEnd
                    ? formatDate(preview.fiscalYearEnd)
                    : '?'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
              <Database className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">{t('review_accounts_mapped', { count: mappedCount })}</p>
                <p className="text-sm text-muted-foreground">
                  {t('review_voucher_count', { count: preview.voucherCount })}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Import options */}
      <Card>
        <CardHeader>
          <CardTitle>{t('review_settings_title')}</CardTitle>
          <CardDescription>{t('review_settings_description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Fiscal period */}
          <div className="flex items-start justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="create-fiscal-period" className="font-medium">
                {t('review_create_fiscal_year')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t('review_create_fiscal_year_hint')}
              </p>
            </div>
            <Switch
              id="create-fiscal-period"
              checked={options.createFiscalPeriod}
              onCheckedChange={(checked) => updateOption('createFiscalPeriod', checked)}
            />
          </div>

          {/* Opening balances */}
          <div className="flex items-start justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="import-opening-balances" className="font-medium">
                {t('review_import_opening_balances')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {hasOpeningBalances
                  ? t('review_opening_balances_hint', { amount: formatCurrency(preview.openingBalanceTotal) })
                  : t('review_no_opening_balances')}
              </p>
              {existingIbCount > 0 && (
                <p className="text-sm text-muted-foreground">{t('ib_exists_hint')}</p>
              )}
            </div>
            <Switch
              id="import-opening-balances"
              checked={options.importOpeningBalances}
              onCheckedChange={(checked) => updateOption('importOpeningBalances', checked)}
              disabled={!hasOpeningBalances}
            />
          </div>

          {/* Voucher series for the opening-balance voucher (issue #1882) */}
          {options.importOpeningBalances && hasOpeningBalances && (
            <div className="space-y-2">
              <Label htmlFor="opening-balance-series" className="font-medium">
                {t('ib_series_label')}
              </Label>
              <Select
                value={options.openingBalanceSeries}
                onValueChange={(value) => updateOption('openingBalanceSeries', value)}
                disabled={!seriesLoaded}
              >
                <SelectTrigger id="opening-balance-series" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERIES_LETTERS.map((letter) => {
                    // The collision that matters for the IB voucher is with
                    // the FILE's own series (issue #1882): flag those first,
                    // ahead of the company-sequence hints.
                    const isInFile = seriesInFile.has(letter)
                    const isDefault = defaultSeries === letter
                    const isExisting = existingSeries.has(letter)
                    const suffix = isInFile
                      ? `, ${t('ib_series_in_file')}`
                      : isDefault
                        ? `, ${t('review_series_default')}`
                        : isExisting
                          ? `, ${t('review_series_in_use')}`
                          : ''
                    const name = voucherSeriesLabel(letter, seriesLabels)
                    return (
                      <SelectItem key={letter} value={letter}>
                        {`${t('review_series_option', { letter })}${name ? ` ${name}` : ''}${suffix}`}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {seriesInFile.has(options.openingBalanceSeries.toUpperCase()) ? (
                <AttnLine>{t('ib_series_collision')}</AttnLine>
              ) : (
                <p className="text-sm text-muted-foreground">{t('ib_series_hint')}</p>
              )}
            </div>
          )}

          {/* Transactions */}
          <div className="flex items-start justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="import-transactions" className="font-medium">
                {t('review_import_vouchers')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {hasTransactions
                  ? t('review_import_vouchers_hint', { vouchers: preview.voucherCount, lines: preview.transactionLineCount })
                  : t('review_no_vouchers')}
              </p>
            </div>
            <Switch
              id="import-transactions"
              checked={options.importTransactions}
              onCheckedChange={(checked) => updateOption('importTransactions', checked)}
              disabled={!hasTransactions}
            />
          </div>

          {/* Account names from file */}
          <div className="flex items-start justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="update-account-names" className="font-medium">
                {t('review_use_account_names')}
              </Label>
              <p className="text-sm text-muted-foreground">
                {customNameCount > 0
                  ? t('review_custom_names', { count: customNameCount })
                  : t('review_names_follow_bas')}
              </p>
            </div>
            <Switch
              id="update-account-names"
              checked={options.updateAccountNames}
              onCheckedChange={(checked) => updateOption('updateAccountNames', checked)}
            />
          </div>

          {/* Voucher series */}
          {options.importTransactions && hasTransactions && (
            <div className="space-y-2">
              <Label htmlFor="voucher-series" className="font-medium">
                {t('review_voucher_series_label')}
              </Label>
              <Select
                value={options.voucherSeries}
                onValueChange={(value) => updateOption('voucherSeries', value)}
                disabled={!seriesLoaded}
              >
                <SelectTrigger id="voucher-series" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERIES_LETTERS.map((letter) => {
                    const isDefault = defaultSeries === letter
                    const isExisting = existingSeries.has(letter)
                    const suffix = isDefault
                      ? `, ${t('review_series_default')}`
                      : isExisting
                        ? `, ${t('review_series_in_use')}`
                        : ''
                    const name = voucherSeriesLabel(letter, seriesLabels)
                    return (
                      <SelectItem key={letter} value={letter}>
                        {`${t('review_series_option', { letter })}${name ? ` ${name}` : ''}${suffix}`}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {t('review_voucher_series_hint')}
              </p>
            </div>
          )}

          {/* No-underlag exemption: keeps a multi-year migration from flooding
              "Att hantera: saknade underlag" with thousands of items. */}
          <div className="flex items-start justify-between border-t pt-6">
            <div className="space-y-0.5 pr-4">
              <Label htmlFor="mark-no-doc-required" className="font-medium flex items-center gap-2">
                {t('review_mark_no_doc')}
                {isHistoricalImport && (
                  <span className="text-xs font-normal text-muted-foreground">
                    · {t('review_recommended_migration')}
                  </span>
                )}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t('review_mark_no_doc_hint')}
              </p>
            </div>
            <Switch
              id="mark-no-doc-required"
              checked={options.markImportedNoDocRequired}
              onCheckedChange={(checked) => updateOption('markImportedNoDocRequired', checked)}
              disabled={!options.importTransactions || !hasTransactions}
            />
          </div>
        </CardContent>
      </Card>

      {/* Warnings */}
      {!preview.trialBalance.isBalanced && (
        <Card className="border-border bg-muted/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-warning">
              <AlertCircle className="h-5 w-5" />
              {t('review_notice_title')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t('review_unbalanced_notice')}
            </p>
          </CardContent>
        </Card>
      )}

      {error && (
        <div role="alert" className="p-4 rounded-lg flex gap-3 bg-destructive/10 border border-destructive/20">
          <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5 text-destructive" />
          <div className="space-y-1.5 min-w-0">
            <p className="font-medium text-destructive">{t('execute_rejected_title')}</p>
            <p className="whitespace-pre-line text-sm text-muted-foreground">{error}</p>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          {t('review_back')}
        </Button>
        <Button
          onClick={handleExecute}
          disabled={!canWrite || isLoading}
          title={!canWrite ? t('review_read_only') : undefined}
        >
          {!canWrite && <Lock className="mr-2 h-4 w-4" />}
          {t('review_start_import')}
          {canWrite && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}
