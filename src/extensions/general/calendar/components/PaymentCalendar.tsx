'use client'

import { useState, useCallback } from 'react'
import { Invoice, Deadline, CalendarViewMode } from '@/types'
import {
  getWeekStart,
} from '@/lib/calendar/utils'
import { CalendarHeader } from './CalendarHeader'
import { CalendarGrid } from './CalendarGrid'
import { CalendarWeekView } from './CalendarWeekView'
import { CalendarDayView } from './CalendarDayView'
import { DayDetailModal } from './DayDetailModal'
import { DeadlineForm, type DeadlineFormValues } from '@/components/deadlines/DeadlineForm'

interface PaymentCalendarProps {
  invoices: Invoice[]
  deadlines: Deadline[]
  customers: { id: string; name: string }[]
  onDeadlineCreate: (data: DeadlineFormValues) => Promise<void>
  onDeadlineToggle: (deadline: Deadline) => Promise<void>
}

export function PaymentCalendar({
  invoices,
  deadlines,
  customers,
  onDeadlineCreate,
  onDeadlineToggle,
}: PaymentCalendarProps) {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month')
  const [selectedDate, setSelectedDate] = useState<Date>(today)
  const [showDayModal, setShowDayModal] = useState(false)
  const [modalDate, setModalDate] = useState<Date | null>(null)
  const [showDeadlineForm, setShowDeadlineForm] = useState(false)
  const [deadlineFormDate, setDeadlineFormDate] = useState<Date | null>(null)

  // Navigation handlers based on view mode
  const handlePrevious = useCallback(() => {
    if (viewMode === 'month') {
      if (month === 0) {
        setMonth(11)
        setYear(year - 1)
      } else {
        setMonth(month - 1)
      }
    } else if (viewMode === 'week') {
      const newDate = new Date(selectedDate)
      newDate.setDate(newDate.getDate() - 7)
      setSelectedDate(newDate)
      setYear(newDate.getFullYear())
      setMonth(newDate.getMonth())
    } else if (viewMode === 'day') {
      const newDate = new Date(selectedDate)
      newDate.setDate(newDate.getDate() - 1)
      setSelectedDate(newDate)
      setYear(newDate.getFullYear())
      setMonth(newDate.getMonth())
    }
  }, [viewMode, month, year, selectedDate])

  const handleNext = useCallback(() => {
    if (viewMode === 'month') {
      if (month === 11) {
        setMonth(0)
        setYear(year + 1)
      } else {
        setMonth(month + 1)
      }
    } else if (viewMode === 'week') {
      const newDate = new Date(selectedDate)
      newDate.setDate(newDate.getDate() + 7)
      setSelectedDate(newDate)
      setYear(newDate.getFullYear())
      setMonth(newDate.getMonth())
    } else if (viewMode === 'day') {
      const newDate = new Date(selectedDate)
      newDate.setDate(newDate.getDate() + 1)
      setSelectedDate(newDate)
      setYear(newDate.getFullYear())
      setMonth(newDate.getMonth())
    }
  }, [viewMode, month, year, selectedDate])

  const handleToday = useCallback(() => {
    const today = new Date()
    setYear(today.getFullYear())
    setMonth(today.getMonth())
    setSelectedDate(today)
  }, [])

  const handleViewModeChange = useCallback((mode: CalendarViewMode) => {
    setViewMode(mode)
    // When switching to week view, ensure selectedDate is set properly
    if (mode === 'week') {
      const weekStart = getWeekStart(selectedDate)
      setSelectedDate(weekStart)
    }
  }, [selectedDate])

  const handleDayClick = useCallback((date: Date) => {
    if (viewMode === 'month') {
      // In month view, clicking a day shows the modal
      setModalDate(date)
      setShowDayModal(true)
    } else if (viewMode === 'week') {
      // In week view, clicking a day switches to day view
      setSelectedDate(date)
      setViewMode('day')
      setYear(date.getFullYear())
      setMonth(date.getMonth())
    }
  }, [viewMode])

  const handleAddDeadline = useCallback((date: Date) => {
    setDeadlineFormDate(date)
    setShowDayModal(false)
    setShowDeadlineForm(true)
  }, [])

  const handleDeadlineFormClose = useCallback(() => {
    setShowDeadlineForm(false)
    setDeadlineFormDate(null)
  }, [])

  const handleDeadlineSubmit = useCallback(async (data: DeadlineFormValues) => {
    await onDeadlineCreate(data)
    handleDeadlineFormClose()
  }, [onDeadlineCreate])

  return (
    <div className="space-y-4">
      <div>
          <CalendarHeader
            year={year}
            month={month}
            currentDate={selectedDate}
            viewMode={viewMode}
            onPrevious={handlePrevious}
            onNext={handleNext}
            onToday={handleToday}
            onViewModeChange={handleViewModeChange}
          />

          {/* Month View */}
          {viewMode === 'month' && (
            <CalendarGrid
              year={year}
              month={month}
              invoices={invoices}
              deadlines={deadlines}
              onDayClick={handleDayClick}
            />
          )}

          {/* Week View */}
          {viewMode === 'week' && (
            <CalendarWeekView
              currentDate={selectedDate}
              invoices={invoices}
              deadlines={deadlines}
              onDayClick={handleDayClick}
            />
          )}

          {/* Day View */}
          {viewMode === 'day' && (
            <CalendarDayView
              date={selectedDate}
              invoices={invoices}
              deadlines={deadlines}
              onAddDeadline={handleAddDeadline}
            />
          )}
      </div>

      {/* Day detail modal (for month view clicks) */}
      <DayDetailModal
        date={modalDate}
        invoices={invoices}
        deadlines={deadlines}
        open={showDayModal}
        onOpenChange={setShowDayModal}
        onAddDeadline={handleAddDeadline}
        onToggleDeadline={onDeadlineToggle}
      />

      {/* Deadline form dialog */}
      <DeadlineForm
        open={showDeadlineForm}
        onOpenChange={handleDeadlineFormClose}
        onSubmit={handleDeadlineSubmit}
        initialDate={deadlineFormDate}
        customers={customers}
      />
    </div>
  )
}
