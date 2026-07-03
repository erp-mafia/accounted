'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowRight } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "Ny lönekörning" as a modal — mirrors NewJournalEntryDialog. A successful
 * create navigates straight to the run detail page (the real workspace),
 * unmounting the host list page and this dialog with it.
 */
export default function NewSalaryRunDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto"
        // Same convention as NewJournalEntryDialog: closing is explicit (the
        // header X or Avbryt), never an accidental Escape or backdrop click.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Ny lönekörning</DialogTitle>
        </DialogHeader>
        <NewSalaryRunForm onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// Inner component so form state resets whenever the dialog reopens (Radix
// unmounts DialogContent children on close).
function NewSalaryRunForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)

  const now = new Date()
  const defaultYear = now.getFullYear()
  const defaultMonth = now.getMonth() + 1
  const defaultPayDate = `${defaultYear}-${String(defaultMonth).padStart(2, '0')}-25`

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)

    const form = new FormData(e.currentTarget)
    const body = {
      period_year: parseInt(form.get('period_year') as string),
      period_month: parseInt(form.get('period_month') as string),
      payment_date: form.get('payment_date') as string,
      voucher_series: form.get('voucher_series') as string || 'A',
    }

    const res = await fetch('/api/salary/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (res.ok) {
      const { data } = await res.json()
      toast({ title: 'Lönekörning skapad' })
      router.push(`/salary/runs/${data.id}`)
    } else {
      const result = await res.json()
      toast({
        title: 'Kunde inte skapa lönekörning',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }

    setSaving(false)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="period_year">År</Label>
            <Input id="period_year" name="period_year" type="number" defaultValue={defaultYear} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="period_month">Månad (1-12)</Label>
            <Input id="period_month" name="period_month" type="number" min="1" max="12" defaultValue={defaultMonth} required />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="payment_date">Utbetalningsdag</Label>
          <Input id="payment_date" name="payment_date" type="date" defaultValue={defaultPayDate} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="voucher_series">Verifikationsserie</Label>
          <Input id="voucher_series" name="voucher_series" defaultValue="A" maxLength={1} className="max-w-20" />
          <p className="text-xs text-muted-foreground">En bokstav A–Z. Standard: A</p>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Skapar...' : 'Skapa och fortsätt'}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </form>
  )
}
