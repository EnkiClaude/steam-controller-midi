// Mapping engine: controller state in, MIDI messages out. Pure and
// synchronous so it can run straight off the HID input event (which keeps
// firing when the browser tab is in the background) and be unit-tested.

import { INPUT_BY_ID, type AxisDef, type ControllerState } from './inputs'
import { gridPadOf, gridZone, type Mapping } from './mapping'
import { SCALES, quantizeNote, stepScale } from './scales'

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

export const channelPressure = (ch: number, value: number): MidiMessage => [0xd0 | (ch - 1), value]

interface MpeVoice {
  ch: number
  /** pad X where the finger came down; bend is relative to it */
  x0: number
  bend: number
  y: number
  pressure: number
}

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
  /** relative mode: fractional steps not yet sent, and the previous position */
  acc: number
  prevT: number | null
  /** note repeat: engine clock time of the next retrigger */
  nextRepeat: number | null
  /** MPE voice while a pad note is held */
  mpe: MpeVoice | null
  /** axis → note: previous travel (for 'speed' velocity) and the velocity it gave */
  prevTravel: number | null
  speedVel: number
}

export interface EngineOptions {
  /** beats per minute, for note repeat */
  tempo: number
  /** scale mode: root 0-11 and an index into SCALES (0 = chromatic, i.e. off) */
  scaleRoot: number
  scale: number
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Shape a raw axis value into a 0-1 position (0.5 = rest for bipolar axes). */
export function shapeAxis(raw: number, def: AxisDef, m: Mapping): number {
  const dz = m.deadzone
  const gain = m.gain ?? 1
  let t: number
  if (def.polarity === 'bipolar') {
    const mag = Math.min(1, Math.abs(raw) * gain)
    let v = mag <= dz ? 0 : (mag - dz) / (1 - dz)
    v = Math.pow(clamp01(v), m.curve)
    t = 0.5 + (Math.sign(raw) * v) / 2
  } else {
    const r = Math.min(1, raw * gain)
    const v = r <= dz ? 0 : (r - dz) / (1 - dz)
    t = Math.pow(clamp01(v), m.curve)
  }
  return m.invert ? 1 - t : t
}

/** Position an axis mapping sits at when its input is at rest. */
function restPosition(def: AxisDef, m: Mapping): number {
  return shapeAxis(0, def, m)
}

/** Full travel in this many seconds or less gives full 'speed' velocity. */
const SPEED_FULL_PER_SEC = 25
/** MPE: member channels use the MPE default bend range of ±48 semitones. */
const MPE_BEND_RANGE = 48

export class Engine {
  private runtimes = new Map<string, Runtime>()
  private order: Runtime[] = []
  private opts: EngineOptions = { tempo: 120, scaleRoot: 0, scale: 0 }
  /** engine time in ms: the caller's clock, or 4 ms per call without one */
  private clock = 0
  private mpeBusy = new Set<number>()
  private mpeNext = 2

  setOptions(o: Partial<EngineOptions>): void {
    const next = { ...this.opts, ...o }
    next.tempo = Math.min(300, Math.max(20, Number.isFinite(next.tempo) ? next.tempo : 120))
    next.scaleRoot = Math.min(11, Math.max(0, Math.round(next.scaleRoot) || 0))
    next.scale = Math.min(SCALES.length - 1, Math.max(0, Math.round(next.scale) || 0))
    this.opts = next
  }

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
        acc: 0,
        prevT: null,
        nextRepeat: null,
        mpe: null,
        prevTravel: null,
        speedVel: m.velocity,
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
    this.freeVoice(rt)
    rt.on = false
    rt.nextRepeat = null
  }

  private freeVoice(rt: Runtime): void {
    if (rt.mpe) {
      this.mpeBusy.delete(rt.mpe.ch)
      rt.mpe = null
    }
  }

  private lastNow: number | null = null
  /** seconds since the previous process() call */
  private dt = 0

  /**
   * Feed one controller snapshot; returns the MIDI to send, in order.
   * `nowMs` is needed for relative mappings on rate-style axes, note repeat
   * and 'speed' velocity; without it the controller's 250 Hz report rate is
   * assumed.
   */
  process(state: ControllerState, solo: string | null = null, nowMs?: number): MidiMessage[] {
    const out: MidiMessage[] = []
    if (nowMs === undefined) {
      this.dt = 0.004
      this.clock += 4
    } else {
      // A long gap (controller asleep, tab suspended) must not turn into a burst.
      this.dt = this.lastNow === null ? 0 : Math.min(0.1, Math.max(0, (nowMs - this.lastNow) / 1000))
      this.lastNow = nowMs
      this.clock = nowMs
    }
    for (const rt of this.order) {
      const m = rt.mapping
      const def = INPUT_BY_ID[m.input]
      const live = m.enabled && (solo === null || solo === m.id)
      if (def.kind === 'button') {
        this.processButton(rt, state, live, out)
      } else {
        this.processAxis(rt, def, state, live, out)
      }
    }
    return out
  }

  /** The note a mapping plays, `offset` grid zones up, after scale mode. */
  private noteFor(m: Mapping, offset: number): number {
    const { scale, scaleRoot } = this.opts
    if (scale > 0 && m.scale !== false) {
      const base = quantizeNote(m.note, scaleRoot, scale)
      return offset > 0 ? stepScale(base, offset, scaleRoot, scale) : base
    }
    return Math.min(127, m.note + offset)
  }

  private velocityFor(rt: Runtime, state: ControllerState): number {
    const m = rt.mapping
    const src = m.velFrom ?? 'fixed'
    if (src === 'fixed') return m.velocity
    if (src === 'speed') return INPUT_BY_ID[m.input].kind === 'axis' ? rt.speedVel : m.velocity
    const v = clamp01(state.axes[src] ?? 0)
    return Math.min(127, Math.max(1, Math.round(m.velMin + v * (m.velocity - m.velMin))))
  }

  private repeatInterval(m: Mapping): number {
    return 60000 / this.opts.tempo / m.repeat
  }

  private setOn(rt: Runtime, on: boolean, out: MidiMessage[], noteOffset = 0, velocity?: number): void {
    const m = rt.mapping
    if (on === rt.on) return
    rt.on = on
    if (m.type === 'note') {
      if (on) {
        const note = this.noteFor(m, noteOffset)
        rt.heldNote = { ch: m.channel, note }
        out.push(noteOn(m.channel, note, velocity ?? m.velocity))
      } else if (rt.heldNote) {
        out.push(noteOff(rt.heldNote.ch, rt.heldNote.note))
        rt.heldNote = null
        this.freeVoice(rt)
      }
      if (!on) rt.nextRepeat = null
    } else {
      out.push(controlChange(m.channel, m.cc, on ? m.max : m.min))
    }
  }

  private processButton(rt: Runtime, state: ControllerState, live: boolean, out: MidiMessage[]): void {
    const m = rt.mapping
    const pressed = state.buttons[m.input] === true
    const was = rt.pressed
    rt.pressed = pressed
    if (!live) {
      // Never leave a note hanging when a mapping is muted mid-press.
      if (rt.heldNote) this.setOn(rt, false, out)
      // A momentary mapping can't stay "on" while muted: if the button is
      // released meanwhile, the next press would be swallowed as a no-op.
      else if (!m.toggle) rt.on = false
      return
    }

    const pad = m.type === 'note' ? gridPadOf(m.input) : null
    if (pad && m.mpe) {
      this.processMpe(rt, state, pad, pressed, was, out)
      return
    }

    if (pressed === was) {
      // Note repeat: retrigger the held note in time.
      if (pressed && rt.heldNote && rt.nextRepeat !== null && this.clock >= rt.nextRepeat) {
        const { ch, note } = rt.heldNote
        out.push(noteOff(ch, note), noteOn(ch, note, this.velocityFor(rt, state)))
        const interval = this.repeatInterval(m)
        rt.nextRepeat += interval
        // Fell behind (a gap in reports): carry on from now rather than catch up in a burst.
        if (rt.nextRepeat <= this.clock) rt.nextRepeat = this.clock + interval
      }
      return
    }
    // Trackpad note grid: the zone under the finger at the moment of the
    // press picks the note.
    let offset = 0
    if (pressed && pad && m.grid > 0) {
      offset = gridZone(state.axes[`${pad}_x`] ?? 0, state.axes[`${pad}_y`] ?? 0, m.grid)
    }
    const velocity = pressed ? this.velocityFor(rt, state) : undefined
    if (m.toggle) {
      if (pressed) this.setOn(rt, !rt.on, out, offset, velocity)
    } else {
      this.setOn(rt, pressed, out, offset, velocity)
      if (pressed && m.type === 'note' && m.repeat > 0) rt.nextRepeat = this.clock + this.repeatInterval(m)
    }
  }

  /** A trackpad note in MPE mode: its own channel, with per-note bend, CC 74 and pressure. */
  private processMpe(
    rt: Runtime,
    state: ControllerState,
    pad: string,
    pressed: boolean,
    was: boolean,
    out: MidiMessage[],
  ): void {
    const m = rt.mapping
    const x = state.axes[`${pad}_x`] ?? 0
    const yVal = Math.min(127, Math.max(0, Math.round(((clamp01(((state.axes[`${pad}_y`] ?? 0) + 1) / 2)) * 127))))
    const pVal = Math.min(127, Math.max(0, Math.round(clamp01(state.axes[`${pad}_pressure`] ?? 0) * 127)))

    if (pressed && !was) {
      if (rt.heldNote) this.setOn(rt, false, out)
      const ch = this.allocateChannel()
      const offset = m.grid > 0 ? gridZone(x, state.axes[`${pad}_y`] ?? 0, m.grid) : 0
      const note = this.noteFor(m, offset)
      // Per MPE: set the channel's expression before the note starts.
      out.push(pitchBend(ch, 8192), controlChange(ch, 74, yVal), channelPressure(ch, pVal))
      out.push(noteOn(ch, note, this.velocityFor(rt, state)))
      rt.on = true
      rt.heldNote = { ch, note }
      rt.mpe = { ch, x0: x, bend: 8192, y: yVal, pressure: pVal }
      return
    }
    if (!pressed && was) {
      this.setOn(rt, false, out)
      return
    }
    const v = rt.mpe
    if (!pressed || !v) return
    const bend = Math.min(16383, Math.max(0, Math.round(8192 + ((x - v.x0) * m.bend * 8192) / MPE_BEND_RANGE)))
    if (bend !== v.bend) {
      v.bend = bend
      out.push(pitchBend(v.ch, bend))
    }
    if (yVal !== v.y) {
      v.y = yVal
      out.push(controlChange(v.ch, 74, yVal))
    }
    if (pVal !== v.pressure) {
      v.pressure = pVal
      out.push(channelPressure(v.ch, pVal))
    }
  }

  /** Round-robin over member channels 2-16, so a released note's tail isn't cut off by the next. */
  private allocateChannel(): number {
    for (let k = 0; k < 15; k++) {
      const ch = 2 + ((this.mpeNext - 2 + k) % 15)
      if (!this.mpeBusy.has(ch)) {
        this.mpeBusy.add(ch)
        this.mpeNext = 2 + ((ch - 2 + 1) % 15)
        return ch
      }
    }
    // All fifteen in use (can't happen with two pads): share the next one.
    const ch = this.mpeNext
    this.mpeNext = 2 + ((ch - 2 + 1) % 15)
    return ch
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
        rt.acc = 0
        rt.prevT = null
        rt.prevTravel = null
        if (m.type === 'relative') {
          // an encoder has no position to hold or reset
        } else if (m.type === 'note') {
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

    const target = shapeAxis(state.axes[m.input] ?? 0, def, m)
    let t = target
    if (m.smooth > 0 && rt.smoothed !== null) {
      t = rt.smoothed + (target - rt.smoothed) * (1 - m.smooth)
      // The filter stalls a few ulps short of its target, which from below
      // rounds the centre to 8191 (or CC 63) for good. Land on it exactly.
      if (Math.abs(target - t) < 1e-6) t = target
    }
    rt.smoothed = t

    if (m.type === 'note') {
      // A bipolar axis rests in the middle, so the note fires on distance
      // from rest in either direction rather than on absolute position.
      const travel = def.polarity === 'bipolar' ? Math.abs(t - 0.5) * 2 : t
      // How fast it is moving, for 'speed' velocity.
      if (rt.prevTravel === null || this.dt <= 0) {
        rt.speedVel = m.velocity
      } else {
        const v = clamp01((travel - rt.prevTravel) / this.dt / SPEED_FULL_PER_SEC)
        rt.speedVel = Math.min(127, Math.max(1, Math.round(m.velMin + v * (m.velocity - m.velMin))))
      }
      rt.prevTravel = travel
      // Hysteresis so a value hovering at the threshold doesn't machine-gun.
      const over = rt.pressed ? travel >= m.threshold * 0.85 : travel >= m.threshold
      rt.pressed = over
      this.setOn(rt, over, out, 0, over && !rt.on ? this.velocityFor(rt, state) : undefined)
      return
    }
    if (m.type === 'relative') {
      if (def.activeWhile) {
        // Trackpad: steps follow finger travel, like turning a knob.
        if (rt.prevT !== null) rt.acc += (t - rt.prevT) * m.speed
        rt.prevT = t
      } else {
        // Stick / trigger / motion: deflection sets how fast it turns.
        const v = def.polarity === 'bipolar' ? (t - 0.5) * 2 : t
        rt.acc += v * m.speed * this.dt
      }
      const steps = Math.trunc(rt.acc)
      if (steps !== 0) {
        rt.acc -= steps
        // Two's-complement relative CC: 1..63 = up, 127..65 = down.
        const n = Math.max(-63, Math.min(63, steps))
        out.push(controlChange(m.channel, m.cc, n > 0 ? n : 128 + n))
      }
      return
    }
    if (rt.last === -1 && !def.activeWhile && m.gate === null) {
      // First sample of an always-on axis: remember where it is but stay
      // quiet, so connecting the controller or editing a mapping doesn't
      // yank a parameter in the DAW to the axis's rest value.
      this.sendPosition(rt, t, [])
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
  if (m.type === 'relative') {
    // Two steps up then two back down, so the parameter ends where it started.
    return [1, 1, 127, 127].map((v, i) => ({ delayMs: i * 40, message: controlChange(m.channel, m.cc, v) }))
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
    case 0xd0:
      return { kind: 'Pressure', channel, detail: `${msg[1]}` }
    default:
      return { kind: 'Other', channel, detail: msg.map((b) => b.toString(16).padStart(2, '0')).join(' ') }
  }
}
