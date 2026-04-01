/**
 * Template Embeddings — Core Facade
 *
 * Provides template matching via keyword-based search.
 */

import {
  findMatchingTemplates,
  type TemplateMatch,
} from './booking-templates'
import type { Transaction, EntityType } from '@/types'

/**
 * Find similar templates via keyword matching.
 */
export async function findSimilarTemplates(
  transaction: Transaction,
  entityType?: EntityType,
): Promise<TemplateMatch[]> {
  return findMatchingTemplates(transaction, entityType)
}
