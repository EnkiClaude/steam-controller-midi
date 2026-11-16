// One requestAnimationFrame loop for everything that follows the controller
// live. Elements opt in with `data-live="<kind>"` and are written to directly;
// none of this goes through React state.
//
//   btn    data-id            toggles the `data-on` attribute
//   meter  data-id            scaleX by the value (bipolar meters grow from the centre)
//   fill   data-id            scaleY by the value (trigger fill)
//   value  data-id            text readout
//   xy     data-x data-y data-r [data-touch] [data-p]   moves a dot; optional touch / pressure
//   rot    data-id data-amt   rotate by value * amt degrees
//   ty     data-id data-amt   translate Y by -value * amt px

import { INPUT_BY_ID } from '../core/inputs'
import { runtime } from '../runtime'

type LiveEl = (HTMLElement | SVGElement) & { style: CSSStyleDeclaration }

interface Bound {
  el: LiveEl
  kind: string
  id: string
  amt: number
  x: string
  y: string
  touch: string
  p: string
  last: string
}

let bound: Bound[] = []
let dirty = true
let lastVersion = -1
let started = false
const frameSubs = new Set<(now: number) => void>()

/** Run a callback every animation frame (monitor, diagnostics). Returns an unsubscribe. */
export function onFrame(fn: (now: number) => void): () => void {
  frameSubs.add(fn)
  return () => {
    frameSubs.delete(fn)
  }
}

export function formatValue(id: string): string {
  const def = INPUT_BY_ID[id]
  if (!def) return ''
  if (def.kind === 'button') return runtime.state.buttons[id] ? 'On' : 'Off'
  const v = runtime.state.axes[id] ?? 0
  if (def.polarity === 'unipolar') return v.toFixed(2)
  return `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}`
}

function collect(): void {
  bound = []
  document.querySelectorAll<LiveEl>('[data-live]').forEach((el) => {
    const d = el.dataset
    bound.push({
      el,
      kind: d.live ?? '',
      id: d.id ?? '',
      amt: Number(d.amt ?? d.r ?? 0),
      x: d.x ?? '',
      y: d.y ?? '',
      touch: d.touch ?? '',
      p: d.p ?? '',
      last: '\u0000',
    })
  })
}

function apply(b: Bound): void {
  const { buttons, axes } = runtime.state
  const el = b.el
  switch (b.kind) {
    case 'btn': {
      const on = buttons[b.id] === true
      const key = on ? '1' : '0'
      if (key !== b.last) {
        b.last = key
        el.toggleAttribute('data-on', on)
      }
      break
    }
    case 'meter':
    case 'fill': {
      const v = Math.max(-1, Math.min(1, axes[b.id] ?? 0))
      const key = v.toFixed(3)
      if (key !== b.last) {
        b.last = key
        el.style.transform = b.kind === 'meter' ? `scaleX(${key})` : `scaleY(${key})`
      }
      break
    }
    case 'value': {
      const text = formatValue(b.id)
      if (text !== b.last) {
        b.last = text
        // nodeValue rather than textContent: no child-list mutation, so the
        // observer below doesn't re-collect on every change.
        if (el.firstChild) el.firstChild.nodeValue = text
        else el.textContent = text
      }
      break
    }
    case 'xy': {
      const x = (axes[b.x] ?? 0) * b.amt
      const y = -(axes[b.y] ?? 0) * b.amt
      const on = b.touch ? buttons[b.touch] === true : true
      const p = b.p ? Math.max(0, Math.min(1, axes[b.p] ?? 0)) : 0
      const key = `${x.toFixed(1)},${y.toFixed(1)},${on ? 1 : 0},${p.toFixed(2)}`
      if (key !== b.last) {
        b.last = key
        el.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
        if (b.touch) el.toggleAttribute('data-on', on)
        if (b.p) el.style.setProperty('--p', p.toFixed(2))
      }
      break
    }
    case 'rot':
    case 'ty': {
      const v = Math.max(-1, Math.min(1, axes[b.id] ?? 0)) * b.amt
      const key = v.toFixed(1)
      if (key !== b.last) {
        b.last = key
        el.style.transform = b.kind === 'rot' ? `rotate(${key}deg)` : `translateY(${(-v).toFixed(1)}px)`
      }
      break
    }
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame)
  if (dirty) {
    dirty = false
    collect()
    lastVersion = -1
  }
  if (runtime.stateVersion !== lastVersion) {
    lastVersion = runtime.stateVersion
    for (const b of bound) apply(b)
  }
  for (const fn of frameSubs) fn(now)
}

export function startLive(): void {
  if (started) return
  started = true
  new MutationObserver(() => {
    dirty = true
  }).observe(document.body, { childList: true, subtree: true })
  requestAnimationFrame(frame)
}
