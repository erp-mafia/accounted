'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DetailSection } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  RECURRING_LINE_ITEM_TYPES,
  RECURRING_LINE_LABELS,
  type RecurringLineItemType,
} from '@/lib/salary/recurring-lines'
import { TEXT_ROW_MAX_LENGTH, isTextRow, normalizeTextRow } from '@/lib/salary/text-rows'

interface EmployeeRecurringLine {
  id: string
  item_type: RecurringLineItemType
  description: string
  amount: number
  account_number: string | null
  valid_from: string
  valid_to: string | null
  metadata: Record<string, unknown>
  is_active: boolean
}

// In-row text action: same idiom as EmployeeBenefitsPanel.
const ROW_ACTION_CLASS =
  'text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-foreground disabled:opacity-50'

export function EmployeeRecurringLinesPanel({ employeeId, canWrite }: { employeeId: string; canWrite: boolean }) {
  const t = useTranslations('salary_employee')
  const { toast } = useToast()
  const [lines, setLines] = useState<EmployeeRecurringLine[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Monotonic request id: a reload issued after a create/delete must not be
  // overwritten by an earlier, slower in-flight load resolving late.
  const loadSeq = useRef(0)

  const [type, setType] = useState<RecurringLineItemType>('gross_deduction_other')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [validFrom, setValidFrom] = useState(() => todayIsoStockholm())
  const [validTo, setValidTo] = useState('')
  // Set when Spara is pressed on a Textrad without text.
  const [textMissing, setTextMissing] = useState(false)
  // A Textrad is words only: no amount, and no Swedish default text.
  const isText = isTextRow({ item_type: type })

  async function load() {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const res = await fetch(`/api/salary/employees/${employeeId}/recurring-lines`)
      if (res.ok) {
        const { data } = await res.json()
        if (seq === loadSeq.current) setLines(data || [])
      }
    } catch {
      // Network failure: keep whatever is shown; the empty/stale list plus
      // the still-enabled actions let the user retry.
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId])

  function reset() {
    setType('gross_deduction_other')
    setDescription('')
    setAmount('')
    setValidFrom(todayIsoStockholm())
    setValidTo('')
    setTextMissing(false)
    setAdding(false)
  }

  async function handleAdd() {
    const text = normalizeTextRow(description)
    if (isText && text === '') {
      setTextMissing(true)
      return
    }
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = { item_type: type, valid_from: validFrom }
      if (type === 'text') {
        // A text row carries its words and no amount.
        body.description = text
      } else {
        // The field takes a positive number; every other recurring line is
        // a deduction and is stored negative so the payslip math reads the
        // sign from the row.
        const magnitude = Math.abs(parseFloat(amount) || 0)
        body.description = description || RECURRING_LINE_LABELS[type]
        body.amount = -magnitude
      }
      if (validTo) body.valid_to = validTo

      const res = await fetch(`/api/salary/employees/${employeeId}/recurring-lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        toast({ title: t('recurring_added') })
        reset()
        await load()
      } else {
        const result = await res.json()
        toast({
          title: t('recurring_save_failed'),
          description: getErrorMessage(result, { statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: t('recurring_save_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/salary/employees/${employeeId}/recurring-lines/${id}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: t('recurring_removed') })
        await load()
      } else {
        toast({ title: t('recurring_remove_failed'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('recurring_remove_failed'), variant: 'destructive' })
    }
  }

  return (
    <DetailSection
      kicker={t('recurring_title')}
      help={<HelpPopover>{t('recurring_help')}</HelpPopover>}
      aside={
        canWrite ? (
          <Button type="button" size="sm" variant="outline" className="-my-1" onClick={() => setAdding(true)}>
            {t('recurring_add')}
          </Button>
        ) : undefined
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : lines.filter((l) => l.is_active).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('recurring_empty')}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {/* Deactivated lines are hidden: "Ta bort" soft-deactivates a line
              that has already been derived into a run, and showing it again
              would read as the delete having failed. */}
          {lines.filter((l) => l.is_active).map((l) => {
            const typeLabel = t(`recurring_type_${l.item_type}`)
            const text = l.item_type === 'text'
            // The description defaults to the Swedish type label when left
            // empty on creation; repeating it next to the type says nothing.
            // A text row's description is its words, always shown.
            const showDescription =
              !!l.description &&
              (l.item_type === 'text' ||
                (l.description !== typeLabel && l.description !== RECURRING_LINE_LABELS[l.item_type]))
            return (
              <li key={l.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="min-w-0 truncate">
                  {typeLabel}
                  {showDescription && (
                    <span className="text-muted-foreground">{' · '}{l.description}</span>
                  )}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatDate(l.valid_from)} → {l.valid_to ? formatDate(l.valid_to) : t('recurring_ongoing')}
                </span>
                {/* A text row has no amount: never "0,00 kr". */}
                {!text && (
                  <span className="ml-auto tabular-nums">
                    {formatCurrency(l.amount)}
                    <span className="text-muted-foreground">{t('recurring_per_month')}</span>
                  </span>
                )}
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => handleDelete(l.id)}
                    className={cn(ROW_ACTION_CLASS, text && 'ml-auto')}
                  >
                    {t('recurring_remove')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Add dialog (convention 13: centered modal for create). Closing by
          Escape or backdrop is the same as Avbryt; both are held while a
          save is in flight. */}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!open && !submitting) reset()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('recurring_add')}</DialogTitle>
            <DialogDescription>{t('recurring_help')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="recurring_type">{t('recurring_type')}</Label>
                <Select
                  value={type}
                  onValueChange={(v) => {
                    setType(v as RecurringLineItemType)
                    setTextMissing(false)
                  }}
                >
                  <SelectTrigger id="recurring_type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECURRING_LINE_ITEM_TYPES.map(k => (
                      <SelectItem key={k} value={k}>{t(`recurring_type_${k}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!isText && (
                <div className="space-y-2">
                  <Label htmlFor="recurring_description">{t('recurring_description')}</Label>
                  <Input
                    id="recurring_description"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder={t(`recurring_type_${type}`)}
                  />
                </div>
              )}
            </div>

            {isText ? (
              <div className="space-y-2">
                <Label htmlFor="recurring_text">{t('recurring_text')}</Label>
                <Textarea
                  id="recurring_text"
                  value={description}
                  onChange={e => {
                    setDescription(e.target.value)
                    setTextMissing(false)
                  }}
                  placeholder={t('recurring_text_placeholder')}
                  maxLength={TEXT_ROW_MAX_LENGTH}
                  required
                  aria-invalid={textMissing || undefined}
                />
                <p
                  className={textMissing ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
                  aria-live="polite"
                >
                  {textMissing
                    ? t('recurring_text_required', { max: TEXT_ROW_MAX_LENGTH })
                    : t('recurring_text_hint')}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="recurring_amount">{t('recurring_amount_deduction')}</Label>
                <Input
                  id="recurring_amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder={t('recurring_amount_placeholder')}
                  className="max-w-xs"
                />
                <p className="text-xs text-muted-foreground">{t('recurring_deduction_hint')}</p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="recurring_valid_from">{t('recurring_valid_from')}</Label>
                <Input id="recurring_valid_from" type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="recurring_valid_to">{t('recurring_valid_to')}</Label>
                <Input id="recurring_valid_to" type="date" value={validTo} onChange={e => setValidTo(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('recurring_window_hint')}</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={reset} disabled={submitting}>{t('form_cancel')}</Button>
            <Button type="button" onClick={handleAdd} loading={submitting}>
              {t('form_save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DetailSection>
  )
}
