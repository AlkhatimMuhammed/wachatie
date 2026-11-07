// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const crypto = require('node:crypto');
const media = require('./media');

const PREFIX = 'CP1';
const SEPARATOR = '|';
const ID_PATTERN = /^[a-f0-9]{12}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PAYLOAD_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const REASON_PATTERN = /^[a-z_]{1,32}$/;

const MAX_CHUNKS = 20000;
const MAX_PAYLOAD_LENGTH = 32768;
const MAX_RESEND_LIST = 400;
const MAX_PACKET_LENGTH = MAX_PAYLOAD_LENGTH + 256;

const isPacket = (text) => typeof text === 'string' && text.startsWith(PREFIX + SEPARATOR);
const newTransferId = () => crypto.randomBytes(6).toString('hex');
const join = (...parts) => [PREFIX, ...parts].join(SEPARATOR);

function toInt(value) {
  return typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : null;
}

function compressRanges(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const tokens = [];
  let start = null;
  let previous = null;
  const flush = () => {
    if (start === null) return;
    tokens.push(start === previous ? `${start}` : `${start}-${previous}`);
  };
  for (const value of sorted) {
    if (start === null) {
      start = value;
      previous = value;
    } else if (value === previous + 1) {
      previous = value;
    } else {
      flush();
      start = value;
      previous = value;
    }
  }
  flush();
  return tokens;
}

function expandRanges(tokens) {
  const indices = [];
  for (const token of tokens) {
    const match = /^(\d{1,9})(?:-(\d{1,9}))?$/.exec(token);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (to < from || to - from >= MAX_RESEND_LIST) return null;
    for (let value = from; value <= to; value += 1) {
      indices.push(value);
      if (indices.length > MAX_RESEND_LIST) return null;
    }
  }
  return indices;
}

function encodeMeta(id, meta) {
  const body = { n: meta.name, m: meta.mime, s: meta.size, h: meta.hash, c: meta.chunks };
  return join('M', id, JSON.stringify(body));
}

function encodeData(id, index, total, payload) {
  return join('D', id, index, total, payload);
}

function encodeAck(id) {
  return join('A', id);
}

function encodeAbort(id, reason) {
  return join('X', id, reason);
}

function encodeResend(id, { meta, indices }) {
  const limited = indices.slice(0, MAX_RESEND_LIST);
  const tokens = [...(meta ? ['m'] : []), ...compressRanges(limited)];
  return join('R', id, tokens.join(','));
}

function checkMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { n, m, s, h, c } = raw;
  if (typeof n !== 'string' || n.length < 1 || n.length > 120) return null;
  if (!media.isSupported(m)) return null;
  if (!Number.isInteger(s) || s < 1) return null;
  if (typeof h !== 'string' || !HASH_PATTERN.test(h)) return null;
  if (!Number.isInteger(c) || c < 1 || c > MAX_CHUNKS) return null;
  return { name: n, mime: m, size: s, hash: h, chunks: c };
}

function decode(text) {
  if (!isPacket(text) || text.length > MAX_PACKET_LENGTH) return null;
  const parts = text.split(SEPARATOR);
  const type = parts[1];
  const id = parts[2];
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;

  switch (type) {
    case 'D': {
      if (parts.length !== 6) return null;
      const index = toInt(parts[3]);
      const total = toInt(parts[4]);
      if (index === null || total === null || total < 1 || total > MAX_CHUNKS || index >= total) {
        return null;
      }
      const payload = parts[5];
      if (payload.length > MAX_PAYLOAD_LENGTH || !PAYLOAD_PATTERN.test(payload)) return null;
      return { type: 'D', id, index, total, payload };
    }
    case 'M': {
      if (parts.length < 4) return null;
      let parsed;
      try {
        parsed = JSON.parse(parts.slice(3).join(SEPARATOR));
      } catch {
        return null;
      }
      const meta = checkMeta(parsed);
      return meta ? { type: 'M', id, meta } : null;
    }
    case 'A':
      return parts.length === 3 ? { type: 'A', id } : null;
    case 'X':
      return parts.length === 4 && REASON_PATTERN.test(parts[3])
        ? { type: 'X', id, reason: parts[3] }
        : null;
    case 'R': {
      if (parts.length !== 4) return null;
      const tokens = parts[3] === '' ? [] : parts[3].split(',');
      const wantsMeta = tokens.includes('m');
      const indices = expandRanges(tokens.filter((token) => token !== 'm'));
      return indices ? { type: 'R', id, meta: wantsMeta, indices } : null;
    }
    default:
      return null;
  }
}

module.exports = {
  MAX_CHUNKS,
  MAX_PAYLOAD_LENGTH,
  MAX_RESEND_LIST,
  isPacket,
  newTransferId,
  encodeMeta,
  encodeData,
  encodeAck,
  encodeAbort,
  encodeResend,
  decode
};
