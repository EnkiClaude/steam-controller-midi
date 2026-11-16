import { useState, type CSSProperties, type ReactNode } from 'react'

export function Switch(props: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      onClick={(e) => {
        e.stopPropagation()
        props.onChange(!props.checked)
      }}
    >
      <span className="switch-knob" />
    </button>
  )
}

export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange(v: T): void
  label: string
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className="seg-item"
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Integer field: type freely, clamps on commit, arrow keys and steppers nudge. */
export function NumField(props: {
  value: number
  min: number
  max: number
  onChange(v: number): void
  label: string
  /** shift+arrow step */
  bigStep?: number
  suffix?: ReactNode
}) {
  const { value, min, max, onChange } = props
  const [draft, setDraft] = useState<string | null>(null)
  const nudge = (d: number) => {
    setDraft(null)
    onChange(clamp(value + d, min, max))
  }
  return (
    <span className="num">
      <input
        className="num-input"
        type="text"
        inputMode="numeric"
        aria-label={props.label}
        value={draft ?? String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const text = e.currentTarget.value.replace(/[^\d-]/g, '')
          setDraft(text)
          const n = Number.parseInt(text, 10)
          if (Number.isFinite(n) && n >= min && n <= max) onChange(n)
        }}
        onBlur={() => {
          if (draft === null) return
          const n = Number.parseInt(draft, 10)
          if (Number.isFinite(n)) onChange(clamp(n, min, max))
          setDraft(null)
        }}
        onKeyDown={(e) => {
          const big = props.bigStep ?? 10
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            nudge(e.shiftKey ? big : 1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            nudge(e.shiftKey ? -big : -1)
          } else if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
      />
      {props.suffix != null && <span className="num-suffix">{props.suffix}</span>}
      <span className="num-steps" aria-hidden="true">
        <button type="button" tabIndex={-1} disabled={value >= max} onClick={() => nudge(1)}>
          <svg viewBox="0 0 8 5" width="8" height="5"><path d="M1 4l3-3 3 3" /></svg>
        </button>
        <button type="button" tabIndex={-1} disabled={value <= min} onClick={() => nudge(-1)}>
          <svg viewBox="0 0 8 5" width="8" height="5"><path d="M1 1l3 3 3-3" /></svg>
        </button>
      </span>
    </span>
  )
}

export function Slider(props: {
  value: number
  min: number
  max: number
  step: number
  onChange(v: number): void
  label: string
  format(v: number): string
}) {
  const pct = ((props.value - props.min) / (props.max - props.min)) * 100
  return (
    <span className="slider-row">
      <input
        type="range"
        className="slider"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        style={{ '--lo': '0%', '--hi': `${pct}%` } as CSSProperties}
        onChange={(e) => props.onChange(Number(e.currentTarget.value))}
      />
      <span className="slider-value">{props.format(props.value)}</span>
    </span>
  )
}

export function Field(props: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={props.wide ? 'field field-wide' : 'field'}>
      <span className="field-label">{props.label}</span>
      {props.children}
    </label>
  )
}

/** Same as Field but for controls that are groups of buttons (a label would forward clicks). */
export function FieldGroup(props: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={props.wide ? 'field field-wide' : 'field'}>
      <span className="field-label">{props.label}</span>
      {props.children}
    </div>
  )
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const Icon = {
  close: (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke} aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
  ),
  trash: (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke} aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.8 7v3.5M9.2 7v3.5" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 16 16" width="12" height="12" {...stroke} aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
  ),
  plus: (
    <svg viewBox="0 0 16 16" width="12" height="12" {...stroke} aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
  ),
  warn: (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke} aria-hidden="true">
      <path d="M8 2.5l6 10.5H2L8 2.5zM8 6.5v3M8 11.3v.2" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 16 16" width="12" height="12" {...stroke} aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
  ),
}
