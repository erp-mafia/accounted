'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { useEmployees } from '@/lib/reference-data/hooks'
import { lastOwnerClaimantName, ownerFallbackName, type ClaimantHistoryRow, type ExpensePayer } from '@/lib/expenses/payer'

interface EmployeeOption {
  id: string
  first_name: string
  last_name: string
}

/**
 * Who the utlägg belongs to, once "Vem betalade?" is a person: the owner's
 * name (optional, the shared fallback label otherwise) or one of the
 * company's employees. Shared by the Underlag dialog and the supplier-invoice
 * form so both post the same claimant to the same claims writer. Employees
 * are fetched on first need; the host only sees the chosen id and name.
 *
 * The owner's name opens with the one the company's last owner claim used
 * (lastOwnerClaimantName), once per mount and only into an empty field, so
 * nobody retypes it per receipt and a person typing first is never
 * overwritten (PH 101).
 */
export function ExpenseClaimantFields({
  payer,
  ownerName,
  onOwnerNameChange,
  employeeId,
  onEmployeeChange,
  disabled,
  idPrefix = 'claimant',
  className,
  labelClassName,
  inputClassName,
}: {
  payer: ExpensePayer
  ownerName: string
  onOwnerNameChange: (name: string) => void
  employeeId: string
  /** The picked employee's id and display name ('' when cleared). */
  onEmployeeChange: (id: string, name: string) => void
  disabled?: boolean
  idPrefix?: string
  className?: string
  labelClassName?: string
  inputClassName?: string
}) {
  const t = useTranslations('inbox_workspace')
  // The placeholder is the label the claim gets when the field stays empty,
  // so it must be the form's word for the person (Ägare, Medlem).
  const ownerPlaceholder = ownerFallbackName(useCompanyOptional()?.company?.entity_type)
  // The roster from the session cache, fetched once the payer is an employee.
  const { employees: roster, isLoading: rosterLoading } = useEmployees()
  const employees: EmployeeOption[] = payer === 'employee' ? roster : []
  const employeesLoaded = payer === 'employee' && !rosterLoading
  const remembered = useRememberedOwnerName(payer === 'owner')
  const prefilled = useRef(false)
  useEffect(() => {
    if (prefilled.current || remembered === undefined) return
    prefilled.current = true
    if (remembered && !(ownerName ?? '').trim()) onOwnerNameChange(remembered)
  }, [remembered, ownerName, onOwnerNameChange])

  if (payer === 'owner') {
    return (
      <div className={cn('space-y-1.5', className)}>
        <Label htmlFor={`${idPrefix}-owner`} className={labelClassName}>
          {t('expense_owner_name')}
        </Label>
        <Input
          id={`${idPrefix}-owner`}
          value={ownerName}
          onChange={(e) => onOwnerNameChange(e.target.value)}
          placeholder={ownerPlaceholder}
          disabled={disabled}
          className={inputClassName}
        />
      </div>
    )
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={`${idPrefix}-employee`} className={labelClassName}>
        {t('expense_employee')}
      </Label>
      <Select
        value={employeeId}
        onValueChange={(id) => {
          const picked = employees.find((e) => e.id === id)
          onEmployeeChange(id, picked ? `${picked.first_name} ${picked.last_name}`.trim() : '')
        }}
        disabled={disabled}
      >
        <SelectTrigger id={`${idPrefix}-employee`} className={inputClassName}>
          <SelectValue
            placeholder={employeesLoaded && employees.length === 0 ? t('expense_no_employees') : t('expense_pick_employee')}
          />
        </SelectTrigger>
        <SelectContent>
          {employees.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.first_name} {e.last_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * The owner name the company's claims were last registered under, read
 * once while the owner field shows: undefined while unknown, null when
 * there is none (or the read failed: the field then simply starts empty).
 */
function useRememberedOwnerName(wanted: boolean): string | null | undefined {
  const [name, setName] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!wanted || name !== undefined) return
    const controller = new AbortController()
    fetch('/api/expense-claims', { signal: controller.signal })
      .then(async (res) => (res.ok ? ((await res.json()) as { data?: unknown }).data : null))
      .then((rows) => setName(Array.isArray(rows) ? lastOwnerClaimantName(rows as ClaimantHistoryRow[]) : null))
      .catch(() => {
        if (!controller.signal.aborted) setName(null)
      })
    return () => controller.abort()
  }, [wanted, name])
  return name
}
