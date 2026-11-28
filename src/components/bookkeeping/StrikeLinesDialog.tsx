'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { KonteringLinesEditor } from '@/components/bookkeeping/KonteringLinesEditor'
import RattelseExplainer from '@/components/bookkeeping/RattelseExplainer'
import { AddAccountDialog } from '@/components/bookkeeping/AddAccountDialog'
import { AccountNumber } from '@/components/ui/account-number'
import { useToast } from '@/components/ui/use-toast'
import { useAccounts } from '@/lib/reference-data/hooks'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { changeCorrectionLineAccount, getSelectableCorrectionCatalog } from '@/lib/bookkeeping/correction-line-account'
import { splitCreateAccountPrefill } from '@/lib/bookkeeping/create-account-prefill'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import { SpinnerIcon } from '@/components/icons'
import { formatDate } from '@/lib/utils'
import type { JournalEntry, JournalEntryLine } from '@/types'

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
  /** The filed momsperiod the verifikat is dated in, when its date is open and the record has one. */
  filedVat?: { tax_period: string; filed_on: string } | null
}

/**
 * Inline line rättelse (BFL 5 kap 5 §): strike lines in a posted verifikat
 * and add replacement lines in the SAME verifikat, without an
 * ändringsverifikation. The struck originals stay visible (strikethrough)
 * in the verifikat via the immutable rättelse log. Stays Swedish
 * (verifikat surface).
 */
export default function StrikeLinesDialog({ entry, open, onOpenChange, onCorrected, filedVat }: Props) {
  const { toast } = useToast()
  const t = useTranslations('journal_detail')
  // The full chart (deactivated rows included) comes from the session cache
  // (lib/reference-data); only the static BAS catalogue is loaded per open,
  // and it is module-cached after the first time.
  const { accounts, isLoading: accountsLoading, error: accountsError, refresh: refreshAccounts } = useAccounts(false)
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const accountsStatus: 'loading' | 'ready' | 'error' =
    accountsLoading || catalogStatus === 'loading'
      ? 'loading'
      : accountsError || catalogStatus === 'error'
        ? 'error'
        : 'ready'
  const [strikeIds, setStrikeIds] = useState<Set<string>>(new Set())
  const [newLines, setNewLines] = useState<NewLine[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Index of the replacement line whose combobox opened the create dialog, and
  // the search string it was showing. Null index = the dialog is closed.
  const [creatingAccountForLine, setCreatingAccountForLine] = useState<number | null>(null)
  const [createAccountPrefill, setCreateAccountPrefill] = useState('')

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
      void loadCatalog()
    }
  }, [open, entry.id])

  async function loadCatalog() {
    setCatalogStatus('loading')
    try {
      setCatalog(await loadBasCatalog())
      setCatalogStatus('ready')
    } catch {
      setCatalog([])
      setCatalogStatus('error')
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

  const closeCreateAccount = () => {
    setCreatingAccountForLine(null)
    setCreateAccountPrefill('')
  }

  // A number that is neither in the company chart nor in BAS 2026 (a retired
  // account such as 8022, or a company-specific underkonto) would otherwise be
  // a dead end here: the rättelse can only post to accounts that exist in the
  // chart. Creating it inline keeps the half-finished rättelse intact.
  const handleAccountCreated = async (account: { account_number: string; account_name?: string }) => {
    await invalidateReferenceData('ref:accounts')
    if (creatingAccountForLine != null) {
      // The refreshed cache is not visible in this closure, so the
      // fresh account's own name is passed alongside the stale sources. The
      // reactivate path reports no name, but that account is already in
      // `accounts` (the fetch includes deactivated rows).
      const created = account.account_name
        ? [{ account_number: account.account_number, account_name: account.account_name }]
        : []
      setNewLines((prev) => prev.map((line, index) => (
        index === creatingAccountForLine
          ? changeCorrectionLineAccount(line, account.account_number, [...accounts, ...catalog, ...created])
          : line
      )))
    }
    closeCreateAccount()
  }

  // Effective verifikat after the rättelse: remaining original lines + new lines.
  const remaining = originalLines.filter((l) => !strikeIds.has(l.id))
  const { totalDebit, totalCredit, balanced: isBalanced } = lineBalance([...remaining, ...newLines])

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
      <DialogContent size="wide">
        <DialogHeader>
          {/* Convention 7: the how-it-works copy lives behind the "?", not in
              the dialog flow. */}
          <div className="flex items-center gap-2">
            <DialogTitle>Stryk rader i verifikatet</DialogTitle>
            <RattelseExplainer>
              <p>
                Här stryks felaktiga rader och ersätts direkt i samma verifikat,
                utan ändringsverifikation. Det fungerar bara i öppna, olåsta
                perioder.
              </p>
              <p>
                Varje rättelse loggas med vem och när, och de ursprungliga
                raderna förblir synliga i verifikatets rättelsehistorik.
              </p>
              <p>
                Om månaden redan är momsdeklarerad kan en ändring av momskonton
                påverka den inlämnade deklarationen.
              </p>
            </RattelseExplainer>
          </div>
          <DialogDescription>
            De strukna raderna förblir synliga (överstrukna) i verifikatet.
          </DialogDescription>
        </DialogHeader>

        {/* The button in the top bar opens this without passing the Rätta
            menu, where the same sentence sits: said here too. */}
        {filedVat && (
          <p className="text-xs text-muted-foreground">
            {t('correct_menu_period_filed', { period: filedVat.tax_period, date: formatDate(filedVat.filed_on) })}
          </p>
        )}

        {/* Original lines with strike checkboxes */}
        <div className="space-y-1">
          <p className="text-sm font-medium">Markera rader som ska strykas</p>
          <div className="divide-y">
            {originalLines.map((line) => {
              const struck = strikeIds.has(line.id)
              // The RPC strikes an FX line only when every added line names
              // its currency, and this dialog's lines carry none: disabled.
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
            <div className="flex items-center justify-between gap-3 rounded-lg p-3 text-sm text-muted-foreground bg-control shadow-raised">
              <span className="flex items-center gap-2">
                {accountsStatus === 'loading' && <SpinnerIcon className="h-4 w-4 animate-spin" />}
                {accountsStatus === 'loading' ? t('accounts_loading') : t('accounts_load_failed')}
              </span>
              {accountsStatus === 'error' && (
                <Button variant="outline" onClick={() => void refreshAccounts()}>
                  {t('accounts_retry')}
                </Button>
              )}
            </div>
          )}

          <KonteringLinesEditor
            lines={newLines}
            accounts={activeAccounts}
            catalog={selectableCatalog}
            onAccountChange={updateNewLineAccount}
            onAmountChange={(index, field, value) => updateNewLine(index, field, value)}
            onDescriptionChange={(index, value) => updateNewLine(index, 'line_description', value)}
            onAdd={addNewLine}
            onRemove={removeNewLine}
            onCreateAccount={(index, prefill) => {
              setCreatingAccountForLine(index)
              setCreateAccountPrefill(prefill)
            }}
            accountsDisabled={accountsStatus !== 'ready'}
            minLines={0}
            header={false}
            labels={{
              account: 'Konto',
              description: 'Beskrivning',
              debit: 'Debet',
              credit: 'Kredit',
              addRow: 'Lägg till rad',
              removeRow: 'Ta bort rad',
            }}
          />
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

      {/* Nested on purpose: closing this one (Esc, click-outside, Avbryt) must
          leave the rättelse behind it untouched. */}
      <AddAccountDialog
        open={creatingAccountForLine != null}
        onOpenChange={(next) => {
          if (!next) closeCreateAccount()
        }}
        onCreated={handleAccountCreated}
        {...splitCreateAccountPrefill(createAccountPrefill)}
      />
    </Dialog>
  )
}
