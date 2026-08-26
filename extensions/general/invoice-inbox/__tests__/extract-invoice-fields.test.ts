import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  extractInvoiceFields,
  extractJsonObject,
} from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'

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

function workingSharpChain(outputBuffer: Buffer) {
  const chain = {
    rotate: vi.fn(() => chain),
    resize: vi.fn(() => chain),
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

  it('does not invoke sharp for normal-sized supported images', async () => {
    mockCreate.mockReturnValueOnce(aiResponse(VALID_RESULT))
    await extractInvoiceFields({
      buffer: Buffer.from('JPEG'),
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
    })
    expect(sharpMock).not.toHaveBeenCalled()
  })

  // Restore env vars so other test files aren't affected.
  afterAll(() => {
    if (ORIG_AWS_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = ORIG_AWS_ACCESS_KEY_ID
    else delete process.env.AWS_ACCESS_KEY_ID
    if (ORIG_AWS_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = ORIG_AWS_SECRET_ACCESS_KEY
    else delete process.env.AWS_SECRET_ACCESS_KEY
  })
})
