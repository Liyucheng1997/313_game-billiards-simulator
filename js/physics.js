/* ============================================================
 * physics.js — 台球物理引擎
 *  - 滑动 / 滚动摩擦两阶段模型（真实的跟进 / 缩杆由此自然产生）
 *  - 三维角速度：wx, wy（滚动轴）+ wz（侧旋/加塞）
 *  - 库边反弹：法向恢复系数 + 切向摩擦 + 侧旋改变反弹角
 *  - 球-球碰撞：等质量弹性碰撞，旋转在碰撞中保留
 * 单位：毫米、秒、弧度
 * ============================================================ */

const Phys = {
  G: 9800,            // 重力加速度 mm/s^2
  MU_SLIDE: 0.21,     // 滑动摩擦系数（球与台呢）
  MU_ROLL: 0.011,     // 滚动阻力系数
  SPIN_DECAY: 12,     // 侧旋衰减 rad/s^2
  E_BALL: 0.94,       // 球-球恢复系数
  E_CUSHION: 0.78,    // 库边法向恢复系数
  CUSHION_FRICTION: 0.16, // 库边切向摩擦强度
  MAX_V: 7600,        // 满力杆速 mm/s
  STOP_V: 6,          // 低于此速度视为静止
  DT: 1 / 600,        // 物理子步长
};

class Ball {
  constructor(id, x, y) {
    this.id = id;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.wx = 0; this.wy = 0; this.wz = 0;  // 角速度
    this.potted = false;
    this.sink = 0;            // 落袋动画进度 0-1
    this.sinkPocket = null;
    this.rollAngle = Math.random() * Math.PI * 2; // 渲染用滚动相位
  }
  get speed() { return Math.hypot(this.vx, this.vy); }
  get moving() {
    return !this.potted && (this.speed > Phys.STOP_V ||
      Math.hypot(this.wx, this.wy) * TABLE.R > Phys.STOP_V * 3);
  }
}

class PhysicsWorld {
  constructor() {
    this.balls = [];
    this.events = this.freshEvents();
    this.onSound = null;   // (type, intensity) 回调
  }

  freshEvents() {
    return { firstHit: null, potted: [], cuePotted: false,
             railAfterContact: false, anyRail: false, cueOffTable: false };
  }

  reset() { this.events = this.freshEvents(); }

  get cue() { return this.balls.find(b => b.id === 0); }
  get anyMoving() { return this.balls.some(b => b.moving || (b.potted && b.sink < 1)); }

  activeBalls() { return this.balls.filter(b => !b.potted); }

  /* ---------- 击球 ---------- */
  strike(ball, angle, power, spinA, spinB) {
    // power 0-1；spinA 横向击点 [-1,1] 右为正；spinB 纵向 [-1,1] 上为正
    const speed = Math.max(0.05, power) * Phys.MAX_V;
    // 侧旋带来的出杆偏移（squirt）
    const a = angle - spinA * 0.015 * power;
    const dx = Math.cos(a), dy = Math.sin(a);
    ball.vx = dx * speed;
    ball.vy = dy * speed;
    const R = TABLE.R;
    // 高低杆：绕滚动轴的角速度（spinB>0 高杆=前旋，<0 低杆=后旋）
    const topMag = 5 * speed * spinB * 0.85 / (2 * R);
    ball.wx = -dy * topMag;
    ball.wy = dx * topMag;
    // 侧旋（加塞）
    ball.wz = spinA * 5 * speed * 0.6 / (2 * R);
    this.reset();
  }

  /* ---------- 主步进：一帧内跑若干物理子步 ---------- */
  update(frameDt) {
    const steps = Math.max(1, Math.round(frameDt / Phys.DT));
    for (let s = 0; s < steps; s++) this.substep(Phys.DT);
    for (const b of this.balls) {
      if (b.potted && b.sink < 1) b.sink = Math.min(1, b.sink + frameDt * 3.2);
    }
  }

  substep(dt) {
    for (const b of this.balls) {
      if (!b.potted) this.stepBallMotion(b, dt);
    }
    const act = this.activeBalls();
    for (let i = 0; i < act.length; i++) {
      for (let j = i + 1; j < act.length; j++) {
        this.collideBalls(act[i], act[j]);
      }
    }
    for (const b of this.activeBalls()) {
      this.collideRails(b);
      this.checkPockets(b);
      this.failsafeBounds(b);
    }
  }

  stepBallMotion(b, dt) {
    const R = TABLE.R;
    const sp = b.speed;
    // 静止判定
    if (sp < Phys.STOP_V && Math.hypot(b.wx, b.wy) * R < Phys.STOP_V * 3) {
      b.vx = b.vy = b.wx = b.wy = 0;
      if (Math.abs(b.wz) < 2) b.wz = 0;
      else { // 原地侧旋衰减
        const d = Phys.SPIN_DECAY * dt;
        b.wz -= Math.sign(b.wz) * Math.min(d, Math.abs(b.wz));
      }
      return;
    }
    // 接触点相对台面的滑动速度 u = v + ω × (-R ẑ) = (vx - R·ωy, vy + R·ωx)
    const ux = b.vx - R * b.wy;
    const uy = b.vy + R * b.wx;
    const u = Math.hypot(ux, uy);

    if (u > 10) {
      // —— 滑动阶段 ——
      const acc = Phys.MU_SLIDE * Phys.G;
      const fx = -acc * ux / u, fy = -acc * uy / u;   // 单位质量摩擦力
      b.vx += fx * dt;
      b.vy += fy * dt;
      // dω/dt = (5/2R)·(f_y, -f_x)  （摩擦力矩 / 转动惯量）
      const k = 5 / (2 * R);
      b.wx += k * fy * dt;
      b.wy += k * (-fx) * dt;
    } else {
      // —— 纯滚动阶段 ——
      if (sp > 0) {
        const dec = Math.min(Phys.MU_ROLL * Phys.G * dt, sp);
        b.vx -= dec * b.vx / sp;
        b.vy -= dec * b.vy / sp;
      }
      b.wy = b.vx / R;
      b.wx = -b.vy / R;
    }
    // 侧旋独立衰减
    if (b.wz !== 0) {
      const d = Phys.SPIN_DECAY * dt;
      b.wz = Math.abs(b.wz) <= d ? 0 : b.wz - Math.sign(b.wz) * d;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.rollAngle += b.speed * dt / R;
  }

  collideBalls(a, c) {
    const R = TABLE.R;
    let nx = c.x - a.x, ny = c.y - a.y;
    const dist = Math.hypot(nx, ny);
    if (dist === 0 || dist >= 2 * R) return;
    nx /= dist; ny /= dist;
    // 位置分离
    const overlap = 2 * R - dist;
    a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
    c.x += nx * overlap / 2; c.y += ny * overlap / 2;
    // 沿连心线的弹性碰撞（等质量）
    const rvx = c.vx - a.vx, rvy = c.vy - a.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;
    const jImp = -(1 + Phys.E_BALL) * vn / 2;
    a.vx -= jImp * nx; a.vy -= jImp * ny;
    c.vx += jImp * nx; c.vy += jImp * ny;

    if (this.events.firstHit === null) {
      if (a.id === 0) this.events.firstHit = c.id;
      else if (c.id === 0) this.events.firstHit = a.id;
    }
    if (this.onSound) this.onSound('ball', Math.min(1, Math.abs(vn) / 4200));
  }

  collideRails(b) {
    const R = TABLE.R;
    for (const s of TABLE.rails) {
      const ex = s.bx - s.ax, ey = s.by - s.ay;
      const len2 = ex * ex + ey * ey;
      let t = ((b.x - s.ax) * ex + (b.y - s.ay) * ey) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = s.ax + ex * t, py = s.ay + ey * t;
      let nx = b.x - px, ny = b.y - py;
      const d = Math.hypot(nx, ny);
      if (d === 0 || d >= R) continue;
      nx /= d; ny /= d;
      // 推出嵌入
      const push = R - d;
      b.x += nx * push; b.y += ny * push;
      const vn = b.vx * nx + b.vy * ny;
      if (vn >= 0) continue;
      const tx = -ny, ty = nx;
      const vt = b.vx * tx + b.vy * ty;
      // 接触点相对库边的切向速度（含侧旋贡献），库边摩擦使其收敛
      const rel = vt - R * b.wz;
      const f = -Phys.CUSHION_FRICTION * rel;    // 切向速度修正量
      const newVn = -Phys.E_CUSHION * vn;
      const newVt = (vt + f) * 0.985;
      b.wz += -(5 / (2 * R)) * f;                // 摩擦力矩反作用于侧旋
      b.wx *= 0.92; b.wy *= 0.92;                // 纵旋轻微损耗
      b.vx = nx * newVn + tx * newVt;
      b.vy = ny * newVn + ty * newVt;
      this.events.anyRail = true;
      if (this.events.firstHit !== null) this.events.railAfterContact = true;
      if (this.onSound) this.onSound('cushion', Math.min(1, Math.abs(vn) / 3800));
    }
  }

  checkPockets(b) {
    for (let i = 0; i < TABLE.pockets.length; i++) {
      const p = TABLE.pockets[i];
      if (Math.hypot(b.x - p.x, b.y - p.y) < p.r) {
        b.potted = true;
        b.sink = 0;
        b.sinkPocket = i;
        b.vx = b.vy = b.wx = b.wy = b.wz = 0;
        if (b.id === 0) this.events.cuePotted = true;
        else this.events.potted.push(b.id);
        if (this.onSound) this.onSound('pocket', 0.8);
        return;
      }
    }
  }

  failsafeBounds(b) {
    // 兜底：万一高速穿隧穿出台面
    const R = TABLE.R, m = 70;
    if (b.x < -m || b.x > TABLE.W + m || b.y < -m || b.y > TABLE.H + m) {
      if (b.id === 0) {
        this.events.cueOffTable = true;
        this.events.cuePotted = true;
        b.potted = true; b.sink = 1;
      } else {
        b.x = Math.max(R, Math.min(TABLE.W - R, b.x));
        b.y = Math.max(R, Math.min(TABLE.H - R, b.y));
        b.vx *= -0.3; b.vy *= -0.3;
      }
    }
  }

  /* ---------- 摆球 / 放球 ---------- */
  setupRack() {
    this.balls = [];
    this.balls.push(new Ball(0, TABLE.HEAD_X, TABLE.H / 2));
    for (const p of TABLE.rackPositions()) {
      this.balls.push(new Ball(p.id, p.x, p.y));
    }
    this.reset();
  }

  respotCue(x, y) {
    let cue = this.cue;
    if (!cue) { cue = new Ball(0, x, y); this.balls.unshift(cue); }
    cue.potted = false; cue.sink = 0; cue.sinkPocket = null;
    cue.x = x; cue.y = y;
    cue.vx = cue.vy = cue.wx = cue.wy = cue.wz = 0;
  }

  canPlace(x, y, ignoreId = 0) {
    const R = TABLE.R;
    if (x < R + 2 || x > TABLE.W - R - 2 || y < R + 2 || y > TABLE.H - R - 2) return false;
    for (const b of this.activeBalls()) {
      if (b.id === ignoreId) continue;
      if (Math.hypot(b.x - x, b.y - y) < 2 * R + 1) return false;
    }
    return true;
  }

  /* ---------- 瞄准辅助：沿方向找白球第一个碰撞 ----------
   * 返回 { type:'ball'|'rail'|'none', x, y, targetBall, targetDir } */
  traceAim(cue, angle) {
    const R = TABLE.R;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let bestT = Infinity, hitBall = null;
    for (const b of this.activeBalls()) {
      if (b.id === 0) continue;
      // 圆扫掠：|cue + t·d - b| = 2R
      const ox = b.x - cue.x, oy = b.y - cue.y;
      const proj = ox * dx + oy * dy;
      if (proj <= 0) continue;
      const perp2 = ox * ox + oy * oy - proj * proj;
      const rr = (2 * R) * (2 * R);
      if (perp2 >= rr) continue;
      const t = proj - Math.sqrt(rr - perp2);
      if (t > 0 && t < bestT) { bestT = t; hitBall = b; }
    }
    // 库边求交
    let railT = Infinity;
    for (const s of TABLE.rails) {
      const t = raySegment(cue.x, cue.y, dx, dy, s, R);
      if (t !== null && t < railT) railT = t;
    }
    if (hitBall && bestT < railT) {
      const gx = cue.x + dx * bestT, gy = cue.y + dy * bestT;
      let tdx = hitBall.x - gx, tdy = hitBall.y - gy;
      const tl = Math.hypot(tdx, tdy) || 1;
      return { type: 'ball', x: gx, y: gy, targetBall: hitBall,
               targetDir: { x: tdx / tl, y: tdy / tl }, dist: bestT };
    }
    if (railT < Infinity) {
      return { type: 'rail', x: cue.x + dx * railT, y: cue.y + dy * railT, dist: railT };
    }
    return { type: 'none', x: cue.x + dx * 3000, y: cue.y + dy * 3000, dist: 3000 };
  }
}

// 射线（起点 o，方向 d）与线段 s 的距离-R 偏置求交，返回射线参数 t 或 null
function raySegment(ox, oy, dx, dy, s, R) {
  const ex = s.bx - s.ax, ey = s.by - s.ay;
  const elen = Math.hypot(ex, ey);
  let nx = -ey / elen, ny = ex / elen;
  // 法向朝向射线起点一侧
  const side = (ox - s.ax) * nx + (oy - s.ay) * ny;
  if (side < 0) { nx = -nx; ny = -ny; }
  const denom = dx * nx + dy * ny;
  if (denom >= -1e-9) return null;
  const t = (R - ((ox - s.ax) * nx + (oy - s.ay) * ny)) / denom;
  if (t <= 0) return null;
  const hx = ox + dx * t, hy = oy + dy * t;
  const proj = ((hx - s.ax) * ex + (hy - s.ay) * ey) / (elen * elen);
  if (proj < -0.02 || proj > 1.02) return null;
  return t;
}
