'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  ArrowRightIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { PendingOperationRejectionCategory } from '@/types'
import { cn } from '@/lib/utils'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { OperationPreview, AccountNamesContext } from '@/components/pending-operations/OperationPreview'
import { useAccountNamesSource } from '@/components/pending-operations/use-account-names'
import { REJECTION_CATEGORY_LABELS } from '@/components/pending-operations/vocabulary'
import { operationTypeFromToolName } from '@/lib/pending-operations/tool-name'

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
// render the shared OperationPreview (components/pending-operations), the
// same renderers /pending uses, dispatched on operation_type. Live streamed
// cards carry the MCP tool name; hydrated cards carry the stored
// operation_type directly. Unknown types fall through to the generic
// key/value renderer so a new tool can ship without an ApprovalCard change.

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
  // The stored pending_operations.operation_type. Preferred over deriving it
  // from toolName: hydrated cards pass it straight from the DB row, so every
  // operation type keeps its specialized preview on resume.
  operationType?: string
  // pending_operations.params (the staging tool's input). Some previews read
  // it: attach_document's DocumentViewButton needs params.document_id.
  params?: Record<string, unknown>
  preview?: unknown
  periodStatus?: PeriodStatus
  // Fired after a reject that carries a reason: the chat feeds this synthetic
  // correction back as a hidden user turn so the agent re-proposes inline.
  onRequestCorrection?: (correctionMessage: string) => void
}

type State = 'pending' | 'committing' | 'committed' | 'rejecting' | 'rejected' | 'error'

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
  operationType,
  params,
  preview,
  periodStatus,
  onRequestCorrection,
}: Props) {
  // Gating the AI re-propose path only: approving/rejecting the staged
  // operation is manual ledger work and stays enabled without the AI add-on.
  // What's paid is feeding a rejection back so the agent generates a *new*
  // proposal (an LLM call): that's suppressed when the company lacks `ai`.
  const hasAi = useCapability(CAPABILITY.ai)
  // Approving and rejecting are ledger writes: locked for a read-only member.
  const { canWrite, lockedTitle } = useViewerLock()
  const t = useTranslations('pending')
  // Chart names for the preview lines (same source as /pending).
  const accountNames = useAccountNamesSource()
  const [state, setState] = useState<State>('pending')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  // Reject-with-reason form (mirrors the granskning dialog). Clicking "Avslå"
  // opens it; the category is required, the note optional. The rejection is
  // fed back so the agent re-proposes.
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

  // Render key for the shared preview. Hydrated cards pass operation_type
  // straight from the pending_operations row; live streamed cards carry the
  // MCP tool name, which maps to the bare operation_type by stripping the
  // wire prefix. The old dispatch keyed on 4 hardcoded tool names, so every
  // other hydrated type silently lost its specialized preview.
  const previewOperationType =
    operationType ?? (toolName ? operationTypeFromToolName(toolName) : '')

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
        // Map the parsed body plus the status, never `new Error(body.error)`:
        // the route answers thrown errors with the canonical envelope
        // `{ error: { code, message } }`, and the Error constructor would
        // stringify that object to "[object Object]", discarding the route's
        // own Swedish reason.
        setState('error')
        setErrorMessage(getUserErrorMessage(body, { statusCode: res.status }))
        return
      }
      // Best-effort deep-link to the created artifact in the success state.
      if (body?.data) setCommitResult(body.data)
      setState('committed')
    } catch (err) {
      setState('error')
      setErrorMessage(err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte godkänna.')
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
        const body = await res.json().catch(() => null)
        setState('error')
        setErrorMessage(getUserErrorMessage(body, { statusCode: res.status }))
        return
      }
      setAccountsToActivate(null)
      await handleCommit()
    } catch (err) {
      setState('error')
      setErrorMessage(err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte aktivera kontona.')
    }
  }

  async function handleReject() {
    // A person's rejection always says what was wrong (parity with the
    // granskning dialog): the button stays disabled until a category is picked.
    if (!rejectCategory) return
    setState('rejecting')
    setErrorMessage(null)
    const categoryLabel = REJECTION_CATEGORY_LABELS[rejectCategory]
    const reason = rejectReason.trim()
    const body = {
      rejection_category: rejectCategory,
      ...(reason ? { rejection_reason: reason } : {}),
    }
    try {
      const res = await fetch(`/api/pending-operations/${operationId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setState('error')
        setErrorMessage(getUserErrorMessage(body, { statusCode: res.status }))
        return
      }
      setShowRejectForm(false)
      setState('rejected')
      // Feed the correction back so the agent re-proposes.
      const parts = [categoryLabel, reason].filter(Boolean) as string[]
      if (hasAi) {
        onRequestCorrection?.(
          `Jag avvisade förslaget. Det som var fel: ${parts.join(', ')}. Föreslå en korrigerad bokning.`,
        )
      }
    } catch (err) {
      setState('error')
      setErrorMessage(err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte avslå.')
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
        className="bg-success/9 rounded-lg px-4 py-3 text-sm"
        aria-description={message}
      >
        <div className="flex items-center gap-2 font-medium">
          <CheckIcon className="h-4 w-4" /> Godkänt
        </div>
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
            <ArrowRightIcon className="h-3 w-3" />
          </Link>
        )}
      </div>
    )
  }

  if (state === 'rejected') {
    return (
      <div
        className="rounded-lg px-4 py-3 text-sm text-muted-foreground bg-control shadow-raised"
        aria-description={message}
      >
        <div className="flex items-center gap-2">
          <XMarkIcon className="h-4 w-4" /> Avslaget
          {rejectCategory && (
            <span className="text-xs text-muted-foreground">· {REJECTION_CATEGORY_LABELS[rejectCategory]}</span>
          )}
        </div>
      </div>
    )
  }

  const isBusy = state === 'committing' || state === 'rejecting'

  return (
    <div
      className={cn(
        // Subtle accent border-top tells the eye what to do BEFORE reading
        // the risk label. high = destructive red, medium = warning yellow,
        // low = neutral foreground. animate-fade-in gives the card a soft
        // entrance when it first lands inline in the conversation.
        'rounded-lg border bg-card px-4 py-3 space-y-3 border-t-2 animate-fade-in',
        riskLevel === 'high'
          ? 'border-destructive/50 border-t-destructive'
          : riskLevel === 'medium'
            ? 'border-border border-t-warning'
            : 'border-border border-t-foreground/30',
      )}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          Förslag · risk {translateRisk(riskLevel)}
        </p>
        {periodStatus && <PeriodBadge status={periodStatus} />}
      </div>

      {preview != null && typeof preview === 'object' && (
        <div className="rounded-lg px-3 py-2 bg-control shadow-raised">
          <AccountNamesContext.Provider value={accountNames}>
            <OperationPreview
              op={{
                operation_type: previewOperationType,
                preview_data: preview as Record<string, unknown>,
                params,
              }}
            />
          </AccountNamesContext.Provider>
        </div>
      )}

      {requiresTextConfirm && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-destructive">
            <ExclamationTriangleIcon className="h-3.5 w-3.5" />
            Hög risk: skriv <strong className="font-semibold">godkänn</strong> för att bekräfta.
          </div>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={isBusy}
            className="w-full rounded-lg px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-control shadow-raised"
            autoComplete="off"
            aria-label="Bekräfta med ordet godkänn"
          />
        </div>
      )}

      {errorMessage && <p className="text-xs text-destructive">{errorMessage}</p>}

      {showRejectForm ? (
        <div className="space-y-2 rounded-lg px-3 py-2 bg-control shadow-raised">
          <p className="text-xs font-medium">Vad är fel?</p>
          <Select
            value={rejectCategory}
            onValueChange={(v) => setRejectCategory(v as PendingOperationRejectionCategory)}
          >
            <SelectTrigger className="h-8 text-xs" aria-label="Anledning">
              <SelectValue placeholder={t('reject_category_label')} />
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
            <p className="text-xs text-muted-foreground">
              Med en anledning eller notering föreslår assistenten en korrigerad bokning direkt.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
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
              onClick={handleReject}
              disabled={!canWrite || isBusy || !rejectCategory}
              title={lockedTitle}
              loading={state === 'rejecting'}
              className="flex-1"
            >
              Avvisa
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowRejectForm(false)}
              disabled={isBusy}
              className="flex-1"
            >
              Avbryt
            </Button>
          </div>
        </div>
      ) : accountsToActivate ? (
        <div className="space-y-2 rounded-lg px-3 py-2 bg-control shadow-raised">
          <p className="text-xs leading-5">
            Bokningen använder konton som inte är aktiva i din kontoplan:{' '}
            <strong className="tabular-nums">{accountsToActivate.join(', ')}</strong>. Aktivera dem för att godkänna bokningen.
          </p>
          <div className="flex gap-2">
            <Button
              onClick={handleActivateAndCommit}
              disabled={!canWrite || isBusy}
              title={lockedTitle}
              loading={state === 'committing'}
              className="flex-1"
            >
              Aktivera och godkänn
            </Button>
            <Button
              variant="outline"
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
              onClick={handleCommit}
              disabled={!canWrite || isBusy || !canCommit}
              title={lockedTitle}
              loading={state === 'committing'}
              className="flex-1"
            >
              Godkänn
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowRejectForm(true)}
              disabled={!canWrite || isBusy}
              title={lockedTitle}
              className="flex-1"
            >
              Avslå
            </Button>
          </div>
          {/* Keep in sync with EXPIRY_DAYS in
              app/api/pending-operations/expire/cron/route.ts. */}
          <p className="text-xs text-muted-foreground">
            Om du inte gör något utgår förslaget automatiskt efter 30 dagar, inget bokförs.
          </p>
        </>
      )}
    </div>
  )
}

function PeriodBadge({ status }: { status: PeriodStatus }) {
  if (status.status === 'open') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <ShieldCheckIcon className="h-3 w-3" /> Period öppen
      </span>
    )
  }
  if (status.status === 'locked') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-warning">
        <LockClosedIcon className="h-3 w-3" /> Period låst
        {status.lock_date ? <span className="tabular-nums">· {status.lock_date}</span> : null}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-destructive">
      <LockClosedIcon className="h-3 w-3" /> Period stängd
    </span>
  )
}

function translateRisk(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'low') return 'låg'
  if (risk === 'medium') return 'medel'
  return 'hög'
}
