(async function () {
  const $ = id => document.getElementById(id);
  const KEY = "busapp-kinasa-v1";
  const [KIN, AEON, SUN] = await Promise.all([
    fetch("data/kinasa.json").then(r => r.json()),
    fetch("data/aeon.json").then(r => r.json()),
    fetch("data/sunmarine.json").then(r => r.json()),
  ]);
  const STOPS = KIN.down.map(s => s[0]);
  const T = { down: Object.fromEntries(KIN.down), up: Object.fromEntries(KIN.up) };
  const pretty = n => n.replace("旅の駅鬼無里", "旅の駅 鬼無里");
  const LINES = {
    kinasa: { name: "鬼無里線", note: "時刻は長野市営バス鬼無里線の時刻表（2026年4月1日制定・素案）の通過予定時刻です。道路状況で遅れることがあります。" },
    aeon: { name: "イオンモール須坂", note: "発車時刻は長電バス路線82の時刻表（2025年9月26日〜・平日ダイヤ）です。時刻表に到着時刻はないので、到着は上の「到着までの時間」から計算した目安です。" },
    sunmarine: { name: "サンマリーンクリニック", note: "時刻は日赤線ほかの時刻表（2025年12月6日改正・平日用）の通過予定時刻です。長野駅と松岡南の両方に止まる便だけを、路線をまとめて時刻順に並べています。" },
  };
  // Fixed-route lines: each route lists trips; arrival is either given or estimated from st.dur.
  const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const sortTrips = list => list.slice().sort((x, y) => toMin(x.dep) - toMin(y.dep));
  const FIXED = {
    aeon: [AEON.out, AEON.back].map(r => ({ ...r, est: true, trips: r.weekday.map(s => {
      const dep = s.match(/^\d{1,2}:\d{2}/)[0], mk = s.slice(dep.length);
      return { dep, note: mk ? r.marks[mk] : "" };
    }) })),
    sunmarine: SUN.routes.map(r => ({ ...r, trips: sortTrips(r.trips).map(t => ({ ...t, note: t.line })) })),
  };

  // ---- state (per device) ----
  let st = { routes: [], cur: 0, alarm: 0, mode: "sc", line: "kinasa", aeonCur: 0, curBy: {}, dur: 40 };
  try { Object.assign(st, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };
  let day = new Date(); day.setHours(0, 0, 0, 0);
  const added = new Set();

  // ---- helpers ----
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const mins = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const hm = n => `${Math.floor(n / 60)}:${pad(n % 60)}`;
  const at = (d, t) => { const [h, m] = t.split(":").map(Number); return new Date(`${ymd(d)}T${pad(h)}:${pad(m)}:00+09:00`); };
  const utc = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = s => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
  function fold(line) { // RFC 5545: max 75 octets per line
    const enc = new TextEncoder(); const out = []; let cur = "", len = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (len + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; len = 0; }
      cur += ch; len += b;
    }
    out.push(cur); return out.join("\r\n ");
  }

  // ---- Japanese public holidays (for the weekday-only warning) ----
  const hcache = {};
  function holidays(y) {
    if (hcache[y]) return hcache[y];
    const set = new Set();
    const add = (m, d) => set.add(`${m}-${d}`);
    [[1, 1], [2, 11], [2, 23], [4, 29], [5, 3], [5, 4], [5, 5], [8, 11], [11, 3], [11, 23]].forEach(([m, d]) => add(m, d));
    const nthMon = (m, n) => { const f = new Date(y, m - 1, 1).getDay(); return 1 + ((8 - f) % 7) + 7 * (n - 1); };
    add(1, nthMon(1, 2)); add(7, nthMon(7, 3)); add(9, nthMon(9, 3)); add(10, nthMon(10, 2));
    const k = y - 1980, q = Math.floor(k / 4);
    add(3, Math.floor(20.8431 + 0.242194 * k - q)); add(9, Math.floor(23.2488 + 0.242194 * k - q));
    const is = d => set.has(`${d.getMonth() + 1}-${d.getDate()}`);
    for (let d = new Date(y, 0, 1); d.getFullYear() === y; d.setDate(d.getDate() + 1)) {
      const prev = new Date(d), next = new Date(d); prev.setDate(d.getDate() - 1); next.setDate(d.getDate() + 1);
      if (!is(d) && d.getDay() !== 0 && is(prev) && is(next) && prev.getFullYear() === y) add(d.getMonth() + 1, d.getDate()); // 国民の休日
    }
    for (let d = new Date(y, 0, 1); d.getFullYear() === y; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0 && is(d)) { // 振替休日
        const s = new Date(d); do { s.setDate(s.getDate() + 1); } while (is(s));
        if (s.getFullYear() === y) add(s.getMonth() + 1, s.getDate());
      }
    }
    return (hcache[y] = set);
  }
  function nonWeekday(d) {
    const m = d.getMonth() + 1, dd = d.getDate();
    if (d.getDay() === 0 || d.getDay() === 6) return "土日";
    if (holidays(d.getFullYear()).has(`${m}-${dd}`)) return "祝日";
    if (st.line !== "kinasa" && ((m === 8 && dd >= 13 && dd <= 16) || (m === 12 && dd >= 29) || (m === 1 && dd <= 3))) return "お盆・年末年始";
    return "";
  }

  // ---- routes & trips per line ----
  const isAeon = () => st.line === "aeon";
  const fixed = () => st.line in FIXED;
  if (!LINES[st.line]) st.line = "kinasa";
  if (!st.curBy) st.curBy = {};
  if (st.curBy.aeon == null) st.curBy.aeon = st.aeonCur || 0;
  const routes = () => fixed() ? FIXED[st.line] : st.routes;
  const curIdx = () => fixed() ? (st.curBy[st.line] || 0) : st.cur;
  const setCur = i => { if (fixed()) st.curBy[st.line] = i; else st.cur = i; };
  const dirOf = r => STOPS.indexOf(r.from) < STOPS.indexOf(r.to) ? "down" : "up";
  const routeLabel = r => fixed() ? r.stop : dirOf(r) === "down" ? "鬼無里方面" : "長野方面";
  function trips(r) {
    if (!fixed()) { const d = dirOf(r); return T[d][r.from].map((t, i) => ({ dep: t, arr: T[d][r.to][i] })); }
    const dur = Math.max(5, Number(st.dur) || 40);
    return r.trips.map(t => r.est ? { ...t, arr: hm(mins(t.dep) + dur), est: true } : t);
  }
  const short = n => fixed() ? n.replace("（東口）", "").replace("イオンモール須坂", "イオン須坂").replace("（善光寺口）", "") : pretty(n);
  const titleOf = (r, t) => `🚌 ${t.dep} ${pretty(r.from)} → ${t.arr} ${pretty(r.to)}${t.line ? `（${t.line.split(" ")[0]}）` : ""}`;

  function buildICS(r, t) {
    const start = at(day, t.dep), end = at(day, t.arr);
    const L = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//bus-app//kinasa//JA", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${st.line}-${utc(start)}-${curIdx()}-${encodeURIComponent(r.from).length}@bus-app`,
      `DTSTAMP:${utc(new Date())}`,
      `DTSTART:${utc(start)}`, `DTEND:${utc(end)}`,
      `SUMMARY:${esc(titleOf(r, t))}`,
      `LOCATION:${esc(`${pretty(r.from)}（バス停）`)}`,
      `DESCRIPTION:${esc(isAeon() ? `長電バス 路線82 ${r.stop}${t.note ? "・" + t.note : ""}（到着は目安）` : fixed() ? `${LINES[st.line].name}へ ${r.stop}${t.note ? "・" + t.note : ""}` : `長野市営バス 鬼無里線 ${routeLabel(r)}`)}`,
    ];
    if (st.alarm > 0) L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:バスの時間です", `TRIGGER:-PT${st.alarm}M`, "END:VALARM");
    L.push("END:VEVENT", "END:VCALENDAR");
    return L.map(fold).join("\r\n") + "\r\n";
  }

  function toast(msg) {
    const el = $("toast"); el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ---- render ----
  function renderTop() {
    document.querySelectorAll("#lines button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.l === st.line)));
    $("badge").textContent = LINES[st.line].name;
    $("srcNote").textContent = LINES[st.line].note;
    $("durBox").hidden = !isAeon();
    $("dur").value = String(st.dur);
    if (fixed()) $("editor").hidden = true;
  }

  function renderDays() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 864e5);
    document.querySelectorAll("#days button").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.d) === diff)));
    $("date").value = ymd(day);
    const why = nonWeekday(day);
    $("weekend").hidden = !why;
    $("weekend").textContent = why ? `この日は${why}です。${LINES[st.line].name}のバスは平日の時刻だけ入れているので、時刻表で確認してください。` : "";
  }

  function renderRoutes() {
    const box = $("routes");
    box.innerHTML = routes().map((r, i) =>
      `<button type="button" data-i="${i}" aria-pressed="${i === curIdx()}">${short(r.from)} → ${short(r.to)}</button>`
    ).join("") + (fixed() ? "" : `<button type="button" class="addr" id="openEditor">＋ 区間を登録</button>`);
    $("del").hidden = fixed() || !st.routes.length;
  }

  function renderTrips() {
    const ul = $("trips"), r = routes()[curIdx()];
    if (!r) {
      $("tripsLabel").textContent = "便";
      ul.innerHTML = `<li class="muted">まず「＋ 区間を登録」で、乗るバス停と降りるバス停を選んでください。</li>`;
      return;
    }
    $("tripsLabel").textContent = `便（${routeLabel(r)}・${day.getMonth() + 1}/${day.getDate()}）`;
    const now = new Date();
    let nextMarked = false;
    ul.innerHTML = trips(r).map((t, i) => {
      const past = at(day, t.dep) < now;
      const isNext = !past && !nextMarked; if (isNext) nextMarked = true;
      const key = `${st.line}|${ymd(day)}|${curIdx()}|${i}`;
      const meta = t.est
        ? `${pretty(r.from)} 発・到着は目安${t.note ? "・" + t.note : ""}`
        : `${pretty(r.from)} 発・約${mins(t.arr) - mins(t.dep)}分${t.note ? "・" + t.note : ""}`;
      return `<li class="trip${past ? " past" : ""}">
        <div class="t">
          <span class="times">${t.dep}<span class="arr"> → ${t.est ? "約" : ""}${t.arr}</span></span>
          <span class="meta">${meta}${isNext ? '<span class="next">次の便</span>' : ""}</span>
        </div>
        <button type="button" class="go${added.has(key) ? " done" : ""}" data-i="${i}">${added.has(key) ? "追加済み" : st.mode === "sc" ? "移動に追加" : "カレンダーに追加"}</button>
      </li>`;
    }).join("");
  }

  const render = () => {
    renderTop(); renderDays(); renderRoutes(); renderTrips();
    $("alarm").value = String(st.alarm); $("mode").value = st.mode; $("setup").hidden = st.mode !== "sc";
  };

  // ---- line switch ----
  $("lines").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    st.line = b.dataset.l; save(); render();
    if (!fixed() && !st.routes.length) openEditor();
  });
  $("dur").addEventListener("change", e => {
    const v = Math.round(Number(e.target.value));
    if (v >= 5 && v <= 120) { st.dur = v; save(); }
    render();
  });

  // ---- editor (鬼無里線) ----
  const fill = (sel, v) => { sel.innerHTML = STOPS.map(s => `<option value="${s}">${pretty(s)}</option>`).join(""); sel.value = v; };
  fill($("from"), "長野駅"); fill($("to"), "鬼無里支所");
  const openEditor = () => { $("editor").hidden = false; $("msg").textContent = ""; $("from").focus(); };

  $("routes").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "openEditor") return openEditor();
    setCur(Number(b.dataset.i)); save(); render();
  });
  $("swap").addEventListener("click", () => { const f = $("from").value; $("from").value = $("to").value; $("to").value = f; });
  $("cancel").addEventListener("click", () => { $("editor").hidden = true; });
  $("save").addEventListener("click", () => {
    const from = $("from").value, to = $("to").value;
    if (from === to) { $("msg").textContent = "乗るバス停と降りるバス停が同じです。"; return; }
    const has = (f, t) => st.routes.findIndex(r => r.from === f && r.to === t);
    if (has(from, to) < 0) st.routes.push({ from, to });
    if ($("ret").checked && has(to, from) < 0) st.routes.push({ from: to, to: from });
    st.cur = has(from, to); save();
    $("editor").hidden = true; render();
  });
  $("del").addEventListener("click", () => {
    const b = $("del");
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "もう一度タップで削除"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "この区間を削除"; }, 3000); return; }
    st.routes.splice(st.cur, 1); st.cur = 0; b.dataset.armed = ""; b.textContent = "この区間を削除"; save(); render();
  });

  // ---- date & alarm ----
  $("days").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() + Number(b.dataset.d)); render();
  });
  $("date").addEventListener("change", e => {
    if (!e.target.value) return;
    const [y, m, d] = e.target.value.split("-").map(Number); day = new Date(y, m - 1, d); render();
  });
  $("alarm").addEventListener("change", e => { st.alarm = Number(e.target.value); save(); });
  $("mode").addEventListener("change", e => { st.mode = e.target.value; save(); render(); if (st.mode === "sc") $("setup").open = true; });

  // ---- add to calendar ----
  $("trips").addEventListener("click", e => {
    const b = e.target.closest(".go"); if (!b) return;
    const r = routes()[curIdx()], i = Number(b.dataset.i), t = trips(r)[i];
    added.add(`${st.line}|${ymd(day)}|${curIdx()}|${i}`);
    if (st.mode === "sc") {
      // Hand the event to the user's "バス移動" shortcut, which adds it to the 移動 calendar, then come back here.
      const iso = tm => { const [h, m] = tm.split(":").map(Number); return `${ymd(day)}T${pad(h)}:${pad(m)}:00+09:00`; };
      const payload = JSON.stringify({ title: titleOf(r, t), start: iso(t.dep), end: iso(t.arr) });
      window.__lastPayload = payload;
      const back = location.href.split("#")[0];
      renderTrips();
      toast("ショートカットを開いて「移動」に追加します");
      location.href = "shortcuts://x-callback-url/run-shortcut?name=" + encodeURIComponent("バス移動")
        + "&input=text&text=" + encodeURIComponent(payload) + "&x-success=" + encodeURIComponent(back);
      return;
    }
    const ics = buildICS(r, t);
    window.__lastICS = ics;
    // iOS Safari blocks top-level data: URLs, so hand it a Blob with the calendar type instead.
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    renderTrips();
    toast("予定の画面が出たら「追加」をタップしてください");
  });

  if (!fixed() && !st.routes.length) openEditor();
  render();
})();
