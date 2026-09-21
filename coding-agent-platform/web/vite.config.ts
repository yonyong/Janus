import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' 使构建产物可被 FastAPI 以静态文件直接托管（相对路径）。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist' },
  server: {
    host: true, // 监听 0.0.0.0，允许通过局域网 IP 访问
    proxy: { '/api': 'http://localhost:8000' },
  },
})
