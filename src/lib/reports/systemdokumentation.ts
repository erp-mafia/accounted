/**
 * Systemdokumentation generator (BFL 5 kap. 11 §, BFNAR 2013:2 kap. 9).
 *
 * BFNAR 2013:2 p. 9.2-9.15 asks every bokföringsskyldig for a description
 * of the bookkeeping system: kontoplan, samlingsplan (delsystem and their
 * flows), verifikationsnummerserier, behandlingsregler, access, backup and
 * integrations. All of that is configuration this system already holds, so
 * the document is derived from it rather than typed by the customer: the
 * loader reads the company's rows, the builder (pure) turns them into the
 * report, and the same rule texts feed the archive's JSON (system-rules.ts).
 *
 * The builder is pure and the loader tolerates a missing optional source
 * (an integration table that errors is reported as not connected, with a
 * warning), because a systemdokumentation that fails to render over one
 * side table would leave the customer with nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountingFramework, AccountingMethod, CompanyRole, EntityType, JournalEntrySourceType, MomsPeriod } from '@/types'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getBranding } from '@/lib/branding/service'
import { flagEnabled, isSelfHosted } from '@/lib/env/public-flags'
import { STANDARD_VOUCHER_SERIES_MAP, resolveDefaultSeriesForSource, voucherSeriesLabel, type VoucherSeriesMap } from '@/lib/bookkeeping/voucher-series-resolver'
import { cashAccountSeriesOverride } from '@/lib/bookkeeping/cash-account-voucher-series'
import { API_KEY_SCOPES } from '@/lib/auth/scope-catalog'
import {
  ARCHIVE_RULES,
  BEHANDLINGSHISTORIK_RULES,
  CORRECTION_AND_LOCK_RULES,
  SIE_IMPORT_RULES,
  SUPPLIER_INVOICE_ROUNDING_RULES,
  SUPPLIER_PAYMENT_RULES,
  VOUCHER_SERIES_RULES,
} from './system-rules'
import type {
  SystemdokumentationAccount,
  SystemdokumentationApiKey,
  SystemdokumentationDelsystem,
  SystemdokumentationIntegration,
  SystemdokumentationReport,
  SystemdokumentationRule,
} from './systemdokumentation-types'

const log = createLogger('reports/systemdokumentation')

export interface SystemdokumentationSettingsRow {
  entity_type: EntityType | null
  accounting_method: AccountingMethod | null
  moms_period: MomsPeriod | null
  vat_registered: boolean | null
  pays_salaries: boolean | null
  fiscal_year_start_month: number | null
  bookkeeping_locked_through: string | null
  auto_lock_period_days: number | null
  default_voucher_series: string | null
  default_voucher_series_per_source_type: Partial<Record<string, string>> | null
  voucher_series_labels: Partial<Record<string, string>> | null
  ore_rounding: boolean | null
  dimensions_enabled: boolean | null
  recurring_invoices_enabled: boolean | null
  invoice_payment_links_enabled: boolean | null
}

export interface SystemdokumentationPeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

export interface SystemdokumentationApiKeyRow {
  name: string
  key_prefix: string
  user_id: string
  scopes: string[] | null
  created_at: string
  last_used_at: string | null
  unattended_commit_limit: number | string | null
}

/** Which integrations the company has connected, as the loader found them. */
export interface SystemdokumentationConnections {
  bank: boolean
  skatteverket: boolean
  peppol: boolean
  stripe: boolean
  shopify: boolean
  woocommerce: boolean
  zettle: boolean
  whatsapp: boolean
  email_inbox: boolean
  cloud_backup: boolean
}

/** Everything the pure builder needs; the loader fills it from the database. */
export interface SystemdokumentationFacts {
  company: { name: string | null; org_number: string | null; accounting_framework: AccountingFramework | null }
  settings: SystemdokumentationSettingsRow | null
  period: SystemdokumentationPeriodRow
  accounts: SystemdokumentationAccount[]
  sequences: { voucher_series: string; last_number: number }[]
  cashAccounts: { name: string | null; ledger_account: string; voucher_series: string | null; source: string | null; enabled: boolean }[]
  members: { user_id: string; role: CompanyRole; joined_at: string }[]
  apiKeys: SystemdokumentationApiKeyRow[]
  dimensions: { name: string }[]
  connections: SystemdokumentationConnections
  /** user id -> display label (e-mail or name). */
  labels: Map<string, string>
  env: {
    appName: string
    appUrl: string
    hosted: boolean
    mfaRequired: boolean
    appVersion: string | null
    generatedAt: string
  }
}

export interface SystemdokumentationOptions {
  /** Resolves user ids to e-mail/name labels (service-role lookup on profiles). */
  resolveUserLabels?: (userIds: string[]) => Promise<Map<string, string>>
  /**
   * Service-role client for `api_keys`, whose RLS is self-only. The document
   * lists the active keys bound to THIS company and held by its members: a
   * byrå member's key for another client is that client's business. Omitted: the key list is empty.
   */
  serviceClient?: Pick<SupabaseClient, 'from'>
  appVersion?: string | null
  now?: Date
}

/** Swedish labels for the journal source types, in the order the document lists them. */
export const SOURCE_TYPE_LABELS_SV: Readonly<Record<JournalEntrySourceType, string>> = {
  manual: 'Manuell verifikation',
  bank_transaction: 'Banktransaktion',
  inbox_item: 'Underlag från inkorgen',
  invoice_created: 'Kundfaktura',
  credit_note: 'Kreditfaktura till kund',
  reminder_fee: 'Påminnelseavgift',
  invoice_paid: 'Kundbetalning',
  invoice_cash_payment: 'Kundbetalning (kontantmetoden)',
  rot_rut_payout: 'ROT/RUT-utbetalning från Skatteverket',
  rot_rut_reclaim: 'ROT/RUT-återkrav',
  supplier_invoice_registered: 'Leverantörsfaktura',
  supplier_credit_note: 'Kreditfaktura från leverantör',
  supplier_invoice_paid: 'Leverantörsbetalning',
  supplier_invoice_cash_payment: 'Leverantörsbetalning (kontantmetoden)',
  supplier_invoice_privately_paid: 'Leverantörsfaktura betald privat',
  salary_payment: 'Lön',
  accrual: 'Periodisering',
  webshop_order: 'Webbutiksorder',
  stripe_payout: 'Stripe-utbetalning',
  expense_claim: 'Utlägg',
  expense_payout: 'Utbetalning av utlägg',
  vat_settlement: 'Momsredovisning',
  currency_revaluation: 'Valutaomvärdering',
  opening_balance: 'Ingående balans',
  year_end: 'Årsbokslut',
  result_appropriation: 'Resultatdisposition',
  import: 'Import',
  system: 'System',
  storno: 'Storno',
  correction: 'Rättelse',
}

const HOSTED_APP_URL_HINT = 'app.accounted.se'

function seriesLabel(letter: string, labels: Partial<Record<string, string>> | null | undefined): string {
  return voucherSeriesLabel(letter, labels ?? undefined) || 'Egen serie'
}

function scopeLabel(scope: string): string {
  const entry = (API_KEY_SCOPES as Record<string, { label?: string } | undefined>)[scope]
  return entry?.label ?? scope
}

function toNumber(value: number | string | null): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** Pure: the report from the loaded facts. */
export function buildSystemdokumentation(facts: SystemdokumentationFacts): SystemdokumentationReport {
  const s = facts.settings
  const labels = s?.voucher_series_labels ?? null
  const label = (id: string) => facts.labels.get(id) ?? id

  const classCounts = new Map<number, number>()
  for (const a of facts.accounts) {
    if (a.account_class == null) continue
    classCounts.set(a.account_class, (classCounts.get(a.account_class) ?? 0) + 1)
  }

  const c = facts.connections
  const paysSalaries = s?.pays_salaries === true
  const delsystem: SystemdokumentationDelsystem[] = [
    { key: 'kundfakturering', label: 'Kundfakturering', description: 'Utgående fakturor med momssats per rad, kreditfakturor och påminnelser; e-faktura via Peppol när det är anslutet', kontering: 'Debet 1510, kredit 30xx och 26xx', active: true },
    { key: 'kundbetalningar', label: 'Kundbetalningar', description: 'Inbetalningar mot kundfakturor, från bankfeed eller registrerade manuellt', kontering: 'Debet 1930 (eller annat likvidkonto), kredit 1510', active: true },
    { key: 'leverantorsfakturor', label: 'Leverantörsfakturor', description: 'Inkommande fakturor från dokumentinkorgen, uppladdning eller Peppol; registrering och betalning', kontering: 'Debet kostnadskonto och 2641, kredit 2440', active: true },
    { key: 'leverantorsbetalningar', label: 'Leverantörsbetalningar', description: 'Utbetalningar mot leverantörsfakturor', kontering: 'Debet 2440, kredit 1930', active: true },
    { key: 'bank', label: 'Banktransaktioner', description: 'Synkroniserade via PSD2 (Enable Banking) eller importerade bankfiler; konteras via regler och mallar efter granskning', kontering: 'Enligt kategoriseringsregel eller konteringsmall', active: c.bank },
    { key: 'underlag', label: 'Kvitto- och underlagshantering', description: 'Uppladdade, inmejlade eller via WhatsApp inskickade underlag, maskinellt avlästa och kopplade till verifikat', kontering: 'Efter granskning', active: true },
    { key: 'loner', label: 'Löner', description: 'Lönekörningar, lönespecifikationer och arbetsgivardeklaration (AGI)', kontering: 'Debet 7xxx och 7510, kredit 2710, 2731 och 1930; semesterlöneskuld 2920 och 2940', active: paysSalaries },
    { key: 'anlaggningar', label: 'Anläggningstillgångar', description: 'Anläggningsregister med årliga avskrivningar', kontering: 'Debet 78xx, kredit ackumulerade avskrivningar (t.ex. 1219, 1229)', active: true },
    { key: 'periodiseringar', label: 'Periodiseringar', description: 'Periodiseringsscheman vars delposter bokförs på förfallodagen', kontering: 'Debet/kredit 17xx respektive 29xx', active: true },
    { key: 'stripe', label: 'Kortbetalningar (Stripe)', description: 'Betallänkar på kundfakturor; betalningar och utbetalningar som stämmer exakt bokförs automatiskt', kontering: 'Betalning: debet 1686, kredit 1510. Utbetalning: debet 1930 och 6570, kredit 1686', active: c.stripe },
    { key: 'webbutik', label: 'Webbutiker (Shopify, WooCommerce, Zettle)', description: 'Order och återbetalningar hämtas som underlag och bokförs när användaren godkänner dem', kontering: 'Vid bokföring av ordern', active: c.shopify || c.woocommerce || c.zettle },
    { key: 'moms', label: 'Momsredovisning', description: 'Momsdeklaration per period från bokförda belopp, redovisning av momsskulden', kontering: 'Debet 26xx, kredit 2650 (eller omvänt)', active: s?.vat_registered === true },
    { key: 'dimensioner', label: 'Dimensioner', description: facts.dimensions.length ? `Konteringsrader märks med ${facts.dimensions.map((d) => d.name).join(', ')}; påverkar inte huvudbokföringens saldon` : 'Kostnadsställen och projekt på konteringsrader; påverkar inte huvudbokföringens saldon', kontering: 'Ingen egen kontering', active: s?.dimensions_enabled === true },
  ]

  const sourceTypes = Object.keys(STANDARD_VOUCHER_SERIES_MAP) as JournalEntrySourceType[]
  const perSourceType = sourceTypes.map((source_type) => {
    const series = resolveDefaultSeriesForSource((s?.default_voucher_series_per_source_type ?? null) as VoucherSeriesMap | null, source_type)
    return { source_type, label: SOURCE_TYPE_LABELS_SV[source_type], series, series_label: seriesLabel(series, labels) }
  })

  const cashOverrides = facts.cashAccounts
    .filter((a) => a.enabled)
    .flatMap((a) => {
      const series = cashAccountSeriesOverride(a)
      return series ? [{ account_name: a.name ?? a.ledger_account, ledger_account: a.ledger_account, series, series_label: seriesLabel(series, labels) }] : []
    })

  const sequences = [...facts.sequences]
    .sort((a, b) => a.voucher_series.localeCompare(b.voucher_series))
    .map((v) => ({ series: v.voucher_series, series_label: seriesLabel(v.voucher_series, labels), last_number: v.last_number }))

  const oreDefault = s?.ore_rounding === true
  const behandlingsregler: SystemdokumentationRule[] = [
    { rubrik: 'Verifikationsnummer', text: 'Tilldelas i löpande följd av databasfunktionen commit_journal_entry vid bokföring, unikt per företag, räkenskapsår och serie, säkert vid samtidiga anrop. Kan inte sättas manuellt. Luckor förklaras i systemets funktion för nummerluckor och förklaringarna bevaras.' },
    { rubrik: 'Balanskontroll', text: 'Varje verifikation måste balansera (debet lika med kredit, båda större än noll); databasen avvisar allt annat.' },
    { rubrik: 'Öresavrundning på kundfakturor', text: oreDefault ? 'Företagsinställningen avrundar fakturabeloppet till hel krona; skillnaden bokförs på 3740 utan moms.' : 'Företagsinställningen är avstängd: kundfakturor avrundas inte till hel krona.' },
    { rubrik: 'Öresavrundning på leverantörsfakturor', text: SUPPLIER_INVOICE_ROUNDING_RULES.val },
    { rubrik: 'Öresavrundning, registrering', text: SUPPLIER_INVOICE_ROUNDING_RULES.registrering },
    { rubrik: 'Öresavrundning och moms', text: `${SUPPLIER_INVOICE_ROUNDING_RULES.moms} ${SUPPLIER_INVOICE_ROUNDING_RULES.omfattning}` },
    { rubrik: 'Öresavrundning, kontantmetoden', text: SUPPLIER_INVOICE_ROUNDING_RULES.betalning_kontantmetoden },
    { rubrik: 'Öresavrundning, införande', text: SUPPLIER_INVOICE_ROUNDING_RULES.historik },
    { rubrik: 'Leverantörsbetalningens belopp', text: `${SUPPLIER_PAYMENT_RULES.bankmatchning} ${SUPPLIER_PAYMENT_RULES.andring} ${SUPPLIER_PAYMENT_RULES.historik}` },
    { rubrik: 'Moms', text: 'Momssats väljs per rad och byts inte automatiskt efter datum. Utgående moms bokförs på 2611, 2621 och 2631 efter sats, ingående på 2641. Omvänd skattskyldighet vid inköp bokför beräknad utgående moms på 2614, 2624 eller 2634 och ingående på 2645 (utland) eller 2647 (inrikes). Förvärv av varor från EU och importmoms skapas inte automatiskt från leverantörsfakturor utan bokförs manuellt.' },
    { rubrik: 'Bankavstämning', text: 'Banktransaktioner matchas mot bokförda verifikationer på belopp och datum, referens, datumintervall och sannolikhet. Förslag med mycket hög säkerhet kopplas automatiskt mot redan bokförda verifikationer; inga nya verifikationer skapas då.' },
    { rubrik: 'Maskinell och automatisk bokföring', text: 'Förslag från maskinella hjälpmedel (kategorisering av banktransaktioner, avläsning av underlag) bokförs först när en användare har godkänt dem. Utan godkännande per verifikation bokför: Stripe-betalningar och utbetalningar som stämmer exakt, schemalagda periodiseringsposter, återkommande fakturor med automatiskt utskick och API-nycklar med skrivbehörighet. Varje verifikation registreras i behandlingshistoriken med tidpunkt, sätt och utförare.' },
    { rubrik: 'Valutor', text: 'Belopp i utländsk valuta räknas om med Riksbankens kurs; valutaomvärdering bokförs som egen verifikation.' },
    { rubrik: 'SIE-import', text: SIE_IMPORT_RULES },
  ]
  if (s?.auto_lock_period_days != null) {
    behandlingsregler.push({ rubrik: 'Automatisk låsning', text: `Låsdatumet flyttas fram automatiskt ${s.auto_lock_period_days} dagar efter varje momsperiods slut.` })
  }

  const integrationer: SystemdokumentationIntegration[] = [
    { key: 'enable_banking', label: 'Enable Banking (PSD2)', description: 'Bankkontosynkronisering: bank till systemet, läsning av transaktioner och saldon', active: c.bank },
    { key: 'skatteverket', label: 'Skatteverket', description: 'Momsdeklaration, arbetsgivardeklaration (AGI) och skattekonto; inlämning signeras med BankID', active: c.skatteverket },
    { key: 'peppol', label: 'Peppol (accesspunkt Qvalia)', description: 'E-fakturor in och ut', active: c.peppol },
    { key: 'stripe', label: 'Stripe', description: 'Betallänkar på kundfakturor, betalningar och utbetalningar', active: c.stripe },
    { key: 'shopify', label: 'Shopify', description: 'Order och återbetalningar som underlag', active: c.shopify },
    { key: 'woocommerce', label: 'WooCommerce', description: 'Order och återbetalningar som underlag', active: c.woocommerce },
    { key: 'zettle', label: 'Zettle', description: 'Order och återbetalningar som underlag', active: c.zettle },
    { key: 'whatsapp', label: 'WhatsApp (Meta)', description: 'Kvitton och underlag som skickas via WhatsApp', active: c.whatsapp },
    { key: 'email_inbox', label: 'E-postinkorg', description: 'Underlag hämtade från företagets e-post', active: c.email_inbox },
    { key: 'cloud_backup', label: 'Molnsynkronisering (Google Drive, Dropbox)', description: 'Kopia av Komplett arkiv i företagets egen molnlagring', active: c.cloud_backup },
    { key: 'ai', label: 'Maskinell behandling (Amazon Bedrock, EU)', description: 'Kategorisering av transaktioner och avläsning av underlag med Anthropics Claude-modeller inom EU; förslag, aldrig bokföring utan godkännande', active: facts.env.hosted },
    { key: 'resend', label: 'Resend', description: 'E-post ut (fakturor, påminnelser) och in (dokumentinkorgens adress)', active: facts.env.hosted },
    { key: 'riksbanken', label: 'Riksbanken', description: 'Valutakurser', active: true },
  ]

  const apiKeys: SystemdokumentationApiKey[] = facts.apiKeys
    .map((k) => ({
      name: k.name,
      key_prefix: k.key_prefix,
      owner_label: label(k.user_id),
      scopes: (k.scopes ?? []).map(scopeLabel),
      created_at: k.created_at,
      last_used_at: k.last_used_at,
      unattended_commit_limit: toNumber(k.unattended_commit_limit),
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))

  const roleOrder: Record<CompanyRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }
  const members = [...facts.members]
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.joined_at.localeCompare(b.joined_at))
    .map((m) => ({ role: m.role, label: label(m.user_id), joined_at: m.joined_at }))

  return {
    generated_at: facts.env.generatedAt,
    app_version: facts.env.appVersion,
    system: { name: facts.env.appName, url: facts.env.appUrl, hosted: facts.env.hosted },
    company: {
      name: facts.company.name,
      org_number: facts.company.org_number,
      entity_type: s?.entity_type ?? null,
      accounting_method: s?.accounting_method ?? null,
      accounting_framework: facts.company.accounting_framework ?? null,
      moms_period: s?.moms_period ?? null,
      vat_registered: s?.vat_registered === true,
      pays_salaries: paysSalaries,
      fiscal_year_start_month: s?.fiscal_year_start_month ?? null,
    },
    period: {
      id: facts.period.id,
      name: facts.period.name,
      start: facts.period.period_start,
      end: facts.period.period_end,
      is_closed: facts.period.is_closed,
      locked_at: facts.period.locked_at,
    },
    kontoplan: {
      standard: 'BAS 2026',
      accounts: facts.accounts,
      class_summary: [...classCounts.entries()].sort((a, b) => a[0] - b[0]).map(([account_class, count]) => ({ account_class, count })),
      sie_import_regler: SIE_IMPORT_RULES,
    },
    delsystem,
    verifikationsserier: {
      per_source_type: perSourceType,
      cash_account_overrides: cashOverrides,
      sequences,
      ordning: [...VOUCHER_SERIES_RULES.ordning],
      undantag: [...VOUCHER_SERIES_RULES.undantag],
    },
    behandlingsregler,
    rattelse_och_las: {
      lock_date: s?.bookkeeping_locked_through ?? null,
      auto_lock_period_days: s?.auto_lock_period_days ?? null,
      rules: [...CORRECTION_AND_LOCK_RULES],
    },
    behorigheter: { mfa_required: facts.env.mfaRequired, members, api_keys: apiKeys },
    integrationer,
    arkivering: {
      lagringsregel: ARCHIVE_RULES.lagringsregel,
      format: ARCHIVE_RULES.format,
      integritetskontroll: ARCHIVE_RULES.integritetskontroll,
      lagringsplats: ARCHIVE_RULES.lagringsplats,
      behandlingshistorik: `${BEHANDLINGSHISTORIK_RULES.beskrivning} ${BEHANDLINGSHISTORIK_RULES.rapport}.`,
    },
  }
}

type Rows<T> = { data: T[] | null; error: { message: string } | null }

/** A side table that fails is reported as empty, with a warning: never a reason to refuse the document. */
async function optional<T>(companyId: string, what: string, query: PromiseLike<Rows<T>>): Promise<T[]> {
  try {
    const { data, error } = await query
    if (error) {
      log.warn('systemdokumentation optional read failed', { companyId, what, error: error.message })
      return []
    }
    return data ?? []
  } catch (err) {
    log.warn('systemdokumentation optional read threw', { companyId, what, error: String(err) })
    return []
  }
}

/** A read the document cannot do without: members, series, bank accounts. An empty section would be a wrong document, not a degraded one. */
async function required<T>(what: string, query: PromiseLike<Rows<T>>): Promise<T[]> {
  const { data, error } = await query
  if (error) throw new Error(`Kunde inte hämta ${what}: ${error.message}`)
  return data ?? []
}

/** Reads the company's configuration; null when the räkenskapsår is not the company's. */
export async function loadSystemdokumentationFacts(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  options: SystemdokumentationOptions = {},
): Promise<SystemdokumentationFacts | null> {
  const [{ data: periodData, error: periodError }, { data: companyData }, { data: settingsData }] = await Promise.all([
    supabase.from('fiscal_periods').select('id, name, period_start, period_end, is_closed, locked_at').eq('id', periodId).eq('company_id', companyId).maybeSingle(),
    supabase.from('companies').select('name, org_number, accounting_framework').eq('id', companyId).maybeSingle(),
    supabase
      .from('company_settings')
      .select(
        'entity_type, accounting_method, moms_period, vat_registered, pays_salaries, fiscal_year_start_month, bookkeeping_locked_through, auto_lock_period_days, default_voucher_series, default_voucher_series_per_source_type, voucher_series_labels, ore_rounding, dimensions_enabled, recurring_invoices_enabled, invoice_payment_links_enabled',
      )
      .eq('company_id', companyId)
      .maybeSingle(),
  ])
  if (periodError) throw new Error(`Kunde inte hämta räkenskapsår: ${periodError.message}`)
  const period = periodData as SystemdokumentationPeriodRow | null
  if (!period) return null

  const [accounts, sequences, cashAccounts, members, dimensions, stripe, peppol, skatteverket, shopify, woocommerce, zettle, mail, cloudBackup, whatsappDefault, whatsappLast] = await Promise.all([
    fetchAllRows<SystemdokumentationAccount>(({ from, to }) =>
      supabase.from('chart_of_accounts').select('account_number, account_name, account_class, sru_code').eq('company_id', companyId).eq('is_active', true).order('account_number').range(from, to),
    ),
    required<{ voucher_series: string; last_number: number }>('verifikationsserier', supabase.from('voucher_sequences').select('voucher_series, last_number').eq('company_id', companyId).eq('fiscal_period_id', periodId)),
    required<SystemdokumentationFacts['cashAccounts'][number]>('bankkonton', supabase.from('cash_accounts').select('name, ledger_account, voucher_series, source, enabled').eq('company_id', companyId)),
    required<{ user_id: string; role: CompanyRole; joined_at: string }>('medlemmar', supabase.from('company_members').select('user_id, role, joined_at').eq('company_id', companyId)),
    optional<{ name: string }>(companyId, 'dimensions', supabase.from('dimensions').select('name').eq('company_id', companyId).eq('is_active', true).order('sie_dim_no')),
    optional<{ id: string }>(companyId, 'stripe_connections', supabase.from('stripe_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1)),
    optional<{ id: string }>(companyId, 'peppol_registrations', supabase.from('peppol_registrations').select('id').eq('company_id', companyId).is('deregistered_at', null).limit(1)),
    optional<{ id: string }>(companyId, 'skatteverket_company_connections', supabase.from('skatteverket_company_connections').select('id').eq('company_id', companyId).in('status', ['partial', 'verified']).limit(1)),
    optional<{ id: string }>(companyId, 'shopify_connections', supabase.from('shopify_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1)),
    optional<{ id: string }>(companyId, 'woocommerce_connections', supabase.from('woocommerce_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1)),
    optional<{ id: string }>(companyId, 'zettle_connections', supabase.from('zettle_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1)),
    optional<{ id: string }>(companyId, 'mail_connections', supabase.from('mail_connections').select('id').eq('company_id', companyId).eq('status', 'active').limit(1)),
    optional<{ id: string }>(companyId, 'extension_data', supabase.from('extension_data').select('id').eq('company_id', companyId).eq('extension_id', 'cloud-backup').limit(1)),
    optional<{ id: string }>(companyId, 'whatsapp_phone_links', supabase.from('whatsapp_phone_links').select('id').eq('default_company_id', companyId).is('revoked_at', null).limit(1)),
    optional<{ id: string }>(companyId, 'whatsapp_phone_links', supabase.from('whatsapp_phone_links').select('id').eq('last_company_id', companyId).is('revoked_at', null).limit(1)),
  ])

  const memberIds = members.map((m) => m.user_id)
  let apiKeys: SystemdokumentationApiKeyRow[] = []
  if (options.serviceClient && memberIds.length > 0) {
    apiKeys = await optional<SystemdokumentationApiKeyRow>(
      companyId,
      'api_keys',
      options.serviceClient.from('api_keys').select('name, key_prefix, user_id, scopes, created_at, last_used_at, unattended_commit_limit').eq('company_id', companyId).in('user_id', memberIds).is('revoked_at', null),
    )
  }

  let labels = new Map<string, string>()
  if (options.resolveUserLabels && memberIds.length > 0) {
    try {
      labels = await options.resolveUserLabels(memberIds)
    } catch (err) {
      log.warn('user label resolution failed', { companyId, error: String(err) })
    }
  }

  const branding = getBranding()
  const company = (companyData as SystemdokumentationFacts['company'] | null) ?? { name: null, org_number: null, accounting_framework: null }
  return {
    company,
    settings: (settingsData as SystemdokumentationSettingsRow | null) ?? null,
    period,
    accounts,
    sequences,
    cashAccounts,
    members,
    apiKeys,
    dimensions,
    connections: {
      bank: cashAccounts.some((a) => a.enabled && a.source === 'enable_banking'),
      skatteverket: skatteverket.length > 0,
      peppol: peppol.length > 0,
      stripe: stripe.length > 0,
      shopify: shopify.length > 0,
      woocommerce: woocommerce.length > 0,
      zettle: zettle.length > 0,
      whatsapp: whatsappDefault.length > 0 || whatsappLast.length > 0,
      email_inbox: mail.length > 0,
      cloud_backup: cloudBackup.length > 0,
    },
    labels,
    env: {
      appName: branding.appName,
      appUrl: branding.appUrl,
      hosted: !isSelfHosted() && (branding.appUrl.includes(HOSTED_APP_URL_HINT) || flagEnabled(process.env.NEXT_PUBLIC_REQUIRE_MFA)),
      mfaRequired: flagEnabled(process.env.NEXT_PUBLIC_REQUIRE_MFA),
      appVersion: options.appVersion ?? null,
      generatedAt: (options.now ?? new Date()).toISOString(),
    },
  }
}

/** Loads and builds; null when the räkenskapsår is not the company's. */
export async function generateSystemdokumentation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  options: SystemdokumentationOptions = {},
): Promise<SystemdokumentationReport | null> {
  const facts = await loadSystemdokumentationFacts(supabase, companyId, periodId, options)
  return facts ? buildSystemdokumentation(facts) : null
}
