'use client'

import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SuccessAnimationProps {
  show: boolean
  title?: string
  description?: string
  onComplete?: () => void
  variant?: 'default' | 'celebration'
}

export function SuccessAnimation({
  show,
  title = 'Klart!',
  description,
  onComplete,
  variant = 'default',
}: SuccessAnimationProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (show) {
      setVisible(true)
      const timer = setTimeout(() => {
        setVisible(false)
        onComplete?.()
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [show, onComplete])

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm animate-fade-in">
      <div className="flex flex-col items-center gap-4 animate-scale-in">
        {/* Animated checkmark */}
        <div className="relative">
          <div className={cn(
            "w-20 h-20 rounded-full flex items-center justify-center",
            "bg-success/10 ring-4 ring-success/20"
          )}>
            <Check className="h-10 w-10 text-success animate-scale-in" style={{ animationDelay: '200ms' }} />
          </div>
          {/* Pulse ring */}
          <div className="absolute inset-0 rounded-full bg-success/10 animate-ping" style={{ animationDuration: '1s', animationIterationCount: '1' }} />
        </div>

        {/* Text */}
        <div className="text-center animate-slide-up" style={{ animationDelay: '300ms' }}>
          <p className="text-lg font-display">{title}</p>
          {description && (
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          )}
        </div>

        {/* Celebration particles */}
        {variant === 'celebration' && (
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="absolute w-2 h-2 rounded-full"
                style={{
                  left: `${50 + Math.cos((i * 30 * Math.PI) / 180) * 40}%`,
                  top: `${50 + Math.sin((i * 30 * Math.PI) / 180) * 40}%`,
                  backgroundColor: ['hsl(145, 20%, 36%)', 'hsl(18, 45%, 55%)', 'hsl(38, 70%, 55%)', 'hsl(150, 30%, 40%)'][i % 4],
                  animation: `fadeIn 0.3s ${i * 50}ms both`,
                  opacity: 0.8,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
