'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Tags,
  Undo2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  DataList,
  DataListEmpty,
  DataListHeader,
  DataListLoading,
  DataListMeta,
  DataListMetaSeparator,
  DataListPrimary,
  DataListRow,
} from '@/components/ui/data-list'
import { useToast } from '@/components/ui/use-toast'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'

/** Line DTO inside a voucher from GET /api/dimensions/tagging/lines. */
interface TaggingLine {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, string>
}

/** Voucher DTO from GET /api/dimensions/tagging/lines. */
interface TaggingVoucher {
  journal_entry_id: string
  entry_date: string
  voucher_number: number | null
  voucher_series: string | null
  description: string
  annulled: boolean
  reversed_by_id: string | null
  reverses_id: string | null
  fiscal_period_id: string
  lines: TaggingLine[]
}

interface ApplyResult {
  retagged: number
  unchanged: number
  failed: { line_id: string; error: string }[]
}

const ACCOUNT_RE = /^\d{4}$/
/** POST /api/dimensions/tagging/apply accepts at most 500 line_ids per call. */
const APPLY_CHUNK = 500

function dimensionLabel(sieDimNo: string): string {
  if (sieDimNo === '1') return 'KS'
  if (sieDimNo === '6') return 'Proj'
  return `Dim ${sieDimNo}`
}

/** Stable grouping key for a dimensions map (sorted entries). */
function mapKey(dims: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(dims)
      .sort()
      .map((k) => [k, dims[k]]),
  )
}

function voucherLabel(v: TaggingVoucher): string {
  return `${v.voucher_series ?? ''}${v.voucher_number ?? ''}`
}

/**
 * Distinct non-empty bags across a voucher's lines (insertion order), plus
 * whether the voucher mixes tagged and untagged lines ("delvis taggad").
 */
function voucherTagState(v: TaggingVoucher): {
  bags: Record<string, string>[]
  partial: boolean
} {
  const seen = new Map<string, Record<string, string>>()
  let tagged = 0
  for (const line of v.lines) {
    if (Object.keys(line.dimensions).length === 0) continue
    tagged++
    const key = mapKey(line.dimensions)
    if (!seen.has(key)) seen.set(key, line.dimensions)
  }
  return {
    bags: [...seen.values()],
    partial: tagged > 0 && tagged < v.lines.length,
  }
}

/**
 * Bulk retro-tagging workbench (dimensions plan PR6 §3, voucher-level
 * rework): browse posted VERIFIKAT, select whole vouchers (shift-click
 * ranges), pick KS/Projekt values and apply them to every line through the
 * audited retag RPC: retroactive tagging produces exactly what tagging at
 * creation would have (the producers stamp all lines too). Rows expand to
 * their lines for the mixed case (a voucher split across projects).
 *
 * Reversal pairs are hidden by default (they net to zero in every dimension
 * bucket when kept symmetric: tagging them is a no-op, and tagging one side
 * only is the one way to skew project P&L). "Visa annullerade" opts them in;
 * the blocking motverifikat confirmation survives only there.
 *
 * Merge mode (default) layers picked values onto each line's existing map;
 * "Ersätt tagg" replaces the whole map: used to consolidate typo/phantom
 * codes. Strings hardcoded Swedish per the dimensions-surface convention.
 */
export default function BulkTagWorkbench() {
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  // Filter bar
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [accountFrom, setAccountFrom] = useState('')
  const [accountTo, setAccountTo] = useState('')
  const [text, setText] = useState('')
  const [onlyUntagged, setOnlyUntagged] = useState(false)
  const [showAnnulled, setShowAnnulled] = useState(false)

  // Result set (null = never fetched)
  const [vouchers, setVouchers] = useState<TaggingVoucher[] | null>(null)
  const [totalCapped, setTotalCapped] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  // Selection (line-id based: the retag RPC is per line), expansion + apply
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const anchorIndexRef = useRef<number | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [replaceMode, setReplaceMode] = useState(false)
  const [reason, setReason] = useState('')
  const [isApplying, setIsApplying] = useState(false)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const loadVouchers = useCallback(async () => {
    for (const [label, value] of [
      ['Konto från', accountFrom],
      ['Konto till', accountTo],
    ] as const) {
      if (value && !ACCOUNT_RE.test(value)) {
        toast({
          title: 'Ogiltigt kontonummer',
          description: `${label} måste vara exakt 4 siffror.`,
          variant: 'destructive',
        })
        return
      }
    }

    setIsLoading(true)
    try {
      const params = new URLSearchParams()
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (accountFrom) params.set('account_from', accountFrom)
      if (accountTo) params.set('account_to', accountTo)
      if (text.trim()) params.set('text', text.trim())
      if (onlyUntagged) params.set('only_untagged', '1')
      if (showAnnulled) params.set('include_annulled', '1')

      const res = await fetch(`/api/dimensions/tagging/lines?${params.toString()}`)
      const json = await res.json().catch(() => null)
      if (!res.ok) throw json ?? new Error()

      setVouchers((json?.data?.vouchers ?? []) as TaggingVoucher[])
      setTotalCapped(Boolean(json?.data?.total_capped))
      setSelected(new Set())
      setExpanded(new Set())
      setRowErrors({})
      anchorIndexRef.current = null
    } catch (err) {
      toast({
        title: 'Kunde inte hämta verifikat',
        description: getErrorMessage(err, { locale: 'sv' }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [accountFrom, accountTo, dateFrom, dateTo, text, onlyUntagged, showAnnulled, toast])

  /** Selection state of one voucher: 'none' | 'some' | 'all'. */
  const voucherSelection = useCallback(
    (v: TaggingVoucher): 'none' | 'some' | 'all' => {
      let count = 0
      for (const line of v.lines) if (selected.has(line.id)) count++
      if (count === 0) return 'none'
      return count === v.lines.length ? 'all' : 'some'
    },
    [selected],
  )

  const toggleVoucher = useCallback(
    (index: number, shiftKey: boolean) => {
      if (!vouchers) return
      setSelected((prev) => {
        const next = new Set(prev)
        const anchor = anchorIndexRef.current
        const setVoucher = (v: TaggingVoucher, on: boolean) => {
          for (const line of v.lines) {
            if (on) next.add(line.id)
            else next.delete(line.id)
          }
        }
        const clicked = vouchers[index]
        const target = !clicked.lines.every((l) => prev.has(l.id))
        if (shiftKey && anchor !== null && anchor !== index) {
          // Range selection: the whole range takes the clicked voucher's NEW state.
          const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor]
          for (let i = lo; i <= hi; i++) setVoucher(vouchers[i], target)
        } else {
          setVoucher(clicked, target)
        }
        return next
      })
      anchorIndexRef.current = index
    },
    [vouchers],
  )

  const toggleLine = useCallback((lineId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      return next
    })
  }, [])

  const toggleExpanded = useCallback((entryId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
  }, [])

  const allSelected =
    vouchers !== null &&
    vouchers.length > 0 &&
    vouchers.every((v) => v.lines.every((l) => selected.has(l.id)))
  const someSelected = selected.size > 0

  const toggleAll = useCallback(() => {
    if (!vouchers) return
    setSelected(
      allSelected ? new Set() : new Set(vouchers.flatMap((v) => v.lines.map((l) => l.id))),
    )
    anchorIndexRef.current = null
  }, [vouchers, allSelected])

  const selectedVoucherCount = useMemo(() => {
    if (!vouchers) return 0
    return vouchers.filter((v) => v.lines.some((l) => selected.has(l.id))).length
  }, [vouchers, selected])

  // Reversal-pair guard: only reachable when annullerade are shown: a
  // selected voucher whose counter-entry is loaded but not fully selected.
  const missingPairLineIds = useMemo(() => {
    if (!vouchers || selected.size === 0) return [] as string[]
    const pairEntryIds = new Set<string>()
    for (const v of vouchers) {
      if (!v.lines.some((l) => selected.has(l.id))) continue
      if (v.reversed_by_id) pairEntryIds.add(v.reversed_by_id)
      if (v.reverses_id) pairEntryIds.add(v.reverses_id)
    }
    if (pairEntryIds.size === 0) return [] as string[]
    return vouchers
      .filter((v) => pairEntryIds.has(v.journal_entry_id))
      .flatMap((v) => v.lines.map((l) => l.id))
      .filter((id) => !selected.has(id))
  }, [vouchers, selected])

  // Voucher labels of the unselected counter-vouchers: the blocking
  // confirmation names them so the skew risk is concrete (#867 review:
  // Srf U 14 gross reporting; an asymmetric storno pair silently skews
  // project P&L, so the advisory alone is not enough).
  const missingPairVouchers = useMemo(() => {
    if (!vouchers || missingPairLineIds.length === 0) return [] as string[]
    const ids = new Set(missingPairLineIds)
    const labels = new Set<string>()
    for (const v of vouchers) {
      if (v.lines.some((l) => ids.has(l.id))) labels.add(voucherLabel(v))
    }
    return [...labels]
  }, [vouchers, missingPairLineIds])

  const includeCounterVouchers = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of missingPairLineIds) next.add(id)
      return next
    })
  }, [missingPairLineIds])

  const handlePick = useCallback((sieDimNo: string, code: string | null) => {
    setPicked((prev) => {
      const next = { ...prev }
      if (code) next[sieDimNo] = code
      else delete next[sieDimNo]
      return next
    })
  }, [])

  const pickedCount = Object.keys(picked).length
  const reasonValid = reason.trim().length >= 3
  const canApply =
    canWrite &&
    !isApplying &&
    selected.size > 0 &&
    reasonValid &&
    (replaceMode || pickedCount > 0)

  const { dialogProps: confirmDialogProps, confirm } = useDestructiveConfirm()

  const handleApply = useCallback(async () => {
    if (!vouchers || !canApply) return

    // Storno-pair guard: tagging one leg of a reversal pair without the
    // other skews project P&L. Blocking confirmation, not just the banner.
    // Only reachable when "Visa annullerade" is on: the default view
    // excludes pairs entirely.
    if (missingPairLineIds.length > 0) {
      const ok = await confirm({
        title: 'Motverifikat är inte valda',
        description: `Du taggar verifikat utan deras motverifikat (${missingPairVouchers.join(', ')}). Projektresultatet blir skevt tills båda sidorna bär samma dimensioner. Vill du tagga ändå?`,
        confirmLabel: 'Tagga ändå',
      })
      if (!ok) return
    }

    const selectedLines = vouchers.flatMap((v) => v.lines).filter((l) => selected.has(l.id))

    // Per-line resulting map, grouped so each distinct map is one POST
    // (the API takes ONE dimensions object per call), then chunked to the
    // apply route's 500-line cap. Usually 1 group; more when merge mode
    // meets heterogeneous existing tags.
    const groups = new Map<string, { dimensions: Record<string, string>; ids: string[] }>()
    for (const line of selectedLines) {
      const dims = replaceMode ? { ...picked } : { ...line.dimensions, ...picked }
      const key = mapKey(dims)
      const group = groups.get(key) ?? { dimensions: dims, ids: [] }
      group.ids.push(line.id)
      groups.set(key, group)
    }

    setIsApplying(true)
    let retagged = 0
    let unchanged = 0
    const failed: { line_id: string; error: string }[] = []
    const newDimsByLine = new Map<string, Record<string, string>>()

    try {
      for (const group of groups.values()) {
        for (let i = 0; i < group.ids.length; i += APPLY_CHUNK) {
          const chunk = group.ids.slice(i, i + APPLY_CHUNK)
          const res = await fetch('/api/dimensions/tagging/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              line_ids: chunk,
              dimensions: group.dimensions,
              reason: reason.trim(),
            }),
          })
          const json = await res.json().catch(() => null)
          if (!res.ok) {
            const message = getErrorMessage(json, { locale: 'sv' })
            for (const id of chunk) failed.push({ line_id: id, error: message })
            continue
          }
          const result = (json?.data ?? {}) as Partial<ApplyResult>
          retagged += result.retagged ?? 0
          unchanged += result.unchanged ?? 0
          const failedIds = new Set<string>()
          for (const f of result.failed ?? []) {
            failed.push(f)
            failedIds.add(f.line_id)
          }
          for (const id of chunk) {
            if (!failedIds.has(id)) newDimsByLine.set(id, group.dimensions)
          }
        }
      }
    } finally {
      setIsApplying(false)
    }

    // Succeeded lines get their new map locally (no refetch); failed lines
    // stay selected with their Swedish RPC error shown inline, and their
    // vouchers auto-expand so the error is visible.
    setVouchers((prev) =>
      prev
        ? prev.map((v) => ({
            ...v,
            lines: v.lines.map((l) =>
              newDimsByLine.has(l.id)
                ? { ...l, dimensions: newDimsByLine.get(l.id) as Record<string, string> }
                : l,
            ),
          }))
        : prev,
    )
    setSelected(new Set(failed.map((f) => f.line_id)))
    setRowErrors(Object.fromEntries(failed.map((f) => [f.line_id, f.error])))
    if (failed.length > 0 && vouchers) {
      const failedIds = new Set(failed.map((f) => f.line_id))
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const v of vouchers) {
          if (v.lines.some((l) => failedIds.has(l.id))) next.add(v.journal_entry_id)
        }
        return next
      })
    }

    toast({
      title: failed.length > 0 ? 'Omtaggningen slutfördes delvis' : 'Verifikat omtaggade',
      description: `${retagged} rader ändrade, ${unchanged} oförändrade${
        failed.length > 0 ? `, ${failed.length} misslyckades` : ''
      }.`,
      variant: failed.length > 0 ? 'destructive' : undefined,
    })

    if (failed.length === 0) {
      setPicked({})
      setReason('')
    }
  }, [vouchers, canApply, selected, replaceMode, picked, reason, toast, missingPairLineIds, missingPairVouchers, confirm])

  const headerChecked: boolean | 'indeterminate' = allSelected
    ? true
    : someSelected
      ? 'indeterminate'
      : false

  return (
    <div className="space-y-8">
      {/* Filter bar */}
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label htmlFor="tag-date-from" className="text-xs text-muted-foreground">
                Från datum
              </Label>
              <Input
                id="tag-date-from"
                type="date"
                className="mt-1"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="tag-date-to" className="text-xs text-muted-foreground">
                Till datum
              </Label>
              <Input
                id="tag-date-to"
                type="date"
                className="mt-1"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="tag-account-from" className="text-xs text-muted-foreground">
                Konto från
              </Label>
              <Input
                id="tag-account-from"
                inputMode="numeric"
                maxLength={4}
                placeholder="3000"
                className="mt-1 font-mono"
                value={accountFrom}
                onChange={(e) => setAccountFrom(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div>
              <Label htmlFor="tag-account-to" className="text-xs text-muted-foreground">
                Konto till
              </Label>
              <Input
                id="tag-account-to"
                inputMode="numeric"
                maxLength={4}
                placeholder="7999"
                className="mt-1 font-mono"
                value={accountTo}
                onChange={(e) => setAccountTo(e.target.value.replace(/\D/g, ''))}
              />
            </div>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Sök i beskrivning…"
                className="pl-10"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadVouchers()
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="tag-only-untagged"
                checked={onlyUntagged}
                onCheckedChange={(checked) => setOnlyUntagged(checked === true)}
              />
              <Label htmlFor="tag-only-untagged" className="text-sm font-normal">
                Endast otaggade
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="tag-show-annulled"
                checked={showAnnulled}
                onCheckedChange={(checked) => setShowAnnulled(checked === true)}
              />
              <Label htmlFor="tag-show-annulled" className="text-sm font-normal">
                Visa annullerade
              </Label>
            </div>
            <Button onClick={() => void loadVouchers()} disabled={isLoading}>
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Search className="mr-2 h-4 w-4" />
              )}
              Hämta verifikat
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Result list */}
      {vouchers === null && !isLoading ? (
        <Card>
          <CardContent className="p-0">
            <DataListEmpty
              icon={<Tags className="h-6 w-6" />}
              title="Hämta verifikat att tagga"
              description="Välj filter ovan och klicka på Hämta verifikat för att bläddra bland bokförda verifikat."
            />
          </CardContent>
        </Card>
      ) : (
        <DataList>
          <DataListHeader>
            <Checkbox
              checked={headerChecked}
              onClick={(e) => {
                e.preventDefault()
                toggleAll()
              }}
              aria-label="Markera alla verifikat"
              disabled={!vouchers || vouchers.length === 0}
            />
            <span className="text-xs text-muted-foreground">
              {vouchers ? `${vouchers.length} verifikat` : ''}
            </span>
            {totalCapped && (
              <span className="ml-auto text-xs text-muted-foreground">
                Visar de första {vouchers?.length ?? 0} verifikaten: förfina filtren för
                att se fler.
              </span>
            )}
          </DataListHeader>
          {isLoading ? (
            <DataListLoading />
          ) : vouchers && vouchers.length === 0 ? (
            <DataListEmpty
              icon={<Search className="h-6 w-6" />}
              title="Inga verifikat matchade filtren"
              description="Justera datum, kontointervall eller söktext och försök igen."
            />
          ) : (
            (vouchers ?? []).map((voucher, index) => {
              const sel = voucherSelection(voucher)
              const isExpanded = expanded.has(voucher.journal_entry_id)
              const { bags, partial } = voucherTagState(voucher)
              const total = voucher.lines.reduce((sum, l) => sum + l.debit_amount, 0)
              const hasError = voucher.lines.some((l) => rowErrors[l.id])
              return (
                <div key={voucher.journal_entry_id}>
                  <DataListRow
                    selected={sel !== 'none'}
                    className="select-none"
                    onClick={(e) => toggleVoucher(index, e.shiftKey)}
                    leading={
                      <div className="flex items-center gap-1">
                        <Checkbox
                          checked={sel === 'all' ? true : sel === 'some' ? 'indeterminate' : false}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            toggleVoucher(index, e.shiftKey)
                          }}
                          aria-label={`Markera verifikat ${voucherLabel(voucher)}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleExpanded(voucher.journal_entry_id)
                          }}
                          aria-label={
                            isExpanded
                              ? `Dölj rader för ${voucherLabel(voucher)}`
                              : `Visa rader för ${voucherLabel(voucher)}`
                          }
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    }
                    trailing={
                      <p className="text-sm tabular-nums">{formatCurrency(total)}</p>
                    }
                  >
                    <DataListPrimary className="flex items-center gap-2">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {voucherLabel(voucher)}
                      </span>
                      <span className="truncate">{voucher.description}</span>
                      {voucher.annulled && (
                        <span
                          title="Verifikatet ingår i ett storno-par"
                          className="inline-flex shrink-0"
                        >
                          <Undo2
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="sr-only">Ingår i ett storno-par</span>
                        </span>
                      )}
                    </DataListPrimary>
                    <DataListMeta>
                      <span className="tabular-nums">{formatDate(voucher.entry_date)}</span>
                      <DataListMetaSeparator />
                      <span>{voucher.lines.length} rader</span>
                      {(bags.length > 0 || partial) && <DataListMetaSeparator />}
                      {bags.map((bag) => (
                        <Badge
                          key={mapKey(bag)}
                          variant="outline"
                          className="px-1.5 py-0 text-[10px] font-normal"
                        >
                          {Object.entries(bag)
                            .sort(([a], [b]) => Number(a) - Number(b))
                            .map(([dimNo, code]) => `${dimensionLabel(dimNo)} ${code}`)
                            .join(' · ')}
                        </Badge>
                      ))}
                      {partial && (
                        <Badge
                          variant="secondary"
                          className="px-1.5 py-0 text-[10px] font-normal"
                        >
                          Delvis taggad
                        </Badge>
                      )}
                    </DataListMeta>
                    {hasError && !isExpanded && (
                      <p className="mt-1 text-xs text-destructive">
                        Vissa rader kunde inte taggas: visa raderna för detaljer.
                      </p>
                    )}
                  </DataListRow>
                  {isExpanded &&
                    voucher.lines.map((line) => {
                      const isSelected = selected.has(line.id)
                      const dimEntries = Object.entries(line.dimensions)
                      const isDebit = line.debit_amount > 0
                      const amount = isDebit ? line.debit_amount : -line.credit_amount
                      return (
                        <DataListRow
                          key={line.id}
                          selected={isSelected}
                          className="select-none bg-muted/30"
                          onClick={() => toggleLine(line.id)}
                          leading={
                            <div className="flex items-center gap-1 pl-7">
                              <Checkbox
                                checked={isSelected}
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  toggleLine(line.id)
                                }}
                                aria-label={`Markera rad ${line.account_number} på ${voucherLabel(voucher)}`}
                              />
                            </div>
                          }
                          trailing={
                            <p className="text-sm tabular-nums">{formatCurrency(amount)}</p>
                          }
                        >
                          <DataListPrimary className="flex items-center gap-2">
                            <span className="font-mono text-xs">{line.account_number}</span>
                          </DataListPrimary>
                          <DataListMeta>
                            {dimEntries.length === 0 ? (
                              <span className="text-muted-foreground">Otaggad</span>
                            ) : (
                              dimEntries.map(([dimNo, code]) => (
                                <Badge
                                  key={dimNo}
                                  variant="outline"
                                  className="px-1.5 py-0 text-[10px] font-normal"
                                >
                                  {dimensionLabel(dimNo)}{' '}
                                  <span className="ml-1 font-mono">{code}</span>
                                </Badge>
                              ))
                            )}
                          </DataListMeta>
                          {rowErrors[line.id] && (
                            <p className="mt-1 text-xs text-destructive">
                              {rowErrors[line.id]}
                            </p>
                          )}
                        </DataListRow>
                      )
                    })}
                </div>
              )
            })
          )}
        </DataList>
      )}

      {/* Spacer so the fixed apply panel never covers the last rows */}
      {selected.size > 0 && <div aria-hidden="true" className="h-64 sm:h-48" />}

      {/* Apply panel: fixed footer bar while a selection is active */}
      {selected.size > 0 && (
        <div className="fixed bottom-20 left-1/2 z-40 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 rounded-lg border border-border bg-background p-4 shadow-lg md:bottom-6">
          {missingPairLineIds.length > 0 && (
            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-border bg-secondary/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-sm">
                  Du taggar ett verifikat men inte dess motverifikat:
                  projektresultatet kan bli skevt.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={includeCounterVouchers}>
                Inkludera motverifikat
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary">
              {selectedVoucherCount} verifikat · {selected.size} rader
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected(new Set())
                anchorIndexRef.current = null
              }}
            >
              <X className="mr-1 h-3 w-3" />
              Avmarkera
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Switch
                id="tag-replace-mode"
                checked={replaceMode}
                onCheckedChange={setReplaceMode}
                disabled={isApplying}
              />
              <Label htmlFor="tag-replace-mode" className="text-sm font-normal">
                Ersätt tagg
              </Label>
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <LineDimensionFields
              dimensions={picked}
              onChange={handlePick}
              disabled={isApplying}
              inputClassName="h-8"
            />
            <div>
              <Label htmlFor="tag-reason" className="text-xs text-muted-foreground">
                Anledning
              </Label>
              <div className="mt-1 flex flex-col gap-3 sm:flex-row">
                <Input
                  id="tag-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="T.ex. rättelse av projektkod (minst 3 tecken)"
                  disabled={isApplying}
                  className="flex-1"
                />
                <Button onClick={() => void handleApply()} disabled={!canApply}>
                  {isApplying ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Tags className="mr-2 h-4 w-4" />
                  )}
                  Tagga {selectedVoucherCount} verifikat
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {replaceMode
                ? 'Ersätter hela taggningen på raderna med exakt de valda värdena. '
                : ''}
              Påverkar endast internredovisningen, inte verifikatet.
            </p>
          </div>
        </div>
      )}
      <DestructiveConfirmDialog {...confirmDialogProps} />
    </div>
  )
}
