/* ============================================================
 * table.js — 球台几何定义（单位：毫米，真实中式八球台尺寸）
 *   台面内沿 2540 x 1270，球直径 57.15
 * 坐标系：台面内沿一角为 (0,0)，x 沿长边，y 沿短边，z 向上（右手系）
 * 物理与 3D 渲染共用这一份几何：库边鼻线折线、袋口落球圆。
 * ============================================================ */

const TABLE = (() => {
  const W = 2540;            // 台面内沿长（库边鼻线之间）
  const H = 1270;            // 台面内沿宽
  const R = 28.575;          // 球半径（57.15mm 直径）

  const CUSHION_D = 50;      // 库边深度：鼻线 → 木边
  const NOSE_H = 36.3;       // 库边鼻线高度（0.635 × 球直径）
  const RAIL_W = 115;        // 木边宽度
  const RAIL_TOP = 40;       // 木边顶面高度

  // 袋角（圆弧袋角，中式八球特征）：鼻线直线段在离角 C 处开始以半径 RJ 向外弯
  const CORNER_C = 90, CORNER_RJ = 70, CORNER_A = Math.PI / 4;       // 喉宽 ≈ 86mm
  const SIDE_C = 93, SIDE_RJ = 45, SIDE_A = 75 * Math.PI / 180;      // 喉宽 ≈ 90mm

  // 袋角局部折线：[s 沿库边到袋的距离, d 向外深度]，从鼻线起点到库背
  function jaw(c, rj, alpha, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = alpha * i / n;
      pts.push([c - rj * Math.sin(f), rj * (1 - Math.cos(f))]);
    }
    const [s0, d0] = pts[pts.length - 1];
    const t = (CUSHION_D - d0) / Math.sin(alpha);
    pts.push([s0 - t * Math.cos(alpha), CUSHION_D]);
    return pts;
  }
  const CJ = jaw(CORNER_C, CORNER_RJ, CORNER_A, 6);
  const SJ = jaw(SIDE_C, SIDE_RJ, SIDE_A, 8);

  // 一条库边 = 袋角A(反向) + 直线 + 袋角B；每点带鼻线坐标与对应库背坐标
  function buildCushion(ja, fa, jb, fb) {
    const pts = [];
    for (let i = ja.length - 1; i >= 0; i--) {
      const [x, y] = fa(ja[i][0], ja[i][1]);
      const [bx, by] = fa(ja[i][0], CUSHION_D);
      pts.push({ x, y, bx, by });
    }
    for (let i = 0; i < jb.length; i++) {
      const [x, y] = fb(jb[i][0], jb[i][1]);
      const [bx, by] = fb(jb[i][0], CUSHION_D);
      pts.push({ x, y, bx, by });
    }
    return pts;
  }

  const cushions = [
    buildCushion(CJ, (s, d) => [s, -d],        SJ, (s, d) => [W / 2 - s, -d]),      // 上-左
    buildCushion(CJ, (s, d) => [W - s, -d],    SJ, (s, d) => [W / 2 + s, -d]),      // 上-右
    buildCushion(CJ, (s, d) => [s, H + d],     SJ, (s, d) => [W / 2 - s, H + d]),   // 下-左
    buildCushion(CJ, (s, d) => [W - s, H + d], SJ, (s, d) => [W / 2 + s, H + d]),   // 下-右
    buildCushion(CJ, (s, d) => [-d, s],        CJ, (s, d) => [-d, H - s]),          // 左
    buildCushion(CJ, (s, d) => [W + d, s],     CJ, (s, d) => [W + d, H - s]),       // 右
  ];

  // 物理用线段
  const rails = [];
  for (const c of cushions) {
    for (let i = 0; i < c.length - 1; i++) {
      rails.push({ ax: c[i].x, ay: c[i].y, bx: c[i + 1].x, by: c[i + 1].y });
    }
  }

  // 袋口：落球圆（石板开孔，球心越过即下落）+ 木边开孔圆（渲染/袋内约束）+ AI 瞄准点
  const CK = 22, CR = 62;        // 角袋落球圆：圆心外移量、半径
  const SK = 38, SR = 55;        // 中袋落球圆
  const CCUT = 30, SCUT = 62;    // 木边开孔圆心外移量
  const cEnd = CJ[CJ.length - 1][0], sEnd = SJ[SJ.length - 1][0];
  const CCUT_R = Math.hypot(cEnd + CCUT, CUSHION_D - CCUT);
  const SCUT_R = Math.hypot(sEnd, SCUT - CUSHION_D);
  const Q = Math.SQRT1_2;

  function corner(sx, sy) {   // sx, sy ∈ {0,1}：哪个角
    const ox = sx ? 1 : -1, oy = sy ? 1 : -1;
    const px = sx ? W : 0, py = sy ? H : 0;
    return {
      x: px + ox * CK, y: py + oy * CK, r: CR, corner: true,
      ax: px - ox * R * 0.9, ay: py - oy * R * 0.9,
      ox: ox * Q, oy: oy * Q,
      cutX: px + ox * CCUT, cutY: py + oy * CCUT, cutR: CCUT_R,
    };
  }
  function side(sy) {
    const oy = sy ? 1 : -1, py = sy ? H : 0;
    return {
      x: W / 2, y: py + oy * SK, r: SR, corner: false,
      ax: W / 2, ay: py + oy * 4,
      ox: 0, oy,
      cutX: W / 2, cutY: py + oy * SCUT, cutR: SCUT_R,
    };
  }
  // 0-2 为 y=0 一侧从左到右，3-5 为 y=H 一侧从左到右
  const pockets = [corner(0, 0), side(0), corner(1, 0), corner(0, 1), side(1), corner(1, 1)];

  // 置球点
  const HEAD_X = W * 0.25;   // 开球线（白球须在其后开球）
  const FOOT_X = W * 0.75;   // 摆球点（三角架顶点）

  // 生成八球球架排布：返回 [{id,x,y}]，id 1-7 全色，8 黑球，9-15 花色
  function rackPositions() {
    const gap = R * 2 + 0.12;
    const rows = [];
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        rows.push({
          x: FOOT_X + row * gap * Math.sqrt(3) / 2 + (Math.random() - 0.5) * 0.08,
          y: H / 2 + (i - row / 2) * gap + (Math.random() - 0.5) * 0.08,
        });
      }
    }
    // 规则：第三排中间必须是 8，最后排两角一全色一花色
    const solids = [1, 2, 3, 4, 5, 6, 7];
    const stripes = [9, 10, 11, 12, 13, 14, 15];
    shuffle(solids); shuffle(stripes);
    const ids = new Array(15).fill(0);
    ids[4] = 8;
    ids[10] = solids.pop();
    ids[14] = stripes.pop();
    const rest = shuffle(solids.concat(stripes));
    for (let i = 0; i < 15; i++) if (!ids[i]) ids[i] = rest.pop();
    return rows.map((p, i) => ({ id: ids[i], x: p.x, y: p.y }));
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  return { W, H, R, CUSHION_D, NOSE_H, RAIL_W, RAIL_TOP,
           cushions, rails, pockets, HEAD_X, FOOT_X, rackPositions };
})();

// 球色定义
const BALL_COLORS = {
  0:  '#f5f2e8',  // 白球
  1:  '#f2c30f', 2: '#1a4fb8', 3: '#d92b2b', 4: '#6a2a9c',
  5:  '#ee7a1c', 6: '#1d7a3c', 7: '#7d1f24',
  8:  '#141414',
  9:  '#f2c30f', 10: '#1a4fb8', 11: '#d92b2b', 12: '#6a2a9c',
  13: '#ee7a1c', 14: '#1d7a3c', 15: '#7d1f24',
};
function isStripe(id) { return id >= 9; }
function isSolid(id) { return id >= 1 && id <= 7; }
