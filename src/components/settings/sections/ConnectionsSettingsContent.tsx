'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { HandCoins, Landmark, Store } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BankConnectDialog } from '@/components/bank-feed/BankConnectDialog'
import { OpenPaymentsConnectionRow } from '@/components/bank-feed/OpenPaymentsConnectionRows'
import { useBankConnectFlow } from '@/components/bank-feed/use-bank-connect-flow'
import { useBankConnectResume } from '@/components/bank-feed/use-bank-connect-resume'
import { useOpenPaymentsAvailability } from '@/components/bank-feed/use-open-payments-availability'
import { useOpenPaymentsConnections } from '@/components/bank-feed/use-open-payments-connections'
import { bankLogoUrl } from '@/lib/reconciliation/bank-logos'
import { collectionsEntryShown, useCollectionsAvailability } from '@/components/collections/collections-client'
import { GoogleMark } from '@/components/ui/provider-marks'
import { WhatsAppMark } from '@/components/extensions/general/WhatsAppMark'
import {
  fetchMailConnections,
  summarizeMailboxes,
  MAIL_SETTINGS_HREF,
  type MailboxSummary,
} from '@/components/extensions/general/mail-connections'
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
import { fetchPaymentsAvailability } from '@/components/payments/payments-client'

// Bank logos shipped in public/logos/banks, matched against the connected
// bank's display name (lowercased, spaces removed).
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
  /** Null when the mailboxes could not be read (the row then shows no state). */
  mail: MailboxSummary | null
  /** Bank payments are switched on for this company (the pilot list); the row shows only then. */
  /** The connected POS venue(s); null when none. */
  pos: { label: string; attention: boolean } | null
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
  // Påminnelser och inkasso shows only where the installation offers it to
  // this company, or where a connection already exists.
  const collections = useCollectionsAvailability()
  const showCollections = collectionsEntryShown(collections)
  const collectionsState = collections?.connection?.state ?? null

  const hasBanking = ENABLED_EXTENSION_IDS.has('enable-banking') && !isSandbox
  // Bank reading through Open Payments: switched on per company. When it is,
  // the bank rows are per connection (Enable Banking rows offer the switch,
  // Open Payments rows their renewal) and Koppla bank opens the flow here.
  const openPayments = useOpenPaymentsAvailability()
  const opAvailable = openPayments.status === 'available' && !isSandbox
  const bankFlow = useBankConnectFlow('connections')
  const bankConnections = useOpenPaymentsConnections(opAvailable ? companyId : null)
  const [bankGeneration, setBankGeneration] = useState(0)
  // A second signatory arrives with ?bank_connect=<id> (the reminder link),
  // and a bank that signs on its own page sends the person back the same way:
  // open the flow at its BankID step, once, and drop the params.
  useBankConnectResume(bankFlow, opAvailable)
  const hasSkatteverket = ENABLED_EXTENSION_IDS.has('skatteverket') && !isSandbox
  const hasWhatsApp = ENABLED_EXTENSION_IDS.has('whatsapp-inbox') && !isSandbox
  const hasMail = ENABLED_EXTENSION_IDS.has('mail') && !isSandbox
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
      hasMail ? fetchMailConnections() : Promise.resolve(null),
      supabase
        .from('pos_connections')
        .select('venue_name, provider_name, health')
        .eq('company_id', companyId)
        .eq('status', 'active'),
    ]).then(([bank, skv, peppol, mail, pos]) => {
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
        mail: mail.status === 'fulfilled' && mail.value ? summarizeMailboxes(mail.value) : null,
        pos: (() => {
          const venues = pos.status === 'fulfilled' ? ((pos.value.data ?? []) as Array<{ venue_name: string; provider_name: string; health: string }>) : []
          if (venues.length === 0) return null
          return {
            label: venues.length === 1 ? `${venues[0].venue_name} (${venues[0].provider_name})` : venues.map((v) => v.venue_name).join(', '),
            attention: venues.some((v) => v.health === 'action_required'),
          }
        })(),
      })
    })
    return () => {
      cancelled = true
    }
  }, [companyId, hasMail, bankGeneration])

  // Bank payments answer in well under a second; the row must not wait for
  // the slowest of the other readouts (mail, Peppol) to appear.
  const [bankPayments, setBankPayments] = useState<boolean | null>(null)
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (!cancelled) setBankPayments(data.available)
      })
      .catch(() => {
        if (!cancelled) setBankPayments(false)
      })
    return () => {
      cancelled = true
    }
  }, [companyId])

  const bankLogo = bankLogoUrl(status?.bankName)

  function row(opts: {
    logo: React.ReactNode
    name: string
    help: string
    state?: string | null
    href: string
    /** null: the state is not read here, so the button just opens the page. */
    connected: boolean | null
    /** The state is an exception the person has to act on (ochre). */
    attention?: boolean
    /** Replaces the default link button (the bank rows carry their own actions). */
    actions?: React.ReactNode
    /** The label carries user data (a bank name) and is masked in session replays. */
    maskLabel?: boolean
  }) {
    return (
      <SettingsRow
        label={
          <span className="flex items-center gap-3">
            <LogoTile>{opts.logo}</LogoTile>
            {opts.maskLabel ? <span data-ph-mask="">{opts.name}</span> : opts.name}
          </span>
        }
        help={opts.help}
      >
        {opts.state ? (
          <SettingsRowNote className={opts.attention ? 'text-attn' : opts.connected ? 'text-foreground' : undefined}>
            {opts.state}
          </SettingsRowNote>
        ) : null}
        <SettingsRowEnd>
          {opts.actions ?? (
            <Button variant="outline" size="sm" asChild>
              <Link href={opts.href}>{opts.connected === null ? t('open') : opts.connected ? t('manage') : t('connect')}</Link>
            </Button>
          )}
        </SettingsRowEnd>
      </SettingsRow>
    )
  }

  const bankLandmark = <Landmark className="h-4 w-4 text-foreground" aria-hidden="true" />

  // The bank rows when Open Payments reads for this company: one row per
  // connection. An Enable Banking row offers the switch; an Open Payments row
  // its state and renewal; none at all offers Koppla bank.
  function openPaymentsBankRows() {
    const rows = bankConnections.rows ?? []
    if (rows.length === 0) {
      return row({
        logo: bankLandmark,
        name: t('bank'),
        help: t('bank_help'),
        state: t('not_connected'),
        href: '/settings/banking',
        connected: false,
        actions: (
          <>
            {hasBanking && (
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/banking">{t('open')}</Link>
              </Button>
            )}
            <Button size="sm" onClick={() => bankFlow.open('new')}>
              {t('connect_bank')}
            </Button>
          </>
        ),
      })
    }
    return (
      <>
        {bankConnections.enableBanking.map((connection) => {
          const logo = bankLogoUrl(connection.bank_name)
          return (
            <div key={connection.id}>
              {row({
                logo: logo ? <ImgLogo src={logo} /> : bankLandmark,
                name: connection.bank_name ?? t('bank'),
                maskLabel: true,
                help: t('bank_help'),
                state: t('connected'),
                href: '/settings/banking',
                connected: true,
                actions: (
                  <>
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/settings/banking">{t('manage')}</Link>
                    </Button>
                    <Button size="sm" onClick={() => bankFlow.open('switch', { bank: { bic: '', name: connection.bank_name ?? '' }, replaceConnectionId: connection.id })}>
                      {t('switch_connection')}
                    </Button>
                  </>
                ),
              })}
            </div>
          )
        })}
        {bankConnections.openPayments.map((connection) => (
          <OpenPaymentsConnectionRow key={connection.id} connection={connection} flow={bankFlow} onChanged={bankConnections.refresh} />
        ))}
      </>
    )
  }

  const off = status ? t('not_connected') : null

  // Gmail shows once its read says there is something to offer: a mailbox,
  // or a company that may connect one. While Google's review keeps new
  // consents closed, a row whose button leads to a page with no connect
  // button is a dead end. A failed read still shows the row, stateless,
  // like every other row here.
  const mail = status?.mail ?? null
  const showMail = hasMail && status !== null && (mail === null || mail.available)
  const mailState = mail
    ? mail.needsReconnect.length > 0
      ? t('gmail_reconnect')
      : mail.active.length > 0
        ? t('gmail_connected', { count: mail.active.length })
        : off
    : null

  return (
    <div>
      <SettingsSectionHeader title={tNav('connections')} intro={tIntro('connections')} />

      {hasBanking || opAvailable || hasSkatteverket ? (
        <SettingsGroup label={t('group_bank_authorities')}>
          {opAvailable && bankConnections.rows !== null
            ? openPaymentsBankRows()
            : hasBanking &&
            row({
              logo: bankLogo ? <ImgLogo src={bankLogo} /> : <Landmark className="h-4 w-4 text-foreground" aria-hidden="true" />,
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
          {bankPayments &&
            row({
              logo: <Landmark className="h-4 w-4 text-foreground" aria-hidden="true" />,
              name: t('bank_payments'),
              help: t('bank_payments_help'),
              href: '/settings/bank-payments',
              connected: null,
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
        {showMail &&
          row({
            logo: <GoogleMark className="h-4 w-4" />,
            name: t('gmail'),
            help: t('gmail_help'),
            state: mailState,
            href: MAIL_SETTINGS_HREF,
            connected: mail ? mail.active.length + mail.needsReconnect.length > 0 : null,
            attention: (mail?.needsReconnect.length ?? 0) > 0,
          })}
      </SettingsGroup>

      {!isSandbox || hasStripe || hasShopify || hasWooCommerce || hasZettle || showCollections ? (
        <SettingsGroup label={t('group_payments_shop')}>
          {/* Kassasystem: core, not an extension (provider code lives in Accounted Connect). */}
          {!isSandbox &&
            row({
              logo: <Store className="h-4 w-4 text-muted-foreground" aria-hidden="true" />,
              name: t('pos'),
              help: t('pos_help'),
              state: status?.pos ? (status.pos.attention ? t('pos_state_attention', { venue: status.pos.label }) : status.pos.label) : null,
              href: '/settings/pos',
              connected: status ? status.pos !== null : null,
              attention: status?.pos?.attention ?? false,
            })}
          {showCollections &&
            row({
              logo: <HandCoins className="h-4 w-4 text-foreground" aria-hidden="true" />,
              name: t('collections'),
              help: t('collections_help'),
              state:
                collectionsState === 'active'
                  ? t('collections_active')
                  : collectionsState === 'connecting' || collectionsState === 'needs_setup'
                    ? t('collections_connecting')
                    : t('not_connected'),
              href: '/settings/collections',
              connected: collectionsState === 'active',
              attention:
                collectionsState === 'needs_setup' ||
                collections?.connection?.health === 'degraded' ||
                collections?.connection?.health === 'action_required',
            })}
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

      {opAvailable && (
        <BankConnectDialog
          flow={bankFlow}
          onConnected={() => {
            bankConnections.refresh()
            setBankGeneration((g) => g + 1)
          }}
        />
      )}
    </div>
  )
}
