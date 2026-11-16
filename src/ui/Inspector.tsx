import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { BUTTONS, GROUPS, INPUT_BY_ID, type AxisDef, type InputDef } from '../core/inputs'
import { describeMapping, noteName, type Mapping, type MappingType } from '../core/mapping'
import { runtime } from '../runtime'
import { activeMappings, useApp } from '../store'
import { CLUSTER_OF, findConflicts, mappedInputs } from './clusters'
import { Field, FieldGroup, Icon, NumField, Segmented, Slider, Switch } from './controls'

const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]))
const pct = (v: number) => `${Math.round(v * 100)}%`

function TestButton({ id }: { id: string }) {
  const held = useRef(false)
  const set = (on: boolean) => {
    if (held.current === on) return
    held.current = on
    runtime.simulate(id, on)
  }
  useEffect(() => () => set(false), [id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button
      type="button"
      className="btn test-btn"
      data-live="btn"
      data-id={id}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        set(true)
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) set(true)
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') set(false)
      }}
      onBlur={() => set(false)}
    >
      Hold to press
    </button>
  )
}

function TestSlider({ def }: { def: AxisDef }) {
  const ref = useRef<HTMLInputElement>(null)
  const bipolar = def.polarity === 'bipolar'
  const min = bipolar ? -1 : 0
  const active = useRef(false)

  const paint = (v: number) => {
    const el = ref.current
    if (!el) return
    const p = ((v - min) / (1 - min)) * 100
    const rest = bipolar ? 50 : 0
    el.style.setProperty('--lo', `${Math.min(p, rest)}%`)
    el.style.setProperty('--hi', `${Math.max(p, rest)}%`)
  }
  const drive = () => {
    const el = ref.current
    if (!el) return
    const v = Number(el.value)
    active.current = true
    paint(v)
    runtime.simulate(def.id, v)
  }
  const release = () => {
    if (!active.current) return
    active.current = false
    const el = ref.current
    if (el) el.value = '0'
    paint(0)
    runtime.simulate(def.id, 0)
    runtime.simulateEnd(def.id)
  }
  useEffect(() => release, [def.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      ref={ref}
      type="range"
      className="slider test-slider"
      aria-label={`Test ${def.label}`}
      min={min}
      max={1}
      step={0.01}
      defaultValue={0}
      style={{ '--lo': bipolar ? '50%' : '0%', '--hi': bipolar ? '50%' : '0%' } as CSSProperties}
      onInput={drive}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyUp={release}
      onBlur={release}
    />
  )
}

const BUTTON_TYPES: { value: MappingType; label: string }[] = [
  { value: 'note', label: 'Note' },
  { value: 'cc', label: 'CC' },
]
const AXIS_TYPES: { value: MappingType; label: string }[] = [
  { value: 'cc', label: 'CC' },
  { value: 'pitchbend', label: 'Pitch bend' },
  { value: 'note', label: 'Note' },
]

function curveText(v: number): string {
  if (Math.abs(v - 1) < 0.05) return 'Linear'
  return `${v.toFixed(1)} ${v > 1 ? 'fine' : 'fast'}`
}

function MappingCard({ m, def, index, others }: { m: Mapping; def: InputDef; index: number; others: Mapping[] | undefined }) {
  const update = useApp((s) => s.updateMapping)
  const solo = useApp((s) => s.solo === m.id)
  const [responseOpen, setResponseOpen] = useState(false)
  const set = (patch: Partial<Mapping>) => update(m.id, patch)
  const isAxis = def.kind === 'axis'
  const showRelease = isAxis && m.type !== 'note' && (Boolean((def as AxisDef).activeWhile) || m.gate !== null)
  const title = `Mapping ${index + 1}`

  return (
    <article className={m.enabled ? 'card' : 'card card-off'} aria-label={`${title}: ${describeMapping(m)}`}>
      <header className="card-head">
        <Switch checked={m.enabled} onChange={(v) => set({ enabled: v })} label={`${title} enabled`} />
        <span className="card-dest mono">{describeMapping(m)}</span>
        <span className="card-actions">
          <button
            type="button"
            className="btn btn-small"
            aria-pressed={solo}
            title="Solo: silence every other mapping"
            onClick={() => useApp.getState().setSolo(solo ? null : m.id)}
          >
            Solo
          </button>
          <button
            type="button"
            className="btn btn-small btn-send"
            title="Send this message once, for MIDI learn in Live"
            onClick={() => runtime.sendLearn(m)}
          >
            Send
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            aria-label={`Delete ${title.toLowerCase()}`}
            title="Delete mapping"
            onClick={() => useApp.getState().removeMapping(m.id)}
          >
            {Icon.trash}
          </button>
        </span>
      </header>

      {others && (
        <p className="card-warn" role="status">
          {Icon.warn}
          <span>
            {describeMapping(m)} is also sent by {others.map((o) => INPUT_BY_ID[o.input]?.label ?? o.input).join(', ')}.
            Live cannot tell them apart.
          </span>
        </p>
      )}

      <div className="card-body">
        <FieldGroup label="Type" wide>
          <Segmented label="Message type" value={m.type} options={isAxis ? AXIS_TYPES : BUTTON_TYPES} onChange={(type) => set({ type })} />
        </FieldGroup>

        <Field label="Channel">
          <NumField label="MIDI channel" value={m.channel} min={1} max={16} onChange={(channel) => set({ channel })} />
        </Field>

        {m.type === 'note' && (
          <>
            <Field label="Note">
              <NumField label="Note number" value={m.note} min={0} max={127} bigStep={12} suffix={noteName(m.note)} onChange={(note) => set({ note })} />
            </Field>
            <Field label="Velocity">
              <NumField label="Velocity" value={m.velocity} min={1} max={127} onChange={(velocity) => set({ velocity })} />
            </Field>
          </>
        )}

        {m.type === 'cc' && (
          <>
            <Field label="CC number">
              <NumField label="CC number" value={m.cc} min={0} max={127} onChange={(cc) => set({ cc })} />
            </Field>
            <Field label={isAxis ? 'Range low' : 'Off value'}>
              <NumField label={isAxis ? 'Output range low' : 'Value when released'} value={m.min} min={0} max={127} onChange={(min) => set({ min })} />
            </Field>
            <Field label={isAxis ? 'Range high' : 'On value'}>
              <NumField label={isAxis ? 'Output range high' : 'Value when pressed'} value={m.max} min={0} max={127} onChange={(max) => set({ max })} />
            </Field>
          </>
        )}

        {!isAxis && (
          <FieldGroup label="Behaviour" wide>
            <Segmented
              label="Button behaviour"
              value={m.toggle ? 'toggle' : 'momentary'}
              options={[
                { value: 'momentary', label: 'Momentary' },
                { value: 'toggle', label: 'Toggle' },
              ]}
              onChange={(v) => set({ toggle: v === 'toggle' })}
            />
          </FieldGroup>
        )}

        {isAxis && m.type === 'note' && (
          <Field label="Fires at" wide>
            <Slider label="Note threshold" value={m.threshold} min={0.02} max={0.98} step={0.01} format={pct} onChange={(threshold) => set({ threshold })} />
          </Field>
        )}
      </div>

      {isAxis && (
        <div className="response">
          <button type="button" className="response-toggle" aria-expanded={responseOpen} onClick={() => setResponseOpen(!responseOpen)}>
            <span className="caret">{Icon.chevron}</span>
            Response
            {!responseOpen && (
              <span className="response-summary">
                {[
                  m.invert && 'inverted',
                  m.deadzone > 0 && `deadzone ${pct(m.deadzone)}`,
                  Math.abs(m.curve - 1) >= 0.05 && `curve ${m.curve.toFixed(1)}`,
                  m.smooth > 0 && `smoothing ${pct(m.smooth)}`,
                  m.gate && `while ${INPUT_BY_ID[m.gate]?.short ?? m.gate}`,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'default'}
              </span>
            )}
          </button>
          {responseOpen && (
            <div className="card-body">
              <FieldGroup label="Invert" wide>
                <Switch checked={m.invert} onChange={(invert) => set({ invert })} label="Invert direction" />
              </FieldGroup>
              <Field label="Deadzone" wide>
                <Slider label="Deadzone" value={m.deadzone} min={0} max={0.9} step={0.01} format={pct} onChange={(deadzone) => set({ deadzone })} />
              </Field>
              <Field label="Curve" wide>
                <Slider label="Response curve" value={m.curve} min={0.2} max={5} step={0.1} format={curveText} onChange={(curve) => set({ curve })} />
              </Field>
              <Field label="Smoothing" wide>
                <Slider label="Smoothing" value={m.smooth} min={0} max={0.95} step={0.01} format={pct} onChange={(smooth) => set({ smooth })} />
              </Field>
              <Field label="Only while held" wide>
                <select className="select" value={m.gate ?? ''} onChange={(e) => set({ gate: e.currentTarget.value || null })}>
                  <option value="">Always active</option>
                  {GROUPS.map((g) => {
                    const list = BUTTONS.filter((b) => b.group === g.id)
                    if (list.length === 0) return null
                    return (
                      <optgroup key={g.id} label={g.label}>
                        {list.map((b) => (
                          <option key={b.id} value={b.id}>{b.label}</option>
                        ))}
                      </optgroup>
                    )
                  })}
                </select>
              </Field>
              {showRelease && (
                <FieldGroup label="On release" wide>
                  <Segmented
                    label="On release"
                    value={m.release}
                    options={[
                      { value: 'hold', label: 'Hold value' },
                      { value: 'reset', label: 'Return to rest' },
                    ]}
                    onChange={(release) => set({ release })}
                  />
                </FieldGroup>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

export function Inspector() {
  const selected = useApp((s) => s.selectedInput)
  const mappings = useApp(activeMappings)
  const limited = useApp((s) => s.gamepad.connected && s.hid.phase !== 'connected')
  const conflicts = useMemo(() => findConflicts(mappings), [mappings])
  const mapped = useMemo(() => mappedInputs(mappings), [mappings])
  const def = selected ? INPUT_BY_ID[selected] : undefined

  if (!def) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <div className="inspector-empty">
          <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
            <circle cx="24" cy="24" r="15" className="hint-ring" />
            <circle cx="24" cy="24" r="5" className="hint-dot" />
          </svg>
          <h2>Click any control</h2>
          <p>Pick a button, stick, trackpad or motion tile to see what it sends to Live and change it.</p>
          <p className="hint-legend">
            <span><i className="key key-mapped" /> Mapped</span>
            <span><i className="key key-live" /> Live</span>
            <span><i className="key key-selected" /> Selected</span>
          </p>
        </div>
      </aside>
    )
  }

  const cluster = CLUSTER_OF[def.id]
  const mine = mappings.filter((m) => m.input === def.id)

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div className="inspector-title">
          <span className="section-label">{cluster ? cluster.label : GROUP_LABEL[def.group]}</span>
          <h2>{def.label}</h2>
        </div>
        <button type="button" className="icon-btn" aria-label="Close inspector" title="Deselect" onClick={() => useApp.getState().selectInput(null)}>
          {Icon.close}
        </button>
      </div>

      {cluster && (
        <div className="subtabs" role="tablist" aria-label={`${cluster.label} inputs`}>
          {cluster.members.map((mem) => (
            <button
              key={mem.id}
              type="button"
              role="tab"
              className="subtab"
              aria-selected={mem.id === def.id}
              data-mapped={mapped.has(mem.id) ? '' : undefined}
              onClick={() => useApp.getState().selectInput(mem.id)}
            >
              {mem.label}
              <i className="subtab-dot" />
            </button>
          ))}
        </div>
      )}

      <div className="inspector-scroll">
        <div className="live-box">
          <div className="live-row">
            <span className="field-label">Live</span>
            {def.kind === 'button' ? (
              <span className="led led-big" data-live="btn" data-id={def.id} />
            ) : (
              <span className={def.polarity === 'bipolar' ? 'meter meter-bipolar' : 'meter'}>
                <span className="meter-fill" data-live="meter" data-id={def.id} />
              </span>
            )}
            <span className="live-value mono" data-live="value" data-id={def.id}>{def.kind === 'button' ? 'Off' : '0.00'}</span>
          </div>
          <div className="live-row">
            <span className="field-label">Test</span>
            {def.kind === 'button' ? <TestButton key={def.id} id={def.id} /> : <TestSlider key={def.id} def={def} />}
          </div>
          <p className="live-help">
            {def.kind === 'button'
              ? 'Hold to press this input without the controller.'
              : 'Drag to move this input without the controller. It springs back when you let go.'}
          </p>
        </div>

        {def.hidOnly && limited && (
          <p className="callout" role="status">
            {Icon.warn}
            <span>
              This input is not available in limited mode. Use Connect controller to read trackpads, grips, touch and motion.
            </span>
          </p>
        )}

        <div className="cards-head">
          <span className="section-label">Mappings</span>
          <span className="cards-count mono">{mine.length}</span>
        </div>
        {mine.length === 0 && <p className="empty">Nothing is mapped to this input, so it sends no MIDI.</p>}
        {mine.map((m, i) => (
          <MappingCard key={m.id} m={m} def={def} index={i} others={conflicts.get(m.id)} />
        ))}
        <button type="button" className="btn add-btn" onClick={() => useApp.getState().addMapping(def.id)}>
          {Icon.plus} Add mapping
        </button>
      </div>
    </aside>
  )
}
