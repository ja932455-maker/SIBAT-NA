/* ==========================================================================
   SIBAT NA — frontend/bike-game.js
   SIBAT RUN: a small offline big-bike runner in the spirit of the Chrome
   dinosaur game. Ctrl+Shift+G opens it; Space / ↑ jumps; Esc exits.
   Flat 2D only, no canvas, no network, no external assets.
   ========================================================================== */
(function () {
  'use strict';

  const overlay = document.getElementById('sibatRun');
  if (!overlay) return;

  const stage = document.getElementById('runStage');
  const bike = document.getElementById('runBike');
  const obstaclesHost = document.getElementById('runObstacles');
  const scoreEl = document.getElementById('runScore');
  const bestEl = document.getElementById('runBest');
  const intro = document.getElementById('runIntro');
  const over = document.getElementById('runOver');
  const hint = document.getElementById('runHint');
  const frame = overlay.querySelector('.sibat-run-frame');
  const finalEl = document.getElementById('runFinal');
  const finalBestEl = document.getElementById('runFinalBest');
  const startBtn = document.getElementById('runStart');
  const againBtn = document.getElementById('runAgain');
  const closeBtn = document.getElementById('runClose');

  const BEST_KEY = 'sibatna.bikeBest';
  const START_SPEED = 430;      // px per second
  const MAX_SPEED = 980;
  const SPEED_RAMP = 0.028;     // extra px/s per px travelled
  const GRAVITY = 2500;         // px per second squared
  const JUMP_POWER = 900;       // px per second upward
  const SCORE_PER_PX = 1 / 18;
  const FIRST_OBSTACLE_AT = 640;

  const state = {
    phase: 'idle',              // idle | running | over
    distance: 0,
    speed: START_SPEED,
    jumpY: 0,
    jumpV: 0,
    airborne: false,
    nextSpawn: FIRST_OBSTACLE_AT,
    score: 0,
    obstacles: []
  };
  let best = readBest();
  let lastFocus = null;
  let rafId = 0;
  let lastTime = 0;

  bestEl.textContent = pad(best);

  // ---------------------------------------------------------------------
  //  Game loop
  // ---------------------------------------------------------------------
  function tick(now) {
    if (state.phase !== 'running') return;

    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
    lastTime = now;

    state.distance += state.speed * dt;
    state.speed = Math.min(MAX_SPEED, START_SPEED + state.distance * SPEED_RAMP);

    const nextScore = Math.floor(state.distance * SCORE_PER_PX);
    if (nextScore !== state.score) {
      state.score = nextScore;
      scoreEl.textContent = pad(nextScore);
      if (nextScore > best) {
        best = nextScore;
        bestEl.textContent = pad(best);
      }
    }

    updateJump(dt);
    moveObstacles(dt);
    spawnObstacles(dt);

    if (hitsObstacle()) {
      endGame();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function updateJump(dt) {
    if (!state.airborne) return;
    state.jumpY += state.jumpV * dt;
    state.jumpV -= GRAVITY * dt;
    if (state.jumpY <= 0) {
      state.jumpY = 0;
      state.jumpV = 0;
      state.airborne = false;
    }
    paintBike();
  }

  function moveObstacles(dt) {
    for (let i = state.obstacles.length - 1; i >= 0; i--) {
      const obstacle = state.obstacles[i];
      obstacle.x -= state.speed * dt;
      obstacle.el.style.transform = `translate3d(${obstacle.x}px,0,0)`;
      if (obstacle.x + obstacle.width < -80) {
        obstacle.el.remove();
        state.obstacles.splice(i, 1);
      }
    }
  }

  function spawnObstacles(dt) {
    state.nextSpawn -= state.speed * dt;
    if (state.nextSpawn > 0) return;

    addObstacle(Math.random() < 0.55 ? 'cone' : 'barrier');
    // Keep the gap wider than one full jump so every obstacle stays fair.
    state.nextSpawn = 360 + Math.random() * 260 + state.speed * 0.55;
  }

  function addObstacle(type) {
    const el = document.createElement('span');
    const x = stage.clientWidth + 60;
    el.className = 'run-obstacle ' + (type === 'cone' ? 'is-cone' : 'is-barrier');
    el.style.transform = `translate3d(${x}px,0,0)`;
    obstaclesHost.appendChild(el);

    state.obstacles.push({
      el,
      x,
      width: el.offsetWidth
    });
  }

  function hitsObstacle() {
    const box = bike.getBoundingClientRect();
    // Only the front half of a side-on bike meets a barrier first; a full-length
    // box would keep "touching" it long after the front wheel has passed.
    const bikeBox = {
      left: box.left + box.width * 0.52,
      right: box.left + box.width * 0.82,
      top: box.top + box.height * 0.38,
      bottom: box.bottom - box.height * 0.04
    };

    for (const obstacle of state.obstacles) {
      const rect = obstacle.el.getBoundingClientRect();
      if (bikeBox.right < rect.left) continue;
      if (overlaps(bikeBox, {
        left: rect.left + 3,
        right: rect.right - 3,
        top: rect.top + 3,
        bottom: rect.bottom
      })) return true;
    }
    return false;
  }

  function overlaps(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function paintBike() {
    const angle = state.airborne ? clamp(-state.jumpV / 120, -8, 6) : 0;
    bike.style.transform = `translate3d(0,${-state.jumpY}px,0) rotate(${angle}deg)`;
  }

  // ---------------------------------------------------------------------
  //  State changes
  // ---------------------------------------------------------------------
  function startGame() {
    cancelAnimationFrame(rafId);
    clearObstacles();
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }

    state.phase = 'running';
    state.distance = 0;
    state.speed = START_SPEED;
    state.jumpY = 0;
    state.jumpV = 0;
    state.airborne = false;
    state.nextSpawn = FIRST_OBSTACLE_AT;
    state.score = 0;

    scoreEl.textContent = pad(0);
    bestEl.textContent = pad(best);
    intro.hidden = true;
    over.hidden = true;
    hint.hidden = false;
    frame.classList.remove('is-hit');
    stage.classList.add('is-running');
    paintBike();

    lastTime = 0;
    rafId = requestAnimationFrame(tick);
  }

  function endGame() {
    cancelAnimationFrame(rafId);
    state.phase = 'over';
    stage.classList.remove('is-running');
    hint.hidden = true;

    if (state.score > best) best = state.score;
    saveBest(best);

    finalEl.textContent = String(state.score);
    finalBestEl.textContent = String(best);
    bestEl.textContent = pad(best);
    over.hidden = false;
    frame.classList.add('is-hit');
    window.setTimeout(() => frame.classList.remove('is-hit'), 380);
    againBtn.focus();
  }

  function resetToIntro() {
    cancelAnimationFrame(rafId);
    state.phase = 'idle';
    state.distance = 0;
    state.speed = START_SPEED;
    state.jumpY = 0;
    state.jumpV = 0;
    state.airborne = false;
    state.score = 0;
    clearObstacles();
    paintBike();
    scoreEl.textContent = pad(0);
    bestEl.textContent = pad(best);
    intro.hidden = false;
    over.hidden = true;
    hint.hidden = true;
    frame.classList.remove('is-hit');
    stage.classList.remove('is-running');
  }

  function clearObstacles() {
    state.obstacles.forEach((obstacle) => obstacle.el.remove());
    state.obstacles = [];
  }

  // ---------------------------------------------------------------------
  //  Open / close + input
  // ---------------------------------------------------------------------
  function openGame() {
    if (!overlay.hidden) return;
    lastFocus = document.activeElement;
    resetToIntro();
    overlay.hidden = false;
    document.body.classList.add('run-open');
    window.setTimeout(() => startBtn.focus(), 40);
  }

  function closeGame() {
    if (overlay.hidden) return;
    cancelAnimationFrame(rafId);
    state.phase = 'idle';
    stage.classList.remove('is-running');
    clearObstacles();
    saveBest(best);
    overlay.hidden = true;
    document.body.classList.remove('run-open');
    frame.classList.remove('is-hit');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function jump() {
    if (state.airborne) return;
    state.airborne = true;
    state.jumpV = JUMP_POWER;
    state.jumpY = 0.01;
    paintBike();
  }

  function isFormField(node) {
    if (!node || !node.tagName) return false;
    const tag = node.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable;
  }

  document.addEventListener('keydown', (event) => {
    const toggleGame = event.ctrlKey && event.shiftKey &&
      (event.code === 'KeyG' || (event.key && event.key.toLowerCase() === 'g'));

    if (toggleGame) {
      event.preventDefault();
      if (overlay.hidden) openGame();
      else closeGame();
      return;
    }

    if (overlay.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGame();
      return;
    }

    const isJumpKey = event.code === 'Space' || event.key === 'ArrowUp' ||
      event.code === 'KeyW' || event.key === 'w' || event.key === 'W';
    if (!isJumpKey || isFormField(event.target)) return;

    event.preventDefault();
    if (event.repeat) return;
    if (state.phase === 'running') jump();
    else startGame();
  });

  stage.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    if (state.phase === 'running') jump();
    else startGame();
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-run-open]')) {
      event.preventDefault();
      openGame();
    }
  });

  startBtn.addEventListener('click', startGame);
  againBtn.addEventListener('click', startGame);
  closeBtn.addEventListener('click', closeGame);

  // Debug hook, mirroring SIBAT_APP / SIBAT_DRIVER.
  window.SIBAT_RUN = {
    open: openGame,
    close: closeGame,
    start: startGame,
    get phase() { return state.phase; },
    get score() { return state.score; }
  };

  // ---------------------------------------------------------------------
  //  Helpers
  // ---------------------------------------------------------------------
  function pad(value) {
    return String(value).padStart(4, '0');
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function readBest() {
    try {
      return Math.max(0, parseInt(localStorage.getItem(BEST_KEY), 10) || 0);
    } catch (_) {
      return 0;
    }
  }

  function saveBest(value) {
    try {
      localStorage.setItem(BEST_KEY, String(value));
    } catch (_) {
      // Private mode / blocked storage: the run still works, just no best score.
    }
  }
})();
