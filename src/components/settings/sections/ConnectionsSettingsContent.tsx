'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Check, Copy, HandCoins, Landmark, Mail, MoreHorizontal, Store } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { BankConnectDialog } from '@/components/bank-feed/BankConnectDialog'
import { OpenPaymentsConnectionRow } from '@/components/bank-feed/OpenPaymentsConnectionRows'
import { SignatoryLinkDialog, useSignatoryLinkFlow } from '@/components/bank-feed/SignatoryLinkDialog'
import { useBankConnectFlow } from '@/components/bank-feed/use-bank-connect-flow'
import { useBankConnectResume } from '@/components/bank-feed/use-bank-connect-resume'
import { useOpenPaymentsAvailability } from '@/components/bank-feed/use-open-payments-availability'
import { useOpenPaymentsConnections } from '@/components/bank-feed/use-open-payments-connections'
import { useBankSwitchCampaign } from '@/components/bank-feed/use-bank-switch-campaign'
import { SWITCH_DEEP_LINK_PARAM } from '@/lib/bank-feed/switch-link'
import { bankCoveredByOpenPayments } from '@/lib/bank-feed/bank-coverage'
import { useFormat } from '@/lib/hooks/use-format'
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
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { copyInboxAddress, type AddressCopyState } from '@/components/extensions/general/inbox-address-copy'
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
  const { company, isSandbox, role, entitlementState } = useCompany()
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
  // The new bank connection is for paying companies (lib/bank-feed/door.ts:
  // the seeded trial does not open it); a trial without a card is told how
  // to get it rather than shown nothing.
  const trialWithoutCard = openPayments.status === 'unavailable' && entitlementState === 'trial' && !isSandbox
  const bankFlow = useBankConnectFlow('connections')
  // The signatory link: a firmatecknare who holds the bank access signs the
  // consent from a link, without a login. Owners and admins send it (the
  // route and the table's policy say the same).
  const signatoryLink = useSignatoryLinkFlow()
  const canInvite = role === 'owner' || role === 'admin'
  const bankConnections = useOpenPaymentsConnections(opAvailable ? companyId : null)
  const [bankGeneration, setBankGeneration] = useState(0)
  // A second signatory arrives with ?bank_connect=<id> (the reminder link),
  // and a bank that signs on its own page sends the person back the same way:
  // open the flow at its BankID step, once, and drop the params. An agent's
  // connect link (?bank_connect=new&bic=...) opens the flow for a new
  // connection with that bank preselected from the loaded list.
  useBankConnectResume(bankFlow, opAvailable, openPayments.banks)
  // The switch campaign (Enable Banking to Open Payments before a deadline):
  // the deadline the switch intro names, and which Enable Banking rows still
  // wait, so their state line says "Byt senast" instead of "Ansluten".
  const switchCampaign = useBankSwitchCampaign()
  const { formatDateLong } = useFormat()
  const switchDeadline = switchCampaign.deadline
  const switchPassed = switchCampaign.progress?.campaign.passed ?? false
  const pendingSwitchIds = useMemo(
    () => new Set(switchCampaign.progress?.company?.pending.map((p) => p.connection_id) ?? []),
    [switchCampaign.progress],
  )
  // A nudge arrives with ?bank_connect_switch=<id> (the Att göra row, the
  // notice line, the campaign mails): once the rows and the campaign have
  // loaded, open Koppla banken in switch mode for that Enable Banking row,
  // once, and drop the param. An id no live row carries opens nothing.
  const searchParams = useSearchParams()
  const openBankFlow = bankFlow.open
  const switchId = searchParams.get(SWITCH_DEEP_LINK_PARAM)
  const switchHandled = useRef(false)
  const enableBankingRows = bankConnections.enableBanking
  const rowsLoaded = bankConnections.rows !== null
  const campaignLoaded = switchCampaign.loaded
  useEffect(() => {
    if (!opAvailable || !switchId || switchHandled.current || !rowsLoaded || !campaignLoaded) return
    const row = enableBankingRows.find((r) => r.id === switchId)
    const timer = setTimeout(() => {
      switchHandled.current = true
      if (row) openBankFlow('switch', { bank: { bic: '', name: row.bank_name ?? '' }, replaceConnectionId: row.id, deadline: switchDeadline })
      const url = new URL(window.location.href)
      url.searchParams.delete(SWITCH_DEEP_LINK_PARAM)
      window.history.replaceState(window.history.state, '', url.pathname + url.search)
    }, 0)
    return () => clearTimeout(timer)
  }, [opAvailable, switchId, rowsLoaded, campaignLoaded, enableBankingRows, openBankFlow, switchDeadline])
  const hasSkatteverket = ENABLED_EXTENSION_IDS.has('skatteverket') && !isSandbox
  const hasWhatsApp = ENABLED_EXTENSION_IDS.has('whatsapp-inbox') && !isSandbox
  const hasMail = ENABLED_EXTENSION_IDS.has('mail') && !isSandbox
  const hasInvoiceInbox = ENABLED_EXTENSION_IDS.has('invoice-inbox') && !isSandbox
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

  // The document inbox address (crm#1174): until now it was shown only behind
  // the sources chip on the inbox page, so a person setting up a forwarding
  // rule from their own kvitto@ mailbox looked here and found nothing.
  // undefined while loading, null when the company has none yet (404), and
  // the row stays out when the address cannot be read at all (no inbound
  // domain on this install, or a failed read).
  const [inboxAddress, setInboxAddress] = useState<string | null | undefined>(undefined)
  const [inboxAddressReadable, setInboxAddressReadable] = useState(true)
  useEffect(() => {
    if (!companyId || !hasInvoiceInbox) return
    let cancelled = false
    fetch('/api/extensions/ext/invoice-inbox/inbox/address')
      .then(async (res) => {
        if (cancelled) return
        if (res.ok) {
          const body = (await res.json()) as { data?: { address?: string } }
          if (!cancelled) setInboxAddress(body.data?.address ?? null)
          return
        }
        if (res.status === 404) setInboxAddress(null)
        else setInboxAddressReadable(false)
      })
      .catch(() => {
        if (!cancelled) setInboxAddressReadable(false)
      })
    return () => {
      cancelled = true
    }
  }, [companyId, hasInvoiceInbox])
  const [inboxCopyState, setInboxCopyState] = useState<AddressCopyState>('idle')
  async function handleCopyInboxAddress(address: string) {
    // The clipboard write is the first await, so the click's user activation
    // still holds when it runs.
    const next = await copyInboxAddress(address)
    setInboxCopyState(next)
    if (next === 'copied') setTimeout(() => setInboxCopyState('idle'), 2000)
  }

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
            {canInvite && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon-sm" aria-label={t('more_actions')}>
                    <MoreHorizontal className="h-[15px] w-[15px]" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => signatoryLink.open()}>{t('send_signatory_link')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        ),
      })
    }
    return (
      <>
        {bankConnections.enableBanking.map((connection) => {
          const logo = bankLogoUrl(connection.bank_name)
          // A row the campaign waits for says so in the one attention line;
          // past the deadline, that its feed has stopped. Once the old feed
          // has stopped, a bank the new provider does not reach offers the
          // file import instead of the switch (the campaign's own list,
          // lib/bank-feed/bank-coverage.ts), and an active row the campaign
          // no longer waits for already has its new connection: it says it
          // was replaced and offers neither. Before that, a bank the new
          // provider does not reach offers no switch either: it would end at
          // the bank's refusal after the BankID.
          const stoppedFeed = Boolean(switchDeadline) && switchPassed
          const pendingSwitch = pendingSwitchIds.has(connection.id)
          const uncovered = !bankCoveredByOpenPayments(connection.bank_name)
          const uncoveredStopped = stoppedFeed && uncovered
          const replacedStopped = stoppedFeed && !uncoveredStopped && !pendingSwitch && connection.status === 'active'
          const state = uncoveredStopped
            ? t('switch_stopped_uncovered')
            : replacedStopped
              ? t('switch_replaced')
              : stoppedFeed
                ? t('switch_stopped')
                : pendingSwitch && switchDeadline
                  ? t('switch_by', { date: formatDateLong(switchDeadline) })
                  : connection.status === 'error'
                    ? t('sync_failed')
                    : t('connected')
          return (
            <div key={connection.id}>
              {row({
                logo: logo ? <ImgLogo src={logo} /> : bankLandmark,
                name: connection.bank_name ?? t('bank'),
                maskLabel: true,
                help: t('bank_help'),
                state,
                href: '/settings/banking',
                connected: true,
                attention: pendingSwitch || (stoppedFeed && !replacedStopped) || connection.status === 'error',
                actions: (
                  <>
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/settings/banking">{t('manage')}</Link>
                    </Button>
                    {uncoveredStopped ? (
                      <Button size="sm" asChild>
                        <Link href="/import?mode=bank">{t('import_statements')}</Link>
                      </Button>
                    ) : replacedStopped || uncovered ? null : (
                      <Button
                        size="sm"
                        onClick={() => bankFlow.open('switch', { bank: { bic: '', name: connection.bank_name ?? '' }, replaceConnectionId: connection.id, deadline: switchDeadline })}
                      >
                        {t('switch_connection')}
                      </Button>
                    )}
                    {/* The signatory link is the byrå's path; it sits behind the row's menu so three buttons never clip the primary one. */}
                    {canInvite && !uncovered && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="icon-sm" aria-label={t('more_actions')}>
                            <MoreHorizontal className="h-[15px] w-[15px]" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => signatoryLink.open({ bank: { bic: null, name: connection.bank_name }, replaceConnectionId: connection.id })}>
                            {t('send_signatory_link')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
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
              // A cardless trial with a bank connection: the new connection
              // (Open Payments, billed per consent) opens once a card is in,
              // so say so where the switch would be instead of hiding it.
              actions:
                trialWithoutCard && (status?.bankCount ?? 0) > 0 ? (
                  <>
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/settings/banking">{t('manage')}</Link>
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/settings/billing">{t('bank_switch_add_card')}</Link>
                    </Button>
                  </>
                ) : undefined,
            })}
          {hasSkatteverket &&
            row({
              logo: <Landmark className="h-4 w-4 text-foreground" aria-hidden="true" />,
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
        {hasInvoiceInbox && inboxAddressReadable && inboxAddress !== undefined &&
          (inboxAddress ? (
            <SettingsRow
              label={
                <span className="flex items-center gap-3">
                  <LogoTile><Mail className="h-4 w-4 text-foreground" aria-hidden="true" /></LogoTile>
                  {t('inbox_address')}
                </span>
              }
              help={t('inbox_address_help')}
            >
              {/* Read-only, not disabled: selecting it by hand is the way
                  out when the clipboard refuses the write. */}
              <SettingsInput
                readOnly
                value={inboxAddress}
                aria-label={t('inbox_address')}
                onFocus={(e) => e.currentTarget.select()}
                data-ph-mask=""
                className="font-mono text-xs"
              />
              <SettingsRowEnd>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => { void handleCopyInboxAddress(inboxAddress) }}
                  aria-label={inboxCopyState === 'failed' ? t('inbox_address_copy_failed') : t('inbox_address_copy')}
                  title={inboxCopyState === 'failed' ? t('inbox_address_copy_failed') : t('inbox_address_copy')}
                >
                  {inboxCopyState === 'copied' ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : inboxCopyState === 'failed' ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-attn" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/e/general/invoice-inbox">{t('open')}</Link>
                </Button>
              </SettingsRowEnd>
            </SettingsRow>
          ) : (
            row({
              logo: <Mail className="h-4 w-4 text-foreground" aria-hidden="true" />,
              name: t('inbox_address'),
              help: t('inbox_address_help'),
              state: t('inbox_address_off'),
              href: '/e/general/invoice-inbox',
              connected: false,
            })
          ))}
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
        <>
          <BankConnectDialog
            flow={bankFlow}
            onConnected={() => {
              bankConnections.refresh()
              switchCampaign.refresh()
              setBankGeneration((g) => g + 1)
            }}
          />
          <SignatoryLinkDialog flow={signatoryLink} />
        </>
      )}
    </div>
  )
}
