import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' 使构建产物可被 FastAPI 以静态文件直接托管（相对路径）。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://localhost:8000' } },
})
