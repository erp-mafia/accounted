import { describe, it, expect } from 'vitest'
import { assetResultNeedsDetail } from '../asset-result'

describe('assetResultNeedsDetail', () => {
  it('is quiet for a clean import', () => {
    expect(assetResultNeedsDetail({ skipped: 0 })).toBe(false)
    expect(assetResultNeedsDetail({ skipped: 0, skipReasons: {} })).toBe(false)
  })

  it('speaks up when assets were skipped', () => {
    expect(assetResultNeedsDetail({ skipped: 2, skipReasons: { inactive: 2 } })).toBe(true)
  })

  // typeUnresolved counts IMPORTED assets, so it arrives with skipped at 0.
  // Gating on skips alone hid it in exactly the run it describes.
  it('speaks up for assets on default accounts when nothing was skipped', () => {
    expect(assetResultNeedsDetail({ skipped: 0, skipReasons: { typeUnresolved: 1 } })).toBe(true)
  })

  it('treats a zero unresolved count as nothing to say', () => {
    expect(assetResultNeedsDetail({ skipped: 0, skipReasons: { typeUnresolved: 0 } })).toBe(false)
  })
})
