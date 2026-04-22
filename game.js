const LOCAL_STORAGE_KEY = "horse-jump-web-local-leaderboard";

class LeaderboardService {
  constructor() {
    this.mode = "local";
  }

  async listTopScores() {
    return this.readLocalScores();
  }

  async submitScore(name, score) {
    const safeName = (name || "Player").trim().slice(0, 14) || "Player";
    const entries = this.readLocalScores();
    entries.push({
      name: safeName,
      score,
      createdAt: new Date().toISOString(),
    });
    entries.sort((a, b) => b.score - a.score);
    const trimmed = entries.slice(0, 20);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(trimmed));
    return trimmed;
  }

  readLocalScores() {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_error) {
      return [];
    }
    return [];
  }
}

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const scoreValue = document.getElementById("scoreValue");
const coinValue = document.getElementById("coinValue");
const areaValue = document.getElementById("areaValue");
const perkValue = document.getElementById("perkValue");
const statusText = document.getElementById("statusText");
const leaderboardList = document.getElementById("leaderboardList");
const leaderboardMode = document.getElementById("leaderboardMode");
const scoreForm = document.getElementById("scoreForm");
const playerNameInput = document.getElementById("playerName");
const scoreSubmitButton = document.getElementById("scoreSubmitButton");
const scorePromptText = document.getElementById("scorePromptText");
const restartButton = document.getElementById("restartButton");
const jumpButton = document.getElementById("jumpButton");
const perkButtons = [...document.querySelectorAll(".perk-button")];

const leaderboard = new LeaderboardService();

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const GROUND_Y = 392;
const PERK_COSTS = { fly: 35, magnet: 28, blaster: 32 };
const AudioContextClass = window.AudioContext || window.webkitAudioContext;

const audioState = {
  enabled: Boolean(AudioContextClass),
  unlocked: false,
  started: false,
  context: null,
  master: null,
  musicGain: null,
  currentArea: -1,
  nextMusicAt: 0,
  musicTimer: null,
};

const state = {
  frame: 0,
  score: 0,
  coins: 0,
  area: 0,
  gameOver: false,
  scoreSubmitted: false,
  gameOverHandled: false,
  awaitingScoreEntry: false,
  status: "Press Space or tap to jump.",
  worldSpeed: 7,
  horse: {
    x: 150,
    y: GROUND_Y,
    vy: 0,
    width: 118,
    height: 92,
    jumpsLeft: 2,
    onGround: true,
  },
  flyUntil: 0,
  magnetUntil: 0,
  blasterUntil: 0,
  invisibleUntil: 0,
  powerModeUntil: 0,
  nextShotFrame: 0,
  obstacles: [],
  coinsInWorld: [],
  pickups: [],
  projectiles: [],
  spawnTimer: 85,
  coinTimer: 140,
  pickupTimer: 950,
  clouds: [
    { x: 80, y: 72, size: 1.0, speed: 0.35 },
    { x: 320, y: 52, size: 1.15, speed: 0.25 },
    { x: 690, y: 92, size: 0.92, speed: 0.3 },
  ],
};

function ensureAudioReady() {
  if (!audioState.enabled || audioState.context) {
    return;
  }

  audioState.context = new AudioContextClass();
  audioState.master = audioState.context.createGain();
  audioState.master.gain.value = 0.18;
  audioState.master.connect(audioState.context.destination);

  audioState.musicGain = audioState.context.createGain();
  audioState.musicGain.gain.value = 0.32;
  audioState.musicGain.connect(audioState.master);
}

function unlockAudio() {
  if (!audioState.enabled) {
    return;
  }

  ensureAudioReady();
  if (!audioState.context) {
    return;
  }

  if (audioState.context.state === "suspended") {
    audioState.context.resume();
  }

  audioState.unlocked = true;
  if (!audioState.started) {
    startAreaMusic(state.area, true);
    audioState.started = true;
  }
}

function playTone({
  frequency,
  duration = 0.12,
  type = "square",
  volume = 0.07,
  attack = 0.005,
  release = 0.06,
  when = 0,
  slideTo = null,
  output = null,
}) {
  if (!audioState.unlocked || !audioState.context || !audioState.master) {
    return;
  }

  const startTime = audioState.context.currentTime + when;
  const oscillator = audioState.context.createOscillator();
  const gain = audioState.context.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startTime);
  if (slideTo !== null) {
    oscillator.frequency.linearRampToValueAtTime(slideTo, startTime + duration);
  }

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration + release);

  oscillator.connect(gain);
  gain.connect(output || audioState.master);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration + release + 0.02);
}

function playJumpSound() {
  playTone({ frequency: 440, duration: 0.08, type: "square", volume: 0.05, slideTo: 620 });
}

function playCoinSound() {
  playTone({ frequency: 880, duration: 0.05, type: "triangle", volume: 0.04 });
  playTone({ frequency: 1320, duration: 0.05, type: "triangle", volume: 0.03, when: 0.04 });
}

function playPerkSound() {
  playTone({ frequency: 523.25, duration: 0.06, type: "square", volume: 0.05 });
  playTone({ frequency: 659.25, duration: 0.06, type: "square", volume: 0.05, when: 0.07 });
  playTone({ frequency: 783.99, duration: 0.08, type: "square", volume: 0.05, when: 0.14 });
}

function playBlasterSound() {
  playTone({ frequency: 720, duration: 0.04, type: "sawtooth", volume: 0.03, slideTo: 420 });
}

function playCrashSound() {
  playTone({ frequency: 180, duration: 0.15, type: "sawtooth", volume: 0.05, slideTo: 100 });
  playTone({ frequency: 130, duration: 0.2, type: "triangle", volume: 0.04, when: 0.04, slideTo: 70 });
}

function playAppleSound() {
  playTone({ frequency: 587.33, duration: 0.06, type: "triangle", volume: 0.06 });
  playTone({ frequency: 783.99, duration: 0.08, type: "triangle", volume: 0.06, when: 0.06 });
  playTone({ frequency: 1046.5, duration: 0.12, type: "triangle", volume: 0.06, when: 0.14 });
}

function getAreaMusicPattern(area) {
  const patterns = [
    { lead: [261.63, 329.63, 392, 440, 392, 329.63, 293.66, 349.23], bass: [130.81, 98, 110, 98] },
    { lead: [293.66, 349.23, 440, 493.88, 440, 392, 349.23, 329.63], bass: [146.83, 110, 123.47, 110] },
    { lead: [220, 261.63, 329.63, 349.23, 329.63, 293.66, 261.63, 246.94], bass: [110, 82.41, 98, 82.41] },
    { lead: [329.63, 392, 523.25, 493.88, 440, 392, 349.23, 440], bass: [164.81, 123.47, 146.83, 123.47] },
  ];
  const powerPattern = {
    lead: [523.25, 659.25, 783.99, 987.77, 880, 783.99, 698.46, 880, 1046.5, 1174.66, 1046.5, 880],
    bass: [130.81, 164.81, 196, 246.94, 164.81, 220],
  };
  if (area === "power") {
    return powerPattern;
  }
  return patterns[area % patterns.length];
}

function stopAreaMusic() {
  if (audioState.musicTimer) {
    clearTimeout(audioState.musicTimer);
    audioState.musicTimer = null;
  }
  audioState.nextMusicAt = 0;
}

function scheduleAreaMusic(area) {
  if (!audioState.unlocked || !audioState.context || !audioState.musicGain) {
    return;
  }

  const pattern = getAreaMusicPattern(area);
  const startTime = Math.max(audioState.context.currentTime + 0.03, audioState.nextMusicAt || audioState.context.currentTime + 0.03);
  const step = 0.22;

  pattern.lead.forEach((note, index) => {
    playTone({
      frequency: note,
      duration: 0.12,
      type: "square",
      volume: 0.018,
      when: startTime - audioState.context.currentTime + index * step,
      output: audioState.musicGain,
    });
    if (index % 2 === 0) {
      playTone({
        frequency: note * 0.5,
        duration: 0.14,
        type: "triangle",
        volume: 0.012,
        when: startTime - audioState.context.currentTime + index * step,
        output: audioState.musicGain,
      });
    }
  });

  pattern.bass.forEach((note, index) => {
    playTone({
      frequency: note,
      duration: 0.28,
      type: "triangle",
      volume: 0.016,
      when: startTime - audioState.context.currentTime + index * step * 2,
      output: audioState.musicGain,
    });
  });

  const loopDuration = pattern.lead.length * step;
  audioState.nextMusicAt = startTime + loopDuration;
  audioState.musicTimer = window.setTimeout(() => {
    if (audioState.currentArea === area && !state.gameOver) {
      scheduleAreaMusic(area);
    }
  }, Math.max(120, loopDuration * 1000 - 60));
}

function startAreaMusic(area, forceRestart = false) {
  if (!audioState.unlocked) {
    return;
  }

  if (!forceRestart && audioState.currentArea === area) {
    return;
  }

  stopAreaMusic();
  audioState.currentArea = area;
  scheduleAreaMusic(area);
}

function resetGame() {
  state.frame = 0;
  state.score = 0;
  state.coins = 0;
  state.area = 0;
  state.gameOver = false;
  state.scoreSubmitted = false;
  state.gameOverHandled = false;
  state.awaitingScoreEntry = false;
  state.status = "Press Space or tap to jump.";
  state.worldSpeed = 7;
  state.flyUntil = 0;
  state.magnetUntil = 0;
  state.blasterUntil = 0;
  state.invisibleUntil = 0;
  state.powerModeUntil = 0;
  state.nextShotFrame = 0;
  state.obstacles = [];
  state.coinsInWorld = [];
  state.pickups = [];
  state.projectiles = [];
  state.spawnTimer = 85;
  state.coinTimer = 140;
  state.pickupTimer = 950;
  Object.assign(state.horse, {
    y: GROUND_Y,
    vy: 0,
    jumpsLeft: 2,
    onGround: true,
  });
  playerNameInput.value = "";
  startAreaMusic(state.area, true);
}

function getAreaTheme() {
  const themes = [
    { sky: "#d9efff", ground: "#88c364", ground2: "#70ad54", mountain: "#bfd4c0" },
    { sky: "#ffd9b5", ground: "#cf9b60", ground2: "#b77b45", mountain: "#d4b39c" },
    { sky: "#d8e4ff", ground: "#9ec2d8", ground2: "#83acc5", mountain: "#cad3e2" },
    { sky: "#ddf6ff", ground: "#a9d07d", ground2: "#8dc260", mountain: "#ccd9b9" },
  ];
  return themes[state.area % themes.length];
}

function getActivePerk() {
  if (state.flyUntil > state.frame) return `Fly ${Math.ceil((state.flyUntil - state.frame) / 60)}s`;
  if (state.magnetUntil > state.frame) return `Magnet ${Math.ceil((state.magnetUntil - state.frame) / 60)}s`;
  if (state.blasterUntil > state.frame) return `Blaster ${Math.ceil((state.blasterUntil - state.frame) / 60)}s`;
  return "None";
}

function tryActivatePerk(perkName) {
  if (state.gameOver) return;
  if (state.coins < PERK_COSTS[perkName]) {
    state.status = `Need ${PERK_COSTS[perkName]} coins for ${perkName}.`;
    return;
  }

  state.coins -= PERK_COSTS[perkName];
  const duration = 10 * 60;
  if (perkName === "fly") state.flyUntil = state.frame + duration;
  if (perkName === "magnet") state.magnetUntil = state.frame + duration;
  if (perkName === "blaster") {
    state.blasterUntil = state.frame + duration;
    state.nextShotFrame = state.frame;
  }
  state.status = `${perkName} perk active for 10 seconds.`;
  playPerkSound();
}

function jump() {
  if (state.gameOver) return;
  if (state.flyUntil > state.frame) {
    state.horse.vy = -10.5;
    state.horse.onGround = false;
    playJumpSound();
    return;
  }
  if (state.horse.jumpsLeft > 0) {
    state.horse.vy = -16.5;
    state.horse.jumpsLeft -= 1;
    state.horse.onGround = false;
    playJumpSound();
  }
}

function buildObstacle(type, x) {
  const specs = {
    hay: { width: 50, height: 40, color: "#e9c861" },
    crate: { width: 42, height: 42, color: "#97653d" },
    spike: { width: 48, height: 28, color: "#d7dbe2" },
    mushroom: { width: 58, height: 42, color: "#d84b45" },
    brick: { width: 54, height: 54, color: "#c86c38" },
    pipe: { width: 56, height: 72, color: "#47ab45" },
  };
  const spec = specs[type];
  return {
    type,
    x,
    y: GROUND_Y - spec.height,
    width: spec.width,
    height: spec.height,
    color: spec.color,
    passed: false,
  };
}

function spawnObstacle() {
  const difficulty = Math.min(8, Math.floor(state.score / 1200));
  const types = ["hay", "crate", "spike", "mushroom", "brick", "pipe"];
  const type = types[Math.min(types.length - 1, Math.floor(Math.random() * (3 + difficulty / 2)))];
  state.obstacles.push(buildObstacle(type, WIDTH + 120 + Math.random() * 80));
}

function spawnCoins() {
  const startX = WIDTH + 80;
  const baseY = [GROUND_Y - 80, GROUND_Y - 130, GROUND_Y - 180][Math.floor(Math.random() * 3)];
  for (let index = 0; index < 4; index += 1) {
    state.coinsInWorld.push({
      x: startX + index * 34,
      y: baseY - Math.abs(index - 1.5) * 14,
      size: 10,
      spin: index * 5,
    });
  }
}

function spawnApple() {
  const yOptions = [GROUND_Y - 90, GROUND_Y - 145, GROUND_Y - 200];
  state.pickups.push({
    x: WIDTH + 120 + Math.random() * 140,
    y: yOptions[Math.floor(Math.random() * yOptions.length)],
    size: 16,
    pulse: Math.random() * Math.PI * 2,
  });
}

function activateApplePower() {
  state.invisibleUntil = state.frame + 10 * 60;
  state.powerModeUntil = state.frame + 10 * 60;
  state.status = "Apple power active: invisibility for 10 seconds.";
  playAppleSound();
  startAreaMusic("power", true);
}

function updateHorse() {
  const horse = state.horse;
  if (state.flyUntil > state.frame) {
    horse.vy += 0.55;
    horse.vy = Math.max(-11.5, Math.min(7.5, horse.vy));
    horse.y += horse.vy;
    horse.y = Math.max(110, Math.min(GROUND_Y, horse.y));
  } else {
    horse.vy += 0.9;
    horse.y += horse.vy;
  }

  if (horse.y >= GROUND_Y) {
    horse.y = GROUND_Y;
    horse.vy = 0;
    horse.onGround = true;
    horse.jumpsLeft = 2;
  }
}

function updateWorld() {
  state.frame += 1;
  const previousArea = state.area;
  state.area = Math.floor(state.score / 2500) % 4;
  state.worldSpeed = 7 + Math.min(8, Math.floor(state.score / 2500)) * 0.5;
  state.score += 1;
  const desiredMusic = state.powerModeUntil > state.frame ? "power" : state.area;
  if (desiredMusic !== audioState.currentArea || state.area !== previousArea) {
    startAreaMusic(desiredMusic, true);
  }

  state.spawnTimer -= 1;
  if (state.spawnTimer <= 0) {
    spawnObstacle();
    state.spawnTimer = 55 + Math.random() * 45;
  }

  state.coinTimer -= 1;
  if (state.coinTimer <= 0) {
    spawnCoins();
    state.coinTimer = 110 + Math.random() * 70;
  }

  state.pickupTimer -= 1;
  if (state.pickupTimer <= 0) {
    spawnApple();
    state.pickupTimer = 900 + Math.random() * 600;
  }

  for (const cloud of state.clouds) {
    cloud.x -= cloud.speed;
    if (cloud.x < -120) {
      cloud.x = WIDTH + 60;
    }
  }

  for (const obstacle of state.obstacles) {
    obstacle.x -= state.worldSpeed;
    if (!obstacle.passed && obstacle.x + obstacle.width < state.horse.x) {
      obstacle.passed = true;
      state.score += 24;
    }
  }
  state.obstacles = state.obstacles.filter((item) => item.x + item.width > -30);

  for (const coin of state.coinsInWorld) {
    if (state.magnetUntil > state.frame) {
      const dx = state.horse.x + 90 - coin.x;
      const dy = state.horse.y - 60 - coin.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = Math.min(distance, Math.max(14, state.worldSpeed + distance * 0.14));
      coin.x += (dx / distance) * pull;
      coin.y += (dy / distance) * pull;
    } else {
      coin.x -= state.worldSpeed;
    }
    coin.spin += 1.2;
  }
  state.coinsInWorld = state.coinsInWorld.filter((coin) => coin.x > -30);

  for (const pickup of state.pickups) {
    pickup.x -= state.worldSpeed;
    pickup.pulse += 0.12;
  }
  state.pickups = state.pickups.filter((pickup) => pickup.x > -40);

  if (state.blasterUntil > state.frame && state.frame >= state.nextShotFrame) {
    const target = state.obstacles[0];
    state.projectiles.push({
      x: state.horse.x + 170,
      y: state.horse.y - 90,
      vx: target ? 15 : 15,
      vy: target ? ((target.y + target.height / 2) - (state.horse.y - 90)) / 25 : 0,
      size: 7,
    });
    state.nextShotFrame = state.frame + 10;
    playBlasterSound();
  }

  for (const projectile of state.projectiles) {
    projectile.x += projectile.vx;
    projectile.y += projectile.vy;
  }
  state.projectiles = state.projectiles.filter((item) => item.x < WIDTH + 20);
}

function checkCollisions() {
  const horse = state.horse;
  const horseBox = {
    left: horse.x + 20,
    right: horse.x + horse.width - 12,
    top: horse.y - horse.height + 16,
    bottom: horse.y,
  };

  for (const coin of [...state.coinsInWorld]) {
    const nearMagnet = state.magnetUntil > state.frame
      && Math.hypot(state.horse.x + 90 - coin.x, state.horse.y - 60 - coin.y) < 52;
    const overlap = (
      horseBox.left < coin.x + coin.size &&
      horseBox.right > coin.x - coin.size &&
      horseBox.top < coin.y + coin.size &&
      horseBox.bottom > coin.y - coin.size
    );
    if (nearMagnet || overlap) {
      state.coinsInWorld.splice(state.coinsInWorld.indexOf(coin), 1);
      state.coins += 1;
      state.score += 8;
      playCoinSound();
    }
  }

  for (const pickup of [...state.pickups]) {
    const overlap = (
      horseBox.left < pickup.x + pickup.size &&
      horseBox.right > pickup.x - pickup.size &&
      horseBox.top < pickup.y + pickup.size &&
      horseBox.bottom > pickup.y - pickup.size
    );
    if (overlap) {
      state.pickups.splice(state.pickups.indexOf(pickup), 1);
      activateApplePower();
      state.score += 120;
    }
  }

  for (const projectile of [...state.projectiles]) {
    for (const obstacle of [...state.obstacles]) {
      const hit = (
        projectile.x + projectile.size > obstacle.x &&
        projectile.x - projectile.size < obstacle.x + obstacle.width &&
        projectile.y + projectile.size > obstacle.y &&
        projectile.y - projectile.size < obstacle.y + obstacle.height
      );
      if (hit) {
        state.projectiles.splice(state.projectiles.indexOf(projectile), 1);
        state.obstacles.splice(state.obstacles.indexOf(obstacle), 1);
        state.score += 30;
        break;
      }
    }
  }

  for (const obstacle of state.obstacles) {
    const overlap = (
      horseBox.left < obstacle.x + obstacle.width - 6 &&
      horseBox.right > obstacle.x + 6 &&
      horseBox.top < obstacle.y + obstacle.height &&
      horseBox.bottom > obstacle.y
    );
    if (overlap) {
      if (state.invisibleUntil > state.frame) {
        continue;
      }
      state.gameOver = true;
      state.status = `Game over. Final score: ${state.score}`;
      stopAreaMusic();
      playCrashSound();
      return;
    }
  }
}

function drawCloud(x, y, scale) {
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  ctx.beginPath();
  ctx.ellipse(x, y, 35 * scale, 18 * scale, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 28 * scale, y - 8 * scale, 30 * scale, 20 * scale, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 54 * scale, y, 32 * scale, 18 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawHorse() {
  const horse = state.horse;
  const x = horse.x;
  const groundY = horse.y;
  const invisibleFlash = state.invisibleUntil > state.frame && Math.floor(state.frame / 6) % 2 === 0;
  const bodyFill = invisibleFlash ? "#c8dced" : "#9b6338";
  const bodyStroke = invisibleFlash ? "#8ba1b3" : "#704522";
  ctx.fillStyle = bodyFill;
  ctx.strokeStyle = bodyStroke;
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.ellipse(x + 72, groundY - 52, 52, 28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(x + 155, groundY - 108, 26, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = invisibleFlash ? "#d8ebf8" : "#87552f";
  ctx.strokeStyle = bodyStroke;
  ctx.beginPath();
  ctx.moveTo(x + 146, groundY - 126);
  ctx.lineTo(x + 151, groundY - 148);
  ctx.lineTo(x + 160, groundY - 128);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 161, groundY - 124);
  ctx.lineTo(x + 168, groundY - 146);
  ctx.lineTo(x + 176, groundY - 124);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x + 108, groundY - 80);
  ctx.lineTo(x + 142, groundY - 118);
  ctx.lineTo(x + 132, groundY - 72);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = bodyStroke;
  ctx.lineWidth = 6;
  for (const legX of [44, 66, 94, 114]) {
    ctx.beginPath();
    ctx.moveTo(x + legX, groundY - 24);
    ctx.lineTo(x + legX, groundY);
    ctx.stroke();
  }

  if (state.powerModeUntil > state.frame) {
    ctx.fillStyle = "#3056c9";
    ctx.fillRect(x + 132, groundY - 122, 28, 12);
    ctx.fillStyle = "#ffd84d";
    ctx.beginPath();
    ctx.moveTo(x + 146, groundY - 120);
    ctx.lineTo(x + 154, groundY - 112);
    ctx.lineTo(x + 146, groundY - 104);
    ctx.lineTo(x + 138, groundY - 112);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#d94242";
    ctx.beginPath();
    ctx.moveTo(x + 122, groundY - 84);
    ctx.lineTo(x + 112, groundY - 110);
    ctx.lineTo(x + 94, groundY - 58);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#3056c9";
    ctx.beginPath();
    ctx.ellipse(x + 156, groundY - 109, 20, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f5f7fb";
    ctx.beginPath();
    ctx.ellipse(x + 150, groundY - 111, 3, 2, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 162, groundY - 111, 3, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawObstacle(obstacle) {
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath();
  ctx.ellipse(obstacle.x + obstacle.width / 2, GROUND_Y - 2, obstacle.width / 2, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  if (obstacle.type === "spike") {
    ctx.fillStyle = "#d6d8dd";
    ctx.strokeStyle = "#4a535f";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(obstacle.x, GROUND_Y);
    ctx.lineTo(obstacle.x + 10, obstacle.y + 12);
    ctx.lineTo(obstacle.x + 20, GROUND_Y);
    ctx.lineTo(obstacle.x + 30, obstacle.y);
    ctx.lineTo(obstacle.x + obstacle.width, GROUND_Y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return;
  }

  if (obstacle.type === "mushroom") {
    ctx.fillStyle = "#f4e5cc";
    ctx.fillRect(obstacle.x + 20, obstacle.y + 18, 16, obstacle.height - 18);
    ctx.fillStyle = "#d94242";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + obstacle.width / 2, obstacle.y + 16, obstacle.width / 2, 16, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.fillStyle = obstacle.color;
  ctx.strokeStyle = obstacle.type === "pipe" ? "#155d22" : "#653f1f";
  ctx.lineWidth = 3;
  ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
  ctx.strokeRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);

  if (obstacle.type === "brick") {
    ctx.strokeStyle = "#8a3c1d";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(obstacle.x, obstacle.y + 18);
    ctx.lineTo(obstacle.x + obstacle.width, obstacle.y + 18);
    ctx.moveTo(obstacle.x, obstacle.y + 36);
    ctx.lineTo(obstacle.x + obstacle.width, obstacle.y + 36);
    ctx.stroke();
  }
}

function drawCoin(coin) {
  const squeeze = Math.max(4, coin.size * (1 - Math.abs(((coin.spin % 20) - 10) / 10) * 0.62));
  ctx.fillStyle = "#f7d24e";
  ctx.strokeStyle = "#b78b1c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(coin.x, coin.y, squeeze, coin.size, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawPickup(pickup) {
  const glow = 1 + Math.sin(pickup.pulse) * 0.12;
  ctx.fillStyle = "rgba(255, 214, 190, 0.35)";
  ctx.beginPath();
  ctx.arc(pickup.x, pickup.y, pickup.size * 1.35 * glow, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#df3939";
  ctx.strokeStyle = "#9b1f1f";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(pickup.x, pickup.y, pickup.size, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#5f8d34";
  ctx.fillRect(pickup.x - 2, pickup.y - pickup.size - 6, 4, 8);
  ctx.beginPath();
  ctx.moveTo(pickup.x, pickup.y - pickup.size - 4);
  ctx.lineTo(pickup.x + 8, pickup.y - pickup.size - 12);
  ctx.lineTo(pickup.x + 4, pickup.y - pickup.size - 3);
  ctx.closePath();
  ctx.fill();
}

function drawProjectile(projectile) {
  ctx.fillStyle = "#7ec8ff";
  ctx.beginPath();
  ctx.arc(projectile.x, projectile.y, projectile.size, 0, Math.PI * 2);
  ctx.fill();
}

function drawScene() {
  const theme = getAreaTheme();
  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = theme.sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = theme.mountain;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(180, 180);
  ctx.lineTo(340, GROUND_Y);
  ctx.lineTo(500, 200);
  ctx.lineTo(700, GROUND_Y);
  ctx.lineTo(870, 210);
  ctx.lineTo(WIDTH, GROUND_Y);
  ctx.closePath();
  ctx.fill();

  for (const cloud of state.clouds) {
    drawCloud(cloud.x, cloud.y, cloud.size);
  }

  ctx.fillStyle = theme.ground;
  ctx.fillRect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y);
  ctx.fillStyle = theme.ground2;
  ctx.fillRect(0, GROUND_Y + 20, WIDTH, HEIGHT - GROUND_Y - 20);

  for (const obstacle of state.obstacles) drawObstacle(obstacle);
  for (const pickup of state.pickups) drawPickup(pickup);
  for (const coin of state.coinsInWorld) drawCoin(coin);
  for (const projectile of state.projectiles) drawProjectile(projectile);
  drawHorse();

  if (state.gameOver) {
    ctx.fillStyle = "rgba(255, 249, 239, 0.96)";
    ctx.fillRect(270, 170, 420, 140);
    ctx.strokeStyle = "#91573a";
    ctx.lineWidth = 4;
    ctx.strokeRect(270, 170, 420, 140);
    ctx.fillStyle = "#8f3029";
    ctx.font = "bold 34px Trebuchet MS";
    ctx.fillText("Game Over", 390, 225);
    ctx.fillStyle = "#5f4630";
    ctx.font = "18px Trebuchet MS";
    ctx.fillText("Confirm your name to save or skip", 332, 265);
  }
}

function syncHud() {
  scoreValue.textContent = `${state.score}`;
  coinValue.textContent = `${state.coins}`;
  areaValue.textContent = `${state.area + 1}`;
  perkValue.textContent = getActivePerk();
  statusText.textContent = state.status;
  scoreSubmitButton.textContent = state.awaitingScoreEntry ? "Confirm Result" : "Confirm";
  scorePromptText.textContent = state.awaitingScoreEntry
    ? "Game paused. Enter a name and confirm to save, or press Space / confirm empty to restart."
    : "Enter a name after game over to save your score.";
  playerNameInput.disabled = !state.awaitingScoreEntry;
  scoreSubmitButton.disabled = !state.awaitingScoreEntry;
  restartButton.disabled = state.awaitingScoreEntry;
  jumpButton.disabled = state.awaitingScoreEntry;

  for (const button of perkButtons) {
    const perk = button.dataset.perk;
    const affordable = state.coins >= PERK_COSTS[perk];
    button.style.outline = affordable ? "3px solid #d5a62c" : "none";
    button.style.opacity = affordable ? "1" : "0.82";
    button.disabled = state.awaitingScoreEntry;
  }
}

async function renderLeaderboard() {
  const scores = await leaderboard.listTopScores();
  leaderboardList.innerHTML = "";
  for (const entry of scores.slice(0, 10)) {
    const item = document.createElement("li");
    item.textContent = `${entry.name} - ${entry.score}`;
    leaderboardList.appendChild(item);
  }
  leaderboardMode.textContent = `Mode: ${leaderboard.mode} leaderboard`;
}

async function submitCurrentScore() {
  if (!state.awaitingScoreEntry || state.scoreSubmitted || state.score <= 0) return;
  const enteredName = playerNameInput.value.trim();
  if (!enteredName) {
    state.scoreSubmitted = true;
    state.awaitingScoreEntry = false;
    state.status = "No name entered, score skipped. Restarting.";
    resetGame();
    return;
  }
  await leaderboard.submitScore(enteredName, state.score);
  state.scoreSubmitted = true;
  state.awaitingScoreEntry = false;
  state.status = `Saved score for ${enteredName}. Press Restart or Space to play again.`;
  await renderLeaderboard();
}

function tick() {
  if (!state.gameOver) {
    updateHorse();
    updateWorld();
    checkCollisions();
  }
  drawScene();
  syncHud();
  if (state.gameOver && !state.gameOverHandled) {
    state.gameOverHandled = true;
    state.awaitingScoreEntry = true;
    state.status = "Game over. Enter your name, then confirm your result.";
    playerNameInput.focus();
    playerNameInput.select();
  }
  requestAnimationFrame(tick);
}

document.addEventListener("keydown", (event) => {
  unlockAudio();
  if (event.code === "Space") {
    event.preventDefault();
    if (state.gameOver && state.awaitingScoreEntry && !playerNameInput.value.trim()) {
      state.scoreSubmitted = true;
      state.awaitingScoreEntry = false;
      state.status = "No name entered, score skipped. Restarting.";
      resetGame();
    } else if (state.gameOver && !state.awaitingScoreEntry) {
      resetGame();
    } else if (!state.gameOver) {
      jump();
    }
  }
  if (!state.awaitingScoreEntry) {
    if (event.key === "1") tryActivatePerk("fly");
    if (event.key === "2") tryActivatePerk("magnet");
    if (event.key === "3") tryActivatePerk("blaster");
  }
});

canvas.addEventListener("pointerdown", () => {
  unlockAudio();
  if (state.gameOver && !state.awaitingScoreEntry) {
    resetGame();
  } else if (!state.awaitingScoreEntry) {
    jump();
  }
});

jumpButton.addEventListener("click", () => {
  unlockAudio();
  if (!state.awaitingScoreEntry && !state.gameOver) {
    jump();
  }
});

restartButton.addEventListener("click", () => {
  unlockAudio();
  resetGame();
});

for (const button of perkButtons) {
  button.addEventListener("click", () => {
    unlockAudio();
    tryActivatePerk(button.dataset.perk);
  });
}

scoreForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitCurrentScore();
});

renderLeaderboard();
syncHud();
tick();
