'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'

type RecurringLineType =
  | 'gross_deduction_pension'
  | 'gross_deduction_other'
  | 'net_deduction_union'
  | 'net_deduction_benefit_payment'
  | 'net_deduction_other'
  | 'other'

interface EmployeeRecurringLine {
  id: string
  item_type: RecurringLineType
  description: string
  amount: number
  account_number: string | null
  valid_from: string
  valid_to: string | null
  metadata: Record<string, unknown>
  is_active: boolean
}

// Swedish defaults written to the DB when the description is left empty:
// stored data stays Swedish regardless of the viewer's UI locale.
const LINE_LABELS: Record<RecurringLineType, string> = {
  gross_deduction_pension: 'Bruttolöneavdrag pension (löneväxling)',
  gross_deduction_other: 'Bruttolöneavdrag',
  net_deduction_union: 'Fackavgift',
  net_deduction_benefit_payment: 'Nettolöneavdrag förmån',
  net_deduction_other: 'Nettolöneavdrag',
  other: 'Återkommande tillägg',
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

  const [type, setType] = useState<RecurringLineType>('gross_deduction_other')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [validFrom, setValidFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [validTo, setValidTo] = useState('')

  const isDeduction = type !== 'other'

  async function load() {
    setLoading(true)
    const res = await fetch(`/api/salary/employees/${employeeId}/recurring-lines`)
    if (res.ok) {
      const { data } = await res.json()
      setLines(data || [])
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId])

  function reset() {
    setType('gross_deduction_other')
    setDescription('')
    setAmount('')
    setValidFrom(new Date().toISOString().slice(0, 10))
    setValidTo('')
    setAdding(false)
  }

  async function handleAdd() {
    setSubmitting(true)
    // The field takes a positive number; deductions are stored negative so the
    // payslip math reads the sign from the row.
    const magnitude = Math.abs(parseFloat(amount) || 0)
    const body: Record<string, unknown> = {
      item_type: type,
      description: description || LINE_LABELS[type],
      amount: isDeduction ? -magnitude : magnitude,
      valid_from: validFrom,
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
    setSubmitting(false)
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/salary/employees/${employeeId}/recurring-lines/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: t('recurring_removed') })
      await load()
    } else {
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
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('recurring_empty')}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {lines.map((l) => {
            const typeLabel = t(`recurring_type_${l.item_type}`)
            // The description defaults to the Swedish type label when left
            // empty on creation; repeating it next to the type says nothing.
            const showDescription =
              !!l.description &&
              l.description !== typeLabel &&
              l.description !== LINE_LABELS[l.item_type]
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
                <span className="ml-auto tabular-nums">
                  {formatCurrency(l.amount)}
                  <span className="text-muted-foreground">{t('recurring_per_month')}</span>
                </span>
                {canWrite && (
                  <button type="button" onClick={() => handleDelete(l.id)} className={ROW_ACTION_CLASS}>
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
                <Select value={type} onValueChange={(v) => setType(v as RecurringLineType)}>
                  <SelectTrigger id="recurring_type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(LINE_LABELS) as RecurringLineType[]).map(k => (
                      <SelectItem key={k} value={k}>{t(`recurring_type_${k}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="recurring_description">{t('recurring_description')}</Label>
                <Input
                  id="recurring_description"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t(`recurring_type_${type}`)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="recurring_amount">
                {isDeduction ? t('recurring_amount_deduction') : t('recurring_amount_addition')}
              </Label>
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
              <p className="text-xs text-muted-foreground">
                {isDeduction ? t('recurring_deduction_hint') : t('recurring_addition_hint')}
              </p>
            </div>

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
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={reset} disabled={submitting}>{t('form_cancel')}</Button>
            <Button type="button" onClick={handleAdd} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('form_save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DetailSection>
  )
}
