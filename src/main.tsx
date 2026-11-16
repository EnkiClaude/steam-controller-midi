import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { runtime } from './runtime'
import { startLive } from './ui/live'

document.title = 'Steam Controller MIDI'
runtime.start()
startLive()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
