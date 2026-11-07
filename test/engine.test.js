// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPair, sampleImage, once, settle } = require('./helpers');

async function transfer(pair, data, options = {}) {
  const done = once(pair.engines.a, 'send:done');
  const received = once(pair.engines.b, 'receive:done');
  const cleaned = once(pair.engines.b, 'receive:cleaned');
  await pair.engines.a.send({ chat: 'b@peer', to: '249222222222', data, name: options.name || 'photo.jpg' });
  return Promise.all([done, received, cleaned]);
}

test('delivers an image, verifies it and cleans both chats', async () => {
  const pair = createPair();
  const data = sampleImage(30000);
  const [done, received, cleaned] = await transfer(pair, data);
  await settle();

  assert.equal(done.cleaned, true);
  assert.equal(cleaned.cleaned, true);
  assert.equal(received.item.size, data.length);
  assert.ok(pair.stores.b.items[0].data.equals(data));
  assert.equal(pair.stores.b.items[0].from, '+249111111111');
  assert.equal(pair.network.chats.a.size, 0, 'sender chat should be empty');
  assert.equal(pair.network.chats.b.size, 0, 'receiver chat should be empty');
  pair.close();
});

test('recovers from lost messages by requesting the missing parts', async () => {
  const seen = new Set();
  const pair = createPair({
    drop: ({ from, text }) => {
      if (from !== 'a' || !text.startsWith('CP1|D|')) return false;
      if (seen.has(text)) return false;
      seen.add(text);
      return Math.random() < 0.3;
    }
  });
  const data = sampleImage(20000);
  const [done] = await transfer(pair, data);
  await settle(100);

  assert.equal(done.cleaned, true);
  assert.ok(pair.stores.b.items[0].data.equals(data));
  assert.equal(pair.network.chats.a.size, 0);
  assert.equal(pair.network.chats.b.size, 0);
  pair.close();
});

test('recovers when the metadata message is lost', async () => {
  let dropped = false;
  const pair = createPair({
    drop: ({ from, text }) => {
      if (from === 'a' && text.startsWith('CP1|M|') && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    }
  });
  const data = sampleImage(5000);
  await transfer(pair, data);
  await settle(100);

  assert.equal(dropped, true);
  assert.ok(pair.stores.b.items[0].data.equals(data));
  assert.equal(pair.network.chats.a.size, 0);
  assert.equal(pair.network.chats.b.size, 0);
  pair.close();
});

test('handles heavy reordering and duplicate delivery', async () => {
  const pair = createPair({ maxDelay: 60 });
  const data = sampleImage(25000);
  const received = once(pair.engines.b, 'receive:done');
  const done = once(pair.engines.a, 'send:done');
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data, name: 'x.jpg' });
  const record = pair.network.log.filter((entry) => entry.text.startsWith('CP1|D|'));
  for (const entry of record.slice(0, 5)) {
    await pair.network.transport('a').sendText('b@peer', entry.text);
  }
  await Promise.all([received, done]);
  await settle(200);

  assert.equal(pair.stores.b.items.length, 1);
  assert.ok(pair.stores.b.items[0].data.equals(data));
  assert.equal(pair.network.chats.a.size, 0);
  assert.equal(pair.network.chats.b.size, 0);
  pair.close();
});

test('rejects tampered data and tells the sender', async () => {
  let tampered = false;
  const pair = createPair({
    mutate: (text, { from }) => {
      if (from === 'a' && text.startsWith('CP1|D|') && !tampered) {
        tampered = true;
        const parts = text.split('|');
        const payload = parts[5];
        parts[5] = (payload[0] === 'A' ? 'B' : 'A') + payload.slice(1);
        return parts.join('|');
      }
      return text;
    }
  });
  const failedReceive = once(pair.engines.b, 'receive:failed');
  const failedSend = once(pair.engines.a, 'send:failed');
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data: sampleImage(3000), name: 'x.jpg' });
  const [receive, send] = await Promise.all([failedReceive, failedSend]);
  await settle(100);

  assert.equal(receive.reason, 'corrupt');
  assert.equal(send.reason, 'corrupt');
  assert.equal(pair.stores.b.items.length, 0);
  assert.equal(pair.network.chats.a.size, 0);
  assert.equal(pair.network.chats.b.size, 0);
  pair.close();
});

test('sender gives up and cleans its chat when no confirmation arrives', async () => {
  const pair = createPair({ drop: ({ from }) => from === 'a' }, { ackTimeoutMs: 300 });
  const failed = once(pair.engines.a, 'send:failed');
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data: sampleImage(2000), name: 'x.jpg' });
  const result = await failed;
  await settle(50);

  assert.equal(result.reason, 'timeout');
  assert.equal(pair.network.chats.a.size, 0);
  pair.close();
});

test('receiver abandons a stalled transfer and cleans its chat', async () => {
  const pair = createPair(
    { drop: ({ from, text }) => from === 'a' && text.startsWith('CP1|D|1|') },
    { stallTimeoutMs: 100, maxResendRounds: 2 }
  );
  const failed = once(pair.engines.b, 'receive:failed');
  const data = sampleImage(4000);
  pair.network.options.drop = ({ from, text }) => from === 'a' && /^CP1\|D\|[a-f0-9]{12}\|(1|2|3)\|/.test(text);
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data, name: 'x.jpg' });
  const result = await failed;
  await settle(100);

  assert.equal(result.reason, 'timeout');
  assert.equal(pair.network.chats.b.size, 0);
  pair.close();
});

test('refuses unsupported and oversized images before sending anything', async () => {
  const pair = createPair({}, { maxImageBytes: 10 * 1024 });
  await assert.rejects(
    pair.engines.a.send({ chat: 'b@peer', to: '1', data: Buffer.from('not an image'), name: 'x.txt' }),
    /Unsupported/
  );
  await assert.rejects(
    pair.engines.a.send({ chat: 'b@peer', to: '1', data: sampleImage(20000), name: 'x.jpg' }),
    /too large/
  );
  assert.equal(pair.network.log.length, 0);
  pair.close();
});

test('ignores senders that are not on the allow list', async () => {
  const pair = createPair({}, { allowedSenders: ['249999999999'], ackTimeoutMs: 300 });
  const failed = once(pair.engines.a, 'send:failed');
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data: sampleImage(2000), name: 'x.jpg' });
  await failed;
  assert.equal(pair.stores.b.items.length, 0);
  pair.close();
});

test('limits concurrent incoming transfers', async () => {
  const pair = createPair({}, { maxIncoming: 1, sendIntervalMs: 30 });
  const firstProgress = once(pair.engines.b, 'receive:progress');
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data: sampleImage(8000), name: 'one.jpg' });
  await firstProgress;

  const protocol = require('../src/protocol');
  const foreignId = protocol.newTransferId();
  pair.network.chats.b.add('foreign-1');
  const handled = pair.engines.b.handle({
    chat: 'c@peer',
    sender: '249333333333',
    text: protocol.encodeData(foreignId, 0, 4, 'QUJD'),
    ref: { side: 'b', id: 'foreign-1' }
  });
  await settle(100);

  assert.equal(handled, true);
  assert.equal(pair.engines.b.snapshot().receiving.length, 1);
  assert.ok(pair.network.log.some((entry) => entry.from === 'b' && entry.text.startsWith(`CP1|X|${foreignId}|busy`)));
  assert.equal(pair.network.chats.b.has('foreign-1'), false);
  pair.close();
});

test('keeps the chunks in the chat when the image cannot be stored', async () => {
  const pair = createPair();
  pair.stores.b.fail = true;
  const failed = once(pair.engines.b, 'receive:failed');
  await pair.engines.a.send({ chat: 'b@peer', to: '1', data: sampleImage(2000), name: 'x.jpg' });
  const result = await failed;
  assert.equal(result.reason, 'storage_error');
  assert.ok(pair.network.chats.b.size > 0);
  pair.close();
});

test('random binary payloads survive the round trip', async () => {
  const pair = createPair();
  for (let round = 0; round < 3; round += 1) {
    const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(7000 + round * 777)]);
    const received = once(pair.engines.b, 'receive:done');
    const done = once(pair.engines.a, 'send:done');
    await pair.engines.a.send({ chat: 'b@peer', to: '1', data, name: 'p.png' });
    await Promise.all([received, done]);
    assert.ok(pair.stores.b.items.at(-1).data.equals(data));
  }
  await settle(100);
  assert.equal(pair.network.chats.a.size, 0);
  assert.equal(pair.network.chats.b.size, 0);
  pair.close();
});
