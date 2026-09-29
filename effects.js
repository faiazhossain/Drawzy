/* Sensory effects: generated sound, haptics, confetti, screen wake lock.
   Every piece degrades silently when unsupported. */
(function () {
  "use strict";

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* ---------- Sound (Web Audio, generated) ---------- */

  var AudioFX = (function () {
    var ctx = null;
    var enabled = true;

    function ensure() {
      if (!ctx) {
        try {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (AC) ctx = new AC();
        } catch (e) { ctx = null; }
      }
      if (ctx && ctx.state === "suspended") {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
      return ctx;
    }

    function tone(freq, at, dur, type, vol) {
      var c = ctx;
      var osc = c.createOscillator();
      var gain = c.createGain();
      osc.type = type || "triangle";
      osc.frequency.value = freq;
      var t = c.currentTime + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol || 0.22, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.06);
    }

    function play(notes) {
      if (!enabled) return;
      try {
        if (!ensure()) return;
        notes.forEach(function (n) { tone(n[0], n[1], n[2], n[3], n[4]); });
      } catch (e) { /* sound must never break the app */ }
    }

    return {
      setEnabled: function (v) { enabled = !!v; },
      unlock: function () { if (enabled) ensure(); },
      call: function (digit) { play([[420 + digit * 34, 0, 0.09, "square", 0.16]]); },
      error: function () { play([[150, 0, 0.16, "sawtooth", 0.2]]); },
      miss: function () { play([[330, 0, 0.1, "sine", 0.14], [220, 0.09, 0.14, "sine", 0.14]]); },
      close: function () { play([[660, 0, 0.09], [880, 0.1, 0.14]]); },
      oneLeft: function () { play([[660, 0, 0.08], [880, 0.09, 0.08], [1046, 0.18, 0.16]]); },
      win: function () {
        play([
          [523, 0, 0.13], [659, 0.11, 0.13], [784, 0.22, 0.13],
          [1046, 0.33, 0.3, "triangle", 0.26], [1318, 0.46, 0.4, "triangle", 0.2]
        ]);
      }
    };
  })();

  /* ---------- Haptics ---------- */

  function buzz(pattern) {
    try {
      // Browsers reject vibration without user activation; stay silent there.
      if (navigator.userActivation && !navigator.userActivation.isActive) return;
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) { /* unsupported: stay silent */ }
  }

  /* ---------- Confetti ---------- */

  var Confetti = (function () {
    var canvas = null;
    var ctx = null;
    var parts = [];
    var raf = 0;
    var endAt = 0;
    var COLORS = ["#ffc94d", "#ff9f1c", "#ff4d8d", "#3ddc84", "#ffffff", "#4dc3ff"];

    function resize() {
      if (!canvas) return;
      var d = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * d);
      canvas.height = Math.floor(window.innerHeight * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }

    function tick(now) {
      if (document.hidden) { raf = requestAnimationFrame(tick); return; }
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      parts = parts.filter(function (p) { return p.y < window.innerHeight + 40; });
      parts.forEach(function (p) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05;
        p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.globalAlpha = now > endAt - 500 ? Math.max(0, (endAt - now) / 500) : 1;
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.62);
        ctx.restore();
      });
      if (now < endAt && parts.length) {
        raf = requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        parts = [];
        raf = 0;
      }
    }

    return {
      burst: function (count) {
        if (prefersReducedMotion()) return;
        try {
          canvas = canvas || document.getElementById("confetti-canvas");
          if (!canvas) return;
          ctx = canvas.getContext("2d");
          if (!ctx) return;
          resize();
          var n = count || 150;
          for (var i = 0; i < n; i++) {
            parts.push({
              x: Math.random() * window.innerWidth,
              y: -20 - Math.random() * window.innerHeight * 0.3,
              vx: (Math.random() - 0.5) * 2.6,
              vy: 2 + Math.random() * 3.5,
              s: 5 + Math.random() * 6,
              r: Math.random() * Math.PI,
              vr: (Math.random() - 0.5) * 0.25,
              c: COLORS[(Math.random() * COLORS.length) | 0]
            });
          }
          endAt = performance.now() + 3200;
          if (!raf) raf = requestAnimationFrame(tick);
        } catch (e) { /* celebration is optional */ }
      }
    };
  })();

  /* ---------- Screen wake lock ---------- */

  var WakeLock = (function () {
    var sentinel = null;
    var wanted = false;

    function supported() {
      return typeof navigator !== "undefined" && "wakeLock" in navigator;
    }

    function request() {
      if (!wanted || sentinel || !supported()) return;
      var p;
      try {
        p = navigator.wakeLock.request("screen");
      } catch (e) { return; }
      if (p && p.then) {
        p.then(function (s) {
          sentinel = s;
          s.addEventListener("release", function () { sentinel = null; });
        }).catch(function () { sentinel = null; });
      }
    }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && wanted) request();
    });

    return {
      acquire: function () { wanted = true; request(); },
      release: function () {
        wanted = false;
        try { if (sentinel) sentinel.release(); } catch (e) { /* ignore */ }
        sentinel = null;
      },
      supported: supported
    };
  })();

  window.FX = {
    audio: AudioFX,
    buzz: buzz,
    confetti: Confetti,
    wakeLock: WakeLock,
    prefersReducedMotion: prefersReducedMotion
  };
})();
