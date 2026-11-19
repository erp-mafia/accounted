'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * A plain form POST, so the click works without JavaScript too. The script's
 * one job is to stop a second submit: a double-click sends the held token
 * twice, and the second, rejected answer is the page the browser keeps.
 */
export function ConfirmLinkForm({
  action,
  label,
  busyLabel,
}: {
  action: string
  label: string
  busyLabel: string
}) {
  const [busy, setBusy] = useState(false)

  return (
    <form
      method="post"
      action={action}
      onSubmit={(event) => {
        if (busy) event.preventDefault()
        else setBusy(true)
      }}
    >
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        {busy ? busyLabel : label}
      </Button>
    </form>
  )
}
