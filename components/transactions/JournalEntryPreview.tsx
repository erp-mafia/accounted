'use client'

import { useMemo } from 'react'
import { formatCurrency } from '@/lib/utils'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import { getVatRate, extractVatAmount, extractNetAmount } from '@/lib/bookkeeping/vat-entries'
import { getCategoryAccountMapping } from '@/lib/bookkeeping/category-mapping'
import type { TransactionCategory, VatTreatment, EntityType, LinePatternEntry } from '@/types'

interface PreviewLine {
  side: 'debet' | 'kredit'
  account: string
  amount: number
}

interface JournalEntryPreviewProps {
  amount: number
  /**
   * SEK-equivalent of `amount` for foreign-currency transactions. When set,
   * all line calculations and the displayed totals use this value: the
   * verifikation must always be in SEK regardless of the source currency.
   * Falls back to `amount` when omitted (i.e. SEK transactions).
   */
  amountSek?: number
  category?: TransactionCategory
  vatTreatment?: VatTreatment | 'none'
  accountOverride?: string
  entityType?: EntityType
  /** For template-based bookings: overrides category mapping */
  templateDebitAccount?: string
  templateCreditAccount?: string
  templateVatRate?: number
  templateVatTreatment?: VatTreatment | null
  templateSupplierType?: 'eu_business' | 'non_eu_business' | 'swedish_business'
  /** For multi-line counterparty template bookings */
  linePattern?: LinePatternEntry[]
  settlementAccount?: string
}

export default function JournalEntryPreview({
  amount,
  amountSek,
  category,
  vatTreatment,
  accountOverride,
  entityType = 'enskild_firma',
  templateDebitAccount,
  templateCreditAccount,
  templateVatRate,
  templateVatTreatment,
  templateSupplierType,
  linePattern,
  settlementAccount = '1930',
}: JournalEntryPreviewProps) {
  const lines = useMemo(() => {
    const result: PreviewLine[] = []
    // Use SEK-equivalent when provided; sign comes from `amount` (which
    // distinguishes income vs expense) but magnitude always comes from SEK.
    const absAmount = Math.abs(amountSek ?? amount)

    // Multi-line counterparty template preview
    if (linePattern && linePattern.length > 0) {
      const isIncome = amount > 0
      const settlementSide = isIncome ? 'debet' : 'kredit'

      // Settlement line
      result.push({ side: settlementSide, account: settlementAccount, amount: absAmount })

      // VAT lines first (from rate)
      let totalVat = 0
      for (const entry of linePattern) {
        if (entry.type === 'vat' && entry.vat_rate) {
          const vatAmt = Math.round(absAmount * entry.vat_rate / (1 + entry.vat_rate) * 100) / 100
          totalVat += vatAmt
          result.push({ side: entry.side === 'debit' ? 'debet' : 'kredit', account: entry.account, amount: vatAmt })
        }
      }

      // Business/tax lines (from ratio against non-VAT amount)
      const nonVatAmt = Math.round((absAmount - totalVat) * 100) / 100
      let allocated = 0
      const ratioEntries = linePattern.filter(e => e.ratio !== undefined)
      for (const entry of ratioEntries) {
        const amt = Math.round(nonVatAmt * (entry.ratio ?? 0) * 100) / 100
        allocated += amt
        result.push({ side: entry.side === 'debit' ? 'debet' : 'kredit', account: entry.account, amount: amt })
      }

      // Rounding difference to 3740
      const totalAllocated = Math.round((totalVat + allocated) * 100) / 100
      const diff = Math.round((absAmount - totalAllocated) * 100) / 100
      if (diff !== 0) {
        const businessSide = linePattern.find(e => e.type === 'business')?.side ?? 'credit'
        result.push({ side: businessSide === 'debit' ? 'debet' : 'kredit', account: '3740', amount: Math.abs(diff) })
      }

      return result
    }

    // Template-based preview
    if (templateDebitAccount && templateCreditAccount) {
      const vatRate = templateVatRate ?? 0
      const vatAmt = extractVatAmount(absAmount, vatRate)
      const netAmt = extractNetAmount(absAmount, vatRate)
      const isIncome = amount > 0
      const isReverseCharge = templateVatTreatment === 'reverse_charge' && !isIncome

      if (isIncome) {
        // Income: debit bank gross, credit revenue net, credit output VAT
        result.push({ side: 'debet', account: templateDebitAccount, amount: absAmount })
        result.push({ side: 'kredit', account: templateCreditAccount, amount: netAmt })
        if (vatAmt > 0) {
          // Map rate → output VAT account (BAS 2611/2621/2631)
          const outputVatAccount = vatRate === 0.06 ? '2631' : vatRate === 0.12 ? '2621' : '2611'
          result.push({ side: 'kredit', account: outputVatAccount, amount: vatAmt })
        }
      } else if (isReverseCharge) {
        // Expense with reverse charge: full reverse-charge verifikation
        // (must match engine output in buildMappingResultFromTemplate).
        const rcRate = 0.25
        const rcVatAmt = Math.round(absAmount * rcRate * 100) / 100
        const supplierType = templateSupplierType ?? 'eu_business'
        const isDomestic = supplierType === 'swedish_business'

        // Expense gross + bank
        result.push({ side: 'debet', account: templateDebitAccount, amount: absAmount })
        result.push({ side: 'kredit', account: templateCreditAccount, amount: absAmount })

        // Fiktiv moms pair: 2645 (or 2647 domestic) / 2614
        result.push({ side: 'debet', account: isDomestic ? '2647' : '2645', amount: rcVatAmt })
        result.push({ side: 'kredit', account: '2614', amount: rcVatAmt })

        // Basbelopp pair: 44xx|45xx / 4598, populates rutor 20-24.
        // Skip if the debit account is already a basis account.
        if (!/^4[45]\d{2}$/.test(templateDebitAccount)) {
          const basisAccount =
            supplierType === 'eu_business' ? '4535'
            : supplierType === 'non_eu_business' ? '4531'
            : '4425'
          result.push({ side: 'debet', account: basisAccount, amount: absAmount })
          result.push({ side: 'kredit', account: '4598', amount: absAmount })
        }
      } else {
        // Expense: debit expense net + input VAT, credit bank gross
        result.push({ side: 'debet', account: templateDebitAccount, amount: netAmt })
        if (vatAmt > 0) {
          result.push({ side: 'debet', account: '2641', amount: vatAmt })
        }
        result.push({ side: 'kredit', account: templateCreditAccount, amount: absAmount })
      }
      return result
    }

    // Category-based preview
    if (!category) return result

    const resolvedVat = vatTreatment === 'none' ? undefined : vatTreatment
    const mapping = getCategoryAccountMapping(category, amount, category !== 'private', entityType, resolvedVat)

    const debitAccount = accountOverride && amount < 0 ? accountOverride : mapping.debitAccount
    const creditAccount = accountOverride && amount > 0 ? accountOverride : mapping.creditAccount

    const treatment = mapping.vatTreatment as VatTreatment | null
    const vatRate = treatment ? getVatRate(treatment) : 0
    const vatAmt = vatRate > 0 ? extractVatAmount(absAmount, vatRate) : 0
    const netAmt = vatRate > 0 ? extractNetAmount(absAmount, vatRate) : absAmount

    if (amount < 0) {
      // Expense: Debit expense + VAT, Credit bank
      result.push({ side: 'debet', account: debitAccount, amount: netAmt })
      if (vatAmt > 0 && mapping.vatDebitAccount) {
        result.push({ side: 'debet', account: mapping.vatDebitAccount, amount: vatAmt })
      }
      result.push({ side: 'kredit', account: creditAccount, amount: absAmount })
    } else {
      // Income: Debit bank, Credit revenue + VAT
      result.push({ side: 'debet', account: debitAccount, amount: absAmount })
      if (vatAmt > 0 && mapping.vatCreditAccount) {
        result.push({ side: 'kredit', account: mapping.vatCreditAccount, amount: vatAmt })
      }
      result.push({ side: 'kredit', account: creditAccount, amount: netAmt })
    }

    // Reverse charge: add offsetting lines
    if (treatment === 'reverse_charge' && amount < 0) {
      const rcVatAmt = Math.round(absAmount * 0.25 * 100) / 100
      result.push({ side: 'debet', account: '2645', amount: rcVatAmt })
      result.push({ side: 'kredit', account: '2614', amount: rcVatAmt })
    }

    return result
  }, [amount, amountSek, category, vatTreatment, accountOverride, entityType, templateDebitAccount, templateCreditAccount, templateVatRate, templateVatTreatment, templateSupplierType, linePattern, settlementAccount])

  if (lines.length === 0) return null

  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2.5 overflow-hidden">
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Verifikation</p>
      <div className="space-y-0.5 font-mono text-xs min-w-0">
        {lines.map((line, i) => (
          <div key={i} className="flex items-baseline gap-2 min-w-0">
            <span className={`w-12 text-right flex-shrink-0 ${line.side === 'debet' ? 'text-foreground' : 'text-muted-foreground'}`}>
              {line.side === 'debet' ? 'Debet' : 'Kredit'}
            </span>
            <span className="flex-1 truncate">{formatAccountWithName(line.account)}</span>
            <span className="flex-shrink-0 tabular-nums">{formatCurrency(line.amount, 'SEK')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
