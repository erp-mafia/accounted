import { describe, it, expect } from 'vitest'
import { transactionTextSearchFilter } from '../text-search'

describe('transactionTextSearchFilter', () => {
  it('matches description or merchant', () => {
    expect(transactionTextSearchFilter(' Acme ')).toBe('description.ilike.%Acme%,merchant_name.ilike.%Acme%')
  })

  it('is null for a term under two characters, after stripping', () => {
    expect(transactionTextSearchFilter('A')).toBeNull()
    expect(transactionTextSearchFilter('%,')).toBeNull()
  })

  it('strips the filter-DSL and LIKE characters a term could inject a clause with', () => {
    expect(transactionTextSearchFilter('a,company_id.neq.x(*)%\\')).toBe(
      'description.ilike.%a company_id.neq.x%,merchant_name.ilike.%a company_id.neq.x%',
    )
  })
})
