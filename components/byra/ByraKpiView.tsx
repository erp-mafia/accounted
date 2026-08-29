'use client'

import { useMemo, useState, useTransition } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { ContextPicker } from '@/components/common/ContextPicker'
import { performCompanySwitch } from '@/lib/company/switch-client'
import type { MonthlyDataPoint } from '@/components/reports/IncomeExpenseChart'
import {
  KPI_PERIOD_PRESETS,
  type KpiPeriodPreset,
} from '@/lib/byra/kpi-aggregate'
import type { ByraKpiClientRow } from '@/lib/byra/kpi-overview'

// Recharts is heavy: defer the chart so the tiles and table render first
// (same pattern as components/reports/views/index.tsx).
const IncomeExpenseChart = dynamic(
  () => import('@/components/reports/IncomeExpenseChart').then((m) => m.IncomeExpenseChart),
  { ssr: false, loading: () => <Skeleton className="h-64 w-full" /> },
)

interface ByraKpiViewProps {
  preset: KpiPeriodPreset
  allClients: Array<{ companyId: string; name: string }>
  selectedIds: string[]
  rows: ByraKpiClientRow[]
  months: MonthlyDataPoint[]
}

type SortKey = 'name' | 'revenue' | 'result' | 'margin' | 'cash' | 'vatLiability' | 'unbookedCount'

const NUMERIC_SORT_KEYS: SortKey[] = [
  'revenue',
  'result',
  'margin',
  'cash',
  'vatLiability',
  'unbookedCount',
]

function formatMargin(margin: number | null): string {
  if (margin === null) return '-'
  return `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 }).format(margin)} %`
}

/**
 * The Nyckeltal surface (WL-16): period preset + company chips filter the
 * URL (the server page refetches), tiles and chart summarize the selection,
 * and the table ranks clients. Entering a client is the same WL-09 soft
 * switch as the client list.
 */
export default function ByraKpiView({
  preset,
  allClients,
  selectedIds,
  rows,
  months,
}: ByraKpiViewProps) {
  const t = useTranslations('byra')
  const tClients = useTranslations('clients')
  const { toast } = useToast()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'revenue',
    desc: true,
  })

  const hasExplicitFilter = searchParams.has('companies')
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString())
    mutate(params)
    const query = params.toString()
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    })
  }

  const handlePreset = (id: string) => {
    updateParams((params) => params.set('period', id))
  }

  /**
   * Chip semantics: no `companies` param = all clients. Clicking a chip in
   * the all state focuses on that client; further clicks toggle. An empty
   * or complete selection collapses back to the all state.
   */
  const handleToggleCompany = (companyId: string) => {
    updateParams((params) => {
      const next = hasExplicitFilter ? new Set(selectedIds) : new Set<string>()
      if (next.has(companyId)) next.delete(companyId)
      else next.add(companyId)
      if (next.size === 0 || next.size === allClients.length) {
        params.delete('companies')
      } else {
        params.set(
          'companies',
          allClients
            .filter((c) => next.has(c.companyId))
            .map((c) => c.companyId)
            .join(','),
        )
      }
    })
  }

  const handleAllCompanies = () => {
    updateParams((params) => params.delete('companies'))
  }

  const handleEnter = async (companyId: string) => {
    if (pendingId) return
    setPendingId(companyId)
    const result = await performCompanySwitch(companyId, { destination: '/' })
    if (result?.error) {
      setPendingId(null)
      toast({ title: tClients('enter_failed'), variant: 'destructive' })
    }
  }

  const handleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, desc: !prev.desc }
        : { key, desc: NUMERIC_SORT_KEYS.includes(key) },
    )
  }

  const sortedRows = useMemo(() => {
    const dir = sort.desc ? -1 : 1
    return [...rows].sort((a, b) => {
      if (sort.key === 'name') return dir * a.name.localeCompare(b.name, 'sv')
      const av = a[sort.key] ?? Number.NEGATIVE_INFINITY
      const bv = b[sort.key] ?? Number.NEGATIVE_INFINITY
      if (av !== bv) return dir * (av - bv)
      return a.name.localeCompare(b.name, 'sv')
    })
  }, [rows, sort])

  const okRows = rows.filter((r) => !r.failed)
  const failedCount = rows.length - okRows.length
  const totals = {
    revenue: okRows.reduce((sum, r) => sum + r.revenue, 0),
    result: okRows.reduce((sum, r) => sum + r.result, 0),
    cash: okRows.reduce((sum, r) => sum + r.cash, 0),
    attention: okRows.filter((r) => r.unbookedCount > 0 || r.inboxCount > 0).length,
  }

  const tiles = [
    { label: t('kpi_revenue'), value: formatCurrency(totals.revenue), negative: false },
    { label: t('kpi_result'), value: formatCurrency(totals.result), negative: totals.result < 0 },
    { label: t('kpi_cash'), value: formatCurrency(totals.cash), negative: totals.cash < 0 },
    { label: t('stats_attention'), value: String(totals.attention), negative: false },
  ]

  const presetItems = KPI_PERIOD_PRESETS.map((id) => ({
    id,
    label: t(`kpi_period_${id}`),
  }))

  const columns: Array<{ key: SortKey; label: string; numeric: boolean }> = [
    { key: 'name', label: tClients('col_company'), numeric: false },
    { key: 'revenue', label: t('kpi_revenue'), numeric: true },
    { key: 'result', label: t('kpi_result'), numeric: true },
    { key: 'margin', label: t('kpi_margin'), numeric: true },
    { key: 'cash', label: t('kpi_cash'), numeric: true },
    { key: 'vatLiability', label: t('kpi_vat'), numeric: true },
    { key: 'unbookedCount', label: tClients('col_unbooked'), numeric: true },
  ]

  const SortIcon = sort.desc ? ArrowDown : ArrowUp

  return (
    <div className={cn('space-y-8 transition-opacity duration-150', isPending && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleAllCompanies}
          aria-pressed={!hasExplicitFilter}
          className={cn(
            'rounded-full border px-3 py-[5px] text-[13px] transition-colors duration-150',
            !hasExplicitFilter
              ? 'border-foreground/20 bg-secondary text-foreground'
              : 'border-border text-muted-foreground hover:bg-secondary/60',
          )}
        >
          {t('kpi_filter_all')}
        </button>
        {allClients.map((client) => {
          const active = hasExplicitFilter && selectedSet.has(client.companyId)
          return (
            <button
              key={client.companyId}
              type="button"
              onClick={() => handleToggleCompany(client.companyId)}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-3 py-[5px] text-[13px] transition-colors duration-150',
                active
                  ? 'border-foreground/20 bg-secondary text-foreground'
                  : 'border-border text-muted-foreground hover:bg-secondary/60',
              )}
            >
              {client.name}
            </button>
          )
        })}
        <div className="ml-auto">
          <ContextPicker
            items={presetItems}
            value={preset}
            onChange={handlePreset}
            triggerLabel={t(`kpi_period_${preset}`)}
            ariaLabel={t('kpi_period_picker')}
          />
        </div>
      </div>

      {failedCount > 0 && (
        <AttnLine>{t('kpi_failed_notice', { count: failedCount })}</AttnLine>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-border p-4">
            <div className="text-xs text-muted-foreground">{tile.label}</div>
            <div
              className={cn(
                'mt-1 font-sans text-xl tabular-nums',
                tile.negative && 'text-destructive',
              )}
            >
              {tile.value}
            </div>
          </div>
        ))}
      </div>

      <IncomeExpenseChart months={months} />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={cn(TH_CLASS, col.numeric && 'text-right')}>
                  <button
                    type="button"
                    onClick={() => handleSort(col.key)}
                    className={cn(
                      'inline-flex items-center gap-1',
                      col.numeric && 'flex-row-reverse',
                    )}
                  >
                    {col.label}
                    {sort.key === col.key && <SortIcon className="h-3 w-3" />}
                  </button>
                </th>
              ))}
              <th className={TH_CLASS}>{tClients('col_next_deadline')}</th>
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {sortedRows.map((row) => (
              <tr
                key={row.companyId}
                onClick={() => void handleEnter(row.companyId)}
                className={cn(
                  'cursor-pointer transition-colors duration-150 hover:bg-secondary/35',
                  pendingId && pendingId !== row.companyId && 'opacity-50',
                )}
              >
                <td className={TD_CLASS}>
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{row.name}</span>
                    {row.orgNumber && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {row.orgNumber}
                      </span>
                    )}
                    {pendingId === row.companyId && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </span>
                </td>
                {row.failed ? (
                  <td className={cn(TD_CLASS, 'text-muted-foreground')} colSpan={6}>
                    {t('kpi_row_failed')}
                  </td>
                ) : (
                  <>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                      {formatCurrency(row.revenue)}
                    </td>
                    <td
                      className={cn(
                        TD_CLASS,
                        'text-right tabular-nums',
                        row.result < 0 && 'text-destructive',
                      )}
                    >
                      {formatCurrency(row.result)}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums text-muted-foreground')}>
                      {formatMargin(row.margin)}
                    </td>
                    <td
                      className={cn(
                        TD_CLASS,
                        'text-right tabular-nums',
                        row.cash < 0 && 'text-destructive',
                      )}
                    >
                      {formatCurrency(row.cash)}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums text-muted-foreground')}>
                      {formatCurrency(row.vatLiability)}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                      {row.unbookedCount > 0 ? (
                        row.unbookedCount
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                  </>
                )}
                <td className={TD_CLASS}>
                  {row.nextDeadline ? (
                    <span className="flex items-center gap-2">
                      {row.nextDeadline.urgency === 'overdue' && (
                        <Badge variant="destructive">{tClients('deadline_overdue')}</Badge>
                      )}
                      {row.nextDeadline.urgency === 'action_needed' && (
                        <Badge variant="warning">{tClients('deadline_action_needed')}</Badge>
                      )}
                      <span
                        className={cn(
                          'truncate',
                          row.nextDeadline.urgency === 'upcoming' && 'text-muted-foreground',
                        )}
                      >
                        {row.nextDeadline.title}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {formatDate(row.nextDeadline.dueDate)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
