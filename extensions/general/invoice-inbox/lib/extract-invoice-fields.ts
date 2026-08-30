// AI-driven invoice/receipt field extraction.
//
// Sends the uploaded document to the configured AI backend through the
// job-shaped service in lib/ai (Claude on Bedrock or the direct API on
// hosted; any OpenAI-compatible endpoint, e.g. a Swedish inference provider,
// on a sovereign self-host) and asks for a structured InvoiceExtractionResult
// JSON. Vision models read PDFs, images and scans, which the previous regex
// extractor couldn't: that's why English receipts (Anthropic, AWS, Stripe, …)
// and image-only PDFs came back empty.
//
// The AI output is validated against a Zod schema; anything that doesn't
// parse falls back to an empty result so the inbox row still lands and
// the user can fill the fields in manually.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { InvoiceExtractionResult } from '@/types'
import { getAiService, readAiConfig, extractJsonObject } from '@/lib/ai'
import type { AiDocumentInput, AiImageMediaType, ExtractionSkipReason } from '@/lib/ai'
import { createLogger } from '@/lib/logger'

// Re-exported for callers and tests that import it from here.
export { extractJsonObject }

const log = createLogger('invoice-inbox-extract')

// Output cap: AI_EXTRACTION_MAX_TOKENS (legacy BEDROCK_MAX_TOKENS) or 8192,
// enough headroom for invoices with 20+ line items. The model id per tier is
// resolved by lib/ai/config.ts (AI_EXTRACTION_MODEL, legacy BEDROCK_MODEL_ID,
// AI_MODEL, then the Claude default on the Anthropic family).

// Media types the extraction accepts. HEIC/HEIF are not on the list, so we
// skip AI for those: the inbox row still lands and the user can edit fields
// manually or replace the file. text/html (mail-body invoices from the
// inbound pipeline) is not sent as a document block: it is converted to plain
// text via htmlToText() first, which also makes it work on text-only models.
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

export type ExtractionSkipped = ExtractionSkipReason | 'unsupported_media'

export interface ExtractionOutput {
  data: InvoiceExtractionResult
  /** The raw JSON string returned by the model, or null on failure/skip. */
  rawText: string | null
  /** Provider-form id of the model that answered, when a call was made. */
  model?: string | null
  /** Set when no model call was made at all (and why). */
  skipped?: ExtractionSkipped | null
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
  // Amounts visible on non-invoice documents (bankintyg, avtal, contracts)
  // that carry no invoice-style total. Matching hint only; never booked.
  // .catch([]) so a hallucinated shape degrades to "no amounts" instead of
  // failing the whole document parse; optional so cached raw outputs from
  // before the field existed still validate.
  prominentAmounts: z
    .array(
      z.object({
        amount: z.number(),
        label: z.string().nullable(),
      })
    )
    .catch([])
    .optional(),
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
  ],
  "prominentAmounts": [
    { "amount": number, "label": string | null }   // non-invoice documents only, see rules
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
- vatBreakdown: include one entry per distinct VAT rate. Empty array is fine.
- prominentAmounts: ONLY when totals.total is null AND the document still displays clear monetary amounts (a price, fee, deposit or paid-in sum: "Engångspris", "Anslutningspris", "Insatt belopp", "Månadspris", "Pris", "Belopp"). Typical sources: bankintyg, bank/account agreements, contracts, statements. One entry per distinct amount, label = the document's own label for it. NEVER include account numbers, org numbers, phone numbers, OCR/reference numbers, dates, percentages, or zero amounts. Empty array for ordinary invoices and receipts.`

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
    prominentAmounts: [],
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

const EXTRACTION_INSTRUCTION = 'Extract the fields per the schema. JSON only.'

/** Map an upload to the service's document input. HTML becomes plain text. */
function toDocumentInput(input: ExtractionInput): AiDocumentInput {
  if (input.mimeType === 'text/html') {
    const text = htmlToText(input.buffer.toString('utf8'))
    return {
      kind: 'text',
      text: `The document is an HTML email invoice, converted to plain text:\n\n${text}`,
    }
  }
  if (input.mimeType === 'application/pdf') {
    return { kind: 'pdf', data: input.buffer, fileName: input.fileName }
  }
  return { kind: 'image', data: input.buffer, mediaType: input.mimeType as AiImageMediaType }
}

// Hand-maintained JSON-schema mirror of ExtractionSchema, used ONLY when the
// operator opts into strict JSON mode on an OpenAI-compatible endpoint
// (AI_STRICT_JSON=true). Deliberately not auto-converted from the Zod schema:
// .catch()/.transform() have no JSON-schema equivalent and the conversion
// would drift silently. Permissive on purpose (types + nullability only):
// Zod stays the validator, this just keeps the model inside the shape.
const nullable = (type: string) => ({ type: [type, 'null'] })
const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    documentKind: nullable('string'),
    merchantCategory: nullable('string'),
    legibility: nullable('string'),
    purchaseTime: nullable('string'),
    payment: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: { method: nullable('string'), cardLast4: nullable('string') },
      required: ['method', 'cardLast4'],
    },
    supplier: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: nullable('string'),
        orgNumber: nullable('string'),
        vatNumber: nullable('string'),
        address: nullable('string'),
        bankgiro: nullable('string'),
        plusgiro: nullable('string'),
      },
      required: ['name', 'orgNumber', 'vatNumber', 'address', 'bankgiro', 'plusgiro'],
    },
    invoice: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoiceNumber: nullable('string'),
        invoiceDate: nullable('string'),
        dueDate: nullable('string'),
        paymentReference: nullable('string'),
        currency: { type: 'string' },
        servicePeriodStart: nullable('string'),
        servicePeriodEnd: nullable('string'),
      },
      required: [
        'invoiceNumber',
        'invoiceDate',
        'dueDate',
        'paymentReference',
        'currency',
        'servicePeriodStart',
        'servicePeriodEnd',
      ],
    },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          quantity: { type: 'number' },
          unitPrice: nullable('number'),
          lineTotal: { type: 'number' },
          vatRate: nullable('number'),
          accountSuggestion: { type: 'null' },
        },
        required: ['description', 'quantity', 'unitPrice', 'lineTotal', 'vatRate', 'accountSuggestion'],
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subtotal: nullable('number'),
        vatAmount: nullable('number'),
        total: nullable('number'),
        roundingAmount: nullable('number'),
      },
      required: ['subtotal', 'vatAmount', 'total', 'roundingAmount'],
    },
    vatBreakdown: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { rate: { type: 'number' }, base: { type: 'number' }, amount: { type: 'number' } },
        required: ['rate', 'base', 'amount'],
      },
    },
    prominentAmounts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { amount: { type: 'number' }, label: nullable('string') },
        required: ['amount', 'label'],
      },
    },
  },
  required: [
    'documentKind',
    'merchantCategory',
    'legibility',
    'purchaseTime',
    'payment',
    'supplier',
    'invoice',
    'lineItems',
    'totals',
    'vatBreakdown',
    'prominentAmounts',
  ],
}

/**
 * Extract invoice fields by sending the document to the configured AI
 * backend. Never throws on extraction failure: always returns an
 * InvoiceExtractionResult. Empty fields are null. `skipped` is set when no
 * model call was made (unsupported file type, AI not configured, no vision
 * on this backend, PDF rasterizer missing), so callers can tell "nothing to
 * read" from "read and found nothing".
 */
export async function extractInvoiceFields(
  rawInput: ExtractionInput
): Promise<ExtractionOutput> {
  // Transcodes HEIC when possible and downscales oversized images; a no-op
  // for PDFs and normal-sized supported images.
  const input = await normalizeImageForExtraction(rawInput)

  if (!SUPPORTED_MEDIA_TYPES.has(input.mimeType)) {
    return { data: emptyResult(), rawText: null, skipped: 'unsupported_media' }
  }

  const fileNameHash = createHash('sha256').update(input.fileName).digest('hex').slice(0, 12)
  const service = getAiService()

  let rawText: string | null = null
  let model: string | null = null
  try {
    const baseMaxTokens = readAiConfig().extractionMaxTokens
    const request = {
      document: toDocumentInput(input),
      system: SYSTEM_PROMPT,
      instruction: EXTRACTION_INSTRUCTION,
      jsonSchema: EXTRACTION_JSON_SCHEMA,
    }
    let result = await service.extractFromDocument({ ...request, maxTokens: baseMaxTokens })
    if (!result.ok) {
      // Not a failure: the deployment cannot read this document at all.
      // `ai_unconfigured` is the self-host "no key yet" case the 30 s
      // upload hang used to hide; the others are honest capability gaps.
      log.warn('AI extraction skipped', { file_name_hash: fileNameHash, reason: result.skipped })
      return { data: emptyResult(), rawText: null, skipped: result.skipped }
    }
    if (result.truncated) {
      // The output hit maxTokens mid-JSON (line-item-heavy documents). Left
      // alone this parsed to nothing and looked like an unreadable document;
      // one retry at double the cap recovers it. A second truncation falls
      // through to the normal parse path, which fails visibly in the log
      // below instead of silently.
      log.warn('ai_extraction_truncated', {
        file_name_hash: fileNameHash,
        max_tokens: baseMaxTokens,
        retrying: true,
      })
      // A retry that THROWS (throttle, network) must not sink the first
      // response: its text may still parse despite the truncation flag, and
      // the outer catch would otherwise return the empty skeleton with
      // rawText null. Swallow locally and continue with the first result.
      try {
        const retry = await service.extractFromDocument({
          ...request,
          maxTokens: baseMaxTokens * 2,
        })
        if (retry.ok) {
          result = retry
          if (retry.truncated) {
            log.warn('ai_extraction_truncated', {
              file_name_hash: fileNameHash,
              max_tokens: baseMaxTokens * 2,
              retrying: false,
            })
          }
        }
      } catch (retryErr) {
        log.warn('ai_extraction_retry_failed', {
          file_name_hash: fileNameHash,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        })
      }
    }
    rawText = result.text
    model = result.model

    // Observability for the prompt-cache hit ratio. The agent-native plan
    // targets cache_read_input_tokens / total_input_tokens ≥ 0.85 in steady
    // state; logging here makes that measurable without a separate dashboard.
    // Raw fileName can constitute personal data (e.g. "faktura_Sven_Andersson.pdf").
    // Log a short hash so the operator can correlate without exposing PII
    // to the log destination (GDPR Art. 5(1)(f)).
    log.info('ai_extraction_usage', {
      file_name_hash: fileNameHash,
      mime_type: input.mimeType,
      model,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_creation_input_tokens: result.usage.cacheCreationInputTokens,
      cache_read_input_tokens: result.usage.cacheReadInputTokens,
      ...(result.pagesRasterized ? { pages_rasterized: result.pagesRasterized } : {}),
    })

    const parsed = JSON.parse(extractJsonObject(rawText))
    const validated = ExtractionSchema.parse(parsed)

    return {
      // accountSuggestion is null at this point, enforced by the schema's
      // .transform, so no post-validation coercion is needed.
      data: { ...validated, confidence: 1 },
      rawText,
      model,
    }
  } catch (err) {
    log.warn('AI extraction failed', {
      file_name_hash: fileNameHash,
      mimeType: input.mimeType,
      error: err instanceof Error ? err.message : String(err),
      hasRawText: rawText != null,
    })
    return { data: emptyResult(), rawText, model }
  }
}
