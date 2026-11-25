import { describe, expect, it } from 'vitest'
import { fortnoxVatCodeToTreatment } from '@/lib/providers/fortnox/vat-codes'
import { applyMappingOverride } from '../account-mapper'
import {
  applySourceVatCodes,
  enrichAccountMappingsWithVat,
  enrichChangedAccountMappingWithVat,
} from '../account-vat-treatment'
import { applySourceChartCsv } from '../source-chart/apply-source-chart'
import type { AccountMapping } from '../types'

function mapping(account: string, name: string): AccountMapping {
  return {
    sourceAccount: account,
    sourceName: name,
    targetAccount: account,
    targetName: name,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
  }
}

function spirisChart(...rows: string[]): string {
  return '﻿' + ['IsActive;AccountNumber;AccountName;VatCodeAndPercent', ...rows].join('\r\n') + '\r\n'
}

/** What the mapping step shows for a row: its momskod and whether it asks. */
function outcome(row: AccountMapping) {
  return {
    treatment: row.defaultVatTreatment,
    inReviewList: Boolean(row.requiresVatTreatmentReview && !row.vatTreatmentReviewed),
  }
}

describe('a source momskod that disagrees with the company chart', () => {
  // One account, one input: the company chart says export, the source
  // system says EU goods (Fortnox VTEU, Spiris 35-0%, both ruta 35).
  const chart = [{ account_number: '3541', default_vat_treatment: 'export_goods', default_vat_rate: 0 }] as never
  const row = () => mapping('3541', 'Faktureringsavgifter, EU-land')

  // Fortnox migration: the server attaches the codes to fresh mappings, the
  // workspace enriches them against the chart afterwards.
  const viaFortnox = () => enrichAccountMappingsWithVat(
    applySourceVatCodes([row()], new Map([['3541', 'VTEU']]), fortnoxVatCodeToTreatment),
    chart,
  )[0]

  // Guided SIE import: the page enriches first, then the user adds the
  // source chart file.
  const viaChartFile = () => applySourceChartCsv(
    enrichAccountMappingsWithVat([row()], chart),
    spirisChart('True;3541;Faktureringsavgifter, EU-land;35-0%'),
    chart,
  ).mappings

  // ...and then points the row at another account and back.
  const viaChartFileThenRepoint = () => {
    let rows = viaChartFile()
    rows = enrichChangedAccountMappingWithVat(applyMappingOverride(rows, '3541', '3540', 'Annat'), '3541', chart)
    rows = enrichChangedAccountMappingWithVat(applyMappingOverride(rows, '3541', '3541', 'Faktureringsavgifter, EU-land'), '3541', chart)
    return rows[0]
  }

  it('gets the same answer from the Fortnox path and the chart-file path', () => {
    expect(viaFortnox().providerVatTreatment).toBe('reverse_charge_eu_goods')
    expect(viaChartFile()[0].providerVatTreatment).toBe('reverse_charge_eu_goods')
    expect(outcome(viaFortnox())).toEqual(outcome(viaChartFile()[0]))
  })

  it('keeps its answer when the user re-points the row and back', () => {
    expect(outcome(viaChartFileThenRepoint())).toEqual(outcome(viaChartFile()[0]))
  })
})
