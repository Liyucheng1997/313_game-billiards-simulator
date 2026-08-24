/* ============================================================
 * main.js — 游戏主循环、输入与 UI
 * ============================================================ */

(() => {
  const canvas = document.getElementById('table');
  const renderer = new Renderer(canvas);
  const world = new PhysicsWorld();
  world.onSound = (t, i) => Sound.play(t, i);

  let game = null;         // EightBallGame
  let ai = null;           // BilliardAI（人机模式）
  let mode = 'ai';
  let difficulty = 1;

  // 输入 / 回合状态
  const aim = { angle: 0, power: 0 };
  let charging = false;
  let chargeStart = null;      // 蓄力起点（台面坐标）
  let mousePos = { x: 0, y: 0 };
  let shotActive = false;      // 球正在滚动
  let placingBall = false;     // 自由球放置模式（人类）
  let ghost = null;            // 放置预览
  const spin = { a: 0, b: 0 };

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
    shotActive = false; charging = false; aiPhase = null; aiShot = null;
    spin.a = 0; spin.b = 0; updateSpinDot();
    aim.power = 0;
    placingBall = game.ballInHand && isHumanTurn();
    ghost = null;
    hide('menu'); hide('gameover'); hide('help');
    updateHUD();
    if (m === 'free') {
      toast('练习模式 — 随意击球');
    } else {
      toast(placingBall ? '开球：点击放置白球（限开球线后）' : '开球！');
    }
  }

  function isHumanTurn() {
    if (!game || game.over) return false;
    if (mode === 'ai') return game.current === 0;
    return true;
  }

  function fireShot(angle, power, sA, sB) {
    const cue = world.cue;
    if (!cue || cue.potted) return;
    Sound.play('strike', power);
    world.strike(cue, angle, power, sA, sB);
    shotActive = true;
    charging = false;
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
    if (placingBall) {
      setTimeout(() => toast(game.behindLine ? '自由球：点击放置白球（限开球线后）' : '自由球：点击任意位置放置白球'), 900);
    }
    // 兜底：白球落袋后必须回到台面
    if (!world.cue || world.cue.potted) game.placeCueSafe();
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
    if (!ai || game.over || shotActive || world.anyMoving) return;
    if (game.current !== 1) { aiPhase = null; return; }

    if (aiPhase === null) {
      aiPhase = 'think';
      aiTimer = ai.thinkTime();
      setMsg('AI 思考中…');
      return;
    }
    aiTimer -= dt * 1000;
    if (aiPhase === 'think' && aiTimer <= 0) {
      // 自由球摆放
      if (game.ballInHand) {
        const p = ai.placeCueBall();
        world.respotCue(p.x, p.y);
        game.ballInHand = false;
      }
      aiShot = ai.decide();
      aiAimFrom = aim.angle;
      aiPhase = 'aim';
      aiTimer = 700;
      setMsg(`AI：${aiShot.desc}`);
    } else if (aiPhase === 'aim') {
      const t = Math.max(0, Math.min(1, 1 - aiTimer / 700));
      aim.angle = lerpAngle(aiAimFrom, aiShot.angle, easeInOut(t));
      if (aiTimer <= 0) {
        aiPhase = 'charge';
        aiTimer = 420 + aiShot.power * 380;
      }
    } else if (aiPhase === 'charge') {
      const total = 420 + aiShot.power * 380;
      const t = Math.max(0, Math.min(1, 1 - aiTimer / total));
      aim.power = aiShot.power * t;
      updatePowerBar(aim.power);
      if (aiTimer <= 0) {
        aiPhase = null;
        fireShot(aiShot.angle, aiShot.power, aiShot.spinA || 0, aiShot.spinB || 0);
      }
    }
  }

  /* ================= 主循环 ================= */

  let lastT = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    if (game) {
      if (shotActive || world.anyMoving) {
        world.update(dt);
        if (shotActive && !world.anyMoving) onShotSettled();
      } else {
        updateAI(dt);
      }
      const aimVisible = !placingBall &&
        (isHumanTurn() || aiPhase === 'aim' || aiPhase === 'charge');
      renderer.draw({
        world,
        aim: aimVisible ? aim : null,
        cueVisible: aimVisible,
        showBreakLine: game.breakShot || (game.ballInHand && game.behindLine),
        behindLine: game.ballInHand && game.behindLine,
        ballInHandGhost: placingBall && ghost ? ghost : null,
      });
    }
    requestAnimationFrame(loop);
  }

  /* ================= 输入 ================= */

  canvas.addEventListener('mousemove', e => {
    const p = renderer.toTable(e.clientX, e.clientY);
    mousePos = p;
    if (!game || game.over) return;
    if (placingBall) {
      ghost = { x: p.x, y: p.y, valid: validPlacement(p.x, p.y) };
      return;
    }
    if (!isHumanTurn() || shotActive || world.anyMoving) return;
    const cue = world.cue;
    if (!cue || cue.potted) return;
    if (charging) {
      // 蓄力：沿瞄准反方向拖动的距离
      const dx = p.x - chargeStart.x, dy = p.y - chargeStart.y;
      const back = -(dx * Math.cos(aim.angle) + dy * Math.sin(aim.angle));
      aim.power = Math.max(0, Math.min(1, back / 420));
      updatePowerBar(aim.power);
    } else {
      aim.angle = Math.atan2(p.y - cue.y, p.x - cue.x);
    }
  });

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0 || !game || game.over) return;
    Sound.unlock();
    const p = renderer.toTable(e.clientX, e.clientY);
    if (placingBall) {
      if (validPlacement(p.x, p.y)) {
        world.respotCue(p.x, p.y);
        game.ballInHand = false;
        placingBall = false;
        ghost = null;
        toast('白球已放置，开始瞄准');
      } else {
        toast('这里不能放置白球');
      }
      return;
    }
    if (!isHumanTurn() || shotActive || world.anyMoving) return;
    charging = true;
    chargeStart = p;
    aim.power = 0;
  });

  window.addEventListener('mouseup', e => {
    if (!charging) return;
    charging = false;
    if (aim.power > 0.03) {
      fireShot(aim.angle, aim.power, spin.a, spin.b);
    } else {
      aim.power = 0;
      updatePowerBar(0);
    }
  });

  window.addEventListener('keydown', e => {
    if (!game || !isHumanTurn() || shotActive || world.anyMoving || placingBall) return;
    const fine = e.shiftKey ? 0.0007 : 0.0045;
    if (e.key === 'ArrowLeft') { aim.angle -= fine; e.preventDefault(); }
    else if (e.key === 'ArrowRight') { aim.angle += fine; e.preventDefault(); }
  });

  function validPlacement(x, y) {
    if (!world.canPlace(x, y)) return false;
    if (game.behindLine && x > TABLE.HEAD_X - TABLE.R) return false;
    return true;
  }

  /* ---------- 击球点（加塞）选择 ---------- */
  const spinBall = document.getElementById('spin-ball');
  spinBall.addEventListener('mousedown', e => {
    const move = ev => {
      const rect = spinBall.getBoundingClientRect();
      let dx = (ev.clientX - rect.left - rect.width / 2) / (rect.width / 2);
      let dy = (ev.clientY - rect.top - rect.height / 2) / (rect.height / 2);
      const r = Math.hypot(dx, dy);
      if (r > 0.78) { dx *= 0.78 / r; dy *= 0.78 / r; }
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

  function resize() {
    const wrap = document.getElementById('canvas-wrap');
    renderer.fit(wrap.clientWidth - 24, wrap.clientHeight - 8);
  }
  window.addEventListener('resize', resize);
  resize();
  // 菜单背景先摆一副球
  world.setupRack();
  game = null;
  // 背景渲染（无交互）
  const bgDraw = () => {
    if (!game) {
      renderer.draw({ world, aim: null, cueVisible: false, showBreakLine: false, ballInHandGhost: null });
      requestAnimationFrame(bgDraw);
    }
  };
  bgDraw();
  requestAnimationFrame(loop);
})();
