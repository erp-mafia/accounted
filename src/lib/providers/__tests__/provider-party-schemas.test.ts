import { describe, expect, it } from 'vitest'
import schemas from './fixtures/party-schemas.json'
import { mapFortnoxToCustomer, mapFortnoxToSupplier } from '../fortnox/mapper'
import { mapVismaToCustomer, mapVismaToSupplier } from '../visma/mapper'
import { mapBokioToCustomer, mapBokioToSupplier } from '../bokio/mapper'
import { mapWintToCustomer } from '../wint/mapper'

/**
 * Every field a customer or supplier mapper reads must exist in the record
 * the provider publishes. A name the provider does not use reads as nothing,
 * and the card quietly lacks the value: Fortnox's phone (Phone1 on the
 * record), Visma's InvoiceCountryCode and BankgiroNumber, Bokio's
 * paymentDetails (crm#1436).
 *
 * Each mapper runs on a record whose fields are all present, on one whose
 * values are all absent (which walks every fallback), and once per value of
 * every enum field (which walks every branch). Every key it reads is
 * recorded, and a key the provider's schema lacks fails the test. The schemas
 * are the providers' own OpenAPI documents (fixtures/party-schemas.json names
 * the sources). Briox and Björn Lundén publish none, so they are not checked.
 */

type FieldSpec = 'string' | 'number' | 'boolean' | { enum: string[] } | { array: FieldSpec } | { object: Fields }
type Fields = { [key: string]: FieldSpec }

/** Fields read on purpose although the published schema lacks them, with the reason. */
const NOT_IN_SCHEMA: Record<string, Record<string, string>> = {
  fortnox: { '@LastModified': 'read into updatedAt, which no importer uses' },
  wint: { LastUpdated: 'read into updatedAt, which no importer uses' },
}

/** Property names JavaScript itself probes on any object. */
const LANGUAGE_PROBES = new Set(['toJSON', 'then', 'constructor', 'valueOf', 'toString'])

interface Walk {
  unknown: Set<string>
  /** Values absent: containers are still there, every scalar is missing. */
  empty: boolean
  /** The value an enum field takes in this walk, by its path. */
  choice: Map<string, string>
}

function sampleOf(spec: FieldSpec, path: string, walk: Walk): unknown {
  if (typeof spec === 'string') {
    if (walk.empty) return undefined
    return spec === 'string' ? 'x' : spec === 'number' ? 1 : true
  }
  if ('enum' in spec) return walk.empty ? undefined : walk.choice.get(path) ?? spec.enum[0]
  if ('array' in spec) return [sampleOf(spec.array, `${path}[]`, walk)]
  return recordOf(spec.object, `${path}.`, walk)
}

/** A record of the schema that notes every key read that the schema lacks. */
function recordOf(fields: Fields, prefix: string, walk: Walk): Record<string, unknown> {
  const known = (key: string | symbol): key is string => typeof key === 'string' && Object.hasOwn(fields, key)
  const note = (key: string | symbol) => {
    if (typeof key === 'string' && !known(key) && !LANGUAGE_PROBES.has(key)) walk.unknown.add(prefix + key)
  }
  const value = (key: string) => sampleOf(fields[key], prefix + key, walk)
  return new Proxy({}, {
    get: (_target, key) => {
      note(key)
      return known(key) ? value(key) : undefined
    },
    has: (_target, key) => {
      note(key)
      return known(key) && value(key) !== undefined
    },
    ownKeys: () => Object.keys(fields).filter((key) => value(key) !== undefined),
    getOwnPropertyDescriptor: (_target, key) => {
      if (!known(key) || value(key) === undefined) return undefined
      return { configurable: true, enumerable: true, writable: true, value: value(key) }
    },
  })
}

function enumPaths(fields: Fields, prefix = ''): { path: string; values: string[] }[] {
  return Object.entries(fields).flatMap(([key, spec]) => {
    if (typeof spec === 'string') return []
    if ('enum' in spec) return [{ path: prefix + key, values: spec.enum }]
    let inner: FieldSpec = spec
    let path = prefix + key
    while (typeof inner !== 'string' && 'array' in inner) {
      inner = inner.array
      path += '[]'
    }
    return typeof inner !== 'string' && 'object' in inner ? enumPaths(inner.object, `${path}.`) : []
  })
}

/** The keys `map` reads that `fields` does not name, over every walk. */
function unknownReads(map: (raw: Record<string, unknown>) => unknown, fields: Fields): string[] {
  const unknown = new Set<string>()
  const walks: Walk[] = [
    { unknown, empty: false, choice: new Map() },
    { unknown, empty: true, choice: new Map() },
    ...enumPaths(fields).flatMap(({ path, values }) =>
      values.map((value) => ({ unknown, empty: false, choice: new Map([[path, value]]) }))),
  ]
  for (const walk of walks) map(recordOf(fields, '', walk))
  return [...unknown].sort()
}

const MAPPERS = [
  ['fortnox', 'customers', mapFortnoxToCustomer],
  ['fortnox', 'suppliers', mapFortnoxToSupplier],
  ['visma', 'customers', mapVismaToCustomer],
  ['visma', 'suppliers', mapVismaToSupplier],
  ['bokio', 'customers', mapBokioToCustomer],
  ['bokio', 'suppliers', mapBokioToSupplier],
  ['wint', 'customers', mapWintToCustomer],
] as const

const fieldsOf = (provider: string, resource: string): Fields =>
  (schemas as unknown as Record<string, Record<string, { fields: Fields }>>)[provider][resource].fields

describe.each(MAPPERS)('the %s %s mapper', (provider, resource, map) => {
  it('reads only fields the provider publishes', () => {
    const allowed = NOT_IN_SCHEMA[provider] ?? {}
    expect(unknownReads(map, fieldsOf(provider, resource)).filter((key) => !Object.hasOwn(allowed, key))).toEqual([])
  })
})

describe('the check itself', () => {
  const fields: Fields = {
    Phone1: 'string',
    Kind: { enum: ['company', 'private'] },
    Address: { object: { Street: 'string' } },
    Contacts: { array: { object: { Mail: 'string' } } },
  }

  it('catches a field the provider names differently', () => {
    expect(unknownReads((raw) => raw['Phone'], fields)).toEqual(['Phone'])
  })

  it('catches a fallback the provider does not have', () => {
    expect(unknownReads((raw) => raw['Phone1'] ?? raw['Mobile'], fields)).toEqual(['Mobile'])
  })

  it('catches a field read only behind an enum branch', () => {
    expect(unknownReads((raw) => (raw['Kind'] === 'private' ? raw['PersonalNumber'] : raw['Phone1']), fields)).toEqual(['PersonalNumber'])
  })

  it('catches a nested field, in an object and in a list', () => {
    const map = (raw: Record<string, unknown>) => {
      const address = raw['Address'] as Record<string, unknown>
      const [contact] = raw['Contacts'] as Record<string, unknown>[]
      return [address['City'], contact['Email']]
    }
    expect(unknownReads(map, fields)).toEqual(['Address.City', 'Contacts[].Email'])
  })

  it('passes a mapper that reads only what the schema names', () => {
    expect(unknownReads((raw) => [raw['Phone1'], 'Kind' in raw, { ...raw }], fields)).toEqual([])
  })
})
