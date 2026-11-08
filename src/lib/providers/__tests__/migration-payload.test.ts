import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMigrationPayload, sealMigrationPayload, migrationSourceHash } from '../migration-payload'

afterEach(() => vi.unstubAllEnvs())
describe('persisted source payloads', () => {
  it('encrypts personal data with randomized authenticated ciphertext and a stable digest', () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'test-key')
    const source = { id: 'source-10', name: 'Private customer', lines: [{ total: 123 }] }
    const a = sealMigrationPayload(source); const b = sealMigrationPayload(source)
    expect(a.payload).not.toBe(b.payload)
    expect(a.payload_hash).toBe(b.payload_hash)
    expect(Buffer.from(a.payload, 'base64').toString()).not.toContain(source.name)
    expect(openMigrationPayload(a.payload)).toEqual(source)
    const tampered = Buffer.from(a.payload, 'base64'); tampered[30] ^= 1
    expect(() => openMigrationPayload(tampered.toString('base64'))).toThrow()
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'different-key')
    expect(() => openMigrationPayload(a.payload)).toThrow()
  })
  it.each(['development', 'test', 'production'])('requires an explicit key in %s, even after a key was cached', mode => {
    vi.stubEnv('NODE_ENV', mode)
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'test-key')
    const { payload } = sealMigrationPayload({ id: '1' })
    for (const missing of [undefined, '']) {
      vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', missing)
      expect(() => sealMigrationPayload({ id: '2' })).toThrow('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
      expect(() => openMigrationPayload(payload)).toThrow('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
    }
  })
})

describe('semantic source versions', () => {
  it('ignores provider key ordering and technical timestamps while retaining business content', () => {
    const a={id:'invoice',invoiceNumber:'LF',updatedAt:'old',paymentStatus:{paid:false,balance:{value:1499,currencyCode:'SEK'}},_raw:{generated:'old',supplierRef:{id:'s1'}}}
    const b={_raw:{supplierRef:{id:'s1'},generated:'new'},paymentStatus:{balance:{currencyCode:'SEK',value:1499},paid:false},updatedAt:'new',invoiceNumber:'LF',id:'invoice'}
    expect(migrationSourceHash(a)).toBe(migrationSourceHash(b))
    expect(migrationSourceHash({...a,paymentStatus:{paid:true,balance:{value:0,currencyCode:'SEK'}}})).not.toBe(migrationSourceHash(a))
    expect(migrationSourceHash({...a,_raw:{supplierRef:{id:'s2'}}})).not.toBe(migrationSourceHash(a))
  })
  it('detects attachment changes but ignores their ordering', () => {
    const a={id:'invoice',_raw:{uploadRefs:[{id:'one'},{id:'two'}]}}
    expect(migrationSourceHash(a)).toBe(migrationSourceHash({id:'invoice',_raw:{uploadRefs:[{id:'two'},{id:'one'}]}}))
    expect(migrationSourceHash(a)).not.toBe(migrationSourceHash({id:'invoice',_raw:{uploadRefs:[{id:'one'}]}}))
  })
  it('ignores reordered identified invoice rows but detects edits, removals and unidentified row order', () => {
    const a={id:'invoice',lines:[{id:'2',description:'Text'},{id:'1',lineExtensionAmount:{value:100}}]}
    expect(migrationSourceHash(a)).toBe(migrationSourceHash({...a,lines:a.lines.slice().reverse()}))
    expect(migrationSourceHash(a)).not.toBe(migrationSourceHash({...a,lines:[a.lines[0],{...a.lines[1],lineExtensionAmount:{value:200}}]}))
    expect(migrationSourceHash(a)).not.toBe(migrationSourceHash({...a,lines:[a.lines[0]]}))
    expect(migrationSourceHash({lines:[{description:'One'},{description:'Two'}]})).not.toBe(migrationSourceHash({lines:[{description:'Two'},{description:'One'}]}))
  })

})
