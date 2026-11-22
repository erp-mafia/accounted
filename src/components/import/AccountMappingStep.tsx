'use client'

import { useState, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
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
  ArrowRightIcon,
  CheckCircleIcon,
  CheckIcon,
  ExclamationCircleIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  XCircleIcon,
} from '@/components/icons'
import type { AccountMapping } from '@/lib/import/types'
import { isLowConfidenceMapping, isValidBASRange, resolveAccountMatch, type AccountMatchKind } from '@/lib/import/account-mapper'
import { ACCOUNT_TO_BOX } from '@/lib/vat/moms-box-mapping'
import type { SourceChartSummary } from '@/lib/import/source-chart/apply-source-chart'
import { ImportNotices } from '@/components/import/ImportNotices'
import { AttnLine } from '@/components/ui/attn-line'
import type { ImportNotice } from '@/lib/import/notices'
import { isAccountNumber } from '@/lib/invariants/account-number'
import type { BASAccount } from '@/types'
import {
  defaultRateForVatTreatment,
  vatTreatmentsForAccountClass,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import {
  countsRcBasisTwice,
  rcBasisPairFindings,
  rcMomskodSetAside,
} from '@/lib/import/account-vat-treatment'
import type { RcBasisPairFinding } from '@/lib/import/rc-basis-pairs'
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
  /**
   * Hand the picked chart export up as a File. The parent owns `mappings`, so
   * it owns reading and applying the file too; this step only collects it, the
   * same division the bulk confirm already uses. Passing the File rather than
   * its text keeps the read where the state that must report a failed one is.
   */
  onSourceChartSelected?: (file: File) => void
  /** What the last accepted file did, for the line above the table. */
  sourceChart?: { summary: SourceChartSummary; notices: ImportNotice[] } | null
  onContinue: () => void
  onBack: () => void
}

export type FilterType = 'all' | 'unmapped' | 'new_account' | 'vat_review' | 'low_confidence' | 'manual'

const PAGE_SIZE = 50

function matchesFilter(m: AccountMapping, filter: FilterType, knownTargets: ReadonlySet<string>): boolean {
  switch (filter) {
    case 'unmapped':
      return !m.targetAccount
    case 'new_account':
      return !!m.targetAccount && !knownTargets.has(m.targetAccount)
    case 'low_confidence':
      return isLowConfidenceMapping(m)
    case 'vat_review':
      return !!m.requiresVatTreatmentReview && !m.vatTreatmentReviewed
    case 'manual':
      return m.isOverride
    default:
      return true
  }
}

/**
 * The rows the table shows: those matching the filter and the search, plus
 * the rows the user answered in this view. Without the second set the review
 * filter was a shrinking queue: a confirmed row left at once, the next row
 * moved up under the pointer, and a quick second click confirmed a momskod
 * nobody had read (O20). The caller empties `answered` when the filter or the
 * search changes; that is when the answered rows leave.
 */
export function rowsInView(
  mappings: AccountMapping[],
  filter: FilterType,
  searchTerm: string,
  knownTargets: ReadonlySet<string>,
  answered: ReadonlySet<string>,
): AccountMapping[] {
  const term = searchTerm.toLowerCase()
  return mappings.filter((m) => {
    if (answered.has(m.sourceAccount)) return true
    if (!matchesFilter(m, filter, knownTargets)) return false
    return !term ||
      m.sourceAccount.includes(term) ||
      m.sourceName.toLowerCase().includes(term) ||
      !!m.targetAccount?.includes(term) ||
      !!m.targetName?.toLowerCase().includes(term)
  })
}

/**
 * How many account numbers the untranslated-code line names before it stops
 * counting them out. Six four-digit numbers fit the line; the realistic case is
 * one or two, since the untranslatable rutor are 06 and 50.
 */
const UNTRANSLATED_ACCOUNTS_LISTED = 6

/**
 * The momsdeklaration box the built-in BAS mapping already routes this account
 * to, or undefined when it has none. ACCOUNT_TO_BOX and ACCOUNT_RUTA are both
 * read from VAT_ACCOUNT_TABLE (lib/vat/moms-box-mapping.ts).
 */
function basBoxFor(mapping: AccountMapping): string | undefined {
  return ACCOUNT_TO_BOX[mapping.targetAccount ?? mapping.sourceAccount]
}

/**
 * The account numbers, capped: "3401, 3402" or "3401, 3402, ... och 4 till".
 * The tail is its own key rather than a hard-coded "och", which is a different
 * word in the other locale.
 */
function untranslatedAccountList(
  accounts: string[],
  t: ReturnType<typeof useTranslations<'chart_of_accounts'>>,
): string {
  const shown = accounts.slice(0, UNTRANSLATED_ACCOUNTS_LISTED).join(', ')
  if (accounts.length <= UNTRANSLATED_ACCOUNTS_LISTED) return shown
  return t('source_chart_untranslated_more', {
    accounts: shown,
    rest: accounts.length - UNTRANSLATED_ACCOUNTS_LISTED,
  })
}

/**
 * The line under a row whose file books the reverse-charge basis on a separate
 * pair beside the account (crm#1096), or null. A warning whenever the row's
 * momskod would count those purchases twice, whoever set it. Otherwise only
 * where the prefill set a reverse-charge momskod aside and the row carries
 * none: why, with the source code named when it was the code's. Then it takes
 * the source-code line's place; every other row keeps that line.
 */
function rcBasisNote(
  mapping: AccountMapping,
  finding: RcBasisPairFinding | undefined,
  t: ReturnType<typeof useTranslations<'chart_of_accounts'>>,
): string | null {
  if (!finding) return null
  const values = { count: finding.vouchers, accounts: finding.accounts.join(', ') }
  if (countsRcBasisTwice(mapping.sourceAccount, mapping.defaultVatTreatment, finding)) {
    return t('vat_treatment_rc_basis_twice', values)
  }
  const setAside = rcMomskodSetAside(mapping, finding)
  if (!setAside) return null
  return mapping.providerVatCode && mapping.providerVatTreatment === setAside
    ? t('vat_treatment_rc_basis_apart_code', { ...values, code: mapping.providerVatCode })
    : t('vat_treatment_rc_basis_apart', values)
}

export default function AccountMappingStep({
  mappings,
  basAccounts,
  onMappingChange,
  onVatTreatmentChange,
  onConfirmAllVatTreatments,
  onSourceChartSelected,
  sourceChart,
  onContinue,
  onBack,
}: AccountMappingStepProps) {
  const t = useTranslations('chart_of_accounts')
  const tStep = useTranslations('chart_of_accounts.mapping_step')
  const tCommon = useTranslations('common')
  const [searchTerm, setSearchTerm] = useState('')
  // Default to showing unmapped accounts first (most actionable)
  const [filter, setFilter] = useState<FilterType>(() => {
    const hasUnmapped = mappings.some((m) => !m.targetAccount)
    const hasVatReview = mappings.some((m) => m.requiresVatTreatmentReview && !m.vatTreatmentReviewed)
    return hasUnmapped ? 'unmapped' : hasVatReview ? 'vat_review' : 'all'
  })
  const [currentPage, setCurrentPage] = useState(1)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // Which rows the file books beside a basis pair that reports ruta 20-24,
  // judged over all rows: a pair's legs are other rows (crm#1096).
  const rcBasisFindings = useMemo(() => rcBasisPairFindings(mappings), [mappings])

  // Rows answered (target, momskod, rate or confirm) since the filter or the
  // search last changed. They stay where they are until it changes again.
  const [answeredInView, setAnsweredInView] = useState<ReadonlySet<string>>(() => new Set())
  const keepInView = (sourceAccount: string) =>
    setAnsweredInView((prev) => (prev.has(sourceAccount) ? prev : new Set(prev).add(sourceAccount)))

  const handleMappingChange: AccountMappingStepProps['onMappingChange'] = (sourceAccount, targetAccount, targetName) => {
    keepInView(sourceAccount)
    onMappingChange(sourceAccount, targetAccount, targetName)
  }

  const handleVatTreatmentChange: AccountMappingStepProps['onVatTreatmentChange'] = (sourceAccount, treatment, rate) => {
    keepInView(sourceAccount)
    onVatTreatmentChange(sourceAccount, treatment, rate)
  }

  const filteredMappings = useMemo(
    () => rowsInView(mappings, filter, searchTerm, knownTargets, answeredInView),
    [mappings, filter, searchTerm, knownTargets, answeredInView],
  )

  // Pagination
  const totalPages = Math.ceil(filteredMappings.length / PAGE_SIZE)
  const paginatedMappings = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE
    return filteredMappings.slice(start, start + PAGE_SIZE)
  }, [filteredMappings, currentPage])

  // A new filter or search is a new view: back to page 1, answered rows leave
  const handleFilterChange = (newFilter: FilterType) => {
    setFilter(newFilter)
    setCurrentPage(1)
    setAnsweredInView(new Set())
  }

  const handleSearchChange = (term: string) => {
    setSearchTerm(term)
    setCurrentPage(1)
    setAnsweredInView(new Set())
  }

  // Calculate stats
  const stats = useMemo(() => {
    const unmapped = mappings.filter((m) => !m.targetAccount).length
    const newAccounts = mappings.filter((m) => m.targetAccount && !knownTargets.has(m.targetAccount)).length
    const lowConfidence = mappings.filter(isLowConfidenceMapping).length
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

  // Group BAS accounts by class for the dropdown, and index the same accounts
  // by number so a closed picker can name its selection without the list.
  // The class headings are the chart of accounts page's own (class_1 to 8).
  const { accountsByClass, accountByNumber } = useMemo(() => {
    const groups: { [key: string]: BASAccount[] } = {}
    const byNumber = new Map<string, BASAccount>()
    for (const account of basAccounts) {
      if (!isAccountNumber(account.account_number)) continue
      const cls = account.account_class
      const className = `${cls}xxx - ${
        cls >= 1 && cls <= 8 ? t(`class_${cls as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`) : tStep('class_other')
      }`
      if (!groups[className]) {
        groups[className] = []
      }
      groups[className].push(account)
      byNumber.set(account.account_number, account)
    }
    return { accountsByClass: groups, accountByNumber: byNumber }
  }, [basAccounts, t, tStep])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardDescription>
            {tStep('intro')}{' '}
            {t('mapping_new_accounts_note')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* The gate on Continue, said where the step opens: its button and
              the bulk confirm sit below up to 50 table rows, which on a phone
              is several screens of scrolling before the way on is visible.
              It yields to a chart file's own attention sentence (one per
              page). */}
          {stats.vatReview > 0 && stats.unmapped === 0 &&
            !sourceChart?.notices.some((notice) => notice.severity === 'action') && (
            <AttnLine
              action={{
                label: t('vat_review_confirm_all', { count: stats.vatReview }),
                onClick: onConfirmAllVatTreatments,
              }}
            >
              {t('vat_review_gate', { count: stats.vatReview })}
            </AttnLine>
          )}

          {/* Stats */}
          <div className="flex gap-4 flex-wrap">
            <Badge
              variant={filter === 'vat_review' ? 'default' : stats.vatReview > 0 ? 'secondary' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('vat_review')}
            >
              <ExclamationCircleIcon className="h-3 w-3 mr-1" />
              {t('vat_review_filter', { count: stats.vatReview })}
            </Badge>
            <Badge
              variant={filter === 'unmapped' ? 'destructive' : stats.unmapped > 0 ? 'destructive' : 'secondary'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('unmapped')}
            >
              <XCircleIcon className="h-3 w-3 mr-1" />
              {tStep('filter_unmapped_count', { count: stats.unmapped })}
            </Badge>
            <Badge
              variant={filter === 'new_account' ? 'default' : stats.newAccounts > 0 ? 'secondary' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('new_account')}
            >
              <CheckCircleIcon className="h-3 w-3 mr-1" />
              {t('new_account_filter', { count: stats.newAccounts })}
            </Badge>
            <Badge
              variant={filter === 'low_confidence' ? 'default' : stats.lowConfidence > 0 ? 'secondary' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('low_confidence')}
            >
              <ExclamationCircleIcon className="h-3 w-3 mr-1" />
              {tStep('filter_low_confidence_count', { count: stats.lowConfidence })}
            </Badge>
            <Badge
              variant={filter === 'manual' ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('manual')}
            >
              <CheckCircleIcon className="h-3 w-3 mr-1" />
              {tStep('filter_manual_count', { count: stats.manual })}
            </Badge>
            <Badge
              variant={filter === 'all' ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => handleFilterChange('all')}
            >
              {tStep('filter_all_count', { count: mappings.length })}
            </Badge>
          </div>

          {unmappedAccounts.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('unmapped_out_of_range_help', { accounts: unmappedAccounts.join(', ') })}
            </p>
          )}

          {/* The source system's own momskoder, if the user has them.
              A quiet line rather than a drop zone: this step is already dense,
              and convention 6 puts attention in one sentence, not a banner.
              Optional throughout, the step works exactly as before without it. */}
          {onSourceChartSelected && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span>
                {sourceChart?.summary.formatLabel
                  ? t('source_chart_applied', {
                      count: sourceChart.summary.treatmentsApplied,
                      // Named back so a wrong detection is visible: the format
                      // is read from the header, never picked by the user.
                      format: sourceChart.summary.formatLabel,
                    })
                  : t('source_chart_prompt')}
              </span>
              {/* A real button that opens a hidden input, the same shape
                  every other file picker in this repo uses (LogoUpload,
                  BookingTemplatesPanel, UnderlagImportWizard). A <label>
                  wrapping a display:none input takes the control out of the
                  tab order entirely: the label is not focusable and neither
                  is the input, so the feature would exist only for a mouse. */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  // Reset first: picking the same file twice must fire again,
                  // which it does not if the value is left in place.
                  event.target.value = ''
                  if (file) onSourceChartSelected(file)
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
              >
                {/* Keyed to the same thing as the line beside it: a file
                    whose format was not recognised leaves nothing to
                    replace, so offering "Byt fil" next to the invitation
                    would have the two controls describe opposite states. */}
                {sourceChart?.summary.formatLabel
                  ? t('source_chart_replace')
                  : t('source_chart_action')}
              </Button>
              {/* Three paragraphs rather than one: the year rule is the one
                  that silently produces a wrong answer, so it gets its own,
                  and the menu path is what saves a trip back to the old
                  system. Wider than the 280px default to keep them readable. */}
              <InfoTooltip
                maxWidth="340px"
                content={
                  <span className="block space-y-2">
                    <span className="block">{t('source_chart_help')}</span>
                    <span className="block">{t('source_chart_help_year')}</span>
                    <span className="block">{t('source_chart_help_where')}</span>
                  </span>
                }
              />
            </div>
          )}
          {/* The other half of what the file did, on screen next to the first
              half. Not a notice: notices are problems with the file, and
              ImportNotices folds all but one away.

              Named, not just counted: the rows are scattered across paginated
              pages, so a bare number sends the user hunting for rows it will
              not identify. */}
          {sourceChart && sourceChart.summary.accountsWithoutTreatment.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('source_chart_untranslated', {
                count: sourceChart.summary.accountsWithoutTreatment.length,
                accounts: untranslatedAccountList(sourceChart.summary.accountsWithoutTreatment, t),
              })}
            </p>
          )}
          {/* The import's own notice system for what went wrong with the file,
              not a second one beside it. Renders nothing when there was
              nothing wrong, so it costs no space in the common case. */}
          {sourceChart && <ImportNotices notices={sourceChart.notices} />}

          {/* Search and filter */}
          <div className="flex gap-4">
            <div className="relative flex-1">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={tStep('search_placeholder')}
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={filter} onValueChange={(v) => handleFilterChange(v as FilterType)}>
              <SelectTrigger className="w-48">
                <FunnelIcon className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tStep('filter_all')}</SelectItem>
                <SelectItem value="unmapped">{tStep('filter_unmapped')}</SelectItem>
                <SelectItem value="new_account">{t('new_account_filter', { count: stats.newAccounts })}</SelectItem>
                <SelectItem value="vat_review">{t('vat_review_filter', { count: stats.vatReview })}</SelectItem>
                <SelectItem value="low_confidence">{tStep('filter_low_confidence')}</SelectItem>
                <SelectItem value="manual">{tStep('filter_manual')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Mapping table */}
          <div className="overflow-hidden">
            {/* Under table-fixed the header widths ARE the layout: cells never
                grow them. The budget is 960px, inside the 966px content
                column of a 1440px window, where the sidebar turns wide
                (#2125: 1216px overflowed, with 144px spent on a four-digit
                source account). The arrow column is as wide as its icon, and
                the source name is the column that gives way: it truncates and
                keeps the whole name in its tooltip. In a narrower column (a
                window under 1334px) the wrapper scrolls and the confirm
                column stays sticky (#1668).
                13px text and px-3 cells match the page-level list density. */}
            <Table className="table-fixed text-[13px] [&_td]:px-3 [&_th]:px-3">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">{tStep('col_source_account')}</TableHead>
                  <TableHead className="w-36">{tStep('col_source_name')}</TableHead>
                  <TableHead className="w-4 !px-0" aria-hidden="true"></TableHead>
                  <TableHead className="w-56">{tStep('col_target_account')}</TableHead>
                  <TableHead className="w-72">{t('vat_treatment_column')}</TableHead>
                  <TableHead className="w-24">{tStep('col_match')}</TableHead>
                  <TableHead className="sticky right-0 z-20 w-28 min-w-28 border-l-hairline bg-background text-right">
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
                      <ArrowRightIcon className="mx-auto h-4 w-4 text-muted-foreground" />
                    </TableCell>
                    <TableCell>
                      <TargetAccountSelect
                        mapping={mapping}
                        knownTargets={knownTargets}
                        accountsByClass={accountsByClass}
                        accountByNumber={accountByNumber}
                        onMappingChange={handleMappingChange}
                      />
                    </TableCell>
                    <TableCell>
                      {mapping.sourceAccount === mapping.targetAccount &&
                      ['3', '4', '5', '6'].includes(mapping.sourceAccount.charAt(0)) ? (
                        <>
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
                              handleVatTreatmentChange(mapping.sourceAccount, treatment, rate)
                            }}
                          >
                            <SelectTrigger
                              className={cn(
                                'min-w-0 flex-1',
                                ((mapping.requiresVatTreatmentReview && !mapping.vatTreatmentReviewed) ||
                                  countsRcBasisTwice(
                                    mapping.sourceAccount,
                                    mapping.defaultVatTreatment,
                                    rcBasisFindings.get(mapping.sourceAccount),
                                  )) &&
                                  'border-warning/60',
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
                            onValueChange={(value) => handleVatTreatmentChange(
                              mapping.sourceAccount,
                              mapping.defaultVatTreatment ?? null,
                              value === 'none' ? null : Number(value),
                            )}
                          >
                            <SelectTrigger className="w-36 shrink-0" aria-label={t('vat_rate_label')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {/* A null rate is "not set": the momskod or the
                                  BAS number decides it. Explicit no VAT is 0 %. */}
                              <SelectItem value="none">{t('vat_rate_none')}</SelectItem>
                              <SelectItem value="0">0 %</SelectItem>
                              <SelectItem value="0.25">25 %</SelectItem>
                              <SelectItem value="0.12">12 %</SelectItem>
                              <SelectItem value="0.06">6 %</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {/* Four things the code line can mean, and saying the
                            wrong one costs trust every time.

                            Translated: print it. Untranslated on an account the
                            BAS map already routes (4545 import to ruta 50):
                            nothing is missing, so claiming the code could not
                            be used would send the user hunting for a problem
                            that is not there. Untranslated with no BAS mapping
                            but a treatment on the row: it really does rest on
                            the account name, and printing the code alone would
                            read as confirmation of a box the source never
                            named.

                            And the one that used to borrow the third sentence
                            and be wrong: nothing translated the code, no BAS
                            number routes the account, and the label matched no
                            rule either. Pointing at a suggestion that is not
                            there is bad enough on its own; here it also hides
                            that the amount reaches NO ruta until the user picks
                            one.

                            Four ways in, measured, not only the import one:
                            ruta 50 or 06 on a number ACCOUNT_TO_BOX does not
                            know; a code naming no sats ("05") beside a label
                            naming none either; a code on the wrong account
                            class (ruta 20 on a revenue account), refused so an
                            acquisition cannot land in a sales box; and a code
                            the parser does not recognise, whether another
                            vendor's spelling or an impossible rate. In every
                            one the label is the last line of defence, which is
                            why a descriptive account name lands in the third
                            state instead. */}
                        {rcBasisNote(mapping, rcBasisFindings.get(mapping.sourceAccount), t) ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {rcBasisNote(mapping, rcBasisFindings.get(mapping.sourceAccount), t)}
                          </p>
                        ) : mapping.providerVatCode ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {mapping.providerVatTreatment
                              ? t('vat_treatment_source_code', { code: mapping.providerVatCode })
                              : basBoxFor(mapping)
                                ? t('vat_treatment_source_code_bas', {
                                    code: mapping.providerVatCode,
                                    box: basBoxFor(mapping)!,
                                  })
                                : mapping.defaultVatTreatment
                                  ? t('vat_treatment_source_code_unreadable', { code: mapping.providerVatCode })
                                  : t('vat_treatment_source_code_nowhere', { code: mapping.providerVatCode })}
                          </p>
                        ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <AccountMatchBadge mapping={mapping} />
                    </TableCell>
                    <TableCell
                      className={cn(
                        'sticky right-0 z-10 w-28 min-w-28 border-l-hairline text-right transition-colors',
                        mapping.targetAccount ? 'bg-background' : 'bg-destructive/5',
                        'group-hover:bg-muted/50 group-focus-within:bg-muted/50',
                      )}
                    >
                      {/* An answered row stays in view (rowsInView), so it says
                          it is done here instead of leaving the table. */}
                      {mapping.requiresVatTreatmentReview && mapping.vatTreatmentReviewed && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
                          {t('vat_treatment_confirmed')}
                        </span>
                      )}
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
                              aria-label={`${t('vat_treatment_confirm')}: ${mapping.sourceAccount}`}
                              onClick={() => handleVatTreatmentChange(
                                mapping.sourceAccount,
                                mapping.defaultVatTreatment ?? null,
                                mapping.defaultVatRate ?? null,
                              )}
                            >
                              <CheckIcon className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left">{t('vat_treatment_confirm')}</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {paginatedMappings.length === 0 && (
                  // No hits: one muted line in the list, not a centred block.
                  <TableRow>
                    <TableCell colSpan={7} className="py-3 text-[13px] text-muted-foreground">
                      <span className="flex flex-wrap items-center gap-x-3">
                        <span>{tStep('no_matches')}</span>
                        {searchTerm && (
                          <Button variant="link" onClick={() => handleSearchChange('')}>
                            {tCommon('clear_search')}
                          </Button>
                        )}
                      </span>
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
                {tStep('showing_range', {
                  from: ((currentPage - 1) * PAGE_SIZE) + 1,
                  to: Math.min(currentPage * PAGE_SIZE, filteredMappings.length),
                  total: filteredMappings.length,
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  {tStep('previous')}
                </Button>
                <div className="flex items-center gap-1 px-2">
                  <span className="text-sm">{tStep('page_of', { page: currentPage, total: totalPages })}</span>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  {tStep('next')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          {tCommon('back')}
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {stats.vatReview > 0 && stats.unmapped === 0 && (
            <Button
              variant="outline"
              onClick={onConfirmAllVatTreatments}
            >
              <CheckCircleIcon className="h-4 w-4" />
              {t('vat_review_confirm_all', { count: stats.vatReview })}
            </Button>
          )}
          <Button onClick={onContinue} disabled={!canContinue}>
            {canContinue
              ? tStep('continue_to_review')
              : stats.unmapped > 0
                ? tStep('unmapped_remaining', { count: stats.unmapped })
                : tStep('vat_review_remaining', { count: stats.vatReview })}
            <ArrowRightIcon className="h-4 w-4" />
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
  unnamed: (number: string) => string,
): Array<{ value: string; name: string }> {
  const options: Array<{ value: string; name: string }> = []
  if (!knownTargets.has(mapping.sourceAccount) && isValidBASRange(mapping.sourceAccount)) {
    options.push({
      value: mapping.sourceAccount,
      name: mapping.sourceName || unnamed(mapping.sourceAccount),
    })
  }
  if (
    mapping.targetAccount &&
    mapping.targetAccount !== mapping.sourceAccount &&
    !knownTargets.has(mapping.targetAccount)
  ) {
    options.push({
      value: mapping.targetAccount,
      name: mapping.targetName || unnamed(mapping.targetAccount),
    })
  }
  return options
}

/**
 * One row's target-account picker. Its option list is mounted only while the
 * list is on screen: open, or fading out after it closed.
 *
 * Radix keeps a closed Select's items mounted in a detached fragment (the
 * trigger shows the selected item's text from there) and registers a native
 * option per item in state. The list is the BAS catalogue plus the company
 * chart, about 1,300 accounts, on each of the page's 50 rows: some 65,000
 * mounted items nobody could see. A laptop spends seconds on that; on an
 * iPhone, WebKit ran out of memory and reloaded the tab every time a Fortnox
 * migration reached this step, back at the start of the wizard (crm#1118).
 * Closed, the picker mounts the selected option alone, which is all its
 * trigger shows. Typeahead on a focused but closed trigger therefore no longer
 * jumps through the chart; it does as soon as the list is open.
 */
function TargetAccountSelect({
  mapping,
  knownTargets,
  accountsByClass,
  accountByNumber,
  onMappingChange,
}: {
  mapping: AccountMapping
  knownTargets: ReadonlySet<string>
  accountsByClass: Record<string, BASAccount[]>
  accountByNumber: ReadonlyMap<string, BASAccount>
  onMappingChange: AccountMappingStepProps['onMappingChange']
}) {
  const tStep = useTranslations('chart_of_accounts.mapping_step')
  const [open, setOpen] = useState(false)
  // Set on open, cleared once the content has left the screen. Radix keeps a
  // closing Select's content mounted for its fade-out, and the fade shows the
  // list it opened with: keyed on `open` alone, the list would shrink to the
  // selected row as it faded.
  const [listMounted, setListMounted] = useState(false)

  return (
    <Select
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setListMounted(true)
      }}
      value={mapping.targetAccount || 'none'}
      onValueChange={(value) => {
        const account = accountByNumber.get(value)
        // A target outside the list is created on import under the file's
        // name (the identity option) or the name the row already carries.
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
        <SelectValue placeholder={tStep('select_account')} />
      </SelectTrigger>
      <SelectContent
        className="max-h-80"
        // The fade-out ended: Radix unmounts the content in this same render,
        // so the closed picker goes straight to its one option. Cleared any
        // later, the detached fragment would mount the whole list again first.
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.currentTarget.dataset.state === 'closed') {
            setListMounted(false)
          }
        }}
        // Called once the content has unmounted, faded or not: the fallback
        // when no exit animation runs, which would leave the list mounted.
        onCloseAutoFocus={() => setListMounted(false)}
      >
        <TargetAccountOptions
          mapping={mapping}
          knownTargets={knownTargets}
          accountsByClass={accountsByClass}
          accountByNumber={accountByNumber}
          selectedOnly={!listMounted}
        />
      </SelectContent>
    </Select>
  )
}

/**
 * The options of one row's target picker: the whole list, or with
 * `selectedOnly` just the selected option, rendered exactly as the list
 * renders it so a closed trigger names it the same way.
 */
export function TargetAccountOptions({
  mapping,
  knownTargets,
  accountsByClass,
  accountByNumber,
  selectedOnly,
}: {
  mapping: AccountMapping
  knownTargets: ReadonlySet<string>
  accountsByClass: Record<string, BASAccount[]>
  accountByNumber: ReadonlyMap<string, BASAccount>
  selectedOnly: boolean
}) {
  const t = useTranslations('chart_of_accounts')
  const tStep = useTranslations('chart_of_accounts.mapping_step')
  const created = createdOptionsFor(mapping, knownTargets, (number) => tStep('account_fallback', { number }))

  const noneItem = <SelectItem value="none">{tStep('no_account_option')}</SelectItem>
  const createdItem = (option: { value: string; name: string }) => (
    <SelectItem key={option.value} value={option.value}>
      <span className="font-mono mr-2">{option.value}</span>
      {option.name}
      <span className="ml-2 text-muted-foreground">
        ({t('new_account_option')})
      </span>
    </SelectItem>
  )
  const accountItem = (account: BASAccount) => (
    <SelectItem key={account.account_number} value={account.account_number}>
      <span className="font-mono mr-2">{account.account_number}</span>
      {account.account_name}
    </SelectItem>
  )

  if (selectedOnly) {
    if (!mapping.targetAccount) return noneItem
    const createdOption = created.find((option) => option.value === mapping.targetAccount)
    if (createdOption) return createdItem(createdOption)
    const account = accountByNumber.get(mapping.targetAccount)
    return account ? accountItem(account) : null
  }

  return (
    <>
      {noneItem}
      {created.map(createdItem)}
      {Object.entries(accountsByClass).map(([className, accounts]) => (
        <div key={className}>
          <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted">
            {className}
          </div>
          {accounts.map(accountItem)}
        </div>
      ))}
    </>
  )
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

/**
 * The match kinds that get a chip, and which one. A recognised account and
 * one kept from the file are what happens to most rows of a migration, so
 * they read as muted text; a chip marks the rows where the target is another
 * number, the mapper asks for a look, or the person chose.
 */
const MATCH_CHIP: Partial<Record<AccountMatchKind, 'default' | 'secondary' | 'outline'>> = {
  redirected: 'secondary',
  uncertain: 'outline',
  manual: 'default',
}

/** What the mapper did with the row (resolveAccountMatch); nothing on an unmapped row. */
function AccountMatchBadge({ mapping }: { mapping: AccountMapping }) {
  const tStep = useTranslations('chart_of_accounts.mapping_step')
  const kind = resolveAccountMatch(mapping)
  if (!kind) return null
  const chip = MATCH_CHIP[kind]
  return chip ? (
    <Badge variant={chip}>{tStep(`match_${kind}`)}</Badge>
  ) : (
    <span className="whitespace-nowrap text-xs text-muted-foreground">{tStep(`match_${kind}`)}</span>
  )
}

