// The mapping model: how one controller input turns into MIDI.

import { AXES, BUTTONS, INPUT_BY_ID } from './inputs'
import { SCALES, type ScaleId } from './scales'

/** 'relative' is a CC that sends +/- steps like an endless encoder instead of a position */
export type MappingType = 'note' | 'cc' | 'pitchbend' | 'relative'

/**
 * One input → one MIDI destination. An input can have several mappings.
 * The shape is deliberately flat: every field always exists, and `type`
 * plus the input's kind decide which ones are used.
 */
export interface Mapping {
  id: string
  input: string
  enabled: boolean
  type: MappingType
  /** 1-16 */
  channel: number

  /** note number (type 'note') */
  note: number
  /** note-on velocity 1-127 (type 'note') */
  velocity: number
  /** controller number (type 'cc') */
  cc: number
  /** CC value when a button is released, or at the bottom of an axis */
  min: number
  /** CC value when a button is pressed, or at the top of an axis */
  max: number
  /** buttons: press toggles on/off instead of following the press */
  toggle: boolean
  /**
   * trackpad click / touch → note only: split the pad into grid × grid zones,
   * each playing its own note counting up from `note` (bottom-left first, like
   * a Drum Rack). 0 = off.
   */
  grid: number
  /**
   * type 'relative': steps sent for one full sweep of a trackpad, or steps per
   * second with a stick / trigger / motion axis fully deflected
   */
  speed: number

  // --- axis shaping (ignored for buttons) ---
  invert: boolean
  /** 0-0.9: portion of travel around rest that is ignored */
  deadzone: number
  /** response curve exponent: 1 linear, >1 fine control near rest, <1 fast start */
  curve: number
  /** 0-0.95: how much to smooth jitter */
  smooth: number
  /** axis → note: position (0-1) at which the note fires */
  threshold: number
  /** only send while this button is held; null = always */
  gate: string | null
  /** when the axis goes inactive (finger lifts / gate released): keep the last value or return to rest */
  release: 'hold' | 'reset'

  // --- added in 0.2 ---
  /**
   * Where a note's velocity comes from: 'fixed' (always `velocity`), an
   * analog input (trigger or trackpad pressure, read at the moment the note
   * starts) scaled into velMin..velocity, or, for an axis played as a note,
   * 'speed': how fast it crossed the threshold.
   */
  velFrom: VelocitySource
  /** velocity at the bottom of the source's range (1-127) */
  velMin: number
  /** axes: multiplies the input before shaping, so less movement covers the whole range (1-10) */
  gain: number
  /**
   * button → note: retrigger while held, this many notes per beat
   * (2 = 1/8, 3 = 1/8 triplets, 4 = 1/16, 6 = 1/16 triplets, 8 = 1/32). 0 = off.
   */
  repeat: number
  /** notes follow the preset's scale (when it has one) */
  scale: boolean
  /**
   * trackpad click / touch → note: MPE. Each note gets its own channel (2-16)
   * and, while held, sliding sends per-note pitch bend, up / down sends
   * CC 74 and pressing harder sends channel pressure.
   */
  mpe: boolean
  /** MPE: semitones of bend for sliding from the touch point to the pad's edge (1-48) */
  bend: number
}

export const VELOCITY_SOURCES = ['fixed', 'lt', 'rt', 'lpad_pressure', 'rpad_pressure', 'speed'] as const
export type VelocitySource = (typeof VELOCITY_SOURCES)[number]

/** Allowed values for Mapping.repeat. */
export const REPEAT_RATES = [0, 2, 3, 4, 6, 8] as const

let idCounter = 0
export function newId(): string {
  idCounter += 1
  return `m${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

export function createMapping(input: string, overrides: Partial<Mapping> = {}): Mapping {
  const def = INPUT_BY_ID[input]
  const isAxis = def?.kind === 'axis'
  return {
    id: newId(),
    input,
    enabled: true,
    type: isAxis ? 'cc' : 'note',
    channel: 1,
    note: 60,
    velocity: 100,
    cc: 1,
    min: 0,
    max: 127,
    toggle: false,
    grid: 0,
    speed: 64,
    invert: false,
    deadzone: isAxis && def.polarity === 'bipolar' && !def.activeWhile && def.group !== 'motion' ? 0.08 : 0,
    curve: 1,
    smooth: def?.group === 'motion' ? 0.6 : 0,
    threshold: 0.5,
    gate: null,
    release: 'hold',
    velFrom: 'fixed',
    velMin: 1,
    gain: 1,
    repeat: 0,
    scale: true,
    mpe: false,
    bend: 2,
    ...overrides,
  }
}

const int = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(hi, Math.max(lo, n))
}
const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(hi, Math.max(lo, n))
}

/** Coerce untrusted data (imported file, old localStorage) into a valid mapping, or null. */
export function sanitizeMapping(raw: unknown): Mapping | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.input !== 'string' || !INPUT_BY_ID[r.input]) return null
  const base = createMapping(r.input)
  const type: MappingType =
    r.type === 'note' || r.type === 'cc' || r.type === 'pitchbend' || r.type === 'relative' ? r.type : base.type
  const isButton = INPUT_BY_ID[r.input].kind === 'button'
  return {
    id: typeof r.id === 'string' && r.id ? r.id : base.id,
    input: r.input,
    enabled: r.enabled !== false,
    type: isButton && (type === 'pitchbend' || type === 'relative') ? 'cc' : type,
    channel: int(r.channel, 1, 16, 1),
    note: int(r.note, 0, 127, base.note),
    velocity: int(r.velocity, 1, 127, base.velocity),
    cc: int(r.cc, 0, 127, base.cc),
    min: int(r.min, 0, 127, base.min),
    max: int(r.max, 0, 127, base.max),
    toggle: r.toggle === true,
    grid: gridPadOf(r.input) && (r.grid === 2 || r.grid === 3 || r.grid === 4) ? r.grid : 0,
    speed: num(r.speed, 1, 500, base.speed),
    invert: r.invert === true,
    deadzone: num(r.deadzone, 0, 0.9, base.deadzone),
    curve: num(r.curve, 0.2, 5, base.curve),
    smooth: num(r.smooth, 0, 0.95, base.smooth),
    threshold: num(r.threshold, 0.02, 0.98, base.threshold),
    gate: typeof r.gate === 'string' && INPUT_BY_ID[r.gate]?.kind === 'button' ? r.gate : null,
    release: r.release === 'reset' ? 'reset' : 'hold',
    velFrom:
      (VELOCITY_SOURCES as readonly unknown[]).includes(r.velFrom) && (r.velFrom !== 'speed' || !isButton)
        ? (r.velFrom as VelocitySource)
        : 'fixed',
    velMin: int(r.velMin, 1, 127, base.velMin),
    gain: num(r.gain, 1, 10, base.gain),
    repeat: isButton && (REPEAT_RATES as readonly unknown[]).includes(r.repeat) ? (r.repeat as number) : 0,
    scale: r.scale !== false,
    mpe: gridPadOf(r.input) !== null && r.mpe === true,
    bend: int(r.bend, 1, 48, base.bend),
  }
}

/** 'lpad' / 'rpad' for the trackpad click and touch buttons (which can use a note grid), else null. */
export function gridPadOf(input: string): string | null {
  const m = /^([lr]pad)_(click|touch)$/.exec(input)
  return m ? m[1] : null
}

/** Zone index 0..grid²-1 for a pad position, counting from the bottom-left, left to right then up. */
export function gridZone(x: number, y: number, grid: number): number {
  const cell = (v: number) => Math.min(grid - 1, Math.max(0, Math.floor(((v + 1) / 2) * grid)))
  return cell(y) * grid + cell(x)
}

export interface Preset {
  name: string
  mappings: Mapping[]
  /** scale mode: root note 0-11 (C = 0) and an id from SCALES ('chromatic' = off) */
  scaleRoot: number
  scale: ScaleId
}

export function sanitizePreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.mappings)) return null
  const seen = new Set<string>()
  const mappings: Mapping[] = []
  for (const m of r.mappings) {
    const s = sanitizeMapping(m)
    if (!s) continue
    if (seen.has(s.id)) s.id = newId()
    seen.add(s.id)
    mappings.push(s)
  }
  return {
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : 'Imported',
    mappings,
    scaleRoot: int(r.scaleRoot, 0, 11, 0),
    scale: SCALES.some((s) => s.id === r.scale) ? (r.scale as ScaleId) : 'chromatic',
  }
}

/**
 * The out-of-the-box preset: every input gets its own note or CC on channel 1
 * so the controller is useful in Live's MIDI Map mode straight away.
 * Buttons play a chromatic run from C1 (the Drum Rack's first pad);
 * axes use CCs 20-31 and then 102-119, which have no standard meaning.
 */
/** The i-th controller number from the ranges MIDI leaves undefined (20-31, 102-119). */
export function freeCc(i: number): number {
  return i < 12 ? 20 + i : Math.min(119, 102 + (i - 12))
}

export function defaultPreset(): Preset {
  const mappings: Mapping[] = []
  BUTTONS.forEach((def, i) => {
    // Capacitive touches fire constantly while you play; start them disabled.
    mappings.push(createMapping(def.id, { type: 'note', note: 36 + i, enabled: !def.touch }))
  })
  AXES.forEach((def, i) => {
    const motion = def.group === 'motion'
    mappings.push(
      createMapping(def.id, {
        type: 'cc',
        cc: freeCc(i),
        // Motion would otherwise move parameters whenever the controller is
        // picked up, so it starts switched off.
        enabled: !motion,
      }),
    )
  })
  return { name: 'Default', mappings, scaleRoot: 0, scale: 'chromatic' }
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** Ableton convention: note 60 = C3. */
export function noteName(n: number): string {
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 2}`
}

/** Short human description of where a mapping sends, e.g. "CC 21 · ch 1". */
export function describeMapping(m: Mapping): string {
  const ch = `ch ${m.channel}`
  if (m.type === 'note') {
    if (m.mpe && gridPadOf(m.input)) return `${noteName(m.note)} MPE · ch 2–16`
    if (m.grid > 0 && gridPadOf(m.input)) {
      return `${noteName(m.note)}–${noteName(Math.min(127, m.note + m.grid * m.grid - 1))} · ${ch}`
    }
    return `${noteName(m.note)} · ${ch}`
  }
  if (m.type === 'cc') return `CC ${m.cc} · ${ch}`
  if (m.type === 'relative') return `CC ${m.cc} rel · ${ch}`
  return `Pitch bend · ${ch}`
}

// ------------------------------------------------------------ factory presets

const preset = (name: string, mappings: Mapping[], scaleRoot = 0, scale: ScaleId = 'chromatic'): Preset => ({
  name,
  mappings,
  scaleRoot,
  scale,
})

/** Drums for a Drum Rack: trigger kicks and snares, a pressure-sensitive pad grid and hi-hat rolls. */
function drumKit(): Preset {
  const n = (input: string, note: number, extra: Partial<Mapping> = {}) =>
    createMapping(input, { type: 'note', note, scale: false, ...extra })
  return preset('Drum kit', [
    // Pull a trigger fast for a hard hit.
    n('rt', 36, { velFrom: 'speed', velMin: 40, velocity: 127, threshold: 0.3 }),
    n('lt', 38, { velFrom: 'speed', velMin: 40, velocity: 127, threshold: 0.3 }),
    // Right pad: the Drum Rack's 16 pads, harder press = louder.
    n('rpad_click', 36, { grid: 4, velFrom: 'rpad_pressure', velMin: 30, velocity: 127 }),
    // Hold the back buttons for hi-hat rolls in time with Live.
    n('l4', 42, { repeat: 4 }),
    n('l5', 42, { repeat: 8 }),
    n('r4', 46),
    n('r5', 49),
  ])
}

/** A synth performance setup: MPE trackpads in a scale, tilt and sticks for expression. */
function synthPerformance(): Preset {
  return preset(
    'Synth performance',
    [
      // Each finger is its own MPE voice: slide to bend, move up/down for timbre, press for pressure.
      // (Velocity is fixed: at the instant a finger lands the pad reads almost no pressure.)
      createMapping('rpad_touch', { type: 'note', note: 60, grid: 4, mpe: true, bend: 2, velocity: 100 }),
      createMapping('lpad_touch', { type: 'note', note: 48, grid: 4, mpe: true, bend: 2, velocity: 100 }),
      // Tilt forward/back for the mod wheel; a 30° tilt covers the full range.
      createMapping('tilt_pitch', { type: 'cc', cc: 1, gain: 3, smooth: 0.6 }),
      createMapping('tilt_roll', { type: 'cc', cc: 21, gain: 3, smooth: 0.6 }),
      createMapping('lstick_x', { type: 'pitchbend', channel: 1 }),
      createMapping('rstick_x', { type: 'cc', cc: 22 }),
      createMapping('rstick_y', { type: 'cc', cc: 23 }),
      createMapping('lt', { type: 'cc', cc: 24 }),
      createMapping('rt', { type: 'cc', cc: 25 }),
      createMapping('a', { type: 'note', note: 57 }),
      createMapping('b', { type: 'note', note: 60 }),
      createMapping('x', { type: 'note', note: 64 }),
      createMapping('y', { type: 'note', note: 67 }),
    ],
    9,
    'minor',
  )
}

/** For Live's MIDI Map mode: unique notes on channel 16 to launch clips and scenes. */
function clipLauncher(): Preset {
  const n = (input: string, note: number, extra: Partial<Mapping> = {}) =>
    createMapping(input, { type: 'note', note, channel: 16, velocity: 127, scale: false, ...extra })
  return preset('Clip launcher', [
    // Right pad: a 4 × 4 block of clips. Left pad: 4 × 4 more.
    n('rpad_click', 0, { grid: 4 }),
    n('lpad_click', 16, { grid: 4 }),
    // D-pad for session navigation, face buttons for scenes / stop.
    n('dpad_up', 32),
    n('dpad_down', 33),
    n('dpad_left', 34),
    n('dpad_right', 35),
    n('a', 36),
    n('b', 37),
    n('x', 38),
    n('y', 39),
    n('lb', 40),
    n('rb', 41),
    // Scroll through tracks or a parameter like an endless knob.
    createMapping('lstick_y', { type: 'relative', cc: 20, channel: 16, speed: 24 }),
    createMapping('lt', { type: 'cc', cc: 21, channel: 16 }),
    createMapping('rt', { type: 'cc', cc: 22, channel: 16 }),
  ])
}

export const FACTORY_PRESETS: { id: string; label: string; make(): Preset }[] = [
  { id: 'default', label: 'Default (everything mapped)', make: defaultPreset },
  { id: 'drums', label: 'Drum kit', make: drumKit },
  { id: 'synth', label: 'Synth performance (MPE)', make: synthPerformance },
  { id: 'clips', label: 'Clip launcher', make: clipLauncher },
]
