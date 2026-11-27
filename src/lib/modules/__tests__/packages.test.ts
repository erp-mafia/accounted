/**
 * The package map (lib/modules/packages.ts): every module is in exactly one
 * package or explicitly outside them, so a new module fails here until it is
 * placed, and the packages are the ones the Profiles and Suggestions design
 * proposes (2026-10-16).
 */
import { describe, expect, it } from 'vitest'
import { MODULES, MODULE_IDS } from '../manifest'
import {
  NON_PACKAGE_MODULES,
  PACKAGES,
  PACKAGE_CONFIG_KEYS,
  PACKAGE_IDS,
  getPackage,
  packageConfigKey,
  packageForConfigKey,
  packageForModule,
} from '../packages'

describe('package map', () => {
  it('places every manifest module in exactly one package, or lists it as outside every package', () => {
    const placements = new Map<string, string[]>()
    for (const p of PACKAGES) {
      for (const m of p.modules) placements.set(m, [...(placements.get(m) ?? []), p.id])
    }
    for (const m of NON_PACKAGE_MODULES) placements.set(m, [...(placements.get(m) ?? []), '(no package)'])
    const problems = MODULE_IDS.filter((id) => placements.get(id)?.length !== 1).map(
      (id) => `${id}: ${(placements.get(id) ?? ['nowhere']).join(', ')}`,
    )
    expect(
      problems,
      'place the module in one package in lib/modules/packages.ts, or in NON_PACKAGE_MODULES',
    ).toEqual([])
  })

  it('names only modules the manifest knows', () => {
    const known = new Set<string>(MODULE_IDS)
    const unknown = [...PACKAGES.flatMap((p) => p.modules), ...NON_PACKAGE_MODULES].filter((m) => !known.has(m))
    expect(unknown).toEqual([])
  })

  it('lists every package once, each with at least one module, in PACKAGE_IDS order', () => {
    expect(PACKAGES.map((p) => p.id)).toEqual([...PACKAGE_IDS])
    for (const p of PACKAGES) expect(p.modules.length, p.id).toBeGreaterThan(0)
  })

  it('is the design proposal: Bokföring always on, eight switchable packages', () => {
    expect(
      Object.fromEntries(PACKAGES.map((p) => [p.nameSv, { switchable: p.switchable, modules: [...p.modules].sort() }])),
    ).toEqual({
      Bokföring: {
        switchable: false,
        modules: ['capital', 'corporate', 'deadlines', 'formation', 'import', 'ledger', 'parties', 'skatteverket', 'transactions', 'vat', 'year-end'],
      },
      Bank: { switchable: true, modules: ['bank-feed'] },
      Kundfakturor: { switchable: true, modules: ['collections', 'invoicing'] },
      'Leverantörsfakturor och betalningar': { switchable: true, modules: ['payments', 'supplier-invoices'] },
      'Kvitton och underlag': { switchable: true, modules: ['inbox', 'spend'] },
      Utlägg: { switchable: true, modules: ['expenses'] },
      Lön: { switchable: true, modules: ['payroll'] },
      Inventarier: { switchable: true, modules: ['assets'] },
      'Kassa och webbshop': { switchable: true, modules: ['pos', 'webshop'] },
    })
    expect([...NON_PACKAGE_MODULES].sort()).toEqual(['agent', 'byra', 'platform'])
  })

  it('never puts a kernel in a switchable package', () => {
    for (const mod of MODULES.filter((m) => m.kind === 'kernel')) {
      const pkg = packageForModule(mod.id)
      if (pkg) expect(getPackage(pkg).switchable, mod.id).toBe(false)
    }
  })

  it('lists each package module in manifest order', () => {
    const order = new Map(MODULE_IDS.map((id, i) => [id, i]))
    for (const p of PACKAGES) {
      expect([...p.modules].sort((a, b) => order.get(a)! - order.get(b)!), p.id).toEqual([...p.modules])
    }
  })
})

describe('lookups', () => {
  it('finds the package of a module, and none for a module outside every package', () => {
    expect(packageForModule('payroll')).toBe('payroll')
    expect(packageForModule('payments')).toBe('supplier-invoices-and-payments')
    expect(packageForModule('ledger')).toBe('bookkeeping')
    expect(packageForModule('agent')).toBeNull()
    expect(getPackage('no-such-package')).toBeUndefined()
  })

  it('keys a package choice as package:<id> in company_capability_config and reads it back', () => {
    expect(packageConfigKey('pos-and-webshop')).toBe('package:pos-and-webshop')
    expect(PACKAGE_CONFIG_KEYS).toEqual(PACKAGE_IDS.map((id) => `package:${id}`))
    for (const id of PACKAGE_IDS) expect(packageForConfigKey(packageConfigKey(id))).toBe(id)
    expect(packageForConfigKey('bank_sync')).toBeNull()
    expect(packageForConfigKey('package:nope')).toBeNull()
  })
})
