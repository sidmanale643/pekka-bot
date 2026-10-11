import { RobotSim, restPose, linear, makeCanvas, parseColor, subscribe, pointer } from "./robot-heads/engine.js";
import { PekkaRenderer, pekkaFrame, PEKKA, HORNS, CRESTS, EYES } from "./pekka-renderer.js";

const states = new Set(["idle", "thinking", "searching", "listening", "speaking", "working", "happy", "error", "sleeping"]);
const pick = (value, options, fallback) => (options.includes(value) ? value : fallback);
const lighten = (rgb, amount) => rgb.map((channel) => channel + (255 - channel) * amount);
const stills = new Map();
const stillRenderer = new PekkaRenderer();

/** <pekka-head>: Pekka's helmet, live. Attributes: state, size, paused, no-follow, armor, horns, horn-color, crest, eyes, eye-color. */
class PekkaHead extends HTMLElement {
  static observedAttributes = ["state", "size", "paused", "armor", "horns", "horn-color", "crest", "eyes", "eye-color"];

  constructor() {
    super();
    this.sim = new RobotSim(Math.random(), "idle");
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.visible = false;
    this.refresh = () => this.update();
    this.poke = () => { if (this.unsubscribe) this.sim.poke(); };
  }

  get state() { return states.has(this.getAttribute("state")) ? this.getAttribute("state") : "idle"; }
  // Frameworks such as React set it as a property.
  set state(value) { this.setAttribute("state", value); }

  get look() {
    return {
      horns: pick(this.getAttribute("horns"), Object.keys(HORNS), PEKKA.horns),
      crest: pick(this.getAttribute("crest"), CRESTS, PEKKA.crest),
      eyes: pick(this.getAttribute("eyes"), EYES, PEKKA.eyes),
    };
  }

  connectedCallback() {
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.setAttribute("aria-hidden", "true");
      this.canvas.style.cssText = "position:absolute;display:block;pointer-events:none";
      this.append(this.canvas);
    }
    this.setAttribute("role", "img");
    this.style.position = "relative";
    this.style.display = "block";
    this.style.flex = "none";
    this.motion.addEventListener("change", this.refresh);
    this.addEventListener("click", this.poke);
    this.preferences = new MutationObserver(this.refresh);
    this.preferences.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    this.visibility = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.update();
    });
    this.visibility.observe(this);
    this.update();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.visibility.disconnect();
    this.preferences.disconnect();
    this.motion.removeEventListener("change", this.refresh);
    this.removeEventListener("click", this.poke);
  }

  attributeChangedCallback() { if (this.isConnected && this.canvas) this.update(); }

  update() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sim.setState(this.state);
    this.setAttribute("aria-label", `Pekka, ${this.state}`);
    const size = Math.min(512, Math.max(16, Number(this.getAttribute("size")) || 42));
    this.style.width = this.style.height = `${size}px`;
    this.lookNow = this.look;
    this.frame = pekkaFrame(this.lookNow, size);
    const armor = parseColor(this.getAttribute("armor") || "") || parseColor(PEKKA.armor);
    this.palette = {
      shell: { albedo: linear(armor), f0: 0.05, metal: 0.3, spec: 0.6, shininess: 60, rim: 0.9 },
      ridge: { albedo: linear(lighten(armor, 0.14)), f0: 0.05, metal: 0.3, spec: 0.6, shininess: 60, rim: 0.9 },
      horn: { albedo: linear(parseColor(this.getAttribute("horn-color") || "") || parseColor(PEKKA.hornColor)), f0: 0.08, metal: 0.2, spec: 0.75, shininess: 48, rim: 0.8 },
      led: parseColor(this.getAttribute("eye-color") || "") || parseColor(PEKKA.eyeColor),
    };
    const f = this.frame;
    Object.assign(this.canvas.style, {
      left: `${-f.padSide}px`, top: `${-f.padTop}px`,
      width: `${f.box + 2 * f.padSide}px`, height: `${f.box + f.padTop + f.padBottom}px`,
    });
    const still = !this.visible || this.motion.matches || this.hasAttribute("paused") || document.documentElement.classList.contains("reduce-motion");
    // A head moved to a new spot carries on from its current pose rather than flashing its resting one.
    this.paint(!still && this.sim.age > 0);
    if (still) return;
    // Heads in lists are small enough that 30 frames a second looks the same and costs half.
    const everyOther = size < 48;
    this.unsubscribe = subscribe((dt) => {
      this.sim.pointer = null;
      // A head watches the pointer when it's near, unless it has no-follow and keeps to its own glances.
      if (!this.hasAttribute("no-follow")) {
        const box = this.getBoundingClientRect();
        const dx = pointer.x - (box.left + box.width / 2);
        const dy = pointer.y - (box.top + this.frame.cy - this.frame.padTop);
        if (Math.hypot(dx, dy) < 700) this.sim.pointer = { x: dx, y: dy };
      }
      this.sim.update(dt);
      this.odd = !this.odd;
      if (!everyOther || this.odd) this.paint(true);
    });
  }

  paint(animated) {
    const f = this.frame;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const width = Math.round((f.box + 2 * f.padSide) * dpr);
    const height = Math.round((f.box + f.padTop + f.padBottom) * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const context = this.canvas.getContext("2d");
    if (!context) return;
    if (animated) {
      this.renderer ??= new PekkaRenderer();
      this.renderer.draw(context, f, dpr, this.sim.pose, this.sim, this.state, this.lookNow, this.palette, { floorShadow: f.box >= 64 });
      return;
    }
    // A still head looks the same as every other with its look, state and size, as in a chat's message list:
    // it's drawn once and copied.
    const key = JSON.stringify([this.lookNow, this.palette.led, this.getAttribute("armor"), this.getAttribute("horn-color"), this.state, f.box, dpr]);
    let frame = stills.get(key);
    if (!frame) {
      // An idle head faces straight on. The engine's idle pose turns it a little, which only looks right while it moves.
      const pose = this.state === "idle" ? { ...restPose("idle"), yaw: 0, pitch: 0, roll: 0 } : restPose(this.state);
      stillRenderer.draw(context, f, dpr, pose, null, this.state, this.lookNow, this.palette, { floorShadow: f.box >= 64 });
      frame = makeCanvas(width, height);
      frame.getContext("2d").drawImage(this.canvas, 0, 0);
      if (stills.size >= 200) stills.delete(stills.keys().next().value);
      stills.set(key, frame);
      return;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.drawImage(frame, 0, 0);
  }
}

customElements.define("pekka-head", PekkaHead);
