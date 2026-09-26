'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Landmark } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WhatsAppMark } from '@/components/extensions/general/WhatsAppMark'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { useCompany } from '@/contexts/CompanyContext'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { createClient } from '@/lib/supabase/client'

// Bank logos shipped in public/logos/banks, matched against the connected
// bank's display name (lowercased, spaces removed).
const BANK_LOGOS: Array<[match: string, file: string]> = [
  ['seb', 'seb'],
  ['swedbank', 'swedbank'],
  ['handelsbanken', 'handelsbanken'],
  ['nordea', 'nordea'],
  ['danske', 'danske'],
  ['länsförsäkringar', 'lansforsakringar'],
  ['lansforsakringar', 'lansforsakringar'],
  ['lunar', 'lunar'],
  ['revolut', 'revolut'],
  ['wise', 'wise'],
  ['svea', 'svea'],
]

function bankLogo(bankName: string | null): string | null {
  if (!bankName) return null
  const key = bankName.toLowerCase().replace(/\s+/g, '')
  return BANK_LOGOS.find(([match]) => key.includes(match))?.[1] ?? null
}

/** 28px tile holding a brand mark, so every connection row starts the same way. */
function LogoTile({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-white">
      {children}
    </span>
  )
}

function ImgLogo({ src }: { src: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className="h-5 w-5 object-contain" />
}

interface Status {
  bankName: string | null
  bankCount: number
  skvConnected: boolean
  peppolOn: boolean
}

/**
 * AI och kopplingar → Kopplingar: every connection that fetches or sends data
 * for the company, in one list. Until 2026-09-24 the bank sat under Verktyg,
 * the Skatteverket connection under Skatt, Peppol under Fakturering and
 * WhatsApp under Verktyg. Each row shows its state and links to the page that
 * manages it; those pages keep their own URLs because OAuth callbacks and
 * deep links land on them.
 */
export function ConnectionsSettingsContent() {
  const t = useTranslations('settings_connections')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const { company, isSandbox } = useCompany()
  const companyId = company?.id ?? null
  const [status, setStatus] = useState<Status | null>(null)

  const hasBanking = ENABLED_EXTENSION_IDS.has('enable-banking') && !isSandbox
  const hasSkatteverket = ENABLED_EXTENSION_IDS.has('skatteverket') && !isSandbox
  const hasWhatsApp = ENABLED_EXTENSION_IDS.has('whatsapp-inbox') && !isSandbox
  const hasStripe = ENABLED_EXTENSION_IDS.has('stripe')
  const hasShopify = ENABLED_EXTENSION_IDS.has('shopify')
  const hasWooCommerce = ENABLED_EXTENSION_IDS.has('woocommerce')
  const hasZettle = ENABLED_EXTENSION_IDS.has('zettle')

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    const supabase = createClient()
    // Best-effort readouts: a failed read shows the row without a state
    // rather than blocking the page.
    // Skatteverket tokens are per user (each user signs their own BankID
    // consent), so the readout asks for the signed-in user's token.
    const skvCount = (async () => {
      const { data } = await supabase.auth.getUser()
      if (!data.user) return 0
      const { count } = await supabase
        .from('skatteverket_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('user_id', data.user.id)
      return count ?? 0
    })()
    Promise.allSettled([
      supabase
        .from('bank_connections')
        .select('bank_name')
        .eq('company_id', companyId)
        .eq('status', 'active'),
      skvCount,
      fetch('/api/settings/peppol').then((res) => (res.ok ? res.json() : null)),
    ]).then(([bank, skv, peppol]) => {
      if (cancelled) return
      const banks = bank.status === 'fulfilled' ? ((bank.value.data ?? []) as Array<{ bank_name: string | null }>) : []
      const registration =
        peppol.status === 'fulfilled'
          ? (peppol.value as { data?: { registration?: { status?: string } | null } } | null)?.data?.registration
          : null
      setStatus({
        bankName: banks[0]?.bank_name ?? null,
        bankCount: banks.length,
        skvConnected: skv.status === 'fulfilled' && skv.value > 0,
        peppolOn: registration?.status === 'registered' || registration?.status === 'pending',
      })
    })
    return () => {
      cancelled = true
    }
  }, [companyId])

  const bankFile = bankLogo(status?.bankName ?? null)

  function row(opts: {
    logo: React.ReactNode
    name: string
    help: string
    state?: string | null
    href: string
    /** null: the state is not read here, so the button just opens the page. */
    connected: boolean | null
  }) {
    return (
      <SettingsRow
        label={
          <span className="flex items-center gap-3">
            <LogoTile>{opts.logo}</LogoTile>
            {opts.name}
          </span>
        }
        help={opts.help}
      >
        {opts.state ? <SettingsRowNote className={opts.connected ? 'text-foreground' : undefined}>{opts.state}</SettingsRowNote> : null}
        <SettingsRowEnd>
          <Button variant="outline" size="sm" asChild>
            <Link href={opts.href}>{opts.connected === null ? t('open') : opts.connected ? t('manage') : t('connect')}</Link>
          </Button>
        </SettingsRowEnd>
      </SettingsRow>
    )
  }

  const off = status ? t('not_connected') : null

  return (
    <div>
      <SettingsSectionHeader title={tNav('connections')} intro={tIntro('connections')} />

      {hasBanking || hasSkatteverket ? (
        <SettingsGroup label={t('group_bank_authorities')}>
          {hasBanking &&
            row({
              logo: bankFile ? <ImgLogo src={`/logos/banks/${bankFile}.png`} /> : <Landmark className="h-4 w-4 text-foreground" aria-hidden="true" />,
              name: t('bank'),
              help: t('bank_help'),
              state: status
                ? status.bankCount > 0
                  ? status.bankCount > 1
                    ? t('bank_connected_many', { bank: status.bankName ?? '', count: status.bankCount })
                    : t('bank_connected', { bank: status.bankName ?? '' })
                  : off
                : null,
              href: '/settings/banking',
              connected: (status?.bankCount ?? 0) > 0,
            })}
          {hasSkatteverket &&
            row({
              logo: <ImgLogo src="/logos/skatteverket_color.svg" />,
              name: t('skatteverket'),
              help: t('skatteverket_help'),
              state: status ? (status.skvConnected ? t('connected') : off) : null,
              href: '/settings/skatteverket',
              connected: status?.skvConnected ?? false,
            })}
        </SettingsGroup>
      ) : null}

      <SettingsGroup label={t('group_documents')}>
        {row({
          logo: <span className="text-[11px] font-semibold text-foreground">P</span>,
          name: t('peppol'),
          help: t('peppol_help'),
          state: status ? (status.peppolOn ? t('peppol_on') : off) : null,
          href: '/settings/peppol',
          connected: status?.peppolOn ?? false,
        })}
        {hasWhatsApp &&
          row({
            logo: <WhatsAppMark size={28} />,
            name: t('whatsapp'),
            help: t('whatsapp_help'),
            href: '/settings/whatsapp',
            connected: null,
          })}
      </SettingsGroup>

      {hasStripe || hasShopify || hasWooCommerce || hasZettle ? (
        <SettingsGroup label={t('group_payments_shop')}>
          {hasStripe &&
            row({
              logo: <ImgLogo src="/logos/banks/stripe.png" />,
              name: t('stripe'),
              help: t('stripe_help'),
              href: '/import?mode=stripe',
              connected: null,
            })}
          {hasShopify &&
            row({
              logo: <ImgLogo src="/logos/shopify.svg" />,
              name: t('shopify'),
              help: t('shop_help'),
              href: '/import?mode=shopify',
              connected: null,
            })}
          {hasWooCommerce &&
            row({
              logo: <ImgLogo src="/logos/woocommerce.svg" />,
              name: t('woocommerce'),
              help: t('shop_help'),
              href: '/import?mode=woocommerce',
              connected: null,
            })}
          {hasZettle &&
            row({
              logo: <ImgLogo src="/logos/zettle.svg" />,
              name: t('zettle'),
              help: t('zettle_help'),
              href: '/import?mode=zettle',
              connected: null,
            })}
        </SettingsGroup>
      ) : null}
    </div>
  )
}
