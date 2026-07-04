'use client'

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import Fuse from 'fuse.js'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus, Trash2, AlertTriangle, Scale } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'

export interface EditableRow {
  id: string
  account_number: string
  account_name: string
  debit_amount: number
  credit_amount: number
  validation_errors: string[]
  bas_match: string | null
}

export interface OpeningBalanceEditorState {
  rows: EditableRow[]
  totals: { debit: number; credit: number; diff: number; isBalanced: boolean }
  /** Balanced, no row errors, and at least two lines: safe to book/correct. */
  canSubmit: boolean
}

interface OpeningBalanceRowEditorProps {
  /** Seed rows. Read once on mount (later prop changes are ignored: remount
   *  via `key` or a conditional render to reset the grid). */
  initialRows: EditableRow[]
  /** Fires whenever rows / totals / validity change. Held in a ref internally,
   *  so it does NOT need to be referentially stable: passing an inline arrow
   *  is safe and will not cause an update-loop. */
  onChange: (state: OpeningBalanceEditorState) => void
}

// Balance-sheet accounts (class 1-2) drive the primary suggestions; numeric
// queries fall back to the full chart.
const BALANCE_SHEET_ACCOUNTS = BAS_REFERENCE.filter(
  (a) => a.account_class === 1 || a.account_class === 2,
)
const ALL_BAS_ACCOUNTS = BAS_REFERENCE

let fuseInstance: Fuse<(typeof BAS_REFERENCE)[0]> | null = null
function getFuse() {
  if (!fuseInstance) {
    fuseInstance = new Fuse(ALL_BAS_ACCOUNTS, {
      keys: ['account_number', 'account_name'],
      threshold: 0.3,
      includeScore: true,
    })
  }
  return fuseInstance
}

let balanceFuseInstance: Fuse<(typeof BAS_REFERENCE)[0]> | null = null
function getBalanceFuse() {
  if (!balanceFuseInstance) {
    balanceFuseInstance = new Fuse(BALANCE_SHEET_ACCOUNTS, {
      keys: ['account_number', 'account_name'],
      threshold: 0.3,
      includeScore: true,
    })
  }
  return balanceFuseInstance
}

let idCounter = 0
function generateId() {
  return `row_${++idCounter}_${Date.now()}`
}

// Defense-in-depth dedup: if a seed source ever leaks duplicate accounts,
// collapse them before the user sees them. Union validation_errors so a
// warning surfaced only on the later row isn't silently dropped on merge.
function dedupeRows(initialRows: EditableRow[]): EditableRow[] {
  const byAccount = new Map<string, EditableRow>()
  for (const r of initialRows) {
    const key = r.account_number.replace(/\D/g, '')
    const existing = byAccount.get(key)
    if (existing) {
      existing.debit_amount = Math.round((existing.debit_amount + r.debit_amount) * 100) / 100
      existing.credit_amount = Math.round((existing.credit_amount + r.credit_amount) * 100) / 100
      if (!existing.account_name && r.account_name) existing.account_name = r.account_name
      if (r.validation_errors?.length) {
        const seen = new Set(existing.validation_errors)
        for (const err of r.validation_errors) {
          if (!seen.has(err)) existing.validation_errors.push(err)
        }
      }
      continue
    }
    byAccount.set(key, {
      id: r.id || generateId(),
      account_number: r.account_number,
      account_name: r.account_name,
      debit_amount: r.debit_amount,
      credit_amount: r.credit_amount,
      validation_errors: [...r.validation_errors],
      bas_match: r.bas_match,
    })
  }
  return Array.from(byAccount.values())
}

/**
 * The opening-balance line grid: editable account / debet / kredit rows with
 * BAS autocomplete, a live debit-credit balance check, blocking of resultat-
 * konton (class 3-8), and a "round to 2099" auto-balance for sub-1-SEK drift.
 *
 * Stateless about WHY it's editing: the wizard seeds it from a parsed file,
 * the verifikat correction dialog seeds it from the booked IB's lines. Both
 * read the current rows + validity through `onChange`.
 */
export default function OpeningBalanceRowEditor({
  initialRows,
  onChange,
}: OpeningBalanceRowEditorProps) {
  const [rows, setRows] = useState<EditableRow[]>(() => dedupeRows(initialRows))
  const [activeAutocomplete, setActiveAutocomplete] = useState<string | null>(null)
  const [autocompleteQuery, setAutocompleteQuery] = useState('')
  const autocompleteRef = useRef<HTMLDivElement>(null)

  // Hold onChange in a ref so an unstable (inline) callback identity can't
  // retrigger the notifying effect below. Synced after each commit rather than
  // during render (react-hooks/refs: refs must not be written while rendering).
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  const totals = useMemo(() => {
    let debit = 0
    let credit = 0
    for (const row of rows) {
      debit = Math.round((debit + row.debit_amount) * 100) / 100
      credit = Math.round((credit + row.credit_amount) * 100) / 100
    }
    const diff = Math.round((debit - credit) * 100) / 100
    return { debit, credit, diff, isBalanced: Math.abs(diff) < 0.01 }
  }, [rows])

  const hasErrors = useMemo(() => {
    return rows.some((r) => {
      if (!/^\d{4}$/.test(r.account_number)) return true
      if (r.debit_amount === 0 && r.credit_amount === 0) return true
      if (r.validation_errors.length > 0) return true
      return false
    })
  }, [rows])

  const canSubmit = totals.isBalanced && !hasErrors && rows.length >= 2

  // Push state up via the ref so an unstable `onChange` identity can't retrigger
  // this effect. Memoised `totals` means it only fires when the user actually
  // edits a row, never in a loop.
  useEffect(() => {
    onChangeRef.current({ rows, totals, canSubmit })
  }, [rows, totals, canSubmit])

  const autocompleteResults = useMemo(() => {
    if (!autocompleteQuery || autocompleteQuery.length < 1) return []
    const isNumeric = /^\d+$/.test(autocompleteQuery)
    const fuse = isNumeric ? getFuse() : getBalanceFuse()
    return fuse.search(autocompleteQuery, { limit: 8 }).map((r) => r.item)
  }, [autocompleteQuery])

  const updateRow = useCallback((id: string, updates: Partial<EditableRow>) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r
        const updated = { ...r, ...updates }

        // Re-validate
        const errors: string[] = []
        if (!/^\d{4}$/.test(updated.account_number)) {
          errors.push('Ogiltigt kontonummer')
        }
        const cls = parseInt(updated.account_number.charAt(0), 10)
        if (cls >= 3 && cls <= 8) {
          errors.push(`Resultatkonto (klass ${cls})`)
        }
        updated.validation_errors = errors

        return updated
      }),
    )
  }, [])

  const deleteRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const addRow = useCallback(() => {
    setRows((prev) => [
      ...prev,
      {
        id: generateId(),
        account_number: '',
        account_name: '',
        debit_amount: 0,
        credit_amount: 0,
        validation_errors: ['Ogiltigt kontonummer'],
        bas_match: null,
      },
    ])
  }, [])

  const selectAutocompleteItem = useCallback(
    (rowId: string, account: (typeof BAS_REFERENCE)[0]) => {
      updateRow(rowId, {
        account_number: account.account_number,
        account_name: account.account_name,
        bas_match: account.account_name,
      })
      setActiveAutocomplete(null)
      setAutocompleteQuery('')
    },
    [updateRow],
  )

  const handleAutoBalance = useCallback(() => {
    if (Math.abs(totals.diff) > 1) return // Only auto-balance ≤ 1 SEK
    if (totals.isBalanced) return

    const adjustmentRow: EditableRow = {
      id: generateId(),
      account_number: '2099',
      account_name: 'Årets resultat',
      debit_amount: totals.diff > 0 ? 0 : Math.abs(totals.diff),
      credit_amount: totals.diff > 0 ? totals.diff : 0,
      validation_errors: [],
      bas_match: 'Årets resultat',
    }
    setRows((prev) => [...prev, adjustmentRow])
  }, [totals])

  return (
    <div className="space-y-4">
      {/* Table */}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left w-28">Konto</th>
              <th className="px-3 py-2 text-left">Kontonamn</th>
              <th className="px-3 py-2 text-right w-32">Debet</th>
              <th className="px-3 py-2 text-right w-32">Kredit</th>
              <th className="px-3 py-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  'border-b last:border-0',
                  row.validation_errors.length > 0 && 'bg-destructive/5',
                )}
              >
                <td className="px-3 py-1.5 relative">
                  <Input
                    value={row.account_number}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, '').slice(0, 4)
                      updateRow(row.id, { account_number: val })
                      setActiveAutocomplete(row.id)
                      setAutocompleteQuery(val)
                    }}
                    onFocus={() => {
                      setActiveAutocomplete(row.id)
                      setAutocompleteQuery(row.account_number)
                    }}
                    onBlur={() => {
                      // Delay to allow click on autocomplete items
                      setTimeout(() => setActiveAutocomplete(null), 200)
                    }}
                    placeholder="1930"
                    className="h-8 font-mono tabular-nums w-20"
                    maxLength={4}
                  />
                  {/* Autocomplete dropdown */}
                  {activeAutocomplete === row.id && autocompleteResults.length > 0 && (
                    <div
                      ref={autocompleteRef}
                      className="absolute z-50 top-full left-3 mt-1 w-72 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md"
                    >
                      {autocompleteResults.map((item) => (
                        <button
                          key={item.account_number}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            selectAutocompleteItem(row.id, item)
                          }}
                        >
                          <span className="font-mono text-muted-foreground tabular-nums">
                            {item.account_number}
                          </span>
                          <span className="truncate">{item.account_name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm truncate max-w-xs">{row.account_name}</span>
                    {row.validation_errors.length > 0 && (
                      <span
                        className="text-destructive shrink-0"
                        title={row.validation_errors.join(', ')}
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-1.5">
                  <Input
                    type="number"
                    value={row.debit_amount || ''}
                    onChange={(e) =>
                      updateRow(row.id, {
                        debit_amount: Math.round(parseFloat(e.target.value || '0') * 100) / 100,
                      })
                    }
                    placeholder="0,00"
                    className="h-8 text-right tabular-nums w-28"
                    min={0}
                    step={0.01}
                  />
                </td>
                <td className="px-3 py-1.5">
                  <Input
                    type="number"
                    value={row.credit_amount || ''}
                    onChange={(e) =>
                      updateRow(row.id, {
                        credit_amount: Math.round(parseFloat(e.target.value || '0') * 100) / 100,
                      })
                    }
                    placeholder="0,00"
                    className="h-8 text-right tabular-nums w-28"
                    min={0}
                    step={0.01}
                  />
                </td>
                <td className="px-3 py-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => deleteRow(row.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-medium">
              <td className="px-3 py-2" colSpan={2}>
                Summa
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {totals.debit.toLocaleString('sv-SE', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {totals.credit.toLocaleString('sv-SE', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </td>
              <td />
            </tr>
            {!totals.isBalanced && (
              <tr className="text-destructive">
                <td className="px-3 py-1 text-sm" colSpan={2}>
                  Differens
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-sm" colSpan={2}>
                  {totals.diff.toLocaleString('sv-SE', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  SEK
                </td>
                <td />
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {/* Actions row */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Lägg till rad
        </Button>
        {!totals.isBalanced && Math.abs(totals.diff) <= 1 && Math.abs(totals.diff) >= 0.01 && (
          <Button variant="outline" size="sm" onClick={handleAutoBalance}>
            <Scale className="h-3.5 w-3.5 mr-1.5" />
            Avrunda ({totals.diff > 0 ? '+' : ''}
            {totals.diff.toFixed(2)} till 2099)
          </Button>
        )}
      </div>

      {/* Warnings */}
      {!totals.isBalanced && Math.abs(totals.diff) > 1 && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
          <p className="text-sm text-warning">
            Debet och kredit balanserar inte. Differens:{' '}
            {totals.diff.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} SEK. Kontrollera
            beloppen innan du fortsätter.
          </p>
        </div>
      )}
    </div>
  )
}
