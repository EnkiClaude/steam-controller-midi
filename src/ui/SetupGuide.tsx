import { useEffect, useRef, useState } from 'react'
import { runtime } from '../runtime'
import { Icon } from './controls'
import { onFrame } from './live'

function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('')
  const count = useRef<HTMLSpanElement>(null)
  const reports = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!open) return
    let next = 0
    return onFrame((now) => {
      if (now < next) return
      next = now + 200
      if (count.current) count.current.textContent = runtime.reportCount.toLocaleString()
      if (reports.current) {
        const lines = [...runtime.lastReports.values()]
          .sort((a, b) => a.id - b.id)
          .map((r) => `0x${r.id.toString(16).padStart(2, '0')}  ${r.hex.replace(/(..)/g, '$1 ').trim()}`)
        reports.current.textContent = lines.length ? lines.join('\n') : 'No reports received yet.'
      }
    })
  }, [open])

  const copy = async () => {
    const text = runtime.diagnostics()
    try {
      await navigator.clipboard.writeText(text)
      setCopied('ok')
    } catch {
      // Clipboard API refused (permissions / insecure context): fall back to a selection copy.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      ta.remove()
      setCopied(ok ? 'ok' : 'fail')
    }
    setTimeout(() => setCopied(''), 2500)
  }

  return (
    <div className="diag">
      <button type="button" className="response-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="caret">{Icon.chevron}</span>
        Diagnostics
      </button>
      {open && (
        <div className="diag-body">
          <p>
            If the controller isn't recognised or inputs look wrong, copy this and send it along with your report. It
            contains the browser version and the last raw data the controller sent, nothing else.
          </p>
          <div className="diag-row">
            <span className="field-label">Reports received</span>
            <span className="mono" ref={count}>0</span>
            <span className="monitor-space" />
            <button type="button" className="btn btn-small" onClick={() => void copy()}>
              {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Could not copy' : 'Copy diagnostics'}
            </button>
          </div>
          <pre className="diag-hex mono" ref={reports} tabIndex={0} aria-label="Latest raw report for each report id">No reports received yet.</pre>
        </div>
      )}
    </div>
  )
}

export function SetupGuide({ onClose }: { onClose(): void }) {
  const closeBtn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeBtn.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      // Keep focus inside the dialog.
      const items = panel.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      before?.focus?.()
    }
  }, [onClose])

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title" ref={panel}>
        <header className="dialog-head">
          <div>
            <span className="section-label">Setup</span>
            <h2 id="setup-title">Connect to Ableton Live</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close setup guide" ref={closeBtn} onClick={onClose}>
            {Icon.close}
          </button>
        </header>
        <div className="dialog-body">
          <ol className="steps">
            <li>
              <h3>Create a virtual MIDI port</h3>
              <p>
                <b>macOS:</b> open Audio MIDI Setup, choose Window → Show MIDI Studio, double-click IAC Driver and tick
                "Device is online".
              </p>
              <p>
                <b>Windows:</b> install loopMIDI and add a port.
              </p>
            </li>
            <li>
              <h3>Choose that port here</h3>
              <p>Pick it in the MIDI out menu at the top of this window.</p>
            </li>
            <li>
              <h3>Turn it on in Live</h3>
              <p>
                In Live open Settings → Link, Tempo &amp; MIDI. For that port's Input, enable Track and Remote. Then
                map controls with Cmd/Ctrl+M, using Learn mode here to send one control at a time.
              </p>
            </li>
          </ol>
          <div className="tips">
            <span className="section-label">Tips</span>
            <ul>
              <li>Quit Steam while you use this app. Steam's desktop layout turns the controller into a mouse and keyboard.</li>
              <li>Keep this browser window open. It can sit behind Live, but not minimised or closed.</li>
              <li>Wired USB or the wireless puck are the most reliable connections.</li>
            </ul>
          </div>
          <Diagnostics />
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}
