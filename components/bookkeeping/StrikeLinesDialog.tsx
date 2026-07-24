'use client'

import { useState, useEffect, useMemo } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { AccountNumber } from '@/components/ui/account-number'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { changeCorrectionLineAccount, getSelectableCorrectionCatalog } from '@/lib/bookkeeping/correction-line-account'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import type { JournalEntry, JournalEntryLine, BASAccount } from '@/types'

interface NewLine {
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

/**
 * Inline line rättelse (BFL 5 kap 5 §): strike lines in a posted verifikat
 * and add replacement lines in the SAME verifikat, without an
 * ändringsverifikation. The struck originals stay visible (strikethrough)
 * in the verifikat via the immutable rättelse log. Stays Swedish
 * (verifikat surface, .claude/rules/i18n.md).
 */
export default function StrikeLinesDialog({ entry, open, onOpenChange, onCorrected }: Props) {
  const { toast } = useToast()
  const t = useTranslations('journal_detail')
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [accountsStatus, setAccountsStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [strikeIds, setStrikeIds] = useState<Set<string>>(new Set())
  const [newLines, setNewLines] = useState<NewLine[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.is_active),
    [accounts],
  )
  const selectableCatalog = useMemo(
    () => getSelectableCorrectionCatalog(accounts, catalog),
    [accounts, catalog],
  )

  const originalLines = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  useEffect(() => {
    if (open) {
      setStrikeIds(new Set())
      setNewLines([])
      void fetchAccounts()
    }
  }, [open, entry.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchAccounts() {
    setAccountsStatus('loading')
    try {
      const [res, basCatalog] = await Promise.all([
        fetch('/api/bookkeeping/accounts?active=false'),
        loadBasCatalog(),
      ])
      if (!res.ok) throw new Error(`accounts ${res.status}`)
      const { data } = await res.json()
      setAccounts(data || [])
      setCatalog(basCatalog)
      setAccountsStatus('ready')
    } catch {
      setAccounts([])
      setCatalog([])
      setAccountsStatus('error')
    }
  }

  const toggleStrike = (lineId: string) => {
    setStrikeIds((prev) => {
      const next = new Set(prev)
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      return next
    })
  }

  const updateNewLine = (index: number, field: keyof NewLine, value: string) => {
    setNewLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  const updateNewLineAccount = (index: number, accountNumber: string) => {
    setNewLines((prev) => prev.map((line, lineIndex) => (
      lineIndex === index
        ? changeCorrectionLineAccount(line, accountNumber, [...accounts, ...catalog])
        : line
    )))
  }

  const addNewLine = () => {
    setNewLines((prev) => [...prev, { account_number: '', debit_amount: '', credit_amount: '', line_description: '' }])
  }

  const removeNewLine = (index: number) => {
    setNewLines((prev) => prev.filter((_, i) => i !== index))
  }

  // Effective verifikat after the rättelse: remaining original lines + new lines.
  const remaining = originalLines.filter((l) => !strikeIds.has(l.id))
  const remainingDebit = remaining.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
  const remainingCredit = remaining.reduce((sum, l) => sum + (Number(l.credit_amount) || 0), 0)
  const newDebit = newLines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
  const newCredit = newLines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
  const totalDebit = Math.round((remainingDebit + newDebit) * 100) / 100
  const totalCredit = Math.round((remainingCredit + newCredit) * 100) / 100
  const isBalanced = totalDebit === totalCredit && totalDebit > 0

  const newLinesValid = newLines.every((l) => {
    const debit = parseFloat(l.debit_amount) || 0
    const credit = parseFloat(l.credit_amount) || 0
    return l.account_number.length === 4 && debit >= 0 && credit >= 0 && (debit > 0) !== (credit > 0)
  })
  const hasChange = strikeIds.size > 0 || newLines.length > 0
  const effectiveCount = remaining.length + newLines.length
  const canSubmit = hasChange && newLinesValid && isBalanced && effectiveCount >= 2

  async function handleSubmit() {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${entry.id}/strike-lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strike_line_ids: [...strikeIds],
          lines: newLines.map((l) => ({
            account_number: l.account_number,
            debit_amount: parseFloat(l.debit_amount) || 0,
            credit_amount: parseFloat(l.credit_amount) || 0,
            line_description: l.line_description || undefined,
          })),
        }),
      })
      const result = await res.json()
      if (!res.ok) {
        const error = new Error('Failed to strike lines') as Error & { body?: unknown; status?: number }
        error.body = result
        error.status = res.status
        throw error
      }
      toast({
        title: 'Verifikationen rättad',
        description: 'De strukna raderna visas överstrukna i verifikatet.',
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
      <DialogContent className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Stryk rader i verifikatet</DialogTitle>
        </DialogHeader>

        <div className="rounded-lg bg-muted/50 border p-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground mb-1">Rättelse i samma verifikat</p>
          <p>
            Felaktiga rader stryks och ersätts direkt i verifikatet, utan ändringsverifikation.
            De strukna raderna förblir synliga (överstrukna) och rättelsen loggas med vem och när,
            enligt bokföringslagen. Fungerar bara i öppna, olåsta perioder. Om månaden redan är
            momsdeklarerad kan en ändring av momskonton påverka den inlämnade deklarationen.
          </p>
        </div>

        {/* Original lines with strike checkboxes */}
        <div className="space-y-1">
          <p className="text-sm font-medium">Markera rader som ska strykas</p>
          <div className="rounded-lg border divide-y">
            {originalLines.map((line) => {
              const struck = strikeIds.has(line.id)
              // FX lines carry conversion data replacements cannot reproduce;
              // the RPC rejects striking them, so the checkbox is disabled.
              const isForeign = !!line.currency && line.currency !== 'SEK'
              return (
                <label
                  key={line.id}
                  className={`flex items-center gap-3 px-3 py-2 text-sm transition-colors ${isForeign ? 'opacity-60' : 'cursor-pointer hover:bg-secondary/60'}`}
                  title={isForeign ? 'Rader i utländsk valuta rättas med ändringsverifikat' : undefined}
                >
                  <Checkbox
                    checked={struck}
                    disabled={isForeign}
                    onCheckedChange={() => toggleStrike(line.id)}
                  />
                  <span className={`flex-1 min-w-0 ${struck ? 'line-through text-muted-foreground' : ''}`}>
                    <AccountNumber number={line.account_number} showName />
                    {line.line_description && (
                      <span className="text-muted-foreground ml-2">{line.line_description}</span>
                    )}
                  </span>
                  <span className={`tabular-nums shrink-0 ${struck ? 'line-through text-muted-foreground' : ''}`}>
                    {Number(line.debit_amount) > 0
                      ? `${Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} D`
                      : `${Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} K`}
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        {/* Replacement lines */}
        <div className="space-y-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">Ersättningsrader</p>
            <p className="text-xs text-muted-foreground">
              Lägg till de rader som ska gälla i stället. Verifikationen måste balansera efter rättelsen.
            </p>
          </div>

          {accountsStatus !== 'ready' && (
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                {accountsStatus === 'loading' && <Loader2 className="h-4 w-4 animate-spin" />}
                {accountsStatus === 'loading' ? t('accounts_loading') : t('accounts_load_failed')}
              </span>
              {accountsStatus === 'error' && (
                <Button variant="outline" size="sm" onClick={() => void fetchAccounts()}>
                  {t('accounts_retry')}
                </Button>
              )}
            </div>
          )}

          <div className="space-y-2">
            {newLines.map((line, index) => (
              <div key={index} className="space-y-2 sm:space-y-0 sm:grid sm:grid-cols-[1fr_1fr_120px_120px_auto] sm:gap-2 sm:items-start border-b sm:border-0 pb-3 sm:pb-0 last:border-0">
                <div className="grid grid-cols-[1fr_auto] sm:contents gap-2">
                  <AccountCombobox
                    value={line.account_number}
                    accounts={activeAccounts}
                    catalog={selectableCatalog}
                    onChange={(v) => updateNewLineAccount(index, v)}
                    disabled={accountsStatus !== 'ready'}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 min-h-[44px] min-w-[44px] sm:order-last"
                    onClick={() => removeNewLine(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <Input
                  value={line.line_description}
                  onChange={(e) => updateNewLine(index, 'line_description', e.target.value)}
                  placeholder="Beskrivning"
                  className="h-8"
                />
                <div className="grid grid-cols-2 gap-2 sm:contents">
                  <Input
                    type="number"
                    value={line.debit_amount}
                    onChange={(e) => updateNewLine(index, 'debit_amount', e.target.value)}
                    placeholder="Debet"
                    className="h-8 text-right"
                    min={0}
                    step="0.01"
                  />
                  <Input
                    type="number"
                    value={line.credit_amount}
                    onChange={(e) => updateNewLine(index, 'credit_amount', e.target.value)}
                    placeholder="Kredit"
                    className="h-8 text-right"
                    min={0}
                    step="0.01"
                  />
                </div>
              </div>
            ))}
          </div>

          <Button variant="outline" size="sm" onClick={addNewLine}>
            <Plus className="h-4 w-4 mr-1" />
            Lägg till rad
          </Button>
        </div>

        {/* Effective balance after the rättelse */}
        <div className="flex justify-end gap-6 text-sm pt-2 border-t">
          <div>
            <span className="text-muted-foreground mr-2">Debet efter rättelse:</span>
            <span className={!isBalanced ? 'text-destructive font-medium' : 'font-medium'}>
              {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground mr-2">Kredit efter rättelse:</span>
            <span className={!isBalanced ? 'text-destructive font-medium' : 'font-medium'}>
              {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
            </span>
          </div>
        </div>

        {hasChange && !isBalanced && (
          <p className="text-sm text-destructive">
            Debet och kredit måste vara lika och större än 0 efter rättelsen.
          </p>
        )}
        {hasChange && isBalanced && effectiveCount < 2 && (
          <p className="text-sm text-destructive">
            Verifikationen måste ha minst två rader efter rättelsen. Använd Återför (storno) för att
            makulera hela verifikatet.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Avbryt
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? 'Rättar...' : 'Rätta verifikatet'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
