import { parseServerConfig } from '@/server/config';
import { startWorker } from './worker';

const logger = {
  info: (message: string) => console.log(`[worker] ${message}`),
  error: (message: string) => console.error(`[worker] ${message}`),
};

try {
  const worker = await startWorker({ config: parseServerConfig(process.env), logger });
  const shutdown = async () => {
    await worker.stop();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
