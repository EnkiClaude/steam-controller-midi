// The live pipeline: controller (WebHID or Gamepad API) → engine → Web MIDI.
//
// Nothing here depends on React or on requestAnimationFrame/setInterval on
// the main thread: when Ableton has focus this tab is in the background and
// Chrome throttles those. HID `inputreport` events and Worker messages keep
// arriving, so those drive everything.

import { Engine, learnMessages, type MidiMessage } from './core/engine'
import { INPUT_BY_ID, emptyState, type ControllerState } from './core/inputs'
import type { Mapping } from './core/mapping'
import {
  FEATURE_REPORT_ID,
  MAINTENANCE_INTERVAL_MS,
  PID_BLE,
  PID_PUCK,
  PID_PUCK_2,
  VALVE_VID,
  buildSettingsReport,
  createContext,
  parseReport,
  recenter,
} from './core/triton'
import { activeMappings, useApp } from './store'

export interface MonitorEntry {
  seq: number
  time: number
  message: MidiMessage
  /** false when the message was produced but not sent (learn mode / no output) */
  sent: boolean
}

export interface RawReport {
  t: number
  id: number
  hex: string
}

const MONITOR_SIZE = 200
const CAPTURE_SIZE = 500

class Runtime {
  /** Live controller snapshot. Mutated in place; the UI reads it every frame. */
  readonly state: ControllerState = emptyState()
  /** Bumped whenever `state` changes. */
  stateVersion = 0

  readonly monitor: MonitorEntry[] = []
  monitorSeq = 0

  /** Diagnostics */
  readonly lastReports = new Map<number, RawReport>()
  readonly capture: RawReport[] = []
  reportCount = 0
  midiCount = 0

  private engine = new Engine()
  private ctx = createContext()
  private devices: HIDDevice[] = []
  private lastMaintenance = 0
  private lastStateReport = 0
  private midiAccess: MIDIAccess | null = null
  private output: MIDIOutput | null = null
  private worker: Worker | null = null
  private started = false
  /** inputs currently held by the on-screen simulator */
  private simulated = new Set<string>()

  start(): void {
    if (this.started) return
    this.started = true

    this.send(this.engine.setMappings(activeMappings(useApp.getState())))
    useApp.subscribe((s, prev) => {
      if (activeMappings(s) !== activeMappings(prev)) {
        this.send(this.engine.setMappings(activeMappings(s)))
      }
      if (s.learn !== prev.learn && s.learn) {
        // Entering learn mode: silence anything still sounding.
        this.send(this.engine.releaseAll(), true)
      }
      if (s.midi.selectedId !== prev.midi.selectedId) this.pickOutput()
    })

    this.startWorker()
    void this.initMidi()

    if ('hid' in navigator) {
      navigator.hid.addEventListener('disconnect', (e) => this.onHidDisconnect(e.device))
      navigator.hid.addEventListener('connect', () => void this.reconnect())
      void this.reconnect()
    }
    window.addEventListener('gamepadconnected', () => this.pollGamepad())
    window.addEventListener('gamepaddisconnected', () => this.pollGamepad())
    window.addEventListener('pagehide', () => this.panic())
  }

  // ---------------------------------------------------------------- pipeline

  private tick(): void {
    this.stateVersion++
    const { solo } = useApp.getState()
    this.send(this.engine.process(this.state, solo))
  }

  private send(messages: MidiMessage[], force = false): void {
    if (messages.length === 0) return
    const muted = useApp.getState().learn && !force
    const out = muted ? null : this.output
    const now = performance.now()
    for (const message of messages) {
      let sent = false
      if (out) {
        try {
          out.send(message)
          sent = true
          this.midiCount++
        } catch {
          // port vanished mid-send; the statechange handler will update the UI
        }
      }
      this.monitor.push({ seq: ++this.monitorSeq, time: now, message, sent })
    }
    if (this.monitor.length > MONITOR_SIZE) this.monitor.splice(0, this.monitor.length - MONITOR_SIZE)
  }

  /** Send a mapping's identifying messages (for the DAW's MIDI learn), even in learn mode. */
  sendLearn(m: Mapping): void {
    for (const step of learnMessages(m)) {
      if (step.delayMs === 0) this.send([step.message], true)
      else setTimeout(() => this.send([step.message], true), step.delayMs)
    }
  }

  /** All notes off on every channel, plus release whatever the engine holds. */
  panic(): void {
    const msgs = this.engine.releaseAll()
    for (let ch = 0; ch < 16; ch++) msgs.push([0xb0 | ch, 123, 0])
    this.send(msgs, true)
  }

  recenterMotion(): void {
    recenter(this.ctx)
  }

  // --------------------------------------------------------------- simulator

  /** Drive an input from the UI (works with or without a controller attached). */
  simulate(input: string, value: number | boolean): void {
    const def = INPUT_BY_ID[input]
    if (!def) return
    if (def.kind === 'button') {
      const on = value === true
      this.state.buttons[input] = on
      if (on) this.simulated.add(input)
      else this.simulated.delete(input)
    } else {
      this.state.axes[input] = Number(value)
      // Trackpad axes only count while the pad is touched.
      if (def.activeWhile) {
        this.state.buttons[def.activeWhile] = true
        this.simulated.add(def.activeWhile)
      }
    }
    this.tick()
  }

  /** End a simulated axis gesture (lifts the simulated finger off a trackpad). */
  simulateEnd(input: string): void {
    const def = INPUT_BY_ID[input]
    if (def?.kind === 'axis' && def.activeWhile) {
      this.state.buttons[def.activeWhile] = false
      this.simulated.delete(def.activeWhile)
      this.tick()
    }
  }

  // -------------------------------------------------------------------- MIDI

  async initMidi(): Promise<void> {
    const app = useApp.getState()
    if (!('requestMIDIAccess' in navigator)) return
    app.setMidi({ phase: 'requesting' })
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false })
      this.midiAccess.onstatechange = () => this.refreshOutputs()
      useApp.getState().setMidi({ phase: 'ready' })
      this.refreshOutputs()
    } catch {
      useApp.getState().setMidi({ phase: 'denied' })
    }
  }

  private refreshOutputs(): void {
    if (!this.midiAccess) return
    const outputs = [...this.midiAccess.outputs.values()]
      .filter((o) => o.state !== 'disconnected')
      .map((o) => ({ id: o.id, name: o.name ?? 'MIDI output' }))
    const app = useApp.getState()
    app.setMidi({ outputs })
    // First run, or the saved port is gone: use the first port so things work
    // without a visit to the menu.
    if (outputs.length > 0 && !outputs.some((o) => o.id === app.midi.selectedId)) app.setMidiOut(outputs[0].id)
    this.pickOutput()
  }

  private pickOutput(): void {
    const id = useApp.getState().midi.selectedId
    const next = (id && this.midiAccess?.outputs.get(id)) || null
    this.output = next && next.state !== 'disconnected' ? next : null
  }

  get hasOutput(): boolean {
    return this.output !== null
  }

  // --------------------------------------------------------------------- HID

  /** Must be called from a click: shows Chrome's device picker. */
  async connect(): Promise<void> {
    const app = useApp.getState()
    if (!('hid' in navigator)) return
    app.setHid({ phase: 'connecting', error: '' })
    try {
      const picked = await navigator.hid.requestDevice({ filters: [{ vendorId: VALVE_VID }] })
      if (picked.length === 0) {
        useApp.getState().setHid({ phase: this.devices.length ? useApp.getState().hid.phase : 'disconnected' })
        return
      }
      await this.open(picked)
    } catch (e) {
      useApp.getState().setHid({ phase: 'disconnected', error: errorText(e) })
    }
  }

  /** Re-open controllers the user has already granted (page load / replug). */
  private async reconnect(): Promise<void> {
    if (this.devices.length > 0) return
    try {
      const granted = (await navigator.hid.getDevices()).filter((d) => d.vendorId === VALVE_VID)
      if (granted.length > 0) await this.open(granted)
    } catch {
      // nothing granted yet
    }
  }

  private async open(devices: HIDDevice[]): Promise<void> {
    // One physical controller shows up as several HID interfaces and we can't
    // know up front which carries the state reports, so listen on all of them.
    const opened: HIDDevice[] = []
    let lastError = ''
    for (const d of devices) {
      if (this.devices.includes(d)) continue
      try {
        if (!d.opened) await d.open()
        d.addEventListener('inputreport', this.onReport)
        opened.push(d)
      } catch (e) {
        lastError = errorText(e)
      }
    }
    this.devices.push(...opened)
    if (this.devices.length === 0) {
      useApp.getState().setHid({
        phase: 'disconnected',
        error: lastError || 'Could not open the controller. Close Steam and try again.',
      })
      return
    }
    const first = this.devices[0]
    const pid = first.productId
    useApp.getState().setHid({
      phase: useApp.getState().hid.phase === 'connected' ? 'connected' : 'waiting',
      deviceName: first.productName || 'Steam Controller',
      transport: pid === PID_BLE ? 'bluetooth' : pid === PID_PUCK || pid === PID_PUCK_2 ? 'puck' : 'usb',
      error: '',
    })
    this.lastMaintenance = 0
    void this.maintain()
  }

  async disconnect(): Promise<void> {
    const devices = this.devices
    this.devices = []
    for (const d of devices) {
      d.removeEventListener('inputreport', this.onReport)
      try {
        await d.close()
      } catch {
        // already gone
      }
    }
    this.onAllGone()
  }

  private onHidDisconnect(device: HIDDevice): void {
    const i = this.devices.indexOf(device)
    if (i < 0) return
    device.removeEventListener('inputreport', this.onReport)
    this.devices.splice(i, 1)
    if (this.devices.length === 0) this.onAllGone()
  }

  private onAllGone(): void {
    this.ctx = createContext()
    Object.assign(this.state, emptyState())
    this.simulated.clear()
    this.stateVersion++
    this.send(this.engine.releaseAll(), true)
    useApp.getState().setHid({
      phase: 'disconnected',
      deviceName: '',
      transport: '',
      battery: null,
      charging: false,
      settingsOk: null,
    })
  }

  private onReport = (e: HIDInputReportEvent): void => {
    const now = performance.now()
    this.reportCount++
    this.record(now, e.reportId, e.data)

    let result
    try {
      result = parseReport(e.reportId, e.data, this.state, this.ctx)
    } catch {
      return
    }
    const app = useApp.getState()
    if (result.type === 'state') {
      this.lastStateReport = now
      if (app.hid.phase !== 'connected') app.setHid({ phase: 'connected' })
      for (const id of this.simulated) this.state.buttons[id] = true
      this.tick()
    } else if (result.type === 'battery') {
      if (app.hid.battery !== result.level || app.hid.charging !== result.charging) {
        app.setHid({ battery: result.level, charging: result.charging })
      }
    } else if (result.type === 'wireless' && !result.connected) {
      // Puck is plugged in but the controller is off.
      Object.assign(this.state, emptyState())
      this.stateVersion++
      this.send(this.engine.releaseAll(), true)
      app.setHid({ phase: 'waiting', battery: null })
    }
    if (now - this.lastMaintenance >= MAINTENANCE_INTERVAL_MS) void this.maintain()
  }

  private record(now: number, id: number, data: DataView): void {
    // Hex only for the first report of each id per 100 ms and for the capture
    // ring; cheap enough at 250 Hz.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    let hex = ''
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
    const entry = { t: Math.round(now), id, hex }
    this.lastReports.set(id, entry)
    this.capture.push(entry)
    if (this.capture.length > CAPTURE_SIZE) this.capture.splice(0, this.capture.length - CAPTURE_SIZE)
  }

  /**
   * Tell the controller to stop emulating a mouse/keyboard and to stream
   * motion data. It forgets after a few seconds, so this repeats.
   */
  private async maintain(): Promise<void> {
    if (this.devices.length === 0) return
    this.lastMaintenance = performance.now()
    const payload = buildSettingsReport(true)
    let ok = false
    for (const d of this.devices) {
      if (!d.opened) continue
      try {
        await d.sendFeatureReport(FEATURE_REPORT_ID, payload)
        ok = true
      } catch {
        // this interface doesn't take feature reports; try the next
      }
    }
    const app = useApp.getState()
    if (app.hid.settingsOk !== ok && this.devices.length > 0) app.setHid({ settingsOk: ok })
  }

  // ---------------------------------------------------- background heartbeat

  private startWorker(): void {
    // Worker timers aren't throttled in background tabs the way page timers are.
    try {
      const src = 'setInterval(() => postMessage(0), 16)'
      this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
      this.worker.onmessage = () => this.heartbeat()
    } catch {
      setInterval(() => this.heartbeat(), 16)
    }
  }

  private heartbeat(): void {
    const now = performance.now()
    if (this.devices.length > 0) {
      if (now - this.lastMaintenance >= MAINTENANCE_INTERVAL_MS) void this.maintain()
      // Reports stopped (controller asleep / out of range) → show it.
      const app = useApp.getState()
      if (app.hid.phase === 'connected' && now - this.lastStateReport > 1500) {
        app.setHid({ phase: 'waiting' })
        this.send(this.engine.releaseAll(), true)
      }
    } else {
      this.pollGamepad()
    }
  }

  // ---------------------------------------------------- Gamepad API fallback

  private gamepadIndex: number | null = null

  private pollGamepad(): void {
    if (this.devices.length > 0 || !navigator.getGamepads) return
    let pad: Gamepad | null = null
    try {
      const pads = navigator.getGamepads()
      pad = (this.gamepadIndex !== null && pads[this.gamepadIndex]) || pads.find((p) => p && p.connected) || null
    } catch {
      return
    }
    const app = useApp.getState()
    if (!pad) {
      if (app.gamepad.connected) {
        this.gamepadIndex = null
        app.setGamepad({ connected: false, name: '' })
        Object.assign(this.state, emptyState())
        this.stateVersion++
        this.send(this.engine.releaseAll(), true)
      }
      return
    }
    if (!app.gamepad.connected || this.gamepadIndex !== pad.index) {
      this.gamepadIndex = pad.index
      app.setGamepad({ connected: true, name: pad.id.replace(/\s*\(.*\)\s*$/, '') || 'Gamepad' })
    }
    if (pad.mapping !== 'standard') return

    const s = this.state
    const btn = (i: number) => pad.buttons[i]?.pressed === true
    const before = this.snapshot()
    const set = (id: string, v: boolean) => {
      s.buttons[id] = v || this.simulated.has(id)
    }
    set('a', btn(0))
    set('b', btn(1))
    set('x', btn(2))
    set('y', btn(3))
    set('lb', btn(4))
    set('rb', btn(5))
    set('view', btn(8))
    set('menu', btn(9))
    set('l3', btn(10))
    set('r3', btn(11))
    set('dpad_up', btn(12))
    set('dpad_down', btn(13))
    set('dpad_left', btn(14))
    set('dpad_right', btn(15))
    set('steam', btn(16))
    s.axes.lt = pad.buttons[6]?.value ?? 0
    s.axes.rt = pad.buttons[7]?.value ?? 0
    s.axes.lstick_x = pad.axes[0] ?? 0
    s.axes.lstick_y = -(pad.axes[1] ?? 0)
    s.axes.rstick_x = pad.axes[2] ?? 0
    s.axes.rstick_y = -(pad.axes[3] ?? 0)
    if (this.snapshot() !== before) this.tick()
  }

  private snapshot(): string {
    const s = this.state
    const a = s.axes
    let bits = ''
    for (const k of GAMEPAD_BUTTONS) bits += s.buttons[k] ? '1' : '0'
    return `${bits}|${a.lt}|${a.rt}|${a.lstick_x}|${a.lstick_y}|${a.rstick_x}|${a.rstick_y}`
  }

  /** Everything needed to debug a protocol problem remotely. */
  diagnostics(): string {
    const hid = useApp.getState().hid
    return JSON.stringify(
      {
        app: 'steam-controller-midi',
        userAgent: navigator.userAgent,
        hid,
        devices: this.devices.map((d) => ({
          productId: d.productId.toString(16),
          productName: d.productName,
          collections: d.collections.map((c) => ({
            usagePage: c.usagePage?.toString(16),
            usage: c.usage?.toString(16),
            input: c.inputReports?.map((r) => r.reportId),
            output: c.outputReports?.map((r) => r.reportId),
            feature: c.featureReports?.map((r) => r.reportId),
          })),
        })),
        reportCount: this.reportCount,
        reports: this.capture,
      },
      null,
      1,
    )
  }
}

const GAMEPAD_BUTTONS = [
  'a', 'b', 'x', 'y', 'lb', 'rb', 'view', 'menu', 'l3', 'r3',
  'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right', 'steam',
]

function errorText(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') {
    return 'The browser was not allowed to open the controller. If Steam is running, quit it and try again.'
  }
  return e instanceof Error ? e.message : String(e)
}

export const runtime = new Runtime()
