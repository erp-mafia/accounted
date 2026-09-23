'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import RattelseExplainer from '@/components/bookkeeping/RattelseExplainer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { JournalEntry } from '@/types'

interface Props {
  entry: JournalEntry
  open: boolean
  onOpenChange: (open: boolean) => void
  onCorrected: () => void
}

/**
 * Metadata rättelse (BFL 5 kap 9 §): correct the verifikationstext and/or
 * the date (within the same fiscal period) of a posted verifikat without an
 * ändringsverifikation. Who/when is recorded in the immutable rättelse log
 * and shown in the verifikat's history. Stays Swedish (verifikat surface,
 * .claude/rules/i18n.md).
 */
export default function CorrectMetadataDialog({ entry, open, onOpenChange, onCorrected }: Props) {
  const { toast } = useToast()
  const [description, setDescription] = useState('')
  const [entryDate, setEntryDate] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setDescription(entry.description || '')
      setEntryDate(entry.entry_date?.slice(0, 10) || '')
    }
  }, [open, entry.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const descriptionChanged = description.trim() !== (entry.description || '')
  const dateChanged = entryDate !== (entry.entry_date?.slice(0, 10) || '')
  const hasChange = (descriptionChanged && description.trim().length > 0) || (dateChanged && entryDate.length > 0)

  async function handleSubmit() {
    if (!hasChange) return
    setIsSubmitting(true)
    try {
      const payload: { description?: string; entry_date?: string } = {}
      if (descriptionChanged && description.trim().length > 0) payload.description = description.trim()
      if (dateChanged && entryDate.length > 0) payload.entry_date = entryDate

      const res = await fetch(`/api/bookkeeping/journal-entries/${entry.id}/correct-metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await res.json()
      if (!res.ok) {
        const error = new Error('Failed to correct metadata') as Error & { body?: unknown; status?: number }
        error.body = result
        error.status = res.status
        throw error
      }
      toast({
        title: 'Verifikationen rättad',
        description: 'Ändringen har loggats i verifikatets rättelsehistorik.',
      })
      onOpenChange(false)
      onCorrected()
    } catch (err) {
      const anyErr = err as { body?: unknown; status?: number }
      toast({
        title: 'Kunde inte rätta verifikationen',
        description: getErrorMessage(anyErr.body ?? err, { context: 'journal_entry', statusCode: anyErr.status }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          {/* Convention 7: the how-it-works copy lives behind the "?", not in
              the dialog flow. */}
          <div className="flex items-center gap-2">
            <DialogTitle>Ändra text eller datum</DialogTitle>
            <RattelseExplainer>
              <p>
                Verifikationstexten och datumet kan rättas här utan
                ändringsverifikation.
              </p>
              <p>
                Varje rättelse loggas med vem och när, och det ursprungliga
                innehållet förblir synligt i verifikatets rättelsehistorik.
              </p>
              <p>
                Om månaden redan är momsdeklarerad kan en datumflytt påverka
                den inlämnade deklarationen.
              </p>
            </RattelseExplainer>
          </div>
          <DialogDescription>
            Datumet kan bara flyttas inom samma bokföringsperiod: använd
            &quot;Flytta till annat datum&quot; för att byta period.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="rattelse-description">Verifikationstext</Label>
            <Input
              id="rattelse-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rattelse-date">Datum</Label>
            <Input
              id="rattelse-date"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              disabled={['storno', 'opening_balance', 'year_end'].includes(entry.source_type)}
            />
            {['storno', 'opening_balance', 'year_end'].includes(entry.source_type) && (
              <p className="text-xs text-muted-foreground">
                Datumet på den här verifikationstypen kan inte ändras.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Avbryt
          </Button>
          <Button onClick={handleSubmit} disabled={!hasChange || isSubmitting}>
            {isSubmitting ? 'Rättar...' : 'Spara rättelse'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
