// The runtime used inside the standalone app and the VST3 / AU plugin.
//
// There the controller is read and the MIDI is produced by native code, so
// that it keeps working with the window closed. This class has the same
// surface as the browser Runtime, but only relays: edits go down to the
// native side, and live state, the MIDI monitor and connection status come
// back up as events.

import type { MidiMessage } from './core/engine'
import { AXES, BUTTONS, INPUT_BY_ID, emptyState, type ControllerState } from './core/inputs'
import { asPlayed, sanitizePreset, type Mapping, type Preset } from './core/mapping'
import type { MonitorEntry, RawReport } from './runtime'
import { sanitizeSettings, useApp, type HostFormat, type Settings } from './store'

interface JuceBackend {
  addEventListener(id: string, fn: (payload: unknown) => void): unknown
  emitEvent(id: string, payload: unknown): void
}

const EVENT = 'sc'
const MONITOR_SIZE = 200

export const juceBackend: JuceBackend | undefined = (
  globalThis as { __JUCE__?: { backend?: JuceBackend } }
).__JUCE__?.backend

export const isNative = juceBackend !== undefined

export class NativeRuntime {
  readonly state: ControllerState = emptyState()
  stateVersion = 0
  readonly monitor: MonitorEntry[] = []
  monitorSeq = 0
  readonly lastReports = new Map<number, RawReport>()
  readonly capture: RawReport[] = []
  reportCount = 0
  midiCount = 0

  private backend = juceBackend as JuceBackend
  private started = false
  private outputOk = true
  private devices: unknown = []
  /** config JSON as the native side last had it, to avoid echoing it back */
  private syncedConfig = ''
  private syncedMidiOut: string | null = null
  private importCallback: ((name: string, text: string) => void) | null = null

  get hasOutput(): boolean {
    return this.outputOk
  }

  private post(cmd: string, extra: Record<string, unknown> = {}): void {
    this.backend.emitEvent(EVENT, { cmd, ...extra })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.backend.addEventListener(EVENT, (payload) => this.onEvent(payload as Record<string, unknown>))

    useApp.subscribe((s, prev) => {
      if (s.presets !== prev.presets || s.active !== prev.active || s.settings !== prev.settings) this.pushConfig()
      if (s.learn !== prev.learn || s.solo !== prev.solo) this.post('flags', { learn: s.learn, solo: s.solo ?? '' })
      if (s.midi.selectedId !== prev.midi.selectedId && s.midi.selectedId !== this.syncedMidiOut) {
        this.syncedMidiOut = s.midi.selectedId
        this.post('midiOut', { id: s.midi.selectedId ?? '' })
      }
    })

    this.post('hello')
    setInterval(() => this.post('diag'), 1000)
  }

  private pushConfig(): void {
    const { presets, active, settings } = useApp.getState()
    const json = JSON.stringify({ presets, active, settings })
    if (json === this.syncedConfig) return
    this.syncedConfig = json
    this.post('config', { json })
  }

  private onEvent(e: Record<string, unknown>): void {
    const app = useApp.getState()
    switch (e.type) {
      case 'init': {
        this.syncedConfig = typeof e.config === 'string' ? e.config : ''
        let presets: Preset[] = []
        let active = 0
        let settings: Settings | undefined
        try {
          const data = JSON.parse(this.syncedConfig) as { presets?: unknown[]; active?: unknown; settings?: unknown }
          if (data.settings !== undefined) settings = sanitizeSettings(data.settings)
          presets = (Array.isArray(data.presets) ? data.presets : [])
            .map(sanitizePreset)
            .filter((p): p is Preset => p !== null)
          if (typeof data.active === 'number') active = data.active
        } catch {
          // fall through to the defaults already in the store
        }
        app.setHost(e.format as HostFormat)
        if (presets.length > 0) {
          app.replaceConfig(presets, Math.min(presets.length - 1, Math.max(0, active)), settings)
          // Sanitising may have changed something; make sure both sides agree.
          this.pushConfig()
        } else {
          this.syncedConfig = ''
          this.pushConfig()
        }
        this.post('flags', { learn: app.learn, solo: app.solo ?? '' })
        break
      }
      case 'host':
        // The plugin's host tempo and transport, for display.
        app.setHostInfo({
          tempo: typeof e.tempo === 'number' && e.tempo > 0 ? e.tempo : null,
          playing: e.playing === true,
        })
        break
      case 'hid':
        app.setHid(e.hid as Parameters<typeof app.setHid>[0])
        break
      case 'midi': {
        this.outputOk = e.hasOutput === true
        const outputs = Array.isArray(e.outputs) ? (e.outputs as { id: string; name: string }[]) : []
        const selectedId = typeof e.selectedId === 'string' && e.selectedId ? e.selectedId : null
        this.syncedMidiOut = selectedId
        const cur = app.midi
        if (
          cur.phase !== 'ready' ||
          cur.selectedId !== selectedId ||
          JSON.stringify(cur.outputs) !== JSON.stringify(outputs)
        ) {
          app.setMidi({ phase: 'ready', outputs, selectedId })
        }
        break
      }
      case 'tick': {
        const mask = Number(e.buttons) >>> 0
        for (const b of BUTTONS) this.state.buttons[b.id] = (mask & b.mask) !== 0
        const axes = e.axes as number[]
        for (let i = 0; i < AXES.length; i++) this.state.axes[AXES[i].id] = axes[i] ?? 0
        this.stateVersion++
        const now = performance.now()
        for (const m of e.monitor as [number, number, number, boolean][]) {
          const message: MidiMessage = [m[0], m[1], m[2]]
          if (m[3]) this.midiCount++
          this.monitor.push({ seq: ++this.monitorSeq, time: now, message, sent: m[3] })
        }
        if (this.monitor.length > MONITOR_SIZE) this.monitor.splice(0, this.monitor.length - MONITOR_SIZE)
        break
      }
      case 'diag': {
        const d = e.data as { reportCount?: number; reports?: { id: number; hex: string }[]; devices?: unknown }
        this.reportCount = d.reportCount ?? 0
        this.devices = d.devices ?? []
        const now = Math.round(performance.now())
        for (const r of d.reports ?? []) this.lastReports.set(r.id, { t: now, id: r.id, hex: r.hex })
        break
      }
      case 'import':
        if (this.importCallback && typeof e.text === 'string') this.importCallback(String(e.name ?? 'file'), e.text)
        this.importCallback = null
        break
    }
  }

  // The native side finds the controller by itself; these exist for parity.
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async initMidi(): Promise<void> {}

  simulate(input: string, value: number | boolean): void {
    if (INPUT_BY_ID[input]) this.post('simulate', { input, value })
  }

  simulateEnd(input: string): void {
    if (INPUT_BY_ID[input]) this.post('simulateEnd', { input })
  }

  sendLearn(m: Mapping): void {
    const s = useApp.getState()
    this.post('sendLearn', { mapping: asPlayed(m, s.presets[s.active]) })
  }

  panic(): void {
    this.post('panic')
  }

  recenterMotion(): void {
    this.post('recenter')
  }

  hapticTest(): void {
    this.post('hapticTest')
  }

  /** Save a preset through a native file dialog (downloads don't work in a plugin window). */
  exportFile(name: string, text: string): void {
    this.post('exportFile', { name, text })
  }

  /** Pick a file through a native dialog; the callback gets its name and contents. */
  importFile(cb: (name: string, text: string) => void): void {
    this.importCallback = cb
    this.post('importFile')
  }

  diagnostics(): string {
    return JSON.stringify(
      {
        app: 'steam-controller-midi',
        host: useApp.getState().host,
        userAgent: navigator.userAgent,
        hid: useApp.getState().hid,
        devices: this.devices,
        reportCount: this.reportCount,
        reports: [...this.lastReports.values()],
      },
      null,
      1,
    )
  }
}
