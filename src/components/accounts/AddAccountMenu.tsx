'use client'

import { Fragment, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { BuildingLibraryIcon, CreditCardIcon, PlusIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import AddCardAccountDialog from './AddCardAccountDialog'

/**
 * The one way in for anything that brings transactions (UI v2 PR 8): a
 * dialog with every source on view, each with its mark and one line on what
 * it brings. A bank through PSD2, the skattekonto through Skatteverket, and
 * the payment and shop services through their imports. Each row lands on
 * the page that connects that source; nothing is set up from here. The
 * payment and shop rows are listed only when their extension is enabled, as
 * in Kopplingar and on the import page. A company card is set up right here
 * (AddCardAccountDialog): it has no connection page of its own.
 */
const SOURCES: ReadonlyArray<{ key: string; href: string; logo: string | null; extension?: string }> = [
  { key: 'bank', href: '/settings/banking', logo: null },
  { key: 'skattekonto', href: '/settings/skatteverket', logo: null },
  { key: 'stripe', href: '/import?mode=stripe', logo: '/logos/banks/stripe.png', extension: 'stripe' },
  { key: 'shopify', href: '/import?mode=shopify', logo: '/logos/shopify.svg', extension: 'shopify' },
  { key: 'woocommerce', href: '/import?mode=woocommerce', logo: '/logos/woocommerce.svg', extension: 'woocommerce' },
  { key: 'zettle', href: '/import?mode=zettle', logo: '/logos/zettle.svg', extension: 'zettle' },
]

// The enabled set is fixed at build time, so filtering once is enough.
const LISTED_SOURCES = SOURCES.filter((s) => !s.extension || ENABLED_EXTENSION_IDS.has(s.extension))

const ROW_CLASS =
  'flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-150 hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none'

function RowText({ title, description }: { title: string; description: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-[13px] font-medium">{title}</span>
      <span className="block text-xs text-muted-foreground">{description}</span>
    </span>
  )
}

function IconTile({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-secondary text-muted-foreground">
      {children}
    </span>
  )
}

export default function AddAccountMenu() {
  const t = useTranslations('accounts_v2')
  const [open, setOpen] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  // Every choice in the dialog connects or creates an account.
  const { canWrite, lockedTitle } = useViewerLock()
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={!canWrite} title={lockedTitle}>
        <PlusIcon className="h-4 w-4" />
        {t('add_account')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="confirm" className="p-0">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle>{t('add_account')}</DialogTitle>
          </DialogHeader>
          <ul className="border-t-hairline pb-2">
            {LISTED_SOURCES.map((s) => (
              <Fragment key={s.key}>
                <li>
                  <Link href={s.href} onClick={() => setOpen(false)} className={ROW_CLASS}>
                    {s.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.logo} alt="" className="h-8 w-8 shrink-0 rounded-sm object-contain" />
                    ) : (
                      <IconTile><BuildingLibraryIcon className="h-4 w-4" /></IconTile>
                    )}
                    <RowText title={t(`add_${s.key}`)} description={t(`add_${s.key}_desc`)} />
                  </Link>
                </li>
                {/* Right after the bank: a card is the other account a company pays from. */}
                {s.key === 'bank' && (
                  <li>
                    <button
                      type="button"
                      className={ROW_CLASS}
                      onClick={() => { setOpen(false); setCardOpen(true) }}
                    >
                      <IconTile><CreditCardIcon className="h-4 w-4" /></IconTile>
                      <RowText title={t('add_card')} description={t('add_card_desc')} />
                    </button>
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      <AddCardAccountDialog open={cardOpen} onOpenChange={setCardOpen} />
    </>
  )
}
