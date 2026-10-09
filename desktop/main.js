import { app, BrowserWindow, Menu, clipboard, ipcMain, nativeTheme, screen, session, shell } from "electron";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv, promisify } from "node:util";
import { localServer, setEnvValues } from "./env-file.js";
import { PekkaProcesses } from "./processes.js";

// Pekka for macOS. The window shows Pekka's own web app, served by a Pekka server that
// the app runs and restarts on this Mac by itself. Keys are added in the web app's
// Settings, so opening the app goes straight to Pekka.

// PEKKA_DESKTOP_DATA points the app at another data folder, to try a setup without touching your own.
if (process.env.PEKKA_DESKTOP_DATA) {
  app.setPath("userData", process.env.PEKKA_DESKTOP_DATA);
  app.setAppLogsPath(join(process.env.PEKKA_DESKTOP_DATA, "logs"));
}
const dataDir = app.getPath("userData");
const envFile = join(dataDir, ".env");
const settingsFile = join(dataDir, "desktop.json");
const logFile = join(app.getPath("logs"), "server.log");
const serverDir = app.isPackaged ? join(process.resourcesPath, "server") : join(import.meta.dirname, "server");
const pagesDir = join(import.meta.dirname, "pages");
const pagesUrl = pathToFileURL(pagesDir).href;

// Google won't sign in inside a browser whose user agent names Electron. That would break
// connecting Gmail, Calendar and Drive, and signing in to a hosted Pekka with Google.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|Pekka|pekka-desktop)\/\S+/g, "");

/** { bounds }, kept in desktop.json. */
let settings = readSettings();
let window;
let processes;
/** The origin of the Pekka the window shows, once it answers. */
let origin;
/** What the status page shows while Pekka isn't up: { phase: "starting" | "failed", message }. */
let status = { phase: "starting", message: "Starting Pekka…" };
/** When the server stopped on its own lately. A few stops in a row mean restarting won't help. */
let recentExits = [];
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", stopBeforeQuit);
  app.on("web-contents-created", (_event, contents) => guard(contents));
  app.whenReady().then(start);
}

async function start() {
  if (!app.isPackaged) app.dock?.setIcon(join(import.meta.dirname, "build/icon.png"));
  app.setAboutPanelOptions({ applicationName: "Pekka", applicationVersion: app.getVersion(), version: "", website: "https://pekkabot.xyz" });
  configureSession();
  registerIpc();
  createWindow();
  buildMenu();
  await connect();
}

/** Starts Pekka's server on this Mac and opens Pekka in the window. */
async function connect() {
  const previous = processes;
  processes = undefined;
  origin = undefined;
  buildMenu();
  await previous?.stop();
  showStatus({ phase: "starting", message: "Starting Pekka…" });
  try {
    const target = await startLocal();
    origin = new URL(target).origin;
    buildMenu();
    await window.loadURL(target).catch((error) => {
      // ERR_ABORTED (-3) only means a page moved on to another URL before it finished loading. On a first
      // launch it's the status page, still loading when Pekka answers, and it comes without a description.
      if (error.code !== "ERR_ABORTED" && error.errno !== -3) throw error;
    });
  } catch (error) {
    showStatus({ phase: "failed", message: error.message });
  }
}

async function startLocal() {
  const text = localEnvText();
  const { origin: target, port } = localServer(text);
  const started = new PekkaProcesses({
    serverDir,
    dataDir,
    logFile,
    // The app's .env wins over variables the app inherited, unlike a plain `pnpm api`.
    env: { ...process.env, ...parseEnv(text), PATH: await loginPath(), PEKKA_API_PORT: String(port) },
    onServerExit: (message) => {
      if (processes !== started) return;
      origin = undefined;
      buildMenu();
      // Restart it without asking, unless it keeps stopping.
      const now = Date.now();
      recentExits = [...recentExits.filter((at) => now - at < 60_000), now];
      if (recentExits.length < 3) void connect();
      else showStatus({ phase: "failed", message });
    },
  });
  processes = started;
  await started.startServer(target);
  started.startScheduler();
  return target;
}

/** The PATH of the user's login shell. Apps opened from Finder get a minimal PATH without Homebrew, where the GitHub plugin's `gh` usually is. */
async function loginPath() {
  const fallback = [...new Set([...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"])].filter(Boolean).join(":");
  try {
    const { stdout } = await promisify(execFile)(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "\n__PATH__%s" "$PATH"'], { timeout: 3000 });
    return stdout.split("__PATH__").pop().trim() || fallback;
  } catch {
    return fallback;
  }
}

function createWindow() {
  window = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 720,
    minHeight: 520,
    title: "Pekka",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191918" : "#efeee9",
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  window.once("ready-to-show", () => {
    window.show();
    // Bringing Pekka forward, such as by clicking one of its notifications, brings back a window you closed.
    // A notification's click reaches only the web page, which can't show a hidden window itself.
    app.on("did-become-active", showWindow);
  });
  // The web app starts its title with how many bots have something new for you, like "(2) Chief of Staff — Pekka".
  window.on("page-title-updated", (_event, title) => app.dock?.setBadge(/^\((\d+)\) /.exec(title)?.[1] ?? ""));
  window.on("close", (event) => {
    saveSettings({ bounds: window.getNormalBounds() });
    if (quitting) return;
    // Closing the window leaves Pekka running, so tasks and schedules carry on. The dock icon brings it back.
    event.preventDefault();
    if (!window.isFullScreen()) return window.hide();
    window.once("leave-full-screen", () => window.hide());
    window.setFullScreen(false);
  });
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
}

function showStatus(next) {
  status = next;
  void window.loadFile(join(pagesDir, "status.html"));
  showWindow();
}

/** Opens one of the web app's pages, such as #settings. */
function openRoute(hash) {
  if (!origin) return;
  showWindow();
  const current = window.webContents.getURL();
  if (current.startsWith(`${origin}/`)) void window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
  else void window.loadURL(`${origin}/${hash}`);
}

/** Keeps the window on Pekka: links to other sites open in the browser, and pages get only the permissions the web app uses. */
function guard(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (origin && sameOrigin(url, origin)) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true } } };
    }
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    // Plugin sign-in (Google, GitHub, Notion…) leaves Pekka and returns to it in this window,
    // because its state cookie has to make the round trip. Anything other than a web page opens outside.
    if (/^https?:$/.test(new URL(url).protocol) || url.startsWith(pagesUrl)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.on("context-menu", (_event, params) => showContextMenu(contents, params));
}

function sameOrigin(url, expected) {
  try {
    return new URL(url).origin === expected;
  } catch {
    return false;
  }
}

function openOutside(url) {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function configureSession() {
  const allowed = new Set(["clipboard-sanitized-write", "fullscreen", "notifications"]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: join(app.getPath("downloads"), item.getFilename()) });
  });
}

function showContextMenu(contents, params) {
  const { editFlags } = params;
  const groups = [
    params.dictionarySuggestions.slice(0, 4).map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) })),
    params.linkURL && /^https?:/.test(params.linkURL)
      ? [{ label: "Open Link in Browser", click: () => openOutside(params.linkURL) }, { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) }]
      : [],
    params.isEditable
      ? [
          { role: "cut", enabled: editFlags.canCut },
          { role: "copy", enabled: editFlags.canCopy },
          { role: "paste", enabled: editFlags.canPaste },
          { role: "selectAll", enabled: editFlags.canSelectAll },
        ]
      : params.selectionText.trim() ? [{ role: "copy" }] : [],
    app.isPackaged ? [] : [{ label: "Inspect Element", click: () => contents.inspectElement(params.x, params.y) }],
  ].filter((group) => group.length);
  if (!groups.length) return;
  Menu.buildFromTemplate(groups.flatMap((group, index) => (index ? [{ type: "separator" }, ...group] : group))).popup();
}

function buildMenu() {
  const history = () => window.webContents.navigationHistory;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Pekka",
      submenu: [
        { role: "about", label: "About Pekka" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CommandOrControl+,", enabled: Boolean(origin), click: () => openRoute("#settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: "Hide Pekka" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: "Quit Pekka" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open in Browser", accelerator: "CommandOrControl+Shift+O", enabled: Boolean(origin), click: () => openOutside(window.webContents.getURL().startsWith(`${origin}/`) ? window.webContents.getURL() : origin) },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: "CommandOrControl+[", click: () => history().canGoBack() && history().goBack() },
        { label: "Forward", accelerator: "CommandOrControl+]", click: () => history().canGoForward() && history().goForward() },
        { label: "Home", accelerator: "CommandOrControl+Shift+H", enabled: Boolean(origin), click: () => window.loadURL(origin) },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Pekka Help", enabled: Boolean(origin), click: () => openRoute("#help") },
        { label: "Pekka on GitHub", click: () => shell.openExternal("https://github.com/sidmanale643/pekka-bot") },
        { label: "pekkabot.xyz", click: () => shell.openExternal("https://pekkabot.xyz") },
      ],
    },
  ]));
}

/** Only the app's own status page may call it; Pekka's web app and other sites can't. */
function registerIpc() {
  const handle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame?.url.startsWith(pagesUrl)) throw new Error("Not allowed.");
    return handler(...args);
  });
  handle("desktop:state", () => ({ status, logo: pathToFileURL(join(serverDir, "src/web/head.svg")).href }));
  handle("desktop:retry", () => {
    recentExits = [];
    void connect();
  });
}

function stopBeforeQuit(event) {
  quitting = true;
  if (!processes) return;
  event.preventDefault();
  const stopping = processes;
  processes = undefined;
  // Close the window first: its open requests and event streams would hold up the server's shutdown.
  if (window && !window.isDestroyed()) {
    saveSettings({ bounds: window.getNormalBounds() });
    window.destroy();
  }
  void stopping.stop().finally(() => app.quit());
}

function restoredBounds() {
  const bounds = settings.bounds;
  const onScreen = bounds && screen.getAllDisplays().some(({ workArea: area }) =>
    bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y);
  return onScreen ? bounds : { width: 1280, height: 840 };
}

/** The local server's .env, first given the key that encrypts plugin tokens and model keys. It's generated once, then must stay the same. */
function localEnvText() {
  const text = readEnvText();
  if (parseEnv(text).PEKKA_PLUGIN_KEY?.trim()) return text;
  const keyed = setEnvValues(text, { PEKKA_PLUGIN_KEY: randomBytes(32).toString("hex") });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(envFile, keyed);
  chmodSync(envFile, 0o600);
  return keyed;
}

function readEnvText() {
  try {
    return readFileSync(envFile, "utf8");
  } catch {
    return "";
  }
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(change) {
  settings = { ...settings, ...change };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}
