import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  EXTRACTION_DEADLINE_MS,
  extractInvoiceFields,
  extractJsonObject,
  stripOwnCompanyAsSupplier,
  dropMalformedVatNumber,
  emptyResult,
} from '@/lib/documents/inbox-extraction/extract-invoice-fields'
import { APIError } from '@anthropic-ai/sdk'

// Mock the Bedrock SDK so tests drive the JSON parser without
// network/credential needs.
const mockCreate = vi.fn()

vi.mock('@anthropic-ai/bedrock-sdk', () => {
  class FakeBedrock {
    messages = { create: mockCreate }
  }
  return { default: FakeBedrock }
})

// sharp is imported lazily by normalizeImageForExtraction. The default mock
// (no implementation → TypeError on .rotate()) mimics a build without HEIF
// support: normalization fails, the original buffer flows on. Individual
// tests install a working chain via sharpMock.mockImplementationOnce.
const sharpMock = vi.fn()
vi.mock('sharp', () => ({
  default: (...args: unknown[]) => sharpMock(...args),
}))

// The shared fitter falls back to heic-convert when sharp cannot read HEIC.
// The default mock fails like a build without the decoder.
const heicConvertMock = vi.fn((_opts: unknown): Promise<ArrayBuffer> => Promise.reject(new Error('no decoder')))
vi.mock('heic-convert', () => ({
  default: (opts: unknown) => heicConvertMock(opts),
}))

function workingSharpChain(outputBuffer: Buffer) {
  const chain = {
    rotate: vi.fn(() => chain),
    resize: vi.fn(() => chain),
    flatten: vi.fn(() => chain),
    jpeg: vi.fn(() => chain),
    toBuffer: vi.fn().mockResolvedValue(outputBuffer),
  }
  return chain
}

const ORIG_AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
const ORIG_AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY

function aiResponse(json: string | object) {
  const text = typeof json === 'string' ? json : JSON.stringify(json)
  return Promise.resolve({
    content: [{ type: 'text', text }],
  })
}

const VALID_RESULT = {
  supplier: {
    name: 'Anthropic, PBC',
    orgNumber: null,
    vatNumber: null,
    address: '548 Market Street, San Francisco, CA 94104',
    bankgiro: null,
    plusgiro: null,
    iban: null,
    bic: null,
  },
  invoice: {
    invoiceNumber: '06655767-0007',
    invoiceDate: '2026-02-13',
    dueDate: null,
    paymentReference: null,
    currency: 'USD',
  },
  lineItems: [
    {
      description: 'One-time credit purchase',
      quantity: 1,
      unitPrice: 5,
      lineTotal: 5,
      vatRate: 25,
      accountSuggestion: null,
    },
  ],
  totals: { subtotal: 5, vatAmount: 1.25, total: 6.25 },
  vatBreakdown: [{ rate: 25, base: 5, amount: 1.25 }],
}

describe('extractInvoiceFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AWS_ACCESS_KEY_ID = 'test-key'
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
  })

  it('returns empty result for unsupported mime type (HEIC)', async () => {
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from(''),
      mimeType: 'image/heic',
      fileName: 'photo.heic',
    })
    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
    expect(data.supplier.name).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns empty result and skips API when AWS creds are missing', async () => {
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.totals.total).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('parses a valid AI response into InvoiceExtractionResult', async () => {
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'anthropic-receipt.pdf',
    })
    expect(rawText).toContain('Anthropic')
    expect(data.supplier.name).toBe('Anthropic, PBC')
    expect(data.invoice.currency).toBe('USD')
    expect(data.invoice.invoiceNumber).toBe('06655767-0007')
    expect(data.totals.total).toBe(6.25)
    expect(data.vatBreakdown).toHaveLength(1)
    expect(data.lineItems).toHaveLength(1)
    expect(data.confidence).toBe(1)
  })

  it('promotes a single prominent amount into the editable total (bankintyg/avtal)', async () => {
    // Zero amounts are noise ("Totalt månadspris: 0 kr"), so this document
    // still has exactly one meaningful figure and it becomes TOTALT.
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        documentKind: 'other',
        supplier: { ...VALID_RESULT.supplier, name: 'SEB' },
        invoice: { ...VALID_RESULT.invoice, invoiceNumber: null, currency: 'SEK' },
        lineItems: [],
        totals: { subtotal: null, vatAmount: null, total: null },
        vatBreakdown: [],
        prominentAmounts: [
          { amount: 0, label: 'Totalt månadspris' },
          { amount: 2500, label: 'Anslutnings-/Engångspris' },
        ],
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'affarsavtal.pdf',
    })
    expect(data.totals.total).toBe(2500)
    expect(data.totalSource).toBe('prominent')
    // The source list is preserved: matching demotes the promoted total back
    // through it, and re-extraction stays idempotent.
    expect(data.prominentAmounts).toEqual([
      { amount: 0, label: 'Totalt månadspris' },
      { amount: 2500, label: 'Anslutnings-/Engångspris' },
    ])
  })

  it('does not promote when the document shows several distinct amounts', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        documentKind: 'government_letter',
        lineItems: [],
        totals: { subtotal: null, vatAmount: null, total: null },
        vatBreakdown: [],
        prominentAmounts: [
          { amount: 4568, label: 'Arbetsgivaravgift' },
          { amount: 8151, label: 'Skatt' },
        ],
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'agi-besked.pdf',
    })
    expect(data.totals.total).toBeNull()
    expect(data.totalSource).toBeUndefined()
  })

  it('never promotes on invoices or receipts', async () => {
    // A receipt whose total was unreadable must not have a stray printed
    // figure laundered into its total.
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        documentKind: 'receipt',
        totals: { subtotal: null, vatAmount: null, total: null },
        prominentAmounts: [{ amount: 999, label: 'Pris' }],
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    expect(data.totals.total).toBeNull()
    expect(data.totalSource).toBeUndefined()
  })

  it('degrades a hallucinated prominentAmounts shape to an empty list, not a parse failure', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse({ ...VALID_RESULT, prominentAmounts: [{ amount: 'tjugofemtusen' }] })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    // The rest of the document still parses.
    expect(data.totals.total).toBe(6.25)
    expect(data.prominentAmounts).toEqual([])
  })

  it('validates a cached raw output from before prominentAmounts existed', async () => {
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.totals.total).toBe(6.25)
    expect(data.prominentAmounts).toBeUndefined()
  })

  it('sends image content for an image upload', async () => {
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('JPEG'),
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
    })
    const call = mockCreate.mock.calls[0][0]
    const content = call.messages[0].content
    expect(content[0].type).toBe('image')
    expect(content[0].source.media_type).toBe('image/jpeg')
  })

  it('tells the model that a receipt carries its purchase date in invoiceDate', async () => {
    // Prod, last 30 days as of 2026-09-08: supplier invoices lost invoiceDate
    // on 0.4% of items, receipts on 46% (75% via WhatsApp), while purchaseTime
    // was filled on nearly every one of those receipts. The field was described
    // as a bare ISO date under the invoice block, right next to a purchaseTime
    // rule marked "receipts only", and the model took the asymmetry literally.
    // Pin the receipt rule so a prompt edit cannot silently drop it again.
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('JPEG'),
      mimeType: 'image/jpeg',
      fileName: 'kvitto.jpg',
    })
    const call = mockCreate.mock.calls[0][0]
    const system: string =
      typeof call.system === 'string'
        ? call.system
        : call.system.map((block: { text: string }) => block.text).join('\n')
    expect(system).toContain(
      '"invoiceDate": string | null,      // ISO date YYYY-MM-DD: the invoice date, or on a receipt the purchase date printed on it'
    )
    expect(system).toContain('- invoiceDate on receipts: the purchase date printed on the receipt')
    expect(system).toContain('The field is NOT invoice-only')
  })

  it('tells the model that lineTotal excludes VAT, and how to convert a line printed incl. VAT', async () => {
    // Feedback seq 983757: a bill that printed its line only incl. VAT came
    // through with the gross in lineTotal, and every consumer (the inbox MCP
    // door, the web prefill) reads lineTotal as the net. Pin the rule.
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'faktura.pdf',
    })
    const call = mockCreate.mock.calls[0][0]
    const system: string =
      typeof call.system === 'string'
        ? call.system
        : call.system.map((block: { text: string }) => block.text).join('\n')
    expect(system).toContain('"lineTotal": number,              // the line amount EXCLUDING VAT')
    expect(system).toContain('- lineItems amounts: lineTotal and unitPrice are ALWAYS excluding VAT')
    expect(system).toContain('Never put an amount including VAT in lineTotal.')
  })

  it('tells the model which Swedish labels mean the due date and how a day-first date is written out (crm#1610)', async () => {
    // An invoice that printed only "Oss tillhanda: 25-11-2026" came back with
    // dueDate null, and the supplier's terms were booked in its place
    // (due_date_source "defaulted"). Pinned so a prompt edit cannot drop it.
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'faktura.pdf',
    })
    const call = mockCreate.mock.calls[0][0]
    const system: string =
      typeof call.system === 'string'
        ? call.system
        : call.system.map((block: { text: string }) => block.text).join('\n')
    expect(system).toContain('"dueDate": string | null,          // ISO date YYYY-MM-DD: when payment is due, see the dueDate rule')
    expect(system).toContain('- dueDate: the date the payment must reach the seller')
    for (const label of ['Förfallodatum', 'Oss tillhanda', 'Oss tillhanda senast', 'Betalas senast', 'Att betala senast']) {
      expect(system).toContain(`"${label}"`)
    }
    expect(system).toContain('25-11-2026, 25.11.2026 and 25/11/2026 are all 2026-11-25')
  })

  describe('the email the document arrived with (crm#1749)', () => {
    // A billing service printed "Date 11/7/26" month first; read day first
    // with nothing to say otherwise, the invoice landed four months early.
    const MAIL = {
      subject: 'Payment details for your purchase on Nov 7, 2026',
      receivedAt: '2026-11-07T07:41:00Z',
    }
    const systemOf = (call: { system: string | { text: string }[] }): string =>
      typeof call.system === 'string' ? call.system : call.system.map((block) => block.text).join('\n')
    const readWith = (invoiceDate: string, emailContext?: { subject?: string | null; receivedAt?: string | null }) => {
      mockCreate.mockReturnValueOnce(aiResponse({ ...VALID_RESULT, invoice: { ...VALID_RESULT.invoice, invoiceDate } }))
      return extractInvoiceFields({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', fileName: 'invoice.pdf', emailContext })
    }

    it('gives the model the received day and the subject after the document, the system prompt unchanged', async () => {
      await readWith('2026-11-07', MAIL)
      await readWith('2026-11-07')
      const [withMail, without] = mockCreate.mock.calls.map((c) => c[0])
      const tail = withMail.messages[0].content.at(-1)
      expect(tail.type).toBe('text')
      expect(tail.text).toContain('The mail reached the inbox on 2026-11-07.')
      expect(tail.text).toContain('"Payment details for your purchase on Nov 7, 2026"')
      expect(tail.text.endsWith('Extract the fields per the schema. JSON only.')).toBe(true)
      // Without a mail the request is the one it always was.
      expect(without.messages[0].content.at(-1).text).toBe('Extract the fields per the schema. JSON only.')
      // One cacheable system prompt for both, the same model and budget.
      expect(systemOf(withMail)).toBe(systemOf(without))
      expect(withMail.max_tokens).toBe(without.max_tokens)
      expect(withMail.model).toBe(without.model)
    })

    it('tells the model how to settle a numeric date that reads both ways, and to fall back to day first', async () => {
      await readWith('2026-11-07', MAIL)
      const system = systemOf(mockCreate.mock.calls[0][0])
      expect(system).toContain('- Ambiguous numeric dates: in a numeric date like 03/11/2026 or 11/7/26')
      expect(system).toContain('an invoice or receipt date is never after the day the mail arrived')
      expect(system).toContain('Only when none of these settles it, read day first as the dueDate rule says.')
    })

    it('reads an ambiguous 03/11/2026 as March when the mail arrived in March', async () => {
      const { data } = await readWith('2026-11-03', { receivedAt: '2026-03-12T08:00:00Z' })
      expect(data.invoice.invoiceDate).toBe('2026-03-11')
    })

    it('reads the same date as November when the mail arrived in November', async () => {
      const { data } = await readWith('2026-11-03', { receivedAt: '2026-11-05T08:00:00Z' })
      expect(data.invoice.invoiceDate).toBe('2026-11-03')
    })

    it('leaves a date that reads only one way as the model read it', async () => {
      const { data } = await readWith('2026-11-25', { receivedAt: '2026-03-12T08:00:00Z' })
      expect(data.invoice.invoiceDate).toBe('2026-11-25')
    })

    it('reads as today without an email', async () => {
      const { data } = await readWith('2026-11-03')
      expect(data.invoice.invoiceDate).toBe('2026-11-03')
      const { data: noDay } = await readWith('2026-11-03', { subject: 'Invoice', receivedAt: null })
      expect(noDay.invoice.invoiceDate).toBe('2026-11-03')
    })
  })

  it('tells the model to keep a hyphen at a line break inside an identifier', async () => {
    // Agent feedback seq 936092: an invoice number wrapped after a hyphen
    // ("...-202604-" / "0001") came back with the hyphen dropped, read as
    // word hyphenation. Pinned so a prompt edit cannot silently drop the rule.
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
    })
    const call = mockCreate.mock.calls[0][0]
    const system: string =
      typeof call.system === 'string'
        ? call.system
        : call.system.map((block: { text: string }) => block.text).join('\n')
    expect(system).toContain('KEEP a hyphen printed at the end of the first line')
    expect(system).toContain('never word hyphenation')
  })

  it('sends document content for a PDF upload', async () => {
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
    })
    const call = mockCreate.mock.calls[0][0]
    const content = call.messages[0].content
    expect(content[0].type).toBe('document')
    expect(content[0].source.media_type).toBe('application/pdf')
  })

  it('returns empty result when AI response is not valid JSON', async () => {
    mockCreate.mockReturnValueOnce(aiResponse('Sorry, I cannot read this PDF.'))
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(rawText).toBe('Sorry, I cannot read this PDF.')
    expect(data.totals.total).toBeNull()
    expect(data.supplier.name).toBeNull()
  })

  // ── Fenced / prefixed model output (Sonnet 5 regression, 2026-08) ──
  // Sonnet 5 intermittently wraps the JSON in markdown fences despite the
  // JSON-only instruction; a fifth of prod extractions came back empty
  // because JSON.parse saw the backticks.

  it('parses a response wrapped in ```json fences', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse('```json\n' + JSON.stringify(VALID_RESULT) + '\n```')
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    expect(data.supplier.name).toBe('Anthropic, PBC')
    expect(data.totals.total).toBe(6.25)
    expect(data.confidence).toBe(1)
  })

  it('parses a response wrapped in bare ``` fences', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse('```\n' + JSON.stringify(VALID_RESULT) + '\n```')
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    expect(data.totals.total).toBe(6.25)
    expect(data.confidence).toBe(1)
  })

  it('parses a response with prose before and after the JSON object', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse(
        'Here is the extracted data:\n```json\n' +
          JSON.stringify(VALID_RESULT) +
          '\n```\nLet me know if you need anything else.'
      )
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    expect(data.supplier.name).toBe('Anthropic, PBC')
    expect(data.confidence).toBe(1)
  })

  it('parses JSON when the surrounding prose itself contains braces', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse(
        'Note: fields use the shape {field: value}.\n```json\n' +
          JSON.stringify(VALID_RESULT) +
          '\n```\nAnything unclear {just ask}.'
      )
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    expect(data.supplier.name).toBe('Anthropic, PBC')
    expect(data.totals.total).toBe(6.25)
    expect(data.confidence).toBe(1)
  })

  it('handles braces inside JSON string values without ending the object early', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse(
        '```json\n' +
          JSON.stringify({
            ...VALID_RESULT,
            supplier: { ...VALID_RESULT.supplier, address: 'Suite {B}, "Main" St 1' },
          }) +
          '\n```'
      )
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    expect(data.supplier.address).toBe('Suite {B}, "Main" St 1')
    expect(data.confidence).toBe(1)
  })

  it('stays bounded on pathological brace-laden input and falls through unchanged', async () => {
    // 100k unclosed braces: without the attempt cap this would scan
    // quadratically; with it the helper bails fast and returns the input,
    // which then lands in the existing empty-result path.
    const pathological = '{'.repeat(100_000)
    const startedAt = performance.now()
    expect(extractJsonObject(pathological)).toBe(pathological)
    expect(performance.now() - startedAt).toBeLessThan(1_000)

    mockCreate.mockReturnValueOnce(aiResponse(pathological))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.totals.total).toBeNull()
    expect(data.confidence).toBe(0)
  })

  it('skips scanning entirely for oversized input', async () => {
    // Above the 256 KB cap the helper must not scan at all; the raw text
    // passes through unchanged even though it contains valid JSON.
    const oversized = 'x'.repeat(300 * 1024) + JSON.stringify(VALID_RESULT)
    expect(extractJsonObject(oversized)).toBe(oversized)
  })

  // ── deadline (2026-10-26: a Bedrock call that never answered held an
  // upload's deferred work until Vercel killed the function at 300 s) ──

  it('gives the reading one deadline: both calls carry the same signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify(VALID_RESULT).slice(0, 40) }],
        stop_reason: 'max_tokens',
      })
      .mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', fileName: 'f.pdf' })

    expect(timeout).toHaveBeenCalledTimes(1)
    expect(timeout).toHaveBeenCalledWith(EXTRACTION_DEADLINE_MS)
    expect(EXTRACTION_DEADLINE_MS).toBeLessThan(300_000)
    const signal = mockCreate.mock.calls[0][1]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(mockCreate.mock.calls[1][1]?.signal).toBe(signal)
    timeout.mockRestore()
  })

  it('ends a reading that never answers at the deadline with no reading instead of hanging', async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    // A call that only ends when its signal fires, as the SDK aborts a request.
    mockCreate.mockImplementationOnce(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')))
        }),
    )
    const pending = extractInvoiceFields({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', fileName: 'f.pdf' })
    await vi.waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    deadline.abort()
    const { data, rawText, failure } = await pending

    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
    expect(data.confidence).toBe(0)
    // A provider that stopped answering, not an unreadable document.
    expect(failure).toBe('provider_unavailable')
    timeout.mockRestore()
  })

  // ── max_tokens truncation retry (2026-08) ──────────────────
  // Line-item-heavy documents can blow the output cap; the truncated JSON
  // used to parse to nothing and look like an unreadable document.

  it('retries once with a doubled cap when the output was truncated at max_tokens', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify(VALID_RESULT).slice(0, 40) }],
        stop_reason: 'max_tokens',
      })
      .mockReturnValueOnce(aiResponse(VALID_RESULT))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'many-line-items.pdf',
    })
    expect(mockCreate).toHaveBeenCalledTimes(2)
    const firstMax = mockCreate.mock.calls[0][0].max_tokens
    expect(mockCreate.mock.calls[1][0].max_tokens).toBe(firstMax * 2)
    expect(data.totals.total).toBe(6.25)
    expect(data.confidence).toBe(1)
  })

  it('falls back to the empty result when the retry is truncated too', async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"lineItems":[{"desc' }],
        stop_reason: 'max_tokens',
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"lineItems":[{"description":"still cut' }],
        stop_reason: 'max_tokens',
      })
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'many-line-items.pdf',
    })
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(rawText).toBe('{"lineItems":[{"description":"still cut')
    expect(data.totals.total).toBeNull()
    expect(data.confidence).toBe(0)
  })

  it('keeps the first response when the retry call itself throws', async () => {
    // The truncated first answer happens to be complete valid JSON (the flag
    // can fire on the last token); a throttled retry must not discard it.
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify(VALID_RESULT) }],
        stop_reason: 'max_tokens',
      })
      .mockRejectedValueOnce(new Error('throttled'))
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'many-line-items.pdf',
    })
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(rawText).toBe(JSON.stringify(VALID_RESULT))
    expect(data.totals.total).toBe(6.25)
    expect(data.confidence).toBe(1)
  })

  it('does not retry when the answer completed under the cap', async () => {
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('returns empty result when AI response fails schema validation', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse({ supplier: { name: 'X' } /* missing required keys */ })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.totals.total).toBeNull()
    expect(data.supplier.name).toBeNull()
  })

  it('returns empty result when Bedrock throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('throttled'))
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
  })

  // ── failure classification (2026-10-26 Bedrock 503 outage) ──

  it('marks a Bedrock 503 as the provider being unavailable, not an unreadable document', async () => {
    mockCreate.mockRejectedValueOnce(
      APIError.generate(503, { message: 'Bedrock is unable to process your request.' }, undefined, new Headers()),
    )
    const result = await extractInvoiceFields({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', fileName: 'f.pdf' })
    expect(result.failure).toBe('provider_unavailable')
    expect(result.rawText).toBeNull()
    expect(result.data.totals.total).toBeNull()
    expect(result.skipped).toBeUndefined()
  })

  it('marks a refused document (400) as an error', async () => {
    mockCreate.mockRejectedValueOnce(
      APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'The PDF specified was not valid.' } }, undefined, new Headers()),
    )
    const { failure } = await extractInvoiceFields({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', fileName: 'f.pdf' })
    expect(failure).toBe('error')
  })

  it('marks an answer that does not parse as an error, whatever it says', async () => {
    mockCreate.mockReturnValueOnce(aiResponse('Bedrock is unable to process your request.'))
    const { failure, rawText } = await extractInvoiceFields({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', fileName: 'f.pdf' })
    expect(rawText).toBe('Bedrock is unable to process your request.')
    expect(failure).toBe('error')
  })

  it('sets no failure on a reading or a skip', async () => {
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    const read = await extractInvoiceFields({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf', fileName: 'f.pdf' })
    expect(read.failure).toBeUndefined()
    const skipped = await extractInvoiceFields({ buffer: Buffer.from(''), mimeType: 'application/zip', fileName: 'f.zip' })
    expect(skipped.skipped).toBe('unsupported_media')
    expect(skipped.failure).toBeUndefined()
  })

  it('forces accountSuggestion to null even if the model returns a value', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        lineItems: [
          {
            ...VALID_RESULT.lineItems[0],
            accountSuggestion: '5410', // model attempting BAS suggestion
          },
        ],
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.lineItems[0].accountSuggestion).toBeNull()
  })

  // ── Receipt-aware classification fields (2026-08) ──────────

  it('parses the classification fields when the model returns them', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        documentKind: 'receipt',
        merchantCategory: 'restaurant',
        legibility: 'good',
        purchaseTime: '12:41',
        payment: { method: 'card', cardLast4: '1234' },
        totals: { ...VALID_RESULT.totals, roundingAmount: -0.25 },
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    expect(data.documentKind).toBe('receipt')
    expect(data.merchantCategory).toBe('restaurant')
    expect(data.legibility).toBe('good')
    expect(data.purchaseTime).toBe('12:41')
    expect(data.payment).toEqual({ method: 'card', cardLast4: '1234' })
    expect(data.totals.roundingAmount).toBe(-0.25)
  })

  it('reads a credit note as one, with the invoice number it credits (issue #2980)', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        documentKind: 'credit_note',
        invoice: { ...VALID_RESULT.invoice, invoiceNumber: 'K-778', creditedInvoiceNumber: '10234' },
        lineItems: [{ ...VALID_RESULT.lineItems[0], lineTotal: -5 }],
        totals: { subtotal: -5, vatAmount: -1.25, total: -6.25 },
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kreditfaktura.pdf',
    })
    expect(data.documentKind).toBe('credit_note')
    expect(data.invoice.creditedInvoiceNumber).toBe('10234')
    expect(data.invoice.invoiceNumber).toBe('K-778')
    expect(data.totals.total).toBe(-6.25)
  })

  it('degrades a malformed credited invoice number to null instead of failing the parse', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse({ ...VALID_RESULT, invoice: { ...VALID_RESULT.invoice, creditedInvoiceNumber: 10234 } })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kreditfaktura.pdf',
    })
    expect(data.supplier.name).toBe('Anthropic, PBC')
    expect(data.invoice.creditedInvoiceNumber).toBeNull()
  })

  it('still parses cached outputs from before the classification fields existed', async () => {
    // VALID_RESULT has none of the new fields: the whole document must
    // validate, not fall back to the empty result.
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'old.pdf',
    })
    expect(data.supplier.name).toBe('Anthropic, PBC')
    expect(data.documentKind).toBeUndefined()
  })

  it('degrades hallucinated classification values to null instead of failing the parse', async () => {
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        documentKind: 'parking_ticket',
        merchantCategory: 'nightclub',
        legibility: 'excellent',
        purchaseTime: '25:99',
        payment: { method: 'bitcoin', cardLast4: 'abcd' },
        totals: { ...VALID_RESULT.totals, roundingAmount: 'noll' },
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'kvitto.pdf',
    })
    // Amounts survived: the junk classification did not sink the document.
    expect(data.totals.total).toBe(6.25)
    expect(data.documentKind).toBeNull()
    expect(data.merchantCategory).toBeNull()
    expect(data.legibility).toBeNull()
    expect(data.purchaseTime).toBeNull()
    expect(data.payment).toEqual({ method: null, cardLast4: null })
    expect(data.totals.roundingAmount).toBeNull()
  })

  // ── Image normalization (HEIC transcode + oversized downscale) ──

  it('transcodes HEIC to JPEG and extracts when sharp can decode it', async () => {
    const converted = Buffer.from('converted-jpeg-bytes')
    sharpMock.mockImplementationOnce(() => workingSharpChain(converted))
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))

    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('heic-bytes'),
      mimeType: 'image/heic',
      fileName: 'photo.heic',
    })

    expect(mockCreate).toHaveBeenCalledOnce()
    const content = mockCreate.mock.calls[0][0].messages[0].content
    expect(content[0].source.media_type).toBe('image/jpeg')
    expect(content[0].source.data).toBe(converted.toString('base64'))
    expect(data.supplier.name).toBe('Anthropic, PBC')
  })

  it('reads a HEIC photo through heic-convert when sharp cannot decode it', async () => {
    // The inbox skipped every iPhone photo on a sharp without libheif; the
    // shared fitter decodes it with heic-convert, then fits the JPEG.
    const decoded = Buffer.from('decoded-jpeg')
    const fitted = Buffer.from('fitted-jpeg')
    heicConvertMock.mockResolvedValueOnce(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer)
    sharpMock
      .mockImplementationOnce(() => {
        throw new Error('heif: unsupported')
      })
      .mockImplementationOnce(() => workingSharpChain(fitted))
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))

    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('heic-bytes'),
      mimeType: 'image/heic',
      fileName: 'photo.heic',
    })

    expect(heicConvertMock).toHaveBeenCalledOnce()
    expect(sharpMock).toHaveBeenNthCalledWith(2, decoded)
    const content = mockCreate.mock.calls[0][0].messages[0].content
    expect(content[0].source.media_type).toBe('image/jpeg')
    expect(content[0].source.data).toBe(fitted.toString('base64'))
    expect(data.supplier.name).toBe('Anthropic, PBC')
  })

  it('downscales oversized JPEGs before sending to Bedrock', async () => {
    const converted = Buffer.from('downscaled-jpeg')
    sharpMock.mockImplementationOnce(() => workingSharpChain(converted))
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))

    await extractInvoiceFields({
      buffer: Buffer.alloc(5 * 1024 * 1024, 1),
      mimeType: 'image/jpeg',
      fileName: 'big-photo.jpg',
    })

    expect(sharpMock).toHaveBeenCalledOnce()
    const content = mockCreate.mock.calls[0][0].messages[0].content
    expect(content[0].source.data).toBe(converted.toString('base64'))
  })

  it('keeps the original buffer when downscaling an oversized image fails', async () => {
    // Default sharpMock throws: the original 5 MB buffer is still attempted.
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))

    await extractInvoiceFields({
      buffer: Buffer.alloc(5 * 1024 * 1024, 1),
      mimeType: 'image/jpeg',
      fileName: 'big-photo.jpg',
    })

    expect(mockCreate).toHaveBeenCalledOnce()
    const content = mockCreate.mock.calls[0][0].messages[0].content
    expect(content[0].source.media_type).toBe('image/jpeg')
  })

  // ── Own-company-as-supplier guard (2026-08) ──────────

  it('strips the supplier when the model extracted the receiving company itself', async () => {
    // A bank agreement's Kunduppgifter block: the model read the customer
    // (the user's own company) as the issuer.
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        documentKind: 'other',
        supplier: {
          name: 'Testbrand AB',
          orgNumber: '5566778899',
          vatNumber: null,
          address: 'Provgatan 1, 111 11 Teststad',
          bankgiro: null,
          plusgiro: null,
          iban: null,
          bic: null,
        },
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'affarsavtal.pdf',
      ownCompany: { orgNumber: '556677-8899', name: 'Testbrand AB' },
    })
    expect(data.supplier).toEqual({
      name: null,
      orgNumber: null,
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
      iban: null,
      bic: null,
    })
    // Only the supplier block is affected.
    expect(data.totals.total).toBe(6.25)
  })

  it('still strips the own company on the image-normalization path (photographed documents)', async () => {
    // normalizeImageForExtraction rebuilds the input for HEIC/oversized
    // photos; ownCompany must survive that rebuild or the guard is dead for
    // exactly the phone-photo documents the fix targets.
    sharpMock.mockImplementationOnce(() => workingSharpChain(Buffer.from('converted-jpeg')))
    mockCreate.mockReturnValueOnce(
      aiResponse({
        ...VALID_RESULT,
        supplier: { ...VALID_RESULT.supplier, name: 'Testbrand AB', orgNumber: '5566778899' },
      })
    )
    const { data } = await extractInvoiceFields({
      buffer: Buffer.alloc(5 * 1024 * 1024, 1),
      mimeType: 'image/jpeg',
      fileName: 'photo-of-avtal.jpg',
      ownCompany: { orgNumber: '556677-8899', name: 'Testbrand AB' },
    })
    expect(data.supplier.name).toBeNull()
    expect(data.supplier.orgNumber).toBeNull()
  })

  it('leaves a genuine supplier untouched when ownCompany is passed', async () => {
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
      ownCompany: { orgNumber: '556677-8899', name: 'Testbrand AB' },
    })
    expect(data.supplier.name).toBe('Anthropic, PBC')
  })

  it('sends a normal-sized image as it is: sharp reads only its header', async () => {
    const header = { metadata: vi.fn().mockResolvedValue({ width: 3024, height: 4032 }), resize: vi.fn() }
    sharpMock.mockImplementationOnce(() => header)
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('JPEG'),
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
    })
    expect(sharpMock).toHaveBeenCalledOnce()
    expect(header.resize).not.toHaveBeenCalled()
    const content = mockCreate.mock.calls[0][0].messages[0].content
    expect(content[0].source.data).toBe(Buffer.from('JPEG').toString('base64'))
  })

  it('fits a small image with a side over the model limit, such as a long receipt strip', async () => {
    // The model refuses a side over 8000 px however small the file.
    const fitted = Buffer.from('fitted-strip')
    sharpMock
      .mockImplementationOnce(() => ({ metadata: vi.fn().mockResolvedValue({ width: 1170, height: 9000 }) }))
      .mockImplementationOnce(() => workingSharpChain(fitted))
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('PNG'),
      mimeType: 'image/png',
      fileName: 'kvitto.png',
    })
    const content = mockCreate.mock.calls[0][0].messages[0].content
    expect(content[0].source.data).toBe(fitted.toString('base64'))
    expect(content[0].source.media_type).toBe('image/jpeg')
  })

  // Restore env vars so other test files aren't affected.
  afterAll(() => {
    if (ORIG_AWS_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = ORIG_AWS_ACCESS_KEY_ID
    else delete process.env.AWS_ACCESS_KEY_ID
    if (ORIG_AWS_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = ORIG_AWS_SECRET_ACCESS_KEY
    else delete process.env.AWS_SECRET_ACCESS_KEY
  })
})

describe('stripOwnCompanyAsSupplier', () => {
  function withSupplier(supplier: Partial<ReturnType<typeof emptyResult>['supplier']>) {
    const base = emptyResult()
    return { ...base, supplier: { ...base.supplier, ...supplier } }
  }
  const strippedSupplier = {
    name: null,
    orgNumber: null,
    vatNumber: null,
    address: null,
    bankgiro: null,
    plusgiro: null,
    iban: null,
    bic: null,
  }
  const own = { orgNumber: '556677-8899', name: 'Testbrand AB' }

  it('matches the org number across hyphen and 12-digit variants', () => {
    for (const extracted of ['5566778899', '556677-8899', '165566778899', '16556677-8899']) {
      const result = stripOwnCompanyAsSupplier(
        withSupplier({ name: 'Något AB', orgNumber: extracted }),
        own
      )
      expect(result.supplier, `orgNumber ${extracted}`).toEqual(strippedSupplier)
    }
  })

  it('matches the derived Swedish VAT number (SE<orgnr>01)', () => {
    // Both the full prefixed form and a bare digits form denote the same
    // registration: digitsOf strips the SE prefix before comparing.
    for (const vat of ['SE556677889901', '556677889901', 'SE 556677-8899 01']) {
      const result = stripOwnCompanyAsSupplier(
        withSupplier({ name: 'Något AB', vatNumber: vat }),
        own
      )
      expect(result.supplier, `vatNumber ${vat}`).toEqual(strippedSupplier)
    }
  })

  it('matches the exact company name case-insensitively', () => {
    const result = stripOwnCompanyAsSupplier(withSupplier({ name: '  testbrand ab ' }), own)
    expect(result.supplier).toEqual(strippedSupplier)
  })

  it('matches a personnummer-form own org number (enskild firma)', () => {
    // companies.org_number for enskild firma is the owner's personnummer,
    // often stored in 12-digit century form.
    const result = stripOwnCompanyAsSupplier(
      withSupplier({ name: 'Firma X', orgNumber: '550505-5566' }),
      { orgNumber: '195505055566', name: 'Firma X Enskild' }
    )
    expect(result.supplier).toEqual(strippedSupplier)
  })

  it('lets a provably different org number outvote a name coincidence', () => {
    // A same-named but distinct entity (foreign registry, generic name) with
    // its own org number on the document stays a valid supplier.
    const supplier = {
      name: 'Testbrand AB',
      orgNumber: '5029032081',
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
      iban: null,
      bic: null,
    }
    expect(stripOwnCompanyAsSupplier(withSupplier(supplier), own).supplier).toEqual(supplier)
  })

  it('leaves a different supplier alone', () => {
    const supplier = {
      name: 'SEB',
      orgNumber: '5029032081',
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
      iban: null,
      bic: null,
    }
    expect(stripOwnCompanyAsSupplier(withSupplier(supplier), own).supplier).toEqual(supplier)
  })

  it('never matches on an empty own identity (junk cannot match junk)', () => {
    const result = stripOwnCompanyAsSupplier(
      withSupplier({ name: 'Något AB', orgNumber: null }),
      { orgNumber: null, name: null }
    )
    expect(result.supplier.name).toBe('Något AB')
  })

  it('fetchOwnCompanyIdentity degrades to nulls on a reported query error (fail open, logged)', async () => {
    const { fetchOwnCompanyIdentity } = await import(
      '@/lib/documents/inbox-extraction/extract-invoice-fields'
    )
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: null, error: new Error('permission denied') }),
          }),
        }),
      }),
    }
    await expect(
      fetchOwnCompanyIdentity(supabase as never, 'company-1')
    ).resolves.toEqual({ orgNumber: null, name: null, companyId: 'company-1' })
  })

  it('is a no-op without ownCompany', () => {
    const data = withSupplier({ name: 'Testbrand AB', orgNumber: '5566778899' })
    expect(stripOwnCompanyAsSupplier(data, undefined)).toBe(data)
  })

  it('preserves every non-supplier field when stripping', () => {
    const base = withSupplier({ name: 'Testbrand AB' })
    const data = {
      ...base,
      documentKind: 'other' as const,
      totals: { ...base.totals, total: 2500 },
      prominentAmounts: [{ amount: 2500, label: 'Engångspris' }],
    }
    const result = stripOwnCompanyAsSupplier(data, own)
    expect(result.documentKind).toBe('other')
    expect(result.totals.total).toBe(2500)
    expect(result.prominentAmounts).toEqual([{ amount: 2500, label: 'Engångspris' }])
    // A bank agreement that prints the customer is no sales invoice: nothing says "own invoice".
    expect(result.sellerIsOwnCompany).toBeUndefined()
  })

  it("reads an invoice or a credit note the company itself issued as its own, never as a supplier's (crm#1830)", () => {
    for (const documentKind of ['supplier_invoice', 'credit_note'] as const) {
      const base = withSupplier({ name: 'Testbrand AB', vatNumber: 'SE556677889901' })
      const result = stripOwnCompanyAsSupplier({ ...base, documentKind, totals: { ...base.totals, total: 1250 } }, own)
      expect(result.supplier, documentKind).toEqual(strippedSupplier)
      expect(result.documentKind, documentKind).toBe('other')
      expect(result.sellerIsOwnCompany, documentKind).toBe(true)
      expect(result.totals.total, documentKind).toBe(1250)
    }
  })

  it('leaves a receipt, a letter and an unclassified reading as they were read when the seller is stripped', () => {
    for (const documentKind of ['receipt', 'government_letter', null] as const) {
      const result = stripOwnCompanyAsSupplier({ ...withSupplier({ name: 'Testbrand AB' }), documentKind }, own)
      expect(result.supplier, String(documentKind)).toEqual(strippedSupplier)
      expect(result.documentKind, String(documentKind)).toBe(documentKind)
      expect(result.sellerIsOwnCompany, String(documentKind)).toBeUndefined()
    }
  })

  it("never marks another seller's invoice as the company's own", () => {
    const data = { ...withSupplier({ name: 'Något AB', orgNumber: '5591234567' }), documentKind: 'supplier_invoice' as const }
    expect(stripOwnCompanyAsSupplier(data, own)).toBe(data)
  })
})

describe('dropMalformedVatNumber (crm#1411)', () => {
  function withSupplier(supplier: Partial<ReturnType<typeof emptyResult>['supplier']>) {
    const base = emptyResult()
    return { ...base, supplier: { ...base.supplier, ...supplier } }
  }

  it('clears a VAT-code label read as the seller VAT number and keeps the rest of the supplier', () => {
    const result = dropMalformedVatNumber(
      withSupplier({ name: 'Synthetic Hosting Inc.', vatNumber: 'SESL000D', address: '101 Townsend St, San Francisco, CA 94107' }),
    )
    expect(result.supplier).toMatchObject({ name: 'Synthetic Hosting Inc.', vatNumber: null, address: '101 Townsend St, San Francisco, CA 94107' })
  })

  it('leaves a real VAT number, a non-EU one and none alone', () => {
    for (const vatNumber of ['SE556677889901', 'IE3668997OH', 'GB123456789', null]) {
      const data = withSupplier({ vatNumber })
      expect(dropMalformedVatNumber(data)).toBe(data)
    }
  })
})
