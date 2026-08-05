/**
 * WhatsApp intake extension (PR3 of the WhatsApp track).
 *
 * Receives receipts sent to the shared Accounted WhatsApp number and lands
 * them in the document inbox (Underlag) through the same uploadAndExtract
 * funnel as email intake. Phone numbers bind to Accounted users via one-time
 * codes; unknown senders get one canned, throttled greeting and are never
 * processed further (no LLM, no media download, no content persistence).
 *
 * Webhook lifecycle: persist-first. POST verifies the Meta signature over the
 * RAW body, Zod-parses, persists inbound rows (wamid partial-unique index =
 * the dedupe key against Meta's up-to-7-day redelivery), 200s fast, and
 * defers media processing via the after() idiom (lib/process-inbound.ts).
 * Rejected/rate-limited content always acks 200: a retryable status would
 * only buy a redelivery of something we already decided to drop.
 *
 * Deferred to PR4: burst debounce + combined ack, company choice buttons,
 * clarifying questions (representation/quality/context), interpret-answer LLM
 * call, sweep + retention crons.
 */

import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import type { WhatsAppPhoneLink } from '@/types'
import { verifyMetaSignature, verifyChallengeToken } from './lib/webhook-verify'
import { parseWebhookEnvelope, type ParsedInboundMessage } from './lib/webhook-parse'
import { hashPhone } from './lib/phone-crypto'
import {
  consumeLinkCode,
  createPhoneLink,
  looksLikeLinkCode,
  lookupActiveLink,
  mintLinkCode,
} from './lib/linking'
import { sendText, getDisplayPhoneNumber } from './lib/graph-api'
import { botCopy, TEMPLATE } from './lib/messages'
import { kickInboundProcessing } from './lib/process-inbound'

const log = createLogger('whatsapp-inbox')

// ── Unknown-sender budgets ───────────────────────────────────
// Pre-binding limiter (check_and_increment_whatsapp_sender_quota): caps how
// much handling an unbound phone can consume at all. Beyond it: silence.
const UNKNOWN_SENDER_MINUTE_MAX = 15
const UNKNOWN_SENDER_DAY_MAX = 200
// The M1 greeting itself is throttled much harder: 1/hour, 3/day, then silence.
const GREETING_HOUR_MS = 60 * 60 * 1000
const GREETING_DAY_MS = 24 * 60 * 60 * 1000
const GREETING_DAY_MAX = 3

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

// Exact whole-message keyword sets (normalized lowercase + trim). Text
// messages only, never captions, per the conversation spec.
const STOP_KEYWORDS = new Set(['stopp', 'stop', 'avsluta'])
const HELP_KEYWORDS = new Set(['hjälp', 'hjalp', 'help', 'support', 'människa', 'manniska'])
const START_KEYWORD = 'start'

const DefaultCompanySchema = z.object({
  companyId: z.string().uuid().nullable(),
})

function buildServiceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// ── Unknown senders ──────────────────────────────────────────

async function greetingThrottled(
  supabase: SupabaseClient,
  phoneHash: string,
): Promise<boolean> {
  const since = new Date(Date.now() - GREETING_DAY_MS).toISOString()
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('created_at')
    .eq('direction', 'outbound')
    .eq('sender_phone_hash', phoneHash)
    .eq('raw_payload->>template', TEMPLATE.m1Unlinked)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(GREETING_DAY_MAX)
  const rows = (data ?? []) as Array<{ created_at: string }>
  if (rows.length >= GREETING_DAY_MAX) return true
  const hourAgo = Date.now() - GREETING_HOUR_MS
  return rows.some((r) => new Date(r.created_at).getTime() > hourAgo)
}

/**
 * Unknown/unlinked sender. Hard rules: never download media, never persist
 * message content or raw payloads, never touch any LLM. The only DB writes
 * are the quota counters, a consumed link code, and outbound reply rows.
 */
async function handleUnknownSender(
  supabase: SupabaseClient,
  msg: ParsedInboundMessage,
  phoneHash: string,
): Promise<void> {
  const { data: quota, error: quotaError } = await supabase.rpc(
    'check_and_increment_whatsapp_sender_quota',
    {
      p_phone_hash: phoneHash,
      p_minute_max: UNKNOWN_SENDER_MINUTE_MAX,
      p_day_max: UNKNOWN_SENDER_DAY_MAX,
    },
  )
  if (quotaError) {
    // Fail closed for unknown senders: without the limiter we send nothing.
    log.warn('sender quota RPC failed; staying silent', { error: quotaError.message })
    return
  }
  if ((quota as { ok?: boolean } | null)?.ok === false) return

  const copy = botCopy('sv')

  if (msg.type === 'text' && looksLikeLinkCode(msg.text)) {
    const consumed = await consumeLinkCode(supabase, msg.text ?? '')
    if (!consumed) {
      await sendText(supabase, {
        to: msg.from,
        body: copy.m2BadCode(),
        template: TEMPLATE.m2BadCode,
        senderPhoneHash: phoneHash,
      })
      return
    }

    const { link, conversationId } = await createPhoneLink(supabase, {
      userId: consumed.userId,
      phone: msg.from,
      profileName: msg.profileName,
    })

    // Persist a content-free row for the code message so a Meta redelivery
    // of the same wamid dedupes instead of falling into the keyword path.
    await supabase.from('whatsapp_messages').insert({
      direction: 'inbound',
      wamid: msg.wamid,
      sender_phone_hash: phoneHash,
      phone_link_id: link.id,
      conversation_id: conversationId,
      message_type: 'text',
      processing_status: 'done',
    })

    const { data: memberships } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', consumed.userId)
    const companyIds = [...new Set((memberships ?? []).map((m) => m.company_id as string))]

    let companyName: string | null = null
    if (companyIds.length === 1) {
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', companyIds[0])
        .maybeSingle()
      companyName = (company as { name?: string } | null)?.name ?? null
    }

    await sendText(supabase, {
      to: msg.from,
      body: copy.m3Linked({ companyName, companyCount: Math.max(companyIds.length, 1) }),
      template: TEMPLATE.m3Linked,
      senderPhoneHash: phoneHash,
      phoneLinkId: link.id,
      conversationId,
    })
    return
  }

  // Anything else from an unknown number: the AI-disclosure greeting, hard
  // throttled per phone hash (EU AI Act Art 50 disclosure lives in M1).
  if (await greetingThrottled(supabase, phoneHash)) return
  await sendText(supabase, {
    to: msg.from,
    body: copy.m1Unlinked(),
    template: TEMPLATE.m1Unlinked,
    senderPhoneHash: phoneHash,
  })
}

// ── Linked senders ───────────────────────────────────────────

type Disposition =
  | { kind: 'media' }
  | { kind: 'stop' }
  | { kind: 'start' }
  | { kind: 'help' }
  | { kind: 'voice' }
  | { kind: 'unsupported' }
  | { kind: 'fallback' }
  | { kind: 'silence' }

function classify(msg: ParsedInboundMessage, muted: boolean): Disposition {
  if (msg.type === 'text') {
    const normalized = (msg.text ?? '').trim().toLowerCase()
    if (muted) {
      // While muted only `start` is recognized; everything else is silence.
      return normalized === START_KEYWORD ? { kind: 'start' } : { kind: 'silence' }
    }
    if (STOP_KEYWORDS.has(normalized)) return { kind: 'stop' }
    if (HELP_KEYWORDS.has(normalized)) return { kind: 'help' }
    if (normalized === START_KEYWORD) return { kind: 'start' }
    return { kind: 'fallback' }
  }
  if (muted) return { kind: 'silence' }
  if (msg.type === 'image' || msg.type === 'document') {
    return msg.media ? { kind: 'media' } : { kind: 'unsupported' }
  }
  if (msg.type === 'audio') return { kind: 'voice' }
  if (msg.type === 'video' || msg.type === 'sticker' || msg.type === 'location' || msg.type === 'contacts') {
    return { kind: 'unsupported' }
  }
  // Truly unknown types (reactions, ephemeral, future additions): stay
  // silent rather than lecture someone for sending a thumbs-up.
  return { kind: 'silence' }
}

async function resolveConversationId(
  supabase: SupabaseClient,
  phoneLinkId: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('whatsapp_conversations')
    .select('id')
    .eq('phone_link_id', phoneLinkId)
    .maybeSingle()
  if (existing) return (existing as { id: string }).id
  const { data: created } = await supabase
    .from('whatsapp_conversations')
    .insert({ phone_link_id: phoneLinkId })
    .select('id')
    .maybeSingle()
  return (created as { id: string } | null)?.id ?? null
}

async function handleLinkedSender(
  supabase: SupabaseClient,
  msg: ParsedInboundMessage,
  phoneHash: string,
  link: WhatsAppPhoneLink,
  mediaMessageIds: string[],
): Promise<void> {
  const disposition = classify(msg, link.muted_at != null)
  const conversationId = await resolveConversationId(supabase, link.id)
  const correlationId = crypto.randomUUID()
  const copy = botCopy('sv')

  // Persist-first, dedupe on the inbound-wamid partial unique index. A
  // redelivered wamid violates it (23505): already handled, stop entirely.
  const initialStatus =
    disposition.kind === 'media' ? 'received' : disposition.kind === 'silence' ? 'skipped' : 'done'
  const { data: inserted, error: insertError } = await supabase
    .from('whatsapp_messages')
    .insert({
      direction: 'inbound',
      wamid: msg.wamid,
      sender_phone_hash: phoneHash,
      phone_link_id: link.id,
      conversation_id: conversationId,
      message_type: msg.type,
      body_text: msg.type === 'text' ? msg.text : (msg.caption ?? null),
      media_id: msg.media?.id ?? null,
      media_mime: msg.media?.mime ?? null,
      media_sha256: msg.media?.sha256 ?? null,
      media_filename: msg.media?.filename ?? null,
      raw_payload: msg.raw as Record<string, unknown>,
      processing_status: initialStatus,
      correlation_id: correlationId,
    })
    .select('id')
    .maybeSingle()

  if (insertError) {
    if (insertError.code === '23505') return // wamid dedupe: Meta redelivery
    log.error('Failed to persist inbound WhatsApp message', insertError)
    return
  }
  const messageId = (inserted as { id: string } | null)?.id ?? null

  const now = new Date()
  await supabase
    .from('whatsapp_phone_links')
    .update({ last_message_at: now.toISOString() })
    .eq('id', link.id)
  if (conversationId) {
    await supabase
      .from('whatsapp_conversations')
      .update({
        last_inbound_at: now.toISOString(),
        service_window_expires_at: new Date(now.getTime() + SERVICE_WINDOW_MS).toISOString(),
      })
      .eq('id', conversationId)
  }

  const replyBase = {
    senderPhoneHash: phoneHash,
    phoneLinkId: link.id,
    conversationId,
    correlationId,
  }

  switch (disposition.kind) {
    case 'media':
      if (messageId) mediaMessageIds.push(messageId)
      return
    case 'stop':
      await supabase
        .from('whatsapp_phone_links')
        .update({ muted_at: now.toISOString() })
        .eq('id', link.id)
      await sendText(supabase, { to: msg.from, body: copy.m11Stop(), template: TEMPLATE.m11Stop, ...replyBase })
      return
    case 'start':
      if (link.muted_at != null) {
        await supabase
          .from('whatsapp_phone_links')
          .update({ muted_at: null })
          .eq('id', link.id)
      }
      await sendText(supabase, { to: msg.from, body: copy.m12Start(), template: TEMPLATE.m12Start, ...replyBase })
      return
    case 'help':
      await sendText(supabase, { to: msg.from, body: copy.m13Help(), template: TEMPLATE.m13Help, ...replyBase })
      return
    case 'voice':
      await sendText(supabase, { to: msg.from, body: copy.m14Voice(), template: TEMPLATE.m14Voice, ...replyBase })
      return
    case 'unsupported':
      await sendText(supabase, { to: msg.from, body: copy.m15Unsupported(), template: TEMPLATE.m15Unsupported, ...replyBase })
      return
    case 'fallback':
      await sendText(supabase, { to: msg.from, body: copy.m16Fallback(), template: TEMPLATE.m16Fallback, ...replyBase })
      return
    case 'silence':
      return
  }
}

// ── Extension definition ─────────────────────────────────────

export const whatsappInboxExtension: Extension = {
  id: 'whatsapp-inbox',
  name: 'WhatsApp-inkorg',
  version: '1.0.0',
  sector: 'general',

  settingsPanel: {
    label: 'WhatsApp',
    path: '/settings/whatsapp',
  },

  apiRoutes: [
    // ── Meta webhook: subscription handshake ────────────────
    {
      method: 'GET',
      path: '/webhook',
      skipAuth: true,
      handler: async (request: Request) => {
        const expected = process.env.WHATSAPP_VERIFY_TOKEN
        if (!expected) {
          return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }
        const url = new URL(request.url)
        const mode = url.searchParams.get('hub.mode')
        const token = url.searchParams.get('hub.verify_token')
        const challenge = url.searchParams.get('hub.challenge')
        if (mode === 'subscribe' && verifyChallengeToken(token, expected) && challenge != null) {
          return new Response(challenge, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          })
        }
        return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
      },
    },

    // ── Meta webhook: inbound events ────────────────────────
    {
      method: 'POST',
      path: '/webhook',
      skipAuth: true,
      handler: async (request: Request) => {
        const appSecret = process.env.WHATSAPP_APP_SECRET
        if (!appSecret) {
          log.error('WHATSAPP_APP_SECRET not configured', undefined)
          return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
        }

        // Signature over the RAW body, before any parsing.
        const rawBody = await request.text()
        const signature = request.headers.get('x-hub-signature-256')
        if (!verifyMetaSignature(rawBody, signature, appSecret)) {
          return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
        }

        let body: unknown
        try {
          body = JSON.parse(rawBody)
        } catch {
          // Signed but unparseable: ack so Meta does not redeliver garbage.
          return NextResponse.json({ data: { ignored: 'unparseable' } })
        }

        const parsed = parseWebhookEnvelope(body)
        const supabase = buildServiceClient()

        // Outbound delivery lifecycle updates (sent -> delivered -> read).
        for (const status of parsed.statuses) {
          await supabase
            .from('whatsapp_messages')
            .update({ delivery_status: status.status })
            .eq('wamid', status.wamid)
            .eq('direction', 'outbound')
        }

        const mediaMessageIds: string[] = []
        for (const msg of parsed.messages) {
          try {
            const phoneHash = hashPhone(msg.from)
            const link = await lookupActiveLink(supabase, phoneHash)
            if (link) {
              await handleLinkedSender(supabase, msg, phoneHash, link, mediaMessageIds)
            } else {
              await handleUnknownSender(supabase, msg, phoneHash)
            }
          } catch (err) {
            // One bad message must not take down the batch or trigger a
            // Meta redelivery of messages we already handled.
            log.error('WhatsApp message handling failed', err, { wamid: msg.wamid })
          }
        }

        // 200 first, processing after: extraction takes 10-60s and Meta
        // expects the ack within seconds.
        kickInboundProcessing(mediaMessageIds)

        return NextResponse.json({
          data: {
            received: parsed.messages.length,
            statuses: parsed.statuses.length,
            queued: mediaMessageIds.length,
          },
        })
      },
    },

    // ── Phone linking (authenticated settings panel) ────────
    {
      method: 'POST',
      path: '/link/start',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
          return NextResponse.json(
            { error: 'WhatsApp-kanalen är inte konfigurerad på den här installationen.' },
            { status: 503 },
          )
        }

        // whatsapp_link_codes is service-role only (RLS with no policies).
        const serviceClient = createServiceClient()
        const minted = await mintLinkCode(serviceClient, ctx.userId)

        // The wa.me link needs the real number, not the Graph object id.
        // WHATSAPP_PUBLIC_NUMBER (E.164 digits) is authoritative when set;
        // otherwise resolve display_phone_number from the Graph API (cached).
        const publicNumber = (process.env.WHATSAPP_PUBLIC_NUMBER ?? '').replace(/\D/g, '')
        const displayNumber = publicNumber || (await getDisplayPhoneNumber())
        const waLink = displayNumber
          ? `https://wa.me/${displayNumber}?text=${encodeURIComponent(minted.code)}`
          : null

        return NextResponse.json({
          data: { code: minted.code, expiresAt: minted.expiresAt, waLink },
        })
      },
    },

    {
      method: 'GET',
      path: '/link',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        const { data } = await ctx.supabase
          .from('whatsapp_phone_links')
          .select('phone_masked, default_company_id, muted_at, verified_at')
          .eq('user_id', ctx.userId)
          .is('revoked_at', null)
          .maybeSingle()

        if (!data) return NextResponse.json({ data: { linked: false } })
        const row = data as {
          phone_masked: string
          default_company_id: string | null
          muted_at: string | null
          verified_at: string
        }
        return NextResponse.json({
          data: {
            linked: true,
            phoneMasked: row.phone_masked,
            defaultCompanyId: row.default_company_id,
            muted: row.muted_at != null,
            verifiedAt: row.verified_at,
          },
        })
      },
    },

    {
      method: 'POST',
      path: '/link/revoke',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        await ctx.supabase
          .from('whatsapp_phone_links')
          .update({ revoked_at: new Date().toISOString() })
          .eq('user_id', ctx.userId)
          .is('revoked_at', null)
        return NextResponse.json({ data: { revoked: true } })
      },
    },

    {
      method: 'POST',
      path: '/link/default-company',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let parsedBody: z.infer<typeof DefaultCompanySchema>
        try {
          parsedBody = DefaultCompanySchema.parse(await request.json())
        } catch {
          return NextResponse.json({ error: 'Ogiltig förfrågan.' }, { status: 400 })
        }

        // The caller must be a member of the company receipts are routed to:
        // otherwise a user could point their intake at someone else's books.
        if (parsedBody.companyId) {
          const { data: membership } = await ctx.supabase
            .from('company_members')
            .select('id')
            .eq('company_id', parsedBody.companyId)
            .eq('user_id', ctx.userId)
            .maybeSingle()
          if (!membership) {
            return NextResponse.json(
              { error: 'Du är inte medlem i det företaget.' },
              { status: 403 },
            )
          }
        }

        const { error } = await ctx.supabase
          .from('whatsapp_phone_links')
          .update({ default_company_id: parsedBody.companyId })
          .eq('user_id', ctx.userId)
          .is('revoked_at', null)
        if (error) {
          return NextResponse.json(
            { error: 'Kunde inte spara standardföretaget.' },
            { status: 500 },
          )
        }
        return NextResponse.json({ data: { defaultCompanyId: parsedBody.companyId } })
      },
    },
  ],
}
