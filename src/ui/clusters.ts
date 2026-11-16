// Controls that are one physical thing but several inputs (a stick is two
// axes, a click and a touch sensor). The drawing shows one hotspot per
// cluster and the inspector offers its members as tabs.

import type { Mapping } from '../core/mapping'

export interface Cluster {
  id: string
  label: string
  members: { id: string; label: string }[]
}

const stick = (side: 'l' | 'r', name: string): Cluster => ({
  id: `${side}stick`,
  label: `${name} stick`,
  members: [
    { id: `${side}stick_x`, label: 'X' },
    { id: `${side}stick_y`, label: 'Y' },
    { id: `${side}3`, label: 'Click' },
    { id: `${side}stick_touch`, label: 'Touch' },
  ],
})

const pad = (side: 'l' | 'r', name: string): Cluster => ({
  id: `${side}pad`,
  label: `${name} trackpad`,
  members: [
    { id: `${side}pad_x`, label: 'X' },
    { id: `${side}pad_y`, label: 'Y' },
    { id: `${side}pad_pressure`, label: 'Pressure' },
    { id: `${side}pad_click`, label: 'Click' },
    { id: `${side}pad_touch`, label: 'Touch' },
  ],
})

const trigger = (side: 'l' | 'r', name: string): Cluster => ({
  id: `${side}t`,
  label: `${name} trigger`,
  members: [
    { id: `${side}t`, label: 'Pull' },
    { id: `${side}t_click`, label: 'Full pull' },
  ],
})

export const CLUSTERS: Cluster[] = [
  stick('l', 'Left'),
  stick('r', 'Right'),
  pad('l', 'Left'),
  pad('r', 'Right'),
  trigger('l', 'Left'),
  trigger('r', 'Right'),
]

export const CLUSTER_BY_ID: Record<string, Cluster> = Object.fromEntries(CLUSTERS.map((c) => [c.id, c]))

export const CLUSTER_OF: Record<string, Cluster> = Object.fromEntries(
  CLUSTERS.flatMap((c) => c.members.map((m) => [m.id, c])),
)

/** What a mapping occupies in the DAW: two mappings with the same key fight over it. */
export function destinationKey(m: Mapping): string {
  if (m.type === 'note') return `note:${m.channel}:${m.note}`
  if (m.type === 'cc') return `cc:${m.channel}:${m.cc}`
  return `bend:${m.channel}`
}

/** For every enabled mapping that shares a destination with another enabled one: the others. */
export function findConflicts(mappings: Mapping[]): Map<string, Mapping[]> {
  const byKey = new Map<string, Mapping[]>()
  for (const m of mappings) {
    if (!m.enabled) continue
    const k = destinationKey(m)
    const list = byKey.get(k)
    if (list) list.push(m)
    else byKey.set(k, [m])
  }
  const out = new Map<string, Mapping[]>()
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    for (const m of list) out.set(m.id, list.filter((o) => o !== m))
  }
  return out
}

export function mappedInputs(mappings: Mapping[]): Set<string> {
  const s = new Set<string>()
  for (const m of mappings) if (m.enabled) s.add(m.input)
  return s
}
