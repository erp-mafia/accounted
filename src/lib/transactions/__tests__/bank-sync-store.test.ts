import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  claimConnectionsLoad,
  clearBusyConnection,
  getBankSyncSnapshot,
  markConnectionStatus,
  publishConnections,
  releaseConnectionsLoad,
  resetBankSyncStore,
  setBusyConnection,
  setSyncingAll,
  subscribeBankSync,
  type BankConn,
} from '@/lib/transactions/bank-sync-store'

const conn = (id: string, status = 'active'): BankConn => ({
  id,
  bank_name: 'Testbanken',
  status,
  provider: 'enablebanking-se',
  last_synced_at: null,
})

describe('bank-sync-store', () => {
  beforeEach(() => {
    resetBankSyncStore()
  })

  describe('connections load claiming', () => {
    it('lets only the first instance claim the fetch for a company', () => {
      expect(claimConnectionsLoad('co-1')).toBe(true)
      // Second surface mounting while the fetch is in flight must not refetch.
      expect(claimConnectionsLoad('co-1')).toBe(false)
    })

    it('does not re-claim once connections are published', () => {
      expect(claimConnectionsLoad('co-1')).toBe(true)
      publishConnections('co-1', [conn('c1')])
      expect(claimConnectionsLoad('co-1')).toBe(false)
    })

    it('allows a retry after a failed load is released', () => {
      expect(claimConnectionsLoad('co-1')).toBe(true)
      releaseConnectionsLoad('co-1')
      expect(claimConnectionsLoad('co-1')).toBe(true)
    })

    it('claims independently per company (company switch refetches)', () => {
      expect(claimConnectionsLoad('co-1')).toBe(true)
      publishConnections('co-1', [conn('c1')])
      expect(claimConnectionsLoad('co-2')).toBe(true)
      publishConnections('co-2', [conn('c2')])
      expect(getBankSyncSnapshot().companyId).toBe('co-2')
      expect(getBankSyncSnapshot().connections).toEqual([conn('c2')])
    })

    it('discards a stale resolve after the company switched mid-flight', () => {
      expect(claimConnectionsLoad('co-1')).toBe(true) // fetch for co-1 in flight
      expect(claimConnectionsLoad('co-2')).toBe(true) // switch re-claims the slot
      publishConnections('co-2', [conn('c2')])
      // co-1's fetch resolves late: it no longer owns the claim and must not
      // clobber co-2's published list.
      publishConnections('co-1', [conn('c1')])
      expect(getBankSyncSnapshot().companyId).toBe('co-2')
      expect(getBankSyncSnapshot().connections).toEqual([conn('c2')])
    })

    it('ignores a publish that never claimed the load', () => {
      publishConnections('co-1', [conn('c1')])
      expect(getBankSyncSnapshot().connections).toBeNull()
    })
  })

  describe('busy state', () => {
    it('shares busyId through the snapshot and notifies subscribers', () => {
      const listener = vi.fn()
      subscribeBankSync(listener)
      setBusyConnection('c1')
      expect(getBankSyncSnapshot().busyId).toBe('c1')
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('clearBusyConnection only clears when that connection owns busy', () => {
      setBusyConnection('c1')
      clearBusyConnection('c2')
      expect(getBankSyncSnapshot().busyId).toBe('c1')
      clearBusyConnection('c1')
      expect(getBankSyncSnapshot().busyId).toBeNull()
    })

    it('does not notify on a no-op write (stable snapshot identity)', () => {
      setBusyConnection('c1')
      const listener = vi.fn()
      subscribeBankSync(listener)
      const before = getBankSyncSnapshot()
      setBusyConnection('c1')
      setSyncingAll(false)
      expect(listener).not.toHaveBeenCalled()
      expect(getBankSyncSnapshot()).toBe(before)
    })

    it('tracks syncingAll independently of busyId', () => {
      setSyncingAll(true)
      expect(getBankSyncSnapshot().syncingAll).toBe(true)
      expect(getBankSyncSnapshot().busyId).toBeNull()
      setSyncingAll(false)
      expect(getBankSyncSnapshot().syncingAll).toBe(false)
    })
  })

  describe('markConnectionStatus', () => {
    it('updates one connection immutably', () => {
      claimConnectionsLoad('co-1')
      publishConnections('co-1', [conn('c1'), conn('c2')])
      const before = getBankSyncSnapshot().connections
      markConnectionStatus('c1', 'expired')
      const after = getBankSyncSnapshot().connections
      expect(after).not.toBe(before)
      expect(after?.find((c) => c.id === 'c1')?.status).toBe('expired')
      expect(after?.find((c) => c.id === 'c2')?.status).toBe('active')
    })

    it('is a no-op before any connections are loaded', () => {
      const listener = vi.fn()
      subscribeBankSync(listener)
      markConnectionStatus('c1', 'expired')
      expect(listener).not.toHaveBeenCalled()
      expect(getBankSyncSnapshot().connections).toBeNull()
    })
  })

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeBankSync(listener)
    unsubscribe()
    setBusyConnection('c1')
    expect(listener).not.toHaveBeenCalled()
  })
})
