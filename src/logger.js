// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const pino = require('pino');

function createLogger(level = 'info') {
  const pretty = Boolean(process.stdout.isTTY) && level !== 'silent';
  const options = { level };
  if (pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
    };
  }
  return pino(options);
}

module.exports = { createLogger };
