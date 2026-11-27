/**
 * Spend operations: company card and spend platform expenses (Pleo and the
 * like, through Accounted Connect), received with their receipts and coding,
 * and booking each one as its verifikat. Rules live in lib/spend/; the
 * dashboard's session routes call the same service functions. Connecting is
 * a browser round trip through the provider's consent page, so it has no
 * door here.
 */
import { z } from 'zod'
import { SPEND_EXPENSE_KINDS } from '@accounted/connect-contract'
import { accountNumberSchema, isoDateSchema } from '@/lib/invariants/zod'
import { spendSettingsPatchSchema } from '@/lib/spend/settings'
import type { SpendConnectionView } from '@/lib/spend/service'
import type { SpendItemSummaryRow } from '@/lib/spend/types'
import { defineOperation } from './types'

// Loaded on first use: the services pull in the engine, the document store
// and the Connect transport, which the registry's importers do not need.
const service = () => import('@/lib/spend/service')
const booking = () => import('@/lib/spend/book-item')

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const isoDate = isoDateSchema
const accountNumber = accountNumberSchema

const Reason = z.object({
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  message: z.string().optional(),
})

const SettingsShape = z.object({
  wallet_account: accountNumber.nullable(),
  out_of_pocket_account: accountNumber,
})

const Connection = z.object({
  connection_id: z.string().uuid(),
  provider: z.string(),
  provider_name: z.string(),
  mode: z.enum(['oauth', 'api_key']),
  provider_company_name: z.string().nullable(),
  status: z.enum(['connecting', 'active', 'disconnected']),
  health: z.enum(['ok', 'degraded', 'action_required']),
  health_code: z.string().nullable(),
  last_success_at: z.string().nullable(),
  next_run_at: z.string(),
  settings: SettingsShape,
  created_at: z.string(),
  ended_at: z.string().nullable(),
})

const ItemSummary = z.object({
  item_id: z.string().uuid(),
  connection_id: z.string().uuid(),
  provider: z.string(),
  external_id: z.string(),
  kind: z.enum(SPEND_EXPENSE_KINDS),
  expense_date: z.string(),
  currency: z.string(),
  amount: z.number(),
  merchant_name: z.string().nullable(),
  person_name: z.string().nullable(),
  status: z.enum(['ready', 'review', 'rejected', 'no_entry', 'booked']),
  reasons: z.array(Reason),
  receipts: z.number(),
  raw_sha256: z.string(),
  received_at: z.string(),
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

function connectionOut(c: SpendConnectionView): z.infer<typeof Connection> {
  return {
    connection_id: c.id,
    provider: c.provider,
    provider_name: c.provider_name,
    mode: c.mode,
    provider_company_name: c.provider_company_name,
    status: c.status,
    health: c.health,
    health_code: c.health_code,
    last_success_at: c.last_success_at,
    next_run_at: c.next_run_at,
    settings: c.resolved_settings,
    created_at: c.created_at,
    ended_at: c.ended_at,
  }
}

function itemOut(i: SpendItemSummaryRow): z.infer<typeof ItemSummary> {
  return {
    item_id: i.id,
    connection_id: i.connection_id,
    provider: i.provider,
    external_id: i.external_id,
    kind: i.kind,
    expense_date: i.expense_date,
    currency: i.currency,
    amount: i.amount,
    merchant_name: i.merchant_name,
    person_name: i.person_name,
    status: i.status,
    reasons: i.reasons,
    receipts: i.document_ids.length,
    raw_sha256: i.raw_sha256,
    received_at: i.received_at,
    changed_after_booking: i.changed_after_booking,
    journal_entry_id: i.journal_entry_id,
    booked_at: i.booked_at,
  }
}

const EXAMPLE_ITEM = {
  item_id: '7c1e…',
  connection_id: '0b3a…',
  provider: 'pleo',
  external_id: '59540ed2-0d68-4e36-9e31-58223975d9e9',
  kind: 'card_purchase',
  expense_date: '2026-10-14',
  currency: 'SEK',
  amount: 625,
  merchant_name: 'Papper & Penna AB',
  person_name: 'Anna Exempel',
  status: 'ready',
  reasons: [],
  receipts: 1,
  raw_sha256: '3f9a…',
  received_at: '2026-10-14T12:05:00Z',
  changed_after_booking: false,
  journal_entry_id: null,
  booked_at: null,
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const spendConnectionsList = defineOperation({
  id: 'spend.connections-list',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The company card and spend platforms the company has connected, with their health and accounts.',
    description:
      'Lists the company\'s spend connections (company card and spend platforms such as Pleo, through Accounted Connect): the provider and the provider company, the status (active or disconnected), the health of the delivery (ok, degraded, action_required with the error code), and the accounts expenses book to (settings: wallet_account, the 19xx account of the card balance, null to take the provider\'s own mapping; out_of_pocket_account, what an utlägg is owed on). available is false when this installation has no connector key, so no platform can be connected. Read-only.',
    useWhen: 'Before reading or booking card expenses, to see which platforms deliver and whether the delivery works.',
    doNotUseFor: 'The expenses themselves (GET /spend/items) or connecting a platform (a person does that in Inställningar, through the provider\'s consent page).',
    pitfalls: [
      'health action_required means delivery stopped until a person acts: health_code says why (CONNECTOR_SPEND_RECONNECT_REQUIRED: the grant at the provider is gone, connect again).',
      'Disconnected connections stay listed: their expenses are still the underlag of booked verifikat.',
    ],
    example: {
      response: {
        data: {
          available: true,
          connections: [
            {
              connection_id: '0b3a…',
              provider: 'pleo',
              provider_name: 'Pleo',
              mode: 'oauth',
              provider_company_name: 'Exempel AB',
              status: 'active',
              health: 'ok',
              health_code: null,
              last_success_at: '2026-10-14T12:05:02Z',
              next_run_at: '2026-10-14T12:10:00Z',
              settings: { wallet_account: '1941', out_of_pocket_account: '2820' },
              created_at: '2026-10-01T09:00:00Z',
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
  errorCodes: ['SPEND_READ_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/spend/connections' },
  mcp: {
    name: 'gnubok_list_spend_connections',
    title: 'List Card And Spend Platforms',
    description:
      'The company\'s connected company card and spend platforms (Pleo and the like, via Accounted Connect): provider, provider company, delivery health with its error code, and the wallet and utlägg accounts expenses book to.',
    keywords: ['pleo', 'företagskort', 'kortplattform', 'utgiftsplattform', 'kortköp', 'koppling', 'spend'],
  },
  run: async (ctx) => {
    const outcome = await (await service()).listSpendConnections(ctx, { include_ended: true })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { available: outcome.data.available, connections: outcome.data.connections.map(connectionOut) } }
  },
})

export const spendDisconnect = defineOperation({
  id: 'spend.disconnect',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Stop receiving a spend platform\'s expenses.',
    description:
      'Ends a spend connection: no more expenses are received and the connection is released at Accounted Connect. Expenses already received stay, booked or not, with their receipts and the provider\'s archived answer; the platform can be connected again later. Idempotent. Dry-runnable.',
    useWhen: 'The company stopped using the platform.',
    doNotUseFor: 'Skipping a single expense (just do not book it) or correcting a booked one (storno).',
    pitfalls: ['Expenses exported at the provider while disconnected never arrive: export them again after connecting.'],
    example: { request: {}, response: { data: { connection_id: '0b3a…', status: 'disconnected' }, meta: META } },
  },
  input: z.object({ connection_id: z.string().uuid().describe('The connection to end.') }),
  output: z.object({ connection_id: z.string().uuid(), status: z.literal('disconnected') }),
  errorCodes: ['SPEND_CONNECTION_NOT_FOUND', 'SPEND_DISCONNECT_FAILED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/spend/connections/:connectionId/disconnect',
    pathParams: { connectionId: 'connection_id' },
  },
  mcp: {
    name: 'gnubok_disconnect_spend_connection',
    title: 'Disconnect Spend Platform',
    description: 'Stage ending a company card or spend platform connection: no more expenses are received; received and booked ones stay. Approval disconnects it.',
    keywords: ['koppla från pleo', 'avsluta kortkoppling', 'företagskort', 'spend'],
    stage: {
      pendingType: 'disconnect_spend_connection',
      title: () => 'Koppla från utgiftsplattform',
    },
  },
  run: async (ctx, input, { dryRun }) => (await service()).disconnectSpendConnection(ctx, input, { dryRun }),
})

export const spendUpdateSettings = defineOperation({
  id: 'spend.update-settings',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Change the accounts a spend platform\'s expenses book to.',
    description:
      'Updates where a connection\'s expenses book their counter side: wallet_account, the 19xx account the card balance sits on (null takes the provider\'s own contra account mapping per expense), and out_of_pocket_account, the liability an utlägg is owed on until the person is paid back (2820 by default; an owner\'s utlägg is 2893 in an AB, 2018 in an EF). Send only what changes. Every unbooked received expense is re-evaluated, so one that waited on an account may become ready. Booked expenses never change. Dry-runnable.',
    useWhen: 'An expense waits with wallet_account_differs, or the company keeps the card balance on another 19xx account.',
    doNotUseFor: 'The accounts expenses are coded on: those come from the provider (the category the person picked there).',
    pitfalls: [
      'wallet_account must be a 19xx account (kassa och bank); anything else is refused by validation.',
      'An account neither in the chart nor standard BAS answers SPEND_SETTINGS_ACCOUNT_UNKNOWN.',
    ],
    example: {
      request: { settings: { wallet_account: '1941' } },
      response: { data: { connection_id: '0b3a…', reevaluated_items: 4 }, meta: META },
    },
  },
  input: z.object({
    connection_id: z.string().uuid(),
    settings: spendSettingsPatchSchema.describe('The fields to change (see description).'),
  }),
  output: z.object({ connection_id: z.string().uuid(), settings: SettingsShape, reevaluated_items: z.number() }),
  errorCodes: ['VALIDATION_ERROR', 'SPEND_CONNECTION_NOT_FOUND', 'SPEND_SETTINGS_ACCOUNT_UNKNOWN', 'SPEND_SETTINGS_FAILED'],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/spend/connections/:connectionId/settings',
    pathParams: { connectionId: 'connection_id' },
  },
  mcp: {
    name: 'gnubok_update_spend_settings',
    title: 'Update Spend Platform Accounts',
    description:
      'Stage changing the wallet (19xx card balance) and utlägg accounts a spend platform\'s expenses book their counter side to. Unbooked expenses are re-evaluated; booked ones never change. Approval saves it.',
    keywords: ['pleo konto', 'kortkonto', 'utläggskonto', '2820', 'företagskort', 'spend'],
    stage: {
      pendingType: 'update_spend_settings',
      title: () => 'Ändra konton för utgiftsplattformen',
    },
  },
  run: async (ctx, input, { dryRun }) => (await service()).updateSpendSettings(ctx, input, { dryRun }),
})

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export const spendItemsList = defineOperation({
  id: 'spend.items-list',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The expenses received from the company\'s card and spend platforms, newest first.',
    description:
      'One row per expense a person approved and exported at the provider: kind (card_purchase, refund, out_of_pocket, ...), date, amount (signed: negative is money back), merchant, the person, how many receipts arrived, and the status: ready to book, review (with the reasons a person must look at first), rejected (sent back to the provider with the reason), no_entry (a transfer the bank row books), booked (with the verifikat). Filter by date range, status or connection. Read-only.',
    useWhen: 'To find the expenses to book, or to check what a platform delivered.',
    doNotUseFor: 'The coding, the receipts and the verifikat an expense books as (GET /spend/items/{itemId}).',
    pitfalls: [
      'rejected rows are back at the provider: the person fixes the coding there and exports again, which updates the row.',
      'changed_after_booking true: the provider now sends something else than what was booked; compare and correct with storno if needed.',
    ],
    example: { request: { status: 'ready' }, response: { data: { items: [EXAMPLE_ITEM], total: 1 }, meta: META } },
  },
  input: z.object({
    from: isoDate.optional().describe('First expense date, inclusive.'),
    to: isoDate.optional().describe('Last expense date, inclusive.'),
    status: z.enum(['ready', 'review', 'rejected', 'no_entry', 'booked']).optional(),
    connection_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
  output: z.object({ items: z.array(ItemSummary), total: z.number() }),
  errorCodes: ['SPEND_READ_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/spend/items' },
  mcp: {
    name: 'gnubok_list_spend_items',
    title: 'List Card Expenses (Kortköp)',
    description:
      'Company card and spend platform expenses received with receipts and coding (Pleo and the like): kind, date, amount, merchant, person, receipts, and whether each is ready to book, needs review (with reasons), was rejected back to the provider, or is booked.',
    keywords: ['kortköp', 'pleo', 'företagskort', 'utlägg', 'kvitto', 'utgifter', 'spend'],
  },
  run: async (ctx, input) => {
    const outcome = await (await service()).listSpendItems(ctx, input)
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { items: outcome.data.items.map(itemOut), total: outcome.data.total } }
  },
})

export const spendItemGet = defineOperation({
  id: 'spend.item-get',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'One spend expense: its coding, receipts and the verifikat it books as.',
    description:
      'Everything GET /spend/items returns plus the expense model (lines with account, VAT code and dimensions, the merchant and its country, the person, attendees, the provider\'s reference and link) and the verifikat it books as with the current settings (proposal.lines). reasons lists what a person must look at before booking (a receipt missing for the VAT, representation, a payroll-related kind, a private purchase that needs a debit account). Read-only.',
    useWhen: 'Before booking an expense, to review it and its verifikat.',
    doNotUseFor: 'Downloading the receipts (they are documents, attached to the verifikat at booking).',
    pitfalls: ['proposal.lines is empty for a private purchase or a cash withdrawal until a debit account is chosen, and for rejected and no_entry expenses.'],
    example: {
      response: {
        data: {
          ...EXAMPLE_ITEM,
          description: 'Kortköp Papper & Penna AB (Anna Exempel): Pärmar, Pleo',
          provider_name: 'Pleo',
          proposal: {
            lines: [
              { account_number: '6110', debit_amount: 500, credit_amount: 0, line_description: 'Kontorsmaterial' },
              { account_number: '2641', debit_amount: 125, credit_amount: 0, line_description: 'Ingående moms 25 %' },
              { account_number: '1941', debit_amount: 0, credit_amount: 625, line_description: 'Betalt med företagskort' },
            ],
          },
          expense: {},
        },
        meta: META,
      },
    },
  },
  input: z.object({ item_id: z.string().uuid() }),
  output: ItemSummary.extend({
    description: z.string(),
    provider_name: z.string(),
    proposal: z.object({ lines: z.array(ProposalLine) }),
    expense: z.record(z.string(), z.unknown()),
  }),
  errorCodes: ['SPEND_ITEM_NOT_FOUND'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/spend/items/:itemId', pathParams: { itemId: 'item_id' } },
  mcp: {
    name: 'gnubok_get_spend_item',
    title: 'Get Card Expense',
    description:
      'One company card or spend platform expense: lines with account, VAT code and dimensions, merchant, person, attendees, receipts, review reasons, and the verifikat it books as with the current accounts.',
    keywords: ['kortköp', 'pleo', 'kvitto', 'kontering', 'utlägg', 'spend'],
  },
  run: async (ctx, input) => {
    const outcome = await (await service()).getSpendItem(ctx, input)
    if (!outcome.ok || outcome.dryRun) return outcome
    const d = outcome.data
    return {
      ok: true,
      data: {
        ...itemOut(d.item),
        reasons: d.reasons,
        description: d.description,
        provider_name: d.connection.provider_name,
        proposal: d.proposal,
        expense: d.item.expense as unknown as Record<string, unknown>,
      },
    }
  },
})

export const spendItemBook = defineOperation({
  id: 'spend.item-book',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book one spend expense as its verifikat, with its receipts as underlag.',
    description:
      'Posts the expense as one verifikat (source_type spend_item, dated the expense date) through the bookkeeping engine: each line\'s account debited with the net, Swedish input VAT on 2641 from the receipt, reverse charge on 2645 and 2614 with the basis pair for reverse codes, and the counter side the kind names (the wallet account for card spend, the utlägg account for an utlägg). The lines are the server\'s, from the stored expense and the connection\'s settings, never the caller\'s. The receipts that arrived with it are linked as underlag. Refused when the expense is booked, rejected, no_entry, changed since expected_raw_sha256, flagged for review without acknowledge_review, or the date is locked. Dry-runnable.',
    useWhen: 'An expense is ready, or in review and a person has read its reasons.',
    doNotUseFor: 'Wallet top-ups or reimbursements paid outside the platform (no_entry: book them from the bank row) or a corrected expense (storno, then book again).',
    pitfalls: [
      'Pass expected_raw_sha256 from the expense you reviewed: a newer export answers 409 SPEND_ITEM_CHANGED instead of booking different figures.',
      'Without a receipt no input VAT is booked: the gross goes to cost (ML 13 kap 31 §).',
      'A private purchase or a cash withdrawal needs debit_account: the receivable (1685 from an owner in an AB), the eget uttag (2013 in an EF), or what the company decides.',
      'A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.',
    ],
    example: {
      request: { expected_raw_sha256: '3f9a…' },
      response: {
        data: { journal_entry_id: '9a0b…', voucher_series: 'A', voucher_number: 42, entry_date: '2026-10-14', amount: 625, linked_documents: 1 },
        meta: META,
      },
    },
  },
  input: z.object({
    item_id: z.string().uuid(),
    expected_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional().describe('raw_sha256 of the expense you reviewed. Refused if it changed since.'),
    acknowledge_review: z.boolean().optional().describe('Book an expense flagged for review; a person read the reasons.'),
    debit_account: accountNumber.optional().describe('For a private purchase or a cash withdrawal: the account the debit side books on.'),
  }),
  output: z.object({
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    entry_date: z.string(),
    amount: z.number(),
    linked_documents: z.number(),
  }),
  errorCodes: [
    'SPEND_ITEM_NOT_FOUND',
    'SPEND_ITEM_ALREADY_BOOKED',
    'SPEND_ITEM_NOT_BOOKABLE',
    'SPEND_ITEM_NOT_RECEIVED',
    'SPEND_ITEM_CHANGED',
    'SPEND_ITEM_NEEDS_REVIEW',
    'SPEND_DEBIT_ACCOUNT_REQUIRED',
    'SPEND_DEBIT_ACCOUNT_UNKNOWN',
    'PERIOD_LOCKED',
    'SPEND_ITEM_NO_FISCAL_PERIOD',
    'SPEND_ITEM_BOOKING_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/spend/items/:itemId/book', pathParams: { itemId: 'item_id' } },
  mcp: {
    name: 'gnubok_book_spend_item',
    title: 'Book Card Expense (Kortköp)',
    description:
      'Stage booking one card or spend platform expense as its verifikat: lines from its coding, input VAT only with a receipt, reverse charge for reverse codes, the wallet or utlägg account as counter side. Refused if booked, rejected, unacknowledged or changed. Approval books it.',
    keywords: ['bokför kortköp', 'bokför pleo', 'bokför utlägg', 'kortköp', 'företagskort', 'kvitto', 'spend'],
    stage: {
      pendingType: 'book_spend_item',
      title: (input) => `Bokför utgift (${String(input.item_id ?? '').slice(0, 8)})`,
      // The approver saw this version of the expense: the commit must book it.
      pinParams: (input, preview) =>
        typeof preview.raw_sha256 === 'string' ? { ...input, expected_raw_sha256: preview.raw_sha256 } : input,
    },
  },
  run: async (ctx, input, { dryRun }) => (await booking()).bookSpendItem(ctx, input, { dryRun }),
})

export const spendItemsBook = defineOperation({
  id: 'spend.items-book',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book several ready spend expenses, each as its own verifikat.',
    description:
      'Books up to 50 expenses whose status is ready, each as its own verifikat exactly as POST /spend/items/{itemId}/book would (never one verifikat for several expenses: each card purchase is its own affärshändelse with its own receipt). Expenses in review, rejected, no_entry or already booked are reported in failed with their code and never booked here. Each booking stands on its own: one that fails leaves the others booked. Dry-runnable: the preview carries every verifikat\'s total.',
    useWhen: 'Booking a month of clean card expenses in one approval.',
    doNotUseFor: 'Expenses that need a person\'s look (book those one by one with acknowledge_review).',
    pitfalls: ['A ready expense that changed between the preview and the approval books as it is now: review the newest export when in doubt.'],
    example: {
      request: { item_ids: ['7c1e…', '8d2f…'] },
      response: { data: { booked: [{ item_id: '7c1e…', journal_entry_id: '9a0b…', voucher_series: 'A', voucher_number: 42, entry_date: '2026-10-14', amount: 625, linked_documents: 1 }], failed: [{ item_id: '8d2f…', code: 'SPEND_ITEM_NOT_READY' }] }, meta: META },
    },
  },
  input: z.object({ item_ids: z.array(z.string().uuid()).min(1).max(50).describe('The ready expenses to book.') }),
  output: z.object({
    booked: z.array(z.record(z.string(), z.unknown())),
    failed: z.array(z.object({ item_id: z.string(), code: z.string() })),
  }),
  errorCodes: ['VALIDATION_ERROR'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/spend/items/book' },
  mcp: {
    name: 'gnubok_book_spend_items',
    title: 'Book Card Expenses In Bulk',
    description:
      'Stage booking up to 50 ready company card or spend platform expenses, each as its own verifikat with its receipts linked. Expenses that need review are skipped and reported. Approval books them.',
    keywords: ['bokför alla kortköp', 'bokför pleo', 'massbokföring', 'kortköp', 'företagskort', 'spend'],
    stage: {
      pendingType: 'book_spend_items',
      title: (input) => `Bokför ${Array.isArray(input.item_ids) ? input.item_ids.length : 0} utgifter`,
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await (await booking()).bookSpendItems(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      created: outcome.created,
      data: { booked: outcome.data.booked as unknown as Record<string, unknown>[], failed: outcome.data.failed },
    }
  },
})

export const spendFetch = defineOperation({
  id: 'spend.fetch',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Receive waiting spend expenses now instead of waiting for the next run.',
    description:
      'Runs the delivery for the company\'s active spend connections (or one): the coding vocabulary goes to the provider when it changed, waiting expenses are received with their receipts, checked, and answered to the provider (received, or rejected with the reason). The regular run is every five minutes. A booked expense is never rewritten: a different answer only marks it changed_after_booking. Nothing is booked. Dry-runnable.',
    useWhen: 'A person just exported expenses at the provider and wants them now.',
    doNotUseFor: 'Booking (POST /spend/items/{itemId}/book).',
    pitfalls: ['A connection in action_required answers with the per-connection result status failed and its errorCode; fix the connection first.'],
    example: {
      request: {},
      response: { data: { results: [{ connectionId: '0b3a…', status: 'synced', received: 12, rejected: 1, deferred: 0, changedAfterBooking: 0, masterData: 'unchanged' }] }, meta: META },
    },
  },
  input: z.object({ connection_id: z.string().uuid().optional() }),
  output: z.object({ results: z.array(z.record(z.string(), z.unknown())) }),
  errorCodes: ['SPEND_SANDBOX_BLOCKED', 'SPEND_CONNECTION_NOT_FOUND'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/spend/fetch' },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await (await service()).fetchSpendNow(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { results: outcome.data.results as unknown as Record<string, unknown>[] } }
  },
})

/** Every spend operation, in registry order. */
export const SPEND_OPERATIONS_LIST = [
  spendConnectionsList,
  spendDisconnect,
  spendUpdateSettings,
  spendItemsList,
  spendItemGet,
  spendItemBook,
  spendItemsBook,
  spendFetch,
] as const
