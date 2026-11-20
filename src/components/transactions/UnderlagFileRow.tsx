'use client'

import { DocumentTextIcon, XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'

/**
 * One attached document in a booking dialog's underlag list: the
 * transaction's own underlag beside its viewer, or an inkorg pick held for
 * the verifikat. Same row as DocumentUploadZone's file list.
 */
export default function UnderlagFileRow({
  name,
  removeLabel,
  onRemove,
  disabled = false,
}: {
  name: string
  removeLabel: string
  onRemove: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-sm bg-muted/50 px-2 py-1.5 text-sm">
      <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span data-ph-mask="" className="min-w-0 flex-1 truncate" title={name}>
        {name}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label={removeLabel}
        disabled={disabled}
        onClick={onRemove}
      >
        <XMarkIcon className="h-3 w-3" />
      </Button>
    </div>
  )
}
