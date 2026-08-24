/* ============================================================
 * sound.js — WebAudio 合成音效（无外部资源）
 * ============================================================ */

const Sound = (() => {
  let ctx = null;
  let lastPlay = {};

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 节流：同类音效 30ms 内只放一次
  function throttled(type, ms = 30) {
    const now = performance.now();
    if (lastPlay[type] && now - lastPlay[type] < ms) return true;
    lastPlay[type] = now;
    return false;
  }

  function noiseBuffer(a, dur) {
    const len = Math.max(1, (a.sampleRate * dur) | 0);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    return buf;
  }

  function play(type, intensity = 0.5) {
    try {
      const a = ac();
      const v = Math.max(0.05, Math.min(1, intensity));
      if (type === 'ball') {
        if (throttled('ball')) return;
        // 清脆的球撞击声：短噪声 + 高频带通
        const src = a.createBufferSource();
        src.buffer = noiseBuffer(a, 0.035);
        const bp = a.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2800 + v * 1800;
        bp.Q.value = 1.2;
        const g = a.createGain();
        g.gain.setValueAtTime(v * 0.75, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.06);
        src.connect(bp).connect(g).connect(a.destination);
        src.start();
      } else if (type === 'cushion') {
        if (throttled('cushion', 50)) return;
        const src = a.createBufferSource();
        src.buffer = noiseBuffer(a, 0.06);
        const lp = a.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 500 + v * 500;
        const g = a.createGain();
        g.gain.setValueAtTime(v * 0.5, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.09);
        src.connect(lp).connect(g).connect(a.destination);
        src.start();
      } else if (type === 'pocket') {
        if (throttled('pocket', 80)) return;
        // 落袋：低频闷响 + 短滚动
        const o = a.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(190, a.currentTime);
        o.frequency.exponentialRampToValueAtTime(70, a.currentTime + 0.16);
        const g = a.createGain();
        g.gain.setValueAtTime(0.45, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.22);
        o.connect(g).connect(a.destination);
        o.start(); o.stop(a.currentTime + 0.25);
        const src = a.createBufferSource();
        src.buffer = noiseBuffer(a, 0.12);
        const lp = a.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 800;
        const g2 = a.createGain();
        g2.gain.setValueAtTime(0.25, a.currentTime + 0.02);
        g2.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.16);
        src.connect(lp).connect(g2).connect(a.destination);
        src.start(a.currentTime + 0.02);
      } else if (type === 'strike') {
        // 出杆击球
        const src = a.createBufferSource();
        src.buffer = noiseBuffer(a, 0.03);
        const bp = a.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 0.8;
        const g = a.createGain();
        g.gain.setValueAtTime(v * 0.9, a.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.05);
        src.connect(bp).connect(g).connect(a.destination);
        src.start();
      }
    } catch (e) { /* 音频不可用时静默 */ }
  }

  return { play, unlock: ac };
})();
