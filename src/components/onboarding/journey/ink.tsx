'use client'

/** Word-by-word ink-dry text: each word blurs in with a slight stagger.
 *  Keyed by the text so a changed string re-inks. */
export function InkText({ text, step = 70 }: { text: string; step?: number }) {
  return (
    <span key={text}>
      {text.split(' ').map((w, i) => (
        <span key={`${i}-${w}`} className="jny-ink" style={{ animationDelay: `${i * step}ms` }}>
          {w}
        </span>
      )).reduce<React.ReactNode[]>((acc, node, i) => (i === 0 ? [node] : [...acc, ' ', node]), [])}
    </span>
  )
}
