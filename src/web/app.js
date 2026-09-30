import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/dompurify.js";

const $ = (selector) => document.querySelector(selector);
const storageKey = "pekka.task-history.v1";
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
    `bot-row${selected === bot ? " active" : ""}`,
  );
  button.setAttribute("aria-current", selected === bot ? "true" : "false");
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
  document.title = `${bot.name} — Pekka`;
  if (selected) drafts.set(selected.name, $("#task").value);
  selected = bot;
  unread.delete(bot.name);
  closeDrawer();
  $("#welcome").hidden = true;
  $("#conversation").hidden = false;
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
        message.role === "user" ? "You" : selected.name,
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
    if (selected !== bot) unread.add(bot.name);
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
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendTask($("#task").value);
  }
});
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
route();
initialize();

function route() {
  const page = location.hash.slice(1);
  let botName = "";
  try { botName = decodeURIComponent(page.replace(/^bot\//, "")); } catch {}
  const bot = bots.find((item) => item.name === botName) || selected || bots[0];
  if (bot) {
    window.history.replaceState(null, "", "#bot/" + encodeURIComponent(bot.name));
    selectBot(bot);
    return;
  }
  $("#welcome").hidden = !loaded;
  $("#conversation").hidden = true;
  $("#heading").textContent = loaded ? "Bots" : "";
  closeDrawer();
}
window.addEventListener("hashchange", route);
