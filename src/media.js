// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const TYPES = Object.freeze({
  'image/jpeg': { extension: 'jpg', kind: 'image' },
  'image/png': { extension: 'png', kind: 'image' },
  'image/gif': { extension: 'gif', kind: 'image' },
  'image/webp': { extension: 'webp', kind: 'image' },
  'video/mp4': { extension: 'mp4', kind: 'video' },
  'video/quicktime': { extension: 'mov', kind: 'video' },
  'video/webm': { extension: 'webm', kind: 'video' },
  'audio/mpeg': { extension: 'mp3', kind: 'audio' },
  'audio/mp4': { extension: 'm4a', kind: 'audio' },
  'audio/aac': { extension: 'aac', kind: 'audio' },
  'audio/ogg': { extension: 'ogg', kind: 'audio' },
  'audio/wav': { extension: 'wav', kind: 'audio' },
  'audio/flac': { extension: 'flac', kind: 'audio' }
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UNSUPPORTED_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

const ascii = (buffer, start, end) => buffer.subarray(start, end).toString('latin1');

function detect(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(buffer, 0, 6))) return 'image/gif';

  if (buffer.length >= 12 && ascii(buffer, 0, 4) === 'RIFF') {
    const form = ascii(buffer, 8, 12);
    if (form === 'WEBP') return 'image/webp';
    if (form === 'WAVE') return 'audio/wav';
    return null;
  }

  if (buffer.length >= 12 && ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12);
    if (UNSUPPORTED_BRANDS.has(brand)) return null;
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }

  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm';

  const head = ascii(buffer, 0, 4);
  if (head === 'OggS') return 'audio/ogg';
  if (head === 'fLaC') return 'audio/flac';
  if (head.startsWith('ID3')) return 'audio/mpeg';

  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return ((buffer[1] >> 1) & 3) === 0 ? 'audio/aac' : 'audio/mpeg';
  }

  return null;
}

function isSupported(mime) {
  return typeof mime === 'string' && Object.hasOwn(TYPES, mime);
}

function kindOf(mime) {
  return isSupported(mime) ? TYPES[mime].kind : null;
}

function extensionFor(mime) {
  return isSupported(mime) ? TYPES[mime].extension : null;
}

function limitFor(mime, config) {
  return kindOf(mime) === 'image' ? config.maxImageBytes : config.maxMediaBytes;
}

function safeName(input, mime) {
  const cleaned = String(input ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 100);
  return cleaned || `${kindOf(mime) || 'file'}.${extensionFor(mime) || 'bin'}`;
}

module.exports = { detect, isSupported, kindOf, extensionFor, limitFor, safeName };
