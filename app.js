/*
 * Browser side of the probe page: reads the browser APIs and fills the rows.
 * The pure logic (pitch, ring log, drive sensor, evaluation) lives in core.js.
 *
 * ES5 on purpose, like core.js: one unsupported syntax feature would stop
 * the whole page in an older embedded Chromium.
 */
(function () {
  'use strict';

  var VERSION = '2';
  var core = window.ProbeCore;

  var LOG_SECONDS = 30 * 60;
  var RAW_MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  var MARKS = { idle: '', run: 'läuft', ok: 'gut', warn: 'Achtung', fail: 'Fehler' };
  var COLORS = {
    night: '#10122a', pit: '#0a0b1c', edge: '#2c3068', ink: '#f4f1e8', soft: '#a9acd6',
    go: '#46e3a1', caution: '#ffcb47', stop: '#ff6680', live: '#63c7ff'
  };
  var FONT = 'system-ui, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif';

  function $(id) {
    return document.getElementById(id);
  }
  function noop() {}
  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // ---- formatting ----------------------------------------------------------

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }
  function clock(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function stamp(ms) {
    var d = new Date(ms);
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '. um ' + clock(ms) + ' Uhr';
  }
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return 'vor ' + s + ' s';
    if (s < 90 * 60) return 'vor ' + Math.round(s / 60) + ' min';
    if (s < 36 * 3600) return 'vor ' + Math.round(s / 3600) + ' h';
    return 'vor ' + Math.round(s / 86400) + ' Tagen';
  }
  function duration(s) {
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  }
  function decibel(db) {
    return db === null || db === undefined ? 'kein Signal' : Math.round(db) + ' dB';
  }
  function percent(share) {
    return Math.round(share * 100) + ' %';
  }
  function decimal(n) {
    return String(Math.round(n * 100) / 100).replace('.', ',');
  }
  function onOff(flag) {
    return flag === true ? 'an' : flag === false ? 'aus' : 'unbekannt';
  }

  // ---- rows ----------------------------------------------------------------

  /** Shrinks the small print of a row until the row shows all of it. */
  function fitRow(row) {
    var body = row.querySelector('.body');
    var detail = row.querySelector('.detail');
    detail.style.fontSize = '';
    if (!body.clientHeight) return;
    var size = parseFloat(window.getComputedStyle(detail).fontSize);
    var smallest = size * 0.65;
    while (body.scrollHeight > body.clientHeight + 1 && size > smallest) {
      size -= 0.5;
      detail.style.fontSize = size + 'px';
    }
  }

  /** state: idle, run, ok, warn or fail. value and detail stay as they are when null. */
  function setRow(id, state, value, detail, mark) {
    var row = $(id);
    var valueEl = row.querySelector('.value');
    var detailEl = row.querySelector('.detail');
    var markText = mark === undefined ? MARKS[state] : mark;
    var changed = false;
    if (row.getAttribute('data-state') !== state) {
      row.setAttribute('data-state', state);
      changed = true;
    }
    if (row.querySelector('.mark').textContent !== markText) row.querySelector('.mark').textContent = markText;
    if (value !== null && value !== undefined && valueEl.textContent !== value) {
      valueEl.textContent = value;
      changed = true;
    }
    if (detail !== null && detail !== undefined && detailEl.textContent !== detail) {
      detailEl.textContent = detail;
      changed = true;
    }
    if (changed) fitRow(row);
  }

  function fitAllRows() {
    Array.prototype.forEach.call(document.querySelectorAll('.test'), fitRow);
  }

  // ---- storage -------------------------------------------------------------

  var storage = null;

  function storageGet(key) {
    try {
      return storage ? storage.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      if (storage) storage.setItem(key, value);
    } catch (e) {
      /* the row for test 2 already reports a broken storage */
    }
  }

  // ---- 1 environment -------------------------------------------------------

  function testEnv() {
    var ua = navigator.userAgent || '';
    var parsed = core.parseUserAgent(ua);
    var parts = ['Bildschirm ' + screen.width + ' × ' + screen.height];
    parts.push(parsed.chromium ? 'Chromium ' + parsed.chromium : 'Chromium-Version unbekannt');
    if (parsed.qtWebEngine) parts.push('QtWebEngine ' + parsed.qtWebEngine);
    if (parsed.tesla) parts.push('Tesla ' + parsed.tesla);
    parts.push('Web Speech API ' + (window.SpeechRecognition || window.webkitSpeechRecognition ? 'vorhanden' : 'fehlt'));
    var insecure = window.isSecureContext === false;
    setRow(
      't-env',
      insecure ? 'warn' : 'ok',
      'Viewport ' + window.innerWidth + ' × ' + window.innerHeight + ', Pixeldichte ' + decimal(window.devicePixelRatio || 1),
      (insecure ? 'Kein sicherer Kontext: Das Mikrofon braucht HTTPS. ' : '') + parts.join(', ') + '. ' + ua
    );
  }

  // ---- 2 storage -----------------------------------------------------------

  function testStorage() {
    try {
      var ls = window.localStorage;
      var token = String(Date.now());
      ls.setItem('probe.selftest', token);
      if (ls.getItem('probe.selftest') !== token) throw new Error('gelesener Wert weicht ab');
      ls.removeItem('probe.selftest');
      storage = ls;

      var visits = (parseInt(ls.getItem('probe.visits'), 10) || 0) + 1;
      var last = parseInt(ls.getItem('probe.lastVisit'), 10) || 0;
      ls.setItem('probe.visits', String(visits));
      ls.setItem('probe.lastVisit', String(Date.now()));

      if (visits === 1 || !last) {
        setRow('t-storage', 'warn', 'Erster Besuch: Schreiben und Lesen klappt',
          'Ob der Speicher hält, zeigt erst der nächste Besuch. Steht dann hier Besuch Nr. 2, bleibt er erhalten.');
      } else {
        setRow('t-storage', 'ok', 'Besuch Nr. ' + visits + ', letzter Besuch am ' + stamp(last),
          'Das war ' + ago(last) + '. localStorage hat den Zähler bis heute behalten.');
      }
    } catch (e) {
      storage = null;
      setRow('t-storage', 'fail', 'localStorage nicht nutzbar: ' + (e.name || 'Fehler'),
        (e.message || '') + ' Der Fahrtest protokolliert dann nur im Arbeitsspeicher der Seite.');
    }
  }

  // ---- 3 audio formats -----------------------------------------------------

  var FORMATS = [
    { label: 'MP3', mime: 'audio/mpeg', file: 'media/tone.mp3', compressed: true },
    { label: 'Ogg Vorbis', mime: 'audio/ogg; codecs="vorbis"', file: 'media/tone-vorbis.ogg', compressed: true },
    { label: 'Opus', mime: 'audio/ogg; codecs="opus"', file: 'media/tone-opus.ogg', compressed: true },
    { label: 'AAC', mime: 'audio/mp4; codecs="mp4a.40.2"', file: 'media/tone.m4a', compressed: true },
    { label: 'WAV', mime: 'audio/wav', file: 'media/tone.wav', compressed: false }
  ];

  function fileReachable(url) {
    if (!window.fetch) return Promise.resolve(true);
    return window.fetch(url, { cache: 'no-store' }).then(
      function (response) {
        return response.ok;
      },
      function () {
        return false;
      }
    );
  }

  /** Really loads a sample file: resolves 'plays', 'unsupported', 'missing' or 'timeout'. */
  function loadSample(url) {
    return new Promise(function (resolve) {
      var audio = new Audio();
      var done = false;
      var timer = setTimeout(function () {
        finish('timeout');
      }, 8000);
      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        audio.removeAttribute('src');
        try {
          audio.load();
        } catch (e) {
          /* releasing the file is best effort */
        }
        resolve(result);
      }
      audio.preload = 'auto';
      audio.addEventListener('canplay', function () {
        finish('plays');
      });
      audio.addEventListener('error', function () {
        if (done) return;
        // A missing file and an unsupported codec raise the same error, so ask the server.
        fileReachable(url).then(function (reachable) {
          finish(reachable ? 'unsupported' : 'missing');
        });
      });
      audio.src = url;
      audio.load();
    });
  }

  function testFormats() {
    var probe = document.createElement('audio');
    var answers = FORMATS.map(function (f) {
      return probe.canPlayType ? probe.canPlayType(f.mime) : '';
    });
    $('t-formats').setAttribute('data-state', 'run');
    $('t-formats').querySelector('.mark').textContent = MARKS.run;

    Promise.all(FORMATS.map(function (f) {
      return loadSample(f.file);
    })).then(function (results) {
      var chips = $('format-chips');
      chips.textContent = '';
      var playing = 0;
      var compressedPlaying = 0;
      var unknown = 0;
      FORMATS.forEach(function (f, i) {
        var r = results[i];
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.setAttribute('data-state', r === 'plays' ? 'ok' : r === 'unsupported' ? 'fail' : 'idle');
        chip.textContent = f.label + (r === 'plays' ? ' ja' : r === 'unsupported' ? ' nein' : ' ?');
        chips.appendChild(chip);
        if (r === 'plays') {
          playing++;
          if (f.compressed) compressedPlaying++;
        } else if (r !== 'unsupported') {
          unknown++;
        }
      });
      var claims = FORMATS.map(function (f, i) {
        return f.label + ' ' + (answers[i] || 'nein');
      }).join(', ');
      var state = playing === FORMATS.length ? 'ok' : compressedPlaying > 0 || unknown > 0 ? 'warn' : 'fail';
      var note = unknown > 0
        ? 'Mit ? markierte Probedateien ließen sich nicht laden (Netz?). '
        : 'Jede Probedatei wurde wirklich geladen und dekodiert. ';
      setRow('t-formats', state, null, note + 'canPlayType meldet: ' + claims + '.');
    });
  }

  // ---- audio: element and Web Audio ----------------------------------------

  var audioEl = $('tone');
  var ctx = null;
  var toneWanted = false;
  var pauseByPage = false;
  var toneResult = { element: null, webAudio: null };

  function ensureContext() {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!ctx) ctx = new AudioContextClass();
    if (ctx.state === 'suspended' && ctx.resume) {
      var resumed = ctx.resume();
      if (resumed && resumed.catch) resumed.catch(noop);
    }
    return ctx;
  }

  /** Starts the looping test melody on the audio element. */
  function playTone(fromStart) {
    try {
      if (!audioEl.getAttribute('src')) {
        var rate = 24000;
        var wav = core.makeWav(core.makeMelody(rate), rate);
        audioEl.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      }
      if (fromStart) audioEl.currentTime = 0;
      var started = audioEl.play();
      return started && started.then ? started : Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function stopTone() {
    if (audioEl.paused) return;
    pauseByPage = true;
    audioEl.pause();
  }

  function beep(context, at) {
    var osc = context.createOscillator();
    var gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1568;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.2, at + 0.02);
    gain.gain.setValueAtTime(0.2, at + 0.18);
    gain.gain.linearRampToValueAtTime(0, at + 0.22);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(at);
    osc.stop(at + 0.25);
  }

  // ---- 4 tone --------------------------------------------------------------

  var TONE_HELP = '„Ton an“ tippen. Zu hören sein sollten eine Melodie über das audio-Element und nach zwei Sekunden zwei hohe Pieptöne über Web Audio.';

  function renderTone() {
    var e = toneResult.element;
    var w = toneResult.webAudio;
    if (e === null && w === null) {
      setRow('t-tone', 'idle', 'Noch nicht getestet', TONE_HELP);
      return;
    }
    if (e === 'run' || w === 'run') {
      setRow('t-tone', 'run', 'Melodie und Pieptöne starten ...', 'Hörst du erst die Melodie und nach zwei Sekunden zwei hohe Pieptöne?');
      return;
    }
    var working = (e === 'ok' ? 1 : 0) + (w === 'ok' ? 1 : 0);
    setRow(
      't-tone',
      working === 2 ? 'ok' : working === 1 ? 'warn' : 'fail',
      'audio-Element ' + (e === 'ok' ? 'läuft' : 'scheitert (' + e + ')') + ', Web Audio ' + (w === 'ok' ? 'läuft' : 'scheitert (' + w + ')'),
      (ctx ? 'AudioContext ' + ctx.state + ' bei ' + ctx.sampleRate + ' Hz. ' : '') +
        'Die Seite sieht nur, dass die Wiedergabe läuft. Ob Melodie und Pieptöne zu hören waren, musst du notieren.'
    );
  }

  function toggleTone() {
    if (toneWanted) {
      toneWanted = false;
      stopTone();
      if (toneResult.element === 'run' || toneResult.webAudio === 'run') toneResult = { element: null, webAudio: null };
      updateButtons();
      renderTone();
      renderMedia();
      return;
    }
    toneWanted = true;
    media.armed = true;
    toneResult = { element: 'run', webAudio: 'run' };
    updateButtons();
    renderTone();
    renderMedia();

    var context = ensureContext();
    playTone(true)
      .then(function () {
        return wait(1500);
      })
      .then(function () {
        if (!toneWanted) return;
        toneResult.element = !audioEl.paused && audioEl.currentTime > 0.3 ? 'ok' : 'Wiedergabe läuft nicht an';
      })
      .catch(function (e) {
        toneResult.element = (e && e.name) || 'Fehler';
      })
      .then(renderTone);

    if (!context) {
      toneResult.webAudio = 'AudioContext fehlt';
      return;
    }
    try {
      var t0 = context.currentTime;
      beep(context, t0 + 2.0);
      beep(context, t0 + 2.35);
      wait(3000).then(function () {
        if (!toneWanted && toneResult.webAudio !== 'run') return;
        toneResult.webAudio = context.state === 'running' && context.currentTime > t0 + 1 ? 'ok' : 'AudioContext ist ' + context.state;
        renderTone();
      });
    } catch (e) {
      toneResult.webAudio = e.name || 'Fehler';
    }
  }

  // ---- 9 media session -----------------------------------------------------

  var media = { supported: false, metadata: false, armed: false, counts: {}, total: 0, external: 0, last: '', lastAt: 0 };

  function renderMedia() {
    if (driveActive) return;
    if (!media.supported) {
      setRow('t-media', 'fail', 'navigator.mediaSession fehlt', 'Der Mediaplayer des Autos kann die Seite dann nicht steuern.');
      return;
    }
    var outside = media.external
      ? ' Der Ton wurde ' + media.external + '-mal von außen pausiert, ohne Signal über die Media Session.'
      : '';
    if (media.total > 0) {
      var list = [];
      for (var action in media.counts) {
        if (Object.prototype.hasOwnProperty.call(media.counts, action)) list.push(action + ' ' + media.counts[action] + '-mal');
      }
      setRow('t-media', 'ok', 'Das Auto steuert die Seite: ' + list.join(', '),
        'Zuletzt ' + media.last + ' um ' + clock(media.lastAt) + ' Uhr.' + outside);
      return;
    }
    if (!media.armed) {
      setRow('t-media', 'idle', 'Noch nicht getestet',
        '„Ton an“ tippen, dann am Auto Pause und Play drücken, zum Beispiel am linken Lenkradrad.');
      return;
    }
    setRow('t-media', 'warn',
      media.external ? 'Ton von außen pausiert, aber ohne Media-Session-Signal' : 'Metadaten ' + (media.metadata ? 'gesetzt' : 'abgelehnt') + ', noch kein Signal vom Auto',
      (toneWanted ? 'Jetzt am Auto Pause und Play drücken.' : 'Der Ton ist aus. „Ton an“ tippen, dann am Auto Pause und Play drücken.') +
        ' Zeigt der Mediaplayer den Titel „Tesla-Karaoke Probe“?' + outside);
  }

  function onMediaAction(action) {
    media.counts[action] = (media.counts[action] || 0) + 1;
    media.total++;
    media.last = action;
    media.lastAt = Date.now();
    if (action === 'pause' || action === 'stop') {
      toneWanted = false;
      stopTone();
    } else if (action === 'play') {
      toneWanted = true;
      playTone(false).catch(noop);
    }
    updateButtons();
    renderMedia();
  }

  function setupMediaSession() {
    media.supported = 'mediaSession' in navigator;
    if (media.supported) {
      try {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: 'Tesla-Karaoke Probe',
          artist: 'Testmelodie',
          album: 'Phase 0'
        });
        media.metadata = true;
      } catch (e) {
        media.metadata = false;
      }
      ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'].forEach(function (action) {
        try {
          navigator.mediaSession.setActionHandler(action, function () {
            onMediaAction(action);
          });
        } catch (e) {
          /* this browser does not know the action */
        }
      });
    }
    audioEl.addEventListener('pause', function () {
      if (pauseByPage) {
        pauseByPage = false;
      } else {
        media.external++;
        toneWanted = false;
        updateButtons();
        renderMedia();
      }
      if (media.supported) navigator.mediaSession.playbackState = 'paused';
    });
    audioEl.addEventListener('playing', function () {
      if (media.supported) navigator.mediaSession.playbackState = 'playing';
    });
    renderMedia();
  }

  // ---- 5 canvas ------------------------------------------------------------

  var miniCanvas = $('mini-canvas');
  var driveCanvas = $('drive-canvas');
  var frames = 0;
  var fps = 0;
  var lastFpsAt = 0;

  function sizeCanvas(canvas) {
    var rect = canvas.getBoundingClientRect();
    var ratio = window.devicePixelRatio || 1;
    var width = Math.max(1, Math.round(rect.width * ratio));
    var height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  function drawMini(now) {
    var g = miniCanvas.getContext('2d');
    var w = miniCanvas.width;
    var h = miniCanvas.height;
    g.clearRect(0, 0, w, h);
    g.lineWidth = Math.max(2, h / 14);
    g.lineCap = 'round';
    g.strokeStyle = COLORS.live;
    g.beginPath();
    for (var x = 0; x <= w; x += 4) {
      var y = h / 2 + Math.sin((x / w) * 4 * Math.PI + now / 300) * h * 0.3;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  /** Drive test screen: two words in large type and a slowly breathing dot as a sign of life. */
  function drawDrive(now) {
    var g = driveCanvas.getContext('2d');
    var w = driveCanvas.width;
    var h = driveCanvas.height;
    var size = Math.min(w / 9, h / 4);
    g.fillStyle = COLORS.night;
    g.fillRect(0, 0, w, h);
    g.fillStyle = COLORS.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 ' + size + 'px ' + FONT;
    g.fillText('Protokoll läuft', w / 2, h * 0.45);
    g.globalAlpha = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((now / 4000) * 2 * Math.PI));
    g.fillStyle = COLORS.live;
    g.beginPath();
    g.arc(w / 2, h * 0.45 + size * 1.1, size * 0.12, 0, 2 * Math.PI);
    g.fill();
    g.globalAlpha = 1;
  }

  function frame(now) {
    frames++;
    if (driveActive) drawDrive(now);
    else drawMini(now);
    window.requestAnimationFrame(frame);
  }

  function measureFps() {
    var now = window.performance.now();
    fps = Math.round((frames * 1000) / (now - lastFpsAt));
    frames = 0;
    lastFpsAt = now;
  }

  function renderCanvas() {
    if (driveActive || document.visibilityState === 'hidden') return;
    setRow('t-canvas', core.fpsVerdict(fps), fps + ' Bilder pro Sekunde', 'Gemessen mit requestAnimationFrame über die letzte Sekunde.');
  }

  // ---- 6 microphone --------------------------------------------------------

  var MIC_HELP = '„Mikrofon an“ tippen und die Freigabe bestätigen. Dann einen Ton summen: Rechts erscheint die Note.';
  var MIC_ERRORS = {
    NotAllowedError: 'Zugriff abgelehnt oder im Browser gesperrt',
    PermissionDeniedError: 'Zugriff abgelehnt oder im Browser gesperrt',
    NotFoundError: 'kein Mikrofon gefunden',
    NotReadableError: 'Mikrofon ist belegt oder nicht lesbar',
    OverconstrainedError: 'Mikrofon erfüllt die Vorgaben nicht',
    SecurityError: 'kein sicherer Kontext',
    AbortError: 'Anfrage abgebrochen'
  };

  var mic = {
    stream: null, track: null, source: null, analyser: null, buffer: null,
    ticket: 0, pending: false, used: false, error: null,
    level: null, contextTime: -1, contextMovedAt: 0, openedAt: 0, signalAt: 0,
    sum: 0, count: 0, note: null, noteAt: 0, polls: 0
  };

  function closeMic() {
    mic.ticket++;
    if (mic.stream) {
      mic.stream.getTracks().forEach(function (track) {
        track.onended = track.onmute = track.onunmute = null;
        track.stop();
      });
    }
    if (mic.source) {
      try {
        mic.source.disconnect();
      } catch (e) {
        /* already disconnected */
      }
    }
    mic.stream = mic.track = mic.source = mic.analyser = null;
    mic.level = null;
    mic.note = null;
  }

  /** Opens the microphone with the given audio constraints and wires it to an analyser. */
  function openMic(constraints) {
    closeMic();
    var ticket = mic.ticket;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject({ name: 'getUserMedia fehlt', message: '' });
    }
    var context = ensureContext();
    return navigator.mediaDevices.getUserMedia({ audio: constraints, video: false }).then(function (stream) {
      if (ticket !== mic.ticket || !context) {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
        throw { name: context ? 'Abgebrochen' : 'AudioContext fehlt', message: '' };
      }
      mic.stream = stream;
      mic.track = stream.getAudioTracks()[0];
      mic.source = context.createMediaStreamSource(stream);
      mic.analyser = context.createAnalyser();
      mic.analyser.fftSize = 2048;
      mic.source.connect(mic.analyser);
      mic.buffer = new Float32Array(mic.analyser.fftSize);
      mic.openedAt = mic.contextMovedAt = Date.now();
      mic.signalAt = 0;
      mic.sum = 0;
      mic.count = 0;
      mic.track.onended = mic.track.onmute = mic.track.onunmute = renderMic;
    });
  }

  /** Reads the current level in dBFS, or null when no audio is flowing. */
  function pollMic() {
    if (!mic.analyser) {
      mic.level = null;
      return null;
    }
    mic.analyser.getFloatTimeDomainData(mic.buffer);
    var db = core.rmsDb(mic.buffer);
    // A suspended AudioContext keeps returning its last buffer: that is not a signal.
    // Its clock moves in steps of the output buffer, so only half a second without
    // movement counts as stopped.
    var now = Date.now();
    if (ctx.currentTime !== mic.contextTime) {
      mic.contextTime = ctx.currentTime;
      mic.contextMovedAt = now;
    }
    if (now - mic.contextMovedAt > 500) db = null;
    if (db !== null) {
      mic.sum += Math.pow(10, db / 10);
      mic.count++;
      mic.signalAt = Date.now();
    }
    mic.level = db;
    return db;
  }

  /** Mean level since the last call, in whole dBFS, or null without signal. */
  function takeLevel() {
    var db = mic.count ? Math.round((10 * Math.log(mic.sum / mic.count)) / Math.LN10) : null;
    mic.sum = 0;
    mic.count = 0;
    return db;
  }

  function measureLevel(ms) {
    takeLevel();
    return wait(ms).then(takeLevel);
  }

  function micSettings() {
    return mic.track && mic.track.getSettings ? mic.track.getSettings() : {};
  }

  function describeMic() {
    var s = micSettings();
    return (mic.track.label || 'Mikrofon ohne Namen') + '. ' +
      (s.sampleRate ? s.sampleRate + ' Hz, ' : '') +
      'Echounterdrückung ' + onOff(s.echoCancellation) +
      ', Rauschfilter ' + onOff(s.noiseSuppression) +
      ', Pegelautomatik ' + onOff(s.autoGainControl) + '.';
  }

  function describeError(e) {
    var name = (e && e.name) || 'Fehler';
    return {
      title: name + (MIC_ERRORS[name] ? ': ' + MIC_ERRORS[name] : ''),
      detail: ((e && e.message) || '') + (window.isSecureContext === false ? ' Die Seite läuft nicht über HTTPS.' : '')
    };
  }

  function renderMicReadout() {
    var showNote = mic.note && Date.now() - mic.noteAt < 500;
    $('mic-note').textContent = showNote ? mic.note.name : '';
    $('mic-cents').textContent = showNote ? (mic.note.cents > 0 ? '+' : '') + mic.note.cents + ' ct' : '';
    var fill = mic.level === null ? 0 : Math.max(0, Math.min(1, (mic.level + 70) / 70));
    $('mic-meter').style.width = Math.round(fill * 100) + '%';
  }

  function renderMic() {
    if (driveActive) return;
    renderMicReadout();
    if (mic.pending) {
      setRow('t-mic', 'run', 'Warte auf die Freigabe ...', 'Im Auto den Dialog für das Mikrofon bestätigen.');
    } else if (mic.error) {
      setRow('t-mic', 'fail', mic.error.title, mic.error.detail);
    } else if (!mic.track) {
      setRow('t-mic', 'idle', mic.used ? 'Mikrofon ist aus' : 'Noch nicht getestet', MIC_HELP);
    } else if (mic.track.readyState !== 'live') {
      setRow('t-mic', 'fail', 'Mikrofon-Track wurde beendet', describeMic());
    } else if (mic.track.muted) {
      setRow('t-mic', 'warn', 'Freigegeben, aber stummgeschaltet', describeMic());
    } else if (mic.level === null && Date.now() - Math.max(mic.signalAt, mic.openedAt) > 2000) {
      setRow('t-mic', 'warn', 'Freigegeben, aber es kommt kein Signal', describeMic());
    } else {
      setRow('t-mic', 'ok', 'Läuft, Pegel ' + (mic.level === null ? '...' : decibel(mic.level)), describeMic());
    }
  }

  function micLoop() {
    if (pollMic() === null && !mic.track) return;
    if (driveActive) return;
    var freq = core.detectPitch(mic.buffer, ctx.sampleRate);
    if (freq) {
      mic.note = core.noteName(freq);
      mic.noteAt = Date.now();
    }
    renderMicReadout();
    if (++mic.polls % 3 === 0) renderMic();
  }

  function startMic() {
    mic.pending = true;
    mic.used = true;
    mic.error = null;
    updateButtons();
    renderMic();
    return openMic(RAW_MIC)
      .then(
        function () {
          mic.pending = false;
        },
        function (e) {
          if (e && e.name === 'Abgebrochen') return;
          mic.pending = false;
          mic.error = describeError(e);
        }
      )
      .then(function () {
        updateButtons();
        renderMic();
      });
  }

  function toggleMic() {
    if (mic.track || mic.pending) {
      closeMic();
      mic.pending = false;
      mic.error = null;
      updateButtons();
      renderMic();
      return;
    }
    startMic();
  }

  // ---- 7 echo --------------------------------------------------------------

  var ECHO_HELP = 'Lautstärke wie beim Singen einstellen, „Echo messen“ tippen und etwa zwölf Sekunden still sein.';
  var echoBusy = false;

  function renderEcho(levels, applied) {
    var verdict = core.echoVerdict(levels);
    var state = verdict.verdict;
    var text = {
      nodata: 'Messung ohne Signal: Das Mikrofon lieferte keine Daten',
      quiet: 'Das Mikrofon hört die Melodie kaum',
      effective: 'Echounterdrückung nimmt ' + verdict.attenuationDb + ' dB von der Musik weg',
      partial: 'Echounterdrückung nimmt nur ' + verdict.attenuationDb + ' dB von der Musik weg',
      'no-effect': 'Echounterdrückung hilft nicht (' + verdict.attenuationDb + ' dB)'
    }[verdict.reason];
    var detail = 'Ruhepegel ' + decibel(levels.silenceDb) + '.';
    if (verdict.reason === 'quiet') {
      detail += ' Lautstärke erhöhen und wiederholen. Bleibt es so, filtert das Auto die Musik schon selbst heraus.';
    }
    if (applied.on === false || applied.off === true) {
      detail += ' Der Browser hat die Einstellung nicht übernommen (gemeldet: ' + onOff(applied.on) + ' und ' + onOff(applied.off) + ').';
    }
    $('echo-on').textContent = decibel(levels.onDb);
    $('echo-off').textContent = decibel(levels.offDb);
    setRow('t-echo', state, text, detail);
  }

  function runEcho() {
    if (echoBusy) return;
    echoBusy = true;
    toneWanted = false;
    stopTone();
    mic.used = true;
    mic.error = null;
    updateButtons();

    var levels = { silenceDb: null, onDb: null, offDb: null };
    var applied = { on: null, off: null };
    var withEcho = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };

    function progress(step, text) {
      setRow('t-echo', 'run', 'Schritt ' + step + ' von 3: ' + text,
        'Bitte still sein, die Messung läuft. Fragt das Auto erneut nach dem Mikrofon, die Freigabe bestätigen.');
    }
    function setting() {
      var value = micSettings().echoCancellation;
      return typeof value === 'boolean' ? value : null;
    }

    progress(1, 'Ruhepegel');
    openMic(withEcho)
      .then(function () {
        applied.on = setting();
        return wait(700);
      })
      .then(function () {
        return measureLevel(1500);
      })
      .then(function (db) {
        levels.silenceDb = db;
        progress(2, 'Melodie mit Echounterdrückung');
        return playTone(true);
      })
      .then(function () {
        return wait(1500); // the canceller needs a moment to adapt
      })
      .then(function () {
        return measureLevel(2500);
      })
      .then(function (db) {
        levels.onDb = db;
        stopTone();
        progress(3, 'Melodie ohne Echounterdrückung');
        return openMic(RAW_MIC);
      })
      .then(function () {
        applied.off = setting();
        return playTone(true);
      })
      .then(function () {
        return wait(1500);
      })
      .then(function () {
        return measureLevel(2500);
      })
      .then(function (db) {
        levels.offDb = db;
        stopTone();
        renderEcho(levels, applied);
      })
      .catch(function (e) {
        stopTone();
        var error = describeError(e);
        if (!mic.track) mic.error = error;
        setRow('t-echo', 'fail', 'Abgebrochen: ' + error.title, error.detail);
      })
      .then(function () {
        echoBusy = false;
        updateButtons();
        renderMic();
      });
  }

  // ---- 8 drive sensor ------------------------------------------------------

  var video = $('sensor-video');
  var sensor = core.createDriveSensor();
  var sensorInfo = { everPlayed: false, pauses: 0, driveSince: 0, loadStart: Date.now(), startError: '' };

  function startSensor() {
    try {
      video.muted = true;
      var started = video.play();
      if (started && started.catch) {
        started.catch(function (e) {
          sensorInfo.startError = (e && e.name) || '';
        });
      }
    } catch (e) {
      sensorInfo.startError = e.name || '';
    }
  }

  function renderSensor(state, loaded, visible) {
    if (driveActive) return;
    if (!visible) {
      setRow('t-sensor', 'idle', 'Seite ist gerade nicht sichtbar', '');
    } else if (!loaded) {
      if (video.error || video.networkState === 3 || Date.now() - sensorInfo.loadStart > 8000) {
        setRow('t-sensor', 'fail', 'Sensor-Video lässt sich nicht laden', 'Weder WebM (VP8) noch MP4 (H.264) wurde angenommen. Ohne Video gibt es keinen Fahrsensor.');
      } else {
        setRow('t-sensor', 'run', 'Sensor-Video wird geladen ...', '');
      }
    } else if (!sensorInfo.everPlayed) {
      setRow('t-sensor', 'warn', 'Sensor-Video startet nicht von selbst',
        'Einmal irgendwo tippen. Im Stand heißt das: Der Browser sperrt Autoplay.' + (sensorInfo.startError ? ' Gemeldet: ' + sensorInfo.startError + '.' : ''));
    } else if (state === 'drive') {
      setRow('t-sensor', 'warn', 'Fahrbetrieb erkannt',
        'Das Video ' + (sensor.reason === 'paused' ? 'wurde ohne Nutzeraktion pausiert' : 'steht still, ohne Pause-Ereignis') +
          ', seit ' + duration(Math.round((Date.now() - sensorInfo.driveSince) / 1000)) + '. Pausen bisher: ' + sensorInfo.pauses + '.',
        'Fahrt');
    } else {
      var file = (video.currentSrc || '').split('/').pop().split('?')[0];
      setRow('t-sensor', 'ok', 'Parkmodus: Video läuft',
        'Quelle ' + file + '. Pausen ohne Nutzeraktion bisher: ' + sensorInfo.pauses + '. Stoppt das Auto das Video, steht hier „Fahrbetrieb erkannt“.');
    }
  }

  /**
   * retry: ask the video to play again if it is paused. Only the one-second
   * timer does that, never the pause event itself, or a car that pauses every
   * attempt would spin the page in a tight loop.
   */
  function sensorTick(retry) {
    var visible = document.visibilityState !== 'hidden';
    var loaded = video.readyState >= 2;
    if (!video.paused && video.currentTime > 0) sensorInfo.everPlayed = true;
    var state = sensor.update({
      t: Date.now(),
      available: loaded && sensorInfo.everPlayed,
      visible: visible,
      paused: video.paused,
      currentTime: video.currentTime
    });
    if (state !== 'drive') sensorInfo.driveSince = 0;
    else if (!sensorInfo.driveSince) sensorInfo.driveSince = Date.now();
    if (retry && visible && video.paused) startSensor();
    renderSensor(state, loaded, visible);
  }

  // ---- 10 connections ------------------------------------------------------

  function testConnections() {
    var hasSocket = typeof window.WebSocket === 'function';
    var PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    var hasPeer = false;
    var peerError = '';
    if (PeerConnection) {
      try {
        var peer = new PeerConnection();
        if (peer.createDataChannel) peer.createDataChannel('probe');
        peer.close();
        hasPeer = true;
      } catch (e) {
        peerError = e.name || 'Fehler';
      }
    }
    setRow(
      't-conn',
      hasSocket && hasPeer ? 'ok' : hasSocket ? 'warn' : 'fail',
      hasSocket && hasPeer
        ? 'WebSocket und RTCPeerConnection vorhanden'
        : 'WebSocket ' + (hasSocket ? 'vorhanden' : 'fehlt') + ', RTCPeerConnection ' + (PeerConnection ? 'gesperrt (' + peerError + ')' : 'fehlt'),
      hasSocket && hasPeer
        ? 'Für das Handy als Mikrofon stehen beide Wege offen: Relay über WebSocket oder direkt über WebRTC.'
        : hasSocket
          ? 'Für den Ausweichweg reicht WebSocket: Das Handy schickt nur Tonhöhen über ein Relay.'
          : 'Ohne WebSocket kann das Handy keine Werte an die Seite schicken.'
    );
  }

  // ---- questions -----------------------------------------------------------

  var askDone = null;
  var askTimer = 0;

  /** Shows a question with two large buttons. Resolves true for the first one. */
  function ask(question, yes, no, autoCloseMs) {
    if (askDone) askDone(false);
    $('ask-text').textContent = question;
    $('ask-yes').textContent = yes;
    $('ask-no').textContent = no;
    $('ask').hidden = false;
    return new Promise(function (resolve) {
      askDone = function (answer) {
        clearTimeout(askTimer);
        askDone = null;
        $('ask').hidden = true;
        resolve(answer);
      };
      if (autoCloseMs) {
        askTimer = setTimeout(function () {
          if (askDone) askDone(false);
        }, autoCloseMs);
      }
    });
  }

  // ---- drive test ----------------------------------------------------------

  var driveActive = false;
  var driveStartedAt = 0;
  var log = null;
  var lastToneTime = 0;

  function logTick() {
    pollMic();
    var toneTime = audioEl.currentTime;
    var toneRunning = !audioEl.paused && toneTime !== lastToneTime;
    lastToneTime = toneTime;
    var track = mic.track;
    var micCode = !track ? core.MIC.NONE : track.readyState !== 'live' ? core.MIC.ENDED : track.muted ? core.MIC.MUTED : core.MIC.LIVE;
    var driveCode = sensor.state === 'drive' ? core.DRIVE.DRIVE : sensor.state === 'park' ? core.DRIVE.PARK : core.DRIVE.UNKNOWN;
    log.push([Date.now(), driveCode, micCode, takeLevel(), toneRunning ? 1 : 0, fps]);
  }

  function startDrive() {
    driveActive = true;
    driveStartedAt = Date.now();
    $('drive-overlay').hidden = false;
    sizeCanvas(driveCanvas);
    log.reset(Date.now());
    ensureContext();
    toneWanted = true;
    media.armed = true;
    playTone(false).catch(noop);
    // A microphone that fails to open shows up in the log as "no microphone".
    if (!mic.track || mic.track.readyState !== 'live') startMic();
    startSensor();
    lastToneTime = audioEl.currentTime;
    takeLevel();
    updateButtons();
  }

  function stopDrive() {
    driveActive = false;
    $('drive-overlay').hidden = true;
    toneWanted = false;
    stopTone();
    updateButtons();
    renderMic();
    renderMedia();
    showEvaluation();
  }

  function onDriveButton() {
    var stored = log.read('storage');
    if (stored.entries.length >= 10 && String(stored.start) !== storageGet('probe.log.seen')) {
      ask('Das Protokoll vom ' + stamp(stored.start) + ' wurde noch nicht ausgewertet. Überschreiben?',
        'Überschreiben und starten', 'Abbrechen').then(function (yes) {
        if (yes) startDrive();
      });
      return;
    }
    startDrive();
  }

  function onOverlayTap() {
    if (askDone) return;
    ask('Fahrtest beenden?', 'Beenden und auswerten', 'Weiter protokollieren', 8000).then(function (yes) {
      if (yes) stopDrive();
    });
  }

  // ---- evaluation ----------------------------------------------------------

  var EVAL_STATE = { ok: 'ok', partial: 'warn', fail: 'fail', nodata: 'idle' };

  function drawTimeline(entries) {
    var canvas = $('timeline-canvas');
    sizeCanvas(canvas);
    var g = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    var lanes = ['Fahrbetrieb', 'Mikrofon', 'Ton', 'Canvas'];
    var gap = Math.max(2, Math.round(h * 0.04));
    var laneH = (h - gap * (lanes.length - 1)) / lanes.length;
    var fontSize = Math.max(9, Math.min(laneH * 0.6, h * 0.16));
    g.clearRect(0, 0, w, h);
    g.font = '600 ' + fontSize + 'px ' + FONT;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    var labelW = g.measureText('Fahrbetrieb').width + fontSize;
    var plotW = w - labelW;
    lanes.forEach(function (name, lane) {
      var y = lane * (laneH + gap);
      g.fillStyle = COLORS.soft;
      g.fillText(name, 0, y + laneH / 2);
      g.fillStyle = COLORS.pit;
      g.fillRect(labelW, y, plotW, laneH);
    });
    if (entries.length < 1) return;

    var start = entries[0][0];
    var span = Math.max(1000, entries[entries.length - 1][0] - start + 1000);
    function xAt(ms) {
      return labelW + Math.floor(((ms - start) / span) * plotW);
    }
    entries.forEach(function (e, i) {
      // A bar reaches to the next entry, unless that one is late: then the gap stays dark.
      var next = entries[i + 1];
      var x = xAt(e[0]);
      var barW = Math.max(1, xAt(next && next[0] - e[0] <= 2500 ? next[0] : e[0] + 1000) - x);
      var colors = [
        e[1] === core.DRIVE.DRIVE ? COLORS.caution : e[1] === core.DRIVE.PARK ? COLORS.edge : COLORS.pit,
        e[2] === core.MIC.LIVE && typeof e[3] === 'number' ? COLORS.go : COLORS.stop,
        e[4] === 1 ? COLORS.go : COLORS.stop,
        { ok: COLORS.go, warn: COLORS.caution, fail: COLORS.stop }[core.fpsVerdict(e[5])]
      ];
      for (var lane = 0; lane < colors.length; lane++) {
        g.fillStyle = colors[lane];
        g.fillRect(x, lane * (laneH + gap), barW, laneH);
      }
    });
  }

  function showEvaluation() {
    var data = log.read();
    var r = core.evaluate(data.entries);
    var where = r.basis === 'drive' ? 'im Fahrbetrieb' : 'im gesamten Protokoll';
    $('eval').hidden = false;

    if (r.count === 0) {
      $('eval-meta').textContent = '';
      setRow('ev-log', 'warn', 'Kein Protokoll vorhanden', 'Erst „Fahrtest starten“ tippen, eine Runde fahren und nach dem Parken hierher zurückkommen.');
      ['ev-drive', 'ev-mic', 'ev-tone', 'ev-canvas'].forEach(function (id) {
        setRow(id, 'idle', 'Keine Daten', '');
      });
      drawTimeline([]);
      return;
    }

    $('eval-meta').textContent = 'Fahrtest vom ' + stamp(r.startMs) + ', Ende um ' + clock(r.endMs) + ' Uhr.';
    var source = data.source === 'memory' ? 'Arbeitsspeicher der Seite' : 'localStorage';
    var storageNote = data.source === 'memory' && !log.storageOk ? ' localStorage hat das Protokoll nicht angenommen.' : '';
    var gappy = r.gapS > Math.max(3, r.durationS * 0.02);
    setRow('ev-log', gappy ? 'warn' : 'ok', duration(r.durationS) + ' protokolliert, ' + r.count + ' Einträge',
      'Quelle: ' + source + '.' + storageNote + (r.gapS ? ' Lücken: ' + r.gapS + ' s ohne Eintrag, die Seite stand in dieser Zeit still.' : ' Keine Lücken.'));

    if (r.basis === 'drive') {
      setRow('ev-drive', 'ok', 'Fahrbetrieb erkannt: ' + r.driveS + ' s',
        'Parkmodus ' + r.parkS + ' s, unklar ' + r.unknownS + ' s. Die Urteile unten gelten nur für die Sekunden im Fahrbetrieb.');
    } else {
      setRow('ev-drive', 'warn', 'Kein Fahrbetrieb erkannt (' + r.driveS + ' s)',
        'Der Fahrsensor hat nicht ausgelöst: Parkmodus ' + r.parkS + ' s, unklar ' + r.unknownS + ' s. Die Urteile unten gelten für das gesamte Protokoll.');
    }

    var verb = { ok: ' lief ' + where + ' weiter', partial: ' lief ' + where + ' nur zeitweise', fail: ' lief ' + where + ' nicht' };
    setRow('ev-mic', EVAL_STATE[r.mic.verdict], 'Mikrofon' + verb[r.mic.verdict],
      percent(r.mic.share) + ' der Sekunden mit Signal' + (r.mic.meanDb === null ? '.' : ', Pegel im Mittel ' + decibel(r.mic.meanDb) + '.'));
    setRow('ev-tone', EVAL_STATE[r.tone.verdict], 'Ton' + verb[r.tone.verdict],
      percent(r.tone.share) + ' der Sekunden mit laufender Wiedergabe.');
    setRow('ev-canvas', EVAL_STATE[r.canvas.verdict], 'Canvas' + verb[r.canvas.verdict],
      percent(r.canvas.share) + ' der Sekunden mit Bild, im Mittel ' + r.canvas.medianFps + ' Bilder pro Sekunde.');

    drawTimeline(data.entries);
    if (data.start !== null) storageSet('probe.log.seen', String(data.start));
  }

  // ---- buttons and timers --------------------------------------------------

  function updateButtons() {
    var tone = $('btn-tone');
    tone.textContent = toneWanted ? 'Ton aus' : 'Ton an';
    tone.setAttribute('aria-pressed', toneWanted ? 'true' : 'false');
    var micOn = !!(mic.track || mic.pending);
    var micButton = $('btn-mic');
    micButton.textContent = micOn ? 'Mikrofon aus' : 'Mikrofon an';
    micButton.setAttribute('aria-pressed', micOn ? 'true' : 'false');
    ['btn-tone', 'btn-mic', 'btn-echo', 'btn-drive'].forEach(function (id) {
      $(id).disabled = echoBusy;
    });
  }

  function applySizes() {
    // Button height follows the pixel density: 2026.26 changed zoom and density of the car's browser.
    document.documentElement.style.setProperty('--btn-h', core.buttonHeight(window.devicePixelRatio) + 'px');
    sizeCanvas(miniCanvas);
    if (driveActive) sizeCanvas(driveCanvas);
  }

  function tick() {
    measureFps();
    sensorTick(true);
    if (!driveActive) {
      renderCanvas();
    } else if (Date.now() - driveStartedAt >= 1000) {
      // An entry describes the second before it. This timer runs since page load, so its
      // first beat after the start would mostly describe the time before the drive test.
      logTick();
    }
  }

  function init() {
    $('version').textContent = 'Version ' + VERSION;
    applySizes();

    testEnv();
    testStorage();
    log = core.createRingLog(storage, 'probe.log', LOG_SECONDS);
    testFormats();
    testConnections();
    setupMediaSession();
    renderTone();
    renderMic();
    setRow('t-echo', 'idle', 'Noch nicht getestet', ECHO_HELP);

    video.addEventListener('playing', function () {
      sensorInfo.everPlayed = true;
    });
    video.addEventListener('pause', function () {
      if (document.visibilityState !== 'hidden') sensorInfo.pauses++;
      sensorTick(false);
    });
    document.addEventListener('visibilitychange', function () {
      sensorTick(false);
    });
    // Autoplay may need one tap: any tap starts the sensor video if it never ran.
    ['pointerdown', 'touchstart', 'mousedown'].forEach(function (type) {
      document.addEventListener(type, function () {
        if (!sensorInfo.everPlayed) startSensor();
      });
    });
    startSensor();

    $('btn-tone').addEventListener('click', toggleTone);
    $('btn-mic').addEventListener('click', toggleMic);
    $('btn-echo').addEventListener('click', runEcho);
    $('btn-drive').addEventListener('click', onDriveButton);
    $('btn-eval').addEventListener('click', showEvaluation);
    $('btn-eval-back').addEventListener('click', function () {
      $('eval').hidden = true;
      fitAllRows();
    });
    $('drive-overlay').addEventListener('click', onOverlayTap);
    $('ask-yes').addEventListener('click', function () {
      if (askDone) askDone(true);
    });
    $('ask-no').addEventListener('click', function () {
      if (askDone) askDone(false);
    });

    window.addEventListener('resize', function () {
      applySizes();
      testEnv();
      fitAllRows();
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      window.onerror('Promise: ' + ((reason && (reason.name || reason.message)) || reason), '', 0);
    });

    lastFpsAt = window.performance.now();
    window.requestAnimationFrame(frame);
    window.setInterval(tick, 1000);
    window.setInterval(micLoop, 80);
    updateButtons();
    document.body.setAttribute('data-ready', '1');
  }

  init();
})();
