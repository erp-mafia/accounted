'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Trash2, Loader2, Check, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { parseHoursInput } from '@/lib/salary/parse-hours'

export interface RunEmployeeOption {
  /** salary_run_employees.id — links the new rows to this run. */
  sreId: string
  employeeId: string
  name: string
  salaryType: string
  /** Masked personnummer for display (e.g. 19900101-XXXX). */
  personnummer?: string | null
  /** Last 4 digits, used for search matching. */
  personnummerLast4?: string | null
}

/** An already-saved worked-day / absence-day row for the period. */
export interface ExistingTimeEntry {
  employeeId: string
  /** WORKED sentinel or an absence type. */
  kind: string
  date: string
  hours: number
  notes: string | null
}

interface BulkTimeEntryTableProps {
  periodStart: string
  periodEnd: string
  employees: RunEmployeeOption[]
  /** Worked + absence rows already saved for the period, pre-loaded for editing. */
  initialEntries?: ExistingTimeEntry[]
  /** Disable all editing (e.g. once the run is approved/booked). */
  readOnly?: boolean
  /** Called after a save or delete changed server state, so the parent can refresh totals. */
  onChanged?: () => void
}

// Worked-time sentinel vs the absence types. Worked hours only apply to hourly
// employees; absence applies to everyone.
const WORKED = 'worked'

const ABSENCE_TYPES: { value: string; label: string }[] = [
  { value: 'sick', label: 'Sjukdom' },
  { value: 'vab', label: 'VAB' },
  { value: 'parental', label: 'Föräldraledig' },
  { value: 'pregnancy', label: 'Graviditetspenning' },
  { value: 'care_relative', label: 'Närståendepenning' },
  { value: 'study', label: 'Studieledig' },
  { value: 'other_leave', label: 'Övrig ledighet' },
]

type RowStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

/** The natural key of a saved record, used to overwrite/delete the right row. */
interface RowSnapshot {
  employeeId: string
  date: string
  kind: string
  hours: string
  notes: string
}

interface EntryRow {
  key: string
  origin: 'new' | 'existing'
  /** Snapshot of the saved record (for existing rows) so edits to the natural
   *  key can delete the old record before writing the new one. */
  original?: RowSnapshot
  employeeId: string
  kind: string
  date: string
  hours: string
  notes: string
  status: RowStatus
  message?: string
}

export function BulkTimeEntryTable({
  periodStart,
  periodEnd,
  employees,
  initialEntries,
  readOnly = false,
  onChanged,
}: BulkTimeEntryTableProps) {
  const rowSeq = useRef(0)
  const nextKey = () => `r${rowSeq.current++}`

  const blankRow = (): EntryRow => ({
    key: nextKey(),
    origin: 'new',
    employeeId: '',
    kind: '',
    date: periodStart,
    hours: '8',
    notes: '',
    status: 'idle',
  })

  // Build the initial row set from existing entries (editable). Only when there
  // are none do we seed a single blank row to start from — otherwise the user
  // adds rows explicitly via "Lägg till rad". Runs once — the parent gates
  // rendering until entries are loaded, so this initializer sees the full list.
  // Static keys here (no ref reads during render); addRow uses nextKey() with
  // its own prefix so there's no collision.
  const [rows, setRows] = useState<EntryRow[]>(() => {
    const existing: EntryRow[] = (initialEntries ?? []).map((e, i) => {
      const hours = String(e.hours)
      const notes = e.notes ?? ''
      return {
        key: `e${i}`,
        origin: 'existing' as const,
        original: { employeeId: e.employeeId, date: e.date, kind: e.kind, hours, notes },
        employeeId: e.employeeId,
        kind: e.kind,
        date: e.date,
        hours,
        notes,
        status: 'idle' as RowStatus,
      }
    })
    if (existing.length > 0) return existing
    // No saved entries yet — start with one blank row.
    const blank: EntryRow = {
      key: 'new0',
      origin: 'new',
      employeeId: '',
      kind: '',
      date: periodStart,
      hours: '8',
      notes: '',
      status: 'idle',
    }
    return [blank]
  })
  const [submitting, setSubmitting] = useState(false)

  const employeeById = useMemo(() => {
    const m = new Map<string, RunEmployeeOption>()
    for (const e of employees) m.set(e.employeeId, e)
    return m
  }, [employees])

  // Worked time is only offered for hourly employees; everyone can take absence.
  const kindOptionsFor = (employeeId: string): { value: string; label: string }[] => {
    const emp = employeeById.get(employeeId)
    const base = emp && emp.salaryType === 'hourly'
      ? [{ value: WORKED, label: 'Arbetad tid' }]
      : []
    return [...base, ...ABSENCE_TYPES]
  }

  const update = (key: string, patch: Partial<EntryRow>) => {
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch, status: 'idle', message: undefined } : r)))
  }

  const onEmployeeChange = (key: string, employeeId: string) => {
    setRows(prev => prev.map(r => {
      if (r.key !== key) return r
      // Reset a now-invalid kind (e.g. switched to a monthly employee while
      // "Arbetad tid" was selected).
      const allowed = kindOptionsFor(employeeId).map(o => o.value)
      const kind = allowed.includes(r.kind) ? r.kind : ''
      return { ...r, employeeId, kind, status: 'idle', message: undefined }
    }))
  }

  const addRow = () => setRows(prev => [...prev, blankRow()])

  const validateRow = (r: EntryRow): string | null => {
    if (!r.employeeId) return 'Välj anställd'
    if (!r.kind) return 'Välj typ'
    if (!r.date || r.date < periodStart || r.date > periodEnd) return 'Datum utanför perioden'
    const h = parseHoursInput(r.hours)
    if (h == null || h <= 0 || h > 24) return 'Timmar måste vara mellan 0 och 24'
    return null
  }

  const isBlankNew = (r: EntryRow) => r.origin === 'new' && !r.employeeId && !r.kind
  const isDirty = (r: EntryRow) => {
    if (r.origin === 'new') return !isBlankNew(r)
    const o = r.original
    if (!o) return true
    return o.employeeId !== r.employeeId || o.date !== r.date || o.kind !== r.kind
      || o.hours !== r.hours || o.notes !== r.notes
  }

  const keyChanged = (r: EntryRow) =>
    !!r.original && (r.original.employeeId !== r.employeeId || r.original.date !== r.date || r.original.kind !== r.kind)

  // Delete a saved record by its natural key.
  const deleteEntry = async (employeeId: string, kind: string, date: string): Promise<{ ok: boolean; message?: string }> => {
    const url = kind === WORKED
      ? `/api/salary/employees/${employeeId}/worked-hours?date=${date}`
      : `/api/salary/employees/${employeeId}/absence?date=${date}&type=${kind}`
    try {
      const res = await fetch(url, { method: 'DELETE' })
      if (res.ok) return { ok: true }
      const json = await res.json().catch(() => ({}))
      return { ok: false, message: json.error || 'Kunde inte ta bort befintlig rad' }
    } catch {
      return { ok: false, message: 'Nätverksfel' }
    }
  }

  const postEntry = async (r: EntryRow, hours: number, sreId: string): Promise<{ status: RowStatus; message?: string }> => {
    try {
      const res = r.kind === WORKED
        ? await fetch(`/api/salary/employees/${r.employeeId}/worked-hours`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ work_date: r.date, hours, notes: r.notes.trim() || undefined, salary_run_employee_id: sreId }),
          })
        : await fetch(`/api/salary/employees/${r.employeeId}/absence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ absence_date: r.date, absence_type: r.kind, hours, notes: r.notes.trim() || undefined, salary_run_employee_id: sreId }),
          })
      if (res.ok) return { status: 'saved' }
      const json = await res.json().catch(() => ({}))
      // 409 = the 24h-per-day cap across worked + absence was exceeded.
      if (res.status === 409) return { status: 'conflict', message: json.error || 'Överstiger 24 timmar för dagen' }
      return { status: 'error', message: json.error || 'Kunde inte spara' }
    } catch {
      return { status: 'error', message: 'Nätverksfel' }
    }
  }

  const saveRow = async (r: EntryRow): Promise<{ status: RowStatus; message?: string }> => {
    const invalid = validateRow(r)
    if (invalid) return { status: 'error', message: invalid }

    const emp = employeeById.get(r.employeeId)
    if (!emp) return { status: 'error', message: 'Okänd anställd' }
    const hours = parseHoursInput(r.hours)
    if (hours == null) return { status: 'error', message: 'Ogiltiga timmar' }

    // If the natural key moved, remove the old record first so we don't leave
    // an orphan at the previous employee/date/type.
    if (keyChanged(r) && r.original) {
      const del = await deleteEntry(r.original.employeeId, r.original.kind, r.original.date)
      if (!del.ok) return { status: 'error', message: del.message }
    }

    return postEntry(r, hours, emp.sreId)
  }

  const handleSaveAll = async () => {
    setSubmitting(true)
    let changed = 0
    // Sequential so per-row conflicts surface against the right row and the
    // 24h-cap trigger sees a consistent picture as rows land.
    for (const r of rows) {
      if (isBlankNew(r)) continue
      if (r.origin === 'existing' && !isDirty(r)) continue
      setRows(prev => prev.map(x => (x.key === r.key ? { ...x, status: 'saving', message: undefined } : x)))
      const result = await saveRow(r)
      if (result.status === 'saved') {
        changed++
        // Re-snapshot so a second save is an in-place overwrite, not a duplicate.
        setRows(prev => prev.map(x => (x.key === r.key
          ? { ...x, status: 'saved', message: undefined, origin: 'existing',
              original: { employeeId: x.employeeId, date: x.date, kind: x.kind, hours: x.hours, notes: x.notes } }
          : x)))
      } else {
        setRows(prev => prev.map(x => (x.key === r.key ? { ...x, status: result.status, message: result.message } : x)))
      }
    }
    setSubmitting(false)
    if (changed > 0) onChanged?.()
  }

  const handleRemove = async (r: EntryRow) => {
    // New, never-saved rows are removed locally. Existing rows delete the saved
    // record first.
    if (r.origin === 'new') {
      setRows(prev => prev.filter(x => x.key !== r.key))
      return
    }
    const o = r.original ?? { employeeId: r.employeeId, kind: r.kind, date: r.date }
    setRows(prev => prev.map(x => (x.key === r.key ? { ...x, status: 'saving', message: undefined } : x)))
    const del = await deleteEntry(o.employeeId, o.kind, o.date)
    if (del.ok) {
      setRows(prev => prev.filter(x => x.key !== r.key))
      onChanged?.()
    } else {
      setRows(prev => prev.map(x => (x.key === r.key ? { ...x, status: 'error', message: del.message } : x)))
    }
  }

  const savedRows = rows.filter(r => r.status === 'saved').length
  const problemRows = rows.filter(r => r.status === 'error' || r.status === 'conflict').length

  if (employees.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Lägg till anställda i lönekörningen först, så kan du registrera tid här.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* Raw table (not the Table primitive) so the employee combobox dropdown
          isn't clipped by the primitive's overflow-auto wrapper. border-collapse
          so the per-row border-b dividers paint as clean full-width lines. */}
      <table className="w-full border-collapse text-sm">
        <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
          <tr className="border-b text-left">
            <th className="py-2 pr-2 min-w-[200px]">Anställd</th>
            <th className="py-2 px-2 min-w-[150px]">Typ</th>
            <th className="py-2 px-2 w-40">Datum</th>
            <th className="py-2 px-2 w-36">Timmar</th>
            <th className="py-2 px-2 min-w-[140px]">Anteckning</th>
            <th className="py-2 px-2 w-24">Status</th>
            <th className="py-2 w-10" />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const kindOptions = kindOptionsFor(r.employeeId)
            return (
              <tr key={r.key} className="border-b align-top">
                <td className="py-1.5 pr-2">
                  <EmployeeCombobox
                    value={r.employeeId}
                    employees={employees}
                    onChange={(id) => onEmployeeChange(r.key, id)}
                    disabled={readOnly || submitting}
                  />
                </td>
                <td className="py-1.5 px-2">
                  <Select
                    value={r.kind}
                    onValueChange={(v) => update(r.key, { kind: v })}
                    disabled={readOnly || submitting || !r.employeeId}
                  >
                    <SelectTrigger className="h-8"><SelectValue placeholder="Välj typ" /></SelectTrigger>
                    <SelectContent>
                      {kindOptions.map(o => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="py-1.5 px-2">
                  <Input
                    type="date"
                    value={r.date}
                    min={periodStart}
                    max={periodEnd}
                    onChange={(e) => update(r.key, { date: e.target.value })}
                    disabled={readOnly || submitting}
                    className="h-8 tabular-nums"
                  />
                </td>
                <td className="py-1.5 px-2">
                  <Input
                    type="text"
                    value={r.hours}
                    onChange={(e) => update(r.key, { hours: e.target.value })}
                    disabled={readOnly || submitting}
                    placeholder="8 el. 1740-2240"
                    className="h-8 tabular-nums"
                  />
                  {(() => {
                    // Show the computed hours when a time range was typed.
                    if (!/[-–—]/.test(r.hours)) return null
                    const parsed = parseHoursInput(r.hours)
                    return (
                      <div className={cn('mt-0.5 text-[11px] tabular-nums', parsed == null ? 'text-destructive' : 'text-muted-foreground')}>
                        {parsed == null ? 'Ogiltigt intervall' : `= ${parsed} tim`}
                      </div>
                    )
                  })()}
                </td>
                <td className="py-1.5 px-2">
                  <Input
                    value={r.notes}
                    maxLength={2000}
                    onChange={(e) => update(r.key, { notes: e.target.value })}
                    disabled={readOnly || submitting}
                    className="h-8"
                    placeholder="Valfri"
                  />
                </td>
                <td className="py-1.5 px-2">
                  <RowStatusCell status={r.status} message={r.message} />
                </td>
                <td className="py-1.5">
                  {!readOnly && (rows.length > 1 || r.origin === 'existing') && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleRemove(r)}
                      disabled={submitting}
                      aria-label="Ta bort rad"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {problemRows > 0 && (
        <ul className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {rows.map((r, i) =>
            (r.status === 'error' || r.status === 'conflict') && r.message ? (
              <li key={r.key}>Rad {i + 1}: {r.message}</li>
            ) : null,
          )}
        </ul>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="outline" size="sm" onClick={addRow} disabled={readOnly || submitting}>
          <Plus className="mr-1 h-4 w-4" /> Lägg till rad
        </Button>
        <div className="flex items-center gap-3">
          {(savedRows > 0 || problemRows > 0) && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {savedRows} sparade{problemRows > 0 ? `, ${problemRows} med fel` : ''}
            </span>
          )}
          <Button onClick={handleSaveAll} disabled={readOnly || submitting}>
            {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Spara alla rader
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Searchable employee picker ─────────────────────────────────────
// Type a name or personnummer to filter. Mirrors the AccountCombobox pattern
// (Input + absolutely-positioned dropdown) since the project has no shared
// combobox/command primitive.
function EmployeeCombobox({
  value,
  employees,
  onChange,
  disabled,
}: {
  value: string
  employees: RunEmployeeOption[]
  onChange: (employeeId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  const selected = employees.find(e => e.employeeId === value)

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return employees
    const digits = q.replace(/\D/g, '')
    return employees.filter(e => {
      if (e.name.toLowerCase().includes(q)) return true
      if (digits.length === 0) return false
      const last4 = (e.personnummerLast4 ?? '').replace(/\D/g, '')
      const masked = (e.personnummer ?? '').replace(/\D/g, '')
      return last4.includes(digits) || masked.includes(digits)
    })
  }, [employees, search])

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={open ? search : (selected?.name ?? '')}
        placeholder="Sök namn eller personnr"
        disabled={disabled}
        onFocus={() => { setOpen(true); setSearch('') }}
        onChange={(e) => { setSearch(e.target.value); if (!open) setOpen(true) }}
        className="h-8"
      />
      {open && !disabled && (
        <div className="absolute z-50 mt-1 max-h-56 w-full min-w-[220px] overflow-auto rounded-md border border-border bg-background shadow-md">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Inga träffar</div>
          ) : (
            filtered.map(e => (
              <button
                type="button"
                key={e.employeeId}
                onClick={() => { onChange(e.employeeId); setOpen(false); setSearch('') }}
                className={cn(
                  'flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-secondary/60',
                  e.employeeId === value && 'bg-secondary/40',
                )}
              >
                <span className="text-sm">{e.name}</span>
                {e.personnummer && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">{e.personnummer}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function RowStatusCell({ status, message }: { status: RowStatus; message?: string }) {
  if (status === 'saving') {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  }
  if (status === 'saved') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <Check className="h-3.5 w-3.5" /> Sparad
      </span>
    )
  }
  if (status === 'error' || status === 'conflict') {
    // Keep the cell compact — the full message would crowd the row, so show a
    // short label here (hover for detail) and list messages below the table.
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive" title={message}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {status === 'conflict' ? 'Konflikt' : 'Fel'}
      </span>
    )
  }
  return null
}
