'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { formatDate } from '@/lib/utils'
import { useCanWrite } from '@/lib/hooks/use-can-write'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** API responses use the canonical envelope; error may be a string or an object. */
function apiErrorMessage(json: unknown, fallback: string): string {
  const err = (json as { error?: unknown } | null)?.error
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return fallback
}

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

  const errorCount = checks.filter((c) => c.status === 'ERROR').length
  const warningCount = checks.length - errorCount
  const hasRcBasisGaps = checks.some((c) => c.code === 'RC_BASIS_MISSING')

  // Gap fetch tagged with the key it was requested under: loading is derived
  // by comparing tags, so the effect never sets state synchronously. Fixed
  // rows are removed via removedIds (the fetch itself is not re-run after a
  // korrigering: the period key is unchanged). The key is period-only, NOT
  // gated on RC_BASIS_MISSING: the aggregate check clears as soon as ONE
  // voucher is corrected, and the remaining unfixed rows must survive the
  // declaration refetch that follows each korrigering.
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
    // Fetch once per period, and only while the aggregate check flags a gap:
    // the fetched list then outlives the check, which clears after the first
    // correction even though other vouchers may remain broken.
    if (!hasRcBasisGaps || gapsFetched) return
    let cancelled = false
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    // Forward-compatible: the route reads calendar params today, but yearly
    // (helårsmoms) declarations resolve against the räkenskapsår.
    if (fiscalPeriodId) params.set('fiscal_period_id', fiscalPeriodId)
    fetch(`/api/reports/vat-declaration/rc-basis-gaps?${params.toString()}`)
      .then(async (r) => {
        const j = await r.json().catch(() => null)
        if (cancelled) return
        // A failed fetch must not masquerade as "no gaps found": the check
        // above says there ARE gaps, so an empty list here would mislead.
        if (!r.ok || j?.error) setGapsResult({ key: gapsKey, gaps: [], failed: true })
        else setGapsResult({ key: gapsKey, gaps: j?.data?.gaps || [] })
      })
      .catch(() => {
        if (!cancelled) setGapsResult({ key: gapsKey, gaps: [], failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [hasRcBasisGaps, gapsFetched, gapsKey, periodType, year, period, fiscalPeriodId])

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
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Kontroll av underlaget</CardTitle>
          {errorCount > 0 ? (
            <Badge variant="destructive">
              {errorCount} {errorCount === 1 ? 'fel' : 'fel'}
            </Badge>
          ) : warningCount > 0 ? (
            <Badge variant="warning">
              {warningCount} {warningCount === 1 ? 'varning' : 'varningar'}
            </Badge>
          ) : (
            <Badge variant="success">Inga anmärkningar</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {checks.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-success" />
            Inga fel hittades i underlaget för perioden.
          </div>
        )}

        {checks.length > 0 && (
          <div className="space-y-2">
            {checks.map((c, i) => (
              <div
                key={`${c.code}-${i}`}
                className={`flex items-start gap-2 rounded-lg p-3 text-sm ${
                  c.status === 'ERROR'
                    ? 'bg-destructive/5 text-destructive'
                    : 'border border-border bg-muted/30'
                }`}
              >
                {c.status === 'ERROR' ? (
                  <ShieldAlert className="h-4 w-4 mt-1 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 mt-1 shrink-0 text-warning" />
                )}
                <div>
                  <span className="font-mono text-xs mr-2">{c.code}</span>
                  {c.message}
                </div>
              </div>
            ))}
          </div>
        )}

        {showGapWorklist && (
          <div className="space-y-3">
            <h3
              className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
              aria-live="polite"
            >
              Verifikationer som saknar basbelopp ({gaps.length})
            </h3>

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
                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <Label htmlFor="rc-supplier-type">Leverantörstyp</Label>
                    <Select
                      value={sharedSel.supplierType}
                      onValueChange={(value) => {
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
                      disabled={busy}
                    >
                      <SelectTrigger id="rc-supplier-type" className="mt-1 w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="eu_business">EU-leverantör</SelectItem>
                        <SelectItem value="non_eu_business">Utanför EU</SelectItem>
                        <SelectItem value="swedish_business">Svensk omvänd skattskyldighet</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="rc-supply-type">Typ av inköp</Label>
                    <Select
                      value={sharedSel.supplyType}
                      onValueChange={(value) =>
                        setSharedSel((prev) => ({ ...prev, supplyType: value as SupplyType }))
                      }
                      disabled={busy}
                    >
                      <SelectTrigger id="rc-supply-type" className="mt-1 w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="service">Tjänst</SelectItem>
                        {sharedSel.supplierType !== 'non_eu_business' && (
                          <SelectItem value="goods">Vara</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
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
                            <Button
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleFixOne(gap)
                              }}
                              disabled={!canWrite || busy}
                            >
                              {fixingId === gap.entryId ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-4 w-4 mr-2" />
                              )}
                              Korrigera
                            </Button>
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
                            <div className="flex flex-wrap items-end gap-4">
                              <div>
                                <Label htmlFor={`rc-supplier-${gap.entryId}`}>
                                  Leverantörstyp
                                </Label>
                                <Select
                                  value={sel.supplierType}
                                  onValueChange={(value) => {
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
                                  disabled={busy}
                                >
                                  <SelectTrigger
                                    id={`rc-supplier-${gap.entryId}`}
                                    className="mt-1 w-56"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="eu_business">EU-leverantör</SelectItem>
                                    <SelectItem value="non_eu_business">Utanför EU</SelectItem>
                                    <SelectItem value="swedish_business">Svensk omvänd skattskyldighet</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div>
                                <Label htmlFor={`rc-supply-${gap.entryId}`}>Typ av inköp</Label>
                                <Select
                                  value={sel.supplyType}
                                  onValueChange={(value) =>
                                    setOverrides((prev) => ({
                                      ...prev,
                                      [gap.entryId]: {
                                        ...sel,
                                        supplyType: value as SupplyType,
                                      },
                                    }))
                                  }
                                  disabled={busy}
                                >
                                  <SelectTrigger
                                    id={`rc-supply-${gap.entryId}`}
                                    className="mt-1 w-32"
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="service">Tjänst</SelectItem>
                                    {sel.supplierType !== 'non_eu_business' && (
                                      <SelectItem value="goods">Vara</SelectItem>
                                    )}
                                  </SelectContent>
                                </Select>
                              </div>
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
                  <Button variant="ghost" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Visa färre' : `Visa alla ${gaps.length} verifikationer`}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
      <DestructiveConfirmDialog {...dialogProps} />
    </Card>
  )
}
