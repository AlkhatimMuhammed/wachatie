// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const protocol = require('./protocol');
const media = require('./media');
const { UserError } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const REASONS = {
  unsupported: 'Unsupported file format',
  too_large: 'The file is too large',
  corrupt: 'The received data failed verification',
  timeout: 'The recipient did not confirm in time',
  busy: 'The recipient is busy with other transfers',
  send_failed: 'The messages could not be sent',
  storage_error: 'The file could not be saved'
};

const describe = (reason) => REASONS[reason] || 'The transfer failed';

class TransferError extends UserError {
  constructor(reason) {
    super(describe(reason));
    this.reason = reason;
  }
}

class TransferEngine extends EventEmitter {
  #transport;
  #store;
  #config;
  #log;
  #maxBase64;
  #outgoing = new Map();
  #incoming = new Map();
  #closed = new Map();
  #queue = Promise.resolve();
  #sweeper;

  constructor({ transport, store, config, log }) {
    super();
    this.#transport = transport;
    this.#store = store;
    this.#config = config;
    this.#log = log;
    this.#maxBase64 = Math.ceil(config.maxTransferBytes / 3) * 4 + 8;
    const interval = Math.max(50, Math.floor(config.stallTimeoutMs / 4));
    this.#sweeper = setInterval(() => this.#sweep(), interval);
    this.#sweeper.unref();
  }

  async send({ chat, to, data, name }) {
    const mime = media.detect(data);
    if (!mime) throw new TransferError('unsupported');
    if (data.length > media.limitFor(mime, this.#config)) throw new TransferError('too_large');
    if (this.#outgoing.size >= this.#config.maxOutgoing) {
      throw new UserError('Too many transfers are in progress. Please wait for one to finish.');
    }

    const id = protocol.newTransferId();
    const base64 = data.toString('base64');
    const size = this.#config.chunkSize;
    const count = Math.ceil(base64.length / size);
    if (count > protocol.MAX_CHUNKS) throw new TransferError('too_large');

    const dataTexts = new Array(count);
    for (let index = 0; index < count; index += 1) {
      dataTexts[index] = protocol.encodeData(id, index, count, base64.slice(index * size, (index + 1) * size));
    }

    const meta = {
      name: media.safeName(name, mime),
      mime,
      size: data.length,
      hash: sha256(data),
      chunks: count
    };

    const record = {
      id,
      chat,
      to,
      name: meta.name,
      metaText: protocol.encodeMeta(id, meta),
      dataTexts,
      refs: [],
      state: 'sending',
      sent: 0,
      total: count + 1,
      resends: 0,
      timer: null
    };

    this.#outgoing.set(id, record);
    this.#enqueue(() => this.#transmit(record, [record.metaText, ...dataTexts], true));
    return { id, messages: record.total };
  }

  handle({ chat, sender, text, ref }) {
    const packet = protocol.decode(text);
    if (!packet) return false;
    const context = { chat, sender: sender ?? null, ref };
    switch (packet.type) {
      case 'M':
        this.#onMeta(packet, context);
        break;
      case 'D':
        this.#onData(packet, context);
        break;
      case 'A':
        this.#onAck(packet, context);
        break;
      case 'R':
        this.#onResend(packet, context);
        break;
      case 'X':
        this.#onAbort(packet, context);
        break;
      default:
        return false;
    }
    return true;
  }

  snapshot() {
    return {
      sending: [...this.#outgoing.values()].map((record) =>
        this.#sendProgress(record, record.state === 'sending' ? 'sending' : 'awaiting')
      ),
      receiving: [...this.#incoming.values()].map((state) => this.#receiveProgress(state))
    };
  }

  close() {
    clearInterval(this.#sweeper);
    for (const record of this.#outgoing.values()) clearTimeout(record.timer);
  }

  #enqueue(task) {
    this.#queue = this.#queue
      .then(task)
      .catch((error) => this.#log.error({ err: error }, 'Transfer task failed'));
    return this.#queue;
  }

  #alive(record) {
    return record.state === 'sending' || record.state === 'awaiting';
  }

  #interval() {
    const base = this.#config.sendIntervalMs;
    return base + Math.floor(Math.random() * base * 0.5);
  }

  #sendProgress(record, phase) {
    return { id: record.id, to: record.to, name: record.name, phase, sent: record.sent, total: record.total };
  }

  #receiveProgress(state) {
    return { id: state.id, from: state.from, received: state.count, total: state.total };
  }

  async #sendWithRetry(chat, text) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#transport.sendText(chat, text);
      } catch (error) {
        lastError = error;
        await sleep(400 * attempt);
      }
    }
    throw lastError;
  }

  async #clean(refs) {
    if (refs.length === 0) return true;
    try {
      const result = await this.#transport.deleteLocal(refs);
      return !result || result.failed === 0;
    } catch (error) {
      this.#log.warn({ err: error }, 'Chat cleanup failed');
      return false;
    }
  }

  #discard(ref) {
    if (ref) void this.#clean([ref]);
  }

  async #notifyAbort(chat, id, reason) {
    try {
      const ref = await this.#sendWithRetry(chat, protocol.encodeAbort(id, reason));
      void this.#clean([ref]);
    } catch (error) {
      this.#log.warn({ err: error, id }, 'Could not notify the peer');
    }
  }

  #armAckTimer(record) {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => this.#failOutgoing(record, 'timeout'), this.#config.ackTimeoutMs);
    record.timer.unref();
  }

  async #transmit(record, texts, initial) {
    clearTimeout(record.timer);
    for (const text of texts) {
      if (!this.#alive(record)) return;
      let ref;
      try {
        ref = await this.#sendWithRetry(record.chat, text);
      } catch (error) {
        this.#log.error({ err: error, id: record.id }, 'Sending failed');
        this.#failOutgoing(record, 'send_failed');
        return;
      }
      if (!this.#alive(record)) {
        this.#discard(ref);
        return;
      }
      record.refs.push(ref);
      if (initial) {
        record.sent += 1;
        this.emit('send:progress', this.#sendProgress(record, 'sending'));
      }
      await sleep(this.#interval());
    }
    if (!this.#alive(record)) return;
    record.state = 'awaiting';
    this.emit('send:progress', this.#sendProgress(record, 'awaiting'));
    this.#armAckTimer(record);
  }

  async #completeOutgoing(record, ackRef) {
    record.state = 'done';
    clearTimeout(record.timer);
    this.#outgoing.delete(record.id);
    this.emit('send:progress', this.#sendProgress(record, 'cleaning'));
    const cleaned = await this.#clean(ackRef ? [...record.refs, ackRef] : record.refs);
    this.emit('send:done', { id: record.id, cleaned });
  }

  #failOutgoing(record, reason) {
    if (!this.#alive(record)) return;
    record.state = 'failed';
    clearTimeout(record.timer);
    this.#outgoing.delete(record.id);
    this.emit('send:failed', { id: record.id, reason, message: describe(reason) });
    void this.#clean(record.refs);
  }

  #onAck(packet, { ref }) {
    const record = this.#outgoing.get(packet.id);
    if (record && this.#alive(record)) {
      void this.#completeOutgoing(record, ref);
      return;
    }
    this.#discard(ref);
  }

  #onResend(packet, { ref }) {
    this.#discard(ref);
    const record = this.#outgoing.get(packet.id);
    if (!record || !this.#alive(record)) return;
    if (record.resends >= this.#config.maxResendRounds * 2) return;
    record.resends += 1;

    const texts = [];
    if (packet.meta) texts.push(record.metaText);
    for (const index of packet.indices) {
      if (index < record.dataTexts.length) texts.push(record.dataTexts[index]);
    }
    if (texts.length === 0) return;
    this.#enqueue(() => this.#transmit(record, texts, false));
  }

  #onAbort(packet, { ref }) {
    const record = this.#outgoing.get(packet.id);
    if (record && this.#alive(record)) {
      record.refs.push(ref);
      this.#failOutgoing(record, packet.reason);
      return;
    }
    this.#discard(ref);
  }

  #accepts(sender) {
    const allowed = this.#config.allowedSenders;
    return allowed.length === 0 || (sender !== null && allowed.includes(sender));
  }

  #rememberClosed(id) {
    this.#closed.set(id, Date.now());
    if (this.#closed.size > 1000) {
      this.#closed.delete(this.#closed.keys().next().value);
    }
  }

  #openIncoming(id, total, { chat, sender, ref }) {
    const existing = this.#incoming.get(id);
    if (existing) return existing;
    if (!this.#accepts(sender)) return null;
    if (this.#incoming.size >= this.#config.maxIncoming) {
      this.#rememberClosed(id);
      this.#discard(ref);
      void this.#notifyAbort(chat, id, 'busy');
      return null;
    }
    const state = {
      id,
      chat,
      sender,
      from: sender ? `+${sender}` : 'Unknown contact',
      meta: null,
      total,
      chunks: new Array(total),
      count: 0,
      bytes: 0,
      refs: [],
      touched: Date.now(),
      rounds: 0
    };
    this.#incoming.set(id, state);
    return state;
  }

  #onMeta(packet, context) {
    if (this.#closed.has(packet.id)) {
      this.#discard(context.ref);
      return;
    }
    const state = this.#openIncoming(packet.id, packet.meta.chunks, context);
    if (!state) return;
    state.refs.push(context.ref);
    if (packet.meta.size > media.limitFor(packet.meta.mime, this.#config)) {
      this.#rejectIncoming(state, 'too_large');
      return;
    }
    if (state.total !== packet.meta.chunks) {
      this.#rejectIncoming(state, 'corrupt');
      return;
    }
    state.meta = packet.meta;
    this.#afterPacket(state);
  }

  #onData(packet, context) {
    if (this.#closed.has(packet.id)) {
      this.#discard(context.ref);
      return;
    }
    const state = this.#openIncoming(packet.id, packet.total, context);
    if (!state) return;
    state.refs.push(context.ref);
    if (packet.total !== state.total) {
      this.#rejectIncoming(state, 'corrupt');
      return;
    }
    if (state.chunks[packet.index] === undefined) {
      state.chunks[packet.index] = packet.payload;
      state.count += 1;
      state.bytes += packet.payload.length;
      if (state.bytes > this.#maxBase64) {
        this.#rejectIncoming(state, 'too_large');
        return;
      }
    }
    this.#afterPacket(state);
  }

  #afterPacket(state) {
    state.touched = Date.now();
    state.rounds = 0;
    this.emit('receive:progress', this.#receiveProgress(state));
    if (state.meta && state.count === state.total) {
      this.#incoming.delete(state.id);
      this.#rememberClosed(state.id);
      void this.#finalize(state);
    }
  }

  #rejectIncoming(state, reason) {
    this.#incoming.delete(state.id);
    this.#rememberClosed(state.id);
    this.emit('receive:failed', { id: state.id, reason, message: describe(reason) });
    void this.#notifyAbort(state.chat, state.id, reason);
    void this.#clean(state.refs);
  }

  async #finalize(state) {
    const { meta } = state;
    const data = Buffer.from(state.chunks.join(''), 'base64');
    const valid =
      data.length === meta.size && sha256(data) === meta.hash && media.detect(data) === meta.mime;

    if (!valid) {
      this.emit('receive:failed', { id: state.id, reason: 'corrupt', message: describe('corrupt') });
      await this.#notifyAbort(state.chat, state.id, 'corrupt');
      await this.#clean(state.refs);
      return;
    }

    let item;
    try {
      item = await this.#store.save({
        id: state.id,
        data,
        mime: meta.mime,
        name: meta.name,
        from: state.from
      });
    } catch (error) {
      this.#log.error({ err: error, id: state.id }, 'Saving the received image failed');
      this.emit('receive:failed', {
        id: state.id,
        reason: 'storage_error',
        message: describe('storage_error')
      });
      return;
    }

    this.emit('receive:done', { id: state.id, item });

    let ackRef = null;
    try {
      ackRef = await this.#sendWithRetry(state.chat, protocol.encodeAck(state.id));
    } catch (error) {
      this.#log.warn({ err: error, id: state.id }, 'Could not send the confirmation');
    }

    const cleaned = await this.#clean(ackRef ? [...state.refs, ackRef] : state.refs);
    this.emit('receive:cleaned', { id: state.id, cleaned });
  }

  async #requestResend(state) {
    const indices = [];
    for (let index = 0; index < state.total && indices.length < protocol.MAX_RESEND_LIST; index += 1) {
      if (state.chunks[index] === undefined) indices.push(index);
    }
    try {
      const ref = await this.#sendWithRetry(
        state.chat,
        protocol.encodeResend(state.id, { meta: !state.meta, indices })
      );
      void this.#clean([ref]);
    } catch (error) {
      this.#log.warn({ err: error, id: state.id }, 'Could not request missing parts');
    }
  }

  #sweep() {
    const now = Date.now();
    for (const state of [...this.#incoming.values()]) {
      if (now - state.touched < this.#config.stallTimeoutMs) continue;
      if (state.rounds >= this.#config.maxResendRounds) {
        this.#rejectIncoming(state, 'timeout');
        continue;
      }
      state.rounds += 1;
      state.touched = now;
      void this.#requestResend(state);
    }
  }
}

module.exports = { TransferEngine, TransferError };
