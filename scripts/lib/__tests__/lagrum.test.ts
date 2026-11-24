/**
 * Every spelling of a provision reads to one key, a location without its law
 * is reported, and a search matches the provision with its stycken and
 * punkter but not its neighbours.
 */
import { describe, expect, it } from 'vitest'
import {
  findUnresolvedLocations,
  lawRefUrl,
  parseLawQuery,
  parseLawRefs,
  refMatches,
} from '../lagrum.mjs'

const keys = (text: string) => parseLawRefs(text).map((r: { key: string }) => r.key)

describe('parseLawRefs: one key per provision', () => {
  it.each([
    ['ML 17 kap. 24 §', 'sfs:2023:200#K17P24'],
    ['ML 17 kap 24§', 'sfs:2023:200#K17P24'],
    ['enligt 17 kap. 24 § mervärdesskattelagen', 'sfs:2023:200#K17P24'],
    ['17 kap. 24 § i Mervärdesskattelagen', 'sfs:2023:200#K17P24'],
    ['ML 17:24 §', 'sfs:2023:200#K17P24'],
    ['ML **17 kap 24 §**', 'sfs:2023:200#K17P24'],
    ['ML (2023:200) 17 kap. 24 §', 'sfs:2023:200#K17P24'],
    ['17 kap. 24 § NML', 'sfs:2023:200#K17P24'],
  ])('%s', (text, key) => {
    expect(keys(text)).toEqual([key])
  })

  it('reads stycke and punkt, in words and in numbers', () => {
    expect(keys('26 kap. 2 § första stycket SFL')).toEqual(['sfs:2011:1244#K26P2S1'])
    expect(keys('16 kap. 13 § 1 st ML')).toEqual(['sfs:2023:200#K16P13S1'])
    expect(keys('SFL 26 kap. 2 § 3 p.')).toEqual(['sfs:2011:1244#K26P2N3'])
    expect(keys('ÅRL 5:8 § andra stycket')).toEqual(['sfs:1995:1554#K5P8S2'])
  })

  it('reads a whole chapter, a lettered chapter or section, and a law without chapters', () => {
    expect(keys('BFL 3 kap.')).toEqual(['sfs:1999:1078#K3'])
    expect(keys('34 a kap. 2 § IL')).toEqual(['sfs:1999:1229#K34aP2'])
    expect(keys('16 a § semesterlagen')).toEqual(['sfs:1977:480#P16a'])
    expect(keys('lag (2026:100) 2 §')).toEqual(['sfs:2026:100#P2'])
  })

  it('expands ranges and lists, and a later item takes the law named first', () => {
    expect(keys('5 kap. 1-3 §§ BFL')).toEqual(['sfs:1999:1078#K5P1', 'sfs:1999:1078#K5P2', 'sfs:1999:1078#K5P3'])
    expect(keys('17 kap. 24 och 25 §§ ML')).toEqual(['sfs:2023:200#K17P24', 'sfs:2023:200#K17P25'])
    expect(keys('SFL 50-51 kap')).toEqual(['sfs:2011:1244#K50', 'sfs:2011:1244#K51'])
    expect(keys('BFL 5 kap. 5 §; 5 kap. 7 § och 7 kap. 1 §')).toEqual([
      'sfs:1999:1078#K5P5',
      'sfs:1999:1078#K5P7',
      'sfs:1999:1078#K7P1',
    ])
  })

  it('gives a later item in a list its own law when one follows it', () => {
    expect(keys('ML 17 kap. 24 § och 8 kap. 3 § SFL')).toEqual(['sfs:2023:200#K17P24', 'sfs:2011:1244#K8P3'])
  })

  it('reads allmänna råd, cases and preparatory works', () => {
    expect(keys('BFNAR 2013:2 punkt 4.3')).toEqual(['bfnar:2013:2#4.3'])
    expect(keys('HFD 2023 ref. 45')).toEqual(['hfd:2023:45'])
    expect(keys('RÅ 2009 ref. 1')).toEqual(['ra:2009:1'])
    expect(keys('NJA 2015 s. 180')).toEqual(['nja:2015:180'])
    expect(keys('prop. 2025/26:66')).toEqual(['prop:2025/26:66'])
    expect(keys('SOU 2023:12')).toEqual(['sou:2023:12'])
    expect(keys('SFS 2026:119')).toEqual(['sfs:2026:119'])
  })

  it('leaves text that only looks like a citation alone', () => {
    expect(keys('5 ml mjölk och 3 kap')).toEqual([])
    expect(keys('ML 2023:200 is the current act')).toEqual([])
    expect(keys('AB 04 kap 3')).toEqual([])
  })
})

describe('findUnresolvedLocations', () => {
  it('reports a location that names no law', () => {
    expect(findUnresolvedLocations('### 4 kap. 4 §').map((u: { raw: string }) => u.raw)).toEqual(['4 kap.', '4 §'])
  })

  it('reports nothing for a citation that names its law', () => {
    expect(findUnresolvedLocations('Se 4 kap. 4 § BFL och ML 17 kap. 24 §.')).toEqual([])
  })
})

describe('parseLawQuery and refMatches', () => {
  const refs = parseLawRefs(
    'ML 17 kap. 24 §, 17 kap. 24 § första stycket ML, ML 17 kap. 25 §, SFL 17 kap. 24 §',
  )

  it('matches the provision and what is under it, not its neighbours or another law', () => {
    const query = parseLawQuery('ML 17 kap 24 §')
    expect(refs.filter((r: object) => refMatches(r, query)).map((r: { key: string }) => r.key)).toEqual([
      'sfs:2023:200#K17P24',
      'sfs:2023:200#K17P24S1',
    ])
  })

  it('reads a key, a law on its own and a non-SFS key', () => {
    expect(parseLawQuery('sfs:2011:1244#K26P2')).toMatchObject({ sfs: '2011:1244', chapter: '26', section: '2' })
    expect(parseLawQuery('bokföringslagen')).toMatchObject({ key: 'sfs:1999:1078', chapter: null })
    expect(parseLawQuery('BFNAR 2013:2')).toMatchObject({ kind: 'bfnar', key: 'bfnar:2013:2' })
    expect(parseLawQuery('not a law')).toBeNull()
  })

  it('a chapter query matches every provision in the chapter', () => {
    const query = parseLawQuery('ML 17 kap')
    expect(refs.filter((r: object) => refMatches(r, query))).toHaveLength(3)
  })
})

describe('lawRefUrl', () => {
  it('links an SFS key to its text', () => {
    expect(lawRefUrl('sfs:2023:200#K17P24')).toBe('https://lagen.nu/2023:200#K17P24')
    expect(lawRefUrl('sfs:1991:1047#P6')).toBe('https://lagen.nu/1991:1047#P6')
  })

  it('links a case, an allmänt råd without its punkt, and a prop.', () => {
    expect(lawRefUrl('hfd:2023:45')).toBe('https://lagen.nu/dom/hfd/2023:45')
    expect(lawRefUrl('bfnar:2013:2#4.3')).toBe('https://lagen.nu/bfnar/2013:2')
    expect(lawRefUrl('prop:2025/26:66')).toBe('https://lagen.nu/prop/2025/26:66')
    expect(lawRefUrl('nja:2015:180')).toBeNull()
  })
})
