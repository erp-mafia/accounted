'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Deadline, DeadlineType, DeadlinePriority } from '@/types'
import { formatDateISO, DEADLINE_TYPE_LABELS, PRIORITY_LABELS } from '@/lib/calendar/utils'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import CustomerCombobox from '@/components/customers/CustomerCombobox'
import { Lock } from 'lucide-react'

/**
 * Only the fields the form actually manages. Both API routes whitelist to
 * this set; the form must never fabricate values for system fields (source,
 * status, reminder_offsets, tax_*), or editing a system-generated tax
 * deadline would depend on the server whitelist alone to avoid data loss.
 */
export type DeadlineFormValues = Pick<
  Deadline,
  'title' | 'due_date' | 'due_time' | 'deadline_type' | 'priority' | 'customer_id' | 'notes'
>

interface DeadlineFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: DeadlineFormValues) => Promise<void>
  onDelete?: (deadline: Partial<Deadline>) => void
  initialData?: Partial<Deadline>
  initialDate?: Date | null
  customers: { id: string; name: string }[]
}

export function DeadlineForm({
  open,
  onOpenChange,
  onSubmit,
  onDelete,
  initialData,
  initialDate,
  customers,
}: DeadlineFormProps) {
  const t = useTranslations('deadline_form')
  const tc = useTranslations('common')
  const td = useTranslations('deadlines')
  const typeLabel = (value: string): string => {
    switch (value) {
      case 'delivery': return t('type_delivery')
      case 'approval': return t('type_approval')
      case 'invoicing': return t('type_invoicing')
      case 'report': return t('type_report')
      case 'revision': return t('type_revision')
      case 'other': return t('type_other')
      default: return DEADLINE_TYPE_LABELS[value] ?? value
    }
  }
  const priorityLabel = (value: string): string => {
    switch (value) {
      case 'critical': return t('priority_critical')
      case 'important': return t('priority_important')
      case 'normal': return t('priority_normal')
      default: return PRIORITY_LABELS[value] ?? value
    }
  }
  const { canWrite } = useCanWrite()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [formData, setFormData] = useState({
    title: '',
    due_date: '',
    due_time: '',
    deadline_type: 'other' as DeadlineType,
    priority: 'normal' as DeadlinePriority,
    customer_id: '',
    notes: '',
  })

  // Reset form when dialog opens with new data
  useEffect(() => {
    if (open) {
      setConfirmDelete(false)
      if (initialData) {
        setFormData({
          title: initialData.title || '',
          due_date: initialData.due_date || formatDateISO(new Date()),
          due_time: initialData.due_time || '',
          deadline_type: initialData.deadline_type || 'other',
          priority: initialData.priority || 'normal',
          customer_id: initialData.customer_id || '',
          notes: initialData.notes || '',
        })
      } else if (initialDate) {
        setFormData({
          title: '',
          due_date: formatDateISO(initialDate),
          due_time: '',
          deadline_type: 'other',
          priority: 'normal',
          customer_id: '',
          notes: '',
        })
      } else {
        setFormData({
          title: '',
          due_date: formatDateISO(new Date()),
          due_time: '',
          deadline_type: 'other',
          priority: 'normal',
          customer_id: '',
          notes: '',
        })
      }
    }
  }, [open, initialData, initialDate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      await onSubmit({
        title: formData.title,
        due_date: formData.due_date,
        due_time: formData.due_time || null,
        deadline_type: formData.deadline_type,
        priority: formData.priority,
        customer_id: formData.customer_id || null,
        notes: formData.notes || null,
      })
    } finally {
      setIsLoading(false)
    }
  }

  const updateField = <K extends keyof typeof formData>(
    field: K,
    value: (typeof formData)[K]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initialData?.id ? t('edit_title') : t('new_title')}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">{t('title_label')}</Label>
            <Input
              id="title"
              placeholder={t('title_placeholder')}
              value={formData.title}
              onChange={(e) => updateField('title', e.target.value)}
              required
            />
          </div>

          {/* Date and Time */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="due_date">{t('date_label')}</Label>
              <Input
                id="due_date"
                type="date"
                value={formData.due_date}
                onChange={(e) => updateField('due_date', e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="due_time">{t('time_label')}</Label>
              <Input
                id="due_time"
                type="time"
                value={formData.due_time}
                onChange={(e) => updateField('due_time', e.target.value)}
              />
            </div>
          </div>

          {/* Type and Priority */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('type_label')}</Label>
              <Select
                value={formData.deadline_type}
                onValueChange={(v) => { if (v) updateField('deadline_type', v as DeadlineType) }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(DEADLINE_TYPE_LABELS).map((value) => (
                    <SelectItem key={value} value={value}>
                      {typeLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('priority_label')}</Label>
              <Select
                value={formData.priority}
                onValueChange={(v) => { if (v) updateField('priority', v as DeadlinePriority) }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(PRIORITY_LABELS).map((value) => (
                    <SelectItem key={value} value={value}>
                      {priorityLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Customer */}
          {customers.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="deadline-customer">{t('customer_label')}</Label>
              <CustomerCombobox
                id="deadline-customer"
                value={formData.customer_id || ''}
                customers={customers}
                onChange={(v) => updateField('customer_id', v)}
                placeholder={t('customer_placeholder')}
                noneLabel={t('no_customer')}
              />
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">{t('notes_label')}</Label>
            <Textarea
              id="notes"
              placeholder={t('notes_placeholder')}
              value={formData.notes}
              onChange={(e) => updateField('notes', e.target.value)}
              rows={3}
            />
          </div>

          <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
            {/* Delete (only when editing an existing deadline) */}
            {initialData?.id && onDelete ? (
              <div className="flex items-center gap-2">
                {confirmDelete ? (
                  <>
                    <span className="text-sm text-muted-foreground mr-1">{t('delete_confirm')}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                    >
                      {tc('cancel')}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        onDelete(initialData)
                        onOpenChange(false)
                      }}
                    >
                      {tc('delete')}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setConfirmDelete(true)}
                  >
                    {tc('delete')}
                  </Button>
                )}
              </div>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {tc('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={isLoading || !formData.title || !canWrite}
                title={!canWrite ? td('read_only_tooltip') : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4" />}
                {isLoading ? tc('saving') : initialData?.id ? tc('save') : t('create')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
