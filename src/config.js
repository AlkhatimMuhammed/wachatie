// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const path = require('node:path');

function readInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readList(name, clean) {
  return (process.env[name] || '')
    .split(',')
    .map((item) => clean(item.trim()))
    .filter(Boolean);
}

function load(overrides = {}) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const config = {
    host: process.env.HOST || '127.0.0.1',
    port: readInt('PORT', 3000, { max: 65535 }),
    allowedHosts: readList('ALLOWED_HOSTS', (value) => value.toLowerCase()),
    dataDir,
    authDir: path.join(dataDir, 'auth'),
    receivedDir: path.join(dataDir, 'received'),
    metaDir: path.join(dataDir, 'received-meta'),
    publicDir: path.join(__dirname, '..', 'public'),
    logLevel: process.env.LOG_LEVEL || 'info',
    baileysLogLevel: process.env.BAILEYS_LOG_LEVEL || 'silent',
    pairingPhone: (process.env.PAIRING_PHONE || '').replace(/\D/g, ''),
    allowedSenders: readList('ALLOWED_SENDERS', (value) => value.replace(/\D/g, '')),
    chunkSize: readInt('CHUNK_SIZE', 4000, { min: 500, max: 30000 }),
    sendIntervalMs: readInt('SEND_INTERVAL_MS', 200, { min: 0, max: 10000 }),
    maxImageBytes: readInt('MAX_IMAGE_BYTES', 2 * 1024 * 1024, { min: 10 * 1024, max: 16 * 1024 * 1024 }),
    maxMediaBytes: readInt('MAX_MEDIA_BYTES', 5 * 1024 * 1024, { min: 10 * 1024, max: 64 * 1024 * 1024 }),
    ackTimeoutMs: readInt('ACK_TIMEOUT_MS', 10 * 60 * 1000, { min: 1000 }),
    stallTimeoutMs: readInt('STALL_TIMEOUT_MS', 20000, { min: 100 }),
    maxResendRounds: readInt('MAX_RESEND_ROUNDS', 5, { max: 50 }),
    maxIncoming: readInt('MAX_INCOMING_TRANSFERS', 4, { max: 50 }),
    maxOutgoing: readInt('MAX_OUTGOING_TRANSFERS', 5, { max: 50 }),
    ...overrides
  };
  config.maxTransferBytes = Math.max(config.maxImageBytes, config.maxMediaBytes);
  return Object.freeze(config);
}

module.exports = { load };
