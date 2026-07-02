'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { AccountNumber } from '@/components/ui/account-number'

export interface RetagLine {
  id: string
  account_number: string
  line_description: string | null
  debit_amount: number
  credit_amount: number
  dimensions?: Record<string, string> | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  line: RetagLine | null
  /** Fired after a successful retag so the host refetches the entry. */
  onRetagged: () => void
}

/**
 * Tier-2 retro-tagging on a posted voucher line (dimensions plan PR6).
 * Edits ONLY the dimension tags via the audited retag RPC; the verifikat
 * itself is untouchable. Dims other than 1/6 pass through unedited (same
 * merge semantics as the voucher editor). Hardcoded Swedish — voucher
 * detail is a stays-Swedish surface.
 */
export default function RetagLineDialog({ open, onOpenChange, line, onRetagged }: Props) {
  const { toast } = useToast()
  const [dims, setDims] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && line) {
      setDims({ ...(line.dimensions ?? {}) })
      setReason('')
      setError(null)
    }
  }, [open, line])

  if (!line) return null

  const amount = Number(line.debit_amount) > 0 ? Number(line.debit_amount) : Number(line.credit_amount)
  const side = Number(line.debit_amount) > 0 ? 'Debet' : 'Kredit'

  const handleChange = (dimNo: string, code: string | null) => {
    setDims((prev) => {
      const next = { ...prev }
      if (code) next[dimNo] = code
      else delete next[dimNo]
      return next
    })
  }

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entry-lines/${line.id}/retag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dimensions: dims, reason }),
      })
      const payload = await res.json()
      if (!res.ok) {
        setError(typeof payload.error === 'string' ? payload.error : 'Kunde inte ändra dimensioner')
        return
      }
      if (payload.data?.changed === false) {
        toast({ title: 'Inga ändringar', description: 'Dimensionerna var redan de valda.' })
      } else {
        toast({ title: 'Dimensioner ändrade', description: 'Ändringen är loggad i ändringshistoriken.' })
      }
      onOpenChange(false)
      onRetagged()
    } catch {
      setError('Kunde inte ändra dimensioner')
    } finally {
      setIsSaving(false)
    }
  }

  const reasonValid = reason.trim().length >= 3

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ändra dimensioner</DialogTitle>
          <DialogDescription>
            Påverkar endast internredovisningen, inte verifikatet. Ändringen
            loggas med före/efter och anledning.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border p-3 text-sm">
          <AccountNumber number={line.account_number} showName />
          <div className="mt-1 flex items-center justify-between text-muted-foreground">
            <span className="truncate">{line.line_description || '—'}</span>
            <span className="tabular-nums shrink-0 ml-3">
              {amount.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} kr {side}
            </span>
          </div>
        </div>

        <LineDimensionFields dimensions={dims} onChange={handleChange} />

        <div className="space-y-2">
          <Label htmlFor="retag-reason">Anledning</Label>
          <Input
            id="retag-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="t.ex. Raden hörde till projekt P002"
            maxLength={500}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Avbryt
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !reasonValid}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Spara ändring
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
