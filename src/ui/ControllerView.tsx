import { createContext, useContext, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import { INPUT_BY_ID } from '../core/inputs'
import { runtime } from '../runtime'
import { activeMappings, useApp } from '../store'
import { CLUSTER_BY_ID, mappedInputs } from './clusters'

const Mapped = createContext<Set<string>>(new Set())

/** A selectable region of the drawing. `ids` are the inputs it stands for; clicking selects `ids[0]`. */
function Hot(props: { ids: string[]; label: string; className?: string; transform?: string; children: ReactNode }) {
  const { ids } = props
  const mapped = useContext(Mapped)
  const selected = useApp((s) => s.selectedInput !== null && ids.includes(s.selectedInput))
  const select = () => {
    const s = useApp.getState()
    // Keep the chosen sub-input when clicking a stick or pad that is already selected.
    if (s.selectedInput === null || !ids.includes(s.selectedInput)) s.selectInput(ids[0])
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      select()
    }
  }
  return (
    <g
      className={props.className ? `hs ${props.className}` : 'hs'}
      transform={props.transform}
      role="button"
      tabIndex={0}
      aria-label={props.label}
      aria-pressed={selected}
      data-selected={selected ? '' : undefined}
      data-mapped={ids.some((id) => mapped.has(id)) ? '' : undefined}
      onClick={select}
      onKeyDown={onKey}
    >
      <title>{props.label}</title>
      {props.children}
    </g>
  )
}

/** Simple button hotspot: the whole group lights while the button is down. */
function Btn(props: { id: string; className?: string; children: ReactNode }) {
  const def = INPUT_BY_ID[props.id]
  const mapped = useContext(Mapped)
  const selected = useApp((s) => s.selectedInput === props.id)
  const select = () => useApp.getState().selectInput(props.id)
  return (
    <g
      className={props.className ? `hs ${props.className}` : 'hs'}
      role="button"
      tabIndex={0}
      aria-label={def.label}
      aria-pressed={selected}
      data-selected={selected ? '' : undefined}
      data-mapped={mapped.has(props.id) ? '' : undefined}
      data-live="btn"
      data-id={props.id}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      }}
    >
      <title>{def.label}</title>
      {props.children}
    </g>
  )
}

const ids = (cluster: string) => CLUSTER_BY_ID[cluster].members.map((m) => m.id)

function Stick({ side, cx, cy }: { side: 'l' | 'r'; cx: number; cy: number }) {
  const c = CLUSTER_BY_ID[`${side}stick`]
  return (
    <Hot ids={ids(c.id)} label={c.label} className="stick" transform={`translate(${cx} ${cy})`}>
      <circle r="35" className="shape" />
      <circle r="35" className="stick-touch" data-live="btn" data-id={`${side}stick_touch`} />
      <circle r="27" className="stick-well" />
      <path d="M-27 0H27M0 -27V27" className="stick-cross" />
      <g data-live="xy" data-x={`${side}stick_x`} data-y={`${side}stick_y`} data-r="13">
        <circle r="15" className="stick-cap" data-live="btn" data-id={`${side}3`} />
        <circle r="8.5" className="stick-dimple" />
      </g>
    </Hot>
  )
}

function Pad({ side, cx, cy, tilt }: { side: 'l' | 'r'; cx: number; cy: number; tilt: number }) {
  const c = CLUSTER_BY_ID[`${side}pad`]
  return (
    <Hot ids={ids(c.id)} label={c.label} className="pad" transform={`translate(${cx} ${cy}) rotate(${tilt})`}>
      <rect x="-42" y="-42" width="84" height="84" rx="13" className="shape" />
      <rect x="-42" y="-42" width="84" height="84" rx="13" className="pad-click" data-live="btn" data-id={`${side}pad_click`} />
      <rect x="-42" y="-42" width="84" height="84" rx="13" className="pad-touch" data-live="btn" data-id={`${side}pad_touch`} />
      <path d="M-30 0H30M0 -30V30" className="stick-cross" />
      <g
        className="pad-finger"
        data-live="xy"
        data-x={`${side}pad_x`}
        data-y={`${side}pad_y`}
        data-r="33"
        data-touch={`${side}pad_touch`}
        data-p={`${side}pad_pressure`}
      >
        <circle r="7" className="pad-ring" />
        <circle r="4" className="pad-dot" />
      </g>
    </Hot>
  )
}

function Trigger({ side, x }: { side: 'l' | 'r'; x: number }) {
  const c = CLUSTER_BY_ID[`${side}t`]
  const clip = `trig-clip-${side}`
  return (
    <Hot ids={ids(c.id)} label={c.label} className="trigger">
      <clipPath id={clip}>
        <rect x={x} y="4" width="68" height="48" rx="9" />
      </clipPath>
      <rect x={x} y="4" width="68" height="48" rx="9" className="shape" />
      <g clipPath={`url(#${clip})`}>
        <rect x={x} y="4" width="68" height="48" className="trigger-fill" data-live="fill" data-id={`${side}t`} />
        <rect x={x} y="4" width="68" height="5" className="trigger-stop" data-live="btn" data-id={`${side}t_click`} />
      </g>
      <text x={x + 34} y="29">{side === 'l' ? 'L2' : 'R2'}</text>
    </Hot>
  )
}

const FACE: [string, number, number][] = [
  ['y', 0, -32],
  ['x', -32, 0],
  ['b', 32, 0],
  ['a', 0, 32],
]

// [id, rect x, y, w, h, arrow path] relative to the D-pad centre
const DPAD: [string, number, number, number, number, string][] = [
  ['dpad_up', -13, -42, 26, 28, 'M0 -34l6 9h-12z'],
  ['dpad_down', -13, 14, 26, 28, 'M0 34l6 -9h-12z'],
  ['dpad_left', -42, -13, 28, 26, 'M-34 0l9 -6v12z'],
  ['dpad_right', 14, -13, 28, 26, 'M34 0l-9 -6v12z'],
]

const BODY =
  'M180 64C120 64 84 84 70 130C56 190 40 270 36 330C30 392 56 430 96 430C136 430 160 404 186 382C198 371 210 366 228 366' +
  'L532 366C550 366 562 371 574 382C600 404 624 430 664 430C704 430 730 392 724 330C720 270 704 190 690 130C676 84 640 64 580 64Z'

function Drawing() {
  return (
    <svg className="pad-svg" viewBox="0 0 760 438" role="group" aria-label="Steam Controller. Select a control to edit its mappings.">
      {/* top edge: triggers and bumpers */}
      <Trigger side="l" x={104} />
      <Btn id="lb" className="bumper">
        <rect x="180" y="30" width="150" height="22" rx="8" className="shape" />
        <text x="255" y="41.5">L1</text>
      </Btn>
      <Btn id="rb" className="bumper">
        <rect x="430" y="30" width="150" height="22" rx="8" className="shape" />
        <text x="505" y="41.5">R1</text>
      </Btn>
      <Trigger side="r" x={588} />

      <path d={BODY} className="body" />
      <path d={BODY} className="body-edge" />

      {/* d-pad */}
      <g transform="translate(165 150)">
        <path d="M-15 -45h30v30h30v30h-30v30h-30v-30h-30v-30h30z" className="dpad-base" />
        {DPAD.map(([id, x, y, w, h, arrow]) => (
          <Btn key={id} id={id}>
            <rect x={x} y={y} width={w} height={h} rx="5" className="shape" />
            <path d={arrow} className="glyph-fill" />
          </Btn>
        ))}
      </g>

      {/* face buttons */}
      <g transform="translate(595 150)">
        {FACE.map(([id, x, y]) => (
          <Btn key={id} id={id}>
            <circle cx={x} cy={y} r="17" className="shape" />
            <text x={x} y={y + 0.5} className="face-letter">{id.toUpperCase()}</text>
          </Btn>
        ))}
      </g>

      {/* system buttons */}
      <Btn id="view">
        <circle cx="330" cy="118" r="11" className="shape" />
        <path d="M325.5 115.5h6v5h-6zM328.500 113.500h6v5" className="glyph" />
      </Btn>
      <Btn id="menu">
        <circle cx="430" cy="118" r="11" className="shape" />
        <path d="M425.5 114.500h9M425.5 118h9M425.5 121.500h9" className="glyph" />
      </Btn>
      <Btn id="steam">
        <circle cx="380" cy="146" r="16" className="shape" />
        <circle cx="383.500" cy="142.500" r="5" className="glyph" />
        <path d="M371 149.500l6.500 2.500" className="glyph" />
        <circle cx="376" cy="151.500" r="2.200" className="glyph-fill" />
      </Btn>
      <Btn id="qam">
        <rect x="364" y="180" width="32" height="16" rx="8" className="shape" />
        <path d="M373 188h.01M380 188h.01M387 188h.01" className="glyph glyph-dots" />
      </Btn>

      <Stick side="l" cx={276} cy={200} />
      <Stick side="r" cx={484} cy={200} />
      <Pad side="l" cx={290} cy={298} tilt={6} />
      <Pad side="r" cx={470} cy={298} tilt={-6} />

      {/* back of the handles */}
      <text x="112" y="252" className="caption">Back</text>
      <Btn id="l4" className="back">
        <rect x="88" y="264" width="62" height="26" rx="13" className="shape" />
        <text x="119" y="277.5">L4</text>
      </Btn>
      <Btn id="l5" className="back">
        <rect x="80" y="298" width="62" height="26" rx="13" className="shape" />
        <text x="111" y="311.500">L5</text>
      </Btn>
      <Btn id="lgrip_touch" className="back">
        <rect x="62" y="340" width="84" height="62" rx="26" className="shape" />
        <text x="104" y="371.500">Grip</text>
      </Btn>
      <text x="648" y="252" className="caption">Back</text>
      <Btn id="r4" className="back">
        <rect x="610" y="264" width="62" height="26" rx="13" className="shape" />
        <text x="641" y="277.5">R4</text>
      </Btn>
      <Btn id="r5" className="back">
        <rect x="618" y="298" width="62" height="26" rx="13" className="shape" />
        <text x="649" y="311.500">R5</text>
      </Btn>
      <Btn id="rgrip_touch" className="back">
        <rect x="614" y="340" width="84" height="62" rx="26" className="shape" />
        <text x="656" y="371.500">Grip</text>
      </Btn>
    </svg>
  )
}

function MotionTile({ id, name, children }: { id: string; name: string; children: ReactNode }) {
  const mapped = useContext(Mapped)
  const selected = useApp((s) => s.selectedInput === id)
  // Gated motion only sends while a button is held: say which, on the tile.
  const gates = useApp((s) =>
    [
      ...new Set(
        activeMappings(s)
          .filter((m) => m.input === id && m.enabled && m.gate)
          .map((m) => INPUT_BY_ID[m.gate as string]?.short ?? m.gate),
      ),
    ].join(', '),
  )
  return (
    <button
      type="button"
      className="tile"
      aria-label={gates ? `${INPUT_BY_ID[id].label}, only while ${gates} is held` : INPUT_BY_ID[id].label}
      title={gates ? `${INPUT_BY_ID[id].label}: only sends while ${gates} is held` : INPUT_BY_ID[id].label}
      aria-pressed={selected}
      data-mapped={mapped.has(id) ? '' : undefined}
      onClick={() => useApp.getState().selectInput(id)}
    >
      <span className="tile-vis" aria-hidden="true">{children}</span>
      <span className="tile-text">
        <span className="tile-name">{name}</span>
        <span className="tile-value mono" data-live="value" data-id={id}>+0.00</span>
      </span>
      {gates && <span className="tile-gate" aria-hidden="true">while {gates}</span>}
    </button>
  )
}

const Bar = ({ id }: { id: string }) => (
  <span className="meter meter-bipolar meter-mini">
    <span className="meter-fill" data-live="meter" data-id={id} />
  </span>
)

function Motion() {
  return (
    <div className="motion">
      <div className="motion-head">
        <span className="section-label">Motion</span>
        <button type="button" className="btn btn-small" title="Use the way you are holding the controller now as level" onClick={() => runtime.recenterMotion()}>
          Recenter
        </button>
      </div>
      <div className="tiles">
        <MotionTile id="tilt_pitch" name="Pitch">
          <svg viewBox="0 0 28 28" width="28" height="28">
            <circle cx="14" cy="14" r="12.5" className="dial" />
            <path d="M5 14h18" className="dial-hand" data-live="ty" data-id="tilt_pitch" data-amt="8" />
          </svg>
        </MotionTile>
        <MotionTile id="tilt_roll" name="Roll">
          <svg viewBox="0 0 28 28" width="28" height="28">
            <circle cx="14" cy="14" r="12.5" className="dial" />
            <path d="M4 14h20" className="dial-hand" data-live="rot" data-id="tilt_roll" data-amt="60" />
          </svg>
        </MotionTile>
        <MotionTile id="turn" name="Yaw">
          <svg viewBox="0 0 28 28" width="28" height="28">
            <circle cx="14" cy="14" r="12.5" className="dial" />
            <path d="M14 14V4" className="dial-hand" data-live="rot" data-id="turn" data-amt="120" />
            <circle cx="14" cy="14" r="1.6" className="dial-pin" />
          </svg>
        </MotionTile>
        <MotionTile id="gyro_x" name="Gyro X"><Bar id="gyro_x" /></MotionTile>
        <MotionTile id="gyro_y" name="Gyro Y"><Bar id="gyro_y" /></MotionTile>
        <MotionTile id="gyro_z" name="Gyro Z"><Bar id="gyro_z" /></MotionTile>
      </div>
    </div>
  )
}

export function ControllerView() {
  const mappings = useApp(activeMappings)
  const mapped = useMemo(() => mappedInputs(mappings), [mappings])
  return (
    <Mapped.Provider value={mapped}>
      <div className="controller">
        <div className="controller-art">
          <Drawing />
        </div>
        <Motion />
      </div>
    </Mapped.Provider>
  )
}
