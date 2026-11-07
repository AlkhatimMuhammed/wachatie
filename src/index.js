// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const { load } = require('./config');
const { createLogger } = require('./logger');
const { ReceivedStore } = require('./storage');
const { WhatsAppClient } = require('./whatsapp');
const { TransferEngine } = require('./engine');
const { createServer } = require('./server');

async function main() {
  const config = load();
  const log = createLogger(config.logLevel);

  const store = new ReceivedStore(config.receivedDir, config.metaDir);
  await store.init();

  const wa = new WhatsAppClient({ config, log: log.child({ module: 'whatsapp' }) });
  const engine = new TransferEngine({ transport: wa, store, config, log: log.child({ module: 'engine' }) });
  wa.on('message', (message) => engine.handle(message));

  engine.on('send:done', ({ id, cleaned }) => log.info({ id, cleaned }, 'Transfer delivered'));
  engine.on('send:failed', ({ id, reason }) => log.warn({ id, reason }, 'Transfer failed'));
  engine.on('receive:done', ({ id, item }) => log.info({ id, from: item.from }, 'File received'));
  engine.on('receive:failed', ({ id, reason }) => log.warn({ id, reason }, 'Incoming transfer failed'));

  const app = createServer({ config, wa, engine, store, log: log.child({ module: 'server' }) });
  const address = await app.listen();
  log.info(`Wachatie is running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${address.port}`);

  await wa.start();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'Shutting down');
    engine.close();
    await wa.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => log.error({ err: error }, 'Unhandled rejection'));
}

main().catch((error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${error.port} is already in use` : error);
  process.exit(1);
});
