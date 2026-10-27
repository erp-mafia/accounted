'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ArrowTopRightOnSquareIcon } from '@/components/icons'

/**
 * The BankID signing link of an approved Skatteverket filing
 * (submit_vat_declaration, submit_agi). Approving locks the declaration at
 * Skatteverket and hands back a signing link; the filing happens only when a
 * person signs there. The dispatcher stores { status: 'awaiting_signature',
 * signing_url } in result_data (lib/pending-operations/commit.ts).
 * Only Skatteverket's https link renders as a link.
 */
export function signingUrlOf(data: Record<string, unknown> | null | undefined): string | null {
  if (!data || data.status !== 'awaiting_signature') return null
  const url = data.signing_url
  return typeof url === 'string' && url.startsWith('https://') ? url : null
}

/**
 * What to do after approving a filing (crm#1478): approving showed only
 * "Godkänd", so nobody was prompted to sign and the declaration stayed
 * locked at Skatteverket. `afterwards` adds the note for a history row, which
 * cannot know whether the person has signed since.
 */
export function SigningStep({ url, afterwards = false }: { url: string; afterwards?: boolean }) {
  const t = useTranslations('skv_signing')
  return (
    <div className="space-y-2 rounded-lg border border-border bg-secondary/25 px-3 py-2">
      <p className="text-[13px] font-medium">{t('awaiting_title')}</p>
      <p className="text-xs leading-snug text-muted-foreground">
        {t('awaiting_description')}
        {afterwards ? ` ${t('already_signed_note')}` : ''}
      </p>
      <Button size="sm" asChild className="gap-2">
        <a href={url} target="_blank" rel="noopener noreferrer">
          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          {t('sign_action')}
        </a>
      </Button>
    </div>
  )
}
