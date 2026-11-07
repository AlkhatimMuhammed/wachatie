// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { UserError, toUserMessage } = require('./errors');

const FORWARDED_EVENTS = [
  'send:progress',
  'send:done',
  'send:failed',
  'receive:progress',
  'receive:done',
  'receive:cleaned',
  'receive:failed'
];

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function createServer({ config, wa, engine, store, log }) {
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...config.allowedHosts]);
  const anyHost = allowedHosts.has('*');
  const hostAllowed = (header) => anyHost || allowedHosts.has(hostnameOf(header));
  const originAllowed = (origin, hostHeader) => {
    if (!origin) return true;
    try {
      return new URL(origin).host.toLowerCase() === String(hostHeader || '').toLowerCase();
    } catch {
      return false;
    }
  };

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host)) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(
    '/files',
    express.static(config.receivedDir, {
      index: false,
      dotfiles: 'deny',
      fallthrough: false,
      setHeaders(res) {
        res.setHeader('Cache-Control', 'private, max-age=3600');
      }
    })
  );
  app.use(express.static(config.publicDir, { index: 'index.html' }));
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, whatsapp: wa.status.state });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(error.status || 500).type('text/plain').send(error.status === 404 ? 'Not found' : 'Server error');
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: config.maxTransferBytes + 64 * 1024,
    allowRequest: (req, callback) => {
      callback(null, hostAllowed(req.headers.host) && originAllowed(req.headers.origin, req.headers.host));
    }
  });

  wa.on('status', (status) => io.emit('status', status));
  for (const name of FORWARDED_EVENTS) engine.on(name, (payload) => io.emit(name, payload));

  io.on('connection', (socket) => {
    const answer = (ack) => (typeof ack === 'function' ? ack : () => {});

    socket.on('pair', async (payload, ack) => {
      const reply = answer(ack);
      try {
        const code = await wa.requestPairing(payload?.phone);
        reply({ ok: true, code });
      } catch (error) {
        reply({ ok: false, error: toUserMessage(error, log) });
      }
    });

    socket.on('send', async (payload, ack) => {
      const reply = answer(ack);
      try {
        if (wa.status.state !== 'open') throw new UserError('WhatsApp is not connected yet');
        const digits = normalizePhone(payload?.phone);
        if (!digits) throw new UserError('Enter the recipient number with the country code, digits only');
        const data = toBuffer(payload?.data);
        if (!data || data.length === 0) throw new UserError('No file data was received');
        const result = await engine.send({
          chat: `${digits}@s.whatsapp.net`,
          to: digits,
          data,
          name: typeof payload?.name === 'string' ? payload.name : ''
        });
        reply({ ok: true, id: result.id, messages: result.messages });
      } catch (error) {
        reply({ ok: false, error: toUserMessage(error, log) });
      }
    });

    socket.on('received:delete', async (payload, ack) => {
      const reply = answer(ack);
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const removed = await store.remove(id);
        if (removed) io.emit('received:removed', { id });
        reply({ ok: removed });
      } catch (error) {
        reply({ ok: false, error: toUserMessage(error, log) });
      }
    });

    store
      .list()
      .catch((error) => {
        log.warn({ err: error }, 'Could not list received images');
        return [];
      })
      .then((received) => {
        socket.emit('hello', {
          status: wa.status,
          limits: {
            maxImageBytes: config.maxImageBytes,
            maxMediaBytes: config.maxMediaBytes,
            chunkSize: config.chunkSize
          },
          received,
          active: engine.snapshot()
        });
      });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
    });
  }

  async function close() {
    const closed = new Promise((resolve) => {
      io.close(() => resolve());
    });
    server.closeAllConnections();
    await closed;
  }

  return { app, server, io, listen, close };
}

module.exports = { createServer };
