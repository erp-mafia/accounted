'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AccountNumber } from '@/components/ui/account-number'
import { QUIET_LINK_CLASS, SortableTh } from '@/components/ui/dry-table'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { MagnifyingGlassIcon } from '@/components/icons'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import {
  ReportEmptyState,
  ReportErrorCard,
  ReportLoadingCard,
  reportQuery,
} from '@/components/reports/report-view-shared'
import { useReportData } from '@/lib/hooks/use-report-data'
import { useReportPages } from '@/lib/hooks/use-report-pages'
import { formatAmount, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  LEDGER_ROW_ORDER,
  arrangeLedgerRows,
  isLedgerRowOrder,
  ledgerBalanceRuns,
  ledgerRowSortToken,
  type LedgerRowSort,
  type LedgerRowSortColumn,
} from '@/lib/reports/general-ledger-rows'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import type { DimensionFilterValue } from '@/components/reports/DimensionFilter'

// --- General Ledger (Huvudbok) ---

interface GeneralLedgerLine {
  date: string
  voucher_series: string
  voucher_number: number
  journal_entry_id: string
  description: string
  source_type: string
  debit: number
  credit: number
  balance: number
  dimensions?: Record<string, string>
}

interface GeneralLedgerAccount {
  account_number: string
  account_name: string
  opening_balance: number
  closing_balance: number
  total_debit: number
  total_credit: number
  line_count: number
  /** Every line of the account, when the overview carries them (lines_included). */
  lines?: GeneralLedgerLine[]
}

interface GeneralLedgerData {
  accounts: GeneralLedgerAccount[]
  period: { start: string; end: string }
  /** False for a large ledger: each account's lines are read when it is opened. */
  lines_included: boolean
}

/**
 * A page of one account's lines. In ledger order `next` is the cursor of the
 * page after it. Sorted on something else or searched, the route answers the
 * arrangement instead: where its next page starts, how many lines it holds
 * and, under a search, the debit and credit of everything the search found.
 */
interface GeneralLedgerLinesPage {
  lines: GeneralLedgerLine[]
  next?: { date: string; voucher_number: number; line_id: string } | null
  next_offset?: number | null
  line_count?: number
  matched?: LedgerSearchSums | null
}

interface LedgerSearchSums {
  debit: number
  credit: number
}

/** How one account's rows are shown, and the two ways the table changes it. */
interface LedgerRowControls {
  sort: LedgerRowSort
  /** The search that narrows the rows; '' is none. */
  search: string
  onSort: (column: LedgerRowSortColumn) => void
  onClearSearch: () => void
}

// A header click: ascending, then descending, then back to ledger order, so
// a sort is always escapable from the header itself (as in the verifikat
// list). On the date column that is oldest first, newest first, oldest first.
function nextLedgerRowSort(current: LedgerRowSort, column: LedgerRowSortColumn): LedgerRowSort {
  if (current.column !== column) return { column, ascending: true }
  return current.ascending ? { column, ascending: false } : LEDGER_ROW_ORDER
}

// Stable default for callers that omit the prop.
const EMPTY_DATE_RANGE: DateRangeValue = {}

export default function GeneralLedgerView({ periodId, initialAccountFilter, dimensionFilter = null, dateRange = EMPTY_DATE_RANGE }: { periodId: string; initialAccountFilter: string | null; dimensionFilter?: DimensionFilterValue | null; dateRange?: DateRangeValue }) {
  const [accountFrom, setAccountFrom] = useState(initialAccountFilter ?? '')
  const [accountTo, setAccountTo] = useState(initialAccountFilter ?? '')
  // The account range the ledger is fetched for: what Filtrera applied. A new
  // period, window, dimension or drill-down applies the drill-down's account
  // when there is one (into the fields too), else what the fields hold.
  const [applied, setApplied] = useState({ from: accountFrom, to: accountTo })
  const scope = `${reportQuery(periodId, dateRange, dimensionFilter)}|${initialAccountFilter ?? ''}`
  const [appliedScope, setAppliedScope] = useState(scope)
  if (appliedScope !== scope) {
    setAppliedScope(scope)
    if (initialAccountFilter) {
      setAccountFrom(initialAccountFilter)
      setAccountTo(initialAccountFilter)
      setApplied({ from: initialAccountFilter, to: initialAccountFilter })
    } else {
      setApplied({ from: accountFrom, to: accountTo })
    }
  }

  // Only the request for the current parameters may land: the window changes
  // right after mount (the date-range control resolves its preset, or a
  // drill-down's window), and the superseded answer is dropped.
  const params = new URLSearchParams({ period_id: periodId })
  if (applied.from) params.set('account_from', applied.from)
  if (applied.to) params.set('account_to', applied.to)
  if (dateRange.fromDate) params.set('from_date', dateRange.fromDate)
  if (dateRange.toDate) params.set('to_date', dateRange.toDate)
  if (dimensionFilter) {
    params.set('dim_no', dimensionFilter.dimNo)
    params.set('dim_code', dimensionFilter.code)
  }
  const { data, loading, error, refetch } = useReportData<GeneralLedgerData>(
    `/api/reports/general-ledger/accounts?${params}`,
    'Kunde inte hämta huvudbok',
  )
  const t = useTranslations('general_ledger')
  // One account in range (a drill-down) opens with its lines.
  const singleAccount = applied.from !== '' && applied.from === applied.to

  // Filtrera with an unchanged range fetches again, as it always has.
  const applyAccountRange = () => {
    if (applied.from === accountFrom && applied.to === accountTo) refetch()
    else setApplied({ from: accountFrom, to: accountTo })
  }

  if (loading) {
    return <ReportLoadingCard />
  }

  if (error) {
    return <ReportErrorCard message={error} onRetry={refetch} />
  }

  // An applied account range that holds nothing keeps the range fields on
  // screen, so it can be changed or cleared; only an unfiltered empty
  // ledger is the period's empty state.
  const rangeApplied = applied.from !== '' || applied.to !== ''
  if (!data || (data.accounts.length === 0 && !rangeApplied)) {
    return (
      <ReportEmptyState
        title="Inga verifikationer i perioden"
        description="Det finns inga bokförda verifikationer i den valda perioden."
      />
    )
  }

  const clearAccountRange = () => {
    setAccountFrom('')
    setAccountTo('')
    setApplied({ from: '', to: '' })
  }

  return (
    <div className="space-y-4">
      <ReportExportMenu items={[{ format: 'xlsx', href: `/api/reports/general-ledger/xlsx?${reportQuery(periodId, dateRange, dimensionFilter)}` }]} />
      {/* Account range filter: flat toolbar on the panel, no box. The labels
          are hidden (field-label) and the placeholders say what the fields are. */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="gl-account-from" className="field-label">Konto från</Label>
          <Input
            id="gl-account-from"
            type="text"
            value={accountFrom}
            onChange={(e) => setAccountFrom(e.target.value)}
            placeholder="Från konto"
            aria-label="Konto från"
            className="mt-1 w-32"
          />
        </div>
        <div>
          <Label htmlFor="gl-account-to" className="field-label">Konto till</Label>
          <Input
            id="gl-account-to"
            type="text"
            value={accountTo}
            onChange={(e) => setAccountTo(e.target.value)}
            placeholder="Till konto"
            aria-label="Konto till"
            className="mt-1 w-32"
          />
        </div>
        <Button onClick={applyAccountRange} variant="outline">
          Filtrera
        </Button>
      </div>

      {data.accounts.length === 0 && (
        <p className="px-1 py-3 text-[13px] text-muted-foreground">
          {t('no_accounts_in_range', { range: `${applied.from}-${applied.to}` })}{' '}
          <button type="button" className={QUIET_LINK_CLASS} onClick={clearAccountRange}>
            {t('clear_account_range')}
          </button>
        </p>
      )}
      {data.accounts.length > 0 && data.period.start && (
        <p className="text-sm text-muted-foreground tabular-nums">
          Period {data.period.start} till {data.period.end} · {data.accounts.length} konton
        </p>
      )}
      {data.accounts.length > 0 && !data.lines_included && (
        <p className="text-sm text-muted-foreground">
          {t('paged_hint', { count: data.accounts.reduce((sum, a) => sum + a.line_count, 0) })}
        </p>
      )}

      {data.accounts.map((account) => (
        <LedgerAccountCard
          key={`${scope}|${account.account_number}`}
          account={account}
          linesQuery={reportQuery(periodId, dateRange, dimensionFilter)}
          defaultOpen={singleAccount || data.accounts.length === 1}
        />
      ))}
    </div>
  )
}

function LedgerAccountCard({ account, linesQuery, defaultOpen }: { account: GeneralLedgerAccount; linesQuery: string; defaultOpen: boolean }) {
  const t = useTranslations('general_ledger')
  const [open, setOpen] = useState(defaultOpen)
  const [sort, setSort] = useState<LedgerRowSort>(LEDGER_ROW_ORDER)
  // The search box sits behind a magnifier, so a ledger of many accounts is
  // not a column of search boxes. The account the view is about (a
  // drill-down, one account in range) shows it at once.
  const [searchOpen, setSearchOpen] = useState(defaultOpen)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  // Debounced, and from two characters on, like the verifikat list's search:
  // one character matches almost every row.
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim()
      setSearch(trimmed.length >= 2 ? trimmed : '')
    }, 300)
    return () => clearTimeout(handle)
  }, [searchInput])

  const rowsShown = account.lines ? account.lines.length > 0 : open && account.line_count > 0
  const controls: LedgerRowControls = {
    sort,
    search,
    onSort: (column) => setSort((current) => nextLedgerRowSort(current, column)),
    onClearSearch: () => setSearchInput(''),
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {/* data-ph-mask: account number and name are user chart data */}
          <CardTitle data-ph-mask="" className="text-base">
            <AccountNumber number={account.account_number} name={account.account_name} showName />
          </CardTitle>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {rowsShown && (searchOpen ? (
              <ToolbarSearch
                autoFocus={!defaultOpen}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t('search_placeholder')}
                aria-label={t('search_rows', { account: account.account_number })}
                title={t('search_hint')}
                maxLength={200}
                containerClassName="w-60 max-w-full flex-none"
              />
            ) : (
              <Button
                variant="ghost"
                size="icon-toolbar"
                aria-label={t('search_rows', { account: account.account_number })}
                onClick={() => setSearchOpen(true)}
              >
                <MagnifyingGlassIcon className="h-4 w-4" />
              </Button>
            ))}
            <span className="text-sm text-muted-foreground">
              IB: {formatAmount(account.opening_balance)} kr
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {account.lines ? (
          <InlineLedgerLines account={account} lines={account.lines} controls={controls} />
        ) : open && account.line_count > 0 ? (
          <PagedLedgerLines account={account} linesQuery={linesQuery} controls={controls} />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            {account.line_count > 0 ? (
              <Button variant="outline" onClick={() => setOpen(true)}>
                {t('show_lines', { count: account.line_count })}
              </Button>
            ) : (
              <span className="text-muted-foreground">{t('no_lines')}</span>
            )}
            <span className="tabular-nums">{t('closing_balance', { amount: formatAmount(account.closing_balance) })}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** An account whose lines came with the overview: sorted and searched here, with the rule the lines route uses. */
function InlineLedgerLines({ account, lines, controls }: { account: GeneralLedgerAccount; lines: GeneralLedgerLine[]; controls: LedgerRowControls }) {
  const { sort, search } = controls
  const arranged = useMemo(() => arrangeLedgerRows(lines, { sort, search }), [lines, sort, search])
  return (
    <LedgerLinesTable
      account={account}
      lines={arranged.rows}
      controls={controls}
      found={arranged.matched && { ...arranged.matched, count: arranged.rows.length }}
    />
  )
}

/** One account's lines, a page at a time, behind its card in a large ledger. */
function PagedLedgerLines({ account, linesQuery, controls }: { account: GeneralLedgerAccount; linesQuery: string; controls: LedgerRowControls }) {
  const t = useTranslations('general_ledger')
  const tCommon = useTranslations('common')
  // Ledger order with no search is the route's plain page, continued by its
  // cursor. Any other order, or a search, is arranged by the route and
  // continued by offset.
  const params = new URLSearchParams({ account: account.account_number })
  if (controls.search || !isLedgerRowOrder(controls.sort)) {
    params.set('sort', ledgerRowSortToken(controls.sort))
    if (controls.search) params.set('search', controls.search)
  }
  const first = `/api/reports/general-ledger/lines?${linesQuery}&${params}`
  const { pages, loading, error, hasMore, loadMore, retry } = useReportPages<GeneralLedgerLinesPage>(
    first,
    t('lines_failed'),
    (page) => page.next
      ? `${first}&${new URLSearchParams({
          after_date: page.next.date,
          after_voucher: String(page.next.voucher_number),
          after_line: page.next.line_id,
        })}`
      : page.next_offset != null
        ? `${first}&${new URLSearchParams({ offset: String(page.next_offset) })}`
        : null,
  )
  const lines = pages.flatMap((page) => page.lines)
  // The same on every page of an arrangement: read it off the first.
  const total = pages[0]?.line_count ?? account.line_count
  const matched = pages[0]?.matched ?? null

  return (
    <>
      <LedgerLinesTable
        account={account}
        lines={lines}
        controls={controls}
        found={matched && { ...matched, count: total }}
        loading={loading}
      />
      {(loading || error || hasMore) && (
        <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
          {loading && <span>{t('loading_lines')}</span>}
          {error && (
            <>
              <span className="text-destructive">{error}</span>
              <Button variant="link" onClick={retry}>{tCommon('retry')}</Button>
            </>
          )}
          {hasMore && (
            <Button variant="outline" onClick={loadMore}>
              {t('load_more', { shown: lines.length, total })}
            </Button>
          )}
        </div>
      )}
    </>
  )
}

// The sortable heads keep this table's own cell rhythm instead of the list
// table's: no side padding, and the height of their 32px button, which is
// what the plain heads beside them come to.
const LEDGER_SORT_TH_CLASS = 'h-auto px-0'
// A head on the left ends in its sort arrow, flush with the edge of its
// cell, and the cells of this table have no side padding: on a phone, where
// every column is as narrow as its content, the arrow met the next head. It
// keeps 8px after the arrow. A head on the right starts with its button's
// own 8px, so only the plain balance head after the last arrow needs its own.
const LEDGER_SORT_TH_START_CLASS = 'h-auto pl-0 pr-2'

function LedgerLinesTable({ account, lines, controls, found, loading = false }: {
  account: GeneralLedgerAccount
  lines: GeneralLedgerLine[]
  controls: LedgerRowControls
  /** How many rows the search found, on all pages, and their sums; null without a search. */
  found: (LedgerSearchSums & { count: number }) | null
  /** The rows are still on their way: no "nothing matches" line yet. */
  loading?: boolean
}) {
  const t = useTranslations('general_ledger')
  const tCommon = useTranslations('common')
  const { sort, search, onSort, onClearSearch } = controls
  // The balance of a row is the account's balance after it in ledger order.
  // It reads as a running balance only in date order with every row there;
  // otherwise the column stays and its cells are empty.
  const balanceRuns = ledgerBalanceRuns(sort, search)
  const sortHead = (column: LedgerRowSortColumn) => ({
    direction: sort.column !== column ? null : sort.ascending ? ('asc' as const) : ('desc' as const),
    onSort: () => onSort(column),
  })
  return (
    <div className="overflow-x-auto -mx-2 px-2"><table className="w-full text-sm min-w-[500px]">
      <thead className="[&_th]:font-medium [&_th]:text-xs [&_th]:tracking-wider [&_th]:text-muted-foreground">
        <tr className="border-b text-left">
          <SortableTh label={t('th_voucher')} {...sortHead('voucher')} className={`${LEDGER_SORT_TH_START_CLASS} w-16`} />
          <SortableTh label={t('th_date')} {...sortHead('date')} className={`${LEDGER_SORT_TH_START_CLASS} w-24`} />
          <th className="py-2">{t('th_description')}</th>
          <SortableTh label={t('th_debit')} {...sortHead('debit')} align="right" className={`${LEDGER_SORT_TH_CLASS} w-24 text-right`} />
          <SortableTh label={t('th_credit')} {...sortHead('credit')} align="right" className={`${LEDGER_SORT_TH_CLASS} w-24 text-right`} />
          <th className="py-2 pl-2 w-28 text-right">
            {balanceRuns ? t('th_balance') : (
              <InfoTooltip content={t('balance_hidden_hint')} side="top" align="end">
                {t('th_balance')}
              </InfoTooltip>
            )}
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, i) => (
          <tr key={i} className="border-b last:border-0">
            <td className="py-1.5 font-mono text-xs">
              <Link
                href={`/bookkeeping/${line.journal_entry_id}`}
                className="text-foreground underline underline-offset-4 decoration-foreground/25 hover:decoration-foreground transition-colors"
              >
                {formatVoucher(line)}
              </Link>
            </td>
            <td className="py-1.5 date-figures">{formatDate(line.date)}</td>
            <td className="py-1.5 max-w-[240px]">
              <span className="truncate block">{line.description}</span>
              {line.dimensions && Object.keys(line.dimensions).length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Object.entries(line.dimensions)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([, code]) => code)
                    .join(' · ')}
                </span>
              )}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {line.debit > 0 ? formatAmount(line.debit) : ''}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {line.credit > 0 ? formatAmount(line.credit) : ''}
            </td>
            <td className="py-1.5 text-right tabular-nums">{balanceRuns ? formatAmount(line.balance) : ''}</td>
          </tr>
        ))}
        {found && found.count === 0 && !loading && (
          <tr>
            <td colSpan={6} className="py-3 text-muted-foreground">
              {t('no_matches')}{' '}
              <Button variant="link" onClick={onClearSearch}>{tCommon('clear_search')}</Button>
            </td>
          </tr>
        )}
      </tbody>
      <tfoot>
        {/* What the search found, named as that: the row under it stays the whole account. */}
        {found && found.count > 0 && (
          <tr className="border-t-2 text-muted-foreground">
            <td colSpan={3} className="py-2">{t('found_total', { count: found.count })}</td>
            <td className="py-2 text-right tabular-nums">{formatAmount(found.debit)}</td>
            <td className="py-2 text-right tabular-nums">{formatAmount(found.credit)}</td>
            <td className="py-2" />
          </tr>
        )}
        <tr className={found && found.count > 0 ? 'font-semibold border-t' : 'font-semibold border-t-2'}>
          <td colSpan={3} className="py-2">{search ? t('account_total_searched') : t('account_total')}</td>
          <td className="py-2 text-right tabular-nums">{formatAmount(account.total_debit)}</td>
          <td className="py-2 text-right tabular-nums">{formatAmount(account.total_credit)}</td>
          <td className="py-2 text-right tabular-nums">{formatAmount(account.closing_balance)}</td>
        </tr>
      </tfoot>
    </table></div>
  )
}
