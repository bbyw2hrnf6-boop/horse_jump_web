const LOCAL_STORAGE_KEY = "horse-jump-web-local-leaderboard";
const SETTINGS_STORAGE_KEY = "horse-jump-web-settings";
const LEADERBOARD_PAGE_SIZE = 20;
const SCORE_MODES = {
  normal: "normal",
  hardcore: "hardcore",
};
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAukUvsI-plRUwP_dX34v-xGe34yERqoSI",
  authDomain: "horse-jump-scoreboard.firebaseapp.com",
  projectId: "horse-jump-scoreboard",
  storageBucket: "horse-jump-scoreboard.firebasestorage.app",
  messagingSenderId: "987391243862",
  appId: "1:987391243862:web:dc172a9e30d846c74eadf7",
};
const FIRESTORE_COLLECTION = "leaderboardScores";

class LeaderboardService {
  constructor() {
    this.mode = "initializing";
    this.db = null;
    this.firebaseReady = false;
    this.firebaseFns = null;
    this.pageCursors = new Map();
    this.lastError = "";
    this.lastWriteOnline = null;
    this.ready = this.initFirebase();
  }

  getModeCursors(gameMode) {
    if (!this.pageCursors.has(gameMode)) {
      this.pageCursors.set(gameMode, [null]);
    }
    return this.pageCursors.get(gameMode);
  }

  async initFirebase() {
    try {
      const [{ initializeApp }, firestoreModule] = await Promise.all([
        import("https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js"),
      ]);
      const app = initializeApp(FIREBASE_CONFIG);
      this.db = firestoreModule.getFirestore(app);
      this.firebaseFns = firestoreModule;
      this.firebaseReady = true;
      this.mode = "firebase";
    } catch (error) {
      this.lastError = this.formatError(error);
      this.mode = "local";
    }
  }

  resetPagination() {
    this.pageCursors = new Map();
  }

  sortScores(scores) {
    return [...scores].sort((a, b) => b.score - a.score);
  }

  formatError(error) {
    const code = error?.code ? `${error.code}: ` : "";
    return `${code}${error?.message || error || "unknown error"}`.replace(/\.+$/, ".");
  }

  scoreKey(entry) {
    return `${entry.gameMode}|${entry.name}|${entry.score}`;
  }

  mergeScores(...scoreLists) {
    const merged = new Map();
    for (const scores of scoreLists) {
      for (const score of scores) {
        const key = this.scoreKey(score);
        const previous = merged.get(key);
        if (!previous || (!previous.createdAt && score.createdAt)) {
          merged.set(key, score);
        }
      }
    }
    return this.sortScores([...merged.values()]);
  }

  normalizeScoreEntry(data) {
    const gameMode = data.gameMode === SCORE_MODES.hardcore ? SCORE_MODES.hardcore : SCORE_MODES.normal;
    return {
      name: typeof data.name === "string" ? data.name : "Player",
      score: Number.isFinite(data.score) ? data.score : 0,
      gameMode,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() || (typeof data.createdAt === "string" ? data.createdAt : null),
      localOnly: Boolean(data.localOnly),
    };
  }

  async readFirebaseScores(gameMode) {
    const scoresRef = this.firebaseFns.collection(this.db, FIRESTORE_COLLECTION);
    const scoreQuery = gameMode === SCORE_MODES.hardcore
      ? this.firebaseFns.query(scoresRef, this.firebaseFns.where("gameMode", "==", SCORE_MODES.hardcore))
      : scoresRef;
    const snapshot = await this.firebaseFns.getDocs(scoreQuery);
    return this.sortScores(
      snapshot.docs
        .map((doc) => this.normalizeScoreEntry(doc.data()))
        .filter((entry) => entry.gameMode === gameMode)
    );
  }

  async listScorePage(pageIndex = 0, pageSize = LEADERBOARD_PAGE_SIZE, gameMode = SCORE_MODES.normal) {
    await this.ready;
    if (this.firebaseReady && this.db && this.firebaseFns) {
      try {
        const firebaseScores = await this.readFirebaseScores(gameMode);
        const localScores = this.readLocalScores(gameMode);
        const scores = this.mergeScores(firebaseScores, localScores);
        const start = pageIndex * pageSize;
        this.mode = localScores.length ? "firebase+local" : "firebase";
        return {
          scores: scores.slice(start, start + pageSize),
          pageIndex,
          hasPrevious: pageIndex > 0,
          hasNext: start + pageSize < scores.length,
        };
      } catch (error) {
        this.lastError = this.formatError(error);
        this.mode = "local-fallback";
      }
    }
    const allScores = this.readLocalScores(gameMode);
    const start = pageIndex * pageSize;
    return {
      scores: allScores.slice(start, start + pageSize),
      pageIndex,
      hasPrevious: pageIndex > 0,
      hasNext: start + pageSize < allScores.length,
    };
  }

  async listTopScores(gameMode = SCORE_MODES.normal) {
    const page = await this.listScorePage(0, LEADERBOARD_PAGE_SIZE, gameMode);
    return page.scores;
  }

  async submitScore(name, score, gameMode = SCORE_MODES.normal) {
    const safeName = (name || "Player").trim().slice(0, 14) || "Player";
    this.lastWriteOnline = false;
    this.lastError = "";
    await this.ready;
    if (this.firebaseReady && this.db && this.firebaseFns) {
      try {
        await this.firebaseFns.addDoc(this.firebaseFns.collection(this.db, FIRESTORE_COLLECTION), {
          name: safeName,
          score,
          gameMode,
          createdAt: this.firebaseFns.serverTimestamp(),
        });
        this.mode = "firebase";
        this.resetPagination();
        this.lastWriteOnline = true;
        return this.listTopScores(gameMode);
      } catch (error) {
        this.lastError = this.formatError(error);
        this.mode = "local-fallback";
      }
    }
    const entries = this.readLocalScores();
    entries.push({
      name: safeName,
      score,
      gameMode,
      createdAt: new Date().toISOString(),
      localOnly: true,
    });
    entries.sort((a, b) => b.score - a.score);
    const trimmed = entries.slice(0, 500);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(trimmed));
    this.resetPagination();
    return this.readLocalScores(gameMode).slice(0, LEADERBOARD_PAGE_SIZE);
  }

  readLocalScores(gameMode = null) {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        const scores = parsed
          .map((entry) => this.normalizeScoreEntry(entry))
          .sort((a, b) => b.score - a.score);
        return gameMode ? scores.filter((entry) => entry.gameMode === gameMode) : scores;
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
const updatesList = document.getElementById("updatesList");
const updatesToggleButton = document.getElementById("updatesToggleButton");
const leaderboardTitle = document.querySelector("#leaderboardPanel h2");
const leaderboardList = document.getElementById("leaderboardList");
const leaderboardMode = document.getElementById("leaderboardMode");
const leaderboardPrevButton = document.getElementById("leaderboardPrevButton");
const leaderboardNextButton = document.getElementById("leaderboardNextButton");
const leaderboardPageLabel = document.getElementById("leaderboardPageLabel");
const scoreForm = document.getElementById("scoreForm");
const playerNameInput = document.getElementById("playerName");
const scoreSubmitButton = document.getElementById("scoreSubmitButton");
const scorePromptText = document.getElementById("scorePromptText");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const finalScoreValue = document.getElementById("finalScoreValue");
const overlayRestartButton = document.getElementById("overlayRestartButton");
const statusText = document.getElementById("statusText");
const pauseButton = document.getElementById("pauseButton");
const fullscreenButton = document.getElementById("fullscreenButton");
const introOverlay = document.getElementById("introOverlay");
const pauseOverlay = document.getElementById("pauseOverlay");
const startGameButton = document.getElementById("startGameButton");
const introTitle = document.getElementById("introTitle");
const introCopy = document.getElementById("introCopy");
const introMobileCopy = document.getElementById("introMobileCopy");
const introControlsTitle = document.getElementById("introControlsTitle");
const introControlsCopy = document.getElementById("introControlsCopy");
const introPowerTitle = document.getElementById("introPowerTitle");
const introPowerCopy = document.getElementById("introPowerCopy");
const introGoalTitle = document.getElementById("introGoalTitle");
const introGoalCopy = document.getElementById("introGoalCopy");
const resumeGameButton = document.getElementById("resumeGameButton");
const gamePanel = document.getElementById("gamePanel");
const gameStage = document.getElementById("gameStage");
const playfield = document.getElementById("playfield");
const settingsButton = document.getElementById("settingsButton");
const settingsOverlay = document.getElementById("settingsOverlay");
const closeSettingsButton = document.getElementById("closeSettingsButton");
const darkModeToggle = document.getElementById("darkModeToggle");
const hardcoreToggle = document.getElementById("hardcoreToggle");
const hardcoreQuickToggle = document.getElementById("hardcoreQuickToggle");
const soundToggle = document.getElementById("soundToggle");
const hardcorePromoStatus = document.getElementById("hardcorePromoStatus");
const perkButtons = [...document.querySelectorAll(".perk-button")];

const leaderboard = new LeaderboardService();

const CANVAS_WIDTH = 960;
const DESKTOP_CANVAS_HEIGHT = 640;
const MOBILE_CANVAS_HEIGHT = 840;
const mobileCanvasQuery = window.matchMedia("(max-width: 720px)");
const CANVAS_HEIGHT = mobileCanvasQuery.matches ? MOBILE_CANVAS_HEIGHT : DESKTOP_CANVAS_HEIGHT;
const CANVAS_PIXEL_RATIO = Math.min(2, window.devicePixelRatio || 1);
canvas.width = Math.round(CANVAS_WIDTH * CANVAS_PIXEL_RATIO);
canvas.height = Math.round(CANVAS_HEIGHT * CANVAS_PIXEL_RATIO);
canvas.style.aspectRatio = `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`;
ctx.setTransform(CANVAS_PIXEL_RATIO, 0, 0, CANVAS_PIXEL_RATIO, 0, 0);

const WIDTH = CANVAS_WIDTH;
const HEIGHT = CANVAS_HEIGHT;
const GROUND_Y = Math.round(HEIGHT * 0.725);
const OBSTACLE_SCALE = 1.24;
const PICKUP_SCALE = 1.16;
const SIMULATION_STEP_MS = 1000 / 60;
const MAX_SIMULATION_STEPS = 4;
const FRIDAY_EVENT_ACTIVE = new Date().getDay() === 5;
const PERK_COSTS = { fly: 35, magnet: 8, blaster: 32 };
const PERK_LABELS = { fly: "Fly", magnet: "Magnet", blaster: "Carrot Blaster" };
const COLLAPSED_UPDATE_COUNT = 3;
const EXPANDED_UPDATE_COUNT = 6;
const INTRO_CONTENT = {
  normal: {
    title: "Welcome to Horse Jump Web",
    copy: "Stay alive as long as you can by jumping over obstacles, collecting coins, and choosing the right perks at the right time.",
    mobileCopy: "Tap to jump. Grab coins. Survive.",
    controlsTitle: "Controls",
    controlsCopy: "`Space` or tap to jump, `1` `2` `3` to buy perks, and `P` to pause.",
    powerTitle: "Power Ups",
    powerCopy: "Red apples protect you for 10 seconds. Rotten apples only boost speed, so they are risky.",
    goalTitle: "Goal",
    goalCopy: "Build score, pass obstacles cleanly, and stack enough coins to buy game-saving perks.",
    startLabel: "Start Run",
  },
  hardcore: {
    title: "Hardcore Mode: Boss Rush",
    copy: "Hardcore adds darker maps, flying enemies, boss fights, weapons, and a separate Hardcore leaderboard. Survive the run, then defeat each boss.",
    mobileCopy: "Tap to jump. Boss fight: drag left/right. Grab weapons.",
    controlsTitle: "Hardcore Controls",
    controlsCopy: "`Space` or tap to jump. Boss fights: use `A/D`, arrow keys, or mobile drag to dodge targeted attacks.",
    powerTitle: "Boss Tools",
    powerCopy: "Collect boss weapons for spread, laser, or mega carrots. Red apples still protect you, rotten apples only make you faster.",
    goalTitle: "Hardcore Goal",
    goalCopy: "Beat Dino, Crab, Biber, Alien, and Bigfood, then save your score to the Hardcore-only leaderboard.",
    startLabel: "Start Hardcore",
  },
};
const GAME_UPDATES = [
  {
    dateTime: "2026-05-21T17:14:00+02:00",
    displayTime: "May 21, 2026 at 17:14",
    title: "Hardcore How To Play",
    description: "The start instructions now switch for Hardcore mode, and the in-game pause, settings, and fullscreen controls are easier to tap.",
  },
  {
    dateTime: "2026-05-21T16:58:00+02:00",
    displayTime: "May 21, 2026 at 16:58",
    title: "Pixel Boss Art",
    description: "Hardcore bosses now use image-inspired pixel-art drawings with animated claws, fur, UFO beams, roaring jaws, and left-facing horse movement in boss fights.",
  },
  {
    dateTime: "2026-05-21T16:36:00+02:00",
    displayTime: "May 21, 2026 at 16:36",
    title: "Fullscreen And Bigger Bosses",
    description: "Desktop now has a tiny fullscreen button, Hardcore adds Alien and Bigfoot bosses, bosses have more HP, and boss attacks now aim at the horse.",
  },
  {
    dateTime: "2026-05-21T13:58:00+02:00",
    displayTime: "May 21, 2026 at 13:58",
    title: "Smoother Hardcore Balance",
    description: "Hardcore now keeps normal ground-obstacle pacing, birds use safer lanes, boss touch movement is smoother, and key obstacles have extra 3D polish.",
  },
  {
    dateTime: "2026-05-21T00:08:00+02:00",
    displayTime: "May 21, 2026 at 00:08",
    title: "Boss Fight Clarity",
    description: "Boss fights now show a tiny dodge hint, play boss-specific music, and use unique Dino, Crab, and Biber attacks.",
  },
  {
    dateTime: "2026-05-20T23:04:00+02:00",
    displayTime: "May 20, 2026 at 23:04",
    title: "Leaderboard Save Diagnostics",
    description: "Scores now fall back visibly to local saves when Firebase blocks online writes, while normal and hardcore filters stay separated.",
  },
  {
    dateTime: "2026-05-20T21:23:00+02:00",
    displayTime: "May 20, 2026 at 21:23",
    title: "Hardcore Leaderboard Fix",
    description: "Hardcore scores now save and display in the hardcore-only leaderboard, even when switching modes during loading.",
  },
  {
    dateTime: "2026-05-20T20:46:00+02:00",
    displayTime: "May 20, 2026 at 20:46",
    title: "Hardcore Banner And Spooky Mode",
    description: "The top banner now promotes Hardcore Mode with a quick toggle, and hardcore runs use darker lava-and-ghost scenery.",
  },
  {
    dateTime: "2026-05-20T20:39:00+02:00",
    displayTime: "May 20, 2026 at 20:39",
    title: "Hardcore Promo Banner",
    description: "The top banner now promotes Hardcore Mode with boss badges, carrot-weapon hype, and a live hardcore status.",
  },
  {
    dateTime: "2026-05-20T20:33:00+02:00",
    displayTime: "May 20, 2026 at 20:33",
    title: "Bigger Boss Arena",
    description: "Boss fights now zoom out, bosses have more HP, and the mobile intro is much smaller.",
  },
  {
    dateTime: "2026-05-20T18:05:00+02:00",
    displayTime: "May 20, 2026 at 18:05",
    title: "Moving Bosses And Weapon Pickups",
    description: "Boss fights now have more boss life, active boss movement, and collectible temporary weapons like triple shot, laser carrots, and mega carrots.",
  },
  {
    dateTime: "2026-05-20T17:42:00+02:00",
    displayTime: "May 20, 2026 at 17:42",
    title: "Hardcore Boss Arenas",
    description: "Hardcore bosses now freeze the runner, give 3 boss-fight hearts, unlock auto carrot blaster, and cycle through Dinosaur, Crab, and Biber fights.",
  },
  {
    dateTime: "2026-05-20T17:18:00+02:00",
    displayTime: "May 20, 2026 at 17:18",
    title: "Distinct Seasons And 3D Obstacles",
    description: "Each season now has a stronger identity, including alpine winter scenery, richer ground details, and more dimensional obstacle art.",
  },
  {
    dateTime: "2026-05-20T16:55:00+02:00",
    displayTime: "May 20, 2026 at 16:55",
    title: "Cleaner Hardcore And Scenic Backgrounds",
    description: "Hardcore mode now spaces threats out better, settings moved outside the playfield, and the scrolling landscape has richer animated layers.",
  },
  {
    dateTime: "2026-05-20T16:28:00+02:00",
    displayTime: "May 20, 2026 at 16:28",
    title: "Settings And Hardcore Mode",
    description: "A new gear menu adds dark mode, sound control, and hardcore mode with flying enemies and boss waves.",
  },
  {
    dateTime: "2026-05-20T16:18:00+02:00",
    displayTime: "May 20, 2026 at 16:18",
    title: "HD Obstacle Details",
    description: "Obstacles have sharper layered drawings, extra highlights, and more detailed canvas styling.",
  },
  {
    dateTime: "2026-05-20T15:48:00+02:00",
    displayTime: "May 20, 2026 at 15:48",
    title: "Tiny Mobile Intro",
    description: "The phone landscape start popup is now much smaller, with only the essentials and a quick start button.",
  },
  {
    dateTime: "2026-05-20T15:34:00+02:00",
    displayTime: "May 20, 2026 at 15:34",
    title: "Phone Landscape Start Fix",
    description: "Landscape phones now open directly on the centered playfield, with the intro popup visible inside the game area.",
  },
  {
    dateTime: "2026-05-20T15:08:00+02:00",
    displayTime: "May 20, 2026 at 15:08",
    title: "Landscape Mobile Focus",
    description: "Phone landscape now scrolls toward the playfield and keeps the gameplay centered before sidebar content.",
  },
  {
    dateTime: "2026-05-20T14:16:00+02:00",
    displayTime: "May 20, 2026 at 14:16",
    title: "Intro And Pause Flow",
    description: "The game now opens with a short how-to-play intro and supports pausing with a button, P, or Escape.",
  },
  {
    dateTime: "2026-05-20T14:09:00+02:00",
    displayTime: "May 20, 2026 at 14:09",
    title: "Richer Obstacle Pass",
    description: "Obstacles now include extra themed variants and more visual detail to make each run feel less repetitive.",
  },
  {
    dateTime: "2026-05-20T11:42:00+02:00",
    displayTime: "May 20, 2026 at 11:42",
    title: "Live Status Bar",
    description: "The game now shows a real in-game status bar with the Horse Jump Web title and live gameplay messages.",
  },
  {
    dateTime: "2026-05-20T11:30:00+02:00",
    displayTime: "May 20, 2026 at 11:30",
    title: "Game Headline Added",
    description: "A proper Horse Jump Web headline and subtitle now sit above the playfield for a clearer game identity.",
  },
  {
    dateTime: "2026-05-20T11:18:00+02:00",
    displayTime: "May 20, 2026 at 11:18",
    title: "Rotten Apple Risk Fix",
    description: "Rotten apples still boost speed, but they no longer protect you from dying like red apples do.",
  },
  {
    dateTime: "2026-05-19T18:39:00+02:00",
    displayTime: "May 19, 2026 at 18:39",
    title: "Expandable Updates",
    description: "Latest Updates now opens from 3 to 6 deployments, and the leaderboard intro text was removed.",
  },
  {
    dateTime: "2026-05-19T18:12:00+02:00",
    displayTime: "May 19, 2026 at 18:12",
    title: "Taller Mobile Field",
    description: "Mobile gets more vertical gameplay space, and perks use the same smaller translucent style as the mini HUD.",
  },
  {
    dateTime: "2026-05-19T18:07:00+02:00",
    displayTime: "May 19, 2026 at 18:07",
    title: "In-Game Mini HUD",
    description: "Score, coins, area, and active perk now sit inside the playfield as a tiny translucent overlay.",
  },
  {
    dateTime: "2026-05-19T18:03:00+02:00",
    displayTime: "May 19, 2026 at 18:03",
    title: "Taller Game View",
    description: "The playfield is taller on desktop and mobile while horse, obstacle, and horizontal spacing stay the same.",
  },
  {
    dateTime: "2026-05-19T17:59:00+02:00",
    displayTime: "May 19, 2026 at 17:59",
    title: "Smaller Perk Warning",
    description: "Expiring perk warnings are now a compact badge, so they cover less of the gameplay.",
  },
  {
    dateTime: "2026-05-19T17:53:00+02:00",
    displayTime: "May 19, 2026 at 17:53",
    title: "Restored Mobile Layout",
    description: "Mobile gameplay is back to the cleaner layout with compact perks below the game and desktop perk alignment fixed.",
  },
];
const DEFAULT_HORSE_X = 150;
const BOSS_ARENA_MIN_X = 70;
const BOSS_ARENA_MAX_X = WIDTH - 150;
const BOSS_FIGHT_LIVES = 3;
const BOSS_WEAPON_DURATION = 8 * 60;
const BOSS_WEAPON_TYPES = [
  { kind: "bossSpread", label: "Triple Carrot", color: "#38bdf8" },
  { kind: "bossLaser", label: "Laser Carrot", color: "#f97316" },
  { kind: "bossMega", label: "Mega Carrot", color: "#a855f7" },
];
const BOSS_TYPES = [
  {
    type: "dinosaur",
    label: "Dinosaur",
    hp: 150,
    width: 188,
    height: 116,
    y: 122,
    palette: ["#6fb34a", "#2f6f31", "#173d1f"],
  },
  {
    type: "crab",
    label: "Crab",
    hp: 170,
    width: 178,
    height: 102,
    y: 152,
    palette: ["#df513f", "#8f241e", "#40110e"],
  },
  {
    type: "biber",
    label: "Biber",
    hp: 195,
    width: 184,
    height: 108,
    y: 138,
    palette: ["#8c5a34", "#4f2f1a", "#25150c"],
  },
  {
    type: "alien",
    label: "Alien",
    hp: 205,
    width: 176,
    height: 116,
    y: 110,
    palette: ["#8b5cf6", "#4c1d95", "#1e103d"],
  },
  {
    type: "bigfoot",
    label: "Bigfood",
    hp: 230,
    width: 196,
    height: 128,
    y: 128,
    palette: ["#8b5a35", "#4a2a18", "#24130b"],
  },
];
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const mobileLandscapeQuery = window.matchMedia("(max-width: 980px) and (orientation: landscape)");

const appSettings = {
  darkMode: false,
  hardcore: false,
  sound: true,
};

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
  forcedScoreSave: false,
  scoreSaveDecisionPending: false,
  scoreSubmissionInProgress: false,
  scoreSaveMessage: "",
  hasStarted: false,
  runMode: SCORE_MODES.normal,
  paused: false,
  status: "Open the intro and start your run.",
  worldSpeed: 7,
  scrollDistance: 0,
  horse: {
    x: DEFAULT_HORSE_X,
    y: GROUND_Y,
    vy: 0,
    width: 118,
    height: 92,
    facing: 1,
    jumpsLeft: 2,
    onGround: true,
  },
  flyUntil: 0,
  magnetUntil: 0,
  blasterUntil: 0,
  invisibleUntil: 0,
  invisibilityGraceUntil: 0,
  powerModeUntil: 0,
  rottenBoostUntil: 0,
  bullUntil: 0,
  nextShotFrame: 0,
  obstacles: [],
  flyingEnemies: [],
  boss: null,
  bossFightCount: 0,
  bossLives: 0,
  bossHitGraceUntil: 0,
  bossAttacks: [],
  bossPickupTimer: 180,
  bossWeapon: null,
  bossWeaponUntil: 0,
  bossTimer: 1250,
  bossAttackTimer: 90,
  flyingTimer: 260,
  coinsInWorld: [],
  pickups: [],
  celebrationBursts: [],
  projectiles: [],
  spawnTimer: 85,
  coinTimer: 140,
  pickupTimer: 950,
  meatTimer: 760,
  clouds: [
    { x: 80, y: 72, size: 1.0, speed: 0.35 },
    { x: 320, y: 52, size: 1.15, speed: 0.25 },
    { x: 690, y: 92, size: 0.92, speed: 0.3 },
  ],
  birds: [
    { x: 140, y: 120, size: 0.9, speed: 0.85, flap: 0.4 },
    { x: 460, y: 98, size: 1.15, speed: 1.05, flap: 1.7 },
    { x: 780, y: 148, size: 0.8, speed: 0.95, flap: 2.9 },
  ],
  meadowFloaters: [
    { x: 120, y: GROUND_Y - 120, size: 1.05, speed: 0.55, phase: 0.2 },
    { x: 380, y: GROUND_Y - 96, size: 0.9, speed: 0.7, phase: 1.4 },
    { x: 690, y: GROUND_Y - 132, size: 1.1, speed: 0.5, phase: 2.5 },
    { x: 910, y: GROUND_Y - 108, size: 0.85, speed: 0.62, phase: 3.1 },
  ],
  input: {
    left: false,
    right: false,
    touchTargetX: null,
  },
};

const hudCache = {
  score: "",
  coins: "",
  area: "",
  perk: "",
  submitText: "",
  promptText: "",
  finalScore: "",
  status: "",
  overlayHidden: null,
  introHidden: null,
  pauseHidden: null,
  inputDisabled: null,
  submitDisabled: null,
  restartDisabled: null,
  pauseButtonLabel: "",
  pauseButtonDisabled: null,
  perkButtons: new Map(),
};

let lastTickTime = null;
let accumulatedTime = 0;
let leaderboardPageIndex = 0;
let leaderboardLoading = false;
let pendingLeaderboardPageIndex = null;
let visibleGameUpdateCount = COLLAPSED_UPDATE_COUNT;
let gameplayFocusTimer = null;
let pausedBySettings = false;

function isMobileLandscapeLayout() {
  return mobileLandscapeQuery.matches;
}

function focusGameplayArea(immediate = false) {
  if (!isMobileLandscapeLayout()) {
    return;
  }

  const target = playfield || gameStage || gamePanel;

  if (!target) {
    return;
  }

  if (gameplayFocusTimer) {
    window.clearTimeout(gameplayFocusTimer);
    gameplayFocusTimer = null;
  }

  const scrollAction = () => {
    const targetBox = target.getBoundingClientRect();
    const targetTop = targetBox.top + window.scrollY;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const targetHeight = targetBox.height || 0;
    const idealTop = Math.max(0, targetTop - Math.max(0, (viewportHeight - targetHeight) / 2));
    window.scrollTo({ top: idealTop, behavior: immediate ? "auto" : "smooth" });
  };

  if (immediate) {
    scrollAction();
  } else {
    gameplayFocusTimer = window.setTimeout(scrollAction, 120);
  }
}

function refocusGameplayAfterViewportChange() {
  focusGameplayArea(true);
  window.setTimeout(() => focusGameplayArea(true), 120);
  window.setTimeout(() => focusGameplayArea(true), 360);
}

function isFullscreenActive() {
  return document.fullscreenElement === gamePanel ||
    document.fullscreenElement === gameStage ||
    document.fullscreenElement === playfield;
}

function syncFullscreenButton() {
  if (!fullscreenButton) {
    return;
  }
  const isActive = isFullscreenActive();
  fullscreenButton.textContent = isActive ? "×" : "⛶";
  fullscreenButton.title = isActive ? "Exit full screen" : "Full screen";
  fullscreenButton.setAttribute("aria-label", isActive ? "Exit full screen" : "Enter full screen");
  fullscreenButton.hidden = !document.fullscreenEnabled;
}

function syncIntroCopy() {
  const content = appSettings.hardcore ? INTRO_CONTENT.hardcore : INTRO_CONTENT.normal;
  if (introTitle) introTitle.textContent = content.title;
  if (introCopy) introCopy.textContent = content.copy;
  if (introMobileCopy) introMobileCopy.textContent = content.mobileCopy;
  if (introControlsTitle) introControlsTitle.textContent = content.controlsTitle;
  if (introControlsCopy) introControlsCopy.textContent = content.controlsCopy;
  if (introPowerTitle) introPowerTitle.textContent = content.powerTitle;
  if (introPowerCopy) introPowerCopy.textContent = content.powerCopy;
  if (introGoalTitle) introGoalTitle.textContent = content.goalTitle;
  if (introGoalCopy) introGoalCopy.textContent = content.goalCopy;
  if (startGameButton) startGameButton.textContent = content.startLabel;
}

async function toggleFullscreenMode() {
  if (!document.fullscreenEnabled) {
    state.status = "Fullscreen is not available in this browser.";
    return;
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await (playfield || gameStage || gamePanel || document.documentElement).requestFullscreen();
    }
    focusGameplayArea(true);
  } catch (_error) {
    state.status = "Fullscreen could not be opened.";
  } finally {
    syncFullscreenButton();
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
    if (typeof saved.darkMode === "boolean") appSettings.darkMode = saved.darkMode;
    if (typeof saved.hardcore === "boolean") appSettings.hardcore = saved.hardcore;
    if (typeof saved.sound === "boolean") appSettings.sound = saved.sound;
  } catch (_error) {
    return;
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
}

function syncSettingsControls() {
  if (darkModeToggle) darkModeToggle.checked = appSettings.darkMode;
  if (hardcoreToggle) hardcoreToggle.checked = appSettings.hardcore;
  if (hardcoreQuickToggle) hardcoreQuickToggle.checked = appSettings.hardcore;
  if (soundToggle) soundToggle.checked = appSettings.sound;
}

function applySettings() {
  document.body.classList.toggle("dark-mode", appSettings.darkMode);
  document.body.classList.toggle("hardcore-active", appSettings.hardcore);
  syncIntroCopy();
  if (hardcorePromoStatus) {
    hardcorePromoStatus.textContent = appSettings.hardcore
      ? "Hardcore ist AN: Lava, Geister, Bossfights und Hardcore-Rangliste."
      : "Schalter rechts: Hardcore schnell aktivieren.";
  }
  if (!appSettings.sound) {
    stopAreaMusic();
    audioState.started = false;
  } else if (audioState.unlocked && state.hasStarted && !state.paused && !state.gameOver) {
    startAreaMusic(getDesiredMusic(), true);
    audioState.started = true;
  }
  syncSettingsControls();
}

function setSetting(name, value) {
  appSettings[name] = value;
  saveSettings();
  applySettings();
  if (name === "hardcore") {
    const selectedMode = value ? SCORE_MODES.hardcore : SCORE_MODES.normal;
    if (!state.hasStarted || state.gameOver) {
      state.runMode = selectedMode;
    } else if (value) {
      // A run that enters Hardcore stays in the Hardcore leaderboard bucket.
      state.runMode = SCORE_MODES.hardcore;
    }
    leaderboard.resetPagination();
    leaderboardPageIndex = 0;
    renderLeaderboard(0);
    state.status = value
      ? "Hardcore mode enabled: faster runs, flying enemies, and boss waves."
      : "Hardcore mode disabled.";
    if (!value) {
      state.flyingEnemies = [];
      state.boss = null;
      state.bossAttacks = [];
      clearBossFightPickups();
      state.bossWeapon = null;
      state.bossWeaponUntil = 0;
      state.bossLives = 0;
    }
  }
}

function openSettings() {
  if (settingsOverlay) {
    settingsOverlay.hidden = false;
    syncSettingsControls();
    pausedBySettings = state.hasStarted && !state.paused && !state.gameOver;
    if (pausedBySettings) {
      togglePause(true);
    }
  }
}

function closeSettings() {
  if (settingsOverlay) {
    settingsOverlay.hidden = true;
    if (pausedBySettings) {
      pausedBySettings = false;
      togglePause(false);
    }
  }
}

function ensureAudioReady() {
  if (!audioState.enabled || audioState.context) {
    return;
  }

  audioState.context = new AudioContextClass();
  audioState.master = audioState.context.createGain();
  audioState.master.gain.value = 0.24;
  audioState.master.connect(audioState.context.destination);

  audioState.musicGain = audioState.context.createGain();
  audioState.musicGain.gain.value = 0.62;
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
  if (!audioState.started && state.hasStarted) {
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
  if (!appSettings.sound || !audioState.unlocked || !audioState.context || !audioState.master) {
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

function playRottenAppleSound() {
  playTone({ frequency: 220, duration: 0.08, type: "sawtooth", volume: 0.05, slideTo: 280 });
  playTone({ frequency: 329.63, duration: 0.1, type: "square", volume: 0.05, when: 0.06 });
  playTone({ frequency: 440, duration: 0.14, type: "sawtooth", volume: 0.05, when: 0.14, slideTo: 659.25 });
}

function playBullSound() {
  playTone({ frequency: 146.83, duration: 0.16, type: "sawtooth", volume: 0.06, slideTo: 196 });
  playTone({ frequency: 220, duration: 0.12, type: "square", volume: 0.05, when: 0.07, slideTo: 329.63 });
  playTone({ frequency: 329.63, duration: 0.14, type: "sawtooth", volume: 0.05, when: 0.16, slideTo: 493.88 });
}

function playSaveSound() {
  playTone({ frequency: 523.25, duration: 0.05, type: "triangle", volume: 0.045 });
  playTone({ frequency: 659.25, duration: 0.05, type: "triangle", volume: 0.045, when: 0.04 });
  playTone({ frequency: 783.99, duration: 0.08, type: "triangle", volume: 0.045, when: 0.08 });
}

function playErrorSound() {
  playTone({ frequency: 220, duration: 0.07, type: "square", volume: 0.04 });
  playTone({ frequency: 185, duration: 0.09, type: "square", volume: 0.04, when: 0.05 });
}

function playSmashSound() {
  playTone({ frequency: 110, duration: 0.08, type: "sawtooth", volume: 0.05, slideTo: 90 });
  playTone({ frequency: 164.81, duration: 0.06, type: "triangle", volume: 0.035, when: 0.03 });
}

function playSpawnSound() {
  playTone({ frequency: 300, duration: 0.04, type: "triangle", volume: 0.022, slideTo: 240 });
}

function playBossAttackSound(type) {
  if (type === "plasma" || type === "laser") {
    playTone({ frequency: 880, duration: 0.1, type: "sine", volume: 0.034, slideTo: 1320 });
    playTone({ frequency: 1760, duration: 0.06, type: "triangle", volume: 0.02, when: 0.04, slideTo: 1046.5 });
    return;
  }
  if (type === "boulder" || type === "shockwave") {
    playTone({ frequency: 82.41, duration: 0.14, type: "sawtooth", volume: 0.04, slideTo: 55 });
    playTone({ frequency: 146.83, duration: 0.08, type: "square", volume: 0.024, when: 0.06 });
    return;
  }
  if (type === "bubble" || type === "claw") {
    playTone({ frequency: 680, duration: 0.08, type: "triangle", volume: 0.035, slideTo: 940 });
    playTone({ frequency: 340, duration: 0.08, type: "square", volume: 0.022, when: 0.04, slideTo: 260 });
    return;
  }
  if (type === "log" || type === "branch") {
    playTone({ frequency: 170, duration: 0.1, type: "square", volume: 0.038, slideTo: 105 });
    playTone({ frequency: 260, duration: 0.06, type: "triangle", volume: 0.026, when: 0.05 });
    return;
  }
  playTone({ frequency: 116.54, duration: 0.12, type: "sawtooth", volume: 0.04, slideTo: 220 });
  playTone({ frequency: 440, duration: 0.05, type: "square", volume: 0.025, when: 0.06, slideTo: 330 });
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
  const rottenPattern = {
    lead: [392, 493.88, 587.33, 783.99, 659.25, 587.33, 523.25, 659.25],
    bass: [98, 123.47, 146.83, 164.81],
  };
  const bullPattern = {
    lead: [293.66, 392, 493.88, 587.33, 783.99, 659.25, 587.33, 493.88],
    bass: [73.42, 98, 123.47, 146.83],
  };
  const bossPatterns = {
    "boss-dinosaur": {
      lead: [110, 146.83, 174.61, 220, 196, 174.61, 146.83, 123.47, 110, 220, 261.63, 196],
      bass: [55, 55, 73.42, 65.41, 55, 82.41],
      stab: [440, 392, 329.63, 293.66],
      leadType: "sawtooth",
      bassType: "square",
      step: 0.18,
    },
    "boss-crab": {
      lead: [523.25, 659.25, 587.33, 783.99, 698.46, 880, 783.99, 659.25, 587.33, 739.99],
      bass: [98, 123.47, 92.5, 116.54, 98],
      stab: [1046.5, 987.77, 880, 783.99],
      leadType: "triangle",
      bassType: "square",
      step: 0.16,
    },
    "boss-biber": {
      lead: [196, 246.94, 293.66, 261.63, 220, 329.63, 293.66, 246.94, 220, 196],
      bass: [73.42, 98, 82.41, 110, 73.42],
      stab: [392, 293.66, 440, 329.63],
      leadType: "square",
      bassType: "triangle",
      step: 0.2,
    },
    "boss-alien": {
      lead: [739.99, 880, 987.77, 1174.66, 1046.5, 932.33, 783.99, 987.77, 659.25, 880],
      bass: [61.74, 92.5, 73.42, 110, 61.74],
      stab: [1480, 1318.51, 1174.66, 987.77],
      leadType: "sine",
      bassType: "sawtooth",
      step: 0.15,
    },
    "boss-bigfoot": {
      lead: [146.83, 196, 220, 246.94, 196, 174.61, 146.83, 110, 164.81, 220],
      bass: [41.2, 55, 61.74, 55, 41.2, 73.42],
      stab: [293.66, 246.94, 220, 196],
      leadType: "square",
      bassType: "sawtooth",
      step: 0.21,
    },
  };
  if (bossPatterns[area]) {
    return bossPatterns[area];
  }
  if (area === "power") {
    return powerPattern;
  }
  if (area === "rotten") {
    return rottenPattern;
  }
  if (area === "bull") {
    return bullPattern;
  }
  return patterns[area % patterns.length];
}

function stopAreaMusic() {
  if (audioState.musicTimer) {
    window.clearTimeout(audioState.musicTimer);
    audioState.musicTimer = null;
  }
  audioState.nextMusicAt = 0;
  audioState.currentArea = -1;
}

function scheduleAreaMusic(area) {
  if (!audioState.unlocked || !audioState.context || !audioState.musicGain) {
    return;
  }

  const pattern = getAreaMusicPattern(area);
  const startTime = Math.max(audioState.context.currentTime + 0.03, audioState.nextMusicAt || audioState.context.currentTime + 0.03);
  const step = pattern.step || 0.22;

  pattern.lead.forEach((note, index) => {
    playTone({
      frequency: note,
      duration: pattern.step ? 0.1 : 0.12,
      type: pattern.leadType || "square",
      volume: pattern.step ? 0.022 : 0.018,
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
      duration: pattern.step ? 0.22 : 0.28,
      type: pattern.bassType || "triangle",
      volume: pattern.step ? 0.02 : 0.016,
      when: startTime - audioState.context.currentTime + index * step * 2,
      output: audioState.musicGain,
    });
  });

  if (pattern.stab) {
    pattern.stab.forEach((note, index) => {
      playTone({
        frequency: note,
        duration: 0.05,
        type: "sawtooth",
        volume: 0.013,
        when: startTime - audioState.context.currentTime + (index * 2 + 1) * step,
        slideTo: note * 0.72,
        output: audioState.musicGain,
      });
    });
  }

  const loopDuration = pattern.lead.length * step;
  audioState.nextMusicAt = startTime + loopDuration;
  audioState.musicTimer = window.setTimeout(() => {
    if (audioState.currentArea === area && !state.gameOver) {
      scheduleAreaMusic(area);
    }
  }, Math.max(120, loopDuration * 1000 - 60));
}

function startAreaMusic(area, forceRestart = false) {
  if (!appSettings.sound || !audioState.unlocked) {
    return;
  }

  if (!forceRestart && audioState.currentArea === area) {
    return;
  }

  stopAreaMusic();
  audioState.currentArea = area;
  scheduleAreaMusic(area);
}

function getDesiredMusic() {
  if (state.boss) return `boss-${state.boss.type}`;
  if (state.bullUntil > state.frame) return "bull";
  if (state.rottenBoostUntil > state.frame) return "rotten";
  if (state.powerModeUntil > state.frame) return "power";
  return state.area;
}

function resetGame() {
  accumulatedTime = 0;
  lastTickTime = null;
  state.runMode = appSettings.hardcore ? SCORE_MODES.hardcore : SCORE_MODES.normal;
  state.frame = 0;
  state.score = 0;
  state.coins = 0;
  state.area = 0;
  state.gameOver = false;
  state.scoreSubmitted = false;
  state.gameOverHandled = false;
  state.awaitingScoreEntry = false;
  state.forcedScoreSave = false;
  state.scoreSaveDecisionPending = false;
  state.scoreSubmissionInProgress = false;
  state.scoreSaveMessage = "";
  state.paused = false;
  state.status = FRIDAY_EVENT_ACTIVE
    ? "Friday special active: find meat to become a bull."
    : (appSettings.hardcore ? "Hardcore run ready. Watch for flying enemies and bosses." : "Press Space or tap to jump.");
  state.worldSpeed = 7.45;
  state.scrollDistance = 0;
  state.flyUntil = 0;
  state.magnetUntil = 0;
  state.blasterUntil = 0;
  state.invisibleUntil = 0;
  state.invisibilityGraceUntil = 0;
  state.powerModeUntil = 0;
  state.rottenBoostUntil = 0;
  state.bullUntil = 0;
  state.nextShotFrame = 0;
  state.obstacles = [];
  state.flyingEnemies = [];
  state.boss = null;
  state.bossFightCount = 0;
  state.bossLives = 0;
  state.bossHitGraceUntil = 0;
  state.bossAttacks = [];
  state.bossPickupTimer = 180;
  state.bossWeapon = null;
  state.bossWeaponUntil = 0;
  state.bossTimer = 1250;
  state.bossAttackTimer = 90;
  state.flyingTimer = 260;
  state.coinsInWorld = [];
  state.pickups = [];
  state.celebrationBursts = [];
  state.projectiles = [];
  state.spawnTimer = 85;
  state.coinTimer = 140;
  state.pickupTimer = 950;
  state.meatTimer = 760;
  Object.assign(state.horse, {
    x: DEFAULT_HORSE_X,
    y: GROUND_Y,
    vy: 0,
    facing: 1,
    jumpsLeft: 2,
    onGround: true,
  });
  state.input.left = false;
  state.input.right = false;
  state.input.touchTargetX = null;
  playerNameInput.value = "";
  if (state.hasStarted) {
    if (audioState.unlocked) {
      startAreaMusic(state.area, true);
      audioState.started = true;
    }
  } else {
    stopAreaMusic();
    audioState.started = false;
  }
}

function startRun() {
  if (state.hasStarted) {
    return;
  }
  state.runMode = appSettings.hardcore ? SCORE_MODES.hardcore : SCORE_MODES.normal;
  state.hasStarted = true;
  state.paused = false;
  accumulatedTime = 0;
  lastTickTime = null;
  state.status = FRIDAY_EVENT_ACTIVE
    ? "Friday special active: find meat to become a bull."
    : (appSettings.hardcore ? "Hardcore run started. Boss waves are active." : "Run started. Jump with Space or tap.");
  if (audioState.unlocked) {
    startAreaMusic(getDesiredMusic(), true);
    audioState.started = true;
  }
  focusGameplayArea();
}

function togglePause(forcePaused = null) {
  if (!state.hasStarted || state.gameOver) {
    return;
  }

  const nextPaused = forcePaused === null ? !state.paused : forcePaused;
  if (nextPaused === state.paused) {
    return;
  }

  state.paused = nextPaused;
  accumulatedTime = 0;
  lastTickTime = null;

  if (state.paused) {
    state.status = "Paused. Press P, Escape, or Resume to continue.";
    stopAreaMusic();
  } else {
    state.status = "Back in the run.";
    if (audioState.unlocked) {
      startAreaMusic(getDesiredMusic(), true);
      audioState.started = true;
    }
  }
}

function getAreaTheme() {
  const lightThemes = [
    {
      season: "spring",
      sky: "#d9efff",
      skyMid: "#eefbff",
      skyBottom: "#f4ead8",
      ground: "#8ed06a",
      ground2: "#62a94d",
      ground3: "#3f8338",
      far: "rgba(166, 196, 170, 0.78)",
      mid: "rgba(91, 151, 92, 0.78)",
      near: "rgba(45, 105, 50, 0.58)",
      tree: "rgba(42, 109, 55, 0.58)",
      accent: "#f5a6c8",
    },
    {
      season: "summer",
      sky: "#ffd9b5",
      skyMid: "#ffe9c7",
      skyBottom: "#f1c16c",
      ground: "#cf9b60",
      ground2: "#aa7a38",
      ground3: "#7e572a",
      far: "rgba(214, 181, 132, 0.82)",
      mid: "rgba(177, 125, 70, 0.78)",
      near: "rgba(114, 83, 39, 0.55)",
      tree: "rgba(83, 86, 37, 0.55)",
      accent: "#f5cf4d",
    },
    {
      season: "winter",
      sky: "#d8eaff",
      skyMid: "#eef7ff",
      skyBottom: "#f8fbff",
      ground: "#eef7ff",
      ground2: "#c8dff2",
      ground3: "#9ebbd4",
      far: "rgba(196, 213, 231, 0.94)",
      mid: "rgba(150, 176, 199, 0.84)",
      near: "rgba(106, 133, 154, 0.5)",
      tree: "rgba(44, 73, 73, 0.58)",
      accent: "#ffffff",
    },
    {
      season: "autumn",
      sky: "#e8f0ff",
      skyMid: "#ffdcbc",
      skyBottom: "#f0ad75",
      ground: "#b9793f",
      ground2: "#8d5430",
      ground3: "#603923",
      far: "rgba(177, 137, 102, 0.8)",
      mid: "rgba(140, 90, 55, 0.78)",
      near: "rgba(92, 53, 31, 0.56)",
      tree: "rgba(119, 70, 34, 0.62)",
      accent: "#d65b2a",
    },
  ];
  const darkThemes = [
    {
      season: "spring",
      sky: "#152235",
      skyMid: "#263b53",
      skyBottom: "#334557",
      ground: "#304f35",
      ground2: "#223b28",
      ground3: "#142518",
      far: "rgba(72, 93, 120, 0.72)",
      mid: "rgba(34, 64, 55, 0.82)",
      near: "rgba(13, 37, 25, 0.72)",
      tree: "rgba(25, 57, 35, 0.76)",
      accent: "#d66aa3",
    },
    {
      season: "summer",
      sky: "#241d2e",
      skyMid: "#46354c",
      skyBottom: "#6b4e37",
      ground: "#644b35",
      ground2: "#473526",
      ground3: "#2f2218",
      far: "rgba(78, 62, 84, 0.82)",
      mid: "rgba(95, 64, 42, 0.78)",
      near: "rgba(54, 40, 24, 0.72)",
      tree: "rgba(65, 61, 29, 0.66)",
      accent: "#d79b32",
    },
    {
      season: "winter",
      sky: "#101927",
      skyMid: "#1e3147",
      skyBottom: "#32475e",
      ground: "#2f5366",
      ground2: "#1f3a49",
      ground3: "#152532",
      far: "rgba(86, 111, 139, 0.9)",
      mid: "rgba(52, 78, 101, 0.86)",
      near: "rgba(27, 49, 63, 0.72)",
      tree: "rgba(17, 43, 45, 0.76)",
      accent: "#d8f2ff",
    },
    {
      season: "autumn",
      sky: "#102a2b",
      skyMid: "#394034",
      skyBottom: "#5b3c2d",
      ground: "#3c5d38",
      ground2: "#294326",
      ground3: "#1d2f1c",
      far: "rgba(70, 83, 58, 0.76)",
      mid: "rgba(74, 55, 34, 0.78)",
      near: "rgba(45, 30, 21, 0.72)",
      tree: "rgba(92, 49, 25, 0.7)",
      accent: "#c45730",
    },
  ];
  const hardcoreThemes = [
    {
      season: "hardcore",
      sky: "#100611",
      skyMid: "#281225",
      skyBottom: "#4d160f",
      ground: "#31110b",
      ground2: "#5a160c",
      ground3: "#130606",
      far: "rgba(71, 30, 62, 0.88)",
      mid: "rgba(91, 28, 20, 0.84)",
      near: "rgba(23, 9, 12, 0.78)",
      tree: "rgba(20, 10, 11, 0.86)",
      accent: "#ff6a1a",
    },
    {
      season: "hardcore",
      sky: "#080813",
      skyMid: "#171a35",
      skyBottom: "#3b152d",
      ground: "#24100f",
      ground2: "#44130e",
      ground3: "#0b0505",
      far: "rgba(45, 37, 78, 0.86)",
      mid: "rgba(74, 31, 58, 0.8)",
      near: "rgba(18, 12, 25, 0.82)",
      tree: "rgba(9, 8, 13, 0.88)",
      accent: "#f97316",
    },
  ];
  if (appSettings.hardcore) {
    return hardcoreThemes[state.area % hardcoreThemes.length];
  }
  const themes = appSettings.darkMode ? darkThemes : lightThemes;
  return themes[state.area % themes.length];
}

function getActivePerk() {
  if (state.bossWeapon && state.bossWeaponUntil > state.frame) {
    return `${state.bossWeapon.label} ${Math.ceil((state.bossWeaponUntil - state.frame) / 60)}s`;
  }
  if (state.boss) return `Boss ${state.bossLives}/${BOSS_FIGHT_LIVES}`;
  if (state.bullUntil > state.frame) return `Friday Bull ${Math.ceil((state.bullUntil - state.frame) / 60)}s`;
  if (state.rottenBoostUntil > state.frame) return `Turbo Apple ${Math.ceil((state.rottenBoostUntil - state.frame) / 60)}s`;
  if (state.powerModeUntil > state.frame) return `Apple Power ${Math.ceil((state.powerModeUntil - state.frame) / 60)}s`;
  if (state.flyUntil > state.frame) return `Fly ${Math.ceil((state.flyUntil - state.frame) / 60)}s`;
  if (state.magnetUntil > state.frame) return `Magnet ${Math.ceil((state.magnetUntil - state.frame) / 60)}s`;
  if (state.blasterUntil > state.frame) return `${PERK_LABELS.blaster} ${Math.ceil((state.blasterUntil - state.frame) / 60)}s`;
  return "None";
}

function hasAnyActivePerk() {
  return state.bullUntil > state.frame
    || state.rottenBoostUntil > state.frame
    || state.powerModeUntil > state.frame
    || state.flyUntil > state.frame
    || state.magnetUntil > state.frame
    || state.blasterUntil > state.frame;
}

function hasAppleFamilyPerkActive() {
  return state.powerModeUntil > state.frame || state.rottenBoostUntil > state.frame;
}

function getPerkCountdownState() {
  const activePerks = [
    { name: "Friday Bull", until: state.bullUntil },
    { name: "Turbo Apple", until: state.rottenBoostUntil },
    { name: "Fly", until: state.flyUntil },
    { name: "Magnet", until: state.magnetUntil },
    { name: PERK_LABELS.blaster, until: state.blasterUntil },
    { name: "Apple Power", until: state.powerModeUntil },
  ];

  for (const perk of activePerks) {
    if (perk.until > state.frame) {
      const secondsLeft = Math.ceil((perk.until - state.frame) / 60);
      if (secondsLeft <= 4) {
        return { name: perk.name, secondsLeft };
      }
    }
  }

  return null;
}

function tryActivatePerk(perkName) {
  if (state.gameOver || !state.hasStarted || state.paused) return;
  if (hasAnyActivePerk()) {
    state.status = "Only one perk can be active at a time.";
    playErrorSound();
    return;
  }
  if (state.coins < PERK_COSTS[perkName]) {
    state.status = `Need ${PERK_COSTS[perkName]} coins for ${PERK_LABELS[perkName]}.`;
    playErrorSound();
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
  state.status = `${PERK_LABELS[perkName]} perk active for 10 seconds.`;
  playPerkSound();
}

function jump() {
  if (state.gameOver || !state.hasStarted || state.paused) return;
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
    barrel: { width: 42, height: 46, color: "#8c5a34" },
    bush: { width: 60, height: 34, color: "#68b15b" },
    fence: { width: 58, height: 56, color: "#9c7045" },
    log: { width: 62, height: 30, color: "#7b5230" },
    hurdle: { width: 70, height: 50, color: "#b28a57" },
    mailbox: { width: 46, height: 60, color: "#b63e34" },
    farmer: { width: 70, height: 94, color: "#5d78b8" },
    tractor: { width: 118, height: 78, color: "#59a53f" },
    spike: { width: 48, height: 28, color: "#d7dbe2" },
    sheep: { width: 92, height: 66, color: "#f7f2ea" },
    scarecrow: { width: 74, height: 98, color: "#c86c38" },
    rooster: { width: 60, height: 58, color: "#47ab45" },
    wagon: { width: 104, height: 60, color: "#be8d47" },
    windmill: { width: 74, height: 108, color: "#d8d2c3" },
    cow: { width: 98, height: 68, color: "#fff6e7" },
  };
  const spec = specs[type];
  const width = Math.round(spec.width * OBSTACLE_SCALE);
  const height = Math.round(spec.height * OBSTACLE_SCALE);
  return {
    type,
    x,
    y: GROUND_Y - height,
    width,
    height,
    color: spec.color,
    passed: false,
    animSeed: Math.random() * Math.PI * 2,
  };
}

function isBossFightActive() {
  return Boolean(state.boss);
}

function clearBossFightPickups() {
  state.pickups = state.pickups.filter((pickup) => !pickup.kind?.startsWith("boss"));
}

function hasUpcomingGroundThreat() {
  return state.obstacles.some((obstacle) => (
    obstacle.x > state.horse.x + 90 &&
    obstacle.x < WIDTH + 390
  ));
}

function hasUpcomingFlyingThreat() {
  return state.flyingEnemies.some((enemy) => (
    enemy.x > state.horse.x + 110 &&
    enemy.x < WIDTH + 280
  ));
}

function spawnObstacle() {
  if (isBossFightActive()) {
    return false;
  }
  const difficulty = Math.min(8, Math.floor(state.score / 1200));
  const types = ["hay", "crate", "barrel", "bush", "fence", "log", "hurdle", "mailbox", "farmer", "tractor", "spike", "sheep", "scarecrow", "rooster", "wagon", "windmill", "cow"];
  const availableTypes = types.slice(0, Math.min(types.length, 7 + difficulty));
  const cowUnlocked = state.score >= 2600;
  const spawnCow = cowUnlocked && Math.random() < 0.18;
  const type = spawnCow
    ? "cow"
    : availableTypes[Math.floor(Math.random() * availableTypes.length)];
  const safeSpawnOffset = appSettings.hardcore && hasUpcomingFlyingThreat() ? 250 : 120;
  state.obstacles.push(buildObstacle(type, WIDTH + safeSpawnOffset + Math.random() * 80));
  if (appSettings.hardcore) {
    state.flyingTimer = Math.max(state.flyingTimer, 120);
  }
  if (Math.random() < 0.28) {
    playSpawnSound();
  }
  return true;
}

function spawnFlyingEnemy() {
  if (isBossFightActive() || hasUpcomingGroundThreat() || hasUpcomingFlyingThreat()) {
    return false;
  }
  const laneOptions = [
    GROUND_Y - 245,
    GROUND_Y - 285,
    GROUND_Y - 320,
  ];
  const lane = laneOptions[Math.floor(Math.random() * laneOptions.length)];
  state.flyingEnemies.push({
    x: WIDTH + 90,
    y: Math.max(88, lane + (Math.random() - 0.5) * 18),
    width: 62,
    height: 38,
    phase: Math.random() * Math.PI * 2,
    passed: false,
  });
  state.spawnTimer = Math.max(state.spawnTimer, 64);
  return true;
}

function spawnBoss() {
  if (state.boss) {
    return;
  }
  const bossType = BOSS_TYPES[state.bossFightCount % BOSS_TYPES.length];
  state.obstacles = [];
  state.flyingEnemies = [];
  state.coinsInWorld = [];
  state.pickups = [];
  state.projectiles = [];
  state.bossAttacks = [];
  state.bossLives = BOSS_FIGHT_LIVES;
  state.bossHitGraceUntil = state.frame + 90;
  state.bossAttackTimer = 95;
  state.bossPickupTimer = 150;
  state.bossWeapon = null;
  state.bossWeaponUntil = 0;
  state.horse.x = DEFAULT_HORSE_X;
  state.horse.vy = Math.min(state.horse.vy, 0);
  state.boss = {
    x: WIDTH + 80,
    y: bossType.y,
    width: bossType.width,
    height: bossType.height,
    hp: bossType.hp,
    maxHp: bossType.hp,
    type: bossType.type,
    label: bossType.label,
    palette: bossType.palette,
    baseY: bossType.y,
    targetX: WIDTH - 260,
    targetY: bossType.y,
    moveTimer: 80,
    phase: Math.random() * Math.PI * 2,
  };
  state.status = `${bossType.label} boss fight. 3 hearts, unlimited carrot blaster, move with A/D or arrows.`;
  spawnCelebrationBurst(WIDTH - 140, 110, ["#ff7043", "#ffd54f", "#66d2a7"]);
  playSpawnSound();
}

function spawnBossAttack() {
  if (!state.boss) {
    return;
  }
  const boss = state.boss;
  const originX = boss.x + boss.width * 0.18;
  const originY = boss.y + boss.height * 0.55 + Math.sin(boss.phase) * 12;
  const targetX = state.horse.x + state.horse.width * 0.58;
  const targetY = Math.max(64, Math.min(
    GROUND_Y - 32,
    state.horse.y - state.horse.height * 0.52 + (Math.random() - 0.5) * 48,
  ));
  const aimSpeed = 7.4 + Math.min(2.8, state.bossFightCount * 0.32);
  const aimedVelocity = (speed, maxVy = 5.4) => {
    const dx = targetX - originX;
    const dy = targetY - originY;
    const distance = Math.max(1, Math.hypot(dx, dy));
    return {
      vx: (dx / distance) * speed,
      vy: Math.max(-maxVy, Math.min(maxVy, (dy / distance) * speed)),
    };
  };
  const baseVelocity = aimedVelocity(aimSpeed);
  const attackRoll = Math.random();
  const baseAttack = {
    x: originX,
    y: originY,
    vx: baseVelocity.vx,
    vy: baseVelocity.vy,
    phase: Math.random() * Math.PI * 2,
    type: "fireball",
    size: 18,
    width: 36,
    height: 28,
  };

  if (boss.type === "dinosaur" && attackRoll < 0.36) {
    Object.assign(baseAttack, {
      type: "meteor",
      x: Math.min(WIDTH - 80, targetX + 170 + Math.random() * 130),
      y: Math.max(56, state.horse.y - 280),
      vx: -5.2 - Math.min(1.6, state.bossFightCount * 0.22),
      vy: 2.5 + Math.random() * 0.9,
      size: 21,
      width: 42,
      height: 42,
    });
  } else if (boss.type === "crab") {
    const velocity = aimedVelocity(attackRoll < 0.42 ? aimSpeed + 1.2 : aimSpeed - 0.4, 4.3);
    Object.assign(baseAttack, {
      type: attackRoll < 0.42 ? "claw" : "bubble",
      size: attackRoll < 0.42 ? 19 : 16,
      width: attackRoll < 0.42 ? 48 : 32,
      height: attackRoll < 0.42 ? 30 : 32,
      vx: velocity.vx,
      vy: velocity.vy,
    });
  } else if (boss.type === "biber") {
    const branchVelocity = aimedVelocity(aimSpeed - 0.8, 4.6);
    Object.assign(baseAttack, {
      type: attackRoll < 0.5 ? "log" : "branch",
      y: attackRoll < 0.5 ? GROUND_Y - 28 : boss.y + 28,
      size: 18,
      width: attackRoll < 0.5 ? 54 : 46,
      height: attackRoll < 0.5 ? 24 : 18,
      vx: attackRoll < 0.5 ? -8.2 : -6.2,
      vy: attackRoll < 0.5 ? 0 : branchVelocity.vy,
    });
  } else if (boss.type === "alien") {
    const laserVelocity = aimedVelocity(aimSpeed + 2.4, 4.1);
    const plasmaVelocity = aimedVelocity(aimSpeed + 0.6, 5.8);
    Object.assign(baseAttack, {
      type: attackRoll < 0.48 ? "laser" : "plasma",
      size: attackRoll < 0.48 ? 15 : 21,
      width: attackRoll < 0.48 ? 64 : 42,
      height: attackRoll < 0.48 ? 18 : 42,
      vx: attackRoll < 0.48 ? laserVelocity.vx : plasmaVelocity.vx,
      vy: attackRoll < 0.48 ? laserVelocity.vy : plasmaVelocity.vy,
      homing: attackRoll < 0.48 ? 0 : 0.04,
    });
  } else if (boss.type === "bigfoot") {
    const boulderVelocity = aimedVelocity(aimSpeed - 0.2, 4.8);
    Object.assign(baseAttack, {
      type: attackRoll < 0.45 ? "shockwave" : "boulder",
      y: attackRoll < 0.45 ? GROUND_Y - 34 : boss.y + boss.height * 0.58,
      size: attackRoll < 0.45 ? 22 : 23,
      width: attackRoll < 0.45 ? 68 : 46,
      height: attackRoll < 0.45 ? 28 : 46,
      vx: attackRoll < 0.45 ? -9.1 : boulderVelocity.vx,
      vy: attackRoll < 0.45 ? 0 : boulderVelocity.vy,
    });
  }

  state.bossAttacks.push(baseAttack);
  if (boss.type === "crab" && baseAttack.type === "bubble" && Math.random() < 0.45) {
    state.bossAttacks.push({
      ...baseAttack,
      y: baseAttack.y + 44,
      phase: baseAttack.phase + Math.PI,
      vx: baseAttack.vx * 0.92,
    });
  }
  playBossAttackSound(baseAttack.type);
}

function spawnBossWeaponPickup() {
  if (!state.boss) {
    return;
  }
  const weapon = BOSS_WEAPON_TYPES[Math.floor(Math.random() * BOSS_WEAPON_TYPES.length)];
  state.pickups.push({
    x: WIDTH - 260 - Math.random() * 180,
    y: 160 + Math.random() * Math.max(120, GROUND_Y - 300),
    size: 18,
    pulse: Math.random() * Math.PI * 2,
    kind: weapon.kind,
    weapon,
  });
}

function activateBossWeapon(weapon) {
  state.bossWeapon = weapon;
  state.bossWeaponUntil = state.frame + BOSS_WEAPON_DURATION;
  state.status = `${weapon.label} active for 8 seconds.`;
  spawnCelebrationBurst(state.horse.x + 100, state.horse.y - 90, [weapon.color, "#ffffff", "#ffd54f"]);
  playPerkSound();
}

function finishBossFight() {
  if (!state.boss) {
    return;
  }
  const boss = state.boss;
  spawnCelebrationBurst(boss.x + boss.width / 2, boss.y + boss.height / 2, ["#ff7043", "#ffd54f", "#ffffff", "#66d2a7"]);
  state.score += 700 + state.bossFightCount * 120;
  state.bossFightCount += 1;
  state.boss = null;
  state.bossAttacks = [];
  clearBossFightPickups();
  state.bossLives = 0;
  state.bossHitGraceUntil = 0;
  state.bossPickupTimer = 180;
  state.bossWeapon = null;
  state.bossWeaponUntil = 0;
  state.horse.x = DEFAULT_HORSE_X;
  state.spawnTimer = 105;
  state.flyingTimer = 300;
  state.bossTimer = 2400 + Math.random() * 900;
  state.status = "Boss defeated. The run continues.";
  playSmashSound();
}

function damageBossFight(x, y) {
  if (!state.boss || state.bossHitGraceUntil > state.frame) {
    return false;
  }
  if (state.invisibleUntil > state.frame || state.invisibilityGraceUntil > state.frame) {
    return false;
  }

  state.bossLives -= 1;
  state.bossHitGraceUntil = state.frame + 90;
  spawnCelebrationBurst(x, y, ["#ef5350", "#ffca28", "#ffffff"]);
  playCrashSound();

  if (state.bossLives <= 0) {
    state.gameOver = true;
    clearBossFightPickups();
    state.bossWeapon = null;
    state.bossWeaponUntil = 0;
    state.status = `Boss fight lost. Final score: ${state.score}`;
    stopAreaMusic();
    return true;
  }

  state.status = `Boss hit you. ${state.bossLives} heart${state.bossLives === 1 ? "" : "s"} left.`;
  return true;
}

function spawnCoins() {
  const startX = WIDTH + 80;
  const baseY = [GROUND_Y - 80, GROUND_Y - 130, GROUND_Y - 180][Math.floor(Math.random() * 3)];
  for (let index = 0; index < 4; index += 1) {
    state.coinsInWorld.push({
      x: startX + index * 34,
      y: baseY - Math.abs(index - 1.5) * 14,
      size: 11.5,
      spin: index * 5,
    });
  }
}

function spawnApple() {
  if (hasAnyActivePerk()) {
    return;
  }
  const yOptions = [GROUND_Y - 90, GROUND_Y - 145, GROUND_Y - 200];
  const rotten = Math.random() < 0.22;
  state.pickups.push({
    x: WIDTH + 120 + Math.random() * 140,
    y: yOptions[Math.floor(Math.random() * yOptions.length)],
    size: Math.round((rotten ? 14 : 16) * PICKUP_SCALE),
    pulse: Math.random() * Math.PI * 2,
    kind: rotten ? "rotten" : "apple",
  });
}

function spawnMeat() {
  if (hasAnyActivePerk()) {
    return;
  }
  const yOptions = [GROUND_Y - 82, GROUND_Y - 138, GROUND_Y - 190];
  state.pickups.push({
    x: WIDTH + 150 + Math.random() * 150,
    y: yOptions[Math.floor(Math.random() * yOptions.length)],
    size: Math.round(15 * PICKUP_SCALE),
    pulse: Math.random() * Math.PI * 2,
    kind: "meat",
  });
}

function activateApplePower() {
  state.invisibleUntil = state.frame + 10 * 60;
  state.invisibilityGraceUntil = state.frame + 11 * 60;
  state.powerModeUntil = state.frame + 10 * 60;
  state.status = "Apple power active: invisibility for 10 seconds.";
  playAppleSound();
  startAreaMusic("power", true);
}

function activateRottenApplePower() {
  state.rottenBoostUntil = state.frame + 5 * 60;
  state.status = "Fauler Apfel: Turbo-Speed fuer 5 Sekunden, aber du bleibst verwundbar.";
  playRottenAppleSound();
  startAreaMusic("rotten", true);
}

function spawnCelebrationBurst(x, y, palette = ["#ffd54f", "#ff6b6b", "#4fc3f7", "#8bc34a"]) {
  for (let index = 0; index < 14; index += 1) {
    const angle = (Math.PI * 2 * index) / 14 + Math.random() * 0.3;
    const speed = 1.8 + Math.random() * 2.4;
    state.celebrationBursts.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1.1,
      life: 28 + Math.random() * 14,
      color: palette[index % palette.length],
      size: 4 + Math.random() * 3,
    });
  }
}

function activateBullPower() {
  state.bullUntil = state.frame + 10 * 60;
  state.status = "Friday Special: You are a bull for 10 seconds. Smash everything.";
  playBullSound();
  spawnCelebrationBurst(state.horse.x + 80, state.horse.y - 80, ["#ef5350", "#ffca28", "#ffffff", "#5c6bc0"]);
  startAreaMusic("bull", true);
}

function updateHorse() {
  const horse = state.horse;
  if (isBossFightActive()) {
    const previousX = horse.x;
    const horizontalSpeed = state.input.touchTargetX === null ? 8.5 : 6.8;
    if (state.input.left) horse.x -= horizontalSpeed;
    if (state.input.right) horse.x += horizontalSpeed;
    if (state.input.touchTargetX !== null) {
      const targetX = Math.max(BOSS_ARENA_MIN_X, Math.min(BOSS_ARENA_MAX_X, state.input.touchTargetX));
      const delta = targetX - horse.x;
      horse.x += Math.max(-9.5, Math.min(9.5, delta * 0.18));
      if (Math.abs(delta) < 4) {
        horse.x = targetX;
      }
    }
    horse.x = Math.max(BOSS_ARENA_MIN_X, Math.min(BOSS_ARENA_MAX_X, horse.x));
    if (horse.x < previousX - 0.35) {
      horse.facing = -1;
    } else if (horse.x > previousX + 0.35) {
      horse.facing = 1;
    }
  } else if (Math.abs(horse.x - DEFAULT_HORSE_X) > 0.5) {
    horse.facing = 1;
    horse.x += (DEFAULT_HORSE_X - horse.x) * 0.12;
  } else {
    horse.facing = 1;
    horse.x = DEFAULT_HORSE_X;
  }

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
  if (FRIDAY_EVENT_ACTIVE && state.area !== previousArea && state.frame > 1) {
    spawnCelebrationBurst(WIDTH * 0.5, 84, ["#ffd54f", "#f06292", "#4fc3f7", "#ffffff"]);
  }
  const baseWorldSpeed = 7.45 + Math.min(8, Math.floor(state.score / 2500)) * 0.5 + (appSettings.hardcore ? 0.65 : 0);
  state.worldSpeed = isBossFightActive()
    ? 0
    : baseWorldSpeed
      + (state.rottenBoostUntil > state.frame ? 3.2 : 0)
      + (state.bullUntil > state.frame ? 4.4 : 0);
  state.scrollDistance += state.worldSpeed;
  if (!isBossFightActive()) {
    state.score += 1;
  }
  const desiredMusic = getDesiredMusic();
  if (desiredMusic !== audioState.currentArea || state.area !== previousArea) {
    startAreaMusic(desiredMusic, true);
  }

  if (!isBossFightActive()) {
    state.spawnTimer -= 1;
    if (state.spawnTimer <= 0) {
      const spawned = spawnObstacle();
      state.spawnTimer = spawned
        ? 55 + Math.random() * 45
        : 42;
    }
  }

  if (appSettings.hardcore && !isBossFightActive()) {
    state.flyingTimer -= 1;
    if (state.flyingTimer <= 0) {
      const spawned = spawnFlyingEnemy();
      state.flyingTimer = spawned ? 320 + Math.random() * 210 : 85;
    }

    state.bossTimer -= 1;
    if (state.bossTimer <= 0) {
      spawnBoss();
      state.bossTimer = 2600 + Math.random() * 900;
    }
  }

  if (!isBossFightActive()) {
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

    if (FRIDAY_EVENT_ACTIVE) {
      state.meatTimer -= 1;
      if (state.meatTimer <= 0) {
        spawnMeat();
        state.meatTimer = 1150 + Math.random() * 650;
      }
    }
  }

  for (const cloud of state.clouds) {
    if (!isBossFightActive()) {
      cloud.x -= cloud.speed;
    }
    if (cloud.x < -120) {
      cloud.x = WIDTH + 60;
    }
  }

  for (const bird of state.birds) {
    if (!isBossFightActive()) {
      bird.x -= bird.speed;
    }
    bird.flap += 0.18;
    if (bird.x < -80) {
      bird.x = WIDTH + 40 + Math.random() * 120;
      bird.y = 86 + Math.random() * 84;
    }
  }

  for (const floater of state.meadowFloaters) {
    if (!isBossFightActive()) {
      floater.x -= floater.speed;
    }
    floater.phase += 0.08;
    if (floater.x < -30) {
      floater.x = WIDTH + 30 + Math.random() * 100;
      floater.y = GROUND_Y - 88 - Math.random() * 56;
    }
  }

  if (!isBossFightActive()) {
    for (const obstacle of state.obstacles) {
      obstacle.x -= state.worldSpeed;
      if (!obstacle.passed && obstacle.x + obstacle.width < state.horse.x) {
        obstacle.passed = true;
        state.score += 24;
      }
    }
    state.obstacles = state.obstacles.filter((item) => item.x + item.width > -30);
  } else {
    state.obstacles = [];
  }

  if (!isBossFightActive()) {
    for (const enemy of state.flyingEnemies) {
      enemy.phase += 0.12;
      enemy.x -= state.worldSpeed + 2.4;
      enemy.y += Math.sin(enemy.phase) * 2.1;
      if (!enemy.passed && enemy.x + enemy.width < state.horse.x) {
        enemy.passed = true;
        state.score += 36;
      }
    }
    state.flyingEnemies = state.flyingEnemies.filter((enemy) => enemy.x + enemy.width > -40);
  } else {
    state.flyingEnemies = [];
  }

  if (state.boss) {
    state.boss.phase += 0.08;
    state.boss.moveTimer -= 1;
    if (state.boss.moveTimer <= 0) {
      const dangerPush = state.horse.x > 300 ? 80 : 0;
      const moveRange = state.boss.type === "alien" ? 160 : (state.boss.type === "crab" || state.boss.type === "bigfoot" ? 76 : 118);
      state.boss.targetX = WIDTH - 330 - Math.random() * 205 - dangerPush;
      state.boss.targetY = state.boss.baseY + (Math.random() - 0.5) * moveRange;
      state.boss.moveTimer = 70 + Math.random() * 85;
    }
    const minBossX = WIDTH - 560;
    const maxBossX = WIDTH - state.boss.width - 40;
    const minBossY = 82;
    const maxBossY = Math.max(minBossY + 20, GROUND_Y - state.boss.height - 26);
    const bob = Math.sin(state.boss.phase) * (state.boss.type === "alien" ? 22 : (state.boss.type === "crab" || state.boss.type === "bigfoot" ? 8 : 14));
    state.boss.x += (Math.max(minBossX, Math.min(maxBossX, state.boss.targetX)) - state.boss.x) * 0.045;
    state.boss.y += (Math.max(minBossY, Math.min(maxBossY, state.boss.targetY + bob)) - state.boss.y) * 0.06;
    state.bossAttackTimer -= 1;
    if (state.bossAttackTimer <= 0) {
      spawnBossAttack();
      const pressure = Math.min(20, state.bossFightCount * 3);
      const bossPaces = { crab: 72, biber: 88, alien: 64, bigfoot: 92, dinosaur: 82 };
      const bossPace = bossPaces[state.boss.type] || 82;
      state.bossAttackTimer = Math.max(46, bossPace - pressure + Math.random() * 38);
    }
    state.bossPickupTimer -= 1;
    if (state.bossPickupTimer <= 0) {
      spawnBossWeaponPickup();
      state.bossPickupTimer = 430 + Math.random() * 260;
    }
  }

  for (const attack of state.bossAttacks) {
    attack.phase += 0.18;
    if (attack.homing) {
      const targetX = state.horse.x + state.horse.width * 0.55;
      const targetY = state.horse.y - state.horse.height * 0.5;
      const dx = targetX - (attack.x + attack.width / 2);
      const dy = targetY - (attack.y + attack.height / 2);
      const distance = Math.max(1, Math.hypot(dx, dy));
      const speed = Math.max(6.8, Math.hypot(attack.vx, attack.vy));
      attack.vx += ((dx / distance) * speed - attack.vx) * attack.homing;
      attack.vy += ((dy / distance) * speed - attack.vy) * attack.homing;
    }
    attack.x += attack.vx;
    attack.y += attack.vy;
    if (attack.type === "bubble") {
      attack.y += Math.sin(attack.phase) * 1.3;
    } else if (attack.type === "claw") {
      attack.y += Math.sin(attack.phase * 1.4) * 2.2;
    } else if (attack.type === "meteor") {
      attack.vy = Math.min(5.6, attack.vy + 0.075);
      attack.x += Math.sin(attack.phase) * 0.8;
    } else if (attack.type === "branch") {
      attack.vy = Math.min(4.2, attack.vy + 0.04);
      attack.y += Math.sin(attack.phase) * 0.8;
    } else if (attack.type === "plasma") {
      attack.y += Math.sin(attack.phase * 1.7) * 1.1;
    } else if (attack.type === "boulder") {
      attack.vy = Math.min(5.8, attack.vy + 0.11);
      attack.x += Math.sin(attack.phase) * 0.6;
    } else if (attack.type === "shockwave") {
      attack.y = GROUND_Y - attack.height - 6;
    }
  }
  state.bossAttacks = state.bossAttacks.filter((attack) => (
    attack.x + attack.width > -30 &&
    attack.y > 20 &&
    attack.y < HEIGHT + 40
  ));

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
    if (pickup.kind?.startsWith("boss")) {
      pickup.x += Math.sin(state.frame * 0.04 + pickup.pulse) * 0.5;
      pickup.y += Math.cos(state.frame * 0.035 + pickup.pulse) * 0.35;
    } else {
      pickup.x -= state.worldSpeed;
    }
    pickup.pulse += 0.12;
  }
  if (hasAnyActivePerk()) {
    state.pickups = state.pickups.filter((pickup) => pickup.kind !== "apple" && pickup.kind !== "rotten" && pickup.kind !== "meat");
  }
  state.pickups = state.pickups.filter((pickup) => pickup.x > -40);
  if (state.bossWeapon && state.bossWeaponUntil <= state.frame) {
    state.bossWeapon = null;
  }

  for (const burst of state.celebrationBursts) {
    burst.x += burst.vx;
    burst.y += burst.vy;
    burst.vy += 0.08;
    burst.life -= 1;
  }
  state.celebrationBursts = state.celebrationBursts.filter((burst) => burst.life > 0);

  if ((state.blasterUntil > state.frame || isBossFightActive()) && state.frame >= state.nextShotFrame) {
    const target = state.boss || state.flyingEnemies[0] || state.obstacles[0];
    const shotX = state.horse.x + 170;
    const shotY = state.horse.y - 90;
    const targetX = target ? target.x + target.width / 2 : WIDTH;
    const targetY = target ? target.y + target.height / 2 : shotY;
    const distance = Math.max(1, Math.hypot(targetX - shotX, targetY - shotY));
    const activeWeapon = state.bossWeaponUntil > state.frame ? state.bossWeapon : null;
    const speed = activeWeapon?.kind === "bossLaser" ? 25 : (state.boss ? 17.5 : 15);
    const baseVx = ((targetX - shotX) / distance) * speed;
    const baseVy = ((targetY - shotY) / distance) * speed;
    const shots = activeWeapon?.kind === "bossSpread" ? [-0.18, 0, 0.18] : [0];
    for (const angleOffset of shots) {
      const angle = Math.atan2(baseVy, baseVx) + angleOffset;
      state.projectiles.push({
        x: shotX,
        y: shotY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: activeWeapon?.kind === "bossMega" ? 11 : (activeWeapon?.kind === "bossLaser" ? 5 : 7),
        damage: activeWeapon?.kind === "bossMega" ? 4 : (activeWeapon?.kind === "bossLaser" ? 2 : 1),
        kind: activeWeapon?.kind || "carrot",
      });
    }
    state.nextShotFrame = state.frame + (state.boss ? (activeWeapon?.kind === "bossLaser" ? 5 : 11) : 10);
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
      if (pickup.kind?.startsWith("boss")) {
        activateBossWeapon(pickup.weapon);
        state.score += 60;
      } else if (pickup.kind === "meat") {
        activateBullPower();
        state.score += 150;
      } else if (pickup.kind === "rotten") {
        activateRottenApplePower();
        spawnCelebrationBurst(pickup.x, pickup.y, ["#8bc34a", "#c5e1a5", "#aed581"]);
        state.score += 120;
      } else {
        activateApplePower();
        spawnCelebrationBurst(pickup.x, pickup.y, ["#ff7043", "#ffcc80", "#ef5350"]);
        state.score += 120;
      }
    }
  }

  for (const projectile of [...state.projectiles]) {
    if (state.boss) {
      const bossHit = (
        projectile.x + projectile.size > state.boss.x &&
        projectile.x - projectile.size < state.boss.x + state.boss.width &&
        projectile.y + projectile.size > state.boss.y &&
        projectile.y - projectile.size < state.boss.y + state.boss.height
      );
      if (bossHit) {
        state.projectiles.splice(state.projectiles.indexOf(projectile), 1);
        const damage = projectile.damage || 1;
        state.boss.hp -= damage;
        state.score += 35 * damage;
        spawnCelebrationBurst(projectile.x, projectile.y, ["#ff7043", "#ffd54f", "#66d2a7"]);
        playSmashSound();
        if (state.boss.hp <= 0) {
          finishBossFight();
        }
        continue;
      }
    }

    let attackDestroyed = false;
    for (const attack of [...state.bossAttacks]) {
      const attackHit = (
        projectile.x + projectile.size > attack.x &&
        projectile.x - projectile.size < attack.x + attack.width &&
        projectile.y + projectile.size > attack.y &&
        projectile.y - projectile.size < attack.y + attack.height
      );
      if (attackHit) {
        state.projectiles.splice(state.projectiles.indexOf(projectile), 1);
        state.bossAttacks.splice(state.bossAttacks.indexOf(attack), 1);
        spawnCelebrationBurst(attack.x + attack.width / 2, attack.y + attack.height / 2, ["#ffd54f", "#ffffff", "#66d2a7"]);
        state.score += 18;
        attackDestroyed = true;
        break;
      }
    }

    if (attackDestroyed || !state.projectiles.includes(projectile)) {
      continue;
    }

    let projectileUsed = false;
    for (const enemy of [...state.flyingEnemies]) {
      const hit = (
        projectile.x + projectile.size > enemy.x &&
        projectile.x - projectile.size < enemy.x + enemy.width &&
        projectile.y + projectile.size > enemy.y &&
        projectile.y - projectile.size < enemy.y + enemy.height
      );
      if (hit) {
        state.projectiles.splice(state.projectiles.indexOf(projectile), 1);
        state.flyingEnemies.splice(state.flyingEnemies.indexOf(enemy), 1);
        state.score += 75;
        spawnCelebrationBurst(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, ["#66d2a7", "#ffd54f", "#ffffff"]);
        playSmashSound();
        projectileUsed = true;
        break;
      }
    }

    if (projectileUsed || !state.projectiles.includes(projectile)) {
      continue;
    }

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

  for (const attack of [...state.bossAttacks]) {
    const overlap = (
      horseBox.left < attack.x + attack.width - 4 &&
      horseBox.right > attack.x + 4 &&
      horseBox.top < attack.y + attack.height - 2 &&
      horseBox.bottom > attack.y + 2
    );
    if (overlap) {
      state.bossAttacks.splice(state.bossAttacks.indexOf(attack), 1);
      damageBossFight(attack.x + attack.width / 2, attack.y + attack.height / 2);
      if (state.gameOver) {
        return;
      }
    }
  }

  for (const enemy of state.flyingEnemies) {
    const overlap = (
      horseBox.left < enemy.x + enemy.width - 4 &&
      horseBox.right > enemy.x + 4 &&
      horseBox.top < enemy.y + enemy.height &&
      horseBox.bottom > enemy.y
    );
    if (overlap) {
      if (state.invisibleUntil > state.frame || state.invisibilityGraceUntil > state.frame) {
        continue;
      }
      state.gameOver = true;
      state.status = `Game over. Final score: ${state.score}`;
      stopAreaMusic();
      playCrashSound();
      return;
    }
  }

  if (state.boss) {
    const bossOverlap = (
      horseBox.left < state.boss.x + state.boss.width - 10 &&
      horseBox.right > state.boss.x + 10 &&
      horseBox.top < state.boss.y + state.boss.height &&
      horseBox.bottom > state.boss.y
    );
    if (bossOverlap && state.invisibleUntil <= state.frame && state.invisibilityGraceUntil <= state.frame) {
      damageBossFight(state.horse.x + state.horse.width / 2, state.horse.y - state.horse.height / 2);
      return;
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
      if (state.bullUntil > state.frame) {
        spawnCelebrationBurst(obstacle.x + obstacle.width / 2, obstacle.y + obstacle.height / 2, ["#ff7043", "#ffeb3b", "#ffffff"]);
        state.obstacles.splice(state.obstacles.indexOf(obstacle), 1);
        state.score += 42;
        playSmashSound();
        continue;
      }
      if (state.invisibleUntil > state.frame || state.invisibilityGraceUntil > state.frame) {
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

function drawBird(bird) {
  const wingLift = Math.sin(bird.flap) * 6 * bird.size;
  ctx.save();
  ctx.translate(bird.x, bird.y);
  ctx.strokeStyle = "rgba(78, 68, 55, 0.8)";
  ctx.lineWidth = 2.4 * bird.size;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-14 * bird.size, 0);
  ctx.quadraticCurveTo(-6 * bird.size, -wingLift, 0, 0);
  ctx.quadraticCurveTo(6 * bird.size, -wingLift, 14 * bird.size, 0);
  ctx.stroke();
  ctx.restore();
}

function drawFlyingEnemy(enemy) {
  const flap = Math.sin(state.frame * 0.34 + enemy.phase) * 8;
  ctx.save();
  ctx.translate(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2);
  ctx.fillStyle = "#2f4059";
  ctx.strokeStyle = "#142033";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, enemy.width * 0.26, enemy.height * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#5c7da8";
  ctx.beginPath();
  ctx.moveTo(-8, -2);
  ctx.quadraticCurveTo(-34, -22 - flap, -enemy.width * 0.58, 2);
  ctx.quadraticCurveTo(-28, 16, -8, 8);
  ctx.moveTo(8, -2);
  ctx.quadraticCurveTo(34, -22 - flap, enemy.width * 0.58, 2);
  ctx.quadraticCurveTo(28, 16, 8, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f6d15f";
  ctx.beginPath();
  ctx.moveTo(enemy.width * 0.22, -2);
  ctx.lineTo(enemy.width * 0.38, 3);
  ctx.lineTo(enemy.width * 0.22, 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(8, -6, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#142033";
  ctx.beginPath();
  ctx.arc(9, -6, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBossPixelBase(boss) {
  const baseY = boss.height + 16;
  const platformColor = boss.type === "alien" ? "#303846" : (boss.type === "crab" ? "#9b6a3d" : "#5b442f");
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(boss.width * 0.48, baseY + 6, boss.width * 0.52, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = platformColor;
  ctx.strokeStyle = "#24170f";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(4, boss.height - 4, boss.width - 8, 24, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = boss.type === "alien" ? "#94a3b8" : "#7b5a35";
  for (let index = 0; index < 9; index += 1) {
    const chipX = 14 + index * Math.max(12, boss.width / 11);
    const chipY = boss.height + (index % 3) * 5;
    ctx.fillRect(chipX, chipY, 8, 3);
  }
  if (boss.type === "alien") {
    const beam = ctx.createLinearGradient(boss.width * 0.5, 72, boss.width * 0.5, boss.height + 24);
    beam.addColorStop(0, "rgba(163, 255, 91, 0.42)");
    beam.addColorStop(1, "rgba(163, 255, 91, 0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(boss.width * 0.34, 74);
    ctx.lineTo(boss.width * 0.66, 74);
    ctx.lineTo(boss.width * 0.76, boss.height + 18);
    ctx.lineTo(boss.width * 0.24, boss.height + 18);
    ctx.closePath();
    ctx.fill();
  }
}

function drawBossPixelHighlights(points) {
  for (const [x, y, width, height, color] of points) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
  }
}

function drawBossPixelOverlay(boss) {
  const pulse = Math.sin(boss.phase * 2);
  const blink = Math.floor(state.frame / 10) % 2;
  if (boss.type === "crab") {
    ctx.fillStyle = "#ff6b3d";
    ctx.strokeStyle = "#66170d";
    ctx.lineWidth = 4;
    for (const side of [-1, 1]) {
      const clawX = boss.width * 0.48 + side * (74 + pulse * 5);
      const clawY = 32 - Math.max(0, pulse) * 7;
      ctx.beginPath();
      ctx.ellipse(clawX, clawY, 24, 38, side * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#b52d19";
      ctx.beginPath();
      ctx.moveTo(clawX - side * 6, clawY - 7);
      ctx.quadraticCurveTo(clawX + side * 36, clawY - 38, clawX + side * 14, clawY + 13);
      ctx.quadraticCurveTo(clawX + side * 2, clawY + 4, clawX - side * 6, clawY - 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ff6b3d";
    }
    ctx.fillStyle = "#ffd166";
    for (let spike = 0; spike < 7; spike += 1) {
      ctx.beginPath();
      ctx.moveTo(42 + spike * 15, 29);
      ctx.lineTo(48 + spike * 15, 10 + (spike % 2) * 5);
      ctx.lineTo(56 + spike * 15, 29);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    drawBossPixelHighlights([
      [34, 50, 7, 5, "#ffb199"],
      [78, 38, 8, 5, "#ffb199"],
      [110, 58, 6, 4, "#ffd0b8"],
      [145, 45, 7, 5, "#ffb199"],
    ]);
  } else if (boss.type === "biber") {
    ctx.fillStyle = "#5a351f";
    ctx.strokeStyle = "#2b170d";
    ctx.lineWidth = 5;
    ctx.save();
    ctx.translate(108, 60 + pulse * 2);
    ctx.rotate(-0.07 + pulse * 0.02);
    ctx.beginPath();
    ctx.roundRect(-10, -10, 82, 24, 9);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#b7793f";
    ctx.lineWidth = 2;
    for (let line = 0; line < 5; line += 1) {
      ctx.beginPath();
      ctx.moveTo(0 + line * 14, -7);
      ctx.lineTo(8 + line * 14, 12);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = "#3a2112";
    for (let fur = 0; fur < 22; fur += 1) {
      const fx = 32 + (fur * 19) % 112;
      const fy = 28 + (fur * 13) % 70;
      ctx.fillRect(fx, fy, 5, 9);
    }
    ctx.fillStyle = "#17100b";
    ctx.beginPath();
    ctx.arc(78, 56, 5 + blink, 0, Math.PI * 2);
    ctx.arc(101, 56, 5 + blink, 0, Math.PI * 2);
    ctx.fill();
  } else if (boss.type === "alien") {
    ctx.strokeStyle = "rgba(201, 255, 255, 0.76)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(68, 43, 45, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    ctx.fillStyle = "rgba(185, 255, 105, 0.24)";
    ctx.beginPath();
    ctx.ellipse(68, 43, 34, 25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#151527";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(100, 50);
    ctx.quadraticCurveTo(126, 35 + pulse * 8, 125, 19);
    ctx.stroke();
    ctx.fillStyle = "#b7ff5e";
    ctx.beginPath();
    ctx.arc(126, 18, 5, 0, Math.PI * 2);
    ctx.fill();
    drawBossPixelHighlights([
      [35, 18, 7, 7, "#ffffff"],
      [45, 15, 4, 4, "#ffffff"],
      [50, 86, 8, 5, "#f0abfc"],
      [82, 89, 8, 5, "#22d3ee"],
      [114, 86, 8, 5, "#f0abfc"],
    ]);
  } else if (boss.type === "bigfoot") {
    ctx.fillStyle = "#2b170d";
    for (let fur = 0; fur < 34; fur += 1) {
      const fx = 34 + (fur * 23) % 138;
      const fy = 20 + (fur * 17) % 92;
      ctx.fillRect(fx, fy, 5, 13);
    }
    ctx.fillStyle = "#f8dfbc";
    for (let tooth = 0; tooth < 5; tooth += 1) {
      ctx.beginPath();
      ctx.moveTo(78 + tooth * 7, 82);
      ctx.lineTo(82 + tooth * 7, 94);
      ctx.lineTo(86 + tooth * 7, 82);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = "#2b170d";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(78, 43);
    ctx.lineTo(91, 51);
    ctx.moveTo(113, 43);
    ctx.lineTo(101, 51);
    ctx.stroke();
    ctx.fillStyle = "#1a0f0a";
    ctx.beginPath();
    ctx.arc(90, 64, 4 + blink, 0, Math.PI * 2);
    ctx.arc(110, 64, 4 + blink, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const jawOpen = 8 + Math.max(0, pulse) * 8;
    ctx.fillStyle = "#173d1f";
    ctx.strokeStyle = "#0d2413";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(42, 48);
    ctx.quadraticCurveTo(-16, 52 + pulse * 8, -2, 84);
    ctx.stroke();
    ctx.fillStyle = "#263f1d";
    for (let scale = 0; scale < 22; scale += 1) {
      const sx = 38 + (scale * 17) % 112;
      const sy = 42 + (scale * 11) % 48;
      ctx.fillRect(sx, sy, 6, 5);
    }
    ctx.fillStyle = "#f7ead0";
    for (let tooth = 0; tooth < 8; tooth += 1) {
      ctx.beginPath();
      ctx.moveTo(boss.width - 34 + tooth * 5, 56);
      ctx.lineTo(boss.width - 31 + tooth * 5, 56 + jawOpen);
      ctx.lineTo(boss.width - 28 + tooth * 5, 56);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "#d44b2e";
    ctx.beginPath();
    ctx.ellipse(boss.width - 20, 68 + jawOpen * 0.35, 16, 7, 0.1, 0, Math.PI * 2);
    ctx.fill();
    drawBossPixelHighlights([
      [72, 30, 7, 5, "#a4bf52"],
      [94, 39, 6, 4, "#a4bf52"],
      [118, 52, 7, 5, "#c6d36c"],
    ]);
  }
}

function drawBoss(boss) {
  ctx.save();
  ctx.translate(boss.x, boss.y);
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(boss.width * 0.48, boss.height + 8, boss.width * 0.42, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  drawBossPixelBase(boss);
  ctx.strokeStyle = boss.palette?.[2] || "#251520";
  ctx.lineWidth = 4;

  if (boss.type === "crab") {
    ctx.fillStyle = boss.palette[0];
    ctx.beginPath();
    ctx.ellipse(boss.width * 0.48, 54, 54, 32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ff806d";
    ctx.beginPath();
    ctx.ellipse(boss.width * 0.34, 44, 18, 11, -0.4, 0, Math.PI * 2);
    ctx.ellipse(boss.width * 0.62, 56, 20, 12, 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = boss.palette[2];
    ctx.lineWidth = 5;
    for (const side of [-1, 1]) {
      const baseX = boss.width * 0.48 + side * 46;
      ctx.beginPath();
      ctx.moveTo(baseX, 56);
      ctx.quadraticCurveTo(baseX + side * 32, 30 + Math.sin(boss.phase) * 6, baseX + side * 54, 46);
      ctx.stroke();
      ctx.fillStyle = boss.palette[0];
      ctx.beginPath();
      ctx.moveTo(baseX + side * 54, 46);
      ctx.quadraticCurveTo(baseX + side * 78, 26, baseX + side * 72, 62);
      ctx.quadraticCurveTo(baseX + side * 58, 60, baseX + side * 54, 46);
      ctx.fill();
      ctx.stroke();
      for (let leg = 0; leg < 3; leg += 1) {
        ctx.beginPath();
        ctx.moveTo(boss.width * 0.48 + side * (18 + leg * 15), 76);
        ctx.lineTo(boss.width * 0.48 + side * (38 + leg * 18), 96);
        ctx.stroke();
      }
    }
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(boss.width * 0.38, 22, 8, 0, Math.PI * 2);
    ctx.arc(boss.width * 0.56, 22, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1b1018";
    ctx.beginPath();
    ctx.arc(boss.width * 0.4, 23, 3, 0, Math.PI * 2);
    ctx.arc(boss.width * 0.58, 23, 3, 0, Math.PI * 2);
    ctx.fill();
  } else if (boss.type === "biber") {
    ctx.fillStyle = boss.palette[0];
    ctx.beginPath();
    ctx.roundRect(18, 26, boss.width - 52, boss.height - 36, 28);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ad7645";
    ctx.beginPath();
    ctx.ellipse(62, 62, 28, 18, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#5a351f";
    ctx.beginPath();
    ctx.ellipse(12, 72, 24, 38, -0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#2d1a0f";
    ctx.lineWidth = 2;
    for (let line = -2; line <= 2; line += 1) {
      ctx.beginPath();
      ctx.moveTo(4 + line * 5, 52);
      ctx.lineTo(20 + line * 5, 94);
      ctx.stroke();
    }
    ctx.fillStyle = "#f0c49a";
    ctx.beginPath();
    ctx.roundRect(boss.width - 58, 45, 42, 34, 15);
    ctx.fill();
    ctx.strokeStyle = boss.palette[2];
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(boss.width - 38, 64, 9, 18);
    ctx.fillRect(boss.width - 28, 64, 9, 18);
    ctx.fillStyle = "#1b1018";
    ctx.beginPath();
    ctx.arc(boss.width - 46, 54, 3.6, 0, Math.PI * 2);
    ctx.arc(boss.width - 28, 54, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = boss.palette[2];
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(44, 96);
    ctx.lineTo(30, boss.height + 4);
    ctx.moveTo(96, 96);
    ctx.lineTo(110, boss.height + 4);
    ctx.stroke();
  } else if (boss.type === "alien") {
    const float = Math.sin(boss.phase * 1.5) * 4;
    ctx.save();
    ctx.translate(0, float);
    const glow = ctx.createRadialGradient(boss.width * 0.5, 76, 8, boss.width * 0.5, 76, 88);
    glow.addColorStop(0, "rgba(125, 249, 255, 0.5)");
    glow.addColorStop(1, "rgba(139, 92, 246, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(boss.width * 0.5, 80, 86, 46, 0, 0, Math.PI * 2);
    ctx.fill();

    const hull = ctx.createLinearGradient(30, 54, boss.width - 24, 98);
    hull.addColorStop(0, "#d8fbff");
    hull.addColorStop(0.48, "#8b5cf6");
    hull.addColorStop(1, "#3b0764");
    ctx.fillStyle = hull;
    ctx.strokeStyle = boss.palette[2];
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(boss.width * 0.5, 78, 70, 24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.beginPath();
    ctx.ellipse(boss.width * 0.36, 67, 24, 7, -0.14, 0, Math.PI * 2);
    ctx.fill();
    for (let lamp = 0; lamp < 5; lamp += 1) {
      const lx = boss.width * 0.24 + lamp * 24;
      ctx.fillStyle = lamp % 2 ? "#22d3ee" : "#f0abfc";
      ctx.beginPath();
      ctx.arc(lx, 84 + Math.sin(boss.phase * 2 + lamp) * 2, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const head = ctx.createRadialGradient(64, 38, 10, 64, 44, 46);
    head.addColorStop(0, "#d9f99d");
    head.addColorStop(0.58, "#76d86d");
    head.addColorStop(1, "#287342");
    ctx.fillStyle = head;
    ctx.strokeStyle = "#173d1f";
    ctx.beginPath();
    ctx.ellipse(68, 42, 40, 32, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#101024";
    ctx.beginPath();
    ctx.ellipse(54, 39, 8, 16, -0.28, 0, Math.PI * 2);
    ctx.ellipse(78, 39, 8, 16, 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#173d1f";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(46, 16);
    ctx.lineTo(36, 2);
    ctx.moveTo(86, 16);
    ctx.lineTo(96, 2);
    ctx.stroke();
    ctx.fillStyle = "#a7f3d0";
    ctx.beginPath();
    ctx.arc(36, 2, 5, 0, Math.PI * 2);
    ctx.arc(96, 2, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (boss.type === "bigfoot") {
    const stomp = Math.sin(boss.phase * 2) * 4;
    const fur = ctx.createLinearGradient(24, 22, boss.width - 20, boss.height);
    fur.addColorStop(0, "#c47a43");
    fur.addColorStop(0.52, "#7a4123");
    fur.addColorStop(1, "#2f1a10");
    ctx.fillStyle = fur;
    ctx.strokeStyle = boss.palette[2];
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(46, 30, boss.width - 76, boss.height - 34, 30);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 224, 188, 0.28)";
    ctx.beginPath();
    ctx.ellipse(82, 54, 30, 18, -0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#9a5b31";
    for (let tuft = 0; tuft < 8; tuft += 1) {
      ctx.beginPath();
      ctx.moveTo(52 + tuft * 13, 32);
      ctx.lineTo(60 + tuft * 13, 16 + (tuft % 2) * 8);
      ctx.lineTo(70 + tuft * 13, 34);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.fillStyle = "#d49a6a";
    ctx.beginPath();
    ctx.roundRect(64, 44, 54, 45, 18);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1a100b";
    ctx.beginPath();
    ctx.arc(78, 61, 4, 0, Math.PI * 2);
    ctx.arc(103, 61, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2f1a10";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(82, 78);
    ctx.quadraticCurveTo(91, 86, 104, 78);
    ctx.stroke();

    ctx.strokeStyle = "#3a2012";
    ctx.lineWidth = 13;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(52, 64);
    ctx.quadraticCurveTo(18, 80 + stomp, 34, 112);
    ctx.moveTo(boss.width - 44, 66);
    ctx.quadraticCurveTo(boss.width - 6, 84 - stomp, boss.width - 28, 112);
    ctx.stroke();
    ctx.fillStyle = "#5b321d";
    ctx.beginPath();
    ctx.ellipse(54, boss.height + 2 + Math.max(0, stomp), 34, 11, 0, 0, Math.PI * 2);
    ctx.ellipse(132, boss.height + 2 - Math.min(0, stomp), 38, 12, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = boss.palette?.[0] || "#6fb34a";
    ctx.beginPath();
    ctx.ellipse(78, 62, 68, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#92d66b";
    ctx.beginPath();
    ctx.ellipse(76, 72, 44, 16, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = boss.palette?.[2] || "#173d1f";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(20, 56);
    ctx.quadraticCurveTo(-18, 28 + Math.sin(boss.phase) * 7, 14, 30);
    ctx.stroke();
    ctx.fillStyle = boss.palette?.[0] || "#6fb34a";
    ctx.beginPath();
    ctx.ellipse(boss.width - 44, 42, 36, 28, -0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(boss.width - 26, 55);
    ctx.lineTo(boss.width - 8, 60);
    ctx.lineTo(boss.width - 28, 66);
    ctx.lineTo(boss.width - 20, 61);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#1b1018";
    ctx.beginPath();
    ctx.arc(boss.width - 50, 36, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#d6ef82";
    for (let spike = 0; spike < 5; spike += 1) {
      ctx.beginPath();
      ctx.moveTo(36 + spike * 20, 28);
      ctx.lineTo(48 + spike * 20, 4 + (spike % 2) * 8);
      ctx.lineTo(60 + spike * 20, 30);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.strokeStyle = boss.palette?.[2] || "#173d1f";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(56, 90);
    ctx.lineTo(46, boss.height + 4);
    ctx.moveTo(112, 88);
    ctx.lineTo(122, boss.height + 4);
    ctx.stroke();
  }

  drawBossPixelOverlay(boss);

  const hpWidth = boss.width - 24;
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fillRect(12, 4, hpWidth, 8);
  ctx.fillStyle = "#66d2a7";
  ctx.fillRect(12, 4, hpWidth * Math.max(0, boss.hp / boss.maxHp), 8);
  ctx.strokeStyle = "#251520";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(12, 4, hpWidth, 8);
  ctx.restore();
}

function drawBossAttack(attack) {
  ctx.save();
  ctx.translate(attack.x + attack.width / 2, attack.y + attack.height / 2);
  const aimedAngle = attack.type === "laser" ? Math.atan2(attack.vy, attack.vx) : 0;
  const spinAngle = attack.type === "log" || attack.type === "branch" || attack.type === "boulder" ? attack.phase * 1.2 : 0;
  ctx.rotate(aimedAngle || spinAngle);
  if (attack.type === "bubble") {
    ctx.fillStyle = "rgba(123, 205, 255, 0.5)";
    ctx.strokeStyle = "rgba(22, 88, 137, 0.75)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, attack.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.beginPath();
    ctx.arc(-6, -7, 4, 0, Math.PI * 2);
    ctx.fill();
  } else if (attack.type === "claw") {
    ctx.fillStyle = "#f05243";
    ctx.strokeStyle = "#7f1d1d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-attack.width / 2, 0);
    ctx.quadraticCurveTo(-8, -attack.height * 0.8, attack.width / 2, -7);
    ctx.quadraticCurveTo(6, 0, attack.width / 2, 9);
    ctx.quadraticCurveTo(-8, attack.height * 0.72, -attack.width / 2, 0);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffd1ca";
    ctx.beginPath();
    ctx.moveTo(attack.width / 2 - 8, -8);
    ctx.lineTo(attack.width / 2 + 8, -13);
    ctx.lineTo(attack.width / 2 - 2, 0);
    ctx.closePath();
    ctx.fill();
  } else if (attack.type === "log") {
    ctx.fillStyle = "#7b5230";
    ctx.strokeStyle = "#3e2514";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(-attack.width / 2, -attack.height / 2, attack.width, attack.height, 10);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#c0905c";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-attack.width / 2 + 10, -4);
    ctx.lineTo(attack.width / 2 - 8, -4);
    ctx.moveTo(-attack.width / 2 + 10, 5);
    ctx.lineTo(attack.width / 2 - 8, 5);
    ctx.stroke();
  } else if (attack.type === "branch") {
    ctx.strokeStyle = "#3e2514";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(-attack.width / 2, 0);
    ctx.lineTo(attack.width / 2, 0);
    ctx.stroke();
    ctx.strokeStyle = "#8b5a32";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(5, -15);
    ctx.moveTo(8, 0);
    ctx.lineTo(22, 12);
    ctx.stroke();
    ctx.fillStyle = "#5f7f35";
    ctx.beginPath();
    ctx.ellipse(8, -16, 8, 4, -0.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (attack.type === "meteor") {
    ctx.fillStyle = "rgba(255, 107, 35, 0.26)";
    ctx.beginPath();
    ctx.ellipse(-18, 0, 32, 13, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff7043";
    ctx.strokeStyle = "#8f2619";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, attack.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffd54f";
    ctx.beginPath();
    ctx.arc(-4, -5, attack.size * 0.42, 0, Math.PI * 2);
    ctx.fill();
  } else if (attack.type === "plasma") {
    const plasmaGlow = ctx.createRadialGradient(0, 0, 4, 0, 0, attack.size * 1.7);
    plasmaGlow.addColorStop(0, "rgba(255,255,255,0.96)");
    plasmaGlow.addColorStop(0.42, "rgba(34,211,238,0.78)");
    plasmaGlow.addColorStop(1, "rgba(139,92,246,0)");
    ctx.fillStyle = plasmaGlow;
    ctx.beginPath();
    ctx.arc(0, 0, attack.size * 1.65, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#4c1d95";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, attack.size, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(240,171,252,0.82)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, attack.size * 1.15, attack.size * 0.44, attack.phase, 0, Math.PI * 2);
    ctx.stroke();
  } else if (attack.type === "laser") {
    ctx.fillStyle = "rgba(103,232,249,0.26)";
    ctx.beginPath();
    ctx.roundRect(-attack.width / 2 - 14, -attack.height / 2 - 4, attack.width + 24, attack.height + 8, 12);
    ctx.fill();
    const beam = ctx.createLinearGradient(-attack.width / 2, 0, attack.width / 2, 0);
    beam.addColorStop(0, "#a78bfa");
    beam.addColorStop(0.5, "#ffffff");
    beam.addColorStop(1, "#22d3ee");
    ctx.fillStyle = beam;
    ctx.strokeStyle = "#4c1d95";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-attack.width / 2, -7);
    ctx.lineTo(attack.width / 2, -3);
    ctx.lineTo(attack.width / 2 + 12, 0);
    ctx.lineTo(attack.width / 2, 3);
    ctx.lineTo(-attack.width / 2, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (attack.type === "boulder") {
    const rock = ctx.createRadialGradient(-8, -9, 4, 0, 0, attack.size * 1.3);
    rock.addColorStop(0, "#f0d0a8");
    rock.addColorStop(0.44, "#8a6a4a");
    rock.addColorStop(1, "#3e2a1b");
    ctx.fillStyle = rock;
    ctx.strokeStyle = "#2f1a10";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-22, -6);
    ctx.lineTo(-10, -22);
    ctx.lineTo(13, -19);
    ctx.lineTo(24, -3);
    ctx.lineTo(16, 20);
    ctx.lineTo(-8, 23);
    ctx.lineTo(-24, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath();
    ctx.ellipse(-8, -10, 8, 4, -0.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (attack.type === "shockwave") {
    ctx.fillStyle = "rgba(120, 72, 37, 0.28)";
    ctx.beginPath();
    ctx.ellipse(0, 12, attack.width * 0.72, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#a16207";
    ctx.strokeStyle = "#422006";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-attack.width / 2, 8);
    ctx.quadraticCurveTo(-16, -20, 4, 4);
    ctx.quadraticCurveTo(22, 24, attack.width / 2, 0);
    ctx.lineTo(attack.width / 2, 17);
    ctx.lineTo(-attack.width / 2, 17);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillStyle = "#ff7043";
    ctx.strokeStyle = "#8f2619";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, attack.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 214, 79, 0.82)";
    ctx.beginPath();
    ctx.arc(-4, -5, attack.size * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBossFightHud() {
  if (!state.boss) {
    return;
  }
  ctx.save();
  ctx.fillStyle = "rgba(255, 250, 238, 0.86)";
  ctx.strokeStyle = "#6f4e37";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(WIDTH / 2 - 150, 18, 300, 48, 15);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#31261f";
  ctx.font = "bold 16px Trebuchet MS";
  ctx.textAlign = "center";
  ctx.fillText(`${state.boss.label} Boss`, WIDTH / 2, 39);
  ctx.font = "12px Trebuchet MS";
  const weaponText = state.bossWeapon && state.bossWeaponUntil > state.frame
    ? `${state.bossWeapon.label}: ${Math.ceil((state.bossWeaponUntil - state.frame) / 60)}s`
    : "grab weapons";
  ctx.fillText(weaponText, WIDTH / 2, 57);
  ctx.textAlign = "left";
  for (let index = 0; index < BOSS_FIGHT_LIVES; index += 1) {
    ctx.fillStyle = index < state.bossLives ? "#ef4444" : "rgba(90,70,58,0.22)";
    ctx.beginPath();
    const heartX = WIDTH / 2 + 94 + index * 20;
    const heartY = 34;
    ctx.moveTo(heartX, heartY + 8);
    ctx.bezierCurveTo(heartX - 13, heartY - 2, heartX - 7, heartY - 14, heartX, heartY - 7);
    ctx.bezierCurveTo(heartX + 7, heartY - 14, heartX + 13, heartY - 2, heartX, heartY + 8);
    ctx.fill();
  }

  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(20, 12, 10, 0.5)";
  ctx.strokeStyle = "rgba(255, 250, 238, 0.48)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(12, HEIGHT - 54, 214, 30, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#fff7e6";
  ctx.font = "bold 11px Trebuchet MS";
  ctx.fillText("Boss dodge: A/D or ←/→ move", 24, HEIGHT - 35);
  ctx.restore();
}

function drawMeadowFloater(floater) {
  const bob = Math.sin(floater.phase) * 5;
  ctx.save();
  ctx.translate(floater.x, floater.y + bob);
  ctx.scale(floater.size, floater.size);
  ctx.fillStyle = "rgba(255, 245, 207, 0.55)";
  ctx.beginPath();
  ctx.ellipse(0, 0, 12, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f4c24f";
  ctx.beginPath();
  ctx.ellipse(-8, 0, 8, 5, -0.35, 0, Math.PI * 2);
  ctx.ellipse(8, 0, 8, 5, 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4b3422";
  ctx.fillRect(-1, -1, 2, 7);
  ctx.restore();
}

function drawHorse() {
  const horse = state.horse;
  const x = horse.x;
  const groundY = horse.y;
  const bullMode = state.bullUntil > state.frame;
  const invisibleFlash = state.invisibleUntil > state.frame && Math.floor(state.frame / 6) % 2 === 0;
  const running = !state.gameOver && horse.onGround;
  const stridePhase = running ? state.frame * (bullMode ? 0.48 : 0.32) : Math.PI / 2;
  const strideAmount = running ? (bullMode ? 15 : 10) : 3;
  const bodyFill = bullMode ? "#63342d" : (invisibleFlash ? "#c8dced" : "#9b6338");
  const bodyStroke = bullMode ? "#2e1711" : (invisibleFlash ? "#8ba1b3" : "#704522");
  const mirrorHorse = isBossFightActive() && horse.facing === -1;
  if (mirrorHorse) {
    ctx.save();
    ctx.translate(2 * (x + 90), 0);
    ctx.scale(-1, 1);
  }
  ctx.fillStyle = bodyFill;
  ctx.strokeStyle = bodyStroke;
  ctx.lineWidth = 3;

  if (FRIDAY_EVENT_ACTIVE) {
    for (let index = 0; index < 4; index += 1) {
      ctx.fillStyle = `rgba(255, ${190 - index * 22}, 90, ${0.18 - index * 0.03})`;
      ctx.beginPath();
      ctx.ellipse(x + 24 - index * 18, groundY - 42, 24 + index * 4, 12 + index * 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = bodyFill;
  ctx.strokeStyle = bodyStroke;
  ctx.lineWidth = 3;

  if (bullMode) {
    ctx.fillStyle = "#f0bf43";
    ctx.strokeStyle = "#7b3f16";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x + 134, groundY - 92, 32, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(x + 110, groundY - 104, 48, 10);
    ctx.strokeRect(x + 110, groundY - 104, 48, 10);
    ctx.fillStyle = "#d65b2a";
    ctx.fillRect(x + 116, groundY - 100, 8, 4);
    ctx.fillRect(x + 128, groundY - 100, 8, 4);
    ctx.fillRect(x + 140, groundY - 100, 8, 4);

    ctx.fillStyle = "#5b2e26";
    ctx.strokeStyle = "#2b150f";
    ctx.lineWidth = 4;

    ctx.beginPath();
    ctx.ellipse(x + 78, groundY - 52, 62, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(x + 132, groundY - 62, 30, 24, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#774236";
    ctx.beginPath();
    ctx.ellipse(x + 38, groundY - 58, 18, 20, 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#e9dcc8";
    ctx.beginPath();
    ctx.moveTo(x + 118, groundY - 82);
    ctx.quadraticCurveTo(x + 110, groundY - 100, x + 94, groundY - 92);
    ctx.lineTo(x + 106, groundY - 76);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + 148, groundY - 82);
    ctx.quadraticCurveTo(x + 166, groundY - 102, x + 182, groundY - 90);
    ctx.lineTo(x + 160, groundY - 76);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#c58a74";
    ctx.beginPath();
    ctx.roundRect(x + 142, groundY - 58, 28, 18, 9);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#2b150f";
    ctx.beginPath();
    ctx.arc(x + 148, groundY - 50, 2.5, 0, Math.PI * 2);
    ctx.arc(x + 160, groundY - 50, 2.5, 0, Math.PI * 2);
    ctx.arc(x + 146, groundY - 63, 2.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#2b150f";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(x + 30, groundY - 60);
    ctx.quadraticCurveTo(x + 6, groundY - 78, x + 16, groundY - 30);
    ctx.stroke();

    ctx.strokeStyle = "#2b150f";
    ctx.lineWidth = 8;
    for (const [index, legX] of [42, 68, 98, 122].entries()) {
      const swing = Math.sin(stridePhase + (index % 2 === 0 ? 0 : Math.PI)) * strideAmount;
      const kneeX = x + legX + swing * 0.34;
      const kneeY = groundY - 18 - Math.abs(swing) * 0.16 - (running ? 0 : 5);
      const hoofX = x + legX + swing * 0.66;
      ctx.beginPath();
      ctx.moveTo(x + legX, groundY - 28);
      ctx.lineTo(kneeX, kneeY);
      ctx.lineTo(hoofX, groundY);
      ctx.stroke();
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(hoofX - 5, groundY);
      ctx.lineTo(hoofX + 3, groundY);
      ctx.stroke();
      ctx.lineWidth = 8;
    }

    ctx.strokeStyle = "#2b150f";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x + 22, groundY - 70);
    ctx.quadraticCurveTo(x - 2, groundY - 96, x + 4, groundY - 118);
    ctx.stroke();
    ctx.fillStyle = "#f4d35e";
    ctx.beginPath();
    ctx.ellipse(x + 2, groundY - 120, 7, 5, 0.1, 0, Math.PI * 2);
    ctx.fill();
    if (mirrorHorse) ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.ellipse(x + 72, groundY - 52, 52, 28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = invisibleFlash ? "#6d8192" : "#3f2512";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(x + 28, groundY - 56);
  ctx.quadraticCurveTo(x - 2, groundY - 78, x + 12, groundY - 24);
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

  if (FRIDAY_EVENT_ACTIVE) {
    ctx.fillStyle = "#f06292";
    ctx.beginPath();
    ctx.moveTo(x + 144, groundY - 132);
    ctx.lineTo(x + 132, groundY - 154);
    ctx.lineTo(x + 156, groundY - 148);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffd54f";
    ctx.beginPath();
    ctx.arc(x + 144, groundY - 132, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = bodyStroke;
  ctx.lineWidth = 6;
  for (const [index, legX] of [44, 66, 94, 114].entries()) {
    const swing = Math.sin(stridePhase + (index % 2 === 0 ? 0 : Math.PI)) * strideAmount;
    const kneeX = x + legX + swing * 0.45;
    const kneeY = groundY - 12 - Math.abs(swing) * 0.18 - (running ? 0 : 6);
    const hoofX = x + legX + swing;
    const hoofY = groundY;
    ctx.beginPath();
    ctx.moveTo(x + legX, groundY - 24);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(hoofX, hoofY);
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
  if (mirrorHorse) ctx.restore();
}

function drawRivets(points, color = "rgba(47, 36, 27, 0.55)") {
  ctx.fillStyle = color;
  for (const [x, y, radius = 2] of points) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWoodGrain(x, y, width, height, color = "rgba(77, 50, 29, 0.35)") {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let index = 0; index < 4; index += 1) {
    const lineY = y + 8 + index * (height / 5);
    ctx.moveTo(x + 6, lineY);
    ctx.bezierCurveTo(x + width * 0.3, lineY - 4, x + width * 0.66, lineY + 5, x + width - 6, lineY);
  }
  ctx.stroke();
}

function draw3DBox(x, y, width, height, colors) {
  const depth = Math.min(16, width * 0.2, height * 0.32);
  const frontGradient = ctx.createLinearGradient(x, y, x + width, y + height);
  frontGradient.addColorStop(0, colors.frontLight);
  frontGradient.addColorStop(0.55, colors.front);
  frontGradient.addColorStop(1, colors.frontDark);

  ctx.fillStyle = colors.top;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + depth, y - depth);
  ctx.lineTo(x + width + depth, y - depth);
  ctx.lineTo(x + width, y);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = colors.side;
  ctx.beginPath();
  ctx.moveTo(x + width, y);
  ctx.lineTo(x + width + depth, y - depth);
  ctx.lineTo(x + width + depth, y + height - depth);
  ctx.lineTo(x + width, y + height);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = frontGradient;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = 2.4;
  ctx.strokeRect(x, y, width, height);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + depth, y - depth);
  ctx.lineTo(x + width + depth, y - depth);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x + width + depth, y - depth);
  ctx.lineTo(x + width + depth, y + height - depth);
  ctx.lineTo(x + width, y + height);
  ctx.stroke();

  const shine = ctx.createLinearGradient(x, y, x + width * 0.6, y + height * 0.6);
  shine.addColorStop(0, "rgba(255,255,255,0.34)");
  shine.addColorStop(0.42, "rgba(255,255,255,0.08)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.beginPath();
  ctx.moveTo(x + 5, y + 5);
  ctx.lineTo(x + width * 0.62, y + 5);
  ctx.lineTo(x + width * 0.38, y + height * 0.42);
  ctx.lineTo(x + 5, y + height * 0.3);
  ctx.closePath();
  ctx.fill();
}

function draw3DGloss(x, y, width, height, radius = 12) {
  const gloss = ctx.createLinearGradient(x, y, x + width, y + height);
  gloss.addColorStop(0, "rgba(255,255,255,0.32)");
  gloss.addColorStop(0.22, "rgba(255,255,255,0.12)");
  gloss.addColorStop(0.7, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height * 0.55, radius);
  ctx.fill();
}

function drawInsetShadow(x, y, width, height, radius = 12) {
  ctx.strokeStyle = "rgba(0,0,0,0.2)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x + 2, y + 2, width - 4, height - 4, radius);
  ctx.stroke();
}

function drawObstacle(obstacle) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath();
  ctx.ellipse(obstacle.x + obstacle.width / 2, GROUND_Y - 2, obstacle.width / 2, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  if (obstacle.type === "bush") {
    ctx.fillStyle = "#4f9446";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + 16, obstacle.y + 22, 18, 16, 0, 0, Math.PI * 2);
    ctx.ellipse(obstacle.x + 33, obstacle.y + 14, 20, 18, 0, 0, Math.PI * 2);
    ctx.ellipse(obstacle.x + 50, obstacle.y + 22, 18, 16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#79c86d";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + 24, obstacle.y + 18, 10, 8, 0, 0, Math.PI * 2);
    ctx.ellipse(obstacle.x + 42, obstacle.y + 16, 11, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(31, 85, 35, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(obstacle.x + 18, obstacle.y + 22, 10, Math.PI * 0.1, Math.PI * 1.1);
    ctx.arc(obstacle.x + 38, obstacle.y + 14, 12, Math.PI * 0.2, Math.PI * 1.2);
    ctx.arc(obstacle.x + 54, obstacle.y + 24, 9, Math.PI * 0.1, Math.PI * 1.1);
    ctx.stroke();
    drawRivets([
      [obstacle.x + 28, obstacle.y + 24, 2],
      [obstacle.x + 46, obstacle.y + 25, 2],
      [obstacle.x + 38, obstacle.y + 10, 1.8],
    ], "#d84a4a");
    return;
  }

  if (obstacle.type === "barrel") {
    const barrelGradient = ctx.createLinearGradient(obstacle.x, obstacle.y, obstacle.x + obstacle.width, obstacle.y + obstacle.height);
    barrelGradient.addColorStop(0, "#b57a43");
    barrelGradient.addColorStop(0.48, "#8c5a34");
    barrelGradient.addColorStop(1, "#4d2e1c");
    ctx.fillStyle = barrelGradient;
    ctx.strokeStyle = "#5d3a22";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(obstacle.x + obstacle.width / 2, obstacle.y + obstacle.height / 2, obstacle.width / 2, obstacle.height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    draw3DGloss(obstacle.x + 6, obstacle.y + 6, obstacle.width - 12, obstacle.height - 12, 18);
    ctx.strokeStyle = "#c7a16a";
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 6, obstacle.y + 12);
    ctx.lineTo(obstacle.x + obstacle.width - 6, obstacle.y + 12);
    ctx.moveTo(obstacle.x + 6, obstacle.y + obstacle.height / 2);
    ctx.lineTo(obstacle.x + obstacle.width - 6, obstacle.y + obstacle.height / 2);
    ctx.moveTo(obstacle.x + 6, obstacle.y + obstacle.height - 12);
    ctx.lineTo(obstacle.x + obstacle.width - 6, obstacle.y + obstacle.height - 12);
    ctx.stroke();
    ctx.strokeStyle = "rgba(70, 42, 23, 0.42)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + obstacle.width * 0.34, obstacle.y + 8);
    ctx.bezierCurveTo(obstacle.x + obstacle.width * 0.26, obstacle.y + 20, obstacle.x + obstacle.width * 0.3, obstacle.y + obstacle.height - 12, obstacle.x + obstacle.width * 0.34, obstacle.y + obstacle.height - 6);
    ctx.moveTo(obstacle.x + obstacle.width * 0.66, obstacle.y + 8);
    ctx.bezierCurveTo(obstacle.x + obstacle.width * 0.76, obstacle.y + 20, obstacle.x + obstacle.width * 0.7, obstacle.y + obstacle.height - 12, obstacle.x + obstacle.width * 0.66, obstacle.y + obstacle.height - 6);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 232, 170, 0.35)";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + obstacle.width * 0.36, obstacle.y + obstacle.height * 0.28, 7, 4, -0.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (obstacle.type === "fence") {
    ctx.fillStyle = "#9c7045";
    for (const postX of [8, 24, 40]) {
      ctx.fillRect(obstacle.x + postX, obstacle.y + 4, 6, obstacle.height - 4);
      ctx.beginPath();
      ctx.moveTo(obstacle.x + postX - 2, obstacle.y + 6);
      ctx.lineTo(obstacle.x + postX + 3, obstacle.y);
      ctx.lineTo(obstacle.x + postX + 8, obstacle.y + 6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "#b98b58";
    ctx.fillRect(obstacle.x, obstacle.y + 16, obstacle.width, 6);
    ctx.fillRect(obstacle.x, obstacle.y + 32, obstacle.width, 6);
    drawWoodGrain(obstacle.x + 2, obstacle.y + 14, obstacle.width - 4, 28, "rgba(79, 48, 25, 0.42)");
    drawRivets([
      [obstacle.x + 10, obstacle.y + 19, 1.8],
      [obstacle.x + 28, obstacle.y + 35, 1.8],
      [obstacle.x + 46, obstacle.y + 19, 1.8],
    ]);
    return;
  }

  if (obstacle.type === "log") {
    ctx.fillStyle = "#7b5230";
    ctx.strokeStyle = "#4d321d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(obstacle.x + obstacle.width / 2, obstacle.y + obstacle.height / 2, obstacle.width / 2, obstacle.height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#a87a4e";
    ctx.beginPath();
    ctx.arc(obstacle.x + 12, obstacle.y + obstacle.height / 2, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 20, obstacle.y + 8);
    ctx.lineTo(obstacle.x + obstacle.width - 8, obstacle.y + 8);
    ctx.moveTo(obstacle.x + 20, obstacle.y + obstacle.height - 8);
    ctx.lineTo(obstacle.x + obstacle.width - 8, obstacle.y + obstacle.height - 8);
    ctx.stroke();
    drawWoodGrain(obstacle.x + 14, obstacle.y + 5, obstacle.width - 18, obstacle.height - 10, "rgba(52, 31, 18, 0.46)");
    ctx.strokeStyle = "#c0905c";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(obstacle.x + 12, obstacle.y + obstacle.height / 2, 3, 0, Math.PI * 2);
    ctx.arc(obstacle.x + 12, obstacle.y + obstacle.height / 2, 11, 0.2, Math.PI * 1.8);
    ctx.stroke();
    return;
  }

  if (obstacle.type === "hurdle") {
    ctx.strokeStyle = "#8d6640";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 10, GROUND_Y);
    ctx.lineTo(obstacle.x + 18, obstacle.y);
    ctx.moveTo(obstacle.x + obstacle.width - 10, GROUND_Y);
    ctx.lineTo(obstacle.x + obstacle.width - 18, obstacle.y);
    ctx.moveTo(obstacle.x + 12, obstacle.y + 8);
    ctx.lineTo(obstacle.x + obstacle.width - 12, obstacle.y + 8);
    ctx.moveTo(obstacle.x + 16, obstacle.y + 22);
    ctx.lineTo(obstacle.x + obstacle.width - 16, obstacle.y + 22);
    ctx.stroke();
    ctx.fillStyle = "#d8c398";
    ctx.fillRect(obstacle.x + 12, obstacle.y + 10, obstacle.width - 24, 4);
    ctx.fillStyle = "#f2dfb4";
    ctx.fillRect(obstacle.x + 18, obstacle.y + 9, obstacle.width - 36, 2);
    drawRivets([
      [obstacle.x + 20, obstacle.y + 12, 1.8],
      [obstacle.x + obstacle.width - 20, obstacle.y + 12, 1.8],
    ], "rgba(84, 54, 31, 0.62)");
    return;
  }

  if (obstacle.type === "mailbox") {
    const wobble = Math.sin(state.frame * 0.2 + obstacle.animSeed) * 3;
    ctx.fillStyle = "#80552f";
    ctx.fillRect(obstacle.x + obstacle.width / 2 - 5, obstacle.y + 20, 10, obstacle.height - 20);
    ctx.fillStyle = "#b63e34";
    ctx.strokeStyle = "#7d221d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(obstacle.x + 8, obstacle.y + 6, obstacle.width - 16, 30, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f4f1e6";
    ctx.fillRect(obstacle.x + 18, obstacle.y + 16, obstacle.width - 28, 8);
    ctx.fillStyle = "#f2c34d";
    ctx.fillRect(obstacle.x + obstacle.width - 14, obstacle.y + 12 + wobble, 12, 4);
    return;
  }

  if (obstacle.type === "farmer") {
    const bounce = Math.sin(state.frame * 0.2 + obstacle.animSeed) * 2.5;
    ctx.fillStyle = "#6f4a2f";
    ctx.fillRect(obstacle.x + obstacle.width / 2 - 6, obstacle.y + 54 + bounce, 9, obstacle.height - 54 - bounce);
    ctx.fillRect(obstacle.x + obstacle.width / 2 - 22, obstacle.y + 54 - bounce, 9, obstacle.height - 54 + bounce);
    ctx.fillStyle = "#5b78b8";
    ctx.beginPath();
    ctx.roundRect(obstacle.x + 14, obstacle.y + 34, obstacle.width - 28, 30, 10);
    ctx.fill();
    ctx.fillStyle = "#d2ab55";
    ctx.fillRect(obstacle.x + obstacle.width / 2 - 8, obstacle.y + 40, 16, 20);
    ctx.fillStyle = "#f0c49a";
    ctx.beginPath();
    ctx.arc(obstacle.x + obstacle.width / 2, obstacle.y + 22, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#8c5a34";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + obstacle.width / 2, obstacle.y + 12, 22, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(obstacle.x + obstacle.width / 2 - 14, obstacle.y + 12, 28, 5);
    ctx.fillStyle = "#2f241b";
    ctx.beginPath();
    ctx.arc(obstacle.x + obstacle.width / 2 - 5, obstacle.y + 21, 1.8, 0, Math.PI * 2);
    ctx.arc(obstacle.x + obstacle.width / 2 + 5, obstacle.y + 21, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6f4a2f";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + obstacle.width - 12, obstacle.y + 42);
    ctx.lineTo(obstacle.x + obstacle.width + 6, obstacle.y + obstacle.height - 6);
    ctx.moveTo(obstacle.x + 14, obstacle.y + 42);
    ctx.lineTo(obstacle.x - 4, obstacle.y + obstacle.height - 10);
    ctx.stroke();
    return;
  }

  if (obstacle.type === "tractor") {
    ctx.fillStyle = "#63ad46";
    ctx.strokeStyle = "#315f23";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(obstacle.x + 12, obstacle.y + 28, obstacle.width - 24, obstacle.height - 28, 12);
    ctx.fill();
    ctx.stroke();
    draw3DGloss(obstacle.x + 16, obstacle.y + 30, obstacle.width - 32, obstacle.height - 36, 10);
    drawInsetShadow(obstacle.x + 12, obstacle.y + 28, obstacle.width - 24, obstacle.height - 28, 12);
    ctx.fillStyle = "#8fd0eb";
    ctx.beginPath();
    ctx.roundRect(obstacle.x + 24, obstacle.y + 10, obstacle.width * 0.4, 28, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f2cf4a";
    ctx.fillRect(obstacle.x + obstacle.width - 28, obstacle.y + 38, 14, 8);
    ctx.fillStyle = "#23481b";
    for (let index = 0; index < 4; index += 1) {
      ctx.fillRect(obstacle.x + obstacle.width - 48, obstacle.y + 42 + index * 5, 18, 2);
    }
    ctx.fillStyle = "#315f23";
    ctx.fillRect(obstacle.x + 58, obstacle.y + 18, 6, 18);
    ctx.fillStyle = "#2e2e2e";
    ctx.beginPath();
    ctx.arc(obstacle.x + 28, GROUND_Y, 20, 0, Math.PI * 2);
    ctx.arc(obstacle.x + obstacle.width - 24, GROUND_Y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c7c7c7";
    ctx.beginPath();
    ctx.arc(obstacle.x + 28, GROUND_Y, 8, 0, Math.PI * 2);
    ctx.arc(obstacle.x + obstacle.width - 24, GROUND_Y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#f4f1e6";
    ctx.lineWidth = 2;
    for (const wheelX of [28, obstacle.width - 24]) {
      ctx.beginPath();
      ctx.moveTo(obstacle.x + wheelX, GROUND_Y);
      ctx.lineTo(obstacle.x + wheelX + 13, GROUND_Y);
      ctx.moveTo(obstacle.x + wheelX, GROUND_Y);
      ctx.lineTo(obstacle.x + wheelX, GROUND_Y - 13);
      ctx.stroke();
    }
    return;
  }

  if (obstacle.type === "wagon") {
    const wheelSpin = state.frame * 0.22 + obstacle.animSeed;
    ctx.fillStyle = "#8e6035";
    ctx.fillRect(obstacle.x + 6, obstacle.y + 20, obstacle.width - 12, 10);
    ctx.fillRect(obstacle.x + 22, obstacle.y + 8, obstacle.width - 36, 18);
    draw3DGloss(obstacle.x + 22, obstacle.y + 8, obstacle.width - 36, 20, 5);
    ctx.strokeStyle = "#5b3c20";
    ctx.lineWidth = 3;
    ctx.strokeRect(obstacle.x + 14, obstacle.y + 16, obstacle.width - 28, 24);
    ctx.fillStyle = "#e7c862";
    for (const baleX of [24, 44, 64]) {
      ctx.fillRect(obstacle.x + baleX, obstacle.y + 4, 18, 12);
      ctx.strokeRect(obstacle.x + baleX, obstacle.y + 4, 18, 12);
    }
    for (const wheelX of [26, obstacle.width - 24]) {
      ctx.fillStyle = "#2f241b";
      ctx.beginPath();
      ctx.arc(obstacle.x + wheelX, GROUND_Y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#d1c5b2";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(obstacle.x + wheelX, GROUND_Y);
      ctx.lineTo(obstacle.x + wheelX + Math.cos(wheelSpin) * 9, GROUND_Y + Math.sin(wheelSpin) * 9);
      ctx.moveTo(obstacle.x + wheelX, GROUND_Y);
      ctx.lineTo(obstacle.x + wheelX + Math.cos(wheelSpin + Math.PI / 2) * 9, GROUND_Y + Math.sin(wheelSpin + Math.PI / 2) * 9);
      ctx.stroke();
    }
    return;
  }

  if (obstacle.type === "windmill") {
    const bladeAngle = state.frame * 0.07 + obstacle.animSeed;
    ctx.fillStyle = "#d5d0c4";
    ctx.beginPath();
    ctx.moveTo(obstacle.x + obstacle.width / 2, obstacle.y);
    ctx.lineTo(obstacle.x + obstacle.width - 10, GROUND_Y);
    ctx.lineTo(obstacle.x + 10, GROUND_Y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#8f7d68";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#8c5a34";
    ctx.fillRect(obstacle.x + obstacle.width / 2 - 4, obstacle.y + 26, 8, obstacle.height - 26);
    ctx.save();
    ctx.translate(obstacle.x + obstacle.width / 2, obstacle.y + 30);
    ctx.rotate(bladeAngle);
    ctx.fillStyle = "#f3ece0";
    for (let index = 0; index < 4; index += 1) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(10, -8);
      ctx.lineTo(34, 0);
      ctx.lineTo(10, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (obstacle.type === "sheep") {
    const bounce = Math.sin(state.frame * 0.22 + obstacle.animSeed) * 2;
    ctx.fillStyle = "#6d5137";
    for (const legX of [18, 36, 58, 76]) {
      ctx.fillRect(obstacle.x + legX, obstacle.y + 42 + Math.max(0, bounce), 7, obstacle.height - 42 - Math.max(0, -bounce));
    }
    ctx.fillStyle = "#f7f2ea";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + 44, obstacle.y + 30, 28, 22, 0, 0, Math.PI * 2);
    ctx.ellipse(obstacle.x + 64, obstacle.y + 34, 24, 20, 0, 0, Math.PI * 2);
    ctx.ellipse(obstacle.x + 28, obstacle.y + 34, 20, 17, 0, 0, Math.PI * 2);
    ctx.ellipse(obstacle.x + 52, obstacle.y + 22, 18, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    draw3DGloss(obstacle.x + 18, obstacle.y + 12, obstacle.width - 28, 34, 12);
    ctx.fillStyle = "#5b4330";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + obstacle.width - 18, obstacle.y + 34, 16, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(obstacle.x + obstacle.width - 22, obstacle.y + 32, 2, 0, Math.PI * 2);
    ctx.arc(obstacle.x + obstacle.width - 14, obstacle.y + 32, 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (obstacle.type === "scarecrow") {
    ctx.fillStyle = "#8c6239";
    ctx.fillRect(obstacle.x + obstacle.width / 2 - 4, obstacle.y + 20, 8, obstacle.height - 20);
    ctx.fillRect(obstacle.x + 8, obstacle.y + 38, obstacle.width - 16, 6);
    ctx.fillStyle = "#d0a14e";
    ctx.beginPath();
    ctx.arc(obstacle.x + obstacle.width / 2, obstacle.y + 20, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7b4f27";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + obstacle.width / 2, obstacle.y + 10, 20, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(obstacle.x + obstacle.width / 2 - 12, obstacle.y + 10, 24, 4);
    ctx.fillStyle = "#2f241b";
    ctx.beginPath();
    ctx.arc(obstacle.x + obstacle.width / 2 - 4, obstacle.y + 18, 1.6, 0, Math.PI * 2);
    ctx.arc(obstacle.x + obstacle.width / 2 + 4, obstacle.y + 18, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#bf5a3a";
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 14, obstacle.y + 46);
    ctx.lineTo(obstacle.x + obstacle.width / 2, obstacle.y + 66);
    ctx.lineTo(obstacle.x + obstacle.width - 14, obstacle.y + 46);
    ctx.lineTo(obstacle.x + obstacle.width / 2, obstacle.y + 36);
    ctx.closePath();
    ctx.fill();
    return;
  }

  if (obstacle.type === "rooster") {
    const bob = Math.sin(state.frame * 0.24 + obstacle.animSeed) * 3;
    ctx.fillStyle = "#f1ddbf";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + 28, obstacle.y + 26, 16, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#d94f43";
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 16, obstacle.y + 12);
    ctx.lineTo(obstacle.x + 22, obstacle.y + 2);
    ctx.lineTo(obstacle.x + 28, obstacle.y + 12);
    ctx.lineTo(obstacle.x + 34, obstacle.y + 2);
    ctx.lineTo(obstacle.x + 38, obstacle.y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f7b733";
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 42, obstacle.y + 24);
    ctx.lineTo(obstacle.x + 54, obstacle.y + 28);
    ctx.lineTo(obstacle.x + 42, obstacle.y + 32);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#2f241b";
    ctx.beginPath();
    ctx.arc(obstacle.x + 34, obstacle.y + 22, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#8c5a34";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 50, obstacle.y + 20);
    ctx.quadraticCurveTo(obstacle.x + 68, obstacle.y + 8 + bob, obstacle.x + obstacle.width - 8, obstacle.y + 20);
    ctx.moveTo(obstacle.x + 50, obstacle.y + 26);
    ctx.quadraticCurveTo(obstacle.x + 70, obstacle.y + 28 + bob, obstacle.x + obstacle.width - 6, obstacle.y + 38);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 22, obstacle.y + 38);
    ctx.lineTo(obstacle.x + 18, GROUND_Y);
    ctx.moveTo(obstacle.x + 30, obstacle.y + 38);
    ctx.lineTo(obstacle.x + 28, GROUND_Y);
    ctx.stroke();
    return;
  }

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
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 30, obstacle.y + 5);
    ctx.lineTo(obstacle.x + 34, GROUND_Y - 5);
    ctx.moveTo(obstacle.x + 10, obstacle.y + 18);
    ctx.lineTo(obstacle.x + 14, GROUND_Y - 5);
    ctx.stroke();
    return;
  }

  if (obstacle.type === "cow") {
    const stride = Math.sin(state.frame * 0.24 + obstacle.animSeed) * 5;
    const headBob = Math.sin(state.frame * 0.18 + obstacle.animSeed) * 2;
    ctx.fillStyle = "#5b4330";
    for (const [legX, offset] of [[18, stride], [38, -stride], [64, -stride], [86, stride]]) {
      ctx.fillRect(obstacle.x + legX, obstacle.y + 38 + Math.max(0, offset), 8, obstacle.height - 38 - Math.max(0, -offset));
    }
    ctx.fillStyle = "#fff8ef";
    ctx.strokeStyle = "#6d5137";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(obstacle.x + 10, obstacle.y + 14, obstacle.width - 26, 36, 16);
    ctx.fill();
    ctx.stroke();
    draw3DGloss(obstacle.x + 15, obstacle.y + 16, obstacle.width - 38, 24, 12);
    ctx.fillStyle = "#5a3d29";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + 30, obstacle.y + 28, 11, 8, -0.2, 0, Math.PI * 2);
    ctx.ellipse(obstacle.x + 58, obstacle.y + 34, 12, 8, 0.25, 0, Math.PI * 2);
    ctx.ellipse(obstacle.x + 80, obstacle.y + 24, 9, 7, 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff8ef";
    ctx.beginPath();
    ctx.roundRect(obstacle.x + obstacle.width - 38, obstacle.y + 18 + headBob, 28, 24, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f4c8b4";
    ctx.beginPath();
    ctx.roundRect(obstacle.x + obstacle.width - 34, obstacle.y + 29 + headBob, 18, 10, 5);
    ctx.fill();
    ctx.fillStyle = "#2f241b";
    ctx.beginPath();
    ctx.arc(obstacle.x + obstacle.width - 28, obstacle.y + 26 + headBob, 2.2, 0, Math.PI * 2);
    ctx.arc(obstacle.x + obstacle.width - 19, obstacle.y + 26 + headBob, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6d5137";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + obstacle.width - 30, obstacle.y + 18 + headBob);
    ctx.quadraticCurveTo(obstacle.x + obstacle.width - 38, obstacle.y + 4 + headBob, obstacle.x + obstacle.width - 48, obstacle.y + 14 + headBob);
    ctx.moveTo(obstacle.x + obstacle.width - 16, obstacle.y + 18 + headBob);
    ctx.quadraticCurveTo(obstacle.x + obstacle.width - 6, obstacle.y + 4 + headBob, obstacle.x + obstacle.width + 2, obstacle.y + 16 + headBob);
    ctx.moveTo(obstacle.x + 10, obstacle.y + 22);
    ctx.quadraticCurveTo(obstacle.x - 6, obstacle.y + 8, obstacle.x + 2, obstacle.y + 38);
    ctx.stroke();
    return;
  }

  if (obstacle.type === "hay") {
    draw3DBox(obstacle.x, obstacle.y + 3, obstacle.width, obstacle.height - 3, {
      top: "#f4d977",
      side: "#b9892f",
      frontLight: "#ffe58a",
      front: "#e2bd4f",
      frontDark: "#b8862e",
      stroke: "#9f7327",
    });
    ctx.strokeStyle = "rgba(126, 89, 21, 0.42)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let index = 0; index < 7; index += 1) {
      const y = obstacle.y + 10 + index * ((obstacle.height - 12) / 7);
      ctx.moveTo(obstacle.x + 7, y);
      ctx.bezierCurveTo(obstacle.x + obstacle.width * 0.33, y - 5, obstacle.x + obstacle.width * 0.66, y + 4, obstacle.x + obstacle.width - 7, y - 1);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 245, 162, 0.78)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let index = 0; index < 8; index += 1) {
      const x = obstacle.x + 8 + (index * (obstacle.width - 16)) / 7;
      ctx.moveTo(x, obstacle.y + 7);
      ctx.lineTo(x - 4 + Math.sin(index) * 3, GROUND_Y - 7);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath();
    ctx.ellipse(obstacle.x + obstacle.width * 0.3, obstacle.y + 16, obstacle.width * 0.18, 5, -0.25, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (obstacle.type === "crate") {
    draw3DBox(obstacle.x, obstacle.y + 2, obstacle.width, obstacle.height - 2, {
      top: "#b98452",
      side: "#70441f",
      frontLight: "#a87545",
      front: "#8f5d32",
      frontDark: "#5f371c",
      stroke: "#4f3019",
    });
    ctx.strokeStyle = "#573318";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 6, obstacle.y + 8);
    ctx.lineTo(obstacle.x + obstacle.width - 6, GROUND_Y - 6);
    ctx.moveTo(obstacle.x + obstacle.width - 6, obstacle.y + 8);
    ctx.lineTo(obstacle.x + 6, GROUND_Y - 6);
    ctx.moveTo(obstacle.x + obstacle.width / 2, obstacle.y + 3);
    ctx.lineTo(obstacle.x + obstacle.width / 2, GROUND_Y - 3);
    ctx.stroke();
    drawWoodGrain(obstacle.x + 5, obstacle.y + 7, obstacle.width - 10, obstacle.height - 12, "rgba(38, 22, 11, 0.42)");
    drawRivets([
      [obstacle.x + 8, obstacle.y + 10, 2],
      [obstacle.x + obstacle.width - 8, obstacle.y + 10, 2],
      [obstacle.x + 8, GROUND_Y - 9, 2],
      [obstacle.x + obstacle.width - 8, GROUND_Y - 9, 2],
      [obstacle.x + obstacle.width / 2, obstacle.y + obstacle.height / 2, 2],
    ]);
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
    ctx.moveTo(obstacle.x + 18, obstacle.y);
    ctx.lineTo(obstacle.x + 18, obstacle.y + 18);
    ctx.moveTo(obstacle.x + 36, obstacle.y + 18);
    ctx.lineTo(obstacle.x + 36, obstacle.y + obstacle.height);
    ctx.stroke();
  } else if (obstacle.type === "hay") {
    ctx.strokeStyle = "#c39e38";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(obstacle.x + 8, obstacle.y + 10);
    ctx.lineTo(obstacle.x + obstacle.width - 8, obstacle.y + 10);
    ctx.moveTo(obstacle.x + 8, obstacle.y + 22);
    ctx.lineTo(obstacle.x + obstacle.width - 8, obstacle.y + 22);
    ctx.moveTo(obstacle.x + 14, obstacle.y + 4);
    ctx.lineTo(obstacle.x + 10, GROUND_Y - 4);
    ctx.moveTo(obstacle.x + 30, obstacle.y + 4);
    ctx.lineTo(obstacle.x + 26, GROUND_Y - 4);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 241, 161, 0.78)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let index = 0; index < 6; index += 1) {
      const y = obstacle.y + 6 + index * 6;
      ctx.moveTo(obstacle.x + 6, y);
      ctx.lineTo(obstacle.x + obstacle.width - 7, y + Math.sin(index) * 2);
    }
    ctx.stroke();
  } else if (obstacle.type === "crate") {
    ctx.strokeStyle = "#6f4928";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(obstacle.x, obstacle.y);
    ctx.lineTo(obstacle.x + obstacle.width, GROUND_Y);
    ctx.moveTo(obstacle.x + obstacle.width, obstacle.y);
    ctx.lineTo(obstacle.x, GROUND_Y);
    ctx.moveTo(obstacle.x + obstacle.width / 2, obstacle.y);
    ctx.lineTo(obstacle.x + obstacle.width / 2, GROUND_Y);
    ctx.stroke();
    drawWoodGrain(obstacle.x + 4, obstacle.y + 4, obstacle.width - 8, obstacle.height - 8);
    drawRivets([
      [obstacle.x + 8, obstacle.y + 8, 1.8],
      [obstacle.x + obstacle.width - 8, obstacle.y + 8, 1.8],
      [obstacle.x + 8, GROUND_Y - 8, 1.8],
      [obstacle.x + obstacle.width - 8, GROUND_Y - 8, 1.8],
    ]);
  } else if (obstacle.type === "pipe") {
    ctx.fillStyle = "#64d064";
    ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, 14);
    ctx.strokeStyle = "#1b5b20";
    ctx.lineWidth = 2;
    ctx.strokeRect(obstacle.x, obstacle.y, obstacle.width, 14);
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
  const isMeat = pickup.kind === "meat";
  const isRotten = pickup.kind === "rotten";
  const isBossWeapon = pickup.kind?.startsWith("boss");
  ctx.fillStyle = isMeat
    ? "rgba(255, 170, 120, 0.35)"
    : (isBossWeapon ? `${pickup.weapon.color}33` : (isRotten ? "rgba(176, 210, 126, 0.35)" : "rgba(255, 214, 190, 0.35)"));
  ctx.beginPath();
  ctx.arc(pickup.x, pickup.y, pickup.size * 1.35 * glow, 0, Math.PI * 2);
  ctx.fill();

  if (isMeat) {
    ctx.fillStyle = "#b14b39";
    ctx.strokeStyle = "#6f2418";
  } else if (isBossWeapon) {
    ctx.fillStyle = pickup.weapon.color;
    ctx.strokeStyle = "#332011";
  } else {
    ctx.fillStyle = isRotten ? "#8fb14a" : "#df3939";
    ctx.strokeStyle = isRotten ? "#536d23" : "#9b1f1f";
  }
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (isBossWeapon) {
    ctx.save();
    ctx.translate(pickup.x, pickup.y);
    ctx.rotate(Math.sin(pickup.pulse) * 0.22);
    ctx.beginPath();
    ctx.roundRect(-pickup.size * 1.05, -pickup.size * 0.58, pickup.size * 2.1, pickup.size * 1.16, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fef3c7";
    ctx.beginPath();
    if (pickup.kind === "bossSpread") {
      ctx.moveTo(-5, -8);
      ctx.lineTo(12, -2);
      ctx.lineTo(-5, 4);
      ctx.moveTo(-8, 0);
      ctx.lineTo(10, 0);
      ctx.moveTo(-5, 8);
      ctx.lineTo(12, 2);
    } else if (pickup.kind === "bossLaser") {
      ctx.moveTo(-12, 0);
      ctx.lineTo(14, 0);
      ctx.moveTo(6, -7);
      ctx.lineTo(14, 0);
      ctx.lineTo(6, 7);
    } else {
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
    }
    ctx.strokeStyle = "#fef3c7";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  } else if (!isMeat) {
    ctx.arc(pickup.x, pickup.y, pickup.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.save();
    ctx.font = `${pickup.size * 1.7}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🍖", pickup.x, pickup.y + 1);
    ctx.restore();
  }

  if (isMeat) {
  } else if (isRotten) {
    ctx.fillStyle = "#6d4f1d";
    ctx.beginPath();
    ctx.arc(pickup.x - pickup.size * 0.25, pickup.y - pickup.size * 0.1, pickup.size * 0.2, 0, Math.PI * 2);
    ctx.arc(pickup.x + pickup.size * 0.18, pickup.y + pickup.size * 0.22, pickup.size * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  if (!isMeat && !isBossWeapon) {
    ctx.fillStyle = "#5f8d34";
    ctx.fillRect(pickup.x - 2, pickup.y - pickup.size - 6, 4, 8);
    ctx.beginPath();
    ctx.moveTo(pickup.x, pickup.y - pickup.size - 4);
    ctx.lineTo(pickup.x + 8, pickup.y - pickup.size - 12);
    ctx.lineTo(pickup.x + 4, pickup.y - pickup.size - 3);
    ctx.closePath();
    ctx.fill();
  }
}

function drawCelebrationBurst(burst) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, burst.life / 36);
  ctx.fillStyle = burst.color;
  ctx.translate(burst.x, burst.y);
  ctx.rotate((burst.vx + burst.vy) * 0.2);
  ctx.fillRect(-burst.size / 2, -burst.size / 2, burst.size, burst.size * 1.6);
  ctx.restore();
}

function drawProjectile(projectile) {
  const angle = Math.atan2(projectile.vy, projectile.vx);
  const length = projectile.size * 4.2;
  const radius = projectile.size * 1.1;

  ctx.save();
  ctx.translate(projectile.x, projectile.y);
  ctx.rotate(angle);

  if (projectile.kind === "bossLaser") {
    ctx.fillStyle = "rgba(249, 115, 22, 0.35)";
    ctx.fillRect(-length * 1.2, -radius * 0.45, length * 1.9, radius * 0.9);
  }

  ctx.fillStyle = projectile.kind === "bossMega" ? "#a855f7" : (projectile.kind === "bossLaser" ? "#fb923c" : "#f28c28");
  ctx.beginPath();
  ctx.moveTo(length * 0.58, 0);
  ctx.quadraticCurveTo(-length * 0.08, -radius, -length * 0.62, -radius * 0.46);
  ctx.quadraticCurveTo(-length * 0.78, 0, -length * 0.62, radius * 0.46);
  ctx.quadraticCurveTo(-length * 0.08, radius, length * 0.58, 0);
  ctx.fill();

  ctx.strokeStyle = projectile.kind === "bossMega" ? "#5b21b6" : "#b75719";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-length * 0.36, -radius * 0.48);
  ctx.lineTo(-length * 0.18, -radius * 0.15);
  ctx.moveTo(-length * 0.22, radius * 0.48);
  ctx.lineTo(-length * 0.02, radius * 0.16);
  ctx.stroke();

  ctx.fillStyle = "#4ca64c";
  ctx.beginPath();
  ctx.moveTo(-length * 0.58, 0);
  ctx.lineTo(-length * 0.92, -radius * 0.95);
  ctx.lineTo(-length * 0.78, -radius * 0.1);
  ctx.lineTo(-length * 1.02, radius * 0.72);
  ctx.lineTo(-length * 0.55, radius * 0.18);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawRollingHills(theme) {
  const farShift = -(state.scrollDistance * 0.035) % WIDTH;
  const midShift = -(state.scrollDistance * 0.07) % WIDTH;
  const nearShift = -(state.scrollDistance * 0.13) % WIDTH;

  const skyGlow = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  skyGlow.addColorStop(0, theme.sky);
  skyGlow.addColorStop(0.52, theme.skyMid);
  skyGlow.addColorStop(1, theme.skyBottom);
  ctx.fillStyle = skyGlow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  if (theme.season === "hardcore") {
    const pulse = 0.5 + Math.sin(state.frame * 0.035) * 0.18;
    ctx.fillStyle = `rgba(255, 88, 24, ${0.18 + pulse * 0.12})`;
    ctx.beginPath();
    ctx.arc(WIDTH - 128, 92, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(235, 221, 197, 0.86)";
    ctx.beginPath();
    ctx.arc(WIDTH - 132, 88, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(16, 6, 17, 0.48)";
    ctx.beginPath();
    ctx.arc(WIDTH - 118, 78, 32, 0, Math.PI * 2);
    ctx.fill();
  } else if (theme.season === "summer") {
    ctx.fillStyle = appSettings.darkMode ? "rgba(232, 164, 65, 0.24)" : "rgba(255, 214, 104, 0.38)";
    ctx.beginPath();
    ctx.arc(WIDTH - 120, 88, 56, 0, Math.PI * 2);
    ctx.fill();
  } else if (theme.season === "spring") {
    ctx.strokeStyle = appSettings.darkMode ? "rgba(216, 128, 176, 0.24)" : "rgba(255, 124, 184, 0.35)";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(210, 208, 128, Math.PI * 1.08, Math.PI * 1.72);
    ctx.stroke();
    ctx.strokeStyle = appSettings.darkMode ? "rgba(122, 199, 232, 0.18)" : "rgba(102, 190, 235, 0.28)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(210, 212, 108, Math.PI * 1.08, Math.PI * 1.72);
    ctx.stroke();
  }

  for (let copy = -1; copy <= 1; copy += 1) {
    const x = farShift + copy * WIDTH;
    ctx.fillStyle = theme.far;
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y);
    if (theme.season === "winter") {
      ctx.lineTo(x + 120, 214);
      ctx.lineTo(x + 218, 96);
      ctx.lineTo(x + 348, 232);
      ctx.lineTo(x + 462, 120);
      ctx.lineTo(x + 660, GROUND_Y);
      ctx.lineTo(x + 760, 190);
      ctx.lineTo(x + 908, GROUND_Y);
    } else if (theme.season === "autumn") {
      ctx.bezierCurveTo(x + 120, 278, x + 250, 185, x + 390, GROUND_Y);
      ctx.bezierCurveTo(x + 520, 286, x + 680, 184, x + 830, GROUND_Y);
    } else {
      ctx.bezierCurveTo(x + 120, 220, x + 240, 135, x + 390, GROUND_Y);
      ctx.bezierCurveTo(x + 520, 245, x + 650, 150, x + 820, GROUND_Y);
    }
    ctx.lineTo(x + WIDTH, GROUND_Y);
    ctx.closePath();
    ctx.fill();

    if (theme.season === "winter") {
      ctx.fillStyle = appSettings.darkMode ? "rgba(225, 242, 255, 0.32)" : "rgba(255, 255, 255, 0.76)";
      ctx.beginPath();
      ctx.moveTo(x + 164, 178);
      ctx.lineTo(x + 218, 96);
      ctx.lineTo(x + 282, 178);
      ctx.lineTo(x + 244, 162);
      ctx.lineTo(x + 216, 196);
      ctx.lineTo(x + 194, 158);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x + 418, 178);
      ctx.lineTo(x + 462, 120);
      ctx.lineTo(x + 524, 184);
      ctx.lineTo(x + 486, 170);
      ctx.lineTo(x + 460, 198);
      ctx.lineTo(x + 440, 166);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = theme.mid;
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y);
    ctx.bezierCurveTo(x + 180, 286, x + 330, 250, x + 520, GROUND_Y);
    ctx.bezierCurveTo(x + 670, 292, x + 790, 238, x + WIDTH, GROUND_Y);
    ctx.lineTo(x + WIDTH, GROUND_Y);
    ctx.closePath();
    ctx.fill();
  }

  for (let copy = -1; copy <= 1; copy += 1) {
    const x = midShift + copy * WIDTH;
    ctx.fillStyle = theme.mid;
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y);
    ctx.bezierCurveTo(x + 160, 338, x + 360, 304, x + 540, GROUND_Y);
    ctx.bezierCurveTo(x + 700, 330, x + 840, 292, x + WIDTH, GROUND_Y);
    ctx.lineTo(x + WIDTH, GROUND_Y);
    ctx.closePath();
    ctx.fill();
  }

  for (let copy = -1; copy <= 1; copy += 1) {
    const x = nearShift + copy * WIDTH;
    ctx.fillStyle = theme.tree;
    for (let index = 0; index < 9; index += 1) {
      const treeX = x + index * 122 + 24;
      const treeBase = GROUND_Y - 8;
      const treeH = 42 + (index % 3) * 16;
      ctx.fillRect(treeX, treeBase - treeH * 0.45, 6, treeH * 0.45);
      ctx.beginPath();
      if (theme.season === "hardcore") {
        ctx.strokeStyle = "rgba(13, 7, 8, 0.9)";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(treeX, treeBase);
        ctx.quadraticCurveTo(treeX - 8, treeBase - treeH * 0.58, treeX + 3, treeBase - treeH);
        ctx.moveTo(treeX - 2, treeBase - treeH * 0.52);
        ctx.lineTo(treeX - 26, treeBase - treeH * 0.72);
        ctx.moveTo(treeX + 1, treeBase - treeH * 0.66);
        ctx.lineTo(treeX + 28, treeBase - treeH * 0.86);
        ctx.stroke();
        ctx.fillStyle = "rgba(255, 105, 35, 0.28)";
        ctx.beginPath();
        ctx.arc(treeX + 3, treeBase - treeH * 0.18, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.tree;
      } else if (theme.season === "autumn") {
        ctx.fillStyle = index % 2 === 0 ? "rgba(190, 91, 38, 0.68)" : "rgba(214, 144, 54, 0.68)";
        ctx.ellipse(treeX + 3, treeBase - treeH * 0.8, 28, 22, 0, 0, Math.PI * 2);
        ctx.ellipse(treeX - 12, treeBase - treeH * 0.58, 20, 18, 0, 0, Math.PI * 2);
        ctx.ellipse(treeX + 18, treeBase - treeH * 0.56, 20, 18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.tree;
      } else if (theme.season === "summer") {
        ctx.moveTo(treeX - 28, treeBase - treeH * 0.28);
        ctx.quadraticCurveTo(treeX + 3, treeBase - treeH * 1.1, treeX + 34, treeBase - treeH * 0.28);
        ctx.closePath();
        ctx.fill();
      } else if (theme.season === "spring") {
        ctx.fillStyle = index % 2 === 0 ? "rgba(104, 171, 82, 0.64)" : "rgba(242, 149, 189, 0.62)";
        ctx.ellipse(treeX + 3, treeBase - treeH * 0.8, 25, 21, 0, 0, Math.PI * 2);
        ctx.ellipse(treeX - 13, treeBase - treeH * 0.56, 18, 16, 0, 0, Math.PI * 2);
        ctx.ellipse(treeX + 18, treeBase - treeH * 0.58, 18, 16, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 229, 239, 0.58)";
        ctx.beginPath();
        ctx.arc(treeX - 4, treeBase - treeH * 0.8, 3, 0, Math.PI * 2);
        ctx.arc(treeX + 14, treeBase - treeH * 0.68, 2.5, 0, Math.PI * 2);
        ctx.arc(treeX - 16, treeBase - treeH * 0.55, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.tree;
      } else {
        ctx.moveTo(treeX - 22, treeBase - treeH * 0.35);
        ctx.lineTo(treeX + 3, treeBase - treeH);
        ctx.lineTo(treeX + 30, treeBase - treeH * 0.35);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(treeX - 18, treeBase - treeH * 0.58);
        ctx.lineTo(treeX + 3, treeBase - treeH * 1.18);
        ctx.lineTo(treeX + 24, treeBase - treeH * 0.58);
        ctx.closePath();
        ctx.fill();
        if (theme.season === "winter") {
          ctx.fillStyle = appSettings.darkMode ? "rgba(225, 244, 255, 0.52)" : "rgba(255, 255, 255, 0.82)";
          ctx.beginPath();
          ctx.moveTo(treeX - 15, treeBase - treeH * 0.62);
          ctx.lineTo(treeX + 3, treeBase - treeH * 1.18);
          ctx.lineTo(treeX + 21, treeBase - treeH * 0.62);
          ctx.lineTo(treeX + 8, treeBase - treeH * 0.72);
          ctx.lineTo(treeX + 3, treeBase - treeH * 0.92);
          ctx.lineTo(treeX - 4, treeBase - treeH * 0.72);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = theme.tree;
        }
      }
    }
  }

  if (theme.season === "hardcore") {
    const lavaShift = -(state.scrollDistance * 0.08) % 320;
    for (let x = lavaShift - 320; x < WIDTH + 320; x += 320) {
      ctx.fillStyle = "rgba(17, 7, 9, 0.88)";
      ctx.beginPath();
      ctx.moveTo(x + 40, GROUND_Y);
      ctx.lineTo(x + 136, GROUND_Y - 150);
      ctx.lineTo(x + 236, GROUND_Y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255, 82, 18, 0.74)";
      ctx.beginPath();
      ctx.moveTo(x + 128, GROUND_Y - 118);
      ctx.lineTo(x + 146, GROUND_Y - 148);
      ctx.lineTo(x + 162, GROUND_Y - 116);
      ctx.quadraticCurveTo(x + 148, GROUND_Y - 98, x + 128, GROUND_Y - 118);
      ctx.fill();
    }
  } else if (theme.season === "winter") {
    const liftShift = -(state.scrollDistance * 0.09) % 180;
    ctx.strokeStyle = appSettings.darkMode ? "rgba(216, 242, 255, 0.42)" : "rgba(72, 103, 125, 0.46)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 148);
    ctx.lineTo(WIDTH, 86);
    ctx.stroke();
    for (let x = liftShift - 180; x < WIDTH + 180; x += 180) {
      const y = 148 - (x / WIDTH) * 62;
      ctx.strokeStyle = appSettings.darkMode ? "rgba(216, 242, 255, 0.6)" : "rgba(72, 103, 125, 0.62)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 24);
      ctx.stroke();
      ctx.fillStyle = appSettings.darkMode ? "rgba(38, 58, 76, 0.86)" : "rgba(236, 56, 56, 0.82)";
      ctx.fillRect(x - 14, y + 24, 28, 12);
    }
  } else if (theme.season === "summer") {
    const barnShift = -(state.scrollDistance * 0.11) % 360;
    for (let x = barnShift - 360; x < WIDTH + 360; x += 360) {
      ctx.fillStyle = appSettings.darkMode ? "rgba(95, 52, 35, 0.62)" : "rgba(178, 73, 45, 0.58)";
      ctx.fillRect(x + 80, GROUND_Y - 98, 76, 48);
      ctx.beginPath();
      ctx.moveTo(x + 72, GROUND_Y - 98);
      ctx.lineTo(x + 118, GROUND_Y - 130);
      ctx.lineTo(x + 164, GROUND_Y - 98);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = appSettings.darkMode ? "rgba(232, 192, 128, 0.38)" : "rgba(255, 232, 159, 0.5)";
      ctx.fillRect(x + 112, GROUND_Y - 76, 15, 26);
    }
  } else if (theme.season === "autumn") {
    const cabinShift = -(state.scrollDistance * 0.1) % 420;
    for (let x = cabinShift - 420; x < WIDTH + 420; x += 420) {
      ctx.fillStyle = appSettings.darkMode ? "rgba(82, 45, 26, 0.62)" : "rgba(120, 69, 36, 0.55)";
      ctx.fillRect(x + 140, GROUND_Y - 88, 68, 42);
      ctx.fillStyle = appSettings.darkMode ? "rgba(154, 86, 42, 0.62)" : "rgba(193, 91, 41, 0.6)";
      ctx.beginPath();
      ctx.moveTo(x + 132, GROUND_Y - 88);
      ctx.lineTo(x + 174, GROUND_Y - 116);
      ctx.lineTo(x + 216, GROUND_Y - 88);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawSeasonAtmosphere(theme) {
  if (theme.season === "hardcore") {
    for (let index = 0; index < 18; index += 1) {
      const x = (index * 74 - state.scrollDistance * 0.42) % (WIDTH + 90);
      const y = 62 + ((index * 41 + state.frame * 0.72) % Math.max(170, GROUND_Y - 96));
      const drawX = x < -30 ? x + WIDTH + 90 : x;
      ctx.fillStyle = index % 3 === 0 ? "rgba(255, 107, 30, 0.55)" : "rgba(255, 194, 87, 0.34)";
      ctx.beginPath();
      ctx.ellipse(drawX, y, 2.4, 5.8, Math.sin(state.frame * 0.04 + index), 0, Math.PI * 2);
      ctx.fill();
    }

    for (let index = 0; index < 5; index += 1) {
      const x = (index * 210 + 90 - state.scrollDistance * 0.18) % (WIDTH + 160);
      const y = 118 + Math.sin(state.frame * 0.035 + index) * 16 + index * 22;
      const drawX = x < -70 ? x + WIDTH + 160 : x;
      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = "#f8fbff";
      ctx.beginPath();
      ctx.arc(drawX, y, 15, Math.PI, 0);
      ctx.lineTo(drawX + 15, y + 24);
      ctx.quadraticCurveTo(drawX + 8, y + 18, drawX + 2, y + 24);
      ctx.quadraticCurveTo(drawX - 5, y + 18, drawX - 12, y + 24);
      ctx.lineTo(drawX - 15, y);
      ctx.fill();
      ctx.fillStyle = "rgba(18, 8, 16, 0.78)";
      ctx.beginPath();
      ctx.arc(drawX - 5, y - 1, 2, 0, Math.PI * 2);
      ctx.arc(drawX + 5, y - 1, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    return;
  }

  if (theme.season === "winter") {
    ctx.fillStyle = appSettings.darkMode ? "rgba(230, 246, 255, 0.72)" : "rgba(255, 255, 255, 0.9)";
    for (let index = 0; index < 42; index += 1) {
      const x = (index * 83 - state.scrollDistance * 0.32) % (WIDTH + 80);
      const y = 42 + ((index * 47 + state.frame * 0.65) % Math.max(160, GROUND_Y - 90));
      const size = 1.4 + (index % 4) * 0.5;
      ctx.beginPath();
      ctx.arc(x < -20 ? x + WIDTH + 80 : x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  if (theme.season === "spring") {
    for (let index = 0; index < 22; index += 1) {
      const x = (index * 97 - state.scrollDistance * 0.22) % (WIDTH + 100);
      const y = 84 + ((index * 53 + state.frame * 0.36) % Math.max(150, GROUND_Y - 130));
      ctx.fillStyle = index % 2 === 0 ? "rgba(255, 172, 205, 0.48)" : "rgba(255, 238, 245, 0.48)";
      ctx.save();
      ctx.translate(x < -20 ? x + WIDTH + 100 : x, y);
      ctx.rotate(Math.sin(state.frame * 0.04 + index) * 0.8);
      ctx.beginPath();
      ctx.ellipse(0, 0, 4, 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    return;
  }

  if (theme.season === "autumn") {
    for (let index = 0; index < 28; index += 1) {
      const x = (index * 76 - state.scrollDistance * 0.38) % (WIDTH + 90);
      const y = 72 + ((index * 37 + state.frame * 0.78) % Math.max(180, GROUND_Y - 100));
      ctx.fillStyle = index % 3 === 0 ? "rgba(209, 86, 36, 0.56)" : "rgba(231, 148, 54, 0.5)";
      ctx.save();
      ctx.translate(x < -20 ? x + WIDTH + 90 : x, y);
      ctx.rotate(Math.sin(state.frame * 0.06 + index) * 1.5);
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.quadraticCurveTo(7, -1, 0, 6);
      ctx.quadraticCurveTo(-7, -1, 0, -5);
      ctx.fill();
      ctx.restore();
    }
    return;
  }

  if (theme.season === "summer") {
    ctx.strokeStyle = appSettings.darkMode ? "rgba(255, 203, 117, 0.13)" : "rgba(255, 236, 165, 0.22)";
    ctx.lineWidth = 1.2;
    for (let index = 0; index < 8; index += 1) {
      const y = 120 + index * 28;
      const wave = Math.sin(state.frame * 0.025 + index) * 8;
      ctx.beginPath();
      ctx.moveTo(70, y + wave);
      ctx.bezierCurveTo(260, y - 12, 420, y + 16, 620, y + wave);
      ctx.stroke();
    }
  }
}

function drawGroundTexture(theme) {
  const groundGradient = ctx.createLinearGradient(0, GROUND_Y, 0, HEIGHT);
  groundGradient.addColorStop(0, theme.ground);
  groundGradient.addColorStop(0.45, theme.ground2);
  groundGradient.addColorStop(1, theme.ground3);
  ctx.fillStyle = groundGradient;
  ctx.fillRect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y);

  const offset = -(state.scrollDistance * 0.55) % 42;

  if (theme.season === "hardcore") {
    const lavaOffset = -(state.scrollDistance * 0.9) % 110;
    ctx.fillStyle = "rgba(255, 88, 24, 0.3)";
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y + 10);
    for (let x = 0; x <= WIDTH + 80; x += 80) {
      ctx.quadraticCurveTo(x + 36, GROUND_Y + 4 + Math.sin((state.frame + x) * 0.025) * 8, x + 80, GROUND_Y + 12);
    }
    ctx.lineTo(WIDTH, HEIGHT);
    ctx.lineTo(0, HEIGHT);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 122, 24, 0.82)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let x = lavaOffset - 110; x < WIDTH + 120; x += 110) {
      const y = GROUND_Y + 28 + ((Math.floor(x / 110) % 4) * 26);
      ctx.moveTo(x, y);
      ctx.lineTo(x + 22, y + 8);
      ctx.lineTo(x + 44, y - 5);
      ctx.lineTo(x + 70, y + 6);
      ctx.lineTo(x + 106, y - 2);
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 177, 58, 0.55)";
    for (let x = lavaOffset - 60; x < WIDTH + 120; x += 86) {
      ctx.beginPath();
      ctx.ellipse(x, GROUND_Y + 82 + (x % 4) * 10, 20, 5, -0.15, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  if (theme.season === "winter") {
    ctx.fillStyle = appSettings.darkMode ? "rgba(229, 244, 255, 0.17)" : "rgba(255, 255, 255, 0.5)";
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y + 8);
    for (let x = 0; x <= WIDTH + 80; x += 80) {
      ctx.quadraticCurveTo(x + 36, GROUND_Y - 7 + Math.sin((state.frame + x) * 0.015) * 4, x + 80, GROUND_Y + 8);
    }
    ctx.lineTo(WIDTH, HEIGHT);
    ctx.lineTo(0, HEIGHT);
    ctx.closePath();
    ctx.fill();

    const skiOffset = -(state.scrollDistance * 0.78) % 150;
    ctx.strokeStyle = appSettings.darkMode ? "rgba(184, 222, 241, 0.38)" : "rgba(93, 146, 174, 0.3)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let x = skiOffset - 150; x < WIDTH + 150; x += 150) {
      ctx.moveTo(x, GROUND_Y + 38);
      ctx.quadraticCurveTo(x + 42, GROUND_Y + 28, x + 104, GROUND_Y + 40);
      ctx.moveTo(x + 4, GROUND_Y + 52);
      ctx.quadraticCurveTo(x + 46, GROUND_Y + 42, x + 108, GROUND_Y + 54);
    }
    ctx.stroke();

    ctx.fillStyle = appSettings.darkMode ? "rgba(210, 235, 247, 0.18)" : "rgba(91, 135, 160, 0.13)";
    for (let x = skiOffset - 90; x < WIDTH + 120; x += 105) {
      ctx.beginPath();
      ctx.ellipse(x, GROUND_Y + 86 + (x % 3) * 8, 18, 4, -0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  if (theme.season === "spring") {
    ctx.strokeStyle = appSettings.darkMode ? "rgba(153, 203, 137, 0.16)" : "rgba(235, 255, 201, 0.42)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = offset - 42; x < WIDTH + 42; x += 14) {
      ctx.moveTo(x, GROUND_Y + 18);
      ctx.quadraticCurveTo(x + 7, GROUND_Y + 9, x + 14, GROUND_Y + 18);
    }
    ctx.stroke();

    const flowerOffset = -(state.scrollDistance * 0.72) % 84;
    for (let x = flowerOffset - 84; x < WIDTH + 84; x += 84) {
      const y = GROUND_Y + 48 + ((Math.floor(x / 84) % 3) * 22);
      ctx.strokeStyle = "rgba(50, 116, 46, 0.5)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y + 8);
      ctx.lineTo(x, y - 4);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 218, 82, 0.92)";
      ctx.beginPath();
      ctx.arc(x, y - 5, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = x % 2 === 0 ? "rgba(255, 132, 184, 0.82)" : "rgba(247, 255, 156, 0.78)";
      for (let petal = 0; petal < 5; petal += 1) {
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(petal * 1.26) * 5, y - 5 + Math.sin(petal * 1.26) * 5, 3.3, 2.2, petal, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return;
  }

  if (theme.season === "summer") {
    const rowOffset = -(state.scrollDistance * 0.62) % 56;
    ctx.strokeStyle = appSettings.darkMode ? "rgba(232, 184, 86, 0.2)" : "rgba(255, 227, 121, 0.42)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = rowOffset - 80; x < WIDTH + 80; x += 28) {
      ctx.moveTo(x, GROUND_Y + 18);
      ctx.lineTo(x + 44, HEIGHT - 12);
    }
    ctx.stroke();
    ctx.fillStyle = appSettings.darkMode ? "rgba(197, 139, 65, 0.2)" : "rgba(126, 84, 32, 0.18)";
    for (let x = rowOffset - 56; x < WIDTH + 80; x += 72) {
      ctx.beginPath();
      ctx.ellipse(x, GROUND_Y + 68, 18, 5, -0.25, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  if (theme.season === "autumn") {
    const leafOffset = -(state.scrollDistance * 0.68) % 76;
    ctx.strokeStyle = appSettings.darkMode ? "rgba(0,0,0,0.22)" : "rgba(88, 47, 24, 0.24)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = leafOffset - 76; x < WIDTH + 76; x += 76) {
      ctx.moveTo(x, GROUND_Y + 44);
      ctx.lineTo(x + 38, GROUND_Y + 38);
      ctx.lineTo(x + 76, GROUND_Y + 46);
    }
    ctx.stroke();
    for (let x = leafOffset - 60; x < WIDTH + 100; x += 38) {
      const y = GROUND_Y + 24 + ((Math.floor(x / 38) % 5) * 22);
      ctx.fillStyle = x % 3 === 0 ? "rgba(207, 86, 38, 0.74)" : "rgba(224, 153, 54, 0.72)";
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((x + state.frame) * 0.03);
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.quadraticCurveTo(8, 0, 0, 6);
      ctx.quadraticCurveTo(-8, 0, 0, -4);
      ctx.fill();
      ctx.restore();
    }
    return;
  }

  ctx.strokeStyle = appSettings.darkMode ? "rgba(153, 203, 137, 0.12)" : "rgba(235, 255, 201, 0.32)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = offset - 42; x < WIDTH + 42; x += 14) {
    ctx.moveTo(x, GROUND_Y + 18);
    ctx.quadraticCurveTo(x + 7, GROUND_Y + 11, x + 14, GROUND_Y + 18);
  }
  ctx.stroke();

  ctx.strokeStyle = appSettings.darkMode ? "rgba(0,0,0,0.22)" : "rgba(52, 98, 43, 0.24)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = offset - 60; x < WIDTH + 60; x += 60) {
    ctx.moveTo(x, GROUND_Y + 46);
    ctx.lineTo(x + 32, GROUND_Y + 40);
    ctx.lineTo(x + 64, GROUND_Y + 48);
  }
  ctx.stroke();
}

function beginBossArenaView(theme) {
  if (!state.boss) {
    return false;
  }

  const zoom = 0.78;
  const focusY = HEIGHT * 0.56;
  const backdrop = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  backdrop.addColorStop(0, theme.sky);
  backdrop.addColorStop(0.64, theme.skyBottom);
  backdrop.addColorStop(0.65, theme.ground);
  backdrop.addColorStop(1, theme.ground3);
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.save();
  ctx.translate(WIDTH / 2, focusY);
  ctx.scale(zoom, zoom);
  ctx.translate(-WIDTH / 2, -focusY);
  return true;
}

function drawScene() {
  const theme = getAreaTheme();
  const perkCountdown = getPerkCountdownState();
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  const bossArenaZoomed = beginBossArenaView(theme);

  drawRollingHills(theme);

  for (const cloud of state.clouds) {
    drawCloud(cloud.x, cloud.y, cloud.size);
  }

  for (const bird of state.birds) {
    drawBird(bird);
  }

  drawSeasonAtmosphere(theme);
  drawGroundTexture(theme);

  for (const floater of state.meadowFloaters) {
    drawMeadowFloater(floater);
  }

  for (const obstacle of state.obstacles) drawObstacle(obstacle);
  for (const enemy of state.flyingEnemies) drawFlyingEnemy(enemy);
  if (state.boss) drawBoss(state.boss);
  for (const attack of state.bossAttacks) drawBossAttack(attack);
  for (const pickup of state.pickups) drawPickup(pickup);
  for (const coin of state.coinsInWorld) drawCoin(coin);
  for (const projectile of state.projectiles) drawProjectile(projectile);
  for (const burst of state.celebrationBursts) drawCelebrationBurst(burst);
  drawHorse();
  if (bossArenaZoomed) {
    ctx.restore();
  }
  drawBossFightHud();

  if (FRIDAY_EVENT_ACTIVE) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 250, 231, 0.92)";
    ctx.strokeStyle = "#d97706";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(18, 18, 204, 44, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#7c2d12";
    ctx.font = "bold 18px Trebuchet MS";
    ctx.textAlign = "left";
    ctx.fillText("Friday Celebration", 34, 46);
    ctx.restore();
  }

  if (perkCountdown) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 248, 239, 0.9)";
    ctx.strokeStyle = "#bf6d2e";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(WIDTH / 2 - 88, 58, 176, 62, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#8f3029";
    ctx.font = "bold 13px Trebuchet MS";
    ctx.textAlign = "center";
    ctx.fillText(`${perkCountdown.name} ending`, WIDTH / 2, 80);
    ctx.fillStyle = "#2f241b";
    ctx.font = "bold 30px Trebuchet MS";
    ctx.fillText(`${perkCountdown.secondsLeft}`, WIDTH / 2, 111);
    ctx.restore();
  }

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
  const scoreText = `${state.score}`;
  const coinText = `${state.coins}`;
  const areaText = `${state.area + 1}`;
  const perkText = getActivePerk();
  const statusLine = state.status;
  const introHidden = state.hasStarted;
  const pauseHidden = !state.paused;
  const pauseButtonLabel = state.paused ? "Resume" : "Pause";
  const pauseButtonDisabled = !state.hasStarted || state.gameOver;
  const submitText = state.awaitingScoreEntry
    ? (state.scoreSubmissionInProgress
      ? "Saving..."
      : (state.scoreSaveDecisionPending
      ? "Checking Score..."
      : (state.forcedScoreSave ? "Save Top Score" : "Save Score")))
    : "Save";
  const promptText = state.scoreSaveMessage || (state.awaitingScoreEntry
    ? (state.scoreSubmissionInProgress
      ? "Saving your score..."
      : (state.scoreSaveDecisionPending
      ? "Checking whether your score made the top 3 leaderboard..."
      : (state.forcedScoreSave
        ? "Top 3 score: enter a player name and save it to continue."
        : "Enter a name to save your score, or restart to skip saving.")))
    : (state.gameOver && state.scoreSubmitted
      ? "Score saved. Restart when you are ready for another run."
      : "Enter a name after game over to save your score."));
  const finalScoreText = `${state.score}`;
  const overlayHidden = !state.gameOver;
  const inputDisabled = !state.awaitingScoreEntry;
  const submitDisabled = !state.awaitingScoreEntry || state.scoreSaveDecisionPending || state.scoreSubmissionInProgress;
  const restartDisabled = state.awaitingScoreEntry
    && (state.scoreSaveDecisionPending || state.scoreSubmissionInProgress || state.forcedScoreSave);

  if (hudCache.score !== scoreText) {
    scoreValue.textContent = scoreText;
    hudCache.score = scoreText;
  }
  if (hudCache.coins !== coinText) {
    coinValue.textContent = coinText;
    hudCache.coins = coinText;
  }
  if (hudCache.area !== areaText) {
    areaValue.textContent = areaText;
    hudCache.area = areaText;
  }
  if (hudCache.perk !== perkText) {
    perkValue.textContent = perkText;
    hudCache.perk = perkText;
  }
  if (statusText && hudCache.status !== statusLine) {
    statusText.textContent = statusLine;
    hudCache.status = statusLine;
  }
  if (introOverlay && hudCache.introHidden !== introHidden) {
    introOverlay.hidden = introHidden;
    hudCache.introHidden = introHidden;
    if (!introHidden) {
      focusGameplayArea();
    }
  }
  if (pauseOverlay && hudCache.pauseHidden !== pauseHidden) {
    pauseOverlay.hidden = pauseHidden;
    hudCache.pauseHidden = pauseHidden;
    if (!pauseHidden) {
      focusGameplayArea();
    }
  }
  if (hudCache.submitText !== submitText) {
    scoreSubmitButton.textContent = submitText;
    hudCache.submitText = submitText;
  }
  if (hudCache.promptText !== promptText) {
    scorePromptText.textContent = promptText;
    hudCache.promptText = promptText;
  }
  if (finalScoreValue && hudCache.finalScore !== finalScoreText) {
    finalScoreValue.textContent = finalScoreText;
    hudCache.finalScore = finalScoreText;
  }
  if (gameOverOverlay && hudCache.overlayHidden !== overlayHidden) {
    gameOverOverlay.hidden = overlayHidden;
    hudCache.overlayHidden = overlayHidden;
  }
  if (hudCache.inputDisabled !== inputDisabled) {
    playerNameInput.disabled = inputDisabled;
    hudCache.inputDisabled = inputDisabled;
  }
  if (hudCache.submitDisabled !== submitDisabled) {
    scoreSubmitButton.disabled = submitDisabled;
    hudCache.submitDisabled = submitDisabled;
  }
  if (overlayRestartButton && hudCache.restartDisabled !== restartDisabled) {
    overlayRestartButton.disabled = restartDisabled;
    hudCache.restartDisabled = restartDisabled;
  }
  if (pauseButton && hudCache.pauseButtonLabel !== pauseButtonLabel) {
    pauseButton.textContent = pauseButtonLabel;
    hudCache.pauseButtonLabel = pauseButtonLabel;
  }
  if (pauseButton && hudCache.pauseButtonDisabled !== pauseButtonDisabled) {
    pauseButton.disabled = pauseButtonDisabled;
    hudCache.pauseButtonDisabled = pauseButtonDisabled;
  }

  for (const button of perkButtons) {
    const perk = button.dataset.perk;
    const affordable = state.coins >= PERK_COSTS[perk];
    const disabled = state.awaitingScoreEntry;
    const cached = hudCache.perkButtons.get(button) || {};
    if (cached.affordable !== affordable) {
      button.style.outline = affordable ? "3px solid #d5a62c" : "none";
      button.style.opacity = affordable ? "1" : "0.82";
      cached.affordable = affordable;
    }
    if (cached.disabled !== disabled) {
      button.disabled = disabled;
      cached.disabled = disabled;
    }
    hudCache.perkButtons.set(button, cached);
  }
}

function formatScoreTimestamp(createdAt) {
  if (!createdAt) {
    return "Saved time unknown";
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "Saved time unknown";
  }
  return `Saved ${date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function getVisibleScoreMode() {
  if (state.hasStarted || state.gameOver || state.awaitingScoreEntry) {
    return state.runMode;
  }
  return appSettings.hardcore ? SCORE_MODES.hardcore : SCORE_MODES.normal;
}

function getScoreModeLabel(gameMode) {
  return gameMode === SCORE_MODES.hardcore ? "Hardcore" : "Normal";
}

async function renderLeaderboard(pageIndex = leaderboardPageIndex) {
  if (!leaderboardList) {
    return;
  }

  const visibleMode = getVisibleScoreMode();
  const modeLabel = getScoreModeLabel(visibleMode);
  if (leaderboardTitle) {
    leaderboardTitle.textContent = `${modeLabel} Leaderboard`;
  }
  if (leaderboardLoading) {
    pendingLeaderboardPageIndex = pageIndex;
    if (leaderboardMode) {
      leaderboardMode.textContent = `Mode: loading ${modeLabel.toLowerCase()} scores...`;
    }
    return;
  }
  leaderboardLoading = true;
  if (leaderboardPrevButton) {
    leaderboardPrevButton.disabled = true;
  }
  if (leaderboardNextButton) {
    leaderboardNextButton.disabled = true;
  }
  if (leaderboardPageLabel) {
    leaderboardPageLabel.textContent = `Loading page ${pageIndex + 1}...`;
  }

  try {
    const page = await leaderboard.listScorePage(pageIndex, LEADERBOARD_PAGE_SIZE, visibleMode);
    leaderboardPageIndex = page.pageIndex;
    leaderboardList.innerHTML = "";

    if (page.scores.length === 0) {
      const item = document.createElement("li");
      item.className = "leaderboard-empty";
      item.textContent = page.pageIndex === 0
        ? `No ${modeLabel.toLowerCase()} scores yet.`
        : "No scores on this page yet.";
      leaderboardList.appendChild(item);
    } else {
      page.scores.forEach((entry, index) => {
        const item = document.createElement("li");
        const rank = document.createElement("span");
        const details = document.createElement("span");
        const timestamp = document.createElement("time");
        const rankNumber = page.pageIndex * LEADERBOARD_PAGE_SIZE + index + 1;

        rank.className = "leaderboard-rank";
        rank.textContent = `#${rankNumber}`;
        details.className = "leaderboard-score-details";
        details.textContent = `${entry.name} - ${entry.score}`;
        timestamp.className = "leaderboard-timestamp";
        if (entry.createdAt) {
          timestamp.dateTime = entry.createdAt;
        }
        timestamp.textContent = formatScoreTimestamp(entry.createdAt);

        item.appendChild(rank);
        item.appendChild(details);
        item.appendChild(timestamp);
        leaderboardList.appendChild(item);
      });
    }

    if (leaderboardPrevButton) {
      leaderboardPrevButton.disabled = !page.hasPrevious;
    }
    if (leaderboardNextButton) {
      leaderboardNextButton.disabled = !page.hasNext;
    }
    if (leaderboardPageLabel) {
      leaderboardPageLabel.textContent = `Page ${page.pageIndex + 1}`;
    }
    if (leaderboardMode) {
      const sourceNote = leaderboard.mode === "firebase+local"
        ? "firebase plus local unsynced saves"
        : leaderboard.mode;
      leaderboardMode.textContent = `Mode: ${sourceNote} ${modeLabel.toLowerCase()} scores only`;
    }
  } catch (_error) {
    leaderboardList.innerHTML = "";
    const item = document.createElement("li");
    item.className = "leaderboard-empty";
    item.textContent = "Could not load scores. Please try again.";
    leaderboardList.appendChild(item);
    if (leaderboardPrevButton) {
      leaderboardPrevButton.disabled = leaderboardPageIndex === 0;
    }
    if (leaderboardNextButton) {
      leaderboardNextButton.disabled = false;
    }
    if (leaderboardPageLabel) {
      leaderboardPageLabel.textContent = `Page ${leaderboardPageIndex + 1}`;
    }
  } finally {
    leaderboardLoading = false;
    if (pendingLeaderboardPageIndex !== null) {
      const pendingPage = pendingLeaderboardPageIndex;
      pendingLeaderboardPageIndex = null;
      renderLeaderboard(pendingPage);
    }
  }
}

function renderGameUpdates() {
  if (!updatesList) {
    return;
  }

  updatesList.innerHTML = "";
  for (const update of GAME_UPDATES.slice(0, visibleGameUpdateCount)) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    const title = document.createElement("strong");
    const description = document.createElement("p");

    time.dateTime = update.dateTime;
    time.textContent = update.displayTime;
    title.textContent = update.title;
    description.textContent = update.description;

    item.appendChild(time);
    item.appendChild(title);
    item.appendChild(description);
    updatesList.appendChild(item);
  }

  if (updatesToggleButton) {
    const expanded = visibleGameUpdateCount > COLLAPSED_UPDATE_COUNT;
    updatesToggleButton.textContent = expanded ? "Show latest 3 deployments" : "Show latest 6 deployments";
    updatesToggleButton.setAttribute("aria-expanded", `${expanded}`);
    updatesToggleButton.hidden = GAME_UPDATES.length <= COLLAPSED_UPDATE_COUNT;
  }
}

async function isTopThreeScore(score) {
  const scores = await leaderboard.listTopScores(state.runMode);
  if (scores.length < 3) {
    return score > 0;
  }
  const thirdScore = scores[2]?.score ?? -Infinity;
  return score > thirdScore;
}

async function submitCurrentScore() {
  if (!state.awaitingScoreEntry || state.scoreSubmitted || state.score <= 0 || state.scoreSubmissionInProgress) return;
  if (state.scoreSaveDecisionPending) {
    state.status = "Checking leaderboard position. Please wait a moment.";
    return;
  }
  const enteredName = playerNameInput.value.trim();
  if (!enteredName) {
    if (state.forcedScoreSave) {
      state.status = "Top 3 score: enter a player name to continue.";
      playerNameInput.focus();
      return;
    }
    state.scoreSubmitted = true;
    state.awaitingScoreEntry = false;
    state.status = "No name entered, score skipped. Restarting.";
    resetGame();
    return;
  }
  state.scoreSubmissionInProgress = true;
  state.scoreSubmitted = true;
  try {
    await leaderboard.submitScore(enteredName, state.score, state.runMode);
    state.awaitingScoreEntry = false;
    const savedOnline = leaderboard.lastWriteOnline === true;
    const modeLabel = getScoreModeLabel(state.runMode);
    state.scoreSaveMessage = savedOnline
      ? `${modeLabel} score saved online for ${enteredName}.`
      : `${modeLabel} score saved locally only. Firebase online write is blocked: ${leaderboard.lastError || "permission denied"}.`;
    state.status = state.scoreSaveMessage;
    playSaveSound();
    leaderboard.resetPagination();
    await renderLeaderboard(0);
  } catch (_error) {
    state.scoreSubmitted = false;
    state.scoreSaveMessage = "";
    state.status = "Score could not be saved. Please try again.";
  } finally {
    state.scoreSubmissionInProgress = false;
  }
}

function restartFromGameOverOverlay() {
  if (!state.gameOver || state.scoreSaveDecisionPending || state.scoreSubmissionInProgress) {
    return;
  }
  if (state.awaitingScoreEntry && state.forcedScoreSave) {
    state.status = "Top 3 score: enter a player name to continue.";
    playerNameInput.focus();
    return;
  }
  if (state.awaitingScoreEntry) {
    state.scoreSubmitted = true;
    state.awaitingScoreEntry = false;
    state.status = "No name entered, score skipped. Restarting.";
  }
  resetGame();
}

function tick(timestamp = performance.now()) {
  if (lastTickTime === null) {
    lastTickTime = timestamp;
  }

  if (state.hasStarted && !state.paused && !state.gameOver) {
    const elapsed = Math.min(250, timestamp - lastTickTime);
    accumulatedTime += elapsed;
    let simulationSteps = 0;

    while (accumulatedTime >= SIMULATION_STEP_MS && simulationSteps < MAX_SIMULATION_STEPS && !state.gameOver) {
      updateHorse();
      updateWorld();
      checkCollisions();
      accumulatedTime -= SIMULATION_STEP_MS;
      simulationSteps += 1;
    }

    if (simulationSteps === MAX_SIMULATION_STEPS && accumulatedTime >= SIMULATION_STEP_MS) {
      accumulatedTime = SIMULATION_STEP_MS;
    }
  } else {
    accumulatedTime = 0;
  }

  lastTickTime = timestamp;
  drawScene();
  syncHud();
  if (state.gameOver && !state.gameOverHandled) {
    state.gameOverHandled = true;
    state.awaitingScoreEntry = true;
    state.scoreSaveMessage = "";
    state.scoreSaveDecisionPending = true;
    state.forcedScoreSave = true;
    state.status = "Checking leaderboard position...";
    Promise.resolve(isTopThreeScore(state.score)).then((mustSave) => {
      state.scoreSaveDecisionPending = false;
      state.forcedScoreSave = mustSave;
      state.status = mustSave
        ? "Top 3 score. Enter a player name to save it. This is mandatory."
        : "Game over. Enter your name to save, or leave it empty to skip.";
      playerNameInput.focus();
      playerNameInput.select();
    }).catch(() => {
      state.scoreSaveDecisionPending = false;
      state.forcedScoreSave = true;
      state.status = "Could not verify leaderboard. Enter a player name to save this score.";
      playerNameInput.focus();
      playerNameInput.select();
    });
  }
  requestAnimationFrame(tick);
}

document.addEventListener("keydown", (event) => {
  unlockAudio();
  if (event.code === "Escape" && settingsOverlay && !settingsOverlay.hidden) {
    event.preventDefault();
    closeSettings();
    return;
  }
  if ((event.code === "KeyP" || event.code === "Escape") && state.hasStarted && !state.gameOver && !state.awaitingScoreEntry) {
    event.preventDefault();
    togglePause();
    return;
  }
  if (!state.awaitingScoreEntry && (event.code === "ArrowLeft" || event.code === "KeyA")) {
    state.input.left = true;
    if (isBossFightActive()) event.preventDefault();
  }
  if (!state.awaitingScoreEntry && (event.code === "ArrowRight" || event.code === "KeyD")) {
    state.input.right = true;
    if (isBossFightActive()) event.preventDefault();
  }
  if (event.code === "Space") {
    event.preventDefault();
    if (!state.hasStarted) {
      startRun();
    } else if (state.paused) {
      return;
    } else if (
      state.gameOver &&
      state.awaitingScoreEntry &&
      !playerNameInput.value.trim() &&
      !state.forcedScoreSave &&
      !state.scoreSaveDecisionPending
    ) {
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

document.addEventListener("keyup", (event) => {
  if (event.code === "ArrowLeft" || event.code === "KeyA") {
    state.input.left = false;
  }
  if (event.code === "ArrowRight" || event.code === "KeyD") {
    state.input.right = false;
  }
});

function updateTouchBossMovement(event) {
  if (!isBossFightActive() || !event.touches?.length) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const touchX = event.touches[0].clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, touchX / Math.max(1, rect.width)));
  const arenaPadding = BOSS_ARENA_MAX_X - BOSS_ARENA_MIN_X;
  state.input.touchTargetX = BOSS_ARENA_MIN_X + arenaPadding * ratio;
  state.input.left = false;
  state.input.right = false;
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch") {
    return;
  }
  unlockAudio();
  if (!state.hasStarted) {
    startRun();
  } else if (state.paused) {
    return;
  } else if (state.gameOver && !state.awaitingScoreEntry) {
    resetGame();
  } else if (!state.awaitingScoreEntry) {
    jump();
  }
});

canvas.addEventListener("touchstart", (event) => {
  event.preventDefault();
  unlockAudio();
  if (!state.hasStarted) {
    startRun();
  } else if (state.paused) {
    return;
  } else if (state.gameOver && !state.awaitingScoreEntry) {
    resetGame();
  } else if (isBossFightActive() && !state.awaitingScoreEntry) {
    updateTouchBossMovement(event);
  } else if (!state.awaitingScoreEntry) {
    jump();
  }
}, { passive: false });

canvas.addEventListener("touchmove", (event) => {
  if (!isBossFightActive()) {
    return;
  }
  event.preventDefault();
  updateTouchBossMovement(event);
}, { passive: false });

canvas.addEventListener("touchend", () => {
  state.input.left = false;
  state.input.right = false;
  state.input.touchTargetX = null;
});

canvas.addEventListener("touchcancel", () => {
  state.input.left = false;
  state.input.right = false;
  state.input.touchTargetX = null;
});

canvas.addEventListener("dblclick", (event) => {
  event.preventDefault();
});

for (const button of perkButtons) {
  button.addEventListener("click", () => {
    unlockAudio();
    tryActivatePerk(button.dataset.perk);
  });
}

if (pauseButton) {
  pauseButton.addEventListener("click", () => {
    unlockAudio();
    togglePause();
  });
}

if (fullscreenButton) {
  fullscreenButton.addEventListener("click", () => {
    unlockAudio();
    toggleFullscreenMode();
  });
}

if (startGameButton) {
  startGameButton.addEventListener("click", () => {
    unlockAudio();
    startRun();
  });
}

if (resumeGameButton) {
  resumeGameButton.addEventListener("click", () => {
    unlockAudio();
    togglePause(false);
  });
}

if (settingsButton) {
  settingsButton.addEventListener("click", () => {
    unlockAudio();
    openSettings();
  });
}

if (closeSettingsButton) {
  closeSettingsButton.addEventListener("click", () => {
    closeSettings();
  });
}

if (settingsOverlay) {
  settingsOverlay.addEventListener("click", (event) => {
    if (event.target === settingsOverlay) {
      closeSettings();
    }
  });
}

if (darkModeToggle) {
  darkModeToggle.addEventListener("change", () => {
    setSetting("darkMode", darkModeToggle.checked);
  });
}

if (hardcoreToggle) {
  hardcoreToggle.addEventListener("change", () => {
    setSetting("hardcore", hardcoreToggle.checked);
  });
}

if (hardcoreQuickToggle) {
  hardcoreQuickToggle.addEventListener("change", () => {
    unlockAudio();
    setSetting("hardcore", hardcoreQuickToggle.checked);
  });
}

if (soundToggle) {
  soundToggle.addEventListener("change", () => {
    setSetting("sound", soundToggle.checked);
  });
}

scoreForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitCurrentScore();
});

if (leaderboardPrevButton) {
  leaderboardPrevButton.addEventListener("click", () => {
    renderLeaderboard(Math.max(0, leaderboardPageIndex - 1));
  });
}

if (leaderboardNextButton) {
  leaderboardNextButton.addEventListener("click", () => {
    renderLeaderboard(leaderboardPageIndex + 1);
  });
}

if (updatesToggleButton) {
  updatesToggleButton.addEventListener("click", () => {
    visibleGameUpdateCount = visibleGameUpdateCount > COLLAPSED_UPDATE_COUNT
      ? COLLAPSED_UPDATE_COUNT
      : EXPANDED_UPDATE_COUNT;
    renderGameUpdates();
  });
}

if (overlayRestartButton) {
  overlayRestartButton.addEventListener("click", () => {
    unlockAudio();
    restartFromGameOverOverlay();
  });
}

window.addEventListener("load", () => {
  refocusGameplayAfterViewportChange();
});

window.addEventListener("resize", () => {
  refocusGameplayAfterViewportChange();
  syncFullscreenButton();
});

document.addEventListener("fullscreenchange", () => {
  syncFullscreenButton();
  refocusGameplayAfterViewportChange();
});

if (typeof mobileLandscapeQuery.addEventListener === "function") {
  mobileLandscapeQuery.addEventListener("change", () => {
    refocusGameplayAfterViewportChange();
  });
} else if (typeof mobileLandscapeQuery.addListener === "function") {
  mobileLandscapeQuery.addListener(() => {
    refocusGameplayAfterViewportChange();
  });
}

loadSettings();
applySettings();
renderGameUpdates();
renderLeaderboard();
syncHud();
syncFullscreenButton();
refocusGameplayAfterViewportChange();
tick();
