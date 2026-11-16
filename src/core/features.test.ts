import { describe, expect, it } from 'vitest'
import { Engine, learnMessages } from './engine'
import { emptyState } from './inputs'
import { createMapping, describeMapping, gridZone, sanitizeMapping } from './mapping'

const CC = 0xb0

describe('relative CC (endless encoder)', () => {
  it('stick: deflection sets the turning rate, in two’s-complement steps', () => {
    const e = new Engine()
    e.setMappings([createMapping('lstick_x', { type: 'relative', cc: 50, speed: 100, deadzone: 0 })])
    const s = emptyState()
    expect(e.process(s, null, 0)).toEqual([])
    // at rest nothing is ever sent
    expect(e.process(s, null, 50)).toEqual([])
    s.axes.lstick_x = 1
    // 100 steps/s for 50 ms = 5 steps up
    expect(e.process(s, null, 100)).toEqual([[CC, 50, 5]])
    s.axes.lstick_x = -1
    // 5 steps down = 128 - 5
    expect(e.process(s, null, 150)).toEqual([[CC, 50, 123]])
  })

  it('accumulates fractions so slow movement still adds up, and loses nothing', () => {
    const e = new Engine()
    e.setMappings([createMapping('rt', { type: 'relative', cc: 51, speed: 50 })])
    const s = emptyState()
    s.axes.rt = 0.5
    let total = 0
    for (let t = 0; t <= 1000; t += 4) {
      for (const m of e.process(s, null, t)) total += m[2]
    }
    // 50 steps/s at half deflection for 1 s
    expect(total).toBeGreaterThanOrEqual(24)
    expect(total).toBeLessThanOrEqual(25)
  })

  it('a long gap between reports does not turn into a burst', () => {
    const e = new Engine()
    e.setMappings([createMapping('rt', { type: 'relative', cc: 51, speed: 100 })])
    const s = emptyState()
    s.axes.rt = 1
    e.process(s, null, 0)
    const out = e.process(s, null, 60_000)
    expect(out).toEqual([[CC, 51, 10]]) // capped at 0.1 s worth
  })

  it('trackpad: steps follow finger travel, nothing on touch-down or lift', () => {
    const e = new Engine()
    e.setMappings([createMapping('lpad_x', { type: 'relative', cc: 52, speed: 64 })])
    const s = emptyState()
    s.buttons.lpad_touch = true
    s.axes.lpad_x = -1
    expect(e.process(s)).toEqual([])
    s.axes.lpad_x = 0 // half the pad = 32 steps
    expect(e.process(s)).toEqual([[CC, 52, 32]])
    s.axes.lpad_x = -0.5
    expect(e.process(s)).toEqual([[CC, 52, 128 - 16]])
    s.buttons.lpad_touch = false
    expect(e.process(s)).toEqual([])
    // touching down somewhere else must not jump
    s.buttons.lpad_touch = true
    s.axes.lpad_x = 1
    expect(e.process(s)).toEqual([])
  })

  it('clamps one message to ±63 steps and carries the rest', () => {
    const e = new Engine()
    e.setMappings([createMapping('lpad_x', { type: 'relative', cc: 52, speed: 400 })])
    const s = emptyState()
    s.buttons.lpad_touch = true
    s.axes.lpad_x = -1
    e.process(s)
    s.axes.lpad_x = 1
    expect(e.process(s)).toEqual([[CC, 52, 63]])
  })

  it('learn sends steps up then back down; buttons cannot be relative', () => {
    const m = createMapping('lstick_x', { type: 'relative', cc: 9, channel: 2 })
    expect(learnMessages(m).map((s) => s.message)).toEqual([
      [0xb1, 9, 1],
      [0xb1, 9, 1],
      [0xb1, 9, 127],
      [0xb1, 9, 127],
    ])
    expect(describeMapping(m)).toBe('CC 9 rel · ch 2')
    expect(sanitizeMapping({ input: 'a', type: 'relative' })?.type).toBe('cc')
    expect(sanitizeMapping({ input: 'lt', type: 'relative', speed: 99999 })?.speed).toBe(500)
  })
})

describe('trackpad note grid', () => {
  it('zones count from the bottom-left, left to right then up', () => {
    expect(gridZone(-1, -1, 2)).toBe(0)
    expect(gridZone(1, -1, 2)).toBe(1)
    expect(gridZone(-1, 1, 2)).toBe(2)
    expect(gridZone(1, 1, 2)).toBe(3)
    expect(gridZone(0, 0, 4)).toBe(10)
    expect(gridZone(-0.01, -0.01, 4)).toBe(5)
    expect(gridZone(5, -5, 4)).toBe(3)
  })

  it('the zone under the finger at the click picks the note; note-off matches', () => {
    const e = new Engine()
    e.setMappings([createMapping('rpad_click', { type: 'note', note: 36, grid: 4 })])
    const s = emptyState()
    e.process(s)
    s.buttons.rpad_touch = true
    s.axes.rpad_x = 0.9
    s.axes.rpad_y = 0.9
    s.buttons.rpad_click = true
    expect(e.process(s)).toEqual([[0x90, 51, 100]])
    // sliding while held does not retrigger, and release stops the same note
    s.axes.rpad_x = -0.9
    expect(e.process(s)).toEqual([])
    s.buttons.rpad_click = false
    expect(e.process(s)).toEqual([[0x80, 51, 0]])
    s.axes.rpad_y = -0.9
    s.buttons.rpad_click = true
    expect(e.process(s)).toEqual([[0x90, 36, 100]])
  })

  it('never exceeds note 127, is ignored on other buttons, and is described as a range', () => {
    const e = new Engine()
    e.setMappings([createMapping('lpad_touch', { type: 'note', note: 120, grid: 4 })])
    const s = emptyState()
    s.axes.lpad_x = 1
    s.axes.lpad_y = 1
    s.buttons.lpad_touch = true
    expect(e.process(s)).toEqual([[0x90, 127, 100]])
    expect(sanitizeMapping({ input: 'a', grid: 4 })?.grid).toBe(0)
    expect(sanitizeMapping({ input: 'lpad_click', grid: 7 })?.grid).toBe(0)
    expect(sanitizeMapping({ input: 'lpad_click', grid: 3 })?.grid).toBe(3)
    expect(describeMapping(createMapping('lpad_click', { note: 36, grid: 2 }))).toBe('C1–D#1 · ch 1')
  })
})
