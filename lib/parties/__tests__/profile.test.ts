/**
 * The counterparty profile's rules: the VAT posture is derived, never read;
 * an attribute survives only with a verbatim quote from the evidence; the
 * typical account must exist in the chart; and non-counterparty keys are
 * never read at all.
 */
import { describe, it, expect } from 'vitest'
import {
  deriveVatPosture,
  profileKeyOf,
  profilePromptBlock,
  profileWorthReading,
  renderProfileEvidence,
  supplierTypeForPosture,
  validateProfileReading,
} from '../profile'

const higgsfield = {
  supplier: {
    name: 'Higgsfield Inc.',
    orgNumber: null,
    vatNumber: null,
    address: '535 Mission Street\nSan Francisco, California 94105\nUnited States',
    country: 'US',
    bankgiro: null,
    plusgiro: null,
  },
  invoice: { invoiceNumber: 'NPUTDXSF-0002', invoiceDate: '2026-06-06', dueDate: null, paymentReference: null, currency: 'USD', servicePeriodStart: null, servicePeriodEnd: null },
  totals: { subtotal: 38.05, vatAmount: 0, total: 38.05, roundingAmount: null },
  lineItems: [{ description: 'Higgsfield Plus - monthly, May 6 to Jun 6, 2026', quantity: 1, unitPrice: 38.05, lineTotal: 38.05, vatRate: 0, accountSuggestion: null }],
  documentKind: 'supplier_invoice',
}

describe('deriveVatPosture', () => {
  it('puts a foreign service seller under omvänd skattskyldighet, EU and non-EU alike', () => {
    expect(deriveVatPosture('US', 'company')).toBe('reverse_charge_non_eu')
    expect(deriveVatPosture('DE', 'company')).toBe('reverse_charge_eu')
    expect(deriveVatPosture('IE', 'company')).toBe('reverse_charge_eu')
    expect(deriveVatPosture('SE', 'company')).toBe('domestic')
    expect(deriveVatPosture(null, 'company')).toBe('unknown')
  })

  it('never reverse-charges a person, an authority or a bank', () => {
    expect(deriveVatPosture('US', 'person')).toBe('domestic')
    expect(deriveVatPosture(null, 'authority')).toBe('domestic')
  })

  it('maps the posture to the template supplier type that books its ruta', () => {
    expect(supplierTypeForPosture('reverse_charge_non_eu')).toBe('non_eu_business')
    expect(supplierTypeForPosture('reverse_charge_eu')).toBe('eu_business')
    expect(supplierTypeForPosture('domestic')).toBe('swedish_business')
    expect(supplierTypeForPosture('unknown')).toBeNull()
  })
})

describe('renderProfileEvidence', () => {
  it('renders the bank text and the document as labelled blocks', () => {
    const { text, blocks } = renderProfileEvidence({
      bankTexts: ['Higgsfield Utlägg Överföring via internet', 'Higgsfield Utlägg Överföring via internet'],
      documents: [{ documentId: 'doc-1', extraction: higgsfield }],
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[0].documentId).toBeNull()
    expect(blocks[1].documentId).toBe('doc-1')
    expect(text).toContain('Leverantör: Higgsfield Inc.')
    expect(text).toContain('Adress: 535 Mission Street, San Francisco, California 94105, United States')
    expect(text).toContain('- Higgsfield Plus - monthly')
    // The duplicate bank line is listed once.
    expect(text.match(/Överföring via internet/g)).toHaveLength(1)
  })
})

describe('validateProfileReading', () => {
  const { text, blocks } = renderProfileEvidence({
    bankTexts: ['Higgsfield Utlägg Överföring via internet'],
    documents: [{ documentId: 'doc-1', extraction: higgsfield }],
  })

  it('keeps attributes the model could quote and derives the VAT posture', () => {
    const out = validateProfileReading(
      {
        name: 'Higgsfield Inc.',
        country: 'us',
        kind: 'company',
        sells: 'AI-videogenerering (SaaS)',
        industry: 'programvara',
        typical_account: '5420',
        recurrence: 'monthly',
        confidence: 'high',
        evidence: [
          { field: 'name', quote: 'Higgsfield Inc.' },
          { field: 'country', quote: 'United States' },
          { field: 'kind', quote: 'Higgsfield Inc.' },
          { field: 'sells', quote: 'Higgsfield Plus' },
          { field: 'industry', quote: 'Higgsfield Plus' },
          { field: 'typical_account', quote: 'Higgsfield Plus - monthly' },
          { field: 'recurrence', quote: 'monthly' },
        ],
      },
      text,
      blocks,
    )
    expect(out).not.toBeNull()
    expect(out?.profile).toMatchObject({
      name: 'Higgsfield Inc.',
      country: 'US',
      kind: 'company',
      sells: 'AI-videogenerering (SaaS)',
      typical_account: '5420',
      recurrence: 'monthly',
      vat_posture: 'reverse_charge_non_eu',
    })
    expect(out?.evidence.find((e) => e.field === 'country')?.document_id).toBe('doc-1')
    expect(out?.confidence).toBe('high')
  })

  it('drops an attribute whose quote is not in the evidence, and a made-up account', () => {
    const out = validateProfileReading(
      {
        name: 'Higgsfield Inc.',
        country: 'US',
        kind: 'company',
        sells: 'Videoproduktion',
        industry: null,
        typical_account: '9999',
        recurrence: 'yearly',
        confidence: 'medium',
        evidence: [
          { field: 'name', quote: 'Higgsfield Inc.' },
          { field: 'country', quote: 'Delaware' },
          { field: 'sells', quote: 'video production studio' },
          { field: 'typical_account', quote: 'Higgsfield Plus' },
          { field: 'recurrence', quote: 'annual plan' },
        ],
      },
      text,
      blocks,
    )
    expect(out?.profile.name).toBe('Higgsfield Inc.')
    expect(out?.profile.country).toBeNull()
    expect(out?.profile.sells).toBeNull()
    expect(out?.profile.typical_account).toBeNull()
    expect(out?.profile.recurrence).toBe('unknown')
    // The kind rides on the quoted name; without a country the posture stays unknown.
    expect(out?.profile.kind).toBe('company')
    expect(out?.profile.vat_posture).toBe('unknown')
    expect(out?.evidence.map((e) => e.field)).toEqual(['name'])
  })

  it('answers null for an unparseable reading', () => {
    expect(validateProfileReading('nonsense', text, blocks)).toBeNull()
  })
})

describe('keys, gates and the prompt block', () => {
  it('keys on the booking normaliser and refuses keys that are not counterparties', () => {
    expect(profileKeyOf('HIGGSFIELD INC')).toBe('higgsfield inc')
    expect(profileKeyOf('')).toBeNull()
    expect(profileWorthReading('higgsfield inc')).toBe(true)
    expect(profileWorthReading('lön juni')).toBe(false)
    expect(profileWorthReading('skatteverket')).toBe(false)
  })

  it('renders a prompt block from what the profile knows, and nothing from what it does not', () => {
    const block = profilePromptBlock({
      name: 'Higgsfield Inc.',
      country: 'US',
      kind: 'company',
      sells: 'AI-videogenerering (SaaS)',
      industry: null,
      typical_account: '5420',
      recurrence: 'monthly',
      vat_posture: 'reverse_charge_non_eu',
    })
    expect(block).toContain('- Land: US')
    expect(block).toContain('- Säljer: AI-videogenerering (SaaS)')
    expect(block).toContain('- Typiskt konto: 5420')
    expect(block).toContain('ruta 22')
    expect(block).not.toContain('Bransch')
    expect(profilePromptBlock(null)).toBe('')
  })
})

describe('kind without a name', () => {
  it('falls back to unknown when neither the kind nor the name is quoted', () => {
    const { text, blocks } = renderProfileEvidence({ bankTexts: ['KORTKÖP 1234'], documents: [] })
    const out = validateProfileReading(
      { name: 'Acme', country: null, kind: 'company', sells: null, industry: null, typical_account: null, recurrence: 'unknown', confidence: 'low', evidence: [] },
      text,
      blocks,
    )
    expect(out?.profile.name).toBeNull()
    expect(out?.profile.kind).toBe('unknown')
  })
})

