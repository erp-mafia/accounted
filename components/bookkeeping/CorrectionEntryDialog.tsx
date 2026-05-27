'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { AccountNumber } from '@/components/ui/account-number'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { Plus, Trash2 } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { JournalEntry, JournalEntryLine, BASAccount } from '@/types'

interface CorrectionLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description: string
}

interface Props {
  entry: JournalEntry
  open: boolean
  onOpenChange: (open: boolean) => void
  onCorrected: () => void
}

export default function CorrectionEntryDialog({ entry, open, onOpenChange, onCorrected }: Props) {
  const { toast } = useToast()
  const router = useRouter()
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [lines, setLines] = useState<CorrectionLine[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  const originalLines = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  useEffect(() => {
    if (open) {
      // Pre-fill with original entry's lines
      setLines(
        originalLines.map((l) => ({
          account_number: l.account_number,
          debit_amount: Number(l.debit_amount) > 0 ? String(Number(l.debit_amount)) : '',
          credit_amount: Number(l.credit_amount) > 0 ? String(Number(l.credit_amount)) : '',
          line_description: l.line_description || '',
        }))
      )
      fetchAccounts()
    }
  }, [open, entry.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchAccounts() {
    try {
      const res = await fetch('/api/bookkeeping/accounts')
      const { data } = await res.json()
      setAccounts(data || [])
    } catch {
      // Accounts will be empty — user can still type account numbers manually
    }
  }

  const updateLine = (index: number, field: keyof CorrectionLine, value: string) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  const addLine = () => {
    setLines((prev) => [...prev, { account_number: '', debit_amount: '', credit_amount: '', line_description: '' }])
  }

  const removeLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index))
  }

  const totalDebit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
  const totalCredit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
  const roundedDebit = Math.round(totalDebit * 100) / 100
  const roundedCredit = Math.round(totalCredit * 100) / 100
  const isBalanced = roundedDebit === roundedCredit && roundedDebit > 0

  const hasValidLines = lines.length >= 2 && lines.every((l) => l.account_number.length === 4)

  async function handleSubmit() {
    if (!isBalanced || !hasValidLines) return

    setIsSubmitting(true)
    try {
      const apiLines = lines.map((l) => ({
        account_number: l.account_number,
        debit_amount: parseFloat(l.debit_amount) || 0,
        credit_amount: parseFloat(l.credit_amount) || 0,
        line_description: l.line_description || undefined,
      }))

      const res = await fetch(`/api/bookkeeping/journal-entries/${entry.id}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: apiLines }),
      })

      const result = await res.json()

      if (!res.ok) {
        const error = new Error('Failed to create correction') as Error & { body?: unknown; status?: number }
        error.body = result
        error.status = res.status
        throw error
      }

      const correctedId = result.data?.corrected?.id

      toast({
        title: 'Ändringsverifikation skapad',
        description: 'Storno och rättelse har bokförts.',
        action: correctedId ? (
          <Button variant="outline" size="sm" onClick={() => router.push(`/bookkeeping/${correctedId}`)}>
            Visa rättelsen
          </Button>
        ) : undefined,
      })
      onOpenChange(false)
      onCorrected()
    } catch (err) {
      const anyErr = err as { body?: unknown; status?: number }
      toast({
        title: 'Kunde inte spara ändringsverifikation',
        description: getErrorMessage(anyErr.body ?? err, { context: 'journal_entry', statusCode: anyErr.status }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Skapa ändringsverifikation</DialogTitle>
        </DialogHeader>

        {/* Storno explanation */}
        <div className="rounded-lg bg-muted/50 border p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground mb-1">Hur fungerar en ändringsverifikation?</p>
          <p>En bokförd verifikation kan inte ändras direkt. Istället skapas automatiskt:</p>
          <ol className="list-decimal list-inside mt-1 space-y-0.5">
            <li>En <strong>stornoverifikation</strong> som nollställer den ursprungliga</li>
            <li>En ny verifikation med dina rättade uppgifter</li>
          </ol>
          <p className="mt-2">
            Rättelsen bokförs i samma räkenskapsperiod som originalet — du hittar den under originalets räkenskapsår.
          </p>
        </div>

        {/* Original entry (read-only) */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{formatVoucher(entry)}</span>
            <span className="tabular-nums">{formatDate(entry.entry_date)}</span>
            <Badge variant="outline" className="text-xs">Original</Badge>
          </div>
          <p className="text-sm">{entry.description}</p>

          <div className="hidden sm:block">
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-1.5 w-48">Konto</th>
                  <th className="py-1.5">Beskrivning</th>
                  <th className="py-1.5 w-28 text-right">Debet</th>
                  <th className="py-1.5 w-28 text-right">Kredit</th>
                </tr>
              </thead>
              <tbody>
                {originalLines.map((line) => (
                  <tr key={line.id} className="border-b last:border-0">
                    <td className="py-1.5"><AccountNumber number={line.account_number} showName /></td>
                    <td className="py-1.5 text-muted-foreground">{line.line_description || ''}</td>
                    <td className="py-1.5 text-right">
                      {Number(line.debit_amount) > 0
                        ? Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })
                        : ''}
                    </td>
                    <td className="py-1.5 text-right">
                      {Number(line.credit_amount) > 0
                        ? Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sm:hidden space-y-1.5">
            {originalLines.map((line) => (
              <div key={line.id} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
                <div className="min-w-0">
                  <AccountNumber number={line.account_number} showName />
                </div>
                <span className="font-mono text-xs shrink-0 ml-2">
                  {Number(line.debit_amount) > 0
                    ? `D ${Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}`
                    : `K ${Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}`}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t my-2" />

        {/* Corrected lines (editable) */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Rättade rader</p>

          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="space-y-2 sm:space-y-0 sm:grid sm:grid-cols-[1fr_1fr_120px_120px_auto] sm:gap-2 sm:items-start border-b sm:border-0 pb-3 sm:pb-0 last:border-0">
                <div className="grid grid-cols-[1fr_auto] sm:contents gap-2">
                  <AccountCombobox
                    value={line.account_number}
                    accounts={accounts}
                    onChange={(v) => updateLine(index, 'account_number', v)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 min-h-[44px] min-w-[44px] sm:order-last"
                    onClick={() => removeLine(index)}
                    disabled={lines.length <= 2}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <Input
                  value={line.line_description}
                  onChange={(e) => updateLine(index, 'line_description', e.target.value)}
                  placeholder="Beskrivning"
                  className="h-8"
                />
                <div className="grid grid-cols-2 gap-2 sm:contents">
                  <Input
                    type="number"
                    value={line.debit_amount}
                    onChange={(e) => updateLine(index, 'debit_amount', e.target.value)}
                    placeholder="Debet"
                    className="h-8 text-right"
                    min={0}
                    step="0.01"
                  />
                  <Input
                    type="number"
                    value={line.credit_amount}
                    onChange={(e) => updateLine(index, 'credit_amount', e.target.value)}
                    placeholder="Kredit"
                    className="h-8 text-right"
                    min={0}
                    step="0.01"
                  />
                </div>
              </div>
            ))}
          </div>

          <Button variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-4 w-4 mr-1" />
            Lägg till rad
          </Button>

          {/* Balance summary */}
          <div className="flex justify-end gap-6 text-sm pt-2 border-t">
            <div>
              <span className="text-muted-foreground mr-2">Debet:</span>
              <span className={!isBalanced ? 'text-destructive font-medium' : 'font-medium'}>
                {roundedDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground mr-2">Kredit:</span>
              <span className={!isBalanced ? 'text-destructive font-medium' : 'font-medium'}>
                {roundedCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
              </span>
            </div>
          </div>

          {!isBalanced && roundedDebit + roundedCredit > 0 && (
            <p className="text-sm text-destructive">
              Debet och kredit måste vara lika och större än 0.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Avbryt
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isBalanced || !hasValidLines || isSubmitting}
          >
            {isSubmitting ? 'Skapar...' : 'Skapa ändringsverifikation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
