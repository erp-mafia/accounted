'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Search, Tags, Undo2, X } from 'lucide-react'
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

/** Flattened line DTO from GET /api/dimensions/tagging/lines. */
interface TaggingLine {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, string>
  journal_entry_id: string
  entry_date: string
  voucher_number: number | null
  voucher_series: string | null
  description: string
  reversed_by_id: string | null
  reverses_id: string | null
  fiscal_period_id: string
}

interface ApplyResult {
  retagged: number
  unchanged: number
  failed: { line_id: string; error: string }[]
}

const ACCOUNT_RE = /^\d{4}$/

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

/**
 * Bulk retro-tagging workbench (dimensions plan PR6 §3, Retrofit UX): browse
 * posted lines, select (shift-click ranges supported), pick KS/Projekt values
 * and apply them through the audited retag RPC. Merge mode (default) layers
 * the picked values onto each line's existing map; "Ersätt tagg" replaces the
 * whole map — used to consolidate typo/phantom codes.
 *
 * Strings are hardcoded Swedish per the dimensions-surface convention
 * (DimensionCombobox/LineDimensionFields): this operates directly on
 * verifikat, a stays-Swedish surface per .claude/rules/i18n.md.
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

  // Result set (null = never fetched)
  const [lines, setLines] = useState<TaggingLine[] | null>(null)
  const [totalCapped, setTotalCapped] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  // Selection + apply panel
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchorIndexRef = useRef<number | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [replaceMode, setReplaceMode] = useState(false)
  const [reason, setReason] = useState('')
  const [isApplying, setIsApplying] = useState(false)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const loadLines = useCallback(async () => {
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

      const res = await fetch(`/api/dimensions/tagging/lines?${params.toString()}`)
      const json = await res.json().catch(() => null)
      if (!res.ok) throw json ?? new Error()

      setLines((json?.data?.lines ?? []) as TaggingLine[])
      setTotalCapped(Boolean(json?.data?.total_capped))
      setSelected(new Set())
      setRowErrors({})
      anchorIndexRef.current = null
    } catch (err) {
      toast({
        title: 'Kunde inte hämta rader',
        description: getErrorMessage(err, { locale: 'sv' }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }, [accountFrom, accountTo, dateFrom, dateTo, text, onlyUntagged, toast])

  const toggleRow = useCallback(
    (index: number, shiftKey: boolean) => {
      if (!lines) return
      setSelected((prev) => {
        const next = new Set(prev)
        const anchor = anchorIndexRef.current
        if (shiftKey && anchor !== null && anchor !== index) {
          // Range selection: the whole range takes the clicked row's NEW state.
          const target = !prev.has(lines[index].id)
          const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor]
          for (let i = lo; i <= hi; i++) {
            if (target) next.add(lines[i].id)
            else next.delete(lines[i].id)
          }
        } else if (next.has(lines[index].id)) {
          next.delete(lines[index].id)
        } else {
          next.add(lines[index].id)
        }
        return next
      })
      anchorIndexRef.current = index
    },
    [lines],
  )

  const allSelected =
    lines !== null && lines.length > 0 && lines.every((l) => selected.has(l.id))
  const someSelected = lines !== null && lines.some((l) => selected.has(l.id))

  const toggleAll = useCallback(() => {
    if (!lines) return
    setSelected(allSelected ? new Set() : new Set(lines.map((l) => l.id)))
    anchorIndexRef.current = null
  }, [lines, allSelected])

  // Reversal-pair warning: a selected line whose entry is half of a storno
  // pair, where the paired entry's lines are loaded but not (all) selected.
  const missingPairLineIds = useMemo(() => {
    if (!lines || selected.size === 0) return [] as string[]
    const pairEntryIds = new Set<string>()
    for (const line of lines) {
      if (!selected.has(line.id)) continue
      if (line.reversed_by_id) pairEntryIds.add(line.reversed_by_id)
      if (line.reverses_id) pairEntryIds.add(line.reverses_id)
    }
    if (pairEntryIds.size === 0) return [] as string[]
    return lines
      .filter((l) => pairEntryIds.has(l.journal_entry_id) && !selected.has(l.id))
      .map((l) => l.id)
  }, [lines, selected])

  // Voucher labels of the unselected counter-vouchers — the blocking
  // confirmation names them so the skew risk is concrete (#867 review:
  // Srf U 14 gross reporting; an asymmetric storno pair silently skews
  // project P&L, so the advisory alone is not enough).
  const missingPairVouchers = useMemo(() => {
    if (!lines || missingPairLineIds.length === 0) return [] as string[]
    const ids = new Set(missingPairLineIds)
    const labels = new Set<string>()
    for (const line of lines) {
      if (ids.has(line.id)) {
        labels.add(`${line.voucher_series ?? ''}${line.voucher_number ?? ''}`)
      }
    }
    return [...labels]
  }, [lines, missingPairLineIds])

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
    if (!lines || !canApply) return

    // Storno-pair guard: tagging one leg of a reversal pair without the
    // other skews project P&L. Blocking confirmation, not just the banner.
    if (missingPairLineIds.length > 0) {
      const ok = await confirm({
        title: 'Motverifikat är inte valda',
        description: `Du taggar verifikat utan deras motverifikat (${missingPairVouchers.join(', ')}). Projektresultatet blir skevt tills båda sidorna bär samma dimensioner. Vill du tagga ändå?`,
        confirmLabel: 'Tagga ändå',
      })
      if (!ok) return
    }
    const selectedLines = lines.filter((l) => selected.has(l.id))

    // Per-line resulting map, grouped so each distinct map is one POST
    // (the API takes ONE dimensions object per call). Usually 1 group; more
    // when merge mode meets heterogeneous existing tags.
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
        const res = await fetch('/api/dimensions/tagging/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            line_ids: group.ids,
            dimensions: group.dimensions,
            reason: reason.trim(),
          }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok) {
          const message = getErrorMessage(json, { locale: 'sv' })
          for (const id of group.ids) failed.push({ line_id: id, error: message })
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
        for (const id of group.ids) {
          if (!failedIds.has(id)) newDimsByLine.set(id, group.dimensions)
        }
      }
    } finally {
      setIsApplying(false)
    }

    // Succeeded rows get their new map locally (no refetch); failed rows stay
    // selected with their Swedish RPC error shown inline.
    setLines((prev) =>
      prev
        ? prev.map((l) =>
            newDimsByLine.has(l.id)
              ? { ...l, dimensions: newDimsByLine.get(l.id) as Record<string, string> }
              : l,
          )
        : prev,
    )
    setSelected(new Set(failed.map((f) => f.line_id)))
    setRowErrors(Object.fromEntries(failed.map((f) => [f.line_id, f.error])))

    toast({
      title: failed.length > 0 ? 'Omtaggningen slutfördes delvis' : 'Rader omtaggade',
      description: `${retagged} ändrade, ${unchanged} oförändrade${
        failed.length > 0 ? `, ${failed.length} misslyckades` : ''
      }.`,
      variant: failed.length > 0 ? 'destructive' : undefined,
    })

    if (failed.length === 0) {
      setPicked({})
      setReason('')
    }
  }, [lines, canApply, selected, replaceMode, picked, reason, toast, missingPairLineIds, missingPairVouchers, confirm])

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
                  if (e.key === 'Enter') void loadLines()
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
                Endast otaggade rader
              </Label>
            </div>
            <Button onClick={() => void loadLines()} disabled={isLoading}>
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Search className="mr-2 h-4 w-4" />
              )}
              Hämta rader
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Result list */}
      {lines === null && !isLoading ? (
        <Card>
          <CardContent className="p-0">
            <DataListEmpty
              icon={<Tags className="h-6 w-6" />}
              title="Hämta rader att tagga"
              description="Välj filter ovan och klicka på Hämta rader för att bläddra bland bokförda verifikatrader."
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
              aria-label="Markera alla rader"
              disabled={!lines || lines.length === 0}
            />
            <span className="text-xs text-muted-foreground">
              {lines ? `${lines.length} rader` : ''}
            </span>
            {totalCapped && (
              <span className="ml-auto text-xs text-muted-foreground">
                Visar de första {lines?.length ?? 0} raderna — förfina filtren för att se
                fler.
              </span>
            )}
          </DataListHeader>
          {isLoading ? (
            <DataListLoading />
          ) : lines && lines.length === 0 ? (
            <DataListEmpty
              icon={<Search className="h-6 w-6" />}
              title="Inga rader matchade filtren"
              description="Justera datum, kontointervall eller söktext och försök igen."
            />
          ) : (
            (lines ?? []).map((line, index) => {
              const isSelected = selected.has(line.id)
              const inStornoPair = Boolean(line.reversed_by_id || line.reverses_id)
              const dimEntries = Object.entries(line.dimensions)
              const isDebit = line.debit_amount > 0
              return (
                <DataListRow
                  key={line.id}
                  selected={isSelected}
                  className="select-none"
                  onClick={(e) => toggleRow(index, e.shiftKey)}
                  leading={
                    <Checkbox
                      checked={isSelected}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        toggleRow(index, e.shiftKey)
                      }}
                      aria-label={`Markera rad ${line.voucher_series ?? ''}${line.voucher_number ?? ''} ${line.account_number}`}
                    />
                  }
                  trailing={
                    <div className="text-right">
                      <p className="text-sm tabular-nums">
                        {formatCurrency(isDebit ? line.debit_amount : line.credit_amount)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {isDebit ? 'Debet' : 'Kredit'}
                      </p>
                    </div>
                  }
                >
                  <DataListPrimary className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {line.voucher_series ?? ''}
                      {line.voucher_number ?? ''}
                    </span>
                    <span className="truncate">{line.description}</span>
                    {inStornoPair && (
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
                    <span className="tabular-nums">{formatDate(line.entry_date)}</span>
                    <DataListMetaSeparator />
                    <span className="font-mono">{line.account_number}</span>
                    {dimEntries.length > 0 && <DataListMetaSeparator />}
                    {dimEntries.map(([dimNo, code]) => (
                      <Badge
                        key={dimNo}
                        variant="outline"
                        className="px-1.5 py-0 text-[10px] font-normal"
                      >
                        {dimensionLabel(dimNo)}{' '}
                        <span className="ml-1 font-mono">{code}</span>
                      </Badge>
                    ))}
                  </DataListMeta>
                  {rowErrors[line.id] && (
                    <p className="mt-1 text-xs text-destructive">{rowErrors[line.id]}</p>
                  )}
                </DataListRow>
              )
            })
          )}
        </DataList>
      )}

      {/* Spacer so the fixed apply panel never covers the last rows */}
      {selected.size > 0 && <div aria-hidden="true" className="h-64 sm:h-48" />}

      {/* Apply panel — fixed footer bar while a selection is active */}
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
                  Du taggar ett verifikat men inte dess motverifikat —
                  projektresultatet kan bli skevt.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={includeCounterVouchers}>
                Inkludera motverifikat
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary">{selected.size} rader valda</Badge>
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
                <Button onClick={() => void handleApply()} disabled={!canApply}>{/* storno-pair confirm inside */}
                  {isApplying ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Tags className="mr-2 h-4 w-4" />
                  )}
                  Tagga {selected.size} rader
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
