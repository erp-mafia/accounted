/**
 * Parties: the model reads a counterpart out of a voucher text that the
 * rules could not anchor.
 *
 * lib/parties/name-extract.ts names a company when the text carries a legal
 * form or a country word. Bank memos carry neither: "Hotel at Booking.com
 * K3667 Kortköp/uttag · Hotell, svenskt boende", "UBER *TRIP HELP.UBER.COM".
 * For those, and only those, one model call reads the counterpart the way a
 * bookkeeper would. The reading is a fact with source 'model', shown as
 * "läst ur verifikatet", used as the registry query and never as a hard key:
 * an org number still comes from SCB and a person's click, a VAT number only
 * when it is written in the text.
 *
 * Runs on demand (the picker, the review list), not when the queue builds:
 * a queue of five hundred rows would otherwise cost five hundred calls that
 * nobody asked for, and a rebuild would repeat them.
 */
import { z } from 'zod'
import { getAiService, getAiStatus } from '@/lib/ai'

export interface AiNameReading {
  /** The counterpart as the model reads it, or null when the text names none. */
  name: string | null
  /** ISO 3166-1 alpha-2 when the text says where the counterpart is. */
  country: string | null
  /** A VAT number written in the text, if any. */
  vatNumber: string | null
  confidence: 'high' | 'medium' | 'low'
  model: string
}

export function aiNameAvailable(): boolean {
  return getAiStatus().configured
}

const SYSTEM = [
  'You read descriptions of Swedish bookkeeping vouchers (verifikat) and name the counterpart: the company or organisation the money went to or came from.',
  'Answer only from the text. Card memos abbreviate: "UBER *TRIP HELP.UBER.COM" is Uber, "Hotel at Booking.com" is Booking.com, "ANTHROPIC* CLAUDE SUB" is Anthropic.',
  'Leave out payment method words (Kortköp/uttag, Överföring via internet, Bg-bet), references, dates, amounts, account notes and VAT commentary.',
  'Give the name as the company writes it, with its legal form only if the text has it. Do not invent a legal form or an org number.',
  'country: ISO 3166-1 alpha-2 only when the text states or unmistakably implies it (Ireland, (NL), USA, utländsk moms with a named country); otherwise null.',
  'vat_number: only a VAT number written in the text, letters and digits, no spaces; otherwise null.',
  'If the text names no counterpart (a fee, a category, a transfer between own accounts, a salary), answer name null.',
].join(' ')

const SCHEMA = {
  name: 'counterpart_reading',
  description: 'The counterpart named in the voucher text, or null.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: ['string', 'null'] },
      country: { type: ['string', 'null'] },
      vat_number: { type: ['string', 'null'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['name', 'country', 'vat_number', 'confidence'],
  },
}

const Reading = z.object({
  name: z.string().trim().min(1).max(120).nullable(),
  country: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/))
    .nullable()
    .catch(null),
  vat_number: z
    .string()
    .trim()
    .transform((s) => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}[0-9A-Z]{8,12}$/))
    .nullable()
    .catch(null),
  confidence: z.enum(['high', 'medium', 'low']).catch('low'),
})

export const AI_NAME_MAX_TEXTS = 3

/**
 * One call for one party. Returns null when the deployment has no model or
 * the answer is unusable; the caller then searches on the memo as before.
 */
export async function readCounterpartName(texts: string[]): Promise<AiNameReading | null> {
  const distinct = [...new Set(texts.map((t) => t.trim()).filter(Boolean))].slice(0, AI_NAME_MAX_TEXTS)
  if (distinct.length === 0 || !aiNameAvailable()) return null
  const prompt = ['Voucher descriptions for one counterpart:', ...distinct.map((t, i) => `${i + 1}. ${t}`)].join('\n')
  try {
    const result = await getAiService().generateStructured({ tier: 'extraction', system: SYSTEM, prompt, maxTokens: 200, schema: SCHEMA })
    const parsed = Reading.safeParse(result.value)
    if (!parsed.success) return null
    return {
      name: parsed.data.name,
      country: parsed.data.country,
      vatNumber: parsed.data.vat_number,
      confidence: parsed.data.confidence,
      model: result.model,
    }
  } catch {
    return null
  }
}
