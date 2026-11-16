import { defineConfig } from 'vitest/config';
import baseConfig from '../../vite.config';

const backendOrigin = process.env['T010_BACKEND_ORIGIN'];
if (backendOrigin === undefined || new URL(backendOrigin).hostname !== '127.0.0.1') {
  throw new Error('T010_BACKEND_ORIGIN must point to the isolated local QA backend');
}

export default defineConfig({
  ...baseConfig,
  server: {
    ...baseConfig.server,
    proxy: {
      '/api': { target: backendOrigin },
      '/socket.io': { target: backendOrigin, ws: true },
    },
  },
});
