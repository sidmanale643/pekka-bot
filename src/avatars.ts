import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const HORNS = ["classic", "long", "short", "curled", "upright", "none"] as const;
const CRESTS = ["none", "ridge", "fin", "plume"] as const;
const EYES = ["slit", "round", "visor"] as const;

/** Avatars saved before Pekka's own head were robot heads with shell, trim and screen colours; they keep their colours. */
function fromRobot(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const { kind, shape: _shape, color: armor, trimColor: hornColor, screenColor: eyeColor, ...rest } = value as Record<string, unknown>;
  if (kind !== "robot" && [armor, hornColor, eyeColor].every((part) => part === undefined)) return value;
  return Object.fromEntries(Object.entries({ ...rest, kind: "pekka", armor, hornColor, eyeColor }).filter(([, part]) => part !== undefined));
}

/** How a bot's Pekka head looks. Anything left out is base Pekka's. */
export const AvatarSchema = z.preprocess(fromRobot, z.object({
  kind: z.literal("pekka"),
  armor: color.optional(),
  horns: z.enum(HORNS).optional(),
  hornColor: color.optional(),
  crest: z.enum(CRESTS).optional(),
  eyes: z.enum(EYES).optional(),
  eyeColor: color.optional(),
}).strict());

export type Avatar = z.infer<typeof AvatarSchema>;
type Look = Required<Avatar>;

/** Base Pekka, the chief of staff's look. The web app draws the same one (PEKKA in src/web/pekka-renderer.js). */
export const BASE_PEKKA: Look = { kind: "pekka", armor: "#475577", horns: "classic", hornColor: "#c24be0", crest: "none", eyes: "slit", eyeColor: "#ff5fe0" };

function hex(h: number, s: number, l: number) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[0, 8, 4].map((n) => channel(n).toString(16).padStart(2, "0")).join("")}`;
}

function hsl(color: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, d / (1 - Math.abs(2 * l - 1)), l];
}

/* Colours are drawn from ranges that suit each part: muted armour, vivid horns, eyes bright enough to glow. */
function randomLook(random: () => number): Look {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const between = (low: number, high: number) => low + random() * (high - low);
  return {
    kind: "pekka",
    armor: hex(between(0, 360), between(0.12, 0.45), between(0.26, 0.62)),
    horns: pick(HORNS.filter((horns) => horns !== "none")),
    hornColor: hex(between(0, 360), between(0.6, 0.9), between(0.48, 0.66)),
    crest: pick(CRESTS),
    eyes: pick(EYES),
    eyeColor: hex(between(0, 360), between(0.85, 1), between(0.62, 0.78)),
  };
}

/* How different two looks are at a glance: each changed part counts one, and colours count by how far apart they are. */
function difference(a: Look, b: Look) {
  const colour = (x: string, y: string) => {
    const [h1, s1, l1] = hsl(x), [h2, s2, l2] = hsl(y);
    const hue = Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2)) / 180;
    return Math.min(1, hue * Math.min(s1, s2) * 2 + Math.abs(l1 - l2) * 2);
  };
  return Number(a.horns !== b.horns) + Number(a.crest !== b.crest) + Number(a.eyes !== b.eyes)
    + colour(a.armor, b.armor) * 1.5 + colour(a.hornColor, b.hornColor) + colour(a.eyeColor, b.eyeColor);
}

/** A new bot's look: of a batch of random ones, the one least like any look the user's bots already have. */
export function newAvatar(taken: Avatar[], random: () => number = Math.random): Avatar {
  const others = taken.map((look) => ({ ...BASE_PEKKA, ...look }));
  let best = randomLook(random), score = -1;
  for (let i = 0; i < 48; i++) {
    const look = i ? randomLook(random) : best;
    const nearest = Math.min(...others.map((other) => difference(look, other)));
    if (nearest > score) [best, score] = [look, nearest];
  }
  return best;
}
