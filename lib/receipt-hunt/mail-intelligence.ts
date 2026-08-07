/**
 * The two judgements in the hunt that a keyword search cannot make.
 *
 * Measured against a real mailbox, the deterministic search failed for reasons
 * no amount of regex tuning fixes:
 *
 *   - `from:anthropic.com` returns nothing, because the receipts were
 *     *forwarded*: the sender is the user, not the vendor.
 *   - The exact charged amount returns nothing, because Swedish banks post a
 *     converted SEK figure that appears nowhere in a USD receipt.
 *   - A date window returns nothing, because a forwarded mail is stamped when
 *     it was forwarded, sometimes months after the purchase.
 *
 * What survives all three is the merchant's *name*, searched without a date
 * window, which returns far too many hits to trust. So the model is used at
 * exactly the two points where the problem is semantic rather than arithmetic:
 * naming the merchant a bank descriptor refers to, and deciding which of many
 * candidate mails is the receipt for a specific charge.
 *
 * What the model is NOT allowed to do: produce any number that reaches the
 * ledger. It returns message ids, a confidence and a reason. Amounts, dates,
 * accounts and the pairing write itself stay in deterministic code, and every
 * result still waits for a human in the granskningskö.
 */
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import { z } from 'zod'
import { createLogger } from '@/lib/logger'

const log = createLogger('receipt-hunt-intelligence')

/**
 * Overridable so ops can move the hunt off the default without a deploy. The
 * hunt reasons over messy, truncated, multilingual descriptors, so it is
 * deliberately not pinned to whatever the cheapest extraction model happens to
 * be.
 */
const MODEL =
  process.env.RECEIPT_HUNT_MODEL_ID ||
  process.env.BEDROCK_MODEL_ID ||
  'eu.anthropic.claude-sonnet-5'

/**
 * Below this the assignment is treated as a guess and dropped.
 *
 * Lower than it looks, deliberately. Nothing here links a document to a
 * verifikat: it stages a proposal that a human reads, alongside the model's
 * own reason for making it. Measured on a real ledger, a 0.7 floor threw away
 * two correct pairings (a Sting office invoice and a Norwegian flight) that the
 * model had scored just below it, so the floor was costing real recall while
 * protecting a decision that a person makes anyway.
 */
export const MIN_ASSIGNMENT_CONFIDENCE = (() => {
  const parsed = Number(process.env.RECEIPT_HUNT_MIN_CONFIDENCE)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.6
})()

export interface PurchaseDescriptor {
  id: string
  /** The bank's raw description, truncation and card tokens included. */
  description: string
  amount: number
  currency: string
  date: string
}

export interface MerchantGroup {
  /** Human-readable merchant name, used in logs and proposal text. */
  brand: string
  /** Names likely to appear in the receipt itself, best first. */
  aliases: string[]
  transactionIds: string[]
}

export interface CandidateForReview {
  messageId: string
  mailbox: string
  subject: string | null
  from: string | null
  receivedAt: string | null
  snippet: string | null
  attachmentNames: string[]
}

export interface Assignment {
  transactionId: string
  messageId: string
  /**
   * Which file on that message is the receipt.
   *
   * Load-bearing: receipts are forwarded in batches here ("Fwd: Kvitton
   * februari" carries five, "Fwd: Anthropic receipts" two for two different
   * months), so a message is not the unit of an underlag, an attachment is.
   */
  attachmentName: string | null
  confidence: number
  reason: string
}

/**
 * Accept an array that arrived as a JSON string.
 *
 * Even under forced tool use the model occasionally stringifies a nested array
 * rather than emitting it. That is a serialisation quirk, not a wrong answer,
 * and rejecting the whole run over it costs a night's hunt.
 */
const jsonArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }, z.array(item).default([]))

/**
 * Lenient on purpose. A group the model marked unsearchable legitimately has no
 * aliases, and one malformed group must not cost the whole run: the useful
 * groups are filtered out below, so anything unusable simply falls away.
 */
const GroupSchema = z.object({
  groups: jsonArray(
    z.object({
      brand: z.string().min(1),
      aliases: jsonArray(z.string()),
      transaction_ids: jsonArray(z.string()),
      searchable: z.boolean().default(true),
    }),
  ),
})

const AssignmentSchema = z.object({
  assignments: jsonArray(
    z.object({
      transaction_id: z.string().min(1),
      message_id: z.string().min(1),
      attachment_name: z.string().nullable().default(null),
      // Some replies send confidence as "0.85"; a number is a number.
      confidence: z.coerce.number().min(0).max(1),
      reason: z.string().min(1).max(300),
    }),
  ),
})

function client(): AnthropicBedrock {
  return new AnthropicBedrock({ awsRegion: process.env.AWS_REGION })
}

/**
 * Ask for a shape, not for text that looks like a shape.
 *
 * The model is required to answer through a tool whose input schema *is* the
 * contract, so the reply arrives already parsed. Asking for JSON in prose and
 * parsing it back failed here in two different ways within a single run: a
 * field omitted on a case the schema had not anticipated, and an unescaped
 * character mid-array. Neither is possible through a tool call.
 */
async function ask(
  system: string,
  user: string,
  toolName: string,
  inputSchema: Record<string, unknown>,
  maxTokens: number,
): Promise<unknown> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    tools: [
      {
        name: toolName,
        description: 'Return the result in this exact shape.',
        input_schema: inputSchema as never,
      },
    ],
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content: user }],
  })
  const block = response.content.find((c) => c.type === 'tool_use')
  if (!block || block.type !== 'tool_use') throw new Error('model did not use the tool')
  return block.input
}

const GROUP_TOOL = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          brand: { type: 'string', description: 'Merchant name in plain language.' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names likely to appear in the receipt itself, best first, max 4.',
          },
          transaction_ids: { type: 'array', items: { type: 'string' } },
          searchable: {
            type: 'boolean',
            description: 'False when no receipt can exist, or no merchant is identifiable.',
          },
        },
        required: ['brand', 'aliases', 'transaction_ids', 'searchable'],
      },
    },
  },
  required: ['groups'],
}

const ASSIGN_TOOL = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string' },
          message_id: { type: 'string' },
          attachment_name: {
            type: 'string',
            description:
              'Exact filename of the attachment that is the receipt for THIS purchase. Required when the message has several.',
          },
          confidence: { type: 'number', description: '0 to 1.' },
          reason: { type: 'string', description: 'One short sentence, in Swedish.' },
        },
        required: ['transaction_id', 'message_id', 'attachment_name', 'confidence', 'reason'],
      },
    },
  },
  required: ['assignments'],
}

const GROUP_SYSTEM = `Du tolkar svenska kontoutdrag.

En banktext är inte ett handlarnamn. Den är avhuggen efter ~16 tecken, saknar
diakriter eller translittererar dem (ö -> oe), och innehåller korttoken (K3667),
betalvägar (Kortköp/uttag, Bg-bet, Autogiro, Överföring) och ibland bara ett
referensnummer.

Din uppgift: avgör vilken handlare varje rad avser, och gruppera rader som
avser samma handlare.

Regler:
- Slå ihop alla köp hos samma handlare till EN grupp, även om beloppen skiljer.
- "aliases" ska vara namn som troligen står i själva kvittomejlet: varumärket,
  det juridiska namnet, produktnamnet. Banken skriver "ANTHROPIC* CLAUDE SUB",
  kvittot säger "Anthropic" eller "Claude". Banken skriver "Stockholm Innovation
  & Growth", kvittot säger "Sting". Max 4 alias, det mest sökbara först.
- Hitta aldrig på en handlare som texten inte antyder.
- searchable=false när inget kvitto kan finnas (lön, skatt, arbetsgivaravgift,
  utdelning, amortering, ränta) eller när raden inte identifierar någon handlare
  alls (enbart ett referensnummer).
`

const ASSIGN_SYSTEM = `Du avgör vilket underlag som hör till ett visst köp.

Du får köp från ett kontoutdrag och kandidatmejl från företagets brevlådor.
Para ihop dem. Ett köp får högst ett underlag.

Så här ser materialet ut, och inget av det är skäl att förkasta ett mejl:

- Nästan allt är VIDAREBEFORDRAT. Mejlets eget datum är då när det skickades
  vidare, inte när köpet gjordes. Originaldatumet står nästan alltid i
  förhandsvisningen ("Date: mån 15 juni 2026", "Datum: tors 15 jan. 2026").
  Använd DET datumet mot köpets datum. Det är ofta det som avgör.
- Ett mejl kan innehålla flera kvitton för olika köp ("Fwd: Kvitton februari"
  med fem bilagor). Välj i attachment_name exakt den bilaga som hör till
  DETTA köp. Filnamnet bär ofta kvittonumret som också står i ämnesraden
  (ämne "#2066-0204-8388" -> "Receipt-2066-0204-8388.pdf"), eller månaden
  ("anthropic-kvitto-december.pdf"). Samma mejl får användas till flera köp
  så länge du väljer olika bilagor.
- Kvittot kan vara i annan valuta än kontoutdraget. Svenska banker drar ett
  omräknat SEK-belopp som aldrig står i ett kvitto i USD. Räkna inte om
  valuta: sakna belopp hellre än att gissa på ett. Saknas beloppet är datumet
  och kvittonumret det du har.

Förkasta mejl som bara nämner handlaren: nyhetsbrev, reklam, påminnelser utan
underlag.

Varje förslag granskas av en människa som ser din motivering innan något
kopplas. Ett välmotiverat förslag är därför användbart även när du inte är
helt säker. Men går två köp inte att skilja åt med det du ser, lämna dem
oparade hellre än att slumpa: fel underlag på ett verifikat är dyrare än
inget underlag alls.

confidence: 0-1, hur säker du är. reason: en kort mening på svenska.`

/**
 * Turn bank descriptors into merchant identities worth searching for.
 *
 * One call for the whole run: grouping is the point, and it can only be done
 * with every purchase in view. Degrades to no groups, which leaves the hunt
 * doing what it did before the model existed rather than doing something wrong.
 */
export async function planMerchantGroups(
  purchases: readonly PurchaseDescriptor[],
): Promise<MerchantGroup[]> {
  if (purchases.length === 0) return []

  const known = new Set(purchases.map((p) => p.id))
  const payload = purchases.map((p) => ({
    id: p.id,
    text: p.description,
    amount: p.amount,
    currency: p.currency,
    date: p.date,
  }))

  try {
    const raw = await ask(
      GROUP_SYSTEM,
      JSON.stringify({ purchases: payload }, null, 1),
      'merchant_groups',
      GROUP_TOOL,
      4096,
    )
    const parsed = GroupSchema.parse(raw)

    return parsed.groups
      .filter((g) => g.searchable)
      .map((g) => ({
        brand: g.brand,
        // Two characters is the floor a Gmail term is worth having; four
        // aliases is where an OR query stops adding recall and starts adding
        // noise.
        aliases: [...new Set(g.aliases.map((a) => a.trim()).filter((a) => a.length >= 2))].slice(0, 4),
        // Ids are filtered against what we sent: the model may not invent a
        // transaction, and a hallucinated id must not reach a query.
        transactionIds: g.transaction_ids.filter((id) => known.has(id)),
      }))
      .filter((g) => g.transactionIds.length > 0 && g.aliases.length > 0)
  } catch (error) {
    log.warn('merchant planning failed, falling back to descriptor search', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Decide which candidate mail is the receipt for which purchase.
 *
 * Called once per merchant group so the model can use the constraint that each
 * receipt belongs to one charge: with six identical Anthropic subscriptions and
 * ten Anthropic mails, deciding all six together is strictly better than six
 * independent guesses.
 */
export async function assignReceipts(
  brand: string,
  purchases: readonly PurchaseDescriptor[],
  candidates: readonly CandidateForReview[],
): Promise<Assignment[]> {
  if (purchases.length === 0 || candidates.length === 0) return []

  const knownPurchases = new Set(purchases.map((p) => p.id))
  const knownMessages = new Set(candidates.map((c) => c.messageId))

  const payload = {
    merchant: brand,
    purchases: purchases.map((p) => ({
      id: p.id,
      date: p.date,
      amount_charged: p.amount,
      currency: p.currency,
      bank_text: p.description,
    })),
    emails: candidates.map((c) => ({
      message_id: c.messageId,
      mailbox: c.mailbox,
      date: c.receivedAt,
      subject: c.subject,
      from: c.from,
      preview: c.snippet?.slice(0, 400) ?? null,
      attachments: c.attachmentNames,
    })),
  }

  try {
    const raw = await ask(
      ASSIGN_SYSTEM,
      JSON.stringify(payload, null, 1),
      'receipt_assignments',
      ASSIGN_TOOL,
      4096,
    )
    const parsed = AssignmentSchema.parse(raw)

    const attachmentsByMessage = new Map(
      candidates.map((c) => [c.messageId, new Set(c.attachmentNames)]),
    )
    const usedFiles = new Set<string>()
    const usedPurchases = new Set<string>()
    const out: Assignment[] = []

    for (const a of parsed.assignments) {
      // Every id must be one we supplied: this is what stops a hallucinated
      // message id from ever being fetched.
      if (!knownPurchases.has(a.transaction_id) || !knownMessages.has(a.message_id)) continue
      if (a.confidence < MIN_ASSIGNMENT_CONFIDENCE) continue

      // A named attachment must actually exist on that message. An invented
      // filename means the model was guessing, so the assignment goes.
      const available = attachmentsByMessage.get(a.message_id) ?? new Set<string>()
      if (a.attachment_name && !available.has(a.attachment_name)) continue

      // One purchase gets one underlag, and one file is used once. Keyed on the
      // file rather than the message, because a single forward legitimately
      // carries receipts for several different purchases.
      const fileKey = `${a.message_id}::${a.attachment_name ?? ''}`
      if (usedFiles.has(fileKey) || usedPurchases.has(a.transaction_id)) continue

      usedFiles.add(fileKey)
      usedPurchases.add(a.transaction_id)
      out.push({
        transactionId: a.transaction_id,
        messageId: a.message_id,
        attachmentName: a.attachment_name,
        confidence: a.confidence,
        reason: a.reason,
      })
    }

    // Worth knowing in production, not just here: a run that proposes six
    // pairings and keeps one is a tuning problem, and without this it looks
    // identical to a run where the model found nothing.
    if (out.length !== parsed.assignments.length) {
      log.info('assignments filtered', {
        brand,
        proposed: parsed.assignments.length,
        kept: out.length,
        belowConfidence: parsed.assignments.filter((a) => a.confidence < MIN_ASSIGNMENT_CONFIDENCE)
          .length,
      })
    }
    return out
  } catch (error) {
    log.warn('receipt assignment failed, proposing nothing for this merchant', {
      brand,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
