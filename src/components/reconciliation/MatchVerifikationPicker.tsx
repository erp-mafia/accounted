'use client'

import { useState, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Check, Search, X } from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { matchesVoucherSearch } from '@/lib/reconciliation/voucher-search'

/**
 * Map the endpoint's 0-1 match confidence (attached only when candidates are
 * ranked for a specific transaction) to a strength label, so the user can tell
 * an exact-amount hit from a fuzzy guess before vouching for an immutable
 * verifikat. Returns null when no confidence was attached.
 *
 * Chips mark exceptions (convention 5): a strong hit is the normal,
 * auto-selected case and renders as muted text; only the fuzzy guesses that
 * deserve a second look get a chip.
 */
function confidenceMark(
  confidence: number | undefined,
): { label: string; variant: 'secondary' | 'outline' | null } | null {
  if (confidence == null) return null
  if (confidence >= 0.85) return { label: 'Stark träff', variant: null }
  if (confidence >= 0.6) return { label: 'Trolig träff', variant: 'secondary' }
  return { label: 'Svag träff', variant: 'outline' }
}

/**
 * A posted journal entry line on a cash account (e.g. 1930) not yet linked to
 * any bank transaction: a candidate for manual reconciliation. Mirrors the
 * `UnlinkedGLLine` returned by GET /api/reconciliation/bank/unmatched-entries.
 *
 * Defined here (not imported from lib/reconciliation/bank-reconciliation) so the
 * client bundle never pulls in that module's server-only dependencies (event
 * bus, match-log). The optional `confidence` is attached when the endpoint
 * ranks candidates for a specific transaction.
 */
export interface UnlinkedGLLine {
  line_id: string
  journal_entry_id: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  entry_date: string
  voucher_number: number
  voucher_series: string
  entry_description: string
  source_type: string
  confidence?: number
  /** How many bank transactions already settle this entry on the account being
   *  matched (links on OTHER cash accounts, e.g. a transfer's outgoing leg,
   *  don't count). > 0 means the voucher is already matched on this account:
   *  surfaced (behind the "visa matchade" opt-in) so a second/third
   *  transaction can be attached to it (N:1). */
  linked_transaction_count?: number
}

interface MatchPickerProps {
  glLines: UnlinkedGLLine[]
  disabled?: boolean
  placeholder?: string
  /**
   * Multi-select (1:N: one bank row explained by several verifikat):
   * `selectedIds` are the picked entries and `onToggle` flips one. Every
   * picked verifikat renders as a removable chip above the search box and the
   * list stays open with the picked rows marked, so the next one is one click
   * away.
   */
  selectedIds: readonly string[]
  onToggle: (journalEntryId: string) => void
}

/**
 * Inline combobox for choosing a journal entry to match a bank transaction
 * against. The native <select> couldn't be searched, and the unmatched-GL list
 * routinely runs to hundreds of rows (historical SIE imports), so the old UX
 * forced users to scroll a giant unsorted dropdown. This picker filters by
 * voucher number, date, amount or description as the user types, and renders
 * the selected verifikationer as removable chips.
 *
 * The candidate list lives in normal document flow (always visible below the
 * search box), never as an absolutely-positioned overlay: inside a Dialog or
 * any `overflow-y-auto` container an absolute dropdown is clipped at the
 * container's edge (the "klipper i dialogerna" bug).
 */
export function MatchVerifikationPicker({
  glLines,
  disabled,
  placeholder = 'Sök ver.nr, datum, belopp eller beskrivning…',
  selectedIds,
  onToggle,
}: MatchPickerProps) {
  const [search, setSearch] = useState('')

  // Chips, in pick order, one per verifikat (a verifikat with two lines on the
  // account is still one pick).
  const pickedLines = useMemo(() => {
    return selectedIds.flatMap((id) => {
      const line = glLines.find((l) => l.journal_entry_id === id)
      return line ? [line] : []
    })
  }, [glLines, selectedIds])
  const pickedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q.length === 0
      ? glLines
      : glLines.filter((line) => matchesVoucherSearch({ ...line, voucher: formatVoucher(line) }, q))
    return base.slice(0, 25)
  }, [search, glLines])

  function renderChip(line: UnlinkedGLLine, onRemove: () => void) {
    const amount = line.debit_amount > 0 ? line.debit_amount : -line.credit_amount
    // Suppress the match-strength badge on an already-matched verifikat so a
    // green "Stark träff" can't visually encourage an accidental double-match:
    // "Redan matchad" is the signal that matters there (N:1 stays opt-in).
    const strength =
      (line.linked_transaction_count ?? 0) > 0 ? null : confidenceMark(line.confidence)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
        <span className="font-mono text-xs shrink-0">{formatVoucher(line)}</span>
        <span className="text-muted-foreground shrink-0 tabular-nums">{formatDate(line.entry_date)}</span>
        <span className="tabular-nums shrink-0">{formatCurrency(amount)}</span>
        <span className="truncate text-muted-foreground flex-1 min-w-0">{line.entry_description}</span>
        {strength && (
          strength.variant ? (
            <Badge variant={strength.variant} className="shrink-0 text-[11px]">
              {strength.label}
            </Badge>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground">{strength.label}</span>
          )
        )}
        {(line.linked_transaction_count ?? 0) > 0 && (
          <Badge variant="secondary" className="shrink-0 text-[11px]">
            Redan matchad
          </Badge>
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="shrink-0"
          onClick={onRemove}
          disabled={disabled}
          aria-label="Avmarkera verifikation"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    )
  }

  function pick(line: UnlinkedGLLine) {
    // The search stays: the next verifikat of a split usually matches the
    // same filter (same day, same payer prefix).
    onToggle(line.journal_entry_id)
  }

  const listContent =
    filtered.length === 0 ? (
      <div className="px-3 py-4 text-sm text-muted-foreground text-center">
        Inga verifikationer matchar &quot;{search}&quot;
      </div>
    ) : (
      <div className="max-h-72 overflow-y-auto">
        {filtered.map((line) => {
          const amount = line.debit_amount > 0 ? line.debit_amount : -line.credit_amount
          const strength =
            (line.linked_transaction_count ?? 0) > 0 ? null : confidenceMark(line.confidence)
          const picked = pickedSet.has(line.journal_entry_id)
          return (
            <button
              key={line.line_id}
              type="button"
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary/60 focus:bg-secondary/60 focus:outline-none',
                picked && 'bg-secondary/40',
              )}
              aria-pressed={picked}
              onMouseDown={(e) => {
                // mousedown beats blur: without this the popover closes
                // before the click registers when the user has tabbed
                // through and uses keyboard.
                e.preventDefault()
              }}
              onClick={() => pick(line)}
            >
              <span className="w-4 shrink-0" aria-hidden>
                {picked && <Check className="h-3.5 w-3.5" />}
              </span>
              <span className="font-mono text-xs shrink-0 w-12">{formatVoucher(line)}</span>
              <span className="text-muted-foreground shrink-0 tabular-nums w-24">{formatDate(line.entry_date)}</span>
              <span className="tabular-nums shrink-0 w-24 text-right">{formatCurrency(amount)}</span>
              <span className="truncate text-muted-foreground flex-1">
                {line.line_description || line.entry_description}
              </span>
              {strength && (
                strength.variant ? (
                  <Badge variant={strength.variant} className="shrink-0 text-[11px]">
                    {strength.label}
                  </Badge>
                ) : (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{strength.label}</span>
                )
              )}
              {(line.linked_transaction_count ?? 0) > 0 && (
                <Badge variant="secondary" className="shrink-0 text-[11px]">
                  Matchad
                </Badge>
              )}
            </button>
          )
        })}
        {glLines.length > filtered.length && (
          <div className="px-3 py-2 text-[11px] text-muted-foreground border-t border-border bg-secondary/30">
            Visar {filtered.length} av {glLines.length}: sök för att filtrera fler.
          </div>
        )}
      </div>
    )

  const searchBox = (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="pl-9"
      />
    </div>
  )

  // The picks so far, each removable, above the search.
  const chips =
    pickedLines.length > 0 ? (
      <div className="space-y-1.5">
        {pickedLines.map((line) => (
          <div key={line.journal_entry_id}>
            {renderChip(line, () => onToggle(line.journal_entry_id))}
          </div>
        ))}
      </div>
    ) : null

  // The list lives in normal flow so it can never be clipped by a scroll
  // container (Dialog). The enclosing modal scrolls if the whole thing is tall.
  return (
    <div className="space-y-2">
      {chips}
      {searchBox}
      <div className="overflow-hidden rounded-lg border border-border bg-popover">
        {listContent}
      </div>
    </div>
  )
}
