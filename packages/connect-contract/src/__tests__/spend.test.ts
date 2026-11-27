import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_ERROR_CODES,
  SPEND_ACK_MAX,
  SPEND_BASE_PATH,
  SPEND_CONNECTION_HEADER,
  SPEND_ERROR_CODES,
  SPEND_EXPENSE_KINDS,
  SPEND_OPERATIONS,
  SPEND_REJECTION_CODES,
  SPEND_SCOPE,
  spendAcknowledgeRequestSchema,
  spendAuthorizeRequestSchema,
  spendConnectionSchema,
  spendExpenseSchema,
  spendExpensesResponseSchema,
  spendMasterDataRequestSchema,
  spendStatusResponseSchema,
  type SpendExpense,
} from '../index'

const provider = {
  ref: 'acme-spend',
  displayName: 'Acme Kort',
  legalName: 'Acme Kort AB',
  portalUrl: 'https://acme-spend.example.com',
  supportUrl: null,
  connectModes: ['oauth', 'api_key'],
  maxDimensions: 5,
  setupNoteSv: 'Koppla varje kategori till ett konto i Acme Kort.',
}

const expense: SpendExpense = {
  externalId: '59540ed2-0d68-4e36-9e31-58223975d9e9',
  batchRef: '8eb648ab-464b-42a0-ba17-eda703657e33',
  kind: 'card_purchase',
  subKind: null,
  date: '2026-10-14',
  currency: 'SEK',
  amount: 625,
  original: null,
  walletAccount: '1941',
  lines: [
    {
      account: '6110',
      amount: 500,
      vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 100 },
      dimensions: { '1': '200' },
      description: 'Kontorsmaterial',
    },
    {
      account: '6540',
      amount: 125,
      vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 25 },
      dimensions: {},
      description: null,
    },
  ],
  merchant: { name: 'Papper & Penna AB', country: 'SE', taxId: null, categoryCode: '5111' },
  person: { name: 'Anna Exempel', ref: 'E12' },
  note: 'Pärmar och en licens',
  attendees: [],
  reference: '2500001',
  settles: [],
  files: [
    {
      fileRef: 'f_1',
      name: 'kvitto.jpg',
      contentType: 'image/jpeg',
      size: 13010,
      sha256: 'a'.repeat(64),
      downloadUrl: 'https://connect.example.com/files/f_1?sig=abc',
      downloadExpiresAt: '2026-10-14T12:15:00Z',
    },
  ],
  providerUrl: 'https://app.acme-spend.example.com/expense/59540ed2',
  issues: [],
  raw: { contentType: 'application/json', body: '{"id":"59540ed2"}', sha256: 'b'.repeat(64) },
}

describe('spend family', () => {
  it('names its path, scope and connection header', () => {
    expect(SPEND_BASE_PATH).toBe('/api/connect/spend')
    expect(SPEND_SCOPE).toBe('spend')
    expect(SPEND_CONNECTION_HEADER).toBe('X-Connector-Connection')
  })

  it('lists every operation as a company POST with schemas, and marks which carry the handle', () => {
    for (const [name, op] of Object.entries(SPEND_OPERATIONS)) {
      expect(op.path.startsWith('/'), name).toBe(true)
      expect(op.method).toBe('POST')
      expect(op.company, name).toBe(true)
      expect(typeof op.request.safeParse).toBe('function')
      expect(typeof op.response.safeParse).toBe('function')
    }
    for (const name of ['providers', 'authorize', 'complete', 'connectKey'] as const) {
      expect(SPEND_OPERATIONS[name].connection, name).toBe(false)
    }
    for (const name of ['status', 'masterData', 'expenses', 'acknowledge', 'disconnect'] as const) {
      expect(SPEND_OPERATIONS[name].connection, name).toBe(true)
    }
  })

  it('keeps its error codes unique and apart from the shared list', () => {
    expect(new Set(SPEND_ERROR_CODES).size).toBe(SPEND_ERROR_CODES.length)
    const shared = new Set<string>(CONNECTOR_ERROR_CODES)
    for (const code of SPEND_ERROR_CODES) {
      if (code === 'CONNECTOR_CONNECTION_NOT_OWNED') continue
      expect(shared.has(code), code).toBe(false)
    }
  })

  it('accepts an expense whose lines sum to its amount, and the kinds it declares', () => {
    expect(spendExpenseSchema.safeParse(expense).success).toBe(true)
    const sum = expense.lines.reduce((total, line) => total + line.amount, 0)
    expect(sum).toBe(expense.amount)
    expect(SPEND_EXPENSE_KINDS).toContain('card_purchase')
    expect(SPEND_EXPENSE_KINDS).toContain('other')
  })

  it('refuses an unknown kind, an impossible date, a lower-case currency and a non-https file link', () => {
    expect(spendExpenseSchema.safeParse({ ...expense, kind: 'lottery_win' }).success).toBe(false)
    expect(spendExpenseSchema.safeParse({ ...expense, date: '2026-02-30' }).success).toBe(false)
    expect(spendExpenseSchema.safeParse({ ...expense, currency: 'sek' }).success).toBe(false)
    const plainLink = { ...expense.files[0], downloadUrl: 'http://connect.example.com/files/f_1' }
    expect(spendExpenseSchema.safeParse({ ...expense, files: [plainLink] }).success).toBe(false)
  })

  it('takes a wallet movement without lines', () => {
    const topup = { ...expense, kind: 'wallet_topup', lines: [], files: [], merchant: null }
    expect(spendExpenseSchema.safeParse(topup).success).toBe(true)
  })

  it('pages expenses and bounds a page', () => {
    expect(spendExpensesResponseSchema.safeParse({ expenses: [expense], more: false, serverTime: '2026-10-14T12:00:00Z' }).success).toBe(true)
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ ...expense, externalId: `e_${i}` }))
    expect(spendExpensesResponseSchema.safeParse({ expenses: tooMany, more: true, serverTime: 'x' }).success).toBe(false)
  })

  it('acknowledges with a ledger reference or a coded Swedish reason, never both', () => {
    const received = { externalId: 'e_1', outcome: 'received', ledgerRef: 'row-1', ledgerUrl: 'https://app.example.com/kortkop?item=row-1' }
    const rejected = { externalId: 'e_2', outcome: 'rejected', reasonCode: 'account_unknown', reasonSv: 'Konto 6071 finns inte i Accounted.' }
    expect(spendAcknowledgeRequestSchema.safeParse({ results: [received, rejected] }).success).toBe(true)
    expect(spendAcknowledgeRequestSchema.safeParse({ results: [{ ...rejected, reasonCode: 'because' }] }).success).toBe(false)
    expect(spendAcknowledgeRequestSchema.safeParse({ results: [{ externalId: 'e_3', outcome: 'received' }] }).success).toBe(false)
    expect(spendAcknowledgeRequestSchema.safeParse({ results: [] }).success).toBe(false)
    const full = Array.from({ length: SPEND_ACK_MAX + 1 }, (_, i) => ({ ...received, externalId: `e_${i}` }))
    expect(spendAcknowledgeRequestSchema.safeParse({ results: full }).success).toBe(false)
    expect(SPEND_REJECTION_CODES).toContain('period_locked')
  })

  it('takes a local return URL for a self-hosted instance but a state of real length only', () => {
    const base = { provider: 'acme-spend', orgNumber: '5561234567', returnUrl: 'http://localhost:3000/api/spend/connections/return', state: 's'.repeat(32) }
    expect(spendAuthorizeRequestSchema.safeParse(base).success).toBe(true)
    expect(spendAuthorizeRequestSchema.safeParse({ ...base, state: 'short' }).success).toBe(false)
    expect(spendAuthorizeRequestSchema.safeParse({ ...base, orgNumber: '556123-4567' }).success).toBe(false)
  })

  it('validates a connection, the status and the master data', () => {
    const connection = {
      connectionHandle: 'h'.repeat(32),
      provider,
      mode: 'oauth',
      providerCompanyRef: '12abc3d4-e567-890e-1234-abc56e78fabc',
      providerCompanyName: 'Exempel AB',
      providerOrgNumber: '5561234567',
      connectedAt: '2026-10-14T12:00:00Z',
    }
    expect(spendConnectionSchema.safeParse(connection).success).toBe(true)
    expect(spendConnectionSchema.safeParse({ ...connection, mode: 'password' }).success).toBe(false)

    const status = {
      state: 'active',
      detail: null,
      waitingExpenses: 0,
      lastBatchAt: null,
      masterData: { receivedAt: null, appliedAt: null, state: 'none', issues: [] },
      serverTime: '2026-10-14T12:00:00Z',
    }
    expect(spendStatusResponseSchema.safeParse(status).success).toBe(true)

    const masterData = {
      idempotencyKey: 'conn-1:abcdef',
      accounts: [{ number: '6540', name: 'IT-tjänster', vatCode: 'SE25' }],
      vatCodes: [
        { code: 'SE25', name: 'Svensk moms 25 %', type: 'standard', rate: 0.25, inputVatAccount: null, outputVatAccount: null },
        { code: 'EUTJ', name: 'Tjänst från EU, omvänd moms', type: 'reverse', rate: 0.25, inputVatAccount: '2645', outputVatAccount: '2614' },
      ],
      dimensions: [{ code: '1', name: 'Kostnadsställe', values: [{ code: '200', name: 'Försäljning' }] }],
    }
    expect(spendMasterDataRequestSchema.safeParse(masterData).success).toBe(true)
    expect(
      spendMasterDataRequestSchema.safeParse({ ...masterData, vatCodes: [{ ...masterData.vatCodes[0], code: 'se 25' }] }).success,
    ).toBe(false)
  })
})
