'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { formatCurrency } from '@/lib/utils'
import { useAccounts, useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { VerdictList, type Verdict } from './Verdicts'
import type { BooksCtx } from '../context'

type VatPick = 'standard_25' | 'reduced_12' | 'reduced_6' | 'exempt'
const VAT_PICKS: { key: VatPick; label: string }[] = [
  { key: 'standard_25', label: '25 %' },
  { key: 'reduced_12', label: '12 %' },
  { key: 'reduced_6', label: '6 %' },
  { key: 'exempt', label: 'Momsfri' },
]

/**
 * Genomlysningen as a panel, not a step: what the books say, as verdict
 * lines under the theater once the import lands. Two things happen here
 * that the old wizard asked for up front: imported years that ended before
 * the latest one are klarmarkerade (reversible), and revenue accounts the
 * import brought in without a momskod can get one now, or later in the chart.
 *
 * `summary` (under the theater after an import, founder direction
 * 2026-09-14): one line with the headline numbers and how many things want
 * a look, plus "Visa importresultat", which opens the full verdict list and
 * the momskod picker in a dialog. The page stays short enough that the door
 * onward is visible without scrolling. The standalone insight step keeps
 * the full list.
 */
export function InsightPanel({ ctx, base = 200, summary = false }: { ctx: BooksCtx; base?: number; summary?: boolean }) {
  const t = useTranslations('books')
  const { state, findings, loadingFindings, loadFindings } = ctx
  const { periods, refresh: refreshPeriods } = useFiscalPeriods()
  const { accounts, refresh: refreshAccounts } = useAccounts(true)
  const [vatOpen, setVatOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [vatSet, setVatSet] = useState<Record<string, VatPick>>({})
  const [closedNames, setClosedNames] = useState<string[]>([])
  const closeRan = useRef(false)

  useEffect(() => {
    if (closeRan.current || state.path !== 'migration' || !state.imported || periods.length < 2) return
    closeRan.current = true
    const today = new Date().toISOString().slice(0, 10)
    const sorted = [...periods].sort((a, b) => a.period_start.localeCompare(b.period_start))
    const latest = sorted[sorted.length - 1]
    const targets = sorted.filter((p) => p.id !== latest.id && p.period_end < today && !p.is_closed && !p.closed_externally && !p.locked_at)
    if (targets.length === 0) return
    void (async () => {
      const done: string[] = []
      for (const p of targets) {
        try {
          const res = await fetch(`/api/bookkeeping/fiscal-periods/${p.id}/close-external`, { method: 'POST' })
          if (res.ok) done.push(p.name)
        } catch {
          // A year that refuses to close stays open; the verdict says so.
        }
      }
      if (done.length) {
        setClosedNames(done)
        void refreshPeriods()
        void invalidateReferenceData('ref:fiscal-periods')
        void loadFindings()
      }
    })()
  }, [state.path, state.imported, periods, refreshPeriods, loadFindings])

  const vatGaps = useMemo(() => {
    if (state.importedAccounts.length === 0) return []
    const imported = new Set(state.importedAccounts)
    return accounts
      .filter((a) => a.account_number.startsWith('3') && imported.has(a.account_number) && !a.default_vat_treatment && !vatSet[a.account_number])
      .sort((a, b) => a.account_number.localeCompare(b.account_number))
  }, [accounts, state.importedAccounts, vatSet])

  async function pickVat(number: string, key: VatPick) {
    setVatSet((prev) => ({ ...prev, [number]: key }))
    try {
      const res = await fetch(`/api/bookkeeping/accounts/${number}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_vat_treatment: key }),
      })
      if (!res.ok) throw new Error('vat')
      void refreshAccounts()
      void invalidateReferenceData('ref:accounts')
    } catch {
      setVatSet((prev) => {
        const next = { ...prev }
        delete next[number]
        return next
      })
    }
  }

  const verdicts = useMemo<Verdict[]>(() => {
    if (!findings) return []
    const b = findings.books
    const out: Verdict[] = []
    out.push({ tone: b.entries > 0 ? 'ok' : 'warn', text: t('v_entries', { count: b.entries, years: b.periods.length }) })
    const broken = b.periods.filter((p) => p.continuityVerified === false)
    if (broken.length > 0) out.push({ tone: 'warn', text: t('v_continuity_broken', { name: broken[0].name }), href: '/bookkeeping' })
    else if (b.periods.some((p) => p.continuityVerified === true)) out.push({ tone: 'ok', text: t('v_continuity_ok') })
    if (closedNames.length > 0) {
      out.push({ tone: 'ok', text: t('v_closed_years', { years: closedNames.join(closedNames.length === 2 ? ` ${t('and')} ` : ', ') }) })
    }
    if (b.revenue !== null && b.result !== null && b.periodName) {
      out.push({ tone: 'ok', text: t('v_result', { period: b.periodName, revenue: formatCurrency(b.revenue), result: formatCurrency(b.result) }) })
    }
    if (state.importedAccounts.length > 0) {
      out.push(vatGaps.length > 0 ? { tone: 'warn', text: t('v_vat_gaps', { count: vatGaps.length }) } : { tone: 'ok', text: t('v_vat_all') })
    }
    if (b.overdueInvoices > 0) out.push({ tone: 'warn', text: t('v_overdue', { count: b.overdueInvoices }), href: '/invoices?status=overdue' })
    if (b.vatBalance !== null && Math.abs(b.vatBalance) >= 1) {
      out.push({
        tone: 'info',
        text: b.vatBalance > 0 ? t('v_vat_owed', { amount: formatCurrency(b.vatBalance) }) : t('v_vat_receivable', { amount: formatCurrency(-b.vatBalance) }),
        href: '/reports/vat',
      })
    }
    if (b.uncategorizedTransactions > 0) out.push({ tone: 'warn', text: t('v_uncategorized', { count: b.uncategorizedTransactions }), href: '/transactions' })
    return out
  }, [findings, closedNames, vatGaps.length, state.importedAccounts.length, t])

  const vatSection = vatGaps.length > 0 ? (
        <div className="vatwrap">
          {!vatOpen ? (
            <>
              <button type="button" className="imp-change" style={{ margin: '0 6px 0 0' }} onClick={() => setVatOpen(true)}>
                {t('vat_set_now')}
              </button>
              {t('vat_or_later')}
            </>
          ) : (
            <ul className="vat">
              {vatGaps.map((a) => (
                <li key={a.account_number}>
                  <span className="acc">
                    {a.account_number}
                    <span>{a.account_name}</span>
                  </span>
                  {VAT_PICKS.map((p) => (
                    <button key={p.key} type="button" className="vpick" onClick={() => void pickVat(a.account_number, p.key)}>
                      {p.label}
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null

  if (summary) {
    const b = findings?.books
    const attention = verdicts.filter((v) => v.tone !== 'ok').length
    const headline = b
      ? [
          t('v_entries', { count: b.entries, years: b.periods.length }),
          b.revenue !== null && b.result !== null && b.periodName
            ? t('v_result', { period: b.periodName, revenue: formatCurrency(b.revenue), result: formatCurrency(b.result) })
            : null,
        ].filter(Boolean).join(' · ')
      : null
    return (
      <div className="insight-summary">
        {loadingFindings && !findings ? (
          <VerdictList verdicts={[]} loading base={base} />
        ) : (
          <>
            <p className="insight-headline">{headline}</p>
            <p className="insight-meta">
              {attention > 0 ? <span className="insight-attn">{t('insight_attention', { count: attention })}</span> : null}
              <button type="button" className="jny-btn-quiet" onClick={() => setDetailsOpen(true)}>
                {t('insight_show')}
              </button>
            </p>
          </>
        )}
        <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
          <DialogContent className="bks-host sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{t('insight_dialog_title')}</DialogTitle>
            </DialogHeader>
            <VerdictList verdicts={verdicts} loading={loadingFindings && !findings} base={0} />
            {vatSection}
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  return (
    <>
      <VerdictList verdicts={verdicts} loading={loadingFindings && !findings} base={base} />
      {vatSection}
    </>
  )
}
