// Tests for the 0.2 playing features: velocity sources, gain, note repeat,
// scale mode and MPE. Checked against MIDI semantics (every note-on gets a
// note-off on the same key and channel, data bytes are 7-bit, bend centre is
// 8192) and the intent stated in mapping.ts, not against the code's formulas.

import { describe, expect, it } from 'vitest'
import { Engine, formatMessage, shapeAxis, type MidiMessage } from './engine'
import { INPUT_BY_ID, emptyState, type AxisDef, type ControllerState } from './inputs'
import { createMapping, type Mapping } from './mapping'
import { SCALES, quantizeNote, scaleIndex, stepScale } from './scales'

const NOTE_OFF = 0x80
const NOTE_ON = 0x90
const CC = 0xb0
const PRESSURE = 0xd0
const BEND = 0xe0

const on = (ch: number, n: number, v: number): MidiMessage => [NOTE_ON | (ch - 1), n, v]
const off = (ch: number, n: number): MidiMessage => [NOTE_OFF | (ch - 1), n, 0]
const bend14 = (m: MidiMessage) => (m[2] << 7) | m[1]
const status = (m: MidiMessage) => m[0] & 0xf0
const chOf = (m: MidiMessage) => (m[0] & 0x0f) + 1

let seq = 0
function mk(input: string, o: Partial<Mapping> = {}): Mapping {
  seq += 1
  return createMapping(input, { id: `f${seq}`, deadzone: 0, smooth: 0, curve: 1, ...o })
}

/** Engine with one at-rest report already processed (untimed clock). */
function setup(mappings: Mapping[], opts?: Parameters<Engine['setOptions']>[0]) {
  const engine = new Engine()
  if (opts) engine.setOptions(opts)
  engine.setMappings(mappings)
  const state = emptyState()
  expect(engine.process(state)).toEqual([])
  return { engine, state }
}

/** Engine on a timed clock, primed with an at-rest report at t = 0. */
function setupTimed(mappings: Mapping[], opts?: Parameters<Engine['setOptions']>[0]) {
  const engine = new Engine()
  if (opts) engine.setOptions(opts)
  engine.setMappings(mappings)
  const state = emptyState()
  expect(engine.process(state, null, 0)).toEqual([])
  return { engine, state }
}

const set = (state: ControllerState, patch: { b?: Record<string, boolean>; a?: Record<string, number> }) => {
  Object.assign(state.buttons, patch.b ?? {})
  Object.assign(state.axes, patch.a ?? {})
}

/** Tracks sounding notes; fails on a double note-on or an unmatched note-off. */
function noteTracker() {
  const sounding = new Set<string>()
  return {
    sounding,
    feed(msgs: MidiMessage[]) {
      for (const m of msgs) {
        expect(m.length, `[${m}]`).toBe(status(m) === PRESSURE ? 2 : 3)
        for (const d of m.slice(1)) expect(Number.isInteger(d) && d >= 0 && d <= 127, `[${m}]`).toBe(true)
        const key = `${chOf(m)}:${m[1]}`
        if (status(m) === NOTE_ON) {
          expect(m[2], 'velocity 0 would be a note-off').toBeGreaterThan(0)
          expect(sounding.has(key), `double note-on ${key}`).toBe(false)
          sounding.add(key)
        } else if (status(m) === NOTE_OFF) {
          expect(sounding.has(key), `note-off without note-on ${key}`).toBe(true)
          sounding.delete(key)
        }
      }
      return msgs
    },
  }
}

// ===========================================================================
describe('velocity sources', () => {
  it("'fixed' ignores every analog input", () => {
    const { engine, state } = setup([mk('a', { type: 'note', note: 60, velocity: 90, velMin: 10 })])
    set(state, { a: { lt: 1, rt: 1, lpad_pressure: 1, rpad_pressure: 1 }, b: { a: true } })
    expect(engine.process(state)).toEqual([on(1, 60, 90)])
  })

  for (const src of ['lt', 'rt', 'lpad_pressure', 'rpad_pressure'] as const) {
    it(`'${src}' is read at note-on and scaled into velMin..velocity`, () => {
      const cases: [number, number][] = [
        [0, 20],
        [1, 120],
        [0.5, 70],
        [0.25, 45],
      ]
      for (const [v, expected] of cases) {
        const { engine, state } = setup([mk('a', { type: 'note', note: 60, velFrom: src, velMin: 20, velocity: 120 })])
        set(state, { a: { [src]: v }, b: { a: true } })
        expect(engine.process(state), `${src}=${v}`).toEqual([on(1, 60, expected)])
        // changing the source while held does nothing: velocity is fixed at note-on
        set(state, { a: { [src]: 1 - v } })
        expect(engine.process(state)).toEqual([])
        set(state, { b: { a: false } })
        expect(engine.process(state)).toEqual([off(1, 60)])
      }
    })
  }

  it('only the named source counts, not other analog inputs', () => {
    const { engine, state } = setup([mk('a', { type: 'note', note: 60, velFrom: 'rt', velMin: 20, velocity: 120 })])
    set(state, { a: { lt: 1, lpad_pressure: 1, rpad_pressure: 1, rt: 0 }, b: { a: true } })
    expect(engine.process(state)).toEqual([on(1, 60, 20)])
  })

  it('velMin above velocity inverts the range (soft at full source, loud at rest)', () => {
    for (const [v, expected] of [
      [0, 120],
      [1, 20],
      [0.5, 70],
    ]) {
      const { engine, state } = setup([mk('b', { type: 'note', note: 61, velFrom: 'lt', velMin: 120, velocity: 20 })])
      set(state, { a: { lt: v }, b: { b: true } })
      expect(engine.process(state)).toEqual([on(1, 61, expected)])
    }
  })

  it('out-of-range source values are clamped to 0..1', () => {
    for (const [v, expected] of [
      [-0.5, 20],
      [1.7, 120],
    ]) {
      const { engine, state } = setup([mk('a', { type: 'note', note: 60, velFrom: 'lt', velMin: 20, velocity: 120 })])
      set(state, { a: { lt: v }, b: { a: true } })
      expect(engine.process(state)).toEqual([on(1, 60, expected)])
    }
  })

  it('never sends velocity 0 (which would be a note-off) or above 127', () => {
    // unsanitized values straight from createMapping
    const lo = setup([mk('a', { type: 'note', note: 60, velFrom: 'lt', velMin: 0, velocity: 127 })])
    set(lo.state, { a: { lt: 0 }, b: { a: true } })
    expect(lo.engine.process(lo.state)).toEqual([on(1, 60, 1)])
    const hi = setup([mk('a', { type: 'note', note: 60, velFrom: 'lt', velMin: 300, velocity: 127 })])
    set(hi.state, { a: { lt: 0 }, b: { a: true } })
    expect(hi.engine.process(hi.state)).toEqual([on(1, 60, 127)])
  })

  it('a missing source axis counts as 0', () => {
    const { engine, state } = setup([mk('a', { type: 'note', note: 60, velFrom: 'lpad_pressure', velMin: 33, velocity: 99 })])
    delete state.axes.lpad_pressure
    set(state, { b: { a: true } })
    expect(engine.process(state)).toEqual([on(1, 60, 33)])
  })

  it('axis → note can take its velocity from another axis', () => {
    const { engine, state } = setup([mk('lt', { type: 'note', note: 40, threshold: 0.5, velFrom: 'rt', velMin: 10, velocity: 110 })])
    set(state, { a: { lt: 0.9, rt: 0.5 } })
    expect(engine.process(state)).toEqual([on(1, 40, 60)])
  })

  it('toggle mappings use the source velocity on the press that turns them on', () => {
    const { engine, state } = setup([mk('a', { type: 'note', note: 60, toggle: true, velFrom: 'rt', velMin: 1, velocity: 101 })])
    set(state, { a: { rt: 1 }, b: { a: true } })
    expect(engine.process(state)).toEqual([on(1, 60, 101)])
  })

  it('the trackpad grid uses the source velocity too', () => {
    const { engine, state } = setup([mk('rpad_click', { type: 'note', note: 36, grid: 4, velFrom: 'rpad_pressure', velMin: 30, velocity: 127 })])
    set(state, { a: { rpad_x: -0.9, rpad_y: -0.9, rpad_pressure: 1 }, b: { rpad_click: true, rpad_touch: true } })
    expect(engine.process(state)).toEqual([on(1, 36, 127)])
  })
})

// ===========================================================================
describe("'speed' velocity (axis → note)", () => {
  const trig = (o: Partial<Mapping> = {}) =>
    mk('lt', { type: 'note', note: 36, threshold: 0.5, velFrom: 'speed', velMin: 10, velocity: 110, ...o })

  it('a fast pull is loud, a slow pull is soft (untimed, 250 Hz assumed)', () => {
    const fast = setup([trig()])
    set(fast.state, { a: { lt: 0.6 } })
    expect(fast.engine.process(fast.state)).toEqual([on(1, 36, 110)])

    const slow = setup([trig()])
    const out: MidiMessage[] = []
    for (let k = 1; k <= 200 && out.length === 0; k++) {
      set(slow.state, { a: { lt: k * 0.004 } }) // full travel in one second
      out.push(...slow.engine.process(slow.state))
    }
    expect(out).toHaveLength(1)
    expect(status(out[0])).toBe(NOTE_ON)
    expect(out[0][2]).toBeGreaterThanOrEqual(10)
    expect(out[0][2]).toBeLessThan(20)
  })

  it('velocity grows with speed (monotonic) and stays within velMin..velocity', () => {
    let prev = 0
    for (const perStep of [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5]) {
      const { engine, state } = setup([trig()])
      let note: MidiMessage | undefined
      for (let k = 1; k <= 1000 && !note; k++) {
        set(state, { a: { lt: Math.min(1, k * perStep) } })
        note = engine.process(state).find((m) => status(m) === NOTE_ON)
      }
      expect(note, `step ${perStep}`).toBeDefined()
      const v = note![2]
      expect(v).toBeGreaterThanOrEqual(prev)
      expect(v).toBeGreaterThanOrEqual(10)
      expect(v).toBeLessThanOrEqual(110)
      prev = v
    }
    expect(prev).toBe(110)
  })

  it('timed process: speed comes from the real time between reports', () => {
    // same travel per report, ten times the time → much softer
    const quick = setupTimed([trig()])
    set(quick.state, { a: { lt: 0.3 } })
    quick.engine.process(quick.state, null, 4)
    set(quick.state, { a: { lt: 0.6 } })
    const loud = quick.engine.process(quick.state, null, 8)

    const lazy = setupTimed([trig()])
    set(lazy.state, { a: { lt: 0.3 } })
    lazy.engine.process(lazy.state, null, 40)
    set(lazy.state, { a: { lt: 0.6 } })
    const soft = lazy.engine.process(lazy.state, null, 80)

    expect(loud).toEqual([on(1, 36, 110)])
    expect(soft).toHaveLength(1)
    expect(soft[0][2]).toBeLessThan(loud[0][2])
    expect(soft[0][2]).toBeGreaterThan(10)
  })

  it('timed slow pull (full travel over one second) is near velMin', () => {
    const { engine, state } = setupTimed([trig()])
    let note: MidiMessage | undefined
    for (let t = 10; t <= 1000 && !note; t += 10) {
      set(state, { a: { lt: t / 1000 } })
      note = engine.process(state, null, t).find((m) => status(m) === NOTE_ON)
    }
    expect(note![2]).toBeGreaterThanOrEqual(10)
    expect(note![2]).toBeLessThan(20)
  })

  it('first sample already over the threshold uses the full velocity', () => {
    for (const timed of [false, true]) {
      const engine = new Engine()
      engine.setMappings([trig()])
      const state = emptyState()
      state.axes.lt = 1
      expect(timed ? engine.process(state, null, 1234) : engine.process(state)).toEqual([on(1, 36, 110)])
    }
  })

  it('works on a bipolar stick in either direction', () => {
    for (const dir of [1, -1]) {
      const { engine, state } = setup([mk('lstick_x', { type: 'note', note: 50, threshold: 0.5, velFrom: 'speed', velMin: 10, velocity: 110 })])
      set(state, { a: { lstick_x: dir } })
      expect(engine.process(state)).toEqual([on(1, 50, 110)])
    }
  })

  it('each new crossing gets its own speed', () => {
    const { engine, state } = setup([trig()])
    set(state, { a: { lt: 1 } })
    expect(engine.process(state)).toEqual([on(1, 36, 110)])
    set(state, { a: { lt: 0 } })
    expect(engine.process(state)).toEqual([off(1, 36)])
    const out: MidiMessage[] = []
    for (let k = 1; k <= 200 && out.length === 0; k++) {
      set(state, { a: { lt: k * 0.004 } })
      out.push(...engine.process(state))
    }
    expect(out[0][2]).toBeLessThan(20)
  })

  it("'speed' on a button falls back to the fixed velocity", () => {
    const { engine, state } = setup([mk('a', { type: 'note', note: 60, velFrom: 'speed', velMin: 5, velocity: 77 })])
    set(state, { b: { a: true }, a: { lt: 1, rt: 1 } })
    expect(engine.process(state)).toEqual([on(1, 60, 77)])
  })
})

// ===========================================================================
describe('gain', () => {
  const lt = INPUT_BY_ID.lt as AxisDef
  const stick = INPUT_BY_ID.lstick_x as AxisDef
  const shape = (raw: number, def: AxisDef, o: Partial<Mapping>) => shapeAxis(raw, def, mk(def.id, o))

  it('unipolar: gain × input, clamped at full', () => {
    expect(shape(0.25, lt, { gain: 2 })).toBeCloseTo(0.5)
    expect(shape(0.5, lt, { gain: 2 })).toBeCloseTo(1)
    expect(shape(0.9, lt, { gain: 2 })).toBe(1)
    expect(shape(0.1, lt, { gain: 10 })).toBeCloseTo(1)
    expect(shape(1, lt, { gain: 10 })).toBe(1)
    expect(shape(0.3, lt, { gain: 1 })).toBeCloseTo(0.3)
  })

  it('bipolar: gain in both directions, clamped at either end', () => {
    expect(shape(0.25, stick, { gain: 2 })).toBeCloseTo(0.75)
    expect(shape(-0.25, stick, { gain: 2 })).toBeCloseTo(0.25)
    expect(shape(0.6, stick, { gain: 2 })).toBe(1)
    expect(shape(-0.9, stick, { gain: 3 })).toBe(0)
    expect(shape(1, stick, { gain: 10 })).toBe(1)
    expect(shape(-1, stick, { gain: 10 })).toBe(0)
  })

  it('rest position is unchanged by gain', () => {
    for (const gain of [1, 2, 5, 10]) {
      expect(shape(0, lt, { gain })).toBe(0)
      expect(shape(0, stick, { gain })).toBe(0.5)
      expect(shape(0, lt, { gain, invert: true })).toBe(1)
      expect(shape(0, stick, { gain, invert: true })).toBe(0.5)
    }
  })

  it('applies before the deadzone (deadzone is measured on the amplified input)', () => {
    expect(shape(0.09, stick, { gain: 2, deadzone: 0.2 })).toBe(0.5)
    expect(shape(0.3, stick, { gain: 2, deadzone: 0.2 })).toBeCloseTo(0.75) // 0.6 → (0.6-0.2)/0.8 = 0.5
    expect(shape(0.6, stick, { gain: 2, deadzone: 0.2 })).toBe(1)
    expect(shape(0.3, lt, { gain: 2, deadzone: 0.2 })).toBeCloseTo(0.5)
  })

  it('then the curve, then invert', () => {
    expect(shape(0.25, lt, { gain: 2, curve: 2 })).toBeCloseTo(0.25)
    expect(shape(0.25, lt, { gain: 2, invert: true })).toBeCloseTo(0.5)
    expect(shape(1, lt, { gain: 2, invert: true })).toBe(0)
    expect(shape(-0.25, stick, { gain: 2, curve: 2 })).toBeCloseTo(0.375)
    expect(shape(-0.25, stick, { gain: 2, invert: true })).toBeCloseTo(0.75)
  })

  it('a missing gain (pre-0.2 mapping object) acts as 1', () => {
    const m = mk('lt') as Partial<Mapping>
    delete m.gain
    expect(shapeAxis(0.3, lt, m as Mapping)).toBeCloseTo(0.3)
  })

  it('CC output: half a trigger pull reaches 127 with gain 2', () => {
    const { engine, state } = setup([mk('lt', { type: 'cc', cc: 30, gain: 2 })])
    set(state, { a: { lt: 0.25 } })
    expect(engine.process(state)).toEqual([[CC, 30, 64]])
    set(state, { a: { lt: 0.5 } })
    expect(engine.process(state)).toEqual([[CC, 30, 127]])
    set(state, { a: { lt: 0.9 } })
    expect(engine.process(state)).toEqual([])
    set(state, { a: { lt: 0 } })
    expect(engine.process(state)).toEqual([[CC, 30, 0]])
  })

  it('pitch bend still centres on exactly 8192 with gain', () => {
    for (const gain of [1, 2.5, 3, 10]) {
      const { engine, state } = setup([mk('lstick_x', { type: 'pitchbend', gain })])
      set(state, { a: { lstick_x: 0.2 } })
      const up = engine.process(state)
      expect(bend14(up[0])).toBeGreaterThan(8192)
      set(state, { a: { lstick_x: 0 } })
      const back = engine.process(state)
      expect(back).toHaveLength(1)
      expect(status(back[0])).toBe(BEND)
      expect(bend14(back[0]), `gain ${gain}`).toBe(8192)
      set(state, { a: { lstick_x: -1 } })
      expect(bend14(engine.process(state)[0])).toBe(0)
      set(state, { a: { lstick_x: 1 } })
      expect(bend14(engine.process(state)[0])).toBe(16383)
    }
  })

  it('axis → note threshold is reached with less travel', () => {
    const { engine, state } = setup([mk('lt', { type: 'note', note: 40, threshold: 0.5, gain: 4 })])
    set(state, { a: { lt: 0.1 } })
    expect(engine.process(state)).toEqual([])
    set(state, { a: { lt: 0.13 } })
    expect(engine.process(state)).toEqual([on(1, 40, 100)])
  })
})

// ===========================================================================
describe('note repeat', () => {
  /** Hold a button from t = 0 on the timed clock and return the times of every note-on. */
  function holdTimed(tempo: number, repeat: number, untilMs: number, stepMs = 1) {
    const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat, velocity: 99 })], { tempo })
    const tr = noteTracker()
    const ons: number[] = []
    set(state, { b: { l4: true } })
    for (let t = 1; t <= untilMs; t += stepMs) {
      const out = tr.feed(engine.process(state, null, t))
      if (out.length) {
        // first press: a lone note-on; every retrigger: note-off then note-on of the same note
        if (ons.length === 0) expect(out).toEqual([on(1, 42, 99)])
        else expect(out).toEqual([off(1, 42), on(1, 42, 99)])
        ons.push(t)
      }
    }
    set(state, { b: { l4: false } })
    const final = tr.feed(engine.process(state, null, untilMs + 1))
    expect(final).toEqual([off(1, 42)])
    expect(tr.sounding.size).toBe(0)
    return ons
  }

  const cases: [number, number][] = [
    [120, 4],
    [120, 2],
    [90, 3],
    [140, 6],
    [174, 8],
    [60, 4],
    [300, 8],
    [20, 2],
  ]
  for (const [tempo, rate] of cases) {
    it(`${tempo} bpm × ${rate} per beat retriggers every ${(60000 / tempo / rate).toFixed(2)} ms without drift`, () => {
      const interval = 60000 / tempo / rate
      const ons = holdTimed(tempo, rate, Math.max(2000, interval * 6) + 1)
      expect(ons[0]).toBe(1)
      for (let k = 1; k < ons.length; k++) {
        const ideal = 1 + k * interval
        expect(ons[k]).toBeGreaterThanOrEqual(ideal - 1e-6)
        // float accumulation may land a hair past an integer ms
        expect(ons[k]).toBeLessThanOrEqual(ideal + 1 + 1e-6)
      }
      expect(ons.length).toBeGreaterThanOrEqual(5)
    })
  }

  it('untimed clock (4 ms per report): 120 bpm 1/16 retriggers about every 31.25 reports', () => {
    const { engine, state } = setup([mk('l4', { type: 'note', note: 42, repeat: 4 })], { tempo: 120 })
    const tr = noteTracker()
    set(state, { b: { l4: true } })
    const ons: number[] = []
    for (let call = 0; call < 1000; call++) {
      const out = tr.feed(engine.process(state))
      if (out.some((m) => status(m) === NOTE_ON)) ons.push(call)
    }
    expect(ons[0]).toBe(0)
    // 1000 reports = 4 s = 32 sixteenths after the first note
    expect(ons.length).toBe(32)
    for (let k = 1; k < ons.length; k++) {
      const gap = ons[k] - ons[k - 1]
      expect(gap === 31 || gap === 32, `gap ${gap}`).toBe(true)
    }
    // no drift: the k-th retrigger lands within one report of k × 31.25
    expect(Math.abs(ons[31] - 31 * 31.25)).toBeLessThanOrEqual(1)
  })

  it('stops on release: no more notes, nothing left sounding', () => {
    const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat: 8, channel: 10 })])
    const tr = noteTracker()
    set(state, { b: { l4: true } })
    for (let t = 1; t <= 300; t++) tr.feed(engine.process(state, null, t))
    set(state, { b: { l4: false } })
    expect(tr.feed(engine.process(state, null, 301))).toEqual([off(10, 42)])
    for (let t = 302; t <= 2000; t++) expect(engine.process(state, null, t)).toEqual([])
    expect(tr.sounding.size).toBe(0)
  })

  it('toggle mappings never repeat', () => {
    const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat: 8, toggle: true })])
    set(state, { b: { l4: true } })
    expect(engine.process(state, null, 1)).toEqual([on(1, 42, 100)])
    for (let t = 2; t <= 2000; t++) expect(engine.process(state, null, t)).toEqual([])
    set(state, { b: { l4: false } })
    expect(engine.process(state, null, 2001)).toEqual([])
    // latched note still on; next press turns it off
    for (let t = 2002; t <= 3000; t++) expect(engine.process(state, null, t)).toEqual([])
    set(state, { b: { l4: true } })
    expect(engine.process(state, null, 3001)).toEqual([off(1, 42)])
  })

  it('no repeat when repeat = 0', () => {
    const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat: 0 })])
    set(state, { b: { l4: true } })
    expect(engine.process(state, null, 1)).toEqual([on(1, 42, 100)])
    for (let t = 2; t <= 3000; t++) expect(engine.process(state, null, t)).toEqual([])
  })

  it('a CC button with repeat set does not retrigger', () => {
    const { engine, state } = setupTimed([mk('l4', { type: 'cc', cc: 64, repeat: 8 })])
    set(state, { b: { l4: true } })
    expect(engine.process(state, null, 1)).toEqual([[CC, 64, 127]])
    for (let t = 2; t <= 1000; t++) expect(engine.process(state, null, t)).toEqual([])
  })

  it('a long gap (tab suspended) gives one retrigger, not a burst, then carries on in time', () => {
    const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat: 4 })], { tempo: 120 })
    set(state, { b: { l4: true } })
    expect(engine.process(state, null, 0)).toEqual([on(1, 42, 100)])
    expect(engine.process(state, null, 10_000)).toEqual([off(1, 42), on(1, 42, 100)])
    expect(engine.process(state, null, 10_001)).toEqual([])
    expect(engine.process(state, null, 10_124)).toEqual([])
    expect(engine.process(state, null, 10_125)).toEqual([off(1, 42), on(1, 42, 100)])
  })

  it('tempo change mid-hold applies from the next step', () => {
    const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat: 4 })], { tempo: 120 })
    const tr = noteTracker()
    set(state, { b: { l4: true } })
    const ons: number[] = []
    for (let t = 1; t <= 1200; t++) {
      if (t === 130) engine.setOptions({ tempo: 60 }) // 250 ms per 1/16
      if (tr.feed(engine.process(state, null, t)).some((m) => status(m) === NOTE_ON)) ons.push(t)
    }
    // 1, 126 (old tempo), 251 (already scheduled), then every 250 ms
    expect(ons).toEqual([1, 126, 251, 501, 751, 1001])
  })

  it('setOptions with only a scale change does not disturb the repeat', () => {
    const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat: 4, scale: false })], { tempo: 120 })
    set(state, { b: { l4: true } })
    engine.process(state, null, 0)
    engine.setOptions({ scale: 1 })
    expect(engine.process(state, null, 125)).toEqual([off(1, 42), on(1, 42, 100)])
  })

  it('each retrigger reads the velocity source again', () => {
    const { engine, state } = setupTimed([mk('a', { type: 'note', note: 60, repeat: 4, velFrom: 'rt', velMin: 1, velocity: 127 })])
    set(state, { b: { a: true }, a: { rt: 0 } })
    expect(engine.process(state, null, 0)).toEqual([on(1, 60, 1)])
    set(state, { a: { rt: 1 } })
    expect(engine.process(state, null, 125)).toEqual([off(1, 60), on(1, 60, 127)])
    set(state, { a: { rt: 0.5 } })
    expect(engine.process(state, null, 250)).toEqual([off(1, 60), on(1, 60, 64)])
  })

  it('the trackpad grid keeps the zone that was pressed for every retrigger', () => {
    const { engine, state } = setupTimed([mk('rpad_click', { type: 'note', note: 60, grid: 2, repeat: 4 })])
    set(state, { b: { rpad_click: true, rpad_touch: true }, a: { rpad_x: 0.5, rpad_y: 0.5 } })
    expect(engine.process(state, null, 0)).toEqual([on(1, 63, 100)])
    set(state, { a: { rpad_x: -0.5, rpad_y: -0.5 } })
    expect(engine.process(state, null, 125)).toEqual([off(1, 63), on(1, 63, 100)])
    set(state, { b: { rpad_click: false } })
    expect(engine.process(state, null, 130)).toEqual([off(1, 63)])
  })

  it('releaseAll while repeating stops it and nothing hangs or restarts until a new press', () => {
    const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat: 8 })])
    const tr = noteTracker()
    set(state, { b: { l4: true } })
    for (let t = 1; t <= 100; t++) tr.feed(engine.process(state, null, t))
    expect(tr.feed(engine.releaseAll())).toEqual([off(1, 42)])
    for (let t = 101; t <= 1000; t++) expect(tr.feed(engine.process(state, null, t))).toEqual([])
    set(state, { b: { l4: false } })
    expect(engine.process(state, null, 1001)).toEqual([])
    set(state, { b: { l4: true } })
    expect(tr.feed(engine.process(state, null, 1002))).toEqual([on(1, 42, 100)])
    expect(tr.feed(engine.process(state, null, 1002 + 63))).toEqual([off(1, 42), on(1, 42, 100)])
  })

  it('soloing another mapping mid-repeat stops the notes; unsolo while held does not leave a note hanging', () => {
    const rep = mk('l4', { type: 'note', note: 42, repeat: 8 })
    const other = mk('b', { type: 'note', note: 50 })
    const { engine, state } = setupTimed([rep, other])
    const tr = noteTracker()
    set(state, { b: { l4: true } })
    for (let t = 1; t <= 100; t++) tr.feed(engine.process(state, null, t))
        expect(tr.feed(engine.process(state, other.id, 102))).toEqual([off(1, 42)])
    for (let t = 103; t <= 500; t++) expect(tr.feed(engine.process(state, other.id, t))).toEqual([])
    for (let t = 501; t <= 1000; t++) tr.feed(engine.process(state, null, t))
    set(state, { b: { l4: false } })
    tr.feed(engine.process(state, null, 1001))
    expect(tr.sounding.size).toBe(0)
  })

  it('disabling the mapping mid-repeat (setMappings) sends the note-off and nothing more', () => {
    const rep = mk('l4', { type: 'note', note: 42, repeat: 8 })
    const { engine, state } = setupTimed([rep])
    const tr = noteTracker()
    set(state, { b: { l4: true } })
    for (let t = 1; t <= 100; t++) tr.feed(engine.process(state, null, t))
    expect(tr.feed(engine.setMappings([{ ...rep, enabled: false }]))).toEqual([off(1, 42)])
    for (let t = 101; t <= 1000; t++) expect(engine.process(state, null, t)).toEqual([])
    expect(tr.sounding.size).toBe(0)
  })

  it('editing the repeating mapping mid-hold cleanly stops the old note', () => {
    const rep = mk('l4', { type: 'note', note: 42, repeat: 8 })
    const { engine, state } = setupTimed([rep])
    const tr = noteTracker()
    set(state, { b: { l4: true } })
    for (let t = 1; t <= 100; t++) tr.feed(engine.process(state, null, t))
    tr.feed(engine.setMappings([{ ...rep, repeat: 2, note: 44 }]))
    expect(tr.sounding.size).toBe(0)
    for (let t = 101; t <= 2000; t++) tr.feed(engine.process(state, null, t))
    set(state, { b: { l4: false } })
    tr.feed(engine.process(state, null, 2001))
    expect(tr.sounding.size).toBe(0)
  })

  it('editing a different mapping does not interrupt the repeat', () => {
    const rep = mk('l4', { type: 'note', note: 42, repeat: 4 })
    const other = mk('b', { type: 'note', note: 50 })
    const { engine, state } = setupTimed([rep, other])
    set(state, { b: { l4: true } })
    expect(engine.process(state, null, 0)).toEqual([on(1, 42, 100)])
    expect(engine.setMappings([rep, { ...other, note: 51 }])).toEqual([])
    expect(engine.process(state, null, 125)).toEqual([off(1, 42), on(1, 42, 100)])
  })

  it('a scale change mid-repeat keeps retriggering (and finally releasing) the note that started', () => {
    const { engine, state } = setupTimed([mk('a', { type: 'note', note: 61, repeat: 4 })])
    set(state, { b: { a: true } })
    expect(engine.process(state, null, 0)).toEqual([on(1, 61, 100)])
    engine.setOptions({ scale: scaleIndex('major') })
    expect(engine.process(state, null, 125)).toEqual([off(1, 61), on(1, 61, 100)])
    set(state, { b: { a: false } })
    expect(engine.process(state, null, 130)).toEqual([off(1, 61)])
  })
})

// ===========================================================================
describe('scales: quantizeNote / stepScale', () => {
  const MAJOR = scaleIndex('major')
  const MINOR = scaleIndex('minor')
  const MPENT = scaleIndex('minor_pentatonic')
  const inScale = (n: number, root: number, scale: number) =>
    (SCALES[scale].steps as readonly number[]).includes((((n - root) % 12) + 12) % 12)

  it('scaleIndex maps ids to indices and unknown ids to chromatic', () => {
    expect(scaleIndex('chromatic')).toBe(0)
    expect(scaleIndex('major')).toBe(1)
    expect(scaleIndex('blues')).toBe(SCALES.length - 1)
    expect(scaleIndex('nope')).toBe(0)
  })

  it('chromatic leaves every note alone', () => {
    for (let n = 0; n <= 127; n++) for (const root of [0, 5, 11]) expect(quantizeNote(n, root, 0)).toBe(n)
    expect(stepScale(60, 5, 0, 0)).toBe(65)
  })

  it('C major: in-scale notes unchanged, others go up to the next one', () => {
    expect(quantizeNote(60, 0, MAJOR)).toBe(60)
    expect(quantizeNote(61, 0, MAJOR)).toBe(62)
    expect(quantizeNote(63, 0, MAJOR)).toBe(64)
    expect(quantizeNote(66, 0, MAJOR)).toBe(67)
    expect(quantizeNote(70, 0, MAJOR)).toBe(71)
    expect(quantizeNote(71, 0, MAJOR)).toBe(71)
  })

  it('other roots: D major, A minor, F# minor pentatonic', () => {
    expect(quantizeNote(60, 2, MAJOR)).toBe(61) // C → C#
    expect(quantizeNote(65, 2, MAJOR)).toBe(66) // F → F#
    expect(quantizeNote(57, 9, MINOR)).toBe(57) // A
    expect(quantizeNote(61, 9, MINOR)).toBe(62) // C# → D
    expect(quantizeNote(68, 9, MINOR)).toBe(69) // G# → A
    expect(quantizeNote(60, 6, MPENT)).toBe(61) // C → C# (F# A B C# E)
  })

  it('every scale, every root, every note: result is in the scale, ≥ input unless at the top, and within 0..127', () => {
    for (let s = 0; s < SCALES.length; s++) {
      for (let root = 0; root < 12; root++) {
        for (let n = 0; n <= 127; n++) {
          const q = quantizeNote(n, root, s)
          expect(q >= 0 && q <= 127).toBe(true)
          expect(inScale(q, root, s), `${n} root ${root} scale ${s} → ${q}`).toBe(true)
          if (q < n) {
            // only allowed when nothing in the scale lies between n and 127
            for (let k = n; k <= 127; k++) expect(inScale(k, root, s)).toBe(false)
          } else {
            for (let k = n; k < q; k++) expect(inScale(k, root, s)).toBe(false)
          }
        }
      }
    }
  })

  it('edges: 0 and 127', () => {
    expect(quantizeNote(0, 0, MAJOR)).toBe(0)
    expect(quantizeNote(0, 1, MAJOR)).toBe(0) // C is B#, in C# major
    expect(quantizeNote(0, 2, MAJOR)).toBe(1) // D major: C → C#
    expect(quantizeNote(127, 0, MAJOR)).toBe(127) // G
    expect(quantizeNote(127, 1, MAJOR)).toBe(126) // G is not in C# major; F# below is
    expect(quantizeNote(127, 1, MPENT)).toBe(126) // C# minor pent: F# is the top in-range note
    expect(quantizeNote(126, 1, MPENT)).toBe(126)
  })

  it('stepScale walks scale degrees', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((d) => stepScale(60, d, 0, MAJOR))).toEqual([60, 62, 64, 65, 67, 69, 71, 72])
    expect([0, 1, 2, 3, 4, 5].map((d) => stepScale(57, d, 9, MPENT))).toEqual([57, 60, 62, 64, 67, 69])
    expect(stepScale(57, 7, 9, MINOR)).toBe(69) // an octave
    expect(stepScale(57, 14, 9, MINOR)).toBe(81) // two octaves
  })

  it('stepScale stops at 127', () => {
    expect(stepScale(120, 20, 0, MAJOR)).toBe(127)
    expect(stepScale(127, 1, 0, MAJOR)).toBe(127)
  })

  // BUG: stepScale returns 127 even when 127 is not in the scale. With C#
  // major (G is out of the scale), a pad grid near the top of the range plays
  // a G. Expected: stay on the highest in-scale note, as quantizeNote does
  // ("or the highest below, at the top of the range"). src/core/scales.ts:47
  // (`if (n > 127) return 127`).
  it('stepScale never leaves the scale at the top of the range', () => {
    const base = quantizeNote(126, 1, MAJOR) // F#, the highest C# major note
    expect(base).toBe(126)
    const top = stepScale(base, 1, 1, MAJOR)
    expect(inScale(top, 1, MAJOR), `got ${top}`).toBe(true)
  })

  it('unknown scale index acts as chromatic', () => {
    expect(quantizeNote(61, 0, 999)).toBe(61)
    expect(stepScale(61, 2, 0, 999)).toBe(63)
  })
})

// ===========================================================================
describe('scale mode through the engine', () => {
  const MAJOR = scaleIndex('major')

  const press = (o: Partial<Mapping>, opts: Parameters<Engine['setOptions']>[0], input = 'a') => {
    const { engine, state } = setup([mk(input, { type: 'note', ...o })], opts)
    set(state, { b: { [input]: true } })
    return { engine, state, out: engine.process(state) }
  }

  it('buttons snap to the scale', () => {
    expect(press({ note: 61 }, { scale: MAJOR, scaleRoot: 0 }).out).toEqual([on(1, 62, 100)])
    expect(press({ note: 60 }, { scale: MAJOR, scaleRoot: 2 }).out).toEqual([on(1, 61, 100)])
  })

  it('note-off matches the snapped note', () => {
    const { engine, state, out } = press({ note: 61, channel: 3 }, { scale: MAJOR })
    expect(out).toEqual([on(3, 62, 100)])
    set(state, { b: { a: false } })
    expect(engine.process(state)).toEqual([off(3, 62)])
  })

  it('scale: false opts a mapping out', () => {
    expect(press({ note: 61, scale: false }, { scale: MAJOR }).out).toEqual([on(1, 61, 100)])
  })

  it('chromatic (scale 0) leaves notes unchanged', () => {
    expect(press({ note: 61 }, { scale: 0, scaleRoot: 5 }).out).toEqual([on(1, 61, 100)])
  })

  it('grid zones walk scale degrees from the (snapped) base note', () => {
    const zones: [number, number][] = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [-0.5, 0.5],
      [0.5, 0.5],
    ]
    const notes = (base: number, opts: Parameters<Engine['setOptions']>[0], mo: Partial<Mapping> = {}) =>
      zones.map(([x, y]) => {
        const { engine, state } = setup([mk('rpad_click', { type: 'note', note: base, grid: 2, ...mo })], opts)
        set(state, { b: { rpad_click: true }, a: { rpad_x: x, rpad_y: y } })
        return engine.process(state)[0][1]
      })
    expect(notes(60, { scale: MAJOR })).toEqual([60, 62, 64, 65])
    expect(notes(61, { scale: MAJOR })).toEqual([62, 64, 65, 67])
    expect(notes(57, { scale: scaleIndex('minor_pentatonic'), scaleRoot: 9 })).toEqual([57, 60, 62, 64])
    expect(notes(60, { scale: 0 })).toEqual([60, 61, 62, 63])
    expect(notes(61, { scale: MAJOR }, { scale: false })).toEqual([61, 62, 63, 64])
  })

  it('a chromatic grid near the top of the range caps at 127', () => {
    const { engine, state } = setup([mk('rpad_click', { type: 'note', note: 126, grid: 2 })])
    set(state, { b: { rpad_click: true }, a: { rpad_x: 0.5, rpad_y: 0.5 } })
    expect(engine.process(state)).toEqual([on(1, 127, 100)])
  })

  it('axis → note snaps too', () => {
    const { engine, state } = setup([mk('lt', { type: 'note', note: 66, threshold: 0.5 })], { scale: MAJOR })
    set(state, { a: { lt: 1 } })
    expect(engine.process(state)).toEqual([on(1, 67, 100)])
    set(state, { a: { lt: 0 } })
    expect(engine.process(state)).toEqual([off(1, 67)])
  })

  it('changing the scale while a note is held still releases the note that sounded', () => {
    const { engine, state } = setup([mk('a', { type: 'note', note: 61 })], { scale: MAJOR })
    set(state, { b: { a: true } })
    expect(engine.process(state)).toEqual([on(1, 62, 100)])
    engine.setOptions({ scale: 0 })
    set(state, { b: { a: false } })
    expect(engine.process(state)).toEqual([off(1, 62)])
    set(state, { b: { a: true } })
    expect(engine.process(state)).toEqual([on(1, 61, 100)])
  })

  it('setOptions clamps root to 0..11 and scale to a real index', () => {
    const note = (opts: Parameters<Engine['setOptions']>[0], n = 60) => press({ note: n }, opts).out[0][1]
    expect(note({ scale: MAJOR, scaleRoot: 12 })).toBe(note({ scale: MAJOR, scaleRoot: 11 }))
    expect(note({ scale: MAJOR, scaleRoot: -4 })).toBe(60)
    expect(note({ scale: MAJOR, scaleRoot: 1.6 })).toBe(61) // rounds to D major
    expect(note({ scale: MAJOR, scaleRoot: NaN })).toBe(60)
    expect(note({ scale: 999 }, 61)).toBe(quantizeNote(61, 0, SCALES.length - 1))
    expect(note({ scale: -1 }, 61)).toBe(61)
    expect(note({ scale: NaN }, 61)).toBe(61)
    expect(note({ scale: 1.2 }, 61)).toBe(62)
  })

  it('setOptions clamps tempo to 20..300 and ignores non-numbers', () => {
    const firstRetrigger = (tempo: number) => {
      const { engine, state } = setupTimed([mk('l4', { type: 'note', note: 42, repeat: 2 })], { tempo })
      set(state, { b: { l4: true } })
      engine.process(state, null, 0)
      for (let t = 1; t <= 5000; t++) if (engine.process(state, null, t).length) return t
      return -1
    }
    expect(firstRetrigger(1000)).toBe(100) // 300 bpm, 1/8
    expect(firstRetrigger(5)).toBe(1500) // 20 bpm
    expect(firstRetrigger(NaN)).toBe(250) // default 120
    expect(firstRetrigger(Infinity)).toBe(250)
  })

  it('setOptions keeps fields it is not given', () => {
    const { engine, state } = setup([mk('a', { type: 'note', note: 61 })], { scale: MAJOR, scaleRoot: 2 })
    engine.setOptions({ tempo: 90 })
    set(state, { b: { a: true } })
    expect(engine.process(state)).toEqual([on(1, 61, 100)]) // still D major
  })
})

// ===========================================================================
describe('MPE', () => {
  const pad = (input = 'rpad_touch', o: Partial<Mapping> = {}) => mk(input, { type: 'note', note: 60, mpe: true, bend: 2, ...o })
  const side = (input: string) => (input.startsWith('l') ? 'lpad' : 'rpad')

  function touch(state: ControllerState, input: string, x: number, y: number, p = 0) {
    const s = side(input)
    set(state, { b: { [input]: true, [`${s}_touch`]: true }, a: { [`${s}_x`]: x, [`${s}_y`]: y, [`${s}_pressure`]: p } })
  }
  function lift(state: ControllerState, input: string) {
    const s = side(input)
    set(state, { b: { [input]: false, [`${s}_touch`]: false } })
  }

  it('note-on gets its own channel, with the expression set first: bend 8192, CC 74, pressure, then note-on', () => {
    const { engine, state } = setup([pad('rpad_touch', { channel: 1, velocity: 100 })])
    touch(state, 'rpad_touch', 0, 0, 0.5)
    const out = engine.process(state)
    expect(out).toEqual([
      [BEND | 1, 0, 64],
      [CC | 1, 74, 64],
      [PRESSURE | 1, 64],
      on(2, 60, 100),
    ])
    expect(bend14(out[0])).toBe(8192)
  })

  it('channels go round-robin through 2..16 so a released note keeps its tail', () => {
    const { engine, state } = setup([pad()])
    const chans: number[] = []
    for (let i = 0; i < 17; i++) {
      touch(state, 'rpad_touch', 0, 0)
      const out = engine.process(state)
      chans.push(chOf(out[out.length - 1]))
      lift(state, 'rpad_touch')
      const rel = engine.process(state)
      expect(rel).toEqual([off(chans[i], 60)])
    }
    expect(chans).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 2, 3])
  })

  it('two pads at once get different channels, each released on its own', () => {
    const l = pad('lpad_touch', { note: 48 })
    const r = pad('rpad_touch', { note: 60 })
    const { engine, state } = setup([l, r])
    const tr = noteTracker()
    touch(state, 'lpad_touch', 0, 0)
    touch(state, 'rpad_touch', 0, 0)
    const out = tr.feed(engine.process(state))
    const ons = out.filter((m) => status(m) === NOTE_ON)
    expect(ons).toHaveLength(2)
    expect(chOf(ons[0])).not.toBe(chOf(ons[1]))
    // each note's expression goes only to its own channel, right before it
    expect(out.map(chOf)).toEqual([2, 2, 2, 2, 3, 3, 3, 3])
    // bending the right pad only touches the right note's channel
    set(state, { a: { rpad_x: 0.5 } })
    const bendOut = engine.process(state)
    expect(bendOut).toHaveLength(1)
    expect(chOf(bendOut[0])).toBe(chOf(ons.find((m) => m[1] === 60)!))
    lift(state, 'lpad_touch')
    expect(tr.feed(engine.process(state))).toEqual([off(2, 48)])
    lift(state, 'rpad_touch')
    expect(tr.feed(engine.process(state))).toEqual([off(3, 60)])
  })

  it('a held channel is skipped by the round robin', () => {
    const { engine, state } = setup([pad('lpad_touch'), pad('rpad_touch')])
    touch(state, 'lpad_touch', 0, 0)
    engine.process(state) // lpad holds ch 2
    const chans: number[] = []
    for (let i = 0; i < 16; i++) {
      touch(state, 'rpad_touch', 0, 0)
      const out = engine.process(state)
      chans.push(chOf(out[out.length - 1]))
      lift(state, 'rpad_touch')
      engine.process(state)
    }
    expect(chans).not.toContain(2)
    expect(chans.slice(0, 15)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 3])
  })

  it('bend is relative to where the finger came down: `bend` semitones per half-pad, on a ±48 range', () => {
    const semis = (v: number) => ((v - 8192) / 8192) * 48
    for (const [b, x0, x, expectSemis] of [
      [2, 0, 1, 2],
      [2, 0.2, 0.7, 1],
      [12, 0, 1, 12],
      [12, 0.5, 0, -6],
      [48, -0.5, 0.5, 48],
    ] as const) {
      const { engine, state } = setup([pad('rpad_touch', { bend: b })])
      touch(state, 'rpad_touch', x0, 0)
      engine.process(state)
      set(state, { a: { rpad_x: x } })
      const out = engine.process(state)
      expect(out, `bend ${b} ${x0}→${x}`).toHaveLength(1)
      expect(status(out[0])).toBe(BEND)
      expect(chOf(out[0])).toBe(2)
      const v = bend14(out[0])
      expect(Math.abs(semis(v) - expectSemis)).toBeLessThan(0.01)
      // back to where it started: exactly centre again
      set(state, { a: { rpad_x: x0 } })
      expect(bend14(engine.process(state)[0])).toBe(8192)
    }
  })

  it('bend clamps at the ends of the 14-bit range', () => {
    const { engine, state } = setup([pad('rpad_touch', { bend: 48 })])
    touch(state, 'rpad_touch', -1, 0)
    engine.process(state)
    set(state, { a: { rpad_x: 1 } })
    expect(bend14(engine.process(state)[0])).toBe(16383)
    set(state, { a: { rpad_x: -1 } })
    expect(bend14(engine.process(state)[0])).toBe(8192)
    lift(state, 'rpad_touch')
    engine.process(state)
    touch(state, 'rpad_touch', 1, 0)
    engine.process(state)
    set(state, { a: { rpad_x: -1 } })
    expect(bend14(engine.process(state)[0])).toBe(0)
  })

  it('CC 74 follows Y (bottom 0, top 127) and channel pressure follows pressure, both 7-bit', () => {
    const { engine, state } = setup([pad()])
    touch(state, 'rpad_touch', 0, -1, 0)
    expect(engine.process(state).slice(0, 3)).toEqual([
      [BEND | 1, 0, 64],
      [CC | 1, 74, 0],
      [PRESSURE | 1, 0],
    ])
    set(state, { a: { rpad_y: 1 } })
    expect(engine.process(state)).toEqual([[CC | 1, 74, 127]])
    set(state, { a: { rpad_pressure: 1 } })
    expect(engine.process(state)).toEqual([[PRESSURE | 1, 127]])
    set(state, { a: { rpad_pressure: 1.5, rpad_y: 3 } })
    expect(engine.process(state)).toEqual([]) // clamped: unchanged
    set(state, { a: { rpad_pressure: 0.25, rpad_y: 0 } })
    expect(engine.process(state)).toEqual([
      [CC | 1, 74, 64],
      [PRESSURE | 1, 32],
    ])
  })

  it('sends nothing while nothing changes', () => {
    const { engine, state } = setup([pad()])
    touch(state, 'rpad_touch', 0.3, 0.3, 0.3)
    engine.process(state)
    for (let i = 0; i < 50; i++) expect(engine.process(state)).toEqual([])
    // movement too small to change any 7-/14-bit value
    set(state, { a: { rpad_y: 0.3 + 1e-5, rpad_pressure: 0.3 + 1e-5 } })
    expect(engine.process(state)).toEqual([])
  })

  it('note-off goes to the note’s channel even after the mapping channel or other notes change', () => {
    const { engine, state } = setup([pad('rpad_touch', { channel: 5 })])
    touch(state, 'rpad_touch', 0, 0)
    expect(engine.process(state).at(-1)).toEqual(on(2, 60, 100))
    set(state, { a: { rpad_x: 0.8, rpad_y: 0.5, rpad_pressure: 0.6 } })
    engine.process(state)
    lift(state, 'rpad_touch')
    expect(engine.process(state)).toEqual([off(2, 60)])
    expect(engine.process(state)).toEqual([])
  })

  it('velocity can come from pad pressure at touch-down', () => {
    const { engine, state } = setup([pad('rpad_touch', { velFrom: 'rpad_pressure', velMin: 50, velocity: 120 })])
    touch(state, 'rpad_touch', 0, 0, 1)
    expect(engine.process(state).at(-1)).toEqual(on(2, 60, 120))
  })

  it('a non-MPE pad mapping stays on its own channel', () => {
    const { engine, state } = setup([mk('rpad_touch', { type: 'note', note: 60, channel: 1, mpe: false })])
    touch(state, 'rpad_touch', 0, 0, 0.5)
    expect(engine.process(state)).toEqual([on(1, 60, 100)])
    set(state, { a: { rpad_x: 0.9 } })
    expect(engine.process(state)).toEqual([])
  })

  it('grid + MPE: the zone under the finger picks the note', () => {
    const { engine, state } = setup([pad('rpad_touch', { grid: 2 })])
    touch(state, 'rpad_touch', 0.5, 0.5)
    expect(engine.process(state).at(-1)).toEqual(on(2, 63, 100))
    // sliding into another zone bends, it doesn't change the note
    set(state, { a: { rpad_x: -0.5 } })
    const out = engine.process(state)
    expect(out.every((m) => status(m) !== NOTE_ON && status(m) !== NOTE_OFF)).toBe(true)
    lift(state, 'rpad_touch')
    expect(engine.process(state)).toEqual([off(2, 63)])
  })

  it('scale + MPE (+ grid): notes snap and walk the scale', () => {
    const { engine, state } = setup([pad('rpad_touch', { note: 61, grid: 2 })], { scale: scaleIndex('major') })
    touch(state, 'rpad_touch', -0.5, -0.5)
    expect(engine.process(state).at(-1)).toEqual(on(2, 62, 100))
    lift(state, 'rpad_touch')
    expect(engine.process(state)).toEqual([off(2, 62)])
    touch(state, 'rpad_touch', 0.5, 0.5)
    expect(engine.process(state).at(-1)).toEqual(on(3, 67, 100))
  })

  it('disabling the mapping mid-note sends the note-off on its channel and frees it', () => {
    const m = pad()
    const { engine, state } = setup([m])
    touch(state, 'rpad_touch', 0, 0)
    engine.process(state)
    expect(engine.setMappings([{ ...m, enabled: false }])).toEqual([off(2, 60)])
    expect(engine.process(state)).toEqual([])
    lift(state, 'rpad_touch')
    expect(engine.process(state)).toEqual([])
  })

  it('soloing another mapping mid-note releases it; nothing hangs', () => {
    const m = pad()
    const other = mk('a', { type: 'note', note: 70 })
    const { engine, state } = setup([m, other])
    const tr = noteTracker()
    touch(state, 'rpad_touch', 0, 0)
    tr.feed(engine.process(state))
    expect(tr.feed(engine.process(state, other.id))).toEqual([off(2, 60)])
    set(state, { a: { rpad_x: 0.5 } })
    expect(engine.process(state, other.id)).toEqual([])
    tr.feed(engine.process(state, null))
    lift(state, 'rpad_touch')
    tr.feed(engine.process(state, null))
    expect(tr.sounding.size).toBe(0)
  })

  it('removing or editing the mapping mid-note releases it and frees the channel for reuse', () => {
    const m = pad()
    const { engine, state } = setup([m])
    touch(state, 'rpad_touch', 0, 0)
    engine.process(state)
    expect(engine.setMappings([{ ...m, bend: 12 }])).toEqual([off(2, 60)])
    // no expression on the dead channel after the edit
    set(state, { a: { rpad_x: 0.7, rpad_pressure: 0.7 } })
    expect(engine.process(state)).toEqual([])
    lift(state, 'rpad_touch')
    engine.process(state)

    touch(state, 'rpad_touch', 0, 0)
    expect(engine.process(state).at(-1)).toEqual(on(3, 60, 100))
    expect(engine.setMappings([])).toEqual([off(3, 60)])

    // every channel must be free again: a full round robin of 15 notes uses all of 2..16
    const fresh = pad()
    engine.setMappings([fresh])
    lift(state, 'rpad_touch')
    engine.process(state)
    const chans = new Set<number>()
    for (let i = 0; i < 15; i++) {
      touch(state, 'rpad_touch', 0, 0)
      chans.add(chOf(engine.process(state).at(-1)!))
      lift(state, 'rpad_touch')
      engine.process(state)
    }
    expect([...chans].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  })

  it('releaseAll ends MPE notes on their channels', () => {
    const { engine, state } = setup([pad('lpad_touch', { note: 48 }), pad('rpad_touch')])
    touch(state, 'lpad_touch', 0, 0)
    touch(state, 'rpad_touch', 0, 0)
    engine.process(state)
    const rel = engine.releaseAll()
    expect(rel).toHaveLength(2)
    expect(rel).toContainEqual(off(2, 48))
    expect(rel).toContainEqual(off(3, 60))
    expect(engine.process(state)).toEqual([])
  })

  it('random play over two MPE pads never double-triggers or leaves a note hanging', () => {
    const { engine, state } = setup([pad('lpad_touch', { note: 48, grid: 3 }), pad('rpad_click', { note: 60, grid: 4 })])
    const tr = noteTracker()
    let s = 7
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 4000; i++) {
      if (rnd() < 0.05) state.buttons.lpad_touch = !state.buttons.lpad_touch
      if (rnd() < 0.05) state.buttons.rpad_click = !state.buttons.rpad_click
      for (const a of ['lpad_x', 'lpad_y', 'rpad_x', 'rpad_y']) state.axes[a] = rnd() * 2 - 1
      state.axes.lpad_pressure = rnd()
      state.axes.rpad_pressure = rnd()
      const out = tr.feed(engine.process(state))
      for (const m of out) if (status(m) !== NOTE_OFF) expect(chOf(m)).toBeGreaterThanOrEqual(2)
      expect(tr.sounding.size).toBeLessThanOrEqual(2)
    }
    tr.feed(engine.releaseAll())
    expect(tr.sounding.size).toBe(0)
  })
})

// ===========================================================================
describe('formatMessage: channel pressure', () => {
  it('shows a 2-byte pressure message', () => {
    expect(formatMessage([0xd3, 77])).toEqual({ kind: 'Pressure', channel: 4, detail: '77' })
    expect(formatMessage([0xd0, 0])).toEqual({ kind: 'Pressure', channel: 1, detail: '0' })
    expect(formatMessage([0xdf, 127])).toEqual({ kind: 'Pressure', channel: 16, detail: '127' })
  })
})
