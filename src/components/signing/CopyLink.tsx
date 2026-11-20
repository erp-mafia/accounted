'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { ClipboardDocumentIcon } from '@/components/icons'

/**
 * A signer's link as text with Kopiera beside it: for a signer no mail
 * reached. The URL is the signer's credential, so it is shown only where the
 * sender asked for it and never stored in the page beyond this render.
 */
export function CopyLink({ url, label }: { url: string; label: string }) {
  const t = useTranslations('signing')
  const { toast } = useToast()

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: t('link_copied') })
    } catch {
      toast({ title: t('link_copy_failed'), variant: 'destructive' })
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Input readOnly value={url} aria-label={label} className="min-w-0 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button type="button" variant="outline" onClick={copy}>
        <ClipboardDocumentIcon className="h-4 w-4" />
        {t('copy_link')}
      </Button>
    </div>
  )
}
