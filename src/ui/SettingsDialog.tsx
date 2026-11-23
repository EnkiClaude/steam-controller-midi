import { useRef } from 'react'
import { ROOT_NAMES, SCALES, type ScaleId } from '../core/scales'
import { runtime } from '../runtime'
import { useApp } from '../store'
import { Field, FieldGroup, Icon, NumField, Slider, Switch } from './controls'
import { useModal } from './dialog'

const pct = (v: number) => `${Math.round(v * 100)}%`

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const closeBtn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useModal(panel, closeBtn, onClose)

  const preset = useApp((s) => s.presets[s.active])
  const settings = useApp((s) => s.settings)
  const host = useApp((s) => s.host)
  const hostTempo = useApp((s) => s.hostInfo.tempo)
  const hidConnected = useApp((s) => s.hid.phase === 'connected')
  const { setSettings, setPresetScale } = useApp.getState()
  const inPlugin = host === 'vst3' || host === 'au' || host === 'plugin'
  const scaleOn = preset.scale !== 'chromatic'

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={panel}>
        <header className="dialog-head">
          <div>
            <span className="section-label">Settings</span>
            <h2 id="settings-title">Scale, tempo and haptics</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close settings" ref={closeBtn} onClick={onClose}>
            {Icon.close}
          </button>
        </header>
        <div className="dialog-body">
          <section className="set-section" aria-labelledby="set-scale">
            <h3 id="set-scale" className="set-title">
              Scale <span className="set-scope">for “{preset.name}”</span>
            </h3>
            <div className="set-grid">
              <Field label="Key" wide>
                <span className="set-pair">
                  <select
                    className="select set-root"
                    aria-label="Root note"
                    value={preset.scaleRoot}
                    disabled={!scaleOn}
                    onChange={(e) => setPresetScale(Number(e.currentTarget.value), preset.scale)}
                  >
                    {ROOT_NAMES.map((n, i) => (
                      <option key={n} value={i}>{n}</option>
                    ))}
                  </select>
                  <select
                    className="select"
                    aria-label="Scale"
                    value={preset.scale}
                    onChange={(e) => setPresetScale(preset.scaleRoot, e.currentTarget.value as ScaleId)}
                  >
                    {SCALES.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </span>
              </Field>
            </div>
            <p className="set-help">
              Note mappings with Follow scale on move to the nearest note in the scale, and pad grids step through it.
              Each preset keeps its own scale.
            </p>
          </section>

          <section className="set-section" aria-labelledby="set-tempo">
            <h3 id="set-tempo" className="set-title">Tempo</h3>
            <div className="set-grid">
              {inPlugin ? (
                <FieldGroup label="Tempo" wide>
                  <span className="set-readout mono" role="status">
                    {hostTempo !== null ? `Follows Live: ${Math.round(hostTempo * 10) / 10} BPM` : 'Waiting for the host'}
                  </span>
                </FieldGroup>
              ) : (
                <Field label="Tempo" wide>
                  <span className="set-num">
                    <NumField label="Tempo in BPM" value={settings.tempo} min={20} max={300} suffix="BPM" onChange={(tempo) => setSettings({ tempo })} />
                  </span>
                </Field>
              )}
            </div>
            <p className="set-help">
              {inPlugin
                ? 'Note repeat runs in time with Live’s tempo.'
                : 'Used for note repeat. In the plugin, note repeat follows Live’s tempo instead.'}
            </p>
          </section>

          <section className="set-section" aria-labelledby="set-haptics">
            <h3 id="set-haptics" className="set-title">Haptics</h3>
            <div className="set-grid">
              <FieldGroup label="Tap on every note" wide>
                <Switch checked={settings.hapticNotes} onChange={(hapticNotes) => setSettings({ hapticNotes })} label="Tap on every note" />
              </FieldGroup>
              <FieldGroup label="Strength" wide>
                <span className="set-pair">
                  <Slider
                    label="Haptic strength"
                    value={settings.hapticStrength}
                    min={0.05}
                    max={1}
                    step={0.05}
                    format={pct}
                    onChange={(hapticStrength) => setSettings({ hapticStrength })}
                  />
                  <button type="button" className="btn btn-small" onClick={() => runtime.hapticTest()}>
                    Test
                  </button>
                </span>
              </FieldGroup>
              <Field label="Metronome" wide>
                <select
                  className="select"
                  value={inPlugin ? settings.metronome : 'off'}
                  disabled={!inPlugin}
                  aria-describedby="set-metro-help"
                  onChange={(e) => setSettings({ metronome: e.currentTarget.value as 'off' | 'beat' | 'bar' })}
                >
                  <option value="off">Off</option>
                  <option value="beat">Every beat</option>
                  <option value="bar">Every bar</option>
                </select>
              </Field>
            </div>
            <p className="set-help" id="set-metro-help">
              {inPlugin
                ? 'The metronome taps while Live is playing.'
                : 'The metronome needs Live’s transport, so it only works in the plugin.'}
              {!hidConnected && ' Connect the controller to feel the taps.'}
            </p>
          </section>
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}
