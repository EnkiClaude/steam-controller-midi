// Musical scales for scale mode. Mirrored in native/Source/Core.cpp (same
// order: the native side refers to scales by index into this list).

export const SCALES = [
  { id: 'chromatic', label: 'Chromatic (off)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'major', label: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', label: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'dorian', label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'harmonic_minor', label: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'major_pentatonic', label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  { id: 'minor_pentatonic', label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { id: 'blues', label: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
] as const

export type ScaleId = (typeof SCALES)[number]['id']

export const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function scaleIndex(id: string): number {
  const i = SCALES.findIndex((s) => s.id === id)
  return i < 0 ? 0 : i
}

function inScale(n: number, root: number, steps: readonly number[]): boolean {
  return steps.includes((((n - root) % 12) + 12) % 12)
}

/** The nearest note in the scale at or above `n` (or the highest below, at the top of the range). */
export function quantizeNote(n: number, root: number, scale: number): number {
  const steps = SCALES[scale]?.steps ?? SCALES[0].steps
  for (let k = n; k <= 127; k++) if (inScale(k, root, steps)) return k
  for (let k = n; k >= 0; k--) if (inScale(k, root, steps)) return k
  return n
}

/**
 * The note `degrees` scale steps above `base` (which should already be in the
 * scale). Past the top of the MIDI range it stays on the highest scale note.
 */
export function stepScale(base: number, degrees: number, root: number, scale: number): number {
  const steps = SCALES[scale]?.steps ?? SCALES[0].steps
  let n = base
  let last = base
  for (let left = degrees; left > 0; ) {
    n++
    if (n > 127) return last
    if (inScale(n, root, steps)) {
      last = n
      left--
    }
  }
  return n
}
