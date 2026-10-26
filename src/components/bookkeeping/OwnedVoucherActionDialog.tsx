'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { VoucherOwner } from '@/lib/core/bookkeeping/voucher-owner'

/**
 * Vänd or Rätta on a verifikat that an invoice, a periodisering, an asset or
 * a payroll run owns (lib/core/bookkeeping/voucher-owner.ts). Leads with the
 * owner's own action, which keeps the object in step with the books, and
 * keeps "only the verifikat" as the second way on, with what that leaves
 * behind said up front. Nothing is refused: the second way opens the same
 * reverse confirm or correction dialog as on any other verifikat.
 */
export function OwnedVoucherActionDialog({
  owner,
  intent,
  open,
  onOpenChange,
  onProceed,
}: {
  owner: VoucherOwner
  intent: 'reverse' | 'correct'
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Go on with the verifikat alone. */
  onProceed: () => void
}) {
  const router = useRouter()
  const t = useTranslations('journal_detail')
  const ownerPhrase = `${t(`owner_name_${owner.kind}`).toLocaleLowerCase()} ${owner.label ?? ''}`.trim()

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('owned_dialog_title', { owner: ownerPhrase })}
      description={`${t(`owned_body_${owner.action}`)} ${t(`owned_consequence_${owner.kind}`)}`}
      confirmLabel={t(`owned_action_${owner.action}`)}
      onConfirm={() => router.push(owner.action_href)}
      secondaryLabel={t(intent === 'reverse' ? 'owned_secondary_reverse' : 'owned_secondary_correct')}
      onSecondary={onProceed}
    />
  )
}
