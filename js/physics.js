/* ============================================================
 * physics.js — 台球物理引擎（参数取自实测文献值）
 *  - 球-台呢：滑动 → 纯滚动两阶段摩擦，过渡点精确求解（跟进/缩杆/定杆自然产生）
 *  - 完整三维角速度 + 姿态四元数（渲染时球真实地滚动、旋转）
 *  - 球-球：恢复系数 + 接触摩擦（产生“投掷效应”和旋转传递），
 *           碰撞时刻回退到精确接触点，薄球切角准确
 *  - 库边：Han(2005) 模型——接触点高于球心，含压陷角、滑动/粘着两种状态，
 *           侧旋改变反弹角、反弹后带出旋转
 *  - 落袋：球心越过石板开孔后受重力下坠，在袋内碰撞
 * 单位：毫米、秒、弧度；球质量取 1。坐标系 x,y 为台面，z 向上（右手系）
 * ============================================================ */

const Phys = {
  G: 9800,              // 重力加速度 mm/s²
  MU_SLIDE: 0.2,        // 球-台呢滑动摩擦系数
  MU_ROLL: 0.0105,      // 滚动阻力系数
  SPIN_DECAY: 11,       // 竖直轴侧旋的角减速度 rad/s²
  E_BALL: 0.95,         // 球-球恢复系数
  E_CUSHION: 0.86,      // 库边恢复系数（Han 模型内，等效法向约 0.75）
  MU_CUSHION: 0.2,      // 球-库边摩擦系数
  MAX_V: 8800,          // 满力杆速 mm/s（约 32 km/h，大力开球）
  MAX_TIP: 0.5,         // 最大击球点偏移（× 球半径，再偏就滑杆）
  DT: 1 / 1000,         // 物理子步长
};

class Ball {
  constructor(id, x, y) {
    this.id = id;
    this.x = x; this.y = y; this.z = 0;       // z：球心相对正常高度的偏移（落袋时为负）
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.wx = 0; this.wy = 0; this.wz = 0;    // 角速度
    this.potted = false;
    this.falling = false;
    this.sink = 0;            // 落袋进度 0-1（1 = 已消失）
    this.sinkPocket = null;
    // 随机初始姿态
    const u1 = Math.random(), u2 = Math.random() * 6.2832, u3 = Math.random() * 6.2832;
    this.qx = Math.sqrt(1 - u1) * Math.sin(u2);
    this.qy = Math.sqrt(1 - u1) * Math.cos(u2);
    this.qz = Math.sqrt(u1) * Math.sin(u3);
    this.qw = Math.sqrt(u1) * Math.cos(u3);
  }
  get speed() { return Math.hypot(this.vx, this.vy); }
  get moving() {
    return !this.potted && (this.vx !== 0 || this.vy !== 0 || this.wx !== 0 || this.wy !== 0);
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

  /* ---------- 击球 ----------
   * power 0-1；spinA 横向击点 [-1,1]（从杆后看，右为正）；spinB 纵向 [-1,1]（上为正）
   * 杆头冲量作用在偏离球心的点上 → ω = 5/(2R²) · (r × v) */
  strike(ball, angle, power, spinA, spinB) {
    let a = spinA * Phys.MAX_TIP, b = spinB * Phys.MAX_TIP;   // 偏移量（× R）
    const off = Math.hypot(a, b);
    if (off > Phys.MAX_TIP) { a *= Phys.MAX_TIP / off; b *= Phys.MAX_TIP / off; }
    // 偏心击球有一部分能量变成旋转，球速略降
    const speed = Math.max(0.03, power) * Phys.MAX_V / (1 + 0.6 * (a * a + b * b));
    // 加塞造成的出杆偏移（squirt）：右塞球向左偏
    const ang = angle + a * 0.045;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    ball.vx = dx * speed;
    ball.vy = dy * speed;
    const k = 2.5 * speed / TABLE.R;
    ball.wx = -dy * k * b;     // 高杆=前旋，低杆=后旋
    ball.wy = dx * k * b;
    ball.wz = k * a;           // 侧旋（加塞）
    this.reset();
  }

  /* ---------- 主步进：一帧内跑若干物理子步 ---------- */
  update(frameDt) {
    const steps = Math.max(1, Math.round(frameDt / Phys.DT));
    for (let s = 0; s < steps; s++) this.substep(Phys.DT);
  }

  substep(dt) {
    const balls = this.balls;
    for (const b of balls) {
      if (b.falling) this.stepFall(b, dt);
      else if (!b.potted) this.stepBallMotion(b, dt);
    }
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.potted) continue;
      for (let j = i + 1; j < balls.length; j++) {
        if (!balls[j].potted) this.collideBalls(a, balls[j], dt);
      }
    }
    for (const b of balls) {
      if (b.potted) continue;
      this.collideRails(b);
      this.checkPockets(b);
      this.failsafeBounds(b);
    }
  }

  /* ---------- 球在台呢上的运动 ---------- */
  stepBallMotion(b, dt) {
    const R = TABLE.R, g = Phys.G;
    // 接触点相对台面的滑动速度 u = v + ω × (-R ẑ) = (vx - R·ωy, vy + R·ωx)
    let ux = b.vx - R * b.wy;
    let uy = b.vy + R * b.wx;
    const u = Math.hypot(ux, uy);
    const moving = b.vx !== 0 || b.vy !== 0;

    if (!moving && u === 0) {
      // 原地陀螺旋转：与台呢的钻孔摩擦使其衰减
      if (b.wz !== 0) {
        const d = Phys.SPIN_DECAY * 2.5 * dt;
        b.wz = Math.abs(b.wz) <= d ? 0 : b.wz - Math.sign(b.wz) * d;
        this.integrateSpin(b, dt);
      }
      return;
    }

    const aS = Phys.MU_SLIDE * g;          // 滑动摩擦加速度
    const uStop = 3.5 * aS * dt;           // 一个子步内滑动速度的衰减量（7/2·μg·dt）
    if (u > uStop) {
      // —— 滑动阶段：摩擦力逆着接触点滑动方向 ——
      const fx = -aS * ux / u, fy = -aS * uy / u;
      b.vx += fx * dt;
      b.vy += fy * dt;
      // dω/dt = (5/2R)·(f_y, -f_x)
      const k = 2.5 / R;
      b.wx += k * fy * dt;
      b.wy -= k * fx * dt;
    } else {
      // —— 本子步内滑动结束，进入纯滚动 ——
      if (u > 0) {
        const tau = u / (3.5 * aS);
        b.vx -= aS * ux / u * tau;
        b.vy -= aS * uy / u * tau;
      }
      const sp = Math.hypot(b.vx, b.vy);
      const dec = Phys.MU_ROLL * g * dt;
      if (sp <= dec) { b.vx = 0; b.vy = 0; }
      else { const f = 1 - dec / sp; b.vx *= f; b.vy *= f; }
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
    this.integrateSpin(b, dt);
  }

  // 姿态四元数积分：q̇ = ½·Ω⊗q（Ω 为世界系角速度）
  integrateSpin(b, dt) {
    const h = 0.5 * dt, wx = b.wx, wy = b.wy, wz = b.wz;
    const qx = b.qx, qy = b.qy, qz = b.qz, qw = b.qw;
    let nx = qx + h * (wx * qw + wy * qz - wz * qy);
    let ny = qy + h * (wy * qw + wz * qx - wx * qz);
    let nz = qz + h * (wz * qw + wx * qy - wy * qx);
    let nw = qw + h * (-wx * qx - wy * qy - wz * qz);
    const n = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    b.qx = nx * n; b.qy = ny * n; b.qz = nz * n; b.qw = nw * n;
  }

  /* ---------- 球-球碰撞 ---------- */
  collideBalls(a, c, dt) {
    const R = TABLE.R, D = 2 * R;
    let dx = c.x - a.x, dy = c.y - a.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= D * D || d2 === 0) return;
    const rvx = c.vx - a.vx, rvy = c.vy - a.vy;
    const dv = dx * rvx + dy * rvy;
    if (dv >= 0) {
      // 已在分离：只做位置修正
      const dist = Math.sqrt(d2), ov = (D - dist) / 2;
      a.x -= dx / dist * ov; a.y -= dy / dist * ov;
      c.x += dx / dist * ov; c.y += dy / dist * ov;
      return;
    }
    // 回退到恰好接触的时刻（否则高速薄球的碰撞法线会偏）
    const w2 = rvx * rvx + rvy * rvy;
    let tau = (dv + Math.sqrt(dv * dv - w2 * (d2 - D * D))) / w2;
    if (!(tau >= 0) || tau > dt * 1.5) tau = 0;
    a.x -= a.vx * tau; a.y -= a.vy * tau;
    c.x -= c.vx * tau; c.y -= c.vy * tau;
    dx = c.x - a.x; dy = c.y - a.y;
    const dist = Math.hypot(dx, dy);
    const nx = dx / dist, ny = dy / dist;
    if (tau === 0) {
      const ov = (D - dist) / 2;
      a.x -= nx * ov; a.y -= ny * ov; c.x += nx * ov; c.y += ny * ov;
    }
    const vn = rvx * nx + rvy * ny;
    const Jn = -(1 + Phys.E_BALL) * vn / 2;        // 法向冲量

    // 接触点处两球表面的相对滑动速度（a 相对 c），含旋转贡献 R(ωa+ωc)×n
    const swx = a.wx + c.wx, swy = a.wy + c.wy, swz = a.wz + c.wz;
    let ux = (a.vx - c.vx) - R * swz * ny;
    let uy = (a.vy - c.vy) + R * swz * nx;
    const uz = R * (swx * ny - swy * nx);
    const un = ux * nx + uy * ny;
    ux -= un * nx; uy -= un * ny;
    const u = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (u > 1e-6) {
      // 球-球摩擦系数随滑动速度下降（实测拟合），冲量不超过“恰好止滑”所需
      const mu = 0.01 + 0.108 * Math.exp(-1.088 * u / 1000);
      const Jt = Math.min(mu * Jn, u / 7);
      const tx = ux / u, ty = uy / u, tz = uz / u;
      a.vx -= Jt * tx; a.vy -= Jt * ty;      // 竖直分量被台面吸收
      c.vx += Jt * tx; c.vy += Jt * ty;
      // 两球角速度变化相同：Δω = -(5·Jt / 2R)·(n × t)
      const k = 2.5 * Jt / R;
      const cx = ny * tz, cy = -nx * tz, cz = nx * ty - ny * tx;
      a.wx -= k * cx; a.wy -= k * cy; a.wz -= k * cz;
      c.wx -= k * cx; c.wy -= k * cy; c.wz -= k * cz;
    }
    a.vx -= Jn * nx; a.vy -= Jn * ny;
    c.vx += Jn * nx; c.vy += Jn * ny;
    // 补走回退的时间
    a.x += a.vx * tau; a.y += a.vy * tau;
    c.x += c.vx * tau; c.y += c.vy * tau;

    if (this.events.firstHit === null) {
      if (a.id === 0) this.events.firstHit = c.id;
      else if (c.id === 0) this.events.firstHit = a.id;
    }
    if (this.onSound && vn < -15) this.onSound('ball', Math.min(1, Math.abs(vn) / 4200));
  }

  /* ---------- 库边碰撞（Han 2005） ---------- */
  collideRails(b) {
    const R = TABLE.R;
    if (b.x > R && b.x < TABLE.W - R && b.y > R && b.y < TABLE.H - R) return;
    for (const s of TABLE.rails) {
      const ex = s.bx - s.ax, ey = s.by - s.ay;
      let t = ((b.x - s.ax) * ex + (b.y - s.ay) * ey) / (ex * ex + ey * ey);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let nx = b.x - (s.ax + ex * t), ny = b.y - (s.ay + ey * t);
      const d = Math.hypot(nx, ny);
      if (d === 0 || d >= R) continue;
      nx /= d; ny /= d;
      b.x += nx * (R - d + 0.005); b.y += ny * (R - d + 0.005);   // 推出嵌入
      const vIn = -(b.vx * nx + b.vy * ny);        // 朝库边的速度
      if (vIn <= 0) continue;
      this.cushionResponse(b, -nx, -ny, vIn);
      if (vIn > 25) {
        this.events.anyRail = true;
        if (this.events.firstHit !== null) this.events.railAfterContact = true;
        if (this.onSound) this.onSound('cushion', Math.min(1, vIn / 3800));
      }
    }
  }

  // (ex,ey)：指向库边的单位向量。在库边局部系（x 朝库，y 沿库，z 向上）里求冲量
  cushionResponse(b, ex, ey, vIn) {
    const R = TABLE.R;
    const tyx = -ey, tyy = ex;                    // 局部 y 轴 = ẑ × x̂
    const vx = vIn;
    const vy = b.vx * tyx + b.vy * tyy;
    const wx = b.wx * ex + b.wy * ey;
    const wy = b.wx * tyx + b.wy * tyy;
    const wz = b.wz;
    const sinT = TABLE.NOSE_H / R - 1;            // 接触点高于球心的仰角
    const cosT = Math.sqrt(1 - sinT * sinT);
    // 高速时橡胶损耗更大
    const e = Math.max(0.7, Phys.E_CUSHION - 0.016 * vIn / 1000);
    const mu = Phys.MU_CUSHION;
    const sx = vx * sinT + R * wy;                // 接触点滑动速度（沿库面竖直方向）
    const sy = -vy - R * wz * cosT + R * wx * sinT;   // （沿库边方向）
    const c = vx * cosT;                          // 压入库边的法向速度
    const PzE = (1 + e) * c;                      // 压缩+恢复总法向冲量
    const PzS = Math.hypot(sx, sy) / 3.5;         // 完全止滑所需冲量
    let PX, PY, PZ;
    if (PzS <= PzE) {
      // 粘着：接触点滑动在碰撞中停止
      PX = -sx / 3.5 * sinT - PzE * cosT;
      PY = sy / 3.5;
      PZ = sx / 3.5 * cosT - PzE * sinT;
    } else {
      // 全程滑动
      const phi = Math.atan2(sy, sx);
      PX = -mu * PzE * Math.cos(phi) * sinT - PzE * cosT;
      PY = mu * PzE * Math.sin(phi);
      PZ = mu * PzE * Math.cos(phi) * cosT - PzE * sinT;
    }
    const k = 2.5 / R;                            // R / I，I = 2/5·R²
    const nvx = vx + PX, nvy = vy + PY;
    const nwx = wx - k * PY * sinT;
    const nwy = wy + k * (PX * sinT - PZ * cosT);
    b.wz = wz + k * PY * cosT;
    b.vx = nvx * ex + nvy * tyx;
    b.vy = nvx * ey + nvy * tyy;
    b.wx = nwx * ex + nwy * tyx;
    b.wy = nwx * ey + nwy * tyy;
  }

  /* ---------- 落袋 ---------- */
  checkPockets(b) {
    for (let i = 0; i < TABLE.pockets.length; i++) {
      const p = TABLE.pockets[i];
      const dx = b.x - p.x, dy = b.y - p.y;
      if (dx * dx + dy * dy < p.r * p.r) {
        b.potted = true;
        b.falling = true;
        b.sink = 0;
        b.sinkPocket = i;
        b.vz = 0;
        if (b.id === 0) this.events.cuePotted = true;
        else this.events.potted.push(b.id);
        if (this.onSound) this.onSound('pocket', 0.5 + Math.min(0.5, b.speed / 5000));
        return;
      }
    }
  }

  // 球心越过石板边缘后：重力下坠，被袋口内壁挡住并掉进袋底
  stepFall(b, dt) {
    const R = TABLE.R, p = TABLE.pockets[b.sinkPocket];
    b.vz -= Phys.G * dt;
    // 球还搭在洞沿上时，重力把它向洞心扳
    let dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy);
    if (b.z > -R && d > 1) {
      const pull = Phys.G * 0.6 * Math.min(1, d / p.r) * dt;
      b.vx -= pull * dx / d; b.vy -= pull * dy / d;
    }
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    if (b.z > -14) this.collideRails(b);          // 还没沉下去时袋角仍然挡球

    // 袋后壁（木边开孔圆）
    const lim = p.cutR - R;
    let rx = b.x - p.cutX, ry = b.y - p.cutY;
    const along = rx * p.ox + ry * p.oy;
    if (along > -p.cutR * 0.3) {
      const lat = -rx * p.oy + ry * p.ox;
      const tx = -p.oy, ty = p.ox;
      if (Math.abs(lat) > lim) {                  // 侧壁
        const sgn = Math.sign(lat), over = Math.abs(lat) - lim;
        b.x -= tx * sgn * over; b.y -= ty * sgn * over;
        const vl = b.vx * tx + b.vy * ty;
        if (vl * sgn > 0) { b.vx -= 1.3 * vl * tx; b.vy -= 1.3 * vl * ty; }
      }
      rx = b.x - p.cutX; ry = b.y - p.cutY;
      const rd = Math.hypot(rx, ry);
      if (along > 0 && rd > lim) {                // 后壁
        const nx = rx / rd, ny = ry / rd;
        b.x -= nx * (rd - lim); b.y -= ny * (rd - lim);
        const vn = b.vx * nx + b.vy * ny;
        if (vn > 0) {
          b.vx -= 1.25 * vn * nx; b.vy -= 1.25 * vn * ny;
          b.vx *= 0.8; b.vy *= 0.8;
          if (this.onSound && vn > 300) this.onSound('cushion', Math.min(1, vn / 3000));
        }
      }
    }
    // 沉入石板开孔后被孔壁约束
    if (b.z < 0) {
      const allow = p.r - R * Math.min(1, -b.z / R);
      dx = b.x - p.x; dy = b.y - p.y; d = Math.hypot(dx, dy);
      if (d > allow && d > 0) {
        const nx = dx / d, ny = dy / d;
        b.x -= nx * (d - allow); b.y -= ny * (d - allow);
        const vn = b.vx * nx + b.vy * ny;
        if (vn > 0) { b.vx -= 1.3 * vn * nx; b.vy -= 1.3 * vn * ny; }
      }
    }
    this.integrateSpin(b, dt);
    if (b.z < -R * 3.4) {
      b.falling = false; b.sink = 1;
      b.vx = b.vy = b.vz = b.wx = b.wy = b.wz = 0;
    } else {
      b.sink = Math.min(0.99, -b.z / (R * 3.4));
    }
  }

  failsafeBounds(b) {
    // 兜底：万一穿出台面
    const R = TABLE.R, m = 110;
    if (b.x < -m || b.x > TABLE.W + m || b.y < -m || b.y > TABLE.H + m) {
      if (b.id === 0) {
        this.events.cueOffTable = true;
        this.events.cuePotted = true;
        b.potted = true; b.sink = 1; b.falling = false;
        b.vx = b.vy = b.wx = b.wy = b.wz = 0;
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
    cue.potted = false; cue.falling = false; cue.sink = 0; cue.sinkPocket = null;
    cue.x = x; cue.y = y; cue.z = 0;
    cue.vx = cue.vy = cue.vz = cue.wx = cue.wy = cue.wz = 0;
  }

  canPlace(x, y, ignoreId = 0) {
    const R = TABLE.R;
    if (x < R + 2 || x > TABLE.W - R - 2 || y < R + 2 || y > TABLE.H - R - 2) return false;
    for (const p of TABLE.pockets) {
      if (Math.hypot(p.x - x, p.y - y) < p.r + 4) return false;
    }
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
    // 直接进袋：画到台面边界外一点
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (TABLE.W + 30 - cue.x) / dx);
    if (dx < 0) t = Math.min(t, (-30 - cue.x) / dx);
    if (dy > 0) t = Math.min(t, (TABLE.H + 30 - cue.y) / dy);
    if (dy < 0) t = Math.min(t, (-30 - cue.y) / dy);
    if (!(t < 6000)) t = 0;
    return { type: 'none', x: cue.x + dx * t, y: cue.y + dy * t, dist: t };
  }
}

// 射线（起点 o，方向 d）与线段 s 的距离-R 偏置求交，返回射线参数 t 或 null
function raySegment(ox, oy, dx, dy, s, R) {
  const ex = s.bx - s.ax, ey = s.by - s.ay;
  const elen = Math.hypot(ex, ey);
  let nx = -ey / elen, ny = ex / elen;
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
