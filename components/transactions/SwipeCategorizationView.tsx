'use client'

import { useState, useCallback, useEffect } from 'react'
import { motion, useMotionValue, useTransform, AnimatePresence, type PanInfo } from 'framer-motion'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import VatTreatmentSelect from './VatTreatmentSelect'
import { formatCurrency, formatDate } from '@/lib/utils'
import { checkExpenseWarnings } from '@/lib/tax/expense-warnings'
import { getDefaultAccountForCategory, getDefaultVatTreatmentForCategory } from '@/lib/bookkeeping/category-mapping'
import { getTemplateById, type BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import TemplatePicker from './TemplatePicker'
import JournalEntryPreview from './JournalEntryPreview'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import DocumentUploadZone from '@/components/bookkeeping/DocumentUploadZone'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import { X, ArrowLeft, ArrowRight, Building, AlertTriangle, Check, FileText, Link2, Receipt as ReceiptIcon, SkipForward, Paperclip, ChevronDown, ChevronUp, MessageSquareText } from 'lucide-react'
import DescribeTransactionDialog from './DescribeTransactionDialog'
import { formatAccountWithName } from '@/lib/bookkeeping/client-account-names'
import type { TransactionCategory, VatTreatment, BASAccount, EntityType } from '@/types'
import type { SuggestedCategory, SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import type { TransactionWithInvoice, CategorizeHandler, MatchInvoiceHandler } from './transaction-types'
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, VAT_TREATMENT_OPTIONS } from './transaction-types'

interface SwipeCategorizationViewProps {
  transactions: TransactionWithInvoice[]
  suggestions?: Record<string, SuggestedCategory[]>
  templateSuggestions?: Record<string, SuggestedTemplate[]>
  onCategorize: CategorizeHandler
  onMatchInvoice?: MatchInvoiceHandler
  onClose: () => void
  entityType?: EntityType
}

const expenseCategories = EXPENSE_CATEGORIES
const incomeCategories = INCOME_CATEGORIES

export default function SwipeCategorizationView({
  transactions,
  suggestions,
  templateSuggestions,
  onCategorize,
  onMatchInvoice,
  onClose,
  entityType,
}: SwipeCategorizationViewProps) {
  const { toast } = useToast()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [showCategorySelect, setShowCategorySelect] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Review step state
  const [showReviewStep, setShowReviewStep] = useState(false)
  const [pendingCategory, setPendingCategory] = useState<TransactionCategory | null>(null)
  const [accountOverride, setAccountOverride] = useState('')
  const [vatTreatment, setVatTreatment] = useState<VatTreatment | 'none'>('standard_25')
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([])
  const [showUploadZone, setShowUploadZone] = useState(false)
  const [showDescribeDialog, setShowDescribeDialog] = useState(false)
  const [showVatDropdown, setShowVatDropdown] = useState(false)
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null)
  const [pendingInboxItemId, setPendingInboxItemId] = useState<string | null>(null)

  // Clear VAT treatment when switching to a liability/equity account (class 2)
  useEffect(() => {
    if (accountOverride.startsWith('2') && vatTreatment !== 'none') {
      setVatTreatment('none')
    }
  }, [accountOverride]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch accounts on mount
  useEffect(() => {
    async function fetchAccounts() {
      try {
        const res = await fetch('/api/bookkeeping/accounts')
        const { data } = await res.json()
        if (data) {
          setAccounts(data)
        }
      } catch {
        // Non-critical, AccountCombobox will just be empty
      }
    }
    fetchAccounts()
  }, [])

  const currentTransaction = transactions[currentIndex]
  const warnings = currentTransaction
    ? checkExpenseWarnings(currentTransaction.description)
    : []

  const x = useMotionValue(0)
  const rotate = useTransform(x, [-200, 0, 200], [-15, 0, 15])
  const opacity = useTransform(x, [-200, -100, 0, 100, 200], [0.5, 1, 1, 1, 0.5])

  const businessIndicatorOpacity = useTransform(x, [0, 100, 200], [0, 0.5, 1])
  const skipIndicatorOpacity = useTransform(x, [-200, -100, 0], [1, 0.5, 0])

  const moveToNext = useCallback(() => {
    x.set(0)
    if (currentIndex < transactions.length - 1) {
      setCurrentIndex(currentIndex + 1)
    } else {
      onClose()
    }
  }, [x, currentIndex, transactions.length, onClose])

  const handleDrag = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (isProcessing) return
      x.set(info.offset.x)
    },
    [isProcessing, x]
  )

  const handleCategorySelect = useCallback((category: TransactionCategory) => {
    // Set up review step with defaults for this category
    const defaultAccount = getDefaultAccountForCategory(category)
    const defaultVat = getDefaultVatTreatmentForCategory(category)

    setPendingCategory(category)
    setAccountOverride(defaultAccount)
    setVatTreatment(defaultVat ?? 'none')
    setPendingTemplateId(null)
    setPendingInboxItemId(null)
    setShowVatDropdown(false)
    setShowCategorySelect(false)
    setShowReviewStep(true)
    setError(null)
  }, [])

  const handlePickerTemplateSelect = useCallback((template: BookingTemplate) => {
    setPendingCategory(template.fallback_category)
    setAccountOverride(template.debit_account)
    setVatTreatment(template.vat_treatment ?? 'none')
    setPendingTemplateId(template.id)
    setPendingInboxItemId(null)
    setShowVatDropdown(false)
    setShowCategorySelect(false)
    setShowReviewStep(true)
    setError(null)
  }, [])

  const handleTemplateSelect = useCallback((templateId: string, inboxItemId?: string) => {
    const template = getTemplateById(templateId)
    if (!template) return

    setPendingCategory(template.fallback_category)
    setAccountOverride(template.debit_account)
    setVatTreatment(template.vat_treatment ?? 'none')
    setPendingTemplateId(templateId)
    setPendingInboxItemId(inboxItemId ?? null)
    setShowVatDropdown(false)
    setShowCategorySelect(false)
    setShowReviewStep(true)
    setError(null)
  }, [])

  const handleDragEnd = useCallback(
    async (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (isProcessing || !currentTransaction) return

      const mx = info.offset.x
      const vx = Math.abs(info.velocity.x)
      const shouldSwipe = Math.abs(mx) > 100 || vx > 500

      if (shouldSwipe) {
        if (mx > 0) {
          // Swipe right = categorize as business
          if (currentTransaction.amount < 0) {
            // Show category selector for business expenses
            setShowCategorySelect(true)
            x.set(0)
          } else {
            // Income: go to review step with income_other default
            handleCategorySelect('income_other')
            x.set(0)
          }
        } else {
          // Swipe left = skip
          moveToNext()
        }
      } else {
        x.set(0)
      }
    },
    [isProcessing, currentTransaction, handleCategorySelect, x, moveToNext]
  )

  const resetUploadState = useCallback(() => {
    setUploadedFiles([])
    setShowUploadZone(false)
  }, [])

  const handleReviewConfirm = async () => {
    if (!pendingCategory) return

    setIsProcessing(true)
    setError(null)
    try {
      const resolvedVat = vatTreatment === 'none' ? undefined : vatTreatment
      const defaultAccount = getDefaultAccountForCategory(pendingCategory)
      // Only send override if it differs from the default
      const override = accountOverride && accountOverride !== defaultAccount
        ? accountOverride
        : undefined

      const journalEntryId = await onCategorize(
        currentTransaction.id,
        true,
        pendingCategory,
        resolvedVat,
        override,
        pendingTemplateId ?? undefined,
        pendingInboxItemId ?? undefined
      )
      if (journalEntryId) {
        // Link uploaded documents to the journal entry
        if (uploadedFiles.length > 0) {
          const filesToLink = uploadedFiles.filter((f) => f.status === 'uploaded' && f.id)
          let linkFailCount = 0
          for (const file of filesToLink) {
            try {
              await fetch(`/api/documents/${file.id}/link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ journal_entry_id: journalEntryId }),
              })
            } catch {
              linkFailCount++
            }
          }
          if (linkFailCount > 0) {
            toast({
              title: 'Underlag kunde inte bifogas',
              description: `${linkFailCount} fil(er) kunde inte länkas till verifikationen.`,
              variant: 'destructive',
            })
          }
        }

        resetUploadState()
        setShowReviewStep(false)
        setPendingCategory(null)
        setPendingTemplateId(null)
        setPendingInboxItemId(null)
        moveToNext()
      } else {
        setError('Kunde inte bokföra. Tryck "Hoppa över" för att gå vidare.')
      }
    } catch {
      setError('Ett fel uppstod. Tryck "Hoppa över" för att gå vidare.')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleMatchInvoice = async () => {
    if (!currentTransaction.potential_invoice || !onMatchInvoice) return

    setIsProcessing(true)
    setError(null)
    try {
      const success = await onMatchInvoice(
        currentTransaction.id,
        currentTransaction.potential_invoice.id
      )
      if (success) {
        moveToNext()
      } else {
        setError('Kunde inte matcha faktura. Tryck "Hoppa över" för att gå vidare.')
      }
    } catch {
      setError('Ett fel uppstod. Tryck "Hoppa över" för att gå vidare.')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleSkip = useCallback(() => {
    setError(null)
    setShowCategorySelect(false)
    setShowReviewStep(false)
    setPendingCategory(null)
    setPendingTemplateId(null)
    setPendingInboxItemId(null)
    resetUploadState()
    moveToNext()
  }, [moveToNext, resetUploadState])

  if (!currentTransaction) {
    return (
      <div className="fixed inset-0 bg-background z-50 flex flex-col items-center justify-center">
        <div className="text-center">
          <div className="h-16 w-16 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
            <Check className="h-8 w-8 text-success" />
          </div>
          <h2 className="font-display text-2xl font-medium">Klart!</h2>
          <p className="text-muted-foreground mt-2">
            Alla transaktioner är nu bokförda
          </p>
          <Button onClick={onClose} className="mt-6">
            Tillbaka till transaktioner
          </Button>
        </div>
      </div>
    )
  }

  if (showCategorySelect) {
    const direction = currentTransaction.amount > 0 ? 'income' : 'expense'
    const txSuggestions = templateSuggestions?.[currentTransaction.id]

    return (
      <div className="fixed inset-0 bg-background z-50 flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <Button variant="ghost" size="icon" onClick={() => setShowCategorySelect(false)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold">Välj mall</h1>
          <div className="w-10" />
        </div>

        <Card className="mx-4 mt-3">
          <CardContent className="pt-4">
            <p className="font-medium">{currentTransaction.description}</p>
            <p className="font-display text-2xl font-medium tabular-nums mt-2">
              {formatCurrency(Math.abs(currentTransaction.amount), currentTransaction.currency)}
            </p>
          </CardContent>
        </Card>

        {error && (
          <div className="mx-4 mt-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-hidden mt-2">
          <TemplatePicker
            direction={direction}
            entityType={entityType}
            suggestedTemplates={txSuggestions}
            onSelect={handlePickerTemplateSelect}
            selectedTemplateId={pendingTemplateId ?? undefined}
          />
        </div>

        <div className="p-4 border-t">
          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={handleSkip}
          >
            <SkipForward className="mr-2 h-4 w-4" />
            Hoppa över
          </Button>
        </div>
      </div>
    )
  }

  if (showReviewStep && pendingCategory) {
    const categoryLabel = [...expenseCategories, ...incomeCategories].find(
      (c) => c.value === pendingCategory
    )?.label || pendingCategory
    const selectedTemplate = pendingTemplateId ? getTemplateById(pendingTemplateId) : null

    // Auto-clear VAT when a class 2 (liability/equity) account is selected
    const isLiabilityAccount = accountOverride.startsWith('2')

    return (
      <div className="fixed inset-0 bg-background z-50 flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setShowReviewStep(false)
              setShowCategorySelect(true)
            }}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold">Granska bokföring</h1>
          <div className="w-10" />
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Transaction summary */}
          <Card>
            <CardContent className="pt-4 space-y-1">
              <p className="font-medium">{currentTransaction.description}</p>
              <p className="text-sm text-muted-foreground">{formatDate(currentTransaction.date)}</p>
              <p className="font-display text-2xl font-medium tabular-nums mt-2">
                {currentTransaction.amount > 0 ? '+' : ''}
                {formatCurrency(currentTransaction.amount, currentTransaction.currency)}
              </p>
            </CardContent>
          </Card>

          {/* Selected template or category */}
          <div>
            <label className="text-sm font-medium text-muted-foreground">
              {selectedTemplate ? 'Mall' : 'Kategori'}
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant="outline" className="text-sm py-1 px-3">
                {selectedTemplate ? selectedTemplate.name_sv : categoryLabel}
              </Badge>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => {
                  setShowReviewStep(false)
                  setShowCategorySelect(true)
                }}
              >
                Byt mall
              </button>
            </div>
            {selectedTemplate && (
              <p className="mt-1.5 text-xs font-mono text-muted-foreground">
                D: {formatAccountWithName(selectedTemplate.debit_account)} → K: {formatAccountWithName(selectedTemplate.credit_account)}
              </p>
            )}
          </div>

          {/* Template special rules warning */}
          {selectedTemplate?.special_rules_sv && (
            <div className="rounded-lg border border-warning/30 bg-warning/[0.03] px-3 py-2.5">
              <p className="text-xs text-warning-foreground leading-snug">
                {selectedTemplate.special_rules_sv}
              </p>
            </div>
          )}

          {/* Deductibility note */}
          {selectedTemplate?.deductibility_note_sv && (
            <div className="rounded-lg border border-primary/20 bg-primary/[0.03] px-3 py-2.5">
              <p className="text-xs text-foreground leading-snug">
                {selectedTemplate.deductibility_note_sv}
              </p>
            </div>
          )}

          {/* Reverse charge VAT registration warning */}
          {selectedTemplate?.requires_vat_registration_data && (
            <div className="rounded-lg border border-warning/30 bg-warning/[0.03] px-3 py-2.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-warning-foreground flex-shrink-0 mt-0.5" />
                <p className="text-xs text-warning-foreground leading-snug">
                  Omvänd skattskyldighet kräver leverantörens momsregistreringsnummer och land.
                </p>
              </div>
            </div>
          )}

          {/* Journal entry preview */}
          <JournalEntryPreview
            amount={currentTransaction.amount}
            currency={currentTransaction.currency}
            category={pendingCategory}
            vatTreatment={isLiabilityAccount ? 'none' : vatTreatment}
            accountOverride={accountOverride}
            entityType={entityType}
          />

          {/* Account override */}
          <div>
            <label className="text-sm font-medium text-muted-foreground">Konto</label>
            <div className="mt-1">
              <AccountCombobox
                value={accountOverride}
                accounts={accounts}
                onChange={setAccountOverride}
              />
            </div>
          </div>

          {/* VAT treatment */}
          <div>
            <label className="text-sm font-medium text-muted-foreground">Momsbehandling</label>
            <div className="mt-1">
              {isLiabilityAccount ? (
                <p className="text-sm text-muted-foreground">
                  Ingen moms för skuld-/eget kapital-konton
                </p>
              ) : showVatDropdown ? (
                <VatTreatmentSelect
                  value={vatTreatment}
                  onValueChange={setVatTreatment}
                />
              ) : (
                <p className="text-sm">
                  {VAT_TREATMENT_OPTIONS.find(o => o.value === vatTreatment)?.label || 'Ingen moms'}
                  {' '}
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setShowVatDropdown(true)}
                  >
                    Ändra
                  </button>
                </p>
              )}
            </div>
          </div>

          {/* Document upload / pre-attached document */}
          {pendingInboxItemId && currentTransaction.matched_inbox_item?.document_id ? (
            <div className="rounded-lg border bg-success/5 border-success/30 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Paperclip className="h-4 w-4 text-success" />
                <span className="text-sm font-medium">Underlag bifogat</span>
                <Check className="h-4 w-4 text-success" />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Dokumentet från inkorgen länkas automatiskt till verifikationen.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border">
              <button
                type="button"
                onClick={() => setShowUploadZone(!showUploadZone)}
                className="flex items-center justify-between w-full px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">Underlag</span>
                  {uploadedFiles.filter((f) => f.status === 'uploaded').length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {uploadedFiles.filter((f) => f.status === 'uploaded').length} bifogade
                    </span>
                  )}
                </div>
                {showUploadZone ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
              {showUploadZone && (
                <div className="px-3 pb-3">
                  <DocumentUploadZone
                    files={uploadedFiles}
                    onFilesChange={setUploadedFiles}
                    compact
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="p-4 border-t space-y-2">
          <Button
            className="w-full"
            onClick={handleReviewConfirm}
            disabled={isProcessing || !accountOverride}
          >
            <Check className="mr-2 h-4 w-4" />
            {isProcessing ? 'Bokför...' : 'Bokför'}
          </Button>
          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={handleSkip}
            disabled={isProcessing}
          >
            <SkipForward className="mr-2 h-4 w-4" />
            Hoppa över
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-background z-50 flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-5 w-5" />
        </Button>
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {currentIndex + 1} av {transactions.length}
          </p>
        </div>
        <div className="w-10" />
      </div>

      {/* Instructions */}
      <div className="flex justify-between px-8 py-4 text-sm">
        <div className="flex items-center gap-2 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          <SkipForward className="h-4 w-4" />
          <span>Hoppa över</span>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Bokför</span>
          <Building className="h-4 w-4" />
          <ArrowRight className="h-4 w-4" />
        </div>
      </div>

      {/* Card stack */}
      <div className="flex-1 flex items-center justify-center px-4 relative">
        {/* Swipe indicators */}
        <motion.div
          className="absolute left-8 flex items-center gap-2 text-muted-foreground"
          style={{ opacity: skipIndicatorOpacity }}
        >
          <SkipForward className="h-8 w-8" />
          <span className="font-semibold">Hoppa över</span>
        </motion.div>

        <motion.div
          className="absolute right-8 flex items-center gap-2 text-success"
          style={{ opacity: businessIndicatorOpacity }}
        >
          <span className="font-semibold">Företag</span>
          <Building className="h-8 w-8" />
        </motion.div>

        <AnimatePresence>
          <motion.div
            key={currentTransaction.id}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={1}
            onDrag={handleDrag}
            onDragEnd={handleDragEnd}
            style={{ x, rotate, opacity }}
            className="w-full max-w-sm touch-none cursor-grab active:cursor-grabbing"
          >
            <Card className="shadow-lg">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <Badge variant="outline">{formatDate(currentTransaction.date)}</Badge>
                  <div className="flex items-center gap-2">
                    {currentTransaction.receipt_id && (
                      <Badge variant="secondary" className="gap-1">
                        <ReceiptIcon className="h-3 w-3" />
                        Kvitto
                      </Badge>
                    )}
                    <Badge>{currentTransaction.currency}</Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-lg font-medium">{currentTransaction.description}</p>

                <p
                  className={`text-3xl font-bold ${
                    currentTransaction.amount > 0 ? 'text-success' : ''
                  }`}
                >
                  {currentTransaction.amount > 0 ? '+' : ''}
                  {formatCurrency(currentTransaction.amount, currentTransaction.currency)}
                </p>

                {/* Potential Invoice Match */}
                {currentTransaction.potential_invoice && (
                  <div className="p-4 rounded-lg border-2 border-success/40 bg-success/5 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-success">
                        <FileText className="h-5 w-5" />
                        <span className="font-semibold text-sm">Fakturamatchning hittad</span>
                      </div>
                      <Badge variant="outline" className="text-success border-success">
                        Match
                      </Badge>
                    </div>
                    <div className="text-sm">
                      <p className="font-medium">
                        Faktura {currentTransaction.potential_invoice.invoice_number}
                      </p>
                      <p className="text-muted-foreground">
                        {currentTransaction.potential_invoice.customer?.name || 'Okänd kund'}
                      </p>
                      <p className="font-medium text-success">
                        {formatCurrency(
                          currentTransaction.potential_invoice.total,
                          currentTransaction.potential_invoice.currency
                        )}
                      </p>
                    </div>
                  </div>
                )}

                {/* Document Match from Inbox */}
                {currentTransaction.matched_inbox_item && (
                  <div className="p-4 rounded-lg border-2 border-primary/40 bg-primary/5 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-primary">
                        <Paperclip className="h-5 w-5" />
                        <span className="font-semibold text-sm">
                          {currentTransaction.matched_inbox_item.document_type === 'receipt'
                            ? 'Matchat kvitto'
                            : currentTransaction.matched_inbox_item.document_type === 'supplier_invoice'
                            ? 'Matchad leverantörsfaktura'
                            : 'Matchat dokument'}
                        </span>
                      </div>
                      {currentTransaction.matched_inbox_item.match_confidence != null && (
                        <Badge variant="outline" className="text-primary border-primary">
                          {Math.round(currentTransaction.matched_inbox_item.match_confidence * 100)}%
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm">
                      {(() => {
                        const ext = currentTransaction.matched_inbox_item.extracted_data as Record<string, unknown> | null
                        if (!ext) return null
                        const supplierName = (ext as { supplier?: { name?: string } })?.supplier?.name
                        const merchantName = (ext as { merchant?: { name?: string } })?.merchant?.name
                        const totals = ext as { totals?: { total?: number } }
                        return (
                          <>
                            {(supplierName || merchantName) && (
                              <p className="font-medium">{supplierName || merchantName}</p>
                            )}
                            {totals?.totals?.total != null && (
                              <p className="text-muted-foreground">
                                {formatCurrency(totals.totals.total)}
                              </p>
                            )}
                          </>
                        )
                      })()}
                      {currentTransaction.matched_inbox_item.suggested_template_id && (
                        <p className="text-xs text-primary mt-1">
                          Mall: {currentTransaction.matched_inbox_item.suggested_template_id}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Warnings */}
                {warnings.length > 0 && (
                  <div className="space-y-2 pt-4 border-t">
                    {warnings.map((warning, idx) => (
                      <div
                        key={idx}
                        className={`flex items-start gap-2 p-2 rounded text-sm ${
                          warning.warningLevel === 'danger'
                            ? 'bg-destructive/10 text-destructive'
                            : warning.warningLevel === 'warning'
                            ? 'bg-warning/10 text-warning-foreground'
                            : 'bg-muted'
                        }`}
                      >
                        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="font-medium">{warning.category}</p>
                          <p className="text-xs opacity-90">{warning.message}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Action buttons */}
      <div className="p-4 border-t">
        <div className="flex flex-col gap-3 max-w-sm mx-auto">
          {/* Error message */}
          {error && (
            <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          {/* Document template match — primary action when inbox item has a suggested template */}
          {currentTransaction.matched_inbox_item?.suggested_template_id && (() => {
            const inboxItem = currentTransaction.matched_inbox_item
            if (!inboxItem?.suggested_template_id) return null
            const tmplId = inboxItem.suggested_template_id
            const template = getTemplateById(tmplId)
            if (!template) return null
            return (
              <Button
                className="w-full"
                onClick={() => handleTemplateSelect(tmplId, inboxItem.id)}
                disabled={isProcessing}
              >
                <Paperclip className="mr-2 h-4 w-4" />
                Bokför som {template.name_sv}
              </Button>
            )
          })()}

          {/* Invoice match button - primary action when there's a match */}
          {currentTransaction.potential_invoice && onMatchInvoice && (
            <Button
              className="w-full bg-success hover:bg-success/90 text-success-foreground"
              onClick={handleMatchInvoice}
              disabled={isProcessing}
            >
              <Link2 className="mr-2 h-4 w-4" />
              Matcha med Faktura {currentTransaction.potential_invoice.invoice_number}
            </Button>
          )}

          {/* Suggested categories - shown as quick-select buttons */}
          {suggestions && suggestions[currentTransaction.id] && suggestions[currentTransaction.id].length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground text-center">Föreslagna kategorier</p>
              <div className="grid grid-cols-2 gap-2">
                {suggestions[currentTransaction.id].map((suggestion) => (
                  <Button
                    key={suggestion.category}
                    variant="outline"
                    className="h-auto py-2.5 px-3 text-left justify-start border-primary/30 hover:border-primary hover:bg-primary/5"
                    onClick={() => handleCategorySelect(suggestion.category)}
                    disabled={isProcessing}
                  >
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{suggestion.label}</span>
                      {suggestion.account && (
                        <span className="text-xs text-muted-foreground">{formatAccountWithName(suggestion.account)}</span>
                      )}
                    </div>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Describe transaction button */}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setShowDescribeDialog(true)}
            disabled={isProcessing}
          >
            <MessageSquareText className="mr-2 h-4 w-4" />
            Beskriv transaktion...
          </Button>

          {/* Categorization button */}
          <Button
            className="w-full"
            onClick={() => {
              if (currentTransaction.amount < 0) {
                setShowCategorySelect(true)
              } else {
                handleCategorySelect('income_other')
              }
            }}
            disabled={isProcessing}
          >
            <Building className="mr-2 h-4 w-4" />
            Bokför
          </Button>

          {/* Skip button - always visible */}
          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={handleSkip}
            disabled={isProcessing}
          >
            <SkipForward className="mr-2 h-4 w-4" />
            Hoppa över
          </Button>
        </div>
      </div>

      <DescribeTransactionDialog
        open={showDescribeDialog}
        onOpenChange={setShowDescribeDialog}
        transaction={currentTransaction}
        onCategorized={() => {
          setShowDescribeDialog(false)
          moveToNext()
        }}
        onBatchApplied={() => {
          setShowDescribeDialog(false)
          moveToNext()
        }}
      />
    </div>
  )
}
