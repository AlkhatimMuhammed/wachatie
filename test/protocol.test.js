// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/protocol');

const id = protocol.newTransferId();
const hash = 'a'.repeat(64);

test('round-trips every packet type', () => {
  assert.deepEqual(protocol.decode(protocol.encodeData(id, 2, 9, 'QUJDRA==')), {
    type: 'D', id, index: 2, total: 9, payload: 'QUJDRA=='
  });
  assert.deepEqual(protocol.decode(protocol.encodeAck(id)), { type: 'A', id });
  assert.deepEqual(protocol.decode(protocol.encodeAbort(id, 'corrupt')), { type: 'X', id, reason: 'corrupt' });
  assert.deepEqual(protocol.decode(protocol.encodeResend(id, { meta: true, indices: [1, 2, 3, 8] })), {
    type: 'R', id, meta: true, indices: [1, 2, 3, 8]
  });
  const meta = { name: 'a|b.png', mime: 'image/png', size: 10, hash, chunks: 3 };
  assert.deepEqual(protocol.decode(protocol.encodeMeta(id, meta)), { type: 'M', id, meta });
});

test('rejects malformed packets', () => {
  const bad = [
    null, undefined, 42, '', 'hello', 'CP1|', 'CP1|D', `CP1|D|nothex|1|2|AAAA`,
    `CP1|D|${id}|5|5|AAAA`, `CP1|D|${id}|0|0|AAAA`, `CP1|D|${id}|0|2|not base64!`,
    `CP1|D|${id}|0|2`, `CP1|A|${id}|extra`, `CP1|X|${id}|Bad Reason`,
    `CP1|M|${id}|{`, `CP1|M|${id}|{"n":"x","m":"image/svg+xml","s":1,"h":"${hash}","c":1}`,
    `CP1|M|${id}|{"n":"x","m":"image/png","s":1,"h":"short","c":1}`,
    `CP1|R|${id}|1-99999`, `CP1|Z|${id}`,
    `CP1|D|${id}|0|2|${'A'.repeat(protocol.MAX_PAYLOAD_LENGTH + 1)}`
  ];
  for (const text of bad) assert.equal(protocol.decode(text), null, String(text).slice(0, 40));
});
