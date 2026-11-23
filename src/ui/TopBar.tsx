import { useEffect, useRef, useState } from 'react'
import { FACTORY_PRESETS, sanitizePreset } from '../core/mapping'
import { NativeRuntime } from '../nativeRuntime'
import { runtime } from '../runtime'
import { activeMappings, useApp } from '../store'
import { Icon } from './controls'
import { useSendingId } from './send'

const TRANSPORT = { usb: 'USB', bluetooth: 'Bluetooth', puck: 'Wireless puck', '': '' } as const

function Battery({ level, charging }: { level: number; charging: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(level)))
  return (
    <span className="battery" title={charging ? `Battery ${pct}%, charging` : `Battery ${pct}%`}>
      <svg viewBox="0 0 22 12" width="20" height="11" aria-hidden="true">
        <rect x="0.75" y="0.75" width="18" height="10.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <rect x="20" y="3.5" width="1.6" height="5" rx="0.8" fill="currentColor" />
        <rect x="2.5" y="2.5" width={(14.5 * pct) / 100} height="7" rx="1.2" className={pct <= 15 ? 'battery-low' : 'battery-fill'} />
      </svg>
      <span className="mono">{pct}%</span>
    </span>
  )
}

function ConnectionChip() {
  const hid = useApp((s) => s.hid)
  const gamepad = useApp((s) => s.gamepad)
  // Inside the app / plugin the controller is found automatically.
  const native = useApp((s) => s.host !== 'web')

  if (hid.phase === 'connected') {
    return (
      <div className="chip chip-live">
        <span className="dot dot-ok" />
        <span className="chip-name" title={hid.deviceName}>{hid.deviceName || 'Steam Controller'}</span>
        {hid.transport && <span className="chip-meta">{TRANSPORT[hid.transport]}</span>}
        {hid.battery !== null && <Battery level={hid.battery} charging={hid.charging} />}
        {!native && (
          <button type="button" className="icon-btn" aria-label="Disconnect controller" title="Disconnect controller" onClick={() => void runtime.disconnect()}>
            {Icon.close}
          </button>
        )}
      </div>
    )
  }
  if (native && hid.phase === 'disconnected') {
    return (
      <div className="chip" title="Plug in the controller or its wireless puck. It connects by itself.">
        <span className="dot dot-wait" />
        <span className="chip-name">Looking for a controller…</span>
      </div>
    )
  }
  if (hid.phase === 'connecting' || hid.phase === 'waiting') {
    return (
      <div className="chip" title={native ? 'The controller is plugged in but not sending yet. Press a button to wake it.' : undefined}>
        <span className="dot dot-wait" />
        <span className="chip-name">{native ? 'Controller found, waiting for input…' : 'Waiting for controller…'}</span>
        {hid.phase === 'waiting' && !native && (
          <button type="button" className="icon-btn" aria-label="Cancel and disconnect" title="Cancel and disconnect" onClick={() => void runtime.disconnect()}>
            {Icon.close}
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="conn">
      {hid.supported ? (
        <button type="button" className="btn btn-primary" onClick={() => void runtime.connect()}>
          Connect controller
        </button>
      ) : (
        <div className="chip chip-warn">
          <span className="dot dot-warn" />
          <span className="chip-name">Needs Chrome or Edge on desktop</span>
        </div>
      )}
      {gamepad.connected && (
        <div className="chip" title="Connected through the browser's basic gamepad support">
          <span className="dot dot-warn" />
          <span className="chip-name">Limited mode: {gamepad.name}</span>
        </div>
      )}
    </div>
  )
}

function MidiOut({ onSetup }: { onSetup(): void }) {
  const midi = useApp((s) => s.midi)
  const setMidiOut = useApp((s) => s.setMidiOut)

  const host = useApp((s) => s.host)

  let body
  if (host !== 'web' && host !== 'standalone') {
    body = <span className="midi-note" title="MIDI leaves through the plugin's output, into the host">To the host, on this track</span>
  } else if (!midi.supported) {
    body = <span className="midi-note">Web MIDI is not available in this browser</span>
  } else if (midi.phase === 'denied') {
    body = (
      <>
        <span className="midi-note midi-bad">MIDI access blocked</span>
        <button type="button" className="btn btn-small" onClick={() => void runtime.initMidi()}>Retry</button>
      </>
    )
  } else if (midi.phase !== 'ready') {
    body = <span className="midi-note">Waiting for MIDI permission…</span>
  } else if (midi.outputs.length === 0) {
    body = (
      <button type="button" className="link" onClick={onSetup}>
        No MIDI ports found. Set one up
      </button>
    )
  } else {
    const missing = midi.selectedId !== null && !midi.outputs.some((o) => o.id === midi.selectedId)
    body = (
      <select
        className="select"
        aria-label="MIDI output"
        value={midi.selectedId ?? ''}
        onChange={(e) => setMidiOut(e.currentTarget.value || null)}
      >
        <option value="">No output</option>
        {missing && <option value={midi.selectedId ?? ''}>Saved port (not connected)</option>}
        {midi.outputs.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    )
  }
  return (
    <div className="midi-out">
      <span className="bar-label">MIDI out</span>
      {body}
    </div>
  )
}

type MenuMode = null | 'rename' | 'delete' | 'reset'

function PresetMenu() {
  const presets = useApp((s) => s.presets)
  const active = useApp((s) => s.active)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<MenuMode>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const current = presets[active]

  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const toggle = () => {
    setOpen(!open)
    setMode(null)
    setError('')
  }
  const app = useApp.getState

  const exportPreset = () => {
    const data = { app: 'steam-controller-midi', version: 1, name: current.name, mappings: activeMappings(app()) }
    if (runtime instanceof NativeRuntime) {
      const safe = current.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'preset'
      runtime.exportFile(`${safe}.json`, JSON.stringify(data, null, 2))
      setOpen(false)
      return
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${current.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'preset'}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setOpen(false)
  }

  const importText = (fileName: string, text: string) => {
    try {
      const preset = sanitizePreset(JSON.parse(text))
      if (!preset) throw new Error('not a preset')
      app().addPreset(preset)
      setError('')
      setOpen(false)
    } catch {
      setError(`"${fileName}" is not a Steam Controller MIDI preset file.`)
    }
  }
  const importPreset = async (f: File) => importText(f.name, await f.text())
  const chooseImport = () => {
    if (runtime instanceof NativeRuntime) runtime.importFile(importText)
    else file.current?.click()
  }

  const commitRename = () => {
    const n = name.trim().slice(0, 60)
    if (n) app().renamePreset(n)
    setMode(null)
  }

  return (
    <div className="menu-root" ref={root}>
      <button type="button" className="btn menu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <span className="bar-label">Preset</span>
        <span className="menu-trigger-name">{current.name}</span>
        {Icon.chevron}
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Presets">
          <div className="menu-list">
            {presets.map((p, i) => (
              <button
                key={i}
                type="button"
                role="menuitemradio"
                aria-checked={i === active}
                className="menu-item"
                onClick={() => {
                  app().selectPreset(i)
                  setOpen(false)
                }}
              >
                <span className="menu-check">{i === active && Icon.check}</span>
                <span className="menu-item-name">{p.name}</span>
                <span className="menu-item-meta">{p.mappings.length}</span>
              </button>
            ))}
          </div>
          <div className="menu-sep" />
          {mode === 'rename' ? (
            <form
              className="menu-form"
              onSubmit={(e) => {
                e.preventDefault()
                commitRename()
              }}
            >
              <input
                className="text-input"
                aria-label="Preset name"
                autoFocus
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="menu-form-actions">
                <button type="button" className="btn btn-small" onClick={() => setMode(null)}>Cancel</button>
                <button type="submit" className="btn btn-small btn-primary">Rename</button>
              </div>
            </form>
          ) : mode === 'delete' || mode === 'reset' ? (
            <div className="menu-form">
              <p className="menu-confirm">
                {mode === 'delete'
                  ? `Delete "${current.name}"? This cannot be undone.`
                  : `Reset "${current.name}" to the default mappings? Your changes to it will be lost.`}
              </p>
              <div className="menu-form-actions">
                <button type="button" className="btn btn-small" autoFocus onClick={() => setMode(null)}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  onClick={() => {
                    if (mode === 'delete') app().deletePreset()
                    else app().resetPreset()
                    setMode(null)
                    setOpen(false)
                  }}
                >
                  {mode === 'delete' ? 'Delete preset' : 'Reset preset'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" className="menu-item" onClick={() => { app().addPreset(); setOpen(false) }}>New empty preset</button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => { app().duplicatePreset(); setOpen(false) }}>Duplicate</button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => { setName(current.name); setMode('rename') }}>Rename…</button>
              <div className="menu-sep" />
              <div role="group" aria-labelledby="menu-templates">
                <span className="menu-label" id="menu-templates">New from template</span>
                {FACTORY_PRESETS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="menuitem"
                    className="menu-item menu-item-indent"
                    onClick={() => {
                      app().addPreset(f.make())
                      setOpen(false)
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
              <button type="button" role="menuitem" className="menu-item" onClick={exportPreset}>Export to file</button>
              <button type="button" role="menuitem" className="menu-item" onClick={chooseImport}>Import from file…</button>
              <div className="menu-sep" />
              <button type="button" role="menuitem" className="menu-item" onClick={() => setMode('reset')}>Reset to defaults…</button>
              <button type="button" role="menuitem" className="menu-item menu-item-danger" onClick={() => setMode('delete')}>Delete…</button>
            </>
          )}
          {error && <p className="menu-error" role="alert">{error}</p>}
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0]
              e.currentTarget.value = ''
              if (f) void importPreset(f)
            }}
          />
        </div>
      )}
    </div>
  )
}

export function TopBar({ onSetup, onSettings }: { onSetup(): void; onSettings(): void }) {
  const learn = useApp((s) => s.learn)
  const setLearn = useApp((s) => s.setLearn)
  return (
    <header className="topbar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <rect x="1" y="1" width="22" height="22" rx="6" className="brand-mark-bg" />
          <circle cx="9" cy="12" r="3.2" className="brand-mark-ring" />
          <path d="M15 8v8M18 10v4" className="brand-mark-bars" />
        </svg>
        <span className="brand-name">Steam Controller <b>MIDI</b></span>
      </div>
      <ConnectionChip />
      <div className="topbar-space" />
      <MidiOut onSetup={onSetup} />
      <PresetMenu />
      <div className="topbar-sep" />
      <button
        type="button"
        className="btn btn-learn"
        aria-pressed={learn}
        title="Pause controller output so you can map one control at a time in Live"
        onClick={() => setLearn(!learn)}
      >
        <span className="learn-led" />
        Learn
      </button>
      <button type="button" className="btn btn-panic" title="Stop all notes on every channel" onClick={() => runtime.panic()}>
        Panic
      </button>
      <button type="button" className="btn" onClick={onSettings}>Settings</button>
      <button type="button" className="btn" onClick={onSetup}>Setup</button>
    </header>
  )
}

/** Banner lines under the top bar: learn mode, solo, and connection warnings. */
export function Notices() {
  const learn = useApp((s) => s.learn)
  const hid = useApp((s) => s.hid)
  const gamepad = useApp((s) => s.gamepad)
  const solo = useApp((s) => s.solo)
  const setSolo = useApp((s) => s.setSolo)
  const sending = useSendingId()
  const setHid = useApp((s) => s.setHid)
  const limited = gamepad.connected && hid.phase !== 'connected'
  const mouseMode = hid.phase === 'connected' && hid.settingsOk === false
  if (!learn && !hid.error && !limited && !mouseMode && !solo) return null
  return (
    <div className="notices">
      {learn && (
        <div className="notice notice-learn" role="status">
          <span className="notice-tag">Learn mode</span>
          <span>
            Learn mode: controller output is paused. In Live press Cmd/Ctrl+M, click a parameter, then press Send on a mapping.
          </span>
          <button type="button" className="btn btn-small notice-action" onClick={() => useApp.getState().setLearn(false)}>
            Done
          </button>
        </div>
      )}
      {solo && (
        <div className="notice" role="status">
          <span className="notice-tag">Solo</span>
          <span>
            {solo === sending
              ? 'Sending for MIDI learn: every other mapping is silent for a moment.'
              : 'One mapping is soloed, so every other mapping is silent.'}
          </span>
          <button type="button" className="btn btn-small notice-action" onClick={() => setSolo(null)}>Clear solo</button>
        </div>
      )}
      {hid.error && (
        <div className="notice notice-error" role="alert">
          {Icon.warn}
          <span>{hid.error}</span>
          <button type="button" className="icon-btn notice-action" aria-label="Dismiss" onClick={() => setHid({ error: '' })}>
            {Icon.close}
          </button>
        </div>
      )}
      {mouseMode && (
        <div className="notice notice-warn" role="status">
          {Icon.warn}
          <span>The controller may still be acting as a mouse and keyboard. Quitting Steam usually fixes it.</span>
        </div>
      )}
      {limited && (
        <div className="notice" role="status">
          {Icon.warn}
          <span>
            Limited mode: only sticks, buttons and triggers work through the browser's basic gamepad support. Use Connect
            controller for trackpads, grips and motion.
          </span>
        </div>
      )}
    </div>
  )
}
