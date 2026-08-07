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
 * ledger. It returns message ids and a reason. Amounts, dates,
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
 * No confidence score is asked for, and none is used as a gate.
 *
 * The first version scored every pairing 0-1 and dropped anything under a
 * threshold. Two things killed it. Measured here, the model anchored on round
 * numbers (0.6, 0.7, 0.75, 0.9) rather than using the scale, and the threshold
 * threw away two correct pairings that scored just under it. And the research
 * agrees: verbalised LLM confidence is badly calibrated, clusters on anchors,
 * and barely beats chance at separating a model's own right answers from its
 * wrong ones, so gating on it is false rigour.
 *
 * What replaces it is an observation rather than a self-assessment: did the
 * charged amount actually appear in this mail. That is a fact about evidence,
 * it is what a reviewer would check first, and it is the signal reconciliation
 * engines weight far above the date, because bank delays are normal and amount
 * mismatches are not.
 */

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

export interface HarvestedReceipt {
  messageId: string
  /**
   * Which file on that message is the receipt.
   *
   * Load-bearing: receipts are forwarded in batches here ("Fwd: Kvitton
   * februari" carries five, "Fwd: Anthropic receipts" two for two different
   * months), so a message is not the unit of an underlag, an attachment is.
   */
  /** Which file on the message is the underlag. */
  attachmentName: string | null
  /** One sentence, shown to nobody in the happy path: it is for the run log. */
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

const HarvestSchema = z.object({
  receipts: jsonArray(
    z.object({
      message_id: z.string().min(1),
      attachment_name: z.string().nullable().default(null),
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

const HARVEST_TOOL = {
  type: 'object',
  properties: {
    receipts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          attachment_name: {
            type: 'string',
            description: 'Exact filename of the attachment that is the receipt or invoice.',
          },
          reason: { type: 'string', description: 'One short sentence, in Swedish.' },
        },
        required: ['message_id', 'attachment_name', 'reason'],
      },
    },
  },
  required: ['receipts'],
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

const HARVEST_SYSTEM = `Du avgör vilka mejl som innehåller ett underlag.

Ett underlag är ett kvitto eller en faktura: en handling som visar vad som
köpts och för hur mycket. Du får kandidatmejl som hittades när vi sökte efter
en viss handlare. Välj ut de mejl som faktiskt bär ett underlag från den
handlaren, och peka ut exakt vilken bilaga som är underlaget.

Ta med:
- Kvitton och fakturor från handlaren, oavsett datum. Nästan allt här är
  vidarebefordrat, så mejlets datum säger inget om när köpet gjordes.
- Flera mejl från samma handlare. Ett företag betalar samma leverantör varje
  månad, och varje månads kvitto är ett eget underlag.
- Flera bilagor ur samma mejl. Ett mejl med ämnet "Kvitton februari" och fem
  bilagor bär fem underlag: lista då fem rader, en per bilaga.

Ta inte med:
- Nyhetsbrev, reklam, orderbekräftelser utan belopp, betalpåminnelser.
- Inbjudningar, kalenderhändelser, korrespondens som bara nämner handlaren.
- Bilagor som uppenbart inte är underlag: signaturbilder, logotyper.

Du ska INTE avgöra vilket köp ett underlag hör till, och inte heller pressa
fram vilken handlare det gäller. Det gör systemet efteråt genom att läsa
beloppet ur filen och jämföra med kontoutdraget. Din uppgift är att hitta
handlingarna.

Därför: ta med varje bilaga som rimligen är ett kvitto eller en faktura, även
när du inte kan se vilken handlare den kommer från. Ett mejl med ämnet
"Diverse kvitton" och femton bilder bär femton underlag, oavsett vem de är
från. Gissa inte handlaren i reason: skriv vad handlingen är.

Ett i onödan hämtat kvitto kostar en rad i inkorgen. Ett missat kvitto kostar
en avdragsgill kostnad.

reason: en kort mening på svenska om vad handlingen är.`

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
 * Pick out the mails that carry an underlag.
 *
 * Deliberately NOT asked which purchase each receipt belongs to. That question
 * needs the amount, the amount lives inside the PDF, and a Gmail preview
 * essentially never shows it: measured over a real mailbox, every single
 * pairing came back "belopp ej synligt", so the model was being asked to
 * decide without the deciding evidence. It now answers what a subject, a
 * sender and a preview line can actually support, and the pairing is left to
 * deterministic code that reads the amount out of the file once it is fetched.
 */
export async function harvestReceipts(
  brand: string,
  candidates: readonly CandidateForReview[],
  limit: number,
): Promise<HarvestedReceipt[]> {
  if (candidates.length === 0) return []

  const knownMessages = new Set(candidates.map((c) => c.messageId))
  const attachmentsByMessage = new Map(
    candidates.map((c) => [c.messageId, new Set(c.attachmentNames)]),
  )

  const payload = {
    merchant: brand,
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
      HARVEST_SYSTEM,
      JSON.stringify(payload, null, 1),
      'receipts_found',
      HARVEST_TOOL,
      4096,
    )
    const parsed = HarvestSchema.parse(raw)

    const seen = new Set<string>()
    const out: HarvestedReceipt[] = []

    for (const r of parsed.receipts) {
      // Ids and filenames must be ones we supplied: the only place the model's
      // answer is not taken at face value, and what stops an invented message
      // id from ever being fetched.
      if (!knownMessages.has(r.message_id)) continue
      const available = attachmentsByMessage.get(r.message_id) ?? new Set<string>()
      if (r.attachment_name && !available.has(r.attachment_name)) continue

      // Deduped on the filename alone, not on message+filename.
      //
      // The same invoice arrives several times: the original, a reminder, and
      // one or two forwards of each, every one of them carrying the identical
      // attachment. Keyed on the message we would file "Invoice_13041840.pdf"
      // four times over. A merchant that names every attachment the same thing
      // loses the later ones, which costs one night rather than a duplicate.
      const fileKey = (r.attachment_name ?? r.message_id).toLowerCase()
      if (seen.has(fileKey)) continue
      seen.add(fileKey)

      out.push({ messageId: r.message_id, attachmentName: r.attachment_name, reason: r.reason })
      if (out.length >= limit) break
    }

    if (out.length !== parsed.receipts.length) {
      log.info('harvest filtered', { brand, proposed: parsed.receipts.length, kept: out.length })
    }
    return out
  } catch (error) {
    log.warn('receipt harvest failed, fetching nothing for this merchant', {
      brand,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
