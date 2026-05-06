/* GitHub-backed sync for notes.json
 * Reads notes.json from the deployed site (no auth) and pushes via the
 * GitHub Contents API (requires a personal access token stored locally).
 * Tombstones track local deletions so they survive merges.
 */
window.SYNC = (function () {
  const REPO_OWNER = "ahmed-kar";
  const REPO_NAME  = "ahmed-kar.github.io";
  const BRANCH     = "master";
  const FILE_PATH  = "notes.json";
  const PAT_KEY    = "gh-pat-v1";
  const TOMB_KEY   = "ahmed-reading-tombstones-v1";

  // ---------- PAT storage ----------
  function getPAT() {
    try { return localStorage.getItem(PAT_KEY) || ""; } catch { return ""; }
  }
  function setPAT(v) {
    try { localStorage.setItem(PAT_KEY, v); } catch {}
  }
  function clearPAT() {
    try { localStorage.removeItem(PAT_KEY); } catch {}
  }

  // ---------- Tombstones (local deletions awaiting sync) ----------
  function getTombstones() {
    try {
      const raw = localStorage.getItem(TOMB_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function addTombstone(key) {
    const t = getTombstones();
    t[key] = new Date().toISOString();
    try { localStorage.setItem(TOMB_KEY, JSON.stringify(t)); } catch {}
  }
  function clearAllTombstones() {
    try { localStorage.removeItem(TOMB_KEY); } catch {}
  }

  // ---------- Read remote (public, no auth) ----------
  async function loadRemote() {
    try {
      const res = await fetch(`${FILE_PATH}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) return {};
        throw new Error(`fetch ${res.status}`);
      }
      const text = await res.text();
      if (!text.trim()) return {};
      const parsed = JSON.parse(text);
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
      console.warn("[sync] loadRemote failed:", e);
      return null; // null = transient failure (offline / file://)
    }
  }

  // ---------- Merge logic ----------
  // Combine local + remote notes, applying tombstones to suppress
  // remotely-resurrected items the user has deleted locally.
  function merge(local, remote, tombstones) {
    local = local || {};
    remote = remote || {};
    tombstones = tombstones || {};
    const merged = {};
    const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);

    for (const k of allKeys) {
      const l = local[k];
      const r = remote[k];
      const tomb = tombstones[k];

      if (tomb) {
        const lu = (l && l.updatedAt) || "";
        const ru = (r && r.updatedAt) || "";
        // Tombstone wins unless something newer exists on either side
        if (lu <= tomb && ru <= tomb) continue;
      }

      if (l && r) merged[k] = ((l.updatedAt || "") >= (r.updatedAt || "")) ? l : r;
      else merged[k] = l || r;
    }
    return merged;
  }

  // ---------- Push (PAT required) ----------
  async function getFileSha(pat) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(FILE_PATH)}?ref=${encodeURIComponent(BRANCH)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (res.status === 401) { clearPAT(); throw new Error("BAD_PAT"); }
    if (!res.ok) throw new Error(`GET sha ${res.status}`);
    const data = await res.json();
    return data.sha;
  }

  function utf8ToBase64(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }

  async function push(notes, message) {
    const pat = getPAT();
    if (!pat) throw new Error("NO_PAT");

    const sha = await getFileSha(pat);
    const content = JSON.stringify(notes, null, 2) + "\n";
    const body = {
      message: message || `notes: update (${Object.keys(notes).length} entries)`,
      content: utf8ToBase64(content),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;

    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(FILE_PATH)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) { clearPAT(); throw new Error("BAD_PAT"); }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`PUT ${res.status}: ${t.slice(0, 200)}`);
    }
    clearAllTombstones(); // remote now reflects deletions
    return true;
  }

  // ---------- PAT modal UI ----------
  function showPATModal() {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "sync-modal-overlay";
      overlay.innerHTML = `
        <div class="sync-modal" role="dialog" aria-modal="true">
          <div class="sync-modal-header">
            <h3>Set up cross-device sync</h3>
            <button class="sync-modal-close" type="button" aria-label="Close">×</button>
          </div>
          <div class="sync-modal-body">
            <p>To save notes to your GitHub repo (and read them on any device), this site needs a <strong>personal access token</strong>. The token is stored in this browser only — it is never sent anywhere except GitHub.</p>
            <ol>
              <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a> (fine-grained tokens).</li>
              <li>Repository access → <em>Only select repositories</em> → pick <code>ahmed-kar.github.io</code>.</li>
              <li>Repository permissions → <strong>Contents: Read and write</strong>.</li>
              <li>Generate, copy the token, paste below.</li>
            </ol>
            <input type="password" class="sync-pat-input" placeholder="github_pat_… or ghp_…" autocomplete="off" spellcheck="false" />
            <div class="sync-modal-actions">
              <button class="sync-modal-btn sync-modal-cancel" type="button">cancel</button>
              <button class="sync-modal-btn primary sync-modal-save" type="button">save token</button>
            </div>
            <p class="sync-modal-note">Tip: set a short expiry (e.g. 90 days) on the token. You can revoke it any time at <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a>.</p>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const input  = overlay.querySelector(".sync-pat-input");
      const save   = overlay.querySelector(".sync-modal-save");
      const cancel = overlay.querySelector(".sync-modal-cancel");
      const close  = overlay.querySelector(".sync-modal-close");
      setTimeout(() => input.focus(), 50);

      function done(ok) { overlay.remove(); resolve(ok); }

      input.addEventListener("keydown", e => {
        if (e.key === "Enter")  { e.preventDefault(); save.click(); }
        if (e.key === "Escape") { e.preventDefault(); done(false); }
      });
      save.addEventListener("click", () => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; }
        setPAT(v);
        done(true);
      });
      cancel.addEventListener("click", () => done(false));
      close.addEventListener("click",  () => done(false));
      overlay.addEventListener("click", e => { if (e.target === overlay) done(false); });
    });
  }

  // High-level helper: ensure PAT, then push. Surfaces a single boolean
  // result (true = synced, false = aborted/failed) and toasts via callback.
  async function syncNow(notes, opts) {
    opts = opts || {};
    const message = opts.message;
    if (!getPAT()) {
      const ok = await showPATModal();
      if (!ok) return { ok: false, reason: "no-pat" };
    }
    try {
      await push(notes, message);
      return { ok: true };
    } catch (e) {
      if (String(e.message).includes("BAD_PAT") || String(e.message).includes("NO_PAT")) {
        const ok = await showPATModal();
        if (!ok) return { ok: false, reason: "bad-pat-cancelled" };
        try {
          await push(notes, message);
          return { ok: true };
        } catch (e2) {
          return { ok: false, reason: "push-failed", error: e2 };
        }
      }
      return { ok: false, reason: "push-failed", error: e };
    }
  }

  return {
    REPO_OWNER, REPO_NAME, BRANCH, FILE_PATH,
    getPAT, setPAT, clearPAT,
    getTombstones, addTombstone, clearAllTombstones,
    loadRemote, merge, push, syncNow, showPATModal,
  };
})();
