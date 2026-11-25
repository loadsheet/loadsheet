// A stand-in for the web UI's bundle: it reads the Report as the real app does.
const el = document.getElementById("report");
document.getElementById("app").textContent = el ? JSON.parse(el.textContent).mode : "no report";
