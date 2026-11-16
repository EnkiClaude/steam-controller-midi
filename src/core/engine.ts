// Mapping engine: controller state in, MIDI messages out. Pure and
// synchronous so it can run straight off the HID input event (which keeps
// firing when the browser tab is in the background) and be unit-tested.

import { INPUT_BY_ID, type AxisDef, type ControllerState } from './inputs'
import type { Mapping } from './mapping'

/** Raw MIDI bytes, e.g. [0x90, 60, 100]. */
export type MidiMessage = number[]

export const noteOn = (ch: number, note: number, vel: number): MidiMessage => [0x90 | (ch - 1), note, vel]
export const noteOff = (ch: number, note: number): MidiMessage => [0x80 | (ch - 1), note, 0]
export const controlChange = (ch: number, cc: number, value: number): MidiMessage => [0xb0 | (ch - 1), cc, value]
export const pitchBend = (ch: number, value14: number): MidiMessage => [
  0xe0 | (ch - 1),
  value14 & 0x7f,
  (value14 >> 7) & 0x7f,
]

interface Runtime {
  /** config snapshot the runtime was built for */
  key: string
  mapping: Mapping
  /** previous raw button state / axis-over-threshold state */
  pressed: boolean
  /** note currently sounding or toggle currently latched */
  on: boolean
  /** note/channel of the sounding note, so note-off always matches note-on */
  heldNote: { ch: number; note: number } | null
  /** last value sent (7-bit CC or 14-bit bend); -1 = nothing sent yet */
  last: number
  /** smoothed position 0-1, null until first sample */
  smoothed: number | null
  active: boolean
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Shape a raw axis value into a 0-1 position (0.5 = rest for bipolar axes). */
export function shapeAxis(raw: number, def: AxisDef, m: Mapping): number {
  const dz = m.deadzone
  let t: number
  if (def.polarity === 'bipolar') {
    const mag = Math.abs(raw)
    let v = mag <= dz ? 0 : (mag - dz) / (1 - dz)
    v = Math.pow(clamp01(v), m.curve)
    t = 0.5 + (Math.sign(raw) * v) / 2
  } else {
    const v = raw <= dz ? 0 : (raw - dz) / (1 - dz)
    t = Math.pow(clamp01(v), m.curve)
  }
  return m.invert ? 1 - t : t
}

/** Position an axis mapping sits at when its input is at rest. */
function restPosition(def: AxisDef, m: Mapping): number {
  return shapeAxis(0, def, m)
}

export class Engine {
  private runtimes = new Map<string, Runtime>()
  private order: Runtime[] = []

  /**
   * Replace the active mappings. Returns the messages needed to cleanly stop
   * anything that was sounding on mappings that changed or went away.
   */
  setMappings(mappings: Mapping[]): MidiMessage[] {
    const out: MidiMessage[] = []
    const next = new Map<string, Runtime>()
    for (const m of mappings) {
      if (!INPUT_BY_ID[m.input]) continue
      const key = JSON.stringify(m)
      const prev = this.runtimes.get(m.id)
      if (prev && prev.key === key) {
        next.set(m.id, prev)
        continue
      }
      if (prev) this.release(prev, out)
      next.set(m.id, {
        key,
        mapping: m,
        // Carry the physical state over so editing a mapping while its
        // button is held doesn't retrigger it.
        pressed: prev?.pressed ?? false,
        on: false,
        heldNote: null,
        last: -1,
        smoothed: null,
        active: false,
      })
    }
    for (const [id, rt] of this.runtimes) {
      if (!next.has(id)) this.release(rt, out)
    }
    this.runtimes = next
    this.order = [...next.values()]
    return out
  }

  /** Stop every sounding note (does not reset CC values). */
  releaseAll(): MidiMessage[] {
    const out: MidiMessage[] = []
    for (const rt of this.order) this.release(rt, out)
    return out
  }

  private release(rt: Runtime, out: MidiMessage[]): void {
    if (rt.heldNote) {
      out.push(noteOff(rt.heldNote.ch, rt.heldNote.note))
      rt.heldNote = null
    }
    rt.on = false
  }

  /** Feed one controller snapshot; returns the MIDI to send, in order. */
  process(state: ControllerState, solo: string | null = null): MidiMessage[] {
    const out: MidiMessage[] = []
    for (const rt of this.order) {
      const m = rt.mapping
      const def = INPUT_BY_ID[m.input]
      const live = m.enabled && (solo === null || solo === m.id)
      if (def.kind === 'button') {
        this.processButton(rt, state.buttons[m.input] === true, live, out)
      } else {
        this.processAxis(rt, def, state, live, out)
      }
    }
    return out
  }

  private setOn(rt: Runtime, on: boolean, out: MidiMessage[]): void {
    const m = rt.mapping
    if (on === rt.on) return
    rt.on = on
    if (m.type === 'note') {
      if (on) {
        rt.heldNote = { ch: m.channel, note: m.note }
        out.push(noteOn(m.channel, m.note, m.velocity))
      } else if (rt.heldNote) {
        out.push(noteOff(rt.heldNote.ch, rt.heldNote.note))
        rt.heldNote = null
      }
    } else {
      out.push(controlChange(m.channel, m.cc, on ? m.max : m.min))
    }
  }

  private processButton(rt: Runtime, pressed: boolean, live: boolean, out: MidiMessage[]): void {
    const m = rt.mapping
    const was = rt.pressed
    rt.pressed = pressed
    if (!live) {
      // Never leave a note hanging when a mapping is muted mid-press.
      if (rt.heldNote) this.setOn(rt, false, out)
      return
    }
    if (pressed === was) return
    if (m.toggle) {
      if (pressed) this.setOn(rt, !rt.on, out)
    } else {
      this.setOn(rt, pressed, out)
    }
  }

  private processAxis(rt: Runtime, def: AxisDef, state: ControllerState, live: boolean, out: MidiMessage[]): void {
    const m = rt.mapping
    const active =
      live &&
      (!def.activeWhile || state.buttons[def.activeWhile] === true) &&
      (m.gate === null || state.buttons[m.gate] === true)

    if (!active) {
      if (rt.active) {
        rt.active = false
        rt.smoothed = null
        if (m.type === 'note') {
          rt.pressed = false
          this.setOn(rt, false, out)
        } else if (m.release === 'reset' && live) {
          this.sendPosition(rt, restPosition(def, m), out)
        }
      } else if (rt.heldNote) {
        this.setOn(rt, false, out)
      }
      return
    }
    rt.active = true

    let t = shapeAxis(state.axes[m.input] ?? 0, def, m)
    if (m.smooth > 0 && rt.smoothed !== null) {
      t = rt.smoothed + (t - rt.smoothed) * (1 - m.smooth)
    }
    rt.smoothed = t

    if (m.type === 'note') {
      // Hysteresis so a value hovering at the threshold doesn't machine-gun.
      const over = rt.pressed ? t >= m.threshold * 0.85 : t >= m.threshold
      rt.pressed = over
      this.setOn(rt, over, out)
      return
    }
    this.sendPosition(rt, t, out)
  }

  private sendPosition(rt: Runtime, t: number, out: MidiMessage[]): void {
    const m = rt.mapping
    if (m.type === 'pitchbend') {
      const v = Math.min(16383, Math.max(0, Math.round(t * 16383)))
      if (v !== rt.last) {
        rt.last = v
        out.push(pitchBend(m.channel, v))
      }
    } else {
      const v = Math.min(127, Math.max(0, Math.round(m.min + t * (m.max - m.min))))
      if (v !== rt.last) {
        rt.last = v
        out.push(controlChange(m.channel, m.cc, v))
      }
    }
  }
}

/**
 * Messages that identify a mapping to a DAW's MIDI-learn without touching the
 * controller. Returned as timed steps; CCs sweep so Live detects an absolute
 * control rather than a relative encoder.
 */
export function learnMessages(m: Mapping): { delayMs: number; message: MidiMessage }[] {
  if (m.type === 'note') {
    return [
      { delayMs: 0, message: noteOn(m.channel, m.note, m.velocity) },
      { delayMs: 120, message: noteOff(m.channel, m.note) },
    ]
  }
  if (m.type === 'pitchbend') {
    return [
      { delayMs: 0, message: pitchBend(m.channel, 10000) },
      { delayMs: 40, message: pitchBend(m.channel, 8192) },
    ]
  }
  const lo = Math.min(m.min, m.max)
  const hi = Math.max(m.min, m.max)
  const mid = Math.round((lo + hi) / 2)
  return [hi, mid, lo].map((v, i) => ({ delayMs: i * 40, message: controlChange(m.channel, m.cc, v) }))
}

/** Human-readable form of a message for the MIDI monitor. */
export function formatMessage(msg: MidiMessage): { kind: string; channel: number; detail: string } {
  const status = msg[0] & 0xf0
  const channel = (msg[0] & 0x0f) + 1
  switch (status) {
    case 0x90:
      return { kind: 'Note On', channel, detail: `${msg[1]} vel ${msg[2]}` }
    case 0x80:
      return { kind: 'Note Off', channel, detail: `${msg[1]}` }
    case 0xb0:
      return { kind: 'CC', channel, detail: `${msg[1]} = ${msg[2]}` }
    case 0xe0:
      return { kind: 'Bend', channel, detail: `${((msg[2] << 7) | msg[1]) - 8192}` }
    default:
      return { kind: 'Other', channel, detail: msg.map((b) => b.toString(16).padStart(2, '0')).join(' ') }
  }
}
