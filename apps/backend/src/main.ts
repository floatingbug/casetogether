import { createApp } from './app.js';
import { readBackendConfig } from './config.js';

const config = readBackendConfig();
const app = createApp({
  allowedOrigins: config.allowedOrigins,
  nodeEnv: config.nodeEnv,
});
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'backend_listening', port: config.port }));
});

function shutdown(): void {
  server.close((error) => {
    if (error !== undefined) {
      console.error(JSON.stringify({ event: 'backend_shutdown_failed' }));
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
