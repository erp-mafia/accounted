// AI-driven invoice/receipt field extraction.
//
// Sends the uploaded document directly to Claude Sonnet 4.6 via AWS
// Bedrock and asks for a structured InvoiceExtractionResult JSON. Sonnet
// reads PDFs, images, and scans natively, which the previous regex
// extractor couldn't: that's why English receipts (Anthropic, AWS,
// Stripe, …) and image-only PDFs came back empty.
//
// The AI output is validated against a Zod schema; anything that doesn't
// parse falls back to an empty result so the inbox row still lands and
// the user can fill the fields in manually.

import { createHash } from 'node:crypto'
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import { z } from 'zod'
import type { InvoiceExtractionResult } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoice-inbox-extract')

// Both overridable via env vars so ops can swap models / raise token caps
// without a code deploy. Defaults match what's expected to be set in
// production (eu.anthropic.claude-sonnet-5 in eu-north-1, 8192 tokens:
// enough headroom for invoices with 20+ line items).
const MODEL = process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-5'
const MAX_TOKENS = (() => {
  const parsed = Number(process.env.BEDROCK_MAX_TOKENS)
  // Use the env value only if it's a positive number: `||` would also
  // fall back on a deliberate `0`, masking what is really an invalid
  // configuration rather than the intent to disable.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8192
})()

// Bedrock supports these document/image media types directly. HEIC/HEIF
// are not on the list, so we skip AI for those: the inbox row still
// lands and the user can edit fields manually or replace the file.
// text/html (mail-body invoices from the inbound pipeline) is not sent as
// a document block: it is converted to plain text via htmlToText() first.
const SUPPORTED_MEDIA_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'text/html',
])

export interface ExtractionInput {
  buffer: Buffer
  mimeType: string
  fileName: string
}

export interface ExtractionOutput {
  data: InvoiceExtractionResult
  /** The raw JSON string returned by the model, or null on failure. */
  rawText: string | null
}

// Classification fields are nullable AND .catch(null): a hallucinated enum
// value must degrade to "unknown", never fail the whole document parse. The
// amount/date fields keep strict parsing on purpose: a malformed amount
// SHOULD reject the output rather than store garbage.
const DocumentKind = z
  .enum(['receipt', 'supplier_invoice', 'government_letter', 'other'])
  .nullable()
  .catch(null)
const PaymentMethod = z
  .enum(['card', 'swish', 'cash', 'invoice', 'other'])
  .nullable()
  .catch(null)
const MerchantCategory = z
  .enum(['restaurant', 'cafe', 'taxi', 'parking', 'fuel', 'grocery', 'hotel', 'other'])
  .nullable()
  .catch(null)
const Legibility = z.enum(['good', 'partial', 'unreadable']).nullable().catch(null)

export const ExtractionSchema = z.object({
  // All optional: raw model outputs cached before these fields existed must
  // still validate (same convention as servicePeriodStart/End below). These
  // route UI emphasis and clarifying questions only; they never book anything.
  documentKind: DocumentKind.optional(),
  merchantCategory: MerchantCategory.optional(),
  legibility: Legibility.optional(),
  purchaseTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .catch(null)
    .optional(),
  payment: z
    .object({
      method: PaymentMethod,
      // Length + digits-only, deliberately not the shared four-digit
      // invariant from @/lib/invariants: this is the tail of a masked card
      // number, not a BAS account and not a fiscal year.
      cardLast4: z.string().length(4).regex(/^\d+$/).nullable().catch(null),
    })
    .nullable()
    .catch(null)
    .optional(),
  supplier: z.object({
    name: z.string().nullable(),
    orgNumber: z.string().nullable(),
    vatNumber: z.string().nullable(),
    address: z.string().nullable(),
    bankgiro: z.string().nullable(),
    plusgiro: z.string().nullable(),
  }),
  invoice: z.object({
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    paymentReference: z.string().nullable(),
    currency: z.string(),
    // Service/coverage window the invoice charges for (insurance period,
    // license term, "avtalsperiod"). Drives the periodisering prefill in the
    // supplier-invoice form. Optional so cached raw outputs from before this
    // field still validate.
    servicePeriodStart: z.string().nullable().optional(),
    servicePeriodEnd: z.string().nullable().optional(),
  }),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number().nullable(),
      lineTotal: z.number(),
      // Sane range for any real-world VAT rate. We allow non-Swedish rates
      // (UK 20, DE 19, NO 25, ...) since Accounted stores foreign invoices
      // for reference; the strict Swedish allowlist applies later when the
      // user converts to a supplier invoice.
      vatRate: z.number().min(0).max(100).nullable(),
      // accountSuggestion is forcibly null at parse time: we never
      // delegate BAS account assignment to an unvalidated AI output.
      // .transform coerces a hallucinated string to null without
      // failing the whole document parse, and eliminates the
      // post-validation null-forcing pattern that left a brief window
      // where a non-null value could appear in the parsed object.
      accountSuggestion: z.union([z.string(), z.null()]).transform(() => null as null),
    })
  ),
  totals: z.object({
    subtotal: z.number().nullable(),
    vatAmount: z.number().nullable(),
    total: z.number().nullable(),
    // Öresavrundning line on Swedish receipts (can be negative). Optional so
    // cached raw outputs from before the field still validate.
    roundingAmount: z.number().nullable().catch(null).optional(),
  }),
  vatBreakdown: z.array(
    z.object({
      rate: z.number().min(0).max(100),
      base: z.number(),
      amount: z.number(),
    })
  ),
})

// Agent-supplied extraction: accountSuggestion is preserved instead of forced
// to null. Agents (unlike AI extractors) can reliably assign a BAS expense
// account; the regex enforces the class-4-7 range required for cost accounts.
export const AgentExtractionSchema = ExtractionSchema.omit({ lineItems: true }).extend({
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number().nullable(),
      lineTotal: z.number(),
      vatRate: z.number().min(0).max(100).nullable(),
      accountSuggestion: z.string().regex(/^[4-7]\d{3}$/).nullable(),
    })
  ),
})

const SYSTEM_PROMPT = `You extract invoice and receipt fields from a single document for a Swedish accounting system.

Return ONLY a single JSON object that matches this schema exactly. No prose, no markdown fences, no commentary.

{
  "documentKind": "receipt" | "supplier_invoice" | "government_letter" | "other" | null,
  "merchantCategory": "restaurant" | "cafe" | "taxi" | "parking" | "fuel" | "grocery" | "hotel" | "other" | null,
  "legibility": "good" | "partial" | "unreadable",
  "purchaseTime": string | null,   // "HH:MM" 24h, receipts only
  "payment": { "method": "card" | "swish" | "cash" | "invoice" | "other" | null, "cardLast4": string | null } | null,
  "supplier": {
    "name": string | null,
    "orgNumber": string | null,    // 10 digits, no hyphen, only when issued by a Swedish entity
    "vatNumber": string | null,    // ISO format, e.g. "SE556012579001" or "DE123456789"
    "address": string | null,      // multi-line allowed
    "bankgiro": string | null,     // Swedish bankgiro, with hyphen, e.g. "991-2346"
    "plusgiro": string | null      // Swedish plusgiro, with hyphen, e.g. "12345-6"
  },
  "invoice": {
    "invoiceNumber": string | null,    // include any suffix, e.g. "06655767-0007"
    "invoiceDate": string | null,      // ISO date YYYY-MM-DD
    "dueDate": string | null,          // ISO date YYYY-MM-DD
    "paymentReference": string | null, // OCR / payment reference
    "currency": string,                // ISO 4217 (SEK, USD, EUR, ...). Default "SEK" only if truly indeterminate.
    "servicePeriodStart": string | null, // ISO date: start of the service/coverage window the invoice charges for
    "servicePeriodEnd": string | null    // ISO date: end of that window
  },
  "lineItems": [
    {
      "description": string,
      "quantity": number,
      "unitPrice": number | null,
      "lineTotal": number,
      "vatRate": number | null,         // percent integer: 25, 12, 6, or 0. Same convention as vatBreakdown.rate.
      "accountSuggestion": null         // always null: leave Swedish BAS suggestion to the user
    }
  ],
  "totals": {
    "subtotal": number | null,    // amount excluding VAT
    "vatAmount": number | null,   // total VAT
    "total": number | null,       // amount including VAT: what the buyer actually pays
    "roundingAmount": number | null  // öresavrundning line, may be negative, e.g. -0.37
  },
  "vatBreakdown": [
    { "rate": number, "base": number, "amount": number }   // rate as percent integer, e.g. 25 for 25%
  ]
}

VAT rate convention: BOTH lineItems[].vatRate AND vatBreakdown[].rate use the same percent-integer format (25, 12, 6, 0). Never use the decimal form (0.25, 0.12).

Rules:
- Output JSON only. The first character must be '{' and the last must be '}'.
- documentKind: "receipt" = point-of-sale proof of a COMPLETED payment (kassakvitto, kortkvitto, taxi/parking slip, webshop order confirmation marked paid). "supplier_invoice" = a request for payment (has due date, OCR/payment reference, bankgiro, "Att betala senast"). "government_letter" = correspondence from a myndighet (Skatteverket, Bolagsverket, Försäkringskassan...). "other" = contracts, statements, reports. null only when truly indeterminate.
- merchantCategory: judge from the merchant name and line items (a receipt from "Prinsen" listing food and wine is "restaurant" even without the word). Use "other" when unsure. null for non-receipts.
- legibility: "good" = all key amounts and the merchant are readable. "partial" = some key fields are cut off, blurry, or unreadable. "unreadable" = the document is mostly illegible (too blurry/dark/small). Judge the IMAGE quality, not whether fields exist on the document.
- payment: only for documents that show how payment was made. "card" for kort/VISA/Mastercard; cardLast4 only when a masked card number like ****1234 is printed. "invoice" means the document says it will be billed separately.
- purchaseTime: the HH:MM time printed on a receipt. null when absent.
- Öresavrundning: Swedish receipts often show an "Avrundning"/"Öresavrundning" line. "total" is ALWAYS the amount actually paid AFTER rounding; put the rounding line in totals.roundingAmount (negative when rounded down). When present: subtotal + vatAmount + roundingAmount = total.
- Currency: detect from the document (symbol $/€/kr or explicit code). Use the ISO 4217 code. Do NOT default to SEK if the document clearly shows another currency.
- "total" is the amount the buyer must pay (look for "Att betala", "Total", "Amount paid", "Amount due", "Balance"). Prefer this over Subtotal.
- Dates: convert any format to YYYY-MM-DD. If the document only shows month/year, leave null.
- servicePeriodStart/servicePeriodEnd: only when the document explicitly states the period the charge covers ("Avtalsperiod", "Period", "Försäkringstid", "Subscription period", coverage dates). Never infer from invoice/due dates. Month-only boundaries map to the first resp. last day of the month.
- Bankgiro/Plusgiro: only set when the document is for a Swedish supplier on a Swedish bank rail. Do not invent.
- Org.nr: only set when it is an actual Swedish organisation number (10 digits, Luhn-valid). For US/EU companies leave null even if they list an EIN/VAT number.
- VAT number: include the country prefix.
- Numbers: parse with the document's locale (Swedish "1 234,56" = 1234.56; English "$1,234.56" = 1234.56). Output as plain JSON numbers.
- If a field is missing or unreadable, set it to null. Never invent values.
- lineItems: include every line. Empty array is fine if the document has no itemised lines.
- vatBreakdown: include one entry per distinct VAT rate. Empty array is fine.`

// Sonnet 5 intermittently wraps its answer in markdown fences (```json ... ```)
// or adds prose around it, despite the JSON-only instruction in the system
// prompt. Scan for balanced top-level '{'..'}' candidates (string- and
// escape-aware, so braces inside JSON string values don't end a candidate
// early) and return the first one JSON.parse accepts; prose braces around the
// object form unparseable candidates and are skipped. Returns the input
// unchanged when no candidate parses, so the existing parse-failure path
// handles prose-only refusals. Zod validation downstream still rejects
// well-formed-but-wrong JSON.
// Bounds for the candidate scan below. Real model output is already capped
// by MAX_TOKENS (roughly 33 KB of text at 8192 tokens), so genuine responses
// never come near these; they exist so pathological or adversarially
// brace-laden text cannot make the scan quadratic (compliance review
// A.8.28). Oversized or exhausted inputs fall through to the raw text and
// land in the existing empty-result path.
const MAX_SCAN_INPUT_LENGTH = 256 * 1024
const MAX_CANDIDATE_ATTEMPTS = 50

export function extractJsonObject(raw: string): string {
  if (raw.length > MAX_SCAN_INPUT_LENGTH) return raw
  let attempts = 0
  let start = raw.indexOf('{')
  while (start !== -1 && attempts < MAX_CANDIDATE_ATTEMPTS) {
    attempts++
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
      } else if (ch === '"') {
        inString = true
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1)
          try {
            JSON.parse(candidate)
            return candidate
          } catch {
            break
          }
        }
      }
    }
    start = raw.indexOf('{', start + 1)
  }
  return raw
}

export function emptyResult(): InvoiceExtractionResult {
  return {
    documentKind: null,
    merchantCategory: null,
    legibility: null,
    purchaseTime: null,
    payment: null,
    supplier: {
      name: null,
      orgNumber: null,
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
    },
    invoice: {
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      paymentReference: null,
      currency: 'SEK',
      servicePeriodStart: null,
      servicePeriodEnd: null,
    },
    lineItems: [],
    totals: { subtotal: null, vatAmount: null, total: null, roundingAmount: null },
    vatBreakdown: [],
    confidence: 0,
  }
}

// Anthropic rejects images above 5 MB (decoded bytes), and 12 MP phone photos
// routinely exceed that: before this step they errored out to an empty
// extraction. Downscaling to ≤2000px JPEG also cuts input tokens on every
// large image. HEIC/HEIF (iPhone default) is transcoded to JPEG when the
// local sharp/libvips build can decode it; prebuilt binaries usually cannot
// (patent licensing), in which case the caller falls through to the
// unsupported-type path exactly as before.
const IMAGE_DOWNSCALE_THRESHOLD_BYTES = 4 * 1024 * 1024
const IMAGE_MAX_DIMENSION = 2000

async function normalizeImageForExtraction(
  input: ExtractionInput
): Promise<ExtractionInput> {
  const isHeic = input.mimeType === 'image/heic' || input.mimeType === 'image/heif'
  const isLargeSupportedImage =
    input.mimeType.startsWith('image/') &&
    SUPPORTED_MEDIA_TYPES.has(input.mimeType) &&
    input.buffer.byteLength > IMAGE_DOWNSCALE_THRESHOLD_BYTES
  if (!isHeic && !isLargeSupportedImage) return input

  try {
    // Lazy import: sharp is a native module and only a fraction of
    // extractions need it; loading it at module scope would tax every
    // cold start of the extension route bundle.
    const sharp = (await import('sharp')).default
    const converted = await sharp(input.buffer)
      // Apply the EXIF orientation before it is lost in re-encoding:
      // phone photos are routinely stored rotated.
      .rotate()
      .resize({
        width: IMAGE_MAX_DIMENSION,
        height: IMAGE_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 80 })
      .toBuffer()
    return { buffer: converted, mimeType: 'image/jpeg', fileName: input.fileName }
  } catch (err) {
    // HEIC without libheif lands here → caller hits the unsupported-type
    // guard, same net behavior as before this step existed. For oversized
    // JPEG/PNG the original buffer is still worth attempting.
    log.warn('image normalization failed', {
      file_name_hash: createHash('sha256').update(input.fileName).digest('hex').slice(0, 12),
      mime_type: input.mimeType,
      byte_length: input.buffer.byteLength,
      error: err instanceof Error ? err.message : String(err),
    })
    return input
  }
}

// Cap the text handed to the model. HTML mails can carry hundreds of KB of
// framework markup; the invoice fields sit in the first fraction of the
// visible text, and MAX_TOKENS bounds the output side anyway.
const MAX_EXTRACTION_TEXT_LENGTH = 50_000

/**
 * Best-effort HTML-to-text for mail-body invoices. Not a sanitiser (the
 * output is only ever sent to the model as plain text, never rendered):
 * drops script/style/head blocks and comments, keeps block boundaries as
 * newlines so amounts and labels stay line-separated, decodes the entities
 * that occur in practice, and collapses whitespace.
 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|tr|li|h[1-6]|table|thead|tbody|section|article|blockquote|pre)\s*>/gi, '\n')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
  const stripped = withBreaks.replace(/<[^>]+>/g, ' ')
  const decoded = stripped
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n)
      return code > 31 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => {
      const code = parseInt(n, 16)
      return code > 31 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
    })
    // &amp; strictly last: decoding it earlier would double-decode
    // "&amp;lt;" into "<" instead of the literal "&lt;".
    .replace(/&amp;/gi, '&')
  return decoded
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_EXTRACTION_TEXT_LENGTH)
}

function buildContent(input: ExtractionInput) {
  if (input.mimeType === 'text/html') {
    const text = htmlToText(input.buffer.toString('utf8'))
    return [
      {
        type: 'text' as const,
        text: `The document is an HTML email invoice, converted to plain text:\n\n${text}`,
      },
      { type: 'text' as const, text: 'Extract the fields per the schema. JSON only.' },
    ]
  }
  const base64 = input.buffer.toString('base64')
  if (input.mimeType === 'application/pdf') {
    return [
      {
        type: 'document' as const,
        source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 },
      },
      { type: 'text' as const, text: 'Extract the fields per the schema. JSON only.' },
    ]
  }
  return [
    {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: input.mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
        data: base64,
      },
    },
    { type: 'text' as const, text: 'Extract the fields per the schema. JSON only.' },
  ]
}

/**
 * Extract invoice fields by sending the document directly to Claude
 * Sonnet 4.6 via AWS Bedrock. Never throws on extraction failure:
 * always returns an InvoiceExtractionResult. Empty fields are null.
 */
export async function extractInvoiceFields(
  rawInput: ExtractionInput
): Promise<ExtractionOutput> {
  // Transcodes HEIC when possible and downscales oversized images; a no-op
  // for PDFs and normal-sized supported images.
  const input = await normalizeImageForExtraction(rawInput)

  if (!SUPPORTED_MEDIA_TYPES.has(input.mimeType)) {
    return { data: emptyResult(), rawText: null }
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    log.warn('AWS Bedrock credentials missing: returning empty extraction', {
      file_name_hash: createHash('sha256').update(input.fileName).digest('hex').slice(0, 12),
    })
    return { data: emptyResult(), rawText: null }
  }

  const client = new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION || 'eu-north-1',
    awsAccessKey: process.env.AWS_ACCESS_KEY_ID,
    awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY,
  })

  let rawText: string | null = null
  try {
    // SYSTEM_PROMPT is byte-stable per deploy and ~3.5 KB: marking it as
    // ephemeral lets Bedrock reuse the prompt-cache on rapid sequential
    // extractions (e.g. a user uploading a stack of receipts within minutes).
    // Bedrock supports `{ type: 'ephemeral' }` with the default short TTL;
    // the 1h TTL from the agent-native API plan (item 10) requires the direct
    // Anthropic API rather than Bedrock and is out of scope here.
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildContent(input) }],
    })

    rawText = resp.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim()

    // Observability for the prompt-cache hit ratio. The agent-native plan
    // targets cache_read_input_tokens / total_input_tokens ≥ 0.85 in steady
    // state; logging here makes that measurable without a separate dashboard.
    const usage = resp.usage as
      | {
          input_tokens?: number
          output_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      | undefined
    if (usage) {
      // Raw fileName can constitute personal data (e.g. "faktura_Sven_Andersson.pdf").
      // Log a short hash so the operator can correlate without exposing PII
      // to the log destination (GDPR Art. 5(1)(f)).
      const fileNameHash = createHash('sha256').update(input.fileName).digest('hex').slice(0, 12)
      log.info('ai_extraction_usage', {
        file_name_hash: fileNameHash,
        mime_type: input.mimeType,
        input_tokens: usage.input_tokens ?? null,
        output_tokens: usage.output_tokens ?? null,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
      })
    }

    const parsed = JSON.parse(extractJsonObject(rawText))
    const validated = ExtractionSchema.parse(parsed)

    return {
      // accountSuggestion is null at this point, enforced by the schema's
      // .transform, so no post-validation coercion is needed.
      data: { ...validated, confidence: 1 },
      rawText,
    }
  } catch (err) {
    log.warn('AI extraction failed', {
      file_name_hash: createHash('sha256').update(input.fileName).digest('hex').slice(0, 12),
      mimeType: input.mimeType,
      error: err instanceof Error ? err.message : String(err),
      hasRawText: rawText != null,
    })
    return { data: emptyResult(), rawText }
  }
}
