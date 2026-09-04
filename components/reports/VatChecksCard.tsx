'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ContextPicker } from '@/components/common/ContextPicker'
import {
  DataList,
  DataListMeta,
  DataListMetaSeparator,
  DataListPrimary,
  DataListRow,
} from '@/components/ui/data-list'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldAlert,
} from 'lucide-react'
import type { VatDeclarationCheck } from '@/lib/reports/vat-declaration-checks'
import type { RcBasisGap } from '@/lib/reports/rc-basis-gaps'
import type { VatPeriodType } from '@/types'
import { formatAmount, formatDate } from '@/lib/utils'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn } from '@/lib/utils'
import { apiErrorMessage } from './api-error'

type SupplierType = 'eu_business' | 'non_eu_business' | 'swedish_business'
type SupplyType = 'service' | 'goods'
interface GapClassification {
  supplierType: SupplierType
  supplyType: SupplyType
}

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
const supplyItemsFor = (supplierType: SupplierType) =>
  supplierType === 'non_eu_business'
    ? [{ id: 'service', label: 'Tjänst' }]
    : [
        { id: 'service', label: 'Tjänst' },
        { id: 'goods', label: 'Vara' },
      ]

/** How many gap rows render before the "Visa alla" toggle. */
const GAP_PREVIEW_COUNT = 8

/**
 * "Kontroll av underlaget": the local pre-flight checks for the
 * momsdeklaration plus the per-voucher RC-basis-gap worklist with single and
 * bulk Korrigera. Hoisted out of SkatteverketPanel so EVERY user sees it,
 * paying or not, connected or not: manual filers are exactly the users who
 * must not file a declaration these checks would have blocked.
 */
export function VatChecksCard({
  checks,
  periodType,
  year,
  period,
  fiscalPeriodId,
  onCorrected,
}: {
  checks: VatDeclarationCheck[]
  periodType: VatPeriodType
  year: number
  period: number
  fiscalPeriodId?: string
  onCorrected: () => void
}) {
  const router = useRouter()
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
    gaps: RcBasisGap[]
    failed?: boolean
  } | null>(null)
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Shared classification applied by "Korrigera alla" and any row without an
  // override. Visible in the toolbar so a bulk fix never runs on a hidden guess.
  const [sharedSel, setSharedSel] = useState<GapClassification>({
    supplierType: 'eu_business',
    supplyType: 'service',
  })
  const [overrides, setOverrides] = useState<Record<string, GapClassification>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)

  // Render-phase adjustment: a new period resets the per-row working state.
  const [appliedGapsKey, setAppliedGapsKey] = useState<string | null>(null)
  if (gapsKey !== appliedGapsKey) {
    setAppliedGapsKey(gapsKey)
    setRemovedIds(new Set())
    setOverrides({})
    setRowErrors({})
    setExpandedId(null)
    setShowAll(false)
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
  const gapsLoading = hasRcBasisGaps && !gapsFetched
  const gapsFailed = gapsFetched && !!gapsResult.failed
  // The worklist stays mounted while unfixed rows remain, even after the
  // aggregate check has cleared: hiding them mid-session would strand the
  // user with silently understated rutor 20-24.
  const showGapWorklist = hasRcBasisGaps || gaps.length > 0

  const busy = fixingId !== null || bulkProgress !== null

  const classificationFor = (gap: RcBasisGap): GapClassification =>
    overrides[gap.entryId] ?? sharedSel

  const postFix = async (
    gap: RcBasisGap,
    sel: GapClassification,
  ): Promise<{ ok: true; correctedId?: string } | { ok: false; message: string }> => {
    try {
      const res = await fetch('/api/reports/vat-declaration/rc-basis-gaps/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryId: gap.entryId,
          supplierType: sel.supplierType,
          supplyType: sel.supplyType,
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.error) {
        return { ok: false, message: apiErrorMessage(json, 'Kunde inte korrigera verifikationen') }
      }
      return { ok: true, correctedId: json?.data?.correctedId }
    } catch {
      return { ok: false, message: 'Kunde inte korrigera verifikationen' }
    }
  }

  const handleFixOne = async (gap: RcBasisGap) => {
    setFixingId(gap.entryId)
    setRowErrors((prev) => {
      const next = { ...prev }
      delete next[gap.entryId]
      return next
    })
    const result = await postFix(gap, classificationFor(gap))
    setFixingId(null)
    if (!result.ok) {
      setRowErrors((prev) => ({ ...prev, [gap.entryId]: result.message }))
      return
    }
    setRemovedIds((prev) => new Set(prev).add(gap.entryId))
    const correctedId = result.correctedId
    toast({
      title: `Verifikation ${gap.voucherSeries}-${gap.voucherNumber} korrigerad`,
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
    const targets = [...gaps]
    if (targets.length === 0) return
    const overriddenCount = targets.filter((g) => overrides[g.entryId]).length
    const ok = await confirm({
      title: `Korrigera ${targets.length} verifikationer?`,
      description:
        `Detta skapar ${targets.length} stornon och ${targets.length} nya verifikationer ` +
        `klassificerade som ${SUPPLIER_LABELS[sharedSel.supplierType].toLowerCase()}, ` +
        `${SUPPLY_LABELS[sharedSel.supplyType]}.` +
        (overriddenCount > 0
          ? ` ${overriddenCount} rader använder sina egna val i stället.`
          : ' Rader du inte ändrat använder valen ovan.'),
      variant: 'warning',
      confirmLabel: 'Korrigera alla',
    })
    if (!ok) return

    setBulkProgress({ done: 0, total: targets.length })
    const failures: Record<string, string> = {}
    for (const [index, gap] of targets.entries()) {
      const result = await postFix(gap, classificationFor(gap))
      if (!result.ok) failures[gap.entryId] = result.message
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
    const fixedCount = targets.length - failureCount
    toast({
      title: `${fixedCount} av ${targets.length} verifikationer korrigerade`,
      description:
        failureCount > 0
          ? `${failureCount} kunde inte korrigeras och ligger kvar i listan.`
          : 'Storno + nya verifikationer skapade.',
    })
    // One refetch at the end: per-row refetches would remount the page once
    // per verifikat.
    onCorrected()
  }

  const visibleGaps = showAll ? gaps : gaps.slice(0, GAP_PREVIEW_COUNT)

  return (
    <div className="space-y-4">
        {checks.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-success" />
            Inga fel hittades i underlaget för perioden.
          </div>
        )}

        {checks.length > 0 && (
          <div>
            {checks.map((c, i) => (
              <div
                key={`${c.code}-${i}`}
                className="flex items-start gap-2 border-b border-border/60 py-3 text-[13px] leading-5 last:border-b-0"
              >
                {c.status === 'ERROR' ? (
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-attn" aria-hidden="true" />
                )}
                <div>{c.message}</div>
              </div>
            ))}
          </div>
        )}

        {showGapWorklist && (
          <div className="space-y-3">
            <div className="mb-1 flex items-center gap-2">
              <h3
                className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground"
                aria-live="polite"
              >
                Verifikationer som saknar basbelopp ({gaps.length})
              </h3>
              <div className="h-px flex-1 bg-border/60" />
            </div>

            {gapsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Söker berörda verifikationer...
              </div>
            ) : gapsFailed ? (
              <div className="flex flex-wrap items-center gap-3">
                <p role="alert" className="text-sm text-destructive">
                  Kunde inte hämta verifikationslistan.
                </p>
                <Button variant="outline" onClick={() => setGapsResult(null)}>
                  Försök igen
                </Button>
              </div>
            ) : gaps.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Inga verifikationer hittades. Bristen kan ligga utanför perioden eller i
                bokföring som inte är bokförd.
              </p>
            ) : (
              <>
                {/* Classification chips (house context-picker style), then the
                    bulk action: the chip values ("EU-leverantör", "Tjänst")
                    are self-describing, so no field labels. */}
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
                        supplyType:
                          supplierType === 'non_eu_business' ? 'service' : prev.supplyType,
                      }))
                    }}
                    triggerLabel={SUPPLIER_LABELS[sharedSel.supplierType]}
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
                  <Button onClick={handleFixAll} disabled={!canWrite || busy}>
                    {bulkProgress ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                    )}
                    Korrigera alla ({gaps.length})
                  </Button>
                </div>

                {bulkProgress && (
                  <p role="status" className="text-sm text-muted-foreground">
                    Korrigerar {Math.min(bulkProgress.done + 1, bulkProgress.total)} av{' '}
                    {bulkProgress.total}...
                  </p>
                )}
                {!canWrite && (
                  <p className="text-xs text-muted-foreground">Kräver skrivbehörighet.</p>
                )}

                <DataList>
                  {visibleGaps.map((gap) => {
                    const sel = classificationFor(gap)
                    const expanded = expandedId === gap.entryId
                    const rowError = rowErrors[gap.entryId]
                    return (
                      <DataListRow
                        key={gap.entryId}
                        expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : gap.entryId)}
                        trailing={
                          <>
                            <span className="text-sm tabular-nums text-muted-foreground">
                              {formatAmount(gap.expectedBasisAmount)} kr
                            </span>
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
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                              )}
                              Korrigera
                            </button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-expanded={expanded}
                              aria-label={
                                expanded
                                  ? `Dölj detaljer för verifikation ${gap.voucherSeries}-${gap.voucherNumber}`
                                  : `Visa detaljer för verifikation ${gap.voucherSeries}-${gap.voucherNumber}`
                              }
                              onClick={(e) => {
                                e.stopPropagation()
                                setExpandedId(expanded ? null : gap.entryId)
                              }}
                            >
                              {expanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                          </>
                        }
                        expandedContent={
                          <div className="space-y-3">
                            <p className="text-sm tabular-nums">
                              {gap.rcOutputAccount} har {formatAmount(gap.rcOutputAmount)} kr
                              fiktiv moms: saknar basbelopp{' '}
                              {formatAmount(gap.expectedBasisAmount)} kr
                            </p>
                            {/* Same chips as the toolbar, scoped to this row:
                                a changed value becomes a per-row override. */}
                            <div className="flex flex-wrap items-center gap-2">
                              <ContextPicker
                                items={SUPPLIER_ITEMS}
                                value={sel.supplierType}
                                onChange={(value) => {
                                  const supplierType = value as SupplierType
                                  setOverrides((prev) => ({
                                    ...prev,
                                    [gap.entryId]: {
                                      supplierType,
                                      supplyType:
                                        supplierType === 'non_eu_business'
                                          ? 'service'
                                          : sel.supplyType,
                                    },
                                  }))
                                }}
                                triggerLabel={SUPPLIER_LABELS[sel.supplierType]}
                                ariaLabel="Leverantörstyp"
                                disabled={busy}
                              />
                              <ContextPicker
                                items={supplyItemsFor(sel.supplierType)}
                                value={sel.supplyType}
                                onChange={(value) =>
                                  setOverrides((prev) => ({
                                    ...prev,
                                    [gap.entryId]: {
                                      ...sel,
                                      supplyType: value as SupplyType,
                                    },
                                  }))
                                }
                                triggerLabel={SUPPLY_DISPLAY[sel.supplyType]}
                                ariaLabel="Typ av inköp"
                                disabled={busy}
                              />
                            </div>
                          </div>
                        }
                      >
                        <DataListPrimary>
                          Verifikation {gap.voucherSeries}-{gap.voucherNumber}
                        </DataListPrimary>
                        <DataListMeta>
                          <span className="tabular-nums">{formatDate(gap.entryDate)}</span>
                          {gap.description && (
                            <>
                              <DataListMetaSeparator />
                              <span className="truncate">{gap.description}</span>
                            </>
                          )}
                        </DataListMeta>
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

                {gaps.length > GAP_PREVIEW_COUNT && (
                  <button type="button" onClick={() => setShowAll((v) => !v)} className={QUIET_LINK_CLASS}>
                    {showAll ? 'Visa färre' : `Visa alla ${gaps.length} verifikationer`}
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
