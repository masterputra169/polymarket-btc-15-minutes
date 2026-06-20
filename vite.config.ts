import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';




export default defineConfig({
  plugins: [react(),],
  server: {
    host: '0.0.0.0',  // expose to local network (access from phone)
    port: 3010,
    proxy: {
      '/gamma-api': {
        target: 'https://gamma-api.polymarket.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gamma-api/, ''),
      },
      '/clob-api': {
        target: 'https://clob.polymarket.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/clob-api/, ''),
      },
      '/binance-api': {
        target: 'https://data-api.binance.vision',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/binance-api/, ''),
      },
      '/fapi-api': {
        target: 'https://fapi.binance.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fapi-api/, ''),
      },
      '/bybit-api': {
        target: 'https://api.bybit.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bybit-api/, ''),
      },
    },
  },
});