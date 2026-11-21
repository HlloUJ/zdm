import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const publicOrigin = env.VITE_PUBLIC_APP_ORIGIN ? new URL(env.VITE_PUBLIC_APP_ORIGIN) : null;
  const port = Number(env.ZDM_FRONTEND_PORT || 5273);
  return {
    plugins: [vue()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      allowedHosts: publicOrigin ? [publicOrigin.hostname] : [],
      hmr: publicOrigin ? { host: publicOrigin.hostname, clientPort: Number(publicOrigin.port || (publicOrigin.protocol === "https:" ? 443 : 80)) } : undefined,
      proxy: { '/api': { target: env.ZDM_API_PROXY_TARGET || 'http://127.0.0.1:' + (env.ZDM_BACKEND_PORT || 8280), changeOrigin: true } },
    },
  };
});
