// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  normalizeMessageContent,
  isPnUser,
  isLidUser,
  Browsers,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const protocol = require('./protocol');
const { UserError } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digitsOf = (jid) => String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
const isDirectChat = (jid) => typeof jid === 'string' && (isPnUser(jid) || isLidUser(jid));

function toSeconds(value) {
  if (value === null || value === undefined) return Math.floor(Date.now() / 1000);
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value.toNumber === 'function') return value.toNumber();
  return Number(value) || Math.floor(Date.now() / 1000);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UserError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class WhatsAppClient extends EventEmitter {
  #config;
  #log;
  #sock = null;
  #state = 'connecting';
  #user = null;
  #pairingCode = null;
  #retryIn = null;
  #attempt = 0;
  #timer = null;
  #stopping = false;
  #ready = deferred();
  #sent = new Map();
  #version;
  #autoPairDone = false;

  constructor({ config, log }) {
    super();
    this.#config = config;
    this.#log = log;
  }

  get status() {
    return {
      state: this.#state,
      user: this.#user,
      pairingCode: this.#pairingCode,
      retryIn: this.#retryIn
    };
  }

  async start() {
    await fs.mkdir(this.#config.authDir, { recursive: true });
    await this.#connect();
  }

  async stop() {
    this.#stopping = true;
    clearTimeout(this.#timer);
    const sock = this.#sock;
    this.#sock = null;
    if (sock) this.#detach(sock);
  }

  async requestPairing(phone) {
    const digits = String(phone ?? '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      throw new UserError('Enter your phone number with the country code, digits only');
    }
    const sock = this.#sock;
    if (!sock) throw new UserError('WhatsApp is not ready yet. Try again in a moment');
    if (sock.authState.creds.registered) throw new UserError('This device is already linked');

    await withTimeout(this.#ready.promise, 30000, 'WhatsApp is not ready yet. Try again in a moment');
    if (sock !== this.#sock) throw new UserError('The connection was reset. Please try again');

    let code;
    try {
      code = await sock.requestPairingCode(digits);
    } catch (error) {
      this.#log.warn({ err: error }, 'Pairing code request failed');
      throw new UserError('WhatsApp did not return a pairing code. Check the number and try again');
    }
    this.#log.info(`Pairing code: ${code}`);
    this.#setState('pairing', { pairingCode: code });
    return code;
  }

  async sendText(jid, text) {
    await this.#waitForOpen(20000);
    const sock = this.#sock;
    const sent = await sock.sendMessage(jid, { text });
    if (!sent?.key?.id) throw new Error('WhatsApp did not accept the message');
    this.#remember(sent.key.id, sent.message ?? { conversation: text });
    return {
      chat: jid,
      alt: sent.key.remoteJid && sent.key.remoteJid !== jid ? [sent.key.remoteJid] : [],
      id: sent.key.id,
      fromMe: true,
      timestamp: toSeconds(sent.messageTimestamp)
    };
  }

  async deleteLocal(refs) {
    await this.#waitForOpen(30000);
    const sock = this.#sock;
    const aliasCache = new Map();
    let deleted = 0;
    let failed = 0;

    for (const ref of refs) {
      if (!aliasCache.has(ref.chat)) aliasCache.set(ref.chat, await this.#aliases(sock, ref));
      let removed = false;
      for (const jid of aliasCache.get(ref.chat)) {
        if (await this.#deleteOne(sock, jid, ref)) removed = true;
      }
      if (removed) deleted += 1;
      else failed += 1;
      this.#sent.delete(ref.id);
    }
    return { deleted, failed };
  }

  async #connect() {
    if (this.#stopping) return;
    const { state, saveCreds } = await useMultiFileAuthState(this.#config.authDir);
    const version = await this.#resolveVersion();
    const logger = pino({ level: this.#config.baileysLogLevel });

    const options = {
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => this.#sent.get(key.id)
    };
    if (version) options.version = version;

    const sock = makeWASocket(options);
    this.#sock = sock;
    this.#ready = deferred();
    this.#user = null;
    this.#setState('connecting');

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => this.#onConnection(sock, update));
    sock.ev.on('messages.upsert', (event) => this.#onUpsert(sock, event));
  }

  async #resolveVersion() {
    if (this.#version !== undefined) return this.#version;
    try {
      const result = await withTimeout(fetchLatestBaileysVersion(), 8000, 'Version lookup timed out');
      this.#version = result?.version ?? null;
    } catch (error) {
      this.#log.debug({ err: error }, 'Using the default WhatsApp Web version');
      this.#version = null;
    }
    return this.#version;
  }

  #setState(state, extra = {}) {
    this.#state = state;
    this.#pairingCode = state === 'pairing' ? extra.pairingCode ?? this.#pairingCode : null;
    this.#retryIn = state === 'reconnecting' ? extra.retryIn ?? null : null;
    if (state !== 'open') this.#user = state === 'connecting' ? null : this.#user;
    this.emit('status', this.status);
  }

  #detach(sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ev.removeAllListeners('creds.update');
      sock.end(undefined);
    } catch (error) {
      this.#log.debug({ err: error }, 'Socket cleanup failed');
    }
  }

  #onConnection(sock, update) {
    if (sock !== this.#sock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.#ready.resolve();
      if (!sock.authState.creds.registered && this.#state !== 'pairing') this.#setState('unpaired');
      void this.#autoPair();
    }

    if (connection === 'open') {
      this.#attempt = 0;
      this.#user = digitsOf(sock.user?.id ?? '') || null;
      this.#log.info({ user: this.#user }, 'Connected to WhatsApp');
      this.#setState('open');
    } else if (connection === 'close') {
      void this.#onClose(sock, lastDisconnect);
    }
  }

  async #onClose(sock, lastDisconnect) {
    const code = lastDisconnect?.error?.output?.statusCode;
    this.#detach(sock);
    this.#sock = null;
    if (this.#stopping) return;

    if (code === DisconnectReason.loggedOut) {
      this.#log.warn('This device was unlinked from WhatsApp. Starting a new pairing');
      await fs.rm(this.#config.authDir, { recursive: true, force: true });
      await fs.mkdir(this.#config.authDir, { recursive: true });
      this.#autoPairDone = false;
      this.#scheduleConnect(0);
      return;
    }

    const immediate = code === DisconnectReason.restartRequired;
    const delay = immediate ? 0 : Math.min(30000, 1000 * 2 ** Math.min(this.#attempt, 5));
    if (!immediate) this.#attempt += 1;
    this.#log.warn({ code, retryInMs: delay }, 'Connection closed');
    this.#setState('reconnecting', { retryIn: delay });
    this.#scheduleConnect(delay);
  }

  #scheduleConnect(delay) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#connect().catch((error) => {
        this.#log.error({ err: error }, 'Could not start the WhatsApp connection');
        const retry = Math.min(30000, 1000 * 2 ** Math.min(this.#attempt, 5));
        this.#attempt += 1;
        this.#setState('reconnecting', { retryIn: retry });
        this.#scheduleConnect(retry);
      });
    }, delay);
  }

  async #autoPair() {
    const phone = this.#config.pairingPhone;
    if (!phone || this.#autoPairDone) return;
    this.#autoPairDone = true;
    try {
      await this.requestPairing(phone);
    } catch (error) {
      this.#log.warn({ err: error }, 'Automatic pairing failed');
    }
  }

  #waitForOpen(timeoutMs) {
    if (this.#state === 'open' && this.#sock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onStatus = (status) => {
        if (status.state !== 'open') return;
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve();
      };
      const timer = setTimeout(() => {
        this.off('status', onStatus);
        reject(new Error('WhatsApp is not connected'));
      }, timeoutMs);
      this.on('status', onStatus);
    });
  }

  #remember(id, message) {
    this.#sent.set(id, message);
    if (this.#sent.size > 4000) this.#sent.delete(this.#sent.keys().next().value);
  }

  #isSelf(sock, jid) {
    const me = sock.user;
    if (!me || !jid) return false;
    const own = [me.id, me.lid].filter(Boolean).map((value) => jidNormalizedUser(value));
    return own.includes(jidNormalizedUser(jid));
  }

  #onUpsert(sock, { messages, type }) {
    if (sock !== this.#sock) return;
    if (type !== 'notify' && type !== 'append') return;
    for (const message of messages) {
      this.#dispatch(sock, message).catch((error) => {
        this.#log.error({ err: error }, 'Failed to process an incoming message');
      });
    }
  }

  async #dispatch(sock, message) {
    const key = message.key;
    if (!key?.id || !isDirectChat(key.remoteJid) || !message.message) return;

    const chat = key.remoteJid;
    const alt = isDirectChat(key.remoteJidAlt) ? key.remoteJidAlt : null;
    const selfChat = this.#isSelf(sock, chat) || this.#isSelf(sock, alt);
    if (key.fromMe && !selfChat) return;

    const content = normalizeMessageContent(message.message);
    const text = content?.conversation ?? content?.extendedTextMessage?.text;
    if (!protocol.isPacket(text)) return;

    const sender = await this.#resolveSender(sock, chat, alt);
    this.emit('message', {
      chat,
      sender,
      text,
      ref: {
        chat,
        alt: alt ? [alt] : [],
        id: key.id,
        fromMe: Boolean(key.fromMe),
        timestamp: toSeconds(message.messageTimestamp)
      }
    });
  }

  async #resolveSender(sock, chat, alt) {
    for (const jid of [chat, alt]) {
      if (jid && isPnUser(jid)) return digitsOf(jid);
    }
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(chat);
      if (pn) return digitsOf(pn);
    } catch (error) {
      this.#log.debug({ err: error }, 'Could not resolve a LID to a phone number');
    }
    return null;
  }

  async #aliases(sock, ref) {
    const jids = new Set([ref.chat, ...(ref.alt ?? [])]);
    const mapping = sock.signalRepository?.lidMapping;
    if (!mapping) return [...jids];
    try {
      for (const jid of [...jids]) {
        if (isPnUser(jid)) {
          const lid = await mapping.getLIDForPN(jid);
          if (lid) jids.add(lid);
        } else if (isLidUser(jid)) {
          const pn = await mapping.getPNForLID(jid);
          if (pn) jids.add(pn);
        }
      }
    } catch (error) {
      this.#log.debug({ err: error }, 'Could not resolve chat aliases');
    }
    return [...jids];
  }

  async #deleteOne(sock, jid, ref) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await sock.chatModify(
          {
            deleteForMe: {
              deleteMedia: false,
              key: { remoteJid: jid, id: ref.id, fromMe: ref.fromMe },
              timestamp: ref.timestamp
            }
          },
          jid
        );
        return true;
      } catch (error) {
        this.#log.debug({ err: error, attempt }, 'Delete-for-me attempt failed');
        await sleep(1200 * attempt);
      }
    }
    return false;
  }
}

module.exports = { WhatsAppClient };
