(() => {
  const MC_NEEDED = 2;
  const WRITE_NEEDED = 2;
  const REVIEW_RATIO = 0.25;
  const STORAGE_KEY = "star-elements-v2";

  const app = document.getElementById("app");

  let state = loadState() || defaultState();

  function defaultState() {
    return {
      screen: "setup",
      groupSize: 8,
      // "intro" = still teaching new elements (MC for new, write for all)
      // "review" = everything introduced; writing-only weak mixes
      phase: "intro",
      groupIndex: 0, // 0-based completed count / current number - 1
      groupsCompleted: 0,
      currentGroup: [], // [{ symbol, name, isNew }]
      introduced: [], // symbols seen in at least one group
      elementStats: {}, // symbol -> { misses, hits, lastCorrectAt, lastAskedAt }
      mastery: {}, // current-group progress only
      askCounter: 0,
      current: null,
      feedback: null,
      lastPromptKey: null,
      sessionCorrect: 0,
      sessionAsked: 0,
      lockedChoices: false,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Migrate / sanitize
      if (!parsed.elementStats) parsed.elementStats = {};
      if (!parsed.introduced) parsed.introduced = [];
      if (!parsed.currentGroup) parsed.currentGroup = [];
      if (!parsed.phase) parsed.phase = "intro";
      return parsed;
    } catch {
      return null;
    }
  }

  function saveState() {
    const toSave = { ...state, current: null, feedback: null, lockedChoices: false };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function bySymbol(symbol) {
    return STARRED_ELEMENTS.find((e) => e.symbol === symbol);
  }

  function ensureStats(symbol) {
    if (!state.elementStats[symbol]) {
      state.elementStats[symbol] = {
        misses: 0,
        hits: 0,
        lastCorrectAt: 0,
        lastAskedAt: 0,
      };
    }
    return state.elementStats[symbol];
  }

  function elKey(symbol, mode, dir) {
    return `${symbol}|${mode}|${dir}`;
  }

  function getCount(symbol, mode, dir) {
    return state.mastery[elKey(symbol, mode, dir)] || 0;
  }

  function setCount(symbol, mode, dir, n) {
    state.mastery[elKey(symbol, mode, dir)] = n;
  }

  function currentGroup() {
    return state.currentGroup || [];
  }

  function isReviewPhase() {
    return state.phase === "review";
  }

  function neededFor(mode) {
    return mode === "mc" ? MC_NEEDED : WRITE_NEEDED;
  }

  function elementDoneForMode(el, mode) {
    const n = neededFor(mode);
    return getCount(el.symbol, mode, "s2n") >= n && getCount(el.symbol, mode, "n2s") >= n;
  }

  function needsMc(el) {
    return !isReviewPhase() && el.isNew && !elementDoneForMode(el, "mc");
  }

  function groupMode() {
    if (isReviewPhase()) return "write";
    const group = currentGroup();
    if (group.some((el) => needsMc(el))) return "mc";
    return "write";
  }

  function groupFullyDone() {
    return currentGroup().every((el) => elementDoneForMode(el, "write"));
  }

  function weakPool(mode) {
    const n = neededFor(mode);
    const pool = [];
    for (const el of currentGroup()) {
      if (mode === "mc" && !el.isNew) continue;
      for (const dir of ["s2n", "n2s"]) {
        if (getCount(el.symbol, mode, dir) < n) {
          pool.push({
            el,
            dir,
            mode,
            progress: getCount(el.symbol, mode, dir),
          });
        }
      }
    }
    return pool;
  }

  /** Higher = should review sooner */
  function weaknessScore(symbol) {
    const s = ensureStats(symbol);
    const sinceCorrect = state.askCounter - (s.lastCorrectAt || 0);
    const sinceAsked = state.askCounter - (s.lastAskedAt || 0);
    return s.misses * 5 + sinceCorrect * 0.35 + sinceAsked * 0.1 - s.hits * 0.15;
  }

  function pickWeak(symbols, count) {
    if (count <= 0 || !symbols.length) return [];
    const ranked = [...symbols].sort((a, b) => weaknessScore(b) - weaknessScore(a));
    // Take from the weakest half with some randomness so it isn't deterministic
    const top = ranked.slice(0, Math.max(count, Math.ceil(ranked.length * 0.6)));
    return shuffle(top).slice(0, Math.min(count, symbols.length));
  }

  function reviewSlotCount(size) {
    return Math.max(1, Math.ceil(size * REVIEW_RATIO));
  }

  function estimateIntroGroupsLeft() {
    const size = state.groupSize;
    const introduced = new Set(state.introduced);
    const unseen = STARRED_ELEMENTS.filter((e) => !introduced.has(e.symbol)).length;
    if (unseen === 0) return 0;
    // First group is all-new; later groups leave ~25% for review
    if (introduced.size === 0) {
      const afterFirst = Math.max(0, STARRED_ELEMENTS.length - size);
      const newPerLater = Math.max(1, size - reviewSlotCount(size));
      return 1 + Math.ceil(afterFirst / newPerLater);
    }
    const newPer = Math.max(1, size - reviewSlotCount(size));
    return Math.ceil(unseen / newPer);
  }

  function buildNextGroup() {
    const size = state.groupSize;
    const introduced = new Set(state.introduced);
    const unseen = STARRED_ELEMENTS.filter((e) => !introduced.has(e.symbol));
    const seen = STARRED_ELEMENTS.filter((e) => introduced.has(e.symbol));

    let picks = [];

    if (seen.length === 0) {
      // First pack: all new
      picks = unseen.slice(0, size).map((e) => ({ ...e, isNew: true }));
    } else if (unseen.length === 0) {
      // Everything introduced → pure weak review
      const weak = pickWeak(
        seen.map((e) => e.symbol),
        size
      );
      picks = weak.map((sym) => ({ ...bySymbol(sym), isNew: false }));
      state.phase = "review";
    } else {
      const reviewN = Math.min(reviewSlotCount(size), seen.length, size - 1);
      let newN = size - reviewN;
      if (unseen.length < newN) {
        newN = unseen.length;
      }
      const actualReview = Math.min(size - newN, seen.length);

      const news = unseen.slice(0, newN).map((e) => ({ ...e, isNew: true }));
      const reviewSyms = pickWeak(
        seen.map((e) => e.symbol),
        actualReview
      );
      const reviews = reviewSyms.map((sym) => ({ ...bySymbol(sym), isNew: false }));
      picks = shuffle([...news, ...reviews]);
    }

    return picks;
  }

  function startGroup(group) {
    state.currentGroup = group;
    state.mastery = {};
    state.current = null;
    state.feedback = null;
    state.lastPromptKey = null;
    state.lockedChoices = false;
    state.screen = "group-intro";

    // Mark new symbols introduced when the group begins
    const introduced = new Set(state.introduced);
    for (const el of group) {
      if (el.isNew) introduced.add(el.symbol);
      ensureStats(el.symbol);
    }
    state.introduced = [...introduced];

    if (STARRED_ELEMENTS.every((e) => introduced.has(e.symbol)) && group.every((e) => !e.isNew)) {
      state.phase = "review";
    }

    saveState();
  }

  function startSession() {
    state.phase = "intro";
    state.groupIndex = 0;
    state.groupsCompleted = 0;
    state.introduced = [];
    state.elementStats = {};
    state.mastery = {};
    state.askCounter = 0;
    state.sessionCorrect = 0;
    state.sessionAsked = 0;
    state.lastPromptKey = null;
    state.feedback = null;
    state.current = null;
    const group = buildNextGroup();
    startGroup(group);
  }

  function advanceAfterGroup() {
    state.groupsCompleted += 1;
    state.groupIndex = state.groupsCompleted;

    const introduced = new Set(state.introduced);
    const unseenLeft = STARRED_ELEMENTS.some((e) => !introduced.has(e.symbol));

    if (!unseenLeft) {
      state.phase = "review";
      state.screen = "cycle-done";
      state.currentGroup = [];
      saveState();
      return;
    }

    const group = buildNextGroup();
    startGroup(group);
  }

  function startReviewRound() {
    state.phase = "review";
    const group = buildNextGroup();
    startGroup(group);
  }

  function pickNextQuestion() {
    const mode = groupMode();
    let pool = weakPool(mode);

    if (!pool.length) {
      if (groupFullyDone()) return null;
      // MC finished → writing pool
      pool = weakPool(groupMode());
    }
    if (!pool.length) return null;

    pool.sort((a, b) => a.progress - b.progress);
    const lowest = pool[0].progress;
    let candidates = pool.filter((p) => p.progress === lowest);

    if (state.lastPromptKey && candidates.length > 1) {
      const filtered = candidates.filter(
        (p) => `${p.el.symbol}|${p.mode}|${p.dir}` !== state.lastPromptKey
      );
      if (filtered.length) candidates = filtered;
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    state.lastPromptKey = `${pick.el.symbol}|${pick.mode}|${pick.dir}`;

    const prompt =
      pick.dir === "s2n"
        ? { show: pick.el.symbol, ask: "name", answer: pick.el.name }
        : { show: pick.el.name, ask: "symbol", answer: pick.el.symbol };

    let choices = null;
    if (mode === "mc") {
      choices = buildChoices(pick.el, pick.dir);
    }

    return { el: pick.el, dir: pick.dir, mode, prompt, choices };
  }

  function buildChoices(correctEl, dir) {
    const others = shuffle(STARRED_ELEMENTS.filter((e) => e.symbol !== correctEl.symbol)).slice(0, 3);
    const opts = shuffle([correctEl, ...others]);
    return opts.map((e) => (dir === "s2n" ? e.name : e.symbol));
  }

  function normalizeName(s) {
    return s.trim().toLowerCase().replace(/\s+/g, " ");
  }

  function checkAnswer(given) {
    const q = state.current;
    if (!q) return false;
    if (q.prompt.ask === "symbol") {
      return given.trim() === q.prompt.answer;
    }
    return normalizeName(given) === normalizeName(q.prompt.answer);
  }

  function recordResult(correct) {
    const q = state.current;
    state.sessionAsked += 1;
    state.askCounter += 1;
    const stats = ensureStats(q.el.symbol);
    stats.lastAskedAt = state.askCounter;

    if (correct) {
      state.sessionCorrect += 1;
      stats.hits += 1;
      stats.lastCorrectAt = state.askCounter;
      const prev = getCount(q.el.symbol, q.mode, q.dir);
      setCount(q.el.symbol, q.mode, q.dir, prev + 1);
    } else {
      stats.misses += 1;
      setCount(q.el.symbol, q.mode, q.dir, 0);
    }
    saveState();
  }

  function beginDrill() {
    state.screen = "drill";
    state.feedback = null;
    state.lockedChoices = false;
    state.current = pickNextQuestion();
    if (!state.current) {
      state.screen = "group-done";
    }
    saveState();
  }

  function afterCorrectContinue() {
    if (groupFullyDone()) {
      state.screen = "group-done";
      state.current = null;
      saveState();
      render();
      return;
    }
    state.feedback = null;
    state.lockedChoices = false;
    state.current = pickNextQuestion();
    if (!state.current) {
      state.screen = "group-done";
    }
    saveState();
    render();
  }

  function progressStats() {
    const group = currentGroup();
    const mode = groupMode();
    const n = neededFor(mode);
    let done = 0;
    let total = 0;
    for (const el of group) {
      if (mode === "mc" && !el.isNew) continue;
      total += 2;
      for (const dir of ["s2n", "n2s"]) {
        if (getCount(el.symbol, mode, dir) >= n) done += 1;
      }
    }
    return { done, total, mode, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function groupLabel() {
    const n = state.groupsCompleted + 1;
    if (isReviewPhase()) {
      return { current: n, totalLabel: "review", title: `Review ${n}` };
    }
    const left = estimateIntroGroupsLeft();
    const total = state.groupsCompleted + left;
    return { current: n, totalLabel: String(total), title: `Group ${n}` };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render() {
    if (state.screen === "setup") renderSetup();
    else if (state.screen === "group-intro") renderGroupIntro();
    else if (state.screen === "drill") renderDrill();
    else if (state.screen === "group-done") renderGroupDone();
    else if (state.screen === "cycle-done") renderCycleDone();
    else renderSetup();
  }

  function renderSetup() {
    const sizes = [4, 5, 6, 8, 10, 12, 16];
    const reviewN = reviewSlotCount(state.groupSize);
    const newN = state.groupSize - reviewN;
    app.innerHTML = `
      <section class="screen">
        <p class="eyebrow">Day 13 prep · ${STARRED_ELEMENTS.length} starred elements</p>
        <h1>Star Elements</h1>
        <p class="lede">
          Learn in packs. Each new pack keeps ~${Math.round(REVIEW_RATIO * 100)}% old/weak elements mixed in, so earlier ones don’t fade.
        </p>

        <div class="panel">
          <h2 style="font-size:1.45rem;margin-bottom:0.35rem">Group size</h2>
          <p class="hint">How many elements per pack?</p>
          <div class="size-grid" role="group" aria-label="Group size">
            ${sizes
              .map(
                (n) => `
              <button type="button" class="size-btn ${state.groupSize === n ? "selected" : ""}" data-size="${n}">${n}</button>
            `
              )
              .join("")}
          </div>
          <label class="hint" for="custom-size" style="display:block;margin-top:0.9rem">Or type any size (2–24)</label>
          <input
            class="write-input"
            style="font-size:1rem;margin-top:0.35rem;max-width:8rem"
            id="custom-size"
            type="number"
            min="2"
            max="24"
            value="${state.groupSize}"
          />
          <p class="hint">
            After the first pack: about <strong>${newN} new</strong> + <strong>${reviewN} review</strong> each time.
          </p>

          <div class="btn-row">
            <button type="button" class="btn-primary" id="start-btn">Start drilling</button>
            ${
              state.currentGroup.length || state.groupsCompleted
                ? `<button type="button" class="btn-secondary" id="resume-btn">Resume</button>`
                : ""
            }
          </div>
        </div>

        <div class="panel how-panel">
          <h2 style="font-size:1.45rem;margin-bottom:0.75rem">How it works</h2>
          <ol class="how-steps">
            <li>
              <strong>Pick a pack size</strong>
              <span>Start small if you want (6–8 is a good default).</span>
            </li>
            <li>
              <strong>Learn the first pack</strong>
              <span>Multiple choice first, then typing — both symbol→name and name→symbol.</span>
            </li>
            <li>
              <strong>Next packs mix in review</strong>
              <span>About ${Math.round(REVIEW_RATIO * 100)}% of each new pack is old/weak elements so earlier ones don’t fade. New = MC then writing; review = writing only.</span>
            </li>
            <li>
              <strong>Clear a pack to move on</strong>
              <span>Miss one and that prompt resets. Keep going until the whole pack is locked.</span>
            </li>
            <li>
              <strong>Finish with writing-only reviews</strong>
              <span>Once every element has been introduced, packs are pure review — weakest and rustiest first.</span>
            </li>
          </ol>
          <p class="how-rules">
            Symbols are case-sensitive (<strong>Ca</strong>, not ca). Names need correct spelling; capitalization doesn’t matter.
          </p>
        </div>
      </section>
    `;

    const applySize = (n, { rerender = true } = {}) => {
      const size = Math.max(2, Math.min(24, Number(n) || 8));
      state.groupSize = size;
      saveState();
      if (rerender) render();
      return size;
    };

    app.querySelectorAll(".size-btn").forEach((btn) => {
      btn.addEventListener("click", () => applySize(btn.dataset.size));
    });

    const custom = app.querySelector("#custom-size");
    custom.addEventListener("change", () => applySize(custom.value));

    app.querySelector("#start-btn").addEventListener("click", () => {
      applySize(custom.value, { rerender: false });
      startSession();
      render();
    });

    const resume = app.querySelector("#resume-btn");
    if (resume) {
      resume.addEventListener("click", () => {
        if (!state.currentGroup.length) {
          if (state.phase === "review" || state.introduced.length === STARRED_ELEMENTS.length) {
            startReviewRound();
          } else {
            startSession();
          }
        } else {
          state.screen = "group-intro";
        }
        saveState();
        render();
      });
    }
  }

  function renderGroupIntro() {
    const group = currentGroup();
    const g = groupLabel();
    const newCount = group.filter((e) => e.isNew).length;
    const reviewCount = group.length - newCount;
    const reviewPhase = isReviewPhase();

    app.innerHTML = `
      <section class="screen">
        <div class="meta-row">
          <span class="chip">${reviewPhase ? `Review pack` : `Group ${g.current} / ${g.totalLabel}`}</span>
          <span class="chip phase">${reviewPhase ? "Writing only" : "MC (new) → Writing"}</span>
          ${reviewCount ? `<span class="chip round">${reviewCount} review</span>` : ""}
          ${newCount ? `<span class="chip">${newCount} new</span>` : ""}
        </div>
        <h1>${g.title}</h1>
        <p class="lede">
          ${
            reviewPhase
              ? "Pure review mix — weakest and rustiest first. Writing only."
              : reviewCount
                ? "New ones start with multiple choice. Review ones jump straight to writing so you don’t forget them."
                : "First pack — all new. Multiple choice, then writing."
          }
        </p>

        <div class="panel">
          <p class="hint" style="margin-top:0">Elements in this pack</p>
          <div class="element-pills">
            ${group
              .map(
                (el) => `
              <span class="pill ${el.isNew ? "new" : "review"}">
                <strong>${escapeHtml(el.symbol)}</strong> ${escapeHtml(el.name)}
                <span class="pill-tag">${el.isNew ? "new" : "review"}</span>
              </span>`
              )
              .join("")}
          </div>
          <div class="btn-row">
            <button type="button" class="btn-primary" id="go-drill">Let's go</button>
            <button type="button" class="btn-ghost" id="back-setup">Change group size</button>
          </div>
        </div>
      </section>
    `;

    app.querySelector("#go-drill").addEventListener("click", () => {
      beginDrill();
      render();
    });
    app.querySelector("#back-setup").addEventListener("click", () => {
      state.screen = "setup";
      saveState();
      render();
    });
  }

  function renderDrill() {
    if (!state.current) {
      beginDrill();
      if (state.screen !== "drill") {
        render();
        return;
      }
    }

    const q = state.current;
    const stats = progressStats();
    const g = groupLabel();
    const isSymbolPrompt = q.prompt.ask === "name";
    const phaseLabel = q.mode === "mc" ? "Multiple choice" : "Writing";
    const reviewTag = q.el.isNew ? "" : `<span class="chip round">review</span>`;

    const modeBanner =
      !isReviewPhase() && q.mode === "write"
        ? `<span class="chip phase">Writing</span>`
        : `<span class="chip phase">${phaseLabel}</span>`;

    app.innerHTML = `
      <section class="screen">
        <div class="meta-row">
          <span class="chip">${isReviewPhase() ? "Review" : `Group ${g.current}`}</span>
          ${modeBanner}
          ${reviewTag}
          <span class="chip streak">${stats.done}/${stats.total} locked</span>
        </div>

        <div class="progress-track" aria-hidden="true">
          <div class="progress-fill" style="width:${stats.pct}%"></div>
        </div>

        <div class="panel prompt-card" style="margin-top:1rem">
          <div class="prompt-label">${
            q.prompt.ask === "name" ? "What is the name?" : "What is the symbol?"
          }</div>
          <p class="prompt-value ${isSymbolPrompt ? "symbol" : ""}">${escapeHtml(q.prompt.show)}</p>
        </div>

        ${
          q.mode === "mc"
            ? `<div class="choices" id="choices">
                ${q.choices
                  .map(
                    (c, i) =>
                      `<button type="button" class="choice" data-choice="${escapeHtml(c)}" data-i="${i}">${escapeHtml(c)}</button>`
                  )
                  .join("")}
              </div>`
            : `<form class="write-form" id="write-form">
                <input
                  class="write-input"
                  id="write-input"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  placeholder="${q.prompt.ask === "symbol" ? "Type the symbol…" : "Type the name…"}"
                />
                <button type="submit" class="btn-primary">Check</button>
              </form>`
        }

        <p class="feedback ${state.feedback ? (state.feedback.ok ? "ok" : "bad") : ""}" id="feedback">
          ${state.feedback ? escapeHtml(state.feedback.text) : ""}
        </p>

        <div class="btn-row">
          <button type="button" class="btn-ghost" id="skip-setup">Exit to setup</button>
        </div>
      </section>
    `;

    app.querySelector("#skip-setup").addEventListener("click", () => {
      state.screen = "setup";
      saveState();
      render();
    });

    if (q.mode === "mc") {
      app.querySelectorAll(".choice").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (state.lockedChoices) return;
          handleMc(btn.dataset.choice, btn);
        });
      });
    } else {
      const form = app.querySelector("#write-form");
      const input = app.querySelector("#write-input");
      input.focus();
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        handleWrite(input);
      });
    }
  }

  function handleMc(choice, btn) {
    const q = state.current;
    const correct = checkAnswer(choice);
    state.lockedChoices = true;
    recordResult(correct);

    const buttons = [...app.querySelectorAll(".choice")];
    buttons.forEach((b) => {
      b.disabled = true;
      if (b.dataset.choice === q.prompt.answer) b.classList.add("correct");
    });
    if (!correct) btn.classList.add("wrong");

    state.feedback = correct
      ? { ok: true, text: "Nice — locked in." }
      : { ok: false, text: `It's ${q.prompt.answer}. You'll see this one again.` };

    const fb = app.querySelector("#feedback");
    fb.textContent = state.feedback.text;
    fb.className = `feedback ${correct ? "ok" : "bad"}`;

    setTimeout(() => {
      if (correct && groupFullyDone()) {
        state.screen = "group-done";
        state.current = null;
        state.feedback = null;
        state.lockedChoices = false;
        saveState();
        render();
        return;
      }
      afterCorrectContinue();
    }, correct ? 450 : 900);
  }

  function handleWrite(input) {
    if (state.lockedChoices) return;
    const value = input.value;
    if (!value.trim()) return;

    const q = state.current;
    const correct = checkAnswer(value);
    state.lockedChoices = true;
    recordResult(correct);

    input.classList.add(correct ? "ok" : "bad");
    state.feedback = correct
      ? { ok: true, text: "Got it." }
      : { ok: false, text: `Correct answer: ${q.prompt.answer}` };

    const fb = app.querySelector("#feedback");
    fb.textContent = state.feedback.text;
    fb.className = `feedback ${correct ? "ok" : "bad"}`;

    setTimeout(() => {
      if (correct && groupFullyDone()) {
        state.screen = "group-done";
        state.current = null;
        state.feedback = null;
        state.lockedChoices = false;
        saveState();
        render();
        return;
      }
      afterCorrectContinue();
    }, correct ? 350 : 1100);
  }

  function renderGroupDone() {
    const introduced = new Set(state.introduced);
    const unseenLeft = STARRED_ELEMENTS.some((e) => !introduced.has(e.symbol));
    const finishingIntro = !unseenLeft && !isReviewPhase();
    const g = groupLabel();

    let title;
    let lede;
    let btnLabel;
    if (unseenLeft) {
      title = "On to the next mix";
      lede = `Pack ${g.current} is locked. Next pack pulls in fresh elements plus weak ones from earlier.`;
      btnLabel = "Next pack";
    } else if (finishingIntro) {
      title = "All elements introduced";
      lede = "You've met every starred element. Keep going with writing-only review mixes.";
      btnLabel = "See wrap-up";
    } else {
      title = "Review pack cleared";
      lede = "Another weak mix is ready — keep writing until nothing feels rusty.";
      btnLabel = "Next review mix";
    }

    app.innerHTML = `
      <section class="screen">
        <p class="eyebrow">Pack cleared</p>
        <h1>${title}</h1>
        <p class="lede">${lede}</p>
        <div class="panel">
          <div class="stat-grid">
            <div class="stat"><span class="n">${state.groupsCompleted + 1}</span><span class="l">Packs done</span></div>
            <div class="stat"><span class="n">${state.introduced.length}</span><span class="l">Introduced</span></div>
            <div class="stat"><span class="n">${
              state.sessionAsked ? Math.round((state.sessionCorrect / state.sessionAsked) * 100) : 0
            }%</span><span class="l">Accuracy</span></div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn-primary" id="next-btn">${btnLabel}</button>
          </div>
        </div>
      </section>
    `;

    app.querySelector("#next-btn").addEventListener("click", () => {
      if (unseenLeft) {
        advanceAfterGroup();
      } else if (finishingIntro) {
        state.groupsCompleted += 1;
        state.phase = "review";
        state.screen = "cycle-done";
        state.currentGroup = [];
        saveState();
      } else {
        state.groupsCompleted += 1;
        startReviewRound();
      }
      render();
    });
  }

  function renderCycleDone() {
    app.innerHTML = `
      <section class="screen">
        <p class="eyebrow">Introduction complete</p>
        <h1>Keep them sharp</h1>
        <p class="lede">
          Next packs are writing-only, built from what you’ve missed or haven’t seen in a while — so nothing goes cold before Day 13.
        </p>
        <div class="panel">
          <div class="stat-grid">
            <div class="stat"><span class="n">${STARRED_ELEMENTS.length}</span><span class="l">Elements</span></div>
            <div class="stat"><span class="n">${state.groupsCompleted}</span><span class="l">Packs done</span></div>
            <div class="stat"><span class="n">${
              state.sessionAsked ? Math.round((state.sessionCorrect / state.sessionAsked) * 100) : 0
            }%</span><span class="l">Accuracy</span></div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn-primary" id="review-btn">Start review mix</button>
            <button type="button" class="btn-secondary" id="setup-again">Change group size</button>
          </div>
        </div>
      </section>
    `;

    app.querySelector("#review-btn").addEventListener("click", () => {
      startReviewRound();
      render();
    });
    app.querySelector("#setup-again").addEventListener("click", () => {
      state.screen = "setup";
      saveState();
      render();
    });
  }

  // Boot
  if (state.screen === "drill" && !state.current) {
    state.screen = state.currentGroup.length ? "group-intro" : "setup";
  }
  // Clear stale v1 so resume doesn’t get confused if both exist — v2 is separate key
  render();
})();
