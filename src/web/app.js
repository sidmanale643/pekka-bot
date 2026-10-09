import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/dompurify.js";

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text) => text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

// HTML in a reply is shown as the text the bot wrote, instead of the sanitizer
// silently dropping the tags. Line breaks still work, since bots use <br> in table cells.
marked.use({
  renderer: {
    html({ text, block }) {
      const shown = text.split(/<br\s*\/?>/i).map(escapeHtml).join("<br>");
      return block ? `<p>${shown.trim().replaceAll("\n", "<br>")}</p>\n` : shown;
    },
  },
});
const profileKey = "pekka.profile.v1";
const preferencesKey = "pekka.preferences.v1";
// The theme is saved once per browser rather than per account, because index.html reads it
// before anyone signs in. With nothing saved it follows the device.
const themeKey = "pekka.theme.v1";
const profileDefaults = { displayName: "", occupation: "", bio: "" };
const preferenceDefaults = { enterToSend: true, compact: false, reduceMotion: false };
// The signed-in Google account, or null when the server runs without sign-in.
let account = null;
let profile = { ...profileDefaults };
let preferences = { ...preferenceDefaults };
let theme = "system";
let currentPage = "workspace";
let bots = [];
let selected;
let history = Object.create(null);
const running = new Set();
const messageQueues = new Map();
const stopping = new Set();
const drafts = new Map();
const unread = new Set();
let loaded = false;
let notionPlugin;
let githubPlugin;
let linearPlugin;
let wisprPlugin;
let todoistPlugin;
// Google plugins share one sign-in flow and card layout; each keeps its own connection and access switch.
const googlePlugins = {
  gmail: { name: "Gmail", grant: "Gmail access", enabled: "Gmail access enabled. Bots can now read and send your email." },
  calendar: { name: "Google Calendar", grant: "calendar and tasks access", enabled: "Google Calendar access enabled. Bots can now see and change your events and reminders." },
  drive: { name: "Google Drive", grant: "Drive, Docs and Sheets access", enabled: "Google Drive access enabled. Bots can now read your files and write Docs and Sheets." },
  contacts: { name: "Google Contacts", grant: "contacts access", enabled: "Google Contacts access enabled. Bots can now look up your contacts." },
};
let googleStatus = {};
// Plugins connected by pasting the user's own API key share one card layout.
const apiKeyPlugins = { granola: { name: "Granola", key: "API key" } };
let apiKeyStatus = {};
let telegramPlugin;
let telegramLink;
let telegramPoll;
let pluginsBusy = false;

// Each account keeps its own browser storage, so people sharing a browser
// don't see each other's history. The owner keeps what was saved before sign-in.
function scoped(key) {
  return account && account.id !== "local" ? `${key}:${account.id}` : key;
}

// Chats are saved on the server, per bot, as each run goes, so they follow the account to every browser and device.
// This tab only reads them, and shows its own runs live until their saved copy is read back.
const messagesLoadedAt = new Map(); // bot ID → when its chat was last read from the server
const localOnly = new WeakSet(); // messages this tab added that the server's copy didn't have when it was last read

const messageId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * A saved message as this tab shows it. One still running on the server says so, until the chat is read again,
 * and its open permission requests can still be answered here.
 */
function restoredMessage(entry) {
  return {
    ...entry,
    pending: false,
    stillRunning: Boolean(entry.pending),
    status: entry.pending ? "Still running when this chat was loaded." : typeof entry.status === "string" ? entry.status : "",
  };
}

/** Adds messages this tab is about to show before the server has them. */
function addLocal(bot, ...messages) {
  const key = bot.name.toLowerCase();
  for (const message of messages) localOnly.add(message);
  (history[key] ||= []).push(...messages);
}

/** Reads a bot's chat from the server. Replies this tab is still showing live stay as they are. */
async function loadMessages(bot) {
  messagesLoadedAt.set(bot.id, Date.now());
  const { messages } = await api(`/api/bots/${encodeURIComponent(bot.name)}/messages`);
  const key = bot.name.toLowerCase();
  const local = new Map((history[key] ?? []).map((message) => [message.id, message]));
  const merged = messages.map((data) => {
    const mine = local.get(data.id);
    local.delete(data.id);
    // A reply still running here keeps its live copy, but takes the saved time: its question now has the server's
    // time, which is later than this tab's, and sorting by the old one would put the reply above the question.
    if (mine?.pending) return Object.assign(mine, { time: data.time });
    // The same object is updated, so a run or handoff that refers to it still finds it.
    if (mine) localOnly.delete(mine);
    return Object.assign(mine ?? {}, restoredMessage(data));
  });
  // Messages missing from the server's copy were added here since it was read, or never reached it, like a task
  // that couldn't start. Any others were cleared from another tab or device.
  const added = [...local.values()].filter((message) => message.pending || localOnly.has(message));
  history[key] = [...merged, ...added].sort((a, b) => a.time - b.time);
}

/** Reads a bot's chat again, keeping what this tab shows if it can't. */
async function reloadMessages(bot) {
  try {
    await loadMessages(bot);
  } catch {
    return;
  }
  renderBots();
  if (selected === bot && currentPage === "workspace") renderTranscript();
}

/** Picks up messages sent from other tabs and devices, at most every few seconds. */
async function refreshMessages(bot) {
  if (Date.now() - (messagesLoadedAt.get(bot.id) ?? 0) < 3000) return;
  await reloadMessages(bot);
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

// Bot rows preview the last message as one line of text, not raw markdown.
function plainText(markdown) {
  const html = marked.parse(markdown.slice(0, 600), { gfm: true, async: false });
  return new DOMParser().parseFromString(html, "text/html").body.textContent.replace(/\s+/g, " ").trim();
}

function relativeTime(time) {
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}

function stateDot(bot) {
  if (running.has(bot.name)) {
    const state = element("span", "bot-state running");
    state.title = "Running";
    return [state];
  }
  if (unread.has(bot.name)) {
    const state = element("span", "bot-state");
    state.title = "New result";
    return [state];
  }
  return [];
}

function editButton(bot) {
  const edit = element("button", "icon-button bot-edit");
  edit.type = "button";
  edit.title = `Edit ${bot.name}`;
  edit.setAttribute("aria-label", `Edit ${bot.name}`);
  edit.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m12.5 3.5 4 4M3 17l4.5-1 9-9a2.8 2.8 0 0 0-4-4l-9 9L3 17Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>';
  edit.addEventListener("click", () => {
    selectBot(bot);
    openBotSetting(bot, "purpose");
  });
  return edit;
}

function botRow(bot) {
  const button = element(
    "button",
    `bot-row${selected === bot && currentPage === "workspace" ? " active" : ""}`,
  );
  button.setAttribute("aria-current", selected === bot && currentPage === "workspace" ? "true" : "false");
  // The collapsed rail shows only the avatar, so the name moves into a tooltip.
  if (sidebarRail()) button.title = bot.name;
  const copy = element("span", "bot-copy");
  const last = entries(bot).at(-1);
  const preview = running.has(bot.name)
    ? "Running…"
    : (last?.text && plainText(last.text)) || bot.role;
  copy.append(element("strong", "", bot.name), element("small", running.has(bot.name) ? "shimmer" : "", preview));
  button.append(avatar(bot.name, 28), synced(copy), ...stateDot(bot));
  button.addEventListener("click", () => selectBot(bot));
  const row = element("div", "bot-list-item");
  row.append(button);
  if (last?.time && !running.has(bot.name)) row.append(element("time", "bot-time", relativeTime(last.time)));
  row.append(editButton(bot));
  return row;
}

// The chief of staff sits above the other bots, with the team it runs and who on it is working.
function chiefCard(chief, team) {
  const active = selected === chief && currentPage === "workspace";
  const button = element("button", "chief-main");
  button.type = "button";
  button.setAttribute("aria-current", active ? "true" : "false");
  if (sidebarRail()) button.title = `${chief.name}, chief of staff`;
  const working = team.filter((bot) => running.has(bot.name));
  const last = entries(chief).at(-1);
  const preview = running.has(chief.name)
    ? working.length ? `Working with ${working.map((bot) => bot.name).join(", ")}…` : "Running…"
    : (last?.text && plainText(last.text)) || "Ask me anything. I'll get it to the right bot.";
  const copy = element("span", "bot-copy");
  // A renamed chief keeps its title, so it still reads as the one in charge.
  if (chief.name.toLowerCase() !== "chief of staff") copy.append(element("small", "chief-label", "Chief of staff"));
  copy.append(element("strong", "", chief.name), element("small", running.has(chief.name) ? "shimmer" : "", preview));
  synced(copy);
  const strip = element("span", "chief-team");
  const faces = element("span", "chief-faces");
  for (const bot of team.slice(0, 5)) {
    const face = avatar(bot.name, 18);
    if (running.has(bot.name)) face.classList.add("working");
    faces.append(face);
  }
  const summary = working.length
    ? `${working.length === 1 ? working[0].name : `${working.length} bots`} working`
    : team.length ? `Runs ${team.length} ${team.length === 1 ? "bot" : "bots"}` : "No other bots yet";
  strip.append(faces, element("span", working.length ? "live" : "", summary));
  button.append(avatar(chief.name, 34), copy, ...stateDot(chief), strip);
  button.addEventListener("click", () => selectBot(chief));
  const card = element("div", `chief-card${active ? " active" : ""}`);
  card.append(button, editButton(chief));
  return card;
}

function renderBots() {
  const list = $("#bot-list");
  list.replaceChildren();
  const chief = bots.find((bot) => bot.primary);
  const team = bots.filter((bot) => !bot.primary);
  $("#chief-slot").replaceChildren(...(chief ? [chiefCard(chief, team)] : []));
  const query = $("#search").value.toLowerCase();
  const filtered = team.filter((bot) =>
    `${bot.name} ${bot.role}`.toLowerCase().includes(query),
  );
  $("#bot-count").textContent = team.length;
  for (const bot of filtered) list.append(botRow(bot));
  if (team.length && !filtered.length)
    list.append(element("p", "empty-list", "No bots match."));
  if (!team.length && chief)
    list.append(element("p", "empty-list", `None yet. Ask ${chief.name} to set one up, or use New bot.`));
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
  if (panelView.bot !== bot.id) panelView = { bot: bot.id, view: "" };
  selected = bot;
  unread.delete(bot.name);
  closeDrawer();
  $("#welcome").hidden = true;
  $("#conversation").hidden = false;
  $("#panel-toggles").hidden = false;
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
  renderComputer();
  void refreshMessages(bot);
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

const copyIcon = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>';
const copiedIcon = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="m4 10.5 4 4 8-9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>';

// Copies the message as written, so an answer keeps its markdown rather than the rendered text.
function messageActions(text) {
  const actions = element("div", "message-actions");
  const button = element("button", "icon-button copy-message");
  button.type = "button";
  const show = (label, icon) => {
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon;
  };
  show("Copy message", copyIcon);
  let reset;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      notify("Could not copy the message. Your browser blocked clipboard access.");
      return;
    }
    show("Copied", copiedIcon);
    clearTimeout(reset);
    reset = setTimeout(() => show("Copy message", copyIcon), 1500);
  });
  actions.append(button);
  return actions;
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
  if (greeting) message.append(renderMessage({ role: "assistant", text: greeting.message }), messageActions(greeting.message));
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

// What each tool is called in the chat, while it runs and once it's done. Internal names stay out of sight.
const toolAliases = {
  web_search: ["Searching the web", "Searched the web"],
  web_scrape: ["Reading a web page", "Read a web page"],
  read_file: ["Reading a file", "Read a file"],
  write_file: ["Saving a file", "Saved a file"],
  edit_file: ["Editing a file", "Edited a file"],
  run_command: ["Running a command", "Ran a command"],
  read_memory: ["Checking memory", "Checked memory"],
  write_memory: ["Updating memory", "Updated memory"],
  list_skills: ["Looking through skills", "Looked through skills"],
  load_skill: ["Loading a skill", "Loaded a skill"],
  write_skill: ["Saving a skill", "Saved a skill"],
  load_plugin: ["Getting a plugin ready", "Got a plugin ready"],
  update_bot_config: ["Updating its setup", "Updated its setup"],
  list_bots: ["Checking the team", "Checked the team"],
  create_bot: ["Creating a bot", "Created a bot"],
  update_bot: ["Updating a bot", "Updated a bot"],
  delegate_task: ["Handing off work", "Handed off work"],
  schedule_job: ["Scheduling a task", "Scheduled a task"],
  list_scheduled_jobs: ["Checking the schedule", "Checked the schedule"],
  cancel_scheduled_job: ["Cancelling a scheduled task", "Cancelled a scheduled task"],
  get_email_address: ["Looking up its email address", "Looked up its email address"],
  send_email: ["Sending an email", "Sent an email"],
  gmail_search: ["Searching Gmail", "Searched Gmail"],
  gmail_read_message: ["Reading an email", "Read an email"],
  gmail_read_thread: ["Reading an email thread", "Read an email thread"],
  gmail_read_attachment: ["Reading an attachment", "Read an attachment"],
  gmail_send: ["Sending an email", "Sent an email"],
  gmail_create_draft: ["Drafting an email", "Drafted an email"],
  gmail_list_labels: ["Checking Gmail labels", "Checked Gmail labels"],
  gmail_modify_labels: ["Relabeling an email", "Relabeled an email"],
  calendar_list_calendars: ["Checking calendars", "Checked calendars"],
  calendar_list_events: ["Checking the calendar", "Checked the calendar"],
  calendar_find_free_time: ["Finding free time", "Found free time"],
  calendar_create_event: ["Creating an event", "Created an event"],
  calendar_update_event: ["Updating an event", "Updated an event"],
  calendar_respond_to_event: ["Answering an invitation", "Answered an invitation"],
  calendar_delete_event: ["Deleting an event", "Deleted an event"],
  tasks_list_lists: ["Checking task lists", "Checked task lists"],
  tasks_list: ["Checking tasks", "Checked tasks"],
  tasks_create: ["Adding a reminder", "Added a reminder"],
  tasks_update: ["Updating a task", "Updated a task"],
  contacts_search: ["Searching contacts", "Searched contacts"],
  drive_search: ["Searching Drive", "Searched Drive"],
  drive_read_file: ["Reading a Drive file", "Read a Drive file"],
  docs_create: ["Creating a document", "Created a document"],
  docs_append_text: ["Adding to a document", "Added to a document"],
  sheets_read: ["Reading a spreadsheet", "Read a spreadsheet"],
  sheets_create: ["Creating a spreadsheet", "Created a spreadsheet"],
  sheets_append_rows: ["Adding rows", "Added rows"],
  sheets_update_range: ["Updating cells", "Updated cells"],
  notion_search: ["Searching Notion", "Searched Notion"],
  notion_get_page: ["Reading a Notion page", "Read a Notion page"],
  notion_list_blocks: ["Reading a Notion page", "Read a Notion page"],
  notion_create_page: ["Creating a Notion page", "Created a Notion page"],
  notion_append_text: ["Adding to a Notion page", "Added to a Notion page"],
  github_list_repositories: ["Listing repositories", "Listed repositories"],
  github_get_repository: ["Checking a repository", "Checked a repository"],
  github_list_issues: ["Checking issues", "Checked issues"],
  github_get_issue: ["Reading an issue", "Read an issue"],
  github_list_issue_comments: ["Reading comments", "Read comments"],
  github_list_pull_requests: ["Checking pull requests", "Checked pull requests"],
  github_get_pull_request: ["Reading a pull request", "Read a pull request"],
  github_list_pull_request_files: ["Reviewing changed files", "Reviewed changed files"],
  github_create_issue: ["Opening an issue", "Opened an issue"],
  github_add_comment: ["Commenting", "Commented"],
  github_create_pull_request: ["Opening a pull request", "Opened a pull request"],
  linear_list_teams: ["Checking Linear teams", "Checked Linear teams"],
  linear_list_issues: ["Checking Linear issues", "Checked Linear issues"],
  linear_search_issues: ["Searching Linear", "Searched Linear"],
  linear_get_issue: ["Reading a Linear issue", "Read a Linear issue"],
  linear_create_issue: ["Creating a Linear issue", "Created a Linear issue"],
  linear_update_issue: ["Updating a Linear issue", "Updated a Linear issue"],
  linear_add_comment: ["Commenting in Linear", "Commented in Linear"],
  granola_list_notes: ["Checking Granola notes", "Checked Granola notes"],
  granola_get_note: ["Reading a meeting note", "Read a meeting note"],
  granola_get_transcript: ["Reading a transcript", "Read a transcript"],
  todoist_list_tools: ["Discovering Todoist tools", "Discovered Todoist tools"],
  todoist_read_tool: ["Reading Todoist", "Read Todoist"],
  todoist_write_tool: ["Updating Todoist", "Updated Todoist"],
  todoist_list_projects: ["Checking Todoist projects", "Checked Todoist projects"],
  todoist_list_tasks: ["Checking Todoist tasks", "Checked Todoist tasks"],
  todoist_get_task: ["Reading a Todoist task", "Read a Todoist task"],
  todoist_create_task: ["Adding a Todoist task", "Added a Todoist task"],
  todoist_update_task: ["Updating a Todoist task", "Updated a Todoist task"],
  todoist_complete_task: ["Completing a Todoist task", "Completed a Todoist task"],
  todoist_reopen_task: ["Reopening a Todoist task", "Reopened a Todoist task"],
  todoist_add_comment: ["Commenting in Todoist", "Commented in Todoist"],
  telegram_send_message: ["Sending a Telegram message", "Sent a Telegram message"],
};

/** A tool's name for people: what it's doing while `running`, otherwise what it did. */
function toolAlias(name, running = false) {
  const alias = toolAliases[name];
  if (alias) return alias[running ? 0 : 1];
  // A tool added later still reads as words rather than an identifier.
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Working";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
}

const toolHintKeys = ["query", "url", "path", "command", "title", "subject", "bot_name", "name", "file", "task", "text"];

// The detail a step is about, like the search query or the file path, read from its arguments.
function toolHint(args) {
  const input = parseJson(args ?? "");
  if (!input || typeof input !== "object") return "";
  const value = toolHintKeys.map((key) => input[key]).find((value) => typeof value === "string" && value.trim());
  return value ? value.replace(/^https?:\/\//, "").replace(/\s+/g, " ").trim().slice(0, 140) : "";
}

/** `message` is the answer the card belongs to, so a handoff card can reopen that run's handoff modal. */
function outputCard(output, message) {
  const card = element(output.url || output.bot ? "a" : "div", "output-card");
  if (output.url) {
    card.href = output.url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
  } else if (output.bot) {
    // Opens the bot's chat, or the handoff modal while this page still has that run's details.
    card.href = "#bot/" + encodeURIComponent(output.bot);
    card.addEventListener("click", (event) => {
      const item = handoff.message === message && handoff.items.findLast(({ delegation }) => delegation.name.toLowerCase() === output.bot.toLowerCase());
      if (!item) return;
      event.preventDefault();
      openHandoff(item.delegation.id);
    });
  }
  const copy = element("span", "output-copy");
  copy.append(element("strong", "", output.title), element("small", "", output.detail));
  card.append(element("span", "output-icon", output.plugin.slice(0, 1)), copy);
  if (output.url) card.append(element("span", "output-open", "↗"));
  card.title = output.plugin;
  return card;
}

function toolTrail(message) {
  const trail = element("div", "message-trail");
  const outputs = message.tools.map((tool) => tool.output).filter(Boolean);
  if (outputs.length) {
    const cards = element("div", "output-cards");
    for (const output of outputs) cards.append(outputCard(output, message));
    trail.append(cards);
  }
  trail.append(stepsUsed(message.tools));
  return trail;
}

/** The step count and what the steps did, once each, after a run. */
function stepsUsed(tools) {
  const used = element("div", "tools-used");
  used.append(element("span", "", `${tools.length} ${tools.length === 1 ? "step" : "steps"}`));
  const failed = new Set(tools.filter((tool) => tool.isError).map((tool) => toolAlias(tool.name)));
  for (const alias of new Set(tools.map((tool) => toolAlias(tool.name)))) used.append(element("span", `tool-chip${failed.has(alias) ? " failed" : ""}`, alias));
  return used;
}

// What a running reply is doing, for the live view only, so it's never saved with the history.
// `phase` is thinking, writing, tools, waiting, compacting or done, and `since` is when it began.
const liveRuns = new WeakMap();
// When each tool call of a running reply started and ended, and the detail it was about.
const toolRuns = new WeakMap();

function startLive(message) {
  liveRuns.set(message, { phase: "thinking", since: Date.now() });
}

function setPhase(message, phase) {
  const live = liveRuns.get(message);
  if (live && live.phase !== phase) Object.assign(live, { phase, since: Date.now() });
}

// The transcript is redrawn on every streamed token, which restarts CSS animations.
// Looping ones take their phase from the page clock instead, so they keep moving smoothly.
function synced(node) {
  node.style.setProperty("--sync", `${-Math.round(document.timeline.currentTime ?? performance.now())}ms`);
  return node;
}

// A one-off entrance keeps its progress across redraws by starting as far in as time has passed.
function entrance(node, since, length = 450) {
  const passed = Date.now() - since;
  if (passed >= length) return node;
  node.classList.add("enter");
  node.style.setProperty("--enter", `${-passed}ms`);
  return node;
}

function elapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return "";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** A running clock, kept current by the ticker below. */
function clock(since) {
  const node = element("span", "live-clock", elapsed(Date.now() - since));
  node.dataset.since = since;
  return node;
}

// A run started in another tab, or before this page loaded, shows up only when its chat is read again. A reply
// left running by a server that stopped stays that way, so only the last hour's are followed.
setInterval(() => {
  if (document.visibilityState !== "visible" || !selected || currentPage !== "workspace") return;
  const recent = (message) => message.stillRunning && Date.now() - message.time < 3_600_000;
  if (history[selected.name.toLowerCase()]?.some(recent)) void refreshMessages(selected);
}, 3000);

setInterval(() => {
  if (!running.size) return;
  for (const node of document.querySelectorAll("[data-since]")) node.textContent = elapsed(Date.now() - Number(node.dataset.since));
}, 500);

const liveStepLimit = 5;

/** A running reply's tool calls as they happen: what each is doing, what it's about and how long it took. */
function liveSteps(message) {
  const list = synced(element("ol", "live-steps"));
  list.setAttribute("aria-label", "Steps so far");
  const earlier = message.tools.length - liveStepLimit;
  if (earlier > 0) list.append(element("li", "live-step earlier", `${earlier} earlier ${earlier === 1 ? "step" : "steps"}`));
  for (const tool of message.tools.slice(-liveStepLimit)) {
    const run = toolRuns.get(tool) ?? {};
    const state = !("isError" in tool) ? "running" : tool.isError ? "failed" : "done";
    const row = element("li", `live-step ${state}`);
    if (run.start) entrance(row, run.start);
    const mark = element("span", "step-mark");
    mark.setAttribute("aria-hidden", "true");
    if (state === "done") mark.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 6.4 5 8.8l4.6-5.3" pathLength="1" /></svg>';
    if (state === "failed") mark.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12"><path d="m3.5 3.5 5 5m0-5-5 5" /></svg>';
    if (run.end) entrance(mark, run.end, 500);
    row.append(mark, element("span", state === "running" ? "step-name shimmer" : "step-name", toolAlias(tool.name, state === "running")));
    if (run.hint) row.append(element("span", "step-hint", run.hint));
    if (state === "running" && run.start) row.append(clock(run.start));
    else if (run.start && run.end) row.append(element("span", "live-clock", duration(run.end - run.start)));
    list.append(row);
  }
  return list;
}

function duration(ms) {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : elapsed(ms);
}

const liveLabels = { thinking: "Thinking", compacting: "Tidying up earlier work", waiting: "Waiting for your permission" };

/** The line under a running reply while the bot thinks between steps, or waits on you. */
function liveLine(message) {
  const live = liveRuns.get(message) ?? { phase: "thinking", since: message.time };
  const label = liveLabels[live.phase];
  if (!label) return [];
  const line = entrance(synced(element("div", `live-line ${live.phase}`)), live.since, 300);
  const glyph = element("span", "tile-glyph");
  glyph.setAttribute("aria-hidden", "true");
  line.append(glyph, element("span", live.phase === "waiting" ? "" : "shimmer", label), clock(live.since));
  return [line];
}

// The computer view: what each bot does on its sandbox, built from its runs' tool events while this page is open.
// Commands keep their output and files their last known text. Sandbox sessions are ephemeral, so the log lives
// in memory only and is gone after a reload.
const computers = new Map();
const computerEntryLimit = 300;
const fileActions = { read_file: "Read", write_file: "Saved", edit_file: "Edited" };
const computerTools = new Set(["run_command", ...Object.keys(fileActions)]);
const commandTailLines = 12;

function computerFor(bot) {
  if (!computers.has(bot.id)) computers.set(bot.id, { entries: [], files: new Map(), tab: "terminal", openFile: "" });
  return computers.get(bot.id);
}

/** Adds a run event to the bot's computer view. Only its sandbox tools, permission prompts and the run's end matter here. */
function watchComputer(bot, event, data) {
  if (event === "result" || event === "error") return endComputerRun(bot);
  const computer = computerFor(bot);
  const pending = (match) => computer.entries.find((entry) => entry.name && !entry.end && match(entry));
  if (event === "tool_call" && computerTools.has(data.name)) {
    // The sandbox starts on a task's first command or file, so that's where the task begins here too.
    if (!computer.run) {
      computer.run = { used: false };
      computer.entries.push({ note: "New task", time: Date.now() });
    }
    computer.entries.push({ id: data.id, name: data.name, input: parseJson(data.arguments) ?? {}, start: Date.now() });
    computer.entries.splice(0, computer.entries.length - computerEntryLimit);
  } else if (event === "tool_result") {
    const entry = pending((entry) => (entry.id && data.id ? entry.id === data.id : entry.name === data.name));
    if (!entry) return;
    settleEntry(computer, entry, data);
  } else if (event === "permission_requested") {
    const entry = pending((entry) => entry.name === data.request.tool && !entry.permission);
    if (!entry) return;
    entry.permission = data.request.id;
  } else if (event === "permission_resolved") {
    const entry = pending((entry) => entry.permission === data.id);
    if (!entry) return;
    delete entry.permission;
  } else return;
  if (selected?.id === bot.id) renderComputer();
}

/**
 * Records a step's result. A command keeps its exit code and output, a file updates the Files tab,
 * and only what the terminal shows stays on the entry.
 */
function settleEntry(computer, entry, { output, isError }) {
  Object.assign(entry, { end: Date.now(), failed: isError });
  delete entry.permission;
  if (isError) entry.output = output.replace(/^Error: /, "");
  else if (entry.name === "run_command") {
    computer.run.used = true;
    const match = /^exit code: (-?\d+)\n?/.exec(output);
    if (match) entry.exitCode = Number(match[1]);
    entry.output = (match ? output.slice(match[0].length) : output).replace(/\n$/, "");
  } else {
    computer.run.used = true;
    const text = entry.name === "read_file" ? output : entry.input.content;
    if (typeof text === "string") entry.lines = lineCount(text);
    trackFile(computer, entry, output);
  }
  const { command, cwd, path } = entry.input;
  entry.input = { command, cwd, path };
}

/**
 * Closes the bot's task in its computer view. The server stops the sandbox when a run ends,
 * but if the connection dropped first the task, and its computer, may still be going.
 */
function endComputerRun(bot, connected = true) {
  const computer = computers.get(bot.id);
  if (!computer?.run) return;
  for (const entry of computer.entries) if (entry.name && !entry.end) Object.assign(entry, { end: Date.now(), lost: true });
  if (!connected) computer.entries.push({ note: "Connection ended. The task may still be running.", time: Date.now() });
  else if (computer.run.used) computer.entries.push({ note: "Task finished. Computer stopped.", time: Date.now() });
  computer.run = undefined;
  if (selected?.id === bot.id) renderComputer();
}

/** Remembers a file the bot read, saved or edited, with the text it last had as far as this page knows. */
function trackFile(computer, entry, output) {
  const { path, content, old_string: before, new_string: after, replace_all: everywhere } = entry.input;
  if (typeof path !== "string") return;
  const file = computer.files.get(path) ?? { path };
  // Moved to the end, so the newest file is last.
  computer.files.delete(path);
  computer.files.set(path, Object.assign(file, { action: fileActions[entry.name], time: entry.end }));
  delete file.change;
  if (entry.name === "read_file") file.content = output;
  if (entry.name === "write_file") file.content = content;
  if (entry.name !== "edit_file") return;
  file.change = { before, after };
  // The whole file is only known if it was read or saved here first; then the same replacement brings it up to date.
  if (typeof file.content === "string" && file.content.includes(before))
    file.content = everywhere ? file.content.split(before).join(after) : file.content.replace(before, () => after);
  else delete file.content;
}

const lineCount = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const lineLabel = (count) => `${count} ${count === 1 ? "line" : "lines"}`;

/** How long a step took, how long it has been going, or why it has no result. */
function entryTime(entry) {
  if (!entry.end) return entry.permission ? element("span", "live-clock", "Waiting for your permission") : clock(entry.start);
  return element("span", "live-clock", entry.lost ? "No result" : duration(entry.end - entry.start));
}

function entryState(entry) {
  if (!entry.end) return "running";
  if (entry.failed || (entry.exitCode ?? 0) !== 0) return "failed";
  return entry.lost ? "lost" : "done";
}

function commandEntry(entry) {
  const block = element("div", `screen-command ${entryState(entry)}`);
  const line = element("div", "command-line");
  line.append(element("span", "prompt", "$"), element("code", "", entry.input.command ?? ""), entryTime(entry));
  block.append(line);
  if (entry.input.cwd) block.append(element("small", "command-cwd", `in ${entry.input.cwd}`));
  if (entry.output) {
    const lines = entry.output.split("\n");
    const hidden = entry.expanded ? 0 : Math.max(0, lines.length - commandTailLines);
    block.append(element("pre", entry.failed ? "command-output error" : "command-output", lines.slice(hidden).join("\n")));
    if (lines.length > commandTailLines) {
      const more = element("button", "screen-more", entry.expanded ? "Show the last lines only" : `Show all ${lines.length} lines`);
      more.type = "button";
      more.addEventListener("click", () => {
        entry.expanded = !entry.expanded;
        renderComputer();
      });
      block.append(more);
    }
  }
  if (entry.exitCode) block.append(element("span", "command-exit", `exit ${entry.exitCode}`));
  return block;
}

function fileEntry(entry) {
  const row = element("div", `screen-file ${entryState(entry)}`);
  const verbs = { read_file: ["Reading", "Read"], write_file: ["Saving", "Saved"], edit_file: ["Editing", "Edited"] }[entry.name];
  row.append(element("span", "prompt", "›"), element("span", "", verbs[entry.end ? 1 : 0]), element("code", "", entry.input.path ?? ""));
  if (entry.lines !== undefined) row.append(element("span", "file-size", lineLabel(entry.lines)));
  row.append(entryTime(entry));
  if (!entry.failed) return row;
  const block = element("div", "screen-command failed");
  block.append(row, element("pre", "command-output error", entry.output));
  return block;
}

function terminalView(computer, bot) {
  const screen = element("div", "computer-screen");
  screen.setAttribute("role", "log");
  screen.setAttribute("aria-label", `${bot.name}'s terminal`);
  if (!computer?.entries.length) {
    screen.classList.add("empty");
    // The chat lists steps from earlier tasks, but their sandbox session ended with them.
    const earlier = entries(bot).some((message) => message.tools?.some((tool) => computerTools.has(tool.name)));
    screen.append(
      element("p", "", earlier ? `The sandbox session from ${bot.name}'s earlier tasks was ephemeral and has been shut down.` : `${bot.name}'s computer isn't running.`),
      element("p", "", "Give it a task to watch the commands it runs, their output and the files it opens, live."),
    );
    return screen;
  }
  for (const entry of computer.entries) {
    if (entry.note) {
      const note = element("p", "screen-note");
      const time = element("time", "", clockTime(entry.time));
      time.dateTime = new Date(entry.time).toISOString();
      note.append(time, element("span", "", entry.note));
      screen.append(note);
    } else screen.append(entry.name === "run_command" ? commandEntry(entry) : fileEntry(entry));
  }
  return synced(screen);
}

function filesView(computer, bot) {
  const files = [...(computer?.files.values() ?? [])].reverse();
  if (!files.length) return element("p", "computer-empty", `No files yet. Files ${bot.name} reads, saves or edits show up here, newest first.`);
  const list = element("ul", "computer-files");
  for (const file of files) {
    const open = computer.openFile === file.path;
    const item = element("li", `computer-file${open ? " open" : ""}`);
    const toggle = element("button", "file-row");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(open));
    const slash = file.path.lastIndexOf("/");
    const name = element("span", "file-name");
    name.append(element("strong", "", file.path.slice(slash + 1)), element("small", "", slash > 0 ? file.path.slice(0, slash) : ""));
    toggle.append(name, element("span", "file-action", file.action), element("time", "", clockTime(file.time)));
    toggle.addEventListener("click", () => {
      computer.openFile = open ? "" : file.path;
      renderComputer();
    });
    item.append(toggle);
    if (open) {
      if (file.change) {
        const diff = element("pre", "file-diff");
        for (const [sign, text] of [["-", file.change.before], ["+", file.change.after]])
          for (const line of text ? text.split("\n") : []) diff.append(element("span", sign === "-" ? "removed" : "added", `${sign} ${line}\n`));
        item.append(diff);
      }
      if (typeof file.content === "string") item.append(element("pre", "file-content", file.content || "(empty file)"));
      else item.append(element("p", "computer-empty", `Only this change is known here. The whole file shows once ${bot.name} reads or saves it.`));
    }
    list.append(item);
  }
  return list;
}

/** Draws the selected bot's computer view, keeping the terminal pinned to the newest line unless you scrolled up. */
function renderComputer() {
  const computer = selected && computers.get(selected.id);
  $("#computer").classList.toggle("live", Boolean(computer?.run));
  const panel = $("#computer-panel");
  if (!selected || panel.hidden || currentPage !== "workspace") return;
  const bot = selected;
  const tab = computer?.tab ?? "terminal";
  // The same tab as last time keeps its scroll position.
  const before = panel.querySelector(tab === "files" ? ".computer-files" : ".computer-screen");
  const pinned = tab === "terminal" && (!before || before.scrollHeight - before.scrollTop - before.clientHeight < 40);

  const head = element("header", "computer-head");
  const title = element("div", "");
  title.append(element("h2", "", "Computer"), element("p", "", `${bot.name}'s Linux sandbox`));
  const state = element("span", `computer-state${computer?.run ? " on" : ""}`, computer?.run ? "On" : "Off");
  head.append(title, state);
  const note = element("p", "computer-note", "Starts when a task needs it and stops when the task ends. Its files stay.");

  const tabs = element("div", "computer-tabs");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Computer view");
  for (const [key, label] of [["terminal", "Terminal"], ["files", `Files${computer?.files.size ? ` ${computer.files.size}` : ""}`]]) {
    const button = element("button", tab === key ? "active" : "", label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(tab === key));
    button.addEventListener("click", () => {
      computerFor(bot).tab = key;
      renderComputer();
    });
    tabs.append(button);
  }

  const view = tab === "files" ? filesView(computer, bot) : terminalView(computer, bot);
  panel.replaceChildren(head, note, tabs, view);
  view.scrollTop = pinned ? view.scrollHeight : (before?.scrollTop ?? 0);
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
    const row = element("article", `message ${message.role}${message.from ? " delegated" : ""}`);
    const time = new Date(message.time).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const meta = element("div", "message-meta");
    // A brief the chief of staff sent this bot is shown as theirs, not the user's.
    const author = message.role === "user" ? message.from || profile.displayName || "You" : selected.name;
    if (message.role !== "user" || message.from) meta.append(avatar(author, 18));
    const stamp = element("time", "", time);
    stamp.dateTime = new Date(message.time).toISOString();
    meta.append(element("strong", "", author), stamp);
    row.append(meta);
    // Messages sent or started in this session rise in; older ones are already there.
    entrance(row, message.time, 350);
    const live = liveRuns.get(message);
    row.classList.toggle("writing", Boolean(message.pending && live?.phase === "writing"));
    if (message.text) row.append(renderMessage(message));
    if (message.tools?.length) row.append(message.pending ? liveSteps(message) : live?.phase === "done" ? entrance(toolTrail(message), live.since) : toolTrail(message));
    for (const request of message.permissions ?? []) row.append(permissionCard(request, message));
    if (message.pending) for (const delegation of message.delegations ?? []) row.append(delegationLine(delegation));
    if (message.pending) row.append(...liveLine(message));
    else if (message.status) row.append(element("div", "run-status", message.status));
    // An answer still streaming is redrawn on every token, so it gets its copy button once it settles.
    if (message.text && !message.pending) row.append(messageActions(message.text));
    transcript.append(row);
  }
  if (forceScroll || nearBottom) transcript.scrollTop = transcript.scrollHeight;
  renderContext();
}

function delegationLine(delegation) {
  const line = element("a", `delegation-line${delegation.done ? "" : " live"}`);
  line.href = "#bot/" + encodeURIComponent(delegation.name);
  line.title = `Open ${delegation.name} to follow its work`;
  line.append(avatar(delegation.name, 16), element("strong", "", delegation.name), element("span", delegation.done ? "" : "shimmer", delegation.status));
  if (!delegation.done) synced(line);
  line.addEventListener("click", (event) => {
    if (!handoff.items.some((item) => item.delegation === delegation)) return;
    event.preventDefault();
    openHandoff(delegation.id);
  });
  return line;
}

// The handoff modal follows the chief of staff's delegations in its current run.
// It opens by itself on the first one, unless the user has closed it during this run.
const handoff = { message: undefined, chief: undefined, items: [], focus: undefined, dismissed: false };

function openHandoff(id) {
  handoff.focus = id;
  renderHandoff();
  if (!$("#handoff-dialog").open) $("#handoff-dialog").showModal();
}

function focusedHandoff() {
  return handoff.items.findLast((item) => item.delegation.id === handoff.focus) ?? handoff.items.at(-1);
}

function renderHandoff() {
  const item = focusedHandoff();
  if (!item) return;
  const { delegation } = item;
  const arrow = element("span", `handoff-arrow${delegation.done ? "" : " live"}`, "→");
  arrow.setAttribute("aria-hidden", "true");
  $("#handoff-title").replaceChildren(
    avatar(handoff.chief.name, 24), arrow, avatar(delegation.name, 24),
    element("span", "", `${handoff.chief.name} handed this to ${delegation.name}`),
  );
  const tabs = $("#handoff-tabs");
  tabs.hidden = handoff.items.length < 2;
  tabs.replaceChildren(...handoff.items.map((other) => {
    const tab = element("button", other === item ? "active" : "", other.delegation.name);
    tab.type = "button";
    if (!other.delegation.done) tab.prepend(element("span", "handoff-dot"));
    tab.addEventListener("click", () => openHandoff(other.delegation.id));
    return tab;
  }));
  const target = bots.find((bot) => bot.id === delegation.id);
  $("#handoff-open").textContent = `Open ${delegation.name}'s chat`;
  $("#handoff-open").hidden = !target;
  renderHandoffWork();
}

/** Redrawn on every event the bot reports, so it stays out of the heading and tabs. */
function renderHandoffWork() {
  const item = focusedHandoff();
  if (!item) return;
  const previous = $("#handoff-content .handoff-work");
  const following = !previous || previous.scrollHeight - previous.scrollTop - previous.clientHeight < 40;
  const brief = element("div", "handoff-brief");
  linkedText(brief, item.task);
  const work = element("div", "handoff-work");
  const { reply } = item;
  work.classList.toggle("writing", Boolean(reply.pending && liveRuns.get(reply)?.phase === "writing"));
  if (reply.text) work.append(renderMessage(reply));
  if (reply.tools?.length) work.append(reply.pending ? liveSteps(reply) : stepsUsed(reply.tools));
  if (reply.pending && !item.delegation.done) work.append(...liveLine(reply));
  else work.append(element("div", "run-status", item.delegation.status || "Finished"));
  $("#handoff-content").replaceChildren(
    element("p", "handoff-label", "Brief"), brief,
    element("p", "handoff-label", `${item.delegation.name} is ${item.delegation.done ? "done" : "working"}`), work,
  );
  if (following) work.scrollTop = work.scrollHeight;
}

$("#handoff-dialog").addEventListener("close", () => { handoff.dismissed = true; });
$("#handoff-close").addEventListener("click", () => $("#handoff-dialog").close());
closeOnBackdrop($("#handoff-dialog"));
$("#handoff-open").addEventListener("click", () => {
  const target = bots.find((bot) => bot.id === focusedHandoff()?.delegation.id);
  $("#handoff-dialog").close();
  if (target) selectBot(target);
});

/**
 * Closes a dialog when you click the dimmed page around it. A click on the backdrop lands on the dialog itself,
 * outside its box. Both ends of the click must be out there, so a text selection that ends past the edge doesn't count.
 */
function closeOnBackdrop(dialog) {
  const outside = (event) => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (event) => { pressedOutside = outside(event); });
  dialog.addEventListener("click", (event) => {
    if (pressedOutside && outside(event)) dialog.close();
  });
}

// A bot's live reply to a brief from the chief of staff, by bot ID. Each bot takes one brief at a time.
const delegatedReplies = new Map();

const delegationEndings = { stopped: "Stopped", done: "Finished", step_limit: "Ran out of steps before finishing", failed: "Failed" };

// The chief of staff's delegations play out live in the other bot's own chat,
// and as a status line under the chief's reply. Returns whether that line changed.
function applyDelegation(event, data, message, chief) {
  const target = bots.find((item) => item.id === data.bot.id);
  message.delegations ??= [];
  if (event === "delegation_start") {
    const delegation = { id: data.bot.id, name: target?.name || data.bot.name, status: "Starting…" };
    message.delegations.push(delegation);
    // The server saves the brief and the reply in that bot's chat under these IDs.
    const time = Date.now();
    const reply = { id: data.messages?.reply ?? messageId(), role: "assistant", text: "", time, pending: true, status: "Starting…" };
    startLive(reply);
    delegatedReplies.set(data.bot.id, reply);
    if (handoff.message !== message) Object.assign(handoff, { message, chief, items: [], dismissed: false });
    handoff.items.push({ delegation, task: data.task, reply });
    const watching = selected === chief && currentPage === "workspace" && !document.querySelector("dialog[open]");
    if ($("#handoff-dialog").open) renderHandoff();
    else if (watching && !handoff.dismissed) openHandoff(delegation.id);
    // A bot created earlier in this run isn't in the bot list yet, so its chat is kept under the name it was given.
    addLocal(target ?? data.bot, { id: data.messages?.question ?? messageId(), role: "user", from: chief.name, text: data.task, time }, reply);
    if (target) {
      running.add(target.name);
      renderBots();
      if (selected === target) updateComposer();
    }
  }
  const delegation = message.delegations.findLast((item) => item.id === data.bot.id);
  const reply = delegatedReplies.get(data.bot.id);
  if (!delegation || !reply) return false;
  const before = delegation.status;
  if (event === "delegation_event") {
    watchComputer(data.bot, data.event.type, data.event);
    applyEvent(data.event.type, data.event, reply);
    delegation.status = reply.status;
  }
  if (event === "delegation_end") {
    endComputerRun(data.bot);
    finishReply(reply, data.answer, data.status === "done" ? "" : delegationEndings[data.status]);
    delegatedReplies.delete(data.bot.id);
    delegation.done = true;
    delegation.status = delegationEndings[data.status];
    if (target) settleBot(target);
  }
  if (target && selected === target) renderTranscript();
  if ($("#handoff-dialog").open) {
    if (event === "delegation_end") renderHandoff();
    else renderHandoffWork();
  }
  return event !== "delegation_event" || delegation.status !== before;
}

function finishReply(reply, answer, status) {
  reply.pending = false;
  setPhase(reply, "done");
  reply.text = answer || reply.text;
  reply.status = status;
  for (const tool of reply.tools ?? []) delete tool.arguments;
}

// Marks a bot idle after a run, flagging the result if the user is looking elsewhere.
function settleBot(bot) {
  running.delete(bot.name);
  if (selected !== bot || currentPage !== "workspace") unread.add(bot.name);
  renderBots();
  if (selected === bot) updateComposer();
  drainQueue(bot);
}

function updateComposer() {
  const busy = running.has(selected.name);
  $("#send").disabled = !$("#task").value.trim();
  $("#send").textContent = busy ? "Queue" : "Send";
  $("#stop").hidden = !busy;
  $("#stop").disabled = stopping.has(selected.name);
  $("#stop").textContent = stopping.has(selected.name) ? "Stopping…" : "Stop";
  renderQueue();
  $("#composer").classList.toggle("running", busy);
  $("#task").style.height = "auto";
  $("#task").style.height = `${Math.min($("#task").scrollHeight, 200)}px`;
}

function applyEvent(event, data, message) {
  const live = liveRuns.get(message);
  const toolsRunning = () => message.tools?.some((tool) => !("isError" in tool));
  const handlers = {
    permission_requested: () => {
      message.permissions ??= [];
      message.permissions.push(data.request);
      message.status = "Waiting for your permission…";
      setPhase(message, "waiting");
    },
    permission_resolved: () => {
      const request = message.permissions?.find((request) => request.id === data.id);
      if (request) request.decision = data.approved ? "Approved once" : "Denied or expired";
      message.status = data.approved ? "Permission approved; continuing…" : "Permission denied; continuing…";
      setPhase(message, toolsRunning() ? "tools" : "thinking");
    },
    message_delta: () => {
      // Each step's text replaces the last one's when it completes, so it streams in fresh too.
      if (live?.newText) message.text = "";
      if (live) live.newText = false;
      message.text += data.text;
      setPhase(message, "writing");
    },
    message: () => {
      message.text = data.text;
      setPhase(message, "thinking");
    },
    compaction: () => {
      message.status = "Summarizing earlier work to free up context…";
      setPhase(message, "compacting");
    },
    step: () => {
      message.status = "Thinking…";
      if (live) live.newText = true;
      setPhase(message, "thinking");
    },
    tool_call: () => {
      message.status = `${toolAlias(data.name, true)}…`;
      const tool = { name: data.name, arguments: data.arguments };
      (message.tools ??= []).push(tool);
      toolRuns.set(tool, { start: Date.now(), hint: toolHint(data.arguments) });
      setPhase(message, "tools");
    },
    tool_result: () => {
      const call = message.tools?.find((tool) => tool.name === data.name && !("isError" in tool));
      if (call) call.isError = data.isError;
      // Parallel calls finish one by one, so the status names one still going until none are.
      const other = message.tools?.find((tool) => !("isError" in tool));
      message.status = data.isError
        ? `${toolAlias(data.name, true)} failed; continuing…`
        : other ? `${toolAlias(other.name, true)}…` : toolAlias(data.name);
      if (!call) return;
      // The server makes the card, so the live view and the saved chat show the same one.
      if (data.card) call.output = data.card;
      delete call.arguments;
      const run = toolRuns.get(call);
      if (run) run.end = Date.now();
      if (!toolsRunning()) setPhase(message, "thinking");
    },
    result: () => {
      message.text =
        data.answer || message.text || (data.status === "stopped" ? "" : "Task finished without a text response.");
      message.status =
        data.status === "done" ? "" : data.status === "stopped" ? "Stopped" : `Run ended: ${data.status}`;
      // Token use and cost move to the bot panel instead of trailing every answer.
      if (data.usage) message.usage = data.usage;
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
  card.append(element("p", "permission-tool", toolAlias(request.tool, true)));
  card.append(element("pre", "permission-arguments", JSON.stringify(request.arguments, null, 2)));
  const expired = Date.parse(request.expiresAt) <= Date.now();
  if (request.decision || expired || !(message.pending || message.stillRunning)) {
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
        // A run this tab isn't streaming shows what happens next when its chat is read again.
        if (!message.pending && selected) void reloadMessages(selected);
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

// The server accepts up to 4000 characters per earlier message. A longer one keeps
// its start and its end, where a pasted document's question usually is, and says
// what was left out so the bot doesn't mistake the cut for the real ending.
function clipForContext(text, limit = 4000) {
  if (text.length <= limit) return text;
  const room = limit - 60; // the marker is always shorter than 60 characters
  let head = Math.floor(room / 2);
  let tail = text.length - (room - head);
  // Never split an emoji or other surrogate pair.
  if (/[\uD800-\uDBFF]/.test(text[head - 1])) head--;
  if (/[\uDC00-\uDFFF]/.test(text[tail])) tail++;
  return `${text.slice(0, head)}\n\n[… ${tail - head} characters of this message left out …]\n\n${text.slice(tail)}`;
}

function renderQueue() {
  const queue = messageQueues.get(selected.name) ?? [];
  const panel = $("#message-queue");
  panel.hidden = !queue.length;
  panel.replaceChildren();
  if (!queue.length) return;
  panel.append(element("strong", "", `${queue.length} message${queue.length === 1 ? "" : "s"} queued`));
  queue.forEach((task, index) => {
    const row = element("div", "queue-item");
    row.append(element("span", "", `${index + 1}. ${task}`));
    const remove = element("button", "button", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove queued message ${index + 1}`);
    remove.addEventListener("click", () => { queue.splice(index, 1); renderQueue(); });
    row.append(remove);
    panel.append(row);
  });
}

function drainQueue(bot) {
  if (running.has(bot.name)) return;
  const queue = messageQueues.get(bot.name);
  if (queue?.length) void runTask(bot, queue.shift());
}

function sendTask(task) {
  const bot = selected;
  task = task.trim();
  if (!task) return;
  $("#task").value = "";
  drafts.delete(bot.name);
  if (running.has(bot.name)) {
    if (!messageQueues.has(bot.name)) messageQueues.set(bot.name, []);
    messageQueues.get(bot.name).push(task);
    updateComposer();
    return;
  }
  void runTask(bot, task);
}

async function runTask(bot, task) {
  const key = bot.name.toLowerCase();
  history[key] ||= [];
  const conversation = history[key]
    .filter((entry) => ["user", "assistant"].includes(entry.role) && !entry.pending && entry.text.trim())
    .slice(-20)
    .map((entry) => ({ role: entry.role, content: clipForContext(entry.from ? `(Brief from ${entry.from}) ${entry.text}` : entry.text) }));
  if (!conversation.length && greetingFor(bot)) conversation.push({ role: "assistant", content: greetingFor(bot).message });
  // The question and its reply share a time, so sorting by time keeps the question first.
  const time = Date.now();
  const question = { id: messageId(), role: "user", text: task.trim(), time };
  const message = { id: messageId(), role: "assistant", text: "", time, pending: true, status: "Starting…" };
  startLive(message);
  addLocal(bot, question, message);
  running.add(bot.name);
  renderBots();
  if (selected === bot) { updateComposer(); renderTranscript(true); }
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ botName: bot.name, task: task.trim(), conversation, sessionId: `${bot.id}:${history[key][0].time}`, chat: { question: question.id, reply: message.id } }),
    });
    if (response.status === 401) showSignIn("Your session ended. Sign in again to continue.");
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Unable to start this task.");
    }
    await consumeStream(response, (event, data) => {
      if (!event.startsWith("delegation_")) watchComputer(bot, event, data);
      // A delegated bot's text streams into its own chat, so the chief's only redraws when a status line changes.
      const changed = event.startsWith("delegation_") ? applyDelegation(event, data, message, bot) : (applyEvent(event, data, message), true);
      if (changed && selected === bot) renderTranscript();
    });
  } catch (error) {
    message.role = "error";
    message.text = [message.text, error.message].filter(Boolean).join("\n\n");
    message.status = "";
  } finally {
    message.pending = false;
    setPhase(message, "done");
    for (const tool of message.tools ?? []) delete tool.arguments;
    endComputerRun(bot, false);
    // Bots still working when the chief's connection ended may finish on the server.
    for (const delegation of (message.delegations ?? []).filter((item) => !item.done)) {
      const reply = delegatedReplies.get(delegation.id);
      if (reply) finishReply(reply, "", "Connection ended. The task may still be running.");
      delegatedReplies.delete(delegation.id);
      delegation.done = true;
      delegation.status = "Connection ended. The task may still be running.";
      endComputerRun(delegation, false);
      const target = bots.find((item) => item.id === delegation.id);
      if (target) settleBot(target);
    }
    if (handoff.message === message && $("#handoff-dialog").open) renderHandoff();
    const delegated = new Set((message.delegations ?? []).map((delegation) => delegation.id));
    delete message.delegations;
    try {
      const updated = await api(`/api/bots/${encodeURIComponent(bot.name)}`);
      if (updated.role !== bot.role || updated.job !== bot.job) forgetGreeting(bot);
      Object.assign(bot, updated);
      if (message.tools?.some((tool) => ["create_bot", "update_bot"].includes(tool.name) && !tool.isError)) await refreshBots();
    } catch {}
    running.delete(bot.name);
    stopping.delete(bot.name);
    if (selected !== bot || currentPage !== "workspace") unread.add(bot.name);
    if (currentPage === "activity") renderActivity();
    // The server has saved this run, and any it handed to other bots, by the time it ends, so the saved copies replace the live ones.
    await Promise.all([bot, ...bots.filter((item) => item !== bot && delegated.has(item.id))].map(reloadMessages));
    renderBots();
    if (selected === bot) {
      $("#heading").replaceChildren(avatar(bot.name, 22), element("strong", "", bot.name), element("span", "", bot.role));
      renderTranscript();
      updateComposer();
    }
    drainQueue(bot);
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

// The chief of staff can create and reconfigure other bots while it works.
async function refreshBots() {
  const latest = (await api("/api/bots")).bots;
  bots = latest.map((item) => {
    const known = bots.find((bot) => bot.id === item.id);
    if (!known) return item;
    if (known.role !== item.role || known.job !== item.job) forgetGreeting(known);
    return Object.assign(known, item);
  });
}

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
    window.history.replaceState(null, "", "#bot/" + encodeURIComponent(bot.name));
    selectBot(bot);
    status.textContent = "Changes saved.";
  } catch (error) { status.textContent = error.message; }
  finally { for (const button of form.querySelectorAll("button")) button.disabled = false; }
}

async function removeBotProfile(bot, form, status) {
  if (!window.confirm(`Delete ${bot.name}? Its sandbox, with every file in it, and its chat history will be deleted, and upcoming schedules cancelled. Saved memory will be retained.`)) return;
  for (const button of form.querySelectorAll("button")) button.disabled = true;
  status.textContent = "Deleting…";
  try {
    await api(`/api/bots/${encodeURIComponent(bot.name)}`, { method: "DELETE" });
    bots = bots.filter((item) => item.id !== bot.id);
    // History is kept by name, so a new bot given this name would otherwise inherit the chat.
    delete history[bot.name.toLowerCase()];
    computers.delete(bot.id);
    drafts.delete(bot.name);
    unread.delete(bot.name);
    forgetGreeting(bot);
    selected = undefined;
    window.history.replaceState(null, "", "#workspace");
    renderBots();
    route();
  } catch (error) { status.textContent = error.message; }
  finally { for (const button of form.querySelectorAll("button")) button.disabled = false; }
}

async function clearChat(bot, button) {
  if (!window.confirm(`Clear your chat with ${bot.name}? Every message is deleted on all your devices, and its next task starts without them. Its memory, files and schedules are kept.`)) return;
  button.disabled = true;
  try {
    await api(`/api/bots/${encodeURIComponent(bot.name)}/messages`, { method: "DELETE" });
    history[bot.name.toLowerCase()] = [];
    renderBots();
    if (selected === bot && currentPage === "workspace") {
      renderTranscript(true);
      $("#task").focus();
    }
  } catch (error) {
    button.disabled = false;
    notify(`Could not clear the chat: ${error.message}`);
  }
}

const detailViews = {
  purpose: async (panel, bot) => {
    const form = element("form", "");
    for (const [name, title] of [["name", "Name"], ["role", "Description"], ["job", "Working instructions"]]) {
      const label = element("label", "", title);
      const input = element(name === "name" ? "input" : "textarea", "");
      input.name = name;
      input.value = bot[name];
      input.required = name !== "job";
      input.maxLength = name === "name" ? 200 : 100000;
      input.rows = name === "job" ? 10 : 4;
      if (name === "job") input.placeholder = "Anything it should always do, like steps to follow or how to format results";
      label.append(input);
      form.append(label);
    }
    const status = element("span", "form-status");
    status.setAttribute("role", "status");
    const actions = element("div", "form-actions");
    actions.append(status, element("button", "button primary", "Save changes"));
    form.append(actions);
    // Deleting sits apart from saving, so it isn't pressed by mistake.
    const danger = element("div", "danger-zone");
    if (bot.primary) {
      danger.append(element("p", "muted", "This is your chief of staff. It runs your other bots and can't be deleted, but you can rename it and change its purpose."));
    } else {
      const remove = element("button", "button secondary danger", "Delete bot");
      remove.type = "button";
      const removing = element("p", "form-status");
      removing.setAttribute("role", "status");
      remove.addEventListener("click", () => removeBotProfile(bot, form, removing));
      danger.append(element("p", "muted", "Deleting removes its sandbox and files and cancels upcoming schedules. Saved memory is kept."), remove, removing);
    }
    form.append(danger);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveBotProfile(bot, form, status);
    });
    panel.append(form);
  },
  memory: async (panel, bot) => {
    panel.append(element("p", "detail-note", `${bot.name} updates these notes as it learns. Your edits apply from its next task.`));
    for (const [file, title, hint] of [
      ["PREFERENCES.md", "Preferences", "How you like things done."],
      ["KNOWLEDGE.md", "Knowledge", "Facts about you and your work."],
    ]) {
      const path = `/api/bots/${encodeURIComponent(bot.name)}/memory/${file}`;
      const data = await api(path);
      const section = element("div", "memory-file");
      const label = element("label", "", title);
      label.title = file;
      label.append(element("small", "", hint));
      const input = element("textarea", "");
      input.rows = 10;
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
          "No skills yet. Ask this bot to save a way of working as a skill, or add one for every bot with pnpm pekka skills add <folder>.",
        ),
      );
    const list = element("div", "detail-list");
    for (const skill of data.skills) {
      const row = element("div", "detail-row");
      const name = element("h3", "", skill.name);
      name.append(element("span", "", skillSources[skill.source] ?? ""));
      row.append(name, element("p", "", skill.description));
      list.append(row);
    }
    if (data.skills.length) panel.append(list);
    for (const error of data.errors) panel.append(element("p", "error", error));
  },
};

const mobileSidebar = window.matchMedia("(max-width: 600px)");

function sidebarExpanded() {
  return mobileSidebar.matches
    ? $("#sidebar").classList.contains("open")
    : !$("#sidebar").classList.contains("collapsed");
}

function sidebarRail() {
  return !mobileSidebar.matches && $("#sidebar").classList.contains("collapsed");
}

function syncSidebarToggle() {
  const expanded = sidebarExpanded();
  $("#menu").setAttribute("aria-expanded", String(expanded));
  $("#menu").title = expanded ? "Collapse sidebar" : "Expand sidebar";
  $(".profile-link").title = sidebarRail() ? $("#profile-label").textContent : "";
}

function setSidebarExpanded(expanded) {
  const className = mobileSidebar.matches ? "open" : "collapsed";
  $("#sidebar").classList.toggle(className, mobileSidebar.matches ? expanded : !expanded);
  syncSidebarToggle();
  renderBots();
}

function closeDrawer() {
  $("#sidebar").classList.remove("open");
  syncSidebarToggle();
}

mobileSidebar.addEventListener("change", closeDrawer);
mobileSidebar.addEventListener("change", renderBots);
syncSidebarToggle();

// One side panel shows at a time: the bot panel ("context") or the computer view ("computer").
// Wide screens keep it beside the chat, remembered per browser; narrower ones open it over the chat.
const widePanel = window.matchMedia("(min-width: 1280px)");
const panelKey = "pekka.bot-panel.v1";
const sidePanels = {
  context: { panel: "#context-panel", toggle: "#details", name: "bot panel", render: () => renderContext() },
  computer: { panel: "#computer-panel", toggle: "#computer", name: "computer view", render: () => renderComputer() },
};
// Set this to false to hide the computer view's button and help entry.
const computerViewEnabled = true;
for (const node of document.querySelectorAll("[data-computer-view]")) node.hidden = !computerViewEnabled;
let pinnedPanel = "context";
let overlayPanel = "";
try {
  // Saved as "open" or "closed" before the computer view existed.
  pinnedPanel =
    { closed: "", computer: computerViewEnabled ? "computer" : "context" }[localStorage.getItem(panelKey)] ?? "context";
} catch {}

/** The side panel that is open, or "" for none. */
function openPanel() {
  return widePanel.matches ? pinnedPanel : overlayPanel;
}

function setPanel(panel) {
  if (widePanel.matches) {
    pinnedPanel = panel;
    try {
      localStorage.setItem(panelKey, panel || "closed");
    } catch {}
  } else overlayPanel = panel;
  syncPanel();
}

function togglePanel(panel) {
  setPanel(openPanel() === panel ? "" : panel);
}

function syncPanel() {
  const open = openPanel();
  for (const [key, side] of Object.entries(sidePanels)) {
    $(side.panel).hidden = open !== key;
    $(side.panel).classList.toggle("overlay", !widePanel.matches);
    $(side.toggle).setAttribute("aria-expanded", String(open === key));
    $(side.toggle).title = `${open === key ? "Hide" : "Show"} ${side.name}`;
    if (open === key) side.render();
  }
}

widePanel.addEventListener("change", () => {
  overlayPanel = "";
  syncPanel();
});
syncPanel();

function markdownLinks(text) {
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s<>)]+)\)|https?:\/\/[^\s<>)\]]+/g;
  return [...text.matchAll(pattern)].map((match) => ({
    url: (match[2] || match[0]).replace(/[.,;:!?]+$/, ""),
    label: match[1] || "",
  }));
}

const chevronIcon = (direction) =>
  `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="${direction === "left" ? "M12 4.5 6.5 10l5.5 5.5" : "m8 4.5 5.5 5.5L8 15.5"}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

// The bot panel shows the bot at a glance, or one of its settings opened from there.
// `view` belongs to the bot with id `bot`, so opening another bot starts back at the overview.
let panelView = { bot: undefined, view: "" };
let panelVersion = 0;
const skillSources = { bot: "This bot", shared: "Shared", base: "Built in" };
const botSettings = {
  purpose: ["Purpose", "Name, description and instructions"],
  memory: ["Memory", "What it has learned about you"],
  skills: ["Skills", "Know-how it loads when a task needs it"],
};

function openBotSetting(bot, view) {
  panelView = { bot: bot.id, view };
  if (openPanel() === "context") renderContext();
  else setPanel("context");
  $("#context-panel .panel-back")?.focus();
}

function closeBotSetting() {
  const { view } = panelView;
  panelView.view = "";
  renderContext();
  $(`#context-panel [data-setting="${view}"]`)?.focus();
}

function panelSection(title, body, action) {
  const section = element("section", "context-section");
  const head = element("div", "context-section-head");
  head.append(element("h3", "", title));
  if (action) head.append(action);
  section.append(head, body);
  return section;
}

function renderContext() {
  const panel = $("#context-panel");
  if (!selected || panel.hidden || currentPage !== "workspace") return;
  const bot = selected;
  const view = panelView.bot === bot.id ? panelView.view : "";
  panel.classList.toggle("setting", Boolean(view));
  if (!view) return renderBotOverview(panel, bot);
  // A setting is drawn once when it opens, so the redraws a streaming reply causes keep what you typed.
  const key = `${bot.id}:${view}`;
  if (panel.dataset.view === key) {
    // Only a rename changes the heading, so the back button otherwise keeps its focus.
    const head = panel.querySelector(".panel-head");
    if (head.querySelector("p").textContent !== bot.name) head.replaceWith(settingHead(bot, view));
    return;
  }
  panel.dataset.view = key;
  const body = element("div", "panel-body");
  body.append(element("p", "loading", "Loading…"));
  panel.replaceChildren(settingHead(bot, view), body);
  panel.scrollTop = 0;
  const version = ++panelVersion;
  const content = element("div", "");
  detailViews[view](content, bot).then(
    () => version === panelVersion && body.replaceChildren(content),
    (error) => version === panelVersion && body.replaceChildren(element("p", "error", error.message)),
  );
}

function settingHead(bot, view) {
  const head = element("header", "panel-head");
  const back = element("button", "icon-button panel-back");
  back.type = "button";
  back.title = `Back to ${bot.name}`;
  back.setAttribute("aria-label", `Back to ${bot.name}`);
  back.innerHTML = chevronIcon("left");
  back.addEventListener("click", closeBotSetting);
  const title = element("div", "");
  title.append(element("h2", "", botSettings[view][0]), element("p", "", bot.name));
  head.append(back, title);
  return head;
}

function renderBotOverview(panel, bot) {
  // Drops a setting that is still loading, so it can't replace the overview when it arrives.
  panelVersion++;
  panel.dataset.view = "";
  const about = element("header", "context-about");
  const name = element("div", "");
  name.append(element("h2", "", bot.name));
  if (bot.primary && bot.name.toLowerCase() !== "chief of staff") name.append(element("span", "context-tag", "Chief of staff"));
  about.append(avatar(bot.name, 40), name);

  const settings = element("nav", "context-settings");
  settings.setAttribute("aria-label", `${bot.name} settings`);
  for (const [view, [label, hint]] of Object.entries(botSettings)) {
    const row = element("button", "setting-row");
    row.type = "button";
    row.dataset.setting = view;
    const copy = element("span", "setting-copy");
    copy.append(element("strong", "", label), element("small", "", hint));
    row.append(copy);
    row.insertAdjacentHTML("beforeend", chevronIcon("right"));
    row.addEventListener("click", () => openBotSetting(bot, view));
    settings.append(row);
  }

  const answers = entries(bot).filter((message) => message.role === "assistant").reverse();
  // A streaming reply redraws the overview on every token, so a focused setting row is focused again.
  const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.setting : undefined;
  panel.replaceChildren(about, element("p", "context-role", bot.role), settings, scheduleSection(bot), chatSection(bot, answers));
  if (focused) panel.querySelector(`[data-setting="${focused}"]`).focus();
  const usage = answers.find((message) => message.usage)?.usage;
  if (usage) panel.append(usageLine(usage));
}

function scheduleSection(bot) {
  const add = element("a", "context-add");
  add.href = "#scheduled/new";
  add.title = `Schedule a task for ${bot.name}`;
  add.setAttribute("aria-label", `Schedule a task for ${bot.name}`);
  add.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.5" /></svg>New';
  add.addEventListener("click", () => { scheduleDraft = { botName: bot.name }; });
  const list = element("div", "context-list");
  for (const job of jobs.filter((job) => job.bot?.id === bot.id && upcomingStatuses.includes(job.status))) {
    const row = element("a", "context-row");
    row.href = "#scheduled/" + encodeURIComponent(job.id);
    row.append(element("strong", "", job.name), element("small", "", jobSummary(job)));
    list.append(row);
  }
  if (!list.children.length) list.append(element("p", "context-empty", "Nothing scheduled."));
  return panelSection("Scheduled", list, add);
}

/** What the bot made and the links it shared in this chat, newest first. */
function chatSection(bot, answers) {
  const list = element("div", "context-list");
  const outputs = answers.flatMap((message) => (message.tools ?? []).filter((tool) => tool.output).map((tool) => [tool.output, message]));
  for (const [output, message] of outputs.slice(0, 6)) list.append(outputCard(output, message));
  const seen = new Set(outputs.map(([output]) => output.url));
  let links = 0;
  for (const link of answers.flatMap((message) => markdownLinks(message.text))) {
    if (seen.has(link.url) || links >= 8) continue;
    seen.add(link.url);
    links++;
    let host = link.url;
    try {
      host = new URL(link.url).hostname.replace(/^www\./, "");
    } catch {}
    const row = element("a", "output-card link-card");
    row.href = link.url;
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    const icon = element("span", "output-icon");
    icon.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M8.5 11.5a3 3 0 0 0 4.24 0l2.83-2.83a3 3 0 0 0-4.24-4.24l-1 1M11.5 8.5a3 3 0 0 0-4.24 0l-2.83 2.83a3 3 0 0 0 4.24 4.24l1-1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>';
    const copy = element("span", "output-copy");
    copy.append(element("strong", "", link.label || host), element("small", "", host));
    row.append(icon, copy, element("span", "output-open", "↗"));
    list.append(row);
  }
  if (!list.children.length) list.append(element("p", "context-empty", "Links it shares and things it makes, like pages and emails, collect here."));
  return panelSection("From this chat", list, entries(bot).length ? clearChatButton(bot) : undefined);
}

function clearChatButton(bot) {
  const clear = element("button", "context-add danger");
  clear.type = "button";
  // Messages a running reply saves would come back after clearing, so it waits until the bot is done.
  clear.disabled = running.has(bot.name);
  clear.title = clear.disabled ? `Clear the chat once ${bot.name} finishes` : `Clear your chat with ${bot.name}`;
  clear.setAttribute("aria-label", clear.title);
  clear.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>Clear chat';
  clear.addEventListener("click", () => clearChat(bot, clear));
  return clear;
}

function usageLine(usage) {
  const line = element("p", "context-usage");
  const tokens = usage.promptTokens + usage.completionTokens;
  const parts = [`${tokens.toLocaleString()} tokens`];
  if (usage.cacheHitRate != null) parts.push(`${(usage.cacheHitRate * 100).toFixed(0)}% cached`);
  parts.push(`$${usage.costUsd.toFixed(4)}`);
  line.title = `${usage.promptTokens.toLocaleString()} input and ${usage.completionTokens.toLocaleString()} output tokens`;
  line.append(element("span", "", "Last run"), element("span", "", parts.join(" · ")));
  return line;
}

$("#new-bot").addEventListener("click", () => openCreate());
$("#rail-new-bot").addEventListener("click", () => openCreate());
$("#welcome-create").addEventListener("click", () => openCreate());
$("#search").addEventListener("input", renderBots);
$("#menu").addEventListener("click", () =>
  setSidebarExpanded(!sidebarExpanded()),
);
$(".app > main").addEventListener("click", (event) => {
  if (!event.target.closest("#menu")) closeDrawer();
  // Only clicks in the chat the panel covers close it; the header's buttons, like the sidebar toggle, leave it open.
  // The computer view redraws on its own clicks, so the clicked node may already be gone; the event's path still has it.
  const inside = event.composedPath().some((node) => node.matches?.("#context-panel, #computer-panel, .topbar"));
  if (overlayPanel && !inside) setPanel("");
});
$("#stop").addEventListener("click", async () => {
  const bot = selected;
  stopping.add(bot.name);
  updateComposer();
  try {
    const result = await api(`/api/bots/${encodeURIComponent(bot.name)}/stop`, { method: "POST" });
    if (!result.stopping) stopping.delete(bot.name);
  } catch (error) {
    stopping.delete(bot.name);
    alert(error.message);
  }
  if (selected === bot) updateComposer();
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
$("#details").addEventListener("click", () => togglePanel("context"));
$("#computer").addEventListener("click", () => togglePanel("computer"));
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
  if (event.key === "Escape") {
    // In an open setting, Escape steps back to the overview, unless you are typing in it.
    if (panelView.view && event.target.closest?.("#context-panel") && !event.target.matches("input,textarea,select")) {
      closeBotSetting();
      return;
    }
    closeDrawer();
    if (overlayPanel && !document.querySelector("dialog[open]")) setPanel("");
  }
});
// Coming back to this tab picks up messages sent from another tab or device in the meantime.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && selected && currentPage === "workspace") void refreshMessages(selected);
});
window.addEventListener("beforeunload", (event) => {
  if (running.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function initialize() {
  try {
    bots = (await api("/api/bots")).bots;
  } catch (error) {
    notify(`Could not load bots: ${error.message} Reload to try again.`);
    return;
  }
  // Every chat loads before the first one shows, so a bot with history doesn't ask for a greeting.
  const failed = (await Promise.allSettled(bots.map(loadMessages))).find((result) => result.status === "rejected");
  if (failed) notify(`Some chats could not be loaded: ${failed.reason.message} Reload to try again.`);
  loaded = true;
  renderBots();
  route();
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
  $("#profile-avatar").textContent = (name || "You").slice(0, 1).toUpperCase();
  $("#profile-name").textContent = name || "Your profile";
  $("#profile-occupation").textContent = profile.occupation || "Add a little about yourself.";
  $("#profile-bio").textContent = profile.bio;
  $("#profile-bio").hidden = !profile.bio;
  updateProfileEditor();
  syncSidebarToggle();
}

function updateProfileEditor() {
  const form = $("#profile-form");
  const changed = Object.keys(profileDefaults).some((key) => form.elements[key].value !== profile[key]);
  $("#profile-discard").disabled = !changed;
  $("#profile-bio-count").textContent = `${form.elements.bio.value.length} / 500`;
  return changed;
}

/** Reads this account's profile, preferences and cached greetings from browser storage. Chats come from the server. */
function loadBrowserState() {
  profile = loadLocal(scoped(profileKey), profileDefaults);
  preferences = loadLocal(scoped(preferencesKey), preferenceDefaults);
  history = Object.create(null);
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
    ? "Your profile details are saved in this browser for this account and do not sync between devices. Google provides your account email."
    : "This profile is saved in this browser and does not sync between devices.";
  $("#profile-storage").textContent = account ? "Google account · Local details" : "Browser profile";
}

function applyPreferences() {
  document.documentElement.classList.toggle("compact", preferences.compact);
  document.documentElement.classList.toggle("reduce-motion", preferences.reduceMotion);
  $("#send-hint").textContent = preferences.enterToSend
    ? "Enter to send, Shift + Enter for a new line"
    : "Enter adds a new line";
}

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

function savedTheme() {
  try {
    const value = localStorage.getItem(themeKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme() {
  const dark = theme === "system" ? darkScheme.matches : theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
  $(`#theme-picker input[value="${theme}"]`).checked = true;
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
    profile: ["Profile", "Your identity, personal details and account."],
    settings: ["Settings", "Preferences for this browser. They apply to every bot."],
    activity: ["Activity", "Tasks you sent to your bots, newest first."],
    help: ["Help", "How bots, memory and schedules work."],
    plugins: ["Plugins", "Connect your tools and choose what Pekka can access."],
  };
  $("#welcome").hidden = true;
  $("#conversation").hidden = true;
  $("#panel-toggles").hidden = true;
  $("#scheduled").hidden = true;
  $("#pages").hidden = false;
  $("#pages").classList.toggle("plugin-page", page === "plugins");
  $("#pages").classList.toggle("profile-page", page === "profile");
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
  if (page === "settings") loadModelKey();
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
  $("#panel-toggles").hidden = true;
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
  for (const id of Object.keys(googlePlugins)) renderGoogle(id);
  renderTelegram();
  renderGithub();
  renderLinear();
  renderWispr();
  renderTodoist();
  for (const id of Object.keys(apiKeyPlugins)) renderApiKeyPlugin(id);
  renderPluginCatalog();
}

let pluginFilter = "all";

function renderPluginCatalog() {
  const query = $("#plugin-search").value.trim().toLowerCase();
  const installed = $("#plugin-installed");
  installed.replaceChildren();
  const connections = { notion: notionPlugin, ...googleStatus, telegram: telegramPlugin, github: githubPlugin, linear: linearPlugin, wispr: wisprPlugin, todoist: todoistPlugin, ...apiKeyStatus };
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

function renderGoogle(id) {
  const plugin = googleStatus[id];
  const { name } = googlePlugins[id];
  const connected = Boolean(plugin?.connected);
  const configured = Boolean(plugin?.configured);
  $(`#${id}-card`).setAttribute("aria-busy", String(pluginsBusy));
  $(`#${id}-state`).textContent = !plugin ? (pluginsBusy ? "Loading…" : "Unavailable") : connected ? (plugin.enabled ? "Access enabled" : "Access off") : configured ? "Not connected" : "Setup required";
  $(`#${id}-state`).classList.toggle("enabled", connected && plugin.enabled);
  $(`#${id}-setup`).hidden = !plugin || configured;
  $(`#${id}-account`).hidden = !connected;
  $(`#${id}-account`).textContent = connected ? `Connected to ${plugin.workspaceName || "your Google account"}` : "";
  $(`#${id}-permission`).hidden = !connected;
  if (!pluginsBusy) $(`#${id}-enabled`).checked = connected && plugin.enabled;
  $(`#${id}-enabled`).disabled = pluginsBusy || !connected;
  $(`#${id}-connect`).textContent = connected ? `Reconnect ${name}` : `Connect ${name}`;
  $(`#${id}-connect`).disabled = pluginsBusy || !configured;
  $(`#${id}-disconnect`).hidden = !connected;
  $(`#${id}-disconnect`).disabled = pluginsBusy;
  $(`#${id}-use`).hidden = !connected;
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
    ...Object.fromEntries(Object.entries(googlePlugins).map(([id, { name, grant }]) => [id, {
      connected: `${name} connected. Choose whether to allow Pekka access below.`,
      denied: `${name} connection was cancelled. You can try again whenever you're ready.`,
      error: `${name} could not be connected. Make sure you allowed ${grant} on Google's consent screen, or check the server's OAuth setup.`,
    }])),
    github: { connected: "GitHub connected. Choose whether to allow Pekka access below.", denied: "GitHub connection was cancelled. You can try again whenever you're ready.", error: "GitHub could not be connected. Try again or check the server's OAuth setup." },
    todoist: { connected: "Todoist connected. Choose whether to allow Pekka access below.", denied: "Todoist connection was cancelled.", error: "Todoist could not be connected. Try again or check the server setup." },
    wispr: { connected: "Wispr Flow connected. Choose whether to allow Pekka access below.", denied: "Wispr Flow connection was cancelled.", error: "Wispr Flow could not be connected. Try again or check the server setup." },
    linear: { connected: "Linear connected. Choose whether to allow Pekka access below.", denied: "Linear connection was cancelled. You can try again whenever you're ready.", error: "Linear could not be connected. Try again or check the server's OAuth setup." },
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
    googleStatus = Object.fromEntries(Object.keys(googlePlugins).map((id) => [id, data.plugins.find((plugin) => plugin.id === id)]));
    telegramPlugin = data.plugins.find((plugin) => plugin.id === "telegram");
    stopTelegramLink();
    telegramLink = telegramPlugin?.linkUrl;
    if (telegramLink && currentPage === "plugins") {
      $("#telegram-card details").open = true;
      telegramPoll = setTimeout(checkTelegramLink, 3000);
    }
    githubPlugin = data.plugins.find((plugin) => plugin.id === "github");
    linearPlugin = data.plugins.find((plugin) => plugin.id === "linear");
    todoistPlugin = data.plugins.find((plugin) => plugin.id === "todoist");
    wisprPlugin = data.plugins.find((plugin) => plugin.id === "wispr");
    apiKeyStatus = Object.fromEntries(Object.keys(apiKeyPlugins).map((id) => [id, data.plugins.find((plugin) => plugin.id === id)]));
  } catch (error) {
    notionPlugin = undefined;
    googleStatus = {};
    telegramPlugin = undefined;
    githubPlugin = undefined;
    linearPlugin = undefined;
    wisprPlugin = undefined;
    todoistPlugin = undefined;
    apiKeyStatus = {};
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

function renderLinear() {
  const connected = Boolean(linearPlugin?.connected);
  const configured = Boolean(linearPlugin?.configured);
  $("#linear-card").setAttribute("aria-busy", String(pluginsBusy));
  $("#linear-state").textContent = !linearPlugin ? (pluginsBusy ? "Loading…" : "Unavailable") : connected ? (linearPlugin.enabled ? "Access enabled" : "Access off") : configured ? "Not connected" : "Setup required";
  $("#linear-state").classList.toggle("enabled", connected && linearPlugin.enabled);
  $("#linear-setup").hidden = !linearPlugin || configured;
  $("#linear-workspace").hidden = !connected;
  $("#linear-workspace").textContent = connected ? `Connected to ${linearPlugin.workspaceName || "your Linear workspace"}` : "";
  $("#linear-permission").hidden = !connected;
  if (!pluginsBusy) $("#linear-enabled").checked = connected && linearPlugin.enabled;
  $("#linear-enabled").disabled = pluginsBusy || !connected;
  $("#linear-connect").textContent = connected ? "Reconnect Linear" : "Add Linear";
  $("#linear-connect").disabled = pluginsBusy || !configured;
  $("#linear-disconnect").hidden = !connected;
  $("#linear-disconnect").disabled = pluginsBusy;
  $("#linear-use").hidden = !connected;
}

async function changeLinear(action) {
  if (pluginsBusy) return;
  pluginsBusy = true;
  const enabled = $("#linear-enabled").checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? "Opening Linear…" : "Saving…";
  try {
    if (action === "connect") {
      const result = await api("/api/plugins/linear/connect", { method: "POST", body: "{}" });
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.hostname !== "linear.app" || target.pathname !== "/oauth/authorize") throw new Error("Invalid Linear authorization URL.");
      location.assign(target.href);
      return;
    }
    linearPlugin = await api("/api/plugins/linear", action === "disconnect" ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ enabled }) });
    $("#plugin-status").textContent = action === "disconnect" ? "Linear disconnected. Pekka no longer has access." : enabled ? "Linear access enabled for all bots." : "Linear access turned off.";
  } catch (error) {
    const message = `Could not update Linear: ${error.message}`;
    pluginsBusy = false;
    await loadPlugins();
    $("#plugin-status").textContent = linearPlugin ? message : `${message} Refresh to check the current connection state.`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

$("#linear-connect").addEventListener("click", () => changeLinear("connect"));
$("#linear-disconnect").addEventListener("click", () => changeLinear("disconnect"));
$("#linear-enabled").addEventListener("change", () => changeLinear("permission"));

function renderWispr() {
  const connected = Boolean(wisprPlugin?.connected);
  const configured = Boolean(wisprPlugin?.configured);
  $("#wispr-card").setAttribute("aria-busy", String(pluginsBusy));
  $("#wispr-state").textContent = !wisprPlugin ? (pluginsBusy ? "Loading…" : "Unavailable") : connected ? (wisprPlugin.enabled ? "Access enabled" : "Access off") : configured ? "Not connected" : "Setup required";
  $("#wispr-state").classList.toggle("enabled", connected && wisprPlugin.enabled);
  $("#wispr-setup").hidden = !wisprPlugin || configured;
  $("#wispr-workspace").hidden = !connected;
  $("#wispr-workspace").textContent = connected ? `Connected to ${wisprPlugin.workspaceName || "your Wispr Flow account"}` : "";
  $("#wispr-permission").hidden = !connected;
  if (!pluginsBusy) $("#wispr-enabled").checked = connected && wisprPlugin.enabled;
  $("#wispr-enabled").disabled = pluginsBusy || !connected;
  $("#wispr-connect").textContent = connected ? "Reconnect Wispr Flow" : "Add Wispr Flow";
  $("#wispr-connect").disabled = pluginsBusy || !configured;
  $("#wispr-disconnect").hidden = !connected;
  $("#wispr-disconnect").disabled = pluginsBusy;
  $("#wispr-use").hidden = !connected;
}

async function changeWispr(action) {
  if (pluginsBusy) return;
  pluginsBusy = true;
  const enabled = $("#wispr-enabled").checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? "Opening Wispr Flow…" : "Saving…";
  try {
    if (action === "connect") {
      const result = await api("/api/plugins/wispr/connect", { method: "POST", body: "{}" });
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.hostname !== "mcp-auth.wisprflow.com" || target.pathname !== "/oauth2/authorize") throw new Error("Invalid Wispr Flow authorization URL.");
      location.assign(target.href);
      return;
    }
    wisprPlugin = await api("/api/plugins/wispr", action === "disconnect" ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ enabled }) });
    $("#plugin-status").textContent = action === "disconnect" ? "Wispr Flow disconnected. Pekka no longer has access." : enabled ? "Wispr Flow access enabled for all bots." : "Wispr Flow access turned off.";
  } catch (error) {
    const message = `Could not update Wispr Flow: ${error.message}`;
    pluginsBusy = false;
    await loadPlugins();
    $("#plugin-status").textContent = wisprPlugin ? message : `${message} Refresh to check the current connection state.`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

$("#wispr-connect").addEventListener("click", () => changeWispr("connect"));
$("#wispr-disconnect").addEventListener("click", () => changeWispr("disconnect"));
$("#wispr-enabled").addEventListener("change", () => changeWispr("permission"));

function renderTodoist() {
  const connected = Boolean(todoistPlugin?.connected);
  const configured = Boolean(todoistPlugin?.configured);
  $("#todoist-card").setAttribute("aria-busy", String(pluginsBusy));
  $("#todoist-state").textContent = !todoistPlugin ? (pluginsBusy ? "Loading…" : "Unavailable") : connected ? (todoistPlugin.enabled ? "Access enabled" : "Access off") : configured ? "Not connected" : "Setup required";
  $("#todoist-state").classList.toggle("enabled", connected && todoistPlugin.enabled);
  $("#todoist-setup").hidden = !todoistPlugin || configured;
  $("#todoist-workspace").hidden = !connected;
  $("#todoist-workspace").textContent = connected ? `Connected to ${todoistPlugin.workspaceName || "your Todoist account"}` : "";
  $("#todoist-permission").hidden = !connected;
  if (!pluginsBusy) $("#todoist-enabled").checked = connected && todoistPlugin.enabled;
  $("#todoist-enabled").disabled = pluginsBusy || !connected;
  $("#todoist-connect").textContent = connected ? "Reconnect Todoist" : "Add Todoist";
  $("#todoist-connect").disabled = pluginsBusy || !configured;
  $("#todoist-disconnect").hidden = !connected;
  $("#todoist-disconnect").disabled = pluginsBusy;
  $("#todoist-use").hidden = !connected;
}

async function changeTodoist(action) {
  if (pluginsBusy) return;
  pluginsBusy = true;
  const enabled = $("#todoist-enabled").checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? "Opening Todoist…" : "Saving…";
  try {
    if (action === "connect") {
      const result = await api("/api/plugins/todoist/connect", { method: "POST", body: "{}" });
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.hostname !== "todoist.com" || target.pathname !== "/oauth/authorize") throw new Error("Invalid Todoist authorization URL.");
      location.assign(target.href);
      return;
    }
    todoistPlugin = await api("/api/plugins/todoist", action === "disconnect" ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ enabled }) });
    $("#plugin-status").textContent = action === "disconnect" ? "Todoist disconnected. Pekka no longer has access." : enabled ? "Todoist access enabled for all bots." : "Todoist access turned off.";
  } catch (error) {
    const message = `Could not update Todoist: ${error.message}`;
    pluginsBusy = false;
    await loadPlugins();
    $("#plugin-status").textContent = todoistPlugin ? message : `${message} Refresh to check the current connection state.`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

$("#todoist-connect").addEventListener("click", () => changeTodoist("connect"));
$("#todoist-disconnect").addEventListener("click", () => changeTodoist("disconnect"));
$("#todoist-enabled").addEventListener("change", () => changeTodoist("permission"));

function renderApiKeyPlugin(id) {
  const plugin = apiKeyStatus[id];
  const { name, key } = apiKeyPlugins[id];
  const connected = Boolean(plugin?.connected);
  const configured = Boolean(plugin?.configured);
  $(`#${id}-card`).setAttribute("aria-busy", String(pluginsBusy));
  $(`#${id}-state`).textContent = !plugin ? (pluginsBusy ? "Loading…" : "Unavailable") : connected ? (plugin.enabled ? "Access enabled" : "Access off") : configured ? "Not connected" : "Setup required";
  $(`#${id}-state`).classList.toggle("enabled", connected && plugin.enabled);
  $(`#${id}-setup`).hidden = !plugin || configured;
  $(`#${id}-account`).hidden = !connected;
  $(`#${id}-account`).textContent = connected ? `Connected to ${plugin.workspaceName || `your ${name} account`}` : "";
  $(`#${id}-key-form`).hidden = !configured;
  $(`#${id}-key-form input`).placeholder = connected ? `Paste a new ${key} to replace the saved one` : "";
  $(`#${id}-permission`).hidden = !connected;
  if (!pluginsBusy) $(`#${id}-enabled`).checked = connected && plugin.enabled;
  $(`#${id}-enabled`).disabled = pluginsBusy || !connected;
  $(`#${id}-connect`).textContent = connected ? `Replace ${key}` : `Save ${key}`;
  $(`#${id}-connect`).disabled = pluginsBusy || !configured;
  $(`#${id}-disconnect`).hidden = !connected;
  $(`#${id}-disconnect`).disabled = pluginsBusy;
  $(`#${id}-use`).hidden = !connected;
}

async function changeApiKeyPlugin(id, action) {
  if (pluginsBusy) return;
  const { name, key } = apiKeyPlugins[id];
  const input = $(`#${id}-key-form input`);
  const apiKey = input.value.trim();
  if (action === "connect" && !apiKey) {
    $("#plugin-status").textContent = `Paste your ${name} ${key} first.`;
    input.focus();
    return;
  }
  pluginsBusy = true;
  const enabled = $(`#${id}-enabled`).checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? `Checking your ${name} ${key}…` : "Saving…";
  try {
    const request = { connect: [`/api/plugins/${id}/connect`, { method: "POST", body: JSON.stringify({ apiKey }) }], disconnect: [`/api/plugins/${id}`, { method: "DELETE" }], permission: [`/api/plugins/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) }] }[action];
    apiKeyStatus[id] = await api(...request);
    if (action === "connect") input.value = "";
    $("#plugin-status").textContent = {
      connect: `${name} connected. Bots can now use it.`,
      disconnect: `${name} disconnected. Pekka no longer has your ${key}.`,
      permission: enabled ? `${name} access enabled for all bots.` : `${name} access turned off.`,
    }[action];
  } catch (error) {
    $("#plugin-status").textContent = `Could not update ${name}: ${error.message}`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

for (const id of Object.keys(apiKeyPlugins)) {
  $(`#${id}-key-form`).addEventListener("submit", (event) => { event.preventDefault(); changeApiKeyPlugin(id, "connect"); });
  $(`#${id}-disconnect`).addEventListener("click", () => changeApiKeyPlugin(id, "disconnect"));
  $(`#${id}-enabled`).addEventListener("change", () => changeApiKeyPlugin(id, "permission"));
}

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

async function changeGoogle(id, action) {
  if (pluginsBusy) return;
  pluginsBusy = true;
  const { name } = googlePlugins[id];
  const enabled = $(`#${id}-enabled`).checked;
  renderPlugins();
  $("#plugin-status").textContent = action === "connect" ? "Opening Google…" : "Saving…";
  try {
    if (action === "connect") {
      const result = await api(`/api/plugins/${id}/connect`, { method: "POST", body: "{}" });
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.hostname !== "accounts.google.com") throw new Error("Invalid Google authorization URL.");
      location.assign(target.href);
      return;
    }
    googleStatus[id] = await api(`/api/plugins/${id}`, action === "disconnect" ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ enabled }) });
    $("#plugin-status").textContent = action === "disconnect" ? `${name} disconnected. Pekka no longer has access.` : enabled ? googlePlugins[id].enabled : `${name} access turned off.`;
  } catch (error) {
    const message = `Could not update ${name}: ${error.message}`;
    pluginsBusy = false;
    await loadPlugins();
    $("#plugin-status").textContent = googleStatus[id] ? message : `${message} Refresh to check the current connection state.`;
  } finally {
    pluginsBusy = false;
    renderPlugins();
  }
}

for (const id of Object.keys(googlePlugins)) {
  $(`#${id}-connect`).addEventListener("click", () => changeGoogle(id, "connect"));
  $(`#${id}-disconnect`).addEventListener("click", () => changeGoogle(id, "disconnect"));
  $(`#${id}-enabled`).addEventListener("change", () => changeGoogle(id, "permission"));
}

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
    empty.append(element("h2", "", "No tasks yet"), element("p", "muted", "Tasks you send to a bot are listed here."));
    list.append(empty);
  }
  for (const task of tasks.slice(0, 100)) {
    const bot = bots.find((item) => item.name.toLowerCase() === task.key);
    const row = element(bot ? "a" : "article", "activity-row");
    if (bot) row.href = "#bot/" + encodeURIComponent(bot.name);
    const meta = element("div", "activity-meta");
    meta.append(
      element("strong", "", (bot?.name || task.key) + (task.from ? ` · from ${task.from}` : "")),
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
  for (const [key, text] of Object.entries(profile)) form.elements[key].value = text;
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
// The theme applies as soon as it's picked, so it saves without the preferences form's button.
$("#theme-picker").addEventListener("change", (event) => {
  theme = event.target.value;
  applyTheme();
  try {
    if (theme === "system") localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, theme);
    $("#theme-status").textContent = "";
  } catch {
    $("#theme-status").textContent = "Could not save. Browser storage is unavailable, so the theme resets when you reload.";
  }
});
darkScheme.addEventListener("change", applyTheme);
// Other tabs of this browser follow a theme change.
window.addEventListener("storage", (event) => {
  if (event.key !== themeKey) return;
  theme = savedTheme();
  applyTheme();
});
$("#profile-form").addEventListener("input", (event) => {
  event.currentTarget.querySelector(".form-status").textContent = updateProfileEditor() ? "Unsaved changes" : "";
});
$("#profile-discard").addEventListener("click", () => {
  const form = $("#profile-form");
  for (const [key, value] of Object.entries(profile)) form.elements[key].value = value;
  updateProfileEditor();
  form.querySelector(".form-status").textContent = "Changes discarded.";
});
$("#settings-form").addEventListener("input", (event) => {
  event.currentTarget.querySelector(".form-status").textContent = "Unsaved changes";
});
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

// Settings › Model: the user's own API key for each of OpenRouter, OpenAI and Anthropic, and which one runs use.
const modelProviders = {
  openrouter: { name: "OpenRouter", key: "sk-or-…" },
  openai: { name: "OpenAI", key: "sk-…" },
  anthropic: { name: "Anthropic", key: "sk-ant-…", model: "claude-opus-5-5" },
};
let modelKeys = null;

const defaultModel = (provider) => provider === "openrouter" ? modelKeys?.serverModel || "" : modelProviders[provider].model || "";
const providerForm = (provider) => $(`.model-provider[data-provider="${provider}"] form`);

function renderModelKeys() {
  const { available, active, keys, serverModel, serverKey } = modelKeys;
  const used = active && keys[active];
  $("#model-current").textContent = used
    ? `Your runs use your ${modelProviders[active].name} key ending ${used.hint}, with ${used.model}.`
    : serverKey
      ? `Your runs use Pekka's default model${serverModel ? `, ${serverModel},` : ""} on the server's OpenRouter key. Add your own key to choose the provider and model and pay for usage yourself.`
      : "This Pekka server has no model key of its own. Add your OpenRouter, OpenAI or Anthropic key below to run tasks.";
  $("#model-setup").hidden = available;
  for (const radio of $("#model-use").querySelectorAll("input")) {
    radio.checked = radio.value === (active || "");
    // Pekka's own model needs the server's key.
    radio.disabled = !available || (radio.value === "" ? !serverKey : !keys[radio.value]);
  }
  for (const [provider, { name, key }] of Object.entries(modelProviders)) {
    const saved = keys[provider];
    const form = providerForm(provider);
    form.closest("details").querySelector(".model-provider-state").textContent =
      saved ? `${provider === active ? "In use · " : ""}key ending ${saved.hint}` : "No key saved";
    form.elements.model.value = saved?.model || defaultModel(provider);
    form.elements.model.placeholder = defaultModel(provider) || "Model ID";
    form.elements.apiKey.value = "";
    form.elements.apiKey.placeholder = saved ? `Saved key ending ${saved.hint}. Leave blank to keep it.` : `Your ${name} key, ${key}`;
    for (const field of form.querySelectorAll("input, button.primary")) field.disabled = !available;
    form.querySelector("[data-remove]").hidden = !saved;
  }
}

async function loadModelKey() {
  const section = $("#model-keys");
  section.setAttribute("aria-busy", "true");
  try {
    modelKeys = await api("/api/model-keys");
    renderModelKeys();
  } catch (error) {
    $("#model-current").textContent = error.message;
  } finally {
    section.setAttribute("aria-busy", "false");
  }
}

$("#model-use").addEventListener("change", async (event) => {
  const provider = event.target.value || null;
  const status = $("#model-use-status");
  try {
    modelKeys = await api("/api/model-keys/active", { method: "PUT", body: JSON.stringify({ provider }) });
    status.textContent = provider ? `Your runs now use ${modelProviders[provider].name}.` : "Your runs now use Pekka's default model.";
  } catch (error) {
    status.textContent = error.message;
  }
  renderModelKeys();
});

for (const provider of Object.keys(modelProviders)) {
  const form = providerForm(provider);
  const { name } = modelProviders[provider];
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector(".form-status");
    const button = form.querySelector("button.primary");
    const model = form.elements.model.value.trim();
    const apiKey = form.elements.apiKey.value.trim();
    if (!model) {
      status.textContent = "Enter a model ID.";
      form.elements.model.focus();
      return;
    }
    if (!apiKey && !modelKeys?.keys[provider]) {
      status.textContent = `Enter your ${name} API key.`;
      form.elements.apiKey.focus();
      return;
    }
    status.textContent = `Checking with ${name}…`;
    button.disabled = true;
    form.setAttribute("aria-busy", "true");
    try {
      modelKeys = await api(`/api/model-keys/${provider}`, { method: "PUT", body: JSON.stringify({ model, ...(apiKey ? { apiKey } : {}) }) });
      renderModelKeys();
      status.textContent = `Saved. Your runs now use ${name}.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = !modelKeys?.available;
      form.setAttribute("aria-busy", "false");
    }
  });
  form.querySelector("[data-remove]").addEventListener("click", async () => {
    const status = form.querySelector(".form-status");
    const wasActive = modelKeys?.active === provider;
    try {
      modelKeys = await api(`/api/model-keys/${provider}`, { method: "DELETE" });
      renderModelKeys();
      status.textContent = wasActive ? "Key removed. Your runs use Pekka's default model." : "Key removed.";
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

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
    name: "Today's agenda",
    summary: "Your meetings and reminders for the day, first thing.",
    task: "Check my Google Calendar for today and my Google Tasks that are due today or overdue. Write a short agenda: each meeting with its time and who it's with, then the tasks. Flag overlapping meetings and invitations I haven't answered. Do not change any events or tasks.",
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
      renderContext();
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
  $("#panel-toggles").hidden = true;
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
  if (session.shared) $("#profile-workspace").textContent = "Public shared workspace";
  $("#app").hidden = false;
  loadBrowserState();
  renderAccount();
  applyPreferences();
  renderProfile();
  route();
  initialize();
  loadJobs();
}

theme = savedTheme();
applyTheme();
start();
