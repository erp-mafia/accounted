'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_RECON_SORT,
  nextReconSort,
  sortReconciliationItems,
  type ReconSort,
  type ReconSortColumn,
} from '@/lib/reconciliation/item-sort'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import type { ReconciliationAccount, ReconciliationItem } from '@/lib/reconciliation/schemas'
import type { ReconciliationWindow } from './AccountOverview'
import type { ResidualKind } from '@/lib/reconciliation/residual'

/**
 * "Matcha manuellt": the two-pane worksheet from the approved design. Left:
 * outside rows with no verifikat (bank transactions or skattekonto rows),
 * multi-select. Right: verifikat on the account with no outside row. The
 * right pane follows the left: with exactly ONE bank row picked it is
 * multi-select (one row settling several verifikat, the 1:N split of #1553);
 * with several rows picked it is single-select (N rows settling one
 * verifikat). The footer sums both sides; Koppla is enabled only when the
 * selection nets to zero, because the engine links N rows to ONE verifikat,
 * ONE row to N verifikat with slices summing to the row, and (for the
 * skattekonto) refuses a group whose sum the verifikat does not settle. A
 * non-zero difference is shown, not hidden: for the N:1 shape the residual
 * can be booked in the same gesture; a split must close exactly.
 */

interface ManualMatchModeProps {
  account: ReconciliationAccount
  window: ReconciliationWindow
  onChanged: () => void
}

const LIMIT = 200

/**
 * Sortable header for the two match tables. Deliberately local: the matching
 * view is not on a shared list table (a selection in one table constrains the
 * other), so it borrows the idiom rather than a component.
 */
function SortTh({
  label,
  column,
  sort,
  onSort,
  className,
  align,
}: {
  label: string
  column: ReconSortColumn
  sort: ReconSort
  onSort: (column: ReconSortColumn) => void
  className?: string
  align?: 'right'
}) {
  const active = sort.column === column
  return (
    <th
      className={cn(TH_CLASS, className)}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex min-h-8 items-center gap-1 rounded-sm uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          align === 'right' && 'ml-auto justify-end',
        )}
      >
        {label}
        <span aria-hidden="true" className={cn('text-[9px]', !active && 'text-muted-foreground/60')}>
          {active ? (sort.direction === 'asc' ? '\u2191' : '\u2193') : '\u2195'}
        </span>
      </button>
    </th>
  )
}

export function ManualMatchMode({ account, window, onChanged }: ManualMatchModeProps) {
  const t = useTranslations('reconciliation')
  const { toast } = useToast()
  const [external, setExternal] = useState<ReconciliationItem[] | null>(null)
  const [ledger, setLedger] = useState<ReconciliationItem[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [pickedExternal, setPickedExternal] = useState<Set<string>>(new Set())
  const [pickedEntries, setPickedEntries] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [residualKind, setResidualKind] = useState<ResidualKind | ''>('')

  // One sort per table, not one shared: the two sides hold different rows and
  // the whole task is comparing them, so pinning both to the same order would
  // work against the person doing the matching.
  const [ledgerSort, setLedgerSort] = useState<ReconSort>(DEFAULT_RECON_SORT)
  const [externalSort, setExternalSort] = useState<ReconSort>(DEFAULT_RECON_SORT)
  const onLedgerSort = useCallback(
    (column: ReconSortColumn) => setLedgerSort((s) => nextReconSort(s, column)),
    [],
  )
  const onExternalSort = useCallback(
    (column: ReconSortColumn) => setExternalSort((s) => nextReconSort(s, column)),
    [],
  )

  // Sorted copies for rendering. Memoised so a re-render from selection state
  // does not resort on every checkbox click. Selection is keyed by item_id, so
  // reordering never disturbs what is picked.
  const sortedLedger = useMemo(
    () => (ledger ? sortReconciliationItems(ledger, ledgerSort) : null),
    [ledger, ledgerSort],
  )
  const sortedExternal = useMemo(
    () => (external ? sortReconciliationItems(external, externalSort) : null),
    [external, externalSort],
  )

  const base = `/api/reconciliation/accounts/${encodeURIComponent(account.account_key)}`
  const isSkv = account.kind === 'skattekonto'
  const currency = account.currency

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ date_from: window.from, date_to: window.to, limit: String(LIMIT) })
      const [extRes, ledRes] = await Promise.all([
        fetch(`${base}/items?bucket=unmatched_external&${qs.toString()}`),
        fetch(`${base}/items?bucket=unmatched_ledger&${qs.toString()}`),
      ])
      setLoadError(false)
      if (!extRes.ok || !ledRes.ok) {
        setLoadError(true)
        return
      }
      const ext = (await extRes.json()).data as { items: ReconciliationItem[] }
      const led = (await ledRes.json()).data as { items: ReconciliationItem[] }
      setExternal(ext.items)
      setLedger(led.items)
    } catch {
      setLoadError(true)
    }
  }, [base, window.from, window.to])

  useEffect(() => {
    void load()
  }, [load])

  const externalSum = useMemo(
    () => roundOre((external ?? []).filter((i) => pickedExternal.has(i.item_id)).reduce((s, i) => s + i.amount, 0)),
    [external, pickedExternal],
  )
  const entries = useMemo(
    () => (ledger ?? []).filter((i) => pickedEntries.has(i.item_id)),
    [ledger, pickedEntries],
  )
  const entry = entries.length === 1 ? entries[0] : null
  const ledgerSum = roundOre(entries.reduce((s, i) => s + i.amount, 0))
  const difference = roundOre(externalSum - ledgerSum)
  // One bank row may settle several verifikat; several rows settle one.
  // N:M has no engine shape and the right pane never lets it be built.
  const splitMode = !isSkv && pickedExternal.size === 1
  const isSplit = entries.length > 1
  const canLink =
    pickedExternal.size > 0 &&
    entries.length > 0 &&
    !(pickedExternal.size > 1 && isSplit) &&
    Math.abs(difference) < 0.005 &&
    !busy

  function toggleExternal(id: string) {
    setPickedExternal((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      // Leaving the one-row shape with several verifikat picked would build
      // an N:M selection: drop the verifikat side, the user re-picks one.
      if (next.size !== 1) {
        setPickedEntries((picked) => (picked.size > 1 ? new Set() : picked))
      }
      return next
    })
  }

  function toggleEntry(id: string) {
    setPickedEntries((prev) => {
      if (!splitMode) return prev.has(id) ? new Set() : new Set([id])
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function link() {
    if (entries.length === 0 || pickedExternal.size === 0) return
    setBusy(true)
    try {
      // The split sends no allocations: each slice defaults to the voucher's
      // bank line and the engine refuses the set unless the slices sum to
      // the row, which is exactly the difference-is-zero gate above.
      const res = await fetch(`${base}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairs: [{ external_ids: [...pickedExternal], journal_entry_ids: entries.map((e) => e.item_id) }],
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: t('toast_failed'), description: getUserErrorMessage(json, { statusCode: res.status }), variant: 'destructive' })
        return
      }
      const applied = (json.data?.applied as unknown[] | undefined)?.length ?? 0
      const skipped = (json.data?.skipped as Array<{ message: string }> | undefined) ?? []
      if (applied === 0 && skipped.length > 0) {
        toast({ title: t('toast_failed'), description: skipped[0].message, variant: 'destructive' })
      } else if (isSplit) {
        toast({ title: t('toast_split_matched', { count: applied }) })
      } else {
        toast({
          title: skipped.length > 0 ? t('toast_matched_skipped', { applied, skipped: skipped.length }) : t('toast_matched', { applied }),
        })
      }
      setPickedExternal(new Set())
      setPickedEntries(new Set())
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function bookResidual() {
    if (!entry || pickedExternal.size === 0 || !residualKind) return
    setBusy(true)
    try {
      const res = await fetch(`${base}/residual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ external_ids: [...pickedExternal], journal_entry_id: entry.item_id, kind: residualKind }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: t('toast_failed'), description: getUserErrorMessage(json, { statusCode: res.status }), variant: 'destructive' })
        return
      }
      toast({ title: t('toast_residual_booked', { amount: formatCurrency(Math.abs(Number(json.data?.residual_amount ?? 0)), currency) }) })
      setPickedExternal(new Set())
      setPickedEntries(new Set())
      setResidualKind('')
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return (
      <AttnLine action={{ label: t('older_show'), onClick: () => void load() }}>{t('load_failed')}</AttnLine>
    )
  }
  if (!external || !ledger) {
    return (
      <div className="grid gap-6 lg:grid-cols-2" aria-busy>
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left: outside rows, multi-select. */}
        <section aria-label={t(isSkv ? 'bucket_unmatched_external_skv' : 'bucket_unmatched_external_bank')}>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t(isSkv ? 'bucket_unmatched_external_skv' : 'bucket_unmatched_external_bank')}
            <span className="ml-1.5 font-normal tabular-nums text-muted-foreground/70">{external.length}</span>
          </h2>
          {external.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('match_empty_left')}</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-8 px-2')} />
                  <SortTh label={t('col_date')} column="date" sort={externalSort} onSort={onExternalSort} className="w-[96px]" />
                  <SortTh label={t('col_event')} column="description" sort={externalSort} onSort={onExternalSort} />
                  <SortTh label={t('col_amount')} column="amount" sort={externalSort} onSort={onExternalSort} className="w-[120px] text-right" align="right" />
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {(sortedExternal ?? []).map((item) => {
                  const picked = pickedExternal.has(item.item_id)
                  return (
                    <tr
                      key={item.item_id}
                      onClick={() => toggleExternal(item.item_id)}
                      className={cn('cursor-pointer', picked ? 'bg-secondary/60' : 'hover:bg-muted/40')}
                    >
                      <td className={cn(TD_CLASS, 'px-2')}>
                        <Checkbox
                          checked={picked}
                          onCheckedChange={() => toggleExternal(item.item_id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={item.description}
                        />
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>{formatDate(item.date)}</td>
                      <td className={cn(TD_CLASS, 'max-w-0')}>
                        <span className="block truncate" data-ph-mask title={item.description}>{item.description}</span>
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
                        {formatCurrency(item.amount, currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* Right: verifikat without an outside row. Single-select for N:1,
            multi-select while exactly one bank row is picked (1:N). */}
        <section aria-label={t(isSkv ? 'bucket_unmatched_ledger_skv' : 'bucket_unmatched_ledger_bank')}>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            {t(isSkv ? 'bucket_unmatched_ledger_skv' : 'bucket_unmatched_ledger_bank')}
            <span className="ml-1.5 font-normal tabular-nums text-muted-foreground/70">{ledger.length}</span>
          </h2>
          {splitMode && ledger.length > 0 && (
            <p className="mb-2 text-[12.5px] text-muted-foreground">{t('match_pick_vouchers')}</p>
          )}
          {ledger.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('match_empty_right')}</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-8 px-2')} />
                  <SortTh label={t('col_date')} column="date" sort={ledgerSort} onSort={onLedgerSort} className="w-[96px]" />
                  <SortTh label={t('col_voucher')} column="voucher" sort={ledgerSort} onSort={onLedgerSort} className="w-[90px]" />
                  <SortTh label={t('col_event')} column="description" sort={ledgerSort} onSort={onLedgerSort} />
                  <SortTh label={t('col_amount')} column="amount" sort={ledgerSort} onSort={onLedgerSort} className="w-[120px] text-right" align="right" />
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {(sortedLedger ?? []).map((item) => {
                  const picked = pickedEntries.has(item.item_id)
                  return (
                    <tr
                      key={item.item_id}
                      onClick={() => toggleEntry(item.item_id)}
                      className={cn('cursor-pointer', picked ? 'bg-secondary/60' : 'hover:bg-muted/40')}
                    >
                      <td className={cn(TD_CLASS, 'px-2')}>
                        {splitMode ? (
                          <Checkbox
                            checked={picked}
                            onCheckedChange={() => toggleEntry(item.item_id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={item.description}
                          />
                        ) : (
                          <input
                            type="radio"
                            name="manual-match-entry"
                            checked={picked}
                            onChange={() => toggleEntry(item.item_id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={item.description}
                            className="h-3.5 w-3.5 accent-foreground"
                          />
                        )}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>{formatDate(item.date)}</td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')} data-ph-mask>
                        {item.voucher_number != null
                          ? formatVoucher({ voucher_series: item.voucher_series, voucher_number: item.voucher_number })
                          : item.item_id.slice(0, 8)}
                      </td>
                      <td className={cn(TD_CLASS, 'max-w-0')}>
                        <span className="block truncate" data-ph-mask title={item.description}>{item.description}</span>
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
                        {formatCurrency(item.amount, currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Footer: the arithmetic of the selection, and the one button. */}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border bg-background py-3 text-[13px]">
        <span className="tabular-nums" data-ph-mask>
          {t('match_selected_external', { count: pickedExternal.size, amount: formatCurrency(externalSum, currency) })}
        </span>
        <span className="tabular-nums" data-ph-mask>
          {isSplit
            ? t('match_selected_entries', { count: entries.length, amount: formatCurrency(ledgerSum, currency) })
            : entry
              ? t('match_selected_entry', { amount: formatCurrency(ledgerSum, currency) })
              : t('match_no_entry')}
        </span>
        <span
          className={cn('tabular-nums', Math.abs(difference) >= 0.005 && pickedExternal.size > 0 && entries.length > 0 ? 'text-warning' : 'text-muted-foreground')}
          data-ph-mask
        >
          {t('match_difference', { amount: formatCurrency(difference, currency) })}
        </span>
        {/* A split has no residual: the slices must sum to the row exactly
            (the engine refuses anything else), so the footer says so instead
            of offering a fee/interest booking against several verifikat. */}
        {Math.abs(difference) >= 0.005 && pickedExternal.size > 0 && isSplit && (
          <span className="text-[12.5px] text-muted-foreground">{t('match_hint_split')}</span>
        )}
        {Math.abs(difference) >= 0.005 && pickedExternal.size > 0 && entry && (
          isSkv ? (
            <span className="text-[12.5px] text-muted-foreground">{t('match_hint_residual_skv')}</span>
          ) : (
            <span className="flex items-center gap-2 text-[12.5px]">
              <label htmlFor="residual-kind" className="text-muted-foreground">{t('match_residual_label')}</label>
              <select
                id="residual-kind"
                value={residualKind}
                onChange={(e) => setResidualKind(e.target.value as ResidualKind | '')}
                className="h-8 rounded-lg border border-border bg-background px-2 text-[12.5px]"
              >
                <option value="">{t('match_residual_pick')}</option>
                {(difference < 0 ? ['bank_fee', 'interest_expense', 'rounding'] : ['interest_income', 'rounding']).map((k) => (
                  <option key={k} value={k}>{t(`residual_${k}`)}</option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={() => void bookResidual()} disabled={!residualKind || busy} aria-busy={busy}>
                {t('match_residual_apply', { amount: formatCurrency(Math.abs(difference), currency) })}
              </Button>
            </span>
          )
        )}
        <span className="ml-auto">
          <Button size="sm" onClick={() => void link()} disabled={!canLink} aria-busy={busy}>
            {isSplit ? t('match_apply_split', { count: entries.length }) : t('match_apply', { count: pickedExternal.size })}
          </Button>
        </span>
      </div>
    </div>
  )
}
