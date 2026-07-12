import { describe, it, expect } from 'vitest'
import { classifyAccount } from '../account-classifier'

describe('classifyAccount: BAS-known accounts delegate to bas-reference', () => {
  it.each([
    ['1930', 'asset', 'debit'],
    ['2110', 'untaxed_reserves', 'credit'],
    ['2440', 'liability', 'credit'],
    ['3001', 'revenue', 'credit'],
    ['8016', 'revenue', 'credit'],
    ['8310', 'revenue', 'credit'],
    ['8420', 'expense', 'debit'],
    ['8811', 'revenue', 'debit'],
    ['8910', 'expense', 'debit'],
  ] as const)('%s -> %s/%s', (num, type, balance) => {
    expect(classifyAccount(num)).toEqual({ account_type: type, normal_balance: balance })
  })
})

describe('classifyAccount: non-BAS accounts use heuristic fallback', () => {
  it.each([
    ['1355', 'asset', 'debit'],
    ['2199', 'untaxed_reserves', 'credit'],
    ['2999', 'liability', 'credit'],
    ['3099', 'revenue', 'credit'],
    ['4995', 'expense', 'debit'],
    ['7095', 'expense', 'debit'],
    ['8015', 'revenue', 'credit'],
    ['8025', 'revenue', 'credit'],
    ['8195', 'revenue', 'credit'],
    ['8213', 'revenue', 'credit'],
    ['8499', 'expense', 'debit'],
    ['8895', 'revenue', 'credit'],
    ['8995', 'expense', 'debit'],
  ] as const)('%s -> %s/%s', (num, type, balance) => {
    expect(classifyAccount(num)).toEqual({ account_type: type, normal_balance: balance })
  })
})
