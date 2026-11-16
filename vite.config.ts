import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so the build works from any folder (GitHub Pages, a USB stick…)
  base: './',
  plugins: [react()],
})
