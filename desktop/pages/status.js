const desktop = window.pekkaDesktop;
const $ = (selector) => document.querySelector(selector);

const { status, logo } = await desktop.state();
$("#logo").src = logo;
const failed = status.phase === "failed";
$("#starting").hidden = failed;
$("#failed").hidden = !failed;
$("#starting-message").textContent = status.message;
$("#failed-message").textContent = status.message;
$("#retry").addEventListener("click", () => desktop.retry());
