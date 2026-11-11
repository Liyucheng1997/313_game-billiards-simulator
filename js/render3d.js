/* ============================================================
 * render3d.js — 3D 渲染层（three.js）
 *   球房环境：木地板、墙裙、地毯、吊灯、杆架、挂画、长椅
 *   球台：台呢（石板开孔）、带圆弧袋角的库边、木边、袋口内衬、台脚
 *   球：程序生成贴图 + 清漆材质，按物理引擎的姿态四元数真实滚动
 * 物理坐标 (x, y, z↑, 毫米) → three 坐标 (x-W/2, z, -(y-H/2)) × 0.001（米）
 * ============================================================ */

class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;

    this.S = 0.001;
    this.hw = TABLE.W / 2 * this.S;
    this.hh = TABLE.H / 2 * this.S;
    this.FLOOR_Y = -0.80;       // 台面离地 80cm
    this.LAMP_Y = 1.25;         // 吊灯底面高度（相对台面）

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070605);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.03, 60);
    this.camPos = new THREE.Vector3(2.6, 1.1, 2.6);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camUp = new THREE.Vector3(0, 1, 0);
    this.view = { pitch: 0.34, dist: 1.25 };   // 瞄准视角的俯仰与距离（用户可调）
    this.time = 0;
    this.firstFrame = true;

    this.raycaster = new THREE.Raycaster();
    this.pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE.R * this.S);

    this.buildEnvironmentMap();
    this.buildLights();
    this.buildRoom();
    this.buildTable();
    this.buildLamp();
    this.buildBalls();
    this.buildCue();
    this.buildGuides();
  }

  /* 物理坐标 → three 向量 */
  P(x, y, z = 0, out = new THREE.Vector3()) {
    return out.set((x - TABLE.W / 2) * this.S, z * this.S, -(y - TABLE.H / 2) * this.S);
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const w = Math.max(2, wrap.clientWidth), h = Math.max(2, wrap.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* 屏幕坐标 → 台面坐标（球心高度平面） */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      (clientX - rect.left) / rect.width * 2 - 1,
      -((clientY - rect.top) / rect.height * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.pickPlane, hit)) return null;
    return { x: hit.x / this.S + TABLE.W / 2, y: -hit.z / this.S + TABLE.H / 2 };
  }

  /* ================= 贴图 ================= */

  tex(w, h, draw, repeat) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  }

  noiseTex(base, amp, repeat, size = 256) {
    return this.tex(size, size, (g, w, h) => {
      const img = g.createImageData(w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - 0.5) * amp + (Math.random() < 0.04 ? amp * 0.5 : 0);
        d[i] = base[0] + n; d[i + 1] = base[1] + n; d[i + 2] = base[2] + n; d[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }, repeat);
  }

  woodTex(base, dark, repeat, streaks = 260) {
    return this.tex(512, 512, (g, w, h) => {
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      for (let i = 0; i < streaks; i++) {
        const y = Math.random() * h;
        g.strokeStyle = Math.random() < 0.7 ? dark : '#ffffff';
        g.globalAlpha = 0.03 + Math.random() * 0.10;
        g.lineWidth = 0.6 + Math.random() * 2.4;
        g.beginPath();
        g.moveTo(0, y);
        const a = (Math.random() - 0.5) * 14, b = (Math.random() - 0.5) * 14;
        g.bezierCurveTo(w * 0.33, y + a, w * 0.66, y + b, w, y);
        g.stroke();
      }
      g.globalAlpha = 1;
    }, repeat);
  }

  floorTex() {
    return this.tex(1024, 1024, (g, w, h) => {
      const rows = 8, rh = h / rows;
      for (let r = 0; r < rows; r++) {
        let x = -Math.random() * 400;
        while (x < w) {
          const len = 380 + Math.random() * 300;
          const l = 34 + Math.random() * 12;
          g.fillStyle = `hsl(${26 + Math.random() * 6}, ${38 + Math.random() * 10}%, ${l}%)`;
          g.fillRect(x, r * rh, len, rh);
          for (let i = 0; i < 26; i++) {
            g.strokeStyle = Math.random() < 0.6 ? '#2a1608' : '#e8c79a';
            g.globalAlpha = 0.04 + Math.random() * 0.07;
            g.lineWidth = 0.5 + Math.random() * 1.5;
            const y = r * rh + Math.random() * rh;
            g.beginPath(); g.moveTo(x, y);
            g.lineTo(x + len, y + (Math.random() - 0.5) * 6); g.stroke();
          }
          g.globalAlpha = 1;
          g.fillStyle = 'rgba(20,10,4,.75)';
          g.fillRect(x + len - 2, r * rh, 2, rh);
          x += len;
        }
        g.fillStyle = 'rgba(20,10,4,.8)';
        g.fillRect(0, r * rh, w, 2);
      }
    }, [4, 8]);
  }

  ballTex(id) {
    const color = BALL_COLORS[id];
    return this.tex(1024, 512, (g, w, h) => {
      if (id === 0) {
        // 白球：六个红点（训练球），旋转一目了然
        g.fillStyle = '#f4efe2'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#c0262c';
        const rr = h * 0.045;
        for (const u of [0, 0.25, 0.5, 0.75, 1]) {
          g.beginPath(); g.arc(u * w, h / 2, rr, 0, Math.PI * 2); g.fill();
        }
        g.fillRect(0, 0, w, rr * 0.9);
        g.fillRect(0, h - rr * 0.9, w, rr * 0.9);
        return;
      }
      if (isStripe(id)) {
        g.fillStyle = '#f4efe2'; g.fillRect(0, 0, w, h);
        g.fillStyle = color; g.fillRect(0, h * 0.26, w, h * 0.48);
      } else {
        g.fillStyle = color; g.fillRect(0, 0, w, h);
      }
      const nr = h * 0.135;
      for (const u of [0.25, 0.75]) {
        g.fillStyle = '#f6f2e6';
        g.beginPath(); g.arc(u * w, h / 2, nr, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#141414';
        g.font = `bold ${id >= 10 ? nr * 1.15 : nr * 1.45}px Arial, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(id), u * w, h / 2 + nr * 0.08);
        if (id === 6 || id === 9) g.fillRect(u * w - nr * 0.34, h / 2 + nr * 0.62, nr * 0.68, nr * 0.1);
      }
    });
  }

  /* ================= 环境与灯光 ================= */

  buildEnvironmentMap() {
    // 用一个小场景烘焙环境贴图：球面上能映出吊灯的长条高光和暖色的房间
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.BoxGeometry(11, 5, 9),
      new THREE.MeshBasicMaterial({ color: 0x1d1611, side: THREE.BackSide })));
    const panel = (w, h, col, pos, rot) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(col[0], col[1], col[2]), side: THREE.DoubleSide }));
      m.position.set(pos[0], pos[1], pos[2]);
      m.rotation.set(rot[0], rot[1], rot[2]);
      env.add(m);
    };
    panel(2.0, 0.5, [16, 15, 13], [0, 1.25, 0], [Math.PI / 2, 0, 0]);       // 吊灯
    panel(11, 9, [0.25, 0.17, 0.10], [0, -0.8, 0], [-Math.PI / 2, 0, 0]);   // 地板
    panel(3.0, 1.7, [0.06, 0.32, 0.16], [0, -0.02, 0], [-Math.PI / 2, 0, 0]); // 台呢
    for (const x of [-3.5, 3.5]) for (const z of [-4.4, 4.4]) {
      panel(0.5, 0.5, [3.2, 2.2, 1.2], [x, 1.3, z], [0, 0, 0]);             // 壁灯
    }
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pm.fromScene(env, 0.02).texture;
    this.scene.environment = this.envMap;
    pm.dispose();
  }

  buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xfff0dc, 0x2a1d12, 0.55));
    // 吊灯：三盏聚光灯排成一列，三重柔和的球影正是球房里的样子
    this.spots = [];
    for (const x of [-0.8, 0, 0.8]) {
      const sp = new THREE.SpotLight(0xfff2dc, 5.2, 9, 1.08, 0.75, 1.7);
      sp.position.set(x, this.LAMP_Y - 0.02, 0);
      sp.target.position.set(x * 1.25, 0, 0);
      sp.castShadow = true;
      sp.shadow.mapSize.set(x === 0 ? 2048 : 1024, x === 0 ? 2048 : 1024);
      sp.shadow.camera.near = 0.4;
      sp.shadow.camera.far = 4.5;
      sp.shadow.bias = -0.0004;
      sp.shadow.normalBias = 0.0015;
      s.add(sp); s.add(sp.target);
      this.spots.push(sp);
    }
    // 壁灯
    for (const x of [-3.5, 3.5]) for (const z of [-4.25, 4.25]) {
      const pl = new THREE.PointLight(0xffc58a, 7, 10, 1.8);
      pl.position.set(x, 1.3, z);
      s.add(pl);
    }
  }

  buildRoom() {
    const s = this.scene, FY = this.FLOOR_Y, RW = 11, RD = 9, RH = 3.3;
    const std = (o) => new THREE.MeshStandardMaterial(o);

    // 地板
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(RW, RD),
      std({ map: this.floorTex(), roughness: 0.42, metalness: 0, envMapIntensity: 0.5 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FY; floor.receiveShadow = true;
    s.add(floor);

    // 台下地毯
    const rugTex = this.tex(512, 512, (g, w, h) => {
      g.fillStyle = '#4a1418'; g.fillRect(0, 0, w, h);
      const img = g.getImageData(0, 0, w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 22;
        img.data[i] += n; img.data[i + 1] += n * 0.5; img.data[i + 2] += n * 0.5;
      }
      g.putImageData(img, 0, 0);
      g.strokeStyle = '#b08a4a'; g.lineWidth = 6; g.strokeRect(22, 30, w - 44, h - 60);
      g.lineWidth = 2; g.strokeRect(36, 50, w - 72, h - 100);
    });
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 3.2),
      std({ map: rugTex, roughness: 1, envMapIntensity: 0.15 }));
    rug.rotation.x = -Math.PI / 2; rug.position.y = FY + 0.004; rug.receiveShadow = true;
    s.add(rug);

    // 墙面 + 木墙裙 + 踢脚线 + 天花
    const wallMat = std({ map: this.noiseTex([92, 104, 96], 10, [8, 3]), roughness: 0.95, envMapIntensity: 0.25 });
    const wainMat = std({ map: this.woodTex('#4a2c18', '#1c0f06', [6, 1]), roughness: 0.55, envMapIntensity: 0.4 });
    const trimMat = std({ color: 0x2b190d, roughness: 0.5, envMapIntensity: 0.4 });
    const walls = [
      [RW, 0, -RD / 2, 0], [RW, 0, RD / 2, Math.PI],
      [RD, -RW / 2, 0, Math.PI / 2], [RD, RW / 2, 0, -Math.PI / 2],
    ];
    for (const [len, x, z, ry] of walls) {
      const g = new THREE.Group();
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, RH), wallMat);
      wall.position.y = RH / 2;
      const wain = new THREE.Mesh(new THREE.BoxGeometry(len, 1.0, 0.03), wainMat);
      wain.position.set(0, 0.5, 0.015);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.06), trimMat);
      cap.position.set(0, 1.02, 0.03);
      const base = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.05), trimMat);
      base.position.set(0, 0.06, 0.025);
      g.add(wall, wain, cap, base);
      g.position.set(x, FY, z); g.rotation.y = ry;
      s.add(g);
    }
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(RW, RD), std({ color: 0x1a1613, roughness: 1, envMapIntensity: 0.1 }));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = FY + RH;
    s.add(ceil);
    this.ceilY = FY + RH;

    // 壁灯
    const shadeMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
    for (const x of [-3.5, 3.5]) for (const z of [-RD / 2, RD / 2]) {
      const zz = z + (z < 0 ? 0.09 : -0.09);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.2, 20), shadeMat);
      shade.position.set(x, 1.3, zz);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.1), trimMat);
      arm.position.set(x, 1.2, z + (z < 0 ? 0.05 : -0.05));
      s.add(shade, arm);
    }

    // 杆架（远墙）
    const rack = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.1, 0.07), wainMat);
    board.position.y = 0.95;
    const board2 = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.07, 0.11), wainMat);
    board2.position.y = -0.52; board2.position.z = 0.02;
    rack.add(board, board2);
    const cueMatA = std({ color: 0xd8b577, roughness: 0.4 });
    const cueMatB = std({ color: 0x24140c, roughness: 0.4 });
    for (let i = 0; i < 6; i++) {
      const x = -0.42 + i * 0.168;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.010, 0.75, 10), cueMatA);
      shaft.position.set(x, 0.59, 0.05);
      const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.0145, 0.70, 10), cueMatB);
      butt.position.set(x, -0.135, 0.05);
      rack.add(shaft, butt);
    }
    rack.position.set(-2.4, FY + 1.05, -RD / 2 + 0.05);
    s.add(rack);

    // 挂画（远墙）
    const frameMat = std({ color: 0x1c120a, roughness: 0.4 });
    const arts = [
      [0.2, '#16261d', '#d9b45a', '8'], [1.5, '#2a1414', '#e8e2d0', '中式八球'], [2.9, '#141c2a', '#d9b45a', '9'],
    ];
    for (const [x, bg, fg, txt] of arts) {
      const t = this.tex(512, 384, (g, w, h) => {
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        g.strokeStyle = fg; g.lineWidth = 3; g.strokeRect(18, 18, w - 36, h - 36);
        if (txt.length === 1) {
          g.fillStyle = txt === '8' ? '#111' : '#f2c30f';
          g.beginPath(); g.arc(w / 2, h / 2, 110, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#f4efe2'; g.beginPath(); g.arc(w / 2, h / 2, 52, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#111'; g.font = 'bold 76px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(txt, w / 2, h / 2 + 5);
        } else {
          g.fillStyle = fg; g.font = 'bold 84px "Microsoft YaHei", sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(txt, w / 2, h / 2 - 20);
          g.font = '30px Arial'; g.fillText('CHINESE EIGHT-BALL', w / 2, h / 2 + 70);
        }
      });
      const fr = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.70, 0.04), frameMat);
      fr.position.set(x, 1.15, -RD / 2 + 0.03);
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.62), std({ map: t, roughness: 0.8, envMapIntensity: 0.2 }));
      pic.position.set(x, 1.15, -RD / 2 + 0.052);
      s.add(fr, pic);
    }

    // 长椅（侧墙）
    const leather = std({ color: 0x3a1512, roughness: 0.55, envMapIntensity: 0.5 });
    for (const sx of [-1, 1]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 2.6), leather);
      seat.position.set(sx * (RW / 2 - 0.36), FY + 0.42, 0);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 2.6), leather);
      back.position.set(sx * (RW / 2 - 0.1), FY + 0.74, 0);
      const baseB = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 2.5), trimMat);
      baseB.position.set(sx * (RW / 2 - 0.36), FY + 0.175, 0);
      s.add(seat, back, baseB);
    }
  }

  /* ================= 球台 ================= */

  roundedRect(shape, hx, hy, r) {
    shape.moveTo(-hx + r, -hy);
    shape.lineTo(hx - r, -hy);
    shape.absarc(hx - r, -hy + r, r, -Math.PI / 2, 0, false);
    shape.lineTo(hx, hy - r);
    shape.absarc(hx - r, hy - r, r, 0, Math.PI / 2, false);
    shape.lineTo(-hx + r, hy);
    shape.absarc(-hx + r, hy - r, r, Math.PI / 2, Math.PI, false);
    shape.lineTo(-hx, -hy + r);
    shape.absarc(-hx + r, -hy + r, r, Math.PI, Math.PI * 1.5, false);
    return shape;
  }

  buildTable() {
    const S = this.S, hw = this.hw, hh = this.hh, T = TABLE;
    const g = this.table = new THREE.Group();
    this.scene.add(g);
    const CD = T.CUSHION_D * S, RWd = T.RAIL_W * S, RT = T.RAIL_TOP * S;
    const outX = hw + CD + RWd, outY = hh + CD + RWd;

    // 每个袋口在“台面中心坐标”下的朝向与木边开孔圆弧范围
    for (const p of T.pockets) {
      const th = Math.atan2(p.oy, p.ox);
      let del;
      if (p.corner) {
        const px = p.ox > 0 ? T.W : 0;
        const e = T.CUSHION_D - Math.abs(p.cutX - px);
        const sq = Math.sqrt(p.cutR * p.cutR - e * e);
        del = Math.acos((e - sq) / (p.cutR * Math.SQRT2));
      } else {
        const py = p.oy > 0 ? T.H : 0;
        const m = Math.abs(p.cutY - py) - T.CUSHION_D;
        del = Math.acos(-m / p.cutR);
      }
      p.arc = { th, del };
    }

    // —— 台呢（石板）：一整块，六个落球孔 ——
    this.clothTex = this.noiseTex([20, 108, 64], 14, [7, 7]);
    const clothMat = this.clothMat = new THREE.MeshStandardMaterial({
      map: this.clothTex, roughness: 0.97, metalness: 0, envMapIntensity: 0.22 });
    const ext = CD + RWd - 0.01;
    const bed = new THREE.Shape();
    bed.moveTo(-hw - ext, -hh - ext); bed.lineTo(hw + ext, -hh - ext);
    bed.lineTo(hw + ext, hh + ext); bed.lineTo(-hw - ext, hh + ext); bed.closePath();
    for (const p of T.pockets) {
      const h = new THREE.Path();
      h.absarc((p.x - T.W / 2) * S, (p.y - T.H / 2) * S, p.r * S, 0, Math.PI * 2, true);
      bed.holes.push(h);
    }
    const bedGeo = new THREE.ShapeGeometry(bed, 40);
    bedGeo.rotateX(-Math.PI / 2);
    const bedMesh = new THREE.Mesh(bedGeo, clothMat);
    bedMesh.receiveShadow = true;
    g.add(bedMesh);

    // 开球线与置球点
    const markMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.003, T.H * S), markMat);
    line.rotation.x = -Math.PI / 2;
    line.position.copy(this.P(T.HEAD_X, T.H / 2, 0.4));
    g.add(line);
    for (const x of [T.HEAD_X, T.FOOT_X, T.W / 2]) {
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 20), markMat);
      dot.rotation.x = -Math.PI / 2;
      dot.position.copy(this.P(x, T.H / 2, 0.5));
      g.add(dot);
    }

    // —— 库边 ——
    const cushMat = new THREE.MeshStandardMaterial({
      map: this.clothTex, color: 0xeef4ee, roughness: 0.95, envMapIntensity: 0.22, side: THREE.DoubleSide });
    for (const c of T.cushions) {
      const pos = [], uv = [], idx = [];
      let len = 0;
      for (let i = 0; i < c.length; i++) {
        const p = c[i];
        if (i > 0) len += Math.hypot(p.x - c[i - 1].x, p.y - c[i - 1].y);
        const top = this.P(p.x, p.y, T.NOSE_H);
        const back = this.P(p.bx, p.by, T.RAIL_TOP);
        const foot = this.P(p.x + (p.bx - p.x) * 0.3, p.y + (p.by - p.y) * 0.3, 0);
        pos.push(top.x, top.y, top.z, back.x, back.y, back.z, top.x, top.y, top.z, foot.x, foot.y, foot.z);
        const u = len * S;
        uv.push(u, 0, u, 0.05, u, 0, u, 0.04);
      }
      for (let i = 0; i < c.length - 1; i++) {
        const a = i * 4, b = (i + 1) * 4;
        idx.push(a, a + 1, b, b, a + 1, b + 1, a + 2, b + 2, a + 3, b + 2, b + 3, a + 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, cushMat);
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
    }

    // —— 木边：外圆角矩形，内轮廓 = 库背矩形 ∪ 六个袋口开孔圆 ——
    const woodTex = this.woodTex('#5a2f17', '#1e0d05', [1.2, 5]);
    const woodMat = this.woodMat = new THREE.MeshPhysicalMaterial({
      map: woodTex, roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 0.3 });
    const railShape = this.roundedRect(new THREE.Shape(), outX, outY, 0.075);
    const inner = [];
    for (const i of [1, 2, 5, 4, 3, 0]) {
      const p = T.pockets[i];
      const cx = (p.cutX - T.W / 2) * S, cy = (p.cutY - T.H / 2) * S, r = p.cutR * S;
      const N = 22;
      for (let k = 0; k <= N; k++) {
        const a = p.arc.th - p.arc.del + 2 * p.arc.del * k / N;
        inner.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
      }
    }
    railShape.holes.push(new THREE.Path().setFromPoints(inner));
    const bev = 0.004;
    const railGeo = new THREE.ExtrudeGeometry(railShape, {
      depth: RT - bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev,
      bevelOffset: -bev, bevelSegments: 3, curveSegments: 16 });
    railGeo.rotateX(-Math.PI / 2);
    const rail = new THREE.Mesh(railGeo, woodMat);
    rail.castShadow = true; rail.receiveShadow = true;
    g.add(rail);

    // 颗星（钻石标记）
    const pearl = new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.25, envMapIntensity: 1 });
    const sightGeo = new THREE.CircleGeometry(0.0055, 16);
    sightGeo.rotateX(-Math.PI / 2);
    const dOff = T.CUSHION_D + T.RAIL_W * 0.5;
    const addSight = (x, y) => {
      const m = new THREE.Mesh(sightGeo, pearl);
      m.position.copy(this.P(x, y, T.RAIL_TOP + 0.25));
      g.add(m);
    };
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      addSight(T.W * i / 8, -dOff); addSight(T.W * i / 8, T.H + dOff);
    }
    for (let i = 1; i < 4; i++) { addSight(-dOff, T.H * i / 4); addSight(T.W + dOff, T.H * i / 4); }

    // —— 袋口：木边开孔内衬 + 石板孔内衬 + 袋底 + 袋口胶圈 ——
    const linerMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9, envMapIntensity: 0.15, side: THREE.DoubleSide });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.5, envMapIntensity: 0.6 });
    const depth = 0.15;
    for (const p of T.pockets) {
      const c = this.P(p.cutX, p.cutY, 0), f = this.P(p.x, p.y, 0);
      const up = new THREE.Mesh(
        new THREE.CylinderGeometry(p.cutR * S - 0.0012, p.cutR * S - 0.0012, RT, 28, 1, true,
          p.arc.th - p.arc.del + Math.PI / 2, 2 * p.arc.del), linerMat);
      up.position.set(c.x, RT / 2, c.z);
      const low = new THREE.Mesh(new THREE.CylinderGeometry(p.r * S, p.r * S, depth, 36, 1, true), linerMat);
      low.position.set(f.x, -depth / 2, f.z);
      const bottom = new THREE.Mesh(new THREE.CircleGeometry(p.r * S, 32), linerMat);
      bottom.rotation.x = -Math.PI / 2;
      bottom.position.set(f.x, -depth + 0.001, f.z);
      const rimGeo = new THREE.TorusGeometry(p.cutR * S + 0.002, 0.0045, 8, 28, 2 * p.arc.del);
      rimGeo.rotateZ(p.arc.th - p.arc.del);
      rimGeo.rotateX(-Math.PI / 2);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.set(c.x, RT, c.z);
      g.add(up, low, bottom, rim);
    }

    // —— 台身：裙板、底板、台脚 ——
    const bodyMat = new THREE.MeshPhysicalMaterial({
      map: this.woodTex('#4a2512', '#180a04', [3, 0.4]), roughness: 0.5, clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.5 });
    const apronShape = this.roundedRect(new THREE.Shape(), outX - 0.012, outY - 0.012, 0.065);
    const ah = new THREE.Path();
    const ix = hw + 0.10, iy = hh + 0.10;
    ah.moveTo(-ix, -iy); ah.lineTo(-ix, iy); ah.lineTo(ix, iy); ah.lineTo(ix, -iy); ah.closePath();
    apronShape.holes.push(ah);
    const apronGeo = new THREE.ExtrudeGeometry(apronShape, { depth: 0.20, bevelEnabled: false, curveSegments: 12 });
    apronGeo.rotateX(-Math.PI / 2);
    const apron = new THREE.Mesh(apronGeo, bodyMat);
    apron.position.y = -0.204;
    apron.castShadow = true; apron.receiveShadow = true;
    g.add(apron);
    const under = new THREE.Mesh(new THREE.BoxGeometry(outX * 2 - 0.06, 0.05, outY * 2 - 0.06),
      new THREE.MeshStandardMaterial({ color: 0x120a05, roughness: 0.9 }));
    under.position.y = -0.185;
    under.castShadow = true;
    g.add(under);
    const legH = -this.FLOOR_Y - 0.2;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.075, legH, 4, 1), bodyMat);
      leg.rotation.y = Math.PI / 4;
      leg.position.set(sx * (hw - 0.12), -0.2 - legH / 2, sz * (hh - 0.02));
      leg.castShadow = true; leg.receiveShadow = true;
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.03, 16),
        new THREE.MeshStandardMaterial({ color: 0x8a6a35, metalness: 0.9, roughness: 0.35 }));
      foot.position.set(leg.position.x, this.FLOOR_Y + 0.015, leg.position.z);
      g.add(leg, foot);
    }

    // 木边上的巧粉
    const chalk = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, 0.022),
      new THREE.MeshStandardMaterial({ color: 0x2d5fa8, roughness: 0.95 }));
    chalk.position.copy(this.P(T.W * 0.31, T.H + dOff + 12, T.RAIL_TOP + 11));
    chalk.rotation.y = 0.5; chalk.castShadow = true;
    g.add(chalk);
  }

  buildLamp() {
    const lamp = this.lamp = new THREE.Group();
    const Y = this.LAMP_Y;
    const shell = new THREE.MeshStandardMaterial({ color: 0x143525, roughness: 0.35, metalness: 0.3, envMapIntensity: 0.6 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xb08a45, roughness: 0.3, metalness: 0.9 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.13, 0.62), shell);
    body.position.y = Y + 0.065;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(2.19, 0.02, 0.66), brass);
    trim.position.y = Y + 0.004;
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xfff3dc, toneMapped: false }));
    glow.rotation.x = Math.PI / 2;
    glow.position.y = Y - 0.007;
    lamp.add(body, trim, glow);
    for (const x of [-0.85, 0.85]) {
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, this.ceilY - Y - 0.13, 8), brass);
      rod.position.set(x, (this.ceilY + Y + 0.13) / 2, 0);
      lamp.add(rod);
    }
    this.scene.add(lamp);
  }

  /* ================= 球 / 球杆 / 辅助线 ================= */

  buildBalls() {
    const geo = new THREE.SphereGeometry(TABLE.R * this.S, 48, 32);
    this.ballMeshes = {};
    for (let id = 0; id <= 15; id++) {
      const mat = new THREE.MeshPhysicalMaterial({
        map: this.ballTex(id), roughness: 0.1, metalness: 0,
        clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.0 });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true;
      m.visible = false;
      this.scene.add(m);
      this.ballMeshes[id] = m;
    }
  }

  buildCue() {
    const cue = this.cueGroup = new THREE.Group();
    const seg = (x0, x1, r0, r1, mat) => {
      // 杆沿局部 +X 指向球，x0/x1 为离杆头的距离
      const geo = new THREE.CylinderGeometry(r0, r1, x1 - x0, 20);
      geo.rotateZ(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.position.x = -(x0 + x1) / 2;
      m.castShadow = true;
      cue.add(m);
    };
    const std = (o) => new THREE.MeshStandardMaterial(o);
    const rAt = (x) => 0.00575 + (0.0145 - 0.00575) * x / 1.45;
    seg(0, 0.007, 0.0052, rAt(0.007), std({ color: 0x2f5f9a, roughness: 0.95 }));               // 皮头（带巧粉）
    seg(0.007, 0.03, rAt(0.007), rAt(0.03), std({ color: 0xf1ecdf, roughness: 0.35 }));          // 先角
    seg(0.03, 0.74, rAt(0.03), rAt(0.74), std({ map: this.woodTex('#dbb67a', '#a8803e', [3, 1], 120), roughness: 0.4 })); // 前节
    seg(0.74, 0.76, rAt(0.74) + 0.0006, rAt(0.76) + 0.0006, std({ color: 0xb08a45, metalness: 0.9, roughness: 0.3 }));    // 铜箍
    seg(0.76, 1.42, rAt(0.76), rAt(1.42), std({ map: this.woodTex('#2a1509', '#080402', [3, 1], 120), roughness: 0.35 })); // 后节
    seg(1.42, 1.45, rAt(1.42), rAt(1.45) * 0.96, std({ color: 0x111111, roughness: 0.7 }));      // 胶垫
    cue.visible = false;
    this.scene.add(cue);
  }

  buildGuides() {
    const basic = (color, opacity) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, toneMapped: false });
    const mkLine = (mat) => {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.visible = false; m.renderOrder = 5;
      this.scene.add(m);
      return m;
    };
    const R = TABLE.R * this.S;
    this.gAim = mkLine(basic(0xffffff, 0.5));
    this.gTarget = mkLine(basic(0xffd866, 0.85));
    this.gTangent = mkLine(basic(0x8fd0ff, 0.75));
    this.gGhost = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 20), basic(0xffffff, 0.22));
    this.gGhost.visible = false; this.gGhost.renderOrder = 6;
    const ringGeo = new THREE.RingGeometry(R * 0.86, R, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.gRing = new THREE.Mesh(ringGeo, basic(0xffffff, 0.7));
    this.gRing.visible = false; this.gRing.renderOrder = 6;
    // 自由球预览
    this.gPlace = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 20),
      new THREE.MeshStandardMaterial({ color: 0xf4efe2, transparent: true, opacity: 0.6, roughness: 0.2 }));
    this.gPlace.visible = false;
    const pr = new THREE.RingGeometry(R * 1.2, R * 1.38, 48);
    pr.rotateX(-Math.PI / 2);
    this.gPlaceRing = new THREE.Mesh(pr, basic(0x78e682, 0.9));
    this.gPlaceRing.visible = false; this.gPlaceRing.renderOrder = 6;
    const zone = new THREE.PlaneGeometry(TABLE.HEAD_X * this.S, TABLE.H * this.S);
    zone.rotateX(-Math.PI / 2);
    this.gZone = new THREE.Mesh(zone, basic(0xffffff, 0.07));
    this.gZone.position.copy(this.P(TABLE.HEAD_X / 2, TABLE.H / 2, 0.6));
    this.gZone.visible = false;
    this.scene.add(this.gGhost, this.gRing, this.gPlace, this.gPlaceRing, this.gZone);
  }

  setLine(mesh, x0, y0, x1, y1, widthMM) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1) { mesh.visible = false; return; }
    mesh.visible = true;
    this.P((x0 + x1) / 2, (y0 + y1) / 2, 0.8, mesh.position);
    mesh.scale.set(len * this.S, 1, widthMM * this.S);
    mesh.rotation.y = Math.atan2(y1 - y0, x1 - x0);
  }

  /* ================= 每帧更新 ================= */

  draw(state, dt) {
    this.time += dt;
    this.syncBalls(state.world);
    this.updateCue(state);
    this.updateGuides(state);
    this.updateCamera(state.cam, dt);
    this.renderer.render(this.scene, this.camera);
  }

  syncBalls(world) {
    const seen = new Set();
    for (const b of world.balls) {
      const m = this.ballMeshes[b.id];
      seen.add(b.id);
      m.visible = !(b.potted && b.sink >= 1);
      this.P(b.x, b.y, TABLE.R + b.z, m.position);
      m.quaternion.set(b.qx, b.qz, -b.qy, b.qw);
    }
    for (let id = 0; id <= 15; id++) if (!seen.has(id)) this.ballMeshes[id].visible = false;
  }

  updateCue(state) {
    const c = state.cue;
    const g = this.cueGroup;
    if (!c) { g.visible = false; return; }
    g.visible = true;
    const R = TABLE.R, S = this.S;
    const dx = Math.cos(c.angle), dy = Math.sin(c.angle);
    const a = c.a * Phys.MAX_TIP, b = c.b * Phys.MAX_TIP;
    const depth = Math.sqrt(Math.max(0.05, 1 - a * a - b * b));
    // 杆头触点（球面上）：右 = d × ẑ = (dy, -dx)
    const px = c.x + R * (a * dy - depth * dx);
    const py = c.y + R * (-a * dx - depth * dy);
    const pz = R + R * b;
    // 抬杆角：杆尾要越过身后的库边
    let tBack = Infinity;
    if (dx > 0) tBack = Math.min(tBack, c.x / dx);
    if (dx < 0) tBack = Math.min(tBack, (c.x - TABLE.W) / dx);
    if (dy > 0) tBack = Math.min(tBack, c.y / dy);
    if (dy < 0) tBack = Math.min(tBack, (c.y - TABLE.H) / dy);
    let el = 0.055;
    if (tBack < 1500) el = Math.max(el, Math.atan2(TABLE.RAIL_TOP + 24 - pz, Math.max(20, tBack + c.pull - 10)));
    el = Math.min(el, 0.7);
    const ce = Math.cos(el), se = Math.sin(el);
    // 杆轴方向（three 坐标）
    const ux = ce * dx, uy = -se, uz = -ce * dy;
    const tip = this.P(px, py, pz, g.position);
    const back = (c.pull + 1) * S;
    tip.x -= ux * back; tip.y -= uy * back; tip.z -= uz * back;
    g.quaternion.setFromUnitVectors(Renderer3D.X_AXIS, this._v.set(ux, uy, uz));
  }

  updateGuides(state) {
    const gd = state.guide;
    const hide = () => {
      this.gAim.visible = this.gTarget.visible = this.gTangent.visible = false;
      this.gGhost.visible = this.gRing.visible = false;
    };
    if (!gd) hide();
    else {
      const cue = state.world.cue;
      const R = TABLE.R;
      const tr = state.world.traceAim(cue, gd.angle);
      const dx = Math.cos(gd.angle), dy = Math.sin(gd.angle);
      this.setLine(this.gAim, cue.x + dx * R, cue.y + dy * R, tr.x, tr.y, 3);
      if (tr.type === 'ball') {
        this.gGhost.visible = this.gRing.visible = true;
        this.P(tr.x, tr.y, R, this.gGhost.position);
        this.P(tr.x, tr.y, 0.9, this.gRing.position);
        const L = gd.full ? 420 : 200;
        const tb = tr.targetBall, td = tr.targetDir;
        this.setLine(this.gTarget, tb.x + td.x * R, tb.y + td.y * R, tb.x + td.x * (R + L), tb.y + td.y * (R + L), 4);
        const dot = dx * td.x + dy * td.y;
        let tx = dx - td.x * dot, ty = dy - td.y * dot;
        const tl = Math.hypot(tx, ty);
        if (tl > 0.06) {
          tx /= tl; ty /= tl;
          this.setLine(this.gTangent, tr.x, tr.y, tr.x + tx * L * 0.6 * tl, tr.y + ty * L * 0.6 * tl, 3);
        } else this.gTangent.visible = false;
      } else {
        this.gTarget.visible = this.gTangent.visible = false;
        this.gGhost.visible = this.gRing.visible = false;
      }
    }
    const gh = state.ghost;
    this.gPlace.visible = this.gPlaceRing.visible = !!gh;
    if (gh) {
      this.P(gh.x, gh.y, TABLE.R, this.gPlace.position);
      this.P(gh.x, gh.y, 0.9, this.gPlaceRing.position);
      this.gPlaceRing.material.color.set(gh.valid ? 0x78e682 : 0xe65a50);
    }
    this.gZone.visible = !!state.behindLine;
  }

  /* 相机：
   *  aim   — 站在白球后方沿瞄准线看（俯仰/距离可调）
   *  shot  — 出杆后拉高看全台
   *  side  — 长边一侧的观战机位（AI 回合）
   *  top   — 正上方俯视
   *  orbit — 菜单背景的缓慢环绕 */
  updateCamera(cam, dt) {
    const pos = this._pos, tgt = this._tgt, up = this._up.set(0, 1, 0);
    const k = Math.max(1, 1.7 / this.camera.aspect);
    const mode = cam.mode;
    if (mode === 'aim' || mode === 'shot') {
      const dx = Math.cos(cam.angle), dz = -Math.sin(cam.angle);
      const f = this.P(cam.x, cam.y, TABLE.R, this._f);
      let dist = this.view.dist, pitch = this.view.pitch, ahead = 0.22 + this.view.dist * 0.16;
      if (mode === 'shot') {
        f.multiplyScalar(0.3);
        dist = 3.2 * k; pitch = 0.36; ahead = 0;
      }
      let h = dist * Math.sin(pitch);
      const hMax = this.LAMP_Y - 0.13;
      let back = dist * Math.cos(pitch);
      if (h > hMax) { h = hMax; }
      pos.set(f.x - dx * back, f.y + h, f.z - dz * back);
      tgt.set(f.x + dx * ahead, f.y, f.z + dz * ahead);
    } else if (mode === 'top') {
      const tanH = Math.tan(this.camera.fov * Math.PI / 360);
      const h = Math.max(1.78 / (2 * tanH), 3.06 / (2 * tanH * this.camera.aspect));
      pos.set(0, h, 0.0001); tgt.set(0, 0, 0); up.set(0, 0, -1);
    } else if (mode === 'side') {
      pos.set(0, 1.1, 2.95 * k); tgt.set(0, 0, 0.12);
    } else {
      const a = this.time * 0.07 + 0.6;
      pos.set(Math.cos(a) * 3.3 * k, 1.05, Math.sin(a) * 2.9 * k); tgt.set(0, 0, 0);
    }
    // 把机位限制在房间内
    pos.x = Math.max(-5.2, Math.min(5.2, pos.x));
    pos.z = Math.max(-4.2, Math.min(4.2, pos.z));

    const rate = this.firstFrame ? 1 : 1 - Math.exp(-dt * (cam.snap ? 26 : 5.5));
    this.firstFrame = false;
    this.camPos.lerp(pos, rate);
    this.camTarget.lerp(tgt, rate);
    this.camUp.lerp(up, rate).normalize();
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(this.camUp);
    this.camera.lookAt(this.camTarget);
    // 机位高过吊灯时把吊灯藏起来，免得挡住台面
    this.lamp.visible = this.camPos.y < this.LAMP_Y - 0.04;
  }

  /* 用户调节瞄准视角 */
  orbit(dPitch) {
    this.view.pitch = Math.max(0.07, Math.min(1.35, this.view.pitch + dPitch));
  }
  zoom(factor) {
    this.view.dist = Math.max(0.55, Math.min(2.6, this.view.dist * factor));
  }
}
Renderer3D.X_AXIS = new THREE.Vector3(1, 0, 0);
Renderer3D.prototype._v = new THREE.Vector3();
Renderer3D.prototype._pos = new THREE.Vector3();
Renderer3D.prototype._tgt = new THREE.Vector3();
Renderer3D.prototype._up = new THREE.Vector3();
Renderer3D.prototype._f = new THREE.Vector3();
