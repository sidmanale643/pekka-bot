import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/dompurify.js";

const $ = (selector) => document.querySelector(selector);
const storageKey = "pekka.task-history.v1";
const profileKey = "pekka.profile.v1";
const preferencesKey = "pekka.preferences.v1";
const profileDefaults = { displayName: "", occupation: "", bio: "" };
const preferenceDefaults = { enterToSend: true, compact: false, reduceMotion: false };
// The signed-in Google account, or null when the server runs without sign-in.
let account = null;
let profile = { ...profileDefaults };
let preferences = { ...preferenceDefaults };
let currentPage = "workspace";
let bots = [];
let selected;
let history = Object.create(null);
const running = new Set();
const drafts = new Map();
const unread = new Set();
let loaded = false;
let notionPlugin;
let githubPlugin;
let gmailPlugin;
let telegramPlugin;
let telegramLink;
let telegramPoll;
let pluginsBusy = false;

// Each account keeps its own browser storage, so people sharing a browser
// don't see each other's history. The owner keeps what was saved before sign-in.
function scoped(key) {
  return account && account.id !== "local" ? `${key}:${account.id}` : key;
}

function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(scoped(storageKey)) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      return Object.create(null);
    return Object.assign(
      Object.create(null),
      Object.fromEntries(
        Object.entries(value)
          .filter(([, entries]) => Array.isArray(entries))
          .map(([key, entries]) => [
            key,
            entries
              .filter(
                (entry) =>
                  entry &&
                  typeof entry.text === "string" &&
                  ["user", "assistant", "error"].includes(entry.role),
              )
              .map((entry) => ({
                ...entry,
                pending: false,
                status: entry.pending
                  ? "Connection ended. The task may still be running."
                  : typeof entry.status === "string" ? entry.status : "",
              })),
          ]),
      ),
    );
  } catch {
    return Object.create(null);
  }
}

function persist() {
  try {
    localStorage.setItem(scoped(storageKey), JSON.stringify(history));
  } catch {
    notify(
      "Browser storage is unavailable or full. Task history cannot be saved.",
    );
  }
}

function notify(message) {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 401) showSignIn("Your session ended. Sign in again to continue.");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return response.json();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const avatarColors = ["#151515", "#2a3cf0", "#e4572e", "#f2b134", "#3f8f5f", "#f2a7b8", "#8fb8e8", "#f8f8f5"];
// Bauhaus tiles drawn in a 20×20 cell; each avatar is a 2×2 grid of them.
const avatarTiles = [
  "M0 0H20A20 20 0 0 1 0 20Z",
  "M0 20A10 10 0 0 1 20 20Z",
  "M0 0H20L0 20Z",
  "M3 10a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z",
  "M0 0H20V20H0Z",
  "M0 0H20V8H0Z",
];

// Seeds a PRNG (FNV-1a into mulberry32) from the name so a bot always gets the same avatar.
function avatarRandom(name) {
  let seed = 2166136261;
  for (const char of name.toLowerCase())
    seed = Math.imul(seed ^ char.codePointAt(0), 16777619);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function avatar(name, size) {
  const random = avatarRandom(name);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "avatar");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  const shape = (d, fill, transform) => {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", fill);
    if (transform) path.setAttribute("transform", transform);
    svg.append(path);
  };
  const background = pick(avatarColors);
  const others = avatarColors.filter((color) => color !== background);
  const first = pick(others);
  const inks = [first, pick(others.filter((color) => color !== first))];
  shape("M0 0H40V40H0Z", background);
  for (const [x, y] of [[0, 0], [20, 0], [0, 20], [20, 20]])
    shape(
      pick(avatarTiles),
      pick(inks),
      `translate(${x} ${y}) rotate(${Math.floor(random() * 4) * 90} 10 10)`,
    );
  return svg;
}

function entries(bot) {
  return history[bot.name.toLowerCase()] || [];
}

function botRow(bot) {
  const button = element(
    "button",
    `bot-row${selected === bot && currentPage === "workspace" ? " active" : ""}`,
  );
  button.setAttribute("aria-current", selected === bot && currentPage === "workspace" ? "true" : "false");
  const copy = element("span", "bot-copy");
  const preview = running.has(bot.name)
    ? "Running…"
    : entries(bot).at(-1)?.text || bot.role;
  copy.append(element("strong", "", bot.name), element("small", "", preview));
  button.append(avatar(bot.name, 28), copy);
  if (running.has(bot.name)) {
    const state = element("span", "bot-state running");
    state.title = "Running";
    button.append(state);
  } else if (unread.has(bot.name)) {
    const state = element("span", "bot-state");
    state.title = "New result";
    button.append(state);
  }
  button.addEventListener("click", () => selectBot(bot));
  const row = element("div", "bot-list-item");
  const edit = element("button", "icon-button bot-edit");
  edit.type = "button";
  edit.title = `Edit ${bot.name}`;
  edit.setAttribute("aria-label", `Edit ${bot.name}`);
  edit.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m12.5 3.5 4 4M3 17l4.5-1 9-9a2.8 2.8 0 0 0-4-4l-9 9L3 17Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>';
  edit.addEventListener("click", () => {
    selectBot(bot);
    $("#details-dialog").showModal();
    showDetails("purpose", bot);
  });
  row.append(button, edit);
  return row;
}

function renderBots() {
  const list = $("#bot-list");
  list.replaceChildren();
  const query = $("#search").value.toLowerCase();
  const filtered = bots.filter((bot) =>
    `${bot.name} ${bot.role}`.toLowerCase().includes(query),
  );
  $("#bot-count").textContent = bots.length;
  for (const bot of filtered) list.append(botRow(bot));
  if (bots.length && !filtered.length)
    list.append(element("p", "empty-list", "No bots match."));
}

function selectBot(bot) {
  const hash = "#bot/" + encodeURIComponent(bot.name);
  if (location.hash !== hash) {
    location.hash = hash;
    return;
  }
  currentPage = "workspace";
  document.title = `${bot.name} — Pekka`;
  $("#pages").hidden = true;
  $("#scheduled").hidden = true;
  updateNavigation();
  if (selected) drafts.set(selected.name, $("#task").value);
  selected = bot;
  unread.delete(bot.name);
  closeDrawer();
  $("#welcome").hidden = true;
  $("#conversation").hidden = false;
  $("#details").hidden = false;
  $("#heading").replaceChildren(
    avatar(bot.name, 22),
    element("strong", "", bot.name),
    element("span", "", bot.role),
  );
  $("#task").value = drafts.get(bot.name) || "";
  $("#task").placeholder = `Message ${bot.name}…`;
  updateComposer();
  renderBots();
  renderTranscript(true);
}

function linkedText(node, text) {
  const pattern =
    /\[([^\]\n]+)\]\((https?:\/\/[^\s<>]+?)\)|https?:\/\/[^\s<>]+/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    node.append(document.createTextNode(text.slice(offset, match.index)));
    const raw = match[2] || match[0];
    const url = match[2] ? raw : raw.replace(/[.,;:!?\])]+$/, "");
    const link = element("a", "", match[1] || url);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    node.append(link, document.createTextNode(raw.slice(url.length)));
    offset = match.index + match[0].length;
  }
  node.append(document.createTextNode(text.slice(offset)));
}

function renderMessage(message) {
  const body = element("div", "message-body");
  const text = message.text;
  if (message.role === "user") {
    linkedText(body, text);
    return body;
  }
  body.classList.add("markdown");
  body.innerHTML = DOMPurify.sanitize(
    marked.parse(text, { gfm: true, async: false }),
    {
      ALLOWED_TAGS: [
        "p",
        "br",
        "hr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "strong",
        "em",
        "del",
        "blockquote",
        "ul",
        "ol",
        "li",
        "pre",
        "code",
        "a",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "input",
      ],
      ALLOWED_ATTR: [
        "href",
        "title",
        "class",
        "start",
        "align",
        "type",
        "checked",
        "disabled",
      ],
    },
  );
  for (const link of body.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  for (const input of body.querySelectorAll("input")) {
    input.type = "checkbox";
    input.disabled = true;
  }
  return body;
}

const greetingsKey = "pekka.greetings.v1";
const greetingTtl = 6 * 60 * 60 * 1000;
// Greetings cost a model call, so they are reused for a few hours unless the bot changes.
const greetings = new Map();
const greetingRequests = new Set();

function greetingFor(bot) {
  const cached = greetings.get(bot.name.toLowerCase());
  const signature = `${bot.role}\n${bot.job}`;
  if (cached?.signature === signature && Date.now() - cached.time < greetingTtl) return cached;
}

function forgetGreeting(bot) {
  greetings.delete(bot.name.toLowerCase());
  saveGreetings();
}

function saveGreetings() {
  try {
    const value = Object.fromEntries([...greetings].filter(([, item]) => !item.fallback));
    localStorage.setItem(scoped(greetingsKey), JSON.stringify({ value }));
  } catch {}
}

async function loadGreeting(bot) {
  const key = bot.name.toLowerCase();
  if (greetingRequests.has(key)) return;
  greetingRequests.add(key);
  const base = { signature: `${bot.role}\n${bot.job}`, time: Date.now() };
  try {
    const data = await api(`/api/bots/${encodeURIComponent(bot.name)}/greeting`);
    greetings.set(key, { ...base, message: data.message, suggestions: data.suggestions });
  } catch {
    greetings.set(key, {
      ...base,
      fallback: true,
      message: bot.job ? `Hi, I'm ${bot.name}. What would you like me to work on?` : `Hi, I'm ${bot.name}. Tell me a little about yourself and what you'd like help with.`,
      suggestions: [],
    });
  } finally {
    greetingRequests.delete(key);
    saveGreetings();
    if (selected === bot && currentPage === "workspace" && !entries(bot).length) renderTranscript();
  }
}

function suggestion(text, label) {
  const button = element("button", "suggestion");
  button.type = "button";
  if (label) button.append(element("span", "suggestion-label", label));
  button.append(element("span", "suggestion-text", text));
  button.addEventListener("click", () => sendTask(text));
  return button;
}

function chatIntro(bot) {
  const greeting = greetingFor(bot);
  if (!greeting) loadGreeting(bot);
  const intro = element("div", "chat-intro");
  const hero = element("div", "intro-hero");
  const copy = element("div", "");
  copy.append(element("h2", "", bot.name), element("p", "role", bot.role));
  hero.append(avatar(bot.name, 56), copy);

  const message = element("article", "message assistant greeting");
  const meta = element("div", "message-meta");
  meta.append(avatar(bot.name, 18), element("strong", "", bot.name));
  message.append(meta);
  if (greeting) message.append(renderMessage({ role: "assistant", text: greeting.message }));
  else {
    const typing = element("div", "typing");
    typing.setAttribute("aria-label", `${bot.name} is writing`);
    typing.append(element("span", ""), element("span", ""), element("span", ""));
    message.append(typing);
  }

  const list = element("div", "suggestions");
  list.hidden = Boolean(greeting && !greeting.suggestions.length);
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Suggested tasks");
  if (greeting) for (const text of greeting.suggestions) list.append(suggestion(text));
  else list.append(element("div", "suggestion placeholder"), element("div", "suggestion placeholder"));

  intro.append(hero, message, list);
  if (greeting?.suggestions.length) {
    const refresh = element("button", "button ghost small refresh-ideas", "More ideas");
    refresh.type = "button";
    refresh.addEventListener("click", () => {
      forgetGreeting(bot);
      renderTranscript();
    });
    intro.append(refresh);
  }
  return intro;
}

function renderTranscript(forceScroll = false) {
  const transcript = $("#transcript");
  const nearBottom =
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
    100;
  const messages = entries(selected);
  transcript.replaceChildren();
  if (!messages.length) transcript.append(chatIntro(selected));
  for (const message of messages) {
    const row = element("article", `message ${message.role}`);
    const time = new Date(message.time).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const meta = element("div", "message-meta");
    if (message.role !== "user") meta.append(avatar(selected.name, 18));
    meta.append(
      element(
        "strong",
        "",
        message.role === "user" ? profile.displayName || "You" : selected.name,
      ),
      element("time", "", time),
    );
    row.append(meta);
    if (message.text) row.append(renderMessage(message));
    for (const request of message.permissions ?? []) row.append(permissionCard(request, message));
    if (message.status)
      row.append(
        element(
          "div",
          `run-status${message.pending ? " live" : ""}`,
          message.status,
        ),
      );
    transcript.append(row);
  }
  if (forceScroll || nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

function updateComposer() {
  const busy = running.has(selected.name);
  $("#send").disabled = busy;
  $("#send").textContent = busy ? "Running" : "Send";
  $("#task").style.height = "auto";
  $("#task").style.height = `${Math.min($("#task").scrollHeight, 200)}px`;
}

function applyEvent(event, data, message) {
  const handlers = {
    permission_requested: () => {
      message.permissions ??= [];
      message.permissions.push(data.request);
      message.status = "Waiting for your permission…";
    },
    permission_resolved: () => {
      const request = message.permissions?.find((request) => request.id === data.id);
      if (request) request.decision = data.approved ? "Approved once" : "Denied or expired";
      message.status = data.approved ? "Permission approved; continuing…" : "Permission denied; continuing…";
    },
    message_delta: () => {
      message.text += data.text;
    },
    message: () => {
      message.text = data.text;
    },
    step: () => {
      message.status = "Working…";
    },
    tool_call: () => {
      message.status = `Using ${data.name}…`;
    },
    tool_result: () => {
      message.status = data.isError
        ? `${data.name} reported an error; continuing…`
        : `Finished ${data.name}`;
    },
    result: () => {
      message.text =
        data.answer || message.text || "Task finished without a text response.";
      message.status =
        data.status === "done" ? "" : `Run ended: ${data.status}`;
      if (data.usage) {
        const { promptTokens, completionTokens, cacheHitRate, costUsd } = data.usage;
        const cache = cacheHitRate == null ? "unavailable" : `${(cacheHitRate * 100).toFixed(1)}%`;
        const metrics = `${promptTokens.toLocaleString()} input tokens · ${completionTokens.toLocaleString()} output tokens · Cache hit rate: ${cache} · $${costUsd.toFixed(4)}`;
        message.status = [message.status, metrics].filter(Boolean).join(" · ");
      }
    },
    error: () => {
      throw new Error(data.error || "Task execution failed.");
    },
  };
  handlers[event]?.();
}

function permissionCard(request, message) {
  const card = element("section", "permission-card");
  card.setAttribute("aria-label", "Permission review");
  card.append(element("strong", "", request.plugin ? `${request.plugin}: permission required` : "Permission required"));
  card.append(element("p", "", request.reason));
  card.append(element("code", "", request.tool));
  card.append(element("pre", "permission-arguments", JSON.stringify(request.arguments, null, 2)));
  const expired = Date.parse(request.expiresAt) <= Date.now();
  if (request.decision || expired || !message.pending) {
    card.append(element("p", "", request.decision || "Expired or run disconnected"));
    return card;
  }
  card.append(element("p", "muted", "Review the exact arguments. Approval applies once and expires after five minutes."));
  const actions = element("div", "permission-actions");
  for (const [label, approved] of [["Deny", false], ["Approve once", true]]) {
    const button = element("button", "", label);
    button.type = "button";
    button.disabled = Boolean(request.submitting);
    button.addEventListener("click", async () => {
      request.submitting = true;
      request.error = "";
      renderTranscript();
      try {
        await api(`/api/permissions/${encodeURIComponent(request.id)}`, { method: "POST", body: JSON.stringify({ approved }) });
        request.decision = approved ? "Approved once" : "Denied";
      } catch (error) {
        request.error = error.message;
      } finally {
        request.submitting = false;
        renderTranscript();
      }
    });
    actions.append(button);
  }
  card.append(actions);
  if (request.error) card.append(element("p", "", request.error));
  return card;
}

function parseEvent(frame) {
  const lines = frame.split("\n");
  const event = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!event || !data) return;
  return { event, data: JSON.parse(data) };
}

async function consumeStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        const parsed = parseEvent(frame);
        if (!parsed) continue;
        onEvent(parsed.event, parsed.data);
        if (parsed.event === "result") finished = true;
      }
      if (done) break;
    }
    if (!finished)
      throw new Error(
        "Connection ended before a result arrived. The task may still be running.",
      );
  } finally {
    reader.releaseLock();
  }
}

async function sendTask(task) {
  const bot = selected;
  if (!task.trim() || running.has(bot.name)) return;
  const key = bot.name.toLowerCase();
  history[key] ||= [];
  const conversation = history[key]
    .filter((entry) => ["user", "assistant"].includes(entry.role) && !entry.pending && entry.text.trim())
    .slice(-20)
    .map((entry) => ({ role: entry.role, content: entry.text.slice(0, 4000) }));
  if (!conversation.length && greetingFor(bot)) conversation.push({ role: "assistant", content: greetingFor(bot).message });
  const message = {
    role: "assistant",
    text: "",
    time: Date.now(),
    pending: true,
    status: "Starting…",
  };
  history[key].push(
    { role: "user", text: task.trim(), time: Date.now() },
    message,
  );
  running.add(bot.name);
  $("#task").value = "";
  drafts.delete(bot.name);
  persist();
  updateComposer();
  renderBots();
  renderTranscript(true);
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ botName: bot.name, task: task.trim(), conversation }),
    });
    if (response.status === 401) showSignIn("Your session ended. Sign in again to continue.");
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Unable to start this task.");
    }
    await consumeStream(response, (event, data) => {
      applyEvent(event, data, message);
      if (selected === bot) renderTranscript();
    });
  } catch (error) {
    message.role = "error";
    message.text = [message.text, error.message].filter(Boolean).join("\n\n");
    message.status = "";
  } finally {
    message.pending = false;
    try {
      const updated = await api(`/api/bots/${encodeURIComponent(bot.name)}`);
      if (updated.role !== bot.role || updated.job !== bot.job) forgetGreeting(bot);
      Object.assign(bot, updated);
    } catch {}
    running.delete(bot.name);
    if (selected !== bot || currentPage !== "workspace") unread.add(bot.name);
    if (currentPage === "activity") renderActivity();
    persist();
    renderBots();
    if (selected === bot) {
      $("#heading").replaceChildren(avatar(bot.name, 22), element("strong", "", bot.name), element("span", "", bot.role));
      renderTranscript();
      updateComposer();
    }
  }
}

const templates = {
  research: {
    name: "Research Scout",
    description: "Help me research topics and find authoritative sources.",
  },
  build: {
    name: "Builder",
    description: "Help turn my ideas into working software.",
  },
  review: {
    name: "Fresh Eyes",
    description: "Review my work and suggest focused improvements.",
  },
};

for (const [key, template] of Object.entries(templates)) {
  const button = element("button", "");
  button.dataset.template = key;
  button.append(
    element("strong", "", template.name),
    element("span", "", template.description),
  );
  $("#templates").append(button);
}

function openCreate(template) {
  $("#create-form").reset();
  $("#create-error").textContent = "";
  if (template)
    for (const [name, value] of Object.entries(template))
      $("#create-form").elements[name].value = value;
  $("#create-dialog").showModal();
}

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#create-submit").disabled = true;
  $("#create-error").textContent = "";
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const bot = await api("/api/bots", {
      method: "POST",
      body: JSON.stringify(input),
    });
    bots.push(bot);
    $("#search").value = "";
    $("#create-dialog").close();
    selectBot(bot);
  } catch (error) {
    $("#create-error").textContent = error.message;
  } finally {
    $("#create-submit").disabled = false;
  }
});

async function saveBotProfile(bot, form, status) {
  for (const button of form.querySelectorAll("button")) button.disabled = true;
  status.textContent = "Saving…";
  try {
    const oldName = bot.name;
    const updated = await api(`/api/bots/${encodeURIComponent(oldName)}`, { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    history[updated.name.toLowerCase()] = entries(bot);
    if (oldName.toLowerCase() !== updated.name.toLowerCase()) delete history[oldName.toLowerCase()];
    drafts.set(updated.name, drafts.get(oldName) || $("#task").value);
    if (oldName !== updated.name) drafts.delete(oldName);
    forgetGreeting(bot);
    Object.assign(bot, updated);
    persist();
    window.history.replaceState(null, "", "#bot/" + encodeURIComponent(bot.name));
    selectBot(bot);
    $("#detail-name").replaceChildren(avatar(bot.name, 24), bot.name);
    status.textContent = "Changes saved.";
  } catch (error) { status.textContent = error.message; }
  finally { for (const button of form.querySelectorAll("button")) button.disabled = false; }
}

async function removeBotProfile(bot, form, status) {
  if (!window.confirm(`Delete ${bot.name}? Upcoming schedules will be cancelled. Sandbox files and saved memory will be retained.`)) return;
  for (const button of form.querySelectorAll("button")) button.disabled = true;
  status.textContent = "Deleting…";
  try {
    await api(`/api/bots/${encodeURIComponent(bot.name)}`, { method: "DELETE" });
    bots = bots.filter((item) => item.id !== bot.id);
    drafts.delete(bot.name);
    unread.delete(bot.name);
    forgetGreeting(bot);
    selected = undefined;
    $("#details-dialog").close();
    window.history.replaceState(null, "", "#workspace");
    renderBots();
    route();
  } catch (error) { status.textContent = error.message; }
  finally { for (const button of form.querySelectorAll("button")) button.disabled = false; }
}

let detailsVersion = 0;
async function showDetails(tab = "purpose", bot = selected) {
  const version = ++detailsVersion;
  $("#detail-name").replaceChildren(avatar(bot.name, 24), bot.name);
  const content = $("#detail-content");
  content.replaceChildren(element("p", "loading", "Loading…"));
  document
    .querySelectorAll("[data-tab]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.tab === tab),
    );
  const panel = element("div", "");
  try {
    await detailViews[tab](panel, bot);
    if (version === detailsVersion) content.replaceChildren(panel);
  } catch (error) {
    if (version === detailsVersion)
      content.replaceChildren(element("p", "error", error.message));
  }
}

// Replaced by the server's list on load; Normal and Custom keep the form usable until then.
let characterPresets = [
  { id: "normal", name: "Normal" },
  { id: "custom", name: "Custom" },
];

function characterFields(value = { preset: "normal", name: "", description: "" }) {
  const fields = element("div", "character-fields");
  const label = element("label", "", "Character");
  const select = element("select", "");
  select.name = "preset";
  for (const preset of characterPresets) {
    const option = element("option", "", preset.name);
    option.value = preset.id;
    select.append(option);
  }
  select.value = value.preset;
  label.append(select);
  const custom = element("div", "character-custom");
  const nameLabel = element("label", "", "Character name");
  const name = element("input", "");
  // "name" is taken by the bot's own name in the create form.
  name.name = "characterName";
  name.maxLength = 100;
  name.placeholder = "e.g. Nova (optional)";
  name.value = value.name ?? "";
  nameLabel.append(name);
  const descriptionLabel = element("label", "", "Custom character");
  const description = element("textarea", "");
  description.name = "description";
  description.maxLength = 2000;
  description.rows = 3;
  description.placeholder = "Describe the character, tone and mannerisms…";
  description.value = value.description;
  descriptionLabel.append(description);
  custom.append(nameLabel, descriptionLabel);
  const hint = element("p", "muted");
  const update = () => {
    custom.hidden = select.value !== "custom";
    description.required = select.value === "custom";
    description.disabled = name.disabled = select.value !== "custom";
    const preset = characterPresets.find(({ id }) => id === select.value);
    hint.textContent = ["normal", "custom"].includes(select.value)
      ? "Shapes conversation style. Your tasks and instructions still come first."
      : `${preset.description} Same capabilities, ${preset.name}'s mannerisms.`;
  };
  select.addEventListener("change", update);
  update();
  fields.append(label, hint, custom);
  return fields;
}

const detailViews = {
  character: async (panel, bot) => {
    const path = `/api/bots/${encodeURIComponent(bot.name)}/character`;
    const form = element("form", "");
    form.append(characterFields(await api(path)));
    const save = element("button", "button primary", "Save character");
    const status = element("p", "form-status");
    status.setAttribute("role", "status");
    form.append(save, status);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        const { preset, characterName, description } = Object.fromEntries(new FormData(form));
        await api(path, {
          method: "PUT",
          body: JSON.stringify({ preset, name: characterName, description }),
        });
        forgetGreeting(bot);
        status.textContent = "Saved. Applies from the next task, including scheduled runs.";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    panel.append(form);
  },
  purpose: async (panel, bot) => {
    const form = element("form", "");
    for (const [name, title] of [["name", "Name"], ["role", "Description"], ["job", "Working instructions"]]) {
      const label = element("label", "", title);
      const input = element(name === "name" ? "input" : "textarea", "");
      input.name = name;
      input.value = bot[name];
      input.required = name !== "job";
      input.maxLength = name === "name" ? 200 : 100000;
      if (name === "job") input.rows = 4;
      label.append(input);
      form.append(label);
    }
    const status = element("p", "muted");
    status.setAttribute("role", "status");
    const actions = element("div", "form-actions");
    const save = element("button", "button primary", "Save changes");
    const remove = element("button", "button secondary", "Delete bot");
    remove.type = "button";
    actions.append(save, remove);
    form.append(actions, status, element("p", "muted", "Deleting cancels upcoming schedules and removes this bot from Pekka. Sandbox files and saved memory are retained."));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveBotProfile(bot, form, status);
    });
    remove.addEventListener("click", () => removeBotProfile(bot, form, status));
    panel.append(form);
  },
  memory: async (panel, bot) => {
    for (const file of ["PREFERENCES.md", "KNOWLEDGE.md"]) {
      const path = `/api/bots/${encodeURIComponent(bot.name)}/memory/${file}`;
      const data = await api(path);
      const section = element("div", "memory-file");
      const label = element("label", "", file);
      const input = element("textarea", "");
      input.rows = 7;
      input.value = data.content;
      input.maxLength = 900000;
      input.spellcheck = false;
      label.append(input);
      const actions = element("div", "form-actions");
      const save = element("button", "button secondary small", "Save");
      const status = element("span", "form-status");
      status.setAttribute("role", "status");
      input.addEventListener("input", () => {
        status.textContent = "Unsaved changes";
      });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await api(path, {
            method: "PUT",
            body: JSON.stringify({ content: input.value }),
          });
          forgetGreeting(bot);
          status.textContent = "Saved";
        } catch (error) {
          status.textContent = error.message;
        } finally {
          save.disabled = false;
        }
      });
      actions.append(status, save);
      section.append(label, actions);
      panel.append(section);
    }
  },
  skills: async (panel, bot) => {
    const data = await api(`/api/bots/${encodeURIComponent(bot.name)}/skills`);
    if (!data.skills.length)
      panel.append(
        element(
          "p",
          "detail-note",
          "No skills yet. Add one with pnpm pekka skills add <folder>. Skills are shared by every bot unless added with --bot.",
        ),
      );
    const list = element("div", "detail-list");
    for (const skill of data.skills) {
      const row = element("div", "detail-row");
      row.append(
        element("h3", "", skill.name),
        element("p", "", skill.description),
      );
      list.append(row);
    }
    if (data.skills.length) panel.append(list);
    for (const error of data.errors) panel.append(element("p", "error", error));
  },
  schedules: async (panel, bot) => {
    const data = await api("/api/jobs");
    const botJobs = data.jobs.filter(
      (job) => job.bot?.name.toLowerCase() === bot.name.toLowerCase(),
    );
    panel.append(
      element(
        "p",
        "detail-note",
        botJobs.length
          ? "Scheduled tasks run only while the local scheduler is running."
          : "No scheduled tasks. Create one here or ask this bot to schedule one; it runs while the local scheduler is running.",
      ),
    );
    const create = element("a", "button secondary small", "New scheduled task");
    create.href = "#scheduled/new";
    create.addEventListener("click", () => { scheduleDraft = { botName: bot.name }; });
    panel.append(create);
    const list = element("div", "detail-list");
    for (const job of botJobs) {
      const row = element("a", "detail-row schedule-link");
      row.href = "#scheduled/" + encodeURIComponent(job.id);
      const title = element("h3", "", job.name);
      title.append(element("span", "", statusLabels[job.status] || job.status));
      row.append(title);
      if (job.nextRunAt)
        row.append(
          element("p", "", `Next run ${new Date(job.nextRunAt).toLocaleString()}`),
        );
      if (job.lastError) row.append(element("p", "error", job.lastError));
      list.append(row);
    }
    if (botJobs.length) panel.append(list);
  },
};

const mobileSidebar = window.matchMedia("(max-width: 600px)");

function sidebarExpanded() {
  return mobileSidebar.matches
    ? $("#sidebar").classList.contains("open")
    : !$("#sidebar").classList.contains("collapsed");
}

function syncSidebarToggle() {
  const expanded = sidebarExpanded();
  $("#menu").setAttribute("aria-expanded", String(expanded));
  $("#menu").title = expanded ? "Collapse sidebar" : "Expand sidebar";
}

function setSidebarExpanded(expanded) {
  const className = mobileSidebar.matches ? "open" : "collapsed";
  $("#sidebar").classList.toggle(className, mobileSidebar.matches ? expanded : !expanded);
  syncSidebarToggle();
}

function closeDrawer() {
  $("#sidebar").classList.remove("open");
  syncSidebarToggle();
}

mobileSidebar.addEventListener("change", closeDrawer);
syncSidebarToggle();

$("#new-bot").addEventListener("click", () => openCreate());
$("#welcome-create").addEventListener("click", () => openCreate());
$("#search").addEventListener("input", renderBots);
$("#menu").addEventListener("click", () =>
  setSidebarExpanded(!sidebarExpanded()),
);
$("main").addEventListener("click", (event) => {
  if (!event.target.closest("#menu")) closeDrawer();
});
$("#task").addEventListener("input", updateComposer);
$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  sendTask($("#task").value);
});
$("#task").addEventListener("keydown", (event) => {
  if (preferences.enterToSend && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendTask($("#task").value);
  }
});
$("#details").addEventListener("click", () => {
  $("#details-dialog").showModal();
  showDetails();
});
document
  .querySelectorAll("[data-tab]")
  .forEach((button) =>
    button.addEventListener("click", () => showDetails(button.dataset.tab)),
  );
document
  .querySelectorAll("[data-template]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      openCreate(templates[button.dataset.template]),
    ),
  );
document
  .querySelectorAll(".close-dialog")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.target.matches("input,textarea") &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    setSidebarExpanded(true);
    $("#search").focus();
  }
  if (event.key === "Escape") closeDrawer();
});
window.addEventListener("beforeunload", (event) => {
  if (running.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function initialize() {
  try {
    const [data, presets] = await Promise.all([
      api("/api/bots"),
      api("/api/characters"),
    ]);
    bots = data.bots;
    characterPresets = presets.characters;
    loaded = true;
    renderBots();
    route();
  } catch (error) {
    notify(`Could not load bots: ${error.message} Reload to try again.`);
  }
}

function loadLocal(key, defaults) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    const result = { ...defaults };
    for (const name of Object.keys(defaults)) {
      if (typeof value?.[name] === typeof defaults[name]) result[name] = value[name];
    }
    return result;
  } catch {
    return { ...defaults };
  }
}

function saveLocal(key, value, form) {
  const status = form.querySelector('.form-status');
  try {
    localStorage.setItem(key, JSON.stringify(value));
    status.textContent = "Saved in this browser.";
    return true;
  } catch {
    status.textContent = "Could not save. Browser storage is unavailable or full.";
    return false;
  }
}

function renderProfile() {
  const name = profile.displayName || account?.name || "";
  $("#profile-label").textContent = name || "Profile";
  $("#profile-initial").textContent = (name || "You").slice(0, 1).toUpperCase();
}

/** Reads this account's profile, preferences, history and cached greetings from browser storage. */
function loadBrowserState() {
  profile = loadLocal(scoped(profileKey), profileDefaults);
  preferences = loadLocal(scoped(preferencesKey), preferenceDefaults);
  history = loadHistory();
  greetings.clear();
  for (const [key, value] of Object.entries(loadLocal(scoped(greetingsKey), { value: {} }).value || {})) greetings.set(key, value);
  for (const [name, value] of Object.entries(profile)) $("#profile-form").elements[name].value = value;
  for (const [name, value] of Object.entries(preferences)) $("#settings-form").elements[name].checked = value;
}

const signInErrors = {
  denied: "Sign-in was cancelled. You can try again whenever you're ready.",
  forbidden: "That Google account isn't allowed to use this Pekka server. Ask its owner to add your email address.",
  error: "Sign-in didn't work. Please try again.",
};

function showSignIn(message = "") {
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("#app").hidden = true;
  $("#sign-in").hidden = false;
  $("#sign-in-error").textContent = message;
  document.title = "Sign in — Pekka";
}

function renderAccount() {
  $("#account").hidden = !account;
  $("#account-email").textContent = account?.email || "";
  $("#profile-note").textContent = account
    ? "Your display name and details only exist in this browser. Google provides your account email."
    : "There is no account or sign-in. This profile only exists in this browser.";
}

function applyPreferences() {
  document.documentElement.classList.toggle("compact", preferences.compact);
  document.documentElement.classList.toggle("reduce-motion", preferences.reduceMotion);
  $("#send-hint").textContent = preferences.enterToSend
    ? "Enter to send, Shift + Enter for a new line"
    : "Enter adds a new line";
}

function updateNavigation() {
  for (const link of document.querySelectorAll("[data-page]")) {
    if (link.dataset.page === currentPage) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function openPage(page) {
  currentPage = page;
  const titles = {
    profile: ["Profile", "Your name appears on the tasks you send. It is stored in this browser and never sent to bots."],
    settings: ["Settings", "Preferences for this browser. They apply to every bot."],
    activity: ["Activity", "Tasks sent from this browser, newest first."],
    help: ["Help", "How bots, memory and schedules work."],
    plugins: ["Plugins", "Connect your tools and choose what Pekka can access."],
  };
  $("#welcome").hidden = true;
  $("#conversation").hidden = true;
  $("#details").hidden = true;
  $("#scheduled").hidden = true;
  $("#pages").hidden = false;
  $("#pages").classList.toggle("plugin-page", page === "plugins");
  document.title = `${titles[page][0]} — Pekka`;
  $("#heading").textContent = titles[page][0];
  $("#page-title").textContent = titles[page][0];
  $("#page-description").textContent = titles[page][1];
  for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== page;
  $("#pages").scrollTop = 0;
  $(page === "plugins" ? "#plugin-page-title" : "#page-title").focus({ preventScroll: true });
  updateNavigation();
  renderBots();
  closeDrawer();
  if (page === "activity") renderActivity();
  if (page === "plugins") loadPlugins();
}

function route() {
  const page = location.hash.slice(1);
  if (["profile", "settings", "activity", "help", "plugins"].includes(page)) {
    openPage(page);
    return;
  }
  if (page === "scheduled" || page.startsWith("scheduled/")) {
    let view = "";
    try { view = decodeURIComponent(page.slice("scheduled/".length)); } catch {}
    openScheduled(view);
    return;
  }
  let botName = "";
  try { botName = decodeURIComponent(page.replace(/^bot\//, "")); } catch {}
  const bot = bots.find((item) => item.name === botName) || selected || bots[0];
  if (bot) {
    window.history.replaceState(null, "", "#bot/" + encodeURIComponent(bot.name));
    selectBot(bot);
    return;
  }
  currentPage = "workspace";
  $("#pages").hidden = true;
  $("#scheduled").hidden = true;
  $("#welcome").hidden = !loaded;
  $("#conversation").hidden = true;
  $("#details").hidden = true;
  $("#heading").textContent = loaded ? "Bots" : "";
  updateNavigation();
  closeDrawer();
}

function renderPlugins() {
  const connected = Boolean(notionPlugin?.connected);
  const configured = Boolean(notionPlugin?.configured);
  $("#notion-card").setAttribute("aria-busy", String(pluginsBusy));
  $("#notion-state").textContent = !notionPlugin ? (pluginsBusy ? "Loading…" : "Unavailable") : connected ? (notionPlugin.enabled ? "Access enabled" : "Access off") : configured ? "Not connected" : "Setup required";
  $("#notion-state").classList.toggle("enabled", connected && notionPlugin.enabled);
  $("#notion-setup").hidden = !notionPlugin || configured;
  $("#notion-workspace").hidden = !connected;
  $("#notion-workspace").textContent = connected ? `Connected to ${notionPlugin.workspaceName || "your Notion workspace"}` : "";
  $("#notion-permission").hidden = !connected;
  if (!pluginsBusy) $("#notion-enabled").checked = connected && notionPlugin.enabled;
  $("#notion-enabled").disabled = pluginsBusy || !connected;
  $("#notion-connect").textContent = connected ? "Reconnect Notion" : "Add Notion";
  $("#notion-connect").disabled = pluginsBusy || !configured;
  $("#notion-disconnect").hidden = !connected;
  $("#notion-disconnect").disabled = pluginsBusy;
  $("#plugins-refresh").disabled = pluginsBusy;
  $("#notion-use").hidden = !connected;
  renderGmail();
  renderTelegram();
  renderGithub();
  renderPluginCatalog();
}

let pluginFilter = "all";

function renderPluginCatalog() {
  const query = $("#plugin-search").value.trim().toLowerCase();
  const installed = $("#plugin-installed");
  installed.replaceChildren();
  const connections = { notion: notionPlugin, gmail: gmailPlugin, telegram: telegramPlugin, github: githubPlugin };
  $("#plugin-count").textContent = document.querySelectorAll("[data-plugin]").length;
  let connectedCount = 0;
  let visibleCount = 0;
  for (const card of document.querySelectorAll("[data-plugin]")) {
    const id = card.dataset.plugin;
    const connected = Boolean(connections[id]?.connected);
    const title = card.querySelector("h2").textContent;
    const description = card.querySelector(".plugin-heading .muted").textContent;
    const summary = card.querySelector("summary");
    summary.querySelector(".plugin-expand").textContent = connected ? "···" : "+";
    card.hidden = (pluginFilter === "connected" && !connected) || !`${title} ${description}`.toLowerCase().includes(query);
    if (!card.hidden) visibleCount++;
    if (!connected) continue;
    connectedCount++;
    const button = element("button", "plugin-installed-link");
    button.append(card.querySelector(".plugin-icon").cloneNode(true), element("span", "", title));
    button.addEventListener("click", () => {
      pluginFilter = "all";
      $("#plugin-search").value = "";
      renderPluginCatalog();
      card.querySelector("details").open = true;
      card.scrollIntoView({ block: "nearest" });
      summary.focus({ preventScroll: true });
    });
    installed.append(button);
  }
  $("#plugin-connected-count").textContent = connectedCount;
  $("#plugin-installed-empty").hidden = connectedCount > 0;
  $("#plugin-search-empty").hidden = visibleCount > 0;
  $("#plugin-search-empty h2").textContent = pluginFilter === "connected" && !query ? "No connected plugins yet" : "No plugins found";
  for (const group of document.querySelectorAll(".plugin-group")) {
    group.hidden = ![...group.querySelectorAll("[data-plugin]")].some((card) => !card.hidden);
  }
  for (const button of document.querySelectorAll("[data-plugin-filter]")) {
    const active = button.dataset.pluginFilter === pluginFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

$("#plugin-search").addEventListener("input", renderPluginCatalog);
for (const button of document.querySelectorAll("[data-plugin-filter]")) {
  button.addEventListener("click", () => {
    pluginFilter = button.dataset.pluginFilter;
    renderPluginCatalog();
  });
}
$("#plugin-reset").addEventListener("click", () => {
  pluginFilter = "all";
  $("#plugin-search").value = "";
  renderPluginCatalog();
  $("#plugin-search").focus();
});

function renderGmail() {
  const connected = Boolean(gmailPlugin?.connected);
  const configured = Boolean(gmailPlugin?.configured);
  $("#gmail-card").setAttribute("aria-busy", String(pluginsBusy));
  $("#gmail-state").textContent = !gmailPlugin ? (pluginsBusy ? "Loading…" : "Unavailable") : connected ? (gmailPlugin.enabled ? "Access enabled" : "Access off") : configured ? "Not connected" : "Setup required";
  $("#gmail-state").classList.toggle("enabled", connected && gmailPlugin.enabled);
  $("#gmail-setup").hidden = !gmailPlugin || configured;
  $("#gmail-account").hidden = !connected;
  $("#gmail-account").textContent = connected ? `Connected to ${gmailPlugin.workspaceName || "your Gmail account"}` : "";
  $("#gmail-permission").hidden = !connected;
  if (!pluginsBusy) $("#gmail-enabled").checked = connected && gmailPlugin.enabled;
  $("#gmail-enabled").disabled = pluginsBusy || !connected;
  $("#gmail-connect").textContent = connected ? "Reconnect Gmail" : "Connect Gmail";
  $("#gmail-connect").disabled = pluginsBusy || !configured;
  $("#gmail-disconnect").hidden = !connected;
  $("#gmail-disconnect").disabled = pluginsBusy;
  $("#gmail-use").hidden = !connected;
}

function renderTelegram() {
  const connected = Boolean(telegramPlugin?.connected);
  const configured = Boolean(telegramPlugin?.configured);
  const linking = Boolean(telegramLink);
  $("#telegram-card").setAttribute("aria-busy", String(pluginsBusy));
  $("#telegram-state").textContent = !telegramPlugin ? (pluginsBusy ? "Loading…" : "Unavailable") : linking ? "Waiting for Start" : connected ? (telegramPlugin.enabled ? "Access enabled" : "Access off") : configured ? "Not linked" : "Setup required";
  $("#telegram-state").classList.toggle("enabled", connected && telegramPlugin.enabled);
  $("#telegram-setup").hidden = !telegramPlugin || configured;
  $("#telegram-chat").hidden = !connected;
  $("#telegram-chat").textContent = connected ? `Linked to ${telegramPlugin.workspaceName || "your Telegram chat"}` : "";
  $("#telegram-link").hidden = !linking;
  if (linking) {
    $("#telegram-link-url").href = telegramLink;
    $("#telegram-link-url").textContent = telegramLink.replace(/\?.*$/, "").replace("https://", "");
  }
  $("#telegram-permission").hidden = !connected;
  if (!pluginsBusy) $("#telegram-enabled").checked = connected && telegramPlugin.enabled;
  $("#telegram-enabled").disabled = pluginsBusy || !connected;
  $("#telegram-connect").textContent = linking ? "Cancel linking" : connected ? "Relink Telegram" : "Link Telegram";
  $("#telegram-connect").disabled = pluginsBusy || !configured;
  $("#telegram-disconnect").hidden = !connected;
  $("#telegram-disconnect").disabled = pluginsBusy;
  $("#telegram-use").hidden = !connected;
}

async function loadPlugins() {
  if (pluginsBusy) return;
  const callback = new URL(location.href);
  const outcomes = {
    notion: { connected: "Notion connected. Choose whether to allow Pekka access below.", denied: "Notion connection was cancelled. You can try again whenever you're ready.", error: "Notion could not be connected. Try again or check the server's OAuth setup." },
    gmail: { connected: "Gmail connected. Choose whether to allow Pekka access below.", denied: "Gmail connection was cancelled. You can try again whenever you're ready.", error: "Gmail could not be connected. Make sure you allowed Gmail access on Google's consent screen, or check the server's OAuth setup." },
    github: { connected: "GitHub connected. Choose whether to allow Pekka access below.", denied: "GitHub connection was cancelled. You can try again whenever you're ready.", error: "GitHub could not be connected. Try again or check the server's OAuth setup." },
  };
  for (const [id, messages] of Object.entries(outcomes)) {
    const outcome = callback.searchParams.get(id);
    if (!outcome) continue;
    $("#plugin-status").textContent = messages[outcome] || "";
    $(`#${id}-card details`).open = true;
    callback.searchParams.delete(id);
    window.history.replaceState(null, "", callback.pathname + callback.search + callback.hash);
  }
  pluginsBusy = true;
  renderPlugins();
  try {
    const data = await api("/api/plugins");
    notionPlugin = data.plugins.find((plugin) => plugin.id === "notion");
    gmailPlugin = data.plugins.find((plugin) => plugin.id === "gmail");
    telegramPlugin = data.plugins.find((plugin) => plugin.id === "telegram");
    stopTelegramLink();
    telegramLink = telegramPlugin?.linkUrl;
    if (telegramLink && currentPage === "plugins") {
      $("#telegram-card details").open = true;
      telegramPoll = setTimeout(checkTelegramLink, 3000);
    }
    githubPlugin = data.plugins.find((plugin) => plugin.id === "github");
  } catch (error) {
    notionPlugin = undefined;
    gmailPlugin = undefined;
    telegramPlugin = undefined;
    githubPlugin = undefined;
    $("#plugin-status").textContent = `Could not load plugins: ${error.message}`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

function renderGithub() {
  const connected = Boolean(githubPlugin?.connected);
  const configured = Boolean(githubPlugin?.configured);
  $("#github-card").setAttribute("aria-busy", String(pluginsBusy));
  $("#github-state").textContent = !githubPlugin ? (pluginsBusy ? "Loading…" : "Unavailable") : connected ? (githubPlugin.enabled ? "Access enabled" : "Access off") : configured ? "Not connected" : "Setup required";
  $("#github-state").classList.toggle("enabled", connected && githubPlugin.enabled);
  $("#github-setup").hidden = !githubPlugin || configured;
  $("#github-workspace").hidden = !connected;
  $("#github-workspace").textContent = connected ? `Connected to ${githubPlugin.workspaceName || "your GitHub account"}` : "";
  $("#github-permission").hidden = !connected;
  if (!pluginsBusy) $("#github-enabled").checked = connected && githubPlugin.enabled;
  $("#github-enabled").disabled = pluginsBusy || !connected;
  $("#github-connect").textContent = connected ? "Reconnect GitHub" : "Add GitHub";
  $("#github-connect").disabled = pluginsBusy || !configured;
  $("#github-disconnect").hidden = !connected;
  $("#github-disconnect").disabled = pluginsBusy;
  $("#github-use").hidden = !connected;
}

async function changeGithub(action) {
  if (pluginsBusy) return;
  pluginsBusy = true;
  const enabled = $("#github-enabled").checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? "Opening GitHub…" : "Saving…";
  try {
    if (action === "connect") {
      const result = await api("/api/plugins/github/connect", { method: "POST", body: "{}" });
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.hostname !== "github.com" || target.pathname !== "/login/oauth/authorize") throw new Error("Invalid GitHub authorization URL.");
      location.assign(target.href);
      return;
    }
    githubPlugin = await api("/api/plugins/github", action === "disconnect" ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ enabled }) });
    $("#plugin-status").textContent = action === "disconnect" ? "GitHub disconnected. Pekka no longer has access." : enabled ? "GitHub access enabled for all bots." : "GitHub access turned off.";
  } catch (error) {
    const message = `Could not update GitHub: ${error.message}`;
    pluginsBusy = false;
    await loadPlugins();
    $("#plugin-status").textContent = githubPlugin ? message : `${message} Refresh to check the current connection state.`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

$("#github-connect").addEventListener("click", () => changeGithub("connect"));
$("#github-disconnect").addEventListener("click", () => changeGithub("disconnect"));
$("#github-enabled").addEventListener("change", () => changeGithub("permission"));

async function changeNotion(action) {
  if (pluginsBusy) return;
  pluginsBusy = true;
  const enabled = $("#notion-enabled").checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? "Opening Notion…" : "Saving…";
  try {
    if (action === "connect") {
      const result = await api("/api/plugins/notion/connect", { method: "POST", body: "{}" });
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.hostname !== "api.notion.com") throw new Error("Invalid Notion authorization URL.");
      location.assign(target.href);
      return;
    }
    notionPlugin = await api("/api/plugins/notion", action === "disconnect" ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ enabled }) });
    $("#plugin-status").textContent = action === "disconnect" ? "Notion disconnected. Pekka no longer has access." : enabled ? "Notion access enabled for this workspace." : "Notion access turned off.";
  } catch (error) {
    const message = `Could not update Notion: ${error.message}`;
    pluginsBusy = false;
    await loadPlugins();
    $("#plugin-status").textContent = notionPlugin ? message : `${message} Refresh to check the current connection state.`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

$("#plugins-refresh").addEventListener("click", () => {
  $("#plugin-status").textContent = "";
  loadPlugins();
});
$("#notion-connect").addEventListener("click", () => changeNotion("connect"));
$("#notion-disconnect").addEventListener("click", () => changeNotion("disconnect"));
$("#notion-enabled").addEventListener("change", () => changeNotion("permission"));

async function changeGmail(action) {
  if (pluginsBusy) return;
  pluginsBusy = true;
  const enabled = $("#gmail-enabled").checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? "Opening Google…" : "Saving…";
  try {
    if (action === "connect") {
      const result = await api("/api/plugins/gmail/connect", { method: "POST", body: "{}" });
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.hostname !== "accounts.google.com") throw new Error("Invalid Google authorization URL.");
      location.assign(target.href);
      return;
    }
    gmailPlugin = await api("/api/plugins/gmail", action === "disconnect" ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ enabled }) });
    $("#plugin-status").textContent = action === "disconnect" ? "Gmail disconnected. Pekka no longer has access." : enabled ? "Gmail access enabled. Bots can now read and send your email." : "Gmail access turned off.";
  } catch (error) {
    const message = `Could not update Gmail: ${error.message}`;
    pluginsBusy = false;
    await loadPlugins();
    $("#plugin-status").textContent = gmailPlugin ? message : `${message} Refresh to check the current connection state.`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

$("#gmail-connect").addEventListener("click", () => changeGmail("connect"));
$("#gmail-disconnect").addEventListener("click", () => changeGmail("disconnect"));
$("#gmail-enabled").addEventListener("change", () => changeGmail("permission"));

function stopTelegramLink() {
  clearTimeout(telegramPoll);
  telegramPoll = undefined;
  telegramLink = undefined;
}

async function checkTelegramLink() {
  if (!telegramLink) return;
  if (currentPage !== "plugins") { telegramPoll = undefined; return; }
  if (pluginsBusy) { telegramPoll = setTimeout(checkTelegramLink, 3000); return; }
  const attempt = telegramLink;
  try {
    const result = await api("/api/plugins/telegram/check", { method: "POST", body: "{}" });
    if (telegramLink !== attempt) return;
    if (result.linked) {
      stopTelegramLink();
      telegramPlugin = result;
      $("#plugin-status").textContent = "Telegram linked. Choose whether to allow bots to message you below.";
    } else {
      telegramPoll = setTimeout(checkTelegramLink, 3000);
    }
  } catch (error) {
    if (telegramLink !== attempt) return;
    stopTelegramLink();
    $("#plugin-status").textContent = `Could not link Telegram: ${error.message}`;
  }
  renderTelegram();
  renderPluginCatalog();
}

async function changeTelegram(action) {
  if (pluginsBusy) return;
  if (action === "connect" && telegramLink) action = "cancel";
  pluginsBusy = true;
  const enabled = $("#telegram-enabled").checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? "Preparing Telegram link…" : "Saving…";
  try {
    if (action === "cancel") {
      stopTelegramLink();
      telegramPlugin = await api("/api/plugins/telegram/connect", { method: "DELETE" });
      $("#plugin-status").textContent = "Telegram linking cancelled.";
      return;
    }
    if (action === "disconnect") stopTelegramLink();
    if (action === "connect") {
      const result = await api("/api/plugins/telegram/connect", { method: "POST", body: "{}" });
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.hostname !== "t.me") throw new Error("Invalid Telegram link.");
      telegramLink = target.href;
      $("#plugin-status").textContent = "";
      telegramPoll = setTimeout(checkTelegramLink, 3000);
      return;
    }
    telegramPlugin = await api("/api/plugins/telegram", action === "disconnect" ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ enabled }) });
    $("#plugin-status").textContent = action === "disconnect" ? "Telegram disconnected. Bots can no longer message you." : enabled ? "Bots can now message you on Telegram." : "Telegram access turned off.";
  } catch (error) {
    const message = `Could not update Telegram: ${error.message}`;
    pluginsBusy = false;
    await loadPlugins();
    $("#plugin-status").textContent = telegramPlugin ? message : `${message} Refresh to check the current connection state.`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

$("#telegram-connect").addEventListener("click", () => changeTelegram("connect"));
$("#telegram-disconnect").addEventListener("click", () => changeTelegram("disconnect"));
$("#telegram-enabled").addEventListener("change", () => changeTelegram("permission"));

function renderActivity() {
  const tasks = Object.entries(history).flatMap(([key, messages]) =>
    messages.filter((message) => message.role === "user").map((message) => ({ key, ...message })),
  ).sort((a, b) => b.time - a.time);
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  $("#activity-summary").textContent = `${plural(tasks.length, "task")} · ${plural(bots.length, "bot")} · ${running.size} running`;
  const list = $("#activity-list");
  list.replaceChildren();
  if (!tasks.length) {
    const empty = element("div", "activity-empty");
    empty.append(element("h2", "", "No tasks yet"), element("p", "muted", "Tasks you send to a bot from this browser are listed here."));
    list.append(empty);
  }
  for (const task of tasks.slice(0, 100)) {
    const bot = bots.find((item) => item.name.toLowerCase() === task.key);
    const row = element(bot ? "a" : "article", "activity-row");
    if (bot) row.href = "#bot/" + encodeURIComponent(bot.name);
    const meta = element("div", "activity-meta");
    meta.append(
      element("strong", "", bot?.name || task.key),
      element("time", "", new Date(task.time).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
    );
    row.append(meta, element("p", "", task.text));
    list.append(row);
  }
  if (tasks.length > 100) list.append(element("p", "muted activity-more", "Showing the 100 most recent tasks. Export the full history from Settings."));
}

$("#profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const value = Object.fromEntries([...new FormData(form)].map(([key, text]) => [key, text.trim()]));
  if (!value.displayName) {
    form.querySelector(".form-status").textContent = "Please enter your name.";
    return;
  }
  if (!saveLocal(scoped(profileKey), value, form)) return;
  profile = value;
  renderProfile();
  if (selected) renderTranscript();
});
$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const value = Object.fromEntries(Object.keys(preferences).map((key) => [key, form.elements[key].checked]));
  if (!saveLocal(scoped(preferencesKey), value, form)) return;
  preferences = value;
  applyPreferences();
});
for (const form of document.querySelectorAll("#profile-form, #settings-form")) {
  form.addEventListener("input", () => { form.querySelector(".form-status").textContent = "Unsaved changes"; });
}
$("#export-history").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: "application/json" }));
  const link = element("a", "");
  link.href = url;
  link.download = `pekka-history-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#export-status").textContent = "Export downloaded.";
});
window.addEventListener("hashchange", route);

const scheduleTemplates = [
  {
    name: "News roundup",
    summary: "A morning roundup of news on topics you care about.",
    task: "Search the web for the most important news from the last 24 hours about [your topics]. Write a short roundup with one or two sentences per story and a link to each source.",
    interval: 86400,
    hour: 8,
  },
  {
    name: "Email monitor",
    summary: "Scan your inbox and flag anything that needs your attention.",
    task: "Check my unread Gmail from the last day. List anything that needs a reply or action from me, with the sender, subject and what is needed. Do not reply to, send or change any messages.",
    interval: 86400,
    hour: 9,
  },
  {
    name: "Weekly research digest",
    summary: "A weekly briefing on what changed in a field you follow.",
    task: "Research what changed this week in [your field]: notable releases, papers and discussions. Write a briefing on the five most important developments, with links and why each one matters.",
    interval: 604800,
    hour: 9,
  },
  {
    name: "Release watch",
    summary: "Check the projects you depend on for new releases.",
    task: "Check the GitHub releases for [owner/repo, owner/repo]. Report any release from the last week with its version, date and most important changes. Say so if there are none.",
    interval: 604800,
    hour: 10,
  },
  {
    name: "Daily plan",
    summary: "Start each day with a plan built from your mail and notes.",
    task: "Read my unread email and the Notion pages I edited yesterday. Write a short plan for today: the three most important things to do and anything with a deadline.",
    interval: 86400,
    hour: 7,
  },
  {
    name: "Telegram reminder",
    summary: "Get a one-time nudge on Telegram.",
    task: "Send me a Telegram message reminding me to [what to remember].",
    interval: 0,
    hour: 17,
  },
];

const repeatOptions = [
  ["0", "Once"],
  ["3600", "Every hour"],
  ["86400", "Every day"],
  ["604800", "Every week"],
  ["custom", "Custom interval"],
];
const intervalUnits = [["60", "minutes"], ["3600", "hours"], ["86400", "days"]];
const upcomingStatuses = ["pending", "running", "paused"];
const statusLabels = { pending: "Scheduled", running: "Running", paused: "Paused", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
let jobs = [];
let schedulerState;
let jobsLoaded = false;
let jobsError = "";
let scheduleView = "";
let scheduleDraft;
let schedulePoll;
let jobsRequest;

const shortDate = (value) => new Date(value).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clockTime = (value) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function describeInterval(job) {
  const seconds = job.intervalSeconds;
  if (!seconds) return `Once, ${shortDate(job.runAt)}`;
  if (seconds === 86400) return `Every day at ${clockTime(job.runAt)}`;
  if (seconds === 604800)
    return `Every ${new Date(job.runAt).toLocaleDateString([], { weekday: "long" })} at ${clockTime(job.runAt)}`;
  for (const [size, unit] of [[86400, "day"], [3600, "hour"], [60, "minute"]]) {
    if (seconds % size) continue;
    const count = seconds / size;
    return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
  }
  return `Every ${seconds} seconds`;
}

// A cancelled task ended when it was cancelled, not when it last ran.
const endedAt = (job) => (job.status === "cancelled" ? job.updatedAt : job.lastFinishedAt || job.updatedAt);

function jobSummary(job) {
  if (job.status === "pending") return job.nextRunAt ? `Next ${shortDate(job.nextRunAt)}` : "Scheduled";
  if (job.status === "running") return "Running now";
  if (job.status === "paused") return `Paused · ${describeInterval(job)}`;
  return `${statusLabels[job.status]} · ${shortDate(endedAt(job))}`;
}

function loadJobs() {
  jobsRequest ||= api("/api/jobs")
    .then((data) => {
      jobs = data.jobs;
      schedulerState = data.scheduler;
      jobsError = "";
    })
    .catch((error) => {
      jobsError = `Could not load scheduled tasks: ${error.message}`;
    })
    .finally(() => {
      jobsLoaded = true;
      jobsRequest = undefined;
      renderScheduledCount();
    });
  return jobsRequest;
}

function renderScheduledCount() {
  const count = jobs.filter((job) => upcomingStatuses.includes(job.status) && job.status !== "paused").length;
  $("#scheduled-count").hidden = !count;
  $("#scheduled-count").textContent = count;
}

function sortedJobs(filter) {
  const upcoming = (job) => upcomingStatuses.includes(job.status);
  const list = jobs.filter((job) => filter === "all" || (filter === "upcoming") === upcoming(job));
  // Running first, then soonest next run, then paused; finished tasks newest first.
  const rank = (job) => ({ running: 0, pending: 1, paused: 2 })[job.status] ?? 3;
  return list.sort((a, b) =>
    rank(a) - rank(b) ||
    (rank(a) === 1 ? (a.nextRunAt || "").localeCompare(b.nextRunAt || "") : endedAt(b).localeCompare(endedAt(a))),
  );
}

function renderScheduleList() {
  const list = $("#schedule-list");
  const filter = $("#schedule-filter").value;
  list.replaceChildren();
  if (!jobsLoaded) list.append(element("p", "empty-list", "Loading…"));
  else if (jobsError) list.append(element("p", "empty-list error", jobsError));
  else {
    const visible = sortedJobs(filter);
    if (!visible.length)
      list.append(element("p", "empty-list", filter === "past" ? "No finished tasks yet." : "Nothing scheduled yet."));
    for (const job of visible) {
      const row = element("a", `bot-row schedule-row${scheduleView === job.id ? " active" : ""}`);
      row.href = "#scheduled/" + encodeURIComponent(job.id);
      if (scheduleView === job.id) row.setAttribute("aria-current", "page");
      const copy = element("span", "bot-copy");
      copy.append(element("strong", "", job.name), element("small", "", jobSummary(job)));
      row.append(avatar(job.bot?.name || job.name, 28), copy);
      if (job.status === "running") {
        const state = element("span", "bot-state running");
        state.title = "Running";
        row.append(state);
      } else if (job.status === "failed" || job.lastRunStatus === "failed") {
        const state = element("span", "bot-state failed");
        state.title = "Last run failed";
        row.append(state);
      }
      list.append(row);
    }
  }
  const status = $("#scheduler-status");
  status.classList.toggle("running", Boolean(schedulerState?.running));
  status.replaceChildren();
  if (!schedulerState) return;
  if (schedulerState.running) {
    status.append(element("strong", "", "Scheduler running"), element("span", "", schedulerState.host ? `on ${schedulerState.host}` : ""));
  } else {
    status.append(element("strong", "", "Scheduler stopped"), element("span", "", "Tasks run only while "));
    status.lastChild.append(element("code", "", "pnpm pekka scheduler"), " is running.");
  }
}

function scheduleIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "schedule-icon");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("width", "52");
  svg.setAttribute("height", "52");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<rect class="block" x="20" y="20" width="26" height="26"/><circle class="face" cx="21" cy="21" r="17"/><path class="hands" d="M21 10v11h8"/>';
  return svg;
}

function renderScheduleHome(pane) {
  const intro = element("div", "schedule-intro");
  intro.append(
    scheduleIcon(),
    element("h1", "", "Schedule a task"),
    element("p", "", "Bots can take care of recurring work for you, once or on a repeating schedule. Pick a starting point or write your own."),
  );
  const grid = element("div", "schedule-templates");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Task ideas");
  for (const template of scheduleTemplates) {
    const card = element("a", "schedule-template");
    card.href = "#scheduled/new";
    card.addEventListener("click", () => { scheduleDraft = template; });
    const copy = element("span", "");
    copy.append(element("strong", "", template.name), element("small", "", template.summary));
    card.append(avatar(template.name, 32), copy);
    grid.append(card);
  }
  pane.append(intro, grid);
}

// datetime-local wants local wall-clock time without an offset.
function localInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultStart(hour) {
  const date = new Date();
  if (hour === undefined) {
    date.setHours(date.getHours() + 1, 0, 0, 0);
    return date;
  }
  date.setHours(hour, 0, 0, 0);
  if (date <= new Date()) date.setDate(date.getDate() + 1);
  return date;
}

function field(labelText, control) {
  const label = element("label", "", labelText);
  label.append(control);
  return label;
}

function selectOf(name, options, value) {
  const select = element("select", "");
  select.name = name;
  for (const [optionValue, text] of options) {
    const option = element("option", "", text);
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  return select;
}

function renderScheduleForm(pane) {
  const draft = scheduleDraft || {};
  scheduleDraft = undefined;
  const form = element("form", "schedule-form");
  const heading = element("div", "page-heading");
  heading.append(
    element("h1", "", "New scheduled task"),
    element("p", "", "Each run starts a fresh task in the bot's sandbox, with its memory, skills and plugins."),
  );

  const name = element("input", "");
  Object.assign(name, { name: "name", maxLength: 200, required: true, placeholder: "e.g. Morning news", value: draft.name || "" });

  const fallbackBot = draft.botName ?? (selected?.name || bots[0]?.name || "");
  const bot = selectOf("botName", [...bots.map((item) => [item.name, item.name]), ["", "No bot (base sandbox)"]], fallbackBot);
  if (bot.selectedIndex < 0) bot.selectedIndex = 0;

  const task = element("textarea", "");
  Object.assign(task, { name: "task", rows: 5, maxLength: 100000, required: true, placeholder: "What to do on each run. Include everything it needs; each run starts without earlier conversation." });
  task.value = draft.task || "";

  const start = element("input", "");
  Object.assign(start, { name: "runAt", type: "datetime-local", required: true, value: localInputValue(defaultStart(draft.hour)) });

  const interval = String(draft.interval ?? 0);
  const repeat = selectOf("repeat", repeatOptions, repeatOptions.some(([value]) => value === interval) ? interval : "custom");
  const custom = element("div", "schedule-custom");
  const count = element("input", "");
  Object.assign(count, { name: "count", type: "number", min: 1, step: 1, value: 2 });
  count.setAttribute("aria-label", "Repeat every");
  const unit = selectOf("unit", intervalUnits, "3600");
  unit.setAttribute("aria-label", "Interval unit");
  custom.append(element("span", "", "Every"), count, unit);

  const row = element("div", "schedule-fields");
  row.append(field("Starts", start), field("Repeat", repeat));
  const zone = element("p", "info-note schedule-zone", `Times are in your time zone, ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Fixed intervals do not adjust for daylight saving time.`);

  const error = element("p", "error");
  error.setAttribute("role", "alert");
  const actions = element("div", "dialog-actions");
  const back = element("a", "button ghost", "Cancel");
  back.href = "#scheduled";
  const submit = element("button", "button primary", "Schedule task");
  actions.append(back, submit);

  const update = () => {
    custom.hidden = repeat.value !== "custom";
    count.required = repeat.value === "custom";
  };
  repeat.addEventListener("change", update);
  update();

  form.append(heading, field("Name", name), field("Bot", bot), field("Task", task), row, custom, zone, error, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const runAt = new Date(start.value);
    const intervalSeconds = repeat.value === "custom" ? Number(count.value) * Number(unit.value) : Number(repeat.value);
    if (Number.isNaN(runAt.getTime()) || runAt <= new Date()) {
      error.textContent = "Choose a start time in the future.";
      return;
    }
    if (repeat.value === "custom" && !(Number.isInteger(intervalSeconds) && intervalSeconds >= 60 && intervalSeconds <= 31536000)) {
      error.textContent = "Repeat between every minute and once a year.";
      return;
    }
    submit.disabled = true;
    try {
      const job = await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          name: name.value.trim(),
          task: task.value.trim(),
          runAt: runAt.toISOString(),
          ...(intervalSeconds ? { intervalSeconds } : {}),
          ...(bot.value ? { botName: bot.value } : {}),
        }),
      });
      jobs.push(job);
      renderScheduledCount();
      $("#schedule-filter").value = "upcoming";
      location.hash = "#scheduled/" + encodeURIComponent(job.id);
    } catch (failure) {
      error.textContent = failure.message;
      submit.disabled = false;
    }
  });
  pane.append(form);
  name.focus({ preventScroll: true });
  if (draft.task) task.focus({ preventScroll: true });
}

function renderScheduleDetail(pane, job) {
  const heading = element("div", "schedule-heading");
  const title = element("h1", "", job.name);
  title.tabIndex = -1;
  const badge = element("span", `plugin-state schedule-badge ${job.status}`, statusLabels[job.status] || job.status);
  heading.append(title, badge);

  const facts = element("dl", "schedule-facts");
  const fact = (label, value) => {
    if (!value) return;
    const item = element("div", "");
    const detail = element("dd", "");
    detail.append(value);
    item.append(element("dt", "", label), detail);
    facts.append(item);
  };
  const owner = bots.find((item) => item.name.toLowerCase() === job.bot?.name.toLowerCase());
  if (job.bot) {
    const link = element(owner ? "a" : "span", "schedule-bot");
    if (owner) link.href = "#bot/" + encodeURIComponent(owner.name);
    link.append(avatar(job.bot.name, 18), job.bot.name);
    fact("Bot", link);
  } else fact("Bot", "No bot (base sandbox)");
  fact("Schedule", describeInterval(job));
  fact("Next run", job.nextRunAt ? shortDate(job.nextRunAt) : job.status === "running" ? "Running now" : "None");
  fact("Runs", String(job.runCount));
  if (job.lastFinishedAt)
    fact("Last run", `${shortDate(job.lastFinishedAt)} · ${job.lastRunStatus === "failed" ? "Failed" : "Completed"}`);
  fact("Created", shortDate(job.createdAt));

  const actions = element("div", "plugin-actions");
  const status = element("p", "form-status");
  status.setAttribute("role", "status");
  const act = async (action) => {
    for (const item of actions.querySelectorAll("button")) item.disabled = true;
    status.textContent = "Saving…";
    try {
      const updated = await api(`/api/jobs/${encodeURIComponent(job.id)}/${action}`, { method: "POST", body: "{}" });
      jobs = jobs.map((item) => (item.id === updated.id ? updated : item));
      renderScheduledCount();
      renderScheduled();
    } catch (error) {
      status.textContent = error.message;
      for (const item of actions.querySelectorAll("button")) item.disabled = false;
      await loadJobs();
      renderScheduleList();
    }
  };
  if (job.status === "pending") {
    const pause = element("button", "button secondary", "Pause");
    pause.addEventListener("click", () => act("pause"));
    actions.append(pause);
  }
  if (job.status === "paused") {
    const resume = element("button", "button primary", "Resume");
    resume.addEventListener("click", () => act("resume"));
    actions.append(resume);
  }
  if (upcomingStatuses.includes(job.status)) {
    const cancel = element("button", "button ghost danger", "Cancel task");
    cancel.addEventListener("click", () => {
      if (confirm(`Cancel “${job.name}”? It will not run again. This cannot be undone.`)) act("cancel");
    });
    actions.append(cancel);
  }
  const copy = element("button", "button ghost", "Duplicate");
  copy.addEventListener("click", () => {
    scheduleDraft = { name: job.name, task: job.task, interval: job.intervalSeconds || 0, botName: job.bot?.name ?? "", hour: new Date(job.runAt).getHours() };
    location.hash = "#scheduled/new";
  });
  actions.append(copy);

  const sections = [];
  const section = (label, ...children) => {
    const block = element("div", "panel-section");
    block.append(element("h2", "", label), ...children);
    sections.push(block);
  };
  section("Task", element("p", "schedule-task", job.task));
  if (job.status === "running") section("Latest result", element("div", "run-status live", "Running now…"));
  else if (job.lastError || job.lastResult) {
    const children = [];
    if (job.lastError) children.push(element("p", "error", job.lastError));
    const answer = job.lastResult?.answer;
    if (typeof answer === "string" && answer) children.push(renderMessage({ role: "assistant", text: answer }));
    const usage = job.lastResult?.usage;
    if (usage?.costUsd !== undefined)
      children.push(element("div", "run-status", `${job.lastResult.steps ?? 0} steps · $${Number(usage.costUsd).toFixed(4)}`));
    section(`Latest result${job.lastFinishedAt ? ` · ${shortDate(job.lastFinishedAt)}` : ""}`, ...children);
  } else if (upcomingStatuses.includes(job.status))
    section("Latest result", element("p", "muted", "No runs yet. The result of the most recent run appears here."));

  const back = element("a", "schedule-back", "← All scheduled tasks");
  back.href = "#scheduled";
  pane.append(back, heading, facts, actions, status, ...sections);
}

function renderScheduled() {
  if (currentPage !== "scheduled") return;
  renderScheduleList();
  const pane = $("#schedule-pane");
  const scroll = pane.scrollTop;
  const sameView = pane.dataset.view === scheduleView;
  pane.dataset.view = scheduleView;
  $("#scheduled").dataset.view = !scheduleView ? "home" : scheduleView === "new" ? "new" : "detail";
  if (scheduleView === "new") {
    // Re-rendering would wipe what the user has typed.
    if (sameView && pane.querySelector("form")) return;
    pane.replaceChildren();
    renderScheduleForm(pane);
    return;
  }
  pane.replaceChildren();
  if (!scheduleView) renderScheduleHome(pane);
  else {
    const job = jobs.find((item) => item.id === scheduleView);
    if (job) renderScheduleDetail(pane, job);
    else if (!jobsLoaded) pane.append(element("p", "muted", "Loading…"));
    else {
      const missing = element("div", "activity-empty");
      const back = element("a", "", "Back to scheduled tasks");
      back.href = "#scheduled";
      missing.append(element("h2", "", "Task not found"), element("p", "muted", "It may have been removed. "), back);
      pane.append(missing);
    }
  }
  if (sameView) pane.scrollTop = scroll;
  else {
    pane.scrollTop = 0;
    pane.querySelector("h1")?.focus({ preventScroll: true });
  }
}

// Keeps statuses and results current while the page is open, without hammering D1.
function pollJobs() {
  clearTimeout(schedulePoll);
  schedulePoll = setTimeout(async () => {
    if (currentPage !== "scheduled") return;
    if (!document.hidden) {
      await loadJobs();
      renderScheduled();
    }
    pollJobs();
  }, 15000);
}

async function openScheduled(view) {
  const changedPage = currentPage !== "scheduled";
  currentPage = "scheduled";
  scheduleView = view;
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("#welcome").hidden = true;
  $("#conversation").hidden = true;
  $("#details").hidden = true;
  $("#pages").hidden = true;
  $("#scheduled").hidden = false;
  document.title = "Scheduled — Pekka";
  $("#heading").textContent = "Scheduled";
  updateNavigation();
  renderBots();
  closeDrawer();
  renderScheduled();
  if (changedPage || !jobsLoaded) {
    await loadJobs();
    renderScheduled();
    pollJobs();
  }
}

$("#schedule-filter").addEventListener("change", renderScheduleList);

$("#sign-out").addEventListener("click", async () => {
  $("#sign-out").disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    location.assign("/");
  } catch (error) {
    $("#sign-out-status").textContent = `Could not sign out: ${error.message}`;
    $("#sign-out").disabled = false;
  }
});

async function start() {
  const login = new URL(location.href);
  const outcome = login.searchParams.get("login");
  if (outcome) {
    login.searchParams.delete("login");
    window.history.replaceState(null, "", login.pathname + login.search + login.hash);
  }
  let session;
  try {
    session = await api("/api/auth/session");
  } catch (error) {
    notify(`Could not reach Pekka: ${error.message} Reload to try again.`);
    return;
  }
  if (session.required && !session.user) {
    showSignIn(session.error || signInErrors[outcome] || (outcome ? signInErrors.error : ""));
    if (session.configured === false) {
      const button = $("#sign-in a");
      button.removeAttribute("href");
      button.setAttribute("aria-disabled", "true");
      button.textContent = "Sign-in setup pending";
    }
    return;
  }
  account = session.user;
  if (session.shared) $("#host").textContent = `${location.host} · Public shared workspace`;
  $("#app").hidden = false;
  loadBrowserState();
  renderAccount();
  applyPreferences();
  renderProfile();
  route();
  initialize();
  loadJobs();
}

$("#host").textContent = location.host;
start();
