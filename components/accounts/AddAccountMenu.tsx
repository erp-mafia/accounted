'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Landmark, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * The one way in for anything that brings transactions (UI v2 PR 8): a
 * dialog with every source on view, each with its mark and one line on what
 * it brings. A bank through PSD2, the skattekonto through Skatteverket, and
 * the payment and shop services through their imports. Each row lands on
 * the page that connects that source; nothing is set up from here.
 */
const SOURCES: ReadonlyArray<{ key: string; href: string; logo: string | null }> = [
  { key: 'bank', href: '/settings/banking', logo: null },
  { key: 'skattekonto', href: '/settings/skatteverket', logo: '/logos/skatteverket_color.svg' },
  { key: 'stripe', href: '/import?mode=stripe', logo: '/logos/banks/stripe.png' },
  { key: 'shopify', href: '/import?mode=shopify', logo: '/logos/shopify.svg' },
  { key: 'woocommerce', href: '/import?mode=woocommerce', logo: '/logos/woocommerce.svg' },
]

export default function AddAccountMenu() {
  const t = useTranslations('accounts_v2')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        {t('add_account')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md p-0">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle>{t('add_account')}</DialogTitle>
          </DialogHeader>
          <ul className="border-t border-border/70 pb-2">
            {SOURCES.map((s) => (
              <li key={s.key}>
                <Link
                  href={s.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 px-5 py-3 transition-colors duration-150 hover:bg-secondary/60"
                >
                  {s.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.logo} alt="" className="h-8 w-8 shrink-0 rounded-sm object-contain" />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-secondary text-muted-foreground">
                      <Landmark className="h-4 w-4" />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{t(`add_${s.key}`)}</span>
                    <span className="block text-[12px] text-muted-foreground">{t(`add_${s.key}_desc`)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
