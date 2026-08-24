/* ============================================================
 * rules.js — 中式八球规则状态机
 * 模式：'ai'（人机）/ 'pvp'（双人）/ 'free'（练习）
 * ============================================================ */

class EightBallGame {
  constructor(world, mode) {
    this.world = world;
    this.mode = mode;               // 'ai' | 'pvp' | 'free'
    this.current = 0;               // 当前玩家 0/1
    this.groups = [null, null];     // 'solid' | 'stripe' | null（未定）
    this.breakShot = true;          // 是否开球
    this.ballInHand = mode !== 'free'; // 开球前白球可摆（限开球线后）
    this.behindLine = true;         // 自由球是否限制在开球线后
    this.over = false;
    this.winner = null;
    this.winReason = '';
    this.lastMsg = '';
    world.setupRack();
  }

  playerName(i) {
    if (this.mode === 'ai') return i === 0 ? '你' : 'AI 对手';
    return i === 0 ? '玩家 1' : '玩家 2';
  }

  groupName(g) {
    return g === 'solid' ? '全色 (1-7)' : g === 'stripe' ? '花色 (9-15)' : '未定';
  }

  // 当前玩家的合法目标球 id 列表
  legalTargets(player = this.current) {
    const alive = this.world.activeBalls().filter(b => b.id !== 0).map(b => b.id);
    const g = this.groups[player];
    if (this.mode === 'free') return alive;
    if (g === null) return alive.filter(id => id !== 8); // 开放球局不能先打 8
    const mine = alive.filter(id => g === 'solid' ? isSolid(id) : isStripe(id));
    return mine.length ? mine : alive.filter(id => id === 8);
  }

  // 玩家是否只剩黑8
  onlyEightLeft(player) {
    const g = this.groups[player];
    if (g === null) return false;
    return !this.world.activeBalls().some(b =>
      g === 'solid' ? isSolid(b.id) : isStripe(b.id));
  }

  remainingOf(group) {
    return this.world.activeBalls()
      .filter(b => group === 'solid' ? isSolid(b.id) : isStripe(b.id))
      .map(b => b.id);
  }

  /* ---------- 一杆结束后的裁决 ----------
   * 返回 { msg, foul, switchTurn, gameOver } */
  judge(ev) {
    if (this.mode === 'free') {
      // 练习模式：白球落袋放回，其他无规则
      if (ev.cuePotted) {
        this.placeCueSafe();
        return { msg: '白球落袋，已放回', foul: false, switchTurn: false };
      }
      if (this.world.activeBalls().filter(b => b.id !== 0).length === 0) {
        this.world.setupRack();
        return { msg: '清台！自动重新摆球', foul: false, switchTurn: false };
      }
      return { msg: ev.potted.length ? `进球：${ev.potted.join('、')} 号` : '', foul: false, switchTurn: false };
    }

    const me = this.current;
    const opp = 1 - me;
    const wasBreak = this.breakShot;
    this.breakShot = false;
    const potted8 = ev.potted.includes(8);
    let foul = false;
    let foulWhy = '';

    // ---- 犯规判定 ----
    // 首球合法性须按击球前的台面状态判断（本杆打进的球当时仍在台上）
    if (ev.firstHit === null) {
      foul = true; foulWhy = '未击中任何球';
    } else if (!wasBreak) {
      const g = this.groups[me];
      if (g === null) {
        if (ev.firstHit === 8) { foul = true; foulWhy = '开放球局不能先击打黑8'; }
      } else {
        const isMine = id => g === 'solid' ? isSolid(id) : isStripe(id);
        const ownBefore = this.remainingOf(g).length + ev.potted.filter(isMine).length;
        const hitLegal = ownBefore > 0 ? isMine(ev.firstHit) : ev.firstHit === 8;
        if (!hitLegal) { foul = true; foulWhy = '首先击中了非本方目标球'; }
      }
    }
    if (ev.cuePotted) {
      foul = true;
      foulWhy = ev.cueOffTable ? '白球跳出台面' : '白球落袋';
    }
    // 无进球且碰库不足（宽松版：击中后须有球碰库或有球进袋）
    if (!foul && !wasBreak && ev.potted.length === 0 && !ev.railAfterContact) {
      foul = true; foulWhy = '击球后无球碰库';
    }

    // ---- 黑8 结算 ----
    if (potted8) {
      if (wasBreak) {
        // 开球进黑8：重新摆球重新开球（友好规则）
        this.world.setupRack();
        this.breakShot = true;
        this.ballInHand = true; this.behindLine = true;
        return { msg: '开球打进黑8，重新开球', foul: false, switchTurn: false };
      }
      const cleared = this.onlyEightLeftBefore(me, ev);
      if (!cleared || foul) {
        this.over = true; this.winner = opp;
        this.winReason = foul ? `${this.playerName(me)}打进黑8时犯规（${foulWhy}）`
                              : `${this.playerName(me)}提前打进黑8`;
        return { msg: this.winReason, foul: true, gameOver: true };
      }
      this.over = true; this.winner = me;
      this.winReason = `${this.playerName(me)}打进黑8，获得胜利！`;
      return { msg: this.winReason, foul: false, gameOver: true };
    }

    // ---- 定花色（开放球局中合法打进球）----
    let assignMsg = '';
    if (!foul && this.groups[me] === null && !wasBreak) {
      const first = ev.potted.find(id => id !== 8);
      if (first !== undefined) {
        const g = isSolid(first) ? 'solid' : 'stripe';
        this.groups[me] = g;
        this.groups[opp] = g === 'solid' ? 'stripe' : 'solid';
        assignMsg = `${this.playerName(me)}确定为${this.groupName(g)}；`;
      }
    }

    // ---- 是否连杆 ----
    let keepTurn = false;
    if (!foul && ev.potted.length > 0) {
      if (this.groups[me] === null) {
        keepTurn = true; // 开球进球（花色未定）继续
      } else {
        const g = this.groups[me];
        keepTurn = ev.potted.some(id => g === 'solid' ? isSolid(id) : isStripe(id));
      }
    }

    if (foul) {
      this.current = opp;
      this.ballInHand = true;
      this.behindLine = false;
      if (ev.cuePotted) this.placeCueSafe(true); // 先放好，等对方拖动
      return { msg: `犯规：${foulWhy} — ${this.playerName(opp)}获得自由球`, foul: true, switchTurn: true };
    }

    this.ballInHand = false;
    if (keepTurn) {
      const n = ev.potted.length;
      return { msg: assignMsg + `打进 ${n} 球，继续击球`, foul: false, switchTurn: false };
    }
    this.current = opp;
    return { msg: assignMsg + `轮到${this.playerName(opp)}`, foul: false, switchTurn: true };
  }

  // 击球前是否已清完本方球（本杆打进的本方球在出杆时仍在台上，须计入）
  onlyEightLeftBefore(player, ev) {
    const g = this.groups[player];
    if (g === null) return false;
    const isMine = id => g === 'solid' ? isSolid(id) : isStripe(id);
    const ownBefore = this.remainingOf(g).length + ev.potted.filter(isMine).length;
    return ownBefore === 0;
  }

  placeCueSafe(pending = false) {
    // 找一个不重叠的位置放白球（自由球时先放台中，等待玩家拖动）
    const cands = [
      [TABLE.HEAD_X, TABLE.H / 2],
      [TABLE.W / 2, TABLE.H / 2],
      [TABLE.W * 0.25, TABLE.H * 0.3],
      [TABLE.W * 0.25, TABLE.H * 0.7],
    ];
    for (const [x, y] of cands) {
      if (this.world.canPlace(x, y)) { this.world.respotCue(x, y); return; }
    }
    // 网格兜底
    for (let x = TABLE.R * 2; x < TABLE.W; x += TABLE.R * 2) {
      for (let y = TABLE.R * 2; y < TABLE.H; y += TABLE.R * 2) {
        if (this.world.canPlace(x, y)) { this.world.respotCue(x, y); return; }
      }
    }
  }
}
