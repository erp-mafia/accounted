import { describe, expect, it, vi } from 'vitest'
import type { NextResponse } from 'next/server'
import { sessionFailureResponse } from '@/lib/operations/session'
import { customerFailureResponse } from '@/lib/customers/customer-failure-response'
import { articleRefusalResponse } from '@/lib/articles/article-refusal-response'
import { serviceFailureResponse } from '@/lib/sales-orders/respond'
import { errorResponse } from '@/lib/errors/get-structured-error'

// The dashboard's failure responders, pinned by what they answer: status and
// body. The domain responders (customer, article, sales order) fold into
// sessionFailureResponse, and these snapshots hold every refusal they answer
// to the bytes they answered before.

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never

async function answer(response: NextResponse) {
  return { status: response.status, body: await response.json() }
}

describe('sessionFailureResponse', () => {
  it('answers a code with its details and the operation Swedish message', async () => {
    expect(
      await answer(
        sessionFailureResponse(
          { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange minst ett fält att ändra.', details: { field: 'body' } },
          log,
          'req-1',
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "VALIDATION_ERROR",
            "details": {
              "field": "body",
            },
            "message": "Ange minst ett fält att ändra.",
            "message_en": "Validation error.",
            "requestId": "req-1",
          },
        },
        "status": 400,
      }
    `)
  })

  it('answers a failure that brings its English and its next step with all three', async () => {
    const remediation = { description: 'Unlock the year first.', tool: 'gnubok_list_fiscal_periods' }
    const { status, body } = await answer(
      sessionFailureResponse(
        { ok: false, code: 'PERIOD_LOCKED', messageSv: 'Året är låst.', messageEn: 'The year is locked.', remediation },
        log,
        'req-1',
      ),
    )
    expect(status).toBe(400)
    expect(body.error).toMatchObject({
      code: 'PERIOD_LOCKED',
      message: 'Året är låst.',
      message_en: 'The year is locked.',
      remediation,
    })
  })

  it('answers a database error as the database error', async () => {
    expect(
      await answer(
        sessionFailureResponse({ ok: false, code: 'X_FAILED', error: { code: '23505', message: 'duplicate key value' } }, log, 'req-1'),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "VALIDATION_ERROR",
            "details": {
              "pgCode": "23505",
            },
            "message": "Förfrågan innehåller ogiltiga uppgifter.",
            "message_en": "Validation error.",
            "requestId": "req-1",
          },
        },
        "status": 400,
      }
    `)
  })
})

describe('customerFailureResponse', () => {
  it('carries the database reason of a failed write in details.reason', async () => {
    expect(
      await answer(
        customerFailureResponse(
          { ok: false, code: 'CUSTOMER_UPDATE_FAILED', error: { code: '23505', message: 'duplicate key value' } },
          log,
          'req-1',
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "CUSTOMER_UPDATE_FAILED",
            "details": {
              "reason": "En post med samma uppgifter finns redan.",
            },
            "message": "Kunden kunde inte uppdateras.",
            "message_en": "Failed to update customer.",
            "requestId": "req-1",
          },
        },
        "status": 500,
      }
    `)
  })

  it('answers the country rule in its own Swedish and English text', async () => {
    expect(
      await answer(
        customerFailureResponse(
          {
            ok: false,
            code: 'CUSTOMER_COUNTRY_MISMATCH',
            messageSv: 'Landet stämmer inte.',
            details: { field: 'country', issue: 'x', message_sv: 'Landet stämmer inte.', message_en: 'The country does not match.' },
          },
          log,
          'req-1',
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "CUSTOMER_COUNTRY_MISMATCH",
            "details": {
              "field": "country",
              "issue": "x",
            },
            "message": "Landet stämmer inte.",
            "message_en": "The country does not match.",
            "requestId": "req-1",
          },
        },
        "status": 400,
      }
    `)
  })

  it('answers any other refusal as its registry entry with the details', async () => {
    expect(
      await answer(
        customerFailureResponse(
          { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange minst ett fält att ändra.', details: { field: 'body' } },
          log,
          undefined,
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "VALIDATION_ERROR",
            "details": {
              "field": "body",
            },
            "message": "Förfrågan innehåller ogiltiga uppgifter.",
            "message_en": "Validation error.",
          },
        },
        "status": 400,
      }
    `)
    expect(
      await answer(customerFailureResponse({ ok: false, code: 'CUSTOMER_DUPLICATE_ORG_NUMBER', details: { field: 'org_number' } }, log, 'req-1')),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "CUSTOMER_DUPLICATE_ORG_NUMBER",
            "details": {
              "field": "org_number",
            },
            "message": "En kund med samma organisationsnummer finns redan.",
            "message_en": "A customer with that organisation number already exists.",
            "requestId": "req-1",
          },
        },
        "status": 409,
      }
    `)
  })
})

describe('articleRefusalResponse', () => {
  it('keeps the activate-and-retry envelope for accounts outside the chart', async () => {
    expect(
      await answer(
        articleRefusalResponse({ ok: false, code: 'ACCOUNTS_NOT_IN_CHART', details: { account_numbers: ['3011'] } }, log, 'req-1'),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "account_numbers": [
              "3011",
            ],
            "code": "ACCOUNTS_NOT_IN_CHART",
            "details": {
              "account_numbers": [
                "3011",
              ],
            },
            "message": "Följande konton behöver aktiveras: 3011",
          },
        },
        "status": 400,
      }
    `)
  })

  it('carries the database reason of a failed write in details.reason', async () => {
    expect(
      await answer(
        articleRefusalResponse({ ok: false, code: 'ARTICLE_CREATE_FAILED', error: { code: '23505', message: 'duplicate key value' } }, log, 'req-1'),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "ARTICLE_CREATE_FAILED",
            "details": {
              "reason": "En post med samma uppgifter finns redan.",
            },
            "message": "Artikeln kunde inte skapas.",
            "message_en": "Failed to create article.",
            "requestId": "req-1",
          },
        },
        "status": 500,
      }
    `)
  })

  it('answers any other refusal as its registry entry with the details', async () => {
    expect(
      await answer(articleRefusalResponse({ ok: false, code: 'NOT_FOUND', details: { id: 'a-1' } }, log, 'req-1')),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "NOT_FOUND",
            "details": {
              "id": "a-1",
            },
            "message": "Resursen kunde inte hittas.",
            "message_en": "Resource not found.",
            "requestId": "req-1",
          },
        },
        "status": 404,
      }
    `)
  })
})

describe('serviceFailureResponse', () => {
  it('answers a missing database error as errorResponse always did', async () => {
    expect(await answer(serviceFailureResponse({ ok: false, dbError: undefined }, log, 'req-1'))).toEqual(
      await answer(errorResponse(undefined, log, { requestId: 'req-1' })),
    )
  })

  it('answers a database error as the database error', async () => {
    expect(
      await answer(serviceFailureResponse({ ok: false, dbError: { code: '23505', message: 'duplicate key value' } }, log, 'req-1')),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "VALIDATION_ERROR",
            "details": {
              "pgCode": "23505",
            },
            "message": "Förfrågan innehåller ogiltiga uppgifter.",
            "message_en": "Validation error.",
            "requestId": "req-1",
          },
        },
        "status": 400,
      }
    `)
  })

  it('answers a code with its details', async () => {
    expect(
      await answer(serviceFailureResponse({ ok: false, code: 'NOT_FOUND', details: { id: 'o-1' } }, log)),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "NOT_FOUND",
            "details": {
              "id": "o-1",
            },
            "message": "Resursen kunde inte hittas.",
            "message_en": "Resource not found.",
          },
        },
        "status": 404,
      }
    `)
  })
})
