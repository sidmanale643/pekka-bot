// Lets the app's own status page (pages/status.html) talk to the app.
// Pekka's web app, and any other site the window visits, don't get it, and the
// main process checks every call's sender as well.
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
  contextBridge.exposeInMainWorld("pekkaDesktop", {
    state: call("desktop:state"),
    retry: call("desktop:retry"),
  });
}
