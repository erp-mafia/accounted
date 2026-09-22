'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
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
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import RattelseExplainer from '@/components/bookkeeping/RattelseExplainer'
import { AddAccountDialog } from '@/components/bookkeeping/AddAccountDialog'
import CorrectionPreview from '@/components/bookkeeping/CorrectionPreview'
import {
  autoCorrectionDescription,
  correctionDescriptionForSubmit,
} from '@/components/bookkeeping/correction-entry-description'
import { nextLineDescriptionForAccountChange } from '@/components/bookkeeping/correction-line-description'
import { useToast } from '@/components/ui/use-toast'
import { useAccounts } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  changeCorrectionLineAccount,
  getSelectableCorrectionCatalog,
} from '@/lib/bookkeeping/correction-line-account'
import { splitCreateAccountPrefill } from '@/lib/bookkeeping/create-account-prefill'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import type { JournalEntry, JournalEntryLine } from '@/types'

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
  const [lines, setLines] = useState<CorrectionLine[]>([])
  const [description, setDescription] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Non-null when the server refused with CORRECTION_CHAIN_TOO_DEEP: holds the
  // reported chain depth and opens the bypass confirm ("Rätta ändå").
  const [deepChainDepth, setDeepChainDepth] = useState<number | null>(null)
  // Index of the line whose combobox opened the create dialog, and the search
  // string it was showing. Null index = the dialog is closed.
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
  const accountNameSources = useMemo(
    () => [...accounts, ...catalog],
    [accounts, catalog],
  )

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
      // Pre-fill the verifikationstext with the same auto text the server
      // would generate; only a user edit is sent along (see handleSubmit).
      setDescription(autoCorrectionDescription(entry.description))
      void loadCatalog()
    }
  }, [open, entry.id]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const updateLine = (index: number, field: keyof CorrectionLine, value: string) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== index) return l
        const next = { ...l, [field]: value }
        // When the account changes, refresh the auto-filled description to the
        // new account's name. Without this, a description carried over from the
        // original entry (e.g. 2393 "Lån från närstående personer, långfristig
        // del") stays stale on the newly chosen account (e.g. 2893, kortfristig).
        if (field === 'account_number' && value) {
          next.line_description = nextLineDescriptionForAccountChange(
            l.line_description,
            l.account_number,
            value,
            accounts,
          )
        }
        return next
      })
    )
  }

  const updateLineAccount = (index: number, accountNumber: string) => {
    setLines((prev) => prev.map((line, lineIndex) => (
      lineIndex === index
        ? changeCorrectionLineAccount(line, accountNumber, accountNameSources)
        : line
    )))
  }

  const addLine = () => {
    setLines((prev) => [...prev, { account_number: '', debit_amount: '', credit_amount: '', line_description: '' }])
  }

  const removeLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index))
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
      setLines((prev) => prev.map((line, index) => (
        index === creatingAccountForLine
          ? changeCorrectionLineAccount(line, account.account_number, [...accountNameSources, ...created])
          : line
      )))
    }
    closeCreateAccount()
  }

  const totalDebit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
  const totalCredit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
  const roundedDebit = Math.round(totalDebit * 100) / 100
  const roundedCredit = Math.round(totalCredit * 100) / 100
  const isBalanced = roundedDebit === roundedCredit && roundedDebit > 0

  const hasValidLines = lines.length >= 2 && lines.every((l) => l.account_number.length === 4)

  async function handleSubmit(allowDeepChain = false) {
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
        body: JSON.stringify({
          lines: apiLines,
          // Only sent when the user changed the auto prefill: the server
          // fallback ("Rättelse: <original>") stays the source of truth.
          description: correctionDescriptionForSubmit(description, entry.description),
          ...(allowDeepChain ? { allow_deep_chain: true } : {}),
        }),
      })

      const result = await res.json()

      if (!res.ok) {
        // Chain-depth guard: open the bypass confirm instead of a dead-end
        // toast. "Rätta ändå" resubmits with allow_deep_chain=true.
        const structured = (result as { error?: { code?: string; details?: { depth?: number } } })?.error
        if (structured?.code === 'CORRECTION_CHAIN_TOO_DEEP') {
          setDeepChainDepth(structured.details?.depth ?? 3)
          return
        }
        const error = new Error('Failed to create correction') as Error & { body?: unknown; status?: number }
        error.body = result
        error.status = res.status
        throw error
      }
      setDeepChainDepth(null)

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
          {/* Convention 7: the how-it-works copy lives behind the "?", not in
              the dialog flow. */}
          <div className="flex items-center gap-2">
            <DialogTitle>Skapa ändringsverifikation</DialogTitle>
            <RattelseExplainer>
              <p>
                Här skapas automatiskt en stornoverifikation som nollställer
                originalet och en ny verifikation med dina rättade uppgifter.
                Rättelsen bokförs i samma räkenskapsperiod som originalet: du
                hittar den under originalets räkenskapsår.
              </p>
              <p>
                Spårbarheten ligger i stornokedjan: originalet,
                stornoverifikationen och ändringsverifikationen förblir synliga
                i bokföringen och länkade till varandra.
              </p>
              <p>
                Tar du bort ett konto ur de rättade raderna nollställs det
                (stornon återför det). Vill du bara återföra hela verifikatet
                utan att ersätta det, använd Återför (storno) istället.
              </p>
            </RattelseExplainer>
          </div>
        </DialogHeader>

        {/* Original entry metadata: lines live inside CorrectionPreview below */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
            <span className="text-muted-foreground">Original</span>
            <span className="font-mono">{formatVoucher(entry)}</span>
            <span className="tabular-nums">{formatDate(entry.entry_date)}</span>
          </div>
          <p className="text-sm">{entry.description}</p>
        </div>

        {/* Live diff: original | storno | correction | förändring */}
        <CorrectionPreview originalLines={originalLines} correctedLines={lines} />

        {/* Verifikationstext for the new (corrected) entry. Pre-filled with
            the auto text; editable so a header named after the wrong account
            is not echoed on the correction (issue #1031). */}
        <div className="space-y-1">
          <Label htmlFor="correction-description">Verifikationstext</Label>
          <Input
            id="correction-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={autoCorrectionDescription(entry.description)}
            // ph-no-capture: the placeholder echoes the posted entry's
            // description, and replay masking covers values, not attributes.
            className="ph-no-capture"
          />
          <p className="text-xs text-muted-foreground">
            Texten på den nya verifikationen. Ändra den om originalets beskrivning inte längre
            stämmer, till exempel när rättelsen byter konto.
          </p>
        </div>

        {/* Corrected lines (editable) */}
        <div className="space-y-2">
          <div className="space-y-1">
            <p className="text-sm font-medium">Rättade rader</p>
            <p className="text-xs text-muted-foreground">
              Det här är hela den nya verifikationen: alla konton som ska finnas kvar måste stå kvar.
            </p>
          </div>

          {accountsStatus !== 'ready' && (
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                {accountsStatus === 'loading' && <Loader2 className="h-4 w-4 animate-spin" />}
                {accountsStatus === 'loading' ? t('accounts_loading') : t('accounts_load_failed')}
              </span>
              {accountsStatus === 'error' && (
                <Button variant="outline" size="sm" onClick={() => void refreshAccounts()}>
                  {t('accounts_retry')}
                </Button>
              )}
            </div>
          )}

          <div className="space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="space-y-2 sm:space-y-0 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_120px_auto] sm:gap-2 sm:items-start border-b sm:border-0 pb-3 sm:pb-0 last:border-0">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] sm:contents gap-2">
                  {/* min-w-0: at sm: the sm:contents wrapper promotes this cell
                      to a direct grid item; without it the combobox refuses to
                      shrink below its content and overflows the dialog (same
                      pattern as SendInvoiceDialog's desktop rows). */}
                  <div className="min-w-0">
                    <AccountCombobox
                      value={line.account_number}
                      accounts={activeAccounts}
                      catalog={selectableCatalog}
                      onChange={(v) => updateLineAccount(index, v)}
                      onCreateAccount={(prefill) => {
                        setCreatingAccountForLine(index)
                        setCreateAccountPrefill(prefill)
                      }}
                      disabled={accountsStatus !== 'ready'}
                    />
                  </div>
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
            onClick={() => handleSubmit()}
            disabled={!isBalanced || !hasValidLines || isSubmitting}
          >
            {isSubmitting ? 'Skapar...' : 'Skapa ändringsverifikation'}
          </Button>
        </DialogFooter>

        {/* Chain-depth guard confirm: the server refused because this entry
            already sits deep in a rättelse chain. Advisory, never a dead end:
            "Rätta ändå" resubmits with allow_deep_chain=true. */}
        <Dialog open={deepChainDepth != null} onOpenChange={(next) => { if (!next) setDeepChainDepth(null) }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('deep_chain_title')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {t('deep_chain_body', { depth: deepChainDepth ?? 3 })}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeepChainDepth(null)} disabled={isSubmitting}>
                {t('deep_chain_cancel')}
              </Button>
              <Button
                onClick={() => { setDeepChainDepth(null); void handleSubmit(true) }}
                disabled={isSubmitting}
              >
                {t('deep_chain_correct_anyway')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>

      {/* Nested on purpose: closing this one (Esc, click-outside, Avbryt) must
          leave the half-filled ändringsverifikation behind it untouched. */}
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
