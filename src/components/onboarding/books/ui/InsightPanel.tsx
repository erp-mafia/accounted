'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { formatCurrency } from '@/lib/utils'
import { yearsOfBooks } from '@/lib/onboarding/books-years'
import { useAccounts } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CloseImportedYearsOffer } from '@/components/import/CloseImportedYearsOffer'
import { VerdictList, type Verdict } from './Verdicts'
import { CHANGE_LINK_CLASS } from './Sentence'
import type { BooksCtx } from '../context'
import { Button } from '@/components/ui/button'

type VatPick = 'standard_25' | 'reduced_12' | 'reduced_6' | 'exempt'
const VAT_PICKS: { key: VatPick; label: string }[] = [
  { key: 'standard_25', label: '25 %' },
  { key: 'reduced_12', label: '12 %' },
  { key: 'reduced_6', label: '6 %' },
  { key: 'exempt', label: 'Momsfri' },
]

/**
 * Genomlysningen as a panel, not a step: what the books say, as verdict
 * lines under the theater once the import lands. Revenue accounts the
 * import brought in without a momskod can get one now, or later in the chart.
 * Imported years that ended before the latest one are NOT klarmarkerade
 * here: a closed year refuses further underlag linking (the period-lock
 * triggers), so closing is offered as an explicit step the user takes once
 * the old system's underlag are linked (product decision on crm#104).
 *
 * `summary` (under the theater after an import, product direction
 * 2026-09-14): one line with the headline numbers and how many things want
 * a look, plus "Visa importresultat", which opens the full verdict list and
 * the momskod picker in a dialog. The page stays short enough that the door
 * onward is visible without scrolling. The standalone insight step keeps
 * the full list.
 */
export function InsightPanel({ ctx, base = 200, summary = false }: { ctx: BooksCtx; base?: number; summary?: boolean }) {
  const t = useTranslations('books')
  const { state, findings, loadingFindings, loadFindings } = ctx
  const { accounts, refresh: refreshAccounts } = useAccounts(true)
  const [vatOpen, setVatOpen] = useState(false)
  // The rows the picker opened with. A picked row stays where it is and shows
  // its momskod: dropping it at once slid the next account's identical
  // button under the pointer, so a quick second click gave that account the
  // same code too.
  const [vatRows, setVatRows] = useState<string[]>([])
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [vatSet, setVatSet] = useState<Record<string, VatPick>>({})
  const [vatSaving, setVatSaving] = useState<Record<string, true>>({})
  const [vatFailed, setVatFailed] = useState<string | null>(null)
  const vatGaps = useMemo(() => {
    if (state.importedAccounts.length === 0) return []
    const imported = new Set(state.importedAccounts)
    return accounts
      .filter((a) => a.account_number.startsWith('3') && imported.has(a.account_number) && !a.default_vat_treatment && !vatSet[a.account_number])
      .sort((a, b) => a.account_number.localeCompare(b.account_number))
  }, [accounts, state.importedAccounts, vatSet])
  const accountByNumber = useMemo(() => new Map(accounts.map((a) => [a.account_number, a])), [accounts])

  function openVat() {
    setVatRows(vatGaps.map((a) => a.account_number))
    setVatOpen(true)
  }

  async function pickVat(number: string, key: VatPick) {
    // One save per row at a time, and the code a row already has is not
    // sent again: a double-click stays on the row it landed on.
    if (vatSaving[number] || vatSet[number] === key) return
    const previous = vatSet[number]
    setVatSet((prev) => ({ ...prev, [number]: key }))
    setVatSaving((prev) => ({ ...prev, [number]: true }))
    setVatFailed(null)
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
        if (previous) next[number] = previous
        else delete next[number]
        return next
      })
      setVatFailed(number)
    } finally {
      setVatSaving((prev) => {
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
    out.push({ tone: b.entries > 0 ? 'ok' : 'warn', text: t('v_entries', { count: b.entries, years: yearsOfBooks(b) }) })
    const broken = b.periods.filter((p) => p.continuityVerified === false)
    if (broken.length > 0) out.push({ tone: 'warn', text: t('v_continuity_broken', { name: broken[0].name }), href: '/bookkeeping' })
    else if (b.periods.some((p) => p.continuityVerified === true)) out.push({ tone: 'ok', text: t('v_continuity_ok') })
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
  }, [findings, vatGaps.length, state.importedAccounts.length, t])

  const vatSection = vatGaps.length > 0 || (vatOpen && vatRows.length > 0) ? (
        <div className="vatwrap">
          {!vatOpen ? (
            <>
              <Button variant="link" className={CHANGE_LINK_CLASS} style={{ margin: '0 6px 0 0' }} onClick={openVat}>
                {t('vat_set_now')}
              </Button>
              {t('vat_or_later')}
            </>
          ) : (
            <>
              <ul className="vat">
                {vatRows.map((number) => {
                  const account = accountByNumber.get(number)
                  const chosen = vatSet[number] ?? account?.default_vat_treatment ?? null
                  return (
                    <li key={number} aria-busy={vatSaving[number] ? true : undefined}>
                      <span className="acc">
                        {number}
                        <span>{account?.account_name}</span>
                      </span>
                      {VAT_PICKS.map((p) => (
                        <button
                          key={p.key}
                          type="button"
                          className={`vpick${chosen === p.key ? ' is-sel' : ''}`}
                          aria-pressed={chosen === p.key}
                          onClick={() => void pickVat(number, p.key)}
                        >
                          {p.label}
                        </button>
                      ))}
                    </li>
                  )
                })}
              </ul>
              {vatFailed ? <p className="mt-2 text-destructive" role="alert">{t('vat_pick_failed', { account: vatFailed })}</p> : null}
            </>
          )}
        </div>
      ) : null

  // Renders nothing unless an earlier imported year is still open.
  const closeOffer = <CloseImportedYearsOffer showUnderlagLink onClosed={() => void loadFindings()} />

  if (summary) {
    const b = findings?.books
    const attention = verdicts.filter((v) => v.tone !== 'ok').length
    const headline = b
      ? [
          t('v_entries', { count: b.entries, years: yearsOfBooks(b) }),
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
              <Button variant="ghost" className="text-muted-foreground" onClick={() => setDetailsOpen(true)}>
                {t('insight_show')}
              </Button>
            </p>
          </>
        )}
        <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
          <DialogContent size="form" className="bks-host">
            <DialogHeader>
              <DialogTitle>{t('insight_dialog_title')}</DialogTitle>
            </DialogHeader>
            <VerdictList verdicts={verdicts} loading={loadingFindings && !findings} base={0} />
            {vatSection}
            {closeOffer}
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  return (
    <>
      <VerdictList verdicts={verdicts} loading={loadingFindings && !findings} base={base} />
      {vatSection}
      {closeOffer}
    </>
  )
}
