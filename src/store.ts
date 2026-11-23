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

/** Where the interface is running: a browser tab, or inside the native app / plugin. */
export type HostFormat = 'web' | 'standalone' | 'vst3' | 'au' | 'plugin'

const inNative = typeof globalThis !== 'undefined' && (globalThis as { __JUCE__?: unknown }).__JUCE__ !== undefined

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

/** App-wide settings (not per preset). */
export interface Settings {
  /** beats per minute for note repeat when there's no host tempo (web app, standalone) */
  tempo: number
  /** a short haptic tap from the controller on every note */
  hapticNotes: boolean
  /** 0.05-1 */
  hapticStrength: number
  /** a tap on every beat or bar while the host is playing (plugin only) */
  metronome: 'off' | 'beat' | 'bar'
}

export const DEFAULT_SETTINGS: Settings = { tempo: 120, hapticNotes: false, hapticStrength: 0.5, metronome: 'off' }

export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d
  return {
    tempo: Math.round(num(r.tempo, 20, 300, DEFAULT_SETTINGS.tempo)),
    hapticNotes: r.hapticNotes === true,
    hapticStrength: num(r.hapticStrength, 0.05, 1, DEFAULT_SETTINGS.hapticStrength),
    metronome: r.metronome === 'beat' || r.metronome === 'bar' ? r.metronome : 'off',
  }
}

interface Persisted {
  presets: Preset[]
  active: number
  midiOutId: string | null
  settings: Settings
}

const STORAGE_KEY = 'steam-controller-midi/v1'

function load(): Persisted {
  // Inside the app / plugin the native side owns the settings and sends them over.
  if (inNative) return { presets: [defaultPreset()], active: 0, midiOutId: null, settings: { ...DEFAULT_SETTINGS } }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const data = JSON.parse(raw) as Partial<Persisted>
      const presets = (Array.isArray(data.presets) ? data.presets : [])
        .map(sanitizePreset)
        .filter((p): p is Preset => p !== null)
      if (presets.length > 0) {
        const active = typeof data.active === 'number' ? Math.min(presets.length - 1, Math.max(0, data.active)) : 0
        return {
          presets,
          active,
          midiOutId: typeof data.midiOutId === 'string' ? data.midiOutId : null,
          settings: sanitizeSettings(data.settings),
        }
      }
    }
  } catch {
    // unreadable or blocked storage: start fresh
  }
  return { presets: [defaultPreset()], active: 0, midiOutId: null, settings: { ...DEFAULT_SETTINGS } }
}

function save(s: Persisted): void {
  if (inNative) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // storage unavailable (private window): the app still works for this session
  }
}

export interface AppState extends Persisted {
  host: HostFormat
  selectedInput: string | null
  /** Learn mode: live controller output is muted so only "Send" buttons reach the DAW */
  learn: boolean
  /** mapping id that is the only one allowed to send, or null */
  solo: string | null
  hid: HidStatus
  midi: MidiStatus
  gamepad: GamepadStatus

  /** plugin only: the host's tempo (null when it doesn't say) and whether it is playing */
  hostInfo: { tempo: number | null; playing: boolean }
  setHostInfo(info: { tempo: number | null; playing: boolean }): void
  setHost(host: HostFormat): void
  /** Replace every preset at once (settings arriving from the native side). */
  replaceConfig(presets: Preset[], active: number, settings?: Settings): void
  setSettings(patch: Partial<Settings>): void
  /** scale mode for the active preset */
  setPresetScale(root: number, scale: Preset['scale']): void
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
    host: inNative ? 'plugin' : 'web',
    selectedInput: null,
    learn: false,
    solo: null,
    hid: {
      supported: inNative || (typeof navigator !== 'undefined' && 'hid' in navigator),
      phase: 'disconnected',
      deviceName: '',
      transport: '',
      battery: null,
      charging: false,
      settingsOk: null,
      error: '',
    },
    midi: {
      supported: inNative || (typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator),
      phase: 'idle',
      outputs: [],
      selectedId: initial.midiOutId,
    },
    gamepad: { connected: false, name: '' },

    hostInfo: { tempo: null, playing: false },
    setHostInfo: (info) => {
      const cur = get().hostInfo
      if (cur.tempo !== info.tempo || cur.playing !== info.playing) set({ hostInfo: info })
    },
    setHost: (host) => set({ host }),
    replaceConfig: (presets, active, settings) =>
      set(settings ? { presets, active, solo: null, settings } : { presets, active, solo: null }),
    setSettings: (patch) => set({ settings: sanitizeSettings({ ...get().settings, ...patch }) }),
    setPresetScale: (root, scale) => {
      const { presets, active } = get()
      set({ presets: presets.map((p, i) => (i === active ? { ...p, scaleRoot: root, scale } : p)) })
    },
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
      const presets: Preset[] = [
        ...get().presets,
        preset ?? { name: 'New preset', mappings: [], scaleRoot: 0, scale: 'chromatic' },
      ]
      set({ presets, active: presets.length - 1, solo: null })
    },
    duplicatePreset: () => {
      const { presets, active } = get()
      const src = presets[active]
      const copy: Preset = {
        ...src,
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
  if (
    s.presets !== prev.presets ||
    s.active !== prev.active ||
    s.midiOutId !== prev.midiOutId ||
    s.settings !== prev.settings
  ) {
    save({ presets: s.presets, active: s.active, midiOutId: s.midiOutId, settings: s.settings })
  }
})

export const activeMappings = (s: AppState): Mapping[] => s.presets[s.active].mappings
