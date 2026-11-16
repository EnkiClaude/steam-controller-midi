// Generates native/Tests/fixtures.txt: random controller reports and mapping
// sets run through the TypeScript parser and engine, with the results
// recorded (run from the repository root). native/Tests/parity.cpp replays the file through the C++ port
// and requires identical output. Run with `npm run fixtures`.

import { writeFileSync } from 'node:fs'
import { Engine } from '../src/core/engine'
import { AXES, BUTTONS, emptyState } from '../src/core/inputs'
import { createMapping, type Mapping, type MappingType } from '../src/core/mapping'
import { createContext, parseReport, recenter } from '../src/core/triton'

// Small deterministic PRNG (mulberry32) so the fixture is reproducible.
let seed = 0x5c0171
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
const pick = <T,>(xs: T[]) => xs[int(0, xs.length - 1)]
const chance = (p: number) => rnd() < p

const lines: string[] = []
const num = (v: number) => (Object.is(v, -0) ? '0' : String(v))

function randomMappings(): Mapping[] {
  const out: Mapping[] = []
  const count = int(8, 40)
  for (let i = 0; i < count; i++) {
    const isAxis = chance(0.6)
    const def = isAxis ? pick(AXES) : pick(BUTTONS)
    const types: MappingType[] = isAxis ? ['cc', 'pitchbend', 'note', 'relative'] : ['note', 'cc']
    const padButton = /^[lr]pad_(click|touch)$/.test(def.id)
    out.push(
      createMapping(def.id, {
        id: `m${i}`,
        enabled: chance(0.9),
        type: pick(types),
        channel: int(1, 16),
        note: int(0, 127),
        velocity: int(1, 127),
        cc: int(0, 127),
        min: int(0, 127),
        max: int(0, 127),
        toggle: chance(0.3),
        grid: padButton ? pick([0, 2, 3, 4]) : 0,
        speed: pick([1, 16, 64, 200, 500]),
        invert: chance(0.3),
        deadzone: pick([0, 0.08, 0.3, 0.9]),
        curve: pick([0.2, 0.5, 1, 2, 5]),
        smooth: pick([0, 0, 0.5, 0.95]),
        threshold: pick([0.02, 0.3, 0.5, 0.98]),
        gate: chance(0.25) ? pick(BUTTONS).id : null,
        release: chance(0.5) ? 'reset' : 'hold',
      }),
    )
  }
  return out
}

function emitMappings(ms: Mapping[]) {
  lines.push(`MAPPINGS ${ms.length}`)
  for (const m of ms) {
    lines.push(
      [
        'M', m.id, m.input, m.type, +m.enabled, m.channel, m.note, m.velocity, m.cc, m.min, m.max,
        +m.toggle, m.grid, num(m.speed), +m.invert, num(m.deadzone), num(m.curve), num(m.smooth),
        num(m.threshold), m.gate ?? '-', m.release,
      ].join(' '),
    )
  }
}

const emitOut = (tag: string, out: number[][]) =>
  lines.push(`${tag} ${out.length}${out.map((m) => ` ${m[0]} ${m[1]} ${m[2]}`).join('')}`)

// Slowly wandering raw controller values, so axes sweep and buttons hold.
const raw = {
  buttons: 0,
  trig: [0, 0],
  stick: [0, 0, 0, 0],
  pad: [0, 0, 0, 0],
  press: [0, 0],
  accel: [0, 0, 16384],
  gyro: [0, 0, 0],
  ts: 1000,
}
const walk = (v: number, step: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v + int(-step, step)))

// A real controller sticks to one report format per connection.
let useTs47 = false

function nextReport(): { id: number; bytes: Uint8Array } {
  if (chance(0.15)) raw.buttons ^= pick(BUTTONS).mask
  if (chance(0.01)) raw.buttons = 0
  raw.trig = raw.trig.map((v) => (chance(0.05) ? pick([0, 32767]) : walk(v, 3000, 0, 32767)))
  raw.stick = raw.stick.map((v) => (chance(0.05) ? pick([-32768, 0, 32767]) : walk(v, 4000, -32768, 32767)))
  raw.pad = raw.pad.map((v) => (chance(0.05) ? pick([-32768, 0, 32767]) : walk(v, 6000, -32768, 32767)))
  raw.press = raw.press.map((v) => walk(v, 4000, 0, 65535))
  raw.accel = raw.accel.map((v) => (chance(0.01) ? 0 : walk(v, 1500, -32768, 32767)))
  raw.gyro = raw.gyro.map((v) => (chance(0.3) ? int(-30, 30) : walk(v, 2500, -32768, 32767)))

  const ts47 = useTs47
  const id = ts47 ? 0x47 : chance(0.5) ? 0x42 : 0x45
  // usually ~4 ms; sometimes a stall or a long gap
  raw.ts += chance(0.03) ? pick([0, 300000, 70000]) : int(3500, 4500)
  const len = chance(0.02) ? int(0, 44) : chance(0.5) ? 45 : 63
  const full = new Uint8Array(63)
  const v = new DataView(full.buffer)
  v.setUint8(0, int(0, 255))
  v.setUint32(1, raw.buttons >>> 0, true)
  v.setInt16(5, raw.trig[0], true)
  v.setInt16(7, raw.trig[1], true)
  raw.stick.forEach((s, i) => v.setInt16(9 + i * 2, s, true))
  let o = 17
  if (ts47) {
    v.setUint16(o, int(0, 65535), true)
    o += 2
  }
  v.setInt16(o, raw.pad[0], true)
  v.setInt16(o + 2, raw.pad[1], true)
  v.setUint16(o + 4, raw.press[0], true)
  v.setInt16(o + 6, raw.pad[2], true)
  v.setInt16(o + 8, raw.pad[3], true)
  v.setUint16(o + 10, raw.press[1], true)
  o += 12
  if (ts47) {
    v.setUint16(o, Math.floor(raw.ts / 32) & 0xffff, true)
    o += 2
  } else {
    v.setUint32(o, raw.ts >>> 0, true)
    o += 4
  }
  raw.accel.forEach((s, i) => v.setInt16(o + i * 2, s, true))
  raw.gyro.forEach((s, i) => v.setInt16(o + 6 + i * 2, s, true))
  return { id, bytes: full.slice(0, len) }
}

const engine = new Engine()
const state = emptyState()
let ctx = createContext()
let mappings = randomMappings()
emitMappings(mappings)
emitOut('SETOUT', engine.setMappings(mappings))
let solo: string | null = null
let now = 0

const STEPS = 12000
for (let step = 0; step < STEPS; step++) {
  if (step % 2000 === 1999) {
    // reconnect with the other report format
    useTs47 = !useTs47
    ctx = createContext()
    lines.push('NEWCTX')
  }
  if (chance(0.004)) {
    // edit: sometimes a fresh set, sometimes tweak one mapping in place
    if (chance(0.5)) mappings = randomMappings()
    else mappings = mappings.map((m, i) => (i === 0 ? { ...m, note: int(0, 127), cc: int(0, 127) } : m))
    emitMappings(mappings)
    emitOut('SETOUT', engine.setMappings(mappings))
  }
  if (chance(0.01)) {
    solo = chance(0.5) ? null : pick(mappings).id
    lines.push(`SOLO ${solo ?? '-'}`)
  }
  if (chance(0.003)) {
    recenter(ctx)
    lines.push('RECENTER')
  }
  if (chance(0.003)) {
    emitOut('RELEASEALL', engine.releaseAll())
  }
  // other report types and junk
  if (chance(0.02)) {
    const id = pick([0x43, 0x46, 0x79, 0x01, 0x42])
    const bytes = Uint8Array.from({ length: int(0, 20) }, () => int(0, 255))
    const r = parseReport(id, new DataView(bytes.buffer), state, ctx)
    const extra = r.type === 'battery' ? ` ${r.level} ${+r.charging}` : r.type === 'wireless' ? ` ${+r.connected}` : ''
    lines.push(`OTHER ${id} ${Buffer.from(bytes).toString('hex') || '-'} ${r.type}${extra}`)
    continue
  }
  const { id, bytes } = nextReport()
  const r = parseReport(id, new DataView(bytes.buffer), state, ctx)
  lines.push(`R ${id} ${Buffer.from(bytes).toString('hex') || '-'} ${r.type}`)
  if (r.type !== 'state') continue
  let mask = 0
  for (const b of BUTTONS) if (state.buttons[b.id]) mask |= b.mask
  lines.push(`B ${mask >>> 0}`)
  lines.push(`A ${AXES.map((a) => num(state.axes[a.id])).join(' ')}`)
  // alternate between timed and untimed processing
  const timed = step % 3 !== 0
  if (timed) now += chance(0.02) ? 5000 : 4 + rnd()
  lines.push(`T ${timed ? num(now) : -1}`)
  emitOut('O', engine.process(state, solo, timed ? now : undefined))
}

writeFileSync('native/Tests/fixtures.txt', lines.join('\n') + '\n')
console.log(`wrote ${lines.length} lines`)
