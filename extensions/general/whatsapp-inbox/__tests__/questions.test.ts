import { describe, it, expect } from 'vitest'
import {
  evaluateQuestion,
  QUESTION_PRIORITY,
  type QuestionInput,
} from '@/extensions/general/whatsapp-inbox/lib/questions'
import type { InvoiceExtractionResult } from '@/types'

function extraction(overrides: Partial<InvoiceExtractionResult> = {}): InvoiceExtractionResult {
  return {
    documentKind: 'receipt',
    merchantCategory: 'grocery',
    legibility: 'good',
    supplier: {
      name: 'ICA Maxi',
      orgNumber: null,
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
    },
    invoice: {
      invoiceNumber: null,
      invoiceDate: '2026-07-30',
      dueDate: null,
      paymentReference: null,
      currency: 'SEK',
    },
    lineItems: [],
    totals: { subtotal: null, vatAmount: null, total: 234 },
    vatBreakdown: [],
    confidence: 1,
    ...overrides,
  }
}

function input(overrides: Partial<QuestionInput> = {}): QuestionInput {
  return {
    extracted: extraction(),
    caption: null,
    mime: 'image/jpeg',
    filename: 'kvitto.jpg',
    fileSizeBytes: 500_000,
    ...overrides,
  }
}

describe('evaluateQuestion', () => {
  it('returns null for a clean, readable, non-representation receipt', () => {
    expect(evaluateQuestion(input())).toBeNull()
  })

  it('unreadable legibility triggers the resend question', () => {
    expect(evaluateQuestion(input({ extracted: extraction({ legibility: 'unreadable' }) })))
      .toEqual({ type: 'resend' })
  })

  it('compressed-chat-photo signal triggers resend: jpeg, no filename, <150KB, empty extraction', () => {
    const empty = extraction({
      legibility: null,
      supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
      totals: { subtotal: null, vatAmount: null, total: null },
    })
    expect(
      evaluateQuestion(input({ extracted: empty, filename: null, fileSizeBytes: 90_000 })),
    ).toEqual({ type: 'resend' })
    // Never on size alone: a readable extraction stops the trigger.
    expect(
      evaluateQuestion(input({ filename: null, fileSizeBytes: 90_000 })),
    ).toBeNull()
    // A real filename means "sent as document": full quality, no resend ask,
    // and an all-empty extraction is not "partial" either (both key fields
    // missing fails the XOR), so no question at all.
    expect(
      evaluateQuestion(input({ extracted: empty, filename: 'scan.jpg', fileSizeBytes: 90_000 })),
    ).toBeNull()
  })

  it('restaurant/cafe/hotel receipts trigger representation', () => {
    for (const category of ['restaurant', 'cafe', 'hotel'] as const) {
      expect(
        evaluateQuestion(
          input({ extracted: extraction({ merchantCategory: category, totals: { subtotal: null, vatAmount: null, total: 450 } }) }),
        ),
      ).toEqual({ type: 'representation' })
    }
  })

  it('asks about a small business meal too: the documentation duty has no amount floor', () => {
    // BFL 5 kap 6-7 §: deltagare + syfte is what makes representation
    // deductible, regardless of the sum. The 300 kr/person figure is the
    // VAT-base cap, a different rule. Flagged by the Swedish compliance
    // review on PR #1340; the old 150 kr floor silently skipped it.
    expect(
      evaluateQuestion(
        input({
          extracted: extraction({
            merchantCategory: 'cafe',
            totals: { subtotal: null, vatAmount: null, total: 120 },
          }),
        }),
      ),
    ).toEqual({ type: 'representation' })
  })

  it('still asks when the total is unreadable, rather than skipping the trail', () => {
    expect(
      evaluateQuestion(
        input({
          extracted: extraction({
            merchantCategory: 'restaurant',
            totals: { subtotal: null, vatAmount: null, total: null },
          }),
        }),
      ),
    ).toEqual({ type: 'representation' })
  })

  it('a supplier_invoice never triggers representation, whatever the merchant', () => {
    expect(
      evaluateQuestion(
        input({
          extracted: extraction({
            documentKind: 'supplier_invoice',
            merchantCategory: 'restaurant',
            totals: { subtotal: null, vatAmount: null, total: 4500 },
          }),
        }),
      ),
    ).toBeNull()
  })

  it('heuristic fallback when classification is absent: meal words + extended venue words', () => {
    const legacy = (name: string, caption: string | null = null) =>
      evaluateQuestion(
        input({
          caption,
          extracted: extraction({
            documentKind: null,
            merchantCategory: null,
            legibility: null,
            supplier: { name, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
            totals: { subtotal: null, vatAmount: null, total: 600 },
          }),
        }),
      )
    expect(legacy('Restaurang Prinsen')).toEqual({ type: 'representation' })
    expect(legacy('Pizzeria Roma')).toEqual({ type: 'representation' })
    expect(legacy('O Learys Pub')).toEqual({ type: 'representation' })
    // Word boundary: 'bar' inside a place name must not fire.
    expect(legacy('Barkarby Bygg')).toBeNull()
    // Caption signals business context even for a neutral merchant.
    expect(legacy('Statoil', 'lunch med kund')).toEqual({ type: 'representation' })
  })

  it('partial legibility (or exactly one key field missing) asks for free-text context', () => {
    expect(
      evaluateQuestion(input({ extracted: extraction({ legibility: 'partial' }) })),
    ).toEqual({ type: 'context' })
    expect(
      evaluateQuestion(
        input({
          extracted: extraction({
            legibility: null,
            totals: { subtotal: null, vatAmount: null, total: null },
          }),
        }),
      ),
    ).toEqual({ type: 'context' }) // total missing, supplier present
    // BOTH missing is not "partial": that is the unreadable/empty case,
    // handled by the resend trigger or plain M4-empty.
    expect(
      evaluateQuestion(
        input({
          extracted: extraction({
            legibility: null,
            supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
            totals: { subtotal: null, vatAmount: null, total: null },
          }),
        }),
      ),
    ).toBeNull()
  })

  it('priority: unreadable beats representation beats partial', () => {
    expect(
      evaluateQuestion(
        input({
          extracted: extraction({
            legibility: 'unreadable',
            merchantCategory: 'restaurant',
            totals: { subtotal: null, vatAmount: null, total: 800 },
          }),
        }),
      ),
    ).toEqual({ type: 'resend' })
    expect(
      evaluateQuestion(
        input({
          extracted: extraction({
            legibility: 'partial',
            merchantCategory: 'restaurant',
            totals: { subtotal: null, vatAmount: null, total: 800 },
          }),
        }),
      ),
    ).toEqual({ type: 'representation' })
    expect(QUESTION_PRIORITY.resend).toBeLessThan(QUESTION_PRIORITY.representation)
    expect(QUESTION_PRIORITY.representation).toBeLessThan(QUESTION_PRIORITY.context)
  })
})
