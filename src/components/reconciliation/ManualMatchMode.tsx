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
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { SortableTh, TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { PAGE_BOTTOM_BAR_PROPS } from '@/components/ui/fab-clearance'
import { useToast } from '@/components/ui/use-toast'
import { chunk, cn, formatCurrency, formatDate, formatRowAmount } from '@/lib/utils'
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
 * right pane follows the left: with exactly ONE row picked it is
 * multi-select (one row settling several verifikat, the 1:N split of #1553;
 * on the skattekonto one event booked over several verifikat, crm#1183);
 * with several rows picked it is single-select (N rows settling one
 * verifikat). The footer sums both sides; Koppla is enabled only when the
 * selection nets to zero, because the engine links N rows to ONE verifikat,
 * ONE row to N verifikat with slices summing to the row, and (for the
 * skattekonto) refuses a group whose sum the verifikat does not settle. A
 * non-zero difference is shown, not hidden: for the N:1 shape the residual
 * can be booked in the same gesture; a split must close exactly.
 *
 * Skattekonto, non-zero difference: a summarised verifikat (one year-end or
 * month-end voucher that books more events than the ones picked) can never
 * close. A second button links the rows anyway and says what stays on the
 * verifikat: the engine keeps that remainder in this same right-hand list,
 * so nothing is hidden and unexplained does not move (crm#1043).
 *
 * With NO outside row picked on a SEK bank account the right pane is
 * multi-select too: two or more verifikat that take each other out (a wrong
 * verifikat and the rättelse booked by hand) are linked to each other and
 * leave the list together. Nothing is booked (crm#1074).
 */

interface ManualMatchModeProps {
  account: ReconciliationAccount
  window: ReconciliationWindow
  onChanged: () => void
}

const LIMIT = 200

/** Most rows one pair may carry (ReconciliationPairSchema). */
const MAX_ROWS_PER_PAIR = 50

/** A column's sort for SortableTh: its direction, or null when the table is sorted on another column. */
function sortDirection(sort: ReconSort, column: ReconSortColumn): ReconSort['direction'] | null {
  return sort.column === column ? sort.direction : null
}

export function ManualMatchMode({ account, window, onChanged }: ManualMatchModeProps) {
  const t = useTranslations('reconciliation')
  const tCommon = useTranslations('common')
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
  // Verifikat can be linked to each other where the engine can judge that
  // they net to zero: bank accounts kept in SEK (ledger-settlement.ts).
  const canSettleLedger = account.kind === 'bank' && currency === 'SEK'

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ date_from: window.from, date_to: window.to, limit: String(LIMIT) })
      // The left pane is every bank row still open, whether or not the
      // matcher has a proposal for it: the proposal is a suggestion, and
      // manual mode exists for the person who wants to decide otherwise.
      const [extRes, propRes, ledRes] = await Promise.all([
        fetch(`${base}/items?bucket=unmatched_external&${qs.toString()}`),
        fetch(`${base}/items?bucket=proposed&${qs.toString()}`),
        fetch(`${base}/items?bucket=unmatched_ledger&${qs.toString()}`),
      ])
      setLoadError(false)
      if (!extRes.ok || !propRes.ok || !ledRes.ok) {
        setLoadError(true)
        return
      }
      const ext = (await extRes.json()).data as { items: ReconciliationItem[] }
      const prop = (await propRes.json()).data as { items: ReconciliationItem[] }
      const led = (await ledRes.json()).data as { items: ReconciliationItem[] }
      const seen = new Set<string>()
      const open = [...ext.items, ...prop.items]
        .filter((i) => (seen.has(i.item_id) ? false : (seen.add(i.item_id), true)))
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      setExternal(open)
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
  // One outside row may settle several verifikat (on the skattekonto only
  // with their whole open amounts, crm#1183); several rows settle one. N:M
  // has no engine shape and the right pane never lets it be built.
  const splitMode = pickedExternal.size === 1
  // No outside row picked: several verifikat may be picked to settle each other.
  const ledgerOnlyMode = canSettleLedger && pickedExternal.size === 0
  const multiEntries = splitMode || ledgerOnlyMode
  const isSplit = entries.length > 1
  const settleMode = ledgerOnlyMode && entries.length >= 2
  const canSettle = settleMode && Math.abs(ledgerSum) < 0.005 && !busy
  const canLink =
    pickedExternal.size > 0 &&
    entries.length > 0 &&
    !(pickedExternal.size > 1 && isSplit) &&
    Math.abs(difference) < 0.005 &&
    !busy
  // What the verifikat would still hold beyond the picked rows (ledger sign).
  const remainder = roundOre(ledgerSum - externalSum)
  const canLinkWithRemainder =
    isSkv && pickedExternal.size > 0 && entry !== null && Math.abs(difference) >= 0.005 && !busy

  function toggleExternal(id: string) {
    setPickedExternal((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      // Leaving the one-row shape with several verifikat picked would build
      // an N:M selection: drop the verifikat side, the user re-picks one.
      // Back at no row at all, several verifikat are a selection of their own
      // where they can be linked to each other.
      if (next.size > 1 || (next.size === 0 && !canSettleLedger)) {
        setPickedEntries((picked) => (picked.size > 1 ? new Set() : picked))
      }
      return next
    })
  }

  // Skattekonto: a summarised verifikat takes every open row of the period,
  // so the left pane can be ticked in one gesture (crm#1043).
  const allExternalPicked = (external ?? []).length > 0 && pickedExternal.size === (external ?? []).length
  function toggleAllExternal() {
    const next = allExternalPicked ? new Set<string>() : new Set((external ?? []).map((i) => i.item_id))
    setPickedExternal(next)
    // Same rule as toggleExternal: several rows never keep several verifikat.
    if (next.size !== 1) setPickedEntries((picked) => (picked.size > 1 ? new Set() : picked))
  }

  function toggleEntry(id: string) {
    setPickedEntries((prev) => {
      if (!multiEntries) return prev.has(id) ? new Set() : new Set([id])
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * The pairs one click sends. A skattekonto selection against one verifikat
   * with a remainder, or with more rows than one pair may carry, goes as
   * pairs of at most 50 rows on that verifikat with allow_remainder: each
   * pair joins the rows linked before it, so the verifikat ends with exactly
   * what the footer showed (0 when the selection settles it).
   */
  function linkPairs(allowRemainder: boolean) {
    const externalIds = [...pickedExternal]
    if (isSkv && entry && (allowRemainder || externalIds.length > MAX_ROWS_PER_PAIR)) {
      return chunk(externalIds, MAX_ROWS_PER_PAIR).map((part) => ({
        external_ids: part,
        journal_entry_ids: [entry.item_id],
        allow_remainder: true,
      }))
    }
    return [{ external_ids: externalIds, journal_entry_ids: entries.map((e) => e.item_id) }]
  }

  async function link(allowRemainder = false) {
    if (entries.length === 0 || pickedExternal.size === 0) return
    setBusy(true)
    try {
      // The split sends no allocations: each slice defaults to the voucher's
      // bank line and the engine refuses the set unless the slices sum to
      // the row, which is exactly the difference-is-zero gate above.
      const res = await fetch(`${base}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs: linkPairs(allowRemainder) }),
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

  // Verifikat against each other, no outside row: the pair carries no
  // external_ids and the engine refuses anything that does not sum to zero.
  async function settle() {
    if (!settleMode) return
    setBusy(true)
    try {
      const res = await fetch(`${base}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairs: [{ external_ids: [], journal_entry_ids: entries.map((e) => e.item_id) }] }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: t('toast_failed'), description: getUserErrorMessage(json, { statusCode: res.status }), variant: 'destructive' })
        return
      }
      const settled = (json.data?.settled as unknown[] | undefined)?.length ?? 0
      const skipped = (json.data?.skipped as Array<{ message: string }> | undefined) ?? []
      if (settled === 0) {
        toast({ title: t('toast_failed'), description: skipped[0]?.message, variant: 'destructive' })
      } else {
        toast({ title: t('toast_settled', { count: entries.length }) })
      }
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

  // Nothing on screen yet: the load failure says so in place of the rows.
  if (loadError && (!external || !ledger)) {
    return <LoadError title={t('load_failed_title')} onRetry={() => void load()} />
  }
  if (!external || !ledger) {
    return (
      <LateReveal className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </LateReveal>
    )
  }

  return (
    <div className="space-y-4">
      {/* A failed refresh keeps the rows under one line. */}
      {loadError && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void load() }}>{tCommon('refresh_failed')}</AttnLine>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: outside rows, multi-select. */}
        <section aria-label={t(isSkv ? 'bucket_unmatched_external_skv' : 'bucket_unmatched_external_bank')}>
          <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
            {t(isSkv ? 'bucket_unmatched_external_skv' : 'bucket_unmatched_external_bank')}
            <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{external.length}</span>
          </h2>
          {external.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('match_empty_left')}</p>
          ) : (
            <div className="-mx-2 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-8 px-2')}>
                    {isSkv && (
                      <Checkbox
                        checked={allExternalPicked}
                        onCheckedChange={toggleAllExternal}
                        aria-label={t('match_select_all')}
                      />
                    )}
                  </th>
                  <SortableTh label={t('col_date')} direction={sortDirection(externalSort, 'date')} onSort={() => onExternalSort('date')} className="w-[96px]" />
                  <SortableTh label={t('col_event')} direction={sortDirection(externalSort, 'description')} onSort={() => onExternalSort('description')} />
                  <SortableTh label={t('col_amount')} direction={sortDirection(externalSort, 'amount')} onSort={() => onExternalSort('amount')} className="w-[120px] text-right" align="right" />
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {(sortedExternal ?? []).map((item) => {
                  const picked = pickedExternal.has(item.item_id)
                  return (
                    <tr
                      key={item.item_id}
                      onClick={() => toggleExternal(item.item_id)}
                      className={cn('cursor-pointer', picked ? 'bg-secondary/60' : 'hover:bg-secondary/35')}
                    >
                      <td className={cn(TD_CLASS, 'px-2')}>
                        <Checkbox
                          checked={picked}
                          onCheckedChange={() => toggleExternal(item.item_id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={item.description}
                        />
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures text-muted-foreground')}>{formatDate(item.date)}</td>
                      <td className={cn(TD_CLASS, 'max-w-0')}>
                        <span className="block truncate" data-ph-mask title={item.description}>{item.description}</span>
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
                        {formatRowAmount(item.amount, currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </section>

        {/* Right: verifikat without an outside row. Single-select for N:1,
            multi-select while exactly one bank row is picked (1:N). */}
        <section aria-label={t(isSkv ? 'bucket_unmatched_ledger_skv' : 'bucket_unmatched_ledger_bank')}>
          <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
            {t(isSkv ? 'bucket_unmatched_ledger_skv' : 'bucket_unmatched_ledger_bank')}
            <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{ledger.length}</span>
          </h2>
          {splitMode && ledger.length > 0 && (
            <p className="mb-2 text-xs text-muted-foreground">{t('match_pick_vouchers')}</p>
          )}
          {ledgerOnlyMode && ledger.length > 0 && (
            <p className="mb-2 text-xs text-muted-foreground">{t('match_pick_settle')}</p>
          )}
          {ledger.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('match_empty_right')}</p>
          ) : (
            <div className="-mx-2 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-8 px-2')} />
                  <SortableTh label={t('col_date')} direction={sortDirection(ledgerSort, 'date')} onSort={() => onLedgerSort('date')} className="w-[96px]" />
                  <SortableTh label={t('col_voucher')} direction={sortDirection(ledgerSort, 'voucher')} onSort={() => onLedgerSort('voucher')} className="w-[90px]" />
                  <SortableTh label={t('col_event')} direction={sortDirection(ledgerSort, 'description')} onSort={() => onLedgerSort('description')} />
                  <SortableTh label={t('col_amount')} direction={sortDirection(ledgerSort, 'amount')} onSort={() => onLedgerSort('amount')} className="w-[120px] text-right" align="right" />
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {(sortedLedger ?? []).map((item) => {
                  const picked = pickedEntries.has(item.item_id)
                  return (
                    <tr
                      key={item.item_id}
                      onClick={() => toggleEntry(item.item_id)}
                      className={cn('cursor-pointer', picked ? 'bg-secondary/60' : 'hover:bg-secondary/35')}
                    >
                      <td className={cn(TD_CLASS, 'px-2')}>
                        {multiEntries ? (
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
                      <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures text-muted-foreground')}>{formatDate(item.date)}</td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')} data-ph-mask>
                        {item.voucher_number != null
                          ? formatVoucher({ voucher_series: item.voucher_series, voucher_number: item.voucher_number })
                          : item.item_id.slice(0, 8)}
                      </td>
                      <td className={cn(TD_CLASS, 'max-w-0')}>
                        <span className="block truncate" data-ph-mask title={item.description}>{item.description}</span>
                        {item.partially_linked && (
                          <span className="block truncate text-xs text-muted-foreground" data-ph-mask>
                            {t('chip_remainder', {
                              total: formatRowAmount(item.partially_linked.entry_amount, currency),
                              count: item.partially_linked.linked_count,
                            })}
                          </span>
                        )}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')} data-ph-mask>
                        {/* A verifikat listed in kronor on a foreign account says so. */}
                        {item.currency === currency
                          ? formatRowAmount(item.amount, currency)
                          : formatCurrency(item.amount, item.currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </section>
      </div>

      {/* Footer: the arithmetic of the selection, and the one button. Sticks
          above the mobile bottom nav (--bottom-nav-h), not behind it. */}
      <div {...PAGE_BOTTOM_BAR_PROPS} className="sticky bottom-[var(--bottom-nav-h)] flex flex-wrap items-center gap-x-6 gap-y-2 border-t-hairline bg-background py-3 text-[13px]">
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
          className={cn(
            'tabular-nums',
            Math.abs(difference) >= 0.005 && ((pickedExternal.size > 0 && entries.length > 0) || settleMode)
              ? 'text-warning'
              : 'text-muted-foreground',
          )}
          data-ph-mask
        >
          {t('match_difference', { amount: formatCurrency(difference, currency) })}
        </span>
        {/* A split has no residual: the slices must sum to the row exactly
            (the engine refuses anything else), so the footer says so instead
            of offering a fee/interest booking against several verifikat. */}
        {Math.abs(difference) >= 0.005 && pickedExternal.size > 0 && isSplit && (
          <span className="text-xs text-muted-foreground">{t('match_hint_split')}</span>
        )}
        {Math.abs(difference) >= 0.005 && settleMode && (
          <span className="text-xs text-muted-foreground">{t('match_hint_settle')}</span>
        )}
        {Math.abs(difference) >= 0.005 && pickedExternal.size > 0 && entry && (
          isSkv ? (
            <span className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t('match_hint_remainder_skv')}</span>
              <Button
                variant="outline"
                onClick={() => void link(true)}
                disabled={!canLinkWithRemainder}
                aria-busy={busy}
              >
                {t('match_apply_remainder', { amount: formatCurrency(remainder, currency) })}
              </Button>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-2 text-xs">
              <label htmlFor="residual-kind" className="text-muted-foreground">{t('match_residual_label')}</label>
              <select
                id="residual-kind"
                value={residualKind}
                onChange={(e) => setResidualKind(e.target.value as ResidualKind | '')}
                className="h-8 rounded-lg px-2 text-xs bg-control shadow-raised"
              >
                <option value="">{t('match_residual_pick')}</option>
                {(difference < 0 ? ['bank_fee', 'interest_expense', 'rounding'] : ['interest_income', 'rounding']).map((k) => (
                  <option key={k} value={k}>{t(`residual_${k}`)}</option>
                ))}
              </select>
              <Button variant="outline" onClick={() => void bookResidual()} disabled={!residualKind || busy} aria-busy={busy}>
                {t('match_residual_apply', { amount: formatCurrency(Math.abs(difference), currency) })}
              </Button>
            </span>
          )
        )}
        <span className="ml-auto">
          {settleMode ? (
            <Button onClick={() => void settle()} disabled={!canSettle} aria-busy={busy}>
              {t('match_apply_settle', { count: entries.length })}
            </Button>
          ) : (
            <Button onClick={() => void link()} disabled={!canLink} aria-busy={busy}>
              {isSplit ? t('match_apply_split', { count: entries.length }) : t('match_apply', { count: pickedExternal.size })}
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
