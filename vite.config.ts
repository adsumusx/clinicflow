import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      // A forma curta liga changeOrigin e troca o Host pela porta da API.
      // A checagem de origem passa a ver o formulário como outra origem.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: true,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
