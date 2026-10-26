'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'

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
      <Input readOnly value={url} aria-label={label} className="min-w-0 font-mono text-[12.5px]" onFocus={(e) => e.currentTarget.select()} />
      <Button type="button" variant="secondary" size="sm" onClick={copy}>
        {t('copy_link')}
      </Button>
    </div>
  )
}
