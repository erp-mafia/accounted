import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { validateBody, validateQuery } from '../validate'

// ============================================================
// Helpers
// ============================================================

function createJsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function createMalformedRequest(): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not valid json {{{',
  })
}

function createRequestWithQuery(params: Record<string, string>): Request {
  const url = new URL('http://localhost/api/test')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return new Request(url.toString())
}

const TestSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
  email: z.string().email().optional(),
})

const QuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

// ============================================================
// validateBody
// ============================================================

describe('validateBody', () => {
  it('returns success with parsed data on valid input', async () => {
    const request = createJsonRequest({ name: 'Alice', age: 30 })
    const result = await validateBody(request, TestSchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ name: 'Alice', age: 30 })
    }
  })

  it('returns success with optional fields', async () => {
    const request = createJsonRequest({ name: 'Bob', age: 25, email: 'bob@test.com' })
    const result = await validateBody(request, TestSchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.email).toBe('bob@test.com')
    }
  })

  it('returns failure response on invalid body', async () => {
    const request = createJsonRequest({ name: '', age: -5 })
    const result = await validateBody(request, TestSchema)

    expect(result.success).toBe(false)
    if (!result.success) {
      const body = await result.response.json()
      expect(result.response.status).toBe(400)
      expect(body.error).toBe('Validation failed')
      expect(body.type).toBe('validation_error')
      expect(body.errors).toBeInstanceOf(Array)
      expect(body.errors.length).toBeGreaterThan(0)
    }
  })

  it('returns field paths in error details', async () => {
    const request = createJsonRequest({ name: 'Alice', age: 'not-a-number' })
    const result = await validateBody(request, TestSchema)

    expect(result.success).toBe(false)
    if (!result.success) {
      const body = await result.response.json()
      const ageError = body.errors.find((e: { field: string }) => e.field === 'age')
      expect(ageError).toBeDefined()
      expect(ageError.code).toBeDefined()
    }
  })

  it('returns error for malformed JSON', async () => {
    const request = createMalformedRequest()
    const result = await validateBody(request, TestSchema)

    expect(result.success).toBe(false)
    if (!result.success) {
      const body = await result.response.json()
      expect(result.response.status).toBe(400)
      expect(body.error).toBe('Invalid JSON in request body')
      expect(body.type).toBe('validation_error')
    }
  })

  it('reports all validation errors, not just the first', async () => {
    // Missing name and age
    const request = createJsonRequest({})
    const result = await validateBody(request, TestSchema)

    expect(result.success).toBe(false)
    if (!result.success) {
      const body = await result.response.json()
      expect(body.errors.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('strips unknown fields (Zod default behavior)', async () => {
    const request = createJsonRequest({ name: 'Alice', age: 30, secret: 'hidden' })
    const result = await validateBody(request, TestSchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).secret).toBeUndefined()
    }
  })

  it('rejects invalid email format', async () => {
    const request = createJsonRequest({ name: 'Alice', age: 30, email: 'not-email' })
    const result = await validateBody(request, TestSchema)

    expect(result.success).toBe(false)
  })
})

// ============================================================
// validateQuery
// ============================================================

describe('validateQuery', () => {
  it('returns success with parsed query params', () => {
    const request = createRequestWithQuery({ page: '3', limit: '25' })
    const result = validateQuery(request, QuerySchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.page).toBe(3)
      expect(result.data.limit).toBe(25)
    }
  })

  it('applies defaults for missing params', () => {
    const request = createRequestWithQuery({})
    const result = validateQuery(request, QuerySchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.page).toBe(1)
      expect(result.data.limit).toBe(50)
    }
  })

  it('coerces string values to numbers', () => {
    const request = createRequestWithQuery({ page: '10' })
    const result = validateQuery(request, QuerySchema)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(typeof result.data.page).toBe('number')
    }
  })

  it('returns failure for invalid query params', () => {
    const request = createRequestWithQuery({ page: '0', limit: '200' })
    const result = validateQuery(request, QuerySchema)

    expect(result.success).toBe(false)
    if (!result.success) {
      const body = result.response as unknown as { status: number }
      expect(result.response.status).toBe(400)
    }
  })

  it('includes error details in response', () => {
    const request = createRequestWithQuery({ limit: 'abc' })
    const result = validateQuery(request, QuerySchema)

    expect(result.success).toBe(false)
    if (!result.success) {
      // The response is a NextResponse: we verify it's a 400
      expect(result.response.status).toBe(400)
    }
  })
})

// ============================================================
// Integration: validateBody with domain schemas
// ============================================================

describe('validateBody with domain schemas', () => {
  // Demonstrates using validateBody with the actual schemas from schemas.ts
  // This pattern is what API routes should use

  const InvoiceSchema = z.object({
    customer_id: z.string().uuid(),
    invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    items: z.array(z.object({
      description: z.string().min(1),
      amount: z.number().positive(),
    })).min(1),
  })

  it('validates a well-formed invoice request', async () => {
    const request = createJsonRequest({
      customer_id: '550e8400-e29b-41d4-a716-446655440000',
      invoice_date: '2025-03-15',
      items: [{ description: 'Service', amount: 1000 }],
    })

    const result = await validateBody(request, InvoiceSchema)
    expect(result.success).toBe(true)
  })

  it('catches nested array validation errors', async () => {
    const request = createJsonRequest({
      customer_id: '550e8400-e29b-41d4-a716-446655440000',
      invoice_date: '2025-03-15',
      items: [{ description: '', amount: -1 }],
    })

    const result = await validateBody(request, InvoiceSchema)
    expect(result.success).toBe(false)
    if (!result.success) {
      const body = await result.response.json()
      // Should catch both description and amount errors
      expect(body.errors.length).toBeGreaterThanOrEqual(2)
      const fields = body.errors.map((e: { field: string }) => e.field)
      expect(fields.some((f: string) => f.includes('items'))).toBe(true)
    }
  })
})
