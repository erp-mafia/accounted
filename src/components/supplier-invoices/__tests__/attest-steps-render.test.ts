/**
 * The step an invoice is at and a substitute, as the invoice's attest panel,
 * the attest mail's list page and its single-invoice page show them (#192):
 * rendered under both catalogues, so a missing key or a broken ICU argument
 * fails here, and English shows no Swedish (the check:guards rule applied to
 * the HTML).
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { looksSwedish } from '@/scripts/checks/swedish-ui-literal.mjs'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import { SupplierInvoiceAttestPanel, type SupplierInvoiceAttestState } from '../SupplierInvoiceAttestPanel'
import { AttestBatchPage } from '../AttestBatchPage'
import { AttestLinkPage } from '../AttestLinkPage'
import type { AttestBatchPageData } from '@/lib/supplier-invoices/attest-batch-route'
import type { AttestLinkPageData } from '@/lib/supplier-invoices/attest-link-route'

type Children = { children?: ReactNode }

vi.mock('@/components/ui/dialog', () => {
  const pass = ({ children }: Children) => createElement('div', null, children)
  return {
    Dialog: ({ open, children }: Children & { open: boolean }) => (open ? createElement('div', null, children) : null),
    DialogContent: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    DialogDescription: pass,
    DialogFooter: pass,
  }
})
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }))
vi.mock('@/components/branding/BrandWordmark', () => ({ BrandWordmark: () => null }))

const petra = { user_id: 'petra', name: 'Petra Projekt', email: null }
const pal = { user_id: 'pal', name: 'Pål Platschef', email: null }
const eva = { user_id: 'eva', name: 'Eva Ekonomi', email: null }
const bosse = { user_id: 'bosse', name: 'Bosse Backup', email: null }

const state: SupplierInvoiceAttestState = {
  supplier_invoice_id: 'inv-1',
  policy: { enabled: true, mode: 'any', threshold_amount: null, preparer_may_attest: false, two_step_from_sek: null },
  required: true,
  satisfied: false,
  blocked: false,
  approved_at: null,
  approved_by: null,
  approved: [],
  remaining: [
    { ...pal, limit_sek: null, stands_in_for: null },
    { ...bosse, limit_sek: null, stands_in_for: pal },
  ],
  amount_sek: 30000,
  steps: 1,
  approvals_needed: 2,
  needs_covering: false,
  stage: 'pre',
  pre_attest: [
    { project: 'P100', project_name: 'Kv. Eken', done: true, approved_by: petra, attesters: [] },
    { project: 'P200', project_name: 'Kv. Linden', done: false, approved_by: null, attesters: [pal] },
  ],
  acts_for: pal,
  latest_rejection: null,
  attestations: [
    {
      attestation_id: 'a-1',
      user: bosse,
      decision: 'approved',
      comment: null,
      source: 'email_link',
      decided_at: '2026-11-07T09:00:00Z',
      step: 1,
      stage: 'pre',
      on_behalf_of: petra,
    },
  ],
  viewer: { may_approve: true, may_reject: true, reason: null, acts_for: 'pal' },
}

const invoiceView = {
  id: 'inv-1',
  supplier_name: 'Byggvaror AB',
  supplier_invoice_number: 'F-1',
  arrival_number: 7,
  invoice_date: '2026-11-01',
  due_date: '2026-12-01',
  total: 30000,
  currency: 'SEK',
  has_document: false,
  overdue: false,
  registered_by: 'Cilla',
  state: 'open' as const,
  may_approve: true,
  may_reject: true,
  reason: null,
  stage: 'final' as const,
  acts_for_name: 'Eva Ekonomi',
}

const batch: AttestBatchPageData = {
  company_name: 'Bygg AB',
  attester_name: 'Bosse Backup',
  kind: 'request',
  expires_at: '2026-11-14T09:00:00Z',
  invoices: [invoiceView, { ...invoiceView, id: 'inv-2', state: 'closed', may_approve: false, may_reject: false, reason: 'other_step', stage: 'pre', acts_for_name: null }],
}

const link: AttestLinkPageData = {
  company_name: 'Bygg AB',
  attester_name: 'Bosse Backup',
  invoice: {
    supplier_name: 'Byggvaror AB',
    supplier_invoice_number: 'F-1',
    arrival_number: 7,
    invoice_date: '2026-11-01',
    due_date: '2026-12-01',
    total: 30000,
    currency: 'SEK',
    has_document: false,
  },
  registered_by: 'Cilla',
  state: 'open',
  may_approve: true,
  may_reject: true,
  reason: null,
  approved_names: [],
  remaining_names: [eva.name],
  mode: 'any',
  stage: 'final',
  acts_for_name: 'Eva Ekonomi',
  expires_at: '2026-11-14T09:00:00Z',
}

const elements = {
  panel: createElement(SupplierInvoiceAttestPanel, { state, onChanged: () => {} }),
  batch: createElement(AttestBatchPage, { token: 't'.repeat(43), initial: batch }),
  link: createElement(AttestLinkPage, { token: 't'.repeat(43), initial: link, preselected: null }),
}

describe('the attest step and substitutes on the pages', () => {
  it('names the step, each project\'s förattest and the substitute in Swedish', () => {
    const panel = visibleText(renderInLocale(elements.panel, 'sv')).join(' | ')
    expect(panel).toContain('Steg 1 av 2: förattest')
    expect(panel).toContain('Förattest för P100 Kv. Eken: godkänd av Petra Projekt')
    expect(panel).toContain('Förattest för P200 Kv. Linden: väntar på en av Pål Platschef')
    expect(panel).toContain('Du attesterar i stället för Pål Platschef.')
    expect(panel).toContain('Bosse Backup för Petra Projekt godkände')
    const list = visibleText(renderInLocale(elements.batch, 'sv')).join(' | ')
    expect(list).toContain('Steg 2 av 2: attest')
    expect(list).toContain('i stället för Eva Ekonomi')
    expect(list).toContain('Väntar på ett annat steg än ditt.')
    const single = visibleText(renderInLocale(elements.link, 'sv')).join(' | ')
    expect(single).toContain('Steg 2 av 2: attest')
    expect(single).toContain('Du attesterar i stället för Eva Ekonomi.')
  })

  it('shows no Swedish in English', () => {
    for (const element of Object.values(elements)) {
      const swedish = visibleText(renderInLocale(element, 'en')).filter((text) => looksSwedish(text) && !/Kv\.|Byggvaror|Bygg AB|Projekt|Platschef|Ekonomi/.test(text))
      expect(swedish).toEqual([])
    }
    expect(visibleText(renderInLocale(elements.panel, 'en')).join(' | ')).toContain('Step 1 of 2: pre-approval')
  })
})
