'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
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
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Loader2, FileText, AlertTriangle, Check, Plus, Trash2, Paperclip } from 'lucide-react'
import type { BookingTemplateLibrary, BookingTemplateLibraryLine } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'

interface BulkBookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transactions: TransactionWithInvoice[]
  onSuccess: () => void
}

type Mode = 'one_line_per_tx' | 'sum_per_account'
type Tab = 'template' | 'manual'

interface PreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | undefined
}

interface ManualLine {
  id: string
  account_number: string
  debit_amount: string  // form-state strings; parsed on send
  credit_amount: string
  line_description: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function parseAmount(s: string): number {
  if (!s) return 0
  const cleaned = s.replace(/\s/g, '').replace(',', '.')
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

function newManualLineId(): string {
  return `ml-${Math.random().toString(36).slice(2, 10)}`
}

export default function BulkBookDialog({
  open,
  onOpenChange,
  transactions,
  onSuccess,
}: BulkBookDialogProps) {
  const { toast } = useToast()
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const t = useTranslations('tx_bulk_book')

  const [tab, setTab] = useState<Tab>('template')
  const [templates, setTemplates] = useState<BookingTemplateLibrary[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('one_line_per_tx')
  const [description, setDescription] = useState('')
  const [manualLines, setManualLines] = useState<ManualLine[]>([])
  const [submitting, setSubmitting] = useState(false)

  // Documents that will inherit onto the new verifikat. Computed from
  // transactions.document_id; the RPC reads these and updates each doc's
  // journal_entry_id atomically with the verifikat commit.
  const docCount = useMemo(
    () => transactions.filter((tx) => tx.document_id).length,
    [transactions],
  )

  const txCount = transactions.length
  const sharedDate = transactions[0]?.date
  const sharedCurrency = transactions[0]?.currency ?? 'SEK'
  const direction: 'income' | 'expense' = useMemo(() => {
    if (transactions.length === 0) return 'income'
    return transactions[0]!.amount > 0 ? 'income' : 'expense'
  }, [transactions])
  const txSumAbs = useMemo(
    () => round2(transactions.reduce((s, tx) => s + Math.abs(tx.amount), 0)),
    [transactions],
  )

  const selectedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  )

  // Load templates when the dialog opens. RLS scopes to user's companies +
  // system templates; no company_id filter needed.
  useEffect(() => {
    if (!open || !company) return
    let cancelled = false
    async function load() {
      setLoadingTemplates(true)
      try {
        const { data } = await supabase
          .from('booking_template_library')
          .select('*')
          .eq('is_active', true)
          .order('is_system', { ascending: false })
          .order('name', { ascending: true })
        if (cancelled) return
        setTemplates((data ?? []) as BookingTemplateLibrary[])
      } finally {
        if (!cancelled) setLoadingTemplates(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [open, company, supabase])

  // Reset state when dialog closes so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setTab('template')
      setSelectedTemplateId(null)
      setMode('one_line_per_tx')
      setDescription('')
      setManualLines([])
    } else if (sharedDate) {
      // Pre-fill description with a sensible default the user can edit.
      setDescription(t('default_description', { date: sharedDate }))
    }
  }, [open, sharedDate, t])

  // Pre-fill the bank side from the txs (one line per tx on 1930 with
  // the correct Dr/Cr direction). We intentionally do NOT pre-fill a
  // counterpart account: swedish-compliance flagged that a hardcoded
  // 3001/5800 prefill nudges users into submitting verifikat without a
  // VAT line (26xx) for momsregistrerade affärshändelser. The bank
  // side is the unambiguous part the user always wants; the
  // counterpart (and any VAT split) is the user's responsibility.
  useEffect(() => {
    if (tab !== 'manual') return
    if (manualLines.length > 0) return
    if (transactions.length === 0) return
    const isIncome = direction === 'income'
    const bankLines: ManualLine[] = transactions.map((tx) => ({
      id: newManualLineId(),
      account_number: '1930',
      debit_amount: isIncome ? Math.abs(tx.amount).toFixed(2).replace('.', ',') : '',
      credit_amount: isIncome ? '' : Math.abs(tx.amount).toFixed(2).replace('.', ','),
      line_description: (tx.description || '').slice(0, 40).trim(),
    }))
    // One empty counterpart row to scaffold the next entry. Account
    // left blank — user must choose, which avoids the no-VAT trap.
    const counterpart: ManualLine = {
      id: newManualLineId(),
      account_number: '',
      debit_amount: '',
      credit_amount: '',
      line_description: '',
    }
    setManualLines([...bankLines, counterpart])
  }, [tab, manualLines.length, transactions, direction])

  // Live line preview — driven by either the template/mode pair (template
  // tab) or the user-edited manual lines (manual tab). Same downstream
  // invariants (balance + bank-leg match) apply to both paths.
  const previewLines = useMemo<PreviewLine[]>(() => {
    if (tab === 'manual') {
      return manualLines
        .map<PreviewLine>((ml) => ({
          account_number: ml.account_number,
          debit_amount: round2(parseAmount(ml.debit_amount)),
          credit_amount: round2(parseAmount(ml.credit_amount)),
          line_description: ml.line_description.trim() || undefined,
        }))
        .filter((l) => l.debit_amount > 0 || l.credit_amount > 0)
    }
    if (!selectedTemplate) return []
    const templateLines = (selectedTemplate.lines ?? []) as BookingTemplateLibraryLine[]
    const lines: PreviewLine[] = []
    if (mode === 'sum_per_account') {
      const applied = applyTemplate(templateLines, txSumAbs)
      for (const fl of applied) {
        const debit = parseFloat(fl.debit_amount || '0') || 0
        const credit = parseFloat(fl.credit_amount || '0') || 0
        if (debit === 0 && credit === 0) continue
        lines.push({
          account_number: fl.account_number,
          debit_amount: round2(debit),
          credit_amount: round2(credit),
          line_description: fl.line_description,
        })
      }
    } else {
      for (const tx of transactions) {
        const applied = applyTemplate(templateLines, Math.abs(tx.amount))
        for (const fl of applied) {
          const debit = parseFloat(fl.debit_amount || '0') || 0
          const credit = parseFloat(fl.credit_amount || '0') || 0
          if (debit === 0 && credit === 0) continue
          const tag = (tx.description || '').slice(0, 40).trim()
          lines.push({
            account_number: fl.account_number,
            debit_amount: round2(debit),
            credit_amount: round2(credit),
            line_description: tag
              ? `${fl.line_description ?? ''} – ${tag}`.trim()
              : fl.line_description,
          })
        }
      }
    }
    return lines
  }, [tab, manualLines, selectedTemplate, mode, transactions, txSumAbs])

  const previewTotals = useMemo(() => {
    const debit = previewLines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = previewLines.reduce((s, l) => s + l.credit_amount, 0)
    return { debit: round2(debit), credit: round2(credit) }
  }, [previewLines])

  // Balance + bank-leg match are the two invariants the RPC will check; we
  // surface them here so the user knows whether confirm will succeed.
  const isBalanced = Math.abs(previewTotals.debit - previewTotals.credit) < 0.005
  const bankLineNet = previewLines
    .filter((l) => l.account_number >= '1900' && l.account_number <= '1999')
    .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0)
  const expectedBankNet = direction === 'income' ? txSumAbs : -txSumAbs
  const bankMatches = Math.abs(bankLineNet - expectedBankNet) < 0.005

  // The active tab gates which selector must be valid. Both paths still
  // need a non-empty description, ≥2 lines, balance, bank-leg match,
  // and (for manual mode) valid 4-digit account numbers — without this,
  // a 1–3-digit entry escapes the lexicographic bank-account range
  // check ('193' < '1900' is true), bank match could pass, and the
  // server's Zod schema rejects with a 400 only after submit.
  const tabReady = tab === 'template' ? selectedTemplate !== null : manualLines.length > 0
  const allAccountsValid = previewLines.every((l) => /^\d{4}$/.test(l.account_number))
  const canConfirm =
    !submitting &&
    tabReady &&
    description.trim().length > 0 &&
    previewLines.length >= 2 &&
    isBalanced &&
    bankMatches &&
    allAccountsValid

  function updateManualLine(id: string, patch: Partial<Omit<ManualLine, 'id'>>) {
    setManualLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  function removeManualLine(id: string) {
    setManualLines((prev) => prev.filter((l) => l.id !== id))
  }

  function addManualLine() {
    setManualLines((prev) => [
      ...prev,
      {
        id: newManualLineId(),
        account_number: '',
        debit_amount: '',
        credit_amount: '',
        line_description: '',
      },
    ])
  }

  async function handleConfirm() {
    if (!canConfirm) return
    setSubmitting(true)
    try {
      // Build the payload per the active tab. Template path uses the
      // existing schema branch (template_id + mode). Manual path sends
      // the user-edited lines directly.
      const payload =
        tab === 'manual'
          ? {
              tx_ids: transactions.map((tx) => tx.id),
              entry_description: description.trim(),
              manual_lines: previewLines.map((l) => ({
                account_number: l.account_number,
                debit_amount: l.debit_amount,
                credit_amount: l.credit_amount,
                currency: sharedCurrency,
                line_description: l.line_description ?? undefined,
              })),
            }
          : {
              tx_ids: transactions.map((tx) => tx.id),
              template_id: selectedTemplateId,
              mode,
              entry_description: description.trim(),
            }
      const response = await fetch('/api/transactions/bulk-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        toast({
          title: t('error_title'),
          description: getErrorMessage(body, { statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      const body = (await response.json()) as {
        data: { voucher_series: string | null; voucher_number: number | null }
      }
      const voucherLabel =
        body.data.voucher_series && body.data.voucher_number != null
          ? `${body.data.voucher_series}-${body.data.voucher_number}`
          : t('unknown_voucher')
      toast({
        title: t('success_title'),
        description: t('success_description', { count: txCount, voucher: voucherLabel }),
        variant: 'success',
      })
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('error_title'),
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (transactions.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t('title', { count: txCount, date: sharedDate ? formatDate(sharedDate) : '' })}
          </DialogTitle>
          <DialogDescription>
            {direction === 'income' ? t('description_income') : t('description_expense')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Selection summary */}
          <div className="rounded-lg border bg-card p-3 flex items-center justify-between">
            <div className="text-sm">
              <p className="font-medium">
                {t('summary_count', { count: txCount })}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {sharedDate ? formatDate(sharedDate) : ''}
              </p>
            </div>
            <p className="font-medium tabular-nums">
              {direction === 'income' ? '+' : '−'}
              {formatCurrency(txSumAbs, sharedCurrency)}
            </p>
          </div>

          {/* Tab: Mall (template) / Manuell (hand-built lines). Default
              template; manual is the "I want to book it myself" escape
              hatch the user asked for after PR #606. */}
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="space-y-4">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="template">{t('tab_template')}</TabsTrigger>
              <TabsTrigger value="manual">{t('tab_manual')}</TabsTrigger>
            </TabsList>

            <TabsContent value="template" className="space-y-4 mt-0">
          {/* Template picker */}
          <div className="space-y-2">
            <Label>{t('template_label')}</Label>
            {loadingTemplates ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-center text-sm text-muted-foreground">
                {t('no_templates')}
              </div>
            ) : (
              <ul className="space-y-1 max-h-[180px] overflow-y-auto">
                {templates.map((tpl) => (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedTemplateId(tpl.id)}
                      className={cn(
                        'w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-secondary/60',
                        selectedTemplateId === tpl.id
                          ? 'border-foreground'
                          : 'border-border',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-sm font-medium truncate">{tpl.name}</span>
                            {tpl.is_system && (
                              <Badge variant="outline" className="text-[10px]">
                                {t('system_badge')}
                              </Badge>
                            )}
                          </div>
                          {tpl.description && (
                            <p className="mt-1 text-xs text-muted-foreground truncate">
                              {tpl.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Mode toggle — segmented control pattern (no RadioGroup primitive
              in the design system; two outlined buttons act as a selectable
              pair) */}
          {selectedTemplate && (
            <div className="space-y-2">
              <Label>{t('mode_label')}</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setMode('one_line_per_tx')}
                  className={cn(
                    'rounded-lg border bg-card p-3 text-left transition-colors hover:bg-secondary/60',
                    mode === 'one_line_per_tx' ? 'border-foreground' : 'border-border',
                  )}
                >
                  <p className="text-sm font-medium">{t('mode_per_tx')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('mode_per_tx_hint')}</p>
                </button>
                <button
                  type="button"
                  onClick={() => setMode('sum_per_account')}
                  className={cn(
                    'rounded-lg border bg-card p-3 text-left transition-colors hover:bg-secondary/60',
                    mode === 'sum_per_account' ? 'border-foreground' : 'border-border',
                  )}
                >
                  <p className="text-sm font-medium">{t('mode_sum')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('mode_sum_hint')}</p>
                </button>
              </div>
            </div>
          )}
            </TabsContent>

            <TabsContent value="manual" className="space-y-4 mt-0">
              {/* Manual line editor. Lines are pre-filled from txs on first
                  switch to this tab (one line per tx on 1930 + counterpart
                  line on 3001/5800). User adjusts accounts, amounts, and
                  descriptions. Live balance + bank-leg checks below drive
                  the confirm button. */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('manual_lines_label')}</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addManualLine}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    {t('manual_add_line')}
                  </Button>
                </div>
                <div className="rounded-lg border bg-card overflow-hidden">
                  <table className="w-full text-xs tabular-nums">
                    <thead>
                      <tr className="border-b text-muted-foreground bg-muted/30">
                        <th className="px-2 py-2 text-left font-medium w-[90px]">{t('col_account')}</th>
                        <th className="px-2 py-2 text-left font-medium">{t('col_description')}</th>
                        <th className="px-2 py-2 text-right font-medium w-[110px]">{t('col_debit')}</th>
                        <th className="px-2 py-2 text-right font-medium w-[110px]">{t('col_credit')}</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {manualLines.map((line) => (
                        <tr key={line.id} className="border-b border-border/40 last:border-b-0">
                          <td className="px-2 py-1">
                            <Input
                              value={line.account_number}
                              onChange={(e) =>
                                updateManualLine(line.id, { account_number: e.target.value.replace(/\D/g, '').slice(0, 4) })
                              }
                              placeholder="1930"
                              className="h-8 text-xs font-mono"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Input
                              value={line.line_description}
                              onChange={(e) =>
                                updateManualLine(line.id, { line_description: e.target.value.slice(0, 200) })
                              }
                              placeholder={t('manual_description_placeholder')}
                              className="h-8 text-xs"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Input
                              inputMode="decimal"
                              value={line.debit_amount}
                              onChange={(e) =>
                                updateManualLine(line.id, { debit_amount: e.target.value })
                              }
                              placeholder="0,00"
                              className="h-8 text-xs text-right"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <Input
                              inputMode="decimal"
                              value={line.credit_amount}
                              onChange={(e) =>
                                updateManualLine(line.id, { credit_amount: e.target.value })
                              }
                              placeholder="0,00"
                              className="h-8 text-xs text-right"
                            />
                          </td>
                          <td className="px-1 py-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => removeManualLine(line.id)}
                              aria-label={t('manual_remove_line')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {/* Description — shared by both tabs once the user has either a
              template selected or manual lines drafted. */}
          {tabReady && (
            <div className="space-y-2">
              <Label htmlFor="bulk-description">{t('description_label')}</Label>
              <Input
                id="bulk-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>
          )}

          {/* Document inheritance hint — informs the user which receipts
              follow the txs onto the combined verifikat. Zero is fine
              (txs without docs don't break anything); we only render
              when the count is non-zero to avoid clutter. */}
          {docCount > 0 && tabReady && (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Paperclip className="h-3.5 w-3.5 flex-shrink-0" />
              <span>{t('docs_inherit_hint', { count: docCount })}</span>
            </div>
          )}

          {/* Live preview */}
          {tabReady && previewLines.length > 0 && (
            <div className="space-y-2">
              <Label>
                {t('preview_label', { count: previewLines.length })}
              </Label>
              <div className="rounded-lg border bg-muted/30 overflow-hidden">
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">{t('col_account')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('col_description')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('col_debit')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('col_credit')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewLines.slice(0, 30).map((line, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-b-0">
                        <td className="px-3 py-1.5 font-mono">{line.account_number}</td>
                        <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[240px]">
                          {line.line_description ?? '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {line.debit_amount > 0 ? formatCurrency(line.debit_amount) : ''}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {line.credit_amount > 0 ? formatCurrency(line.credit_amount) : ''}
                        </td>
                      </tr>
                    ))}
                    {previewLines.length > 30 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-1.5 text-center text-muted-foreground">
                          {t('preview_truncated', { remaining: previewLines.length - 30 })}
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-card font-medium">
                      <td colSpan={2} className="px-3 py-2 text-right">{t('total_label')}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(previewTotals.debit)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(previewTotals.credit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Invariant indicators */}
              <div className="space-y-1">
                {isBalanced ? (
                  <div className="flex items-center gap-2 text-xs text-success">
                    <Check className="h-3.5 w-3.5" />
                    <span>{t('balance_ok')}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>{t('balance_off', {
                      delta: formatCurrency(Math.abs(previewTotals.debit - previewTotals.credit)),
                    })}</span>
                  </div>
                )}
                {bankMatches ? (
                  <div className="flex items-center gap-2 text-xs text-success">
                    <Check className="h-3.5 w-3.5" />
                    <span>{t('bank_ok')}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>{t('bank_off')}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
