import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: '0.0.0.0',
  },
  preview: {
    port: process.env.PORT ? (parseInt(process.env.PORT, 10) || 4173) : 4173,
    host: '0.0.0.0',
    allowedHosts: ['cargas-integrado.onrender.com', 'localhost', '127.0.0.1'],
  },
});
