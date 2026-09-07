'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The one way in for anything that brings transactions (UI v2 PR 8): a bank
 * through PSD2, the skattekonto through Skatteverket, and the payment and
 * shop services through their imports. Each item lands on the page that
 * connects that source; nothing is set up from here.
 */
const SOURCES: ReadonlyArray<{ key: string; href: string }> = [
  { key: 'bank', href: '/settings/banking' },
  { key: 'skattekonto', href: '/settings/skatteverket' },
  { key: 'stripe', href: '/import?mode=stripe' },
  { key: 'shopify', href: '/import?mode=shopify' },
  { key: 'woocommerce', href: '/import?mode=woocommerce' },
]

export default function AddAccountMenu() {
  const t = useTranslations('accounts_v2')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          {t('add_account')}
          <ChevronDown className="ml-2 h-3.5 w-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SOURCES.map((s) => (
          <DropdownMenuItem key={s.key} asChild>
            <Link href={s.href}>{t(`add_${s.key}`)}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
