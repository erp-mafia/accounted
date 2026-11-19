/**
 * The connector feeds for agents (crm#1385): Stripe, Shopify, WooCommerce and
 * Zettle. An agent saw the rows a feed had imported but not the feed itself,
 * so a row missing at the connection start needed a person to press "Hämta
 * äldre" in the panel.
 *
 * - gnubok_list_feed_connections: each connection with its start and its
 *   cursor (how far it has synced). A READ, search-only: reachable through
 *   gnubok_search_tools and the gnubok_call_tool bridge at no cost to the
 *   tools/list budget.
 * - gnubok_backfill_feed: the panel's backfill, through the same
 *   runFeedBackfill, so it starts after the days the books already hold
 *   (crm#1386) unless include_booked. A direct write (no bridge carries one),
 *   so it rides the default catalog. Books nothing: rows land unbooked, in
 *   the inbox (Stripe) or on the Orders page (the shops and the till).
 *
 * Both answer for the same connector specs the routes serve, with the same
 * paid capability and the panel's per-user backfill rate limit.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { capabilityBlockedRefusal, hasCapability } from '@/lib/entitlements/has-capability'
import { badArgument, codedRefusal } from '@/lib/errors/refusal'
import { dbError } from '@/lib/errors/db-error'
import { createLogger } from '@/lib/logger'
import {
  RATE_LIMIT_BACKFILL,
  runFeedBackfill,
  type FeedBackfillRefusal,
  type FeedConnectorSpec,
} from '@/lib/feed-sync/connector-routes'
import { stripeFeed } from '@/extensions/general/stripe/index'
import { shopifyFeed } from '@/extensions/general/shopify/api-routes'
import { woocommerceFeed } from '@/extensions/general/woocommerce/api-routes'
import { zettleFeed } from '@/extensions/general/zettle/api-routes'
import type { McpTool, McpToolAnnotations } from './server'

const log = createLogger('mcp-feed-tools')

export const FEED_PROVIDERS = ['stripe', 'shopify', 'woocommerce', 'zettle'] as const
type FeedProvider = (typeof FEED_PROVIDERS)[number]

// The specs differ in their connection row and summary types; these tools
// only pass them through to the shared feed code.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFeedSpec = FeedConnectorSpec<any, any>

const FEEDS: Record<FeedProvider, AnyFeedSpec> = {
  stripe: stripeFeed,
  shopify: shopifyFeed,
  woocommerce: woocommerceFeed,
  zettle: zettleFeed,
}

/**
 * Where the shops' and the till's rows land, with the tool that reads them.
 * Named because an agent that knew only "the Orders page" looked for synced
 * WooCommerce orders among the kundorder (gnubok_list_sales_orders) and in
 * the archive, found none in either and reported the orders missing
 * (crm#1931).
 */
const ORDERS_PAGE =
  'on the Orders page, unbooked: read them with gnubok_list_webshop_orders (through gnubok_call_tool if your client does not show it), not gnubok_list_sales_orders'

/** Where the rows of each feed land, for the answer's next step. */
const LANDS_IN: Record<FeedProvider, string> = {
  stripe: 'unbooked in the transactions inbox (gnubok_list_uncategorized_transactions)',
  shopify: ORDERS_PAGE,
  woocommerce: ORDERS_PAGE,
  zettle: ORDERS_PAGE,
}

const BACKFILL_REFUSAL_EN: Record<FeedBackfillRefusal, string> = {
  invalid: 'from must be a real day, YYYY-MM-DD.',
  future: 'from cannot be in the future.',
  too_old: 'from is further back than this feed reaches.',
  not_connected: 'no active connection of this provider for the company.',
  several_connections: 'several connections are active: pass connection_id (gnubok_list_feed_connections).',
  ledger_unreadable: 'the books could not be read to find the days they already hold. Retry.',
  cursor_unsaved: 'the start day could not be saved. Retry.',
  locked: 'another sync of this connection is running. Retry in a minute.',
  sync_failed: 'the provider could not be read. Retry.',
}

function providerOf(value: unknown, required: boolean): FeedProvider | null {
  if (value === undefined && !required) return null
  if (typeof value === 'string' && (FEED_PROVIDERS as readonly string[]).includes(value)) {
    return value as FeedProvider
  }
  throw badArgument('provider', `provider must be one of ${FEED_PROVIDERS.join(', ')}.`)
}

/** The refusal an agent acts on, from the shared backfill's reason. */
function backfillRefusal(provider: FeedProvider, reason: FeedBackfillRefusal, sv: string): Error {
  const en = `${provider} backfill: ${BACKFILL_REFUSAL_EN[reason]}`
  switch (reason) {
    case 'invalid':
    case 'future':
    case 'too_old':
      return badArgument('from', en, sv)
    case 'several_connections':
      return badArgument('connection_id', en, sv)
    case 'not_connected':
      return codedRefusal('NOT_FOUND', en)
    default:
      return codedRefusal('TRANSIENT_ERROR', en)
  }
}

export function createFeedTools(deps: { readOnly: McpToolAnnotations; writeOpenWorld: McpToolAnnotations }): McpTool[] {
  return [
    {
      name: 'gnubok_list_feed_connections',
      keywords: ['stripe', 'shopify', 'woocommerce', 'zettle', 'stripe-koppling', 'webbshop', 'kassaregister', 'senast synkad'],
      title: 'List Feed Connections',
      description:
        "The company's Stripe, Shopify, WooCommerce and Zettle connections: status, connected_at (where the feed starts) and last_synced_at (its cursor). Use before gnubok_backfill_feed when a row from the connection start is missing.",
      catalogVisibility: 'search',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', enum: [...FEED_PROVIDERS], description: 'Only this provider.' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          connections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                connection_id: { type: 'string' },
                provider: { type: 'string', enum: [...FEED_PROVIDERS] },
                status: { type: 'string' },
                connected_at: { type: ['string', 'null'] },
                last_synced_at: { type: ['string', 'null'] },
                nightly_sync: { type: 'boolean' },
                error_message: { type: ['string', 'null'] },
              },
            },
          },
          instructions: { type: 'string' },
        },
        required: ['connections', 'instructions'],
      },
      annotations: deps.readOnly,
      async execute(args, companyId, _userId, supabase: SupabaseClient) {
        const only = providerOf(args.provider, false)
        const providers = only ? [only] : [...FEED_PROVIDERS]
        const connections: Array<Record<string, unknown>> = []
        for (const provider of providers) {
          const spec = FEEDS[provider]
          const { data, error } = await supabase
            .from(spec.table)
            .select(`id, status, connected_at, error_message, transaction_sync_enabled, ${spec.cursorColumn}`)
            .eq('company_id', companyId)
            .neq('status', 'revoked')
            .order('created_at', { ascending: false })
            .limit(10)
          if (error) throw dbError(error, `${provider} connections`)
          for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
            connections.push({
              connection_id: row.id,
              provider,
              status: row.status,
              connected_at: row.connected_at ?? null,
              last_synced_at: row[spec.cursorColumn] ?? null,
              nightly_sync: row.transaction_sync_enabled === true,
              error_message: row.error_message ?? null,
            })
          }
        }
        // Where each connected feed's rows are read: a status that says
        // "synced" without it sends the agent looking in the wrong list.
        const connected = providers.filter((provider) => connections.some((c) => c.provider === provider))
        return {
          connections,
          instructions:
            connections.length === 0
              ? 'No Stripe, Shopify, WooCommerce or Zettle connection. The user connects one in Accounted under Import.'
              : 'A feed imports from connected_at on. To fetch rows from before that, or a day the feed missed, call gnubok_backfill_feed({ provider, from }); last_synced_at is how far it has synced. ' +
                connected.map((provider) => `${provider} rows land ${LANDS_IN[provider]}.`).join(' '),
        }
      },
    },

    {
      name: 'gnubok_backfill_feed',
      keywords: ['hämta äldre transaktioner', 'hämta äldre ordrar', 'hämta äldre köp', 'backfill', 'synka stripe', 'stripe', 'shopify', 'woocommerce', 'zettle'],
      title: 'Backfill Feed',
      description:
        'Refetch a Stripe, Shopify, WooCommerce or Zettle feed from a day; rows land unbooked (shop orders: gnubok_list_webshop_orders). Skips days the books already hold unless include_booked.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'from'],
        properties: {
          provider: { type: 'string', enum: [...FEED_PROVIDERS] },
          from: { type: 'string', format: 'date' },
          include_booked: { type: 'boolean' },
          connection_id: { type: 'string' },
        },
      },
      outputSchema: { type: 'object' },
      annotations: deps.writeOpenWorld,
      async execute(args, companyId, userId, supabase: SupabaseClient) {
        const provider = providerOf(args.provider, true)!
        const spec = FEEDS[provider]
        if (!(await hasCapability(supabase, companyId, spec.capability))) throw capabilityBlockedRefusal(spec.capability)
        const rl = await checkRateLimit({ prefix: `${spec.extensionId}:backfill`, identifier: userId, ...RATE_LIMIT_BACKFILL })
        if (!rl.ok) {
          throw codedRefusal('RATE_LIMITED', `${provider} backfill: at most ${RATE_LIMIT_BACKFILL.maxRequests} a minute. Retry in a minute.`)
        }

        const result = await runFeedBackfill(
          spec,
          { supabase, serviceClient: supabase, companyId, log },
          { from: args.from, connectionId: args.connection_id, includeBooked: args.include_booked },
        )
        if (!result.ok) throw backfillRefusal(provider, result.reason, result.error)

        const lands = LANDS_IN[provider]
        // A run stops at its time budget or its bound on rows read: what it
        // read is in, the rest of the period is not yet.
        const paused = (result.summary as { deadlineReached?: boolean } | null)?.deadlineReached === true
        const verb = paused ? 'Started fetching' : 'Fetched'
        const instructions =
          result.from === null
            ? `Nothing older was fetched: the books already hold everything through ${result.bookedThrough} (an imported ledger, or a manual voucher on 1686). Pass include_booked=true only if those vouchers do not hold this money; otherwise booking these rows would book it twice.`
            : [
                result.bookedThrough
                  ? `${verb} from the day after ${result.bookedThrough}: the books already hold the days up to it, so they were skipped. Rows land ${lands}. Pass include_booked=true only if those vouchers do not hold this money.`
                  : `${verb} from ${String(args.from)}. Rows land ${lands}; rows already imported were skipped.`,
                ...(paused
                  ? [
                      'The run stopped before today (summary.deadlineReached), so only the start of the period is in. To fetch the rest, call gnubok_backfill_feed again with from set to the day of last_synced_at (gnubok_list_feed_connections); the nightly sync also goes on from there when nightly_sync is on.',
                    ]
                  : []),
              ].join(' ')
        return {
          connection_id: result.connectionId,
          provider,
          from: result.from,
          booked_through: result.bookedThrough,
          summary: result.summary,
          instructions,
        }
      },
    },
  ]
}
