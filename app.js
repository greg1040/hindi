/* Hindi flashcards — vanilla JS, localStorage spaced repetition. */
(function () {
  "use strict";
  const DATA = window.HINDI_DATA || { decks: [] };
  const DAY = 86400000;
  const LADDER = [1, 3, 7, 14, 30, 60]; // days between reviews after each "Got it"
  const NEW_PER_SESSION = 20;
  const KEY = "hindiCards.v1";
  const $app = document.getElementById("app");
  const player = document.getElementById("player");

  // ---------- storage ----------
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { S = {}; }
  S.cards = S.cards || {};
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };
  const now = () => Date.now();
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  const allCards = [];
  const byId = {};
  DATA.decks.forEach((d) => d.cards.forEach((c) => { c._deck = d.id; allCards.push(c); byId[c.id] = c; }));
  const deckById = Object.fromEntries(DATA.decks.map((d) => [d.id, d]));

  const st = (id) => S.cards[id];
  const isDue = (id) => { const s = st(id); return s && s.due <= now(); };
  const isNew = (id) => !st(id);
  function counts(deck) {
    let due = 0, nw = 0;
    deck.cards.forEach((c) => { if (isNew(c.id)) nw++; else if (isDue(c.id)) due++; });
    return { due, nw };
  }

  function grade(card, ok, missedThisSession) {
    const s = S.cards[card.id] || { step: -1, seen: 0, lapses: 0 };
    s.seen++;
    if (ok) {
      s.step = (s.step < 0 || missedThisSession) ? 0 : Math.min(s.step + 1, LADDER.length - 1);
      s.due = startOfDay(now()) + LADDER[s.step] * DAY + 4 * 3600000; // available from 4 AM that day
    } else {
      s.lapses++;
      s.step = -1;
      s.due = now(); // due again right away (and re-shown later this session)
    }
    s.last = now();
    S.cards[card.id] = s;
    logAnswer(card.id, ok);
    save();
    Sync.schedule();
  }


  // ---------- progress sync (ntfy.sh; card ids + counts only) ----------
  function dayKey(t) { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function logAnswer(id, ok) {
    const today = dayKey(now());
    if (!S.log || S.log.d !== today) {
      if (S.log && S.log.r && S.log.r.length) Sync.queue(snapshot()); // keep yesterday's final snapshot
      S.log = { d: today, r: [] };
    }
    S.log.r.push([id, ok ? 1 : 0, Math.round(now() / 1000)]);
    S.active = (S.active || []).filter((d) => d !== today).concat([today]).slice(-60);
  }
  function snapshot() {
    const decks = {};
    DATA.decks.forEach((d) => {
      let seen = 0, learned = 0, due = 0, nw = 0;
      d.cards.forEach((c) => { const s = st(c.id); if (!s) { nw++; return; } seen++; if (s.step >= 1) learned++; if (s.due <= now()) due++; });
      decks[d.id] = { n: d.cards.length, seen, learned, due, new: nw };
    });
    const snap = { v: 1, t: Math.round(now() / 1000), tz: -new Date().getTimezoneOffset(),
      days: S.active || [], decks, today: S.log || null };
    const stc = {};
    Object.keys(S.cards).forEach((id) => { const s = S.cards[id]; stc[id] = [s.step, Math.round(s.due / 3600000), s.lapses || 0, s.seen || 0]; });
    const withSt = Object.assign({}, snap, { st: stc });
    const body = JSON.stringify(withSt);
    if (body.length < 3900) return withSt;
    snap.stOmitted = true;
    return snap;
  }
  const Sync = (function () {
    const URL_ = (window.HINDI_SYNC || {}).url;
    const QKEY = "hindiCards.pending";
    let timer = null, firstPending = 0;
    const loadQ = () => { try { return JSON.parse(localStorage.getItem(QKEY)) || []; } catch (e) { return []; } };
    const saveQ = (q) => { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-10))); } catch (e) {} };
    function queue(snap) {
      const q = loadQ();
      const last = q[q.length - 1];
      if (last && last.today && snap.today && last.today.d === snap.today.d) q[q.length - 1] = snap; else q.push(snap);
      saveQ(q);
    }
    function flush(useBeacon) {
      if (!URL_) return;
      const q = loadQ();
      if (!q.length || (navigator.onLine === false)) return;
      if (useBeacon && navigator.sendBeacon) {
        let sent = 0;
        q.forEach((snap) => { if (navigator.sendBeacon(URL_, new Blob([JSON.stringify(snap)], { type: "text/plain" }))) sent++; });
        if (sent === q.length) saveQ([]);
        return;
      }
      (async () => {
        const rest = q.slice();
        while (rest.length) {
          try {
            const r = await fetch(URL_, { method: "POST", body: JSON.stringify(rest[0]), keepalive: true, headers: { "Content-Type": "text/plain" } });
            if (!r.ok) break;
            rest.shift();
          } catch (e) { break; }
        }
        // keep anything newer that was queued meanwhile
        const cur = loadQ();
        saveQ(cur.slice(q.length - rest.length));
      })();
    }
    function schedule() {
      queue(snapshot());
      clearTimeout(timer);
      if (!firstPending) firstPending = now();
      // send 20 s after the last answer, but at least every 2 minutes while studying
      const wait = Math.max(0, Math.min(20000, firstPending + 120000 - now()));
      timer = setTimeout(() => { firstPending = 0; flush(false); }, wait);
    }
    function sendNow(beacon) { clearTimeout(timer); firstPending = 0; flush(beacon); }
    window.addEventListener("online", () => flush(false));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") sendNow(true); });
    window.addEventListener("pagehide", () => sendNow(true));
    setTimeout(() => flush(false), 3000); // anything left from an offline session
    return { schedule, queue, sendNow };
  })();

  // ---------- audio ----------
  let seqToken = 0;
  function play(urls, btn) {
    urls = [].concat(urls).filter(Boolean);
    const token = ++seqToken;
    document.querySelectorAll(".spk button.playing").forEach((b) => b.classList.remove("playing"));
    if (btn) btn.classList.add("playing");
    let i = 0;
    const next = () => {
      if (token !== seqToken) return;
      if (i >= urls.length) { if (btn) btn.classList.remove("playing"); return; }
      player.src = urls[i++];
      player.onended = () => setTimeout(next, 450);
      const p = player.play();
      if (p && p.catch) p.catch(() => { if (btn) btn.classList.remove("playing"); });
    };
    next();
  }

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  // wrap Devanagari runs in notes so they get the Devanagari font
  const rich = (s) => esc(s).replace(/([\u0900-\u097F][\u0900-\u097F\s।?!,…]*)/g, '<span class="deva">$1</span>');
  function lenClass(t) { const n = t.length; return n > 34 ? "len-xl" : n > 22 ? "len-l" : n > 12 ? "len-m" : ""; }
  const TAG = { word: "शब्द", phrase: "वाक्यांश", sentence: "वाक्य", tense: "काल", char: "अक्षर" };
  function h(html) { $app.innerHTML = html; }

  // ---------- home ----------
  function home() {
    seqToken++;
    const days = DATA.decks.filter((d) => d.type === "day").sort((a, b) => b.day - a.day);
    const wife = deckById.wife, chars = deckById.chars;
    let totalDue = 0;
    DATA.decks.forEach((d) => (totalDue += counts(d).due));
    const pills = (d) => { const c = counts(d); return (c.due ? `<span class="pill dueP">${c.due} due</span>` : "") + (c.nw ? `<span class="pill new">${c.nw} new</span>` : "") + (!c.due && !c.nw ? `<span class="pill">✓ done</span>` : ""); };
    const row = (d, ic, t1, t2) => `<button class="deck" data-deck="${d.id}"><div class="ic">${ic}</div><div class="t"><div class="t1">${t1}</div><div class="t2">${t2}</div></div><div>${pills(d)}</div></button>`;
    h(`<div class="top"><h1>हिंदी कार्ड</h1></div>
      <div class="home">
        <button class="due" data-due="1"><div class="big">${totalDue ? `Review due: ${totalDue}` : "Nothing due to review 🎉"}</div>
        <div class="small">${totalDue ? "Cards from all decks that are ready for review" : "Learn new cards below"}</div></button>
        <div class="sect">Daily lessons</div>
        ${days.map((d) => row(d, d.day, `Day ${d.day}: ${esc(d.title)}`, `${esc(d.titleRom)} · ${esc(d.titleEn)}`)).join("")}
        <div class="sect">Special</div>
        ${wife ? row(wife, "❤️", esc(wife.title), esc(wife.titleEn)) : ""}
        ${chars ? row(chars, "अ", esc(chars.title), esc(chars.titleEn) + " · " + chars.cards.length + " cards") : ""}
        <div class="foot">Tap a card to hear it. Turn your volume up.<br>
        Got it → back in 1, 3, 7, 14, 30 days. Again → comes back soon.<br>
        <button id="reset">Reset all progress</button></div>
      </div>`);
    $app.querySelectorAll("[data-deck]").forEach((b) => (b.onclick = () => startDeck(deckById[b.dataset.deck])));
    $app.querySelector("[data-due]").onclick = () => { if (totalDue) startDue(); };
    document.getElementById("reset").onclick = () => { if (confirm("Erase all flashcard progress on this phone?")) { S.cards = {}; S.log = null; S.active = []; save(); Sync.queue(Object.assign(snapshot(), { reset: true })); Sync.sendNow(false); home(); } };
  }

  // ---------- session ----------
  let sess = null;
  function startDeck(deck, extraNew) {
    const due = deck.cards.filter((c) => isDue(c.id)).sort((a, b) => st(a.id).due - st(b.id).due);
    const nw = deck.cards.filter((c) => isNew(c.id)).slice(0, NEW_PER_SESSION);
    runSession(due.concat(nw), deck);
  }
  function startDue() {
    const due = allCards.filter((c) => isDue(c.id)).sort((a, b) => st(a.id).due - st(b.id).due);
    runSession(due, null);
  }
  function runSession(queue, deck) {
    if (!queue.length) { sess = { queue: [], deck, total: 0, done: 0, missed: {} }; return finished(); }
    sess = { queue: queue.slice(), deck, total: queue.length, done: 0, missed: {} };
    showFront();
  }
  function topBar() {
    const title = sess.deck ? (sess.deck.type === "day" ? `Day ${sess.deck.day}: ${esc(sess.deck.title)}` : esc(sess.deck.title)) : "Review";
    const pct = sess.total ? Math.round((sess.done / sess.total) * 100) : 0;
    return `<div class="top"><button class="back" id="home" aria-label="Home">‹</button><h1>${title}</h1><span class="count">${sess.queue.length} left</span></div><div class="bar"><i style="width:${pct}%"></i></div>`;
  }
  function frontAudio(c) {
    if (c.kind === "char") return [c.a.char];
    return [c.a.slow];
  }
  function showFront() {
    const c = sess.queue[0];
    if (!c) return finished();
    let body;
    if (c.kind === "char") {
      body = `<div class="hi char">${esc(c.hi)}</div>` + (c.matra ? `<div class="matra">${esc(c.matra.length ? "◌" + c.matra : "")} &nbsp; <b>${esc(c.matraEx)}</b></div>` : "");
    } else {
      body = (c.emoji ? `<div class="emoji">${esc(c.emoji)}</div>` : "") + `<div class="hi ${lenClass(c.hi)}">${esc(c.hi)}</div>`;
    }
    h(`${topBar()}<div class="stage">
      <div class="card" id="card"><span class="tag deva">${TAG[c.kind] || ""}</span>${body}
        <div class="spk"><button id="spk" aria-label="Play">🔊</button></div>
        <span class="hint">👆 🔊</span></div>
      <div class="actions"><button class="show" id="flip">Show answer</button></div></div>`);
    document.getElementById("home").onclick = home;
    const spk = document.getElementById("spk");
    document.getElementById("card").onclick = () => play(frontAudio(c), spk);
    spk.onclick = (e) => { e.stopPropagation(); play(frontAudio(c), spk); };
    document.getElementById("flip").onclick = showBack;
  }
  function showBack() {
    const c = sess.queue[0];
    let body, buttons;
    if (c.kind === "char") {
      body = `<div class="hi char">${esc(c.hi)}</div>
        ${c.matra ? `<div class="matra">${esc("◌" + c.matra)} &nbsp; <b>${esc(c.matraEx)}</b></div>` : ""}
        <div class="rom">${esc(c.rom)}</div>
        <div class="tip">${rich(c.tip)}</div>
        <div class="ex">${c.ex.emoji ? `<span class="exe">${esc(c.ex.emoji)}</span> ` : ""}<span class="exw">${esc(c.ex.hi)}</span>
          <div class="rom" style="font-size:19px">${esc(c.ex.rom)}</div><div class="en" style="font-size:17px">${esc(c.ex.en)}</div></div>`;
      buttons = `<button data-a="${c.a.char}">🔊 ${esc(c.hi)} से ${esc(c.ex.hi)}</button><button data-a="${c.ex.a.slow}">🐢 Word</button><button data-a="${c.ex.a.normal}">🔊 Word</button>`;
    } else {
      body = `<div class="hi ${lenClass(c.hi)}">${esc(c.hi)}</div>
        <div class="rom">${esc(c.rom)}</div><div class="en">${esc(c.en)}</div>
        ${c.note ? `<div class="note">${rich(c.note)}</div>` : ""}`;
      buttons = `<button data-a="${c.a.slow}">🐢 Slow</button><button data-a="${c.a.normal}">🔊 Normal</button>`;
    }
    h(`${topBar()}<div class="stage">
      <div class="card backside" id="card">${body}<div class="spk">${buttons}</div></div>
      <div class="actions"><button class="again" id="again">Again</button><button class="got" id="got">Got it</button></div></div>`);
    document.getElementById("home").onclick = home;
    $app.querySelectorAll(".spk button").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); play(b.dataset.a, b); }));
    document.getElementById("again").onclick = () => answer(false);
    document.getElementById("got").onclick = () => answer(true);
  }
  function answer(ok) {
    const c = sess.queue.shift();
    grade(c, ok, !!sess.missed[c.id]);
    if (ok) sess.done++;
    else {
      sess.missed[c.id] = true;
      sess.queue.splice(Math.min(3, sess.queue.length), 0, c); // see it again in a few cards
    }
    showFront();
  }
  function finished() {
    seqToken++;
    if (sess && sess.total) Sync.sendNow(false);
    const deck = sess.deck;
    const moreNew = deck ? counts(deck).nw : 0;
    let totalDue = 0; DATA.decks.forEach((d) => (totalDue += counts(d).due));
    h(`<div class="top"><button class="back" id="home">‹</button><h1>${deck ? esc(deck.title) : "Review"}</h1></div>
      <div class="done"><div class="big">🎉</div><h2>बहुत अच्छा!</h2>
      <div>${sess.total ? `You finished ${sess.total} card${sess.total > 1 ? "s" : ""}.` : "Nothing to study here right now."}</div>
      ${moreNew ? `<button id="more">Learn ${Math.min(moreNew, NEW_PER_SESSION)} more new</button>` : ""}
      ${totalDue ? `<button id="due">Review due (${totalDue})</button>` : ""}
      <button class="sec" id="h2">Home</button></div>`);
    document.getElementById("home").onclick = home;
    document.getElementById("h2").onclick = home;
    const m = document.getElementById("more"); if (m) m.onclick = () => startDeck(deck);
    const d = document.getElementById("due"); if (d) d.onclick = startDue;
  }

  // deep links for testing: #deck=day01 / #deck=chars&flip=1
  const hp = new URLSearchParams(location.hash.slice(1));
  if (hp.get("deck") && deckById[hp.get("deck")]) {
    startDeck(deckById[hp.get("deck")]);
    if (hp.get("skip")) for (let i = 0; i < +hp.get("skip"); i++) { sess.queue.push(sess.queue.shift()); } 
    if (hp.get("skip")) showFront();
    if (hp.get("flip")) showBack();
  } else home();

  if ("serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then((r) => r.update && r.update()).catch(() => {});
    // when a new day's deck is published, the new service worker takes over: reload once to show it
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }
})();
