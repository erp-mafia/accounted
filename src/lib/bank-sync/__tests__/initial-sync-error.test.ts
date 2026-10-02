import { describe, expect, it } from 'vitest'
import {
  INITIAL_SYNC_DEFERRED,
  INITIAL_SYNC_TIMEOUT,
  classifyInitialSyncError,
} from '../initial-sync-error'

describe('classifyInitialSyncError', () => {
  it('reads the deferred code', () => {
    expect(classifyInitialSyncError(INITIAL_SYNC_DEFERRED)).toBe('deferred')
  })

  it('reads the timeout code', () => {
    expect(classifyInitialSyncError(INITIAL_SYNC_TIMEOUT)).toBe('timeout')
  })

  it('treats any other message as a failure, never as text to show', () => {
    expect(
      classifyInitialSyncError(
        'Bank transaction persistence failed: duplicate key value violates unique constraint "idx_transactions_company_external_id"'
      )
    ).toBe('failed')
    expect(classifyInitialSyncError('ASPSP_DOWN')).toBe('failed')
  })

  it('is null when there is nothing to show', () => {
    expect(classifyInitialSyncError(undefined)).toBeNull()
    expect(classifyInitialSyncError(null)).toBeNull()
    expect(classifyInitialSyncError('')).toBeNull()
    expect(classifyInitialSyncError('   ')).toBeNull()
    expect(classifyInitialSyncError(42)).toBeNull()
  })

  it('keeps the wire values the accounts route and its tests assert on', () => {
    expect(INITIAL_SYNC_DEFERRED).toBe('initial_sync_deferred')
    expect(INITIAL_SYNC_TIMEOUT).toBe('initial_sync_timeout')
  })
})
