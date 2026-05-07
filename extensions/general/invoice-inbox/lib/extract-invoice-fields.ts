// AI-driven invoice/receipt field extraction.
//
// Sends the uploaded document directly to Claude Sonnet 4.6 via AWS
// Bedrock and asks for a structured InvoiceExtractionResult JSON. Sonnet
// reads PDFs, images, and scans natively, which the previous regex
// extractor couldn't — that's why English receipts (Anthropic, AWS,
// Stripe, …) and image-only PDFs came back empty.
//
// The AI output is validated against a Zod schema; anything that doesn't
// parse falls back to an empty result so the inbox row still lands and
// the user can fill the fields in manually.

import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import { z } from 'zod'
import type { InvoiceExtractionResult } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoice-inbox-extract')

const MODEL = 'eu.anthropic.claude-sonnet-4-6'
// 4096 covers a 10-15 line invoice plus VAT breakdown comfortably. The JSON
// skeleton alone is ~200 tokens; 1500 left only ~1300 for content and
// silently truncated complex documents (response cut mid-JSON →
// JSON.parse throws → row lands with all-null fields).
const MAX_TOKENS = 4096

// Bedrock supports these document/image media types directly. HEIC/HEIF
// are not on the list, so we skip AI for those — the inbox row still
// lands and the user can edit fields manually or replace the file.
const SUPPORTED_MEDIA_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
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

const ExtractionSchema = z.object({
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
  }),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number().nullable(),
      lineTotal: z.number(),
      // Sane range for any real-world VAT rate. We allow non-Swedish rates
      // (UK 20, DE 19, NO 25, ...) since gnubok stores foreign invoices
      // for reference; the strict Swedish allowlist applies later when the
      // user converts to a supplier invoice.
      vatRate: z.number().min(0).max(100).nullable(),
      // accountSuggestion is forcibly null at parse time — we never
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
  }),
  vatBreakdown: z.array(
    z.object({
      rate: z.number().min(0).max(100),
      base: z.number(),
      amount: z.number(),
    })
  ),
})

const SYSTEM_PROMPT = `You extract invoice and receipt fields from a single document for a Swedish accounting system.

Return ONLY a single JSON object that matches this schema exactly. No prose, no markdown fences, no commentary.

{
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
    "currency": string                 // ISO 4217 (SEK, USD, EUR, ...). Default "SEK" only if truly indeterminate.
  },
  "lineItems": [
    {
      "description": string,
      "quantity": number,
      "unitPrice": number | null,
      "lineTotal": number,
      "vatRate": number | null,         // percent integer: 25, 12, 6, or 0. Same convention as vatBreakdown.rate.
      "accountSuggestion": null         // always null — leave Swedish BAS suggestion to the user
    }
  ],
  "totals": {
    "subtotal": number | null,    // amount excluding VAT
    "vatAmount": number | null,   // total VAT
    "total": number | null        // amount including VAT — what the buyer pays
  },
  "vatBreakdown": [
    { "rate": number, "base": number, "amount": number }   // rate as percent integer, e.g. 25 for 25%
  ]
}

VAT rate convention: BOTH lineItems[].vatRate AND vatBreakdown[].rate use the same percent-integer format (25, 12, 6, 0). Never use the decimal form (0.25, 0.12).

Rules:
- Output JSON only. The first character must be '{' and the last must be '}'.
- Currency: detect from the document (symbol $/€/kr or explicit code). Use the ISO 4217 code. Do NOT default to SEK if the document clearly shows another currency.
- "total" is the amount the buyer must pay (look for "Att betala", "Total", "Amount paid", "Amount due", "Balance"). Prefer this over Subtotal.
- Dates: convert any format to YYYY-MM-DD. If the document only shows month/year, leave null.
- Bankgiro/Plusgiro: only set when the document is for a Swedish supplier on a Swedish bank rail. Do not invent.
- Org.nr: only set when it is an actual Swedish organisation number (10 digits, Luhn-valid). For US/EU companies leave null even if they list an EIN/VAT number.
- VAT number: include the country prefix.
- Numbers: parse with the document's locale (Swedish "1 234,56" = 1234.56; English "$1,234.56" = 1234.56). Output as plain JSON numbers.
- If a field is missing or unreadable, set it to null. Never invent values.
- lineItems: include every line. Empty array is fine if the document has no itemised lines.
- vatBreakdown: include one entry per distinct VAT rate. Empty array is fine.`

function emptyResult(): InvoiceExtractionResult {
  return {
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
    },
    lineItems: [],
    totals: { subtotal: null, vatAmount: null, total: null },
    vatBreakdown: [],
    confidence: 0,
  }
}

function buildContent(input: ExtractionInput) {
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
 * Sonnet 4.6 via AWS Bedrock. Never throws on extraction failure —
 * always returns an InvoiceExtractionResult. Empty fields are null.
 */
export async function extractInvoiceFields(
  input: ExtractionInput
): Promise<ExtractionOutput> {
  if (!SUPPORTED_MEDIA_TYPES.has(input.mimeType)) {
    return { data: emptyResult(), rawText: null }
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    log.warn('AWS Bedrock credentials missing — returning empty extraction', {
      fileName: input.fileName,
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
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildContent(input) }],
    })

    rawText = resp.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim()

    const parsed = JSON.parse(rawText)
    const validated = ExtractionSchema.parse(parsed)

    return {
      // accountSuggestion is null at this point — enforced by the schema's
      // .transform — so no post-validation coercion is needed.
      data: { ...validated, confidence: 1 },
      rawText,
    }
  } catch (err) {
    log.warn('AI extraction failed', {
      fileName: input.fileName,
      mimeType: input.mimeType,
      error: err instanceof Error ? err.message : String(err),
      hasRawText: rawText != null,
    })
    return { data: emptyResult(), rawText }
  }
}
