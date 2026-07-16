/* ===========================================================================
   Juniper Health — Care Operations Platform
   Vanilla single-page app. All data comes from the /ui-api/* JSON contract.
   No framework, no build step, no external dependencies.
   =========================================================================== */

"use strict";

/* --- Element handles ------------------------------------------------------ */
const app = document.querySelector("#app");
const sidebar = document.querySelector("#sidebar");
const drawer = document.querySelector("#detail-drawer");
const drawerBackdrop = document.querySelector("#drawer-backdrop");
const drawerContent = document.querySelector("#drawer-content");
const modalBackdrop = document.querySelector("#modal-backdrop");
const modalContent = document.querySelector("#modal-content");
const toasts = document.querySelector("#toasts");

const DEFAULT_ORG = "org_northstar";
const DEMO_USER = { org_northstar: "user_admin", org_lakeside: "user_lakeside", org_evergreen: "ev_user_admin" };

const state = {
  organizationId: localStorage.getItem("juniper.org") || DEFAULT_ORG,
  route: "dashboard",
  orgs: [],
  pendingPatientQuery: "",
  cache: {},
};

function actingUser() { return DEMO_USER[state.organizationId] || "user_admin"; }
function currentOrg() { return state.orgs.find((o) => o.id === state.organizationId) || null; }
function orgName() { return currentOrg()?.name || "your organization"; }

/* --- Formatting helpers --------------------------------------------------- */
const _money0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const _money2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const _num = new Intl.NumberFormat("en-US");

function money(value, exact) { const n = Number(value); return isFinite(n) ? (exact ? _money2 : _money0).format(n) : "$0"; }
function num(value) { const n = Number(value); return isFinite(n) ? _num.format(n) : "0"; }
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
function humanize(value) { return String(value == null ? "" : value).replace(/[_-]+/g, " ").trim().toLowerCase(); }
function titleCase(value) { return humanize(value).replace(/\b\w/g, (c) => c.toUpperCase()); }
function initials(name) {
  const parts = String(name || "?").replace(/,/g, " ").trim().split(/\s+/);
  return (((parts[0] || "")[0] || "") + ((parts[1] || "")[0] || "")).toUpperCase() || "?";
}
function fmtDate(value) { if (!value) return "—"; const d = new Date(value); return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function fmtDateTime(value) { if (!value) return "—"; const d = new Date(value); return isNaN(d) ? "—" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function monthLabel(year, month) { const d = new Date(Date.UTC(Number(year), Number(month) - 1, 1)); return isNaN(d) ? "—" : d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }); }
function statusBadge(value, extra) {
  if (value == null || value === "") return `<span class="status neutral ${extra || ""}">—</span>`;
  const cls = String(value).toLowerCase().replace(/[\s_]+/g, "-");
  return `<span class="status ${cls} ${extra || ""}">${esc(humanize(value))}</span>`;
}
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
const TODAY_ISO = isoDate(Date.now());
const NINETY_AGO_ISO = isoDate(Date.now() - 90 * 86400000);

/* --- Networking ----------------------------------------------------------- */
function orgQ(extra) {
  const params = new URLSearchParams({ organizationId: state.organizationId });
  if (extra) for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") params.set(k, v);
  return params.toString();
}
async function api(path, options) {
  const init = options ? { headers: { "content-type": "application/json" }, ...options } : undefined;
  const response = await fetch(path, init);
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch (_) { /* ignore */ }
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/* --- UI primitives -------------------------------------------------------- */
function loadingPage() {
  app.innerHTML = `<div class="loading-page"><div class="loading-line wide"></div><div class="loading-line"></div><div class="loading-grid"><div></div><div></div><div></div><div></div></div></div>`;
}
function panelSpinner(message) { return `<div class="panel-loading"><div class="spinner"></div><span>${esc(message || "Loading…")}</span></div>`; }
function pageError(error) {
  app.innerHTML = `<div class="error-state"><h2>We couldn’t load this workspace</h2><p>${esc(error && error.message ? error.message : "Unexpected error")}</p><button class="secondary-button" onclick="location.reload()">Reload</button></div>`;
}
function emptyState(icon, title, message) {
  return `<div class="empty-state"><div class="empty-icon">${icon || "∅"}</div><h3>${esc(title)}</h3><p>${esc(message || "")}</p></div>`;
}
function toast(message, type) {
  const el = document.createElement("div");
  el.className = `toast ${type || "success"}`;
  el.textContent = message;
  toasts.append(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(6px)"; setTimeout(() => el.remove(), 220); }, 3600);
}
function openDrawer(content) {
  drawerContent.innerHTML = content;
  drawer.classList.add("open");
  drawerBackdrop.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
}
function closeDrawer() { drawer.classList.remove("open"); drawerBackdrop.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); }
function drawerLoading(title) { openDrawer(`<div class="drawer-head"><span class="eyebrow">${esc(title || "Loading")}</span><h2>&nbsp;</h2></div><div class="drawer-body">${panelSpinner("Loading details…")}</div>`); }
function openModal(content) { modalContent.innerHTML = content; modalBackdrop.classList.add("open"); }
function closeModal() { modalBackdrop.classList.remove("open"); modalContent.innerHTML = ""; }

/* --- Layout fragments ----------------------------------------------------- */
function pageHead(eyebrow, title, subtitle, actions) {
  return `<header class="page-head"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1>${subtitle ? `<p class="page-subtitle">${esc(subtitle)}</p>` : ""}</div><div class="head-actions">${actions || ""}</div></header>`;
}
function metricCard(label, value, symbol, foot, trend) {
  return `<article class="metric-card"><div class="metric-top"><span>${esc(label)}</span><span class="metric-symbol">${symbol || ""}</span></div><div class="metric-value">${value}</div><div class="metric-foot ${trend || ""}">${foot || ""}</div></article>`;
}
function tabBar(tabs, active, group) {
  return `<div class="tabs">${tabs.map((t) => `<button class="tab ${t.key === active ? "active" : ""}" data-tab="${t.key}" data-tabgroup="${group}">${esc(t.label)}</button>`).join("")}</div>`;
}
function go(route) { if (location.hash === `#/${route}`) handleRoute(); else location.hash = `#/${route}`; }

/* ===========================================================================
   DASHBOARD
   =========================================================================== */
async function renderDashboard() {
  const [data, exceptions] = await Promise.all([
    api(`/ui-api/dashboard?${orgQ()}`),
    api(`/ui-api/dashboard/exceptions?${orgQ()}`).catch(() => null),
  ]);
  state.cache.dashboard = data;
  const m = data.metrics || {};
  const weekly = Array.isArray(data.weeklyVolume) ? data.weeklyVolume : [];
  const recent = Array.isArray(data.recentVisits) ? data.recentVisits : [];
  const periods = Array.isArray(data.periods) ? data.periods : [];
  const closed = periods.find((p) => p && p.status === "CLOSED");

  const navCount = document.querySelector("#visit-nav-count");
  if (navCount) navCount.textContent = num(m.visits || 0);
  const revDot = document.querySelector("#revenue-nav-dot");
  if (revDot) revDot.style.display = (m.rejectedClaims || 0) > 0 ? "" : "none";

  const backlogDoc = (exceptions && exceptions.documentationPreview) || [];
  const maxVol = Math.max(1, ...weekly.map((w) => Number(w.count) || 0));
  const chart = weekly.map((w) => {
    const c = Number(w.count) || 0;
    const h = Math.max(3, Math.round((c / maxVol) * 100));
    return `<div class="volume-bar" title="${esc(fmtDate(w.weekStart))}: ${c} visits"><span class="bar-num">${c}</span><span class="bar" style="height:${h}%"></span></div>`;
  }).join("");
  const axis = weekly.length ? `<div class="volume-axis"><span>${esc(fmtDate(weekly[0].weekStart))}</span><span>${esc(fmtDate(weekly[weekly.length - 1].weekStart))}</span></div>` : "";

  app.innerHTML = `
    ${pageHead("Operational overview", "Good afternoon, Avery", `Here’s what needs attention across ${orgName()} today.`, `<button class="date-control">Last 30 days&nbsp; ⌄</button><button class="secondary-button" data-nav="reports">Reports</button>`)}
    <section class="metric-grid">
      ${metricCard("Active patients", num(m.activePatients || 0), "P", "Currently in service")}
      ${metricCard("Completed visits", num(m.completed || 0), "V", `${num(m.visits || 0)} scheduled across all branches`)}
      ${metricCard("Expected revenue", money(m.expectedRevenue || 0), "$", `${num(m.claimCount || 0)} claims in the pipeline`)}
      ${metricCard("Outstanding A/R", money(m.outstandingReceivables || 0), "R", `${num(m.rejectedClaims || 0)} rejected claim(s) to review`, (m.rejectedClaims || 0) > 0 ? "trend-warn" : "")}
    </section>
    <section class="content-grid">
      <div>
        <section class="panel">
          <div class="panel-head"><div><h2>Recent care activity</h2><p>Latest visits across all branches</p></div><button class="panel-link" data-nav="visits">View all visits →</button></div>
          ${recent.length ? `<div class="data-table-wrap"><table><thead><tr><th>Patient</th><th>Service</th><th>Branch</th><th>When</th><th>Documentation</th><th>Billing</th></tr></thead><tbody>
            ${recent.map((v) => `<tr class="clickable" data-visit-id="${esc(v.id)}"><td><div class="patient-cell"><span class="patient-initials">${esc(initials(v.patient))}</span><div><div class="cell-title">${esc(v.patient)}</div><div class="cell-sub">${esc(v.id)}</div></div></div></td><td>${esc(titleCase(v.serviceType) || "—")}</td><td>${esc(v.branch || "—")}</td><td>${esc(fmtDateTime(v.scheduledStart))}</td><td>${statusBadge(v.documentationStatus)}</td><td>${v.hasCharge ? statusBadge("READY") : statusBadge("NOT_READY")}</td></tr>`).join("")}
          </tbody></table></div>` : emptyState("◔", "No recent visits", "Visits will appear here as care is delivered.")}
        </section>
        <section class="ai-callout"><small>Juniper AI employee</small><h3>${num(m.documentationBacklog || 0)} visits may be blocked from billing</h3><p>I can review documentation, authorization, and coverage context, then prepare a prioritized follow-up list for your team.</p><button data-nav="ai">Review with the AI employee →</button></section>
      </div>
      <div>
        <section class="panel">
          <div class="panel-head"><div><h2>Needs attention</h2><p>Exception queues across operations</p></div></div>
          <div class="attention-list">
            <button class="attention-item panel-link" data-nav="documentation"><span class="attention-icon red">!</span><span><strong>Unsigned documentation</strong><small>Completed visits waiting on notes</small></span><span class="attention-count">${num(m.documentationBacklog || 0)}</span></button>
            <button class="attention-item panel-link" data-nav="revenue"><span class="attention-icon amber">↗</span><span><strong>Rejected claims</strong><small>Corrections needed before resubmission</small></span><span class="attention-count">${num(m.rejectedClaims || 0)}</span></button>
            <button class="attention-item panel-link" data-nav="accounting"><span class="attention-icon blue">$</span><span><strong>Unapplied cash</strong><small>Payments awaiting application</small></span><span class="attention-count">${money(m.unappliedCash || 0)}</span></button>
            <button class="attention-item panel-link" data-nav="workflows"><span class="attention-icon blue">↯</span><span><strong>Pending events</strong><small>Awaiting workflow processing</small></span><span class="attention-count">${num(m.pendingEvents || 0)}</span></button>
          </div>
        </section>
        <section class="panel mini-chart" style="margin-top:15px">
          <div class="panel-head" style="padding:0 0 4px;border:0;min-height:auto"><div><h2>Visit volume</h2><p>Rolling eight weeks</p></div><span class="pill">${num(m.completed || 0)} completed</span></div>
          <div class="volume-chart">${chart || `<span class="meta-line">No volume data</span>`}</div>
          ${axis}
        </section>
        <section class="panel" style="margin-top:15px">
          <div class="panel-head"><div><h2>Month close</h2><p>${closed ? `${monthLabel(closed.year, closed.month)} closed` : "No period has been closed"}</p></div><button class="panel-link" data-nav="accounting">Open →</button></div>
          <div class="panel-body"><div class="kv-list">
            <div class="kv-row"><span>Open tasks</span><strong>${num(m.openTasks || 0)}</strong></div>
            <div class="kv-row"><span>Documentation backlog</span><strong>${num(backlogDoc.length || m.documentationBacklog || 0)}</strong></div>
            <div class="kv-row"><span>Accounting periods</span><strong>${num(periods.length)}</strong></div>
          </div></div>
        </section>
      </div>
    </section>`;
}

/* ===========================================================================
   PATIENTS
   =========================================================================== */
async function renderPatients() {
  const query = state.pendingPatientQuery || "";
  state.pendingPatientQuery = "";
  const patients = await api(`/ui-api/patients?${orgQ(query ? { q: query } : null)}`);
  state.cache.patients = Array.isArray(patients) ? patients : [];
  app.innerHTML = `
    ${pageHead("Care delivery", "Patients", "Manage patient identity, coverage, intake, and care history.", `<button class="secondary-button">Import</button><button class="primary-action" data-open-intake>+ New patient</button>`)}
    <section class="table-panel">
      <div class="table-tools">
        <input class="table-search" id="patient-search" value="${esc(query)}" placeholder="Search name, MRN, or member ID…" autocomplete="off">
        <button class="ghost-button" id="patient-search-btn">Search</button>
        <span class="meta-line" id="patient-count" style="margin-left:auto">${state.cache.patients.length} patient(s)</span>
      </div>
      <div id="patient-table">${patientTable(state.cache.patients)}</div>
    </section>`;
  const input = document.querySelector("#patient-search");
  const run = () => reloadPatients(input.value.trim());
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  document.querySelector("#patient-search-btn").addEventListener("click", run);
}
function patientTable(patients) {
  if (!patients.length) return emptyState("👤", "No patients found", "Try a different search, or add a new patient with intake.");
  return `<div class="data-table-wrap"><table><thead><tr><th>Patient</th><th>MRN</th><th>Date of birth</th><th>Coverage</th><th>Phone</th><th>Last visit</th><th>Status</th></tr></thead><tbody>
    ${patients.map((p) => `<tr class="clickable" data-patient-id="${esc(p.id)}"><td><div class="patient-cell"><span class="patient-initials">${esc(initials(p.name))}</span><div><div class="cell-title">${esc(p.name)}</div>${p.preferredName ? `<div class="cell-sub">Goes by ${esc(p.preferredName)}</div>` : ""}</div></div></td><td>${esc(p.externalId || "—")}</td><td>${esc(fmtDate(p.dateOfBirth))}</td><td>${esc(p.payer || "—")}</td><td>${esc(p.phone || "—")}</td><td>${p.lastVisit ? esc(fmtDate(p.lastVisit)) : "No visits"}</td><td>${statusBadge(p.active ? "ACTIVE" : "INACTIVE")}</td></tr>`).join("")}
  </tbody></table></div>`;
}
async function reloadPatients(query) {
  const holder = document.querySelector("#patient-table");
  holder.innerHTML = panelSpinner("Searching patients…");
  try {
    const patients = await api(`/ui-api/patients?${orgQ(query ? { q: query } : null)}`);
    state.cache.patients = Array.isArray(patients) ? patients : [];
    holder.innerHTML = patientTable(state.cache.patients);
    document.querySelector("#patient-count").textContent = `${state.cache.patients.length} patient(s)`;
  } catch (error) { holder.innerHTML = emptyState("⚠", "Search failed", error.message); toast(error.message, "error"); }
}

async function showPatientDrawer(patientId) {
  drawerLoading("Patient");
  let detail;
  try { detail = await api(`/ui-api/patients/${encodeURIComponent(patientId)}`); }
  catch (error) { openDrawer(`<div class="drawer-head"><span class="eyebrow">Patient</span><h2>Unavailable</h2></div><div class="drawer-body">${emptyState("⚠", "Could not load patient", error.message)}</div>`); return; }
  const header = detail.header || {};
  const patient = header.patient || {};
  const counts = header.counts || {};
  const coverages = Array.isArray(detail.coverages) ? detail.coverages : [];
  const visitSets = Array.isArray(detail.visitSets) ? detail.visitSets : [];
  const recentVisits = Array.isArray(detail.recentVisits) ? detail.recentVisits : [];
  openDrawer(`
    <div class="drawer-head">
      <span class="patient-initials" style="width:42px;height:42px;font-size:12px">${esc(initials(patient.displayName))}</span>
      <h2>${esc(patient.displayName || "Patient")}</h2>
      <p>MRN ${esc(patient.mrn || "—")} · ${esc(fmtDate(patient.dateOfBirth))}</p>
      ${statusBadge(patient.active ? "ACTIVE" : "INACTIVE", "lg")}
    </div>
    <div class="drawer-body">
      <section class="detail-section"><h3>Care summary</h3>
        <div class="mini-stats">
          <div class="mini-stat"><small>Visits</small><strong>${num(counts.visitCount || 0)}</strong></div>
          <div class="mini-stat"><small>Completed</small><strong>${num(counts.completedCount || 0)}</strong></div>
          <div class="mini-stat"><small>Upcoming</small><strong>${num(counts.upcomingCount || 0)}</strong></div>
          <div class="mini-stat"><small>Open orders</small><strong>${num(counts.openOrderCount || 0)}</strong></div>
          <div class="mini-stat"><small>Unsigned notes</small><strong>${num(counts.unsignedNoteCount || 0)}</strong></div>
          <div class="mini-stat"><small>Open claims</small><strong>${num(counts.openClaimCount || 0)}</strong></div>
        </div>
      </section>
      <section class="detail-section"><h3>Identity &amp; balance</h3>
        <div class="detail-grid">
          <div class="detail-field"><small>Phone</small><strong>${esc(patient.phone || "Not provided")}</strong></div>
          <div class="detail-field"><small>Open balance</small><strong>${money(header.openBalance || 0, true)}</strong></div>
          <div class="detail-field"><small>Legal name</small><strong>${esc(patient.legalName || patient.displayName || "—")}</strong></div>
          <div class="detail-field"><small>Patient ID</small><strong>${esc(patient.id || patientId)}</strong></div>
        </div>
      </section>
      <section class="detail-section"><h3>Coverage (${coverages.length})</h3>
        ${coverages.length ? `<div class="kv-list">${coverages.map((c) => `<div class="kv-row"><span>${esc(c.payer || "Payer")}${c.plan ? ` · ${esc(c.plan)}` : ""}<br><small class="meta-line">Member ${esc(c.memberId || "—")}</small></span>${statusBadge(c.verified ? "VERIFIED" : "PENDING")}</div>`).join("")}</div>` : `<p class="meta-line">No coverage on file.</p>`}
      </section>
      <section class="detail-section"><h3>Visit sets (${visitSets.length})</h3>
        ${visitSets.length ? `<div class="data-table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Billing</th><th class="num">Visits</th></tr></thead><tbody>${visitSets.map((s) => `<tr><td>${esc(titleCase(s.serviceType) || "—")}</td><td>${statusBadge(s.status)}</td><td>${statusBadge(s.billingStatus)}</td><td class="num">${num(s.visitCount || 0)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="meta-line">No visit sets.</p>`}
      </section>
      <section class="detail-section"><h3>Recent visits</h3>
        ${recentVisits.length ? `<div class="timeline">${recentVisits.slice(0, 6).map((v) => `<div class="timeline-item" data-visit-id="${esc(v.id)}" style="cursor:pointer"><strong>${esc(titleCase(v.status))} · ${esc(v.branch || "—")}</strong><small>${esc(fmtDateTime(v.scheduledStart))}${v.signed ? " · note signed" : ""}</small></div>`).join("")}</div>` : `<p class="meta-line">No recent visits.</p>`}
      </section>
    </div>`);
}

function showIntakeModal() {
  openModal(`<h2 id="modal-title">Start a new patient</h2><p>Create a patient record for ${esc(orgName())} and begin coverage verification.</p>
    <form id="intake-form" class="form-grid">
      <div class="form-field"><label>First name</label><input name="firstName" required></div>
      <div class="form-field"><label>Last name</label><input name="lastName" required></div>
      <div class="form-field"><label>Date of birth</label><input name="dateOfBirth" type="date" required></div>
      <div class="form-field"><label>Phone</label><input name="phone" type="tel" placeholder="(555) 555-5555"></div>
      <div class="form-field"><label>Preferred name</label><input name="preferredName"></div>
      <div class="form-field"><label>Email</label><input name="email" type="email"></div>
      <div class="form-field full"><label>Intake note</label><input name="note" placeholder="Referral source, service line…"></div>
      <div class="form-actions"><button type="button" class="secondary-button" id="cancel-intake">Cancel</button><button class="primary-action" type="submit" id="intake-submit">Create patient</button></div>
    </form>`);
  document.querySelector("#cancel-intake").addEventListener("click", closeModal);
  document.querySelector("#intake-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = document.querySelector("#intake-submit");
    const values = Object.fromEntries(new FormData(event.target));
    if (!values.firstName || !values.lastName || !values.dateOfBirth) { toast("First name, last name, and date of birth are required.", "error"); return; }
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      await api("/patients", { method: "POST", body: JSON.stringify({ userId: actingUser(), organizationId: state.organizationId, skipMatching: true, firstName: values.firstName, lastName: values.lastName, dateOfBirth: values.dateOfBirth, phone: values.phone || undefined, preferredName: values.preferredName || undefined, email: values.email || undefined }) });
      closeModal();
      toast(`Patient ${values.firstName} ${values.lastName} created.`);
      if (state.route === "patients") reloadPatients(document.querySelector("#patient-search")?.value.trim() || "");
    } catch (error) {
      btn.disabled = false; btn.textContent = "Create patient";
      toast(error.message || "Could not create patient.", "error");
    }
  });
}

/* ===========================================================================
   VISITS (+ documentation backlog tab)
   =========================================================================== */
async function renderVisits() {
  const visits = await api(`/ui-api/visits?${orgQ()}`);
  state.cache.visits = Array.isArray(visits) ? visits : [];
  app.innerHTML = `
    ${pageHead("Care delivery", "Visits", "Schedule, document, and prepare delivered care for billing.", `<button class="secondary-button">Calendar view</button><button class="primary-action">+ Schedule visit</button>`)}
    ${tabBar([{ key: "activity", label: "Visit activity" }, { key: "documentation", label: "Documentation backlog" }], "activity", "visits")}
    <div id="visits-tabpanel">${visitActivityView()}</div>`;
  bindVisitFilters();
}
function visitActivityView() {
  const visits = state.cache.visits || [];
  const branches = [...new Set(visits.map((v) => v.branch).filter(Boolean))].sort();
  const statuses = [...new Set(visits.map((v) => v.status).filter(Boolean))].sort();
  return `<section class="table-panel">
    <div class="table-tools">
      <input class="table-search" id="visit-search" placeholder="Search patient…" autocomplete="off">
      <select class="filter-select" id="visit-status"><option value="">All statuses</option>${statuses.map((s) => `<option value="${esc(s)}">${esc(titleCase(s))}</option>`).join("")}</select>
      <select class="filter-select" id="visit-branch"><option value="">All branches</option>${branches.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("")}</select>
      <span class="meta-line" id="visit-count" style="margin-left:auto">${visits.length} visit(s)</span>
    </div>
    <div class="data-table-wrap"><table><thead><tr><th>Patient</th><th>Service date</th><th>Service</th><th>Branch</th><th>Visit</th><th>Documentation</th><th>Billing</th></tr></thead><tbody id="visit-tbody">${visitRows(visits)}</tbody></table></div>
  </section>`;
}
function visitRows(visits) {
  if (!visits.length) return `<tr><td colspan="7">${emptyState("◔", "No visits match", "Adjust the filters to see more visits.")}</td></tr>`;
  return visits.map((v) => `<tr class="clickable" data-visit-id="${esc(v.id)}"><td><div class="patient-cell"><span class="patient-initials">${esc(initials(v.patient))}</span><div><div class="cell-title">${esc(v.patient)}</div><div class="cell-sub">${esc(v.id)}</div></div></div></td><td>${esc(fmtDateTime(v.scheduledStart))}</td><td>${esc(titleCase(v.serviceType) || "—")}</td><td>${esc(v.branch || "—")}</td><td>${statusBadge(v.status)}</td><td>${statusBadge(v.documentationStatus)}</td><td>${v.hasCharge ? statusBadge("READY") : statusBadge("NOT_READY")}</td></tr>`).join("");
}
function bindVisitFilters() {
  const search = document.querySelector("#visit-search");
  const status = document.querySelector("#visit-status");
  const branch = document.querySelector("#visit-branch");
  if (!search || !status || !branch) return;
  const apply = () => {
    const term = search.value.trim().toLowerCase();
    const filtered = (state.cache.visits || []).filter((v) =>
      (!status.value || v.status === status.value) &&
      (!branch.value || v.branch === branch.value) &&
      (!term || `${v.patient} ${v.id} ${v.serviceType}`.toLowerCase().includes(term)));
    document.querySelector("#visit-tbody").innerHTML = visitRows(filtered);
    document.querySelector("#visit-count").textContent = `${filtered.length} of ${(state.cache.visits || []).length} visit(s)`;
  };
  search.addEventListener("input", apply);
  status.addEventListener("change", apply);
  branch.addEventListener("change", apply);
}
async function showVisitDrawer(visitId) {
  drawerLoading("Visit record");
  let d;
  try { d = await api(`/ui-api/visits/${encodeURIComponent(visitId)}`); }
  catch (error) { openDrawer(`<div class="drawer-head"><span class="eyebrow">Visit</span><h2>Unavailable</h2></div><div class="drawer-body">${emptyState("⚠", "Could not load visit", error.message)}</div>`); return; }
  const v = d.visit || {};
  const h = d.hierarchy || {};
  const patient = d.patient || {};
  const doc = d.documentation || {};
  const billing = d.billing || {};
  const history = Array.isArray(d.statusHistory) ? d.statusHistory : [];
  const notes = Array.isArray(doc.notes) ? doc.notes : [];
  const claims = Array.isArray(billing.claims) ? billing.claims : [];
  const charges = Array.isArray(billing.charges) ? billing.charges : [];
  const patientName = patient.firstName ? `${patient.firstName} ${patient.lastName || ""}`.trim() : (patient.displayName || "Patient");
  openDrawer(`
    <div class="drawer-head"><span class="eyebrow">Visit record</span><h2>${esc(titleCase(v.serviceType) || "Visit")}</h2><p>${esc(fmtDateTime(v.scheduledStart))} · ${esc(h.branch && h.branch.name ? h.branch.name : "—")}</p>${statusBadge(v.status, "lg")}</div>
    <div class="drawer-body">
      ${h.patientMismatch ? `<div class="inline-note warn"><span>⚠</span><span>Visit patient does not match the visit set patient. Review before billing.</span></div>` : ""}
      <section class="detail-section"><h3>Delivery</h3>
        <div class="detail-grid">
          <div class="detail-field"><small>Patient</small><strong>${esc(patientName)}</strong></div>
          <div class="detail-field"><small>Clinician</small><strong>${esc(v.clinicianId || "Unassigned")}</strong></div>
          <div class="detail-field"><small>Scheduled</small><strong>${esc(fmtDateTime(v.scheduledStart))}</strong></div>
          <div class="detail-field"><small>Completed</small><strong>${esc(fmtDateTime(v.completedAt))}</strong></div>
          <div class="detail-field"><small>Region</small><strong>${esc((h.branch && h.branch.region) || "—")}</strong></div>
          <div class="detail-field"><small>Authorization</small><strong>${esc(authLabel(d.authorization))}</strong></div>
        </div>
      </section>
      <section class="detail-section"><h3>Documentation</h3>
        <div class="kv-list"><div class="kv-row"><span>Group status</span>${statusBadge(doc.groupStatus)}</div>
        ${notes.length ? notes.map((n) => `<div class="kv-row"><span>Note ${esc(n.id ? String(n.id).slice(-6) : "")}</span>${statusBadge(n.status)}</div>`).join("") : `<div class="kv-row"><span>Clinical notes</span><span class="meta-line">None on file</span></div>`}</div>
      </section>
      <section class="detail-section"><h3>Billing readiness</h3>
        <div class="detail-grid">
          <div class="detail-field"><small>Expected price</small><strong>${billing.expectedPrice != null ? money(readNumber(billing.expectedPrice), true) : "—"}</strong></div>
          <div class="detail-field"><small>Charges</small><strong>${num(charges.length)}</strong></div>
          <div class="detail-field"><small>Claims</small><strong>${num(claims.length)}</strong></div>
          <div class="detail-field"><small>Readiness</small><strong>${readinessLabel(billing.readiness)}</strong></div>
        </div>
        ${claims.length ? `<div class="kv-list" style="margin-top:12px">${claims.map((c) => `<div class="kv-row"><span>${esc(c.claimNumber || c.id || "Claim")}</span>${statusBadge(c.status)}</div>`).join("")}</div>` : ""}
      </section>
      <section class="detail-section"><h3>Status history</h3>
        ${history.length ? `<div class="timeline">${history.slice(0, 8).map((s) => `<div class="timeline-item"><strong>${esc(titleCase(s.toStatus || s.status || "Update"))}</strong><small>${esc(fmtDateTime(s.changedAt || s.createdAt))}${s.reason ? ` · ${esc(s.reason)}` : ""}</small></div>`).join("")}</div>` : `<p class="meta-line">No status changes recorded.</p>`}
      </section>
      <section class="detail-section"><h3>Legacy identifiers</h3>
        <div class="detail-grid"><div class="detail-field"><small>Visit set</small><strong>${esc(h.visitSetId || "—")}</strong></div><div class="detail-field"><small>Visit group</small><strong>${esc(h.visitGroupId || "—")}</strong></div></div>
      </section>
    </div>`);
}
function readNumber(value) { if (value == null) return NaN; if (typeof value === "object") return Number(value.amount ?? value.value ?? value.price ?? NaN); return Number(value); }
function authLabel(auth) {
  if (!auth || typeof auth !== "object") return "No authorization";
  const n = auth.authorizationNumber || auth.number || auth.authNumber;
  const max = auth.maxVisits ?? auth.limit;
  if (n) return `${n}${max != null ? ` · ${max} visits` : ""}`;
  if (max != null) return `${max} visits authorized`;
  return "On file";
}
function readinessLabel(readiness) {
  if (readiness == null) return "—";
  if (typeof readiness === "object") {
    if (typeof readiness.ready === "boolean") return statusBadge(readiness.ready ? "READY" : "BLOCKED");
    if (typeof readiness.status === "string") return statusBadge(readiness.status);
    if (Array.isArray(readiness.blockers) || Array.isArray(readiness.reasons)) { const arr = readiness.blockers || readiness.reasons; return arr.length ? statusBadge("BLOCKED") : statusBadge("READY"); }
  }
  return statusBadge(String(readiness));
}

/* ===========================================================================
   DOCUMENTATION BACKLOG (standalone + visits tab)
   =========================================================================== */
async function documentationView() {
  const data = await api(`/ui-api/documentation?${orgQ()}`);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  state.cache.documentation = rows;
  const overdue = rows.filter((r) => Number(r.hoursSinceCompletion) > 24).length;
  const unsigned = rows.filter((r) => r.noteStatus && r.noteStatus !== "SIGNED").length;
  return `
    <section class="metric-grid">
      ${metricCard("Backlog", num(data.total ?? rows.length), "D", "Completed visits needing attention", rows.length ? "trend-warn" : "")}
      ${metricCard("Over 24 hours", num(overdue), "!", "Past escalation threshold", overdue ? "trend-warn" : "")}
      ${metricCard("Unsigned notes", num(unsigned), "✎", "Awaiting clinician signature")}
      ${metricCard("Branches affected", num(new Set(rows.map((r) => r.branchName).filter(Boolean)).size), "◈", "Across the organization")}
    </section>
    <section class="table-panel">
      <div class="table-tools"><input class="table-search" id="doc-search" placeholder="Search patient or clinician…" autocomplete="off"><span class="meta-line" style="margin-left:auto">${rows.length} row(s)</span></div>
      <div class="data-table-wrap"><table><thead><tr><th>Patient / visit</th><th>Clinician</th><th>Branch</th><th>Completed</th><th>Note</th><th>Group</th><th class="num">Age</th></tr></thead><tbody id="doc-tbody">${documentationRows(rows)}</tbody></table></div>
    </section>`;
}
function documentationRows(rows) {
  if (!rows.length) return `<tr><td colspan="7">${emptyState("✓", "Documentation is caught up", "No completed visits are waiting on notes.")}</td></tr>`;
  return rows.map((r) => {
    const hrs = Number(r.hoursSinceCompletion);
    return `<tr class="clickable" data-visit-id="${esc(r.visitId)}"><td><div class="cell-title">${esc(r.patientName || "—")}</div><div class="cell-sub">${esc(r.visitId)}</div></td><td>${esc(r.clinicianId || "—")}</td><td>${esc(r.branchName || "—")}</td><td>${esc(fmtDateTime(r.completedAt))}</td><td>${statusBadge(r.noteStatus)}</td><td>${statusBadge(r.groupCachedStatus)}</td><td class="num">${isFinite(hrs) ? `${Math.round(hrs)}h` : "—"}</td></tr>`;
  }).join("");
}
async function renderDocumentation() {
  app.innerHTML = `${pageHead("Care delivery", "Documentation", "Track clinical notes, signatures, and billing readiness.", `<button class="secondary-button">Send reminders</button>`)}<div id="doc-holder">${panelSpinner("Loading documentation backlog…")}</div>`;
  const holder = document.querySelector("#doc-holder");
  try { holder.innerHTML = await documentationView(); bindDocSearch(); }
  catch (error) { holder.innerHTML = emptyState("⚠", "Could not load documentation", error.message); toast(error.message, "error"); }
}
function bindDocSearch() {
  const input = document.querySelector("#doc-search");
  if (!input) return;
  input.addEventListener("input", () => {
    const term = input.value.trim().toLowerCase();
    const filtered = (state.cache.documentation || []).filter((r) => !term || `${r.patientName} ${r.clinicianId} ${r.branchName}`.toLowerCase().includes(term));
    document.querySelector("#doc-tbody").innerHTML = documentationRows(filtered);
  });
}

/* ===========================================================================
   REVENUE CYCLE (claims + rejections tab)
   =========================================================================== */
async function renderRevenue() {
  const [claims, rejections] = await Promise.all([
    api(`/ui-api/claims?${orgQ()}`),
    api(`/ui-api/rejections?${orgQ()}`).catch(() => []),
  ]);
  state.cache.claims = Array.isArray(claims) ? claims : [];
  state.cache.rejections = Array.isArray(rejections) ? rejections : [];
  const totals = state.cache.claims.reduce((acc, c) => ({ total: acc.total + Number(c.total || 0), balance: acc.balance + Number(c.balance || 0) }), { total: 0, balance: 0 });
  const rejected = state.cache.claims.filter((c) => c.status === "REJECTED").length;
  app.innerHTML = `
    ${pageHead("Financial", "Revenue cycle", "Review charges, submit claims, and resolve payer exceptions.", `<button class="secondary-button">Import responses</button><button class="primary-action">Generate claims</button>`)}
    <section class="metric-grid">
      ${metricCard("Total billed", money(totals.total), "$", `${state.cache.claims.length} claim(s) in queue`)}
      ${metricCard("Outstanding balance", money(totals.balance), "R", "Across open claims")}
      ${metricCard("Rejected", num(rejected), "!", "Require correction", rejected ? "trend-warn" : "")}
      ${metricCard("Open rejections", num(state.cache.rejections.length), "↺", "On the worklist", state.cache.rejections.length ? "trend-warn" : "")}
    </section>
    ${tabBar([{ key: "claims", label: "Claim queue" }, { key: "rejections", label: `Rejections (${state.cache.rejections.length})` }], "claims", "revenue")}
    <div id="revenue-tabpanel">${claimQueueView()}</div>`;
  bindClaimChips();
}
function claimQueueView() {
  const claims = state.cache.claims || [];
  const statuses = [...new Set(claims.map((c) => c.status).filter(Boolean))];
  const chips = [{ key: "", label: "All" }].concat(statuses.map((s) => ({ key: s, label: titleCase(s) })));
  return `
    <div class="filter-chips" id="claim-chips">${chips.map((c) => `<button class="chip ${c.key === "" ? "active" : ""}" data-chip="${esc(c.key)}">${esc(c.label)}<span class="chip-count">${c.key === "" ? claims.length : claims.filter((x) => x.status === c.key).length}</span></button>`).join("")}</div>
    <section class="table-panel"><div class="data-table-wrap"><table><thead><tr><th>Claim</th><th>Patient</th><th>Submitted</th><th>Status</th><th class="num">Billed</th><th class="num">Balance</th><th class="num">Rejections</th></tr></thead><tbody id="claim-tbody">${claimRows(claims)}</tbody></table></div></section>`;
}
function claimRows(claims) {
  if (!claims.length) return `<tr><td colspan="7">${emptyState("$", "No claims", "No claims match this filter.")}</td></tr>`;
  return claims.map((c) => `<tr class="clickable" data-claim-id="${esc(c.id)}"><td><div class="cell-title">${esc(c.claimNumber || c.id)}</div><div class="cell-sub">${esc(c.externalId || "No payer reference")}</div></td><td>${esc(c.patient || c.patientId)}</td><td>${c.submittedAt ? esc(fmtDate(c.submittedAt)) : "Not submitted"}</td><td>${statusBadge(c.status)}</td><td class="num">${money(c.total, true)}</td><td class="num">${money(c.balance, true)}</td><td class="num">${(c.openRejections && c.openRejections.length) ? `<span class="pill financial">${c.openRejections.length}</span>` : "—"}</td></tr>`).join("");
}
function bindClaimChips() {
  const wrap = document.querySelector("#claim-chips");
  if (!wrap) return;
  wrap.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-chip]");
    if (!chip) return;
    wrap.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    const status = chip.dataset.chip;
    const filtered = status ? (state.cache.claims || []).filter((c) => c.status === status) : (state.cache.claims || []);
    document.querySelector("#claim-tbody").innerHTML = claimRows(filtered);
  });
}
function rejectionsView() {
  const rows = state.cache.rejections || [];
  if (!rows.length) return `<section class="table-panel">${emptyState("✓", "No open rejections", "Every claim rejection has been resolved.")}</section>`;
  return `<section class="table-panel"><div class="data-table-wrap"><table><thead><tr><th>Patient</th><th>Code</th><th>Reason</th><th>Category</th><th>Received</th><th class="num">Age</th><th class="num">Claim total</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="clickable" data-claim-id="${esc(r.claimId)}"><td>${esc(r.patientName || "—")}</td><td><span class="pill financial">${esc(r.code || "—")}</span></td><td>${esc(r.message || "—")}</td><td>${esc(titleCase(r.category) || "—")}</td><td>${esc(fmtDate(r.receivedAt))}</td><td class="num">${r.ageDays != null ? `${num(r.ageDays)}d` : "—"}</td><td class="num">${money(r.claimTotal, true)}</td></tr>`).join("")}
  </tbody></table></div></section>`;
}
function showClaimDrawer(claimId) {
  const claim = (state.cache.claims || []).find((c) => c.id === claimId);
  if (!claim) { toast("Claim details are only available from the revenue cycle screen.", "error"); return; }
  const rejections = (state.cache.rejections || []).filter((r) => r.claimId === claimId);
  openDrawer(`
    <div class="drawer-head"><span class="eyebrow">Claim</span><h2>${esc(claim.claimNumber || claim.id)}</h2><p>${esc(claim.patient || claim.patientId)}</p>${statusBadge(claim.status, "lg")}</div>
    <div class="drawer-body">
      <section class="detail-section"><h3>Financial summary</h3>
        <div class="detail-grid">
          <div class="detail-field"><small>Billed</small><strong>${money(claim.total, true)}</strong></div>
          <div class="detail-field"><small>Balance</small><strong>${money(claim.balance, true)}</strong></div>
          <div class="detail-field"><small>External ID</small><strong>${esc(claim.externalId || "Not assigned")}</strong></div>
          <div class="detail-field"><small>Submit attempts</small><strong>${num(claim.attempts || 0)}</strong></div>
          <div class="detail-field"><small>Payment applications</small><strong>${num(claim.applications || 0)}</strong></div>
          <div class="detail-field"><small>Submitted</small><strong>${esc(fmtDate(claim.submittedAt))}</strong></div>
        </div>
      </section>
      <section class="detail-section"><h3>Rejections (${rejections.length || (claim.openRejections || []).length})</h3>
        ${rejections.length ? rejections.map((r) => `<div class="inline-note warn"><span>${esc(r.code || "!")}</span><span><strong>${esc(titleCase(r.category) || "Rejection")}</strong><br>${esc(r.message || "")}<br><small class="meta-line">Received ${esc(fmtDate(r.receivedAt))}${r.ageDays != null ? ` · ${r.ageDays} days old` : ""}</small></span></div>`).join("")
          : (claim.openRejections && claim.openRejections.length ? `<div class="kv-list">${claim.openRejections.map((code) => `<div class="kv-row"><span>Rejection code</span><span class="pill financial">${esc(code)}</span></div>`).join("")}</div>` : `<p class="meta-line">No open rejections on this claim.</p>`)}
      </section>
      ${claim.status === "REJECTED" ? `<button class="primary-action" data-nav="ai" style="width:100%">Review rejection with the AI employee →</button>` : ""}
    </div>`);
}

/* ===========================================================================
   ACCOUNTING (month close + cash activity tabs)
   =========================================================================== */
async function renderAccounting() {
  const data = await api(`/ui-api/accounting?${orgQ()}`);
  state.cache.accounting = data;
  const periods = Array.isArray(data.periods) ? data.periods : [];
  const payments = Array.isArray(data.payments) ? data.payments : [];
  const received = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const unapplied = payments.reduce((s, p) => s + Number(p.unappliedAmount || 0), 0);
  const current = periods[0];
  app.innerHTML = `
    ${pageHead("Financial", "Accounting", "Close periods, apply cash, and reconcile financial activity.", `<button class="secondary-button">Reconciliation</button><button class="primary-action">Import remittance</button>`)}
    <section class="metric-grid">
      ${metricCard("Cash received", money(received), "$", `${payments.length} remittance(s)`)}
      ${metricCard("Applied cash", money(received - unapplied), "✓", "Matched to claims", "trend-up")}
      ${metricCard("Unapplied", money(unapplied), "?", "Requires review", unapplied ? "trend-warn" : "")}
      ${metricCard("Current period", current ? monthLabel(current.year, current.month) : "—", "▣", current ? titleCase(current.status) : "No active period")}
    </section>
    ${tabBar([{ key: "close", label: "Month close" }, { key: "cash", label: "Cash activity" }], "close", "accounting")}
    <div id="accounting-tabpanel">${accountingCloseView()}</div>`;
  loadMonthClose(current ? current.id : null);
}
function accountingCloseView() {
  const periods = (state.cache.accounting && state.cache.accounting.periods) || [];
  return `<div class="split-grid">
    <section class="panel">
      <div class="panel-head"><div><h2>Accounting periods</h2><p>Select a period to view its position</p></div></div>
      <div class="data-table-wrap"><table><thead><tr><th>Period</th><th>Status</th><th>Closed</th></tr></thead><tbody>
        ${periods.length ? periods.map((p) => `<tr class="clickable" data-period-id="${esc(p.id)}"><td class="cell-title">${esc(monthLabel(p.year, p.month))}</td><td>${statusBadge(p.status)}</td><td>${p.closedAt ? esc(fmtDate(p.closedAt)) : "—"}</td></tr>`).join("") : `<tr><td colspan="3">${emptyState("▣", "No periods", "Accounting periods will appear here.")}</td></tr>`}
      </tbody></table></div>
    </section>
    <section class="panel"><div class="panel-head"><div><h2>Financial position</h2><p>Revenue, receivables, and cash for the period</p></div></div><div class="panel-body" id="close-panel">${panelSpinner("Loading…")}</div></section>
  </div>`;
}
async function loadMonthClose(periodId) {
  const holder = document.querySelector("#close-panel");
  if (!holder) return;
  holder.innerHTML = panelSpinner("Loading preview…");
  try {
    const mc = await api(`/ui-api/month-close?${orgQ(periodId ? { periodId } : null)}`);
    holder.innerHTML = monthClosePanel(mc);
  } catch (error) { holder.innerHTML = emptyState("⚠", "Could not load preview", error.message); }
}
function monthClosePanel(mc) {
  if (!mc || !mc.period) return emptyState("▣", "No period selected", "Choose a period to view its position.");
  const fin = mc.financials || {};
  const aging = mc.aging || {};
  const cash = mc.unappliedCash || {};
  const buckets = Array.isArray(aging.buckets) ? aging.buckets : [];
  const maxBucket = Math.max(1, ...buckets.map((b) => Number(b.balance) || 0));
  const status = fin.status || mc.period.status || "OPEN";
  const closed = status === "CLOSED";
  const statusCard = `<div class="close-card"><div class="close-badge">${closed ? "▣" : "○"}</div><div><strong>${esc(monthLabel(mc.period.year, mc.period.month))} · ${esc(titleCase(status))}</strong><small>${closed && fin.closedAt ? `Closed ${esc(fmtDate(fin.closedAt))}` : "Open period"}</small></div></div>`;
  return `
    ${statusCard}
    <div class="kv-list" style="margin:16px 0">
      <div class="kv-row"><span>Recognized revenue</span><strong>${money(fin.recognizedRevenue || 0, true)}</strong></div>
      <div class="kv-row"><span>Outstanding receivables</span><strong>${money(fin.outstandingReceivables || 0, true)}</strong></div>
      <div class="kv-row"><span>Cash received</span><strong>${money(fin.cashReceived || 0, true)}</strong></div>
      <div class="kv-row"><span>Unbilled completed visits</span><strong>${num(fin.unbilledVisits || 0)}</strong></div>
      <div class="kv-row"><span>Unapplied cash</span><strong>${money(cash.totalUnapplied || 0, true)} · ${num(cash.count || 0)} payment(s)</strong></div>
    </div>
    <h3 style="font:600 11px/1 Georgia,serif;margin:0 0 12px;color:var(--muted)">A/R aging · ${money(aging.totalBalance || 0, true)} total</h3>
    <div class="aging">${buckets.length ? buckets.map((b) => `<div class="aging-row"><span class="aging-label">${esc(b.bucket)}</span><div class="aging-track"><div class="aging-fill" style="width:${Math.round(((Number(b.balance) || 0) / maxBucket) * 100)}%"></div></div><span class="aging-amt">${money(b.balance, true)}<small>${num(b.count || 0)} claim(s)</small></span></div>`).join("") : `<p class="meta-line">No aged receivables.</p>`}</div>`;
}
function cashActivityView() {
  const data = state.cache.accounting || {};
  const payments = Array.isArray(data.payments) ? data.payments : [];
  const unappliedPayments = payments.filter((p) => Number(p.unappliedAmount || 0) > 0);
  return `
    <div class="split-grid">
      <section class="panel"><div class="panel-head"><div><h2>Payments received</h2><p>Most recent remittances</p></div></div>
        <div class="data-table-wrap"><table><thead><tr><th>Payment</th><th>Received</th><th class="num">Amount</th><th class="num">Applied</th><th class="num">Unapplied</th><th>Status</th></tr></thead><tbody>
          ${payments.length ? payments.map((p) => `<tr><td><div class="cell-title">${esc(p.externalId || p.id)}</div></td><td>${esc(fmtDate(p.receivedAt))}</td><td class="num">${money(p.amount, true)}</td><td class="num">${money(p.applied, true)}</td><td class="num">${money(p.unappliedAmount, true)}</td><td>${statusBadge(p.status)}</td></tr>`).join("") : `<tr><td colspan="6">${emptyState("$", "No payments", "Imported remittances will appear here.")}</td></tr>`}
        </tbody></table></div>
      </section>
      <section class="panel"><div class="panel-head"><div><h2>Unapplied cash</h2><p>${unappliedPayments.length} payment(s) to review</p></div></div>
        <div class="panel-body">${unappliedPayments.length ? `<div class="kv-list">${unappliedPayments.map((p) => `<div class="kv-row"><span>${esc(p.externalId || p.id)}<br><small class="meta-line">${esc(fmtDate(p.receivedAt))}</small></span><strong>${money(p.unappliedAmount, true)}</strong></div>`).join("")}</div>` : `<p class="meta-line">All cash has been applied.</p>`}</div>
      </section>
    </div>`;
}

/* ===========================================================================
   REPORTS
   =========================================================================== */
async function renderReports() {
  const data = await api(`/ui-api/reports?${orgQ()}`);
  state.cache.reports = data;
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  const categories = [...new Set(catalog.map((c) => c.category || "other"))];
  app.innerHTML = `
    ${pageHead("Insights", "Reports", `Explore operational and financial data across ${orgName()}.`, `<button class="secondary-button">Scheduled exports</button>`)}
    ${categories.map((cat) => `<h2 class="section-title" style="${cat === categories[0] ? "margin-top:0" : ""}">${esc(titleCase(cat))} reports</h2>
      <section class="report-grid">${catalog.filter((c) => (c.category || "other") === cat).map(reportCard).join("")}</section>`).join("")}
    <div class="report-result" id="report-result"></div>
    <h2 class="section-title">Recent runs</h2>
    <section class="panel"><div class="panel-body" id="recent-runs">${recentRunsList(data.recentRuns)}</div></section>`;
}
function reportCard(entry) {
  return `<div class="report-card"><span class="report-icon ${entry.financial ? "lock" : ""}">${entry.financial ? "$" : "▥"}</span><h3>${esc(entry.name || entry.key)}</h3><p>${esc(entry.description || "")}</p><footer>${entry.financial ? `<span class="pill financial">Financial</span> ` : ""}${(entry.parameters || []).length} parameter(s) · <button class="panel-link" data-run-report="${esc(entry.key)}">Run report →</button></footer></div>`;
}
function recentRunsList(runs) {
  runs = Array.isArray(runs) ? runs : [];
  if (!runs.length) return `<p class="meta-line">No report runs yet. Run a report to see it here.</p>`;
  return runs.map((r) => `<div class="recent-run"><div class="cell-title">${esc(titleCase(r.reportKey || "report"))} ${statusBadge(r.status)}</div><span class="run-dur">${r.rowCount != null ? `${num(r.rowCount)} rows` : ""}${r.durationMs != null ? ` · ${num(r.durationMs)}ms` : ""}</span><span class="run-dur">${esc(fmtDateTime(r.startedAt))}</span></div>`).join("");
}
function runReportFlow(key) {
  const catalog = (state.cache.reports && state.cache.reports.catalog) || [];
  const entry = catalog.find((c) => c.key === key);
  if (!entry) { runReport(key, {}); return; }
  const params = entry.parameters || [];
  if (!params.length) { runReport(key, {}); return; }
  openModal(`<h2 id="modal-title">Run ${esc(entry.name || key)}</h2><p>${esc(entry.description || "Set parameters and run.")}</p>
    <form id="report-form" class="form-grid">
      ${params.map((p) => `<div class="form-field${p.type === "date" ? "" : " full"}"><label>${esc(titleCase(p.name))}${p.required ? " *" : ""}</label><input name="${esc(p.name)}" type="${p.type === "date" ? "date" : p.type === "number" ? "number" : "text"}" value="${esc(defaultParam(p))}" ${p.required ? "required" : ""}></div>`).join("")}
      <div class="form-actions"><button type="button" class="secondary-button" id="cancel-report">Cancel</button><button class="primary-action" type="submit">Run report</button></div>
    </form>`);
  document.querySelector("#cancel-report").addEventListener("click", closeModal);
  document.querySelector("#report-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target));
    const clean = {}; for (const [k, v] of Object.entries(values)) if (v !== "") clean[k] = v;
    closeModal();
    runReport(key, clean);
  });
}
function defaultParam(p) {
  if (p.type === "date") { if (/end|as.?of|to|through/i.test(p.name)) return TODAY_ISO; if (/start|from|since|begin/i.test(p.name)) return NINETY_AGO_ISO; return TODAY_ISO; }
  return "";
}
async function runReport(key, params) {
  const holder = document.querySelector("#report-result");
  if (holder) { holder.innerHTML = `<section class="panel"><div class="panel-body">${panelSpinner(`Running ${titleCase(key)}…`)}</div></section>`; holder.scrollIntoView({ behavior: "smooth", block: "start" }); }
  try {
    const res = await api("/ui-api/reports/run", { method: "POST", body: JSON.stringify({ organizationId: state.organizationId, key, params: params || {} }) });
    if (holder) holder.innerHTML = reportResult(key, res);
    // refresh recent runs
    api(`/ui-api/reports?${orgQ()}`).then((data) => { const rr = document.querySelector("#recent-runs"); if (rr && data) rr.innerHTML = recentRunsList(data.recentRuns); }).catch(() => {});
    toast(`${titleCase(key)} completed.`);
  } catch (error) {
    if (holder) holder.innerHTML = `<section class="panel"><div class="panel-body">${emptyState("⚠", "Report failed", error.message)}</div></section>`;
    toast(error.message || "Report failed", "error");
  }
}
function reportResult(key, res) {
  const result = res && res.result;
  const rows = Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : null);
  const meta = `<span class="run-dur">${res && res.durationMs != null ? `${num(res.durationMs)}ms` : ""}${res && res.rowCount != null ? ` · ${num(res.rowCount)} rows` : ""}</span>`;
  let body;
  if (rows && rows.length && typeof rows[0] === "object" && rows[0] !== null) {
    const cols = Object.keys(rows[0]).slice(0, 8);
    body = `<div class="data-table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(titleCase(c))}</th>`).join("")}</tr></thead><tbody>${rows.slice(0, 50).map((row) => `<tr>${cols.map((c) => `<td>${formatCell(row[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  } else if (rows && !rows.length) {
    body = `<div class="panel-body">${emptyState("◔", "No rows", "This report returned no rows for the selected parameters.")}</div>`;
  } else {
    body = `<pre>${esc(JSON.stringify(result, null, 2))}</pre>`;
  }
  return `<section class="panel"><div class="panel-head"><div><h2>${esc(titleCase(key))}</h2><p>Generated just now · ${esc(orgName())}</p></div>${meta}</div>${body}</section>`;
}
function formatCell(v) {
  if (v == null) return "—";
  if (typeof v === "number") return num(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return esc(JSON.stringify(v));
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return esc(fmtDateTime(s));
  return esc(s);
}

/* ===========================================================================
   WORKFLOWS
   =========================================================================== */
async function renderWorkflows() {
  const data = await api(`/ui-api/automations?${orgQ()}`);
  state.cache.automations = data;
  const workflows = Array.isArray(data.workflows) ? data.workflows : [];
  const executions = Array.isArray(data.recentExecutions) ? data.recentExecutions : [];
  const webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
  app.innerHTML = `
    ${pageHead("Platform", "Workflows", `Respond to business events with configured conditions and actions for ${orgName()}.`, `<button class="secondary-button">Process events (${num(data.pendingEvents || 0)})</button><button class="primary-action">+ New workflow</button>`)}
    <section class="metric-grid">
      ${metricCard("Active workflows", num(workflows.filter((w) => w.enabled).length), "↯", `${workflows.length} configured`)}
      ${metricCard("Pending events", num(data.pendingEvents || 0), "E", "Awaiting worker processing")}
      ${metricCard("Recent executions", num(executions.length), "✓", "Across all workflows")}
      ${metricCard("Webhooks", num(webhooks.length), "◈", `${webhooks.filter((w) => w.active).length} active`)}
    </section>
    <section class="table-panel"><div class="panel-head"><div><h2>Workflow definitions</h2><p>Triggers and side effects</p></div></div>
      <div class="data-table-wrap"><table><thead><tr><th>Workflow</th><th>Trigger event</th><th class="num">Version</th><th class="num">Actions</th><th class="num">Runs</th><th>Enabled</th></tr></thead><tbody>
        ${workflows.length ? workflows.map((w) => `<tr><td><div class="cell-title">${esc(w.name)}</div><div class="cell-sub">${esc(w.id)}</div></td><td><code>${esc(w.eventName || "—")}</code></td><td class="num">v${esc(w.version ?? 1)}</td><td class="num">${num(Array.isArray(w.actions) ? w.actions.length : (w.actions || 0))}</td><td class="num">${num((w.executions || []).length)}</td><td><button class="toggle ${w.enabled ? "on" : ""}" data-toggle-workflow="${esc(w.id)}"><span class="track"></span><span class="toggle-label">${w.enabled ? "On" : "Off"}</span></button></td></tr>`).join("") : `<tr><td colspan="6">${emptyState("↯", "No workflows", "Configured automations will appear here.")}</td></tr>`}
      </tbody></table></div>
    </section>
    <h2 class="section-title">Execution feed</h2>
    <section class="table-panel">${executions.length ? `<div class="data-table-wrap"><table><thead><tr><th>Workflow</th><th>Started</th><th>Status</th></tr></thead><tbody>
      ${executions.map((e) => `<tr><td class="cell-title">${esc((e.workflow && e.workflow.name) || "—")}</td><td>${esc(fmtDateTime(e.startedAt))}</td><td>${statusBadge(e.status)}</td></tr>`).join("")}
    </tbody></table></div>` : emptyState("↯", "No executions yet", "Business events will appear here after the worker evaluates triggers.")}</section>`;
  document.querySelectorAll("[data-toggle-workflow]").forEach((btn) => btn.addEventListener("click", () => {
    const on = btn.classList.toggle("on");
    btn.querySelector(".toggle-label").textContent = on ? "On" : "Off";
    toast(`Workflow ${on ? "enabled" : "disabled"} (preview — not persisted).`);
  }));
}

/* ===========================================================================
   AI EMPLOYEE
   =========================================================================== */
const QUICK_QUESTIONS = [
  "Find visits that cannot be billed and explain why.",
  "Which claims were rejected and why?",
  "Why did expected revenue change?",
  "What documentation is missing?",
];
async function renderAi() {
  const data = await api(`/ui-api/ai?${orgQ()}`).catch(() => ({ runs: [], quality: {} }));
  state.cache.ai = data;
  const quality = data.quality || {};
  const runs = Array.isArray(data.runs) ? data.runs : [];
  app.innerHTML = `
    <section class="ai-hero"><div><p class="eyebrow">Juniper AI employee · Preview</p><h1>A focused teammate for your operational backlog</h1><p>Ask about billing blockers, rejected claims, or missing documentation. The AI employee traces the underlying records and proposes actions — material changes stay under human review.</p></div></section>
    <section class="agent-workspace">
      <div class="panel"><div class="panel-head"><div><h2>Ask the AI employee</h2><p>${esc(orgName())} · all branches</p></div><span class="status active">Ready</span></div>
        <div class="panel-body">
          <div class="ai-composer">
            <textarea id="ai-input" placeholder="Ask about billing blockers, rejections, revenue, or documentation…"></textarea>
            <div class="ai-composer-foot"><span class="hint">Read-only analysis · proposed actions require approval</span><button class="primary-action" id="ai-ask">Ask →</button></div>
          </div>
          <div class="quick-questions">${QUICK_QUESTIONS.map((q) => `<button class="quick-q" data-quick-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
          <div id="ai-conversation" style="margin-top:16px"></div>
        </div>
      </div>
      <div>
        <div class="panel"><div class="panel-head"><div><h2>Quality</h2><p>Recent agent performance</p></div></div>
          <div class="panel-body"><div class="quality-grid">
            <div class="quality-cell"><small>Total runs</small><strong>${num(quality.totalRuns || 0)}</strong></div>
            <div class="quality-cell"><small>Proposed actions</small><strong>${num(quality.proposedActions || 0)}</strong></div>
            <div class="quality-cell"><small>Executed actions</small><strong>${num(quality.executedActions || 0)}</strong></div>
            <div class="quality-cell"><small>Tool calls</small><strong>${num(quality.toolInvocations || 0)}</strong></div>
            <div class="quality-cell"><small>Tool errors</small><strong>${num(quality.toolErrors || 0)}</strong></div>
            <div class="quality-cell"><small>Actioned rate</small><strong>${quality.proposedActions ? Math.round((Number(quality.executedActions || 0) / Number(quality.proposedActions)) * 100) : 0}%</strong></div>
          </div>${quality.note ? `<p class="meta-line" style="margin-top:12px">${esc(quality.note)}</p>` : ""}</div>
        </div>
        <div class="panel" style="margin-top:16px"><div class="panel-head"><div><h2>Recent runs</h2><p>${runs.length} logged</p></div></div>
          <div class="panel-body">${runs.length ? `<div class="run-list">${runs.slice(0, 8).map(aiRunItem).join("")}</div>` : `<p class="meta-line">No AI runs yet. Ask a question to get started.</p>`}</div>
        </div>
      </div>
    </section>`;
  document.querySelector("#ai-ask").addEventListener("click", () => askAi(document.querySelector("#ai-input").value.trim()));
  document.querySelector("#ai-input").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") askAi(e.target.value.trim()); });
}
function aiRunItem(run) {
  const actions = Array.isArray(run.proposedActions) ? run.proposedActions : [];
  return `<div class="run-item"><div class="run-top"><strong>${esc(titleCase(run.purpose) || "AI run")}</strong>${statusBadge(run.status)}<span class="run-time">${esc(fmtDateTime(run.createdAt))}</span></div><p>${esc(run.response || "")}</p>${actions.length ? `<div class="meta-line" style="margin-top:6px">${actions.length} proposed action(s)</div>` : ""}</div>`;
}
function askQuick(question) { const input = document.querySelector("#ai-input"); if (input) input.value = question; askAi(question); }
async function askAi(question) {
  if (!question) { toast("Enter a question for the AI employee.", "error"); return; }
  const conv = document.querySelector("#ai-conversation");
  const askBtn = document.querySelector("#ai-ask");
  if (askBtn) { askBtn.disabled = true; askBtn.textContent = "Thinking…"; }
  conv.innerHTML = `<div class="msg you"><div class="msg-who"><span class="dot"></span>You</div><p>${esc(question)}</p></div>${panelSpinner("The AI employee is reviewing records…")}`;
  try {
    const res = await api("/ui-api/ai/ask", { method: "POST", body: JSON.stringify({ organizationId: state.organizationId, question }) });
    conv.innerHTML = `<div class="msg you"><div class="msg-who"><span class="dot"></span>You</div><p>${esc(question)}</p></div>${aiAnswer(res)}`;
    toast("The AI employee responded.");
  } catch (error) {
    conv.innerHTML = `<div class="msg you"><div class="msg-who"><span class="dot"></span>You</div><p>${esc(question)}</p></div>${emptyState("⚠", "The AI employee could not respond", error.message)}`;
    toast(error.message || "AI request failed", "error");
  } finally { if (askBtn) { askBtn.disabled = false; askBtn.textContent = "Ask →"; } }
}
function aiAnswer(res) {
  const run = res.run || {};
  const answer = res.answer || run.response || "No answer returned.";
  const provenance = Array.isArray(res.provenance) ? res.provenance : [];
  const toolResults = Array.isArray(res.toolResults) ? res.toolResults : [];
  const actions = Array.isArray(run.proposedActions) ? run.proposedActions : (Array.isArray(res.proposedActions) ? res.proposedActions : []);
  return `<div class="msg ai"><div class="msg-who"><span class="dot"></span>AI employee</div><p>${esc(answer)}</p>
    ${provenance.length ? `<div class="provenance">${provenance.map((p) => `<span class="prov-chip">${esc(provLabel(p))}</span>`).join("")}</div>` : ""}
  </div>
  ${actions.length ? `<h3 style="font:600 12px/1 Georgia,serif;margin:6px 0 8px">Proposed actions</h3>${actions.map((a) => `<div class="action-card" id="action-${esc(a.id)}"><span class="action-icon">✦</span><span><strong>${esc(titleCase(a.actionType) || "Action")}</strong><small>${esc(a.summary || "Proposed — requires approval")}</small></span>${a.status === "EXECUTED" ? `<span class="status completed">Executed</span>` : `<button class="primary-action" data-exec-action="${esc(a.id)}">Approve &amp; run</button>`}</div>`).join("")}` : ""}
  ${toolResults.length ? toolResults.map((t) => `<details class="tool-result"><summary>Tool · ${esc(t.tool || "result")}</summary><pre>${esc(JSON.stringify(t.result, null, 2))}</pre></details>`).join("") : ""}`;
}
function provLabel(p) { if (p == null) return "source"; if (typeof p === "string") return p; return p.label || p.type || p.tool || p.source || p.id || JSON.stringify(p).slice(0, 40); }
async function executeAction(id) {
  const card = document.querySelector(`#action-${CSS.escape(id)}`);
  const btn = card ? card.querySelector("[data-exec-action]") : null;
  if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
  try {
    await api(`/ui-api/ai/actions/${encodeURIComponent(id)}/execute`, { method: "POST", body: "{}" });
    if (btn) btn.outerHTML = `<span class="status completed">Executed</span>`;
    toast("Action approved and executed.");
  } catch (error) {
    if (btn) { btn.disabled = false; btn.textContent = "Approve & run"; }
    toast(error.message || "Could not execute action", "error");
  }
}

/* ===========================================================================
   PERMISSIONS (Enterprise)
   =========================================================================== */
async function renderPermissions() {
  const data = await api(`/ui-api/permissions?${orgQ()}`);
  const matrix = Array.isArray(data.matrix) ? data.matrix : [];
  const scopes = Array.isArray(data.unsupportedScopes) ? data.unsupportedScopes : [];
  const roles = ["ADMIN", "CLINICIAN", "BILLER", "VIEWER"];
  const org = currentOrg();
  app.innerHTML = `
    ${pageHead("Platform", "Permissions", "Role-based capabilities, enforcement source, and unsupported access scopes.", org && org.enterprise ? `<span class="pill" style="align-self:center">Enterprise</span>` : "")}
    ${org && !org.enterprise ? `<div class="inline-note"><span>ℹ</span><span>${esc(org.name)} is on the standard plan. Region-, team-, and delegated access scopes require the Enterprise tier.</span></div>` : ""}
    <section class="split-grid">
      <section class="panel"><div class="panel-head"><div><h2>Role capability matrix</h2><p>Organization-level permissions by role</p></div></div>
        <div class="data-table-wrap"><table class="permission-matrix"><thead><tr><th>Capability</th>${roles.map((r) => `<th>${esc(titleCase(r))}</th>`).join("")}<th>Enforcement</th></tr></thead><tbody>
          ${matrix.length ? matrix.map((row) => `<tr><td>${esc(row.label || row.action)}</td>${roles.map((r) => `<td>${(row.roles && row.roles[r]) ? `<span class="perm-check">✓</span>` : `<span class="perm-x">✕</span>`}</td>`).join("")}<td><span class="enf-badge ${esc(row.enforcement || "policy")}">${esc(row.enforcement || "policy")}</span></td></tr>`).join("") : `<tr><td colspan="${roles.length + 2}">${emptyState("A", "No matrix", "Permission matrix unavailable.")}</td></tr>`}
        </tbody></table></div>
      </section>
      <section class="panel"><div class="panel-head"><div><h2>Unsupported scopes</h2><p>Not yet enforced</p></div></div>
        <div class="panel-body"><div class="scope-list">
          ${scopes.length ? scopes.map((s) => `<div class="scope-item"><span class="scope-x">✕</span><span>${esc(typeof s === "string" ? titleCase(s) : (s.label || s.name || JSON.stringify(s)))}</span></div>`).join("") : `<p class="meta-line">All access scopes are supported.</p>`}
        </div></div>
      </section>
    </section>`;
}

/* ===========================================================================
   ORG SWITCHER + GLOBAL SEARCH
   =========================================================================== */
async function loadOrgs() {
  const select = document.querySelector("#org-select");
  try {
    const orgs = await api("/ui-api/orgs");
    state.orgs = Array.isArray(orgs) ? orgs : [];
  } catch (error) { state.orgs = []; toast("Could not load organizations.", "error"); }
  if (!state.orgs.length) { select.innerHTML = `<option>${esc(DEFAULT_ORG)}</option>`; return; }
  if (!state.orgs.find((o) => o.id === state.organizationId)) state.organizationId = state.orgs[0].id;
  select.innerHTML = state.orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}${o.enterprise ? " · Enterprise" : ""}</option>`).join("");
  select.value = state.organizationId;
  applyOrgHeader();
  select.addEventListener("change", () => {
    state.organizationId = select.value;
    localStorage.setItem("juniper.org", state.organizationId);
    applyOrgHeader();
    handleRoute();
  });
}
function applyOrgHeader() {
  const org = currentOrg();
  const logo = document.querySelector("#org-logo");
  if (logo) logo.textContent = ((org && org.name) || "N").trim().charAt(0).toUpperCase();
  const ent = document.querySelector("#permissions-ent-tag");
  if (ent) ent.hidden = !(org && org.enterprise);
  const role = document.querySelector("#profile-role");
  if (role && org) role.textContent = org.name;
}

function wireSearch() {
  const input = document.querySelector("#global-search");
  const box = document.querySelector("#search-results");
  let timer;
  const hide = () => { box.hidden = true; box.innerHTML = ""; };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(async () => {
      try {
        const results = await api(`/ui-api/patients?${orgQ({ q })}`);
        const list = Array.isArray(results) ? results.slice(0, 6) : [];
        if (!list.length) { box.innerHTML = `<div class="search-empty">No patients match “${esc(q)}”.</div>`; box.hidden = false; return; }
        box.innerHTML = list.map((p) => `<button class="search-item" data-patient-id="${esc(p.id)}"><span class="patient-initials">${esc(initials(p.name))}</span><span><strong>${esc(p.name)}</strong><small>MRN ${esc(p.externalId || "—")} · ${esc(p.payer || "—")}</small></span></button>`).join("") + `<div class="search-foot">Press Enter to view all patient results →</div>`;
        box.hidden = false;
        box.querySelectorAll(".search-item").forEach((item) => item.addEventListener("click", () => { hide(); input.value = ""; showPatientDrawer(item.dataset.patientId); }));
      } catch (_) { hide(); }
    }, 220);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const q = input.value.trim(); hide(); if (q) { state.pendingPatientQuery = q; input.value = ""; go("patients"); } }
    if (e.key === "Escape") hide();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".global-search-wrap")) hide(); });
}

/* ===========================================================================
   ROUTER + EVENT WIRING
   =========================================================================== */
const routes = {
  dashboard: renderDashboard,
  patients: renderPatients,
  visits: renderVisits,
  documentation: renderDocumentation,
  revenue: renderRevenue,
  accounting: renderAccounting,
  reports: renderReports,
  workflows: renderWorkflows,
  ai: renderAi,
  permissions: renderPermissions,
};
function currentRouteKey() {
  const key = location.hash.replace(/^#\/?/, "").split("/")[0];
  return routes[key] ? key : "dashboard";
}
function setActiveNav(route) {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.route === route));
}
async function handleRoute() {
  const route = currentRouteKey();
  state.route = route;
  setActiveNav(route);
  closeDrawer();
  closeModal();
  sidebar.classList.remove("open");
  loadingPage();
  try {
    await routes[route]();
    app.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  } catch (error) {
    console.error(error);
    pageError(error);
    toast(error.message || "Something went wrong loading this screen.", "error");
  }
}

/* Tab switching (delegated by group) */
function handleTabClick(button) {
  const group = button.dataset.tabgroup;
  const tab = button.dataset.tab;
  document.querySelectorAll(`[data-tabgroup="${group}"]`).forEach((b) => b.classList.toggle("active", b === button));
  if (group === "visits") {
    const panel = document.querySelector("#visits-tabpanel");
    if (tab === "activity") { panel.innerHTML = visitActivityView(); bindVisitFilters(); }
    else { panel.innerHTML = panelSpinner("Loading documentation backlog…"); documentationView().then((html) => { panel.innerHTML = html; bindDocSearch(); }).catch((e) => { panel.innerHTML = emptyState("⚠", "Failed to load", e.message); }); }
  } else if (group === "revenue") {
    const panel = document.querySelector("#revenue-tabpanel");
    if (tab === "claims") { panel.innerHTML = claimQueueView(); bindClaimChips(); }
    else { panel.innerHTML = rejectionsView(); }
  } else if (group === "accounting") {
    const panel = document.querySelector("#accounting-tabpanel");
    if (tab === "close") { panel.innerHTML = accountingCloseView(); const first = (state.cache.accounting && state.cache.accounting.periods || [])[0]; loadMonthClose(first ? first.id : null); }
    else { panel.innerHTML = cashActivityView(); }
  }
}

/* Delegated clicks across the main content + drawer */
function onDelegatedClick(e) {
  const tab = e.target.closest("[data-tab]"); if (tab) { handleTabClick(tab); return; }
  const nav = e.target.closest("[data-nav]"); if (nav) { closeDrawer(); go(nav.dataset.nav); return; }
  const period = e.target.closest("[data-period-id]"); if (period) { document.querySelectorAll("[data-period-id]").forEach((r) => r.classList.remove("row-active")); loadMonthClose(period.dataset.periodId); return; }
  const visit = e.target.closest("[data-visit-id]"); if (visit) { showVisitDrawer(visit.dataset.visitId); return; }
  const patient = e.target.closest("[data-patient-id]"); if (patient) { showPatientDrawer(patient.dataset.patientId); return; }
  const claim = e.target.closest("[data-claim-id]"); if (claim) { showClaimDrawer(claim.dataset.claimId); return; }
  const report = e.target.closest("[data-run-report]"); if (report) { runReportFlow(report.dataset.runReport); return; }
  const quick = e.target.closest("[data-quick-q]"); if (quick) { askQuick(quick.dataset.quickQ); return; }
  const exec = e.target.closest("[data-exec-action]"); if (exec) { executeAction(exec.dataset.execAction); return; }
  const intake = e.target.closest("[data-open-intake]"); if (intake) { showIntakeModal(); return; }
}

function bindChrome() {
  app.addEventListener("click", onDelegatedClick);
  drawerContent.addEventListener("click", onDelegatedClick);
  document.querySelector("#mobile-menu").addEventListener("click", () => sidebar.classList.toggle("open"));
  document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
  drawerBackdrop.addEventListener("click", closeDrawer);
  document.querySelector("#modal-close").addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeModal(); });
  document.querySelector("#quick-action").addEventListener("click", showIntakeModal);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); document.querySelector("#global-search").focus(); }
    if (e.key === "Escape") { closeDrawer(); closeModal(); sidebar.classList.remove("open"); }
  });
  window.addEventListener("hashchange", handleRoute);
}

/* --- Bootstrap ------------------------------------------------------------ */
async function init() {
  bindChrome();
  wireSearch();
  await loadOrgs();
  if (!location.hash) location.replace("#/dashboard");
  handleRoute();
}
init();
