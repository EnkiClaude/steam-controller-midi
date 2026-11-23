import { describe, expect, it } from 'vitest'
import { Engine } from './engine'
import { AXES, BUTTONS, emptyState, INPUT_BY_ID, INPUTS } from './inputs'
import { createMapping, defaultPreset, describeMapping, freeCc, noteName, sanitizeMapping, sanitizePreset, type Mapping } from './mapping'

function expectValidMapping(m: Mapping) {
  expect(typeof m.id === 'string' && m.id.length > 0).toBe(true)
  expect(Object.hasOwn(INPUT_BY_ID, m.input), `input ${m.input}`).toBe(true)
  expect(typeof m.enabled).toBe('boolean')
  expect(['note', 'cc', 'pitchbend']).toContain(m.type)
  const ints: [keyof Mapping, number, number][] = [
    ['channel', 1, 16],
    ['note', 0, 127],
    ['velocity', 1, 127],
    ['cc', 0, 127],
    ['min', 0, 127],
    ['max', 0, 127],
  ]
  for (const [k, lo, hi] of ints) {
    const v = m[k] as number
    expect(Number.isInteger(v), `${k}=${v}`).toBe(true)
    expect(v, k).toBeGreaterThanOrEqual(lo)
    expect(v, k).toBeLessThanOrEqual(hi)
  }
  expect(typeof m.toggle).toBe('boolean')
  expect(typeof m.invert).toBe('boolean')
  expect(m.deadzone).toBeGreaterThanOrEqual(0)
  expect(m.deadzone).toBeLessThan(1)
  expect(m.curve).toBeGreaterThan(0)
  expect(Number.isFinite(m.curve)).toBe(true)
  expect(m.smooth).toBeGreaterThanOrEqual(0)
  expect(m.smooth).toBeLessThan(1)
  expect(m.threshold).toBeGreaterThan(0)
  expect(m.threshold).toBeLessThan(1)
  expect(m.gate === null || INPUT_BY_ID[m.gate]?.kind === 'button').toBe(true)
  expect(['hold', 'reset']).toContain(m.release)
  if (INPUT_BY_ID[m.input].kind === 'button') expect(m.type).not.toBe('pitchbend')
}

const dest = (m: Mapping) => (m.type === 'note' ? `note:${m.channel}:${m.note}` : m.type === 'cc' ? `cc:${m.channel}:${m.cc}` : `bend:${m.channel}`)

describe('input catalog', () => {
  it('ids are unique across buttons and axes', () => {
    expect(new Set(INPUTS.map((i) => i.id)).size).toBe(INPUTS.length)
    expect(INPUTS.length).toBe(BUTTONS.length + AXES.length)
  })
  it('activeWhile refers to an existing button', () => {
    for (const a of AXES) if (a.activeWhile) expect(INPUT_BY_ID[a.activeWhile]?.kind, a.id).toBe('button')
  })
  it('INPUT_BY_ID does not resolve Object.prototype names', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(INPUT_BY_ID[k], k).toBeUndefined()
    }
  })
})

describe('defaultPreset', () => {
  const preset = defaultPreset()

  it('gives every catalog input exactly one mapping', () => {
    expect(preset.mappings).toHaveLength(INPUTS.length)
    for (const def of INPUTS) {
      expect(preset.mappings.filter((m) => m.input === def.id), def.id).toHaveLength(1)
    }
  })

  it('mapping ids are unique', () => {
    expect(new Set(preset.mappings.map((m) => m.id)).size).toBe(preset.mappings.length)
  })

  it('no two enabled mappings share a (type, channel, number)', () => {
    const enabled = preset.mappings.filter((m) => m.enabled).map(dest)
    expect(new Set(enabled).size).toBe(enabled.length)
  })

  it('no two mappings share a destination even counting the disabled ones', () => {
    const all = preset.mappings.map(dest)
    expect(new Set(all).size).toBe(all.length)
  })

  it('every value is in MIDI range and every mapping is well-formed', () => {
    for (const m of preset.mappings) expectValidMapping(m)
  })

  // Controller numbers the MIDI 1.0 spec leaves undefined in the ranges the
  // preset draws from. Everything else is either a defined controller, an LSB
  // for controllers 0-31 (32-63), or a channel mode message (120-127).
  const isFree = (cc: number) => (cc >= 20 && cc <= 31) || (cc >= 102 && cc <= 119)

  it('every default CC is an undefined controller: none in 32-63, none defined, no channel-mode', () => {
    const ccs = preset.mappings.filter((m) => m.type === 'cc').map((m) => m.cc)
    expect(ccs).toHaveLength(AXES.length)
    for (const cc of ccs) {
      expect(cc < 32 || cc > 63, `CC ${cc} is an LSB controller`).toBe(true)
      expect(cc, `CC ${cc} is a channel mode message`).toBeLessThan(120)
      expect(isFree(cc), `CC ${cc}`).toBe(true)
    }
    expect(new Set(ccs).size).toBe(ccs.length)
  })

  it('freeCc walks 20-31 then 102-119 without repeats, for more axes than exist', () => {
    const seq = Array.from({ length: 30 }, (_, i) => freeCc(i))
    expect(seq).toEqual([...Array.from({ length: 12 }, (_, i) => 20 + i), ...Array.from({ length: 18 }, (_, i) => 102 + i)])
    expect(AXES.length).toBeLessThanOrEqual(30)
  })

  it('buttons are notes and axes are CCs', () => {
    for (const m of preset.mappings) {
      expect(m.type, m.input).toBe(INPUT_BY_ID[m.input].kind === 'button' ? 'note' : 'cc')
    }
  })

  it('has a name and survives its own sanitizer unchanged (JSON round trip)', () => {
    expect(preset.name.length).toBeGreaterThan(0)
    expect(sanitizePreset(JSON.parse(JSON.stringify(preset)))).toEqual(preset)
  })

  it('two calls give independent mapping objects', () => {
    const a = defaultPreset()
    const b = defaultPreset()
    a.mappings[0].note = 1
    expect(b.mappings[0].note).not.toBe(1)
  })

  it('with nothing touched, the engine sends no notes for it', () => {
    const e = new Engine()
    e.setMappings(preset.mappings)
    const out = e.process(emptyState())
    expect(out.filter((m) => (m[0] & 0xf0) === 0x90)).toEqual([])
  })
})

describe('createMapping', () => {
  it('buttons default to notes, axes to CC, all valid', () => {
    for (const def of INPUTS) {
      const m = createMapping(def.id)
      expectValidMapping(m)
      expect(m.type).toBe(def.kind === 'button' ? 'note' : 'cc')
      expect(m.enabled).toBe(true)
    }
  })
  it('ids are unique', () => {
    const ids = Array.from({ length: 500 }, () => createMapping('a').id)
    expect(new Set(ids).size).toBe(500)
  })
  it('overrides win', () => {
    expect(createMapping('a', { note: 12, channel: 5 })).toMatchObject({ note: 12, channel: 5, input: 'a' })
  })
})

describe('sanitizeMapping', () => {
  it('rejects garbage', () => {
    for (const g of [null, undefined, 0, 5, NaN, '', 'a', true, [], [1, 2], () => 1]) {
      expect(sanitizeMapping(g), String(g)).toBeNull()
    }
    expect(sanitizeMapping({})).toBeNull()
    expect(sanitizeMapping({ input: 5 })).toBeNull()
    expect(sanitizeMapping({ input: null })).toBeNull()
  })

  it('rejects unknown inputs', () => {
    expect(sanitizeMapping({ input: 'nope' })).toBeNull()
    expect(sanitizeMapping({ input: '' })).toBeNull()
    expect(sanitizeMapping({ input: 'A' })).toBeNull()
  })

  it('rejects inputs named after Object.prototype members', () => {
    for (const input of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(sanitizeMapping({ input }), input).toBeNull()
    }
    expect(sanitizeMapping(JSON.parse('{"input":"__proto__"}'))).toBeNull()
  })

  it('fills a bare { input } with valid defaults', () => {
    for (const def of INPUTS) {
      const m = sanitizeMapping({ input: def.id })
      expect(m, def.id).not.toBeNull()
      expectValidMapping(m!)
      expect(m!.enabled).toBe(true)
      expect(m!.type).toBe(def.kind === 'button' ? 'note' : 'cc')
    }
  })

  it('keeps a valid mapping exactly', () => {
    const m = createMapping('lstick_x', {
      id: 'keep',
      enabled: false,
      type: 'pitchbend',
      channel: 16,
      note: 0,
      velocity: 1,
      cc: 127,
      min: 127,
      max: 0,
      toggle: true,
      invert: true,
      deadzone: 0.3,
      curve: 2.5,
      smooth: 0.4,
      threshold: 0.7,
      gate: 'l4',
      release: 'reset',
    })
    expect(sanitizeMapping(JSON.parse(JSON.stringify(m)))).toEqual(m)
  })

  it('clamps out-of-range numbers', () => {
    const hi = sanitizeMapping({ input: 'lt', channel: 17, note: 200, velocity: 300, cc: 128, min: 999, max: 1e9, deadzone: 5, curve: 100, smooth: 1, threshold: 2 })!
    expectValidMapping(hi)
    expect(hi).toMatchObject({ channel: 16, note: 127, velocity: 127, cc: 127, min: 127, max: 127 })
    const lo = sanitizeMapping({ input: 'lt', channel: 0, note: -5, velocity: 0, cc: -1, min: -1, max: -100, deadzone: -1, curve: 0, smooth: -3, threshold: -1 })!
    expectValidMapping(lo)
    expect(lo).toMatchObject({ channel: 1, note: 0, velocity: 1, cc: 0, min: 0, max: 0, deadzone: 0, smooth: 0 })
    const neg = sanitizeMapping({ input: 'lt', channel: -3, curve: -2 })!
    expectValidMapping(neg)
  })

  it('rounds fractional MIDI numbers to integers', () => {
    const m = sanitizeMapping({ input: 'a', channel: 2.4, note: 60.6, velocity: 99.5, cc: 7.2, min: 0.4, max: 126.6 })!
    expectValidMapping(m)
    expect(m).toMatchObject({ channel: 2, note: 61, cc: 7, min: 0, max: 127 })
  })

  it('replaces non-numeric / non-finite numbers with defaults', () => {
    const base = createMapping('lstick_x')
    for (const bad of [NaN, Infinity, -Infinity, '64', null, {}, [], true]) {
      const m = sanitizeMapping({ input: 'lstick_x', channel: bad, note: bad, velocity: bad, cc: bad, min: bad, max: bad, deadzone: bad, curve: bad, smooth: bad, threshold: bad })!
      expectValidMapping(m)
      expect(m, String(bad)).toMatchObject({
        channel: base.channel,
        note: base.note,
        velocity: base.velocity,
        cc: base.cc,
        min: base.min,
        max: base.max,
        deadzone: base.deadzone,
        curve: base.curve,
        smooth: base.smooth,
        threshold: base.threshold,
      })
    }
  })

  it('a button with type pitchbend does not stay pitchbend', () => {
    const m = sanitizeMapping({ input: 'a', type: 'pitchbend' })!
    expect(m.type).not.toBe('pitchbend')
    expectValidMapping(m)
  })

  it('an axis may be pitchbend, note or cc', () => {
    expect(sanitizeMapping({ input: 'lt', type: 'pitchbend' })!.type).toBe('pitchbend')
    expect(sanitizeMapping({ input: 'lt', type: 'note' })!.type).toBe('note')
    expect(sanitizeMapping({ input: 'lt', type: 'cc' })!.type).toBe('cc')
  })

  it('unknown type falls back to the default for the input kind', () => {
    expect(sanitizeMapping({ input: 'a', type: 'sysex' })!.type).toBe('note')
    expect(sanitizeMapping({ input: 'lt', type: 7 })!.type).toBe('cc')
  })

  it('gate must be an existing button', () => {
    expect(sanitizeMapping({ input: 'lt', gate: 'l4' })!.gate).toBe('l4')
    expect(sanitizeMapping({ input: 'lt', gate: 'rt' })!.gate).toBeNull() // an axis
    expect(sanitizeMapping({ input: 'lt', gate: 'nope' })!.gate).toBeNull()
    expect(sanitizeMapping({ input: 'lt', gate: 'constructor' })!.gate).toBeNull()
    expect(sanitizeMapping({ input: 'lt', gate: 5 })!.gate).toBeNull()
    expect(sanitizeMapping({ input: 'lt', gate: '' })!.gate).toBeNull()
  })

  it('booleans and enums are coerced strictly', () => {
    const m = sanitizeMapping({ input: 'a', enabled: 0, toggle: 'yes', invert: 1, release: 'explode' })!
    expect(m.toggle).toBe(false)
    expect(m.invert).toBe(false)
    expect(m.release).toBe('hold')
    expect(typeof m.enabled).toBe('boolean')
    expect(sanitizeMapping({ input: 'a', enabled: false })!.enabled).toBe(false)
    expect(sanitizeMapping({ input: 'a', release: 'reset' })!.release).toBe('reset')
  })

  it('a missing or bad id gets a fresh non-empty one', () => {
    for (const id of [undefined, '', 5, null, {}]) {
      const m = sanitizeMapping({ input: 'a', id })!
      expect(typeof m.id === 'string' && m.id.length > 0).toBe(true)
    }
  })

  it('drops unknown extra properties', () => {
    const m = sanitizeMapping({ input: 'a', evil: 1, __proto__: { x: 1 } })!
    expect(Object.keys(m).sort()).toEqual(Object.keys(createMapping('a')).sort())
  })

  it('whatever comes out is safe to run through the engine', () => {
    const m = sanitizeMapping({ input: 'lstick_x', type: 'cc', deadzone: 99, curve: -1, smooth: 99, min: -50, max: 500 })!
    const e = new Engine()
    e.setMappings([m])
    const s = emptyState()
    for (const v of [-1, -0.5, 0, 0.5, 1]) {
      s.axes.lstick_x = v
      for (let i = 0; i < 50; i++) {
        for (const msg of e.process(s)) {
          for (const d of msg.slice(1)) expect(Number.isInteger(d) && d >= 0 && d <= 127).toBe(true)
        }
      }
    }
  })
})

describe('sanitizePreset', () => {
  it('rejects garbage', () => {
    for (const g of [null, undefined, 3, 'x', [], {}, { mappings: 'x' }, { mappings: {} }, { name: 'n' }]) {
      expect(sanitizePreset(g)).toBeNull()
    }
  })

  it('accepts an empty mapping list', () => {
    // A preset without scale fields loads with scale mode off.
    expect(sanitizePreset({ name: 'Empty', mappings: [] })).toEqual({ name: 'Empty', mappings: [], scaleRoot: 0, scale: 'chromatic' })
  })

  it('drops invalid entries and keeps the valid ones in order', () => {
    const p = sanitizePreset({
      name: 'x',
      mappings: [null, { input: 'a', id: 'one' }, 5, { input: 'nope' }, 'str', { input: 'lt', id: 'two' }, [], { input: 'toString', id: 'three' }],
    })!
    expect(p.mappings.map((m) => m.id)).toEqual(['one', 'two'])
    p.mappings.forEach(expectValidMapping)
  })

  it('makes duplicate ids unique, keeping the first', () => {
    const p = sanitizePreset({
      mappings: [
        { input: 'a', id: 'dup', note: 1 },
        { input: 'b', id: 'dup', note: 2 },
        { input: 'x', id: 'dup', note: 3 },
        { input: 'y', id: 'other', note: 4 },
      ],
    })!
    expect(p.mappings).toHaveLength(4)
    expect(new Set(p.mappings.map((m) => m.id)).size).toBe(4)
    expect(p.mappings[0].id).toBe('dup')
    expect(p.mappings[3].id).toBe('other')
    expect(p.mappings.map((m) => m.note)).toEqual([1, 2, 3, 4])
    expect(p.mappings.every((m) => m.id.length > 0)).toBe(true)
  })

  it('name: trimmed, capped, and defaulted', () => {
    expect(sanitizePreset({ name: '  Live set  ', mappings: [] })!.name).toBe('Live set')
    expect(sanitizePreset({ name: 'x'.repeat(500), mappings: [] })!.name.length).toBeLessThanOrEqual(60)
    for (const name of [undefined, '', '   ', 5, null, {}]) {
      const n = sanitizePreset({ name, mappings: [] })!.name
      expect(typeof n === 'string' && n.trim().length > 0).toBe(true)
    }
  })

  it('clamps numbers inside nested mappings', () => {
    const p = sanitizePreset({ mappings: [{ input: 'a', channel: 99, note: -1, velocity: 0 }] })!
    expect(p.mappings[0]).toMatchObject({ channel: 16, note: 0, velocity: 1 })
  })
})

describe('noteName (Ableton convention, 60 = C3)', () => {
  it('reference points', () => {
    expect(noteName(60)).toBe('C3')
    expect(noteName(36)).toBe('C1')
    expect(noteName(0)).toBe('C-2')
  })
  it('accidentals and octave boundaries', () => {
    expect(noteName(61)).toBe('C#3')
    expect(noteName(59)).toBe('B2')
    expect(noteName(69)).toBe('A3')
    expect(noteName(11)).toBe('B-2')
    expect(noteName(12)).toBe('C-1')
    expect(noteName(24)).toBe('C0')
    expect(noteName(127)).toBe('G8')
  })
  it('all 128 names are distinct', () => {
    expect(new Set(Array.from({ length: 128 }, (_, i) => noteName(i))).size).toBe(128)
  })
})

describe('describeMapping', () => {
  it('mentions the destination and channel', () => {
    expect(describeMapping(createMapping('a', { type: 'note', note: 60, channel: 2 }))).toMatch(/C3.*2/)
    expect(describeMapping(createMapping('lt', { type: 'cc', cc: 21, channel: 1 }))).toMatch(/21.*1/)
    expect(describeMapping(createMapping('lt', { type: 'pitchbend', channel: 9 }))).toMatch(/bend.*9/i)
  })
})
