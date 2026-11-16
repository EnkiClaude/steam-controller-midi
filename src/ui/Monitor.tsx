import { useEffect, useRef, useState } from 'react'
import { formatMessage } from '../core/engine'
import { noteName } from '../core/mapping'
import { runtime, type MonitorEntry } from '../runtime'
import { useApp } from '../store'
import { Icon } from './controls'
import { onFrame } from './live'

const MAX_ROWS = 80
/** entries at or below this seq were cleared by the user */
let clearedSeq = 0

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = cls
  s.textContent = text
  return s
}

function timeText(ms: number): string {
  const total = Math.floor(ms)
  const m = Math.floor(total / 60000)
  const s = Math.floor(total / 1000) % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`
}

function buildRow(e: MonitorEntry): HTMLDivElement {
  const f = formatMessage(e.message)
  const row = document.createElement('div')
  row.className = e.sent ? 'mon-row' : 'mon-row mon-unsent'
  const isNote = f.kind === 'Note On' || f.kind === 'Note Off'
  row.append(
    span('mon-time', timeText(e.time)),
    span(`mon-kind mon-kind-${f.kind.replace(' ', '').toLowerCase()}`, f.kind),
    span('mon-ch', `ch ${f.channel}`),
    span('mon-detail', isNote ? `${noteName(e.message[1])}  ${f.detail}` : f.detail),
  )
  if (!e.sent) {
    const reason = !runtime.hasOutput ? 'not sent: no output selected' : useApp.getState().learn ? 'not sent: learn mode' : 'not sent'
    row.append(span('mon-reason', reason))
  }
  return row
}

export function Monitor() {
  const [open, setOpen] = useState(true)
  const list = useRef<HTMLDivElement>(null)
  const led = useRef<HTMLSpanElement>(null)

  // Activity light: runs whether or not the list is open.
  useEffect(() => {
    let seen = runtime.monitorSeq
    let litUntil = 0
    let lit = false
    return onFrame((now) => {
      if (runtime.monitorSeq !== seen) {
        seen = runtime.monitorSeq
        litUntil = now + 90
      }
      const want = now < litUntil
      if (want !== lit) {
        lit = want
        led.current?.toggleAttribute('data-on', lit)
      }
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const el = list.current
    if (!el) return
    el.replaceChildren()
    let shown = clearedSeq
    return onFrame(() => {
      if (shown < clearedSeq) {
        shown = clearedSeq
        el.replaceChildren()
      }
      if (runtime.monitorSeq === shown) return
      const fresh = runtime.monitor.filter((e) => e.seq > shown).slice(-MAX_ROWS)
      shown = runtime.monitorSeq
      const frag = document.createDocumentFragment()
      for (let i = fresh.length - 1; i >= 0; i--) frag.append(buildRow(fresh[i]))
      el.prepend(frag)
      while (el.childElementCount > MAX_ROWS) el.lastElementChild?.remove()
    })
  }, [open])

  return (
    <section className={open ? 'monitor' : 'monitor monitor-closed'} aria-label="MIDI monitor">
      <div className="monitor-head">
        <button type="button" className="monitor-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="caret">{Icon.chevron}</span>
          MIDI monitor
        </button>
        <span className="led" ref={led} aria-hidden="true" />
        <span className="monitor-space" />
        <button
          type="button"
          className="btn btn-small btn-ghost"
          onClick={() => {
            clearedSeq = runtime.monitorSeq
          }}
        >
          Clear
        </button>
      </div>
      {open && (
        <div
          className="monitor-list"
          ref={list}
          role="log"
          aria-label="Recent MIDI messages, newest first"
          tabIndex={0}
          data-empty="No MIDI yet. Press something on the controller, or use Test in the inspector."
        />
      )}
    </section>
  )
}
