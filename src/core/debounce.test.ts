import { describe, expect, it } from 'vitest'
import { DEBOUNCE_MS, Debouncer } from './debounce'
import { Engine } from './engine'
import { emptyState } from './inputs'
import { createMapping } from './mapping'

describe('button debounce', () => {
  it('passes a press through at once and swallows contact chatter', () => {
    const d = new Debouncer()
    const e = new Engine()
    e.setMappings([createMapping('l4', { type: 'note', note: 36 })])
    const s = emptyState()
    const out: number[][] = []
    // press, chatter open/closed over the next 12 ms, then held, then a clean release
    const raw: [number, boolean][] = [
      [0, true], [4, false], [8, true], [12, false], [16, true], [20, true], [24, true],
      [100, false], [104, true], [108, false], [112, false], [130, false],
    ]
    for (const [t, down] of raw) {
      s.buttons.l4 = down
      d.apply(s, t)
      out.push(...e.process(s))
    }
    expect(out).toEqual([
      [0x90, 36, 100],
      [0x80, 36, 0],
    ])
  })

  it('adds no delay to the first edge and settles on the real state after the window', () => {
    const d = new Debouncer()
    const s = emptyState()
    s.buttons.a = true
    d.apply(s, 1000)
    expect(s.buttons.a).toBe(true)
    // released inside the window: held as pressed until the window ends
    s.buttons.a = false
    d.apply(s, 1005)
    expect(s.buttons.a).toBe(true)
    s.buttons.a = false
    d.apply(s, 1000 + DEBOUNCE_MS)
    expect(s.buttons.a).toBe(false)
  })

  it('still lets a fast roll through and treats buttons independently', () => {
    const d = new Debouncer()
    const s = emptyState()
    let presses = 0
    let was = false
    // 40 ms between hits, 20 ms down each: 25 hits a second
    for (let t = 0; t < 400; t += 4) {
      s.buttons.r4 = t % 40 < 20
      s.buttons.r5 = true
      d.apply(s, t)
      if (s.buttons.r4 && !was) presses++
      was = s.buttons.r4
      expect(s.buttons.r5).toBe(true)
    }
    expect(presses).toBe(10)
  })
})
