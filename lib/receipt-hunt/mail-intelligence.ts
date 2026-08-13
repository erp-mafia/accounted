/**
 * One job for the model: read a mail and say what document it is.
 *
 * This started out much cleverer. The model was asked to resolve bank
 * descriptors to merchants, then to decide which mail was the receipt for
 * which charge, with a confidence score gating the result. Measured against a
 * real mailbox, every part of that was wrong in the same way: it was being
 * asked to judge without the evidence to judge on.
 *
 *   - The amount decides a reconciliation, and the amount is inside the PDF.
 *     Every pairing it produced came back "belopp ej synligt".
 *   - Its confidence was anchored on round numbers and its threshold threw
 *     away correct answers, which is what the calibration literature predicts.
 *   - The purchase date it needed was sitting in the mail body all along: a
 *     forwarded receipt quotes the original sender and date in its header, and
 *     the body was being downloaded and discarded in favour of a 200-character
 *     snippet.
 *
 * So it now does the thing models are unambiguously good at and nothing else:
 * read text, return fields. Which receipt belongs to which purchase is decided
 * afterwards by the same deterministic amount-and-merchant matcher that scores
 * every other underlag, so mail and Underlag get one matcher rather than two.
 */
import { z } from 'zod'
import { createAiClient, toProviderModelId, type AiClient } from '@/lib/ai/provider'
import { createLogger } from '@/lib/logger'

const log = createLogger('receipt-hunt-intelligence')

/**
 * Overridable so ops can move the hunt off the default without a deploy.
 */
const MODEL = toProviderModelId(
  process.env.RECEIPT_HUNT_MODEL_ID ||
    process.env.BEDROCK_MODEL_ID ||
    'claude-sonnet-5'
)

export interface CandidateForReview {
  messageId: string
  mailbox: string
  subject: string | null
  from: string | null
  receivedAt: string | null
  bodyText: string | null
  attachmentNames: string[]
}

/** What a mail says a document is. Fields, not judgements. */
export interface MailReceipt {
  messageId: string
  /** Which file on the message, when the mail carries several. */
  attachmentName: string | null
  vendor: string | null
  /** The purchase date, read from the forwarded header rather than the mail's own. */
  date: string | null
  amount: number | null
  currency: string | null
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

const ExtractionSchema = z.object({
  documents: jsonArray(
    z.object({
      message_id: z.string().min(1),
      attachment_name: z.string().nullable().default(null),
      is_receipt: z.coerce.boolean().default(false),
      vendor: z.string().nullable().default(null),
      date: z.string().nullable().default(null),
      amount: z.coerce.number().nullable().default(null),
      currency: z.string().nullable().default(null),
    }),
  ),
})

const EXTRACT_TOOL = {
  type: 'object',
  properties: {
    documents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          attachment_name: {
            type: 'string',
            description: 'Exact filename this document is, or null if the mail body is the receipt.',
          },
          is_receipt: { type: 'boolean', description: 'It is a receipt or an invoice.' },
          vendor: { type: 'string', description: 'Who sold it. Null if unclear.' },
          date: { type: 'string', description: 'Purchase date as YYYY-MM-DD. Null if unclear.' },
          amount: { type: 'number', description: 'Total including VAT. Null if not stated in the text.' },
          currency: { type: 'string', description: 'ISO code, e.g. SEK, USD, EUR.' },
        },
        required: ['message_id', 'attachment_name', 'is_receipt', 'vendor', 'date', 'amount', 'currency'],
      },
    },
  },
  required: ['documents'],
}

const EXTRACT_SYSTEM = `Du läser mejl och rapporterar vilka handlingar de innehåller.

För varje mejl: är det ett kvitto eller en faktura, från vem, för hur mycket
och vilket datum. Du dömer inte om något hör ihop med något annat. Du läser.

Det här är nästan alltid vidarebefordrade mejl, och det avgör hur du läser dem:

- DATUM: använd datumet ur den vidarebefordrade rubriken ("Från: Elgiganten,
  Date: mån 3 aug. 2026"), inte när mejlet skickades vidare. Skillnaden är
  ofta månader. Skriv det som YYYY-MM-DD.
- HANDLARE: samma rubrik namnger den ursprungliga avsändaren. Det är
  handlaren, inte personen som vidarebefordrade.
- BELOPP: bara om det faktiskt står i texten. Står det inte där ligger det i
  den bifogade filen, och då är amount null. Hitta aldrig på ett belopp och
  räkna aldrig om valuta: står det 180,00 EUR rapporterar du 180 och EUR.

Bär mejlet flera handlingar ("Kvitton februari" med fem bilagor), lämna en rad
per bilaga och sätt attachment_name till rätt filnamn. Nämner texten belopp
per kvitto, para ihop dem med filnamnen så gott det går.

Är mejlet inget underlag (nyhetsbrev, reklam, korrespondens, kalender), sätt
is_receipt=false och lämna resten null. Ta hellre med en osäker faktura än
missa ett kvitto: en handling utan matchande belopp faller bort av sig själv
senare.`

function client(): AiClient {
  return createAiClient()
}

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
      { name: toolName, description: 'Return the result in this exact shape.', input_schema: inputSchema as never },
    ],
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content: user }],
  })
  const block = response.content.find((c) => c.type === 'tool_use')
  if (!block || block.type !== 'tool_use') throw new Error('model did not use the tool')
  return block.input
}

/** ISO date or nothing: a malformed date must not become a matching signal. */
function cleanDate(value: string | null): string | null {
  if (!value) return null
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const iso = match[0]
  return Number.isNaN(new Date(iso).getTime()) ? null : iso
}

/**
 * Read a batch of mails and report the documents in them.
 *
 * One call for the whole batch: the task is per-mail, but batching keeps this
 * to a single round trip per run instead of one per message.
 */
export async function extractMailDocuments(
  candidates: readonly CandidateForReview[],
): Promise<MailReceipt[]> {
  if (candidates.length === 0) return []

  const known = new Set(candidates.map((c) => c.messageId))
  const attachmentsByMessage = new Map(
    candidates.map((c) => [c.messageId, new Set(c.attachmentNames)]),
  )

  const payload = {
    emails: candidates.map((c) => ({
      message_id: c.messageId,
      subject: c.subject,
      from: c.from,
      forwarded_at: c.receivedAt,
      attachments: c.attachmentNames,
      body: c.bodyText,
    })),
  }

  try {
    const raw = await ask(
      EXTRACT_SYSTEM,
      JSON.stringify(payload, null, 1),
      'documents_in_mail',
      EXTRACT_TOOL,
      8192,
    )
    const parsed = ExtractionSchema.parse(raw)

    const out: MailReceipt[] = []
    for (const d of parsed.documents) {
      if (!d.is_receipt) continue
      // Ids and filenames must be ones we supplied: the only place the reply is
      // not taken at face value, and what stops an invented id being fetched.
      if (!known.has(d.message_id)) continue
      const available = attachmentsByMessage.get(d.message_id) ?? new Set<string>()
      if (d.attachment_name && !available.has(d.attachment_name)) continue

      // No filename on a mail carrying several files is not an answer, it is a
      // shrug: the caller would fetch the first attachment and hope. A batch
      // forward with five receipts is exactly where that goes wrong.
      if (!d.attachment_name && available.size > 1) continue

      out.push({
        messageId: d.message_id,
        attachmentName: d.attachment_name,
        vendor: d.vendor?.trim() || null,
        date: cleanDate(d.date),
        // A non-positive total is a misread, not a free receipt.
        amount: d.amount != null && d.amount > 0 ? d.amount : null,
        currency: d.currency?.trim().toUpperCase() || null,
      })
    }

    log.info('mail extraction', {
      mails: candidates.length,
      documents: out.length,
      withAmount: out.filter((r) => r.amount != null).length,
    })
    return out
  } catch (error) {
    log.warn('mail extraction failed, fetching nothing this run', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
