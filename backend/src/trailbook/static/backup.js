// Settings › Backup: export the whole install to one ZIP and restore it on another device.
// Loaded after preview.js (uses its helpers: api, esc, num, state, hint, browserTime, timer).
"use strict";

const BACKUP_PHASES = { start: "Starting", database: "Database", files: "Files", scan: "Checking files" };

const fmtSize = (bytes) => bytes >= 1073741824 ? `${num(bytes / 1073741824, 2)} GB`
  : bytes >= 1048576 ? `${num(bytes / 1048576, 1)} MB` : `${num(Math.ceil(bytes / 1024))} kB`;

function backupJobState(p, kind, isRunning) {
  if (isRunning || p.state === "running") {
    const step = BACKUP_PHASES[p.phase] || p.phase || "";
    const count = p.total ? ` ${num(p.done ?? 0)} / ${num(p.total)} files` : "";
    const size = p.total_bytes ? ` · ${fmtSize(p.bytes || 0)} of ${fmtSize(p.total_bytes)}` : "";
    return state(`Running: ${esc(step)}${count}${size}`, "warn");
  }
  if (p.state === "running?") return state("Interrupted — the process stopped before finishing", "bad");
  if (p.state === "failed") return state(`Failed: ${esc(p.error)}`, "bad");
  if (p.state === "finished") {
    return kind === "export"
      ? state(`Last export ${browserTime(p.finished_at)} · ${p.files ? `${num(p.files)} files (${fmtSize(p.bytes || 0)})` : "database only"}`, "ok")
      : state(`Restored ${browserTime(p.finished_at)} · ${num(p.activities)} activities, ${num(p.files)} files`, "ok");
  }
  return "";
}

function exportContents(m) {
  if (!m) return "";
  const c = m.counts || {};
  return [
    `${num(c.activities ?? 0)} activities`,
    m.include_files ? `${num(c.archived_files ?? 0)} files` : "database only",
    m.include_secrets ? "with Garmin keys" : "",
    `${num((m.persons || []).length)} people`,
  ].filter(Boolean).join(" · ");
}

async function settingsBackup(el) {
  const s = await api("backup");
  const busy = !!s.running;
  const rows = s.exports.map((x) => `<tr>
      <td><code>${esc(x.name)}</code></td>
      <td>${x.manifest ? browserTime(x.manifest.created_at) : ""}</td>
      <td class="num">${fmtSize(x.bytes)}</td>
      <td>${x.error ? state(esc(x.error), "bad") : esc(exportContents(x.manifest))}</td>
      <td class="actions">
        <a class="btn small" href="api/export/${encodeURIComponent(x.name)}" download>Download</a>
        ${x.error ? "" : `<button class="small" data-restore-name="${esc(x.name)}" ${busy ? "disabled" : ""}>Restore</button>`}
        <button class="small danger" data-delete-export="${esc(x.name)}" ${busy ? "disabled" : ""}>Delete</button>
      </td></tr>`).join("");

  el.innerHTML = `
    <div class="card">
      <h3>Export <span class="title-note">(to move Trailbook to another device)</span></h3>
      <div class="check-list">
        <label><input type="checkbox" name="exp-files" checked> Include FIT files </label>
        <label><input type="checkbox" name="exp-secrets"> Include Garmin API keys <span class="hint">— keep such a ZIP private</span></label>
      </div>
      <div class="card-row" style="margin-top:12px">
        <button class="primary" data-export ${busy ? "disabled" : ""}>Create export</button>
        <span data-export-state>${backupJobState(s.export, "export", s.running === "export")}</span>
      </div>
    </div>

    <div class="card">
      <h3>Exports <span class="title-note">(${esc(s.exports_dir)})</span></h3>
      ${rows ? `<div class="scroll"><table class="data exports"><thead><tr><th>File</th><th>Created</th><th class="num">Size</th><th>Contents</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : hint("No exports yet.")}
    </div>

    <div class="card">
      <h3>Restore from an export</h3>
      <div class="upload-row">${filePicker("restore-file", ".zip")}</div>
      ${s.empty ? "" : `<div class="check-list"><label><input type="checkbox" name="restore-confirm"> Replace all data in this install <span class="hint">— cannot be undone</span></label></div>`}
      <div class="card-row" style="margin-top:12px">
        <button class="primary" data-restore ${busy ? "disabled" : ""}>Restore</button>
        <span data-restore-state>${backupJobState(s.restore, "restore", s.running === "restore")}</span>
      </div>
    </div>`;

  const reload = () => settingsBackup(el);
  const out = (sel, html) => { el.querySelector(sel).innerHTML = html; };

  el.querySelector("[data-export]").onclick = async () => {
    try {
      await api("export", { method: "POST", body: JSON.stringify({
        files: el.querySelector("[name=exp-files]").checked,
        secrets: el.querySelector("[name=exp-secrets]").checked,
      }) });
      await reload();
    } catch (e) { out("[data-export-state]", state(esc(e.message), "bad")); }
  };

  const confirmed = () => s.empty || el.querySelector("[name=restore-confirm]").checked;
  const startRestore = async (query, body) => {
    const q = new URLSearchParams(query);
    if (!s.empty) q.set("confirm", "1");
    out("[data-restore-state]", state(body ? `Uploading ${fmtSize(body.size)}…` : "Starting…", "warn"));
    try {
      await api("restore?" + q, { method: "POST", ...(body ? { body, headers: {} } : {}) });
      await reload();
    } catch (e) { out("[data-restore-state]", state(esc(e.message), "bad")); }
  };

  el.querySelector("[data-restore]").onclick = () => {
    const file = el.querySelector("[name=restore-file]").files[0];
    if (!file) return out("[data-restore-state]", state("Choose an export file", "warn"));
    if (!confirmed()) return out("[data-restore-state]", state("Tick “Replace all data in this install” first", "warn"));
    startRestore({}, file);
  };
  el.querySelectorAll("[data-restore-name]").forEach((b) => b.onclick = () => {
    if (!confirmed()) {
      out("[data-restore-state]", state("Tick “Replace all data in this install” first", "warn"));
      el.querySelector("[name=restore-confirm]").closest("label").scrollIntoView({ block: "center" });
      return;
    }
    startRestore({ name: b.dataset.restoreName });
  });
  el.querySelectorAll("[data-delete-export]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Delete ${b.dataset.deleteExport}? The file is removed from the exports folder.`)) return;
    try { await api("export/" + encodeURIComponent(b.dataset.deleteExport), { method: "DELETE" }); await reload(); }
    catch (e) { alert(e.message); }
  });

  if (busy) {
    const wasRestore = s.running === "restore";
    timer = setTimeout(async () => {
      const now = await api("backup").catch(() => null);
      // After a restore everything (people, types, settings) may differ: reload the app.
      if (wasRestore && now && !now.running) { location.reload(); return; }
      reload();
    }, 2000);
  }
}
