const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const TRANSPORT_SYNC_PLAYING_DRIFT_TOLERANCE_MS = 350;
const TRANSPORT_SYNC_PAUSED_DRIFT_TOLERANCE_MS = 120;
const AUDIO_PREFS_STORAGE_KEY = "lossless-player-audio-prefs";

function readPersistedAudioPrefs() {
  if (typeof window === "undefined") {
    return { volume: 0.15, muted: false };
  }

  try {
    const raw = window.localStorage.getItem(AUDIO_PREFS_STORAGE_KEY);
    if (!raw) {
      return { volume: 0.15, muted: false };
    }

    const parsed = JSON.parse(raw);
    const volume = Number(parsed?.volume);
    const muted = Boolean(parsed?.muted);

    return {
      volume: Number.isFinite(volume) ? clamp(volume, 0, 1) : 0.15,
      muted
    };
  } catch {
    return { volume: 0.15, muted: false };
  }
}

function persistAudioPrefs(volume, muted) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      AUDIO_PREFS_STORAGE_KEY,
      JSON.stringify({
        volume: clamp(Number(volume), 0, 1),
        muted: Boolean(muted)
      })
    );
  } catch {
    // ignore storage failures
  }
}

function waitForEvent(target, eventName) {
  return new Promise((resolve) => {
    const handle = () => resolve();
    target.addEventListener(eventName, handle, { once: true });
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildDescriptorKey(descriptor) {
  return descriptor ? `${descriptor.mode}:${descriptor.assetId}` : "";
}

function getAudioContextConstructor() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.AudioContext ?? window.webkitAudioContext ?? null;
}

function resolvePlaybackManifestUrls(manifest, manifestUrl) {
  if (!manifest || !manifestUrl) {
    return manifest;
  }

  return {
    ...manifest,
    segments: (manifest.segments ?? []).map((segment) => ({
      ...segment,
      url: new URL(segment.url, manifestUrl).toString()
    }))
  };
}

function readFourCc(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function decodePcmSample(view, offset, formatTag, bitsPerSample) {
  if (formatTag === 3 && bitsPerSample === 32) {
    return clamp(view.getFloat32(offset, true), -1, 1);
  }

  if (bitsPerSample === 8) {
    return (view.getUint8(offset) - 128) / 128;
  }

  if (bitsPerSample === 16) {
    return view.getInt16(offset, true) / 32768;
  }

  if (bitsPerSample === 24) {
    let value =
      view.getUint8(offset) |
      (view.getUint8(offset + 1) << 8) |
      (view.getUint8(offset + 2) << 16);

    if (value & 0x800000) {
      value |= ~0xffffff;
    }

    return value / 8388608;
  }

  if (bitsPerSample === 32) {
    return view.getInt32(offset, true) / 2147483648;
  }

  throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
}

function decodeWavChunk(arrayBuffer, audioContext) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 44 || readFourCc(view, 0) !== "RIFF" || readFourCc(view, 8) !== "WAVE") {
    throw new Error("Chunked lossless playback expected a valid WAV chunk.");
  }

  let formatTag = null;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readFourCc(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16) {
      const rawFormatTag = view.getUint16(chunkDataOffset, true);
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      blockAlign = view.getUint16(chunkDataOffset + 12, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);

      if (rawFormatTag === 0xfffe && chunkSize >= 40) {
        formatTag = view.getUint16(chunkDataOffset + 24, true);
      } else {
        formatTag = rawFormatTag;
      }
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = Math.min(chunkSize, Math.max(0, view.byteLength - chunkDataOffset));
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!formatTag || !channels || !sampleRate || !blockAlign || !bitsPerSample || dataOffset < 0 || dataSize <= 0) {
    throw new Error("Chunked lossless playback could not parse WAV chunk metadata.");
  }

  if (formatTag !== 1 && formatTag !== 3) {
    throw new Error(`Unsupported WAV audio format: ${formatTag}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error(`Unsupported WAV sample size: ${bitsPerSample}`);
  }

  const frameCount = Math.floor(dataSize / blockAlign);
  const audioBuffer = audioContext.createBuffer(channels, frameCount, sampleRate);
  const channelData = Array.from({ length: channels }, (_, channelIndex) => audioBuffer.getChannelData(channelIndex));

  let sampleOffset = dataOffset;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      channelData[channelIndex][frameIndex] = decodePcmSample(view, sampleOffset, formatTag, bitsPerSample);
      sampleOffset += bytesPerSample;
    }
  }

  return audioBuffer;
}

async function decodeChunkAudio(arrayBuffer, audioContext, chunkMimeType) {
  const normalizedMimeType = (chunkMimeType ?? "").toLowerCase();
  if (normalizedMimeType === "audio/wav" || normalizedMimeType === "audio/wave") {
    return decodeWavChunk(arrayBuffer, audioContext);
  }

  try {
    return await audioContext.decodeAudioData(arrayBuffer);
  } catch {
    return audioContext.decodeAudioData(arrayBuffer.slice(0));
  }
}

function findSegmentIndex(manifest, positionMs) {
  if (!manifest?.segments?.length) {
    return 0;
  }

  const clampedPositionMs = clamp(positionMs, 0, manifest.durationMs);
  const segmentIndex = manifest.segments.findIndex(
    (segment) => clampedPositionMs >= segment.startMs && clampedPositionMs < segment.endMs
  );

  if (segmentIndex >= 0) {
    return segmentIndex;
  }

  return manifest.segments.length - 1;
}

export class PlaybackService {
  constructor() {
    const persistedPrefs = readPersistedAudioPrefs();
    this.audio = null;
    this.audioMount = null;
    this.audioToken = 0;
    this.audioContext = null;
    this.gainNode = null;
    this.currentDescriptor = null;
    this.currentDescriptorKey = "";
    this.loadingDescriptorKey = "";
    this.loadingPromise = null;
    this.manifest = null;
    this.timer = null;
    this.progressFrame = null;
    this.listeners = new Set();
    this.lastError = null;
    this.unlocked = false;
    this.endedCount = 0;
    this.endedNotified = false;
    this.currentTimeMs = 0;
    this.durationMs = 0;
    this.paused = true;
    this.volume = persistedPrefs.volume;
    this.muted = persistedPrefs.muted;
    this.capabilityAudio = typeof Audio !== "undefined" ? new Audio() : null;
    this.chunkFetchControllers = new Map();
    this.chunkBufferPromises = new Map();
    this.chunkBuffers = new Map();
    this.chunkGeneration = 0;
    this.chunkPlayback = null;
    this.chunkCleanupTimer = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    this.currentTimeMs = this.computeCurrentTimeMs();

    for (const listener of this.listeners) {
      listener({
        currentTimeMs: this.currentTimeMs,
        paused: this.paused,
        durationMs: this.durationMs,
        volume: this.volume,
        muted: this.muted,
        errorMessage: this.lastError,
        endedCount: this.endedCount
      });
    }
  }

  getCapabilities() {
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isChromiumEngine = /(Chrome|Chromium|Edg)\//.test(userAgent) && !/OPR\//.test(userAgent);

    const canPlayAny = (types) => {
      if (!this.capabilityAudio) {
        return false;
      }

      return types.some((type) => this.capabilityAudio.canPlayType(type) !== "");
    };

    const supportsDirectFlac =
      isChromiumEngine || canPlayAny(["audio/flac", "audio/x-flac", "audio/flac; codecs=flac"]);
    const supportsDirectMp3 = canPlayAny(["audio/mpeg", "audio/mp3"]);
    const supportsDirectWav = canPlayAny(["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"]);
    const supportsDirectAiff = canPlayAny(["audio/aiff", "audio/x-aiff"]);

    return {
      mimeTypes: ["audio/flac", "audio/mpeg", "audio/wav", "audio/aiff"],
      supportsFlac: supportsDirectFlac,
      supportsMp3: supportsDirectMp3,
      supportsWav: supportsDirectWav,
      supportsAiff: supportsDirectAiff,
      supportsMseFlacSegmented: false
    };
  }

  computeCurrentTimeMs() {
    if (this.currentDescriptor?.mode === "lossless_chunked" && this.chunkPlayback) {
      if (this.chunkPlayback.playing && this.audioContext) {
        const elapsedMs = Math.max(0, Math.round((this.audioContext.currentTime - this.chunkPlayback.playbackStartContextTime) * 1000));
        const nextTimeMs = clamp(this.chunkPlayback.playbackStartPositionMs + elapsedMs, 0, this.durationMs);
        this.currentTimeMs = nextTimeMs;
      } else {
        this.currentTimeMs = Math.max(0, Math.round(this.chunkPlayback.pausedPositionMs ?? this.currentTimeMs));
      }

      return Math.max(0, Math.round(this.currentTimeMs));
    }

    if (!this.audio) {
      return Math.max(0, Math.round(this.currentTimeMs));
    }

    const nextTimeMs = Math.round(this.audio.currentTime * 1000);
    if (!Number.isNaN(nextTimeMs)) {
      this.currentTimeMs = nextTimeMs;
    }

    return Math.max(0, Math.round(this.currentTimeMs));
  }

  startProgressLoop() {
    if (this.progressFrame) {
      return;
    }

    const tick = () => {
      if (this.paused) {
        this.progressFrame = null;
        return;
      }

      this.emit();
      this.progressFrame = window.requestAnimationFrame(tick);
    };

    this.progressFrame = window.requestAnimationFrame(tick);
  }

  stopProgressLoop() {
    if (this.progressFrame) {
      window.cancelAnimationFrame(this.progressFrame);
      this.progressFrame = null;
    }
  }

  clearTimer() {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stopChunkCleanupLoop() {
    if (this.chunkCleanupTimer) {
      window.clearInterval(this.chunkCleanupTimer);
      this.chunkCleanupTimer = null;
    }
  }

  cleanupChunkWindow() {
    if (!this.manifest || !this.chunkPlayback) {
      return;
    }

    const activePositionMs = this.chunkPlayback.playing
      ? this.computeCurrentTimeMs()
      : Math.max(0, Math.round(this.chunkPlayback.pausedPositionMs ?? this.currentTimeMs));
    const currentChunkIndex = findSegmentIndex(this.manifest, activePositionMs);
    const keepIndices = new Set(
      [currentChunkIndex, currentChunkIndex + 1].filter(
        (index) => index >= 0 && index < this.manifest.segments.length
      )
    );

    for (const [segmentIndex, controller] of this.chunkFetchControllers.entries()) {
      if (!keepIndices.has(segmentIndex)) {
        controller.abort();
        this.chunkFetchControllers.delete(segmentIndex);
        this.chunkBufferPromises.delete(segmentIndex);
      }
    }

    for (const segmentIndex of Array.from(this.chunkBuffers.keys())) {
      if (!keepIndices.has(segmentIndex)) {
        this.chunkBuffers.delete(segmentIndex);
      }
    }
  }

  startChunkCleanupLoop() {
    if (this.chunkCleanupTimer || typeof window === "undefined") {
      return;
    }

    if (window.performance?.setResourceTimingBufferSize) {
      window.performance.setResourceTimingBufferSize(32);
    }

    this.chunkCleanupTimer = window.setInterval(() => {
      this.cleanupChunkWindow();
      window.performance?.clearResourceTimings?.();
    }, 300);
  }

  applyAudioVolume() {
    if (this.audio) {
      this.audio.volume = this.muted ? 0 : this.volume;
      this.audio.muted = this.muted;
    }

    if (this.gainNode?.gain) {
      this.gainNode.gain.value = this.muted ? 0 : this.volume;
    }
  }

  createAudioElement() {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.crossOrigin = "anonymous";
    audio.playsInline = true;
    audio.style.position = "fixed";
    audio.style.width = "0";
    audio.style.height = "0";
    audio.style.opacity = "0";
    audio.style.pointerEvents = "none";
    audio.style.inset = "auto";
    audio.setAttribute("aria-hidden", "true");

    const token = ++this.audioToken;
    audio.onloadedmetadata = () => {
      if (this.audioToken !== token) {
        return;
      }

      if (Number.isFinite(audio.duration)) {
        this.durationMs = Math.max(0, Math.round(audio.duration * 1000));
      }
      this.emit();
    };
    audio.ondurationchange = () => {
      if (this.audioToken !== token) {
        return;
      }

      if (Number.isFinite(audio.duration)) {
        this.durationMs = Math.max(0, Math.round(audio.duration * 1000));
      }
      this.emit();
    };
    audio.onpause = () => {
      if (this.audioToken !== token) {
        return;
      }

      this.paused = true;
      this.stopProgressLoop();
      this.emit();
    };
    audio.onplay = () => {
      if (this.audioToken !== token) {
        return;
      }

      this.endedNotified = false;
      this.paused = false;
      this.lastError = null;
      this.startProgressLoop();
      this.emit();
    };
    audio.onended = () => {
      if (this.audioToken !== token) {
        return;
      }

      this.finalizePlaybackEnded();
    };
    audio.onerror = () => {
      if (this.audioToken !== token) {
        return;
      }

      this.lastError = "The browser could not continue audio playback.";
      this.emit();
    };

    this.audio = audio;
    if (typeof document !== "undefined" && document.body && !audio.isConnected) {
      document.body.appendChild(audio);
      this.audioMount = audio;
    }
    this.applyAudioVolume();
    return audio;
  }

  destroyAudioElement() {
    if (!this.audio) {
      return;
    }

    const audio = this.audio;
    this.audio = null;
    audio.onloadedmetadata = null;
    audio.ondurationchange = null;
    audio.onpause = null;
    audio.onplay = null;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      // noop
    }
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {
      // noop
    }
    if (audio.isConnected) {
      audio.remove();
    }
    if (this.audioMount === audio) {
      this.audioMount = null;
    }
  }

  async ensureAudioContext() {
    if (this.audioContext && this.audioContext.state !== "closed") {
      return this.audioContext;
    }

    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor) {
      throw new Error("Chunked lossless playback requires Web Audio support on this device.");
    }

    this.audioContext = new AudioContextCtor();
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    this.applyAudioVolume();
    return this.audioContext;
  }

  async arm() {
    const audioContext = await this.ensureAudioContext();
    await audioContext.resume();

    const unlockBuffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    const unlockSource = audioContext.createBufferSource();
    unlockSource.buffer = unlockBuffer;
    unlockSource.connect(this.gainNode);
    unlockSource.start();
    unlockSource.stop(audioContext.currentTime + 0.001);
    unlockSource.disconnect();

    if (this.audio) {
      const previousMuted = this.audio.muted;
      const previousVolume = this.audio.volume;
      this.audio.muted = true;
      this.audio.volume = 0;
      try {
        await this.audio.play();
        this.audio.pause();
      } finally {
        this.audio.muted = previousMuted;
        this.audio.volume = previousVolume;
        this.applyAudioVolume();
      }
    } else {
      const audio = new Audio(SILENT_WAV_DATA_URI);
      audio.volume = 0;
      await audio.play();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }

    this.unlocked = true;
    this.lastError = null;
    this.emit();
    return true;
  }

  abortChunkFetches() {
    for (const controller of this.chunkFetchControllers.values()) {
      controller.abort();
    }
    this.chunkFetchControllers.clear();
    this.chunkBufferPromises.clear();
  }

  clearChunkBuffers() {
    this.chunkBuffers.clear();
  }

  async releaseChunkAudioContext() {
    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = null;
      this.gainNode = null;
      return;
    }

    try {
      await this.audioContext.close();
    } catch {
      // noop
    }

    this.audioContext = null;
    this.gainNode = null;
  }

  disposeChunkSource(source, options = {}) {
    if (!source) {
      return;
    }

    source.onended = null;

    if (options.stop) {
      try {
        source.stop();
      } catch {
        // noop
      }
    }

    try {
      source.disconnect();
    } catch {
      // noop
    }

    try {
      source.buffer = null;
    } catch {
      // noop
    }
  }

  stopChunkSources() {
    if (!this.chunkPlayback) {
      return;
    }

    const { currentSource, nextSource } = this.chunkPlayback;
    for (const source of [currentSource, nextSource]) {
      this.disposeChunkSource(source, { stop: true });
    }

    this.chunkPlayback.currentSource = null;
    this.chunkPlayback.nextSource = null;
  }

  async teardownTrack() {
    const shouldReleaseChunkAudioContext = this.currentDescriptor?.mode === "lossless_chunked";
    this.clearTimer();
    this.stopProgressLoop();
    this.stopChunkCleanupLoop();
    this.chunkGeneration += 1;
    this.abortChunkFetches();
    this.stopChunkSources();
    this.clearChunkBuffers();
    this.chunkPlayback = null;
    this.manifest = null;
    this.loadingDescriptorKey = "";
    this.loadingPromise = null;
    this.currentDescriptor = null;
    this.currentDescriptorKey = "";
    this.endedNotified = false;
    this.lastError = null;
    this.currentTimeMs = 0;
    this.durationMs = 0;
    this.paused = true;
    if (shouldReleaseChunkAudioContext) {
      await this.releaseChunkAudioContext();
    }
    this.destroyAudioElement();
  }

  resetViewState() {
    this.currentTimeMs = 0;
    this.durationMs = 0;
    this.paused = true;
    this.endedNotified = false;
    this.lastError = null;
  }

  finalizePlaybackEnded() {
    if (this.endedNotified) {
      return;
    }

    this.endedNotified = true;
    this.paused = true;
    this.stopProgressLoop();
    this.currentTimeMs = this.durationMs;
    this.endedCount += 1;
    this.emit();
  }

  async fetchArrayBuffer(url, controllerCollection = null) {
    const controller = new AbortController();
    if (controllerCollection) {
      controllerCollection.push(controller);
    }

    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Track fetch failed with ${response.status}`);
    }

    return response.arrayBuffer();
  }

  async fetchJson(url, controllerCollection = null) {
    const controller = new AbortController();
    if (controllerCollection) {
      controllerCollection.push(controller);
    }

    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Manifest fetch failed with ${response.status}`);
    }

    return response.json();
  }

  clearPrewarm() {
    // No-op. Chunked playback no longer keeps next-track prewarm state.
  }

  async createDirectAudio(descriptor) {
    const audio = this.createAudioElement();
    audio.src = descriptor.streamUrl;
    audio.load();
    this.currentDescriptor = descriptor;
    this.currentDescriptorKey = buildDescriptorKey(descriptor);
    this.paused = true;

    await Promise.race([
      waitForEvent(audio, "loadedmetadata"),
      waitForEvent(audio, "canplay")
    ]);

    if (Number.isFinite(audio.duration)) {
      this.durationMs = Math.max(0, Math.round(audio.duration * 1000));
    }
    this.emit();
  }

  async setupLosslessChunked(descriptor, startPositionMs = 0) {
    await this.ensureAudioContext();
    const manifest = resolvePlaybackManifestUrls(await this.fetchJson(descriptor.manifestUrl), descriptor.manifestUrl);

    this.currentDescriptor = descriptor;
    this.currentDescriptorKey = buildDescriptorKey(descriptor);
    this.manifest = manifest;
    this.durationMs = manifest.durationMs;
    this.currentTimeMs = Math.max(0, Math.round(startPositionMs));
    this.chunkPlayback = {
      generation: this.chunkGeneration,
      playbackStartContextTime: 0,
      playbackStartPositionMs: Math.max(0, Math.round(startPositionMs)),
      pausedPositionMs: Math.max(0, Math.round(startPositionMs)),
      currentChunkIndex: findSegmentIndex(manifest, startPositionMs),
      currentChunkStartContextTime: 0,
      currentChunkOffsetSeconds: 0,
      nextChunkIndex: -1,
      nextChunkStartContextTime: null,
      currentSource: null,
      nextSource: null,
      playing: false
    };
    this.startChunkCleanupLoop();
    this.emit();
  }

  async loadPlaybackDescriptor(descriptor, options = {}) {
    const startPositionMs = Math.max(0, Math.round(options.startPositionMs ?? 0));
    const forceReload = Boolean(options.forceReload);
    const descriptorKey = buildDescriptorKey(descriptor);

    if (!descriptorKey) {
      return;
    }

    if (!forceReload && this.currentDescriptorKey === descriptorKey && this.currentDescriptor?.mode === descriptor.mode) {
      return;
    }

    if (!forceReload && this.loadingDescriptorKey === descriptorKey && this.loadingPromise) {
      await this.loadingPromise;
      return;
    }

    const preservedVolume = this.volume;
    const preservedMuted = this.muted;
    this.loadingDescriptorKey = descriptorKey;

    this.loadingPromise = (async () => {
      await this.teardownTrack();
      this.volume = preservedVolume;
      this.muted = preservedMuted;
      this.resetViewState();

      if (descriptor.mode === "lossless_chunked") {
        await this.setupLosslessChunked(descriptor, startPositionMs);
      } else {
        await this.createDirectAudio(descriptor);
      }

      this.applyAudioVolume();
      this.loadingDescriptorKey = "";
      this.loadingPromise = null;
    })().catch((error) => {
      this.loadingDescriptorKey = "";
      this.loadingPromise = null;
      const message = error instanceof Error ? error.message : "The browser could not prepare this audio stream.";
      this.lastError = message;
      this.emit();
      throw error;
    });

    await this.loadingPromise;
  }

  async fetchAndDecodeChunk(segmentIndex, generation) {
    if (!this.manifest || segmentIndex < 0 || segmentIndex >= this.manifest.segments.length) {
      return null;
    }

    if (this.chunkBuffers.has(segmentIndex)) {
      return this.chunkBuffers.get(segmentIndex);
    }

    if (this.chunkBufferPromises.has(segmentIndex)) {
      return this.chunkBufferPromises.get(segmentIndex);
    }

    const audioContext = await this.ensureAudioContext();
    const controller = new AbortController();
    this.chunkFetchControllers.set(segmentIndex, controller);

    const promise = (async () => {
      const segment = this.manifest.segments[segmentIndex];
      const response = await fetch(segment.url, {
        cache: "no-store",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Chunk fetch failed with ${response.status}`);
      }

      const rawData = await response.arrayBuffer();
      if (controller.signal.aborted || generation !== this.chunkGeneration) {
        return null;
      }

      const decoded = await decodeChunkAudio(
        rawData,
        audioContext,
        this.currentDescriptor?.chunkMimeType ?? this.manifest?.chunkMimeType
      );
      if (generation !== this.chunkGeneration) {
        return null;
      }

      this.chunkBuffers.set(segmentIndex, decoded);
      return decoded;
    })()
      .finally(() => {
        this.chunkFetchControllers.delete(segmentIndex);
        this.chunkBufferPromises.delete(segmentIndex);
      });

    this.chunkBufferPromises.set(segmentIndex, promise);
    return promise;
  }

  trimChunkBuffers(currentChunkIndex) {
    const keepIndices = new Set([currentChunkIndex, currentChunkIndex + 1]);
    for (const segmentIndex of Array.from(this.chunkBuffers.keys())) {
      if (!keepIndices.has(segmentIndex)) {
        this.chunkBuffers.delete(segmentIndex);
      }
    }
  }

  async primeChunkWindow(currentChunkIndex, generation) {
    await Promise.all([
      this.fetchAndDecodeChunk(currentChunkIndex, generation),
      this.fetchAndDecodeChunk(currentChunkIndex + 1, generation)
    ]);
    this.trimChunkBuffers(currentChunkIndex);
  }

  createChunkSource(segmentIndex, buffer, startAtSeconds, offsetSeconds, generation) {
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.onended = () => {
      this.disposeChunkSource(source);
      this.handleChunkEnded(segmentIndex, generation).catch((error) => {
        const message = error instanceof Error ? error.message : "Chunk playback failed.";
        this.lastError = message;
        this.emit();
      });
    };
    source.start(startAtSeconds, Math.max(0, offsetSeconds));
    return source;
  }

  async scheduleUpcomingChunk(generation) {
    if (!this.manifest || !this.chunkPlayback || generation !== this.chunkGeneration) {
      return;
    }

    const nextChunkIndex = this.chunkPlayback.currentChunkIndex + 1;
    if (nextChunkIndex >= this.manifest.segments.length) {
      this.chunkPlayback.nextChunkIndex = -1;
      this.chunkPlayback.nextSource = null;
      return;
    }

    const currentBuffer =
      this.chunkBuffers.get(this.chunkPlayback.currentChunkIndex) ??
      (await this.fetchAndDecodeChunk(this.chunkPlayback.currentChunkIndex, generation));
    const nextBuffer = await this.fetchAndDecodeChunk(nextChunkIndex, generation);
    if (!currentBuffer || !nextBuffer || !this.chunkPlayback || generation !== this.chunkGeneration) {
      return;
    }

    const startAtSeconds =
      this.chunkPlayback.currentChunkStartContextTime +
      Math.max(0, currentBuffer.duration - this.chunkPlayback.currentChunkOffsetSeconds);

    this.chunkPlayback.nextChunkIndex = nextChunkIndex;
    this.chunkPlayback.nextChunkStartContextTime = startAtSeconds;
    this.chunkPlayback.nextSource = this.createChunkSource(nextChunkIndex, nextBuffer, startAtSeconds, 0, generation);

    this.trimChunkBuffers(this.chunkPlayback.currentChunkIndex);
  }

  async handleChunkEnded(segmentIndex, generation) {
    if (
      generation !== this.chunkGeneration ||
      !this.chunkPlayback ||
      this.paused ||
      !this.manifest
    ) {
      return;
    }

    const isCurrentChunk = segmentIndex === this.chunkPlayback.currentChunkIndex;
    const isLastSegment = segmentIndex >= this.manifest.segments.length - 1;

    if (!isCurrentChunk && !isLastSegment) {
      return;
    }

    if (isLastSegment) {
      this.stopChunkSources();
      this.clearChunkBuffers();
      this.chunkPlayback.playing = false;
      this.chunkPlayback.pausedPositionMs = this.durationMs;
      this.finalizePlaybackEnded();
      return;
    }

    const nextChunkIndex = segmentIndex + 1;
    this.chunkPlayback.currentChunkIndex = nextChunkIndex;
    this.chunkPlayback.currentSource = this.chunkPlayback.nextSource;
    this.chunkPlayback.nextSource = null;
    this.chunkPlayback.currentChunkStartContextTime =
      this.chunkPlayback.nextChunkStartContextTime ?? this.audioContext.currentTime;
    this.chunkPlayback.currentChunkOffsetSeconds = 0;
    this.chunkPlayback.pausedPositionMs = nextChunkIndex < this.manifest.segments.length
      ? this.manifest.segments[nextChunkIndex].startMs
      : this.durationMs;
    this.chunkPlayback.nextChunkStartContextTime = null;
    this.chunkBuffers.delete(segmentIndex);
    this.trimChunkBuffers(nextChunkIndex);
    await this.scheduleUpcomingChunk(generation);
  }

  async playLosslessChunkedAt(positionMs) {
    if (!this.currentDescriptor || this.currentDescriptor.mode !== "lossless_chunked" || !this.manifest) {
      return;
    }

    const audioContext = await this.ensureAudioContext();
    await audioContext.resume();

    const clampedPositionMs = clamp(Math.max(0, Math.round(positionMs)), 0, this.durationMs || Number.MAX_SAFE_INTEGER);
    const currentChunkIndex = findSegmentIndex(this.manifest, clampedPositionMs);
    const generation = ++this.chunkGeneration;

    this.abortChunkFetches();
    this.stopChunkSources();
    this.clearChunkBuffers();
    await this.primeChunkWindow(currentChunkIndex, generation);

    const currentBuffer = this.chunkBuffers.get(currentChunkIndex);
    if (!currentBuffer || generation !== this.chunkGeneration) {
      return;
    }

    const currentSegment = this.manifest.segments[currentChunkIndex];
    const offsetSeconds = Math.max(0, (clampedPositionMs - currentSegment.startMs) / 1000);
    const playbackStartContextTime = audioContext.currentTime + 0.03;

    this.endedNotified = false;
    this.lastError = null;
    this.chunkPlayback = {
      generation,
      playbackStartContextTime,
      playbackStartPositionMs: clampedPositionMs,
      pausedPositionMs: clampedPositionMs,
      currentChunkIndex,
      currentChunkStartContextTime: playbackStartContextTime,
      currentChunkOffsetSeconds: offsetSeconds,
      nextChunkIndex: -1,
      nextChunkStartContextTime: null,
      currentSource: this.createChunkSource(currentChunkIndex, currentBuffer, playbackStartContextTime, offsetSeconds, generation),
      nextSource: null,
      playing: true
    };

    await this.scheduleUpcomingChunk(generation);
    this.startChunkCleanupLoop();

    this.currentTimeMs = clampedPositionMs;
    this.paused = false;
    this.startProgressLoop();
    this.emit();
  }

  async playAt(positionMs) {
    if (this.currentDescriptor?.mode === "lossless_chunked") {
      await this.playLosslessChunkedAt(positionMs);
      return;
    }

    if (!this.audio) {
      return;
    }

    const clampedPositionMs = Math.max(0, Math.round(positionMs));
    const safeDurationSeconds = this.durationMs > 0 ? this.durationMs / 1000 : Number.MAX_SAFE_INTEGER;
    this.audio.currentTime = clamp(clampedPositionMs / 1000, 0, safeDurationSeconds);
    this.currentTimeMs = clampedPositionMs;
    try {
      await this.audio.play();
    } catch (error) {
      const previousMuted = this.audio.muted;
      const previousVolume = this.audio.volume;
      this.audio.muted = true;
      this.audio.volume = 0;
      let startedMuted = false;
      try {
        await this.audio.play();
        startedMuted = true;
      } finally {
        if (startedMuted) {
          window.setTimeout(() => {
            if (!this.audio) {
              return;
            }

            this.audio.muted = previousMuted;
            this.audio.volume = previousVolume;
            this.applyAudioVolume();
          }, 220);
        } else {
          this.audio.muted = previousMuted;
          this.audio.volume = previousVolume;
          this.applyAudioVolume();
        }
      }

      if (this.audio.paused) {
        throw error;
      }
    }
    this.paused = false;
    this.startProgressLoop();
    this.emit();
  }

  pauseAt(positionMs = this.computeCurrentTimeMs()) {
    const clampedPositionMs = Math.max(0, Math.round(positionMs));

    if (this.currentDescriptor?.mode === "lossless_chunked") {
      this.chunkGeneration += 1;
      this.abortChunkFetches();
      this.stopChunkSources();
      this.clearChunkBuffers();

      if (this.chunkPlayback) {
        this.chunkPlayback.playing = false;
        this.chunkPlayback.pausedPositionMs = clampedPositionMs;
        this.chunkPlayback.playbackStartPositionMs = clampedPositionMs;
        this.chunkPlayback.currentChunkIndex = findSegmentIndex(this.manifest, clampedPositionMs);
        this.chunkPlayback.currentChunkStartContextTime = 0;
        this.chunkPlayback.currentChunkOffsetSeconds = 0;
        this.chunkPlayback.nextChunkIndex = -1;
        this.chunkPlayback.nextChunkStartContextTime = null;
      }

      this.currentTimeMs = clampedPositionMs;
      this.paused = true;
      this.stopProgressLoop();
      this.cleanupChunkWindow();
      this.emit();
      return;
    }

    if (!this.audio) {
      return;
    }

    try {
      this.audio.pause();
    } catch {
      // noop
    }
    this.audio.currentTime = clamp(
      clampedPositionMs / 1000,
      0,
      this.durationMs > 0 ? this.durationMs / 1000 : clampedPositionMs / 1000
    );
    this.currentTimeMs = clampedPositionMs;
    this.paused = true;
    this.stopProgressLoop();
    this.emit();
  }

  async clearSource() {
    await this.teardownTrack();
    this.emit();
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.volume > 0 && this.muted) {
      this.muted = false;
    }
    persistAudioPrefs(this.volume, this.muted);
    this.applyAudioVolume();
    this.emit();
  }

  toggleMute() {
    this.muted = !this.muted;
    persistAudioPrefs(this.volume, this.muted);
    this.applyAudioVolume();
    this.emit();
    return this.muted;
  }

  async deactivate() {
    this.unlocked = false;
    await this.teardownTrack();
    await this.releaseChunkAudioContext();
    this.emit();
  }

  syncTransport(transport, serverTimeMs) {
    this.clearTimer();

    if (!transport.trackId) {
      this.clearSource().catch(() => {});
      return;
    }

    const clockOffsetMs = Number.isFinite(serverTimeMs) ? serverTimeMs - Date.now() : 0;

    const currentServerTimeMs = Date.now() + clockOffsetMs;
    const effectiveElapsedMs = Math.max(0, currentServerTimeMs - transport.effectiveAtMs);
    const targetMs =
      transport.status === "playing"
        ? transport.basePositionMs + effectiveElapsedMs
        : transport.basePositionMs;
    const clampedTargetMs = Math.max(
      0,
      Math.round(this.durationMs ? Math.min(targetMs, this.durationMs) : targetMs)
    );
    const currentMs = this.computeCurrentTimeMs();
    const driftMs = Math.abs(currentMs - clampedTargetMs);

    if (transport.status === "playing" && !this.paused && driftMs <= TRANSPORT_SYNC_PLAYING_DRIFT_TOLERANCE_MS) {
      return;
    }

    if (transport.status !== "playing" && this.paused && driftMs <= TRANSPORT_SYNC_PAUSED_DRIFT_TOLERANCE_MS) {
      return;
    }

    const apply = async () => {
      const currentServerTimeMs = Date.now() + clockOffsetMs;
      const effectiveElapsedMs = Math.max(0, currentServerTimeMs - transport.effectiveAtMs);
      const targetMs =
        transport.status === "playing"
          ? transport.basePositionMs + effectiveElapsedMs
          : transport.basePositionMs;
      const clampedTargetMs = Math.max(
        0,
        Math.round(this.durationMs ? Math.min(targetMs, this.durationMs) : targetMs)
      );

      if (transport.status === "playing" && (!this.durationMs || clampedTargetMs < this.durationMs)) {
        await this.playAt(clampedTargetMs);
        return;
      }

      this.pauseAt(clampedTargetMs);
    };

    const nowServerTimeMs = Date.now() + clockOffsetMs;
    const delay = Math.max(0, transport.effectiveAtMs - nowServerTimeMs);
    if (delay === 0) {
      apply().catch((error) => {
        const message = error instanceof Error ? error.message : "The browser blocked audio playback.";
        this.lastError = message;
        this.emit();
      });
      return;
    }

    this.timer = window.setTimeout(() => {
      apply().catch((error) => {
        const message = error instanceof Error ? error.message : "The browser blocked audio playback.";
        this.lastError = message;
        this.emit();
      });
    }, delay);
  }
}

export const playbackService = new PlaybackService();

if (typeof window !== "undefined") {
  window.__losslessPlaybackService = playbackService;
}
