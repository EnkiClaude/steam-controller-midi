// 0.2 data model: sanitizing the new mapping / preset fields, the factory
// presets, the default preset's motion mappings, the rumble report and the
// app settings.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../store'
import { Engine, type MidiMessage } from './engine'
import { AXES, BUTTONS, INPUTS, INPUT_BY_ID, emptyState } from './inputs'
import {
  FACTORY_PRESETS,
  REPEAT_RATES,
  VELOCITY_SOURCES,
  createMapping,
  defaultPreset,
  gridPadOf,
  sanitizeMapping,
  sanitizePreset,
  type Mapping,
  type Preset,
} from './mapping'
import { SCALES, quantizeNote, scaleIndex, stepScale } from './scales'
import { REPORT_RUMBLE, buildRumbleReport } from './triton'

const BUTTON_IDS = BUTTONS.map((b) => b.id)
const AXIS_IDS = AXES.map((a) => a.id)
const PAD_BUTTONS = ['lpad_click', 'lpad_touch', 'rpad_click', 'rpad_touch']

// ===========================================================================
describe('sanitizeMapping: 0.2 fields', () => {
  it('a pre-0.2 mapping (no new fields) gets the defaults', () => {
    for (const input of ['a', 'rpad_click', 'lt', 'lstick_x', 'tilt_roll']) {
      const m = sanitizeMapping({ id: 'x', input, type: 'note', note: 50 })!
      expect(m).toMatchObject({ velFrom: 'fixed', velMin: 1, gain: 1, repeat: 0, scale: true, mpe: false, bend: 2 })
    }
  })

  it('velFrom: every source accepted on axes; speed rejected on buttons; junk → fixed', () => {
    for (const src of VELOCITY_SOURCES) {
      expect(sanitizeMapping({ input: 'lt', velFrom: src })!.velFrom).toBe(src)
      expect(sanitizeMapping({ input: 'lstick_y', velFrom: src })!.velFrom).toBe(src)
    }
    for (const b of BUTTON_IDS) {
      expect(sanitizeMapping({ input: b, velFrom: 'speed' })!.velFrom, b).toBe('fixed')
      expect(sanitizeMapping({ input: b, velFrom: 'rpad_pressure' })!.velFrom).toBe('rpad_pressure')
    }
    for (const junk of ['lstick_x', 'a', 'toString', 'constructor', '', 3, null, {}, ['lt'], 'LT']) {
      expect(sanitizeMapping({ input: 'a', velFrom: junk })!.velFrom).toBe('fixed')
    }
  })

  it('repeat: only the listed rates, only on buttons', () => {
    for (const r of REPEAT_RATES) expect(sanitizeMapping({ input: 'l4', repeat: r })!.repeat).toBe(r)
    for (const junk of [1, 5, 7, 16, -2, 2.5, '4', null, true, NaN]) {
      expect(sanitizeMapping({ input: 'l4', repeat: junk })!.repeat, String(junk)).toBe(0)
    }
    for (const axis of AXIS_IDS) expect(sanitizeMapping({ input: axis, type: 'note', repeat: 4 })!.repeat).toBe(0)
  })

  it('mpe: only on trackpad click / touch', () => {
    for (const p of PAD_BUTTONS) expect(sanitizeMapping({ input: p, type: 'note', mpe: true })!.mpe).toBe(true)
    for (const id of INPUTS.map((i) => i.id).filter((id) => !PAD_BUTTONS.includes(id))) {
      expect(sanitizeMapping({ input: id, type: 'note', mpe: true })!.mpe, id).toBe(false)
    }
    expect(sanitizeMapping({ input: 'rpad_touch', mpe: 'yes' })!.mpe).toBe(false)
    expect(sanitizeMapping({ input: 'rpad_touch', mpe: 1 })!.mpe).toBe(false)
  })

  it('gain: 1..10, non-numbers → 1', () => {
    const g = (v: unknown) => sanitizeMapping({ input: 'lt', gain: v })!.gain
    expect(g(2.5)).toBe(2.5)
    expect(g(0.5)).toBe(1)
    expect(g(0)).toBe(1)
    expect(g(-3)).toBe(1)
    expect(g(11)).toBe(10)
    expect(g(Infinity)).toBe(1)
    expect(g(NaN)).toBe(1)
    expect(g('3')).toBe(1)
  })

  it('bend: integer 1..48', () => {
    const b = (v: unknown) => sanitizeMapping({ input: 'rpad_touch', bend: v })!.bend
    expect(b(12)).toBe(12)
    expect(b(0)).toBe(1)
    expect(b(100)).toBe(48)
    expect(b(2.6)).toBe(3)
    expect(b('24')).toBe(2)
    expect(b(NaN)).toBe(2)
  })

  it('velMin: integer 1..127', () => {
    const v = (x: unknown) => sanitizeMapping({ input: 'a', velMin: x })!.velMin
    expect(v(40)).toBe(40)
    expect(v(0)).toBe(1)
    expect(v(200)).toBe(127)
    expect(v(39.4)).toBe(39)
    expect(v(null)).toBe(1)
  })

  it('scale: defaults to true, only an explicit false opts out', () => {
    const s = (x: unknown) => sanitizeMapping({ input: 'a', scale: x })!.scale
    expect(s(undefined)).toBe(true)
    expect(s(true)).toBe(true)
    expect(s(false)).toBe(false)
    expect(s(0)).toBe(true)
    expect(s('false')).toBe(true)
  })

  it('a sanitized mapping round-trips unchanged', () => {
    const m = createMapping('rpad_click', {
      id: 'z',
      type: 'note',
      grid: 4,
      velFrom: 'rpad_pressure',
      velMin: 30,
      velocity: 127,
      repeat: 6,
      scale: false,
      mpe: true,
      bend: 24,
    })
    expect(sanitizeMapping(JSON.parse(JSON.stringify(m)))).toEqual(m)
  })
})

// ===========================================================================
describe('sanitizePreset: scale fields', () => {
  it('keeps a valid scale and root', () => {
    for (const s of SCALES) {
      expect(sanitizePreset({ mappings: [], scale: s.id, scaleRoot: 7 })).toMatchObject({ scale: s.id, scaleRoot: 7 })
    }
  })

  it('unknown scale id → chromatic', () => {
    for (const junk of ['nope', 'Major', '', 1, null, {}, 'toString', 'constructor']) {
      expect(sanitizePreset({ mappings: [], scale: junk })!.scale).toBe('chromatic')
    }
  })

  it('root is clamped to 0..11 and rounded', () => {
    const r = (v: unknown) => sanitizePreset({ mappings: [], scale: 'major', scaleRoot: v })!.scaleRoot
    expect(r(12)).toBe(11)
    expect(r(-1)).toBe(0)
    expect(r(4.6)).toBe(5)
    expect(r('3')).toBe(0)
    expect(r(NaN)).toBe(0)
  })

  it('an old preset without the new fields loads with scale off and default mapping fields', () => {
    const old = {
      name: 'Old',
      mappings: [
        { id: 'a1', input: 'a', enabled: true, type: 'note', channel: 1, note: 36, velocity: 100 },
        { id: 'm1', input: 'tilt_roll', enabled: false, type: 'cc', cc: 30, gate: 'rgrip_touch' },
      ],
    }
    const p = sanitizePreset(old)!
    expect(p.scale).toBe('chromatic')
    expect(p.scaleRoot).toBe(0)
    expect(p.mappings[0]).toMatchObject({ velFrom: 'fixed', repeat: 0, scale: true, mpe: false })
    // an old preset's explicit gate is kept
    expect(p.mappings[1].gate).toBe('rgrip_touch')
  })
})

// ===========================================================================
describe('FACTORY_PRESETS', () => {
  it('ids are unique and every make() returns a fresh preset', () => {
    expect(new Set(FACTORY_PRESETS.map((f) => f.id)).size).toBe(FACTORY_PRESETS.length)
    for (const f of FACTORY_PRESETS) {
      const a = f.make()
      const b = f.make()
      expect(a).not.toBe(b)
      expect(a.mappings[0]).not.toBe(b.mappings[0])
      expect(new Set([...a.mappings, ...b.mappings].map((m) => m.id)).size, f.id).toBe(a.mappings.length * 2)
    }
  })

  for (const f of FACTORY_PRESETS) {
    describe(f.id, () => {
      const p = f.make()

      it('round-trips through sanitizePreset unchanged (via JSON)', () => {
        expect(sanitizePreset(JSON.parse(JSON.stringify(p)))).toEqual(p)
      })

      it('every mapping is valid and in range', () => {
        expect(SCALES.some((s) => s.id === p.scale)).toBe(true)
        expect(p.scaleRoot >= 0 && p.scaleRoot <= 11).toBe(true)
        for (const m of p.mappings) {
          expect(INPUT_BY_ID[m.input], m.input).toBeDefined()
          expect(sanitizeMapping(m), m.input).toEqual(m)
          expect(m.velMin >= 1 && m.velMin <= 127).toBe(true)
          expect(m.velocity >= 1 && m.velocity <= 127).toBe(true)
          // every note the mapping can play is in 0..127
          const zones = m.grid > 0 ? m.grid * m.grid : 1
          expect(m.note + zones - 1, m.input).toBeLessThanOrEqual(127)
        }
      })

      it('mapping ids are unique', () => {
        expect(new Set(p.mappings.map((m) => m.id)).size).toBe(p.mappings.length)
      })

      it('plays: random input over the preset only ever sends valid 7-bit data', () => {
        const engine = new Engine()
        engine.setOptions({ scale: scaleIndex(p.scale), scaleRoot: p.scaleRoot })
        engine.setMappings(p.mappings)
        const state = emptyState()
        let s = 3
        const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
        for (let i = 0; i < 3000; i++) {
          for (const b of BUTTON_IDS) if (rnd() < 0.02) state.buttons[b] = !state.buttons[b]
          for (const a of AXES) if (rnd() < 0.1) state.axes[a.id] = a.polarity === 'bipolar' ? rnd() * 2 - 1 : rnd()
          for (const m of engine.process(state, null, i * 4)) {
            for (const d of m.slice(1)) expect(Number.isInteger(d) && d >= 0 && d <= 127, `[${m}]`).toBe(true)
          }
        }
        engine.releaseAll()
      })
    })
  }

  /** Every (kind, channel, number) an enabled non-MPE mapping can send, with the inputs that send it. */
  function destinations(p: Preset): Map<string, string[]> {
    const sc = scaleIndex(p.scale)
    const out = new Map<string, string[]>()
    const add = (k: string, input: string) => out.set(k, [...(out.get(k) ?? []), input])
    for (const m of p.mappings) {
      if (!m.enabled || m.mpe) continue
      if (m.type === 'note') {
        const zones = gridPadOf(m.input) && m.grid > 0 ? m.grid * m.grid : 1
        for (let z = 0; z < zones; z++) {
          let n: number
          if (sc > 0 && m.scale) {
            const base = quantizeNote(m.note, p.scaleRoot, sc)
            n = z > 0 ? stepScale(base, z, p.scaleRoot, sc) : base
          } else n = Math.min(127, m.note + z)
          add(`note ch${m.channel} ${n}`, m.input)
        }
      } else if (m.type === 'pitchbend') add(`bend ch${m.channel}`, m.input)
      else add(`cc ch${m.channel} ${m.cc}`, m.input)
    }
    return out
  }
  const shared = (p: Preset) => [...destinations(p)].filter(([, v]) => v.length > 1)

  it('default, synth and clip launcher: no two enabled mappings send the same note / CC on one channel', () => {
    for (const id of ['default', 'synth', 'clips']) {
      expect(shared(FACTORY_PRESETS.find((f) => f.id === id)!.make()), id).toEqual([])
    }
  })

  it('drum kit: the only shared notes are the deliberate doubled drums (kick, snare, hats, crash)', () => {
    // The pad grid covers every Drum Rack pad, so each dedicated drum control
    // also appears there; the two hi-hat roll speeds share 42 on purpose.
    // Pinned so a new accidental overlap shows up.
    expect(shared(FACTORY_PRESETS.find((f) => f.id === 'drums')!.make())).toEqual([
      ['note ch1 36', ['rt', 'rpad_click']],
      ['note ch1 38', ['lt', 'rpad_click']],
      ['note ch1 42', ['rpad_click', 'l4', 'l5']],
      ['note ch1 46', ['rpad_click', 'r4']],
      ['note ch1 49', ['rpad_click', 'r5']],
    ])
  })

  it('synth: MPE pads in the preset scale, both pads MPE, other notes on channel 1 in A minor', () => {
    const p = FACTORY_PRESETS.find((f) => f.id === 'synth')!.make()
    expect(p.scale).toBe('minor')
    expect(p.scaleRoot).toBe(9)
    const mpe = p.mappings.filter((m) => m.mpe)
    expect(mpe.map((m) => m.input).sort()).toEqual(['lpad_touch', 'rpad_touch'])
    for (const m of p.mappings.filter((m) => !m.mpe && m.type === 'note')) {
      expect(quantizeNote(m.note, 9, scaleIndex('minor')), m.input).toBe(m.note)
    }
  })
})

// ===========================================================================
describe('defaultPreset: motion', () => {
  it('motion mappings are disabled and no longer gated', () => {
    const p = defaultPreset()
    const motion = p.mappings.filter((m) => (INPUT_BY_ID[m.input] as { group: string }).group === 'motion')
    expect(motion.length).toBe(AXES.filter((a) => a.group === 'motion').length)
    for (const m of motion) {
      expect(m.enabled, m.input).toBe(false)
      expect(m.gate, m.input).toBeNull()
    }
  })

  it('has scale mode off and every mapping uses the 0.2 defaults', () => {
    const p = defaultPreset()
    expect(p.scale).toBe('chromatic')
    expect(p.scaleRoot).toBe(0)
    for (const m of p.mappings) {
      expect(m).toMatchObject({ velFrom: 'fixed', gain: 1, repeat: 0, mpe: false } satisfies Partial<Mapping>)
    }
  })

  it('an enabled motion mapping (no gate) sends on tilt, without needing a grip', () => {
    const m = defaultPreset().mappings.find((x) => x.input === 'tilt_roll')!
    const engine = new Engine()
    engine.setMappings([{ ...m, enabled: true, smooth: 0 }])
    const state = emptyState()
    expect(engine.process(state)).toEqual([]) // first sample silent
    state.axes.tilt_roll = 1
    expect(engine.process(state)).toEqual([[0xb0, m.cc, 127]])
  })
})

// ===========================================================================
describe('buildRumbleReport', () => {
  it('is 9 bytes: u8 type, u16 intensity, {u16 speed, i8 gain} left and right, little-endian', () => {
    const r = buildRumbleReport(0x1234, 0xabcd)
    expect(r).toBeInstanceOf(Uint8Array)
    expect([...r]).toEqual([0, 0, 0, 0x34, 0x12, 0, 0xcd, 0xab, 0])
  })

  it('clamps and rounds speeds to 0..65535', () => {
    expect([...buildRumbleReport(-5, 70000)]).toEqual([0, 0, 0, 0, 0, 0, 0xff, 0xff, 0])
    expect([...buildRumbleReport(1.6, 65535.4)]).toEqual([0, 0, 0, 2, 0, 0, 0xff, 0xff, 0])
    expect([...buildRumbleReport(NaN, Infinity)].slice(3, 8)).toEqual([0, 0, 0, 0xff, 0xff])
  })

  it('zero speeds give an all-zero (stop) report', () => {
    expect([...buildRumbleReport(0, 0)]).toEqual(new Array(9).fill(0))
  })

  it('uses output report 0x80', () => {
    expect(REPORT_RUMBLE).toBe(0x80)
  })
})

// ===========================================================================
describe('sanitizeSettings', () => {
  it('defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({ tempo: 120, hapticNotes: false, hapticStrength: 0.5, metronome: 'off' })
    for (const junk of [undefined, null, 3, 'x', [], {}]) expect(sanitizeSettings(junk)).toEqual(DEFAULT_SETTINGS)
  })

  it('returns a copy, not DEFAULT_SETTINGS itself', () => {
    expect(sanitizeSettings({})).not.toBe(DEFAULT_SETTINGS)
  })

  it('tempo: 20..300, rounded', () => {
    const t = (v: unknown) => sanitizeSettings({ tempo: v }).tempo
    expect(t(128)).toBe(128)
    expect(t(127.6)).toBe(128)
    expect(t(5)).toBe(20)
    expect(t(999)).toBe(300)
    expect(t(NaN)).toBe(120)
    expect(t('140')).toBe(120)
  })

  it('haptics and metronome', () => {
    expect(sanitizeSettings({ hapticNotes: true }).hapticNotes).toBe(true)
    expect(sanitizeSettings({ hapticNotes: 'yes' }).hapticNotes).toBe(false)
    expect(sanitizeSettings({ hapticStrength: 0 }).hapticStrength).toBe(0.05)
    expect(sanitizeSettings({ hapticStrength: 2 }).hapticStrength).toBe(1)
    expect(sanitizeSettings({ hapticStrength: 0.3 }).hapticStrength).toBe(0.3)
    expect(sanitizeSettings({ metronome: 'beat' }).metronome).toBe('beat')
    expect(sanitizeSettings({ metronome: 'bar' }).metronome).toBe('bar')
    expect(sanitizeSettings({ metronome: 'on' }).metronome).toBe('off')
  })
})
