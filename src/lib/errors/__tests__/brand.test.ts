/**
 * Error classes that `instanceof` must recognise across module copies
 * (lib/errors/brand.ts, crm#1282).
 *
 * The helper on its own, then every branded class, then a guard: an error
 * class declared in a module whose objects lib/init registers, or a subclass
 * of a branded class, that is not branded fails here. Such an error is thrown
 * in the instrumentation hook's copy of its module and caught in a route's
 * copy, where a prototype check answers false.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetGlobalSingletons } from '@/lib/global-singleton'
import { brandError, hasErrorBrand, isBrandedInstance } from '../brand'

const SRC = resolve(__dirname, '../../..')

/** Two copies of one branded class, as two bundler layers hold them. */
function brandedClass(brand: string) {
  class Branded extends Error {
    constructor(message: string) {
      super(message)
      brandError(this, brand)
    }

    static [Symbol.hasInstance](value: unknown): boolean {
      return isBrandedInstance(this, Branded, brand, value)
    }
  }
  return Branded
}

describe('the brand helper', () => {
  it('recognises an instance of another copy of the class, both ways', () => {
    const InstrumentationCopy = brandedClass('accounted.test.brandedError')
    const RouteCopy = brandedClass('accounted.test.brandedError')
    expect(RouteCopy).not.toBe(InstrumentationCopy)

    expect(new InstrumentationCopy('x') instanceof RouteCopy).toBe(true)
    expect(new RouteCopy('x') instanceof InstrumentationCopy).toBe(true)
    expect(new RouteCopy('x') instanceof Error).toBe(true)
    expect(hasErrorBrand(new InstrumentationCopy('x'), 'accounted.test.brandedError')).toBe(true)
  })

  it('recognises nothing else: another brand, the same name, a plain error, a non-object', () => {
    const Branded = brandedClass('accounted.test.brandedError')
    const Other = brandedClass('accounted.test.otherError')
    const lookalike = Object.assign(new Error('x'), { name: 'Branded' })

    expect(new Other('x') instanceof Branded).toBe(false)
    expect(lookalike instanceof Branded).toBe(false)
    expect(new Error('x') instanceof Branded).toBe(false)
    for (const value of [null, undefined, 'accounted.test.brandedError', 42] as unknown[]) {
      expect(value instanceof Branded).toBe(false)
      expect(hasErrorBrand(value, 'accounted.test.brandedError')).toBe(false)
    }
  })

  it('answers a subclass without a brand of its own by the prototype chain, never by its parent\'s brand', () => {
    const Branded = brandedClass('accounted.test.brandedError')
    class Unbranded extends Branded {}

    expect(new Unbranded('x') instanceof Unbranded).toBe(true)
    expect(new Unbranded('x') instanceof Branded).toBe(true)
    expect(new Branded('x') instanceof Unbranded).toBe(false)
  })

  it('keeps the mark out of keys and JSON', () => {
    const Branded = brandedClass('accounted.test.brandedError')
    const error = Object.assign(new Branded('x'), { code: 'C' })

    expect(Object.keys(error)).toEqual(['code'])
    expect(JSON.parse(JSON.stringify(error))).toEqual({ code: 'C' })
  })
})

/**
 * Every branded error class. A class added to lib/errors/brand.ts's pattern
 * is listed here: the guard below reads the names, the cases construct one.
 */
const BRANDED_ERRORS = [
  {
    name: 'PaymentProviderError',
    load: async () => {
      const { PaymentProviderError } = await import('@/lib/payments/initiation/provider')
      return { cls: PaymentProviderError, make: () => new PaymentProviderError('refused', 'FORMAT_ERROR', false, 422) }
    },
  },
  {
    name: 'PeppolTransportError',
    load: async () => {
      const { PeppolTransportError } = await import('@/lib/invoices/peppol-transport')
      return { cls: PeppolTransportError, make: () => new PeppolTransportError('busy', { retryable: true, code: 'HTTP_429' }) }
    },
  },
  {
    name: 'QvaliaApiError',
    load: async () => {
      const { QvaliaApiError } = await import('@/lib/invoices/transports/qvalia')
      return { cls: QvaliaApiError, make: () => new QvaliaApiError('auth', 'refused', { httpStatus: 401 }) }
    },
  },
] as const

describe.each(BRANDED_ERRORS)('$name', ({ name, load }) => {
  beforeEach(() => {
    vi.resetModules()
    resetGlobalSingletons()
  })

  it('answers instanceof by its own brand, for an instance of another module copy too', async () => {
    const first = await load()
    const thrown = first.make()
    vi.resetModules()
    const second = await load()

    expect(second.cls).not.toBe(first.cls)
    expect(Object.prototype.hasOwnProperty.call(second.cls, Symbol.hasInstance)).toBe(true)
    expect(thrown instanceof second.cls).toBe(true)
    expect(second.make() instanceof first.cls).toBe(true)
    expect(thrown.name).toBe(name)
  })

  it('keeps its mark non-enumerable', async () => {
    const { make } = await load()
    const error = make()
    const marks = Object.getOwnPropertySymbols(error).filter((symbol) => Symbol.keyFor(symbol)?.startsWith('accounted.'))

    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) expect(Object.getOwnPropertyDescriptor(error, mark)?.enumerable).toBe(false)
  })
})

/**
 * Modules whose objects lib/init registers in a process-wide registry
 * (lib/global-singleton.ts) and that a route calls: an error class declared
 * here is thrown in the instrumentation copy and caught in the route's. A
 * new registry of that kind adds its port and adapters here.
 */
const REGISTERED_BY_INIT = [
  'lib/invoices/peppol-transport.ts',
  'lib/invoices/transports',
  'lib/payments/initiation',
]

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  const out: string[] = []
  for (const name of readdirSync(path)) {
    if (name === 'node_modules' || name === '__tests__') continue
    const child = join(path, name)
    if (statSync(child).isDirectory()) out.push(...sourceFiles(child))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(child)
  }
  return out
}

const CLASS_DECLARATION = /\bclass\s+(\w+)\s+extends\s+([\w.]+)/g

function classDeclarations(files: string[]): Array<{ file: string; name: string; base: string }> {
  return files.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(CLASS_DECLARATION)].map((m) => ({
      file: relative(SRC, file),
      name: m[1],
      base: m[2],
    })),
  )
}

describe('branded error guard', () => {
  const branded = new Set<string>(BRANDED_ERRORS.map((entry) => entry.name))

  it('finds the modules it guards', () => {
    for (const path of REGISTERED_BY_INIT) expect(statSync(join(SRC, path)).isFile() || statSync(join(SRC, path)).isDirectory()).toBe(true)
  })

  it('brands every error class declared where lib/init registers objects a route calls', () => {
    const errors = classDeclarations(REGISTERED_BY_INIT.flatMap((path) => sourceFiles(join(SRC, path))))
      .filter(({ base }) => /Error$/.test(base))
    expect(errors.map(({ name }) => name)).toEqual(expect.arrayContaining(['PaymentProviderError', 'PeppolTransportError', 'QvaliaApiError']))

    const unbranded = errors.filter(({ name }) => !branded.has(name)).map(({ file, name }) => `${file}: ${name}`)
    expect(unbranded, 'brand these with lib/errors/brand.ts and list them in BRANDED_ERRORS').toEqual([])
  })

  it('brands every subclass of a branded error class, anywhere in src', () => {
    const subclasses = classDeclarations(sourceFiles(SRC)).filter(({ base }) => branded.has(base))
    const unbranded = subclasses.filter(({ name }) => !branded.has(name)).map(({ file, name }) => `${file}: ${name}`)
    expect(unbranded, 'brand these with lib/errors/brand.ts and list them in BRANDED_ERRORS').toEqual([])
  })
})
