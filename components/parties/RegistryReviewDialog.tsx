'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { ScbCandidate } from '@/lib/parties/scb/client'
import type { RegistryCandidatesResult } from '@/lib/parties/registry-search'
import type { RegisterRow } from '@/lib/parties/register'
import { formatOrgNumber } from '@/lib/utils'
import { regionName } from './SuggestionQueue'

/**
 * One list instead of one picker per row. For every suggestion without an
 * org number the server plans a query from the voucher text and asks SCB;
 * a row whose query matches exactly one active company is shown with that
 * company ticked, and the person approves the whole list at once. Zero or
 * several matches, and foreign companies, are listed underneath with the
 * per-row picker still available. Nothing is chosen without the click.
 *
 * SCB allows ten calls per ten seconds and one search is up to two calls,
 * so rows are asked one at a time with a pause between them; results appear
 * as they land and approval can start before the last row is in.
 */

/** Spacing between SCB rounds: two calls per search under ten per ten seconds. */
export const REVIEW_STEP_MS = 2200

export type ReviewOutcome =
  | { kind: 'match'; candidate: ScbCandidate; aiRead: RegistryCandidatesResult['aiRead'] }
  | { kind: 'choose'; count: number; aiRead: RegistryCandidatesResult['aiRead'] }
  | { kind: 'none'; aiRead: RegistryCandidatesResult['aiRead'] }
  | { kind: 'foreign'; name: string; country: string | null }
  | { kind: 'failed' }

export interface ReviewState {
  row: RegisterRow
  outcome: ReviewOutcome | null
  approved: boolean
  saved: 'pending' | 'saving' | 'done' | 'failed'
}

export function outcomeOf(result: RegistryCandidatesResult): ReviewOutcome {
  if (result.foreign && result.candidates.length === 0) return { kind: 'foreign', name: result.foreign.name, country: result.foreign.country ?? null }
  const active = result.candidates.filter((c) => c.active)
  if (!result.truncated && active.length === 1 && result.candidates.length === 1) return { kind: 'match', candidate: active[0]!, aiRead: result.aiRead }
  if (result.candidates.length === 0) return { kind: 'none', aiRead: result.aiRead }
  return { kind: 'choose', count: result.truncated ? result.total : result.candidates.length, aiRead: result.aiRead }
}

export function RegistryReviewDialog({
  open,
  rows,
  onOpenChange,
  onChoose,
  onApproved,
  delayMs = REVIEW_STEP_MS,
}: {
  open: boolean
  rows: RegisterRow[]
  onOpenChange: (open: boolean) => void
  /** Open the per-row picker for a row the list could not settle. */
  onChoose: (row: RegisterRow) => void
  /** Called once after the approved org numbers are saved. */
  onApproved: (saved: number, failed: number) => void
  delayMs?: number
}) {
  const t = useTranslations('parties')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const [states, setStates] = useState<ReviewState[]>([])
  const [searched, setSearched] = useState(0)
  const [saving, setSaving] = useState(false)
  const runId = useRef(0)

  // Ask SCB row by row while the dialog is open; a closed dialog stops the loop.
  useEffect(() => {
    if (!open) return
    const id = ++runId.current
    const initial: ReviewState[] = rows.map((row) => ({ row, outcome: null, approved: false, saved: 'pending' }))
    setStates(initial)
    setSearched(0)
    let cancelled = false
    void (async () => {
      for (let i = 0; i < rows.length; i += 1) {
        if (cancelled || runId.current !== id) return
        const row = rows[i]!
        let outcome: ReviewOutcome
        try {
          const res = await fetch(`/api/parties/${row.id}/enrich/candidates`)
          if (!res.ok) throw new Error(String(res.status))
          const json = (await res.json()) as { data: RegistryCandidatesResult }
          outcome = outcomeOf(json.data)
        } catch {
          outcome = { kind: 'failed' }
        }
        if (cancelled || runId.current !== id) return
        setStates((prev) => prev.map((s) => (s.row.id === row.id ? { ...s, outcome, approved: outcome.kind === 'match' } : s)))
        setSearched(i + 1)
        if (i < rows.length - 1) await new Promise((r) => setTimeout(r, delayMs))
      }
    })()
    return () => {
      cancelled = true
    }
    // rows is the snapshot the dialog was opened with; re-running on every
    // register reload would restart the SCB loop mid-way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, delayMs])

  const searching = open && searched < rows.length
  const matches = states.filter((s) => s.outcome?.kind === 'match')
  const others = states.filter((s) => s.outcome && s.outcome.kind !== 'match')
  const approvedCount = matches.filter((s) => s.approved && s.saved === 'pending').length

  async function approve() {
    const chosen = matches.filter((s) => s.approved && s.saved === 'pending')
    if (chosen.length === 0) return
    setSaving(true)
    let saved = 0
    let failed = 0
    for (let i = 0; i < chosen.length; i += 1) {
      const s = chosen[i]!
      const candidate = (s.outcome as Extract<ReviewOutcome, { kind: 'match' }>).candidate
      setStates((prev) => prev.map((x) => (x.row.id === s.row.id ? { ...x, saved: 'saving' } : x)))
      let ok = false
      try {
        const res = await fetch(`/api/parties/${s.row.id}/enrich`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgNumber: candidate.orgNumber }),
        })
        ok = res.ok
      } catch {
        ok = false
      }
      if (ok) saved += 1
      else failed += 1
      setStates((prev) => prev.map((x) => (x.row.id === s.row.id ? { ...x, saved: ok ? 'done' : 'failed' } : x)))
      if (i < chosen.length - 1) await new Promise((r) => setTimeout(r, delayMs / 2))
    }
    setSaving(false)
    onApproved(saved, failed)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!saving ? onOpenChange(o) : undefined)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('review_title')}</DialogTitle>
          <DialogDescription>{searching ? t('review_searching', { done: searched, total: rows.length }) : t('review_intro')}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-6 overflow-y-auto">
          {matches.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    <th className={`${TH_CLASS} w-8`} />
                    <th className={TH_CLASS}>{t('review_col_book')}</th>
                    <th className={TH_CLASS}>{t('review_col_match')}</th>
                    <th className={TH_CLASS} />
                  </tr>
                </thead>
                <tbody>
                  {matches.map((s) => {
                    const o = s.outcome as Extract<ReviewOutcome, { kind: 'match' }>
                    return (
                      <tr key={s.row.id}>
                        <td className={TD_CLASS}>
                          <Checkbox
                            checked={s.approved}
                            disabled={s.saved !== 'pending' || saving}
                            onCheckedChange={(v) => setStates((prev) => prev.map((x) => (x.row.id === s.row.id ? { ...x, approved: v === true } : x)))}
                            aria-label={s.row.displayName}
                          />
                        </td>
                        <td className={`${TD_CLASS} max-w-[16rem] truncate`} title={s.row.displayName}>
                          {s.row.displayName}
                          {o.aiRead ? <span className="block text-xs text-muted-foreground">{t('review_ai_read', { name: o.aiRead.name })}</span> : null}
                        </td>
                        <td className={TD_CLASS}>
                          <span className="font-medium">{o.candidate.name}</span>
                          <span className="block text-xs text-muted-foreground tabular-nums">
                            {[formatOrgNumber(o.candidate.orgNumber), o.candidate.city, o.candidate.industry].filter(Boolean).join(' · ')}
                          </span>
                        </td>
                        <td className={`${TD_CLASS} text-right`}>
                          {s.saved === 'done' ? <Badge variant="success">{t('review_saved')}</Badge> : s.saved === 'failed' ? <Badge variant="warning">{t('review_failed')}</Badge> : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {others.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('review_others')}</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {others.map((s) => {
                  const o = s.outcome!
                  return (
                    <li key={s.row.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate" title={s.row.displayName}>
                        {s.row.displayName}
                        {'aiRead' in o && o.aiRead ? <span className="block text-xs text-muted-foreground">{t('review_ai_read', { name: o.aiRead.name })}</span> : null}
                      </span>
                      <span className="text-muted-foreground">
                        {o.kind === 'foreign'
                          ? t('review_foreign', { place: o.country ? ` (${regionName(o.country, locale)})` : '' })
                          : o.kind === 'choose'
                            ? t('review_choose_n', { count: o.count })
                            : o.kind === 'failed'
                              ? t('registry_unavailable_title')
                              : t('review_none')}
                      </span>
                      {o.kind === 'choose' || o.kind === 'none' ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => onChoose(s.row)} disabled={saving}>
                          {t('review_choose')}
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          {!searching && matches.length === 0 && others.length === 0 ? <p className="text-sm text-muted-foreground">{t('review_empty')}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {tCommon('close')}
          </Button>
          <Button type="button" onClick={() => void approve()} disabled={saving || approvedCount === 0}>
            {saving ? t('review_approving') : t('review_approve', { count: approvedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
