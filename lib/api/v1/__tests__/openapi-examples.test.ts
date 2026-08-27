/**
 * The registry's worked `example` must reach the OpenAPI spec.
 *
 * `EndpointDefinition.example` has always been required, and every endpoint
 * populates `example.response`, but `generateOpenApiSpec()` never emitted it.
 * The examples therefore reached only the docs markdown builder
 * (lib/docs/content/reference.ts); the spec carried none, so spec consumers
 * (skills/accounted-api, client generators, any agent reading
 * /api/v1/openapi.json) saw schemas without a single concrete body.
 *
 * A condensed schema states the shape of a field. An example states the
 * conventions the shape cannot express, which is the half agents get wrong.
 */

import { describe, expect, it } from 'vitest'
import { generateOpenApiSpec, listEndpoints } from '../registry'
// Side-effect import: populates the ENDPOINTS registry from every route file.
import '../load-routes'

type MediaType = { schema?: unknown; example?: unknown }
type OperationObject = {
  requestBody?: { content: Record<string, MediaType> }
  responses: Record<string, { content?: Record<string, MediaType> }>
}

const spec = generateOpenApiSpec('https://unit.test')

function operation(path: string, method: string): OperationObject {
  const op = (spec.paths[path] as Record<string, OperationObject> | undefined)?.[method]
  expect(op, `${method.toUpperCase()} ${path} missing from spec`).toBeDefined()
  return op as OperationObject
}

describe('generateOpenApiSpec examples', () => {
  it('attaches the registry response example to the JSON success media type', () => {
    const op = operation('/api/v1/companies/{companyId}/customers', 'post')
    const example = op.responses['200']?.content?.['application/json']?.example as
      | { data?: unknown }
      | undefined
    expect(example).toBeDefined()
    expect(example).toHaveProperty('data')
  })

  it('attaches the registry request example to the JSON request body', () => {
    const op = operation('/api/v1/companies/{companyId}/customers', 'post')
    const example = op.requestBody?.content['application/json']?.example as
      | Record<string, unknown>
      | undefined
    expect(example).toBeDefined()
    expect(example).toHaveProperty('name')
  })

  it('emits a response example on every JSON success response', () => {
    const missing: string[] = []
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, OperationObject>)) {
        const json = op.responses['200']?.content?.['application/json']
        // 204 endpoints and binary (application/pdf) responses carry no JSON body.
        if (!json) continue
        if (json.example === undefined) missing.push(`${method.toUpperCase()} ${path}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('emits a request example on every JSON request body', () => {
    // `example.request` is optional on EndpointDefinition, but a registered
    // JSON body with no worked example is the gap this test exists to hold
    // shut: an agent reading the spec would get a shape and no conventions.
    const missing: string[] = []
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, OperationObject>)) {
        const json = op.requestBody?.content['application/json']
        if (!json) continue
        if (json.example === undefined) missing.push(`${method.toUpperCase()} ${path}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('does not attach a JSON example to a binary response', () => {
    // A PDF endpoint's registry example describes the JSON envelope it does
    // not send; attaching it to the binary media type would be a lie.
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, OperationObject>)) {
        for (const [contentType, media] of Object.entries(op.responses['200']?.content ?? {})) {
          if (contentType === 'application/json') continue
          expect(media.example, `${method.toUpperCase()} ${path} ${contentType}`).toBeUndefined()
        }
      }
    }
  })

  it('keeps every registered endpoint carrying a response example in the registry', () => {
    const missing = listEndpoints()
      .filter((def) => !def.example?.response)
      .map((def) => def.operation)
    expect(missing).toEqual([])
  })
})
