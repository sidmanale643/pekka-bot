import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/dompurify.js";

const $ = (selector) => document.querySelector(selector);
const storageKey = "pekka.task-history.v1";
const profileKey = "pekka.profile.v1";
const preferencesKey = "pekka.preferences.v1";
let profile = loadLocal(profileKey, { displayName: "", occupation: "", bio: "" });
let preferences = loadLocal(preferencesKey, { enterToSend: true, compact: false, reduceMotion: false });
let currentPage = "workspace";
let bots = [];
let selected;
let history = loadHistory();
const running = new Set();
const drafts = new Map();
const unread = new Set();
let loaded = false;

function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
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
                  : "",
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
    localStorage.setItem(storageKey, JSON.stringify(history));
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
  button.append(copy);
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
  return button;
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
  updateNavigation();
  if (selected) drafts.set(selected.name, $("#task").value);
  selected = bot;
  unread.delete(bot.name);
  closeDrawer();
  $("#welcome").hidden = true;
  $("#conversation").hidden = false;
  $("#details").hidden = false;
  $("#heading").replaceChildren(
    element("strong", "", bot.name),
    element("span", "", bot.role),
  );
  $("#task").value = drafts.get(bot.name) || "";
  $("#task").placeholder = `Describe a task for ${bot.name}`;
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

function renderTranscript(forceScroll = false) {
  const transcript = $("#transcript");
  const nearBottom =
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
    100;
  const messages = entries(selected);
  transcript.replaceChildren();
  if (!messages.length) {
    const intro = element("div", "chat-intro");
    const task = element("div", "default-task");
    task.append(
      element("div", "field-label", "Default task"),
      element("p", "", selected.job),
    );
    const start = element("button", "button primary", "Run default task");
    start.addEventListener("click", () => sendTask(selected.job));
    intro.append(
      element("h2", "", selected.name),
      element("p", "role", selected.role),
      task,
      start,
    );
    transcript.append(intro);
  }
  for (const message of messages) {
    const row = element("article", `message ${message.role}`);
    const time = new Date(message.time).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const meta = element("div", "message-meta");
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
    message_delta: () => {
      message.text += data.text;
    },
    message: () => {
      message.text = data.text;
    },
    step: () => {
      message.status = `Working · Step ${data.step}`;
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
    },
    error: () => {
      throw new Error(data.error || "Task execution failed.");
    },
  };
  handlers[event]?.();
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
      body: JSON.stringify({ botName: bot.name, task: task.trim() }),
    });
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
    running.delete(bot.name);
    if (selected !== bot || currentPage !== "workspace") unread.add(bot.name);
    if (currentPage === "activity") renderActivity();
    persist();
    renderBots();
    if (selected === bot) {
      renderTranscript();
      updateComposer();
    }
  }
}

const templates = {
  research: {
    name: "Research Scout",
    role: "Research assistant",
    job: "Research a topic I provide. Find authoritative sources, compare the evidence, and write a concise summary with links.",
  },
  build: {
    name: "Builder",
    role: "Software engineer",
    job: "Help turn my ideas into working software. Keep the solution simple and verify that it works.",
  },
  review: {
    name: "Fresh Eyes",
    role: "Careful reviewer",
    job: "Review the work I share. Identify concrete problems, explain why they matter, and suggest focused improvements.",
  },
};

for (const [key, template] of Object.entries(templates)) {
  const button = element("button", "");
  button.dataset.template = key;
  button.append(
    element("strong", "", template.name),
    element("span", "", template.role),
    element("small", "", template.job),
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

let detailsVersion = 0;
async function showDetails(tab = "purpose") {
  const bot = selected;
  const version = ++detailsVersion;
  $("#detail-name").textContent = bot.name;
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

const detailViews = {
  purpose: async (panel, bot) => {
    for (const [label, value] of [
      ["Role", bot.role],
      ["Default task", bot.job],
    ]) {
      const field = element("div", "detail-field");
      field.append(element("div", "field-label", label), element("p", "", value));
      panel.append(field);
    }
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
          "No skills installed. Add a skill folder to this bot's skills directory.",
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
    const jobs = data.jobs.filter(
      (job) => job.bot?.name.toLowerCase() === bot.name.toLowerCase(),
    );
    panel.append(
      element(
        "p",
        "detail-note",
        jobs.length
          ? "Scheduled tasks run only while the local scheduler is running."
          : "No scheduled tasks. Ask this bot to schedule one; it runs while the local scheduler is running.",
      ),
    );
    const list = element("div", "detail-list");
    for (const job of jobs) {
      const row = element("div", "detail-row");
      const title = element("h3", "", job.name);
      title.append(element("span", "", job.status));
      row.append(title);
      if (job.nextRunAt)
        row.append(
          element("p", "", `Next run ${new Date(job.nextRunAt).toLocaleString()}`),
        );
      if (job.lastError) row.append(element("p", "error", job.lastError));
      list.append(row);
    }
    if (jobs.length) panel.append(list);
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
    const data = await api("/api/bots");
    bots = data.bots;
    loaded = true;
    renderBots();
    route();
  } catch (error) {
    notify(`Could not load bots: ${error.message} Reload to try again.`);
  }
}
$("#host").textContent = location.host;
applyPreferences();
renderProfile();
route();
initialize();

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
  $("#profile-label").textContent = profile.displayName || "Profile";
  $("#profile-initial").textContent = (profile.displayName || "You").slice(0, 1).toUpperCase();
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
  };
  $("#welcome").hidden = true;
  $("#conversation").hidden = true;
  $("#details").hidden = true;
  $("#pages").hidden = false;
  document.title = `${titles[page][0]} — Pekka`;
  $("#heading").textContent = titles[page][0];
  $("#page-title").textContent = titles[page][0];
  $("#page-description").textContent = titles[page][1];
  for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== page;
  $("#pages").scrollTop = 0;
  $("#page-title").focus({ preventScroll: true });
  updateNavigation();
  renderBots();
  closeDrawer();
  if (page === "activity") renderActivity();
}

function route() {
  const page = location.hash.slice(1);
  if (["profile", "settings", "activity"].includes(page)) {
    openPage(page);
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
  $("#welcome").hidden = !loaded;
  $("#conversation").hidden = true;
  $("#details").hidden = true;
  $("#heading").textContent = loaded ? "Bots" : "";
  updateNavigation();
  closeDrawer();
}

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

for (const [name, value] of Object.entries(profile)) $("#profile-form").elements[name].value = value;
for (const [name, value] of Object.entries(preferences)) $("#settings-form").elements[name].checked = value;

$("#profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const value = Object.fromEntries([...new FormData(form)].map(([key, text]) => [key, text.trim()]));
  if (!value.displayName) {
    form.querySelector(".form-status").textContent = "Please enter your name.";
    return;
  }
  if (!saveLocal(profileKey, value, form)) return;
  profile = value;
  renderProfile();
  if (selected) renderTranscript();
});
$("#settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const value = Object.fromEntries(Object.keys(preferences).map((key) => [key, form.elements[key].checked]));
  if (!saveLocal(preferencesKey, value, form)) return;
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
