<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DFK Tournament Leaderboard</title>
  <style>
    :root{
      --bg:#0b1220;
      --muted:#7f93b8;
      --text:#e9f0ff;
      --border:rgba(255,255,255,.10);
      --accent:#4ea1ff;
      --bad:#ef4444;

      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --radius:16px;

      --inputBg: rgba(0,0,0,.18);
      --inputBgFocus: rgba(0,0,0,.26);
      --chipBg: rgba(255,255,255,.03);
      --chipBg2: rgba(255,255,255,.05);

      --toggleOff: rgba(255,255,255,.04);
      --toggleOn: rgba(255,255,255,.09);
    }

    *{box-sizing:border-box}
    body{
      margin:0;
      font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Helvetica,Arial;
      background:
        radial-gradient(1200px 700px at 10% -10%, rgba(78,161,255,.18), transparent 55%),
        radial-gradient(900px 600px at 110% 0%, rgba(110,231,255,.12), transparent 50%),
        var(--bg);
      color:var(--text);
    }
    a{color:inherit}
    .wrap{max-width:1240px;margin:0 auto;padding:18px}

    /* page columns */
    .page{
      display:grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap:14px;
      align-items:start;
    }

    /* ✅ centered body block; filters+table widened by 15% (from 60% -> 69%) */
    .mainNarrow{
      width: 69%;
      margin: 0 auto;
    }

    /* ✅ header aligns to centered body block too */
    header{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      margin-bottom:10px;
    }
    .headerInner{
      width: 69%;
      margin: 0 auto;
    }

    h1{font-size:18px;margin:0}
    .sub{color:var(--muted);font-size:12px;margin-top:2px}

    /* clocks under header */
    .clocksRow{
      display:flex;
      gap:10px;
      flex-wrap:wrap;
      align-items:center;
      margin:8px 0 14px;
    }
    .chip{
      display:inline-flex;
      align-items:center;
      gap:10px;
      padding:8px 10px;
      border:1px solid var(--border);
      border-radius:12px;
      background: var(--chipBg);
      box-shadow: 0 8px 18px rgba(0,0,0,.12);
      max-width:100%;
    }
    .chip.secondary{background: var(--chipBg2); box-shadow:none;}
    .chip .k{color:var(--muted);font-size:12px;white-space:nowrap}
    .chip .v{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-weight:900;
      white-space:nowrap;
    }
    .chip .hint{color:var(--muted);font-size:12px;white-space:nowrap}

    .btn{
      border:1px solid var(--border);
      background:rgba(255,255,255,.04);
      color:var(--text);
      padding:9px 10px;
      border-radius:12px;
      cursor:pointer;
      display:inline-flex; align-items:center; gap:8px;
      transition: transform .06s ease, background .15s ease, border-color .15s ease, opacity .15s ease;
      user-select:none;
      white-space:nowrap;
    }
    .btn:hover{background:rgba(255,255,255,.06)}
    .btn:active{transform: translateY(1px)}
    .btn.primary{
      border-color: rgba(78,161,255,.45);
      background: linear-gradient(135deg, rgba(78,161,255,.20), rgba(110,231,255,.10));
    }

    .card{
      background: rgba(255,255,255,.03);
      border:1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .card .hd{
      padding:12px 14px;
      border-bottom:1px solid var(--border);
      display:flex; align-items:center; justify-content:space-between; gap:10px;
    }
    .card .bd{padding:14px}
    .kicker{font-size:12px;color:var(--muted)}
    label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}

    input{
      width:100%;
      padding:10px 10px;
      border-radius:12px;
      border:1px solid var(--border);
      background: rgba(0,0,0,.18);
      color: var(--text);
      outline:none;
      appearance:none;
      -webkit-appearance:none;
    }
    input:focus{
      background: rgba(0,0,0,.26);
      border-color: rgba(78,161,255,.45);
      box-shadow: 0 0 0 3px rgba(78,161,255,.12);
    }

    .hintRow{color:var(--muted);font-size:12px;margin-top:10px}
    .toast{margin-top:10px;font-size:12px;color:var(--muted)}

    /* Date controls (no arrows, no reset) */
    .dateRow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .dateBtn{
      border:1px solid var(--border);
      background: var(--chipBg);
      color: var(--text);
      padding:8px 10px;
      border-radius:12px;
      cursor:pointer;
      display:inline-flex;
      align-items:center;
      gap:8px;
      min-height:38px;
    }
    .dateBtn .lab{color:var(--muted); font-size:12px}
    .dateBtn .val{font-weight:700; font-size:13px}
    .dateBtn:hover{filter: brightness(1.05)}
    .dateHidden{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}

    /* Controls */
    .controlsRow{
      display:flex;
      gap:10px;
      align-items:flex-end;
      flex-wrap:wrap;
      margin-top:12px;
    }
    .toggleWrap{
      display:flex;
      border:1px solid var(--border);
      border-radius:12px;
      overflow:hidden;
      background: rgba(255,255,255,.02);
      height:38px;
    }
    .toggleBtn{
      border:none;
      background: var(--toggleOff);
      color: var(--text);
      padding:0 12px;
      cursor:pointer;
      font-weight:800;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      transition: background .15s ease, opacity .15s ease;
      min-width:72px;
    }
    .toggleBtn:hover{opacity:.95}
    .toggleBtn.active{ background: var(--toggleOn); }
    .toggleBtn + .toggleBtn{ border-left:1px solid var(--border); }

    .controlsButtons{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .searchWrap{flex:1 1 260px;min-width:220px}

    /* Table */
    .tableWrap{max-height:560px;overflow:auto}
    table{width:100%;border-collapse:separate;border-spacing:0;font-size:16px;line-height:1.25}
    thead th{
      text-align:left;
      color:var(--muted);
      font-weight:700;
      padding:12px 12px;
      border-bottom:1px solid var(--border);
      background: rgba(255,255,255,.02);
      position:sticky; top:0;
      backdrop-filter: blur(8px);
      z-index:1;
      font-size:14px;
    }
    tbody td{padding:12px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
    tbody tr:hover{background: rgba(255,255,255,.03)}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace}
    .right{text-align:right}
    .rank{font-weight:900;width:70px}
    .link{color: var(--accent); text-decoration:none}
    .link:hover{text-decoration:underline}
    td.l10, td.l20{font-size:20px;font-weight:700}

    .walletCell{display:flex;align-items:center;gap:10px;min-width:0}
    .walletCell a{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .copyBtn{
      flex:0 0 auto;
      border:1px solid var(--border);
      background: rgba(255,255,255,.04);
      color: var(--text);
      border-radius:10px;
      padding:6px 10px;
      cursor:pointer;
      font-size:12px;
      line-height:1;
      user-select:none;
      transition: background .15s ease, opacity .15s ease;
    }
    .copyBtn:hover{background: rgba(255,255,255,.06)}
    .copyBtn.copied{opacity:.95;border-color: rgba(78,161,255,.45)}

    .hdActions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}

    /* ✅ right tile aligns vertically with filters and same width; height = filters */
    .sideTile{
      width: 280px;
      border:1px dashed rgba(255,255,255,.18);
      background: rgba(255,255,255,.02);
      border-radius: var(--radius);
      box-shadow: 0 10px 26px rgba(0,0,0,.18);
      height: var(--filtersH, 240px);
    }
    .sideTile .hd{
      padding:12px 14px;
      border-bottom:1px dashed rgba(255,255,255,.16);
      color: var(--muted);
      font-weight:700;
      font-size:12px;
    }
    .sideTile .bd{padding:14px;color: var(--muted);font-size:12px}

    /* Modal */
    .modalBackdrop{
      position:fixed;inset:0;background: rgba(0,0,0,.55);
      display:none;align-items:center;justify-content:center;padding:16px;z-index:1000;
    }
    .modalBackdrop.show{display:flex;}
    .modal{
      width:min(720px, 100%);
      background:#ffffff;color:#0b1220;border-radius:16px;
      box-shadow: 0 18px 60px rgba(0,0,0,.45);
      overflow:hidden;border:1px solid rgba(10,20,40,.12);
    }
    .modalHd{
      padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;
      border-bottom:1px solid rgba(10,20,40,.12);background:#f7f9ff;
    }
    .modalTitle{font-weight:900}
    .modalBd{padding:14px}
    .modalNote{font-size:12px;color:#445472;margin:0 0 10px 0}
    .walletList{
      width:100%;min-height:240px;max-height:50vh;resize:vertical;
      padding:12px;border-radius:12px;border:1px solid rgba(10,20,40,.18);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size:13px;line-height:1.35;outline:none;background:#ffffff;color:#0b1220;
    }
    .modalBtns{display:flex;gap:10px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}
    .modalBtn{
      border:1px solid rgba(10,20,40,.18);
      background:#ffffff;color:#0b1220;padding:9px 10px;border-radius:12px;cursor:pointer;font-weight:800;
    }
    .modalBtn.primary{
      border-color: rgba(29,78,216,.25);
      background: linear-gradient(135deg, rgba(29,78,216,.10), rgba(14,165,233,.08));
    }

    /* Responsive */
    @media (max-width: 1200px){
      .mainNarrow, .headerInner{width: 78%;}
    }
    @media (max-width: 1100px){
      .page{grid-template-columns: minmax(0,1fr) 240px;}
      .sideTile{width:240px;}
      .mainNarrow, .headerInner{width: 88%;}
    }
    @media (max-width: 980px){
      .wrap{padding:14px}
      .page{grid-template-columns: 1fr;}
      .mainNarrow, .headerInner{width:100%;}
      .sideTile{height:auto; min-height:160px;}
      header{flex-direction:column;align-items:stretch;gap:12px}
    }
    @media (max-width: 520px){
      .wrap{padding:12px}
      h1{font-size:17px}
      .dateRow{gap:8px}
      .dateBtn{flex:1 1 auto;justify-content:space-between;min-width:0}
      .controlsRow{flex-direction:column;align-items:stretch}
      .controlsButtons{justify-content:flex-start}
      .searchWrap{min-width:0;width:100%}
      .toggleWrap{width:100%}
      .toggleBtn{flex:1 1 0}
      table{font-size:15px}
      thead th{font-size:13px;padding:10px 10px}
      tbody td{padding:10px 10px}
      .rank{width:56px}
      .tableWrap{max-height:65vh}
      td.l10, td.l20{font-size:19px}
    }
  </style>
</head>

<body>
<div class="wrap" id="app">
  <div class="page">
    <!-- MAIN COLUMN -->
    <div>
      <!-- ✅ centered header block -->
      <div class="headerInner">
        <header>
          <div>
            <h1>DFK Tournament Leaderboard</h1>
            <div class="sub" id="subline">Loading…</div>

            <div class="clocksRow" title="All weekly presets and date ranges are interpreted in UTC">
              <div class="chip">
                <span class="k">UTC time:</span>
                <span class="v" id="utcNow">—</span>
                <span class="hint">(UTC)</span>
              </div>

              <div class="chip secondary">
                <span class="k">Daily rollover:</span>
                <span class="v" id="utcCountdown">—</span>
                <span class="hint">(next 00:00 UTC)</span>
              </div>
            </div>
          </div>
          <div></div>
        </header>
      </div>

      <div class="mainNarrow">
        <!-- Filters -->
        <section class="card" id="filtersCard">
          <div class="hd"><div></div><div></div></div>
          <div class="bd">
            <div class="dateRow">
              <button class="dateBtn" id="fromBtn" type="button" title="Pick From date (UTC)">
                <span class="lab">From</span>
                <span class="val" id="fromLabel">—</span>
              </button>

              <button class="dateBtn" id="toBtn" type="button" title="Pick To date (UTC)">
                <span class="lab">To</span>
                <span class="val" id="toLabel">—</span>
              </button>

              <button class="btn" id="thisWeekBtn" type="button">This week</button>
              <button class="btn" id="lastWeekBtn" type="button">Last week</button>
            </div>

            <input class="dateHidden" id="fromDate" type="date" />
            <input class="dateHidden" id="toDate" type="date" />

            <div class="controlsRow">
              <div>
                <div class="toggleWrap" role="group" aria-label="Sort by tier">
                  <button class="toggleBtn active" id="sort10Btn" type="button" aria-pressed="true">10s</button>
                  <button class="toggleBtn" id="sort20Btn" type="button" aria-pressed="false">20s</button>
                </div>
              </div>

              <div class="searchWrap">
                <!-- ✅ removed outside label text; only placeholder remains -->
                <input id="search" placeholder="Search by 0x…" />
              </div>
            </div>

            <div class="hintRow">
              Weeks are exact UTC weeks: Monday 00:00 → next Monday 00:00.
            </div>
            <div class="toast" id="toast"></div>
          </div>
        </section>

        <!-- Leaderboard -->
        <section class="card" style="margin-top:14px">
          <div class="hd">
            <div>
              <div class="kicker">Leaderboard</div>
              <div style="font-weight:700">Lvl 10 vs Lvl 20 wins</div>
            </div>

            <div class="hdActions">
              <button class="btn" id="walletsBtn" type="button" title="Show wallets">
                <span id="walletsBtnText">— wallets</span>
              </button>
              <button class="btn primary" id="csvBtn" type="button">
                <span>⬇️</span> Export CSV
              </button>
            </div>
          </div>

          <div class="tableWrap">
            <table>
              <thead>
                <tr>
                  <th class="rank">Rank</th>
                  <th>Wallet</th>
                  <th class="right">Lvl 10</th>
                  <th class="right">Lvl 20</th>
                  <th class="right">Total</th>
                </tr>
              </thead>
              <tbody id="tbody">
                <tr><td colspan="5" style="padding:14px;color:var(--muted)">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>

    <!-- ✅ empty tile aligned with filters and same height as filters -->
    <aside class="sideTile" id="sideTile" aria-label="Empty tile">
      <div class="hd">Empty tile</div>
      <div class="bd">Reserved space for something later.</div>
    </aside>
  </div>
</div>

<!-- Wallets Modal -->
<div class="modalBackdrop" id="modalBackdrop" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="walletModalTitle">
    <div class="modalHd">
      <div class="modalTitle" id="walletModalTitle">Wallets (copy-friendly)</div>
      <button class="modalBtn" id="modalCloseBtn" type="button">Close</button>
    </div>
    <div class="modalBd">
      <p class="modalNote">
        One wallet per line. Click inside, Ctrl+A, then copy. Or use the buttons below.
      </p>
      <textarea class="walletList" id="walletsText" readonly></textarea>
      <div class="modalBtns">
        <button class="modalBtn" id="modalCopyBtn" type="button">Copy all</button>
        <button class="modalBtn primary" id="modalCopySortedBtn" type="button">Copy sorted wallets</button>
      </div>
      <div class="modalNote" id="modalStatus" style="margin-top:10px"></div>
    </div>
  </div>
</div>

<script>
  const $ = (id) => document.getElementById(id);

  const state = {
    wins: [],
    filtered: [],
    range: { fromMs: null, toMs: null }, // UTC ms [from, to)
    searchTimer: null,
    sortMode: "10s", // "10s" or "20s"
  };

  function toast(msg){ $("toast").textContent = msg || ""; }
  function pad(n){ return String(n).padStart(2,"0"); }

  function toIsoDateUtc(ms){
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  }

  function fromIsoDateUtc(iso){
    if (!iso) return null;
    const [y,m,d] = iso.split("-").map(Number);
    if (![y,m,d].every(Number.isFinite)) return null;
    return Date.UTC(y, m-1, d, 0,0,0,0);
  }

  function formatPrettyUtc(ms){
    if (ms == null) return "—";
    const d = new Date(ms);
    const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    const day = d.getUTCDate();
    const year = String(d.getUTCFullYear()).slice(-2);
    return `${month} ${day}, ${year}`;
  }

  function startOfUtcWeekMonday(ms){
    const d = new Date(ms);
    const day = d.getUTCDay(); // 0 Sun ... 6 Sat
    const diffToMonday = (day === 0 ? -6 : (1 - day));
    const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0,0,0,0));
    base.setUTCDate(base.getUTCDate() + diffToMonday);
    return base.getTime();
  }

  function updateDateLabels(){
    $("fromLabel").textContent = formatPrettyUtc(state.range.fromMs);
    $("toLabel").textContent = formatPrettyUtc(state.range.toMs);
  }

  function setRange(fromMs, toMs){
    state.range.fromMs = fromMs;
    state.range.toMs = toMs;

    $("fromDate").value = fromMs != null ? toIsoDateUtc(fromMs) : "";
    $("toDate").value = toMs != null ? toIsoDateUtc(toMs) : "";

    updateDateLabels();
  }

  function setThisWeek(){
    const now = Date.now();
    const mon = startOfUtcWeekMonday(now);
    const nextMon = mon + 7*86400000;
    setRange(mon, nextMon);
  }

  function setLastWeek(){
    const now = Date.now();
    const thisMon = startOfUtcWeekMonday(now);
    const lastMon = thisMon - 7*86400000;
    setRange(lastMon, thisMon);
  }

  function shortWallet(addr){
    if (!addr || addr.length < 12) return addr || "";
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  function aggregateWins(wins, fromMs, toMs){
    const by = new Map();
    for (const w of wins){
      const tMs = w.timestamp * 1000;
      if (fromMs != null && tMs < fromMs) continue;
      if (toMs != null && tMs >= toMs) continue;

      const cur = by.get(w.wallet) || { wallet: w.wallet, lvl10Wins:0, lvl20Wins:0, total:0 };
      if (w.tier === 10) cur.lvl10Wins++;
      else if (w.tier === 20) cur.lvl20Wins++;
      cur.total++;
      by.set(w.wallet, cur);
    }
    return { rows: [...by.values()] };
  }

  function sortRows(rows){
    const mode = state.sortMode;
    const cmp =
      mode === "20s"
        ? (a,b)=> (b.lvl20Wins - a.lvl20Wins) || (b.total - a.total) || a.wallet.localeCompare(b.wallet)
        : (a,b)=> (b.lvl10Wins - a.lvl10Wins) || (b.total - a.total) || a.wallet.localeCompare(b.wallet);
    return rows.sort(cmp);
  }

  async function copyToClipboard(text){
    try{
      await navigator.clipboard.writeText(text);
      return true;
    }catch{
      try{
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      }catch{
        return false;
      }
    }
  }

  function renderTable(rows){
    const tb = $("tbody");
    if (!rows.length){
      tb.innerHTML = `<tr><td colspan="5" style="padding:14px;color:var(--muted)">No results for this range.</td></tr>`;
      return;
    }

    tb.innerHTML = rows.map(r => `
      <tr>
        <td class="rank">${r.rank}</td>
        <td class="mono">
          <div class="walletCell">
            <a class="link" href="https://andromeda-explorer.metis.io/address/${r.wallet}" target="_blank" rel="noreferrer">${shortWallet(r.wallet)}</a>
            <button class="copyBtn" type="button" data-copy="${r.wallet}" title="Copy wallet">Copy</button>
          </div>
        </td>
        <td class="right l10">${r.lvl10Wins.toLocaleString()}</td>
        <td class="right l20">${r.lvl20Wins.toLocaleString()}</td>
        <td class="right"><b>${r.total.toLocaleString()}</b></td>
      </tr>
    `).join("");

    tb.querySelectorAll(".copyBtn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const wallet = btn.getAttribute("data-copy");
        const ok = await copyToClipboard(wallet);
        if (!ok) { toast("Copy failed (browser blocked clipboard)."); return; }
        btn.classList.add("copied");
        const prev = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove("copied");
        }, 1200);
      });
    });
  }

  function updateWalletsButton(count){
    $("walletsBtnText").textContent = `${count.toLocaleString()} wallets`;
  }

  function setToggleUI(){
    const is10 = state.sortMode === "10s";
    $("sort10Btn").classList.toggle("active", is10);
    $("sort10Btn").setAttribute("aria-pressed", String(is10));
    $("sort20Btn").classList.toggle("active", !is10);
    $("sort20Btn").setAttribute("aria-pressed", String(!is10));
  }

  function apply(){
    const search = ($("search").value || "").trim().toLowerCase();
    const fromMs = state.range.fromMs;
    const toMs = state.range.toMs;

    const agg = aggregateWins(state.wins, fromMs, toMs);
    let rows = agg.rows;

    if (search) rows = rows.filter(r => r.wallet.includes(search));
    sortRows(rows);

    const ranked = rows.map((r, i)=> ({ rank: i+1, ...r }));
    state.filtered = ranked;

    updateWalletsButton(ranked.length);
    renderTable(ranked);
    toast("");
  }

  function exportCsv(){
    const rows = state.filtered;
    if (!rows.length){
      toast("Nothing to export (no filtered rows).");
      return;
    }
    const header = ["rank","wallet","lvl10Wins","lvl20Wins","totalWins"];
    const lines = [header.join(",")];
    for (const r of rows){
      lines.push([r.rank, r.wallet, r.lvl10Wins, r.lvl20Wins, r.total].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dfk-leaderboard.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Exported CSV.");
  }

  function fmtCountdown(ms){
    const total = Math.max(0, Math.floor(ms / 1000));
    const hh = String(Math.floor(total / 3600)).padStart(2,"0");
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2,"0");
    const ss = String(total % 60).padStart(2,"0");
    return `${hh}:${mm}:${ss}`;
  }

  function setUtcWidgets(){
    const now = new Date();
    const clock = now.toISOString().replace("T"," ").slice(0,19) + "Z";
    $("utcNow").textContent = clock;

    const nextMidnightUtcMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,0,0,0
    );
    $("utcCountdown").textContent = fmtCountdown(nextMidnightUtcMs - now.getTime());
  }

  // Modal
  function openWalletsModal(){
    const wallets = state.filtered.map(r => r.wallet);
    $("walletsText").value = wallets.join("\n");
    $("modalStatus").textContent = "";
    $("modalBackdrop").classList.add("show");
    $("modalBackdrop").setAttribute("aria-hidden","false");
    setTimeout(() => $("walletsText").focus(), 0);
  }
  function closeWalletsModal(){
    $("modalBackdrop").classList.remove("show");
    $("modalBackdrop").setAttribute("aria-hidden","true");
  }
  async function modalCopyAll(){
    const text = $("walletsText").value || "";
    const ok = await navigator.clipboard.writeText(text).then(()=>true).catch(()=>false);
    $("modalStatus").textContent = ok ? "Copied all wallets to clipboard." : "Copy failed (browser blocked clipboard).";
  }
  async function modalCopySortedOnly(){
    const text = state.filtered.map(r => r.wallet).join("\n");
    const ok = await navigator.clipboard.writeText(text).then(()=>true).catch(()=>false);
    $("modalStatus").textContent = ok ? "Copied sorted wallets to clipboard." : "Copy failed (browser blocked clipboard).";
  }

  function sizeSideTileToFilters(){
    const filters = $("filtersCard");
    const side = $("sideTile");
    if (!filters || !side) return;

    // avoid doing this on mobile single-column
    const isSingleColumn = window.matchMedia("(max-width: 980px)").matches;
    if (isSingleColumn){
      side.style.height = "auto";
      return;
    }

    const rect = filters.getBoundingClientRect();
    // set CSS var on the element so it stays consistent
    side.style.setProperty("--filtersH", Math.round(rect.height) + "px");
  }

  async function load(){
    try{
      const res = await fetch("./leaderboard.json", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load leaderboard.json");
      const json = await res.json();

      const wins = Array.isArray(json.wins) ? json.wins : [];
      state.wins = wins
        .map(w => ({
          wallet: (w.wallet || "").toLowerCase(),
          timestamp: Number(w.timestamp),
          tier: w.tier === 10 ? 10 : (w.tier === 20 ? 20 : null)
        }))
        .filter(w => w.wallet && Number.isFinite(w.timestamp));

      $("subline").textContent = `Wins loaded: ${state.wins.length.toLocaleString()} • Sorted by ${state.sortMode}`;

      setLastWeek();
      setToggleUI();
      apply();

      // after render, align side tile height
      requestAnimationFrame(() => {
        sizeSideTileToFilters();
      });
    } catch (e){
      $("tbody").innerHTML =
        `<tr><td colspan="5" style="padding:14px;color:var(--bad)">Error loading data: ${String(e.message || e)}</td></tr>`;
      $("subline").textContent = "Failed to load leaderboard.json";
      requestAnimationFrame(() => sizeSideTileToFilters());
    }
  }

  // Wire up
  $("csvBtn").addEventListener("click", exportCsv);
  $("walletsBtn").addEventListener("click", openWalletsModal);

  $("modalCloseBtn").addEventListener("click", closeWalletsModal);
  $("modalBackdrop").addEventListener("click", (e) => { if (e.target === $("modalBackdrop")) closeWalletsModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("modalBackdrop").classList.contains("show")) closeWalletsModal(); });
  $("modalCopyBtn").addEventListener("click", modalCopyAll);
  $("modalCopySortedBtn").addEventListener("click", modalCopySortedOnly);

  $("thisWeekBtn").addEventListener("click", () => { setThisWeek(); apply(); sizeSideTileToFilters(); });
  $("lastWeekBtn").addEventListener("click", () => { setLastWeek(); apply(); sizeSideTileToFilters(); });

  $("fromBtn").addEventListener("click", () => openDatePicker("fromDate"));
  $("toBtn").addEventListener("click", () => openDatePicker("toDate"));

  function openDatePicker(inputId){
    const el = $(inputId);
    try{
      if (el.showPicker) el.showPicker();
      else { el.focus(); el.click(); }
    }catch{
      el.focus();
      el.click();
    }
  }

  $("fromDate").addEventListener("change", () => {
    const fMs = fromIsoDateUtc($("fromDate").value);
    setRange(fMs, state.range.toMs);
    apply();
    sizeSideTileToFilters();
  });

  $("toDate").addEventListener("change", () => {
    const tMs = fromIsoDateUtc($("toDate").value);
    setRange(state.range.fromMs, tMs);
    apply();
    sizeSideTileToFilters();
  });

  $("search").addEventListener("input", () => {
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => { apply(); }, 120);
  });
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (state.searchTimer) clearTimeout(state.searchTimer);
      apply();
    }
  });

  $("sort10Btn").addEventListener("click", () => {
    state.sortMode = "10s";
    setToggleUI();
    $("subline").textContent = `Wins loaded: ${state.wins.length.toLocaleString()} • Sorted by ${state.sortMode}`;
    apply();
  });
  $("sort20Btn").addEventListener("click", () => {
    state.sortMode = "20s";
    setToggleUI();
    $("subline").textContent = `Wins loaded: ${state.wins.length.toLocaleString()} • Sorted by ${state.sortMode}`;
    apply();
  });

  function setToggleUI(){
    const is10 = state.sortMode === "10s";
    $("sort10Btn").classList.toggle("active", is10);
    $("sort10Btn").setAttribute("aria-pressed", String(is10));
    $("sort20Btn").classList.toggle("active", !is10);
    $("sort20Btn").setAttribute("aria-pressed", String(!is10));
  }

  // keep side tile aligned on resize
  window.addEventListener("resize", () => sizeSideTileToFilters());

  // Init
  setToggleUI();
  setUtcWidgets();
  setInterval(setUtcWidgets, 1000);
  load();
</script>
</body>
</html>