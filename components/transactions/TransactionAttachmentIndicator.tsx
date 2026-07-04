'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Paperclip, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'

interface Props {
  documentId: string | null | undefined
  /** The booked tx's journal entry: link target when the underlag lives only
   *  at verifikat level (multi-doc entries, booking-dialog uploads). */
  journalEntryId?: string | null
  /** Underlag exists on the journal entry even though no doc is pinned to the
   *  transaction row (computeJeUnderlagStatus === 'has'). */
  hasJeDoc?: boolean
  /** Booked, requires underlag, has none (computeJeUnderlagStatus === 'missing'). */
  missing?: boolean
  /** Opens the attach dialog from the negative state. Omit for viewers:
   *  the badge then renders non-interactive. */
  onAttach?: () => void
  className?: string
}

const badgeClass = 'h-4 gap-1 px-1.5 py-0 text-[10px] font-normal'
// Enlarges the hit area beyond the 16px badge without shifting layout.
const hitAreaClass = 'shrink-0 p-1 -m-1'

/**
 * Per-row underlag status for the /transactions lists.
 *
 * - Pinned doc (transactions.document_id): clickable badge that fetches a
 *   signed URL and opens the document in a new tab.
 * - Verifikat-level doc only: same badge, links to the verifikat page (which
 *   lists all attachments: handles multi-doc without a per-row fetch).
 * - Missing on a booked row: discreet outline badge that doubles as the
 *   attach affordance when onAttach is provided.
 */
export function TransactionAttachmentIndicator({
  documentId,
  journalEntryId,
  hasJeDoc,
  missing,
  onAttach,
  className,
}: Props) {
  const t = useTranslations('tx_underlag')
  const { toast } = useToast()
  const [isLoading, setIsLoading] = useState(false)

  const handleOpen = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (isLoading || !documentId) return
    setIsLoading(true)
    try {
      const res = await fetch(`/api/documents/${documentId}`)
      if (!res.ok) {
        toast({ title: t('open_failed'), variant: 'destructive' })
        return
      }
      const { data } = await res.json()
      if (data?.download_url) {
        window.open(data.download_url, '_blank', 'noopener,noreferrer')
      }
    } finally {
      setIsLoading(false)
    }
  }

  if (documentId) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        title={t('attached_title')}
        aria-label={t('attached_aria')}
        className={cn(hitAreaClass, className)}
      >
        <Badge variant="secondary" className={badgeClass}>
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Paperclip className="h-3 w-3" />
          )}
          {t('attached_label')}
        </Badge>
      </button>
    )
  }

  if (hasJeDoc && journalEntryId) {
    return (
      <Link
        href={`/bookkeeping/${journalEntryId}`}
        title={t('attached_title')}
        aria-label={t('attached_aria')}
        onClick={(e) => e.stopPropagation()}
        className={cn(hitAreaClass, className)}
      >
        <Badge variant="secondary" className={badgeClass}>
          <Paperclip className="h-3 w-3" />
          {t('attached_label')}
        </Badge>
      </Link>
    )
  }

  if (missing) {
    const badge = (
      <Badge variant="outline" className={cn(badgeClass, 'text-muted-foreground')}>
        <Paperclip className="h-3 w-3" />
        {t('missing_label')}
      </Badge>
    )
    if (!onAttach) return <span className={cn('shrink-0', className)}>{badge}</span>
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onAttach()
        }}
        title={t('missing_title')}
        aria-label={t('missing_title')}
        className={cn(hitAreaClass, className)}
      >
        {badge}
      </button>
    )
  }

  return null
}
