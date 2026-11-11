/* ============================================================
 * main.js — 游戏主循环、输入与 UI（3D 版）
 *   左键拖动：转动瞄准 / 调视角高度     滚轮：远近
 *   右键下拉（或右侧拉杆、空格）：拉杆蓄力，松开出杆
 * ============================================================ */

(() => {
  const canvas = document.getElementById('table');
  const renderer = new Renderer3D(canvas);
  const world = new PhysicsWorld();
  world.onSound = (t, i) => Sound.play(t, i);

  let game = null;         // EightBallGame
  let ai = null;           // BilliardAI（人机模式）
  let mode = 'ai';
  let difficulty = 1;

  // 输入 / 回合状态
  const aim = { angle: 0, power: 0 };
  let charging = null;         // null | 'drag' | 'key'
  let chargeStartY = 0;
  let dragAim = null;          // 左键拖动瞄准：{x, y}
  let shotActive = false;      // 球正在滚动
  let placingBall = false;     // 自由球放置模式（人类）
  let ghost = null;            // 放置预览
  const spin = { a: 0, b: 0 };
  let viewMode = 'aim';        // 'aim' 杆后视角 | 'top' 俯视
  let showGuide = true;
  let stroke = null;           // 出杆动画 {t, dur, from, angle, power, a, b}
  let follow = 0;              // 出杆后的随球动作计时
  let shotCam = { angle: 0, x: TABLE.W / 2, y: TABLE.H / 2 };
  let snapCam = 0;             // 拖动瞄准时相机紧跟
  let feather = 0;

  // AI 回合状态机
  let aiPhase = null;          // 'think' | 'aim' | 'charge' | null
  let aiTimer = 0;
  let aiShot = null;
  let aiAimFrom = 0;

  /* ================= 游戏流程 ================= */

  function startGame(m) {
    mode = m;
    game = new EightBallGame(world, m);
    ai = m === 'ai' ? new BilliardAI(world, game, difficulty) : null;
    shotActive = false; charging = null; aiPhase = null; aiShot = null; stroke = null; follow = 0;
    spin.a = 0; spin.b = 0; updateSpinDot();
    aim.power = 0; aim.angle = 0;
    updatePowerBar(0);
    placingBall = game.ballInHand && isHumanTurn();
    ghost = null;
    hide('menu'); hide('gameover'); hide('help');
    updateHUD();
    if (m === 'free') {
      toast('练习模式 — 随意击球');
    } else {
      toast(placingBall ? '开球：点击台面放置白球（限开球线后）' : '开球！');
    }
  }

  function isHumanTurn() {
    if (!game || game.over) return false;
    if (mode === 'ai') return game.current === 0;
    return true;
  }

  function idle() { return !shotActive && !world.anyMoving && !stroke; }
  function canAim() { return game && !game.over && isHumanTurn() && idle() && !placingBall; }

  // 蓄力后拉距离（毫米）
  function pullFor(p) { return 14 + p * 260; }

  // 开始出杆：球杆先向前送，杆头碰到球的瞬间才真正击球
  function beginStroke(angle, power, sA, sB) {
    const cue = world.cue;
    if (!cue || cue.potted) return;
    charging = null;
    stroke = { t: 0, dur: 0.13 - 0.07 * power, from: pullFor(power), angle, power, a: sA, b: sB };
  }

  function fireShot(s) {
    const cue = world.cue;
    Sound.play('strike', s.power);
    shotCam = { angle: s.angle, x: cue.x, y: cue.y };
    world.strike(cue, s.angle, s.power, s.a, s.b);
    shotActive = true;
    follow = 0.001;
    aim.power = 0;
    updatePowerBar(0);
  }

  function onShotSettled() {
    shotActive = false;
    const ev = world.events;
    const verdict = game.judge(ev);
    spin.a = 0; spin.b = 0; updateSpinDot();
    if (verdict.msg) toast(verdict.msg);
    updateHUD();
    if (verdict.gameOver) {
      showGameOver();
      return;
    }
    // 自由球 → 人类进入放置模式；AI 在 think 阶段自行放置
    placingBall = game.ballInHand && isHumanTurn();
    ghost = null;
    if (placingBall) {
      setTimeout(() => toast(game.behindLine ? '自由球：点击台面放置白球（限开球线后）' : '自由球：点击台面任意位置放置白球'), 900);
    }
    // 兜底：白球落袋后必须回到台面
    if (!world.cue || world.cue.potted) game.placeCueSafe();
    if (isHumanTurn() && !placingBall) autoAim();
  }

  // 轮到玩家时，把瞄准方向转向最近的合法目标球，省得满场找球
  function autoAim() {
    const cue = world.cue;
    if (!cue || cue.potted) return;
    const ids = game.legalTargets(game.current);
    let best = null, bd = Infinity;
    for (const b of world.activeBalls()) {
      if (!ids.includes(b.id)) continue;
      const d = Math.hypot(b.x - cue.x, b.y - cue.y);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) aim.angle = Math.atan2(best.y - cue.y, best.x - cue.x);
  }

  function showGameOver() {
    const win = game.winner;
    const youWin = mode !== 'ai' || win === 0;
    document.getElementById('go-title').textContent =
      mode === 'ai' ? (youWin ? '🏆 胜利！' : '💀 失败') : `🏆 ${game.playerName(win)} 获胜！`;
    document.getElementById('go-detail').textContent = game.winReason;
    show('gameover');
  }

  /* ================= AI 回合 ================= */

  function updateAI(dt) {
    if (!ai || game.over || !idle()) return;
    if (game.current !== 1) { aiPhase = null; return; }

    if (aiPhase === null) {
      aiPhase = 'think';
      aiTimer = ai.thinkTime();
      setMsg('AI 思考中…');
      return;
    }
    aiTimer -= dt * 1000;
    if (aiPhase === 'think' && aiTimer <= 0) {
      if (game.ballInHand) {
        const p = ai.placeCueBall();
        world.respotCue(p.x, p.y);
        game.ballInHand = false;
      }
      aiShot = ai.decide();
      aiAimFrom = aim.angle;
      aiPhase = 'aim';
      aiTimer = 800;
      setMsg(`AI：${aiShot.desc}`);
    } else if (aiPhase === 'aim') {
      const t = Math.max(0, Math.min(1, 1 - aiTimer / 800));
      aim.angle = lerpAngle(aiAimFrom, aiShot.angle, easeInOut(t));
      if (aiTimer <= 0) {
        aiPhase = 'charge';
        aiTimer = 450 + aiShot.power * 400;
      }
    } else if (aiPhase === 'charge') {
      const total = 450 + aiShot.power * 400;
      const t = Math.max(0, Math.min(1, 1 - aiTimer / total));
      aim.power = aiShot.power * t;
      updatePowerBar(aim.power);
      if (aiTimer <= 0) {
        aiPhase = null;
        beginStroke(aiShot.angle, aiShot.power, aiShot.spinA || 0, aiShot.spinB || 0);
      }
    }
  }

  /* ================= 主循环 ================= */

  let lastT = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    feather += dt;
    if (snapCam > 0) snapCam -= dt;

    const state = { world, cue: null, guide: null, ghost: null, behindLine: false,
                    cam: { mode: 'orbit', angle: 0, x: 0, y: 0, snap: false } };

    if (game) {
      // 空格蓄力：按住越久力度越大
      if (charging === 'key' && canAim()) {
        aim.power = Math.min(1, aim.power + dt / 1.6);
        updatePowerBar(aim.power);
      }
      if (stroke) {
        stroke.t += dt;
        if (stroke.t >= stroke.dur) { const s = stroke; stroke = null; fireShot(s); }
      }
      if (shotActive || world.anyMoving) {
        world.update(dt);
        if (shotActive && !world.anyMoving) onShotSettled();
      } else if (!stroke) {
        updateAI(dt);
      }
      if (follow > 0) { follow += dt; if (follow > 0.45) follow = 0; }

      const cue = world.cue;
      const humanAiming = canAim() || (stroke && isHumanTurn());
      const aiAiming = !isHumanTurn() && !game.over && (aiPhase === 'aim' || aiPhase === 'charge' || stroke);
      const cueOk = cue && !cue.potted;

      // 球杆
      if (cueOk && (humanAiming || aiAiming)) {
        let pull;
        if (stroke) {
          const k = Math.min(1, stroke.t / stroke.dur);
          pull = stroke.from * (1 - k * k);            // 加速前送
        } else {
          pull = pullFor(aim.power) + (aim.power === 0 ? Math.sin(feather * 2.2) * 5 + 5 : 0);
        }
        const s = stroke || { angle: aim.angle, a: spin.a, b: spin.b };
        const useSpin = isHumanTurn() || stroke;
        state.cue = { x: cue.x, y: cue.y, angle: s.angle, pull,
                      a: useSpin ? s.a : 0, b: useSpin ? s.b : 0 };
      } else if (follow > 0 && follow < 0.3) {
        // 击球后球杆随球送出一小段再收回
        state.cue = { x: shotCam.x, y: shotCam.y, angle: shotCam.angle, pull: -Math.min(70, follow * 900), a: 0, b: 0 };
      }
      // 辅助线
      if (cueOk && !stroke && (humanAiming || aiAiming) && showGuide) {
        state.guide = { angle: aim.angle, full: mode === 'free' };
      }
      // 自由球
      if (placingBall) {
        state.ghost = ghost;
        state.behindLine = game.behindLine;
      }
      // 相机
      const c = state.cam;
      if (game.over) c.mode = 'orbit';
      else if (placingBall || viewMode === 'top') c.mode = 'top';
      else if (!isHumanTurn() && !(shotActive || world.anyMoving)) c.mode = 'side';
      else if (shotActive || world.anyMoving) {
        if (mode === 'ai' && game.current === 1) c.mode = 'side';
        else { c.mode = 'shot'; c.angle = shotCam.angle; c.x = shotCam.x; c.y = shotCam.y; }
      } else if (cueOk) {
        c.mode = 'aim'; c.angle = stroke ? stroke.angle : aim.angle; c.x = cue.x; c.y = cue.y;
        c.snap = snapCam > 0;
      } else c.mode = 'side';
    }
    renderer.draw(state, dt);
    requestAnimationFrame(loop);
  }

  /* ================= 输入 ================= */

  function startCharge(clientY) {
    if (!canAim()) return;
    charging = 'drag';
    chargeStartY = clientY;
    aim.power = 0;
  }

  function releaseCharge() {
    if (!charging) return;
    charging = null;
    if (aim.power > 0.015 && canAim()) {
      beginStroke(aim.angle, aim.power, spin.a, spin.b);
    } else {
      aim.power = 0;
      updatePowerBar(0);
    }
  }

  function aimAtPointer(e) {
    const cue = world.cue;
    const p = renderer.pick(e.clientX, e.clientY);
    if (!p || !cue) return;
    if (Math.hypot(p.x - cue.x, p.y - cue.y) > TABLE.R) {
      aim.angle = Math.atan2(p.y - cue.y, p.x - cue.x);
    }
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('mousedown', e => {
    if (!game || game.over) return;
    Sound.unlock();
    if (placingBall) {
      if (e.button !== 0) return;
      const p = renderer.pick(e.clientX, e.clientY);
      if (p && validPlacement(p.x, p.y)) {
        world.respotCue(p.x, p.y);
        game.ballInHand = false;
        placingBall = false;
        ghost = null;
        autoAim();
        toast('白球已放置，开始瞄准');
      } else {
        toast('这里不能放置白球');
      }
      return;
    }
    if (e.button === 2) { startCharge(e.clientY); e.preventDefault(); return; }
    if (e.button !== 0) return;
    dragAim = { x: e.clientX, y: e.clientY };
    if (viewMode === 'top' && canAim()) aimAtPointer(e);
  });

  window.addEventListener('mousemove', e => {
    if (!game || game.over) return;
    if (placingBall) {
      if (e.target !== canvas) return;
      const p = renderer.pick(e.clientX, e.clientY);
      ghost = p ? { x: p.x, y: p.y, valid: validPlacement(p.x, p.y) } : null;
      return;
    }
    if (charging === 'drag') {
      // 向下拉 = 向后拉杆；小力段更细腻
      const t = Math.max(0, Math.min(1, (e.clientY - chargeStartY) / 280));
      aim.power = Math.pow(t, 1.35);
      updatePowerBar(aim.power);
      return;
    }
    if (dragAim) {
      const dx = e.clientX - dragAim.x, dy = e.clientY - dragAim.y;
      dragAim.x = e.clientX; dragAim.y = e.clientY;
      if (viewMode === 'top') {
        if (canAim()) aimAtPointer(e);
      } else {
        const k = e.shiftKey ? 0.00035 : 0.0042;
        if (canAim()) { aim.angle -= dx * k; snapCam = 0.25; }
        if (!e.shiftKey) renderer.orbit(dy * 0.004);
      }
    }
  });

  window.addEventListener('mouseup', e => {
    if (e.button === 0) dragAim = null;
    if (charging === 'drag') releaseCharge();
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    renderer.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  // 右侧拉杆
  const pull = document.getElementById('pull');
  pull.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    Sound.unlock();
    startCharge(e.clientY);
    e.preventDefault();
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'v' || e.key === 'V') { toggleView(); return; }
    if (e.key === 'g' || e.key === 'G') { toggleGuide(); return; }
    if (!canAim()) return;
    const fine = e.shiftKey ? 0.0006 : 0.004;
    if (e.key === 'ArrowLeft') { aim.angle += fine; snapCam = 0.25; e.preventDefault(); }
    else if (e.key === 'ArrowRight') { aim.angle -= fine; snapCam = 0.25; e.preventDefault(); }
    else if (e.key === 'ArrowUp') { renderer.orbit(0.03); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { renderer.orbit(-0.03); e.preventDefault(); }
    else if (e.code === 'Space') {
      e.preventDefault();
      if (!charging && !e.repeat) { Sound.unlock(); charging = 'key'; aim.power = 0; }
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space' && charging === 'key') releaseCharge();
  });

  function validPlacement(x, y) {
    if (!world.canPlace(x, y)) return false;
    if (game.behindLine && x > TABLE.HEAD_X - TABLE.R) return false;
    return true;
  }

  function toggleView() {
    viewMode = viewMode === 'aim' ? 'top' : 'aim';
    document.getElementById('btn-view').textContent = viewMode === 'aim' ? '俯视 (V)' : '杆后 (V)';
  }
  function toggleGuide() {
    showGuide = !showGuide;
    document.getElementById('btn-guide').classList.toggle('off', !showGuide);
  }

  /* ---------- 击球点（加塞）选择 ---------- */
  const spinBall = document.getElementById('spin-ball');
  spinBall.addEventListener('mousedown', e => {
    const move = ev => {
      const rect = spinBall.getBoundingClientRect();
      let dx = (ev.clientX - rect.left - rect.width / 2) / (rect.width / 2 * 0.8);
      let dy = (ev.clientY - rect.top - rect.height / 2) / (rect.height / 2 * 0.8);
      const r = Math.hypot(dx, dy);
      if (r > 1) { dx /= r; dy /= r; }
      spin.a = dx;
      spin.b = -dy;
      updateSpinDot();
    };
    move(e);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  });
  spinBall.addEventListener('dblclick', () => { spin.a = 0; spin.b = 0; updateSpinDot(); });

  function updateSpinDot() {
    const dot = document.getElementById('spin-dot');
    dot.style.left = (50 + spin.a * 40) + '%';
    dot.style.top = (50 - spin.b * 40) + '%';
  }

  /* ================= HUD ================= */

  function updateHUD() {
    if (!game) return;
    const free = mode === 'free';
    document.getElementById('name-0').textContent = free ? '练习模式' : game.playerName(0);
    document.getElementById('name-1').textContent = free ? '' : game.playerName(1);
    document.getElementById('panel-1').style.visibility = free ? 'hidden' : 'visible';
    for (const i of [0, 1]) {
      const g = game.groups[i];
      document.getElementById(`group-${i}`).textContent =
        free ? '打进所有球即可' : (g ? game.groupName(g) : '花色未定');
      document.getElementById(`panel-${i}`).classList.toggle('active', !free && game.current === i && !game.over);
      renderTray(i, g, free);
    }
    document.getElementById('turn-arrow').classList.toggle('p1', !free && game.current === 1);
    setMsg(free ? '' : `${game.playerName(game.current)}击球`);
  }

  function renderTray(i, group, free) {
    const el = document.getElementById(`tray-${i}`);
    el.innerHTML = '';
    if (free || !group) return;
    const ids = group === 'solid' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
    const alive = new Set(world.activeBalls().map(b => b.id));
    for (const id of ids) {
      const d = document.createElement('div');
      d.className = 'tray-ball' + (alive.has(id) ? '' : ' done');
      d.style.background = BALL_COLORS[id];
      d.textContent = id;
      el.appendChild(d);
    }
  }

  function setMsg(t) { document.getElementById('game-msg').textContent = t; }

  let toastTimer = null;
  function toast(t) {
    const el = document.getElementById('toast');
    el.textContent = t;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function updatePowerBar(p) {
    document.getElementById('power-fill').style.width = (p * 100) + '%';
    document.getElementById('power-pct').textContent = Math.round(p * 100) + '%';
    document.getElementById('pull-knob').style.top = (p * 100) + '%';
    document.getElementById('pull-fill').style.height = (p * 100) + '%';
  }

  /* ================= 菜单 ================= */

  document.querySelectorAll('.menu-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => startGame(btn.dataset.mode));
  });
  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      difficulty = +btn.dataset.diff;
      document.querySelectorAll('.diff-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  document.getElementById('btn-menu').addEventListener('click', () => show('menu'));
  document.getElementById('btn-help').addEventListener('click', () => show('help'));
  document.getElementById('btn-view').addEventListener('click', toggleView);
  document.getElementById('btn-guide').addEventListener('click', toggleGuide);
  document.getElementById('btn-close-help').addEventListener('click', () => hide('help'));
  document.getElementById('btn-rematch').addEventListener('click', () => startGame(mode));
  document.getElementById('btn-backmenu').addEventListener('click', () => { hide('gameover'); show('menu'); });

  function show(id) { document.getElementById(id).classList.remove('hidden'); }
  function hide(id) { document.getElementById(id).classList.add('hidden'); }

  /* ================= 工具 ================= */

  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  /* ================= 启动 ================= */

  window.addEventListener('resize', () => renderer.resize());
  renderer.resize();
  world.setupRack();          // 菜单背景先摆一副球
  requestAnimationFrame(loop);

  // 调试/自动化测试入口
  window.__pool = { world, renderer, aim, get game() { return game; }, beginStroke };
})();
