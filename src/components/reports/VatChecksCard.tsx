'use client'

import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { ContextPicker } from '@/components/common/ContextPicker'
import {
  DataList,
  DataListRow,
} from '@/components/ui/data-list'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  ShieldExclamationIcon,
  SpinnerIcon,
} from '@/components/icons'
import type { VatDeclarationCheck } from '@/lib/reports/vat-declaration-checks'
import type { RcBasisGap } from '@/lib/reports/rc-basis-gaps'
import type { RcBasisGapWithDefault } from '@/lib/vat/rc-basis-supplier-default'
import {
  coerceSupplyType,
  rcGapClassification,
  type RcGapClassification,
  type RcSupplierType,
  type RcSupplyType,
} from '@/lib/vat/rc-basis-gap-classification'
import {
  isReviewableVatCheck,
  unreviewedVatChecks,
  vatCheckFingerprint,
  type VatCheckReviewInputs,
} from '@/lib/vat/check-reviews'
import type { VatPeriodType } from '@/types'
import { formatAmount, formatDate } from '@/lib/utils'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

type SupplierType = RcSupplierType
type SupplyType = RcSupplyType
type GapClassification = RcGapClassification

const SUPPLIER_LABELS: Record<SupplierType, string> = {
  eu_business: 'EU-leverantör',
  non_eu_business: 'Utanför EU',
  swedish_business: 'Svensk omvänd skattskyldighet',
}
const SUPPLY_LABELS: Record<SupplyType, string> = {
  service: 'tjänst',
  goods: 'vara',
}
/** Chip labels (sentence case); SUPPLY_LABELS stays lowercase for dialog prose. */
const SUPPLY_DISPLAY: Record<SupplyType, string> = {
  service: 'Tjänst',
  goods: 'Vara',
}

const SUPPLIER_ITEMS = [
  { id: 'eu_business', label: 'EU-leverantör' },
  { id: 'non_eu_business', label: 'Utanför EU' },
  { id: 'swedish_business', label: 'Svensk omvänd skattskyldighet' },
]

// Non-EU + goods is import VAT (ruta 50/60-62), not reverse charge: the
// goods choice disappears entirely for non-EU suppliers.
const supplyItemsFor = (supplierType: SupplierType | null) =>
  supplierType === 'non_eu_business'
    ? [{ id: 'service', label: 'Tjänst' }]
    : [
        { id: 'service', label: 'Tjänst' },
        { id: 'goods', label: 'Vara' },
      ]

/** How many verifikat render before the "Visa alla" toggle. */
const GAP_PREVIEW_COUNT = 5

/**
 * A worklist row is one momssats of a verifikat: its expansion and its
 * classification are its own (EU goods at 12 % and an EU service at 25 % on
 * one verifikat land in different rutor), while one korrigering covers every
 * row of the verifikat.
 */
const rowKey = (gap: RcBasisGap) => `${gap.entryId}:${gap.rcOutputAccount}`

/**
 * "Kontroll av underlaget": the local pre-flight checks for the
 * momsdeklaration plus the per-voucher RC-basis-gap worklist with single and
 * bulk Korrigera. Hoisted out of SkatteverketPanel so EVERY user sees it,
 * paying or not, connected or not: manual filers are exactly the users who
 * must not file a declaration these checks would have blocked.
 *
 * A WARNING can be marked reviewed for the period (crm#1171,
 * lib/vat/check-reviews.ts): it then renders muted with who and when, and
 * stops counting. It comes back when its figures change. An ERROR has no such
 * action. When the RC basis gaps are advisory (`rcBasisAdvisory`: the period
 * matches per momssats) the worklist offers no Korrigera: the basis is
 * already booked in another verifikat and would be counted twice.
 */
export function VatChecksCard({
  checks,
  periodType,
  year,
  period,
  fiscalPeriodId,
  onCorrected,
  reviewInputs = null,
  rcBasisAdvisory = false,
  onReviewsChanged,
}: {
  checks: VatDeclarationCheck[]
  periodType: VatPeriodType
  year: number
  period: number
  fiscalPeriodId?: string
  onCorrected: () => void
  /** What the period's findings were computed from; null while the gap scan is pending. */
  reviewInputs?: VatCheckReviewInputs | null
  rcBasisAdvisory?: boolean
  onReviewsChanged?: () => void
}) {
  const router = useRouter()
  const t = useTranslations('reports')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { dialogProps, confirm } = useDestructiveConfirm()

  const hasRcBasisGaps = checks.some((c) => c.code === 'RC_BASIS_MISSING')

  // Gap fetch tagged with the key it was requested under: loading is derived
  // by comparing tags, so the effect never sets state synchronously. Fixed
  // rows are removed via removedIds (the fetch itself is not re-run after a
  // korrigering: the period key is unchanged). The key is period-only so the
  // list survives the declaration refetch that follows each korrigering, and
  // survives a remount even when the aggregate check no longer fires.
  const gapsKey = `${periodType}:${year}:${period}:${fiscalPeriodId ?? ''}`
  const [gapsResult, setGapsResult] = useState<{
    key: string
    gaps: RcBasisGapWithDefault[]
    failed?: boolean
  } | null>(null)
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // The toolbar's classification: its supply type applies to every row
  // without its own, its supplier type to every row without its own and
  // without one preselected from the supplier's country. It starts empty:
  // a row nothing is known about is asked, never guessed as EU (crm#1431).
  const [sharedSel, setSharedSel] = useState<GapClassification>({
    supplierType: null,
    supplyType: 'service',
  })
  const [overrides, setOverrides] = useState<Record<string, GapClassification>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  // The finding whose review note is open, its draft note, and the code a
  // mark or undo is in flight for.
  const [reviewingCode, setReviewingCode] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  const [reviewBusy, setReviewBusy] = useState<string | null>(null)

  // Render-phase adjustment: a new period resets the per-row working state.
  const [appliedGapsKey, setAppliedGapsKey] = useState<string | null>(null)
  if (gapsKey !== appliedGapsKey) {
    setAppliedGapsKey(gapsKey)
    setRemovedIds(new Set())
    setOverrides({})
    setRowErrors({})
    setExpandedId(null)
    setShowAll(false)
    setReviewingCode(null)
    setReviewNote('')
  }

  const gapsFetched = gapsResult !== null && gapsResult.key === gapsKey

  useEffect(() => {
    // Fetch once per period, NOT gated on the aggregate check: the check
    // compares period totals and can clear (or never fire) while individual
    // vouchers still miss their basis pair. Gating the fetch on it meant a
    // remount after the first korrigering showed "inga fel" with the
    // remaining broken vouchers silently hidden.
    if (gapsFetched) return
    let cancelled = false
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    // Yearly (helårsmoms) resolves against the räkenskapsår server-side.
    if (fiscalPeriodId) params.set('fiscal_period_id', fiscalPeriodId)
    fetch(`/api/reports/vat-declaration/rc-basis-gaps?${params.toString()}`)
      .then(async (r) => {
        const j = await r.json().catch(() => null)
        if (cancelled) return
        // A failed fetch must not masquerade as "no gaps found": an empty
        // list would mislead whenever gaps actually exist.
        if (!r.ok || j?.error) setGapsResult({ key: gapsKey, gaps: [], failed: true })
        else setGapsResult({ key: gapsKey, gaps: j?.data?.gaps || [] })
      })
      .catch(() => {
        if (!cancelled) setGapsResult({ key: gapsKey, gaps: [], failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [gapsFetched, gapsKey, periodType, year, period, fiscalPeriodId])

  const gaps = gapsFetched
    ? gapsResult.gaps.filter((g) => !removedIds.has(g.entryId))
    : []
  const verifikatCount = new Set(gaps.map((g) => g.entryId)).size
  const gapsLoading = hasRcBasisGaps && !gapsFetched
  const gapsFailed = gapsFetched && !!gapsResult.failed
  // The worklist stays mounted while unfixed rows remain, even after the
  // aggregate check has cleared: hiding them mid-session would strand the
  // user with silently understated rutor 20-24.
  const showGapWorklist = hasRcBasisGaps || gaps.length > 0

  const busy = fixingId !== null || bulkProgress !== null
  const preselectedVerifikatCount = new Set(gaps.filter((g) => g.supplierDefault).map((g) => g.entryId)).size

  const classificationFor = (gap: RcBasisGapWithDefault): GapClassification =>
    rcGapClassification(overrides[rowKey(gap)], gap.supplierDefault?.supplierType, sharedSel)

  /** The rows of the verifikat that have no supplier type yet: Korrigera asks for one first. */
  const unclassifiedRowsOf = (entryId: string) =>
    gaps.filter((g) => g.entryId === entryId && classificationFor(g).supplierType === null)

  /**
   * A supplier type was picked, for one verifikat or (no id) in the toolbar
   * for every row without one: its "choose one first" notes have done their job.
   */
  const clearChooseFirstErrors = (entryId?: string) => {
    const chooseFirst = t('vat_basis_choose_supplier_first')
    setRowErrors((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([id, message]) => message !== chooseFirst || (entryId !== undefined && id !== entryId)),
      ),
    )
  }

  // One korrigering per verifikat, each momssats with its own row's
  // classification. `resolved`: the verifikat has nothing left to correct
  // (already corrected elsewhere, a click that lost the race to another
  // included, or the kontoplan changed), so the row goes and the list is read
  // again rather than kept as a failure.
  const postFix = async (
    gap: RcBasisGapWithDefault,
  ): Promise<
    { ok: true; correctedId?: string } | { ok: false; resolved: boolean; message: string }
  > => {
    const sel = classificationFor(gap)
    try {
      const res = await fetch('/api/reports/vat-declaration/rc-basis-gaps/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryId: gap.entryId,
          supplierType: sel.supplierType,
          supplyType: sel.supplyType,
          perOutputAccount: gaps
            .filter((g) => g.entryId === gap.entryId)
            .map((g) => ({ rcOutputAccount: g.rcOutputAccount, ...classificationFor(g) })),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.error) {
        return {
          ok: false,
          resolved: json?.error?.code === 'VAT_RC_BASIS_NOTHING_MISSING',
          message: getErrorMessage(json, { locale: errorLocale, fallback: 'Kunde inte korrigera verifikationen' }),
        }
      }
      return { ok: true, correctedId: json?.data?.correctedId }
    } catch {
      return { ok: false, resolved: false, message: 'Kunde inte korrigera verifikationen' }
    }
  }

  const handleFixOne = async (gap: RcBasisGapWithDefault) => {
    const unclassified = unclassifiedRowsOf(gap.entryId)
    if (unclassified.length > 0) {
      setExpandedId(rowKey(unclassified[0]))
      setRowErrors((prev) => ({ ...prev, [gap.entryId]: t('vat_basis_choose_supplier_first') }))
      return
    }
    setFixingId(gap.entryId)
    setRowErrors((prev) => {
      const next = { ...prev }
      delete next[gap.entryId]
      return next
    })
    const result = await postFix(gap)
    setFixingId(null)
    if (!result.ok && result.resolved) {
      setRemovedIds((prev) => new Set(prev).add(gap.entryId))
      toast({ title: formatVoucher({ voucher_series: gap.voucherSeries, voucher_number: gap.voucherNumber }), description: result.message })
      setGapsResult(null)
      onCorrected()
      return
    }
    if (!result.ok) {
      setRowErrors((prev) => ({ ...prev, [gap.entryId]: result.message }))
      return
    }
    setRemovedIds((prev) => new Set(prev).add(gap.entryId))
    const correctedId = result.correctedId
    toast({
      title: `Verifikation ${formatVoucher({ voucher_series: gap.voucherSeries, voucher_number: gap.voucherNumber })} korrigerad`,
      description: 'Storno + ny verifikation skapad.',
      action: correctedId ? (
        <ToastAction
          altText="Visa verifikat"
          onClick={() => router.push(`/bookkeeping/${correctedId}`)}
        >
          Visa verifikat
        </ToastAction>
      ) : undefined,
    })
    onCorrected()
  }

  const handleFixAll = async () => {
    // One korrigering per verifikat: it adds the basis for every momssats the
    // verifikat lacks, so a second row for the same verifikat has nothing left.
    const targets = [...new Map(gaps.map((g) => [g.entryId, g])).values()]
    if (targets.length === 0) return
    // Nothing is posted while a row has no supplier type: each such row says
    // so inline, and the toolbar or the row's own picker answers it.
    const unclassifiedIds = new Set(
      gaps.filter((g) => classificationFor(g).supplierType === null).map((g) => g.entryId),
    )
    if (unclassifiedIds.size > 0) {
      setRowErrors((prev) => {
        const next = { ...prev }
        for (const id of unclassifiedIds) next[id] = t('vat_basis_choose_supplier_first')
        return next
      })
      toast({ title: t('vat_basis_fix_all_unclassified', { count: unclassifiedIds.size }) })
      return
    }
    const ownCount = gaps.filter((g) => overrides[rowKey(g)]?.supplierType).length
    const preselectedCount = gaps.filter((g) => !overrides[rowKey(g)]?.supplierType && g.supplierDefault).length
    const sharedCount = gaps.length - ownCount - preselectedCount
    const ok = await confirm({
      title: `Korrigera ${targets.length} verifikationer?`,
      description: [
        t('vat_basis_fix_all_confirm', { count: targets.length }),
        sharedCount > 0 && sharedSel.supplierType
          ? t('vat_basis_fix_all_confirm_shared', {
              count: sharedCount,
              supplier: SUPPLIER_LABELS[sharedSel.supplierType].toLowerCase(),
              supply: SUPPLY_LABELS[sharedSel.supplyType],
            })
          : null,
        preselectedCount > 0 ? t('vat_basis_fix_all_confirm_preselected', { count: preselectedCount }) : null,
        ownCount > 0 ? t('vat_basis_fix_all_confirm_own', { count: ownCount }) : null,
      ]
        .filter(Boolean)
        .join(' '),
      variant: 'warning',
      confirmLabel: 'Korrigera alla',
    })
    if (!ok) return

    setBulkProgress({ done: 0, total: targets.length })
    const failures: Record<string, string> = {}
    let resolvedCount = 0
    for (const [index, gap] of targets.entries()) {
      const result = await postFix(gap)
      if (!result.ok && result.resolved) resolvedCount += 1
      else if (!result.ok) failures[gap.entryId] = result.message
      setBulkProgress({ done: index + 1, total: targets.length })
    }
    // Fixed rows leave the list; failures stay with their inline error note.
    setRemovedIds((prev) => {
      const next = new Set(prev)
      for (const gap of targets) {
        if (!failures[gap.entryId]) next.add(gap.entryId)
      }
      return next
    })
    setRowErrors(failures)
    setBulkProgress(null)
    const failureCount = Object.keys(failures).length
    const fixedCount = targets.length - failureCount - resolvedCount
    // Every outcome is accounted for: a resolved row is neither corrected nor
    // left in the list, and no storno is claimed when none was made.
    toast({
      title: t('vat_basis_fix_all_title', { fixed: fixedCount, total: targets.length }),
      description: [
        failureCount > 0
          ? t('vat_basis_fix_all_failed', { count: failureCount })
          : fixedCount > 0
            ? t('vat_basis_fix_all_created')
            : null,
        resolvedCount > 0 ? t('vat_basis_fix_all_resolved', { count: resolvedCount }) : null,
      ]
        .filter(Boolean)
        .join(' '),
    })
    // One refetch at the end: per-row refetches would remount the page once
    // per verifikat. A resolved row means the list was stale: read it again.
    if (resolvedCount > 0) setGapsResult(null)
    onCorrected()
  }

  const periodQuery = (): Record<string, string> => ({
    period_type: periodType,
    year: String(year),
    period: String(period),
    ...(fiscalPeriodId ? { fiscal_period_id: fiscalPeriodId } : {}),
  })

  // The server recomputes the finding; the fingerprint sent is the one on
  // screen, so figures that moved since are refused instead of reviewed.
  const handleMarkReviewed = async (check: VatDeclarationCheck) => {
    if (!reviewInputs) return
    setReviewBusy(check.code)
    try {
      const note = reviewNote.trim()
      const res = await fetch('/api/reports/vat-declaration/check-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...periodQuery(),
          year,
          period,
          check_code: check.code,
          ...(note ? { note } : {}),
          expected_fingerprint: vatCheckFingerprint(check, reviewInputs),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.error) {
        toast({
          title: t('vat_check_review_failed'),
          description: getErrorMessage(json, { locale: errorLocale, fallback: t('vat_check_review_failed') }),
        })
        return
      }
      setReviewingCode(null)
      setReviewNote('')
      toast({ title: t('vat_check_review_saved') })
      onReviewsChanged?.()
    } catch {
      toast({ title: t('vat_check_review_failed') })
    } finally {
      setReviewBusy(null)
    }
  }

  const handleUndoReview = async (check: VatDeclarationCheck) => {
    setReviewBusy(check.code)
    try {
      const params = new URLSearchParams({ ...periodQuery(), check_code: check.code })
      const res = await fetch(`/api/reports/vat-declaration/check-reviews?${params.toString()}`, { method: 'DELETE' })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.error) {
        toast({
          title: t('vat_check_review_undo_failed'),
          description: getErrorMessage(json, { locale: errorLocale, fallback: t('vat_check_review_undo_failed') }),
        })
        return
      }
      onReviewsChanged?.()
    } catch {
      toast({ title: t('vat_check_review_undo_failed') })
    } finally {
      setReviewBusy(null)
    }
  }

  const unreviewed = unreviewedVatChecks(checks)

  // The fold counts verifikat, like the header and its own label: every row
  // of a verifikat with two momssatser stays on the same side of it.
  const previewIds = new Set([...new Set(gaps.map((g) => g.entryId))].slice(0, GAP_PREVIEW_COUNT))
  const visibleGaps = showAll ? gaps : gaps.filter((g) => previewIds.has(g.entryId))

  return (
    <div className="space-y-4">
        {checks.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircleIcon className="h-4 w-4 text-success" />
            Inga fel hittades i underlaget för perioden.
          </div>
        )}
        {checks.length > 0 && unreviewed.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircleIcon className="h-4 w-4 text-success" />
            {t('vat_check_all_reviewed')}
          </div>
        )}

        {checks.length > 0 && (
          <div>
            {checks.map((c, i) => {
              const reviewable = reviewInputs !== null && isReviewableVatCheck(c, reviewInputs)
              const editing = reviewingCode === c.code
              return (
                <div
                  key={`${c.code}-${i}`}
                  className="flex items-start gap-2 border-b-hairline py-3 text-[13px] leading-5 last:border-b-0"
                >
                  {c.review ? (
                    <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : c.status === 'ERROR' ? (
                    <ShieldExclamationIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                  ) : (
                    <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-attn" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex min-w-0 items-start gap-1.5">
                      <span className={cn(c.review && 'text-muted-foreground')}>{c.message}</span>
                      {c.detail ? <HelpPopover className="mt-0.5">{c.detail}</HelpPopover> : null}
                    </div>
                    {c.review ? (
                      <p className="text-xs text-muted-foreground">
                        {c.review.reviewed_by_label
                          ? t('vat_check_reviewed_by', {
                              date: formatDate(c.review.reviewed_at),
                              name: c.review.reviewed_by_label,
                            })
                          : t('vat_check_reviewed', { date: formatDate(c.review.reviewed_at) })}
                        {c.review.source === 'agent' ? ` ${t('vat_check_reviewed_via_agent')}` : ''}
                        {c.review.note ? `: ${c.review.note}` : ''}
                        {canWrite && (
                          <>
                            {' '}
                            <button
                              type="button"
                              onClick={() => handleUndoReview(c)}
                              disabled={reviewBusy !== null}
                              className={cn(QUIET_LINK_CLASS, 'disabled:cursor-not-allowed disabled:opacity-50')}
                            >
                              {t('vat_check_review_undo')}
                            </button>
                          </>
                        )}
                      </p>
                    ) : reviewable && canWrite && !editing ? (
                      <button
                        type="button"
                        onClick={() => {
                          setReviewingCode(c.code)
                          setReviewNote('')
                        }}
                        disabled={reviewBusy !== null}
                        className={cn(QUIET_LINK_CLASS, 'text-xs disabled:cursor-not-allowed disabled:opacity-50')}
                      >
                        {t('vat_check_review_action')}
                      </button>
                    ) : null}
                    {editing && !c.review && (
                      <div className="space-y-2 pt-1">
                        <label className="block text-xs text-muted-foreground" htmlFor={`vat-review-note-${c.code}`}>
                          {t('vat_check_review_note_label')}
                        </label>
                        <Textarea
                          id={`vat-review-note-${c.code}`}
                          value={reviewNote}
                          onChange={(e) => setReviewNote(e.target.value)}
                          maxLength={1000}
                          placeholder={t('vat_check_review_note_placeholder')}
                          className="min-h-[64px]"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            onClick={() => handleMarkReviewed(c)}
                            loading={reviewBusy === c.code}
                            disabled={reviewBusy !== null}
                          >
                            {t('vat_check_review_save')}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setReviewingCode(null)}
                            disabled={reviewBusy !== null}
                          >
                            {t('vat_check_review_cancel')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {showGapWorklist && (
          <div className="space-y-3">
            <div className="mb-1 flex items-center gap-2">
              <h3
                className="font-sans text-xs font-medium text-muted-foreground"
                aria-live="polite"
              >
                {rcBasisAdvisory
                  ? t('vat_basis_advisory_heading', { count: verifikatCount })
                  : `Verifikationer som saknar basbelopp (${verifikatCount})`}
              </h3>
              <div className="h-px flex-1 bg-border/60" />
            </div>

            {gapsLoading ? (
              <LateReveal aria-label="Söker berörda verifikationer">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex h-11 items-center gap-6 border-b-hairline">
                    <Skeleton className="h-3.5 w-16" />
                    <Skeleton className="h-3.5 w-56" />
                    <Skeleton className="ml-auto h-3.5 w-20" />
                  </div>
                ))}
              </LateReveal>
            ) : gapsFailed ? (
              <LoadError title="Kunde inte hämta verifikationslistan" onRetry={() => setGapsResult(null)} />
            ) : gaps.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Inga verifikationer hittades. Bristen kan ligga utanför perioden eller i
                bokföring som inte är bokförd.
              </p>
            ) : (
              <>
                {rcBasisAdvisory && (
                  <p className="text-xs text-muted-foreground">{t('vat_basis_advisory_hint')}</p>
                )}
                {/* Classification chips (house context-picker style), then the
                    bulk action: the chip values ("EU-leverantör", "Tjänst")
                    are self-describing, so no field labels. Not in the
                    advisory tier: there is nothing to add. */}
                {!rcBasisAdvisory && (
                <div className="flex flex-wrap items-center gap-2">
                  <ContextPicker
                    items={SUPPLIER_ITEMS}
                    value={sharedSel.supplierType}
                    onChange={(value) => {
                      const supplierType = value as SupplierType
                      setSharedSel((prev) => ({
                        supplierType,
                        // Non-EU + goods is import VAT, not reverse charge:
                        // coerce back to service so an invalid combo can't
                        // be mass-applied.
                        supplyType: coerceSupplyType(supplierType, prev.supplyType),
                      }))
                      clearChooseFirstErrors()
                    }}
                    triggerLabel={
                      sharedSel.supplierType
                        ? SUPPLIER_LABELS[sharedSel.supplierType]
                        : t('vat_basis_supplier_placeholder')
                    }
                    ariaLabel="Leverantörstyp"
                    disabled={busy}
                  />
                  <ContextPicker
                    items={supplyItemsFor(sharedSel.supplierType)}
                    value={sharedSel.supplyType}
                    onChange={(value) =>
                      setSharedSel((prev) => ({ ...prev, supplyType: value as SupplyType }))
                    }
                    triggerLabel={SUPPLY_DISPLAY[sharedSel.supplyType]}
                    ariaLabel="Typ av inköp"
                    disabled={busy}
                  />
                  <Button size="toolbar" onClick={handleFixAll} disabled={!canWrite || busy} loading={bulkProgress !== null}>
                    {bulkProgress === null && <CheckCircleIcon className="h-4 w-4" />}
                    Korrigera alla ({verifikatCount})
                  </Button>
                </div>
                )}
                {!rcBasisAdvisory && preselectedVerifikatCount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('vat_basis_preselected_hint', { count: preselectedVerifikatCount, total: verifikatCount })}
                  </p>
                )}

                {bulkProgress && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Korrigerar {Math.min(bulkProgress.done + 1, bulkProgress.total)} av{' '}
                    {bulkProgress.total}...
                  </p>
                )}
                {!canWrite && (
                  <p className="text-xs text-muted-foreground">Kräver skrivbehörighet.</p>
                )}

                <DataList className="rounded-none border-0 bg-transparent">
                  {visibleGaps.map((gap) => {
                    const sel = classificationFor(gap)
                    // Why the row's supplier type is what it is, when the
                    // person did not pick it: read from the supplier, or not
                    // known at all (the row is then asked).
                    const supplierNote =
                      sel.supplierType === null
                        ? t('vat_basis_supplier_unknown')
                        : !overrides[rowKey(gap)]?.supplierType && gap.supplierDefault
                          ? gap.supplierDefault.country
                            ? t('vat_basis_preselected_from_country', { country: gap.supplierDefault.country })
                            : t('vat_basis_preselected_from_card')
                          : null
                    const expanded = expandedId === rowKey(gap)
                    const rowError = rowErrors[gap.entryId]
                    return (
                      <DataListRow
                        key={rowKey(gap)}
                        expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : rowKey(gap))}
                        rowClassName="items-center px-1 py-[9px]"
                        trailing={
                          <>
                            <span className="text-sm tabular-nums text-muted-foreground">
                              {formatAmount(gap.missingBasisAmount)} kr
                            </span>
                            {!rcBasisAdvisory && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleFixOne(gap)
                              }}
                              disabled={!canWrite || busy}
                              className={cn(QUIET_LINK_CLASS, 'inline-flex items-center disabled:cursor-not-allowed disabled:opacity-50')}
                            >
                              {fixingId === gap.entryId && (
                                <SpinnerIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                              )}
                              Korrigera
                            </button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-expanded={expanded}
                              aria-label={
                                expanded
                                  ? `Dölj detaljer för verifikation ${formatVoucher({ voucher_series: gap.voucherSeries, voucher_number: gap.voucherNumber })}`
                                  : `Visa detaljer för verifikation ${formatVoucher({ voucher_series: gap.voucherSeries, voucher_number: gap.voucherNumber })}`
                              }
                              onClick={(e) => {
                                e.stopPropagation()
                                setExpandedId(expanded ? null : rowKey(gap))
                              }}
                            >
                              {expanded ? (
                                <ChevronDownIcon className="h-4 w-4" />
                              ) : (
                                <ChevronRightIcon className="h-4 w-4" />
                              )}
                            </Button>
                          </>
                        }
                        expandedContent={
                          <div className="space-y-3 px-1">
                            <p className="text-sm tabular-nums">
                              {gap.rcOutputAccount} har {formatAmount(gap.rcOutputAmount)} kr
                              fiktiv moms: saknar basbelopp{' '}
                              {formatAmount(gap.missingBasisAmount)} kr
                            </p>
                            {/* Same chips as the toolbar, scoped to this row:
                                a changed value becomes a per-row override.
                                Not in the advisory tier (no Korrigera). */}
                            {!rcBasisAdvisory && (
                            <div className="flex flex-wrap items-center gap-2">
                              <ContextPicker
                                items={SUPPLIER_ITEMS}
                                value={sel.supplierType}
                                onChange={(value) => {
                                  const supplierType = value as SupplierType
                                  setOverrides((prev) => ({
                                    ...prev,
                                    [rowKey(gap)]: {
                                      supplierType,
                                      supplyType: coerceSupplyType(supplierType, sel.supplyType),
                                    },
                                  }))
                                  clearChooseFirstErrors(gap.entryId)
                                }}
                                triggerLabel={
                                  sel.supplierType
                                    ? SUPPLIER_LABELS[sel.supplierType]
                                    : t('vat_basis_supplier_placeholder')
                                }
                                ariaLabel="Leverantörstyp"
                                disabled={busy}
                              />
                              <ContextPicker
                                items={supplyItemsFor(sel.supplierType)}
                                value={sel.supplyType}
                                onChange={(value) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    [rowKey(gap)]: {
                                      // Only the supply type is the row's own: its
                                      // supplier type keeps coming from the
                                      // supplier's country or the toolbar.
                                      supplierType: prev[rowKey(gap)]?.supplierType ?? null,
                                      supplyType: value as SupplyType,
                                    },
                                  }))
                                }
                                triggerLabel={SUPPLY_DISPLAY[sel.supplyType]}
                                ariaLabel="Typ av inköp"
                                disabled={busy}
                              />
                            </div>
                            )}
                            {!rcBasisAdvisory && supplierNote && (
                              <p className="text-xs text-muted-foreground">{supplierNote}</p>
                            )}
                          </div>
                        }
                      >
                        <div className="flex min-w-0 items-baseline gap-4 text-[13px]">
                          <span className="w-16 shrink-0 tabular-nums">
                            {formatVoucher({ voucher_series: gap.voucherSeries, voucher_number: gap.voucherNumber })}
                          </span>
                          <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{formatDate(gap.entryDate)}</span>
                          {gap.description && <span className="min-w-0 truncate text-muted-foreground">{gap.description}</span>}
                        </div>
                        {/* Always visible: a failed korrigering must not hide
                            its reason behind the collapsed expansion. */}
                        {rowError && (
                          <p role="alert" className="mt-1 text-xs text-destructive">
                            {rowError}
                          </p>
                        )}
                      </DataListRow>
                    )
                  })}
                </DataList>

                {verifikatCount > GAP_PREVIEW_COUNT && (
                  <button type="button" onClick={() => setShowAll((v) => !v)} className={QUIET_LINK_CLASS}>
                    {showAll ? 'Visa färre' : `Visa alla ${verifikatCount} verifikationer`}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
