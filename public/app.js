// Snip dashboard (vanilla JS). User text is always inserted with textContent.
const $ = (id) => document.getElementById(id);
const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"];

// Anonymous owner key: links belong to this browser, no account needed
const OWNER_KEY = (() => {
  try {
    let key = localStorage.getItem("snip:owner");
    if (!key) {
      key = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}-key`).replace(/[^A-Za-z0-9-]/g, "");
      localStorage.setItem("snip:owner", key);
    }
    return key;
  } catch {
    return `session-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  }
})();

const state = { links: [], filter: "", current: null, days: 30, charts: {} };

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "X-Owner-Key": OWNER_KEY, ...(body && { "Content-Type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? "Request failed");
  return data;
}

// ---------- helpers ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard ✓");
  } catch {
    toast("Press Ctrl+C to copy");
  }
}

const ago = (iso) => {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const shortText = (url) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const qrUrl = (code) => `/api/links/${encodeURIComponent(code)}/qr.svg`;

// ---------- create ----------
$("prefix").textContent = `${location.host}/`;

$("createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("createBtn");
  const err = $("createError");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Shortening…";
  try {
    const { link } = await api("/links", { method: "POST", body: { url: $("urlInput").value, alias: $("aliasInput").value } });
    $("createForm").reset();
    showCreated(link);
    await loadLinks();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Shorten";
  }
});

function showCreated(link) {
  $("created").hidden = false;
  $("createdLink").textContent = shortText(link.shortUrl);
  $("createdLink").href = link.shortUrl;
  $("createdTarget").textContent = `→ ${link.url}`;
  $("createdQr").src = qrUrl(link.code);
  $("copyCreated").onclick = () => copy(link.shortUrl);
}

// ---------- list ----------
async function loadLinks() {
  try {
    const { links } = await api("/links");
    state.links = links;
    renderLinks();
  } catch (ex) {
    toast(ex.message);
  }
}

function renderLinks() {
  const q = state.filter.toLowerCase();
  const links = state.links.filter((l) => !q || l.code.toLowerCase().includes(q) || l.url.toLowerCase().includes(q));
  $("linkCount").textContent = state.links.length ? `· ${state.links.length}` : "";
  $("empty").hidden = state.links.length > 0;

  const totalClicks = state.links.reduce((s, l) => s + l.clicks, 0);
  const top = [...state.links].sort((a, b) => b.clicks - a.clicks)[0];
  const cards = state.links.length
    ? [["Links", state.links.length], ["Total clicks", totalClicks], ["Top link", top && top.clicks ? `/${top.code}` : "—"]]
    : [];
  $("summary").replaceChildren(
    ...cards.map(([label, value]) => {
      const c = el("div", "summary-card");
      c.append(el("span", "muted small", label), el("strong", "", String(value)));
      return c;
    })
  );

  $("linkList").replaceChildren(
    ...links.map((link) => {
      const row = el("article", "link-row");
      const qr = el("img", "row-qr");
      qr.src = qrUrl(link.code);
      qr.alt = "";
      qr.loading = "lazy";

      const main = el("div", "link-main");
      const a = el("a", "short", shortText(link.shortUrl));
      a.href = link.shortUrl;
      a.target = "_blank";
      a.rel = "noopener";
      const target = el("span", "target ellipsis", link.url);
      target.title = link.url;
      main.append(a, target, el("span", "muted small", `Created ${ago(link.createdAt)} · last click ${ago(link.lastClick)}`));

      const clicks = el("div", "clicks");
      clicks.append(el("strong", "", String(link.clicks)), el("span", "muted small", link.clicks === 1 ? "click" : "clicks"));

      const actions = el("div", "row-actions");
      const copyBtn = el("button", "btn ghost sm", "Copy");
      copyBtn.addEventListener("click", () => copy(link.shortUrl));
      const statsBtn = el("button", "btn primary sm", "📊 Stats");
      statsBtn.addEventListener("click", () => openStats(link.code));
      const delBtn = el("button", "icon-btn danger", "🗑️");
      delBtn.setAttribute("aria-label", `Delete /${link.code}`);
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete /${link.code}? Its click history will be deleted too.`)) return;
        await api(`/links/${encodeURIComponent(link.code)}`, { method: "DELETE" });
        toast("Link deleted");
        loadLinks();
      });
      actions.append(copyBtn, statsBtn, delBtn);

      row.append(qr, main, clicks, actions);
      return row;
    })
  );
}

$("filterInput").addEventListener("input", (e) => {
  state.filter = e.target.value.trim();
  renderLinks();
});

// ---------- stats panel ----------
const chartDefaults = () => {
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.defaults.color = "#6b7280";
};

function drawChart(key, canvasId, config) {
  state.charts[key]?.destroy();
  state.charts[key] = new Chart($(canvasId), config);
}

function donut(key, canvasId, rows) {
  const empty = rows.length === 0;
  drawChart(key, canvasId, {
    type: "doughnut",
    data: {
      labels: empty ? ["No data yet"] : rows.map((r) => r.name),
      datasets: [{ data: empty ? [1] : rows.map((r) => r.clicks), backgroundColor: empty ? ["#e5e7eb"] : COLORS, borderWidth: 2, borderColor: "#fff" }],
    },
    options: {
      maintainAspectRatio: false,
      cutout: "64%",
      plugins: { legend: { position: "right", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } }, tooltip: { enabled: !empty } },
    },
  });
}

function rankList(id, rows) {
  const total = rows.reduce((s, r) => s + r.clicks, 0);
  const list = $(id);
  if (!rows.length) return list.replaceChildren(el("li", "muted small", "No clicks yet"));
  list.replaceChildren(
    ...rows.map((r) => {
      const li = el("li");
      const top = el("div", "rank-top");
      top.append(el("span", "", r.name), el("strong", "", `${r.clicks} · ${Math.round((r.clicks / total) * 100)}%`));
      const bar = el("div", "rank-bar");
      const fill = el("span");
      fill.style.width = `${(r.clicks / rows[0].clicks) * 100}%`;
      bar.append(fill);
      li.append(top, bar);
      return li;
    })
  );
}

async function openStats(code) {
  state.current = code;
  $("stats").hidden = false;
  $("statsScrim").hidden = false;
  document.body.classList.add("no-scroll");
  await loadStats();
}

async function loadStats() {
  const s = await api(`/links/${encodeURIComponent(state.current)}/stats?days=${state.days}`);
  $("statsTitle").textContent = `/${s.link.code}`;
  $("statsTarget").textContent = s.link.url;
  $("statsTarget").href = s.link.url;
  $("statsQr").src = qrUrl(s.link.code);
  $("qrDownload").href = qrUrl(s.link.code);
  $("qrDownload").setAttribute("download", `snip-${s.link.code}.svg`);

  const inRange = s.timeline.reduce((sum, d) => sum + d.clicks, 0);
  const kpis = [
    ["Total clicks", s.totals.clicks],
    ["Unique visitors", s.totals.visitors],
    [`Last ${state.days} days`, inRange],
    ["Top source", s.referrers[0]?.name ?? "—"],
  ];
  $("kpis").replaceChildren(
    ...kpis.map(([label, value]) => {
      const k = el("div", "kpi");
      k.append(el("span", "muted small", label), el("strong", "", String(value)));
      return k;
    })
  );

  chartDefaults();
  drawChart("line", "lineChart", {
    type: "line",
    data: {
      labels: s.timeline.map((d) => new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })),
      datasets: [{
        label: "Clicks",
        data: s.timeline.map((d) => d.clicks),
        borderColor: "#6366f1",
        backgroundColor: "rgba(99, 102, 241, 0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        borderWidth: 2.5,
      }],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#f1f2f6" }, border: { display: false } },
      },
    },
  });
  donut("device", "deviceChart", s.devices);
  donut("browser", "browserChart", s.browsers);
  rankList("referrers", s.referrers);
  rankList("osList", s.os);

  const rows = s.recent.map((c) => {
    const tr = el("tr");
    [ago(c.clicked_at), c.referrer, `${c.browser} · ${c.os}`, c.device].forEach((v) => tr.append(el("td", "", v)));
    return tr;
  });
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "muted", "No clicks yet. Open your short link to test it!");
    td.colSpan = 4;
    tr.append(td);
    rows.push(tr);
  }
  $("recent").replaceChildren(...rows);
}

function closeStats() {
  $("stats").hidden = true;
  $("statsScrim").hidden = true;
  document.body.classList.remove("no-scroll");
  state.current = null;
  loadLinks();
}
$("closeStats").addEventListener("click", closeStats);
$("statsScrim").addEventListener("click", closeStats);
document.addEventListener("keydown", (e) => e.key === "Escape" && state.current && closeStats());

document.querySelectorAll(".range button").forEach((b) =>
  b.addEventListener("click", () => {
    state.days = Number(b.dataset.days);
    document.querySelectorAll(".range button").forEach((x) => x.classList.toggle("active", x === b));
    loadStats();
  })
);

// Refresh counts when coming back to the tab (e.g. after testing a link)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") (state.current ? loadStats() : loadLinks());
});

loadLinks();
