/* ============================================================
 * table.js — 球台几何定义（单位：毫米，中式八球台内沿 2540x1270 缩比）
 * 坐标系：台面内沿左上角为 (0,0)，x 向右，y 向下
 * ============================================================ */

const TABLE = (() => {
  const W = 2240;          // 台面内沿长
  const H = 1120;          // 台面内沿宽
  const R = 26.25;         // 球半径（52.5mm 直径）
  const MARGIN = 96;       // 画布上木框宽度

  // 袋口参数
  const CORNER_MOUTH = 72;   // 角袋沿边留空（从角点起）
  const SIDE_MOUTH = 58;     // 中袋沿边半留空
  const POCKET_R = 45;       // 袋口捕获半径
  const CORNER_OFF = 16;     // 角袋中心向外偏移
  const SIDE_OFF = 24;       // 中袋中心向外偏移

  // 6 个袋口中心（0-2 上边从左到右，3-5 下边从左到右）
  const pockets = [
    { x: -CORNER_OFF,      y: -CORNER_OFF,     r: POCKET_R,     corner: true },
    { x: W / 2,            y: -SIDE_OFF,       r: POCKET_R - 3, corner: false },
    { x: W + CORNER_OFF,   y: -CORNER_OFF,     r: POCKET_R,     corner: true },
    { x: -CORNER_OFF,      y: H + CORNER_OFF,  r: POCKET_R,     corner: true },
    { x: W / 2,            y: H + SIDE_OFF,    r: POCKET_R - 3, corner: false },
    { x: W + CORNER_OFF,   y: H + CORNER_OFF,  r: POCKET_R,     corner: true },
  ];

  // 库边线段：{ax,ay,bx,by}，球撞到线段即反弹。
  // 每条库边在袋口处断开，并加一小段向外张开的“袋口斜面”模拟袋角。
  const JAW = 34; // 袋口斜面深度
  const rails = [];
  function seg(ax, ay, bx, by) { rails.push({ ax, ay, bx, by }); }

  // 上边两段
  seg(CORNER_MOUTH, 0, W / 2 - SIDE_MOUTH, 0);
  seg(W / 2 + SIDE_MOUTH, 0, W - CORNER_MOUTH, 0);
  // 下边两段
  seg(CORNER_MOUTH, H, W / 2 - SIDE_MOUTH, H);
  seg(W / 2 + SIDE_MOUTH, H, W - CORNER_MOUTH, H);
  // 左右边
  seg(0, CORNER_MOUTH, 0, H - CORNER_MOUTH);
  seg(W, CORNER_MOUTH, W, H - CORNER_MOUTH);

  // 角袋斜面（向外张开 45°）
  seg(CORNER_MOUTH, 0, CORNER_MOUTH - JAW, -JAW);                 // 左上-上
  seg(0, CORNER_MOUTH, -JAW, CORNER_MOUTH - JAW);                 // 左上-左
  seg(W - CORNER_MOUTH, 0, W - CORNER_MOUTH + JAW, -JAW);         // 右上-上
  seg(W, CORNER_MOUTH, W + JAW, CORNER_MOUTH - JAW);              // 右上-右
  seg(CORNER_MOUTH, H, CORNER_MOUTH - JAW, H + JAW);              // 左下
  seg(0, H - CORNER_MOUTH, -JAW, H - CORNER_MOUTH + JAW);
  seg(W - CORNER_MOUTH, H, W - CORNER_MOUTH + JAW, H + JAW);      // 右下
  seg(W, H - CORNER_MOUTH, W + JAW, H - CORNER_MOUTH + JAW);
  // 中袋斜面（较陡）
  seg(W / 2 - SIDE_MOUTH, 0, W / 2 - SIDE_MOUTH + 14, -JAW);
  seg(W / 2 + SIDE_MOUTH, 0, W / 2 + SIDE_MOUTH - 14, -JAW);
  seg(W / 2 - SIDE_MOUTH, H, W / 2 - SIDE_MOUTH + 14, H + JAW);
  seg(W / 2 + SIDE_MOUTH, H, W / 2 + SIDE_MOUTH - 14, H + JAW);

  // 置球点
  const HEAD_X = W * 0.25;   // 开球线（白球须在其左侧开球）
  const FOOT_X = W * 0.75;   // 摆球点（三角架顶点）

  // 生成八球球架排布：返回 [{id,x,y}]，id 1-7 全色，8 黑球，9-15 花色
  function rackPositions() {
    const gap = R * 2 + 0.4;
    const rows = [];
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        rows.push({
          x: FOOT_X + row * gap * Math.sqrt(3) / 2,
          y: H / 2 + (i - row / 2) * gap,
          row, idx: i,
        });
      }
    }
    // 规则：顶点任意，第三排中间必须是 8，最后排两角一全色一花色
    const solids = [1, 2, 3, 4, 5, 6, 7];
    const stripes = [9, 10, 11, 12, 13, 14, 15];
    shuffle(solids); shuffle(stripes);
    const ids = new Array(15).fill(0);
    ids[4] = 8;                     // 第三排中间（index 4 = row2 中间）
    ids[10] = solids.pop();         // 最后排左角
    ids[14] = stripes.pop();        // 最后排右角
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

  return { W, H, R, MARGIN, pockets, rails, HEAD_X, FOOT_X, rackPositions,
           CORNER_MOUTH, SIDE_MOUTH };
})();

// 球色定义
const BALL_COLORS = {
  0:  '#f5f2e8',  // 白球
  1:  '#f2c30f', 2: '#1a4fb8', 3: '#d92b2b', 4: '#7a2ba8',
  5:  '#e8742a', 6: '#1d7a3c', 7: '#8a2020',
  8:  '#181818',
  9:  '#f2c30f', 10: '#1a4fb8', 11: '#d92b2b', 12: '#7a2ba8',
  13: '#e8742a', 14: '#1d7a3c', 15: '#8a2020',
};
function isStripe(id) { return id >= 9; }
function isSolid(id) { return id >= 1 && id <= 7; }
