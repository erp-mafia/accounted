/**
 * Reading a bank with BankID through Open Payments (lib/bank-feed): the
 * operations behind the dashboard routes under /api/bank/open-payments.
 *
 * None of them has a machine door yet: a BankID consent is the account
 * holder's own act (start, poll, restart, select are ui-only in
 * session-route-parity), the sync is already served for every aggregator by
 * POST /bank-connections/:id/sync and gnubok_sync_bank, and removing a
 * connection is a P3 gap exactly as for Enable Banking. They are defined here
 * so the request contract, the rules and the outcome live in one place and
 * a door can be added by binding, not by copying.
 */
import { z } from 'zod'
import {
  disconnectBankFeedConnection,
  getBankFeedBankDetails,
  getBankFeedOverview,
  listBankFeedBanks,
  pollBankFeedConsent,
  restartBankFeedConsent,
  selectBankFeedAccounts,
  startBankFeedConsent,
  syncBankFeedConnection,
} from '@/lib/bank-feed/service'
import type { BankFeedSignerInput } from '@/lib/bank-feed/party'
import { BANK_CONNECT_RETURN_SURFACES } from '@/lib/bank-feed/return-url'
import { getBankSwitchProgress } from '@/lib/bank-feed/switch-campaign'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import { createServiceClient } from '@/lib/supabase/server'
import { defineOperation } from './types'

const CONNECTION_ID = z.string().uuid().describe('The bank connection (bank_connections.id).')
const BIC = z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/).describe('The bank, as its BIC (8 or 11 characters).')
const METHOD = z.enum(['same_device', 'qr', 'redirect']).describe('BankID on this device, an animated QR scanned with the app, or signing on the bank\'s own page (redirect, which needs return_to).')
const RETURN_TO = z.enum(BANK_CONNECT_RETURN_SURFACES).nullish().describe('Redirect: the Accounted page the browser comes back to after signing at the bank.')
const RETURN_ORIGIN = z.url().max(200).nullish().describe('Redirect: the app origin the return lands on (a session route resolves it from the request).')
const PERSONAL_NUMBER = z.string().max(20).nullish().describe('The signer\'s personnummer when they have none on file. Sent to the bank, never stored.')

const Challenge = z.object({
  approach: z.enum(['decoupled', 'redirect']),
  autostartToken: z.string().nullable(),
  qrData: z.string().nullable(),
  qrImage: z.string().nullable(),
  redirectUrl: z.string().nullable(),
})

const Attempt = z.object({
  authorisation_id: z.string().nullable(),
  method: METHOD,
  state: z.enum(['pending', 'failed', 'partially_authorised']),
  challenge: Challenge.nullable(),
  sca_status: z.string().nullable(),
  step: z.enum(['identify', 'consent']).nullable(),
  failure_code: z.string().nullable(),
  failure_text: z.string().nullable(),
})

const Signer = z.object({
  personalNumber: z.string().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
})

const ConnectionOut = z.object({
  connection_id: z.string().uuid(),
  bank_name: z.string().nullable(),
  bic: z.string().nullable(),
  provider: z.string(),
  status: z.string(),
  consent_expires: z.string().nullable(),
  last_synced_at: z.string().nullable(),
  initial_sync_completed_at: z.string().nullable(),
  error_message: z.string().nullable(),
  accounts: z.array(
    z.object({
      uid: z.string(),
      name: z.string().nullable(),
      iban: z.string().nullable(),
      currency: z.string(),
      enabled: z.boolean(),
      ledger_account: z.string().nullable(),
      usage: z.string().nullable(),
    }),
  ),
})

const ConsentAccount = z.object({
  uid: z.string(),
  name: z.string().nullable(),
  iban: z.string().nullable(),
  bban: z.string().nullable(),
  currency: z.string(),
  usage: z.string().nullable(),
  preselected: z.boolean(),
  enabled: z.boolean(),
  suggested_ledger_account: z.string().nullable(),
  matches_existing: z.string().nullable().describe('The ledger of the cash account this company already books the same IBAN on, or null.'),
})

const SyncOut = z.object({
  connection_id: z.string().uuid(),
  bank: z.string().nullable(),
  imported: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  from_date: z.string(),
  to_date: z.string(),
  last_synced_at: z.string(),
})

const signerOf = (input: { personal_number?: string | null; ip_address?: string | null; user_agent?: string | null }): BankFeedSignerInput => ({
  personalNumber: input.personal_number?.trim() || null,
  ipAddress: input.ip_address ?? null,
  userAgent: input.user_agent ?? null,
})

const EXAMPLE_CONNECTION = '4f6c1a2b-9c0d-4e8f-8a1b-2c3d4e5f6a7b'

export const bankFeedBanks = defineOperation({
  id: 'bank-feed.banks',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The banks a company can connect with BankID through Open Payments.',
    description: 'Lists the banks the account information provider reaches (BIC, name, logo, whether BankID can be signed in our screen). Answers OPEN_BANKING_NOT_AVAILABLE when reading through Open Payments is not switched on for the company.',
    useWhen: 'Before starting a bank connection with BankID.',
    doNotUseFor: 'Enable Banking connections (the bank list of the enable-banking extension).',
    pitfalls: ['A sparbank is reached through SWEDSESS with its affiliate id; ask bank for the list.'],
    example: { response: { data: { banks: [{ bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: false }] } } },
  },
  input: z.object({}),
  output: z.object({ banks: z.array(z.object({ bic: z.string(), name: z.string(), logo_url: z.string().nullable(), decoupled: z.boolean().nullable(), redirect: z.boolean().nullable() })) }),
  errorCodes: ['OPEN_BANKING_NOT_AVAILABLE', 'BANK_PROVIDER_UNAVAILABLE', 'BANK_PROVIDER_REFUSED'],
  run: async (ctx) => listBankFeedBanks(ctx),
})

export const bankFeedBank = defineOperation({
  id: 'bank-feed.bank',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'One bank\'s details: how a person signs there, and the sparbanker behind a shared BIC.',
    description: 'Whether the bank signs BankID in our screen (decoupled) or on its own page (redirect), how many days of history it serves, and the savings banks reached through it (Swedbank: the sparbanker and Ölands Bank). Answered from a 24 h cache.',
    useWhen: 'After a bank is picked and before BankID starts: to show the sparbank picker and choose the signing method.',
    doNotUseFor: 'Listing banks (bank-feed.banks).',
    pitfalls: ['A sparbank is connected through SWEDSESS with its affiliate id from this answer.'],
    example: { response: { data: { bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: true, affiliates: [{ id: '08999', name: 'Sparbanken Nord' }], transaction_history_max_days: 88, extended_transaction_history_max_days: 760 } } },
  },
  input: z.object({ bic: BIC }),
  output: z.object({
    bic: z.string(),
    name: z.string(),
    decoupled: z.boolean().nullable(),
    redirect: z.boolean().nullable(),
    affiliates: z.array(z.object({ id: z.string(), name: z.string() })),
    transaction_history_max_days: z.number().int().nullable(),
    extended_transaction_history_max_days: z.number().int().nullable(),
  }),
  errorCodes: ['OPEN_BANKING_NOT_AVAILABLE', 'BANK_CONSENT_UNKNOWN_BANK', 'BANK_PROVIDER_UNAVAILABLE', 'BANK_PROVIDER_REFUSED'],
  run: async (ctx, input) => getBankFeedBankDetails(ctx, input.bic),
})

export const bankFeedOverview = defineOperation({
  id: 'bank-feed.overview',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The company\'s Open Payments bank connections and whether it may make one.',
    description: 'Answers available (and why not), the connections made through Open Payments with their accounts, and whether the calling person has a personnummer on file for BankID.',
    useWhen: 'Rendering the bank connections a company reads through Open Payments.',
    doNotUseFor: 'Enable Banking connections.',
    pitfalls: [],
    example: { response: { data: { available: true, reason: null, connections: [], signer_known: true } } },
  },
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    reason: z.enum(['no_connector', 'not_in_pilot', 'subscription']).nullable(),
    connections: z.array(ConnectionOut),
    signer_known: z.boolean(),
  }),
  run: async (ctx) => getBankFeedOverview(ctx),
})

const SwitchConnection = z.object({ connection_id: z.string().uuid(), bank_name: z.string() })

const SwitchState = z.object({
  state: z.enum(['done', 'pending', 'uncovered']),
  pending: z.array(SwitchConnection),
  uncovered: z.array(SwitchConnection),
  open_payments: z.number().int().nonnegative(),
  deadline: z.string(),
  days_left: z.number().int(),
  passed: z.boolean(),
  urgent: z.boolean(),
})

const SwitchTotals = z.object({
  companies: z.object({ pending: z.number(), uncovered: z.number(), done: z.number() }),
  connections: z.object({ pending: z.number(), uncovered: z.number(), switched: z.number() }),
  banks: z.array(z.object({ bank: z.string(), pending: z.number(), uncovered: z.number(), switched: z.number() })),
})

export const bankFeedSwitchProgress = defineOperation({
  id: 'bank-feed.switch-progress',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Where the company stands in the switch from Enable Banking to Open Payments.',
    description: 'The campaign (on, deadline, days left), the company\'s state (the Enable Banking connections still to switch, the ones at banks Open Payments does not reach) and, for an owner or admin, the totals across companies (counts per bank, no company identities). Null company when the campaign does not apply to it.',
    useWhen: 'Rendering the switch deadline, the deep link to the switch, or the founders\' counter.',
    doNotUseFor: 'Starting the switch: that is bank-feed.start with replace_connection_id, and a person\'s BankID.',
    pitfalls: ['totals come from a service-role RPC and are null for members below admin.'],
    example: { response: { data: { campaign: { on: true, deadline: '2026-11-09', days_left: 20, passed: false }, company: null, totals: null } } },
  },
  input: z.object({}),
  output: z.object({
    campaign: z.object({ on: z.boolean(), deadline: z.string().nullable(), days_left: z.number().int().nullable(), passed: z.boolean() }),
    company: SwitchState.nullable(),
    totals: SwitchTotals.nullable(),
  }),
  run: async (ctx) => {
    // Cross-company totals are the owners' and admins' to see: the rule lives
    // here, beside the read, and the session route applies the same one.
    const admin = await isCompanyAdmin(ctx.supabase, ctx.companyId)
    return { ok: true, data: await getBankSwitchProgress(ctx, { totalsClient: admin ? createServiceClient() : null }) }
  },
})

export const bankFeedStart = defineOperation({
  id: 'bank-feed.start',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Create a bank consent at the bank and start BankID for it.',
    description: 'Creates the consent (today plus 180 days, the bank may clamp it), stores the attempt as a pending bank connection and starts BankID. Answers the challenge the person signs with; poll follows. A bank that only signs on its own page is started with redirect when return_to is given: the challenge then carries the bank\'s page in redirectUrl and the browser comes back to the return_to page with the connection named.',
    useWhen: 'A person connects a bank with BankID through Open Payments.',
    doNotUseFor: 'Agents: the account holder gives the consent in person.',
    pitfalls: ['replace_connection_id names the Enable Banking connection this one replaces at account selection (a switch).', 'method redirect needs return_to and return_origin; without them a redirect-only bank is refused by the bank (SCA_REDIRECT_UNSUPPORTED).'],
    example: { response: { data: { connection_id: EXAMPLE_CONNECTION, attempt: { authorisation_id: 'a-1', method: 'qr', state: 'pending', challenge: null, sca_status: 'started', step: 'identify', failure_code: null, failure_text: null } } } },
  },
  input: z.object({
    bic: BIC,
    affiliated_aspsp_id: z.string().min(1).max(64).nullish(),
    account_context: z.enum(['corporate', 'private']).nullish(),
    method: METHOD,
    personal_number: PERSONAL_NUMBER,
    replace_connection_id: z.string().uuid().nullish(),
    return_to: RETURN_TO,
    return_origin: RETURN_ORIGIN,
    ip_address: z.string().max(64).nullish(),
    user_agent: z.string().max(300).nullish(),
  }),
  output: z.object({ connection_id: z.string().uuid(), attempt: Attempt }),
  errorCodes: ['OPEN_BANKING_NOT_AVAILABLE', 'BANK_CONSENT_UNKNOWN_BANK', 'BANK_CONSENT_PERSONAL_NUMBER_REQUIRED', 'BANK_CONSENT_REDIRECT_UNSUPPORTED', 'VALIDATION_ERROR', 'BANK_PROVIDER_UNAVAILABLE', 'BANK_PROVIDER_REFUSED'],
  run: async (ctx, input) =>
    startBankFeedConsent(ctx, {
      bic: input.bic,
      affiliatedAspspId: input.affiliated_aspsp_id ?? null,
      accountContext: input.account_context ?? null,
      method: input.method,
      replaceConnectionId: input.replace_connection_id ?? null,
      returnTo: input.return_to ?? null,
      returnOrigin: input.return_origin ?? null,
      signer: signerOf(input),
    }),
})

export const bankFeedPoll = defineOperation({
  id: 'bank-feed.poll',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Where a bank consent\'s BankID stands; the accounts once it is valid.',
    description: 'While pending it answers fresh BankID data (the animated QR changes every second). Once the bank reports the consent valid, the accounts it reaches are read and the connection awaits account selection; Svea\'s second consent goes straight to active.',
    useWhen: 'Every second while a person signs a bank consent.',
    doNotUseFor: 'Checking an active connection; read it instead.',
    pitfalls: ['partially_authorised: another signatory must sign; keep the attempt, poll later.'],
    example: { response: { data: { connection_id: EXAMPLE_CONNECTION, state: 'pending', method: 'qr', challenge: null, sca_status: 'started', step: 'identify', failure_code: null, failure_text: null, status: 'pending' } } },
  },
  input: z.object({ connection_id: CONNECTION_ID, ip_address: z.string().max(64).nullish(), user_agent: z.string().max(300).nullish() }),
  output: z.object({
    connection_id: z.string().uuid(),
    state: z.enum(['pending', 'valid', 'partially_authorised', 'failed']),
    method: METHOD,
    challenge: Challenge.nullable(),
    sca_status: z.string().nullable(),
    step: z.enum(['identify', 'consent']).nullable(),
    failure_code: z.string().nullable(),
    failure_text: z.string().nullable(),
    accounts: z.array(ConsentAccount).optional(),
    consent_expires: z.string().nullable().optional(),
    needs_second_consent: z.boolean().optional(),
    status: z.string(),
  }),
  errorCodes: ['OPEN_BANKING_NOT_AVAILABLE', 'NOT_FOUND', 'BANK_CONSENT_CHANGED', 'BANK_CONSENT_OVER', 'BANK_PROVIDER_UNAVAILABLE', 'BANK_PROVIDER_REFUSED'],
  run: async (ctx, input) => pollBankFeedConsent(ctx, { connectionId: input.connection_id, signer: signerOf(input) }),
})

export const bankFeedRestart = defineOperation({
  id: 'bank-feed.restart',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Start BankID again for a pending bank consent.',
    description: 'A new authorisation for the same consent (a new consent when the bank says the first is over). Same answer shape as start. A redirect attempt keeps its return_to from the row; return_origin names the app origin to come back to.',
    useWhen: 'A BankID attempt failed or timed out and the person tries again.',
    doNotUseFor: 'A connection that is already active.',
    pitfalls: [],
    example: { response: { data: { connection_id: EXAMPLE_CONNECTION, attempt: { authorisation_id: 'a-2', method: 'qr', state: 'pending', challenge: null, sca_status: null, step: null, failure_code: null, failure_text: null } } } },
  },
  input: z.object({
    connection_id: CONNECTION_ID,
    method: METHOD.nullish(),
    personal_number: PERSONAL_NUMBER,
    return_to: RETURN_TO,
    return_origin: RETURN_ORIGIN,
    ip_address: z.string().max(64).nullish(),
    user_agent: z.string().max(300).nullish(),
  }),
  output: z.object({ connection_id: z.string().uuid(), attempt: Attempt }),
  errorCodes: ['OPEN_BANKING_NOT_AVAILABLE', 'NOT_FOUND', 'BANK_CONSENT_CHANGED', 'VALIDATION_ERROR', 'BANK_PROVIDER_UNAVAILABLE', 'BANK_PROVIDER_REFUSED'],
  run: async (ctx, input) =>
    restartBankFeedConsent(ctx, {
      connectionId: input.connection_id,
      method: input.method ?? null,
      returnTo: input.return_to ?? null,
      returnOrigin: input.return_origin ?? null,
      signer: signerOf(input),
    }),
})

export const bankFeedSelect = defineOperation({
  id: 'bank-feed.select',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Choose which accounts of a bank consent to sync, onto which ledgers, and run the first import.',
    description: 'Saves the selection through the same configuration writer every bank feed uses, hands over the Enable Banking connection a switch replaces, and imports the extended history the bank serves right after the consent. Svea gets its second consent to sign instead.',
    useWhen: 'After poll answered valid with accounts.',
    doNotUseFor: 'Enable Banking connections (PATCH /api/extensions/ext/enable-banking/accounts).',
    pitfalls: ['ledger_account is a BAS 19xx account; null lets the allocator choose.'],
    example: { response: { data: { connection: {}, sync: { imported: 120, duplicates: 0, from: '2026-01-01', to: '2026-10-12' }, sync_pending: false } } },
  },
  input: z.object({
    connection_id: CONNECTION_ID,
    accounts: z.array(z.object({ uid: z.string().min(1), enabled: z.boolean(), ledger_account: z.string().regex(/^19\d{2}$/).nullish() })).min(1).max(100),
    method: METHOD.nullish(),
    personal_number: PERSONAL_NUMBER,
    ip_address: z.string().max(64).nullish(),
    user_agent: z.string().max(300).nullish(),
  }),
  output: z.object({
    connection: ConnectionOut,
    sync: z.object({ imported: z.number(), duplicates: z.number(), from: z.string(), to: z.string() }).nullable(),
    sync_pending: z.boolean(),
    attempt: Attempt.optional(),
  }),
  errorCodes: ['OPEN_BANKING_NOT_AVAILABLE', 'NOT_FOUND', 'BANK_CONSENT_NOT_READY', 'BANK_CONFIGURATION_CHANGED', 'BANK_SELECTION_LEDGER_CONFLICT', 'VALIDATION_ERROR'],
  run: async (ctx, input) =>
    selectBankFeedAccounts(ctx, {
      connectionId: input.connection_id,
      accounts: input.accounts.map((a) => ({ uid: a.uid, enabled: a.enabled, ledgerAccount: a.ledger_account ?? null })),
      method: input.method ?? null,
      signer: signerOf(input),
    }),
})

export const bankFeedSync = defineOperation({
  id: 'bank-feed.sync',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one Open Payments bank connection now.',
    description: 'One read with the person present (the bank does not count it against the consent\'s unattended budget). The first read after selection takes the extended history window; later ones the gap since the last sync. A connection synced within 15 minutes answers BANK_SYNC_COOLDOWN.',
    useWhen: 'A person presses Synka nu, or the first import after a Svea consent.',
    doNotUseFor: 'Polling: the cron reads every connection twice a day.',
    pitfalls: ['BANK_RATE_LIMITED: the consent\'s daily budget is spent; wait for next_allowed_at.'],
    example: { response: { data: { connection_id: EXAMPLE_CONNECTION, bank: 'Swedbank', imported: 3, duplicates: 12, from_date: '2026-10-05', to_date: '2026-10-12', last_synced_at: '2026-10-12T09:14:03Z' } } },
  },
  input: z.object({ connection_id: CONNECTION_ID, ip_address: z.string().max(64).nullish(), user_agent: z.string().max(300).nullish() }),
  output: SyncOut,
  errorCodes: ['OPEN_BANKING_NOT_AVAILABLE', 'NOT_FOUND', 'BANK_SYNC_NOT_ACTIVE', 'BANK_SYNC_NO_ACCOUNTS', 'BANK_SYNC_COOLDOWN', 'BANK_RATE_LIMITED', 'BANK_SESSION_EXPIRED', 'BANK_SYNC_FAILED'],
  run: async (ctx, input) => syncBankFeedConnection(ctx, { connectionId: input.connection_id, signer: signerOf(input) }),
})

export const bankFeedDisconnect = defineOperation({
  id: 'bank-feed.disconnect',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Remove an Open Payments bank connection and end its consent at the bank.',
    description: 'Releases the connection\'s cash-account claims (history stays), revokes the row and ends the consent at the bank under the openpayments revocation claim.',
    useWhen: 'A person removes a bank connection.',
    doNotUseFor: 'Renewing a consent: start a new connection instead.',
    pitfalls: [],
    example: { response: { data: { connection_id: EXAMPLE_CONNECTION } } },
  },
  input: z.object({ connection_id: CONNECTION_ID }),
  output: z.object({ connection_id: z.string().uuid() }),
  errorCodes: ['NOT_FOUND', 'BANK_CONFIGURATION_CHANGED'],
  run: async (ctx, input) => disconnectBankFeedConnection(ctx, input.connection_id),
})

export const BANK_FEED_OPERATIONS = [
  bankFeedBanks,
  bankFeedBank,
  bankFeedOverview,
  bankFeedSwitchProgress,
  bankFeedStart,
  bankFeedPoll,
  bankFeedRestart,
  bankFeedSelect,
  bankFeedSync,
  bankFeedDisconnect,
] as const
