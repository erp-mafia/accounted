import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'

const generate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/invoices/peppol-bis-billing', async (load) => ({
  ...(await load<typeof import('@/lib/invoices/peppol-bis-billing')>()),
  generatePeppolBisBillingInvoice: generate,
}))

import {
  generatePeppolDocumentOrResponse,
  PEPPOL_CUSTOMER_MISSING_MESSAGE_EN,
  PEPPOL_CUSTOMER_MISSING_MESSAGE_SV,
} from '../peppol-document'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

type Envelope = {
  error: {
    code: string
    message: string
    message_en: string
    details: { field?: string; issues?: Array<Record<string, string>> }
  }
}

const issues = [
  {
    code: 'BUYER_ORG_NUMBER_INVALID',
    field: 'customer.org_number',
    messageSv: 'Köparen måste ha ett giltigt svenskt organisationsnummer.',
    messageEn: 'The buyer must have a valid Swedish organization number.',
  },
  {
    code: 'SELLER_NAME_REQUIRED',
    field: 'company.name',
    messageSv: 'Säljaren måste ha ett namn.',
    messageEn: 'The seller must have a name.',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generatePeppolDocumentOrResponse', () => {
  it('answers a failed BIS preflight with the first issue in both locales and the full issue list', async () => {
    // errorResponseFromCode treats a supplied messageSv/messageEn as authored,
    // so the issues summary no longer rewrites them. On the send, v1 and MCP
    // surfaces message_en is now the first issue's English sentence instead
    // of the registry's generic "Validation error.". Intended.
    generate.mockReturnValue({ ok: false, issues })
    const result = generatePeppolDocumentOrResponse({
      invoice: { ...makeInvoice(), customer: makeCustomer(), items: [] },
      company: makeCompanySettings(),
      log: log as never,
      requestId: 'req-1',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('VALIDATION_ERROR')
    expect(result.issues).toEqual(['BUYER_ORG_NUMBER_INVALID', 'SELLER_NAME_REQUIRED'])
    expect(result.response.status).toBe(400)

    const body = (await result.response.json()) as Envelope
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe(issues[0].messageSv)
    expect(body.error.message_en).toBe(issues[0].messageEn)
    expect(body.error.details.issues).toEqual([
      {
        code: 'BUYER_ORG_NUMBER_INVALID',
        field: 'customer.org_number',
        message_sv: issues[0].messageSv,
        message_en: issues[0].messageEn,
      },
      {
        code: 'SELLER_NAME_REQUIRED',
        field: 'company.name',
        message_sv: issues[1].messageSv,
        message_en: issues[1].messageEn,
      },
    ])
  })

  it('answers a missing customer with its own bilingual sentence', async () => {
    const result = generatePeppolDocumentOrResponse({
      invoice: { ...makeInvoice(), customer: undefined, items: [] },
      company: makeCompanySettings(),
      log: log as never,
      requestId: 'req-1',
    })

    expect(generate).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) return
    const body = (await result.response.json()) as Envelope
    expect(body.error.message).toBe(PEPPOL_CUSTOMER_MISSING_MESSAGE_SV)
    expect(body.error.message_en).toBe(PEPPOL_CUSTOMER_MISSING_MESSAGE_EN)
    expect(body.error.details.field).toBe('invoice.customer')
  })

  it('returns the generated document when the preflight passes', () => {
    const document = {
      ok: true,
      xml: '<Invoice/>',
      filename: 'invoice.xml',
      sender: { scheme: '0007', identifier: '5560000000' },
      recipient: { scheme: '0007', identifier: '5560000001' },
    }
    generate.mockReturnValue(document)
    const result = generatePeppolDocumentOrResponse({
      invoice: { ...makeInvoice(), customer: makeCustomer(), items: [] },
      company: makeCompanySettings(),
      log: log as never,
      requestId: 'req-1',
    })
    expect(result).toEqual({ ok: true, document })
  })
})
