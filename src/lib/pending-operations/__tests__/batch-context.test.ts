import { describe, expect, it } from 'vitest'
import { getRiskLevel } from '../risk-tiers'
import {
  assertStageableInBatch,
  batchHighRiskRefusal,
  currentStagingBatchId,
  runWithStagingBatch,
} from '../batch-context'

describe('assertStageableInBatch', () => {
  it('lets every tier through outside a batch', () => {
    expect(() => assertStageableInBatch('create_voucher', 'high')).not.toThrow()
    expect(batchHighRiskRefusal()).toBeNull()
  })

  it('lets low and medium through inside a batch', async () => {
    await runWithStagingBatch('batch-1', async () => {
      expect(() => assertStageableInBatch('ignore_transaction', 'low')).not.toThrow()
      expect(() => assertStageableInBatch('match_transaction_invoice', 'medium')).not.toThrow()
      expect(batchHighRiskRefusal()).toBeNull()
      expect(currentStagingBatchId()).toBe('batch-1')
    })
  })

  it('refuses high inside a batch and records the first refusal for the batch only', async () => {
    await runWithStagingBatch('batch-2', async () => {
      expect(() => assertStageableInBatch('book_invoice', 'high')).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/book_invoice.*never staged in batch/) }),
      )
      expect(() => assertStageableInBatch('send_invoice_peppol', 'high')).toThrow()
      expect(batchHighRiskRefusal()).toBe('book_invoice')
    })
    // A later batch starts clean.
    await runWithStagingBatch('batch-3', async () => {
      expect(batchHighRiskRefusal()).toBeNull()
    })
  })

  // Kept out of batches by the old hand-kept list; their tier is now 'high'
  // so the tier-based check keeps them out (2026-10-11).
  it.each(['dispose_asset', 'match_batch_allocate', 'settle_rot_rut_payout'])(
    '%s is high risk and refused in a batch',
    async (operationType) => {
      expect(getRiskLevel(operationType)).toBe('high')
      await runWithStagingBatch('batch-4', async () => {
        expect(() => assertStageableInBatch(operationType, getRiskLevel(operationType))).toThrow(
          expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        )
      })
    },
  )
})
