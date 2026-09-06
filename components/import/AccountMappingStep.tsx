'use client'

import { useState, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowRight,
  Search,
  Check,
  CheckCircle,
  AlertCircle,
  XCircle,
  Filter,
} from 'lucide-react'
import type { AccountMapping } from '@/lib/import/types'
import { isValidBASRange } from '@/lib/import/account-mapper'
import type { BASAccount } from '@/types'
import { getAccountClassName } from '@/lib/bookkeeping/account-descriptions'
import {
  defaultRateForVatTreatment,
  vatTreatmentsForAccountClass,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import {
  InfoTooltip,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/info-tooltip'
import { cn } from '@/lib/utils'

interface AccountMappingStepProps {
  mappings: AccountMapping[]
  basAccounts: BASAccount[]
  onMappingChange: (sourceAccount: string, targetAccount: string, targetName: string) => void
  onVatTreatmentChange: (
    sourceAccount: string,
    treatment: AccountVatTreatment | null,
    rate: number | null,
  ) => void
  /** Accept the suggested VAT treatment for every unreviewed row at once. */
  onConfirmAllVatTreatments: () => void
  onContinue: () => void
  onBack: () => void
}

type FilterType = 'all' | 'unmapped' | 'new_account' | 'vat_review' | 'low_confidence' | 'manual'

const PAGE_SIZE = 50

export default function AccountMappingStep({
  mappings,
  basAccounts,
  onMappingChange,
  onVatTreatmentChange,
  onConfirmAllVatTreatments,
  onContinue,
  onBack,
}: AccountMappingStepProps) {
  const t = useTranslations('chart_of_accounts')
  const [searchTerm, setSearchTerm] = useState('')
  // Default to showing unmapped accounts first (most actionable)
  const [filter, setFilter] = useState<FilterType>(() => {
    const hasUnmapped = mappings.some((m) => !m.targetAccount)
    const hasVatReview = mappings.some((m) => m.requiresVatTreatmentReview && !m.vatTreatmentReviewed)
    return hasUnmapped ? 'unmapped' : hasVatReview ? 'vat_review' : 'all'
  })
  const [currentPage, setCurrentPage] = useState(1)

  // Targets the dropdown can name: the caller's list (the company chart, or
  // chart + BAS). A mapped target outside it is an account the import will
  // CREATE (syncMappedAccounts inserts every missing target, class and type
  // derived from the number). Such a row is mapped and valid, but a Select
  // whose value matches no option renders blank, which is how a self-mapped
  // Fortnox account outside BAS looked unmapped and unmappable (issue #2212).
  // Every target outside this set is therefore rendered as an explicit
  // "created on import" option.
  const knownTargets = useMemo(
    () => new Set(basAccounts.map((a) => a.account_number)),
    [basAccounts],
  )

  // Filter and search mappings
  const filteredMappings = useMemo(() => {
    let result = mappings

    // Apply filter
    switch (filter) {
      case 'unmapped':
        result = result.filter((m) => !m.targetAccount)
        break
      case 'new_account':
        result = result.filter((m) => m.targetAccount && !knownTargets.has(m.targetAccount))
        break
      case 'low_confidence':
        result = result.filter((m) => m.targetAccount && m.confidence < 0.7)
        break
      case 'vat_review':
        result = result.filter((m) => m.requiresVatTreatmentReview && !m.vatTreatmentReviewed)
        break
      case 'manual':
        result = result.filter((m) => m.isOverride)
        break
    }

    // Apply search
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      result = result.filter(
        (m) =>
          m.sourceAccount.includes(term) ||
          m.sourceName.toLowerCase().includes(term) ||
          m.targetAccount?.includes(term) ||
          m.targetName?.toLowerCase().includes(term)
      )
    }

    return result
  }, [mappings, filter, searchTerm, knownTargets])

  // Pagination
  const totalPages = Math.ceil(filteredMappings.length / PAGE_SIZE)
  const paginatedMappings = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return filteredMappings.slice(start, start + PAGE_SIZE)
  }, [filteredMappings, currentPage])

  // Reset page when filter or search changes
  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter)
    setCurrentPage(1)
  }

  const handleSearchChange = (term: string) => {
    setSearchTerm(term)
    setCurrentPage(1)
  }

  // Calculate stats
  const stats = useMemo(() => {
    const unmapped = mappings.filter((m) => !m.targetAccount).length
    const newAccounts = mappings.filter((m) => m.targetAccount && !knownTargets.has(m.targetAccount)).length
    const lowConfidence = mappings.filter((m) => m.targetAccount && m.confidence < 0.7).length
    const manual = mappings.filter((m) => m.isOverride).length
    const vatReview = mappings.filter((m) => m.requiresVatTreatmentReview && !m.vatTreatmentReviewed).length
    return { unmapped, newAccounts, lowConfidence, manual, vatReview }
  }, [mappings, knownTargets])

  // After the mapper's self-map rule, an unmapped row is always a number
  // outside 1000-8999: nothing can be created for it, so the user must pick a
  // target. Name them so the disabled Continue button is not the only signal.
  const unmappedAccounts = useMemo(
    () => mappings.filter((m) => !m.targetAccount).map((m) => m.sourceAccount),
    [mappings],
  )

  const canContinue = stats.unmapped === 0 && stats.vatReview === 0

  // Group BAS accounts by class for the dropdown
  const accountsByClass = useMemo(() => {
    const groups: { [key: string]: BASAccount[] } = {}
    for (const account of basAccounts) {
      const className = getAccountClassName(account.account_class)
      if (!groups[className]) {
        groups[className] = []
      }
      groups[className].push(account)
    }
    return groups
  }, [basAccounts])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Kontomappning</CardTitle>
          <CardDescription>
            Varje konto i SIE-filen kopplas till ett konto i din kontoplan.
            De flesta matchas automatiskt: granska de osäkra nedan.{' '}
            {t('mapping_new_accounts_note')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Stats */}
          <div className="flex gap-4 flex-wrap">
            <Badge
              variant={filter === 'vat_review' ? 'default' : stats.vatReview > 0 ? 'secondary' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('vat_review')}
            >
              <AlertCircle className="h-3 w-3 mr-1" />
              {t('vat_review_filter', { count: stats.vatReview })}
            </Badge>
            <Badge
              variant={filter === 'unmapped' ? 'destructive' : stats.unmapped > 0 ? 'destructive' : 'secondary'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('unmapped')}
            >
              <XCircle className="h-3 w-3 mr-1" />
              {stats.unmapped} ej mappade
            </Badge>
            <Badge
              variant={filter === 'new_account' ? 'default' : stats.newAccounts > 0 ? 'secondary' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('new_account')}
            >
              <CheckCircle className="h-3 w-3 mr-1" />
              {t('new_account_filter', { count: stats.newAccounts })}
            </Badge>
            <Badge
              variant={filter === 'low_confidence' ? 'default' : stats.lowConfidence > 0 ? 'secondary' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('low_confidence')}
            >
              <AlertCircle className="h-3 w-3 mr-1" />
              {stats.lowConfidence} osäkra
            </Badge>
            <Badge
              variant={filter === 'manual' ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('manual')}
            >
              <CheckCircle className="h-3 w-3 mr-1" />
              {stats.manual} manuellt satta
            </Badge>
            <Badge
              variant={filter === 'all' ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('all')}
            >
              Visa alla ({mappings.length})
            </Badge>
          </div>

          {unmappedAccounts.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('unmapped_out_of_range_help', { accounts: unmappedAccounts.join(', ') })}
            </p>
          )}

          {/* Search and filter */}
          <div className="flex gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Sök konto..."
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filter} onValueChange={(v) => handleFilterChange(v as FilterType)}>
              <SelectTrigger className="w-48">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Visa alla</SelectItem>
                <SelectItem value="unmapped">Ej mappade</SelectItem>
                <SelectItem value="new_account">{t('new_account_filter', { count: stats.newAccounts })}</SelectItem>
                <SelectItem value="vat_review">{t('vat_review_filter', { count: stats.vatReview })}</SelectItem>
                <SelectItem value="low_confidence">Osäkra</SelectItem>
                <SelectItem value="manual">Manuellt satta</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Mapping table */}
          <div className="overflow-hidden rounded-lg border">
            {/* Under table-fixed the header widths ARE the layout: cells never
                grow them. The budget is ~990px so the table fits a laptop
                content column at 100 % zoom (#2125: 1216px overflowed, with
                144px spent on a four-digit source account); beyond that the
                wrapper scrolls and the confirm column stays sticky (#1668).
                13px text and px-3 cells match the page-level list density. */}
            <Table className="table-fixed text-[13px] [&_td]:px-3 [&_th]:px-3">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Källkonto</TableHead>
                  <TableHead className="w-40">Källnamn</TableHead>
                  <TableHead className="w-8 !px-0" aria-hidden="true"></TableHead>
                  <TableHead className="w-56">Målkonto</TableHead>
                  <TableHead className="w-72">{t('vat_treatment_column')}</TableHead>
                  <TableHead className="w-24">Konfidens</TableHead>
                  <TableHead className="sticky right-0 z-20 w-28 min-w-28 border-l border-border bg-background text-right">
                    <span className="inline-flex items-center gap-1">
                      {t('vat_treatment_confirm')}
                      <InfoTooltip content={t('vat_treatment_confirm_help')} side="left" />
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedMappings.map((mapping) => (
                  <TableRow
                    key={mapping.sourceAccount}
                    className={cn('group', !mapping.targetAccount && 'bg-destructive/5')}
                  >
                    <TableCell className="font-mono">{mapping.sourceAccount}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {mapping.sourceName ? (
                        <TruncatedSourceName sourceName={mapping.sourceName} />
                      ) : (
                        <span className="italic">{t('source_name_missing')}</span>
                      )}
                    </TableCell>
                    <TableCell className="!px-0">
                      <ArrowRight className="mx-auto h-4 w-4 text-muted-foreground" />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={mapping.targetAccount || 'none'}
                        onValueChange={(value) => {
                          const account = basAccounts.find((a) => a.account_number === value)
                          // A target outside the list is created on import
                          // under the file's name (the identity option) or
                          // the name the row already carries.
                          const createdName =
                            value === mapping.sourceAccount ? mapping.sourceName : mapping.targetName
                          onMappingChange(
                            mapping.sourceAccount,
                            value === 'none' ? '' : value,
                            account?.account_name ?? createdName ?? ''
                          )
                        }}
                      >
                        <SelectTrigger className={!mapping.targetAccount ? 'border-destructive' : ''}>
                          <SelectValue placeholder="Välj konto..." />
                        </SelectTrigger>
                        <SelectContent className="max-h-80">
                          <SelectItem value="none">-- Välj konto --</SelectItem>
                          {createdOptionsFor(mapping, knownTargets).map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              <span className="font-mono mr-2">{option.value}</span>
                              {option.name}
                              <span className="ml-2 text-muted-foreground">
                                ({t('new_account_option')})
                              </span>
                            </SelectItem>
                          ))}
                          {Object.entries(accountsByClass).map(([className, accounts]) => (
                            <div key={className}>
                              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted">
                                {className}
                              </div>
                              {accounts.map((account) => (
                                <SelectItem
                                  key={account.account_number}
                                  value={account.account_number}
                                >
                                  <span className="font-mono mr-2">{account.account_number}</span>
                                  {account.account_name}
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {mapping.sourceAccount === mapping.targetAccount &&
                      ['3', '4', '5', '6'].includes(mapping.sourceAccount.charAt(0)) ? (
                        <div className="flex gap-2">
                          <Select
                            value={mapping.defaultVatTreatment ?? 'none'}
                            onValueChange={(value) => {
                              const treatment = value === 'none'
                                ? null
                                : value as AccountVatTreatment
                              const accountClass = Number(mapping.sourceAccount.charAt(0))
                              const rate = treatment
                                ? mapping.defaultVatRate == null || mapping.vatTreatmentSuggested
                                  ? defaultRateForVatTreatment(treatment, accountClass)
                                  : mapping.defaultVatRate
                                : mapping.defaultVatRate ?? null
                              onVatTreatmentChange(mapping.sourceAccount, treatment, rate)
                            }}
                          >
                            <SelectTrigger
                              className={cn(
                                'min-w-0 flex-1',
                                mapping.requiresVatTreatmentReview && 'border-warning/60',
                              )}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">{t('vat_treatment_none')}</SelectItem>
                              {vatTreatmentsForAccountClass(
                                Number(mapping.sourceAccount.charAt(0))
                              ).map((treatment) => (
                                <SelectItem key={treatment} value={treatment}>
                                  {t(`vat_treatment_${treatment}`)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={mapping.defaultVatRate === null || mapping.defaultVatRate === undefined
                              ? 'none'
                              : String(mapping.defaultVatRate)}
                            onValueChange={(value) => onVatTreatmentChange(
                              mapping.sourceAccount,
                              mapping.defaultVatTreatment ?? null,
                              value === 'none' ? null : Number(value),
                            )}
                          >
                            <SelectTrigger className="w-24 shrink-0" aria-label={t('vat_rate_label')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">{t('vat_rate_none')}</SelectItem>
                              <SelectItem value="0">0 %</SelectItem>
                              <SelectItem value="0.25">25 %</SelectItem>
                              <SelectItem value="0.12">12 %</SelectItem>
                              <SelectItem value="0.06">6 %</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {mapping.targetAccount && (
                        <ConfidenceBadge
                          confidence={mapping.confidence}
                          matchType={mapping.matchType}
                          isOverride={mapping.isOverride}
                        />
                      )}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'sticky right-0 z-10 w-28 min-w-28 border-l border-border text-right transition-colors',
                        mapping.targetAccount ? 'bg-background' : 'bg-destructive/5',
                        'group-hover:bg-muted/50 group-focus-within:bg-muted/50',
                      )}
                    >
                      {mapping.requiresVatTreatmentReview && !mapping.vatTreatmentReviewed && (
                        /* Icon-only: the column header carries the label and
                           the tooltip repeats it on hover; the accessible name
                           also says which row. */
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-11 w-11 sm:h-8 sm:w-8"
                              aria-label={`${t('vat_treatment_confirm')}: ${mapping.sourceAccount}`}
                              onClick={() => onVatTreatmentChange(
                                mapping.sourceAccount,
                                mapping.defaultVatTreatment ?? null,
                                mapping.defaultVatRate ?? null,
                              )}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left">{t('vat_treatment_confirm')}</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {paginatedMappings.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      Inga konton matchar filtret
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Visar {((currentPage - 1) * PAGE_SIZE) + 1}-{Math.min(currentPage * PAGE_SIZE, filteredMappings.length)} av {filteredMappings.length}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Föregående
                </Button>
                <div className="flex items-center gap-1 px-2">
                  <span className="text-sm">Sida {currentPage} av {totalPages}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Nästa
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" className="min-h-11" onClick={onBack}>
          Tillbaka
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {stats.vatReview > 0 && stats.unmapped === 0 && (
            <Button
              variant="outline"
              className="min-h-11"
              onClick={onConfirmAllVatTreatments}
            >
              <CheckCircle className="mr-2 h-4 w-4" />
              {t('vat_review_confirm_all', { count: stats.vatReview })}
            </Button>
          )}
          <Button className="min-h-11" onClick={onContinue} disabled={!canContinue}>
            {canContinue
              ? 'Fortsätt till granskning'
              : stats.unmapped > 0
                ? `${stats.unmapped} konton saknar mappning`
                : `${stats.vatReview} momskoder återstår att bekräfta`}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The "created on import" options a row can select: its own number (when
 * that is in the auto-create range and not already in the chart) and, if the
 * row currently points at some other target the list cannot name, that
 * target too, so the current value always renders. Ordered so the identity
 * option comes first.
 */
function createdOptionsFor(
  mapping: AccountMapping,
  knownTargets: ReadonlySet<string>,
): Array<{ value: string; name: string }> {
  const options: Array<{ value: string; name: string }> = []
  if (!knownTargets.has(mapping.sourceAccount) && isValidBASRange(mapping.sourceAccount)) {
    options.push({
      value: mapping.sourceAccount,
      name: mapping.sourceName || `Konto ${mapping.sourceAccount}`,
    })
  }
  if (
    mapping.targetAccount &&
    mapping.targetAccount !== mapping.sourceAccount &&
    !knownTargets.has(mapping.targetAccount)
  ) {
    options.push({
      value: mapping.targetAccount,
      name: mapping.targetName || `Konto ${mapping.targetAccount}`,
    })
  }
  return options
}

function TruncatedSourceName({ sourceName }: { sourceName: string }) {
  const [open, setOpen] = useState(false)

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className="flex min-h-10 w-full min-w-0 items-center rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onClick={() => setOpen(true)}
        >
          <span className="block min-w-0 truncate">{sourceName}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-xs break-words"
        data-ph-mask=""
      >
        {sourceName}
      </TooltipContent>
    </Tooltip>
  )
}

function ConfidenceBadge({
  confidence,
  isOverride,
}: {
  confidence: number
  matchType: string  // Keep for potential future use
  isOverride: boolean
}) {
  if (isOverride) {
    return <Badge variant="default">Manuell</Badge>
  }

  if (confidence >= 0.9) {
    return <Badge variant="success">Exakt</Badge>
  }

  if (confidence >= 0.7) {
    return <Badge variant="secondary">Trolig</Badge>
  }

  return <Badge variant="outline">Osäker</Badge>
}

