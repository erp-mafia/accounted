'use client'

import { useTranslations } from 'next-intl'
import { PercentBadgeIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { isReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import {
  DEFAULT_VOUCHER_LINE_VAT_RATE,
  VOUCHER_LINE_VAT_KINDS,
  VOUCHER_LINE_VAT_RATES,
  isVoucherLineVatRate,
  vatCodeBasisBox,
  type VoucherLineVatCode,
  type VoucherLineVatCodeRule,
} from '@/lib/bookkeeping/voucher-line-vat-code'

type TakesVatCode = Exclude<VoucherLineVatCodeRule, { mode: 'none' }>

/** "Omvänd moms 25 % · ruta 22": the rate and the box the base lands in. */
function useVatCodeText() {
  const t = useTranslations('journal_form')
  return (rule: TakesVatCode, code: VoucherLineVatCode) =>
    t('vat_code_badge', {
      rate: Math.round(code.rate * 100),
      box: vatCodeBasisBox(rule, code).replace('ruta', ''),
    })
}

/** Which momskod a line carries, shown under its description (not by colour alone). */
export function LineVatCodeBadge({ rule, code }: { rule: TakesVatCode; code: VoucherLineVatCode }) {
  const text = useVatCodeText()
  return (
    <Badge variant="outline" className="mt-1 mr-1 text-[11px] font-normal tabular-nums">
      {text(rule, code)}
    </Badge>
  )
}

interface LineVatCodeMenuProps {
  /** What the line's account allows (lib/bookkeeping/voucher-line-vat-code.ts). */
  rule: TakesVatCode
  /** The momskod that applies to the line now, null when none does. */
  code: VoucherLineVatCode | null
  /** A code; null switches an account's own code off; undefined is no choice. */
  onChange: (code: VoucherLineVatCode | null | undefined) => void
}

/**
 * Picks the momskod of one konteringsrad (crm#1096). On an ordinary cost
 * account: the reverse-charge purchase type and its self-assessed rate. On an
 * account that reports its own ruta 20-24, box and rate are the account's, so
 * the code is only on or off. The lines it generates render under the row;
 * this menu only sets the code.
 */
export function LineVatCodeMenu({ rule, code, onChange }: LineVatCodeMenuProps) {
  const t = useTranslations('journal_form')
  const text = useVatCodeText()
  const label = code ? t('vat_code_current', { code: text(rule, code) }) : t('vat_code_aria')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          className={code ? 'text-foreground' : 'text-muted-foreground'}
        >
          <PercentBadgeIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t('vat_code_label')}</DropdownMenuLabel>
        {rule.mode === 'fixed' ? (
          <>
            <DropdownMenuRadioGroup
              value={code ? 'on' : 'none'}
              onValueChange={(value) => onChange(value === 'on' ? rule.code : null)}
            >
              <DropdownMenuRadioItem value="none">{t('vat_code_none')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="on">
                {t('vat_code_account_option', {
                  rate: Math.round(rule.code.rate * 100),
                  box: rule.box.replace('ruta', ''),
                })}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <p className="px-2 py-1 text-[11px] text-muted-foreground">{t('vat_code_account_help')}</p>
          </>
        ) : (
          <>
            <DropdownMenuRadioGroup
              value={code?.kind ?? 'none'}
              onValueChange={(value) =>
                onChange(
                  isReverseChargeKind(value)
                    ? { kind: value, rate: code?.rate ?? DEFAULT_VOUCHER_LINE_VAT_RATE }
                    : undefined,
                )
              }
            >
              <DropdownMenuRadioItem value="none">{t('vat_code_none')}</DropdownMenuRadioItem>
              {VOUCHER_LINE_VAT_KINDS.map((kind) => (
                <DropdownMenuRadioItem key={kind} value={kind}>
                  {t(`vat_code_kind_${kind}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {code && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t('vat_code_rate_label')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={String(code.rate)}
                  onValueChange={(value) => {
                    const rate = Number(value)
                    if (isVoucherLineVatRate(rate)) onChange({ kind: code.kind, rate })
                  }}
                >
                  {VOUCHER_LINE_VAT_RATES.map((rate) => (
                    <DropdownMenuRadioItem key={rate} value={String(rate)}>
                      {t('vat_code_rate_option', { rate: Math.round(rate * 100) })}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <p className="px-2 py-1 text-[11px] text-muted-foreground">{t('vat_code_help')}</p>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
