/* Pekka's helmet, drawn with robot-heads (./robot-heads, MIT). The library's sim, ticker, light and mesh
 * helpers give the brand mark in assets/head.svg a body: a dome shell, horns and a crest that turn and hop,
 * and a visor whose eyes and grille show what a bot is doing. Everything is in helmet units: the shell is one
 * unit wide, centred on the origin, facing +z. */
import { LIGHTS, css, finish, grainPattern, makeCanvas, mix, noise, norm, radiance, rotate, rotation, smooth2, stitch } from "./robot-heads/engine.js";

const TAU = Math.PI * 2;

/** Base Pekka: blue-steel armour, magenta horns and a hot-pink glow. Every other look is a change from this one. */
export const PEKKA = { armor: "#475577", hornColor: "#c24be0", eyeColor: "#ff5fe0", horns: "classic", crest: "none", eyes: "slit" };

/* Horn centrelines for the left horn (the right one is mirrored): a cubic Bézier and the radius at its root.
 * Classic follows the horns in head.svg. */
export const HORNS = {
  classic: { curve: [[-0.4, -0.16, -0.06], [-0.64, -0.19, -0.07], [-0.74, -0.42, -0.05], [-0.665, -0.63, -0.02]], root: 0.105 },
  long: { curve: [[-0.4, -0.17, -0.06], [-0.72, -0.18, -0.08], [-0.88, -0.56, -0.07], [-0.72, -0.99, -0.03]], root: 0.11 },
  short: { curve: [[-0.41, -0.17, -0.05], [-0.54, -0.2, -0.05], [-0.62, -0.3, -0.04], [-0.62, -0.45, -0.02]], root: 0.095 },
  curled: { curve: [[-0.41, -0.12, -0.06], [-0.8, -0.34, -0.12], [-0.9, 0.18, -0.02], [-0.6, 0.17, 0.12]], root: 0.1 },
  upright: { curve: [[-0.27, -0.3, -0.03], [-0.33, -0.46, -0.03], [-0.34, -0.62, -0.03], [-0.27, -0.8, -0.02]], root: 0.08 },
  none: null,
};
export const CRESTS = ["ridge", "fin", "plume", "none"];
export const EYES = ["slit", "round", "visor"];

/* The shell: head.svg's helmet outline as a rounded hull (a dome over slightly tapering cheeks), swept back
 * with a soft bevel at the front, where the visor sits, and a rounder one at the back. */
const SHELL_R = 0.17;
const FRONT = { z: 0.34, a: 0.15, d: 0.28 };
const BACK = { z: -0.4, a: 0.17, d: 0.42 };
const HY = 0.472;

function hull(centres, r) {
  const pts = centres.map(([x, y]) => ({ x, y, t: Math.atan2(y, x) })).sort((a, b) => a.t - b.t);
  const n = pts.length;
  const edge = pts.map((a, i) => {
    const b = pts[(i + 1) % n];
    return Math.atan2(-(b.x - a.x), b.y - a.y);
  });
  const corners = pts.map((p, i) => {
    const a0 = edge[(i - 1 + n) % n];
    let a1 = edge[i];
    while (a1 < a0) a1 += TAU;
    return { x: p.x, y: p.y, a0, a1 };
  });
  const path = (ctx, inset) => {
    const rr = Math.max(5e-4, r - inset);
    corners.forEach((c, i) => {
      if (i === 0) ctx.moveTo(c.x + rr * Math.cos(c.a0), c.y + rr * Math.sin(c.a0));
      ctx.arc(c.x, c.y, rr, c.a0, c.a1);
    });
    ctx.closePath();
  };
  return { corners, path };
}

const SHELL = hull([
  ...Array.from({ length: 13 }, (_, i) => {
    const a = Math.PI + (i / 12) * Math.PI;
    return [(0.5 - SHELL_R) * Math.cos(a), 0.056 + (0.528 - SHELL_R) * Math.sin(a)];
  }),
  [0.311, 0.302],
  [-0.311, 0.302],
], SHELL_R);

const ellipseNormal = (w, z) => {
  const l = Math.hypot(w, z) || 1;
  return [w / l, z / l];
};

/* Rings from the back face round to the front face: [z, inset, outward share, z share] of the normal. */
function shellProfile(steps) {
  const rings = [];
  for (let i = steps; i >= 0; i--) {
    const p = (i / steps) * (Math.PI / 2);
    rings.push([BACK.z + BACK.d * (1 - Math.sin(p)), BACK.a * (1 - Math.cos(p)), ...ellipseNormal(Math.cos(p) / BACK.a, -Math.sin(p) / BACK.d)]);
  }
  for (let i = 0; i <= steps; i++) {
    const p = (i / steps) * (Math.PI / 2);
    rings.push([FRONT.z - FRONT.d * (1 - Math.sin(p)), FRONT.a * (1 - Math.cos(p)), ...ellipseNormal(Math.cos(p) / FRONT.a, Math.sin(p) / FRONT.d)]);
  }
  return rings;
}

/* The outline, traced finely and then spaced evenly by length, so a small head draws few quads. */
function shellOutline(count) {
  const fine = [];
  for (const c of SHELL.corners) {
    const sweep = c.a1 - c.a0;
    const steps = Math.max(1, Math.ceil((sweep / (Math.PI / 2)) * 24));
    for (let i = 0; i <= steps; i++) {
      const a = c.a0 + (i / steps) * sweep;
      fine.push([c.x, c.y, Math.cos(a), Math.sin(a)]);
    }
  }
  const at = ([cx, cy, nx, ny]) => [cx + SHELL_R * nx, cy + SHELL_R * ny];
  const lengths = [0];
  for (let i = 1; i <= fine.length; i++) {
    const [ax, ay] = at(fine[i - 1]), [bx, by] = at(fine[i % fine.length]);
    lengths.push(lengths[i - 1] + Math.hypot(bx - ax, by - ay));
  }
  const total = lengths.at(-1);
  const outline = [];
  for (let k = 0, i = 0; k < count; k++) {
    while (lengths[i + 1] < (k / count) * total) i++;
    outline.push(fine[i]);
  }
  return outline;
}

function buildShell(detail) {
  const outline = shellOutline(Math.max(24, Math.round(96 * detail)));
  const profile = shellProfile(Math.max(2, Math.round(8 * detail)));
  const pos = [], vn = [];
  for (const [z, inset, nw, nz] of profile) {
    for (const [cx, cy, nx, ny] of outline) {
      pos.push(cx + (SHELL_R - inset) * nx, cy + (SHELL_R - inset) * ny, z);
      vn.push(nx * nw, ny * nw, nz);
    }
  }
  return finish(pos, stitch(profile.length, outline.length), vn);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/* A tube along `points` (centre, side axis, up axis, half width, half height per ring), closed at the root.
 * Each quad remembers its ring so a material can change along the tube. */
function buildTube(rings, segs, surface) {
  const pos = [], vn = [], ring = [];
  for (const { c, side, up, w, h } of rings) {
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(c[0] + side[0] * w * ca + up[0] * h * sa, c[1] + side[1] * w * ca + up[1] * h * sa, c[2] + side[2] * w * ca + up[2] * h * sa);
      vn.push(...norm(side[0] * ca / w + up[0] * sa / h, side[1] * ca / w + up[1] * sa / h, side[2] * ca / w + up[2] * sa / h));
    }
  }
  const quads = stitch(rings.length, segs);
  for (let k = 0; k < quads.length / 4; k++) ring.push(Math.floor(k / segs));
  // Close the root with a fan of degenerate quads round its centre.
  const [root, next] = rings;
  const centre = pos.length / 3;
  pos.push(...root.c);
  vn.push(...norm(root.c[0] - next.c[0], root.c[1] - next.c[1], root.c[2] - next.c[2]));
  for (let j = 0; j < segs; j++) {
    quads.push(centre, (j + 1) % segs, j, centre);
    ring.push(0);
  }
  const mesh = finish(pos, quads, vn);
  mesh.ring = Uint16Array.from(ring);
  mesh.rings = rings.length;
  if (surface) {
    // A ring hides once the shell under it has turned away; taller parts stay up over the silhouette longer.
    mesh.surface = Float32Array.from(rings.flatMap(({ up }) => up));
    mesh.limit = Float32Array.from(rings, ({ h }) => -Math.min(0.6, h * 3));
  }
  return mesh;
}

const bezier = ([p0, p1, p2, p3], t) => {
  const u = 1 - t;
  return [0, 1, 2].map((i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]);
};

function buildHorn(style, mirror, detail) {
  const curve = style.curve.map(([x, y, z]) => [mirror ? -x : x, y, z]);
  const count = Math.max(5, Math.round(18 * detail));
  const rings = [];
  let side;
  for (let k = 0; k <= count; k++) {
    const t = 0.02 + (k / count) * 0.98;
    const a = bezier(curve, Math.max(0, t - 0.01)), b = bezier(curve, Math.min(1, t + 0.01));
    const tangent = norm(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    // Parallel transport keeps the tube from twisting as the horn bends.
    side = side ? norm(...cross(cross(tangent, side), tangent)) : norm(...cross(tangent, [0, 0, 1]));
    const up = cross(side, tangent);
    const r = style.root * Math.pow(1 - t, 0.85) + 0.004;
    rings.push({ c: bezier(curve, t), side, up, w: r, h: r });
  }
  return buildTube(rings, Math.max(6, Math.round(14 * detail)));
}

/* A collar of armour where the horn meets the shell, so it looks mounted rather than stuck on. */
function buildMount(style, mirror, detail) {
  const curve = style.curve.map(([x, y, z]) => [mirror ? -x : x, y, z]);
  const c0 = bezier(curve, 0), c1 = bezier(curve, 0.04);
  const tangent = norm(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
  const side = norm(...cross(tangent, [0, 0, 1]));
  const up = cross(side, tangent);
  const r = style.root * 1.32;
  const rings = [[0.0, 0.7], [0.03, 0.96], [0.055, 1], [0.085, 0.94], [0.1, 0.72]].map(([d, k]) => ({
    c: [c0[0] + tangent[0] * d, c0[1] + tangent[1] * d, c0[2] + tangent[2] * d], side, up, w: r * k, h: r * k,
  }));
  return buildTube(rings, Math.max(6, Math.round(16 * detail)));
}

/* The crest runs along the top of the shell: up the front face from under the brow, over the dome, down the back. */
function crestPath() {
  const pts = [];
  const add = (y, z, ny, nz) => pts.push({ c: [0, y, z], up: norm(0, ny, nz) });
  for (let i = 0; i < 4; i++) add(-0.13 - (i / 4) * (HY - FRONT.a - 0.13), FRONT.z, 0, 1);
  for (let i = 8; i >= 0; i--) {
    const p = (i / 8) * (Math.PI / 2);
    const [nw, nz] = ellipseNormal(Math.cos(p) / FRONT.a, Math.sin(p) / FRONT.d);
    add(-(HY - FRONT.a * (1 - Math.cos(p))), FRONT.z - FRONT.d * (1 - Math.sin(p)), -nw, nz);
  }
  for (let i = 1; i < 4; i++) add(-HY, FRONT.z - FRONT.d + (i / 4) * (BACK.z + BACK.d - FRONT.z + FRONT.d), -1, 0);
  for (let i = 0; i <= 8; i++) {
    const p = (i / 8) * (Math.PI / 2);
    const [nw, nz] = ellipseNormal(Math.cos(p) / BACK.a, -Math.sin(p) / BACK.d);
    add(-(HY - BACK.a * (1 - Math.cos(p))), BACK.z + BACK.d * (1 - Math.sin(p)), -nw, nz);
  }
  for (let i = 1; i <= 3; i++) add(-(HY - BACK.a) + (i / 3) * 0.2, BACK.z, 0, 0);
  pts.at(-1).up = pts.at(-2).up = pts.at(-3).up = norm(0, 0, -1);
  return pts;
}

function buildCrest(kind, detail) {
  const path = crestPath();
  const rings = path.map(({ c, up }, i) => {
    const s = i / (path.length - 1);
    const end = smooth2(1, 0.82, s);
    if (kind === "fin") return { c, side: [1, 0, 0], up, w: 0.026, h: 0.03 + 0.13 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.15)), 0.8) * end };
    return { c, side: [1, 0, 0], up, w: (0.05 - 0.014 * s) * (0.3 + 0.7 * end), h: 0.03 * end + 0.004 };
  });
  return buildTube(rings, Math.max(6, Math.round(12 * detail)), true);
}

/* What sticks out of the shell, for sizing the canvas. */
function extents(look) {
  let side = 0.5, top = HY;
  const horn = HORNS[look.horns];
  if (horn) {
    for (let k = 0; k <= 16; k++) {
      const [x, y] = bezier(horn.curve, k / 16);
      const r = horn.root * Math.pow(1 - k / 16, 0.85);
      side = Math.max(side, -x + r);
      top = Math.max(top, -y + r);
    }
  }
  if (look.crest === "fin") top = Math.max(top, HY + 0.17);
  if (look.crest === "plume") top = Math.max(top, HY + 0.46);
  return { side, top };
}

/* Every look shares one layout, so a helmet is the same size whatever it wears. The box fits the helmet and
 * the roots of base Pekka's horns; horn tips and plumes reach into the padding round it. */
const LAYOUT = { side: 0.64, top: 0.6 };
const TRAVEL = { hop: 0.36, shadow: 0.22, side: 0.12 };
const BOX_INSET = 0.04;

export function pekkaFrame(look, box) {
  const reach = extents(look);
  const tall = HY + LAYOUT.top;
  const unit = Math.min((box * (1 - 2 * BOX_INSET)) / tall, (box * (1 - 2 * BOX_INSET)) / (2 * LAYOUT.side));
  const centreY = (box - tall * unit) / 2 + LAYOUT.top * unit;
  const padTop = Math.ceil(Math.max(0, (reach.top + TRAVEL.hop) * unit - centreY) + 1);
  const padBottom = Math.ceil(Math.max(0, centreY + (HY + TRAVEL.shadow) * unit - box) + 1);
  const padSide = Math.ceil(Math.max(0, (reach.side * 1.08 + TRAVEL.side) * unit - box / 2) + 1);
  return { box, padTop, padBottom, padSide, unit, cx: padSide + box / 2, cy: padTop + centreY };
}

/* head.svg's front details, in its own pixels; `toSvg` maps them onto the helmet. */
const VISOR = "M178 196C178 178 190 168 208 168H304C322 168 334 178 334 196L330 252C329 264 320 272 308 272H204C192 272 183 264 182 252Z";
const BROW = "M170 180 256 204 342 180V160C300 148 212 148 170 160Z";
const BROW_EDGE = "M176 163C210 153 300 153 336 163";
const EYE = "M199 218 242 229C245 230 247 233 246 236L243 247C242 250 239 251 236 250L206 242C202 241 199 237 199 233Z";
const EYE_X = 33.5, EYE_Y = 234.5;
let paths;
const shapes = () => (paths ??= { visor: new Path2D(VISOR), brow: new Path2D(BROW), browEdge: new Path2D(BROW_EDGE), eye: new Path2D(EYE) });
const toSvg = (c) => c.transform(1 / 216, 0, 0, 1 / 216, -256 / 216, -194 / 216);

const rgb = (c, a = 1) => `rgba(${c.map(Math.round).join(",")},${a})`;
const STILL = { lookX: 0, lookY: 0, blink: 0, time: 0.4, side: 1, seed: 0 };

/* The visor's faces, one per state, drawn in head.svg's pixels. */
function face(c, state, f, led, eyes, open, blur) {
  const s = shapes();
  const core = mix(led, [255, 255, 255], 0.62);
  const deep = mix(led, [0, 0, 0], 0.35);
  const fill = c.createLinearGradient(0, 214, 0, 254);
  fill.addColorStop(0, rgb(mix(core, [255, 255, 255], 0.5)));
  fill.addColorStop(0.45, rgb(led));
  fill.addColorStop(1, rgb(deep));
  const glow = (level) => {
    c.shadowColor = rgb(led, 0.9 * level);
    c.shadowBlur = blur;
  };
  const lookX = f.lookX * 5, lookY = f.lookY * 4;
  const drawEyes = ({ dx = 0, dy = 0, lid = 0, squint = 1 } = {}) => {
    const sy = Math.max(0.08, open * squint * (1 - 0.92 * f.blink) * (1 - lid * 0.42));
    c.fillStyle = fill;
    glow(1);
    if (eyes === "visor") {
      c.save();
      c.translate(256 + lookX * 0.6 + dx, EYE_Y - 2 + lookY + dy + lid * 3);
      c.scale(1, sy);
      c.globalAlpha *= 0.4;
      c.beginPath();
      c.roundRect(-62, -8, 124, 16, 8);
      c.fill();
      c.globalAlpha /= 0.4;
      for (const side of [-1, 1]) {
        c.beginPath();
        c.roundRect(side * EYE_X + lookX * 0.6 - 16, -8, 32, 16, 8);
        c.fill();
      }
      c.restore();
      return;
    }
    for (const side of [-1, 1]) {
      c.save();
      c.translate(256 + side * EYE_X + lookX + dx, EYE_Y + lookY + dy + lid * 3);
      c.scale(1, sy);
      if (eyes === "round") {
        c.beginPath();
        c.ellipse(0, 0, 14, 16, 0, 0, TAU);
        c.fill();
      } else {
        // The right eye is head.svg's left one mirrored about the middle.
        c.translate(-(256 + side * EYE_X), -EYE_Y);
        if (side > 0) c.transform(-1, 0, 0, 1, 512, 0);
        c.fill(s.eye);
      }
      c.restore();
    }
  };
  const strokeEyes = (trace, width, level = 1) => {
    c.strokeStyle = rgb(core);
    c.lineWidth = width;
    c.lineCap = c.lineJoin = "round";
    glow(level);
    for (const side of [-1, 1]) {
      c.beginPath();
      trace(256 + side * EYE_X + lookX * 0.5, EYE_Y + lookY * 0.5);
      c.stroke();
    }
  };
  const grille = (level, grow) => {
    for (let i = 0; i < 3; i++) {
      const v = Math.max(0, Math.min(1, level(i)));
      const h = grow ? 11 * (0.4 + 0.6 * v) : 11;
      c.shadowBlur = 0;
      c.fillStyle = "#1c2030";
      c.beginPath();
      c.roundRect(239 + i * 14, 254, 6, 11, 3);
      c.fill();
      if (v < 0.03) continue;
      glow(v);
      c.globalAlpha *= v;
      c.fillStyle = rgb(core);
      c.beginPath();
      c.roundRect(239 + i * 14, 259.5 - h / 2, 6, h, 3);
      c.fill();
      c.globalAlpha /= v;
    }
  };
  const t = f.time;
  switch (state) {
    case "thinking":
      drawEyes({ dx: f.side * 7, dy: -5, lid: 0.45 });
      grille((i) => {
        const p = (((t * 1.6 - i * 0.22) % 1) + 1) % 1;
        return 0.2 + 0.8 * (p < 0.35 ? Math.sin((p / 0.35) * Math.PI) : 0);
      });
      break;
    case "searching": {
      const x = 256 + Math.sin(t * 1.6 + 0.4) * 72;
      const band = c.createLinearGradient(x - 34, 0, x + 34, 0);
      band.addColorStop(0, rgb(led, 0));
      band.addColorStop(0.5, rgb(led, 0.32));
      band.addColorStop(1, rgb(led, 0));
      c.shadowBlur = 0;
      c.fillStyle = band;
      c.fillRect(x - 34, 160, 68, 120);
      drawEyes();
      grille(() => 0);
      break;
    }
    case "listening":
      drawEyes({ dy: -4 });
      grille((i) => 0.25 + 0.75 * noise(t * 7 + i * 1.9 + f.seed * 10) * (i === 1 ? 1 : 0.75), true);
      break;
    case "speaking": {
      const env = Math.max(0, Math.sin(t * 2.1) * 0.5 + Math.sin(t * 3.7 + 1) * 0.5);
      drawEyes({ dy: -3 });
      grille((i) => noise(t * 11 + i * 0.9) * (0.45 + env) * (i === 1 ? 1.25 : 0.9), true);
      break;
    }
    case "working": {
      const lit = Math.floor((t / 2.6) % 1 * 4);
      drawEyes({ dy: 4, squint: 0.55 });
      grille((i) => (i < lit ? 1 : 0.12));
      break;
    }
    case "happy": {
      const hop = -Math.max(0, Math.sin(t * 5.6)) * 3;
      strokeEyes((x, y) => {
        c.moveTo(x - 15, y + 6 + hop);
        c.lineTo(x, y - 7 + hop);
        c.lineTo(x + 15, y + 6 + hop);
      }, 7);
      grille(() => 0.7);
      break;
    }
    case "error": {
      const on = Math.sin(t * 7) > -0.6 ? 1 : 0.5;
      c.globalAlpha *= on;
      strokeEyes((x, y) => {
        c.moveTo(x - 10, y - 10);
        c.lineTo(x + 10, y + 10);
        c.moveTo(x + 10, y - 10);
        c.lineTo(x - 10, y + 10);
      }, 6);
      c.globalAlpha /= on;
      grille((i) => (Math.floor(t * 6) + i) % 2 ? 0.9 : 0.2);
      break;
    }
    case "sleeping":
      c.globalAlpha *= 0.55;
      strokeEyes((x, y) => {
        c.moveTo(x - 15, y + 2);
        c.quadraticCurveTo(x, y + 11, x + 15, y + 2);
      }, 4.5, 0.6);
      c.globalAlpha /= 0.55;
      grille(() => 0);
      break;
    default:
      drawEyes();
      grille(() => 0);
  }
  c.shadowBlur = 0;
}

/* Sleeping Zs drift up out of the visor, past the helmet's right side. */
function snore(c, t, led) {
  c.lineCap = c.lineJoin = "round";
  for (const [delay, size] of [[0, 18], [1.1, 12]]) {
    const p = ((t + delay) / 2.2) % 1;
    const x = 318 + p * 34, y = 176 - p * 70;
    c.globalAlpha = Math.sin(p * Math.PI) * 0.75;
    c.strokeStyle = rgb(mix(led, [255, 255, 255], 0.5));
    c.lineWidth = size / 5;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + size, y);
    c.lineTo(x, y + size);
    c.lineTo(x + size, y + size);
    c.stroke();
  }
  c.globalAlpha = 1;
}

/* Meshes depend only on the horns, the crest and the level of detail, so every head shares them. */
const meshes = new Map();

export class PekkaRenderer {
  constructor() {
    this.meshes = null;
    this.meshKey = "";
    this.layer = null;
    this.grain = null;
    this.proj = new Float32Array(4096 * 3);
    this.hornMats = null;
    this.hornKey = "";
  }

  prepare(look, unit) {
    const detail = unit < 90 ? 0.3 : unit < 200 ? 0.6 : unit < 320 ? 1 : 1.5;
    const key = `${look.horns}:${look.crest}:${detail}`;
    if (key === this.meshKey) return;
    this.meshKey = key;
    if (!meshes.has(key)) {
      const horn = HORNS[look.horns];
      meshes.set(key, {
        shell: buildShell(detail),
        horns: horn ? [false, true].map((mirror) => ({ horn: buildHorn(horn, mirror, detail), mount: buildMount(horn, mirror, detail) })) : [],
        crest: look.crest === "ridge" || look.crest === "fin" ? buildCrest(look.crest, detail) : null,
      });
    }
    this.meshes = meshes.get(key);
  }

  /* One material per ring: head.svg's horns darken towards the root and frost towards the tip. */
  materialsAlong(mat, rings) {
    const key = `${mat.albedo.join(",")}:${rings}`;
    if (key !== this.hornKey) {
      this.hornKey = key;
      const root = mix(mat.albedo, [0, 0, 0], 0.55), tip = mix(mat.albedo, [1, 1, 1], 0.7);
      this.hornMats = Array.from({ length: rings }, (_, k) => {
        const t = k / Math.max(1, rings - 1);
        const albedo = t < 0.55 ? mix(root, mat.albedo, t / 0.55) : mix(mat.albedo, tip, (t - 0.55) / 0.45);
        return { ...mat, albedo };
      });
    }
    return this.hornMats;
  }

  drawMesh(c, mesh, mats, P, R, U) {
    const n = mesh.pos.length / 3;
    if (this.proj.length < n * 3) this.proj = new Float32Array(n * 3);
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
      if (mesh.surface) {
        const r = mesh.ring[k] * 3;
        if (R[6] * mesh.surface[r] + R[7] * mesh.surface[r + 1] + R[8] * mesh.surface[r + 2] < mesh.limit[mesh.ring[k]]) continue;
      }
      order.push([pr[q[k * 4] * 3 + 2] + pr[q[k * 4 + 1] * 3 + 2] + pr[q[k * 4 + 2] * 3 + 2] + pr[q[k * 4 + 3] * 3 + 2], k]);
    }
    order.sort((a, b) => a[0] - b[0]);
    c.lineWidth = Math.max(0.6, U / 260);
    c.lineJoin = "round";
    for (const [, k] of order) {
      const w = rotate(R, nn[k * 3], nn[k * 3 + 1], nn[k * 3 + 2]);
      const col = css(radiance(Array.isArray(mats) ? mats[mesh.ring[k]] : mats, w[0], w[1], w[2]));
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
  }

  /** Draw a frame; `frame` is in CSS px, the canvas in device px (`dpr` per CSS px). */
  draw(ctx, frame, dpr, pose, sim, state, look, palette, opts) {
    const U = frame.unit * dpr;
    this.prepare(look, U);
    if (!this.layer || this.layer.width !== ctx.canvas.width || this.layer.height !== ctx.canvas.height) {
      this.layer = makeCanvas(ctx.canvas.width, ctx.canvas.height);
      this.grain = grainPattern(ctx);
    }
    const shown = sim ? sim.shown : state;
    let led = LIGHTS[shown].screen ?? palette.led;
    if (sim && sim.switched < 0.3) led = mix(LIGHTS[sim.previous].screen ?? palette.led, led, sim.switched / 0.3);

    const R = rotation(pose.yaw, pose.pitch, pose.roll);
    const cx = frame.cx * dpr + pose.x * U;
    const rest = frame.cy * dpr;
    const cy = rest - pose.lift * U;
    const by = cy + HY * U;
    const P = (x, y, z) => {
      const r = rotate(R, x, y, z);
      return [cx + r[0] * U * pose.sx, by + (cy + r[1] * U - by) * pose.sy, r[2]];
    };
    const plane = (c, z, flip) => {
      const o = P(0, 0, z), ex = P(flip ? -1 : 1, 0, z), ey = P(0, 1, z);
      c.setTransform(ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]);
    };
    /* the shell's colour where its normal leans (dx, dy) off the face, for gradients across flat parts */
    const lit = (mat, dx, dy, dz = 1) => {
      const w = rotate(R, dx, dy, dz);
      const l = Math.hypot(w[0], w[1], w[2]);
      return css(radiance(mat, w[0] / l, w[1] / l, w[2] / l));
    };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (opts.floorShadow) {
      const up = Math.max(0, pose.lift);
      const rx = U * 0.55 * (1 - up * 0.9) * pose.sx;
      ctx.save();
      ctx.translate(frame.cx * dpr + pose.x * U, rest + (HY + 0.11) * U);
      ctx.scale(1, 0.16);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      const a = 0.5 * Math.max(0, 1 - up * 1.6);
      g.addColorStop(0, `rgba(0,0,0,${a})`);
      g.addColorStop(0.55, `rgba(0,0,0,${a * 0.45})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    const { shell, horns, crest } = this.meshes;
    const hornMats = horns.length ? this.materialsAlong(palette.horn, horns[0].horn.rings) : null;
    const drawHorn = ({ horn, mount }) => {
      this.drawMesh(ctx, mount, palette.ridge, P, R, U);
      this.drawMesh(ctx, horn, hornMats, P, R, U);
    };
    const hornStyle = HORNS[look.horns];
    const hornZ = (mirror) => {
      const [x, y, z] = bezier(hornStyle.curve, 0.6);
      return rotate(R, mirror ? -x : x, y, z)[2];
    };
    const behind = horns.map((_, i) => hornZ(i === 1) < 0);
    horns.forEach((parts, i) => behind[i] && drawHorn(parts));
    const plume = () => look.crest === "plume" && this.drawPlume(ctx, P, U, pose, palette);
    // The feathers sweep back, so they're behind the dome unless the head has turned away.
    const plumeBehind = rotate(R, 0, -HY - 0.3, -0.4)[2] < 0;
    if (plumeBehind) plume();

    const layer = this.layer.getContext("2d");
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, this.layer.width, this.layer.height);
    this.drawMesh(layer, shell, palette.shell, P, R, U);
    const facing = Math.abs(R[8]) > 5e-3 ? Math.sign(R[8]) : 0;
    if (facing) {
      const cap = facing > 0 ? FRONT : BACK;
      const dome = 0.28;
      plane(layer, facing > 0 ? FRONT.z : BACK.z, facing < 0);
      const at = (dx, dy) => lit(palette.shell, dx * facing, dy, facing);
      layer.beginPath();
      SHELL.path(layer, cap.a - 2e-3);
      const vg = layer.createLinearGradient(0, -HY, 0, HY);
      vg.addColorStop(0, at(0, -dome));
      vg.addColorStop(0.5, at(0, 0));
      vg.addColorStop(1, at(0, dome));
      layer.fillStyle = vg;
      layer.fill();
      const hg = layer.createLinearGradient(-0.5, 0, 0.5, 0);
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

    if (crest) this.drawMesh(ctx, crest, look.crest === "fin" ? palette.horn : palette.ridge, P, R, U);
    if (facing > 0) this.drawFront(ctx, plane, lit, U, sim, state, shown, look, palette, led, pose);

    horns.forEach((parts, i) => !behind[i] && drawHorn(parts));
    if (!plumeBehind) plume();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawFront(ctx, plane, lit, U, sim, state, shown, look, palette, led, pose) {
    const s = shapes();
    const blur = Math.max(1, U * 0.045);
    ctx.save();
    plane(ctx, FRONT.z);
    toSvg(ctx);
    // The visor: a dark recess under the brow, with the face on glass set back inside it.
    const recess = ctx.createLinearGradient(0, 168, 0, 272);
    recess.addColorStop(0, "#0b0d15");
    recess.addColorStop(1, "#22273a");
    ctx.fillStyle = recess;
    ctx.fill(s.visor);
    ctx.save();
    ctx.clip(s.visor);
    plane(ctx, FRONT.z - 0.035);
    toSvg(ctx);
    const open = sim && sim.age < 0.55 ? smooth2(0.08, 0.5, sim.age) : 1;
    const f = sim ? sim.face : STILL;
    if (sim && sim.switched < 0.3) {
      const k = sim.switched / 0.3;
      ctx.globalAlpha = 1 - k;
      face(ctx, sim.previous, { ...f, time: f.time + 10 }, led, look.eyes, open, blur);
      ctx.globalAlpha = k;
    }
    face(ctx, shown, f, led, look.eyes, open, blur);
    ctx.globalAlpha = 1;
    plane(ctx, FRONT.z);
    toSvg(ctx);
    const shade = ctx.createLinearGradient(0, 168, 0, 214);
    shade.addColorStop(0, "rgba(0,0,0,0.55)");
    shade.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shade;
    ctx.fillRect(170, 160, 172, 60);
    const sheen = -0.05 - pose.yaw * 0.9 + pose.pitch * 0.5;
    const sg = ctx.createLinearGradient(150 + sheen * 216, 160, 300 + sheen * 216, 280);
    sg.addColorStop(0, "rgba(255,255,255,0)");
    sg.addColorStop(0.4, "rgba(255,255,255,0)");
    sg.addColorStop(0.46, "rgba(220,232,255,0.09)");
    sg.addColorStop(0.53, "rgba(255,255,255,0)");
    sg.addColorStop(0.62, "rgba(220,232,255,0.05)");
    sg.addColorStop(0.66, "rgba(255,255,255,0)");
    ctx.fillStyle = sg;
    ctx.fillRect(170, 160, 172, 120);
    ctx.restore();
    // The visor's lip: shadowed under the brow, catching light along the chin.
    const lip = ctx.createLinearGradient(0, 168, 0, 272);
    lip.addColorStop(0, "rgba(0,0,0,0.6)");
    lip.addColorStop(0.6, "rgba(0,0,0,0.1)");
    lip.addColorStop(1, "rgba(255,255,255,0.28)");
    ctx.strokeStyle = lip;
    ctx.lineWidth = 3;
    ctx.stroke(s.visor);
    if (shown === "sleeping") snore(ctx, sim ? sim.face.time : 0.4, led);

    // Rivets at the cheeks.
    for (const x of [164, 348]) {
      const g = ctx.createRadialGradient(x - 1.5, 236.5, 0, x, 238, 5.5);
      g.addColorStop(0, lit(palette.shell, -0.5, -0.6, 0.6));
      g.addColorStop(1, lit(palette.shell, 0.3, 0.5, 0.8));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, 238, 5, 0, TAU);
      ctx.fill();
    }

    // The brow plate stands proud of the face and throws a shadow on the visor.
    plane(ctx, FRONT.z + 0.014);
    toSvg(ctx);
    ctx.save();
    ctx.translate(0, 5);
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    ctx.fill(s.brow);
    ctx.restore();
    const brow = ctx.createLinearGradient(0, 150, 0, 204);
    brow.addColorStop(0, lit(palette.shell, 0, -0.75));
    brow.addColorStop(0.35, lit(palette.shell, 0, -0.18));
    brow.addColorStop(1, lit(palette.shell, 0, 0.32));
    ctx.fillStyle = brow;
    ctx.fill(s.brow);
    const wings = ctx.createLinearGradient(170, 0, 342, 0);
    wings.addColorStop(0, lit(palette.shell, -0.5, -0.1));
    wings.addColorStop(0.5, lit(palette.shell, 0, -0.1));
    wings.addColorStop(1, lit(palette.shell, 0.5, -0.1));
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = wings;
    ctx.fill(s.brow);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(235,240,255,0.42)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.stroke(s.browEdge);
    ctx.restore();
  }

  /* A knight's plume: feathers rooted on the crown that whip about on the antenna springs. */
  drawPlume(ctx, P, U, pose, palette) {
    const feathers = [-2, -1, 0, 1, 2].map((i) => {
      const sway = pose.antennaX * 0.28, nod = pose.antennaZ * 0.22;
      const base = P(i * 0.018, -HY + 0.01, -0.02 - Math.abs(i) * 0.02);
      const ctrl = P(i * 0.06 + sway * 0.4, -HY - 0.3, -0.1 - Math.abs(i) * 0.03 + nod * 0.4);
      const tip = P(i * 0.13 + sway, -HY - 0.34 + Math.abs(i) * 0.06, -0.4 - Math.abs(i) * 0.04 + nod);
      return { base, ctrl, tip, z: tip[2] + base[2] };
    }).sort((a, b) => a.z - b.z);
    const deep = css(radiance({ ...palette.horn, albedo: mix(palette.horn.albedo, [0, 0, 0], 0.45) }, 0, 0, 1));
    const light = css(radiance({ ...palette.horn, albedo: mix(palette.horn.albedo, [1, 1, 1], 0.55) }, -0.3, -0.4, 0.85));
    ctx.lineCap = "round";
    for (const { base, ctrl, tip } of feathers) {
      const g = ctx.createLinearGradient(base[0], base[1], tip[0], tip[1]);
      g.addColorStop(0, deep);
      g.addColorStop(1, light);
      ctx.beginPath();
      ctx.moveTo(base[0], base[1]);
      ctx.quadraticCurveTo(ctrl[0], ctrl[1], tip[0], tip[1]);
      ctx.strokeStyle = g;
      ctx.lineWidth = U * 0.075 * pose.sx;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = U * 0.014;
      ctx.stroke();
    }
  }
}
