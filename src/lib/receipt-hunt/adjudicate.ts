/**
 * The pairs the arithmetic cannot settle.
 *
 * A weighted formula is the right instrument for the clear cases: it is free,
 * instant, reproducible years later for an audit, and it cannot invent a
 * merchant. It is a poor instrument for the middle. Its weights are chosen by
 * hand, and a pair agreeing to within 1% from a recognised merchant can still
 * land at 0.62 because a date drifted, which says more about the constants than
 * about the receipt.
 *
 * So the formula keeps what it is good at and hands over what it is not. Only
 * the uncertain band is sent here, which on a real ledger was eight pairs
 * against five it had already settled.
 *
 * The question asked is deliberately a yes or no with a reason, never a score.
 * An earlier design in this feature asked the model to rate its own certainty
 * and it anchored on round numbers, which the calibration literature predicts:
 * verbalised confidence is badly calibrated and barely separates a model's
 * right answers from its wrong ones. Judging concrete evidence and explaining
 * the judgement is a different task, and one it is good at.
 *
 * Nothing here books anything. An accepted pair becomes the same proposal a
 * human approves, carrying the reason so the approval is checking an argument
 * rather than trusting a verdict.
 */
import { z } from 'zod'
import { createAiClient, toProviderModelId, type AiClient } from '@/lib/ai/provider'
import { createLogger } from '@/lib/logger'

const log = createLogger('receipt-hunt-adjudicate')

const MODEL = toProviderModelId(
  process.env.RECEIPT_HUNT_MODEL_ID ||
    process.env.BEDROCK_MODEL_ID ||
    'claude-sonnet-5'
)

export interface UncertainPair {
  /** Stable handle for this pair, opaque to the model beyond matching it back. */
  key: string
  purchase: {
    description: string
    amount: number
    currency: string
    date: string
  }
  receipt: {
    vendor: string | null
    total: number | null
    currency: string | null
    /** The total in kronor when a rate was resolved, so both sides compare. */
    sekTotal?: number | null
    date: string | null
    fileName: string | null
  }
  /** What the formula made of it, as context rather than as an instruction. */
  confidence: number
  matchReasons: string[]
}

export interface Verdict {
  key: string
  accept: boolean
  reason: string
}

const VerdictSchema = z.object({
  verdicts: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v
      try {
        return JSON.parse(v)
      } catch {
        return v
      }
    },
    z
      .array(
        z.object({
          key: z.string().min(1),
          accept: z.coerce.boolean(),
          reason: z.string().min(1).max(300),
        }),
      )
      .default([]),
  ),
})

const TOOL = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The pair key exactly as given.' },
          accept: {
            type: 'boolean',
            description: 'True only if this document is the underlag for this purchase.',
          },
          reason: { type: 'string', description: 'One short sentence, in Swedish.' },
        },
        required: ['key', 'accept', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const SYSTEM = `Du avgör om en handling hör till ett visst köp.

Du får par som en beräkning inte kunde avgöra själv. För varje par: är den här
handlingen underlaget för det här köpet? Svara ja eller nej och säg varför.

Det här gör paren svåra, och inget av det är i sig skäl att säga nej:

- Datumen glider. Ett kortköp bokförs hos banken dagar efter att det gjordes,
  utrikes gärna en vecka, och ett vidarebefordrat kvitto bär köpets datum medan
  kontoutdraget bär bokföringsdagen.
- Beloppen kan skilja någon procent när kvittot är i annan valuta. Banken drog
  ett omräknat belopp till sin egen kurs; vi har räknat om till Riksbankens.
  Ett par procents skillnad är växelkursen, inte olika belopp.
- Bankens text är inte ett handlarnamn. Den är avhuggen och innehåller
  betalvägar: "ANTHROPIC* CLAUDE SUB" och "Anthropic, PBC" är samma leverantör.

Säg nej när något faktiskt talar emot: fel storleksordning på beloppet, en
handling som avser en annan period, eller en handlare som inte rimligen är
samma. Säg nej också när du helt enkelt inte kan avgöra det: en människa läser
ditt skäl och ett vagt ja kostar mer än ett ärligt nej.

Beräkningens poäng och skäl finns med som bakgrund. Den har redan vägt in
belopp, handlare och datum, så håll dig inte till den: du ser saker den inte
kan väga.

reason: en kort mening på svenska om varför paret hör ihop eller inte.`

function client(): AiClient {
  return createAiClient()
}

/**
 * Settle the pairs the formula could not.
 *
 * One call for the batch: the pairs are independent, but a run holds a handful
 * of them and a call each would be latency for nothing.
 *
 * Returns only the pairs it was given, and only accepted ones. A failed call
 * accepts nothing, which leaves the run exactly where the arithmetic left it.
 */
export async function adjudicate(pairs: readonly UncertainPair[]): Promise<Verdict[]> {
  if (pairs.length === 0) return []

  const known = new Set(pairs.map((p) => p.key))
  const payload = {
    pairs: pairs.map((p) => ({
      key: p.key,
      kop: {
        text: p.purchase.description,
        belopp: p.purchase.amount,
        valuta: p.purchase.currency,
        datum: p.purchase.date,
      },
      handling: {
        leverantor: p.receipt.vendor,
        belopp: p.receipt.total,
        valuta: p.receipt.currency,
        belopp_i_kronor: p.receipt.sekTotal ?? null,
        datum: p.receipt.date,
        fil: p.receipt.fileName,
      },
      berakningen_sa: { poang: p.confidence, skal: p.matchReasons },
    })),
  }

  try {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      tools: [{ name: 'verdicts', description: 'Return the result in this exact shape.', input_schema: TOOL as never }],
      tool_choice: { type: 'tool', name: 'verdicts' },
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 1) }],
    })

    const block = response.content.find((c) => c.type === 'tool_use')
    if (!block || block.type !== 'tool_use') throw new Error('model did not use the tool')
    const parsed = VerdictSchema.parse(block.input)

    const seen = new Set<string>()
    const out: Verdict[] = []
    for (const v of parsed.verdicts) {
      // Only pairs we asked about, and each answered once: a key we never sent
      // would attach a document to a purchase nobody weighed.
      if (!known.has(v.key) || seen.has(v.key)) continue
      seen.add(v.key)
      if (!v.accept) continue
      out.push({ key: v.key, accept: true, reason: v.reason })
    }

    log.info('adjudicated uncertain pairs', { asked: pairs.length, accepted: out.length })
    return out
  } catch (error) {
    log.warn('adjudication failed, proposing none of the uncertain pairs', {
      pairs: pairs.length,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
