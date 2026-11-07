// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const crypto = require('node:crypto');
const { TransferEngine } = require('../src/engine');
const { load } = require('../src/config');

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

function sampleImage(size = 20000) {
  const body = crypto.randomBytes(size);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), body]);
}

class MemoryStore {
  constructor() {
    this.items = [];
    this.fail = false;
  }

  async save({ id, data, mime, name, from }) {
    if (this.fail) throw new Error('disk full');
    const item = { id, name, mime, from, size: data.length, data };
    this.items.push(item);
    return item;
  }
}

class FakeNetwork {
  constructor(options = {}) {
    this.options = { drop: () => false, mutate: (text) => text, maxDelay: 5, ...options };
    this.counter = 0;
    this.chats = { a: new Set(), b: new Set() };
    this.log = [];
    this.engines = {};
  }

  transport(side) {
    const peer = side === 'a' ? 'b' : 'a';
    return {
      sendText: async (chat, text) => {
        this.counter += 1;
        const ownId = `${side}${this.counter}`;
        this.chats[side].add(ownId);
        this.log.push({ from: side, text });
        if (!this.options.drop({ from: side, text })) {
          const delivered = this.options.mutate(text, { from: side });
          const delay = Math.floor(Math.random() * this.options.maxDelay);
          setTimeout(() => {
            this.counter += 1;
            const peerId = `${peer}${this.counter}`;
            this.chats[peer].add(peerId);
            this.engines[peer].handle({
              chat: `${side}@peer`,
              sender: side === 'a' ? '249111111111' : '249222222222',
              text: delivered,
              ref: { side: peer, id: peerId }
            });
          }, delay);
        }
        return { side, id: ownId };
      },
      deleteLocal: async (refs) => {
        for (const ref of refs) this.chats[ref.side].delete(ref.id);
        return { deleted: refs.length, failed: 0 };
      }
    };
  }
}

function createPair(networkOptions = {}, configOverrides = {}) {
  const network = new FakeNetwork(networkOptions);
  const config = load({
    chunkSize: 500,
    sendIntervalMs: 0,
    stallTimeoutMs: 150,
    ackTimeoutMs: 4000,
    maxResendRounds: 5,
    maxImageBytes: 1024 * 1024,
    ...configOverrides
  });
  const stores = { a: new MemoryStore(), b: new MemoryStore() };
  const engines = {
    a: new TransferEngine({ transport: network.transport('a'), store: stores.a, config, log: silentLog }),
    b: new TransferEngine({ transport: network.transport('b'), store: stores.b, config, log: silentLog })
  };
  network.engines = engines;
  const close = () => {
    engines.a.close();
    engines.b.close();
  };
  return { network, engines, stores, config, close };
}

function once(emitter, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { createPair, sampleImage, once, settle, silentLog };
