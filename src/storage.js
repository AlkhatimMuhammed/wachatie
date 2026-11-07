// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

const fs = require('node:fs/promises');
const path = require('node:path');
const media = require('./media');

const ID_PATTERN = /^[a-f0-9]{12}$/;

class ReceivedStore {
  #imageDir;
  #metaDir;

  constructor(imageDir, metaDir) {
    this.#imageDir = imageDir;
    this.#metaDir = metaDir;
  }

  async init() {
    await fs.mkdir(this.#imageDir, { recursive: true });
    await fs.mkdir(this.#metaDir, { recursive: true });
  }

  async save({ id, data, mime, name, from }) {
    const extension = media.extensionFor(mime);
    if (!extension || !ID_PATTERN.test(id)) throw new Error('Invalid image metadata');

    const receivedAt = Date.now();
    const base = `${receivedAt}_${id}`;
    const fileName = `${base}.${extension}`;
    const target = path.join(this.#imageDir, fileName);
    const partial = `${target}.part`;

    await fs.writeFile(partial, data, { mode: 0o600 });
    await fs.rename(partial, target);

    const item = { id, fileName, name, mime, size: data.length, from, receivedAt };
    await fs.writeFile(path.join(this.#metaDir, `${base}.json`), JSON.stringify(item), { mode: 0o600 });
    return this.#present(item);
  }

  async list(limit = 60) {
    let names;
    try {
      names = await fs.readdir(this.#metaDir);
    } catch {
      return [];
    }
    const items = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const item = JSON.parse(await fs.readFile(path.join(this.#metaDir, name), 'utf8'));
        if (ID_PATTERN.test(item.id) && typeof item.fileName === 'string') items.push(item);
      } catch {
        continue;
      }
    }
    items.sort((a, b) => b.receivedAt - a.receivedAt);
    return items.slice(0, limit).map((item) => this.#present(item));
  }

  async remove(id) {
    if (!ID_PATTERN.test(id)) return false;
    const names = await fs.readdir(this.#metaDir).catch(() => []);
    const metaName = names.find((name) => name.endsWith(`_${id}.json`));
    if (!metaName) return false;
    const item = JSON.parse(await fs.readFile(path.join(this.#metaDir, metaName), 'utf8'));
    await fs.rm(path.join(this.#imageDir, path.basename(item.fileName)), { force: true });
    await fs.rm(path.join(this.#metaDir, metaName), { force: true });
    return true;
  }

  #present(item) {
    return {
      id: item.id,
      name: item.name,
      mime: item.mime,
      size: item.size,
      from: item.from,
      receivedAt: item.receivedAt,
      url: `/files/${encodeURIComponent(item.fileName)}`
    };
  }
}

module.exports = { ReceivedStore };
