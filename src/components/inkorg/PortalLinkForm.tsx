'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { normalizePortalUrl } from '@/lib/receipt-hunt/company-portals'
import { cn } from '@/lib/utils'

/**
 * The one field a supplier portal takes: the link to the page with the
 * invoices, and Spara. Enter saves, Esc puts it away. A link pasted without
 * https:// is fine; one the rule refuses (lib/receipt-hunt/company-portals.ts)
 * is marked on the field and never sent. With `onRemove` it also offers a
 * quiet "Ta bort portalen" (a portal the company added, changed in place).
 */
export function PortalLinkForm({
  initialUrl = '',
  onSave,
  onCancel,
  onRemove,
  className,
}: {
  initialUrl?: string
  /** Resolves true when it was saved; the form then stays as the caller decides. */
  onSave: (url: string) => Promise<boolean>
  onCancel: () => void
  onRemove?: () => Promise<void>
  className?: string
}) {
  const t = useTranslations('inkorg')
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [value, setValue] = useState(initialUrl)
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const link = normalizePortalUrl(value)
    if (!link.ok) {
      setInvalid(true)
      toast({ title: t('portal_url_invalid'), variant: 'destructive' })
      inputRef.current?.focus()
      return
    }
    setBusy('save')
    try {
      await onSave(link.url)
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    if (!onRemove || busy) return
    setBusy('remove')
    try {
      await onRemove()
    } finally {
      setBusy(null)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }

  return (
    <form onSubmit={(e) => void submit(e)} className={cn('flex flex-wrap items-center gap-2 animate-fade-in', className)}>
      <Input
        ref={inputRef}
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          if (invalid) setInvalid(false)
        }}
        onKeyDown={onKeyDown}
        placeholder={t('portal_url_placeholder')}
        aria-label={t('portal_url_placeholder')}
        aria-invalid={invalid || undefined}
        disabled={busy !== null}
        className="h-9 min-w-0 flex-1 basis-56 text-[13px]"
      />
      <Button type="submit" variant="outline" loading={busy === 'save'} disabled={busy === 'remove'}>
        {t('portal_save')}
      </Button>
      {onRemove && (
        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy !== null}
          className={cn(QUIET_LINK_CLASS, 'ml-2 disabled:opacity-50')}
        >
          {t('portal_remove')}
        </button>
      )}
    </form>
  )
}
