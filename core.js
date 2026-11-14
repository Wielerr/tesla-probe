/*
 * Pure logic of the probe page: no DOM, no browser APIs.
 * Tested with `node --test`. Loaded in the page as a classic script.
 *
 * Written in ES5 on purpose: one unsupported syntax feature would stop the
 * whole page in an older embedded Chromium.
 */
var ProbeCore = (function () {
  'use strict';

  // ---- level -------------------------------------------------------------

  /** RMS level in dBFS, or null for an empty buffer or digital silence. */
  function rmsDb(samples) {
    var n = samples.length;
    var sum = 0;
    for (var i = 0; i < n; i++) sum += samples[i] * samples[i];
    if (n === 0 || sum === 0) return null;
    return 10 * Math.log(sum / n) / Math.LN10;
  }

  // ---- pitch (YIN, de Cheveigné & Kawahara 2002) -------------------------

  var PITCH_MIN_HZ = 65;
  var PITCH_MAX_HZ = 1400;
  var PITCH_GATE_DB = -55;
  var YIN_THRESHOLD = 0.15;

  /** Fundamental frequency in Hz, or null if the buffer has no clear pitch. */
  function detectPitch(samples, sampleRate) {
    var n = samples.length;
    var level = rmsDb(samples);
    if (level === null || level < PITCH_GATE_DB) return null;

    var tauMax = Math.min(Math.floor(sampleRate / PITCH_MIN_HZ), Math.floor(n / 2));
    var tauMin = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));
    var windowSize = n - tauMax;
    if (tauMax <= tauMin + 1) return null;

    // Cumulative mean normalized difference function.
    var cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;
    var runningSum = 0;
    var tau, j, delta, diff;
    for (tau = 1; tau <= tauMax; tau++) {
      diff = 0;
      for (j = 0; j < windowSize; j++) {
        delta = samples[j] - samples[j + tau];
        diff += delta * delta;
      }
      runningSum += diff;
      cmnd[tau] = runningSum > 0 ? (diff * tau) / runningSum : 1;
    }

    // First dip below the threshold, followed down to its local minimum.
    var best = -1;
    for (tau = tauMin; tau < tauMax; tau++) {
      if (cmnd[tau] < YIN_THRESHOLD) {
        while (tau + 1 < tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) return null;

    // Parabolic interpolation between the neighbouring lags.
    var a = cmnd[best - 1];
    var b = cmnd[best];
    var c = cmnd[best + 1];
    var denominator = a - 2 * b + c;
    var refined = denominator !== 0 ? best + (a - c) / (2 * denominator) : best;

    var freq = sampleRate / refined;
    if (!(freq >= PITCH_MIN_HZ && freq <= PITCH_MAX_HZ)) return null;
    return freq;
  }

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** Nearest note for a frequency: { name: 'A4', midi: 69, cents: -12 }. */
  function noteName(freq) {
    if (typeof freq !== 'number' || !(freq > 0) || !isFinite(freq)) return null;
    var exact = 69 + (12 * Math.log(freq / 440)) / Math.LN2;
    var midi = Math.round(exact);
    return {
      name: NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1),
      midi: midi,
      cents: Math.round((exact - midi) * 100) || 0
    };
  }

  // ---- generated audio ---------------------------------------------------

  /** 16-bit mono PCM WAV file as an ArrayBuffer. */
  function makeWav(samples, sampleRate) {
    var dataSize = samples.length * 2;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);
    function tag(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    tag(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, 'data');
    view.setUint32(40, dataSize, true);
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, Math.round(s * 32767), true);
    }
    return buffer;
  }

  // A3 C4 E4 G4 A4 G4 E4 C4: a calm pentatonic figure in the range of a singing voice.
  var MELODY_HZ = [220, 261.63, 329.63, 392, 440, 392, 329.63, 261.63];
  var MELODY_NOTE_S = 0.5;

  /**
   * Four-second test melody that loops without a click. It stands in for
   * music: several pitches with overtones and note onsets, because echo
   * cancellation treats a steady sine differently from real music.
   */
  function makeMelody(sampleRate) {
    var noteLength = Math.round(sampleRate * MELODY_NOTE_S);
    var attack = Math.max(1, Math.round(sampleRate * 0.01));
    var release = Math.max(1, Math.round(sampleRate * 0.03));
    var out = new Float32Array(noteLength * MELODY_HZ.length);
    for (var n = 0; n < MELODY_HZ.length; n++) {
      var w = (2 * Math.PI * MELODY_HZ[n]) / sampleRate;
      for (var i = 0; i < noteLength; i++) {
        var envelope = Math.exp((-1.6 * i) / noteLength);
        if (i < attack) envelope *= i / attack;
        if (i >= noteLength - release) envelope *= (noteLength - 1 - i) / release;
        var wave = Math.sin(w * i) + 0.35 * Math.sin(2 * w * i) + 0.15 * Math.sin(3 * w * i);
        out[n * noteLength + i] = 0.3 * envelope * wave;
      }
    }
    return out;
  }

  // ---- drive sensor ------------------------------------------------------

  var STALL_MS = 2000;
  var RELEASE_MS = 3000;

  /**
   * Turns observations of the hidden sensor video into 'park', 'drive' or
   * 'unknown'. The page never pauses that video itself, so a pause or a
   * freeze on a visible page is the car's doing.
   *
   * update({ t, available, visible, paused, currentTime }) returns the state.
   */
  function createDriveSensor() {
    var lastTime = null;
    var lastAdvance = 0;
    var playingSince = null;
    var wasVisible = false;

    var sensor = {
      state: 'unknown',
      reason: 'unavailable',
      update: function (x) {
        if (!x.available || !x.visible) {
          sensor.state = 'unknown';
          sensor.reason = x.available ? 'hidden' : 'unavailable';
          wasVisible = false;
          playingSince = null;
          return sensor.state;
        }
        if (!wasVisible) {
          // Browsers pause video on hidden pages themselves: start the freeze timer fresh.
          wasVisible = true;
          lastTime = x.currentTime;
          lastAdvance = x.t;
        }
        if (x.currentTime !== lastTime) {
          lastTime = x.currentTime;
          lastAdvance = x.t;
        }

        var blocked = x.paused ? 'paused' : x.t - lastAdvance >= STALL_MS ? 'stalled' : '';
        if (blocked) {
          sensor.state = 'drive';
          sensor.reason = blocked;
          playingSince = null;
        } else if (sensor.state === 'drive') {
          // The page keeps retrying play(). Only steady playback ends drive mode.
          if (playingSince === null) playingSince = x.t;
          if (x.t - playingSince >= RELEASE_MS) {
            sensor.state = 'park';
            sensor.reason = '';
          }
        } else {
          sensor.state = 'park';
          sensor.reason = '';
        }
        return sensor.state;
      }
    };
    return sensor;
  }

  // ---- ring log ----------------------------------------------------------

  /**
   * Fixed-size log, one storage key per entry plus a meta key, mirrored in
   * memory. `storage` is localStorage or null. Storage errors never throw.
   */
  function createRingLog(storage, prefix, capacity) {
    var memory = [];
    var meta = null;
    var metaKey = prefix + '.meta';

    function get(key) {
      try {
        return storage ? storage.getItem(key) : null;
      } catch (e) {
        return null;
      }
    }
    function set(key, value) {
      if (!storage) return false;
      try {
        storage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    }
    function remove(key) {
      try {
        if (storage) storage.removeItem(key);
      } catch (e) {
        /* nothing to clean up */
      }
    }
    function parse(text) {
      if (text === null || text === undefined) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    }
    function storedMeta() {
      var m = parse(get(metaKey));
      return m && typeof m.head === 'number' && typeof m.count === 'number' && m.cap > 0 ? m : null;
    }

    var log = {
      storageOk: !!storage,

      /** Starts a new run and removes the previous one. */
      reset: function (startMs) {
        var old = storedMeta();
        var slots = Math.max(capacity, old ? old.cap : 0);
        if (old) for (var i = 0; i < slots; i++) remove(prefix + '.' + i);
        memory = [];
        meta = { start: startMs, head: 0, count: 0, cap: capacity };
        log.storageOk = set(metaKey, JSON.stringify(meta));
      },

      /** Appends an entry. Returns false if storage did not take it. */
      push: function (entry) {
        if (!meta) log.reset(entry[0]);
        memory.push(entry);
        if (memory.length > capacity) memory.shift();
        var ok = set(prefix + '.' + meta.head, JSON.stringify(entry));
        meta.head = (meta.head + 1) % capacity;
        meta.count = Math.min(meta.count + 1, capacity);
        ok = set(metaKey, JSON.stringify(meta)) && ok;
        log.storageOk = ok;
        return ok;
      },

      /** read('memory' | 'storage'), or read() for memory with storage as fallback. */
      read: function (source) {
        if (source === 'memory' || (source === undefined && memory.length > 0)) {
          return { source: 'memory', start: meta ? meta.start : null, entries: memory.slice() };
        }
        var m = storedMeta();
        var entries = [];
        if (m) {
          var first = (m.head - m.count + m.cap) % m.cap;
          for (var i = 0; i < m.count; i++) {
            var e = parse(get(prefix + '.' + ((first + i) % m.cap)));
            if (e && e.length) entries.push(e);
          }
        }
        return { source: 'storage', start: m ? m.start : null, entries: entries };
      }
    };
    return log;
  }

  // ---- evaluation --------------------------------------------------------

  // Log entry layout: [timeMs, drive, mic, levelDb, tone, fps]
  var DRIVE = { PARK: 0, DRIVE: 1, UNKNOWN: 2 };
  var MIC = { NONE: 0, LIVE: 1, MUTED: 2, ENDED: 3 };
  var MIN_DRIVE_S = 5;
  var FPS_OK = 25;
  var FPS_WARN = 10;

  function shareVerdict(share) {
    return share >= 0.95 ? 'ok' : share >= 0.05 ? 'partial' : 'fail';
  }

  /**
   * Summarizes a drive-test log. If the sensor saw at least 5 driving
   * seconds, the verdicts cover only those (basis 'drive'), otherwise the
   * whole log (basis 'all').
   */
  function evaluate(entries) {
    var count = entries.length;
    var result = {
      count: count,
      startMs: null,
      endMs: null,
      durationS: 0,
      gapS: 0,
      driveS: 0,
      parkS: 0,
      unknownS: 0,
      basis: 'none',
      mic: { verdict: 'nodata', share: 0, meanDb: null },
      tone: { verdict: 'nodata', share: 0 },
      canvas: { verdict: 'nodata', share: 0, medianFps: null }
    };
    if (count === 0) return result;

    var i, e;
    result.startMs = entries[0][0];
    result.endMs = entries[count - 1][0];
    result.durationS = Math.round((result.endMs - result.startMs) / 1000);
    for (i = 0; i < count; i++) {
      e = entries[i];
      if (e[1] === DRIVE.DRIVE) result.driveS++;
      else if (e[1] === DRIVE.PARK) result.parkS++;
      else result.unknownS++;
      if (i > 0) {
        var step = e[0] - entries[i - 1][0];
        if (step > 2500) result.gapS += Math.round(step / 1000) - 1;
      }
    }

    result.basis = result.driveS >= MIN_DRIVE_S ? 'drive' : 'all';
    var micRunning = 0;
    var levelSum = 0;
    var toneRunning = 0;
    var canvasRunning = 0;
    var fpsValues = [];
    var total = 0;
    for (i = 0; i < count; i++) {
      e = entries[i];
      if (result.basis === 'drive' && e[1] !== DRIVE.DRIVE) continue;
      total++;
      if (e[2] === MIC.LIVE && typeof e[3] === 'number') {
        micRunning++;
        levelSum += e[3];
      }
      if (e[4] === 1) toneRunning++;
      if (e[5] >= 1) canvasRunning++;
      fpsValues.push(typeof e[5] === 'number' ? e[5] : 0);
    }
    fpsValues.sort(function (a, b) {
      return a - b;
    });
    var median = fpsValues[Math.floor((fpsValues.length - 1) / 2)];

    result.mic.share = micRunning / total;
    result.mic.verdict = shareVerdict(result.mic.share);
    result.mic.meanDb = micRunning ? Math.round(levelSum / micRunning) : null;

    result.tone.share = toneRunning / total;
    result.tone.verdict = shareVerdict(result.tone.share);

    result.canvas.share = canvasRunning / total;
    result.canvas.medianFps = median;
    result.canvas.verdict = shareVerdict(result.canvas.share);
    if (result.canvas.verdict === 'ok' && median < FPS_OK) result.canvas.verdict = 'partial';
    return result;
  }

  /**
   * Judges the echo test from three microphone levels in dBFS: room without
   * tone, tone with echo cancellation on, tone with it off.
   */
  function echoVerdict(levels) {
    var on = levels.onDb;
    var off = levels.offDb;
    var silence = levels.silenceDb;
    if (typeof on !== 'number' || typeof off !== 'number') {
      return { verdict: 'fail', reason: 'nodata', attenuationDb: null };
    }
    var attenuation = Math.round(off - on);
    if (typeof silence === 'number' && off - silence < 6) {
      return { verdict: 'warn', reason: 'quiet', attenuationDb: attenuation };
    }
    if (attenuation >= 10) return { verdict: 'ok', reason: 'effective', attenuationDb: attenuation };
    if (attenuation >= 3) return { verdict: 'warn', reason: 'partial', attenuationDb: attenuation };
    return { verdict: 'fail', reason: 'no-effect', attenuationDb: attenuation };
  }

  // ---- small helpers -----------------------------------------------------

  function fpsVerdict(fps) {
    return fps >= FPS_OK ? 'ok' : fps >= FPS_WARN ? 'warn' : 'fail';
  }

  /**
   * Button height in CSS px: at least 72, and at least 100 device pixels
   * (about 17 mm on the Model 3 screen) whatever zoom the browser applies.
   */
  function buttonHeight(devicePixelRatio) {
    if (!(devicePixelRatio > 0)) return 72;
    return Math.max(72, Math.ceil(100 / devicePixelRatio));
  }

  function parseUserAgent(userAgent) {
    var ua = String(userAgent || '');
    var chromium = /Chrom(?:e|ium)\/(\d+)/.exec(ua);
    var qt = /QtWebEngine\/([\d.]+)/.exec(ua);
    var tesla = /Tesla\/(\S+)/.exec(ua);
    return {
      chromium: chromium ? chromium[1] : null,
      qtWebEngine: qt ? qt[1] : null,
      tesla: tesla ? tesla[1] : null
    };
  }

  return {
    DRIVE: DRIVE,
    MIC: MIC,
    rmsDb: rmsDb,
    detectPitch: detectPitch,
    noteName: noteName,
    makeWav: makeWav,
    makeMelody: makeMelody,
    createDriveSensor: createDriveSensor,
    createRingLog: createRingLog,
    evaluate: evaluate,
    echoVerdict: echoVerdict,
    fpsVerdict: fpsVerdict,
    buttonHeight: buttonHeight,
    parseUserAgent: parseUserAgent
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProbeCore;
}
