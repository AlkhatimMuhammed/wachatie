// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const test = require('node:test');
const assert = require('node:assert/strict');
const media = require('../src/media');
const { createPair, once, settle } = require('./helpers');

const pad = (head) => Buffer.concat([head, Buffer.alloc(64, 7)]);
const box = (brand) => pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand, 'latin1')]));

test('detects supported video and audio signatures', () => {
  const cases = [
    [box('isom'), 'video/mp4'],
    [box('qt  '), 'video/quicktime'],
    [box('M4A '), 'audio/mp4'],
    [pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'video/webm'],
    [pad(Buffer.from('OggS')), 'audio/ogg'],
    [pad(Buffer.from('fLaC')), 'audio/flac'],
    [pad(Buffer.from('ID3')), 'audio/mpeg'],
    [pad(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'audio/mpeg'],
    [pad(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'audio/aac'],
    [pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])), 'audio/wav'],
    [pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp'],
    [pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg']
  ];
  for (const [buffer, expected] of cases) assert.equal(media.detect(buffer), expected);
});

test('rejects unknown and unsupported containers', () => {
  assert.equal(media.detect(box('heic')), null);
  assert.equal(media.detect(box('avif')), null);
  assert.equal(media.detect(pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')]))), null);
  assert.equal(media.detect(Buffer.from('plain text file')), null);
  assert.equal(media.detect(Buffer.alloc(2)), null);
});

test('applies separate size limits to images and media', () => {
  const config = { maxImageBytes: 10, maxMediaBytes: 100 };
  assert.equal(media.limitFor('image/png', config), 10);
  assert.equal(media.limitFor('video/mp4', config), 100);
  assert.equal(media.limitFor('audio/mpeg', config), 100);
});

test('transfers a video larger than the image limit', async () => {
  const pair = createPair({}, { maxImageBytes: 10 * 1024, maxMediaBytes: 200 * 1024 });
  const data = box('isom').subarray(0, 28);
  const video = Buffer.concat([data, Buffer.alloc(60000, 9)]);
  const received = once(pair.engines.b, 'receive:done');
  const done = once(pair.engines.a, 'send:done');
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data: video, name: 'clip.mp4' });
  const [{ item }] = await Promise.all([received, done]);
  await settle(100);

  assert.equal(item.mime, 'video/mp4');
  assert.ok(pair.stores.b.items[0].data.equals(video));
  assert.equal(pair.network.chats.a.size, 0);
  assert.equal(pair.network.chats.b.size, 0);

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60000, 1)]);
  await assert.rejects(pair.engines.a.send({ chat: 'b@peer', to: '1', data: jpeg, name: 'x.jpg' }), /too large/);
  pair.close();
});

test('transfers an audio file', async () => {
  const pair = createPair();
  const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(30000, 5)]);
  const received = once(pair.engines.b, 'receive:done');
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data: audio, name: 'voice.mp3' });
  const { item } = await received;
  assert.equal(item.mime, 'audio/mpeg');
  assert.equal(item.name, 'voice.mp3');
  pair.close();
});
