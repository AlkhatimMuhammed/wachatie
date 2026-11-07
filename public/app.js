// Copyright (c) 2026 Alkhatim Muhammed. All rights reserved.

(() => {
  const $ = (id) => document.getElementById(id);

  const SUPPORTED_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'audio/mpeg',
    'audio/mp4',
    'audio/aac',
    'audio/ogg',
    'audio/wav',
    'audio/flac'
  ]);
  const EXTENSION_TYPES = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac'
  };
  const PRESETS = {
    small: { edge: 1024, quality: 0.72, hint: 'Up to 1024 px, re-encoded as JPEG. Fastest to send.' },
    balanced: { edge: 1600, quality: 0.82, hint: 'Up to 1600 px, re-encoded as JPEG. Good for most photos.' },
    original: { edge: 0, quality: 1, hint: 'Sent exactly as it is. Large files need many more messages.' }
  };
  const STORAGE_KEY = 'wachatie.recipient';

  const el = {
    status: $('status'),
    statusText: $('statusText'),
    linkCard: $('linkCard'),
    pairForm: $('pairForm'),
    pairPhone: $('pairPhone'),
    pairSubmit: $('pairSubmit'),
    pairError: $('pairError'),
    pairCode: $('pairCode'),
    pairCodeValue: $('pairCodeValue'),
    copyCode: $('copyCode'),
    sendForm: $('sendForm'),
    recipient: $('recipient'),
    drop: $('drop'),
    file: $('file'),
    dropEmpty: $('dropEmpty'),
    dropPreview: $('dropPreview'),
    previewImg: $('previewImg'),
    previewName: $('previewName'),
    previewInfo: $('previewInfo'),
    clearFile: $('clearFile'),
    previewIcon: $('previewIcon'),
    previewIconUse: $('previewIconUse'),
    qualityField: $('qualityField'),
    fileError: $('fileError'),
    qualityHint: $('qualityHint'),
    sendBtn: $('sendBtn'),
    sendNote: $('sendNote'),
    transfer: $('transfer'),
    transferTitle: $('transferTitle'),
    transferPercent: $('transferPercent'),
    transferFill: $('transferFill'),
    transferSteps: $('transferSteps'),
    incoming: $('incoming'),
    gallery: $('gallery'),
    empty: $('empty'),
    viewer: $('viewer'),
    viewerImg: $('viewerImg'),
    viewerVideo: $('viewerVideo'),
    viewerAudio: $('viewerAudio'),
    viewerName: $('viewerName'),
    viewerMeta: $('viewerMeta'),
    viewerDownload: $('viewerDownload'),
    viewerDelete: $('viewerDelete'),
    viewerClose: $('viewerClose'),
    toasts: $('toasts')
  };

  const app = {
    status: { state: 'connecting', user: null, pairingCode: null },
    online: false,
    limits: { maxImageBytes: 2 * 1024 * 1024, maxMediaBytes: 5 * 1024 * 1024, chunkSize: 4000 },
    file: null,
    prepared: null,
    preparing: false,
    prepareToken: 0,
    previewUrl: null,
    sendId: null,
    sending: false,
    received: new Map(),
    incoming: new Map(),
    viewing: null,
    deleteTimer: null
  };

  const socket = io();

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function resolveType(file) {
    if (SUPPORTED_TYPES.has(file.type)) return file.type;
    const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    return EXTENSION_TYPES[extension] || null;
  }

  const kindOf = (type) => type.split('/')[0];

  function limitFor(kind) {
    return kind === 'image' ? app.limits.maxImageBytes : app.limits.maxMediaBytes;
  }

  function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function isValidPhone(value) {
    const digits = digitsOnly(value);
    return digits.length >= 8 && digits.length <= 15;
  }

  function messageCount(bytes) {
    return Math.ceil((Math.ceil(bytes / 3) * 4) / app.limits.chunkSize) + 1;
  }

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, kind = 'info') {
    const node = create('div', `toast${kind === 'error' ? ' toast--error' : kind === 'warn' ? ' toast--warn' : ''}`, message);
    el.toasts.appendChild(node);
    setTimeout(() => node.remove(), kind === 'error' ? 7000 : 4500);
  }

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  function writeStored(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      return;
    }
  }

  function selectedPreset() {
    const checked = document.querySelector('input[name="quality"]:checked');
    return checked ? checked.value : 'balanced';
  }

  function formatCode(code) {
    return /^[A-Z0-9]{8}$/i.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  }

  const STATUS_LABELS = {
    open: 'Connected',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    unpaired: 'Not linked',
    pairing: 'Waiting for pairing',
    offline: 'Server unreachable'
  };

  function renderStatus() {
    const state = app.online ? app.status.state : 'offline';
    el.status.dataset.state = state;
    const base = STATUS_LABELS[state] || 'Connecting';
    el.statusText.textContent = state === 'open' && app.status.user ? `${base} as +${app.status.user}` : base;

    const needsLink = app.online && (state === 'unpaired' || state === 'pairing');
    el.linkCard.hidden = !needsLink;

    const code = app.online && state === 'pairing' ? app.status.pairingCode : null;
    el.pairCode.hidden = !code;
    if (code) el.pairCodeValue.textContent = formatCode(code);
    el.pairSubmit.textContent = code ? 'New code' : 'Get code';

    updateSendControls();
  }

  function updateSendControls() {
    const connected = app.online && app.status.state === 'open';
    const ready = connected && app.prepared && !app.preparing && !app.sending;
    el.sendBtn.disabled = !ready;

    if (!connected) {
      el.sendNote.textContent = app.online ? 'Waiting for the WhatsApp connection.' : 'Cannot reach the Wachatie server.';
    } else if (app.preparing) {
      el.sendNote.textContent = 'Preparing the file.';
    } else if (app.sending) {
      el.sendNote.textContent = 'A transfer is in progress.';
    } else if (!app.prepared) {
      el.sendNote.textContent = 'Choose a file to continue.';
    } else {
      el.sendNote.textContent = '';
    }
  }

  function setFileError(message) {
    el.fileError.hidden = !message;
    el.fileError.textContent = message || '';
  }

  function clearFile() {
    app.prepareToken += 1;
    app.file = null;
    app.prepared = null;
    app.preparing = false;
    if (app.previewUrl) URL.revokeObjectURL(app.previewUrl);
    app.previewUrl = null;
    el.file.value = '';
    el.previewImg.removeAttribute('src');
    el.previewImg.hidden = false;
    el.previewIcon.hidden = true;
    el.qualityField.hidden = false;
    el.dropPreview.hidden = true;
    el.dropEmpty.hidden = false;
    setFileError('');
    updateSendControls();
  }

  async function prepareImage(file, presetName) {
    const preset = PRESETS[presetName];
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = bitmap;
      if (presetName === 'original') return { blob: file, width, height, name: file.name, reencoded: false };

      const scale = Math.min(1, preset.edge / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, targetWidth, targetHeight);
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', preset.quality));
      if (!blob) throw new Error('This image could not be processed');
      if (scale === 1 && blob.size >= file.size) {
        return { blob: file, width, height, name: file.name, reencoded: false };
      }
      const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      return { blob, width: targetWidth, height: targetHeight, name, reencoded: true };
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  function showPreview(file, kind) {
    if (app.previewUrl) URL.revokeObjectURL(app.previewUrl);
    app.previewUrl = null;
    const isImage = kind === 'image';
    el.previewImg.hidden = !isImage;
    el.previewIcon.hidden = isImage;
    if (isImage) {
      app.previewUrl = URL.createObjectURL(file);
      el.previewImg.src = app.previewUrl;
    } else {
      el.previewIconUse.setAttribute('href', kind === 'video' ? '#i-video' : '#i-audio');
    }
    el.previewName.textContent = file.name;
    el.previewInfo.textContent = 'Preparing…';
    el.dropEmpty.hidden = true;
    el.dropPreview.hidden = false;
  }

  async function processFile(file) {
    if (!file) return;
    const type = resolveType(file);
    if (!type) {
      setFileError('Supported files: JPEG, PNG, WebP, GIF, MP4, MOV, WebM, MP3, M4A, AAC, OGG, WAV and FLAC.');
      return;
    }
    const kind = kindOf(type);
    setFileError('');

    const token = ++app.prepareToken;
    app.file = file;
    app.preparing = true;
    app.prepared = null;
    updateSendControls();

    el.qualityField.hidden = kind !== 'image';
    showPreview(file, kind);

    try {
      const result =
        kind === 'image'
          ? await prepareImage(file, selectedPreset())
          : { blob: file, width: 0, height: 0, name: file.name, reencoded: false };
      if (token !== app.prepareToken) return;
      app.preparing = false;

      const limit = limitFor(kind);
      if (result.blob.size > limit) {
        el.previewInfo.textContent = `${formatBytes(result.blob.size)} is over the ${formatBytes(limit)} limit`;
        setFileError(
          kind === 'image'
            ? 'This image is too large. Choose a smaller quality setting or a smaller image.'
            : 'This file is too large to send. Choose a shorter or smaller file.'
        );
        updateSendControls();
        return;
      }

      app.prepared = { file, kind, ...result };
      const count = `${formatBytes(result.blob.size)} · ${messageCount(result.blob.size)} messages`;
      el.previewInfo.textContent = kind === 'image' ? `${result.width} × ${result.height} · ${count}` : count;
    } catch {
      if (token !== app.prepareToken) return;
      app.preparing = false;
      el.previewInfo.textContent = 'Unreadable file';
      setFileError('This file could not be read by the browser.');
    }
    updateSendControls();
  }

  const STEP_ORDER = ['sending', 'awaiting', 'cleaning'];

  function showTransfer({ phase, sent = 0, total = 1, title, failed = false, done = false }) {
    el.transfer.hidden = false;
    el.transfer.classList.toggle('is-waiting', phase === 'awaiting' || phase === 'cleaning');
    el.transfer.classList.toggle('is-failed', failed);

    const percent = phase === 'sending' ? Math.min(100, Math.round((sent / total) * 100)) : 100;
    el.transferFill.style.width = `${failed ? Math.max(percent, 6) : percent}%`;
    el.transferPercent.textContent = failed ? '' : `${percent}%`;
    el.transferTitle.textContent = title;

    const activeIndex = done ? STEP_ORDER.length : STEP_ORDER.indexOf(phase);
    for (const item of el.transferSteps.children) {
      const index = STEP_ORDER.indexOf(item.dataset.step);
      let state = 'pending';
      if (index < activeIndex) state = 'done';
      else if (index === activeIndex) state = failed ? 'failed' : 'active';
      item.dataset.state = state;
    }
  }

  function endSend() {
    app.sending = false;
    app.sendId = null;
    updateSendControls();
  }

  function onSendProgress(data) {
    if (!app.sendId && app.sending) app.sendId = data.id;
    if (data.id !== app.sendId) return;
    app.sending = true;
    const titles = {
      sending: `Sending messages (${data.sent} of ${data.total})`,
      awaiting: 'Waiting for the recipient to confirm',
      cleaning: 'Delivered. Cleaning the chat'
    };
    showTransfer({ phase: data.phase, sent: data.sent, total: data.total, title: titles[data.phase] });
    updateSendControls();
  }

  function onSendDone(data) {
    if (data.id !== app.sendId) return;
    showTransfer({
      phase: 'cleaning',
      done: true,
      title: data.cleaned ? 'Delivered. Chat cleaned' : 'Delivered. Some messages could not be removed'
    });
    if (!data.cleaned) toast('The file was delivered, but some transfer messages are still in your chat.', 'warn');
    endSend();
    clearFile();
  }

  function onSendFailed(data) {
    if (data.id !== app.sendId) return;
    showTransfer({ phase: 'sending', failed: true, sent: 0, total: 1, title: data.message || 'The transfer failed' });
    toast(data.message || 'The transfer failed', 'error');
    endSend();
  }

  function renderIncoming() {
    el.incoming.replaceChildren();
    for (const row of app.incoming.values()) {
      const node = create('div', 'incoming__row');
      const top = create('div', 'incoming__top');
      top.append(create('span', '', `Receiving from ${row.from}`), create('span', '', `${row.received} / ${row.total}`));
      const bar = create('div', 'bar');
      const fill = create('div', 'bar__fill');
      fill.style.width = `${Math.min(100, Math.round((row.received / row.total) * 100))}%`;
      bar.appendChild(fill);
      node.append(top, bar);
      el.incoming.appendChild(node);
    }
  }

  function renderGallery() {
    const items = [...app.received.values()].sort((a, b) => b.receivedAt - a.receivedAt);
    el.gallery.replaceChildren();
    el.empty.hidden = items.length > 0 || app.incoming.size > 0;
    for (const item of items) {
      const kind = kindOf(item.mime);
      const entry = create('li');
      const tile = create('button', 'tile');
      tile.type = 'button';
      if (kind !== 'image') tile.append(create('span', 'tile__badge', kind === 'video' ? 'Video' : 'Audio'));

      if (kind === 'video') {
        const video = create('video');
        video.src = `${item.url}#t=0.1`;
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        tile.append(video);
      } else if (kind === 'audio') {
        const art = create('div', 'tile__art');
        art.innerHTML = '<svg class="icon icon--lg"><use href="#i-audio"></use></svg>';
        tile.append(art);
      } else {
        const image = create('img');
        image.src = item.url;
        image.alt = item.name;
        image.loading = 'lazy';
        tile.append(image);
      }

      const meta = create('div', 'tile__meta');
      meta.append(create('strong', '', item.name), create('span', '', `${item.from} · ${formatBytes(item.size)}`), create('span', '', formatTime(item.receivedAt)));
      tile.append(meta);
      tile.addEventListener('click', () => openViewer(item));
      entry.appendChild(tile);
      el.gallery.appendChild(entry);
    }
  }

  function resetDeleteButton() {
    clearTimeout(app.deleteTimer);
    el.viewerDelete.classList.remove('is-armed');
    el.viewerDelete.querySelector('span').textContent = 'Delete';
  }

  function openViewer(item) {
    app.viewing = item;
    resetDeleteButton();
    const kind = kindOf(item.mime);
    for (const node of [el.viewerImg, el.viewerVideo, el.viewerAudio]) node.hidden = true;
    const target = kind === 'video' ? el.viewerVideo : kind === 'audio' ? el.viewerAudio : el.viewerImg;
    target.src = item.url;
    if (kind === 'image') target.alt = item.name;
    target.hidden = false;
    el.viewerName.textContent = item.name;
    el.viewerMeta.textContent = `${item.from} · ${formatBytes(item.size)} · ${formatTime(item.receivedAt)}`;
    el.viewerDownload.href = item.url;
    el.viewerDownload.setAttribute('download', item.name);
    if (!el.viewer.open) el.viewer.showModal();
  }

  function closeViewer() {
    if (el.viewer.open) el.viewer.close();
  }

  function setReceived(items) {
    app.received = new Map(items.map((item) => [item.id, item]));
    renderGallery();
  }

  socket.on('connect', () => {
    app.online = true;
    renderStatus();
  });

  socket.on('disconnect', () => {
    app.online = false;
    renderStatus();
  });

  socket.on('hello', (data) => {
    app.online = true;
    app.status = data.status;
    app.limits = data.limits;
    setReceived(data.received);
    app.incoming = new Map(data.active.receiving.map((row) => [row.id, row]));
    renderIncoming();
    renderGallery();
    const current = data.active.sending[0];
    if (current && !app.sending) {
      app.sending = true;
      app.sendId = current.id;
      onSendProgress(current);
    }
    renderStatus();
  });

  socket.on('status', (status) => {
    app.status = status;
    renderStatus();
  });

  socket.on('send:progress', onSendProgress);
  socket.on('send:done', onSendDone);
  socket.on('send:failed', onSendFailed);

  socket.on('receive:progress', (data) => {
    app.incoming.set(data.id, data);
    renderIncoming();
    el.empty.hidden = true;
  });

  socket.on('receive:done', ({ id, item }) => {
    app.incoming.delete(id);
    app.received.set(item.id, item);
    renderIncoming();
    renderGallery();
    toast(`File received from ${item.from}`);
  });

  socket.on('receive:cleaned', (data) => {
    if (!data.cleaned) toast('The file was saved, but some transfer messages are still in your chat.', 'warn');
  });

  socket.on('receive:failed', (data) => {
    app.incoming.delete(data.id);
    renderIncoming();
    renderGallery();
    toast(`Incoming transfer failed: ${data.message}`, 'error');
  });

  socket.on('received:removed', ({ id }) => {
    app.received.delete(id);
    if (app.viewing && app.viewing.id === id) closeViewer();
    renderGallery();
  });

  el.pairForm.addEventListener('submit', (event) => {
    event.preventDefault();
    el.pairError.hidden = true;
    if (!isValidPhone(el.pairPhone.value)) {
      el.pairError.textContent = 'Enter your phone number with the country code, digits only.';
      el.pairError.hidden = false;
      return;
    }
    el.pairSubmit.disabled = true;
    socket.emit('pair', { phone: el.pairPhone.value }, (reply) => {
      el.pairSubmit.disabled = false;
      if (!reply || !reply.ok) {
        el.pairError.textContent = (reply && reply.error) || 'Could not get a pairing code.';
        el.pairError.hidden = false;
      }
    });
  });

  el.copyCode.addEventListener('click', async () => {
    const code = app.status.pairingCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('Pairing code copied');
    } catch {
      toast('Copy is not available in this browser', 'warn');
    }
  });

  el.drop.addEventListener('click', (event) => {
    if (event.target.closest('#clearFile')) return;
    el.file.click();
  });

  el.drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      el.file.click();
    }
  });

  el.drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    el.drop.classList.add('is-over');
  });

  el.drop.addEventListener('dragleave', () => el.drop.classList.remove('is-over'));

  el.drop.addEventListener('drop', (event) => {
    event.preventDefault();
    el.drop.classList.remove('is-over');
    const file = event.dataTransfer.files[0];
    if (file) processFile(file);
  });

  el.file.addEventListener('change', () => {
    if (el.file.files[0]) processFile(el.file.files[0]);
  });

  el.clearFile.addEventListener('click', (event) => {
    event.stopPropagation();
    clearFile();
  });

  for (const radio of document.querySelectorAll('input[name="quality"]')) {
    radio.addEventListener('change', () => {
      el.qualityHint.textContent = PRESETS[selectedPreset()].hint;
      if (app.file) processFile(app.file);
    });
  }

  el.recipient.addEventListener('change', () => writeStored(el.recipient.value));

  el.sendForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (el.sendBtn.disabled || !app.prepared) return;
    if (!isValidPhone(el.recipient.value)) {
      toast('Enter the recipient number with the country code, digits only.', 'error');
      el.recipient.focus();
      return;
    }

    writeStored(el.recipient.value);
    app.sending = true;
    app.sendId = null;
    updateSendControls();
    showTransfer({ phase: 'sending', sent: 0, total: messageCount(app.prepared.blob.size), title: 'Starting the transfer' });

    const data = await app.prepared.blob.arrayBuffer();
    socket.emit('send', { phone: el.recipient.value, name: app.prepared.name, data }, (reply) => {
      if (!reply || !reply.ok) {
        endSend();
        el.transfer.hidden = true;
        toast((reply && reply.error) || 'Could not start the transfer.', 'error');
        return;
      }
      if (!app.sendId) app.sendId = reply.id;
    });
  });

  el.viewerClose.addEventListener('click', closeViewer);

  el.viewer.addEventListener('click', (event) => {
    if (event.target === el.viewer) closeViewer();
  });

  el.viewer.addEventListener('close', () => {
    resetDeleteButton();
    for (const node of [el.viewerVideo, el.viewerAudio]) {
      node.pause();
      node.removeAttribute('src');
      node.load();
    }
    el.viewerImg.removeAttribute('src');
    app.viewing = null;
  });

  el.viewerDelete.addEventListener('click', () => {
    if (!app.viewing) return;
    if (!el.viewerDelete.classList.contains('is-armed')) {
      el.viewerDelete.classList.add('is-armed');
      el.viewerDelete.querySelector('span').textContent = 'Click again to confirm';
      app.deleteTimer = setTimeout(resetDeleteButton, 3500);
      return;
    }
    const { id } = app.viewing;
    resetDeleteButton();
    socket.emit('received:delete', { id }, (reply) => {
      if (!reply || !reply.ok) toast('Could not delete the file.', 'error');
    });
  });

  el.recipient.value = readStored();
  el.qualityHint.textContent = PRESETS[selectedPreset()].hint;
  renderStatus();
  renderGallery();
})();
