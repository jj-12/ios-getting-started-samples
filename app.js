/* ========================================
   Heads Up! Party Game - Main App Logic
   ======================================== */

// ---- Game State ----

const gameState = {
  teams: [],
  timerDuration: 60,
  category: 'animals',
  roundsPerTeam: 1,

  currentScreen: 'SETUP',
  currentTeamIndex: 0,
  currentRound: 0,
  wordsUsed: new Set(),

  roundWords: [],
  timeRemaining: 60,
  currentWord: null,
  timerInterval: null,

  tiltAvailable: false,
  wakeLock: null,
};

// ---- Screen Management ----

const screens = {
  SETUP: document.getElementById('screen-setup'),
  READY: document.getElementById('screen-ready'),
  PLAYING: document.getElementById('screen-playing'),
  ROUND_RESULTS: document.getElementById('screen-results'),
  COUNTDOWN: document.getElementById('screen-countdown'),
  SCOREBOARD: document.getElementById('screen-scoreboard'),
  GAME_OVER: document.getElementById('screen-gameover'),
};

function transition(newScreen) {
  exitState(gameState.currentScreen);
  Object.values(screens).forEach(s => s.classList.remove('active'));
  gameState.currentScreen = newScreen;
  screens[newScreen].classList.add('active');
  enterState(newScreen);
}

let countdownTimer = null;

function exitState(screen) {
  if (screen === 'PLAYING') {
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = null;
    window.removeEventListener('deviceorientation', handleOrientation);
    document.body.classList.remove('playing-active');
    releaseWakeLock();
  }
  if (screen === 'COUNTDOWN') {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function enterState(screen) {
  switch (screen) {
    case 'READY': enterReady(); break;
    case 'COUNTDOWN': enterCountdown(); break;
    case 'PLAYING': enterPlaying(); break;
    case 'ROUND_RESULTS': enterRoundResults(); break;
    case 'SCOREBOARD': enterScoreboard(); break;
    case 'GAME_OVER': enterGameOver(); break;
  }
}

// ---- Setup Screen ----

let teamCount = 2;
let selectedTimer = 60;
let selectedCategory = 'animals';
let roundsPerTeam = 1;

function initSetup() {
  // Team stepper
  document.getElementById('teams-minus').addEventListener('click', () => {
    if (teamCount > 2) {
      teamCount--;
      updateTeamInputs();
    }
  });
  document.getElementById('teams-plus').addEventListener('click', () => {
    if (teamCount < 6) {
      teamCount++;
      updateTeamInputs();
    }
  });

  // Rounds stepper
  document.getElementById('rounds-minus').addEventListener('click', () => {
    if (roundsPerTeam > 1) {
      roundsPerTeam--;
      document.getElementById('rounds-count').textContent = roundsPerTeam;
    }
  });
  document.getElementById('rounds-plus').addEventListener('click', () => {
    if (roundsPerTeam < 5) {
      roundsPerTeam++;
      document.getElementById('rounds-count').textContent = roundsPerTeam;
    }
  });

  // Timer toggle
  document.querySelectorAll('#timer-group .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#timer-group .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedTimer = parseInt(btn.dataset.value);
    });
  });

  // Category grid
  const grid = document.getElementById('category-grid');
  Object.entries(WORD_BANK).forEach(([key, cat]) => {
    const card = document.createElement('div');
    card.className = 'category-card' + (key === selectedCategory ? ' selected' : '');
    card.dataset.category = key;
    card.innerHTML = `<span class="category-card-icon">${cat.icon}</span><span class="category-card-name">${cat.name}</span>`;
    card.addEventListener('click', () => {
      document.querySelectorAll('.category-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedCategory = key;
    });
    grid.appendChild(card);
  });

  // Start button
  document.getElementById('start-game-btn').addEventListener('click', startGame);
}

function updateTeamInputs() {
  document.getElementById('teams-count').textContent = teamCount;
  const container = document.getElementById('team-names');
  const existing = container.querySelectorAll('.team-input');
  const currentValues = Array.from(existing).map(i => i.value);

  container.innerHTML = '';
  for (let i = 0; i < teamCount; i++) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'team-input';
    input.placeholder = `Team ${i + 1}`;
    input.maxLength = 20;
    if (currentValues[i]) input.value = currentValues[i];
    container.appendChild(input);
  }
}

function startGame() {
  const inputs = document.querySelectorAll('.team-input');
  gameState.teams = Array.from(inputs).map((input, i) => ({
    name: input.value.trim() || `Team ${i + 1}`,
    scores: [],
  }));
  gameState.timerDuration = selectedTimer;
  gameState.category = selectedCategory;
  gameState.roundsPerTeam = roundsPerTeam;
  gameState.currentTeamIndex = 0;
  gameState.currentRound = 0;
  gameState.wordsUsed = new Set();

  transition('READY');
}

// ---- Ready Screen ----

function enterReady() {
  const team = gameState.teams[gameState.currentTeamIndex];
  const cat = WORD_BANK[gameState.category];
  document.getElementById('ready-team-name').textContent = team.name + "'s Turn";
  document.getElementById('ready-category').textContent = cat.icon + ' ' + cat.name;
}

document.getElementById('go-btn').addEventListener('click', async () => {
  initAudio();
  // Request fullscreen to hide address bar
  try {
    const el = document.documentElement;
    const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (rfs) await rfs.call(el);
  } catch (e) {}
  await requestOrientationPermission();
  transition('COUNTDOWN');
});

// ---- Countdown ----

function enterCountdown() {
  const countdownEl = document.getElementById('countdown-number');
  let count = 3;
  countdownEl.textContent = count;

  playTickSound();

  countdownTimer = setInterval(() => {
    count--;
    if (count > 0) {
      countdownEl.textContent = count;
      // Re-trigger animation
      countdownEl.style.animation = 'none';
      countdownEl.offsetHeight; // force reflow
      countdownEl.style.animation = '';
      playTickSound();
    } else {
      transition('PLAYING');
    }
  }, 1000);
}

// ---- Tilt Detection ----

let tiltState = { lastGestureTime: 0, waitingForNeutral: false };

async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm === 'granted') {
        gameState.tiltAvailable = true;
      } else {
        gameState.tiltAvailable = false;
      }
    } catch (e) {
      gameState.tiltAvailable = false;
    }
  } else if ('DeviceOrientationEvent' in window) {
    gameState.tiltAvailable = true;
  } else {
    gameState.tiltAvailable = false;
  }

  if (!gameState.tiltAvailable) {
    document.body.classList.add('tap-mode');
  } else {
    document.body.classList.remove('tap-mode');
  }
}

function handleOrientation(event) {
  if (gameState.currentScreen !== 'PLAYING') return;

  // Get screen orientation angle (works on iOS and Android)
  const orientationAngle = (screen.orientation && screen.orientation.angle !== undefined)
    ? screen.orientation.angle
    : (window.orientation || 0);

  // Convert to orientation-independent tilt value
  const effectiveTilt = getEffectiveTilt(event.beta, event.gamma, orientationAngle);

  const result = processTilt(effectiveTilt, Date.now(), tiltState, TILT_CONFIG);
  tiltState = result.state;

  if (result.action) {
    recordAnswer(result.action);
  }
}

// Tap zone fallbacks - ONLY active when tilt is not available (desktop)
document.getElementById('tap-pass').addEventListener('click', () => {
  if (!gameState.tiltAvailable && gameState.currentScreen === 'PLAYING') recordAnswer('correct');
});
document.getElementById('tap-correct').addEventListener('click', () => {
  if (!gameState.tiltAvailable && gameState.currentScreen === 'PLAYING') recordAnswer('pass');
});

// ---- Playing Screen ----

function enterPlaying() {
  document.body.classList.add('playing-active');
  gameState.roundWords = [];
  gameState.timeRemaining = gameState.timerDuration;
  tiltState = { lastGestureTime: 0, waitingForNeutral: false };

  if (gameState.tiltAvailable) {
    window.addEventListener('deviceorientation', handleOrientation);
  }

  requestWakeLock();
  showNextWord();
  updateTimerDisplay();
  updateScoreDisplay();

  gameState.timerInterval = setInterval(() => {
    gameState.timeRemaining--;
    updateTimerDisplay();

    if (gameState.timeRemaining <= 5 && gameState.timeRemaining > 0) {
      playTickSound();
    }

    if (gameState.timeRemaining <= 0) {
      endRound();
    }
  }, 1000);
}

function showNextWord() {
  gameState.currentWord = getNextWord();
  document.getElementById('playing-word').textContent = gameState.currentWord;
}

function getNextWord() {
  const words = WORD_BANK[gameState.category].words;
  const available = words.filter(w => !gameState.wordsUsed.has(w));
  if (available.length === 0) {
    gameState.wordsUsed.clear();
    return getNextWord();
  }
  const word = available[Math.floor(Math.random() * available.length)];
  gameState.wordsUsed.add(word);
  return word;
}

function recordAnswer(result) {
  gameState.roundWords.push({
    word: gameState.currentWord,
    result: result,
  });

  // Visual feedback
  const playingScreen = screens.PLAYING;
  const flashClass = result === 'correct' ? 'flash-correct' : 'flash-pass';
  playingScreen.classList.add(flashClass);
  setTimeout(() => playingScreen.classList.remove(flashClass), 400);

  // Audio feedback
  if (result === 'correct') {
    playCorrectSound();
  } else {
    playPassSound();
  }

  // Vibration
  if (navigator.vibrate) {
    navigator.vibrate(result === 'correct' ? 200 : [100, 50, 100]);
  }

  updateScoreDisplay();
  showNextWord();
}

function updateTimerDisplay() {
  const timerEl = document.getElementById('playing-timer');
  timerEl.textContent = gameState.timeRemaining;
  if (gameState.timeRemaining <= 10) {
    timerEl.classList.add('urgent');
  } else {
    timerEl.classList.remove('urgent');
  }
}

function updateScoreDisplay() {
  const correct = gameState.roundWords.filter(w => w.result === 'correct').length;
  document.getElementById('playing-score').textContent = correct + ' correct';
}

function endRound() {
  playTimerEndSound();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);

  const score = gameState.roundWords.filter(w => w.result === 'correct').length;
  gameState.teams[gameState.currentTeamIndex].scores.push(score);

  transition('ROUND_RESULTS');
}

// ---- Round Results ----

function enterRoundResults() {
  const team = gameState.teams[gameState.currentTeamIndex];
  const score = team.scores[team.scores.length - 1];

  document.getElementById('results-title').textContent = team.name;
  document.getElementById('results-score').textContent = score + ' correct!';

  const list = document.getElementById('results-list');
  list.innerHTML = '';

  gameState.roundWords.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'results-item ' + item.result;
    li.innerHTML = `<span class="results-icon"></span><span class="results-word">${item.word}</span>`;
    li.addEventListener('click', () => toggleResult(index, li));
    list.appendChild(li);
  });
}

function toggleResult(index, li) {
  const item = gameState.roundWords[index];
  item.result = item.result === 'correct' ? 'pass' : 'correct';
  li.className = 'results-item ' + item.result;

  // Recalculate score
  const team = gameState.teams[gameState.currentTeamIndex];
  const newScore = gameState.roundWords.filter(w => w.result === 'correct').length;
  team.scores[team.scores.length - 1] = newScore;
  document.getElementById('results-score').textContent = newScore + ' correct!';
}

document.getElementById('results-continue-btn').addEventListener('click', () => {
  transition('SCOREBOARD');
});

// ---- Scoreboard ----

function enterScoreboard() {
  const table = document.getElementById('scoreboard-table');
  table.innerHTML = '';

  // Sort teams by total score
  const ranked = gameState.teams.map((team, i) => ({
    team,
    index: i,
    total: team.scores.reduce((s, v) => s + v, 0),
  })).sort((a, b) => b.total - a.total);

  const maxTotal = ranked.length > 0 ? ranked[0].total : 0;

  ranked.forEach((entry, rank) => {
    const row = document.createElement('div');
    row.className = 'scoreboard-row' + (entry.total === maxTotal && entry.total > 0 ? ' leader' : '');
    row.innerHTML = `
      <span class="scoreboard-rank">#${rank + 1}</span>
      <span class="scoreboard-name">${entry.team.name}</span>
      <span class="scoreboard-points">${entry.total}</span>
    `;
    table.appendChild(row);
  });

  // Determine next action
  const btn = document.getElementById('scoreboard-next-btn');
  const totalRounds = gameState.teams.length * gameState.roundsPerTeam;
  const completedRounds = gameState.teams.reduce((sum, t) => sum + t.scores.length, 0);

  if (completedRounds >= totalRounds) {
    btn.textContent = 'Final Results';
    btn.onclick = () => transition('GAME_OVER');
  } else {
    // Advance to next team
    advanceToNextTeam();
    const nextTeam = gameState.teams[gameState.currentTeamIndex];
    btn.textContent = 'Next: ' + nextTeam.name;
    btn.onclick = () => transition('READY');
  }
}

function advanceToNextTeam() {
  // Find the next team that hasn't completed all their rounds
  const totalTeams = gameState.teams.length;
  for (let i = 1; i <= totalTeams; i++) {
    const idx = (gameState.currentTeamIndex + i) % totalTeams;
    if (gameState.teams[idx].scores.length < gameState.roundsPerTeam) {
      gameState.currentTeamIndex = idx;
      return;
    }
  }
}

// ---- Game Over ----

function enterGameOver() {
  const ranked = gameState.teams.map(team => ({
    name: team.name,
    total: team.scores.reduce((s, v) => s + v, 0),
  })).sort((a, b) => b.total - a.total);

  // Check for tie
  const topScore = ranked[0].total;
  const winners = ranked.filter(t => t.total === topScore);
  const winnerText = winners.length > 1
    ? "It's a tie!"
    : ranked[0].name + ' Wins!';

  document.getElementById('gameover-winner').textContent = winnerText;

  const scoresDiv = document.getElementById('gameover-scores');
  scoresDiv.innerHTML = '';
  ranked.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'gameover-score-row';
    row.innerHTML = `<span class="gameover-score-name">${entry.name}</span><span class="gameover-score-points">${entry.total} pts</span>`;
    scoresDiv.appendChild(row);
  });

  spawnConfetti();
}

document.getElementById('play-again-btn').addEventListener('click', () => {
  // Keep team names, reset scores
  gameState.teams.forEach(t => t.scores = []);
  gameState.currentTeamIndex = 0;
  gameState.currentRound = 0;
  gameState.wordsUsed = new Set();
  transition('READY');
});

document.getElementById('new-game-btn').addEventListener('click', () => {
  // Full reset, go back to setup
  gameState.teams = [];
  gameState.currentTeamIndex = 0;
  gameState.currentRound = 0;
  gameState.wordsUsed = new Set();
  transition('SETUP');
});

// ---- Confetti ----

function spawnConfetti() {
  const container = document.getElementById('confetti');
  container.innerHTML = '';
  const colors = ['#e94560', '#f39c12', '#2ecc71', '#3498db', '#9b59b6', '#e67e22', '#1abc9c'];

  for (let i = 0; i < 40; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + '%';
    piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (2 + Math.random() * 3) + 's';
    piece.style.animationDelay = (Math.random() * 2) + 's';
    piece.style.width = (6 + Math.random() * 8) + 'px';
    piece.style.height = (12 + Math.random() * 12) + 'px';
    container.appendChild(piece);
  }
}

// ---- Wake Lock ----

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      gameState.wakeLock = await navigator.wakeLock.request('screen');
      gameState.wakeLock.addEventListener('release', () => {
        gameState.wakeLock = null;
      });
    } catch (e) {}
  }
}

function releaseWakeLock() {
  if (gameState.wakeLock) {
    gameState.wakeLock.release();
    gameState.wakeLock = null;
  }
}

// ---- Orientation Overlay ----

function checkOrientation() {
  const overlay = document.getElementById('rotate-overlay');
  const isPortrait = window.innerHeight > window.innerWidth;
  const needsLandscape = gameState.currentScreen !== 'SETUP';

  if (isPortrait && needsLandscape) {
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}

window.addEventListener('resize', checkOrientation);
window.addEventListener('orientationchange', checkOrientation);

// ---- Service Worker Registration ----

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---- Init ----

initSetup();
checkOrientation();
