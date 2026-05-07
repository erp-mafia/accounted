import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractInvoiceFields } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'

// Mock the Bedrock SDK so tests drive the JSON parser without
// network/credential needs.
const mockCreate = vi.fn()

vi.mock('@anthropic-ai/bedrock-sdk', () => {
  class FakeBedrock {
    messages = { create: mockCreate }
  }
  return { default: FakeBedrock }
})

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

  // Restore env vars so other test files aren't affected.
  afterAll(() => {
    if (ORIG_AWS_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = ORIG_AWS_ACCESS_KEY_ID
    else delete process.env.AWS_ACCESS_KEY_ID
    if (ORIG_AWS_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = ORIG_AWS_SECRET_ACCESS_KEY
    else delete process.env.AWS_SECRET_ACCESS_KEY
  })
})

// vitest doesn't auto-import afterAll
import { afterAll } from 'vitest'
