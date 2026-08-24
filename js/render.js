/* ============================================================
 * render.js — 渲染层（Canvas 2D）
 * ============================================================ */

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.LW = TABLE.W + TABLE.MARGIN * 2;   // 逻辑宽
    this.LH = TABLE.H + TABLE.MARGIN * 2;   // 逻辑高
    this.scale = 1;
    this.clothPattern = null;
  }

  /* 画布自适应窗口 */
  fit(availW, availH) {
    const dpr = window.devicePixelRatio || 1;
    const s = Math.min(availW / this.LW, availH / this.LH);
    this.canvas.style.width = (this.LW * s) + 'px';
    this.canvas.style.height = (this.LH * s) + 'px';
    this.canvas.width = Math.round(this.LW * s * dpr);
    this.canvas.height = Math.round(this.LH * s * dpr);
    this.scale = s * dpr;
  }

  /* 屏幕坐标 → 台面坐标 */
  toTable(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = (clientX - rect.left) / rect.width * this.LW;
    const sy = (clientY - rect.top) / rect.height * this.LH;
    return { x: sx - TABLE.MARGIN, y: sy - TABLE.MARGIN };
  }

  draw(state) {
    const { ctx } = this;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, this.LW, this.LH);
    this.drawFrame();
    ctx.save();
    ctx.translate(TABLE.MARGIN, TABLE.MARGIN);
    this.drawCloth(state);
    this.drawPockets();
    this.drawRails();
    if (state.showBreakLine) this.drawBreakLine(state.behindLine);
    this.drawSinkingBalls(state.world);
    if (state.aim && !state.world.anyMoving) this.drawAimGuide(state);
    this.drawBalls(state.world);
    if (state.aim && !state.world.anyMoving && state.cueVisible) this.drawCueStick(state);
    if (state.ballInHandGhost) this.drawBallInHandGhost(state.ballInHandGhost);
    ctx.restore();
  }

  /* ---------- 木框 ---------- */
  drawFrame() {
    const { ctx } = this;
    const M = TABLE.MARGIN;
    const g = ctx.createLinearGradient(0, 0, 0, this.LH);
    g.addColorStop(0, '#6b4423');
    g.addColorStop(0.5, '#54351b');
    g.addColorStop(1, '#3f2713');
    ctx.fillStyle = g;
    roundRect(ctx, 0, 0, this.LW, this.LH, 26);
    ctx.fill();
    // 内框高光
    ctx.strokeStyle = 'rgba(255, 214, 150, .18)';
    ctx.lineWidth = 3;
    roundRect(ctx, 5, 5, this.LW - 10, this.LH - 10, 22);
    ctx.stroke();
    // 钻石点位
    ctx.fillStyle = '#e8d9b0';
    const M2 = M / 2;
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      const x = M + TABLE.W * i / 8;
      dot(ctx, x, M2, 6); dot(ctx, x, this.LH - M2, 6);
    }
    for (let i = 1; i < 4; i++) {
      const y = M + TABLE.H * i / 4;
      dot(ctx, M2, y, 6); dot(ctx, this.LW - M2, y, 6);
    }
  }

  /* ---------- 台呢 ---------- */
  drawCloth(state) {
    const { ctx } = this;
    const cushion = 40; // 库边呢子视觉厚度
    const g = ctx.createRadialGradient(
      TABLE.W / 2, TABLE.H / 2, 100,
      TABLE.W / 2, TABLE.H / 2, TABLE.W * 0.62);
    g.addColorStop(0, '#2e7d46');
    g.addColorStop(1, '#1d5c31');
    ctx.fillStyle = g;
    ctx.fillRect(-cushion, -cushion, TABLE.W + cushion * 2, TABLE.H + cushion * 2);
    // 置球点
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    dot(ctx, TABLE.FOOT_X, TABLE.H / 2, 5);
    dot(ctx, TABLE.HEAD_X, TABLE.H / 2, 5);
  }

  drawBreakLine(restricted) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.30)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([14, 12]);
    ctx.beginPath();
    ctx.moveTo(TABLE.HEAD_X, 0);
    ctx.lineTo(TABLE.HEAD_X, TABLE.H);
    ctx.stroke();
    if (restricted) {
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(0, 0, TABLE.HEAD_X, TABLE.H);
    }
    ctx.restore();
  }

  /* ---------- 库边 ---------- */
  drawRails() {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = '#237040';
    ctx.lineCap = 'round';
    ctx.lineWidth = 30;
    for (const s of TABLE.rails) {
      // 只画主库边（斜面短段颜色略深）
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();
    }
    // 库边受光高亮
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = 8;
    for (const s of TABLE.rails) {
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPockets() {
    const { ctx } = this;
    for (const p of TABLE.pockets) {
      const g = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, p.r + 14);
      g.addColorStop(0, '#000');
      g.addColorStop(0.72, '#0a0a0a');
      g.addColorStop(1, '#233');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 13, 0, Math.PI * 2);
      ctx.fill();
      // 金属袋口环
      ctx.strokeStyle = 'rgba(210,180,120,.35)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 11, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /* ---------- 球 ---------- */
  drawBalls(world) {
    for (const b of world.balls) {
      if (b.potted) continue;
      this.drawBall(b.x, b.y, TABLE.R, b.id, 1, b);
    }
  }

  drawSinkingBalls(world) {
    for (const b of world.balls) {
      if (!b.potted || b.sink >= 1 || b.sinkPocket === null) continue;
      const p = TABLE.pockets[b.sinkPocket];
      const t = b.sink;
      const x = b.x + (p.x - b.x) * t;
      const y = b.y + (p.y - b.y) * t;
      this.drawBall(x, y, TABLE.R * (1 - t * 0.55), b.id, 1 - t * 0.6, b);
    }
  }

  drawBall(x, y, r, id, alpha, ball) {
    const { ctx } = this;
    const color = BALL_COLORS[id];
    ctx.save();
    ctx.globalAlpha = alpha;
    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.18, y + r * 0.30, r * 0.95, r * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
    // 本体
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.42, r * 0.15, x, y, r * 1.25);
    if (isStripe(id)) {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#c9c4b4');
    } else {
      g.addColorStop(0, lighten(color, id === 8 ? 0.35 : 0.5));
      g.addColorStop(0.65, color);
      g.addColorStop(1, darken(color, 0.45));
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // 花色带
    if (isStripe(id)) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      const bandH = r * 1.15;
      const wob = ball ? Math.sin(ball.rollAngle * 0.7) * r * 0.16 : 0;
      const sg = ctx.createLinearGradient(x, y - bandH, x, y + bandH);
      sg.addColorStop(0, darken(color, 0.3));
      sg.addColorStop(0.35, lighten(color, 0.25));
      sg.addColorStop(0.6, color);
      sg.addColorStop(1, darken(color, 0.4));
      ctx.fillStyle = sg;
      ctx.fillRect(x - r, y - bandH / 2 + wob, r * 2, bandH);
      ctx.restore();
    }
    // 号码圈
    if (id > 0) {
      const nr = r * 0.42;
      ctx.fillStyle = '#f5f2e6';
      ctx.beginPath();
      ctx.arc(x, y, nr, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      ctx.font = `bold ${Math.max(8, nr * 1.25)}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(id), x, y + nr * 0.06);
    }
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.beginPath();
    ctx.ellipse(x - r * 0.34, y - r * 0.42, r * 0.20, r * 0.13, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ---------- 瞄准辅助 ---------- */
  drawAimGuide(state) {
    const { ctx } = this;
    const cue = state.world.cue;
    if (!cue || cue.potted) return;
    const trace = state.world.traceAim(cue, state.aim.angle);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.65)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(cue.x, cue.y);
    ctx.lineTo(trace.x, trace.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (trace.type === 'ball') {
      // 假想球
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(trace.x, trace.y, TABLE.R, 0, Math.PI * 2);
      ctx.stroke();
      // 目标球去向
      const L = 190;
      ctx.strokeStyle = 'rgba(255, 224, 120, .9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(trace.targetBall.x, trace.targetBall.y);
      ctx.lineTo(trace.targetBall.x + trace.targetDir.x * L,
                 trace.targetBall.y + trace.targetDir.y * L);
      ctx.stroke();
      // 白球分离方向（切线）
      const dx = Math.cos(state.aim.angle), dy = Math.sin(state.aim.angle);
      const dot2 = dx * trace.targetDir.x + dy * trace.targetDir.y;
      let tx = dx - trace.targetDir.x * dot2, ty = dy - trace.targetDir.y * dot2;
      const tl = Math.hypot(tx, ty);
      if (tl > 0.05) {
        tx /= tl; ty /= tl;
        ctx.strokeStyle = 'rgba(150, 210, 255, .8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(trace.x, trace.y);
        ctx.lineTo(trace.x + tx * 110, trace.y + ty * 110);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawCueStick(state) {
    const { ctx } = this;
    const cue = state.world.cue;
    if (!cue || cue.potted) return;
    const ang = state.aim.angle;
    const pull = 34 + state.aim.power * 190;   // 蓄力后拉
    const len = 900;
    const bx = cue.x - Math.cos(ang) * pull;
    const by = cue.y - Math.sin(ang) * pull;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(ang);
    // 杆身
    const g = ctx.createLinearGradient(-len, 0, 0, 0);
    g.addColorStop(0, '#3d2413');
    g.addColorStop(0.55, '#8a5a2e');
    g.addColorStop(0.97, '#c89b62');
    g.addColorStop(1, '#e8e2d2');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-len, -9);
    ctx.lineTo(-14, -4.5);
    ctx.lineTo(-14, 4.5);
    ctx.lineTo(-len, 9);
    ctx.closePath();
    ctx.fill();
    // 皮头
    ctx.fillStyle = '#3b6ea5';
    ctx.fillRect(-14, -4.5, 8, 9);
    ctx.restore();
  }

  drawBallInHandGhost(g) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.6;
    this.drawBall(g.x, g.y, TABLE.R, 0, 0.7, null);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = g.valid ? 'rgba(120, 230, 130, .9)' : 'rgba(230, 90, 80, .9)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(g.x, g.y, TABLE.R + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/* ---------- 小工具 ---------- */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
function lighten(hex, f) { return shade(hex, f); }
function darken(hex, f) { return shade(hex, -f); }
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  else { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
