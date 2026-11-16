// Engine behaviour checked against plain MIDI semantics: a note-on is always
// followed by a note-off for the same key and channel, data bytes are 7-bit,
// pitch bend centre is 8192 (LSB 0, MSB 64), channel n lives in the low
// nibble of the status byte as n-1.

import { describe, expect, it } from 'vitest'
import { Engine, formatMessage, learnMessages, pitchBend, type MidiMessage } from './engine'
import { AXES, BUTTONS, emptyState, type ControllerState } from './inputs'
import { createMapping, defaultPreset, type Mapping } from './mapping'

const NOTE_OFF = 0x80
const NOTE_ON = 0x90
const CC = 0xb0
const BEND = 0xe0

let seq = 0
function mk(input: string, o: Partial<Mapping> = {}): Mapping {
  seq += 1
  // neutral shaping unless a test asks otherwise
  return createMapping(input, { id: `t${seq}`, deadzone: 0, smooth: 0, curve: 1, ...o })
}

function setup(...mappings: Mapping[]) {
  const engine = new Engine()
  const initial = engine.setMappings(mappings)
  const state = emptyState()
  return { engine, state, initial }
}

/** process and return */
const step = (engine: Engine, state: ControllerState, patch: { b?: Record<string, boolean>; a?: Record<string, number> } = {}, solo: string | null = null) => {
  Object.assign(state.buttons, patch.b ?? {})
  Object.assign(state.axes, patch.a ?? {})
  return engine.process(state, solo)
}

const bend14 = (m: MidiMessage) => (m[2] << 7) | m[1]

function expectValidMidi(msgs: MidiMessage[]) {
  for (const m of msgs) {
    expect(m).toHaveLength(3)
    expect(Number.isInteger(m[0]) && m[0] >= 0x80 && m[0] <= 0xef, `status ${m[0]}`).toBe(true)
    for (const d of m.slice(1)) {
      expect(Number.isInteger(d) && d >= 0 && d <= 127, `data byte ${d} in [${m}]`).toBe(true)
    }
  }
}

// ---------------------------------------------------------------------------

describe('button → note', () => {
  it('momentary: note-on on press, note-off on release, nothing in between', () => {
    const { engine, state, initial } = setup(mk('a', { type: 'note', note: 60, velocity: 101 }))
    expect(initial).toEqual([])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { a: true } })).toEqual([[NOTE_ON, 60, 101]])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { a: false } })).toEqual([[NOTE_OFF, 60, 0]])
    expect(step(engine, state)).toEqual([])
  })

  it('only reacts to its own input', () => {
    const { engine, state } = setup(mk('a', { type: 'note', note: 60 }))
    expect(step(engine, state, { b: { b: true, x: true }, a: { lt: 1 } })).toEqual([])
  })

  it('toggle: first press on, second press off, releases do nothing', () => {
    const { engine, state } = setup(mk('a', { type: 'note', note: 48, velocity: 90, toggle: true }))
    expect(step(engine, state, { b: { a: true } })).toEqual([[NOTE_ON, 48, 90]])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
    expect(step(engine, state, { b: { a: true } })).toEqual([[NOTE_OFF, 48, 0]])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
    expect(step(engine, state, { b: { a: true } })).toEqual([[NOTE_ON, 48, 90]])
  })

  it('two mappings on one button both fire, in mapping order', () => {
    const { engine, state } = setup(mk('a', { type: 'note', note: 60 }), mk('a', { type: 'note', note: 64 }))
    expect(step(engine, state, { b: { a: true } }).map((m) => m[1])).toEqual([60, 64])
    expect(step(engine, state, { b: { a: false } }).map((m) => [m[0], m[1]])).toEqual([
      [NOTE_OFF, 60],
      [NOTE_OFF, 64],
    ])
  })
})

describe('button → CC', () => {
  it('momentary with default range: 127 on press, 0 on release', () => {
    const { engine, state } = setup(mk('b', { type: 'cc', cc: 7 }))
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { b: true } })).toEqual([[CC, 7, 127]])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { b: false } })).toEqual([[CC, 7, 0]])
  })

  it('momentary with custom min/max', () => {
    const { engine, state } = setup(mk('b', { type: 'cc', cc: 64, min: 10, max: 100 }))
    expect(step(engine, state, { b: { b: true } })).toEqual([[CC, 64, 100]])
    expect(step(engine, state, { b: { b: false } })).toEqual([[CC, 64, 10]])
  })

  it('momentary with reversed min/max', () => {
    const { engine, state } = setup(mk('b', { type: 'cc', cc: 64, min: 127, max: 0 }))
    expect(step(engine, state, { b: { b: true } })).toEqual([[CC, 64, 0]])
    expect(step(engine, state, { b: { b: false } })).toEqual([[CC, 64, 127]])
  })

  it('toggle with custom min/max', () => {
    const { engine, state } = setup(mk('b', { type: 'cc', cc: 80, min: 5, max: 99, toggle: true }))
    expect(step(engine, state, { b: { b: true } })).toEqual([[CC, 80, 99]])
    expect(step(engine, state, { b: { b: false } })).toEqual([])
    expect(step(engine, state, { b: { b: true } })).toEqual([[CC, 80, 5]])
    expect(step(engine, state, { b: { b: false } })).toEqual([])
    expect(step(engine, state, { b: { b: true } })).toEqual([[CC, 80, 99]])
  })
})

describe('editing mappings while a note is held', () => {
  it('changing the note: setMappings returns the note-off for the ORIGINAL note', () => {
    const m = mk('a', { type: 'note', note: 60, channel: 3 })
    const { engine, state } = setup(m)
    step(engine, state, { b: { a: true } })
    expect(engine.setMappings([{ ...m, note: 62 }])).toEqual([[NOTE_OFF | 2, 60, 0]])
    // still held: no retrigger; release: no stray note-off for a note that never started
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
    expect(step(engine, state, { b: { a: true } })).toEqual([[NOTE_ON | 2, 62, 100]])
    expect(step(engine, state, { b: { a: false } })).toEqual([[NOTE_OFF | 2, 62, 0]])
  })

  it('changing the channel: note-off goes to the ORIGINAL channel', () => {
    const m = mk('a', { type: 'note', note: 60, channel: 1 })
    const { engine, state } = setup(m)
    step(engine, state, { b: { a: true } })
    expect(engine.setMappings([{ ...m, channel: 9 }])).toEqual([[NOTE_OFF, 60, 0]])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
  })

  it('changing the type to CC releases the note', () => {
    const m = mk('a', { type: 'note', note: 60 })
    const { engine, state } = setup(m)
    step(engine, state, { b: { a: true } })
    expect(engine.setMappings([{ ...m, type: 'cc' }])).toEqual([[NOTE_OFF, 60, 0]])
  })

  it('a toggled-on note is released when edited', () => {
    const m = mk('a', { type: 'note', note: 61, toggle: true })
    const { engine, state } = setup(m)
    step(engine, state, { b: { a: true } })
    step(engine, state, { b: { a: false } })
    expect(engine.setMappings([{ ...m, velocity: 50 }])).toEqual([[NOTE_OFF, 61, 0]])
  })

  it('re-setting identical mappings (new objects) does not interrupt a held note', () => {
    const m = mk('a', { type: 'note', note: 60 })
    const other = mk('b', { type: 'note', note: 61 })
    const { engine, state } = setup(m, other)
    step(engine, state, { b: { a: true } })
    expect(engine.setMappings([{ ...m }, { ...other, note: 70 }])).toEqual([])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { a: false } })).toEqual([[NOTE_OFF, 60, 0]])
  })

  it('a removed mapping releases its note, once', () => {
    const m = mk('a', { type: 'note', note: 60, channel: 2 })
    const keep = mk('b', { type: 'note', note: 61 })
    const { engine, state } = setup(m, keep)
    step(engine, state, { b: { a: true, b: true } })
    expect(engine.setMappings([keep])).toEqual([[NOTE_OFF | 1, 60, 0]])
    expect(engine.setMappings([keep])).toEqual([])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
    expect(step(engine, state, { b: { b: false } })).toEqual([[NOTE_OFF, 61, 0]])
  })

  it('removing a mapping that is not sounding sends nothing', () => {
    const m = mk('a', { type: 'note' })
    const { engine } = setup(m)
    expect(engine.setMappings([])).toEqual([])
  })

  it('an axis-triggered note is released when its mapping is edited or removed', () => {
    const m = mk('lt', { type: 'note', note: 40, threshold: 0.5 })
    const { engine, state } = setup(m)
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([[NOTE_ON, 40, 100]])
    expect(engine.setMappings([{ ...m, note: 41 }])).toEqual([[NOTE_OFF, 40, 0]])
    step(engine, state, { a: { lt: 0 } })
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([[NOTE_ON, 41, 100]])
    expect(engine.setMappings([])).toEqual([[NOTE_OFF, 41, 0]])
  })

  it('mappings for unknown inputs are ignored without throwing', () => {
    const { engine, state } = setup({ ...mk('a'), input: 'nope' }, { ...mk('a'), input: 'toString' }, { ...mk('a'), input: '__proto__' })
    expect(() => step(engine, state, { b: { a: true } })).not.toThrow()
    expect(step(engine, state)).toEqual([])
  })
})

describe('disabled mappings', () => {
  it('send nothing (button note, button CC, axis CC, axis note, pitch bend)', () => {
    const { engine, state } = setup(
      mk('a', { type: 'note', enabled: false }),
      mk('b', { type: 'cc', enabled: false }),
      mk('lt', { type: 'cc', enabled: false }),
      mk('rt', { type: 'note', enabled: false }),
      mk('lstick_x', { type: 'pitchbend', enabled: false }),
    )
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { a: true, b: true }, a: { lt: 1, rt: 1, lstick_x: 1 } })).toEqual([])
    expect(step(engine, state, { b: { a: false, b: false }, a: { lt: 0, rt: 0, lstick_x: 0 } })).toEqual([])
  })

  it('disabling while held releases the note and nothing else follows', () => {
    const m = mk('a', { type: 'note', note: 60 })
    const { engine, state } = setup(m)
    step(engine, state, { b: { a: true } })
    const out = [...engine.setMappings([{ ...m, enabled: false }]), ...step(engine, state)]
    expect(out).toEqual([[NOTE_OFF, 60, 0]])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
  })

  it('re-enabling while the button is still held does not fire until the next press', () => {
    const m = mk('a', { type: 'note', note: 60 })
    const { engine, state } = setup({ ...m, enabled: false })
    step(engine, state, { b: { a: true } })
    expect(engine.setMappings([m])).toEqual([])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
    expect(step(engine, state, { b: { a: true } })).toEqual([[NOTE_ON, 60, 100]])
  })
})

describe('solo', () => {
  it('only the soloed mapping sends', () => {
    const a = mk('a', { type: 'note', note: 60 })
    const b = mk('b', { type: 'note', note: 61 })
    const ax = mk('lt', { type: 'cc', cc: 5 })
    const { engine, state } = setup(a, b, ax)
    expect(step(engine, state, { b: { a: true, b: true }, a: { lt: 1 } }, b.id)).toEqual([[NOTE_ON, 61, 100]])
    expect(step(engine, state, { b: { a: false, b: false }, a: { lt: 0 } }, b.id)).toEqual([[NOTE_OFF, 61, 0]])
  })

  it('soloing an axis mapping lets it through', () => {
    const a = mk('a', { type: 'note', note: 60 })
    const ax = mk('lt', { type: 'cc', cc: 5 })
    const { engine, state } = setup(a, ax)
    expect(step(engine, state, { b: { a: true }, a: { lt: 1 } }, ax.id)).toEqual([[CC, 5, 127]])
  })

  it('soloing something else while a note is held releases it', () => {
    const a = mk('a', { type: 'note', note: 60 })
    const b = mk('b', { type: 'note', note: 61 })
    const { engine, state } = setup(a, b)
    step(engine, state, { b: { a: true } })
    expect(step(engine, state, {}, b.id)).toEqual([[NOTE_OFF, 60, 0]])
    expect(step(engine, state, {}, b.id)).toEqual([])
    // un-solo while still held: no retrigger, and no second note-off on release
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
  })

  it('a disabled mapping stays silent even when soloed', () => {
    const a = mk('a', { type: 'note', enabled: false })
    const { engine, state } = setup(a)
    expect(step(engine, state, { b: { a: true } }, a.id)).toEqual([])
  })

  it('a momentary CC button released while muted by solo still works on the next press', () => {
    const a = mk('a', { type: 'cc', cc: 30, min: 0, max: 127 })
    const b = mk('b', { type: 'note' })
    const { engine, state } = setup(a, b)
    expect(step(engine, state, { b: { a: true } })).toEqual([[CC, 30, 127]])
    step(engine, state, {}, b.id) // solo something else while held
    step(engine, state, { b: { a: false } }, b.id) // release while muted
    expect(step(engine, state)).toEqual([]) // un-solo
    // the next press must send the pressed value again
    expect(step(engine, state, { b: { a: true } })).toEqual([[CC, 30, 127]])
    expect(step(engine, state, { b: { a: false } })).toEqual([[CC, 30, 0]])
  })
})

describe('axis → CC', () => {
  it('unipolar: 0 → min, 1 → max, linear in between', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 11 }))
    expect(step(engine, state, { a: { lt: 0 } })).toEqual([[CC, 11, 0]])
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([[CC, 11, 127]])
    expect(step(engine, state, { a: { lt: 0.25 } })).toEqual([[CC, 11, 32]]) // 31.75
    expect(step(engine, state, { a: { lt: 0.75 } })).toEqual([[CC, 11, 95]]) // 95.25
  })

  it('bipolar: -1 → min, 0 → midpoint, +1 → max', () => {
    const { engine, state } = setup(mk('lstick_x', { type: 'cc', cc: 12 }))
    expect(step(engine, state, { a: { lstick_x: -1 } })).toEqual([[CC, 12, 0]])
    expect(step(engine, state, { a: { lstick_x: 1 } })).toEqual([[CC, 12, 127]])
    expect(step(engine, state, { a: { lstick_x: 0 } })).toEqual([[CC, 12, 64]])
    expect(step(engine, state, { a: { lstick_x: 0.5 } })).toEqual([[CC, 12, 95]])
    expect(step(engine, state, { a: { lstick_x: -0.5 } })).toEqual([[CC, 12, 32]])
  })

  it('dedupes: an unchanged or sub-step change sends nothing', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 11 }))
    expect(step(engine, state, { a: { lt: 0.5 } })).toHaveLength(1)
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { a: { lt: 0.5001 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0.6 } })).toHaveLength(1)
    expect(step(engine, state, { a: { lt: 0.6 } })).toEqual([])
  })

  it('a sweep never repeats a value and never leaves 0-127', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 11 }))
    const vals: number[] = []
    for (let i = 0; i <= 1000; i++) {
      const out = step(engine, state, { a: { lt: i / 1000 } })
      expectValidMidi(out)
      for (const m of out) vals.push(m[2])
    }
    expect(vals).toEqual(Array.from({ length: 128 }, (_, i) => i))
  })

  it('custom range', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 11, min: 20, max: 100 }))
    expect(step(engine, state, { a: { lt: 0 } })).toEqual([[CC, 11, 20]])
    expect(step(engine, state, { a: { lt: 0.5 } })).toEqual([[CC, 11, 60]])
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([[CC, 11, 100]])
  })

  it('reversed range (min > max)', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 11, min: 100, max: 20 }))
    expect(step(engine, state, { a: { lt: 0 } })).toEqual([[CC, 11, 100]])
    expect(step(engine, state, { a: { lt: 0.5 } })).toEqual([[CC, 11, 60]])
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([[CC, 11, 20]])
  })

  it('reversed range on a bipolar axis keeps the midpoint at rest', () => {
    const { engine, state } = setup(mk('lstick_y', { type: 'cc', cc: 11, min: 127, max: 0 }))
    expect(step(engine, state, { a: { lstick_y: 1 } })).toEqual([[CC, 11, 0]])
    expect(step(engine, state, { a: { lstick_y: -1 } })).toEqual([[CC, 11, 127]])
    const rest = step(engine, state, { a: { lstick_y: 0 } })[0][2]
    expect(rest === 63 || rest === 64).toBe(true)
  })

  it('invert (unipolar and bipolar)', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 1, invert: true }), mk('lstick_x', { type: 'cc', cc: 2, invert: true }))
    expect(step(engine, state, { a: { lt: 0, lstick_x: -1 } })).toEqual([
      [CC, 1, 127],
      [CC, 2, 127],
    ])
    expect(step(engine, state, { a: { lt: 1, lstick_x: 1 } })).toEqual([
      [CC, 1, 0],
      [CC, 2, 0],
    ])
    expect(step(engine, state, { a: { lt: 0.25, lstick_x: 0 } })).toEqual([
      [CC, 1, 95],
      [CC, 2, 64],
    ])
  })

  it('deadzone, bipolar: rests at the midpoint, then rescales to reach both ends', () => {
    const { engine, state } = setup(mk('lstick_x', { type: 'cc', cc: 3, deadzone: 0.2 }))
    expect(step(engine, state, { a: { lstick_x: 0 } })).toEqual([[CC, 3, 64]])
    expect(step(engine, state, { a: { lstick_x: 0.19 } })).toEqual([])
    expect(step(engine, state, { a: { lstick_x: -0.19 } })).toEqual([])
    expect(step(engine, state, { a: { lstick_x: 0.2 } })).toEqual([])
    expect(step(engine, state, { a: { lstick_x: 0.6 } })).toEqual([[CC, 3, 95]]) // halfway through live travel
    expect(step(engine, state, { a: { lstick_x: -0.6 } })).toEqual([[CC, 3, 32]])
    expect(step(engine, state, { a: { lstick_x: 1 } })).toEqual([[CC, 3, 127]])
    expect(step(engine, state, { a: { lstick_x: -1 } })).toEqual([[CC, 3, 0]])
  })

  it('deadzone, bipolar with a custom range: rests at the middle of that range', () => {
    const { engine, state } = setup(mk('lstick_x', { type: 'cc', cc: 3, deadzone: 0.2, min: 40, max: 80 }))
    expect(step(engine, state, { a: { lstick_x: 0.1 } })).toEqual([[CC, 3, 60]])
  })

  it('deadzone, unipolar: rests at min, then rescales to reach max', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 4, deadzone: 0.2, min: 10, max: 110 }))
    expect(step(engine, state, { a: { lt: 0 } })).toEqual([[CC, 4, 10]])
    expect(step(engine, state, { a: { lt: 0.15 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0.6 } })).toEqual([[CC, 4, 60]])
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([[CC, 4, 110]])
  })

  it('the default stick deadzone leaves no jump at its edge', () => {
    const m = createMapping('lstick_x', { id: 'dz' })
    expect(m.deadzone).toBeGreaterThan(0)
    const { engine, state } = setup(m)
    step(engine, state, { a: { lstick_x: 0 } })
    const out = step(engine, state, { a: { lstick_x: m.deadzone + 0.02 } })
    expect(out).toHaveLength(1)
    expect(out[0][2] - 64).toBeLessThanOrEqual(2)
  })

  it('curve: exponent applied to the distance from rest', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 1, curve: 2 }), mk('lstick_x', { type: 'cc', cc: 2, curve: 2 }))
    expect(step(engine, state, { a: { lt: 0.5, lstick_x: 0.5 } })).toEqual([
      [CC, 1, 32], // 0.25 * 127 = 31.75
      [CC, 2, 79], // 0.5 + 0.25/2 = 0.625 → 79.4
    ])
    expect(step(engine, state, { a: { lt: 1, lstick_x: -0.5 } })).toEqual([
      [CC, 1, 127],
      [CC, 2, 48], // 0.375 → 47.6
    ])
    expect(step(engine, state, { a: { lt: 0, lstick_x: -1 } })).toEqual([
      [CC, 1, 0],
      [CC, 2, 0],
    ])
  })

  it('curve < 1 rises faster than linear', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 1, curve: 0.5 }))
    expect(step(engine, state, { a: { lt: 0.25 } })).toEqual([[CC, 1, 64]]) // sqrt(.25) = .5
  })

  it('smoothing: moves part of the way each step, monotonically, and converges on the target', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 9, smooth: 0.5 }))
    expect(step(engine, state, { a: { lt: 0 } })).toEqual([[CC, 9, 0]])
    const first = step(engine, state, { a: { lt: 1 } })
    expect(first).toEqual([[CC, 9, 64]]) // halfway
    const vals = [64]
    for (let i = 0; i < 60; i++) {
      for (const m of step(engine, state)) vals.push(m[2])
    }
    expect(vals).toEqual([...vals].sort((x, y) => x - y))
    expect(new Set(vals).size).toBe(vals.length)
    expect(vals.at(-1)).toBe(127)
    expect(step(engine, state)).toEqual([])
  })

  it('smoothing converges back down to exactly min', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 9, smooth: 0.9 }))
    step(engine, state, { a: { lt: 1 } })
    let last = -1
    state.axes.lt = 0
    for (let i = 0; i < 400; i++) for (const m of engine.process(state)) last = m[2]
    expect(last).toBe(0)
  })

  it('stronger smoothing is slower', () => {
    const run = (smooth: number) => {
      const { engine, state } = setup(mk('lt', { type: 'cc', cc: 9, smooth }))
      step(engine, state, { a: { lt: 0 } })
      return step(engine, state, { a: { lt: 1 } })[0][2]
    }
    expect(run(0.9)).toBeLessThan(run(0.5))
    expect(run(0.5)).toBeLessThan(run(0))
    expect(run(0)).toBe(127)
  })
})

describe('axis → pitch bend', () => {
  it('pitchBend() encodes 14 bits LSB first', () => {
    expect(pitchBend(1, 8192)).toEqual([0xe0, 0x00, 0x40])
    expect(pitchBend(1, 0)).toEqual([0xe0, 0x00, 0x00])
    expect(pitchBend(1, 16383)).toEqual([0xe0, 0x7f, 0x7f])
    expect(pitchBend(2, 8193)).toEqual([0xe1, 0x01, 0x40])
  })

  for (const deadzone of [0, 0.08, 0.5]) {
    it(`centre is exactly 8192 at rest, extremes are 0 and 16383 (deadzone ${deadzone})`, () => {
      const { engine, state } = setup(mk('lstick_x', { type: 'pitchbend', deadzone }))
      expect(step(engine, state, { a: { lstick_x: 0 } })).toEqual([[BEND, 0x00, 0x40]])
      expect(step(engine, state, { a: { lstick_x: 1 } })).toEqual([[BEND, 0x7f, 0x7f]])
      expect(step(engine, state, { a: { lstick_x: -1 } })).toEqual([[BEND, 0x00, 0x00]])
      const back = step(engine, state, { a: { lstick_x: 0 } })
      expect(back).toHaveLength(1)
      expect(bend14(back[0])).toBe(8192)
    })
  }

  it('centre stays 8192 with invert and with a curve', () => {
    const { engine, state } = setup(mk('lstick_x', { type: 'pitchbend', invert: true, curve: 2.5 }))
    expect(bend14(step(engine, state)[0])).toBe(8192)
    expect(bend14(step(engine, state, { a: { lstick_x: 1 } })[0])).toBe(0)
    expect(bend14(step(engine, state, { a: { lstick_x: -1 } })[0])).toBe(16383)
  })

  it('is symmetric and monotonic', () => {
    const { engine, state } = setup(mk('lstick_x', { type: 'pitchbend' }))
    let prev = -1
    for (let i = -100; i <= 100; i++) {
      const out = step(engine, state, { a: { lstick_x: i / 100 } })
      expectValidMidi(out)
      expect(out).toHaveLength(1)
      const v = bend14(out[0])
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
  })

  it('dedupes', () => {
    const { engine, state } = setup(mk('lstick_x', { type: 'pitchbend' }))
    expect(step(engine, state, { a: { lstick_x: 0.3 } })).toHaveLength(1)
    expect(step(engine, state)).toEqual([])
  })

  it('ignores the CC min/max range', () => {
    const { engine, state } = setup(mk('lstick_x', { type: 'pitchbend', min: 40, max: 50 }))
    expect(bend14(step(engine, state, { a: { lstick_x: 1 } })[0])).toBe(16383)
  })

  for (const smooth of [0.5, 0.9]) {
    for (const from of [1, -1]) {
      it(`with smoothing ${smooth}, letting go from ${from} settles on exactly 8192`, () => {
        const { engine, state } = setup(mk('lstick_x', { type: 'pitchbend', smooth }))
        step(engine, state, { a: { lstick_x: from } })
        state.axes.lstick_x = 0
        let last = -1
        // 4 seconds at 250 Hz
        for (let i = 0; i < 1000; i++) for (const m of engine.process(state)) last = bend14(m)
        expect(last).toBe(8192)
      })
    }
  }
})

describe('axis → note', () => {
  it('fires at the threshold and releases below it', () => {
    const { engine, state } = setup(mk('lt', { type: 'note', note: 50, velocity: 77, threshold: 0.5 }))
    expect(step(engine, state, { a: { lt: 0 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0.49 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0.5 } })).toEqual([[NOTE_ON, 50, 77]])
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0 } })).toEqual([[NOTE_OFF, 50, 0]])
    expect(step(engine, state)).toEqual([])
  })

  it('hysteresis: hovering just under the threshold does not retrigger', () => {
    const { engine, state } = setup(mk('lt', { type: 'note', note: 50, threshold: 0.5 }))
    expect(step(engine, state, { a: { lt: 0.52 } })).toHaveLength(1)
    const out: MidiMessage[] = []
    for (const v of [0.49, 0.51, 0.48, 0.5, 0.47, 0.53, 0.46]) out.push(...step(engine, state, { a: { lt: v } }))
    expect(out).toEqual([])
    // clearly below: off
    expect(step(engine, state, { a: { lt: 0.3 } })).toEqual([[NOTE_OFF, 50, 0]])
    // coming back up it needs the full threshold again
    expect(step(engine, state, { a: { lt: 0.47 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0.49 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0.5 } })).toEqual([[NOTE_ON, 50, 100]])
  })

  it('noise around the threshold produces balanced on/off pairs', () => {
    const { engine, state } = setup(mk('lt', { type: 'note', note: 50, threshold: 0.3 }))
    let on = 0
    let off = 0
    let s = 12345
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 2000; i++) {
      for (const m of step(engine, state, { a: { lt: 0.3 + (rnd() - 0.5) * 0.04 } })) {
        if (m[0] === NOTE_ON) on++
        else off++
        expect(on - off === 0 || on - off === 1).toBe(true)
      }
    }
    // ±0.02 of noise is inside the hysteresis band: at most one trigger
    expect(on).toBeLessThanOrEqual(1)
  })

  it('invert: fires when the axis is released past the threshold', () => {
    const { engine, state } = setup(mk('lt', { type: 'note', note: 50, threshold: 0.5, invert: true }))
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0.2 } })).toEqual([[NOTE_ON, 50, 100]])
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([[NOTE_OFF, 50, 0]])
  })

  // A bipolar axis is shaped to 0-1 with rest at 0.5, and the default
  // threshold is 0.5, so a stick mapped to a note with default settings
  // sounds its note AT REST and only releases when pushed left/down past
  // ~0.425. The intended semantics for bipolar axes are not specified
  // (distance from rest? positive half only?), so this is reported rather
  // than changed.
  it.todo('bipolar axis → note with the default threshold should not sound at rest')
})

describe('trackpad axes (only meaningful while touched)', () => {
  it('send nothing until the pad is touched', () => {
    const { engine, state } = setup(mk('lpad_x', { type: 'cc', cc: 40 }), mk('rpad_y', { type: 'pitchbend' }))
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { a: { lpad_x: 0.7, rpad_y: -0.7 } })).toEqual([])
  })

  it('send while touched; each pad is gated by its own touch', () => {
    const { engine, state } = setup(mk('lpad_x', { type: 'cc', cc: 40 }), mk('rpad_x', { type: 'cc', cc: 41 }))
    expect(step(engine, state, { b: { lpad_touch: true }, a: { lpad_x: 1, rpad_x: 1 } })).toEqual([[CC, 40, 127]])
    expect(step(engine, state, { b: { lpad_touch: false, rpad_touch: true }, a: { lpad_x: -1, rpad_x: -1 } })).toEqual([[CC, 41, 0]])
  })

  it("release 'hold': lifting the finger sends nothing and the value stays", () => {
    const { engine, state } = setup(mk('lpad_x', { type: 'cc', cc: 40, release: 'hold' }))
    expect(step(engine, state, { b: { lpad_touch: true }, a: { lpad_x: 0.5 } })).toEqual([[CC, 40, 95]])
    expect(step(engine, state, { b: { lpad_touch: false } })).toEqual([])
    expect(step(engine, state, { a: { lpad_x: 0 } })).toEqual([])
    // touching again at the same spot: nothing new to say
    expect(step(engine, state, { b: { lpad_touch: true }, a: { lpad_x: 0.5 } })).toEqual([])
    expect(step(engine, state, { a: { lpad_x: 1 } })).toEqual([[CC, 40, 127]])
  })

  it("release 'reset': lifting the finger returns to rest once", () => {
    const { engine, state } = setup(mk('lpad_x', { type: 'cc', cc: 40, release: 'reset' }))
    expect(step(engine, state, { b: { lpad_touch: true }, a: { lpad_x: 1 } })).toEqual([[CC, 40, 127]])
    expect(step(engine, state, { b: { lpad_touch: false } })).toEqual([[CC, 40, 64]])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { lpad_touch: true } })).toEqual([[CC, 40, 127]])
  })

  it("release 'reset' on pitch bend returns to exactly 8192, even with smoothing", () => {
    const { engine, state } = setup(mk('rpad_x', { type: 'pitchbend', release: 'reset', smooth: 0.8 }))
    step(engine, state, { b: { rpad_touch: true }, a: { rpad_x: -1 } })
    const out = step(engine, state, { b: { rpad_touch: false } })
    expect(out).toEqual([[BEND, 0x00, 0x40]])
  })

  it("release 'reset' with invert and a custom range returns to that mapping's rest value", () => {
    const { engine, state } = setup(mk('lpad_y', { type: 'cc', cc: 40, release: 'reset', min: 20, max: 40, invert: true }))
    expect(step(engine, state, { b: { lpad_touch: true }, a: { lpad_y: 1 } })).toEqual([[CC, 40, 20]])
    expect(step(engine, state, { b: { lpad_touch: false } })).toEqual([[CC, 40, 30]])
  })

  it('smoothing restarts on a new touch instead of gliding from the old position', () => {
    const { engine, state } = setup(mk('lpad_x', { type: 'cc', cc: 40, smooth: 0.9 }))
    step(engine, state, { b: { lpad_touch: true }, a: { lpad_x: -1 } })
    step(engine, state, { b: { lpad_touch: false } })
    expect(step(engine, state, { b: { lpad_touch: true }, a: { lpad_x: 1 } })).toEqual([[CC, 40, 127]])
  })

  it('pad → note: lifting the finger releases the note', () => {
    const { engine, state } = setup(mk('lpad_x', { type: 'note', note: 70, threshold: 0.8 }))
    expect(step(engine, state, { b: { lpad_touch: true }, a: { lpad_x: 1 } })).toEqual([[NOTE_ON, 70, 100]])
    // parser holds the last coordinate after release
    expect(step(engine, state, { b: { lpad_touch: false } })).toEqual([[NOTE_OFF, 70, 0]])
    expect(step(engine, state)).toEqual([])
  })

  it('pressure is not gated by touch', () => {
    const { engine, state } = setup(mk('lpad_pressure', { type: 'cc', cc: 42 }))
    expect(step(engine, state, { a: { lpad_pressure: 0.5 } })).toEqual([[CC, 42, 64]])
  })
})

describe('gate button', () => {
  it('nothing is sent while the gate is up', () => {
    const { engine, state } = setup(mk('tilt_roll', { type: 'cc', cc: 50, gate: 'rgrip_touch' }))
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { a: { tilt_roll: 0.8 } })).toEqual([])
    expect(step(engine, state, { a: { tilt_roll: -0.8 } })).toEqual([])
  })

  it('sends while the gate is held, following the axis', () => {
    const { engine, state } = setup(mk('tilt_roll', { type: 'cc', cc: 50, gate: 'rgrip_touch' }))
    expect(step(engine, state, { b: { rgrip_touch: true }, a: { tilt_roll: 1 } })).toEqual([[CC, 50, 127]])
    expect(step(engine, state, { a: { tilt_roll: -1 } })).toEqual([[CC, 50, 0]])
  })

  it('only its own gate button opens it', () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 50, gate: 'l4' }))
    expect(step(engine, state, { b: { l5: true, r4: true, a: true }, a: { lt: 1 } })).toEqual([])
    expect(step(engine, state, { b: { l4: true } })).toEqual([[CC, 50, 127]])
  })

  it("release 'hold': letting go of the gate freezes the value", () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 50, gate: 'l4', release: 'hold' }))
    expect(step(engine, state, { b: { l4: true }, a: { lt: 0.5 } })).toEqual([[CC, 50, 64]])
    expect(step(engine, state, { b: { l4: false } })).toEqual([])
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 0 } })).toEqual([])
    expect(step(engine, state, { b: { l4: true }, a: { lt: 0.5 } })).toEqual([])
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([[CC, 50, 127]])
  })

  it("release 'reset': letting go of the gate returns to rest (unipolar → min)", () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 50, gate: 'l4', release: 'reset', min: 12, max: 90 }))
    expect(step(engine, state, { b: { l4: true }, a: { lt: 1 } })).toEqual([[CC, 50, 90]])
    expect(step(engine, state, { b: { l4: false } })).toEqual([[CC, 50, 12]])
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { a: { lt: 0.5 } })).toEqual([])
  })

  it("release 'reset': bipolar → midpoint; pitch bend → 8192", () => {
    const { engine, state } = setup(
      mk('tilt_pitch', { type: 'cc', cc: 51, gate: 'l4', release: 'reset' }),
      mk('tilt_roll', { type: 'pitchbend', gate: 'l4', release: 'reset' }),
    )
    step(engine, state, { b: { l4: true }, a: { tilt_pitch: -1, tilt_roll: 1 } })
    expect(step(engine, state, { b: { l4: false } })).toEqual([
      [CC, 51, 64],
      [BEND, 0x00, 0x40],
    ])
  })

  it("release 'reset' sends nothing if the value is already at rest", () => {
    const { engine, state } = setup(mk('lt', { type: 'cc', cc: 50, gate: 'l4', release: 'reset' }))
    expect(step(engine, state, { b: { l4: true }, a: { lt: 0 } })).toEqual([[CC, 50, 0]])
    expect(step(engine, state, { b: { l4: false } })).toEqual([])
  })

  it('gated axis → note releases when the gate is released', () => {
    const { engine, state } = setup(mk('lt', { type: 'note', note: 33, gate: 'l4' }))
    expect(step(engine, state, { a: { lt: 1 } })).toEqual([])
    expect(step(engine, state, { b: { l4: true } })).toEqual([[NOTE_ON, 33, 100]])
    expect(step(engine, state, { b: { l4: false } })).toEqual([[NOTE_OFF, 33, 0]])
    expect(step(engine, state)).toEqual([])
  })

  it('gate combines with trackpad touch: both are required', () => {
    const { engine, state } = setup(mk('rpad_x', { type: 'cc', cc: 52, gate: 'r4' }))
    expect(step(engine, state, { b: { rpad_touch: true }, a: { rpad_x: 1 } })).toEqual([])
    expect(step(engine, state, { b: { rpad_touch: false, r4: true } })).toEqual([])
    expect(step(engine, state, { b: { rpad_touch: true } })).toEqual([[CC, 52, 127]])
  })
})

describe('channels', () => {
  for (const [channel, nibble] of [
    [1, 0x0],
    [10, 0x9],
    [16, 0xf],
  ] as const) {
    it(`channel ${channel} → low nibble 0x${nibble.toString(16)} on every message type`, () => {
      const { engine, state } = setup(
        mk('a', { type: 'note', note: 60, channel }),
        mk('b', { type: 'cc', cc: 70, channel }),
        mk('lt', { type: 'cc', cc: 71, channel }),
        mk('lstick_x', { type: 'pitchbend', channel }),
        mk('rt', { type: 'note', note: 61, channel }),
      )
      const down = step(engine, state, { b: { a: true, b: true }, a: { lt: 1, lstick_x: 1, rt: 1 } })
      expect(down).toEqual([
        [NOTE_ON | nibble, 60, 100],
        [CC | nibble, 70, 127],
        [CC | nibble, 71, 127],
        [BEND | nibble, 127, 127],
        [NOTE_ON | nibble, 61, 100],
      ])
      const up = step(engine, state, { b: { a: false, b: false }, a: { lt: 0, lstick_x: 0, rt: 0 } })
      expect(up).toEqual([
        [NOTE_OFF | nibble, 60, 0],
        [CC | nibble, 70, 0],
        [CC | nibble, 71, 0],
        [BEND | nibble, 0, 64],
        [NOTE_OFF | nibble, 61, 0],
      ])
    })
  }
})

describe('releaseAll', () => {
  it('stops every sounding note (momentary, toggled, axis) on the right key and channel, once', () => {
    const { engine, state } = setup(
      mk('a', { type: 'note', note: 60, channel: 1 }),
      mk('b', { type: 'note', note: 61, channel: 2, toggle: true }),
      mk('lt', { type: 'note', note: 62, channel: 16 }),
      mk('x', { type: 'note', note: 63 }), // not pressed
      mk('y', { type: 'cc', cc: 5 }), // CC: not a note
    )
    step(engine, state, { b: { a: true, b: true, y: true }, a: { lt: 1 } })
    step(engine, state, { b: { b: false } })
    expect(engine.releaseAll()).toEqual([
      [NOTE_OFF, 60, 0],
      [NOTE_OFF | 1, 61, 0],
      [NOTE_OFF | 15, 62, 0],
    ])
    expect(engine.releaseAll()).toEqual([])
  })

  it('with nothing sounding returns nothing', () => {
    const { engine } = setup(mk('a', { type: 'note' }))
    expect(engine.releaseAll()).toEqual([])
    expect(new Engine().releaseAll()).toEqual([])
  })

  it('a button still held afterwards does not retrigger or double note-off', () => {
    const { engine, state } = setup(mk('a', { type: 'note', note: 60 }))
    step(engine, state, { b: { a: true } })
    engine.releaseAll()
    expect(step(engine, state)).toEqual([])
    expect(step(engine, state, { b: { a: false } })).toEqual([])
    expect(step(engine, state, { b: { a: true } })).toEqual([[NOTE_ON, 60, 100]])
  })

  it('a toggle is back to "off" afterwards: next press turns it on', () => {
    const { engine, state } = setup(mk('a', { type: 'note', note: 60, toggle: true }))
    step(engine, state, { b: { a: true } })
    step(engine, state, { b: { a: false } })
    engine.releaseAll()
    expect(step(engine, state, { b: { a: true } })).toEqual([[NOTE_ON, 60, 100]])
  })
})

describe('note-on / note-off always pair up', () => {
  it('random play over the default preset with every mapping enabled', () => {
    const preset = defaultPreset()
    let mappings = preset.mappings.map((m) => ({ ...m, enabled: true }))
    // add some axis-note and pitch-bend mappings into the mix
    mappings.push(mk('lt', { type: 'note', note: 100 }), mk('rstick_x', { type: 'pitchbend', channel: 4 }), mk('lpad_y', { type: 'note', note: 101, channel: 5 }))
    // give every mapping its own key so a double note-on can only be an engine bug:
    // mapping k lives on channel 1 + k % 16 and plays note k or k + 64
    expect(mappings.length).toBeLessThan(64)
    mappings = mappings.map((m, k) => ({ ...m, channel: 1 + (k % 16), note: k }))
    const engine = new Engine()
    engine.setMappings(mappings)
    const state = emptyState()
    const sounding = new Map<string, number>()
    let s = 99
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const track = (msgs: MidiMessage[]) => {
      expectValidMidi(msgs)
      for (const m of msgs) {
        const key = `${m[0] & 0x0f}:${m[1]}`
        if ((m[0] & 0xf0) === NOTE_ON) {
          expect(m[2]).toBeGreaterThan(0)
          expect(sounding.get(key) ?? 0, `double note-on ${key}`).toBe(0)
          sounding.set(key, 1)
        } else if ((m[0] & 0xf0) === NOTE_OFF) {
          expect(sounding.get(key) ?? 0, `note-off without note-on ${key}`).toBe(1)
          sounding.set(key, 0)
        }
      }
    }
    for (let i = 0; i < 3000; i++) {
      const b = BUTTONS[Math.floor(rnd() * BUTTONS.length)]
      state.buttons[b.id] = rnd() < 0.5
      const a = AXES[Math.floor(rnd() * AXES.length)]
      state.axes[a.id] = a.polarity === 'unipolar' ? rnd() : rnd() * 2 - 1
      const solo = rnd() < 0.05 ? mappings[Math.floor(rnd() * mappings.length)].id : null
      track(engine.process(state, solo))
      if (rnd() < 0.01) {
        const k = Math.floor(rnd() * mappings.length)
        mappings[k] = { ...mappings[k], note: rnd() < 0.5 ? k : k + 64, toggle: rnd() < 0.3, enabled: rnd() < 0.8 }
        track(engine.setMappings([...mappings]))
      }
    }
    track(engine.releaseAll())
    expect([...sounding.values()].every((v) => v === 0)).toBe(true)
  })
})

describe('learnMessages', () => {
  it('note: a note-on then the matching note-off, later', () => {
    const steps = learnMessages(mk('a', { type: 'note', note: 65, velocity: 99, channel: 3 }))
    expect(steps.map((s) => s.message)).toEqual([
      [NOTE_ON | 2, 65, 99],
      [NOTE_OFF | 2, 65, 0],
    ])
    expect(steps[0].delayMs).toBe(0)
    expect(steps[1].delayMs).toBeGreaterThan(steps[0].delayMs)
  })

  it('cc: several distinct values on the right controller and channel, covering min and max', () => {
    const steps = learnMessages(mk('lt', { type: 'cc', cc: 74, channel: 16, min: 10, max: 90 }))
    expect(steps.length).toBeGreaterThanOrEqual(2)
    expectValidMidi(steps.map((s) => s.message))
    for (const s of steps) {
      expect(s.message[0]).toBe(CC | 15)
      expect(s.message[1]).toBe(74)
      expect(s.message[2]).toBeGreaterThanOrEqual(10)
      expect(s.message[2]).toBeLessThanOrEqual(90)
    }
    const values = steps.map((s) => s.message[2])
    expect(values).toContain(10)
    expect(values).toContain(90)
    expect(new Set(values).size).toBe(values.length)
    const delays = steps.map((s) => s.delayMs)
    expect(delays).toEqual([...delays].sort((x, y) => x - y))
    expect(delays[0]).toBe(0)
  })

  it('cc with a reversed range still sends valid values inside the range', () => {
    const steps = learnMessages(mk('lt', { type: 'cc', cc: 74, min: 127, max: 0 }))
    expectValidMidi(steps.map((s) => s.message))
    expect(steps.map((s) => s.message[2])).toContain(0)
    expect(steps.map((s) => s.message[2])).toContain(127)
  })

  it('cc for a button mapping uses the same controller', () => {
    const steps = learnMessages(mk('a', { type: 'cc', cc: 3, channel: 2 }))
    expect(steps.every((s) => s.message[0] === (CC | 1) && s.message[1] === 3)).toBe(true)
  })

  it('pitch bend: moves off centre and ends back at exactly 8192', () => {
    const steps = learnMessages(mk('lstick_x', { type: 'pitchbend', channel: 5 }))
    expectValidMidi(steps.map((s) => s.message))
    expect(steps.every((s) => s.message[0] === (BEND | 4))).toBe(true)
    expect(steps.some((s) => bend14(s.message) !== 8192)).toBe(true)
    expect(bend14(steps.at(-1)!.message)).toBe(8192)
    expect(steps.at(-1)!.delayMs).toBeGreaterThan(0)
  })
})

describe('formatMessage', () => {
  it('note on', () => {
    const f = formatMessage([0x90, 60, 100])
    expect(f.kind).toBe('Note On')
    expect(f.channel).toBe(1)
    expect(f.detail).toContain('60')
    expect(f.detail).toContain('100')
  })
  it('note off, channel 16', () => {
    const f = formatMessage([0x8f, 61, 0])
    expect(f.kind).toBe('Note Off')
    expect(f.channel).toBe(16)
    expect(f.detail).toContain('61')
  })
  it('control change', () => {
    const f = formatMessage([0xb2, 74, 33])
    expect(f.kind).toBe('CC')
    expect(f.channel).toBe(3)
    expect(f.detail).toContain('74')
    expect(f.detail).toContain('33')
  })
  it('pitch bend is shown relative to centre', () => {
    expect(formatMessage([0xe0, 0x00, 0x40])).toEqual({ kind: 'Bend', channel: 1, detail: '0' })
    expect(formatMessage([0xe9, 0x7f, 0x7f])).toEqual({ kind: 'Bend', channel: 10, detail: '8191' })
    expect(formatMessage([0xe0, 0x00, 0x00]).detail).toBe('-8192')
  })
  it('round-trips what the engine produces', () => {
    const { engine, state } = setup(mk('lstick_x', { type: 'pitchbend', channel: 7 }))
    expect(formatMessage(step(engine, state)[0])).toEqual({ kind: 'Bend', channel: 7, detail: '0' })
  })
  it('anything else is shown as hex without throwing', () => {
    const f = formatMessage([0xc1, 5])
    expect(f.kind).toBe('Other')
    expect(f.detail.toLowerCase()).toContain('c1')
    expect(() => formatMessage([0xf8])).not.toThrow()
  })
})
