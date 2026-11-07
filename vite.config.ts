import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';
const uniPlugin = typeof uni === 'function' ? uni : (uni as unknown as { default: typeof uni }).default;

export default defineConfig({
  plugins: [uniPlugin()],
  ...(process.env.UNI_PLATFORM === 'h5' ? {
    build: {
      rollupOptions: {
        output: {
          // The existing host serves .js with a module-compatible JavaScript MIME type.
          assetFileNames: (asset: { name?: string }) => /(?:^|[/\\])pdf\.worker[^/\\]*\.mjs$/.test(asset.name ?? '')
            ? 'assets/[name]-[hash].js'
            : 'assets/[name]-[hash][extname]',
        },
      },
    },
  } : {}),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true } },
  },
});
