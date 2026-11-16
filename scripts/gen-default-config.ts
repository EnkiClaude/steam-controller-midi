// Writes native/Resources/default-config.json: the default preset, in the same
// shape the interface sends to the native side. The app and plugin start with
// it before any settings have been saved. Run from the repository root.

import { mkdirSync, writeFileSync } from 'node:fs'
import { defaultPreset } from '../src/core/mapping'

mkdirSync('native/Resources', { recursive: true })
writeFileSync('native/Resources/default-config.json', JSON.stringify({ presets: [defaultPreset()], active: 0 }))
console.log('wrote native/Resources/default-config.json')
