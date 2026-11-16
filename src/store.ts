// App state shared with React: presets and mappings (persisted), plus
// connection status pushed in by the runtime.

import { create } from 'zustand'
import {
  createMapping,
  defaultPreset,
  freeCc,
  newId,
  sanitizePreset,
  type Mapping,
  type Preset,
} from './core/mapping'

export type HidPhase = 'disconnected' | 'connecting' | 'waiting' | 'connected'

export interface HidStatus {
  /** browser has WebHID at all */
  supported: boolean
  /** disconnected → connecting → waiting (opened, no reports yet) → connected */
  phase: HidPhase
  deviceName: string
  transport: 'usb' | 'bluetooth' | 'puck' | ''
  battery: number | null
  charging: boolean
  /** did the controller accept the "stop emulating mouse/keyboard" command? null = not tried yet */
  settingsOk: boolean | null
  error: string
}

export interface MidiPort {
  id: string
  name: string
}

export interface MidiStatus {
  supported: boolean
  phase: 'idle' | 'requesting' | 'ready' | 'denied'
  outputs: MidiPort[]
  selectedId: string | null
}

export interface GamepadStatus {
  connected: boolean
  name: string
}

interface Persisted {
  presets: Preset[]
  active: number
  midiOutId: string | null
}

const STORAGE_KEY = 'steam-controller-midi/v1'

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const data = JSON.parse(raw) as Partial<Persisted>
      const presets = (Array.isArray(data.presets) ? data.presets : [])
        .map(sanitizePreset)
        .filter((p): p is Preset => p !== null)
      if (presets.length > 0) {
        const active = typeof data.active === 'number' ? Math.min(presets.length - 1, Math.max(0, data.active)) : 0
        return { presets, active, midiOutId: typeof data.midiOutId === 'string' ? data.midiOutId : null }
      }
    }
  } catch {
    // unreadable or blocked storage: start fresh
  }
  return { presets: [defaultPreset()], active: 0, midiOutId: null }
}

function save(s: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // storage unavailable (private window): the app still works for this session
  }
}

export interface AppState extends Persisted {
  selectedInput: string | null
  /** Learn mode: live controller output is muted so only "Send" buttons reach the DAW */
  learn: boolean
  /** mapping id that is the only one allowed to send, or null */
  solo: string | null
  hid: HidStatus
  midi: MidiStatus
  gamepad: GamepadStatus

  selectInput(id: string | null): void
  setLearn(on: boolean): void
  setSolo(id: string | null): void

  addMapping(input: string): void
  updateMapping(id: string, patch: Partial<Mapping>): void
  removeMapping(id: string): void

  selectPreset(index: number): void
  addPreset(preset?: Preset): void
  duplicatePreset(): void
  renamePreset(name: string): void
  deletePreset(): void
  resetPreset(): void

  setMidiOut(id: string | null): void
  setHid(patch: Partial<HidStatus>): void
  setMidi(patch: Partial<MidiStatus>): void
  setGamepad(patch: Partial<GamepadStatus>): void
}

const initial = load()

export const useApp = create<AppState>((set, get) => {
  const editMappings = (fn: (m: Mapping[]) => Mapping[]) => {
    const { presets, active } = get()
    set({ presets: presets.map((p, i) => (i === active ? { ...p, mappings: fn(p.mappings) } : p)) })
  }
  return {
    ...initial,
    selectedInput: null,
    learn: false,
    solo: null,
    hid: {
      supported: typeof navigator !== 'undefined' && 'hid' in navigator,
      phase: 'disconnected',
      deviceName: '',
      transport: '',
      battery: null,
      charging: false,
      settingsOk: null,
      error: '',
    },
    midi: {
      supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
      phase: 'idle',
      outputs: [],
      selectedId: initial.midiOutId,
    },
    gamepad: { connected: false, name: '' },

    selectInput: (id) => set({ selectedInput: id }),
    setLearn: (on) => set({ learn: on }),
    setSolo: (id) => set({ solo: id }),

    addMapping: (input) => {
      // Pick the first note / CC not already used in this preset so a new
      // mapping never collides with an existing one by default.
      const existing = get().presets[get().active].mappings
      const m = createMapping(input)
      const used = new Set(existing.filter((e) => e.type === m.type).map((e) => (m.type === 'note' ? e.note : e.cc)))
      for (let i = 0; i < 92; i++) {
        const n = m.type === 'note' ? 36 + i : freeCc(i)
        if (!used.has(n)) {
          if (m.type === 'note') m.note = n
          else m.cc = n
          break
        }
      }
      editMappings((ms) => [...ms, m])
    },
    updateMapping: (id, patch) => editMappings((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m))),
    removeMapping: (id) => {
      editMappings((ms) => ms.filter((m) => m.id !== id))
      if (get().solo === id) set({ solo: null })
    },

    selectPreset: (index) => {
      if (index >= 0 && index < get().presets.length) set({ active: index, solo: null })
    },
    addPreset: (preset) => {
      const presets = [...get().presets, preset ?? { name: 'New preset', mappings: [] }]
      set({ presets, active: presets.length - 1, solo: null })
    },
    duplicatePreset: () => {
      const { presets, active } = get()
      const src = presets[active]
      const copy: Preset = {
        name: `${src.name} copy`,
        mappings: src.mappings.map((m) => ({ ...m, id: newId() })),
      }
      set({ presets: [...presets, copy], active: presets.length, solo: null })
    },
    renamePreset: (name) => {
      const { presets, active } = get()
      set({ presets: presets.map((p, i) => (i === active ? { ...p, name } : p)) })
    },
    deletePreset: () => {
      const { presets, active } = get()
      const next = presets.filter((_, i) => i !== active)
      if (next.length === 0) next.push(defaultPreset())
      set({ presets: next, active: Math.min(active, next.length - 1), solo: null })
    },
    resetPreset: () => {
      const { presets, active } = get()
      set({
        presets: presets.map((p, i) => (i === active ? { ...defaultPreset(), name: p.name } : p)),
        solo: null,
      })
    },

    setMidiOut: (id) => set({ midiOutId: id, midi: { ...get().midi, selectedId: id } }),
    setHid: (patch) => set({ hid: { ...get().hid, ...patch } }),
    setMidi: (patch) => set({ midi: { ...get().midi, ...patch } }),
    setGamepad: (patch) => set({ gamepad: { ...get().gamepad, ...patch } }),
  }
})

useApp.subscribe((s, prev) => {
  if (s.presets !== prev.presets || s.active !== prev.active || s.midiOutId !== prev.midiOutId) {
    save({ presets: s.presets, active: s.active, midiOutId: s.midiOutId })
  }
})

export const activeMappings = (s: AppState): Mapping[] => s.presets[s.active].mappings
