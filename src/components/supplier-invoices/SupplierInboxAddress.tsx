'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { EnvelopeIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { copyToClipboard } from '@/lib/browser/copy-to-clipboard'
import { tagInboxAddress } from '@/lib/documents/inbox-address'

/**
 * The address suppliers mail invoices to, in the Leverantörsfakturor top bar.
 *
 * Why it is here: the address lived only behind the sources chip in Underlag,
 * so people working with supplier invoices had to be told where to find it.
 * The `+lev` variant is shown so a forwarded invoice arrives already declared
 * as a supplier invoice.
 *
 * The invoice-inbox route is the single gate: it answers non-OK when the
 * extension is off, the plan lacks the capability, the install has no inbound
 * domain or the company has no active inbox, and in every one of those cases
 * there is no address to give out, so nothing renders.
 */
export function SupplierInboxAddress() {
  const t = useTranslations('supplier_invoices')
  const { toast } = useToast()
  const [address, setAddress] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/extensions/ext/invoice-inbox/inbox/address')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const base = json?.data?.address
        if (!cancelled && typeof base === 'string') setAddress(tagInboxAddress(base, 'lev'))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!address) return null
  const shown = address

  async function handleCopy() {
    // The clipboard write is the first await, so the click's user activation
    // still holds when it runs.
    const result = await copyToClipboard(shown)
    if (result === 'copied') {
      toast({ title: t('inbox_address_copied') })
    } else {
      // The label is hidden on a phone, so the toast carries the address.
      toast({ title: t('inbox_address_copy_failed', { address: shown }), variant: 'destructive' })
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="min-w-0 gap-2 text-muted-foreground"
      onClick={handleCopy}
      title={t('inbox_address_hint')}
      aria-label={t('inbox_address_copy_label', { address: shown })}
    >
      <EnvelopeIcon className="h-4 w-4 shrink-0" />
      <span className="hidden min-w-0 truncate md:block">{shown}</span>
    </Button>
  )
}
