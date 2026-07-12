'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, X, Loader2, AlertTriangle, Lock, ShieldCheck, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { PendingOperationRejectionCategory } from '@/types'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/utils'

// Inline approval card for an agent-staged pending_operation.
//
// Risk tiers (plan §9, §12):
//   low:    single-click "Godkänn". Trust UI for auto-approve lives
//            post-V0 (data model supports it via agent_profiles.trust_per_tool).
//   medium: single-click "Godkänn".
//   high:   requires the user to type "godkänn" verbatim. Never auto-
//            approvable, by design (legal compliance).
//
// Reject is always one-click.
//
// The card posts to the existing /api/pending-operations/<id>/{commit,reject}
// endpoints: same surface the Accounted "Förslag" page uses, so there is
// exactly one approval source of record.
//
// Structured preview: when the staged envelope carries a preview object, we
// render a scannable summary block under the prose. Each common tool has its
// own renderer; unknown tools fall through to a flat key/value list so a new
// tool can ship without an ApprovalCard change.

interface PeriodStatus {
  period_id?: string | null
  status: 'open' | 'locked' | 'closed'
  lock_date?: string | null
}

interface Props {
  operationId: string
  riskLevel: 'low' | 'medium' | 'high'
  message: string
  toolName?: string
  preview?: unknown
  periodStatus?: PeriodStatus
  // Fired after a reject that carries a reason: the chat feeds this synthetic
  // correction back as a hidden user turn so the agent re-proposes inline.
  onRequestCorrection?: (correctionMessage: string) => void
}

type State = 'pending' | 'committing' | 'committed' | 'rejecting' | 'rejected' | 'error'

// Mirrors the granskning (/pending) reject dialog so chat rejections capture
// the same structured feedback. Stored on the op + surfaced to the agent via
// gnubok_get_recent_rejections.
const REJECTION_CATEGORY_LABELS: Record<PendingOperationRejectionCategory, string> = {
  wrong_category: 'Fel kategori / konto',
  wrong_amount: 'Fel belopp',
  duplicate: 'Dubblett',
  wrong_period: 'Fel period',
  other: 'Annat',
}

// Subset of fields the commit response may return that the success state
// uses to deep-link to the freshly-created artifact. Different
// operation_types return different shapes: only the ones we actually
// surface as links are declared.
interface CommitResultData {
  journal_entry_id?: string | null
  invoice_id?: string | null
  customer_id?: string | null
  supplier_invoice_id?: string | null
  // bulk_book_inbox_items creates N verifikationer, not one artifact: the
  // executor returns per-item counts instead of a single id. Surfaced as a
  // "N bokförda" summary + a link to the ledger (or the sole verifikat).
  booked_count?: number
  skipped_count?: number
  booked?: Array<{ journal_entry_id?: string | null }>
}

export default function ApprovalCard({
  operationId,
  riskLevel,
  message,
  toolName,
  preview,
  periodStatus,
  onRequestCorrection,
}: Props) {
  // Gating the AI re-propose path only: approving/rejecting the staged
  // operation is manual ledger work and stays enabled without the AI add-on.
  // What's paid is feeding a rejection back so the agent generates a *new*
  // proposal (an LLM call): that's suppressed when the company lacks `ai`.
  const hasAi = useCapability(CAPABILITY.ai)
  const [state, setState] = useState<State>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  // Reject-with-reason form (mirrors the granskning dialog). Clicking "Avslå"
  // opens it; both fields are optional. When a reason is given, the rejection
  // is fed back so the agent re-proposes.
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectCategory, setRejectCategory] = useState<PendingOperationRejectionCategory | ''>('')
  const [rejectReason, setRejectReason] = useState('')
  // Surfaced in the "Godkänt" success state so the user can jump directly
  // to the newly-created artifact (verifikation / faktura / kund) instead
  // of hunting through /bookkeeping.
  const [commitResult, setCommitResult] = useState<CommitResultData | null>(null)
  // Set when commit fails because the booking posts to BAS accounts not yet
  // active in the chart. Drives the inline "activate and approve" affordance
  // (the op stays pending server-side, so retrying after activation works).
  const [accountsToActivate, setAccountsToActivate] = useState<string[] | null>(null)

  const requiresTextConfirm = riskLevel === 'high'
  const canCommit =
    !requiresTextConfirm || confirmText.trim().toLowerCase() === 'godkänn'

  async function handleCommit() {
    setState('committing')
    setErrorMessage(null)
    setAccountsToActivate(null)
    try {
      const res = await fetch(`/api/pending-operations/${operationId}/commit`, {
        method: 'POST',
      })
      const body = (await res.json().catch(() => ({}))) as {
        data?: CommitResultData
        error?: string | { code?: string; message?: string; account_numbers?: string[] }
      }
      if (!res.ok) {
        // Recoverable: the booking posts to BAS accounts not active in the
        // chart. Offer to activate them and retry: the op stays pending.
        const structured = typeof body.error === 'object' && body.error !== null ? body.error : null
        if (structured?.code === 'ACCOUNTS_NOT_IN_CHART' && structured.account_numbers?.length) {
          setAccountsToActivate(structured.account_numbers)
          setState('pending')
          return
        }
        throw new Error(errorText(body.error) || `HTTP ${res.status}`)
      }
      // Best-effort deep-link to the created artifact in the success state.
      if (body?.data) setCommitResult(body.data)
      setState('committed')
    } catch (err) {
      setState('error')
      setErrorMessage(err instanceof Error ? err.message : 'Kunde inte godkänna.')
    }
  }

  // Activate the missing BAS accounts (one POST) then retry the commit. The
  // pending_operation was left 'pending' server-side precisely so this retry
  // commits the same booking without re-staging it.
  async function handleActivateAndCommit() {
    if (!accountsToActivate || accountsToActivate.length === 0) return
    setState('committing')
    setErrorMessage(null)
    try {
      const res = await fetch('/api/bookkeeping/accounts/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_numbers: accountsToActivate }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || 'Kunde inte aktivera kontona.')
      }
      setAccountsToActivate(null)
      await handleCommit()
    } catch (err) {
      setState('error')
      setErrorMessage(err instanceof Error ? err.message : 'Kunde inte aktivera kontona.')
    }
  }

  async function handleReject() {
    setState('rejecting')
    setErrorMessage(null)
    const categoryLabel = rejectCategory ? REJECTION_CATEGORY_LABELS[rejectCategory] : null
    const reason = rejectReason.trim()
    // Both fields optional: a bare "Avvisa" still rejects (parity with the
    // granskning dialog and older bodyless clients).
    const body =
      rejectCategory || reason
        ? {
            ...(rejectCategory ? { rejection_category: rejectCategory } : {}),
            ...(reason ? { rejection_reason: reason } : {}),
          }
        : undefined
    try {
      const res = await fetch(`/api/pending-operations/${operationId}/reject`, {
        method: 'POST',
        ...(body
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
      }
      setShowRejectForm(false)
      setState('rejected')
      // Feed the correction back so the agent re-proposes: only when the user
      // actually said what was wrong. A bare reject just stops here.
      const parts = [categoryLabel, reason].filter(Boolean) as string[]
      if (hasAi && parts.length > 0) {
        onRequestCorrection?.(
          `Jag avvisade förslaget. Det som var fel: ${parts.join(', ')}. Föreslå en korrigerad bokning.`,
        )
      }
    } catch (err) {
      setState('error')
      setErrorMessage(err instanceof Error ? err.message : 'Kunde inte avslå.')
    }
  }

  if (state === 'committed') {
    // Build a deep-link to the newly-created artifact when the commit
    // response told us what it was. Falls back to nothing if no relevant
    // id was returned (e.g. period close / unlock / mark-as-sent).
    let deepLink: { href: string; label: string } | null = null
    if (commitResult?.journal_entry_id) {
      deepLink = {
        href: `/bookkeeping/${commitResult.journal_entry_id}`,
        label: 'Öppna verifikation',
      }
    } else if (commitResult?.invoice_id) {
      deepLink = {
        href: `/invoices/${commitResult.invoice_id}`,
        label: 'Öppna faktura',
      }
    } else if (commitResult?.supplier_invoice_id) {
      deepLink = {
        href: `/supplier-invoices/${commitResult.supplier_invoice_id}`,
        label: 'Öppna leverantörsfaktura',
      }
    } else if (commitResult?.customer_id) {
      deepLink = {
        href: `/customers/${commitResult.customer_id}`,
        label: 'Öppna kund',
      }
    }
    // Bulk operations (bulk_book_inbox_items) book N underlag at once and return
    // counts instead of a single id. Show the outcome ("N bokförda · M
    // överhoppade") (a bulk commit silently skips non-bookable items, so
    // without this the user can't tell whether anything was booked) and link to
    // the ledger list, or straight to the sole verifikat when exactly one landed.
    const bulkSummary =
      typeof commitResult?.booked_count === 'number'
        ? { booked: commitResult.booked_count, skipped: commitResult.skipped_count ?? 0 }
        : null
    if (bulkSummary && !deepLink) {
      const soleEntryId =
        bulkSummary.booked === 1 ? commitResult?.booked?.[0]?.journal_entry_id : null
      deepLink = soleEntryId
        ? { href: `/bookkeeping/${soleEntryId}`, label: 'Öppna verifikation' }
        : { href: '/bookkeeping', label: 'Öppna bokföringen' }
    }
    // The server's `message` field (e.g. "Operation staged for review …
    // Open the Accounted web app to approve or reject it.") was written for
    // MCP clients without an inline approval surface. Inside the in-app
    // chat it's redundant noise: the agent already narrated the why
    // above the card. We keep it accessible via aria-description for
    // screen readers but don't render it.
    return (
      <div
        className="rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm"
        aria-description={message}
      >
        <p className="flex items-center gap-2 font-medium">
          <Check className="h-4 w-4" /> Godkänt
        </p>
        {bulkSummary && (
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            {bulkSummary.booked} {bulkSummary.booked === 1 ? 'underlag bokfört' : 'underlag bokförda'}
            {bulkSummary.skipped > 0 ? ` · ${bulkSummary.skipped} överhoppade` : ''}
          </p>
        )}
        {deepLink && (
          <Link
            href={deepLink.href}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
          >
            {deepLink.label}
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    )
  }

  if (state === 'rejected') {
    return (
      <div
        className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        aria-description={message}
      >
        <p className="flex items-center gap-2">
          <X className="h-4 w-4" /> Avslaget
          {rejectCategory && (
            <span className="text-xs text-muted-foreground/80">· {REJECTION_CATEGORY_LABELS[rejectCategory]}</span>
          )}
        </p>
      </div>
    )
  }

  const isBusy = state === 'committing' || state === 'rejecting'

  return (
    <div
      className={cn(
        // Subtle accent border-top tells the eye what to do BEFORE reading
        // the risk label. high = destructive red, medium = warning yellow,
        // low = neutral foreground. animate-scale-in gives the card a soft
        // entrance when it first lands inline in the conversation.
        'rounded-lg border bg-card px-4 py-3 space-y-3 border-t-2 animate-scale-in',
        riskLevel === 'high'
          ? 'border-destructive/50 border-t-destructive'
          : riskLevel === 'medium'
            ? 'border-border border-t-warning'
            : 'border-border border-t-foreground/30',
      )}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Förslag · risk {translateRisk(riskLevel)}
        </p>
        {periodStatus && <PeriodBadge status={periodStatus} />}
      </div>

      <PreviewBlock toolName={toolName} preview={preview} />

      {requiresTextConfirm && (
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            Hög risk: skriv <strong className="font-semibold">godkänn</strong> för att bekräfta.
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={isBusy}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            autoComplete="off"
            aria-label="Bekräfta med ordet godkänn"
          />
        </div>
      )}

      {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}

      {showRejectForm ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          <p className="text-xs font-medium">Vad är fel?</p>
          <Select
            value={rejectCategory}
            onValueChange={(v) => setRejectCategory(v as PendingOperationRejectionCategory)}
          >
            <SelectTrigger className="h-8 text-xs" aria-label="Anledning">
              <SelectValue placeholder="Anledning (valfritt)" />
            </SelectTrigger>
            {/* The agent sheet panel is z-[60]; SelectContent defaults to z-50
                and portals to <body>, so without this it opens BEHIND the
                sheet. z-[70] sits above the sheet, below toasts (z-[100]). */}
            <SelectContent className="z-[70]">
              {(Object.keys(REJECTION_CATEGORY_LABELS) as PendingOperationRejectionCategory[]).map((cat) => (
                <SelectItem key={cat} value={cat}>{REJECTION_CATEGORY_LABELS[cat]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="T.ex. ska vara IT-tjänster, inte telefoni…"
            rows={2}
            maxLength={2000}
            disabled={isBusy}
            className="text-xs"
            aria-label="Notering"
          />
          {hasAi ? (
            <p className="text-[11px] text-muted-foreground">
              Med en anledning eller notering föreslår assistenten en korrigerad bokning direkt.
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Din anledning sparas på förslaget. Vill du att assistenten automatiskt
              föreslår en korrigerad bokning?{' '}
              <Link href="/settings/billing" className="font-medium text-foreground hover:underline">
                Uppgradera
              </Link>
              .
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleReject}
              disabled={isBusy}
              className="flex-1"
            >
              {state === 'rejecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Avvisa'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRejectForm(false)}
              disabled={isBusy}
              className="flex-1"
            >
              Avbryt
            </Button>
          </div>
        </div>
      ) : accountsToActivate ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          <p className="text-xs leading-5">
            Bokningen använder konton som inte är aktiva i din kontoplan:{' '}
            <strong className="tabular-nums">{accountsToActivate.join(', ')}</strong>. Aktivera dem för att godkänna bokningen.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleActivateAndCommit}
              disabled={isBusy}
              className="flex-1"
            >
              {state === 'committing' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Aktivera och godkänn'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAccountsToActivate(null)}
              disabled={isBusy}
              className="flex-1"
            >
              Avbryt
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleCommit}
              disabled={isBusy || !canCommit}
              className="flex-1"
            >
              {state === 'committing' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                'Godkänn'
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRejectForm(true)}
              disabled={isBusy}
              className="flex-1"
            >
              Avslå
            </Button>
          </div>
          {/* Keep in sync with EXPIRY_DAYS in
              app/api/pending-operations/expire/cron/route.ts. */}
          <p className="text-[11px] text-muted-foreground">
            Om du inte gör något utgår förslaget automatiskt efter 30 dagar, inget bokförs.
          </p>
        </>
      )}
    </div>
  )
}

// ─── Structured preview block ──────────────────────────────────────────────
//
// Dispatches on tool_name. Adding a new tool: write a specialized renderer
// here. Falling back to the generic flat list is fine for low-volume tools.

interface PreviewBlockProps {
  toolName?: string
  preview?: unknown
}

function PreviewBlock({ toolName, preview }: PreviewBlockProps) {
  if (!preview || typeof preview !== 'object') return null
  const p = preview as Record<string, unknown>

  if (toolName === 'gnubok_categorize_transaction') {
    return <CategorizeTransactionPreview preview={p} />
  }
  if (toolName === 'gnubok_create_invoice') {
    return <CreateInvoicePreview preview={p} />
  }
  if (toolName === 'gnubok_create_voucher' || toolName === 'gnubok_correct_entry') {
    return <VoucherPreview preview={p} />
  }

  return <GenericPreview preview={p} />
}

// 20 categories from types/index.ts TransactionCategory. Kept inline so the
// component has no cross-module enum import; sync if the type changes.
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'income_services', label: 'Intäkt: tjänster' },
  { value: 'income_products', label: 'Intäkt: produkter' },
  { value: 'income_other', label: 'Intäkt: övrigt' },
  { value: 'expense_software', label: 'Kostnad: mjukvara' },
  { value: 'expense_equipment', label: 'Kostnad: utrustning' },
  { value: 'expense_office', label: 'Kostnad: kontor' },
  { value: 'expense_travel', label: 'Kostnad: resor' },
  { value: 'expense_marketing', label: 'Kostnad: marknadsföring' },
  { value: 'expense_professional_services', label: 'Kostnad: konsult/tjänster' },
  { value: 'expense_education', label: 'Kostnad: utbildning' },
  { value: 'expense_representation', label: 'Kostnad: representation' },
  { value: 'expense_consumables', label: 'Kostnad: förbrukning' },
  { value: 'expense_vehicle', label: 'Kostnad: fordon' },
  { value: 'expense_telecom', label: 'Kostnad: telefon/internet' },
  { value: 'expense_bank_fees', label: 'Kostnad: bankavgifter' },
  { value: 'expense_card_fees', label: 'Kostnad: kortavgifter' },
  { value: 'expense_currency_exchange', label: 'Kostnad: valutaväxling' },
  { value: 'expense_other', label: 'Kostnad: övrigt' },
  { value: 'private', label: 'Privat uttag' },
]

function CategorizeTransactionPreview({
  preview,
}: {
  preview: Record<string, unknown>
}) {
  const debit = preview.debit_account as string | undefined
  const credit = preview.credit_account as string | undefined
  const amount = preview.amount as number | undefined
  const currency = (preview.currency as string | undefined) ?? 'SEK'
  const category = preview.category as string | undefined
  // The exact journal lines the approval will post (net cost line, VAT line,
  // gross bank line, SEK), staged by the server since the preview-lines fix.
  const lines = (preview.lines as
    | {
        account_number?: string
        debit_amount?: number
        credit_amount?: number
        description?: string
      }[]
    | undefined) ?? []
  // Legacy summary fields, rendered only for operations staged before the
  // preview carried full lines. Pairing the gross amount with the cost
  // account reads as an unbalanced entry: never show it when lines exist.
  const vatLines = (preview.vat_lines as
    | {
        account_number?: string
        debit_amount?: number
        credit_amount?: number
        description?: string
      }[]
    | undefined) ?? []

  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs space-y-1.5">
      <div className="flex items-baseline gap-3">
        <span className="w-20 shrink-0 text-muted-foreground text-[10px] uppercase tracking-wider">
          Kategori
        </span>
        <span className="flex-1 min-w-0 leading-5 text-foreground">
          {prettyCategory(category)}
        </span>
      </div>
      {lines.length > 0 ? (
        <div className="pt-1 mt-1 border-t border-border space-y-0.5">
          {lines.map((l, i) => {
            const debitAmt = typeof l.debit_amount === 'number' ? l.debit_amount : 0
            const creditAmt = typeof l.credit_amount === 'number' ? l.credit_amount : 0
            const side: 'D' | 'K' = debitAmt > 0 ? 'D' : 'K'
            return (
              <Row
                key={i}
                label={i === 0 ? 'Verifikat' : ''}
                value={
                  <span className="tabular-nums">
                    <span className="text-muted-foreground">{side} </span>
                    <strong className="font-medium">{l.account_number ?? '?'}</strong>
                    <span className="ml-2">
                      {formatCurrency(side === 'D' ? debitAmt : creditAmt)}
                    </span>
                  </span>
                }
              />
            )
          })}
        </div>
      ) : (
        <>
          {debit && credit && amount != null && (
            <Row
              label="Bokning"
              value={
                <span className="tabular-nums">
                  <span className="text-muted-foreground">D </span>
                  <strong className="font-medium">{debit}</strong>
                  <span className="text-muted-foreground"> / K </span>
                  <strong className="font-medium">{credit}</strong>
                  <span className="ml-2">{formatCurrency(amount, currency)}</span>
                </span>
              }
            />
          )}
          {vatLines.length > 0 && (
            <div className="pt-1 mt-1 border-t border-border">
              {vatLines.map((v, i) => {
                const debit = typeof v.debit_amount === 'number' ? v.debit_amount : 0
                const credit = typeof v.credit_amount === 'number' ? v.credit_amount : 0
                const side: 'D' | 'K' | null = debit > 0 ? 'D' : credit > 0 ? 'K' : null
                const amount = side === 'D' ? debit : side === 'K' ? credit : 0
                return (
                  <Row
                    key={i}
                    label={i === 0 ? 'Moms' : ''}
                    value={
                      <span className="tabular-nums">
                        {side && <span className="text-muted-foreground">{side} </span>}
                        <span className="text-muted-foreground">{v.account_number ?? ''} </span>
                        {formatCurrency(amount, currency)}
                      </span>
                    }
                  />
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Pull a human message out of an API error body that may be either a bare
// string ({ error: "…" }) or the structured envelope ({ error: { message } }).
function errorText(error: string | { message?: string } | undefined): string | null {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return null
}

function prettyCategory(value: string | undefined): string {
  if (!value) return '(saknas)'
  return CATEGORY_OPTIONS.find((o) => o.value === value)?.label ?? value
}

function CreateInvoicePreview({ preview }: { preview: Record<string, unknown> }) {
  const customer = preview.customer_name as string | undefined
  const subtotal = preview.subtotal as number | undefined
  const vatAmount = preview.vat_amount as number | undefined
  const total = preview.total as number | undefined
  const currency = (preview.currency as string | undefined) ?? 'SEK'
  const items =
    (preview.items as { description?: string; line_total?: number }[] | undefined) ?? []

  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs space-y-1.5">
      {customer && (
        <Row label="Kund" value={<span className="text-foreground">{customer}</span>} />
      )}
      {items.length > 0 && (
        <div className="space-y-0.5 max-h-32 overflow-y-auto">
          {items.slice(0, 5).map((it, i) => (
            <Row
              key={i}
              label={i === 0 ? 'Rader' : ''}
              value={
                <span className="tabular-nums truncate">
                  <span className="text-muted-foreground">
                    {it.description ?? '(rad)'}
                  </span>
                  {it.line_total != null && (
                    <span className="ml-2">{formatCurrency(it.line_total, currency)}</span>
                  )}
                </span>
              }
            />
          ))}
          {items.length > 5 && (
            <p className="pl-[88px] text-muted-foreground/70">
              + {items.length - 5} ytterligare rader
            </p>
          )}
        </div>
      )}
      <div className="pt-1 mt-1 border-t border-border space-y-0.5">
        {subtotal != null && (
          <Row
            label="Netto"
            value={
              <span className="tabular-nums">{formatCurrency(subtotal, currency)}</span>
            }
          />
        )}
        {vatAmount != null && (
          <Row
            label="Moms"
            value={
              <span className="tabular-nums">{formatCurrency(vatAmount, currency)}</span>
            }
          />
        )}
        {total != null && (
          <Row
            label="Totalt"
            value={
              <span className="tabular-nums font-medium text-foreground">
                {formatCurrency(total, currency)}
              </span>
            }
          />
        )}
      </div>
    </div>
  )
}

function VoucherPreview({ preview }: { preview: Record<string, unknown> }) {
  const lines = (preview.lines as { account?: string; debit?: number; credit?: number; description?: string }[] | undefined) ?? []
  const date = preview.date as string | undefined
  const description = preview.description as string | undefined

  if (lines.length === 0) return <GenericPreview preview={preview} />

  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs space-y-1.5">
      {date && <Row label="Datum" value={<span className="tabular-nums">{date}</span>} />}
      {description && (
        <Row label="Notering" value={<span className="text-foreground">{description}</span>} />
      )}
      <div className="pt-1 mt-1 border-t border-border space-y-0.5">
        {lines.map((l, i) => (
          <Row
            key={i}
            label={i === 0 ? 'Rader' : ''}
            value={
              <span className="tabular-nums">
                <strong className="font-medium">{l.account ?? '?'}</strong>
                <span className="text-muted-foreground"> · </span>
                {l.debit != null && l.debit !== 0 && <span>D {formatCurrency(l.debit)}</span>}
                {l.credit != null && l.credit !== 0 && <span>K {formatCurrency(l.credit)}</span>}
                {l.description && (
                  <span className="text-muted-foreground/70 ml-2 truncate">{l.description}</span>
                )}
              </span>
            }
          />
        ))}
      </div>
    </div>
  )
}

// Fallback: render the top-level key/value pairs from any preview object.
// Strips internal-looking keys, formats numbers tabular, truncates long
// strings. Caps at 8 rows to keep the card compact.
function GenericPreview({ preview }: { preview: Record<string, unknown> }) {
  const rows: { key: string; value: string }[] = []
  for (const [k, v] of Object.entries(preview)) {
    if (rows.length >= 8) break
    if (k.startsWith('_') || k === 'period_status') continue
    if (v == null) continue
    if (typeof v === 'object') continue
    rows.push({ key: prettyKey(k), value: String(v) })
  }
  if (rows.length === 0) return null
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs space-y-1">
      {rows.map((r) => (
        <Row key={r.key} label={r.key} value={<span className="tabular-nums">{r.value}</span>} />
      ))}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-baseline">
      <span className="w-20 shrink-0 text-muted-foreground text-[10px] uppercase tracking-wider">
        {label}
      </span>
      <span className="flex-1 min-w-0 leading-5">{value}</span>
    </div>
  )
}

function prettyKey(k: string): string {
  // 'customer_name' → 'Customer name' → keep Swedish-leaning by capitalising
  // first letter only; lots of preview keys are already short.
  const spaced = k.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function PeriodBadge({ status }: { status: PeriodStatus }) {
  if (status.status === 'open') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-success">
        <ShieldCheck className="h-3 w-3" /> Period öppen
      </span>
    )
  }
  if (status.status === 'locked') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-warning">
        <Lock className="h-3 w-3" /> Period låst
        {status.lock_date ? <span className="tabular-nums">· {status.lock_date}</span> : null}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-destructive">
      <Lock className="h-3 w-3" /> Period stängd
    </span>
  )
}

function translateRisk(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'low') return 'låg'
  if (risk === 'medium') return 'medel'
  return 'hög'
}
