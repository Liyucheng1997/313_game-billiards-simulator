/* ============================================================
 * ai.js — AI 对手
 * 决策流程：
 *   1. 枚举（合法目标球 × 袋口）的所有候选进攻线路
 *   2. 检查白球→假想球、目标球→袋口两段路径是否被阻挡
 *   3. 按切角、距离、袋口类型评分，选最优
 *   4. 按难度加入瞄准角度噪声与力度噪声
 *   5. 无进攻线路时执行安全球（轻推本方球）
 * ============================================================ */

const AI_LEVELS = [
  { name: '新手', angleErr: 0.030, powerErr: 0.20, maxCut: 62, thinkMs: [900, 1600] },
  { name: '进阶', angleErr: 0.011, powerErr: 0.10, maxCut: 74, thinkMs: [800, 1400] },
  { name: '大师', angleErr: 0.0035, powerErr: 0.05, maxCut: 82, thinkMs: [700, 1200] },
];

class BilliardAI {
  constructor(world, game, level) {
    this.world = world;
    this.game = game;
    this.cfg = AI_LEVELS[level];
  }

  /* 路径 a→b 是否被其他球阻挡（走廊宽 2R），忽略 ignore 中的球 */
  pathBlocked(ax, ay, bx, by, ignore) {
    const R = TABLE.R;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1) return false;
    const ux = dx / len, uy = dy / len;
    for (const b of this.world.activeBalls()) {
      if (ignore.includes(b.id)) continue;
      const ox = b.x - ax, oy = b.y - ay;
      const proj = ox * ux + oy * uy;
      if (proj < -R || proj > len + R) continue;
      const perp = Math.abs(ox * uy - oy * ux);
      if (perp < 2 * R - 2) return true;
    }
    return false;
  }

  /* 枚举所有可行进攻，返回按分数排序的候选列表 */
  findShots(cueX, cueY) {
    const R = TABLE.R;
    const targets = this.game.legalTargets(this.game.current);
    const shots = [];
    for (const tid of targets) {
      const ball = this.world.balls.find(b => b.id === tid && !b.potted);
      if (!ball) continue;
      for (let pi = 0; pi < TABLE.pockets.length; pi++) {
        const p = TABLE.pockets[pi];
        // 瞄向袋口稍内侧
        const pdx = p.x - ball.x, pdy = p.y - ball.y;
        const pdist = Math.hypot(pdx, pdy);
        if (pdist < R * 2) continue;
        const pux = pdx / pdist, puy = pdy / pdist;
        // 假想球位置
        const gx = ball.x - pux * 2 * R;
        const gy = ball.y - puy * 2 * R;
        const cdx = gx - cueX, cdy = gy - cueY;
        const cdist = Math.hypot(cdx, cdy);
        if (cdist < R) continue;
        const cux = cdx / cdist, cuy = cdy / cdist;
        // 切角
        const cosCut = cux * pux + cuy * puy;
        const cutDeg = Math.acos(Math.max(-1, Math.min(1, cosCut))) * 180 / Math.PI;
        if (cutDeg > this.cfg.maxCut) continue;
        // 路径检查
        if (this.pathBlocked(cueX, cueY, gx, gy, [0, tid])) continue;
        if (this.pathBlocked(ball.x, ball.y, p.x, p.y, [0, tid])) continue;
        // 中袋对入射角更挑剔
        if (!p.corner) {
          const inAng = Math.abs(pux) ; // 中袋在上下边，理想入射沿 y
          if (Math.abs(puy) < 0.45) continue;
        }
        // 评分：距离越短、切角越小越好
        let score =
          1000
          - cutDeg * 9
          - cdist * 0.10
          - pdist * 0.14
          + (p.corner ? 40 : 0)
          + (this.game.onlyEightLeft(this.game.current) && tid === 8 ? 100 : 0);
        // 风险1：目标球线路附近有黑8，可能连带撞进（直接判负）
        if (tid !== 8) {
          const eight = this.world.balls.find(b => b.id === 8 && !b.potted);
          if (eight) {
            const perp = Math.abs((eight.x - ball.x) * puy - (eight.y - ball.y) * pux);
            const along = (eight.x - ball.x) * pux + (eight.y - ball.y) * puy;
            if (along > 0 && along < pdist && perp < 3.2 * R) score -= 320;
          }
        }
        // 风险2：白球碰撞后的分离/跟进方向正对某个袋口 → 洗袋风险
        const tanx = cux - pux * cosCut, tany = cuy - puy * cosCut;
        const tl = Math.hypot(tanx, tany);
        const scatterDirs = tl > 0.1
          ? [[tanx / tl, tany / tl]]          // 有切角：白球沿切线走
          : [[pux, puy]];                     // 直球：白球易跟进目标球方向
        for (const [sx2, sy2] of scatterDirs) {
          for (const q of TABLE.pockets) {
            const qdx = q.x - gx, qdy = q.y - gy;
            const qd = Math.hypot(qdx, qdy);
            if (qd > 950) continue;
            const cosQ = (qdx * sx2 + qdy * sy2) / qd;
            if (cosQ > 0.985) score -= 160;
          }
        }
        // 力度估算：需要目标球滚行 pdist，白球滚行 cdist 后仍有足够动能
        const need = Math.sqrt(2 * Phys.MU_ROLL * Phys.G * (pdist + 250));
        const vGhost = need / Math.max(0.25, cosCut);        // 切角损耗补偿
        const vCue = Math.sqrt(vGhost * vGhost + 2 * Phys.MU_SLIDE * Phys.G * 0.25 * cdist);
        let power = Math.min(1, (vCue * 1.35) / Phys.MAX_V + 0.06);
        power = Math.max(0.18, power);
        shots.push({
          angle: Math.atan2(cuy, cux),
          power, score, cutDeg, target: tid, pocket: pi,
          cueDist: cdist, ballDist: pdist,
        });
      }
    }
    shots.sort((a, b) => b.score - a.score);
    return shots;
  }

  /* 安全球：把白球轻打向最近的本方球，尽量贴库 */
  safetyShot(cueX, cueY) {
    const targets = this.game.legalTargets(this.game.current);
    let best = null, bestD = Infinity;
    for (const tid of targets) {
      const ball = this.world.balls.find(b => b.id === tid && !b.potted);
      if (!ball) continue;
      const d = Math.hypot(ball.x - cueX, ball.y - cueY);
      const blocked = this.pathBlocked(cueX, cueY, ball.x, ball.y, [0, tid]);
      const dd = d + (blocked ? 5000 : 0);
      if (dd < bestD) { bestD = dd; best = ball; }
    }
    if (!best) return { angle: Math.random() * Math.PI * 2, power: 0.5 };
    const ang = Math.atan2(best.y - cueY, best.x - cueX);
    // 接近满击（保证目标球能碰库，避免“无球碰库”犯规），略带角度
    const thin = (Math.random() < 0.5 ? 1 : -1) * 0.03;
    return { angle: ang + thin, power: 0.42 + Math.random() * 0.12 };
  }

  /* 开球 */
  breakShot(cue) {
    // 瞄准球堆顶球，微小偏移让球堆炸开更自然
    const ang = Math.atan2(TABLE.H / 2 - cue.y, TABLE.FOOT_X - cue.x);
    return { angle: ang + (Math.random() - 0.5) * 0.01, power: 1.0, spinA: 0, spinB: -0.1 };
  }

  /* 自由球摆位：采样若干位置选进攻分最高的 */
  placeCueBall() {
    let best = { x: TABLE.HEAD_X, y: TABLE.H / 2, score: -Infinity };
    const restrictLine = this.game.behindLine;
    for (let i = 0; i < 60; i++) {
      const x = restrictLine
        ? TABLE.R * 2 + Math.random() * (TABLE.HEAD_X - TABLE.R * 4)
        : TABLE.R * 2 + Math.random() * (TABLE.W - TABLE.R * 4);
      const y = TABLE.R * 2 + Math.random() * (TABLE.H - TABLE.R * 4);
      if (!this.world.canPlace(x, y)) continue;
      const shots = this.findShots(x, y);
      const s = shots.length ? shots[0].score : -500;
      if (s > best.score) best = { x, y, score: s };
    }
    return best;
  }

  /* 决策一杆，返回 {angle, power, spinA, spinB, desc} */
  decide() {
    const cue = this.world.cue;
    if (this.game.breakShot) {
      const s = this.breakShot(cue);
      return { ...s, desc: '开球' };
    }
    const shots = this.findShots(cue.x, cue.y);
    let shot, desc;
    if (shots.length) {
      // 高手在前几个近似方案中选最优，新手可能选到次优
      const pickIdx = this.cfg.angleErr > 0.02 && shots.length > 1 && Math.random() < 0.3 ? 1 : 0;
      const s = shots[pickIdx];
      shot = { angle: s.angle, power: s.power, spinA: 0, spinB: 0 };
      // 走位意识：直球（近距）用低杆防止白球跟进洗袋
      if (s.cutDeg < 22) shot.spinB = s.cutDeg < 10 ? -0.4 : -0.25;
      desc = `瞄准 ${s.target} 号球`;
    } else {
      shot = { ...this.safetyShot(cue.x, cue.y), spinA: 0, spinB: 0 };
      desc = '防守';
    }
    // 难度噪声
    shot.angle += gauss() * this.cfg.angleErr;
    shot.power = Math.max(0.12, Math.min(1, shot.power * (1 + gauss() * this.cfg.powerErr)));
    return { ...shot, desc };
  }

  thinkTime() {
    const [a, b] = this.cfg.thinkMs;
    return a + Math.random() * (b - a);
  }
}

function gauss() {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.random();
  return (s - 2) / 1.0;
}
