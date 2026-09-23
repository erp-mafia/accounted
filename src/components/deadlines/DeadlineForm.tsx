'use client'

import { useState, useEffect } from 'react'
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
            {initialData?.id ? 'Redigera deadline' : 'Ny deadline'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">Titel *</Label>
            <Input
              id="title"
              placeholder="t.ex. Leverera video till Företag AB"
              value={formData.title}
              onChange={(e) => updateField('title', e.target.value)}
              required
            />
          </div>

          {/* Date and Time */}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="due_date">Datum *</Label>
              <Input
                id="due_date"
                type="date"
                value={formData.due_date}
                onChange={(e) => updateField('due_date', e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="due_time">Tid (valfritt)</Label>
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
              <Label>Typ *</Label>
              <Select
                value={formData.deadline_type}
                onValueChange={(v) => { if (v) updateField('deadline_type', v as DeadlineType) }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DEADLINE_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Prioritet</Label>
              <Select
                value={formData.priority}
                onValueChange={(v) => { if (v) updateField('priority', v as DeadlinePriority) }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Customer */}
          {customers.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="deadline-customer">Kund (valfritt)</Label>
              <CustomerCombobox
                id="deadline-customer"
                value={formData.customer_id || ''}
                customers={customers}
                onChange={(v) => updateField('customer_id', v)}
                placeholder="Välj kund..."
                noneLabel="Ingen kund"
              />
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Anteckningar (valfritt)</Label>
            <Textarea
              id="notes"
              placeholder="Lägg till anteckningar..."
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
                    <span className="text-sm text-muted-foreground mr-1">Ta bort?</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Avbryt
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
                      Ta bort
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
                    Ta bort
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
                Avbryt
              </Button>
              <Button
                type="submit"
                disabled={isLoading || !formData.title || !canWrite}
                title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4" />}
                {isLoading ? 'Sparar...' : initialData?.id ? 'Spara' : 'Skapa'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
