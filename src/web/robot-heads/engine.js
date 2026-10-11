/*! robot-heads v0.3.0 by Fayaz Ahmed. MIT License (see ./LICENSE).
 * https://github.com/fayazara/robot-heads/tree/58ebf6439a8125a769f63b22ffd35bc18834b1b5
 * Canvas renderer bundled from src/tv, color and ticker; React wrapper excluded.
 * Pekka change: the export list also names the helpers ../pekka-renderer.js draws with. */

// ../robot-heads/src/tv/sim.ts
var Spring = class {
  constructor(x = 0) {
    this.x = 0;
    this.v = 0;
    this.x = x;
  }
  step(target, dt, freq, damping) {
    const w = freq * Math.PI * 2;
    this.v += (w * w * (target - this.x) - 2 * damping * w * this.v) * dt;
    this.x += this.v * dt;
  }
};
function rng(seed) {
  let a = Math.floor(seed * 4294967295) >>> 0 || 1;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
var easeInOut = (p) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
var CROUCH = 0.11;
var RobotSim = class {
  constructor(seed, state) {
    /* seconds since `shown` changed, and since the head appeared */
    this.switched = 10;
    this.age = 0;
    this.time = 0;
    this.since = 0;
    this.pose = { yaw: 0, pitch: 0, roll: 0, x: 0, lift: 0, sx: 1, sy: 1, antennaX: 0, antennaZ: 0 };
    /* the pointer, relative to the head's centre in CSS px, or null */
    this.pointer = null;
    this.yaw = new Spring();
    this.pitch = new Spring();
    this.roll = new Spring();
    this.sway = new Spring();
    this.squash = new Spring();
    this.antX = new Spring();
    this.antZ = new Spring();
    this.lastV = { roll: 0, pitch: 0, sway: 0 };
    this.jump = null;
    this.lookAt = { yaw: 0, pitch: 0, x: 0, y: 0 };
    this.nextLook = 0.6;
    this.nextBlink = 1.5;
    this.blinkAge = -1;
    this.nextHop = 8;
    this.nextSide = 4;
    this.reactUntil = -1;
    this.nextNod = 2.5;
    this.random = rng(seed);
    this.state = this.shown = this.previous = state;
    this.face = { lookX: 0, lookY: 0, blink: 0, time: 0, side: 1, seed };
    this.nextBlink = 1 + this.random() * 3;
    this.nextHop = 6 + this.random() * 6;
  }
  setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.since = 0;
    this.nextLook = 0;
    this.nextHop = this.time + (s === "happy" ? 0.2 : 3 + this.random() * 4);
    if (s === "happy") this.hop(0.22, 1);
  }
  /** A click: a hop with a full turn and a happy face. */
  poke() {
    this.hop(0.24, this.random() < 0.5 ? 1 : -1);
    this.reactUntil = this.time + 1.6;
  }
  hop(height, spin) {
    if (this.jump) return;
    this.jump = { age: 0, height, spin, lean: (this.random() - 0.5) * 0.3, air: 0.42 + height * 0.45, landed: false };
  }
  update(dt) {
    if (!(dt > 0)) return;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < steps; i++) this.step(dt / steps);
  }
  step(dt) {
    this.time += dt;
    this.since += dt;
    this.age += dt;
    this.switched += dt;
    const t = this.time;
    const rand = this.random;
    const shown = t < this.reactUntil ? "happy" : this.state;
    if (shown !== this.shown) {
      this.previous = this.shown;
      this.shown = shown;
      this.switched = 0;
    }
    let yaw = 0, pitch = 0, roll = 0, sway = 0, bob = Math.sin(t * 1.9) * 8e-3;
    let lookX = 0, lookY = 0;
    let freq = 1.3, damping = 0.62;
    let shake = 0;
    const p = this.pointer;
    const follows = p && (this.state === "idle" || this.state === "listening" || this.state === "happy" || this.state === "speaking");
    if (t > this.nextLook) {
      this.lookAt = {
        yaw: (rand() - 0.5) * 0.75,
        pitch: (rand() - 0.5) * 0.24,
        x: 0,
        y: 0
      };
      this.lookAt.x = clamp(Math.round(this.lookAt.yaw * 5), -2, 2);
      this.lookAt.y = rand() < 0.3 ? -1 : rand() < 0.2 ? 1 : 0;
      this.nextLook = t + 1.4 + rand() * 2.6;
    }
    switch (this.state) {
      case "idle":
        yaw = this.lookAt.yaw;
        pitch = this.lookAt.pitch;
        roll = -this.lookAt.yaw * 0.16;
        lookX = this.lookAt.x;
        lookY = this.lookAt.y;
        if (t > this.nextHop) {
          this.hop(0.15 + rand() * 0.07, rand() < 0.35 ? rand() < 0.5 ? 1 : -1 : 0);
          this.nextHop = t + 7 + rand() * 7;
        }
        break;
      case "thinking": {
        if (t > this.nextSide) {
          this.face.side = -this.face.side;
          this.nextSide = t + 3 + rand() * 2;
        }
        const s = this.face.side;
        yaw = 0.24 * s + Math.sin(t * 0.9) * 0.05;
        pitch = 0.17 + Math.sin(t * 1.3) * 0.03;
        roll = -0.13 * s;
        freq = 0.9;
        break;
      }
      case "searching": {
        const ph = t * 1.6;
        yaw = Math.sin(ph) * 0.55;
        pitch = -0.04 + Math.sin(ph * 2) * 0.04;
        roll = Math.sin(ph) * -0.06;
        lookX = clamp(Math.sin(ph + 0.4) * 3, -3, 3);
        freq = 2.2;
        damping = 0.8;
        break;
      }
      case "listening": {
        yaw = -0.14;
        pitch = 0.02;
        roll = 0.17;
        if (t > this.nextNod) {
          this.pitch.v -= 0.9;
          this.nextNod = t + 2 + rand() * 2.5;
        }
        break;
      }
      case "speaking":
        yaw = Math.sin(t * 0.7) * 0.12;
        pitch = 0.03 + Math.sin(t * 6.3) * 0.025 * (0.5 + 0.5 * Math.sin(t * 2.1));
        roll = Math.sin(t * 0.9) * 0.05;
        bob += Math.abs(Math.sin(t * 6.3)) * 0.01;
        freq = 1.8;
        break;
      case "working":
        yaw = Math.sin(t * 0.8) * 0.08;
        pitch = -0.16;
        roll = Math.sin(t * 0.5) * 0.04;
        bob += Math.abs(Math.sin(t * 7)) * 0.012;
        if (t > this.nextHop) {
          this.hop(0.2, rand() < 0.5 ? 1 : -1);
          this.nextHop = t + 5 + rand() * 3;
        }
        break;
      case "happy":
        yaw = Math.sin(t * 2.2) * 0.18;
        roll = Math.sin(t * 4.4) * 0.12;
        pitch = 0.08;
        if (t > this.nextHop) {
          this.hop(0.17, rand() < 0.34 ? rand() < 0.5 ? 1 : -1 : 0);
          this.nextHop = t + 1.05 + rand() * 0.4;
        }
        break;
      case "error": {
        const c = t % 2.4 / 0.7;
        shake = c < 1 ? Math.sin(c * Math.PI * 7) * 0.22 * (1 - c) : 0;
        pitch = -0.06;
        roll = -0.05;
        freq = 1.6;
        break;
      }
      case "sleeping":
        pitch = -0.34;
        roll = 0.13;
        yaw = 0.06;
        bob = Math.sin(t * 1.15) * 0.016;
        freq = 0.55;
        damping = 0.9;
        if (t > this.nextNod) {
          this.pitch.v -= 0.5;
          this.nextNod = t + 5 + rand() * 4;
        }
        break;
    }
    if (follows && p) {
      yaw = clamp(p.x / 260, -1, 1) * 0.55;
      pitch = -clamp(p.y / 260, -1, 1) * 0.32;
      roll = -yaw * 0.12 + (this.state === "listening" ? 0.12 : 0);
      lookX = clamp(p.x / 120, -2.4, 2.4);
      lookY = clamp(p.y / 160, -1.4, 1.4);
    }
    this.yaw.step(yaw, dt, freq, damping);
    this.pitch.step(pitch, dt, freq, damping);
    this.roll.step(roll, dt, freq, damping);
    this.sway.step(sway, dt, 1.2, 0.7);
    let lift = 0, spin = 0, lean = 0;
    let squashTarget = 0;
    const j = this.jump;
    if (j) {
      j.age += dt;
      if (j.age < CROUCH) {
        squashTarget = 0.14;
      } else {
        const ap = (j.age - CROUCH) / j.air;
        if (ap < 1) {
          if (ap < 0.06 && this.squash.x > 0.05) {
            this.squash.v = -2.6;
            this.antZ.v -= 3;
          }
          lift = 4 * j.height * ap * (1 - ap);
          spin = j.spin * Math.PI * 2 * easeInOut(clamp(ap * 1.08, 0, 1));
          lean = j.lean * Math.sin(ap * Math.PI);
          squashTarget = ap < 0.5 ? -0.05 : 0;
        } else if (!j.landed) {
          j.landed = true;
          this.squash.v += 3.2;
          this.antX.v += (rand() < 0.5 ? -1 : 1) * (2.5 + rand() * 2);
          this.antZ.v += 3.5;
        } else if (j.age - CROUCH - j.air > 0.35) {
          this.jump = null;
        }
      }
    }
    this.squash.step(squashTarget, dt, 3.2, 0.32);
    if (t > this.nextBlink) {
      this.blinkAge = 0;
      this.nextBlink = t + 2.2 + rand() * 3.5;
      if (rand() < 0.2) this.nextBlink = t + 0.35;
    }
    let blink = 0;
    if (this.blinkAge >= 0) {
      this.blinkAge += dt;
      blink = Math.sin(clamp(this.blinkAge / 0.17, 0, 1) * Math.PI);
      if (this.blinkAge > 0.17) this.blinkAge = -1;
    }
    const rollAcc = (this.roll.v - this.lastV.roll) / dt;
    const pitchAcc = (this.pitch.v - this.lastV.pitch) / dt;
    const swayAcc = (this.sway.v - this.lastV.sway) / dt;
    this.lastV = { roll: this.roll.v, pitch: this.pitch.v, sway: this.sway.v };
    const aw = 2.3;
    this.antX.v -= (rollAcc * 0.05 + swayAcc * 0.3) * dt * 6;
    this.antZ.v -= pitchAcc * 0.05 * dt * 6;
    this.antX.step(0, dt, aw, 0.09);
    this.antZ.step(0, dt, aw, 0.09);
    this.antX.x = clamp(this.antX.x, -0.7, 0.7);
    this.antZ.x = clamp(this.antZ.x, -0.7, 0.7);
    const sq = this.squash.x;
    this.pose = {
      yaw: this.yaw.x + spin + shake,
      pitch: this.pitch.x,
      roll: this.roll.x + lean,
      x: this.sway.x,
      lift: lift + bob,
      sx: 1 + sq * 0.55,
      sy: 1 - sq,
      antennaX: this.antX.x,
      antennaZ: this.antZ.x
    };
    this.face.lookX = lookX;
    this.face.lookY = lookY;
    this.face.blink = this.state === "sleeping" ? 0 : blink;
    this.face.time = this.since;
  }
};
function restPose(state) {
  const base = { yaw: 0, pitch: 0, roll: 0, x: 0, lift: 0, sx: 1, sy: 1, antennaX: 0, antennaZ: 0 };
  switch (state) {
    case "thinking":
      return { ...base, yaw: 0.24, pitch: 0.17, roll: -0.13 };
    case "searching":
      return { ...base, yaw: 0.3, roll: -0.04 };
    case "listening":
      return { ...base, yaw: -0.14, pitch: 0.02, roll: 0.17 };
    case "working":
      return { ...base, pitch: -0.16 };
    case "happy":
      return { ...base, pitch: 0.08, roll: 0.06 };
    case "error":
      return { ...base, pitch: -0.06, roll: -0.05 };
    case "sleeping":
      return { ...base, pitch: -0.34, roll: 0.13, yaw: 0.06 };
    default:
      return { ...base, yaw: -0.18, pitch: 0.04, roll: 0.03 };
  }
}

// ../robot-heads/src/tv/faces.ts
var COLS = 22;
var ROWS = 14;
function makeGrid(cols, rows) {
  const c = COLS + 2 * Math.max(0, Math.ceil((cols - COLS) / 2));
  const r = ROWS + 2 * Math.max(0, Math.ceil((rows - ROWS) / 2));
  return { v: new Float32Array(c * r), cols: c, rows: r, ox: (c - COLS) / 2, oy: (r - ROWS) / 2 };
}
var put = (g, c, r, v) => {
  const x = c + g.ox, y = r + g.oy;
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return;
  const i = y * g.cols + x;
  if (v > g.v[i]) g.v[i] = v;
};
var rect = (g, c, r, w, h, v) => {
  for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) put(g, x, y, v);
};
var sprite = (g, c, r, rows, v) => {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "#") put(g, c + x, r + y, v);
      else if (row[x] === "+") put(g, c + x, r + y, v * 0.5);
    }
  });
};
var EYE_L = 6;
var EYE_R = 13;
var EYE_TOP = 5;
function eyes(g, f, h = 4, v = 1, dy = 0, lid = 0) {
  const dx = Math.round(f.lookX);
  const ly = Math.round(f.lookY) + dy;
  const open = Math.max(1, Math.round(h - (h - 1) * f.blink));
  const top = EYE_TOP + Math.floor((4 - h) / 2) + ly + Math.floor((h - open) / 2);
  for (const c of [EYE_L, EYE_R]) {
    if (lid > 0 && open > 1) {
      rect(g, c + dx, top, 3, 1, v * (1 - lid));
      rect(g, c + dx, top + 1, 3, open - 1, v);
    } else rect(g, c + dx, top, 3, open, v);
  }
}
var noise = (x) => {
  return 0.5 + 0.25 * Math.sin(x * 1.7) + 0.15 * Math.sin(x * 3.1 + 1.3) + 0.1 * Math.sin(x * 5.3 + 4.1);
};
var CARET = ["..#..", ".#.#.", "#...#"];
var CROSS = ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"];
var Z_BIG = ["####", "..#.", ".#..", "####"];
var Z_SMALL = ["###", ".#.", "###"];
var FACES = {
  idle(g, f) {
    eyes(g, f);
  },
  thinking(g, f) {
    eyes(g, { ...f, lookX: f.lookX + f.side * 1.4, lookY: f.lookY - 1.2 }, 3, 1, 0, 0.45);
    for (let i = 0; i < 3; i++) {
      const p = (f.time * 1.6 - i * 0.22) % 1;
      const pulse = p < 0.35 ? Math.sin(p / 0.35 * Math.PI) : 0;
      rect(g, 6 + i * 4, 11 - (pulse > 0.5 ? 1 : 0), 2, 2, 0.28 + 0.72 * pulse);
    }
  },
  searching(g, f) {
    eyes(g, f);
    const first = -g.ox, last2 = COLS - 1 + g.ox;
    const sweep = first + (Math.sin(f.time * 1.6 + 0.4) * 0.5 + 0.5) * (last2 - first);
    const dir = Math.cos(f.time * 1.6 + 0.4) > 0 ? -1 : 1;
    for (let k = 0; k < 5; k++) {
      const c = Math.round(sweep + dir * k);
      const v = 0.32 * (1 - k / 5);
      for (let r = -g.oy; r < ROWS + g.oy; r++) put(g, c, r, v);
    }
  },
  listening(g, f) {
    eyes(g, f, 4, 1, -1);
    for (let i = 0; i < 12; i++) {
      const centre = 1 - Math.abs(i - 5.5) / 7;
      const level = noise(f.time * 7 + i * 1.9 + f.seed * 10) * centre;
      const h = Math.max(1, Math.round(level * 4));
      for (let k = 0; k < h; k++) put(g, 5 + i, 12 - k, 0.75 - k * 0.12);
    }
  },
  speaking(g, f) {
    eyes(g, f, 4, 1, -1);
    const env = Math.max(0, Math.sin(f.time * 2.1) * 0.5 + Math.sin(f.time * 3.7 + 1) * 0.5);
    for (let i = 0; i < 8; i++) {
      const centre = 1 - Math.abs(i - 3.5) / 5;
      const a = noise(f.time * 11 + i * 0.9) * centre * (0.35 + env);
      const h = a > 0.55 ? 3 : a > 0.28 ? 2 : 1;
      const top = h === 3 ? 10 : 11;
      const rows = h === 3 ? 3 : h === 2 ? 2 : 1;
      rect(g, 7 + i, top, 1, rows, 1);
    }
  },
  working(g, f) {
    eyes(g, { ...f, lookY: f.lookY + 1 }, 2, 1, 0);
    const p = f.time / 2.6 % 1;
    const fill = Math.round(p * 12);
    for (let i = 0; i < 12; i++) put(g, 5 + i, 11, i < fill ? 0.95 : 0.16);
    put(g, 4, 11, 0.4);
    put(g, 17, 11, 0.4);
  },
  happy(g, f) {
    const hop = Math.round(Math.max(0, Math.sin(f.time * 5.6)) * -1);
    sprite(g, EYE_L - 1, EYE_TOP + hop, CARET, 1);
    sprite(g, EYE_R - 1, EYE_TOP + hop, CARET, 1);
    sprite(g, 7, 10 + hop, ["#......#", ".######."], 0.9);
  },
  error(g, f) {
    const on = Math.sin(f.time * 7) > -0.6 ? 1 : 0.55;
    sprite(g, EYE_L - 1, 4, CROSS, on);
    sprite(g, EYE_R - 1, 4, CROSS, on);
    for (let i = 0; i < 8; i++) put(g, 7 + i, i % 2 ? 11 : 12, 0.8);
  },
  sleeping(g, f) {
    for (const c of [EYE_L, EYE_R]) {
      put(g, c - 1, 7, 0.32);
      rect(g, c, 8, 3, 1, 0.42);
      put(g, c + 3, 7, 0.32);
    }
    for (const [delay, big] of [[0, true], [1.1, false]]) {
      const p = (f.time + delay) / 2.2 % 1;
      const v = Math.sin(p * Math.PI) * 0.6;
      const y = Math.round(5 - p * 5);
      const x = 16 + Math.round(p * 2);
      sprite(g, x, y, big ? Z_BIG : Z_SMALL, v);
    }
  }
};
var steady = (v) => () => v;
var LIGHTS = {
  idle: { screen: null, ball: [255, 250, 240], pulse: (t) => 0.75 + 0.1 * Math.sin(t * 1.4) },
  thinking: { screen: null, ball: [255, 184, 64], pulse: (t) => 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 4.2)) },
  searching: { screen: null, ball: [90, 220, 255], pulse: (t) => t * 2.4 % 1 < 0.18 ? 1 : 0.25 },
  listening: { screen: null, ball: [96, 255, 150], pulse: steady(0.95) },
  speaking: { screen: null, ball: [255, 250, 240], pulse: (t) => 0.55 + 0.45 * noise(t * 11) },
  working: { screen: null, ball: [110, 160, 255], pulse: (t) => t * 1.7 % 1 < 0.5 ? 1 : 0.35 },
  happy: { screen: null, ball: [255, 130, 200], pulse: (t) => 0.8 + 0.2 * Math.sin(t * 8) },
  error: { screen: [255, 70, 64], ball: [255, 60, 50], pulse: (t) => t * 3 % 1 < 0.5 ? 1 : 0.15 },
  sleeping: { screen: null, ball: [255, 250, 240], pulse: steady(0) }
};

// ../robot-heads/src/tv/geometry.ts
var HEAD = {
  /* radius of the rolled edge round the front and the back */
  bevel: 0.075,
  /* the shell's rim round the screen, then the rubber gasket */
  margin: 0.045,
  gasket: 0.022,
  /* how far the glass sits behind the face */
  recess: 0.03,
  earY: 0.03,
  /* the antenna: the stem's length and the ball's radius */
  stem: 0.2,
  ball: 0.052
};
var INSET = {
  plate: HEAD.bevel,
  hole: HEAD.bevel + HEAD.margin,
  glass: HEAD.bevel + HEAD.margin + HEAD.gasket
};
function rotation(yaw, pitch, roll) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const a = [cy, sy * sp, sy * cp, 0, cp, -sp, -sy, cy * sp, cy * cp];
  return [
    cr * a[0] - sr * a[3],
    cr * a[1] - sr * a[4],
    cr * a[2] - sr * a[5],
    sr * a[0] + cr * a[3],
    sr * a[1] + cr * a[4],
    sr * a[2] + cr * a[5],
    a[6],
    a[7],
    a[8]
  ];
}
function rotate(m, x, y, z) {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}
var norm = (x, y, z) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};
var TAU = Math.PI * 2;
function makeShape(name, centres, r, depth, screwAt, backScrewAt) {
  const pts = centres.map(([x, y]) => ({ x, y, t: Math.atan2(y, x) })).sort((a, b) => a.t - b.t);
  const n = pts.length;
  const edge = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    edge.push(Math.atan2(-(b.x - a.x), b.y - a.y));
  }
  const corners = pts.map((p, i) => {
    if (n === 1) return { x: p.x, y: p.y, a0: -Math.PI, a1: Math.PI };
    let a0 = edge[(i - 1 + n) % n];
    let a1 = edge[i];
    while (a1 < a0) a1 += TAU;
    return { x: p.x, y: p.y, a0, a1 };
  });
  const sdPoly = (x, y) => {
    if (n === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
    let d = Infinity;
    let inside = true;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ex = b.x - a.x, ey = b.y - a.y;
      const px = x - a.x, py = y - a.y;
      const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
      d = Math.min(d, Math.hypot(px - ex * t, py - ey * t));
      if (ex * py - ey * px < 0) inside = false;
    }
    return inside ? -d : d;
  };
  const sd = (x, y, inset) => sdPoly(x, y) - (r - inset);
  const path = (ctx, inset) => {
    const rr = Math.max(5e-4, r - inset);
    corners.forEach((c, i) => {
      if (i === 0) ctx.moveTo(c.x + rr * Math.cos(c.a0), c.y + rr * Math.sin(c.a0));
      ctx.arc(c.x, c.y, rr, c.a0, c.a1);
    });
    ctx.closePath();
  };
  let hx = 0, hy = 0;
  for (const p of pts) {
    hx = Math.max(hx, Math.abs(p.x) + r);
    hy = Math.max(hy, Math.abs(p.y) + r);
  }
  let lo = 0, hi = hx + 0.1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sd(mid, HEAD.earY, 0) < 0) lo = mid;
    else hi = mid;
  }
  const place = (dirs, inward) => dirs.map((d, i) => {
    const a = d * Math.PI / 180;
    const c = corners.find((k) => [a, a + TAU, a - TAU].some((x) => x >= k.a0 - 1e-6 && x <= k.a1 + 1e-6)) ?? corners[0];
    return [c.x + Math.cos(a) * (r - inward), c.y + Math.sin(a) * (r - inward), 0.5 + i * 0.9];
  });
  const gw = 2 * (hx - INSET.glass), gh = 2 * (hy - INSET.glass);
  const pitch = Math.min(FACE_SHARE * gw / 14, 0.65 * gh / 10);
  return {
    name,
    r,
    depth,
    corners,
    hx,
    hy,
    pitch,
    earX: lo - 8e-3,
    /* on the face: halfway between the lip round the hole and the rolled edge */
    screws: place(screwAt, (INSET.hole - 0.018 + INSET.plate) / 2),
    /* on the back: inside the panel line */
    backScrews: place(backScrewAt, INSET.plate + 0.07),
    sd,
    path
  };
}
var hexCentres = (a) => [0, 60, 120, 180, 240, 300].map((d) => [a * Math.cos(d * Math.PI / 180), a * Math.sin(d * Math.PI / 180)]);
var FACE_SHARE = 0.6;
var CORNERS = [45, 135];
var BACK_CORNERS = [-135, -45, 45, 135];
var SHAPES = {
  rectangle: () => makeShape("rectangle", [[-0.29, -0.17], [0.29, -0.17], [0.29, 0.17], [-0.29, 0.17]], 0.21, 0.6, CORNERS, BACK_CORNERS),
  square: () => makeShape("square", [[-0.22, -0.22], [0.22, -0.22], [0.22, 0.22], [-0.22, 0.22]], 0.2, 0.6, CORNERS, BACK_CORNERS),
  circle: () => makeShape("circle", [[0, 0]], 0.46, 0.56, CORNERS, BACK_CORNERS),
  hexagon: () => makeShape("hexagon", hexCentres(0.35), 0.16, 0.58, [60, 120], [-120, -60, 60, 120])
};
var shapeCache = /* @__PURE__ */ new Map();
function getShape(name) {
  let s = shapeCache.get(name);
  if (!s) {
    s = (SHAPES[name] ?? SHAPES.rectangle)();
    shapeCache.set(name, s);
  }
  return s;
}
function finish(pos, quads, vn) {
  const normals = new Float32Array(quads.length / 4 * 3);
  for (let q = 0; q < quads.length / 4; q++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const i = quads[q * 4 + k] * 3;
      x += vn[i];
      y += vn[i + 1];
      z += vn[i + 2];
    }
    normals.set(norm(x, y, z), q * 3);
  }
  return { pos: new Float32Array(pos), quads: new Uint16Array(quads), normals };
}
function stitch(rings, samples, closed = true) {
  const quads = [];
  const span = closed ? samples : samples - 1;
  for (let k = 0; k < rings - 1; k++) {
    for (let j = 0; j < span; j++) {
      const j2 = (j + 1) % samples;
      quads.push(k * samples + j, k * samples + j2, (k + 1) * samples + j2, (k + 1) * samples + j);
    }
  }
  return quads;
}
function buildBody(shape, bevelSteps = 10) {
  const R = shape.r, b = HEAD.bevel, zf = shape.depth / 2;
  const outline = [];
  for (const c of shape.corners) {
    const sweep = c.a1 - c.a0;
    const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 2) * 14));
    const last2 = sweep >= TAU - 1e-6 ? steps - 1 : steps;
    for (let i = 0; i <= last2; i++) {
      const a = c.a0 + i / steps * sweep;
      outline.push([c.x, c.y, Math.cos(a), Math.sin(a)]);
    }
  }
  const profile = [];
  for (let i = bevelSteps; i >= 0; i--) {
    const t = i / bevelSteps * (Math.PI / 2);
    profile.push([-zf + b - b * Math.sin(t), b * (1 - Math.cos(t)), -t]);
  }
  for (let i = 0; i <= bevelSteps; i++) {
    const t = i / bevelSteps * (Math.PI / 2);
    profile.push([zf - b + b * Math.sin(t), b * (1 - Math.cos(t)), t]);
  }
  const pos = [], vn = [];
  for (const [z, inset, t] of profile) {
    for (const [cx, cy, nx, ny] of outline) {
      pos.push(cx + (R - inset) * nx, cy + (R - inset) * ny, z);
      vn.push(nx * Math.cos(t), ny * Math.cos(t), Math.sin(t));
    }
  }
  return finish(pos, stitch(profile.length, outline.length), vn);
}
function buildLathe(profile, origin, axis, segments = 36) {
  const e1 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e2 = norm(axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]);
  const pos = [], vn = [];
  for (let k = 0; k < profile.length; k++) {
    const [r, t] = profile[k];
    const prev = profile[Math.max(0, k - 1)], next = profile[Math.min(profile.length - 1, k + 1)];
    const dr = next[0] - prev[0], dt = next[1] - prev[1];
    const l = Math.hypot(dr, dt) || 1;
    const nr = dt / l, na = -dr / l;
    for (let j = 0; j < segments; j++) {
      const a = j / segments * TAU;
      const rx = Math.cos(a) * e1[0] + Math.sin(a) * e2[0];
      const ry = Math.cos(a) * e1[1] + Math.sin(a) * e2[1];
      const rz = Math.cos(a) * e1[2] + Math.sin(a) * e2[2];
      pos.push(origin[0] + axis[0] * t + r * rx, origin[1] + axis[1] * t + r * ry, origin[2] + axis[2] * t + r * rz);
      vn.push(rx * nr + axis[0] * na, ry * nr + axis[1] * na, rz * nr + axis[2] * na);
    }
  }
  return finish(pos, stitch(profile.length, segments), vn);
}
var EAR_PROFILE = [
  [0.06, -0.012],
  [0.068, 0],
  [0.074, 6e-3],
  [0.08, 0.018],
  [0.084, 0.032],
  [0.084, 0.048],
  [0.079, 0.06],
  [0.068, 0.07],
  [0.052, 0.077],
  [0.032, 0.081],
  [0.014, 0.083],
  [0, 0.0835]
];
var COLLAR_PROFILE = [
  [0.05, -0.012],
  [0.052, 6e-3],
  [0.05, 0.016],
  [0.042, 0.024],
  [0.026, 0.029],
  [0.014, 0.031],
  [0, 0.032]
];
var meshCache = /* @__PURE__ */ new Map();
function headMeshes(shape) {
  let m = meshCache.get(shape.name);
  if (!m) {
    m = {
      body: buildBody(shape),
      earL: buildLathe(EAR_PROFILE, [-shape.earX, HEAD.earY, 0], [-1, 0, 0]),
      earR: buildLathe(EAR_PROFILE, [shape.earX, HEAD.earY, 0], [1, 0, 0]),
      collar: buildLathe(COLLAR_PROFILE, [0, -shape.hy, 0], [0, -1, 0], 16)
    };
    meshCache.set(shape.name, m);
  }
  return m;
}

// ../robot-heads/src/tv/light.ts
var n3 = (x, y, z) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
var KEY = n3(-0.5, -0.78, 0.62);
var FILL = n3(0.85, 0.15, 0.5);
var BACK = n3(0.55, -0.55, -0.62);
var HALF = n3(KEY[0], KEY[1], KEY[2] + 1);
var smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function environment(rx, ry, rz) {
  const up = -ry;
  const horizon = 0.05 + 0.12 * smooth(-0.25, 0.3, up);
  const softbox = 1.1 * smooth(0.42, 0.78, up) * smooth(-0.9, -0.2, rz - 0.6 * Math.abs(rx));
  const window2 = 2.6 * smooth(0.86, 0.97, rx * KEY[0] + ry * KEY[1] + rz * KEY[2]);
  const strip = 0.5 * smooth(0.6, 0.85, -rx) * smooth(-0.35, 0.05, up) * (1 - smooth(0.2, 0.5, up));
  return horizon + softbox + window2 + strip;
}
var toLinear = (c) => Math.pow(c / 255, 2.2);
function linear(rgb) {
  return [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
}
function display(x) {
  const t = x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14);
  return Math.round(255 * Math.pow(Math.min(1, Math.max(0, t)), 1 / 2.2));
}
function radiance(m, nx, ny, nz, out = [0, 0, 0]) {
  const ndl = nx * KEY[0] + ny * KEY[1] + nz * KEY[2];
  const key = Math.max(0, (ndl + 0.12) / 1.12);
  const fill = Math.max(0, nx * FILL[0] + ny * FILL[1] + nz * FILL[2]);
  const sky = 0.5 - 0.5 * ny;
  const ndv = Math.max(0, nz);
  const fres = m.f0 + (1 - m.f0) * Math.pow(1 - ndv, 5);
  const rx = 2 * ndv * nx, ry = 2 * ndv * ny, rz = 2 * ndv * nz - 1;
  const env = environment(rx, ry, rz) * fres;
  const spec = m.spec * Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), m.shininess);
  const back = Math.max(0, nx * BACK[0] + ny * BACK[1] + nz * BACK[2]);
  const rim = m.rim * back * back * Math.pow(1 - ndv, 1.6);
  const diffuse = 0.05 + 0.1 * sky + 1.25 * key + 0.16 * fill;
  for (let i = 0; i < 3; i++) {
    const a = m.albedo[i];
    const tint = 1 - m.metal + m.metal * a * 2.2;
    const rimTint = i === 0 ? 0.62 : i === 1 ? 0.78 : 1;
    out[i] = a * diffuse * (1 - fres * 0.6) + (env + spec) * tint + rim * rimTint * (0.35 + a);
  }
  return out;
}
function css(c, alpha = 1) {
  return alpha >= 1 ? `rgb(${display(c[0])},${display(c[1])},${display(c[2])})` : `rgba(${display(c[0])},${display(c[1])},${display(c[2])},${alpha})`;
}
function shadeCss(m, nx, ny, nz) {
  return css(radiance(m, nx, ny, nz));
}

// ../robot-heads/src/tv/render.ts
var makeCanvas = (w, h) => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
};
var smooth2 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
var hash = (x, y) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
};
var HALF2 = (() => {
  const l = Math.hypot(KEY[0], KEY[1], KEY[2] + 1);
  return [KEY[0] / l, KEY[1] / l, (KEY[2] + 1) / l];
})();
var HEAD_TRAVEL = { antenna: 0.028 + HEAD.stem + HEAD.ball * 1.8, knob: 0.035, ear: 0.105, glow: 0.18, hop: 0.3, overshoot: 0.13, shadow: 0.22, side: 0.12 };
var BOX_INSET = 0.05;
function frameFor(shape, antenna, box) {
  const top = antenna ? HEAD_TRAVEL.antenna : HEAD_TRAVEL.knob;
  const tall = 2 * shape.hy + top;
  const wide = 2 * (shape.earX + HEAD_TRAVEL.ear);
  const inner = box * (1 - 2 * BOX_INSET);
  const unit = Math.min(inner / tall, inner / wide);
  const above = (box - tall * unit) / 2;
  const centreY = above + (shape.hy + top) * unit;
  const reachUp = (antenna ? HEAD_TRAVEL.glow + HEAD_TRAVEL.hop : HEAD_TRAVEL.hop + HEAD_TRAVEL.overshoot) * unit;
  const reachDown = centreY + (shape.hy + HEAD_TRAVEL.shadow) * unit;
  const reachSide = box / 2 + (shape.earX + HEAD_TRAVEL.ear + HEAD_TRAVEL.side) * unit;
  const padTop = Math.ceil(Math.max(0, reachUp - above) + 1);
  const padBottom = Math.ceil(Math.max(0, reachDown - box) + 1);
  const padSide = Math.ceil(Math.max(0, reachSide - box) + 1);
  return { box, padTop, padBottom, padSide, unit, cx: padSide + box / 2, cy: padTop + centreY };
}
var SCREEN_OVER = 0.035;
var glassOf = (s) => ({ hx: s.hx - INSET.glass, hy: s.hy - INSET.glass });
function screenOf(s) {
  const g = glassOf(s);
  return {
    hx: Math.max(g.hx, COLS / 2 * s.pitch) + SCREEN_OVER,
    hy: Math.max(g.hy, ROWS / 2 * s.pitch) + SCREEN_OVER
  };
}
var plateOf = (s) => ({ hx: s.hx - INSET.plate, hy: s.hy - INSET.plate });
function bakeRelief(shape, unit, fn) {
  const PLATE = plateOf(shape);
  const w = Math.ceil(PLATE.hx * 2 * unit), h = Math.ceil(PLATE.hy * 2 * unit);
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(c.width, c.height);
  const d = img.data;
  const px = PLATE.hx * 2 / c.width;
  for (let iy = 0; iy < c.height; iy++) {
    const v = -PLATE.hy + (iy + 0.5) * px;
    for (let ix = 0; ix < c.width; ix++) {
      const u = -PLATE.hx + (ix + 0.5) * px;
      const edge = shape.sd(u, v, INSET.plate);
      const cover = Math.min(1, Math.max(0, 0.5 - edge / px));
      if (cover <= 0) continue;
      const val = fn(u, v, px, ix, iy);
      const i = (iy * c.width + ix) * 4;
      const a = Math.min(1, Math.abs(val)) * cover;
      const white = val > 0 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = white;
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function tilt(nx, ny, nz, gloss = 0.55, power = 36) {
  const l = Math.hypot(nx, ny, nz);
  nx /= l;
  ny /= l;
  nz /= l;
  const diff = (nx * KEY[0] + ny * KEY[1] + nz * KEY[2] - KEY[2]) * 0.95;
  const spec = gloss * Math.pow(Math.max(0, nx * HALF2[0] + ny * HALF2[1] + nz * HALF2[2]), power);
  return diff + spec - gloss * Math.pow(HALF2[2], power);
}
function grad(fn, u, v) {
  const e = 15e-4;
  const gx = fn(u + e, v) - fn(u - e, v);
  const gy = fn(u, v + e) - fn(u, v - e);
  const l = Math.hypot(gx, gy) || 1;
  return [gx / l, gy / l];
}
function screw(u, v, cx, cy, angle) {
  const rs = 0.013;
  const dx = u - cx, dy = v - cy;
  const d = Math.hypot(dx, dy);
  if (d > rs + 6e-3) return null;
  if (d > rs) return -0.5 * (1 - (d - rs) / 6e-3);
  const nz = Math.sqrt(Math.max(0, 1 - (d / rs) ** 2)) + 0.6;
  let val = tilt(dx / rs, dy / rs, nz, 0.9, 30) * 1.3 + 0.08;
  const c = Math.cos(angle), s = Math.sin(angle);
  const across = Math.abs(dx * -s + dy * c);
  if (across < 26e-4 && d < rs * 0.8) val = -0.65;
  return val;
}
function bakeFront(shape, unit) {
  const LIP = 0.018;
  const sdHole = (u, v) => shape.sd(u, v, INSET.hole);
  const sdGlass = (u, v) => shape.sd(u, v, INSET.glass);
  const screws = shape.screws;
  return bakeRelief(shape, unit, (u, v, _px, ix, iy) => {
    const grain = (hash(ix, iy) - 0.5) * 0.07;
    for (const [cx, cy, a] of screws) {
      const s = screw(u, v, cx, cy, a);
      if (s !== null) return s;
    }
    const dh = sdHole(u, v);
    if (dh >= 0) {
      if (dh < LIP) {
        const [gx, gy] = grad(sdHole, u, v);
        const s = 1 - dh / LIP;
        const th = s * s * 1.25;
        return tilt(-gx * Math.sin(th), -gy * Math.sin(th), Math.cos(th)) + grain;
      }
      return grain;
    }
    const dg = sdGlass(u, v);
    if (dg >= 0) {
      const s = dg / HEAD.gasket;
      const [gx, gy] = grad(sdGlass, u, v);
      const th = (s - 0.45) * 2.2;
      return tilt(gx * Math.sin(th), gy * Math.sin(th), Math.cos(th), 0.22, 14) * 0.7 + grain * 0.4;
    }
    const k = 0.05;
    const blocked = smooth2(-0.012, 0.012, sdGlass(u - KEY[0] * k, v - KEY[1] * k));
    return -(0.5 * blocked + 0.32 * Math.exp(dg / 0.014));
  });
}
function bakeBack(shape, unit) {
  const vents = [-0.12, -0.065, -0.01, 0.045, 0.1];
  const panel = (u, v) => shape.sd(u, v, INSET.plate + 0.04);
  const screws = shape.backScrews;
  return bakeRelief(shape, unit, (u, v, _px, ix, iy) => {
    const grain = (hash(ix, iy) - 0.5) * 0.07;
    for (const [cx, cy, a] of screws) {
      const s = screw(u, v, cx, cy, a);
      if (s !== null) return s;
    }
    const dp = panel(u, v);
    if (Math.abs(dp) < 6e-3) {
      const [gx, gy] = grad(panel, u, v);
      const th = dp / 6e-3 * 1.1;
      return tilt(-gx * Math.sin(th), -gy * Math.sin(th), Math.cos(th)) * 0.9 - 0.18;
    }
    for (const vy of vents) {
      const slot = (a, b) => Math.hypot(Math.max(0, Math.abs(a) - 0.196), b - vy) - 0.014;
      const d = slot(u, v);
      if (d < 0) {
        return -0.72 - 0.15 * smooth2(-0.014, 0, -(v - vy));
      }
      if (d < 0.01) {
        const [gx, gy] = grad(slot, u, v);
        const th = (1 - d / 0.01) ** 2 * 1.2;
        return tilt(-gx * Math.sin(th), -gy * Math.sin(th), Math.cos(th)) + grain;
      }
    }
    return grain;
  });
}
function bakeScreenBase(w, h, pitch, x0, y0, led) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.65);
  g.addColorStop(0, "#111417");
  g.addColorStop(1, "#050607");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const cell = pitch * 0.8;
  const off = (pitch - cell) / 2;
  const lens = `rgba(${Math.round(60 + led[0] * 0.12)},${Math.round(64 + led[1] * 0.12)},${Math.round(70 + led[2] * 0.12)},0.34)`;
  const c0 = -Math.ceil(x0 / pitch), c1 = Math.ceil((w - x0) / pitch);
  const r0 = -Math.ceil(y0 / pitch), r1 = Math.ceil((h - y0) / pitch);
  ctx.fillStyle = lens;
  for (let r = r0; r < r1; r++) for (let q = c0; q < c1; q++) ctx.fillRect(x0 + q * pitch + off, y0 + r * pitch + off, cell, cell);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  for (let r = r0; r < r1; r++) for (let q = c0; q < c1; q++) ctx.fillRect(x0 + q * pitch + off, y0 + r * pitch + off, cell, Math.max(1, cell * 0.16));
  return c;
}
function bakeGlass(w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.55);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.5)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
  const top = ctx.createLinearGradient(0, 0, 0, h);
  top.addColorStop(0, "rgba(190,210,255,0.09)");
  top.addColorStop(0.42, "rgba(190,210,255,0.015)");
  top.addColorStop(0.43, "rgba(190,210,255,0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w * 0.3, h * 0.2);
  ctx.scale(1, 0.45);
  const spot = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.35);
  spot.addColorStop(0, "rgba(255,255,255,0.07)");
  spot.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = spot;
  ctx.fillRect(-w, -h * 3, w * 2, h * 6);
  ctx.restore();
  return c;
}
function grainPattern(ctx) {
  const c = makeCanvas(128, 128);
  const g = c.getContext("2d");
  const img = g.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) {
    const r = hash(i, 7);
    const on = r > 0.5 ? 255 : 0;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = on;
    img.data[i * 4 + 3] = Math.round(hash(i, 13) * 9);
  }
  g.putImageData(img, 0, 0);
  return ctx.createPattern(c, "repeat");
}
var bakes = /* @__PURE__ */ new Map();
function bakesFor(shape, unit) {
  const key = `${shape.name}:${Math.round(unit)}`;
  let b = bakes.get(key);
  if (!b) {
    const sc = screenOf(shape);
    b = { front: bakeFront(shape, unit), back: bakeBack(shape, unit), glass: bakeGlass(sc.hx * 2 * unit, sc.hy * 2 * unit) };
    bakes.set(key, b);
  }
  return b;
}
var mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
var RobotRenderer = class {
  constructor() {
    this.shape = null;
    this.meshes = null;
    this.unit = 0;
    this.ledKey = "";
    this.front = null;
    this.back = null;
    this.screen = null;
    this.screenBase = null;
    this.glass = null;
    this.layer = null;
    this.tiny = makeCanvas(COLS, ROWS);
    this.tinyHalf = makeCanvas(COLS / 2, ROWS / 2);
    this.tinyImg = null;
    this.grain = null;
    this.grid = makeGrid(COLS, ROWS);
    this.gridPrev = makeGrid(COLS, ROWS);
    this.proj = new Float32Array(2048 * 3);
    this.screenGeo = { pitch: 0, x0: 0, y0: 0 };
  }
  prepare(shape, unit, led) {
    if (Math.abs(unit - this.unit) > 0.5 || shape !== this.shape) {
      this.unit = unit;
      this.shape = shape;
      this.meshes = headMeshes(shape);
      const b = bakesFor(shape, unit);
      this.front = b.front;
      this.back = b.back;
      this.glass = b.glass;
      const sc = screenOf(shape);
      this.screen = makeCanvas(sc.hx * 2 * unit, sc.hy * 2 * unit);
      this.ledKey = "";
      const gl = glassOf(shape);
      this.grid = makeGrid(Math.ceil(gl.hx * 2 / shape.pitch), Math.ceil(gl.hy * 2 / shape.pitch));
      this.gridPrev = makeGrid(this.grid.cols, this.grid.rows);
      this.tiny = makeCanvas(this.grid.cols, this.grid.rows);
      this.tinyHalf = makeCanvas(Math.ceil(this.grid.cols / 2), Math.ceil(this.grid.rows / 2));
      this.tinyImg = null;
      const pitch = shape.pitch * unit;
      this.screenGeo = {
        pitch,
        x0: (this.screen.width - pitch * this.grid.cols) / 2,
        y0: (this.screen.height - pitch * this.grid.rows) / 2
      };
    }
    const key = led.join(",");
    if (key !== this.ledKey && this.screen) {
      this.ledKey = key;
      const { pitch, x0, y0 } = this.screenGeo;
      this.screenBase = bakeScreenBase(this.screen.width, this.screen.height, pitch, x0, y0, led);
    }
  }
  /* the LED matrix for this frame */
  compose(sim, state) {
    const grid = this.grid;
    const g = grid.v;
    const { cols, rows } = grid;
    g.fill(0);
    if (!sim) {
      FACES[state](grid, { lookX: 0, lookY: 0, blink: 0, time: 0.4, side: 1, seed: 0 });
      return grid;
    }
    FACES[sim.shown](grid, sim.face);
    if (sim.switched < 0.3) {
      const p = this.gridPrev;
      p.v.fill(0);
      FACES[sim.previous](p, { ...sim.face, time: sim.face.time + 10 });
      const k = sim.switched / 0.3;
      for (let i = 0; i < g.length; i++) g[i] = g[i] * k + p.v[i] * (1 - k);
      if (sim.switched < 0.13) {
        const seed = Math.floor(sim.time * 30);
        for (let r = 0; r < rows; r++) {
          const shift = Math.floor((Math.sin(seed * 12.9 + r * 78.2) * 0.5 + 0.5) * 3) - 1;
          if (!shift) continue;
          const row = g.slice(r * cols, (r + 1) * cols);
          for (let c = 0; c < cols; c++) g[r * cols + c] = row[(c - shift + cols) % cols];
        }
        for (let i = 0; i < g.length; i++) if (Math.sin(i * 91.7 + seed * 3.1) > 0.93) g[i] = Math.max(g[i], 0.3);
      }
    }
    if (sim.age < 0.55) {
      const open = smooth2(0.08, 0.5, sim.age) * (rows / 2 + 0.5);
      for (let r = 0; r < rows; r++) {
        const d = Math.abs(r - (rows - 1) / 2);
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          if (d > open) g[i] = 0;
          else if (d > open - 1.2) g[i] = Math.max(g[i], 0.85 * (1 - sim.age / 0.55));
        }
      }
    }
    return grid;
  }
  drawScreen(grid, led) {
    const s = this.screen;
    const ctx = s.getContext("2d");
    const { cols, rows, v: g } = grid;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.screenBase, 0, 0);
    const { pitch, x0, y0 } = this.screenGeo;
    const core = mix(led, [255, 255, 255], 0.6);
    const coreCss = `rgb(${core.map(Math.round).join(",")})`;
    const bleedCss = `rgb(${led.map(Math.round).join(",")})`;
    const cell = pitch * 0.8, off = (pitch - cell) / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = g[r * cols + c];
        if (v < 0.01) continue;
        ctx.globalAlpha = Math.min(1, v * 0.4);
        ctx.fillStyle = bleedCss;
        ctx.fillRect(x0 + c * pitch + off * 0.4, y0 + r * pitch + off * 0.4, pitch - off * 0.8, pitch - off * 0.8);
        ctx.globalAlpha = Math.min(1, v);
        ctx.fillStyle = coreCss;
        ctx.fillRect(x0 + c * pitch + off, y0 + r * pitch + off, cell, cell);
      }
    }
    const t = this.tiny.getContext("2d");
    if (!this.tinyImg) this.tinyImg = t.createImageData(cols, rows);
    const d = this.tinyImg.data;
    for (let i = 0; i < cols * rows; i++) {
      d[i * 4] = led[0];
      d[i * 4 + 1] = led[1];
      d[i * 4 + 2] = led[2];
      d[i * 4 + 3] = Math.round(Math.min(1, g[i]) * 255);
    }
    t.putImageData(this.tinyImg, 0, 0);
    const h = this.tinyHalf.getContext("2d");
    h.clearRect(0, 0, this.tinyHalf.width, this.tinyHalf.height);
    h.imageSmoothingEnabled = true;
    h.drawImage(this.tiny, 0, 0, this.tinyHalf.width, this.tinyHalf.height);
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.7;
    ctx.drawImage(this.tiny, x0, y0, cols * pitch, rows * pitch);
    ctx.globalAlpha = 0.65;
    ctx.drawImage(this.tinyHalf, x0 - pitch, y0 - pitch, (cols + 2) * pitch, (rows + 2) * pitch);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(this.glass, 0, 0);
  }
  /** Draw a frame; `frame` is in CSS px, the canvas in device px (`dpr` per CSS px). */
  draw(ctx, frame2, dpr, pose, sim, state, shape, palette, opts) {
    const U = frame2.unit * dpr;
    const PLATE = plateOf(shape);
    const GLASS = glassOf(shape);
    const SCREEN = screenOf(shape);
    const shown = sim ? sim.shown : state;
    const lightNow = LIGHTS[shown];
    let led = lightNow.screen ?? palette.led;
    if (sim && sim.switched < 0.3) {
      const was = LIGHTS[sim.previous].screen ?? palette.led;
      led = mix(was, led, sim.switched / 0.3).map(Math.round);
    }
    this.prepare(shape, U, led);
    if (!this.layer || this.layer.width !== ctx.canvas.width || this.layer.height !== ctx.canvas.height) {
      this.layer = makeCanvas(ctx.canvas.width, ctx.canvas.height);
      this.grain = grainPattern(ctx);
    }
    const layer = this.layer.getContext("2d");
    const R = rotation(pose.yaw, pose.pitch, pose.roll);
    const cx = frame2.cx * dpr + pose.x * U;
    const rest = frame2.cy * dpr;
    const cy = rest - pose.lift * U;
    const by = cy + shape.hy * U;
    const P = (x, y, z) => {
      const r = rotate(R, x, y, z);
      return [cx + r[0] * U * pose.sx, by + (cy + r[1] * U - by) * pose.sy, r[2]];
    };
    const plane = (c, z, flip) => {
      const o = P(0, 0, z), ex = P(flip ? -1 : 1, 0, z), ey = P(0, 1, z);
      c.setTransform(ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]);
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (opts.floorShadow) {
      const up = Math.max(0, pose.lift);
      const fy = rest + (shape.hy + 0.11) * U;
      const rx = U * shape.hx * (1 - up * 0.9) * pose.sx;
      ctx.save();
      ctx.translate(frame2.cx * dpr + pose.x * U, fy);
      ctx.scale(1, 0.16);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      const a = 0.55 * Math.max(0, 1 - up * 1.6);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(0.55, `rgba(0,0,0,${a * 0.45})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    const { body, earL, earR, collar } = this.meshes;
    const earLz = rotate(R, -shape.earX - 0.05, HEAD.earY, 0)[2];
    const earRz = rotate(R, shape.earX + 0.05, HEAD.earY, 0)[2];
    const topZ = rotate(R, 0, -shape.hy, 0)[2];
    const antennaBehind = topZ < -0.012;
    const drawMesh = (c, mesh, mat) => {
      const n = mesh.pos.length / 3;
      const pr = this.proj;
      for (let i = 0; i < n; i++) {
        const p = P(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]);
        pr[i * 3] = p[0];
        pr[i * 3 + 1] = p[1];
        pr[i * 3 + 2] = p[2];
      }
      const order = [];
      const q = mesh.quads, nn = mesh.normals;
      for (let k = 0; k < q.length / 4; k++) {
        const nz = R[6] * nn[k * 3] + R[7] * nn[k * 3 + 1] + R[8] * nn[k * 3 + 2];
        if (nz < -0.03) continue;
        const z = pr[q[k * 4] * 3 + 2] + pr[q[k * 4 + 1] * 3 + 2] + pr[q[k * 4 + 2] * 3 + 2] + pr[q[k * 4 + 3] * 3 + 2];
        order.push([z, k]);
      }
      order.sort((a, b) => a[0] - b[0]);
      c.lineWidth = Math.max(0.6, U / 260);
      c.lineJoin = "round";
      for (const [, k] of order) {
        const nx = nn[k * 3], ny = nn[k * 3 + 1], nz0 = nn[k * 3 + 2];
        const w = rotate(R, nx, ny, nz0);
        const col = shadeCss(mat, w[0], w[1], w[2]);
        c.beginPath();
        for (let j = 0; j < 4; j++) {
          const vi = q[k * 4 + j] * 3;
          if (j) c.lineTo(pr[vi], pr[vi + 1]);
          else c.moveTo(pr[vi], pr[vi + 1]);
        }
        c.closePath();
        c.fillStyle = col;
        c.strokeStyle = col;
        c.fill();
        c.stroke();
      }
    };
    const antenna = () => this.drawAntenna(ctx, P, U, pose, palette, sim, shown, lightNow, collar, opts.antenna);
    if (antennaBehind) antenna();
    if (earLz < 0) drawMesh(ctx, earL, palette.trim);
    if (earRz < 0) drawMesh(ctx, earR, palette.trim);
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, this.layer.width, this.layer.height);
    drawMesh(layer, body, palette.shell);
    const frontZ = R[8];
    const zf = shape.depth / 2;
    const facing = Math.abs(frontZ) > 5e-3 ? frontZ > 0 ? 1 : -1 : 0;
    if (facing) {
      const dome = 0.17;
      plane(layer, facing * zf, facing < 0);
      const at = (dx, dy) => {
        const w = rotate(R, dx * (facing < 0 ? -1 : 1), dy, facing);
        const l = Math.hypot(w[0], w[1], w[2]);
        return css(radiance(palette.shell, w[0] / l, w[1] / l, w[2] / l));
      };
      layer.beginPath();
      shape.path(layer, INSET.plate - 2e-3);
      const vg = layer.createLinearGradient(0, -PLATE.hy, 0, PLATE.hy);
      vg.addColorStop(0, at(0, -dome));
      vg.addColorStop(0.5, at(0, 0));
      vg.addColorStop(1, at(0, dome));
      layer.fillStyle = vg;
      layer.fill();
      const hg = layer.createLinearGradient(-PLATE.hx, 0, PLATE.hx, 0);
      hg.addColorStop(0, at(-dome, 0));
      hg.addColorStop(0.5, at(0, 0));
      hg.addColorStop(1, at(dome, 0));
      layer.globalAlpha = 0.5;
      layer.fillStyle = hg;
      layer.fill();
      layer.globalAlpha = 1;
    }
    if (this.grain) {
      layer.setTransform(1, 0, 0, 1, 0, 0);
      layer.globalCompositeOperation = "source-atop";
      const m = typeof DOMMatrix === "function" ? new DOMMatrix().translate(cx, cy) : null;
      if (m && "setTransform" in this.grain) this.grain.setTransform(m);
      layer.fillStyle = this.grain;
      layer.fillRect(0, 0, this.layer.width, this.layer.height);
      layer.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(this.layer, 0, 0);
    if (facing > 0) {
      ctx.save();
      plane(ctx, zf, false);
      ctx.beginPath();
      shape.path(ctx, INSET.hole);
      ctx.fillStyle = "#060709";
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      shape.path(ctx, INSET.glass);
      ctx.clip();
      this.drawScreen(this.compose(sim, state), led);
      plane(ctx, zf - HEAD.recess, false);
      ctx.drawImage(this.screen, -SCREEN.hx, -SCREEN.hy, SCREEN.hx * 2, SCREEN.hy * 2);
      plane(ctx, zf, false);
      const s = -0.05 - pose.yaw * 0.9 + pose.pitch * 0.5;
      const sg = ctx.createLinearGradient(-0.55 + s, -0.35, 0.15 + s, 0.35);
      sg.addColorStop(0, "rgba(255,255,255,0)");
      sg.addColorStop(0.36, "rgba(255,255,255,0)");
      sg.addColorStop(0.43, "rgba(220,232,255,0.075)");
      sg.addColorStop(0.5, "rgba(255,255,255,0)");
      sg.addColorStop(0.58, "rgba(255,255,255,0)");
      sg.addColorStop(0.61, "rgba(220,232,255,0.04)");
      sg.addColorStop(0.65, "rgba(255,255,255,0)");
      ctx.fillStyle = sg;
      ctx.fillRect(-GLASS.hx, -GLASS.hy, GLASS.hx * 2, GLASS.hy * 2);
      ctx.restore();
      ctx.drawImage(this.front, -PLATE.hx, -PLATE.hy, PLATE.hx * 2, PLATE.hy * 2);
      ctx.restore();
    } else if (facing < 0) {
      ctx.save();
      plane(ctx, -zf, true);
      ctx.drawImage(this.back, -PLATE.hx, -PLATE.hy, PLATE.hx * 2, PLATE.hy * 2);
      ctx.restore();
    }
    if (earLz >= 0) drawMesh(ctx, earL, palette.trim);
    if (earRz >= 0) drawMesh(ctx, earR, palette.trim);
    if (!antennaBehind) antenna();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  drawAntenna(ctx, P, U, pose, palette, sim, shown, lightNow, collar, stem) {
    const R = rotation(pose.yaw, pose.pitch, pose.roll);
    const pr = this.proj;
    const n = collar.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const p = P(collar.pos[i * 3], collar.pos[i * 3 + 1], collar.pos[i * 3 + 2]);
      pr[i * 3] = p[0];
      pr[i * 3 + 1] = p[1];
      pr[i * 3 + 2] = p[2];
    }
    const q = collar.quads, nn = collar.normals;
    ctx.lineWidth = Math.max(0.6, U / 260);
    for (let k = 0; k < q.length / 4; k++) {
      const w = rotate(R, nn[k * 3], nn[k * 3 + 1], nn[k * 3 + 2]);
      if (w[2] < -0.03) continue;
      const col = shadeCss(palette.trim, w[0], w[1], w[2]);
      ctx.beginPath();
      for (let j = 0; j < 4; j++) {
        const vi = q[k * 4 + j] * 3;
        if (j) ctx.lineTo(pr[vi], pr[vi + 1]);
        else ctx.moveTo(pr[vi], pr[vi + 1]);
      }
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.fill();
      ctx.stroke();
    }
    if (!stem) return;
    const top = -this.shape.hy - 0.028;
    const L = HEAD.stem;
    const ax = pose.antennaX, az = pose.antennaZ;
    const dir = [Math.sin(ax), -Math.cos(ax) * Math.cos(az), Math.sin(az)];
    const base = P(0, top, 0);
    const ctrl = P(0, top - L * 0.55, 0);
    const tip = P(dir[0] * L, top + dir[1] * L, dir[2] * L);
    const ballC = P(dir[0] * (L + HEAD.ball * 0.8), top + dir[1] * (L + HEAD.ball * 0.8), dir[2] * (L + HEAD.ball * 0.8));
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(base[0], base[1]);
    ctx.quadraticCurveTo(ctrl[0], ctrl[1], tip[0], tip[1]);
    ctx.lineWidth = U * 0.02;
    ctx.strokeStyle = "#4a5260";
    ctx.stroke();
    ctx.lineWidth = U * 9e-3;
    ctx.strokeStyle = "#9aa3b1";
    ctx.stroke();
    ctx.save();
    ctx.translate(-U * 4e-3, 0);
    ctx.lineWidth = U * 4e-3;
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.stroke();
    ctx.restore();
    let colour = lightNow.ball;
    let level = lightNow.pulse(sim ? sim.face.time : 0.3);
    if (sim && sim.switched < 0.3) {
      const was = LIGHTS[sim.previous];
      const k = sim.switched / 0.3;
      colour = mix(was.ball, colour, k);
      level = was.pulse(sim.face.time + 10) * (1 - k) + level * k;
    }
    if (sim && sim.age < 0.55) level *= smooth2(0.1, 0.5, sim.age);
    const r = HEAD.ball * U * pose.sx;
    const [bx, by] = ballC;
    const frost = [168, 174, 186];
    const lit = mix(frost, mix(colour, [255, 255, 255], 0.35), level);
    const glassTint = mix([150, 158, 172], colour, 0.5);
    const shoulder = mix(lit, glassTint, 0.48);
    const edge = mix([70, 76, 88], mix(colour, [90, 96, 108], 0.5), level * 0.55);
    const g = ctx.createRadialGradient(bx - r * 0.18, by - r * 0.22, r * 0.05, bx, by, r);
    g.addColorStop(0, `rgb(${mix(lit, [255, 255, 255], 0.6 + level * 0.3).map(Math.round).join(",")})`);
    g.addColorStop(0.38, `rgb(${lit.map(Math.round).join(",")})`);
    g.addColorStop(0.78, `rgb(${shoulder.map(Math.round).join(",")})`);
    g.addColorStop(1, `rgb(${edge.map(Math.round).join(",")})`);
    if (level > 0.01) {
      ctx.globalCompositeOperation = "lighter";
      const glow = ctx.createRadialGradient(bx, by, r * 0.6, bx, by, r * 4.2);
      const c = colour.map(Math.round).join(",");
      glow.addColorStop(0, `rgba(${c},${0.5 * level})`);
      glow.addColorStop(0.35, `rgba(${c},${0.14 * level})`);
      glow.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bx, by, r * 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }
    const seat = ctx.createRadialGradient(bx, by + r * 0.9, 0, bx, by + r * 0.9, r * 0.7);
    seat.addColorStop(0, "rgba(20,24,32,0.28)");
    seat.addColorStop(1, "rgba(20,24,32,0)");
    ctx.fillStyle = seat;
    ctx.beginPath();
    ctx.arc(bx, by + r * 0.9, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = Math.max(0.75, r * 0.07);
    ctx.strokeStyle = "rgba(28,32,42,0.28)";
    ctx.stroke();
    const sp = ctx.createRadialGradient(bx - r * 0.38, by - r * 0.42, 0, bx - r * 0.38, by - r * 0.42, r * 0.38);
    sp.addColorStop(0, "rgba(255,255,255,0.95)");
    sp.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sp;
    ctx.fill();
  }
};

// ../robot-heads/src/color.ts
function parseColor(input) {
  const s = input.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    const n = parseInt(h, 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

// ../robot-heads/src/ticker.ts
var pointer = { x: NaN, y: NaN };
var subscribers = /* @__PURE__ */ new Set();
var frame = 0;
var last = 0;
var listening = false;
function loop(now) {
  frame = 0;
  const dt = last ? Math.min(0.1, (now - last) / 1e3) : 0;
  last = now;
  subscribers.forEach((fn) => fn(dt));
  if (subscribers.size) frame = requestAnimationFrame(loop);
}
function start() {
  if (frame || typeof document === "undefined" || document.hidden) return;
  last = 0;
  frame = requestAnimationFrame(loop);
}
function stop() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}
function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  const away = () => {
    pointer.x = NaN;
    pointer.y = NaN;
  };
  document.addEventListener("pointermove", (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }, { passive: true });
  document.addEventListener("pointerleave", away);
  window.addEventListener("blur", away);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (subscribers.size) start();
  });
}
function subscribe(fn) {
  listen();
  subscribers.add(fn);
  start();
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size) stop();
  };
}
export {
  RobotRenderer,
  RobotSim,
  frameFor,
  getShape,
  linear,
  parseColor,
  pointer,
  restPose,
  subscribe,
  /* Pekka's helmet (../pekka-renderer.js) reuses the light, mesh and screen helpers. */
  LIGHTS,
  css,
  finish,
  grainPattern,
  makeCanvas,
  mix,
  noise,
  norm,
  radiance,
  rotate,
  rotation,
  smooth2,
  stitch
};
