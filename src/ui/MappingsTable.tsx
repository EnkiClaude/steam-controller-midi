import { GROUPS, INPUTS, INPUT_BY_ID } from '../core/inputs'
import { describeMapping, type Mapping } from '../core/mapping'
import { runtime } from '../runtime'
import { activeMappings, useApp } from '../store'
import { findConflicts } from './clusters'
import { Icon, Switch } from './controls'

const ORDER = new Map(INPUTS.map((d, i) => [d.id, i]))

function Row({ m, conflict }: { m: Mapping; conflict: boolean }) {
  const def = INPUT_BY_ID[m.input]
  const selected = useApp((s) => s.selectedInput === m.input)
  const solo = useApp((s) => s.solo === m.id)
  const select = () => useApp.getState().selectInput(m.input)
  return (
    <tr className={m.enabled ? 'row' : 'row row-off'} aria-selected={selected} onClick={select}>
      <td className="cell-live">
        {def.kind === 'button' ? (
          <span className="led" data-live="btn" data-id={def.id} />
        ) : (
          <span className={`meter meter-mini ${def.polarity === 'bipolar' ? 'meter-bipolar' : ''}`}>
            <span className="meter-fill" data-live="meter" data-id={def.id} />
          </span>
        )}
      </td>
      <td className="cell-input">
        <button type="button" className="row-select" onClick={select}>{def.label}</button>
      </td>
      <td className="cell-dest mono">
        {describeMapping(m)}
        {solo && <span className="tag">Solo</span>}
        {conflict && (
          <span className="tag tag-warn" title="Another enabled mapping sends the same message">
            {Icon.warn} Shared
          </span>
        )}
      </td>
      <td className="cell-on">
        <Switch
          checked={m.enabled}
          label={`${def.label} mapping enabled`}
          onChange={(v) => useApp.getState().updateMapping(m.id, { enabled: v })}
        />
      </td>
      <td className="cell-send">
        <button
          type="button"
          className="btn btn-small"
          title="Send this mapping's message once, for MIDI learn in Live"
          aria-label={`Send ${describeMapping(m)} for ${def.label}`}
          onClick={(e) => {
            e.stopPropagation()
            runtime.sendLearn(m)
          }}
        >
          Send
        </button>
      </td>
    </tr>
  )
}

export function MappingsTable() {
  const mappings = useApp(activeMappings)
  const conflicts = findConflicts(mappings)
  if (mappings.length === 0) {
    return (
      <div className="table-wrap">
        <p className="empty">
          This preset has no mappings yet. Open the Controller tab, click a control, then choose Add mapping.
        </p>
      </div>
    )
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="cell-live"><span className="sr-only">Live</span></th>
            <th>Input</th>
            <th>Sends</th>
            <th className="cell-on">On</th>
            <th className="cell-send"><span className="sr-only">Send</span></th>
          </tr>
        </thead>
        {GROUPS.map((g) => {
          const rows = mappings
            .filter((m) => INPUT_BY_ID[m.input]?.group === g.id)
            .sort((a, b) => (ORDER.get(a.input) ?? 0) - (ORDER.get(b.input) ?? 0))
          if (rows.length === 0) return null
          return (
            <tbody key={g.id}>
              <tr className="group-row">
                <th colSpan={5} scope="rowgroup">
                  {g.label}
                  <span className="group-count">{rows.length}</span>
                </th>
              </tr>
              {rows.map((m) => (
                <Row key={m.id} m={m} conflict={conflicts.has(m.id)} />
              ))}
            </tbody>
          )
        })}
      </table>
    </div>
  )
}
