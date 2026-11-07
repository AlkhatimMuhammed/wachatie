// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { io: connect } = require('socket.io-client');
const { load } = require('../src/config');
const { ReceivedStore } = require('../src/storage');
const { TransferEngine } = require('../src/engine');
const { createServer } = require('../src/server');
const { silentLog, sampleImage, once } = require('./helpers');

class FakeWhatsApp extends EventEmitter {
  constructor() {
    super();
    this.state = 'open';
    this.sent = [];
  }

  get status() {
    return { state: this.state, user: '249111111111', pairingCode: null, retryIn: null };
  }

  async requestPairing(phone) {
    if (String(phone).replace(/\D/g, '').length < 8) throw new (require('../src/errors').UserError)('bad number');
    return 'ABCD1234';
  }

  async sendText(chat, text) {
    this.sent.push({ chat, text });
    return { chat, alt: [], id: `m${this.sent.length}`, fromMe: true, timestamp: 1 };
  }

  async deleteLocal(refs) {
    return { deleted: refs.length, failed: 0 };
  }
}

async function boot(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wachatie-'));
  const config = load({
    port: 0,
    dataDir: dir,
    receivedDir: path.join(dir, 'received'),
    metaDir: path.join(dir, 'meta'),
    chunkSize: 500,
    sendIntervalMs: 0,
    maxImageBytes: 200 * 1024,
    maxMediaBytes: 200 * 1024,
    ...overrides
  });
  const store = new ReceivedStore(config.receivedDir, config.metaDir);
  await store.init();
  const wa = new FakeWhatsApp();
  const engine = new TransferEngine({ transport: wa, store, config, log: silentLog });
  const app = createServer({ config, wa, engine, store, log: silentLog });
  const address = await app.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    engine.close();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { url, wa, engine, store, app, close, port: address.port };
}

function client(url, options = {}) {
  return connect(url, { transports: ['websocket'], forceNew: true, ...options });
}

const emitAck = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

test('serves the UI with security headers and blocks foreign hosts', async () => {
  const ctx = await boot();
  const res = await fetch(ctx.url + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), /Wachatie/);

  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: ctx.port, path: '/', headers: { host: 'evil.example' } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    });
  });
  assert.equal(status, 403);
  assert.equal((await fetch(ctx.url + '/files/missing.png')).status, 404);
  await ctx.close();
});

test('rejects socket connections from other origins', async () => {
  const ctx = await boot();
  const bad = client(ctx.url, { extraHeaders: { Origin: 'https://evil.example' } });
  const outcome = await new Promise((resolve) => {
    bad.on('connect', () => resolve('connected'));
    bad.on('connect_error', () => resolve('refused'));
  });
  bad.close();
  assert.equal(outcome, 'refused');

  const good = client(ctx.url, { extraHeaders: { Origin: `http://127.0.0.1:${ctx.port}` } });
  const hello = await once(good, 'hello');
  assert.equal(hello.status.state, 'open');
  assert.equal(hello.limits.chunkSize, 500);
  good.close();
  await ctx.close();
});

test('validates and starts a transfer, then reports progress', async () => {
  const ctx = await boot();
  const socket = client(ctx.url);
  await once(socket, 'hello');

  const badPhone = await emitAck(socket, 'send', { phone: '12', data: sampleImage(100) });
  assert.equal(badPhone.ok, false);
  const notImage = await emitAck(socket, 'send', { phone: '249912345678', data: Buffer.from('hello world') });
  assert.equal(notImage.ok, false);
  const slightlyBig = await emitAck(socket, 'send', { phone: '249912345678', data: sampleImage(210 * 1024) });
  assert.equal(slightlyBig.ok, false);
  const missing = await emitAck(socket, 'send', { phone: '249912345678' });
  assert.equal(missing.ok, false);

  const progress = once(socket, 'send:progress');
  const reply = await emitAck(socket, 'send', { phone: '+249 91 234 5678', name: 'a.jpg', data: sampleImage(1200) });
  assert.equal(reply.ok, true);
  assert.match(reply.id, /^[a-f0-9]{12}$/);
  const first = await progress;
  assert.equal(first.id, reply.id);
  assert.equal(ctx.wa.sent[0].chat, '249912345678@s.whatsapp.net');

  ctx.wa.state = 'connecting';
  const offline = await emitAck(socket, 'send', { phone: '249912345678', data: sampleImage(100) });
  assert.equal(offline.ok, false);
  socket.close();
  await ctx.close();
});

test('pairing returns the code or a readable error', async () => {
  const ctx = await boot();
  const socket = client(ctx.url);
  await once(socket, 'hello');
  assert.deepEqual(await emitAck(socket, 'pair', { phone: '249912345678' }), { ok: true, code: 'ABCD1234' });
  const bad = await emitAck(socket, 'pair', { phone: '1' });
  assert.equal(bad.ok, false);
  socket.close();
  await ctx.close();
});

test('received images are stored, listed, served and deletable', async () => {
  const ctx = await boot();
  const data = sampleImage(900);
  const item = await ctx.store.save({ id: 'abcdef123456', data, mime: 'image/jpeg', name: 'p.jpg', from: '+249111111111' });

  const socket = client(ctx.url);
  const hello = await once(socket, 'hello');
  assert.equal(hello.received.length, 1);
  assert.equal(hello.received[0].id, 'abcdef123456');

  const res = await fetch(ctx.url + item.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(data));
  assert.equal((await fetch(ctx.url + '/files/..%2Fmeta')).status >= 400, true);

  const removed = once(socket, 'received:removed');
  assert.deepEqual(await emitAck(socket, 'received:delete', { id: 'abcdef123456' }), { ok: true });
  assert.equal((await removed).id, 'abcdef123456');
  assert.equal((await ctx.store.list()).length, 0);
  assert.deepEqual(await emitAck(socket, 'received:delete', { id: '../../etc/passwd' }), { ok: false });
  socket.close();
  await ctx.close();
});

test('drops connections that send oversized payloads', async () => {
  const ctx = await boot();
  const socket = client(ctx.url);
  await once(socket, 'hello');
  const dropped = once(socket, 'disconnect');
  socket.emit('send', { phone: '249912345678', data: sampleImage(400 * 1024) }, () => {});
  await dropped;
  assert.equal(ctx.wa.sent.length, 0);
  socket.close();
  await ctx.close();
});
