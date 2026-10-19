'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { cn, formatDate } from '@/lib/utils'
import { formatVoucherGapRange } from '@/lib/bookkeeping/voucher-gap-label'

interface GapExplanation {
  id: string
  explanation: string
  user_id: string
  created_at: string
}

interface VoucherGap {
  series: string
  gap_start: number
  gap_end: number
  explanation: GapExplanation | null
}

/** Matches the CHECK constraint on voucher_gap_explanations.explanation. */
const EXPLANATION_MAX = 500
/** Above this the text is clamped to two lines behind "Visa mer". */
const CLAMP_THRESHOLD = 160

/** Stable row key: one gap per series and number range within a year. */
function gapKey(gap: VoucherGap): string {
  return `${gap.series}:${gap.gap_start}:${gap.gap_end}`
}

/** Identifies the period and series a gap list was loaded for. */
function scopeKeyOf(periodId: string | null, series: string | null): string {
  return `${periodId ?? ''}|${series ?? ''}`
}

/**
 * Holes in the voucher numbering of one räkenskapsår, above the verifikat
 * table. Every gap needs a documented reason (BFNAR 2013:2) and the bokslut
 * preflight refuses to run while one is missing, so this is where the
 * customer satisfies that requirement. Renders nothing when the series is
 * unbroken, so most companies never see it.
 *
 * Unexplained gaps collapse into one attn line (convention 6) whose Förklara
 * action opens the explain dialog; with several open gaps the dialog picks
 * between them and moves on to the next after each save. Explained gaps are
 * done work, so they leave the default view but stay one click away behind a
 * quiet "Förklarade luckor (N)" disclosure: the documentation must remain
 * findable, not just exist.
 *
 * Write-once by design: editing waits for a history trail.
 */
export default function VoucherGapNotice({
  periodId,
  series,
  refreshToken,
  onUnexplainedCountChange,
}: {
  /** Räkenskapsår to inspect; null renders nothing. */
  periodId: string | null
  /** Series filter from the list, null for every series. */
  series: string | null
  /** Bumped by the parent after a write so a new gap shows up. */
  refreshToken?: number
  /**
   * Reports how many unexplained gaps the attn line is showing, so the list
   * can give this line the page's single attn slot (convention 6). Reports 0
   * on unmount.
   */
  onUnexplainedCountChange?: (count: number) => void
}) {
  const t = useTranslations('journal_list')
  const { toast } = useToast()
  const role = useCompanyOptional()?.role ?? null
  // Mirrors the RLS insert policy (owner/admin), so the action is not offered
  // to someone whose save would be refused anyway.
  const canExplain = role === 'owner' || role === 'admin'

  // Gaps are kept with the scope they were loaded for and rendered only while
  // that scope is current: on a period or series switch the old rows vanish
  // at once instead of staying clickable until the new reply lands, so a
  // dialog can only ever open for a gap of the year it would be saved to.
  const scopeKey = scopeKeyOf(periodId, series)
  const [loaded, setLoaded] = useState<{ scopeKey: string; gaps: VoucherGap[] } | null>(null)
  const gaps = loaded && loaded.scopeKey === scopeKey ? loaded.gaps : []
  const unexplained = gaps.filter((gap) => !gap.explanation)
  const explained = gaps.filter((gap) => gap.explanation)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showExplained, setShowExplained] = useState(false)
  // The gap being explained, pinned to the räkenskapsår it was opened for: a
  // save must never attach an explanation to a year the list switched to
  // while the dialog was open.
  const [target, setTarget] = useState<{ gap: VoucherGap; periodId: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // Only the newest probe may write state: a slow earlier response for a
  // previous period or series must not paint its gaps over the current one.
  const fetchGenRef = useRef(0)

  /** Fetches the gaps of the current period and series; stale replies are dropped. */
  const load = useCallback(async () => {
    if (!periodId) return
    const gen = ++fetchGenRef.current
    const key = scopeKeyOf(periodId, series)
    const params = new URLSearchParams({ fiscal_period_id: periodId })
    if (series) params.set('voucher_series', series)
    try {
      const res = await fetch(`/api/bookkeeping/voucher-gaps?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (gen !== fetchGenRef.current) return
      setLoaded({ scopeKey: key, gaps: (json?.data?.gaps ?? []) as VoucherGap[] })
    } catch {
      // A failed probe hides the rows; the bokslut preflight is the
      // enforcement surface and reports its own failures.
      if (gen === fetchGenRef.current) setLoaded({ scopeKey: key, gaps: [] })
    }
  }, [periodId, series])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  // The parent hides its own attn line while this one shows; the callback is
  // read through a ref so a parent passing an inline function does not
  // re-run the effect on every render.
  const onCountRef = useRef(onUnexplainedCountChange)
  onCountRef.current = onUnexplainedCountChange
  const unexplainedCount = periodId ? unexplained.length : 0
  useEffect(() => {
    onCountRef.current?.(unexplainedCount)
  }, [unexplainedCount])
  useEffect(() => () => onCountRef.current?.(0), [])

  // A period or series switch invalidates the gap list the dialog was opened
  // from, so the dialog closes rather than saving against the new scope.
  useEffect(() => {
    setTarget(null)
  }, [periodId, series])

  /** Shows or hides the full explanation text of one row. */
  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** Opens the explain dialog on the first unexplained gap of the shown year. */
  const openDialog = () => {
    if (!periodId || unexplained.length === 0) return
    setTarget({ gap: unexplained[0], periodId })
    setDraft('')
  }

  /**
   * Switches the dialog to another unexplained gap of the same year. The
   * draft is kept: one reason often covers several gaps, and nothing is saved
   * until the user confirms it for the gap now shown.
   */
  const pickTarget = (key: string) => {
    const gap = unexplained.find((g) => gapKey(g) === key)
    if (gap && target) setTarget({ gap, periodId: target.periodId })
  }

  /** Saves the draft through the existing voucher-gaps route, then reloads. */
  const save = async () => {
    if (!target) return
    const explanation = draft.trim()
    if (!explanation) return
    setSaving(true)
    try {
      const res = await fetch('/api/bookkeeping/voucher-gaps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_period_id: target.periodId,
          voucher_series: target.gap.series,
          gap_start: target.gap.gap_start,
          gap_end: target.gap.gap_end,
          explanation,
        }),
      })
      if (res.status === 403) {
        toast({ title: t('gap_forbidden'), variant: 'destructive' })
        return
      }
      if (!res.ok) {
        toast({ title: t('gap_save_failed'), variant: 'destructive' })
        return
      }
      toast({ title: t('gap_saved') })
      // Several open gaps: move straight on to the next one with an empty
      // draft, so each gap gets its own deliberate explanation.
      const savedKey = gapKey(target.gap)
      const next = unexplained.find((g) => gapKey(g) !== savedKey)
      if (next) {
        setTarget({ gap: next, periodId: target.periodId })
        setDraft('')
      } else {
        setTarget(null)
      }
      await load()
    } catch {
      toast({ title: t('gap_save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (!periodId || gaps.length === 0) return null

  const joiner = t('gap_range_joiner')
  const targetRange = target ? formatVoucherGapRange(target.gap, joiner) : ''

  const explainedToggle =
    explained.length > 0 ? (
      <button
        type="button"
        className={cn(QUIET_LINK_CLASS, 'print:hidden')}
        aria-expanded={showExplained}
        onClick={() => setShowExplained((v) => !v)}
      >
        {showExplained
          ? t('gap_explained_hide')
          : t('gap_explained_toggle', { count: explained.length })}
      </button>
    ) : null

  return (
    <>
      <div className="px-1 pb-2">
        {unexplained.length > 0 ? (
          <AttnLine
            action={
              canExplain ? { label: t('gap_explain_action'), onClick: openDialog } : undefined
            }
            trailing={
              explainedToggle ? (
                <>
                  <span className="text-muted-foreground print:hidden"> · </span>
                  {explainedToggle}
                </>
              ) : undefined
            }
          >
            {t('gap_attn', { count: unexplained.length })}
          </AttnLine>
        ) : (
          <p className="text-[12.5px] leading-5">{explainedToggle}</p>
        )}
      </div>

      {showExplained && explained.length > 0 && (
        <div className="divide-y divide-border border-b border-border text-[13px] leading-5">
          {explained.map((gap) => {
            const key = gapKey(gap)
            const range = formatVoucherGapRange(gap, joiner)
            const text = gap.explanation?.explanation ?? ''
            const clampable = text.length > CLAMP_THRESHOLD
            const isExpanded = expanded.has(key)
            return (
              <div
                key={key}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t('gap_title', { series: gap.series, range })}</p>
                  <p className={cn('text-muted-foreground', clampable && !isExpanded && 'line-clamp-2')}>
                    {text}
                  </p>
                  {clampable && (
                    <button type="button" className={QUIET_LINK_CLASS} onClick={() => toggleExpanded(key)}>
                      {isExpanded ? t('gap_show_less') : t('gap_show_more')}
                    </button>
                  )}
                </div>
                {gap.explanation && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t('gap_explained_on', { date: formatDate(gap.explanation.created_at) })}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('gap_dialog_title', { range: targetRange })}</DialogTitle>
            <DialogDescription>{t('gap_dialog_hint')}</DialogDescription>
          </DialogHeader>
          {target && unexplained.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="voucher-gap-pick">{t('gap_dialog_pick_label')}</Label>
              <Select value={gapKey(target.gap)} onValueChange={pickTarget} disabled={saving}>
                <SelectTrigger id="voucher-gap-pick">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {unexplained.map((gap) => (
                    <SelectItem key={gapKey(gap)} value={gapKey(gap)}>
                      {t('gap_title', { series: gap.series, range: formatVoucherGapRange(gap, joiner) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, EXPLANATION_MAX))}
            maxLength={EXPLANATION_MAX}
            placeholder={t('gap_dialog_placeholder')}
            aria-label={t('gap_dialog_title', { range: targetRange })}
            autoFocus
          />
          <p className="text-xs tabular-nums text-muted-foreground">
            {t('gap_dialog_counter', { count: draft.length, max: EXPLANATION_MAX })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={saving}>
              {t('gap_cancel')}
            </Button>
            <Button onClick={save} loading={saving} disabled={draft.trim().length === 0}>
              {t('gap_save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
