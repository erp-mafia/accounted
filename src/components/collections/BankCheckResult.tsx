'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useBankSync } from '@/components/transactions/BankSyncNowButton'
import type { BankCheckState } from '@/lib/collections/handover-dialog'
import type { BankCheckView } from '@/lib/collections/invoice-collection'
import { formatKronor } from '@/lib/collections/amount-text'
import { formatDate, formatDateTime } from '@/lib/utils'

/**
 * The bank check as both collections dialogs show it (build spec 3.4): a
 * clean pass, the unbooked rows that may be the payment (each one can be
 * marked as something else), or a bank that is not fresh, with a sync and
 * the person's attestation. The handover dialog and the escalation dialog
 * on the case card share it so the check reads the same in both.
 */
export function BankCheckResult({
  bank,
  state,
  dismissed,
  onToggleDismissed,
  attested,
  onAttestedChange,
  onSynced,
  tp,
}: {
  bank: BankCheckView
  state: BankCheckState
  dismissed: readonly string[]
  onToggleDismissed: (transactionId: string) => void
  attested: boolean
  onAttestedChange: (attested: boolean) => void
  /** The bank was synced from here: read the check again. */
  onSynced: () => void
  tp: (key: string, values?: Record<string, string | number>) => string
}) {
  return (
    <div className="min-w-0 space-y-2">
      {state.outcome === 'pass' && (
        <p>
          {bank.lastSyncedAt
            ? tp('bank_check_pass', { date: formatDateTime(bank.lastSyncedAt) })
            : tp('bank_check_pass_no_date')}
        </p>
      )}
      {state.blocking.length > 0 && (
        <p>
          {tp('bank_check_candidates', { count: state.blocking.length })}{' '}
          <Link href="/transactions" className="underline underline-offset-2">
            {tp('bank_check_candidates_link')}
          </Link>
        </p>
      )}
      {bank.candidates.length > 0 && (
        <ul className="space-y-1" data-ph-mask="">
          {bank.candidates.map((c) => {
            const isDismissed = c.dismissed || dismissed.includes(c.transactionId)
            return (
              <li key={c.transactionId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12.5px]">
                <span className="tabular-nums text-muted-foreground">{formatDate(c.date)}</span>
                <span className="tabular-nums">{formatKronor(c.amount)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.description}</span>
                {!c.dismissed && (
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => onToggleDismissed(c.transactionId)}
                  >
                    {isDismissed ? tp('bank_check_undo') : tp('bank_check_dismiss')}
                  </button>
                )}
                {isDismissed && <span className="text-muted-foreground">{tp('bank_check_dismissed')}</span>}
              </li>
            )
          })}
        </ul>
      )}
      {state.needsAttest && (
        <>
          <p>
            {state.outcome === 'no_bank'
              ? tp('bank_check_no_bank')
              : state.staleAccount?.syncedAt
                ? tp('bank_check_stale', {
                    account: state.staleAccount.name,
                    date: formatDateTime(state.staleAccount.syncedAt),
                  })
                : tp('bank_check_stale_never', { account: state.staleAccount?.name ?? '' })}
          </p>
          {state.outcome === 'no_bank' ? (
            <Link href="/settings/banking" className="inline-block underline underline-offset-2">
              {tp('bank_check_connect')}
            </Link>
          ) : (
            <SyncBankNow label={tp('bank_check_sync_now')} onSynced={onSynced} />
          )}
          <label className="flex items-start gap-2">
            <Checkbox checked={attested} onCheckedChange={(v) => onAttestedChange(v === true)} className="mt-0.5" />
            <span>{tp('bank_check_attest')}</span>
          </label>
        </>
      )}
    </div>
  )
}

/** "Synka banken nu": a user-present sync of every connected bank, then the check runs again. */
function SyncBankNow({ label, onSynced }: { label: string; onSynced: () => void }) {
  const { hasBankSync, isBusy, syncAll } = useBankSync()
  if (!hasBankSync) {
    return (
      <Link href="/settings/banking" className="inline-block underline underline-offset-2">
        {label}
      </Link>
    )
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      loading={isBusy}
      onClick={async () => {
        await syncAll()
        onSynced()
      }}
    >
      {label}
    </Button>
  )
}
