import { describe, expect, it } from 'vitest'
import { ASSET_ACQUISITION_TYPES, arrivesDepreciated, assetAcquisitionType } from '../acquisition-type'

describe('assetAcquisitionType', () => {
  it('reads a row without the column as a purchase', () => {
    expect(assetAcquisitionType({})).toBe('purchase')
    expect(assetAcquisitionType({ acquisition_type: undefined })).toBe('purchase')
  })

  it('returns what the row states', () => {
    for (const type of ASSET_ACQUISITION_TYPES) expect(assetAcquisitionType({ acquisition_type: type })).toBe(type)
  })
})

describe('arrivesDepreciated', () => {
  it('holds for what is taken over with its depreciation: a fusion or an omklassificering', () => {
    expect(ASSET_ACQUISITION_TYPES.filter(arrivesDepreciated)).toEqual(['merger', 'reclassification'])
  })
})
