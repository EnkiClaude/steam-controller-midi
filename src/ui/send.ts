// "Send" for MIDI learn: solo the mapping for a moment while its message goes
// out, so nothing else the controller is doing (a resting stick, motion) can
// reach the DAW's MIDI learn first. Afterwards the previous solo comes back,
// unless the user changed it in the meantime.

import { useSyncExternalStore } from 'react'
import type { Mapping } from '../core/mapping'
import { runtime } from '../runtime'
import { activeMappings, useApp } from '../store'

const SOLO_MS = 2000

let pending: { id: string; prev: string | null; timer: ReturnType<typeof setTimeout> } | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export function sendLearn(m: Mapping): void {
  const app = useApp.getState()
  let prev = app.solo
  if (pending) {
    clearTimeout(pending.timer)
    // Still auto-soloed from an earlier Send: what to restore is what came before that.
    if (app.solo === pending.id) prev = pending.prev
  }
  const id = m.id
  app.setSolo(id)
  runtime.sendLearn(m)
  pending = {
    id,
    prev,
    timer: setTimeout(() => {
      pending = null
      const s = useApp.getState()
      if (s.solo === id) {
        const keep = prev !== null && activeMappings(s).some((x) => x.id === prev)
        s.setSolo(keep ? prev : null)
      }
      notify()
    }, SOLO_MS),
  }
  notify()
}

/** Id of the mapping that is soloed only because Send was just pressed, or null. */
export function useSendingId(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pending?.id ?? null,
  )
}
