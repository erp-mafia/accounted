'use client'

import { LockClosedIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'

/**
 * The submit row at the end of a register form (customer, supplier): the
 * one primary, locked with a tooltip for a viewer and loading while the
 * save runs. A form hosted in a drawer leaves it out: the drawer's fixed
 * footer carries the primary and submits the form through its id.
 */
export function FormSubmitRow({
  canWrite,
  isLoading,
  label,
  savingLabel,
  viewerTitle,
}: {
  canWrite: boolean
  isLoading: boolean
  label: string
  savingLabel: string
  viewerTitle: string
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="submit" disabled={!canWrite} loading={isLoading} title={!canWrite ? viewerTitle : undefined}>
        {isLoading ? (
          savingLabel
        ) : !canWrite ? (
          <>
            <LockClosedIcon className="h-4 w-4" />
            {label}
          </>
        ) : (
          label
        )}
      </Button>
    </div>
  )
}
