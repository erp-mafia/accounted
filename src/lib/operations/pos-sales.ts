/**
 * POS sales (kassasystem) operations: the connected point-of-sale venues, the
 * business days they deliver through Accounted Connect, and booking a day as
 * its daily takings voucher (gemensam verifikation, BFL 5 kap 6 §). Rules
 * live in lib/pos-sales/; the dashboard's session routes call the same
 * service functions.
 */
import { z } from 'zod'
import { POS_TENDER_KINDS } from '@accounted/connect-contract'
import { accountNumberSchema, isoDateSchema } from '@/lib/invariants/zod'
import { posSalesSettingsPatchSchema } from '@/lib/pos-sales/settings'
import type { PosConnectionView } from '@/lib/pos-sales/service'
import type { PosSalesDaySummaryRow } from '@/lib/pos-sales/types'
import { defineOperation } from './types'

// Loaded on first use: the services pull in the engine, the PDF renderer and
// the Connect transport, which the registry's importers do not otherwise need.
const service = () => import('@/lib/pos-sales/service')
const booking = () => import('@/lib/pos-sales/book-day')

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const isoDate = isoDateSchema
const accountNumber = accountNumberSchema

const TenderSummary = z.object({
  kind: z.enum(POS_TENDER_KINDS),
  method: z.string(),
  amount: z.number(),
  tips: z.number(),
  receiptCount: z.number(),
})
const VatGroupSummary = z.object({ ratePercent: z.number(), net: z.number(), vat: z.number(), gross: z.number() })
const ReviewReason = z.object({
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  message: z.string().optional(),
})

const SettingsShape = z.object({
  tender_accounts: z.record(z.string(), accountNumber.nullable()),
  revenue_accounts: z.record(z.string(), accountNumber.nullable()),
  vat_accounts: z.record(z.string(), accountNumber.nullable()),
  tips_account: accountNumber,
  rounding_account: accountNumber,
  max_rounding: z.number(),
})

const Connection = z.object({
  connection_id: z.string().uuid(),
  provider: z.string(),
  provider_name: z.string(),
  venue_ref: z.string(),
  venue_name: z.string(),
  status: z.enum(['connecting', 'needs_setup', 'active', 'disconnected']),
  health: z.enum(['ok', 'degraded', 'action_required']),
  health_code: z.string().nullable(),
  sync_from: z.string(),
  synced_through: z.string().nullable(),
  last_success_at: z.string().nullable(),
  next_run_at: z.string(),
  settings: SettingsShape,
  created_at: z.string(),
  ended_at: z.string().nullable(),
})

const DaySummary = z.object({
  day_id: z.string().uuid(),
  connection_id: z.string().uuid(),
  business_date: z.string(),
  currency: z.string(),
  status: z.enum(['ready', 'needs_review', 'empty', 'booked']),
  review_reasons: z.array(ReviewReason),
  gross: z.number(),
  net: z.number(),
  vat: z.number(),
  tips: z.number(),
  receipt_count: z.number(),
  tenders: z.array(TenderSummary),
  vat_groups: z.array(VatGroupSummary),
  raw_sha256: z.string(),
  fetched_at: z.string(),
  changed_after_booking: z.boolean(),
  journal_entry_id: z.string().uuid().nullable(),
  booked_at: z.string().nullable(),
})

const ProposalLine = z.object({
  account_number: z.string(),
  debit_amount: z.number(),
  credit_amount: z.number(),
  line_description: z.string().optional(),
})

function connectionOut(c: PosConnectionView): z.infer<typeof Connection> {
  return {
    connection_id: c.id,
    provider: c.provider,
    provider_name: c.provider_name,
    venue_ref: c.venue_ref,
    venue_name: c.venue_name,
    status: c.status,
    health: c.health,
    health_code: c.health_code,
    sync_from: c.sync_from,
    synced_through: c.synced_through,
    last_success_at: c.last_success_at,
    next_run_at: c.next_run_at,
    settings: c.resolved_settings,
    created_at: c.created_at,
    ended_at: c.ended_at,
  }
}

function dayOut(d: PosSalesDaySummaryRow): z.infer<typeof DaySummary> {
  return {
    day_id: d.id,
    connection_id: d.connection_id,
    business_date: d.business_date,
    currency: d.currency,
    status: d.status,
    review_reasons: d.review_reasons,
    gross: d.gross,
    net: d.net,
    vat: d.vat,
    tips: d.tips,
    receipt_count: d.receipt_count,
    tenders: d.tenders,
    vat_groups: d.vat_groups,
    raw_sha256: d.raw_sha256,
    fetched_at: d.fetched_at,
    changed_after_booking: d.changed_after_booking,
    journal_entry_id: d.journal_entry_id,
    booked_at: d.booked_at,
  }
}

const EXAMPLE_DAY = {
  day_id: '7c1e…',
  connection_id: '0b3a…',
  business_date: '2026-09-30',
  currency: 'SEK',
  status: 'ready',
  review_reasons: [],
  gross: 39070,
  net: 34000,
  vat: 5070,
  tips: 640,
  receipt_count: 212,
  tenders: [
    { kind: 'card', method: 'card', amount: 28640, tips: 640, receiptCount: 160 },
    { kind: 'swish', method: 'swish', amount: 6000, tips: 0, receiptCount: 40 },
    { kind: 'cash', method: 'cash', amount: 5070, tips: 0, receiptCount: 12 },
  ],
  vat_groups: [
    { ratePercent: 25, net: 9000, vat: 2250, gross: 11250 },
    { ratePercent: 12, net: 22000, vat: 2640, gross: 24640 },
    { ratePercent: 6, net: 3000, vat: 180, gross: 3180 },
  ],
  raw_sha256: '3f9a…',
  fetched_at: '2026-10-01T04:15:00Z',
  changed_after_booking: false,
  journal_entry_id: null,
  booked_at: null,
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const posSalesConnectionsList = defineOperation({
  id: 'pos-sales.connections-list',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The point-of-sale venues the company has connected, with their health and account mapping.',
    description:
      'Lists the company\'s POS connections (kassasystem) through Accounted Connect: the provider and venue, the status (active or disconnected), the health of the daily fetch (ok, degraded, action_required with the error code), the first business day fetched (sync_from) and the last one fetched without a gap (synced_through), and the account mapping each day is booked with (settings, defaults merged in). available is false when this installation has no connector key, so no POS system can be connected. Read-only.',
    useWhen: 'Before reading or booking POS days, to see which venues feed the company and whether the fetch works.',
    doNotUseFor: 'The days themselves (GET /pos-sales/days) or venues not yet connected (GET /pos-sales/venues).',
    pitfalls: [
      'health action_required means fetching stopped until a person acts: health_code says why (for example CONNECTOR_POS_PROVIDER_ACCESS_DENIED: the provider has not opened the venue for Accounted).',
      'Disconnected connections stay listed: their days are still the underlag of booked vouchers.',
    ],
    example: {
      response: {
        data: {
          available: true,
          connections: [
            {
              connection_id: '0b3a…',
              provider: 'heynow',
              provider_name: 'Heynow',
              venue_ref: '6081523749284167',
              venue_name: 'Restaurang Exempel',
              status: 'active',
              health: 'ok',
              health_code: null,
              sync_from: '2026-09-30',
              synced_through: '2026-10-02',
              last_success_at: '2026-10-03T04:15:02Z',
              next_run_at: '2026-10-04T04:15:00Z',
              settings: {
                tender_accounts: { card: '1686', swish: '1686', cash: '1910', gift_card: '2421', invoice: null, prepaid: null, other: null },
                revenue_accounts: { '25': '3001', '12': '3002', '6': '3003', '0': null },
                vat_accounts: { '25': '2611', '12': '2621', '6': '2631' },
                tips_account: '2820',
                rounding_account: '3740',
                max_rounding: 1,
              },
              created_at: '2026-10-03T09:00:00Z',
              ended_at: null,
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: z.object({ available: z.boolean(), connections: z.array(Connection) }),
  errorCodes: ['POS_READ_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/pos-sales/connections' },
  mcp: {
    name: 'gnubok_list_pos_connections',
    title: 'List POS Connections (Kassasystem)',
    description:
      'The company\'s connected point-of-sale venues (kassasystem via Accounted Connect): provider, venue, fetch health with its error code, the days fetched so far, and the account mapping daily takings are booked with.',
    keywords: ['kassasystem', 'kassaregister', 'kassa', 'pos', 'dagskassa', 'koppling', 'heynow'],
  },
  run: async (ctx) => {
    const outcome = await (await service()).listPosConnections(ctx, { include_ended: true })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { available: outcome.data.available, connections: outcome.data.connections.map(connectionOut) } }
  },
})

export const posSalesVenuesList = defineOperation({
  id: 'pos-sales.venues-list',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The point-of-sale venues this company may connect, and how to get one opened.',
    description:
      'Asks Accounted Connect which POS venues are open to this company\'s organisation number: a POS provider opens a venue for Accounted when the venue asks it to, and Accounted records which organisation the venue belongs to. Each venue says whether this company already holds it (connected) and whether it is free (available). providers lists the POS providers this installation can use, each with accessRequestSv: what the venue sends the provider to get a venue opened. Read-only; nothing is connected.',
    useWhen: 'To find the venue to connect with POST /pos-sales/connections, or to tell a person how to get their venue opened.',
    doNotUseFor: 'Venues already connected (GET /pos-sales/connections).',
    pitfalls: [
      'An empty venues list means no provider has opened a venue for this organisation yet: follow accessRequestSv.',
      'POS_ORG_NUMBER_MISSING: the company has no organisation number to match venues against.',
    ],
    example: {
      response: {
        data: {
          org_number: '5561234567',
          venues: [
            {
              provider: { ref: 'heynow', displayName: 'Heynow', legalName: 'Heynow AB', portalUrl: 'https://heynow.ai', supportUrl: null, accessRequestSv: 'Be Heynow öppna API-åtkomst för Accounted…' },
              venueRef: '6081523749284167',
              name: 'Restaurang Exempel',
              connected: false,
              available: true,
            },
          ],
          providers: [],
        },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: z.object({
    org_number: z.string(),
    venues: z.array(z.record(z.string(), z.unknown())),
    providers: z.array(z.record(z.string(), z.unknown())),
  }),
  errorCodes: ['POS_ORG_NUMBER_MISSING', 'POS_CONNECT_UNCONFIGURED', 'POS_CONNECT_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/pos-sales/venues' },
  mcp: {
    name: 'gnubok_list_pos_venues',
    title: 'List Connectable POS Venues',
    description:
      'Point-of-sale venues open to this company (matched on its organisation number) that can be connected, and for each POS provider the Swedish instructions a venue follows to get access opened for Accounted.',
    keywords: ['kassasystem', 'kassa', 'pos', 'venue', 'restaurang', 'koppla kassa', 'heynow'],
  },
  run: async (ctx) => {
    const outcome = await (await service()).listAvailablePosVenues(ctx)
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: {
        org_number: outcome.data.org_number,
        venues: outcome.data.venues as unknown as Record<string, unknown>[],
        providers: outcome.data.providers as unknown as Record<string, unknown>[],
      },
    }
  },
})

export const posSalesConnect = defineOperation({
  id: 'pos-sales.connect',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Connect a point-of-sale venue, so its business days are fetched every morning.',
    description:
      'Connects one venue listed by GET /pos-sales/venues to the company through Accounted Connect. From the next run on, every closed business day from sync_from on is fetched (each morning, after the venue closed) and stored with the provider\'s answer archived verbatim. Nothing is booked: each day waits for POST /pos-sales/days/{dayId}/book. sync_from defaults to yesterday; set it to the venue\'s first trading day to read earlier days. Dry-runnable.',
    useWhen: 'A venue is listed as available and the company wants its daily sales in the books.',
    doNotUseFor: 'Getting a venue opened at the provider (the venue asks the provider, see accessRequestSv) or booking days.',
    pitfalls: [
      'POS_ALREADY_CONNECTED: the venue is already connected; the connection id is in details.',
      'A venue another company holds answers POS_CONNECT_FAILED with details.connect_code CONNECTOR_POS_VENUE_TAKEN.',
      'Refused in the sandbox (POS_SANDBOX_BLOCKED).',
    ],
    example: {
      request: { provider: 'heynow', venue_ref: '6081523749284167', sync_from: '2026-09-30' },
      response: { data: { connection_id: '0b3a…', venue_name: 'Restaurang Exempel', provider_name: 'Heynow', sync_from: '2026-09-30' }, meta: META },
    },
  },
  input: z.object({
    provider: z.string().trim().min(1).max(64).describe('Provider ref from GET /pos-sales/venues, e.g. heynow.'),
    venue_ref: z.string().trim().min(1).max(64).describe('The venueRef from GET /pos-sales/venues.'),
    sync_from: isoDate.optional().describe('First business day to fetch; defaults to yesterday.'),
  }),
  output: z.object({ connection_id: z.string().uuid(), venue_name: z.string(), provider_name: z.string(), sync_from: z.string() }),
  errorCodes: ['POS_SANDBOX_BLOCKED', 'POS_ORG_NUMBER_MISSING', 'POS_SYNC_FROM_INVALID', 'POS_ALREADY_CONNECTED', 'POS_CONNECT_UNCONFIGURED', 'POS_CONNECT_FAILED'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/pos-sales/connections' },
  mcp: {
    name: 'gnubok_connect_pos_venue',
    title: 'Connect POS Venue (Kassasystem)',
    description:
      'Stage connecting a point-of-sale venue from gnubok_list_pos_venues: its closed business days are then fetched each morning from sync_from (default yesterday), ready to book. Nothing is booked. Approval connects it.',
    keywords: ['koppla kassa', 'kassasystem', 'anslut kassa', 'pos', 'heynow'],
    stage: {
      pendingType: 'connect_pos_venue',
      title: (input) => `Koppla kassa ${String(input.venue_ref ?? '')} (${String(input.provider ?? '')})`,
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await (await service()).connectPosVenue(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const c = outcome.data.connection
    return {
      ok: true,
      created: true,
      data: { connection_id: c.id, venue_name: c.venue_name, provider_name: c.provider_name, sync_from: c.sync_from },
    }
  },
})

export const posSalesDisconnect = defineOperation({
  id: 'pos-sales.disconnect',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Stop fetching a point-of-sale venue\'s days.',
    description:
      'Ends a POS connection: no more days are fetched and the venue is released at Accounted Connect. Days already fetched stay, booked or not, with their archived provider answers; a disconnected venue can be connected again later. Idempotent. Dry-runnable.',
    useWhen: 'The company stopped using the POS system or the venue closed.',
    doNotUseFor: 'Pausing a single day (just do not book it) or correcting a booked day (storno).',
    pitfalls: ['Days not fetched before the disconnect are not fetched later unless the venue is connected again with an earlier sync_from.'],
    example: { request: {}, response: { data: { connection_id: '0b3a…', status: 'disconnected' }, meta: META } },
  },
  input: z.object({ connection_id: z.string().uuid().describe('The connection to end.') }),
  output: z.object({ connection_id: z.string().uuid(), status: z.literal('disconnected') }),
  errorCodes: ['POS_CONNECTION_NOT_FOUND', 'POS_DISCONNECT_FAILED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/pos-sales/connections/:connectionId/disconnect',
    pathParams: { connectionId: 'connection_id' },
  },
  mcp: {
    name: 'gnubok_disconnect_pos_connection',
    title: 'Disconnect POS Venue',
    description: 'Stage ending a point-of-sale connection: no more business days are fetched; fetched and booked days stay. Approval disconnects it.',
    keywords: ['koppla från kassa', 'avsluta kassakoppling', 'kassasystem', 'pos'],
    stage: {
      pendingType: 'disconnect_pos_connection',
      title: () => 'Koppla från kassasystem',
    },
  },
  run: async (ctx, input, { dryRun }) => (await service()).disconnectPosConnection(ctx, input, { dryRun }),
})

export const posSalesUpdateSettings = defineOperation({
  id: 'pos-sales.update-settings',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Change the accounts a point-of-sale venue\'s days are booked to.',
    description:
      'Updates the account mapping of one POS connection: an account per way of paying (tender_accounts: card, swish, cash, gift_card, invoice, prepaid, other; null = a person decides each time), the revenue and output VAT account per VAT rate (keys "25", "12", "6", "0"), the tips account, the rounding account and the largest rounding difference per day. Send only what changes; nested maps merge key by key. Every unbooked day is re-evaluated against the new mapping, so a day that waited on an account may become ready. Booked days never change. Dry-runnable.',
    useWhen: 'A day is needs_review with tender_unmapped or vat_rate_unmapped, or the company books takings to other accounts than the BAS defaults.',
    doNotUseFor: 'Re-booking a booked day (reverse it with storno and book again).',
    pitfalls: [
      'Defaults: card and Swish 1686 (cleared by the payouts, so revenue is never booked twice), cash 1910, redeemed gift cards 2421, tips 2820 (a liability until paid out through payroll), 25/12/6 % to 3001/3002/3003 with 2611/2621/2631, rounding 3740.',
      'Sales without VAT have no default account: in a restaurant they are often gift cards sold (2421) rather than exempt sales (3004).',
      'An account neither in the chart nor in BAS answers POS_SETTINGS_ACCOUNT_UNKNOWN.',
    ],
    example: {
      request: { settings: { revenue_accounts: { '0': '2421' }, tender_accounts: { invoice: '1510' } } },
      response: { data: { connection_id: '0b3a…', reevaluated_days: 3 }, meta: META },
    },
  },
  input: z.object({
    connection_id: z.string().uuid(),
    settings: posSalesSettingsPatchSchema.describe('The fields to change (see description).'),
  }),
  output: z.object({ connection_id: z.string().uuid(), settings: SettingsShape, reevaluated_days: z.number() }),
  errorCodes: ['VALIDATION_ERROR', 'POS_CONNECTION_NOT_FOUND', 'POS_SETTINGS_ACCOUNT_UNKNOWN', 'POS_SETTINGS_FAILED'],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/pos-sales/connections/:connectionId/settings',
    pathParams: { connectionId: 'connection_id' },
  },
  mcp: {
    name: 'gnubok_update_pos_settings',
    title: 'Update POS Account Mapping',
    description:
      'Stage changing the accounts a point-of-sale venue\'s days are booked to (per way of paying, per VAT rate, tips, rounding). Unbooked days are re-evaluated; booked days never change. Approval saves it.',
    keywords: ['kontering kassa', 'kassakonto', 'dagskassa konto', '1686', 'dricks', 'kassasystem'],
    stage: {
      pendingType: 'update_pos_sales_settings',
      title: () => 'Ändra konton för kassasystemet',
    },
  },
  run: async (ctx, input, { dryRun }) => (await service()).updatePosSalesSettings(ctx, input, { dryRun }),
})

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export const posSalesDaysList = defineOperation({
  id: 'pos-sales.days-list',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The business days fetched from the company\'s point-of-sale venues, newest first.',
    description:
      'One row per venue and business day: sales (gross, net, VAT), tips, receipts, the payment split (tenders: card, swish, cash, gift_card, invoice, prepaid, other) and the VAT split, the status (ready to book, needs_review with the reasons, empty for a day without sales, booked with the verifikat), the hash of the archived provider answer, and whether a fetch after booking answered differently (changed_after_booking). Filter by date range, status or connection. Read-only.',
    useWhen: 'To find the days to book, or to check which days a venue has delivered.',
    doNotUseFor: 'The receipts and the voucher a day books as (GET /pos-sales/days/{dayId}).',
    pitfalls: [
      'A day is fetched the morning after it ends (from 06:00 Swedish time) and once more the next morning while unbooked.',
      'changed_after_booking true: the provider now answers something else than what was booked; compare and correct with storno if needed.',
    ],
    example: { request: { status: 'ready' }, response: { data: { days: [EXAMPLE_DAY], total: 1 }, meta: META } },
  },
  input: z.object({
    from: isoDate.optional().describe('First business date, inclusive.'),
    to: isoDate.optional().describe('Last business date, inclusive.'),
    status: z.enum(['ready', 'needs_review', 'empty', 'booked']).optional(),
    connection_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
  output: z.object({ days: z.array(DaySummary), total: z.number() }),
  errorCodes: ['POS_READ_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/pos-sales/days' },
  mcp: {
    name: 'gnubok_list_pos_sales_days',
    title: 'List POS Sales Days (Kassarapporter)',
    description:
      'Daily point-of-sale takings per venue: sales, VAT and payment split (card, Swish, cash), tips, receipts, and whether each day is ready to book, needs review (with reasons), empty or booked.',
    keywords: ['kassarapport', 'dagsrapport', 'z-rapport', 'dagskassa', 'kassa', 'försäljning per dag', 'pos'],
  },
  run: async (ctx, input) => {
    const outcome = await (await service()).listPosSalesDays(ctx, input)
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { days: outcome.data.days.map(dayOut), total: outcome.data.total } }
  },
})

export const posSalesDayGet = defineOperation({
  id: 'pos-sales.day-get',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'One point-of-sale day: its receipts and the voucher it books as.',
    description:
      'The full day: everything GET /pos-sales/days returns plus the day model (receipts with number, time, payment method and amount; sales per article group; refunds; discounts; the provider\'s issues) and the voucher the day books as with the current mapping (proposal: the lines, the rounding). reasons lists what needs a person; acknowledgeable is true when every reason is a provider issue, which acknowledge_issues on the booking accepts after review. Read-only.',
    useWhen: 'Before booking a day, to review it and its voucher.',
    doNotUseFor: 'The day report PDF (the dashboard renders it).',
    pitfalls: ['proposal.lines is empty while a reason other than a provider issue remains: fix the mapping first.'],
    example: {
      response: {
        data: {
          ...EXAMPLE_DAY,
          description: 'Dagskassa 2026-09-30 Restaurang Exempel (Heynow)',
          proposal: {
            lines: [
              { account_number: '1686', debit_amount: 28640, credit_amount: 0, line_description: 'Kortbetalningar' },
              { account_number: '3002', debit_amount: 0, credit_amount: 22000, line_description: 'Försäljning 12 % moms' },
            ],
            rounding_amount: 0,
          },
          reasons: [],
          acknowledgeable: false,
          day: {},
        },
        meta: META,
      },
    },
  },
  input: z.object({ day_id: z.string().uuid() }),
  output: DaySummary.extend({
    description: z.string(),
    venue_name: z.string(),
    provider_name: z.string(),
    proposal: z.object({ lines: z.array(ProposalLine), rounding_amount: z.number() }),
    reasons: z.array(ReviewReason),
    acknowledgeable: z.boolean(),
    day: z.record(z.string(), z.unknown()),
  }),
  errorCodes: ['POS_DAY_NOT_FOUND'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/pos-sales/days/:dayId', pathParams: { dayId: 'day_id' } },
  mcp: {
    name: 'gnubok_get_pos_sales_day',
    title: 'Get POS Sales Day',
    description:
      'One point-of-sale business day: receipts, sales per VAT rate and article group, payment split, tips, provider issues, and the daily takings voucher it books as with the current account mapping.',
    keywords: ['kassarapport', 'dagsrapport', 'kvitton', 'dagskassa', 'kontering kassa', 'pos'],
  },
  run: async (ctx, input) => {
    const outcome = await (await service()).getPosSalesDay(ctx, input)
    if (!outcome.ok || outcome.dryRun) return outcome
    const d = outcome.data
    return {
      ok: true,
      data: {
        ...dayOut(d.day),
        description: d.description,
        venue_name: d.connection.venue_name,
        provider_name: d.connection.provider_name,
        proposal: d.proposal,
        reasons: d.reasons,
        acknowledgeable: d.acknowledgeable,
        day: d.day.day as unknown as Record<string, unknown>,
      },
    }
  },
})

export const posSalesDayBook = defineOperation({
  id: 'pos-sales.day-book',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a point-of-sale day as its daily takings voucher, with the day report as underlag.',
    description:
      'Posts the day as one verifikat (source_type pos_daily_sales, dated the business day) through the bookkeeping engine: each way of paying debited to its account (card and Swish to the 1686 clearing account by default), sales credited per VAT rate with the output VAT, tips credited to the tips account, a rounding difference up to max_rounding on the rounding account. The lines are the server\'s, from the stored day and the connection\'s mapping, never the caller\'s. The day report (sales, payments, receipts, the archived answer\'s SHA-256) is archived on the verifikat. Refused when the day is booked, empty, needs review, changed since expected_raw_sha256, or the date is locked. Dry-runnable.',
    useWhen: 'A day is ready (or needs_review with only provider issues a person has read) and should be booked.',
    doNotUseFor: 'Payouts from the card acquirer or the bank (book those against 1686 from the bank row) or a corrected day (storno, then book again).',
    pitfalls: [
      'Pass expected_raw_sha256 from the day you reviewed: a newer fetch answers 409 POS_DAY_CHANGED instead of booking different figures.',
      'acknowledge_issues books past provider issues only; a missing account (tender_unmapped, vat_rate_unmapped) or an imbalance always stops the day.',
      'A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.',
      'The card acquirer\'s payout must clear 1686 when it reaches the bank, never be booked as sales again.',
    ],
    example: {
      request: { expected_raw_sha256: '3f9a…' },
      response: {
        data: {
          journal_entry_id: '9a0b…',
          voucher_series: 'F',
          voucher_number: 12,
          entry_date: '2026-09-30',
          business_date: '2026-09-30',
          gross: 39070,
          underlag_document_id: '5d2c…',
        },
        meta: META,
      },
    },
  },
  input: z.object({
    day_id: z.string().uuid(),
    acknowledge_issues: z.boolean().optional().describe('Book although the provider reported issues; a person read the day report.'),
    expected_raw_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe('raw_sha256 of the day you reviewed. Refused if the day changed since.'),
  }),
  output: z.object({
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    entry_date: z.string(),
    business_date: z.string(),
    gross: z.number(),
    underlag_document_id: z.string().uuid().nullable(),
  }),
  errorCodes: [
    'POS_DAY_NOT_FOUND',
    'POS_DAY_ALREADY_BOOKED',
    'POS_DAY_CHANGED',
    'POS_DAY_EMPTY',
    'POS_DAY_NEEDS_REVIEW',
    'PERIOD_LOCKED',
    'POS_DAY_NO_FISCAL_PERIOD',
    'POS_DAY_BOOKING_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/pos-sales/days/:dayId/book', pathParams: { dayId: 'day_id' } },
  mcp: {
    name: 'gnubok_book_pos_sales_day',
    title: 'Book POS Sales Day (Dagskassa)',
    description:
      'Stage booking a point-of-sale day as its daily takings voucher: payments debited (card and Swish to 1686), sales and VAT per rate credited, tips to 2820, day report archived as underlag. Refused if booked, empty, unmapped or changed. Approval books it.',
    keywords: ['bokför dagskassa', 'bokför kassarapport', 'dagsrapport', 'z-rapport', 'dagskassa', 'kassa', 'pos'],
    stage: {
      pendingType: 'book_pos_sales_day',
      title: (input) => `Bokför dagskassa (${String(input.day_id ?? '').slice(0, 8)})`,
      // The approver saw this version of the day: the commit must book it.
      pinParams: (input, preview) =>
        typeof preview.raw_sha256 === 'string' ? { ...input, expected_raw_sha256: preview.raw_sha256 } : input,
    },
  },
  run: async (ctx, input, { dryRun }) => (await booking()).bookPosSalesDay(ctx, input, { dryRun }),
})

export const posSalesFetch = defineOperation({
  id: 'pos-sales.fetch',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Fetch point-of-sale days now instead of waiting for the morning run.',
    description:
      'Runs the fetch for the company\'s active POS connections (or one): with business_dates, exactly those closed days (fetched again if stored); without, the regular plan (days not yet fetched, oldest first, then one more read of the two latest unbooked days). A booked day is never rewritten: a different answer only marks it changed_after_booking. Each day is one call to the provider, whose limit is ten an hour per venue, so the run stops at six. Nothing is booked. Dry-runnable.',
    useWhen: 'A person corrected a day in the POS system, or wants yesterday before the morning run.',
    doNotUseFor: 'Today (a business day is fetched once it has ended) or booking.',
    pitfalls: ['A rate-limited run answers with the per-connection result status failed and errorCode CONNECTOR_POS_PROVIDER_RATE_LIMITED; try again later.'],
    example: {
      request: { business_dates: ['2026-10-02'] },
      response: { data: { results: [{ connectionId: '0b3a…', status: 'synced', fetched: ['2026-10-02'], changed: ['2026-10-02'], changedAfterBooking: [] }] }, meta: META },
    },
  },
  input: z.object({
    connection_id: z.string().uuid().optional(),
    business_dates: z.array(isoDate).min(1).max(6).optional().describe('Closed business days to fetch now.'),
  }),
  output: z.object({ results: z.array(z.record(z.string(), z.unknown())) }),
  errorCodes: ['POS_SANDBOX_BLOCKED', 'POS_CONNECTION_NOT_FOUND'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/pos-sales/fetch' },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await (await service()).fetchPosSalesDays(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { results: outcome.data.results as unknown as Record<string, unknown>[] } }
  },
})
