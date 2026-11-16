import { useCallback, useEffect, useState } from 'react'
import { useApp } from './store'
import { ControllerView } from './ui/ControllerView'
import { Inspector } from './ui/Inspector'
import { MappingsTable } from './ui/MappingsTable'
import { Monitor } from './ui/Monitor'
import { SetupGuide } from './ui/SetupGuide'
import { Notices, TopBar } from './ui/TopBar'

const SETUP_SEEN_KEY = 'steam-controller-midi/setup-seen'

function setupSeen(): boolean {
  try {
    return localStorage.getItem(SETUP_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

type Tab = 'controller' | 'mappings'

export default function App() {
  const [tab, setTab] = useState<Tab>('controller')
  const [setupOpen, setSetupOpen] = useState(false)
  const needsPort = useApp((s) => s.midi.phase === 'ready' && s.midi.outputs.length === 0)
  const mappingCount = useApp((s) => s.presets[s.active].mappings.length)

  // First run with no MIDI port to send to: show how to make one.
  useEffect(() => {
    if (needsPort && !setupSeen()) setSetupOpen(true)
  }, [needsPort])

  const closeSetup = useCallback(() => {
    setSetupOpen(false)
    try {
      localStorage.setItem(SETUP_SEEN_KEY, '1')
    } catch {
      // storage blocked: the guide may open again next visit
    }
  }, [])

  return (
    <div className="app">
      <TopBar onSetup={() => setSetupOpen(true)} />
      <Notices />
      <main className="main">
        <section className="stage">
          <div className="tabs" role="tablist" aria-label="View">
            <button type="button" role="tab" id="tab-controller" aria-controls="view-panel" aria-selected={tab === 'controller'} className="tab" onClick={() => setTab('controller')}>
              Controller
            </button>
            <button type="button" role="tab" id="tab-mappings" aria-controls="view-panel" aria-selected={tab === 'mappings'} className="tab" onClick={() => setTab('mappings')}>
              All mappings
              <span className="tab-count mono">{mappingCount}</span>
            </button>
            <span className="tabs-space" />
            <span className="legend" aria-hidden="true">
              <span><i className="key key-mapped" /> Mapped</span>
              <span><i className="key key-live" /> Live</span>
              <span><i className="key key-selected" /> Selected</span>
            </span>
          </div>
          <div className="view" id="view-panel" role="tabpanel" aria-labelledby={tab === 'controller' ? 'tab-controller' : 'tab-mappings'}>
            {tab === 'controller' ? <ControllerView /> : <MappingsTable />}
          </div>
          <Monitor />
        </section>
        <Inspector />
      </main>
      {setupOpen && <SetupGuide onClose={closeSetup} />}
    </div>
  )
}
