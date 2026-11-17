// Button debounce. A press or release is passed on immediately (no added
// latency), then that button ignores further changes for a short window.
// Switch contacts can chatter for a few milliseconds as they close, and at
// 250 reports a second that chatter would otherwise come out as a doubled
// note. The window is far shorter than the fastest roll a finger can play.

import { BUTTONS, type ControllerState } from './inputs'

export const DEBOUNCE_MS = 20

export class Debouncer {
  private stable: Record<string, boolean> = {}
  private changedAt: Record<string, number> = {}

  /** Replace the raw button states in `state` with debounced ones. */
  apply(state: ControllerState, nowMs: number): void {
    for (const def of BUTTONS) {
      const id = def.id
      const raw = state.buttons[id] === true
      const stable = this.stable[id] === true
      if (raw !== stable && nowMs - (this.changedAt[id] ?? -Infinity) >= DEBOUNCE_MS) {
        this.stable[id] = raw
        this.changedAt[id] = nowMs
      } else {
        state.buttons[id] = stable
      }
    }
  }

  reset(): void {
    this.stable = {}
    this.changedAt = {}
  }
}
