'use client'

import { useEffect, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronRightIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { DocumentReading, ReadingFields } from '@/lib/documents/reading/types'
import {
  buildFieldUpdate,
  editInputValue,
  evidenceLabelKey,
  fieldLabelKey,
  formatFieldValue,
  panelRows,
  personField,
  readingCurrency,
  sourceLabelKey,
  whereRead,
  type EditableFieldName,
  type FieldUpdateError,
  type PanelFieldName,
  type PanelRow,
} from '@/lib/inkorg/fields'

export interface DocumentFieldsPanelProps {
  /** The inbox item the reading belongs to: corrections are saved on it. */
  itemId: string
  /**
   * The item's one reading (GET the item with ?include=reading). Keep the
   * object stable between renders: a new reading replaces what the panel
   * shows, the person's unsaved edit included.
   */
  reading: DocumentReading | null | undefined
  /** Converted to a supplier invoice: the reading is frozen and nothing is editable. */
  locked?: boolean
  /** Unfold the list from the start; it starts folded behind its heading. */
  defaultOpen?: boolean
  /**
   * Inside a fold that already carries the heading (the focus view's "Uppgifter
   * från dokumentet"): the list only, without a heading and fold of its own.
   */
  embedded?: boolean
  /**
   * After a saved correction, with the item's merged reading. The field
   * already reads as the person's (Ditt val); re-read the item to get the
   * server's word on the rest.
   */
  onSaved?: (saved: { field: EditableFieldName; extractedData: Record<string, unknown> }) => void
}

/**
 * "Uppgifter från dokumentet": every field of the one reading with where it
 * came from and how far it can be trusted, page and quote on demand, and an
 * inline correction per field. A saved correction is the person's (Ditt val)
 * and a new reading never overwrites it (lib/documents/person-corrections.ts).
 * What shows and what a save sends is decided in lib/inkorg/fields.ts.
 */
export function DocumentFieldsPanel({ itemId, reading, locked = false, defaultOpen = false, embedded = false, onSaved }: DocumentFieldsPanelProps) {
  const t = useTranslations('inkorg_fields')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [saved, setSaved] = useState<ReadingFields>({})
  const [editing, setEditing] = useState<EditableFieldName | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<FieldUpdateError | null>(null)
  const [saving, setSaving] = useState(false)
  const [shownWhere, setShownWhere] = useState<PanelFieldName | null>(null)
  const [linesOpen, setLinesOpen] = useState(false)
  const errorId = useId()

  // A new item or a re-read replaces everything shown locally.
  useEffect(() => {
    setSaved({})
    setEditing(null)
    setError(null)
    setShownWhere(null)
  }, [itemId, reading])

  const fields = useMemo<ReadingFields>(() => ({ ...(reading?.fields ?? {}), ...saved }), [reading, saved])
  const rows = panelRows({ fields }, { locked })
  const currency = readingCurrency({ fields })

  function startEdit(row: PanelRow & { name: EditableFieldName }) {
    setEditing(row.name)
    setDraft(editInputValue(row.name, row.field?.value ?? null))
    setError(null)
  }

  function cancelEdit() {
    setEditing(null)
    setError(null)
  }

  async function save(event: FormEvent, row: PanelRow & { name: EditableFieldName }) {
    event.preventDefault()
    const update = buildFieldUpdate(row.name, draft)
    if (!update.ok) {
      setError(update.error)
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}/fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update.body),
      })
      const json = (await res.json().catch(() => null)) as { data?: { extracted_data?: Record<string, unknown> } } | null
      if (!res.ok) {
        toast({
          title: getErrorMessage(json, { statusCode: res.status, locale, fallback: t('save_failed') }),
          variant: 'destructive',
        })
        return
      }
      setSaved((prev) => ({ ...prev, [row.name]: personField(update.value, row.field) }))
      setEditing(null)
      onSaved?.({ field: row.name, extractedData: json?.data?.extracted_data ?? {} })
    } catch {
      toast({ title: t('save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  function onEditorKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      cancelEdit()
    }
  }

  const body = (
    <>
      <dl className="mt-2 divide-y divide-border">
        {rows.map((row) => {
          const label = t(fieldLabelKey(row.name))
          const shown = formatFieldValue(row.name, row.field?.value ?? null, currency)
          const where = whereRead(row.field)
          const whereId = `${errorId}-${row.name}-where`
          const isEditing = editing === row.name && row.editable
          return (
            <div key={row.name} className="grid grid-cols-1 gap-x-4 gap-y-1 py-2 sm:grid-cols-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="min-w-0 text-[13px] sm:col-span-2">
                {isEditing ? (
                  <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => void save(e, row as PanelRow & { name: EditableFieldName })}>
                    <Input
                      autoFocus
                      type={row.name === 'invoice_issue_date' || row.name === 'payment_due_date' ? 'date' : 'text'}
                      inputMode={row.name === 'amount_due_for_payment' ? 'decimal' : undefined}
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value)
                        setError(null)
                      }}
                      onKeyDown={onEditorKey}
                      aria-label={label}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? errorId : undefined}
                      className="min-w-0 flex-1 tabular-nums sm:max-w-sm"
                    />
                    <Button type="submit" loading={saving}>
                      {t('save')}
                    </Button>
                    <Button type="button" variant="ghost" onClick={cancelEdit} disabled={saving}>
                      {t('cancel')}
                    </Button>
                    {error && (
                      <p id={errorId} role="alert" className="w-full text-xs text-destructive">
                        {t(`errors.${error}`)}
                      </p>
                    )}
                  </form>
                ) : (
                  <>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <FieldValue
                        value={shown}
                        empty={t('empty')}
                        linesLabel={(count) => t('lines_count', { count })}
                        vatRow={(r) => t('vat_row', r)}
                        linesOpen={linesOpen}
                        onToggleLines={() => setLinesOpen((open) => !open)}
                        showLines={t('show_lines')}
                        hideLines={t('hide_lines')}
                      />
                      {row.editable && (
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => startEdit(row as PanelRow & { name: EditableFieldName })}
                          aria-label={t('edit_label', { field: label })}
                          disabled={editing !== null && editing !== row.name}
                        >
                          {t('edit')}
                        </Button>
                      )}
                    </div>
                    {row.field && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{t(sourceLabelKey(row.field.source))}</span>
                        <span aria-hidden>·</span>
                        <span className={cn(row.field.evidence === 'ditt_val' && 'text-foreground')}>
                          {t(evidenceLabelKey(row.field.evidence))}
                        </span>
                        {where && (
                          <Button
                            type="button"
                            variant="link"
                            className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                            aria-expanded={shownWhere === row.name}
                            aria-controls={whereId}
                            aria-label={t('where_label', { field: label })}
                            onClick={() => setShownWhere((open) => (open === row.name ? null : row.name))}
                          >
                            {shownWhere === row.name ? t('hide_where') : t('show_where')}
                          </Button>
                        )}
                      </div>
                    )}
                    {where && shownWhere === row.name && (
                      <p id={whereId} className="mt-1 animate-fade-in text-xs text-muted-foreground">
                        {where.page !== undefined && <span>{t('page', { page: where.page })}</span>}
                        {where.page !== undefined && where.quote && <span aria-hidden>: </span>}
                        {where.quote && <q className="break-words italic">{where.quote}</q>}
                      </p>
                    )}
                  </>
                )}
              </dd>
            </div>
          )
        })}
      </dl>
    </>
  )

  if (embedded) return <div>{body}</div>

  return (
    <details className="group" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-foreground transition-colors duration-150 hover:text-foreground/80 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="h-4 w-4 transition-transform duration-150 group-open:rotate-90" aria-hidden />
        {t('title')}
      </summary>
      {body}
    </details>
  )
}

function FieldValue({
  value,
  empty,
  linesLabel,
  vatRow,
  linesOpen,
  onToggleLines,
  showLines,
  hideLines,
}: {
  value: ReturnType<typeof formatFieldValue>
  empty: string
  linesLabel: (count: number) => string
  vatRow: (row: { rate: string; base: string; tax: string }) => string
  linesOpen: boolean
  onToggleLines: () => void
  showLines: string
  hideLines: string
}) {
  switch (value.kind) {
    case 'empty':
      return <span className="text-muted-foreground">{empty}</span>
    case 'text':
      return <span className={cn('break-words', value.numeric && 'tabular-nums')}>{value.text}</span>
    case 'vat':
      return (
        <ul className="space-y-1 tabular-nums">
          {value.rows.map((row, i) => (
            <li key={i}>{vatRow(row)}</li>
          ))}
        </ul>
      )
    case 'lines':
      return (
        <div className="min-w-0">
          <span>{linesLabel(value.rows.length)}</span>{' '}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={linesOpen}
            onClick={onToggleLines}
          >
            {linesOpen ? hideLines : showLines}
          </Button>
          {linesOpen && (
            <ul className="mt-1 animate-fade-in space-y-1">
              {value.rows.map((row, i) => (
                <li key={i} className="flex justify-between gap-4">
                  <span className="min-w-0 break-words">
                    {row.quantity !== '1' && <span className="tabular-nums text-muted-foreground">{row.quantity} × </span>}
                    {row.name}
                  </span>
                  <span className="shrink-0 tabular-nums">{row.amount}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )
  }
}
