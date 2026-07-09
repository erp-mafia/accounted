'use client'

import React, { useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, AlertCircle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  createSourceLoader,
  type ReportSourceLine,
  type ReportSourceFetcher,
} from '@/lib/reports/source-lines'

interface ReportRowExpansionProps {
  /** Lazy fetcher invoked the first time the row is expanded. */
  fetcher: ReportSourceFetcher
  /** Column span used by the inline expansion `<tr>`. */
  colSpan: number
  /** Stable id used as the toggle's aria-controls reference. */
  rowId: string
}

interface UseSourceLinesResult {
  lines: ReportSourceLine[] | null
  loading: boolean
  error: string | null
  load: () => Promise<void>
}

/**
 * Hook owning the lazy fetch + caching of source lines. Thin wrapper on top
 * of `createSourceLoader` from `lib/reports/source-lines` so the loading
 * semantics can be unit-tested in node without DOM.
 *
 * The cache lives per-instance: reopening the same row never refetches.
 */
export function useSourceLines(fetcher: ReportSourceFetcher): UseSourceLinesResult {
  const [lines, setLines] = useState<ReportSourceLine[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The loader is stable for the lifetime of the fetcher reference; callers
  // are expected to memoise their fetcher with `useMemo` (every callsite in
  // `reports/page.tsx` does).
  const loader = useMemo(
    () =>
      createSourceLoader(fetcher, (s) => {
        setLines(s.lines)
        setLoading(s.loading)
        setError(s.error)
      }),
    [fetcher]
  )

  const load = useCallback(() => loader.load(), [loader])

  return { lines, loading, error, load }
}

/**
 * Drilldown affordance for aggregated report rows.
 *
 * Renders two cells (the chevron-toggle is placed in the calling row; the
 * expansion itself is rendered as a sibling `<tr>` only when expanded).
 * The caller is responsible for placing `<ReportRowExpansion.Toggle>` inside
 * the aggregated row and `<ReportRowExpansion.Panel>` immediately below.
 *
 * Usage:
 *   const expansion = useReportRowExpansion(fetcher)
 *   <tr><td><expansion.Toggle /></td>...</tr>
 *   {expansion.expanded && <expansion.Panel colSpan={6} />}
 *
 * Or use the all-in-one component below where the caller owns the
 * surrounding `<tr>` and just plugs the expansion in.
 */
export function ReportRowExpansion({
  fetcher,
  colSpan,
  rowId,
}: ReportRowExpansionProps) {
  const [expanded, setExpanded] = useState(false)
  const { lines, loading, error, load } = useSourceLines(fetcher)

  const toggle = useCallback(() => {
    const next = !expanded
    setExpanded(next)
    if (next) load()
  }, [expanded, load])

  return (
    <>
      <td className="py-2 w-8">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={`expansion-${rowId}`}
          aria-label={expanded ? 'Dölj verifikat' : 'Visa verifikat'}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
      </td>
      {expanded && (
        <ExpansionPanel
          colSpan={colSpan}
          loading={loading}
          error={error}
          lines={lines}
          rowId={rowId}
        />
      )}
    </>
  )
}

/**
 * Variant where the toggle and the expansion are placed by the caller. The
 * caller renders `<Toggle />` inside the aggregated `<tr>`, then below
 * conditionally renders `<Panel />` as a sibling `<tr>` so its `<td
 * colSpan={n}>` lines up with the rest of the table.
 */
export function useReportRowExpansion(fetcher: ReportSourceFetcher, rowId: string) {
  const [expanded, setExpanded] = useState(false)
  const { lines, loading, error, load } = useSourceLines(fetcher)

  const toggle = useCallback(() => {
    const next = !expanded
    setExpanded(next)
    if (next) load()
  }, [expanded, load])

  const Toggle = () => (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={expanded}
      aria-controls={`expansion-${rowId}`}
      aria-label={expanded ? 'Dölj verifikat' : 'Visa verifikat'}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
    >
      {expanded ? (
        <ChevronDown className="h-4 w-4" />
      ) : (
        <ChevronRight className="h-4 w-4" />
      )}
    </button>
  )

  const Panel = ({ colSpan }: { colSpan: number }) =>
    expanded ? (
      <ExpansionPanelRow
        colSpan={colSpan}
        loading={loading}
        error={error}
        lines={lines}
        rowId={rowId}
      />
    ) : null

  return { expanded, Toggle, Panel }
}

/**
 * Body of the expansion when the wrapping `<td>` colSpan is provided:
 * renders inline (used by ReportRowExpansion).
 */
function ExpansionPanel({
  colSpan,
  loading,
  error,
  lines,
  rowId,
}: {
  colSpan: number
  loading: boolean
  error: string | null
  lines: ReportSourceLine[] | null
  rowId: string
}) {
  return (
    <td colSpan={colSpan} id={`expansion-${rowId}`} className="bg-muted/20 p-0">
      <ExpansionContent loading={loading} error={error} lines={lines} />
    </td>
  )
}

/**
 * Body of the expansion when used in a sibling `<tr>` (used by
 * `useReportRowExpansion`'s Panel).
 */
function ExpansionPanelRow({
  colSpan,
  loading,
  error,
  lines,
  rowId,
}: {
  colSpan: number
  loading: boolean
  error: string | null
  lines: ReportSourceLine[] | null
  rowId: string
}) {
  return (
    <tr className="bg-muted/20">
      <td colSpan={colSpan} id={`expansion-${rowId}`} className="p-0">
        <ExpansionContent loading={loading} error={error} lines={lines} />
      </td>
    </tr>
  )
}

function ExpansionContent({
  loading,
  error,
  lines,
}: {
  loading: boolean
  error: string | null
  lines: ReportSourceLine[] | null
}) {
  if (loading) {
    return (
      <div className="px-4 py-3 space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-4 py-3 flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    )
  }

  if (!lines || lines.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-muted-foreground">
        Inga underliggande verifikat.
      </div>
    )
  }

  return (
    <div className="px-4 py-2">
      <table className="w-full text-xs">
        <thead className="[&_th]:font-medium [&_th]:text-[10px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
          <tr className="text-left">
            <th className="py-1 w-24">Verifikat</th>
            <th className="py-1 w-24">Datum</th>
            <th className="py-1">Beskrivning</th>
            <th className="py-1 w-24 text-right">Debet</th>
            <th className="py-1 w-24 text-right">Kredit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.voucher_series}-${line.voucher_number}-${line.journal_entry_id}`} className="border-t border-border">
              <td className="py-1.5">
                {line.journal_entry_id ? (
                  <Link
                    href={`/bookkeeping/${line.journal_entry_id}`}
                    className="font-mono text-foreground hover:underline underline-offset-4"
                  >
                    {formatVoucher(line)}
                  </Link>
                ) : (
                  <span className="font-mono text-muted-foreground">-</span>
                )}
              </td>
              <td className="py-1.5 tabular-nums text-muted-foreground">
                {line.date ? formatDate(line.date) : ''}
              </td>
              <td className="py-1.5 truncate max-w-md" title={line.description}>
                {line.description}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {line.debit > 0 ? formatAmount(line.debit) : ''}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {line.credit > 0 ? formatAmount(line.credit) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
