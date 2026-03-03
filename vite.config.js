import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/four-color-theorem/',
  worker: {
    format: 'es'
  },
  plugins: [react()],
  server: {
    port: 8080
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern'
      }
    }
  }
})