import json
import math
import random
import shutil
import struct
import subprocess
import sys
import tkinter as tk
import wave
from datetime import datetime
from pathlib import Path


class HorseJumpGame:
    """A tiny endless runner where the horse stays in place and jumps obstacles."""

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Horse Jump Game")
        self.root.geometry("960x560")
        self.root.resizable(False, False)
        self.root.configure(bg="#f5efe5")

        self.width = 920
        self.height = 460
        self.ground_y = 360
        self.horse_x = 150
        self.horse_width = 118
        self.horse_height = 92
        self.score_file = Path(__file__).with_name("horse_jump_scores.json")
        self.theme_sound_paths = {
            "area_0": Path(__file__).with_name("horse_theme_area_0.wav"),
            "area_1": Path(__file__).with_name("horse_theme_area_1.wav"),
            "area_2": Path(__file__).with_name("horse_theme_area_2.wav"),
            "area_3": Path(__file__).with_name("horse_theme_area_3.wav"),
            "power": Path(__file__).with_name("horse_theme_power.wav"),
        }
        self.horse_sound_path = Path(__file__).with_name("horse_call.wav")
        self.score_entries = self.load_score_entries()
        self.name_prompt_open = False
        self.score_saved_this_run = False
        self.music_process: subprocess.Popen[str] | None = None
        self.current_music_key = ""
        self.audio_backend = "bell"
        self.winsound = None
        self.perk_costs = {"fly": 35, "magnet": 28, "blaster": 32}

        self.canvas = tk.Canvas(
            root,
            width=self.width,
            height=self.height,
            bg="#d9efff",
            highlightthickness=0,
        )
        self.canvas.pack(padx=20, pady=(20, 12))

        control_frame = tk.Frame(root, bg="#f5efe5")
        control_frame.pack(fill="x", padx=20)

        self.status_label = tk.Label(
            control_frame,
            text="Press Space to jump. Press R to restart after a crash.",
            font=("Helvetica", 12),
            bg="#f5efe5",
            fg="#4d3a28",
        )
        self.status_label.pack(side="left")

        self.restart_button = tk.Button(
            control_frame,
            text="Restart",
            font=("Helvetica", 11, "bold"),
            bg="#8f6138",
            fg="white",
            activebackground="#714a2a",
            activeforeground="white",
            padx=14,
            pady=7,
            command=self.restart_game,
        )
        self.restart_button.pack(side="right")

        self.highscores_button = tk.Button(
            control_frame,
            text="High Scores",
            font=("Helvetica", 11, "bold"),
            bg="#4f7a9a",
            fg="white",
            activebackground="#3f6380",
            activeforeground="white",
            padx=14,
            pady=7,
            command=self.show_highscores,
        )
        self.highscores_button.pack(side="right", padx=(0, 10))

        self.root.bind("<space>", self.jump)
        self.root.bind("<r>", self.restart_game)
        self.root.bind("<R>", self.restart_game)
        self.root.bind("<Key-1>", lambda _event: self.try_activate_perk("fly"))
        self.root.bind("<Key-2>", lambda _event: self.try_activate_perk("magnet"))
        self.root.bind("<Key-3>", lambda _event: self.try_activate_perk("blaster"))
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        self.setup_audio()
        self.setup_game()
        self.game_loop()

    def play_sound(self, pattern: list[int], spacing: int = 120) -> None:
        """Use Tk's built-in bell for tiny local sound cues without extra assets."""
        for index, _ in enumerate(pattern):
            self.root.after(index * spacing, self.root.bell)

    def play_effect_wav(self, path: Path) -> None:
        """Play a short generated wav effect when a local backend supports it."""
        if not path.exists():
            self.play_sound([1, 1], 90)
            return

        if self.audio_backend == "afplay":
            subprocess.Popen(["afplay", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        elif self.audio_backend == "paplay":
            subprocess.Popen(["paplay", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        elif self.audio_backend == "aplay":
            subprocess.Popen(["aplay", "-q", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
        elif self.audio_backend == "winsound" and self.winsound is not None:
            self.winsound.PlaySound(str(path), self.winsound.SND_ASYNC | self.winsound.SND_FILENAME)
        else:
            self.play_sound([1, 1], 90)

    def setup_audio(self) -> None:
        """Prepare a simple local music loop using only standard-library-generated audio."""
        try:
            self.ensure_theme_music_files()
            self.ensure_horse_sound_file()
        except OSError:
            return

        if sys.platform == "darwin" and shutil.which("afplay"):
            self.audio_backend = "afplay"
        elif sys.platform.startswith("linux"):
            if shutil.which("paplay"):
                self.audio_backend = "paplay"
            elif shutil.which("aplay"):
                self.audio_backend = "aplay"
        elif sys.platform.startswith("win"):
            try:
                import winsound  # type: ignore

                self.winsound = winsound
                self.audio_backend = "winsound"
            except ImportError:
                self.audio_backend = "bell"

        self.start_background_music()

    def ensure_theme_music_files(self) -> None:
        """Generate longer, quieter 8-bit story tracks with a more varied feel."""
        sample_rate = 22050
        step = 0.18

        tracks = {
            "area_0": {
                "lead_a": [261.63, 329.63, 392.00, 329.63, 293.66, 349.23, 440.00, 392.00],
                "lead_b": [392.00, 440.00, 493.88, 440.00, 392.00, 349.23, 329.63, 293.66],
                "bass_a": [65.41, 98.00, 82.41, 98.00, 73.42, 110.00, 82.41, 98.00],
                "bass_b": [82.41, 98.00, 123.47, 98.00, 87.31, 110.00, 82.41, 73.42],
                "pulse": 0.42,
                "noise": 0.012,
            },
            "area_1": {
                "lead_a": [293.66, 349.23, 440.00, 392.00, 349.23, 392.00, 493.88, 440.00],
                "lead_b": [523.25, 440.00, 392.00, 349.23, 392.00, 440.00, 349.23, 293.66],
                "bass_a": [73.42, 110.00, 92.50, 110.00, 87.31, 130.81, 98.00, 110.00],
                "bass_b": [87.31, 110.00, 98.00, 87.31, 98.00, 123.47, 92.50, 73.42],
                "pulse": 0.36,
                "noise": 0.014,
            },
            "area_2": {
                "lead_a": [220.00, 261.63, 329.63, 349.23, 329.63, 293.66, 261.63, 196.00],
                "lead_b": [246.94, 293.66, 392.00, 349.23, 329.63, 293.66, 246.94, 220.00],
                "bass_a": [55.00, 82.41, 65.41, 73.42, 65.41, 61.74, 55.00, 49.00],
                "bass_b": [61.74, 87.31, 73.42, 82.41, 65.41, 61.74, 55.00, 49.00],
                "pulse": 0.48,
                "noise": 0.010,
            },
            "area_3": {
                "lead_a": [329.63, 392.00, 523.25, 493.88, 440.00, 392.00, 349.23, 440.00],
                "lead_b": [392.00, 493.88, 587.33, 523.25, 493.88, 440.00, 392.00, 349.23],
                "bass_a": [82.41, 123.47, 98.00, 110.00, 92.50, 73.42, 87.31, 98.00],
                "bass_b": [98.00, 146.83, 110.00, 123.47, 98.00, 92.50, 87.31, 73.42],
                "pulse": 0.34,
                "noise": 0.015,
            },
            "power": {
                "lead_a": [523.25, 659.25, 783.99, 659.25, 587.33, 698.46, 880.00, 987.77],
                "lead_b": [987.77, 880.00, 783.99, 698.46, 783.99, 880.00, 1046.50, 1174.66],
                "bass_a": [130.81, 164.81, 196.00, 164.81, 146.83, 174.61, 220.00, 246.94],
                "bass_b": [164.81, 196.00, 246.94, 220.00, 196.00, 220.00, 261.63, 293.66],
                "pulse": 0.28,
                "noise": 0.022,
            },
        }

        def square_wave(frequency: float, t: float, duty: float) -> float:
            cycle = (t * frequency) % 1.0
            return 1.0 if cycle < duty else -1.0

        for music_key, spec in tracks.items():
            frames = bytearray()
            lead_phrase = spec["lead_a"] + spec["lead_b"] + spec["lead_a"] + list(reversed(spec["lead_b"]))
            bass_phrase = spec["bass_a"] + spec["bass_b"] + spec["bass_a"] + list(reversed(spec["bass_b"]))
            lead_notes = lead_phrase * 4
            bass_notes = bass_phrase * 4
            total_frames = int(len(lead_notes) * step * sample_rate)

            for frame in range(total_frames):
                time_position = frame / sample_rate
                note_index = min(len(lead_notes) - 1, int(time_position / step))
                note_start = note_index * step
                local_t = time_position - note_start
                pulse = float(spec["pulse"])
                lead_frequency = float(lead_notes[note_index])
                bass_frequency = float(bass_notes[note_index])
                envelope = max(0.0, 1.0 - (local_t / step) * 0.4)

                lead = square_wave(lead_frequency, local_t, pulse) * 0.18 * envelope
                harmony = square_wave(lead_frequency * 0.5, local_t, 0.5) * 0.07 * envelope
                bass = square_wave(bass_frequency, time_position, 0.5) * 0.11

                arpeggio = 0.0
                if music_key != "power":
                    arp_index = (frame // max(1, int(sample_rate * step / 4))) % 4
                    arp_ratio = [1.0, 1.25, 1.5, 2.0][arp_index]
                    arpeggio = square_wave(lead_frequency * arp_ratio, local_t, 0.22) * 0.035

                percussion = 0.0
                step_frame = frame % max(1, int(sample_rate * step))
                if step_frame < 320:
                    percussion += 0.10 * (1.0 - step_frame / 320)
                if music_key == "power" and step_frame < 180:
                    percussion += 0.10 * (1.0 - step_frame / 180)

                noise = (random.random() * 2 - 1) * float(spec["noise"])
                melody_wobble = math.sin(2 * math.pi * 2.6 * time_position) * 0.012
                sample = max(-1.0, min(1.0, lead + harmony + bass + arpeggio + percussion + noise + melody_wobble))
                frames.extend(struct.pack("<h", int(sample * 4600)))

            with wave.open(str(self.theme_sound_paths[music_key]), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(bytes(frames))

    def ensure_horse_sound_file(self) -> None:
        """Generate a short synthetic horse-call effect."""
        sample_rate = 22050
        duration = 0.85
        total_frames = int(sample_rate * duration)
        frames = bytearray()

        for frame in range(total_frames):
            t = frame / sample_rate
            glide = 220 - 70 * t
            burst = math.sin(2 * math.pi * glide * t) * 0.28
            rough = math.sin(2 * math.pi * (glide * 1.9) * t) * 0.15
            wobble = math.sin(2 * math.pi * 6 * t) * 0.08
            envelope = math.exp(-2.2 * t)
            value = int(max(-1.0, min(1.0, (burst + rough + wobble) * envelope)) * 14000)
            frames.extend(struct.pack("<h", value))

        with wave.open(str(self.horse_sound_path), "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(bytes(frames))

    def desired_music_key(self) -> str:
        """Pick the music that matches the current area or apple-power chaos."""
        if getattr(self, "power_mode", False) and getattr(self, "power_timer", 0) > 0:
            return "power"
        area_stage = int(getattr(self, "area_stage", 0))
        return f"area_{max(0, min(3, area_stage))}"

    def start_background_music(self, music_key: str | None = None) -> None:
        """Start or restart the generated background theme."""
        music_key = music_key or self.desired_music_key()
        music_path = self.theme_sound_paths.get(music_key)
        if music_path is None or not music_path.exists():
            return

        self.current_music_key = music_key

        if self.audio_backend == "afplay":
            self.music_process = subprocess.Popen(
                ["afplay", str(music_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
        elif self.audio_backend == "paplay":
            self.music_process = subprocess.Popen(
                ["paplay", str(music_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
        elif self.audio_backend == "aplay":
            self.music_process = subprocess.Popen(
                ["aplay", "-q", str(music_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
            )
        elif self.audio_backend == "winsound" and self.winsound is not None:
            self.winsound.PlaySound(
                str(music_path),
                self.winsound.SND_ASYNC | self.winsound.SND_FILENAME,
            )

    def maintain_background_music(self) -> None:
        """Keep music looping and swap tracks when the world theme changes."""
        desired_key = self.desired_music_key()
        if desired_key != self.current_music_key:
            self.stop_background_music()
            self.start_background_music(desired_key)
            return

        if self.audio_backend in {"afplay", "paplay", "aplay"} and self.music_process is not None:
            if self.music_process.poll() is not None:
                self.music_process = None
                self.start_background_music(desired_key)
        elif self.audio_backend in {"afplay", "paplay", "aplay"} and self.music_process is None:
            self.start_background_music(desired_key)

    def stop_background_music(self) -> None:
        """Stop the current music playback."""
        if self.audio_backend in {"afplay", "paplay", "aplay"} and self.music_process is not None:
            if self.music_process.poll() is None:
                self.music_process.terminate()
            self.music_process = None
        elif self.audio_backend == "winsound" and self.winsound is not None:
            self.winsound.PlaySound(None, self.winsound.SND_ASYNC)

    def on_close(self) -> None:
        self.stop_background_music()
        self.root.destroy()

    def load_score_entries(self) -> list[dict[str, str | int]]:
        """Load previous scores from disk if the file exists."""
        if not self.score_file.exists():
            return []

        try:
            data = json.loads(self.score_file.read_text())
            if isinstance(data, list):
                return data[:20]
        except (OSError, json.JSONDecodeError):
            pass
        return []

    def save_score_entries(self) -> None:
        """Persist the most recent score entries to disk."""
        try:
            self.score_file.write_text(json.dumps(self.score_entries[:20], indent=2))
        except OSError:
            pass

    def show_highscores(self) -> None:
        """Open a simple local high-score window."""
        window = tk.Toplevel(self.root)
        window.title("Horse Jump High Scores")
        window.geometry("420x420")
        window.configure(bg="#f7f0e3")
        window.resizable(False, False)

        tk.Label(
            window,
            text="Last Tries",
            font=("Helvetica", 18, "bold"),
            bg="#f7f0e3",
            fg="#4d3a28",
        ).pack(pady=(16, 8))

        list_frame = tk.Frame(window, bg="#f7f0e3")
        list_frame.pack(fill="both", expand=True, padx=18, pady=(0, 12))

        if not self.score_entries:
            tk.Label(
                list_frame,
                text="No saved runs yet.",
                font=("Helvetica", 12),
                bg="#f7f0e3",
                fg="#6b543d",
            ).pack(anchor="w", pady=8)
            return

        sorted_entries = sorted(self.score_entries, key=lambda item: int(item["score"]), reverse=True)
        for index, entry in enumerate(sorted_entries[:12], start=1):
            line = f"{index:>2}. {entry['name']:<12}  {entry['score']:>6}  {entry['time']}"
            tk.Label(
                list_frame,
                text=line,
                font=("Courier", 11),
                bg="#fff8ed" if index % 2 else "#f0e4d2",
                fg="#4d3a28",
                anchor="w",
                padx=8,
                pady=5,
                width=40,
            ).pack(fill="x", pady=2)

    def prompt_for_score_name(self) -> None:
        """Ask the player for a name after a run ends and save the score."""
        if self.name_prompt_open:
            return

        self.name_prompt_open = True
        dialog = tk.Toplevel(self.root)
        dialog.title("Save Score")
        dialog.geometry("360x180")
        dialog.configure(bg="#f7f0e3")
        dialog.resizable(False, False)
        dialog.transient(self.root)
        dialog.grab_set()

        tk.Label(
            dialog,
            text=f"Save your run: {self.score} points",
            font=("Helvetica", 14, "bold"),
            bg="#f7f0e3",
            fg="#4d3a28",
        ).pack(pady=(18, 10))

        name_var = tk.StringVar(value="Player")
        entry = tk.Entry(dialog, textvariable=name_var, font=("Helvetica", 12), justify="center")
        entry.pack(padx=28, fill="x")
        entry.focus_set()
        entry.select_range(0, "end")

        def save_and_close() -> None:
            name = name_var.get().strip() or "Player"
            self.score_entries.insert(
                0,
                {
                    "name": name[:14],
                    "score": int(self.score),
                    "time": datetime.now().strftime("%m-%d %H:%M"),
                },
            )
            self.score_entries = self.score_entries[:20]
            self.save_score_entries()
            self.name_prompt_open = False
            self.score_saved_this_run = True
            dialog.destroy()

        tk.Button(
            dialog,
            text="Save",
            font=("Helvetica", 11, "bold"),
            bg="#8f6138",
            fg="white",
            activebackground="#714a2a",
            activeforeground="white",
            padx=12,
            pady=6,
            command=save_and_close,
        ).pack(pady=14)

        dialog.protocol("WM_DELETE_WINDOW", save_and_close)
        entry.bind("<Return>", lambda _event: save_and_close())

    def setup_game(self) -> None:
        """Initialize or reset the game state."""
        self.score = 0
        self.game_over = False
        self.frame_count = 0
        self.world_speed = 7
        self.gravity = 0.9
        self.jump_strength = -16.5
        self.horse_y = self.ground_y
        self.horse_velocity_y = 0.0
        self.on_ground = True
        self.jumps_left = 2
        self.difficulty_stage = 0
        self.area_stage = 0
        self.obstacles: list[dict[str, float | str | bool]] = []
        self.pickups: list[dict[str, float | str | bool]] = []
        self.coins: list[dict[str, float | str | bool]] = []
        self.projectiles: list[dict[str, float | str | bool]] = []
        self.decorations: list[dict[str, float | str]] = []
        self.special_effects: list[dict[str, float | str]] = []
        self.passed_obstacles = 0
        self.coin_count = 0
        self.power_mode = False
        self.power_timer = 0
        self.invisible_until = 0
        self.speed_boost_until = 0
        self.score_bonus_until = 0
        self.fly_until = 0
        self.magnet_until = 0
        self.blaster_until = 0
        self.rotten_speed_until = 0
        self.next_auto_shot_frame = 0
        self.background_sound_timer = 0
        self.next_horse_score_mark = 10000
        self.name_prompt_open = False
        self.score_saved_this_run = False

        # Background layers move at different speeds for a simple parallax effect.
        self.clouds = [
            {"x": 100, "y": 75, "size": 0.9, "speed": 0.5},
            {"x": 330, "y": 55, "size": 1.1, "speed": 0.35},
            {"x": 610, "y": 90, "size": 0.8, "speed": 0.45},
            {"x": 840, "y": 65, "size": 1.0, "speed": 0.4},
        ]
        self.mountains = [
            {"x": -40, "width": 240, "height": 120, "speed": 1.0},
            {"x": 180, "width": 280, "height": 145, "speed": 1.0},
            {"x": 430, "width": 250, "height": 110, "speed": 1.0},
            {"x": 650, "width": 260, "height": 135, "speed": 1.0},
            {"x": 860, "width": 240, "height": 120, "speed": 1.0},
        ]
        self.trees = [
            {"x": 90, "kind": "tree", "speed": 2.2},
            {"x": 250, "kind": "bush", "speed": 2.4},
            {"x": 420, "kind": "tree", "speed": 2.0},
            {"x": 570, "kind": "bush", "speed": 2.5},
            {"x": 730, "kind": "tree", "speed": 2.1},
            {"x": 880, "kind": "bush", "speed": 2.3},
        ]
        self.ground_marks = [{"x": x, "width": random.randint(18, 34)} for x in range(0, self.width + 60, 40)]

        self.spawn_timer = 85
        self.pickup_timer = random.randint(1800, 2600)
        self.coin_timer = random.randint(140, 220)
        self.status_label.config(text="Press Space to jump. Press R to restart after a crash.")

    def restart_game(self, _event: tk.Event | None = None) -> None:
        self.setup_game()

    def jump(self, _event: tk.Event | None = None) -> None:
        """Allow normal jumping, double jump, and freer movement during flight perk."""
        if self.game_over:
            return

        if self.fly_until > self.frame_count:
            self.horse_velocity_y = -11.5
            self.on_ground = False
            self.play_sound([1], 80)
            return

        if self.jumps_left > 0:
            self.horse_velocity_y = self.jump_strength
            self.on_ground = False
            self.jumps_left -= 1
            self.play_sound([1], 80)

    def update_difficulty(self) -> None:
        """Gradually increase speed and obstacle variety over time."""
        self.difficulty_stage = min(12, self.score // 2500)
        self.area_stage = (self.score // 2500) % 4
        self.world_speed = 7 + self.difficulty_stage * 0.55
        if self.speed_boost_until > self.frame_count:
            self.world_speed += 1.8

    def build_obstacle(self, obstacle_type: str, x: float) -> dict[str, float | str | bool]:
        """Create a single obstacle dictionary with drawing and collision metadata."""
        obstacle_specs = {
            "hay": {"width": 50, "height": 40, "top_offset": 40, "landable": False},
            "crate": {"width": 40, "height": 40, "top_offset": 40, "landable": False},
            "fence": {"width": 56, "height": 56, "top_offset": 56, "landable": False},
            "rock": {"width": 48, "height": 30, "top_offset": 30, "landable": False},
            "barrel": {"width": 38, "height": 48, "top_offset": 48, "landable": False},
            "stump": {"width": 44, "height": 34, "top_offset": 34, "landable": False},
            "bush": {"width": 54, "height": 34, "top_offset": 34, "landable": False},
            "pipe": {"width": 50, "height": 58, "top_offset": 58, "landable": False},
            "crate_stack": {"width": 62, "height": 68, "top_offset": 68, "landable": True},
            "hay_wagon": {"width": 94, "height": 58, "top_offset": 58, "landable": True},
            "bridge": {"width": 142, "height": 78, "top_offset": 64, "landable": True},
            "rolling_barrel": {"width": 40, "height": 42, "top_offset": 42, "landable": False},
            "jumping_crate": {"width": 44, "height": 44, "top_offset": 44, "landable": False},
            "crow": {"width": 48, "height": 30, "top_offset": 140, "landable": False},
            "brick_block": {"width": 54, "height": 54, "top_offset": 54, "landable": True},
            "spike": {"width": 48, "height": 30, "top_offset": 30, "landable": False},
            "mushroom": {"width": 58, "height": 42, "top_offset": 42, "landable": False},
            "piranha_pipe": {"width": 58, "height": 76, "top_offset": 76, "landable": False},
        }
        spec = obstacle_specs[obstacle_type]
        top = self.ground_y - spec["top_offset"]
        return {
            "x": x,
            "width": float(spec["width"]),
            "height": float(spec["height"]),
            "top": float(top),
            "type": obstacle_type,
            "passed": False,
            "landable": bool(spec["landable"]),
            "base_top": float(top),
            "phase": float(random.randint(0, 100)),
        }

    def create_obstacle(self) -> None:
        """Spawn random obstacles and simple patterns as difficulty rises."""
        base_x = float(self.width + random.randint(40, 180))
        easy_types = ["hay", "crate", "rock", "barrel", "stump", "bush", "mushroom", "spike"]
        medium_types = easy_types + ["fence", "crate_stack", "pipe", "rolling_barrel", "brick_block"]
        hard_types = medium_types + ["hay_wagon", "bridge", "jumping_crate", "crow", "piranha_pipe"]

        if self.difficulty_stage <= 1:
            obstacle_type = random.choice(easy_types)
            self.obstacles.append(self.build_obstacle(obstacle_type, base_x))
            return

        if self.difficulty_stage <= 3:
            obstacle_type = random.choice(medium_types)
            self.obstacles.append(self.build_obstacle(obstacle_type, base_x))
            if random.random() < 0.25:
                second_type = random.choice(easy_types)
                second_x = base_x + random.randint(80, 130)
                self.obstacles.append(self.build_obstacle(second_type, second_x))
            return

        pattern_roll = random.random()
        if pattern_roll < 0.25:
            self.obstacles.append(self.build_obstacle("bridge", base_x))
            self.obstacles.append(self.build_obstacle(random.choice(easy_types), base_x + random.randint(150, 210)))
        elif pattern_roll < 0.55:
            for index in range(random.randint(2, 3)):
                obstacle_type = random.choice(hard_types)
                gap = 88 + index * random.randint(55, 90)
                self.obstacles.append(self.build_obstacle(obstacle_type, base_x + gap))
        else:
            obstacle_type = random.choice(hard_types)
            self.obstacles.append(self.build_obstacle(obstacle_type, base_x))

        if self.difficulty_stage >= 2 and random.random() < 0.28:
            self.decorations.append(
                {
                    "type": random.choice(["bonus_block", "coin_ring"]),
                    "x": base_x + random.randint(20, 120),
                    "y": float(random.randint(170, 260)),
                }
            )

    def create_pickup(self) -> None:
        """Spawn either a safe red apple or a risky rotten speed apple."""
        pickup_y = random.choice([self.ground_y - 130, self.ground_y - 180, self.ground_y - 225])
        pickup_type = "rotten_apple" if random.random() < 0.28 else "apple"
        self.pickups.append(
            {
                "type": pickup_type,
                "x": float(self.width + random.randint(120, 220)),
                "y": float(pickup_y),
                "size": 16.0,
            }
        )

    def create_coin_pattern(self) -> None:
        """Spawn a few coins in arcs or short lines."""
        start_x = float(self.width + random.randint(60, 160))
        base_y = random.choice([self.ground_y - 70, self.ground_y - 120, self.ground_y - 170])
        pattern = random.choice(["line", "arc"])

        for index in range(random.randint(3, 5)):
            y = base_y
            if pattern == "arc":
                y = base_y - abs(2 - index) * 16 + 24
            self.coins.append(
                {
                    "x": start_x + index * 34,
                    "y": float(y),
                    "size": 11.0,
                    "spin": float(index * 6),
                }
            )

    def try_activate_perk(self, perk_name: str) -> None:
        """Spend coins to activate one of three 10-second perks."""
        if self.game_over:
            return

        if self.coin_count < self.perk_costs[perk_name]:
            self.status_label.config(text=f"Need {self.perk_costs[perk_name]} coins for that perk.")
            return

        self.coin_count -= self.perk_costs[perk_name]
        perk_duration = 10 * 60
        if perk_name == "fly":
            self.fly_until = self.frame_count + perk_duration
            self.status_label.config(text="Flight perk active for 10 seconds.")
        elif perk_name == "magnet":
            self.magnet_until = self.frame_count + perk_duration
            self.status_label.config(text="Coin magnet active for 10 seconds.")
        else:
            self.blaster_until = self.frame_count + perk_duration
            self.next_auto_shot_frame = self.frame_count
            self.status_label.config(text="Blaster perk active for 10 seconds. Auto-fire engaged.")
        self.play_sound([1, 1], 100)

    def get_active_perk_status(self) -> tuple[str, int]:
        """Return the active perk label and its remaining time."""
        if self.fly_until > self.frame_count:
            return "Fly", max(0, (self.fly_until - self.frame_count) // 60)
        if self.magnet_until > self.frame_count:
            return "Magnet", max(0, (self.magnet_until - self.frame_count) // 60)
        if self.blaster_until > self.frame_count:
            return "Blaster", max(0, (self.blaster_until - self.frame_count) // 60)
        return "None", 0

    def collect_coin(self, coin: dict[str, float | str | bool]) -> None:
        """Award a coin once, whether touched or pulled in by magnet."""
        if coin not in self.coins:
            return
        self.coins.remove(coin)
        self.coin_count += 1
        self.score += 8
        self.play_sound([1], 50)

    def fire_projectile(self, _event: tk.Event | None = None) -> None:
        """Shoot targeted shots while the blaster perk is active."""
        if self.game_over or self.blaster_until <= self.frame_count:
            return

        start_x = float(self.horse_x + 175)
        start_y = float(self.horse_y - 92)
        ahead_obstacles = [
            obstacle
            for obstacle in self.obstacles
            if float(obstacle["x"]) + float(obstacle["width"]) > start_x
        ]
        ahead_obstacles.sort(key=lambda obstacle: float(obstacle["x"]))

        def add_projectile(target_x: float, target_y: float, speed: float, color: str) -> None:
            dx = target_x - start_x
            dy = target_y - start_y
            distance = max(1.0, math.hypot(dx, dy))
            self.projectiles.append(
                {
                    "x": start_x,
                    "y": start_y,
                    "vx": dx / distance * speed,
                    "vy": dy / distance * speed,
                    "size": 8.0,
                    "color": color,
                }
            )

        if ahead_obstacles:
            target = ahead_obstacles[0]
            target_x = float(target["x"]) + float(target["width"]) * 0.5
            target_y = float(target["top"]) + float(target["height"]) * 0.5
            add_projectile(target_x, target_y, 15.0, "#7ec8ff")
        else:
            add_projectile(start_x + 180.0, start_y, 15.0, "#7ec8ff")

        add_projectile(start_x + 130.0, self.ground_y - 8.0, 13.0, "#9fe0ff")
        if self.frame_count % 3 == 0:
            self.play_sound([1], 50)

    def create_special_effect(self) -> None:
        """Spawn a rare animated world event for extra personality."""
        effect_type = random.choice(["bird_flock", "shooting_star", "leaf_swirl"])
        if effect_type == "bird_flock":
            self.special_effects.append(
                {
                    "type": effect_type,
                    "x": float(self.width + 40),
                    "y": float(random.randint(70, 160)),
                    "speed": float(6 + random.random() * 2),
                }
            )
        elif effect_type == "shooting_star":
            self.special_effects.append(
                {
                    "type": effect_type,
                    "x": float(self.width + 20),
                    "y": float(random.randint(40, 120)),
                    "speed": float(10 + random.random() * 3),
                }
            )
        else:
            self.special_effects.append(
                {
                    "type": effect_type,
                    "x": float(self.width + 20),
                    "y": float(self.ground_y - random.randint(20, 70)),
                    "speed": float(5 + random.random() * 2),
                }
            )

    def activate_apple_power(self) -> None:
        """Enable a short superhero mode with invisibility and bonus perks."""
        self.power_mode = True
        self.power_timer = 600
        self.invisible_until = self.frame_count + 600
        self.speed_boost_until = self.frame_count + 420
        self.score_bonus_until = self.frame_count + 600
        self.rotten_speed_until = 0
        self.status_label.config(
            text="Apple power! Invisibility active for 10 seconds. Superman horse mode on."
        )
        self.play_sound([1, 1, 1], 90)

    def activate_rotten_apple_power(self) -> None:
        """Enable only a temporary speed boost, without collision protection."""
        self.rotten_speed_until = self.frame_count + 600
        self.speed_boost_until = self.frame_count + 600
        self.status_label.config(
            text="Rotten apple! Speed boost active, but you can still die."
        )
        self.play_sound([1, 1], 70)

    def get_theme(self) -> dict[str, str]:
        """Rotate through a few simple world areas for visual variety."""
        themes = [
            {
                "sky": "#d9efff",
                "sun": "#ffe694",
                "mountain": "#bdd4c4",
                "ground": "#8bc56f",
                "ground_2": "#7ab35f",
                "grass": "#6fa955",
                "flower": "#6aa652",
                "tree_trunk": "#7a5030",
                "tree_leaf_1": "#5eaa5a",
                "tree_leaf_2": "#76bf67",
                "bush_1": "#63af54",
                "bush_2": "#78c267",
                "bush_3": "#5ea84e",
            },
            {
                "sky": "#ffd9b5",
                "sun": "#ffcf72",
                "mountain": "#d4b29e",
                "ground": "#d0a062",
                "ground_2": "#be874f",
                "grass": "#a56d36",
                "flower": "#d49a5a",
                "tree_trunk": "#875537",
                "tree_leaf_1": "#b66834",
                "tree_leaf_2": "#d67e45",
                "bush_1": "#b05e2e",
                "bush_2": "#d37b3e",
                "bush_3": "#995024",
            },
            {
                "sky": "#d4e2ff",
                "sun": "#fff0bf",
                "mountain": "#c7cedf",
                "ground": "#a0c7d8",
                "ground_2": "#89b4c9",
                "grass": "#6e9fb7",
                "flower": "#7bb2c7",
                "tree_trunk": "#5d4f46",
                "tree_leaf_1": "#80a9c5",
                "tree_leaf_2": "#a5c7de",
                "bush_1": "#78a5bf",
                "bush_2": "#97c3db",
                "bush_3": "#6d94ad",
            },
            {
                "sky": "#dff7ff",
                "sun": "#fff5a8",
                "mountain": "#cfdcbe",
                "ground": "#a6d27f",
                "ground_2": "#8fc060",
                "grass": "#79aa4d",
                "flower": "#ffe29c",
                "tree_trunk": "#785332",
                "tree_leaf_1": "#55a758",
                "tree_leaf_2": "#70c86f",
                "bush_1": "#5cad58",
                "bush_2": "#76cb72",
                "bush_3": "#4d9548",
            },
        ]
        return themes[self.area_stage]

    def update_horse(self) -> None:
        """Apply gravity and allow landing on the ground or platform-like obstacles."""
        previous_y = self.horse_y

        if self.fly_until > self.frame_count:
            self.horse_velocity_y += 0.55
            self.horse_velocity_y = max(-11.5, min(7.5, self.horse_velocity_y))
            self.horse_y += self.horse_velocity_y
            self.horse_y = max(90, min(self.ground_y, self.horse_y))
            if self.horse_y >= self.ground_y:
                self.horse_y = self.ground_y
                self.horse_velocity_y = 0.0
                self.on_ground = True
                self.jumps_left = 2
            else:
                self.on_ground = False
            return

        if not self.on_ground:
            self.horse_velocity_y += self.gravity
            self.horse_y += self.horse_velocity_y

        landing_y = self.ground_y
        landed = False
        horse_left = self.horse_x + 28
        horse_right = self.horse_x + self.horse_width - 20

        if self.horse_velocity_y >= 0:
            for obstacle in self.obstacles:
                if not obstacle["landable"]:
                    continue

                obstacle_left = float(obstacle["x"]) + 6
                obstacle_right = float(obstacle["x"]) + float(obstacle["width"]) - 6
                obstacle_top = float(obstacle["top"])

                overlaps_horizontally = horse_left < obstacle_right and horse_right > obstacle_left
                crossed_platform = previous_y <= obstacle_top <= self.horse_y + 2

                if overlaps_horizontally and crossed_platform and obstacle_top < landing_y:
                    landing_y = obstacle_top
                    landed = True

        if self.horse_y >= landing_y:
            self.horse_y = landing_y
            self.horse_velocity_y = 0.0
            self.on_ground = True
            self.jumps_left = 2
        else:
            self.on_ground = landed and self.horse_y >= landing_y

    def update_power_mode(self) -> None:
        if self.power_timer > 0:
            self.power_timer -= 1
        else:
            self.power_mode = False

        if self.blaster_until > self.frame_count and not self.game_over and self.frame_count >= self.next_auto_shot_frame:
            self.fire_projectile()
            self.next_auto_shot_frame = self.frame_count + 9

        if not self.game_over:
            self.background_sound_timer -= 1
            if self.background_sound_timer <= 0:
                self.play_sound([1], 80)
                self.background_sound_timer = max(180, 320 - self.difficulty_stage * 10)

    def update_background(self) -> None:
        for cloud in self.clouds:
            cloud["x"] -= cloud["speed"]
            if cloud["x"] < -120:
                cloud["x"] = self.width + random.randint(40, 180)
                cloud["y"] = random.randint(45, 105)

        for mountain in self.mountains:
            mountain["x"] -= mountain["speed"]
            if mountain["x"] + mountain["width"] < 0:
                rightmost = max(item["x"] + item["width"] for item in self.mountains)
                mountain["x"] = rightmost - 30
                mountain["width"] = random.randint(220, 300)
                mountain["height"] = random.randint(105, 150)

        for item in self.trees:
            item["x"] -= item["speed"]
            if item["x"] < -80:
                item["x"] = self.width + random.randint(40, 180)
                item["kind"] = random.choice(["tree", "bush"])

        for mark in self.ground_marks:
            mark["x"] -= self.world_speed
            if mark["x"] + mark["width"] < 0:
                rightmost = max(item["x"] + item["width"] for item in self.ground_marks)
                mark["x"] = rightmost + random.randint(14, 42)
                mark["width"] = random.randint(18, 34)

        for decoration in self.decorations:
            decoration["x"] -= self.world_speed
        self.decorations = [item for item in self.decorations if item["x"] > -80]

        for effect in self.special_effects:
            effect["x"] -= effect["speed"]
            if effect["type"] == "shooting_star":
                effect["y"] += 1.4
            elif effect["type"] == "leaf_swirl":
                effect["y"] += ((self.frame_count // 4) % 3) - 1

        self.special_effects = [item for item in self.special_effects if item["x"] > -120 and item["y"] < self.height + 40]

        if random.random() < 0.0045:
            self.create_special_effect()

    def update_obstacles(self) -> None:
        if self.game_over:
            return

        self.update_difficulty()
        self.spawn_timer -= 1
        if self.spawn_timer <= 0:
            self.create_obstacle()
            min_gap = max(30, 62 - self.difficulty_stage * 4)
            max_gap = max(min_gap + 12, 96 - self.difficulty_stage * 5)
            self.spawn_timer = random.randint(min_gap, max_gap)

        self.pickup_timer -= 1
        if self.pickup_timer <= 0:
            self.create_pickup()
            self.pickup_timer = random.randint(1800, 2800)

        self.coin_timer -= 1
        if self.coin_timer <= 0:
            self.create_coin_pattern()
            self.coin_timer = random.randint(150, 260)

        for obstacle in self.obstacles:
            obstacle["x"] -= self.world_speed
            kind = str(obstacle["type"])
            if kind == "rolling_barrel":
                obstacle["top"] = float(obstacle["base_top"]) + ((self.frame_count + obstacle["phase"]) % 10) * 0.5
            elif kind == "jumping_crate":
                obstacle["top"] = float(obstacle["base_top"]) - abs(((self.frame_count + obstacle["phase"]) % 48) - 24) * 0.7
            elif kind == "crow":
                obstacle["top"] = float(obstacle["base_top"]) + (((self.frame_count + obstacle["phase"]) % 60) - 30) * 0.6

            if not obstacle["passed"] and obstacle["x"] + obstacle["width"] < self.horse_x - 8:
                obstacle["passed"] = True
                self.passed_obstacles += 1
                self.score += 35 if self.score_bonus_until > self.frame_count else 25

        for pickup in self.pickups:
            pickup["x"] -= self.world_speed

        for coin in self.coins:
            if self.magnet_until > self.frame_count:
                dx = (self.horse_x + 86) - float(coin["x"])
                dy = (self.horse_y - 58) - float(coin["y"])
                distance = max(1.0, math.hypot(dx, dy))
                pull_speed = min(distance, max(14.0, self.world_speed + distance * 0.14))
                coin["x"] += dx / distance * pull_speed
                coin["y"] += dy / distance * pull_speed
            else:
                coin["x"] -= self.world_speed
            coin["spin"] = float(coin["spin"]) + 1.5

        for projectile in self.projectiles:
            projectile["x"] += projectile["vx"]
            projectile["y"] += projectile.get("vy", 0.0)

        self.projectiles = [
            item
            for item in self.projectiles
            if -40 < float(item["x"]) < self.width + 40 and -40 < float(item["y"]) < self.height + 40
        ]

        self.pickups = [item for item in self.pickups if item["x"] > -40]
        self.coins = [item for item in self.coins if item["x"] > -30]

        self.obstacles = [item for item in self.obstacles if item["x"] + item["width"] > -20]

    def check_collisions(self) -> None:
        horse_left = self.horse_x + 18
        horse_right = self.horse_x + self.horse_width - 16
        horse_top = self.horse_y - self.horse_height + 18
        horse_bottom = self.horse_y

        for pickup in self.pickups[:]:
            pickup_left = pickup["x"] - pickup["size"]
            pickup_right = pickup["x"] + pickup["size"]
            pickup_top = pickup["y"] - pickup["size"]
            pickup_bottom = pickup["y"] + pickup["size"]
            overlaps_horizontally = horse_left < pickup_right and horse_right > pickup_left
            overlaps_vertically = horse_top < pickup_bottom and horse_bottom > pickup_top

            if overlaps_horizontally and overlaps_vertically:
                self.pickups.remove(pickup)
                if pickup["type"] == "rotten_apple":
                    self.activate_rotten_apple_power()
                else:
                    self.activate_apple_power()
                self.score += 120
                break

        for coin in self.coins[:]:
            coin_left = float(coin["x"]) - float(coin["size"])
            coin_right = float(coin["x"]) + float(coin["size"])
            coin_top = float(coin["y"]) - float(coin["size"])
            coin_bottom = float(coin["y"]) + float(coin["size"])
            overlaps_horizontally = horse_left < coin_right and horse_right > coin_left
            overlaps_vertically = horse_top < coin_bottom and horse_bottom > coin_top
            if self.magnet_until > self.frame_count:
                magnet_dx = (self.horse_x + 86) - float(coin["x"])
                magnet_dy = (self.horse_y - 58) - float(coin["y"])
                if math.hypot(magnet_dx, magnet_dy) < 54:
                    self.collect_coin(coin)
                    continue

            if overlaps_horizontally and overlaps_vertically:
                self.collect_coin(coin)

        for projectile in self.projectiles[:]:
            projectile_left = float(projectile["x"]) - float(projectile["size"])
            projectile_right = float(projectile["x"]) + float(projectile["size"])
            projectile_top = float(projectile["y"]) - float(projectile["size"])
            projectile_bottom = float(projectile["y"]) + float(projectile["size"])

            for obstacle in self.obstacles[:]:
                obstacle_left = obstacle["x"] + 4
                obstacle_right = obstacle["x"] + obstacle["width"] - 4
                obstacle_top = float(obstacle["top"])
                obstacle_bottom = obstacle_top + obstacle["height"]

                overlaps_horizontally = projectile_left < obstacle_right and projectile_right > obstacle_left
                overlaps_vertically = projectile_top < obstacle_bottom and projectile_bottom > obstacle_top

                if overlaps_horizontally and overlaps_vertically:
                    if projectile in self.projectiles:
                        self.projectiles.remove(projectile)
                    if obstacle in self.obstacles:
                        self.obstacles.remove(obstacle)
                    self.score += 40
                    self.play_sound([1, 1], 70)
                    break

        for obstacle in self.obstacles:
            obstacle_left = obstacle["x"] + 4
            obstacle_right = obstacle["x"] + obstacle["width"] - 4
            obstacle_top = float(obstacle["top"])
            obstacle_bottom = obstacle_top + obstacle["height"]

            overlaps_horizontally = horse_left < obstacle_right and horse_right > obstacle_left
            overlaps_vertically = horse_top < obstacle_bottom and horse_bottom > obstacle_top

            if obstacle["landable"]:
                standing_on_top = horse_bottom >= obstacle_top - 3 and horse_bottom <= obstacle_top + 6
                if overlaps_horizontally and standing_on_top and self.horse_velocity_y >= 0:
                    continue

            if self.invisible_until > self.frame_count:
                continue

            if overlaps_horizontally and overlaps_vertically:
                self.game_over = True
                self.status_label.config(
                    text=f"Game Over. Score: {self.score}  |  Press R or click Restart."
                )
                self.play_sound([1, 1, 1], 180)
                break

    def update_score(self) -> None:
        if not self.game_over:
            self.score += 2 if self.score_bonus_until > self.frame_count else 1
            if self.score >= self.next_horse_score_mark:
                self.play_effect_wav(self.horse_sound_path)
                self.next_horse_score_mark += 10000

    def draw_cloud(self, x: float, y: float, scale: float) -> None:
        self.canvas.create_oval(x, y, x + 44 * scale, y + 24 * scale, fill="white", outline="")
        self.canvas.create_oval(
            x + 20 * scale, y - 10 * scale, x + 62 * scale, y + 20 * scale, fill="white", outline=""
        )
        self.canvas.create_oval(
            x + 42 * scale, y, x + 86 * scale, y + 24 * scale, fill="white", outline=""
        )

    def draw_tree(self, x: float) -> None:
        theme = self.get_theme()
        self.canvas.create_rectangle(
            x + 16, self.ground_y - 56, x + 28, self.ground_y - 8, fill=theme["tree_trunk"], outline=""
        )
        self.canvas.create_oval(x, self.ground_y - 94, x + 44, self.ground_y - 42, fill=theme["tree_leaf_1"], outline="")
        self.canvas.create_oval(x + 10, self.ground_y - 110, x + 56, self.ground_y - 60, fill=theme["tree_leaf_2"], outline="")

    def draw_bush(self, x: float) -> None:
        theme = self.get_theme()
        self.canvas.create_oval(x, self.ground_y - 24, x + 28, self.ground_y + 6, fill=theme["bush_1"], outline="")
        self.canvas.create_oval(x + 14, self.ground_y - 30, x + 46, self.ground_y + 6, fill=theme["bush_2"], outline="")
        self.canvas.create_oval(x + 30, self.ground_y - 24, x + 58, self.ground_y + 8, fill=theme["bush_3"], outline="")

    def draw_pickup(self, pickup: dict[str, float | str | bool]) -> None:
        x = float(pickup["x"])
        y = float(pickup["y"])
        size = float(pickup["size"])
        pulse = (self.frame_count // 8) % 2
        is_rotten = pickup["type"] == "rotten_apple"
        self.canvas.create_oval(
            x - size,
            y - size,
            x + size,
            y + size,
            fill="#8ba53a" if is_rotten else "#df3939",
            outline="#5b6e1f" if is_rotten else "#9b1f1f",
            width=2,
        )
        self.canvas.create_oval(
            x - 3,
            y - size - 5,
            x + 3,
            y - size + 1,
            fill="#5f8d34",
            outline="",
        )
        self.canvas.create_line(x, y - size - 5, x + 6, y - size - 12, fill="#5f8d34", width=3)
        if pulse:
            self.canvas.create_oval(
                x - 6,
                y - 4,
                x + 2,
                y + 4,
                fill="#ddeb9b" if is_rotten else "#ffd4d4",
                outline="",
            )

    def draw_coin(self, coin: dict[str, float | str | bool]) -> None:
        x = float(coin["x"])
        y = float(coin["y"])
        size = float(coin["size"])
        squash = abs(((float(coin["spin"]) % 20) - 10) / 10)
        width = max(4, size * (1 - squash * 0.65))
        self.canvas.create_oval(x - width, y - size, x + width, y + size, fill="#f7d24e", outline="#b78b1c", width=2)
        self.canvas.create_oval(x - width * 0.55, y - size * 0.5, x + width * 0.55, y + size * 0.5, outline="#b78b1c", width=2)

    def draw_projectile(self, projectile: dict[str, float | str | bool]) -> None:
        x = float(projectile["x"])
        y = float(projectile["y"])
        size = float(projectile["size"])
        fill = str(projectile.get("color", "#7ec8ff"))
        self.canvas.create_oval(x - size, y - size, x + size, y + size, fill=fill, outline="#2d78b2", width=2)
        self.canvas.create_line(x - size - 8, y, x + size, y, fill="#bfe7ff", width=3)

    def draw_decoration(self, decoration: dict[str, float | str]) -> None:
        x = float(decoration["x"])
        y = float(decoration["y"])
        kind = str(decoration["type"])

        if kind == "bonus_block":
            self.canvas.create_rectangle(x, y, x + 26, y + 26, fill="#f3c347", outline="#a36b24", width=2)
            self.canvas.create_text(x + 13, y + 13, text="?", font=("Helvetica", 12, "bold"), fill="#7b4e17")
        elif kind == "coin_ring":
            self.canvas.create_oval(x, y, x + 18, y + 24, fill="#f7d24e", outline="#b78b1c", width=2)

    def draw_special_effect(self, effect: dict[str, float | str]) -> None:
        x = float(effect["x"])
        y = float(effect["y"])
        kind = str(effect["type"])

        if kind == "bird_flock":
            for offset in (0, 18, 36):
                self.canvas.create_line(x + offset, y, x + offset + 8, y - 5, fill="#3e4954", width=2, smooth=True)
                self.canvas.create_line(x + offset + 8, y - 5, x + offset + 16, y, fill="#3e4954", width=2, smooth=True)
        elif kind == "shooting_star":
            self.canvas.create_line(x - 28, y - 8, x, y, fill="#fff1aa", width=3)
            self.canvas.create_oval(x - 4, y - 4, x + 4, y + 4, fill="#fff1aa", outline="")
        elif kind == "leaf_swirl":
            for offset in (0, 10, 20):
                self.canvas.create_oval(
                    x + offset,
                    y + (offset % 2) * 6,
                    x + offset + 8,
                    y + 10 + (offset % 2) * 6,
                    fill="#d88b47",
                    outline="",
                )

    def draw_obstacle(self, obstacle: dict[str, float | str | bool]) -> None:
        x = float(obstacle["x"])
        width = float(obstacle["width"])
        height = float(obstacle["height"])
        kind = str(obstacle["type"])
        top = float(obstacle["top"])

        if kind != "crow":
            shadow_top = min(self.ground_y - 8, top + height - 8)
            self.canvas.create_oval(
                x + 4,
                shadow_top,
                x + width - 4,
                shadow_top + 16,
                fill="#000000",
                outline="",
                stipple="gray25",
            )

        if kind == "hay":
            self.canvas.create_rectangle(x, top, x + width, self.ground_y, fill="#e9c861", outline="#ba9b40", width=2)
            self.canvas.create_line(x + 6, top + 10, x + width - 6, top + 10, fill="#c5a13e", width=2)
            self.canvas.create_line(x + 6, top + 22, x + width - 6, top + 22, fill="#c5a13e", width=2)
        elif kind == "crate":
            self.canvas.create_rectangle(x, top, x + width, self.ground_y, fill="#9b6c40", outline="#6f4928", width=2)
            self.canvas.create_line(x, top, x + width, self.ground_y, fill="#6f4928", width=2)
            self.canvas.create_line(x + width, top, x, self.ground_y, fill="#6f4928", width=2)
        elif kind == "fence":
            for post_x in (x + 8, x + 22, x + 36):
                self.canvas.create_rectangle(post_x, top, post_x + 6, self.ground_y, fill="#92623a", outline="")
            self.canvas.create_rectangle(x, top + 12, x + width, top + 18, fill="#a77549", outline="")
            self.canvas.create_rectangle(x, top + 28, x + width, top + 34, fill="#a77549", outline="")
        elif kind == "rock":
            self.canvas.create_oval(x, top, x + width, self.ground_y, fill="#85888c", outline="#686b70", width=2)
        elif kind == "barrel":
            self.canvas.create_oval(x, top, x + width, self.ground_y, fill="#8c5a34", outline="#5d3a22", width=2)
            self.canvas.create_line(x + 6, top + 10, x + width - 6, top + 10, fill="#c7a16a", width=2)
            self.canvas.create_line(x + 6, top + 28, x + width - 6, top + 28, fill="#c7a16a", width=2)
        elif kind == "stump":
            self.canvas.create_rectangle(x, top + 6, x + width, self.ground_y, fill="#8e6039", outline="#654325", width=2)
            self.canvas.create_oval(x, top, x + width, top + 14, fill="#c69a6c", outline="#654325", width=2)
        elif kind == "bush":
            self.canvas.create_oval(x, top + 8, x + width * 0.55, self.ground_y, fill="#64af54", outline="")
            self.canvas.create_oval(x + width * 0.25, top, x + width, self.ground_y, fill="#7dc66d", outline="")
        elif kind == "crate_stack":
            self.canvas.create_rectangle(x, top + 24, x + width, self.ground_y, fill="#9b6c40", outline="#6f4928", width=2)
            self.canvas.create_rectangle(x + 8, top, x + width - 8, top + 28, fill="#a97749", outline="#6f4928", width=2)
            self.canvas.create_line(x + 8, top, x + width - 8, top + 28, fill="#6f4928", width=2)
            self.canvas.create_line(x + width - 8, top, x + 8, top + 28, fill="#6f4928", width=2)
        elif kind == "hay_wagon":
            self.canvas.create_rectangle(x + 10, top + 8, x + width - 10, self.ground_y - 10, fill="#e4c05b", outline="#b28f38", width=2)
            self.canvas.create_rectangle(x + 4, self.ground_y - 18, x + width - 4, self.ground_y - 6, fill="#8a5c34", outline="#5f3e22", width=2)
            self.canvas.create_oval(x + 10, self.ground_y - 12, x + 28, self.ground_y + 8, fill="#6d4b2e", outline="#4b321d", width=2)
            self.canvas.create_oval(x + width - 28, self.ground_y - 12, x + width - 10, self.ground_y + 8, fill="#6d4b2e", outline="#4b321d", width=2)
        elif kind == "bridge":
            bridge_top = top
            self.canvas.create_rectangle(x, bridge_top, x + width, bridge_top + 14, fill="#ad8151", outline="#7a5632", width=2)
            for plank_x in range(0, int(width), 18):
                self.canvas.create_line(x + plank_x, bridge_top, x + plank_x, bridge_top + 14, fill="#7a5632", width=2)
            self.canvas.create_line(x + 8, bridge_top + 14, x + 18, self.ground_y, fill="#7a5632", width=3)
            self.canvas.create_line(x + width - 8, bridge_top + 14, x + width - 18, self.ground_y, fill="#7a5632", width=3)
            self.canvas.create_line(x + width * 0.35, bridge_top + 14, x + width * 0.33, self.ground_y, fill="#7a5632", width=3)
            self.canvas.create_line(x + width * 0.65, bridge_top + 14, x + width * 0.67, self.ground_y, fill="#7a5632", width=3)
        elif kind == "pipe":
            self.canvas.create_rectangle(x + 6, top + 10, x + width - 6, self.ground_y, fill="#3f9e3f", outline="#155d22", width=3)
            self.canvas.create_rectangle(x, top, x + width, top + 16, fill="#64d064", outline="#155d22", width=3)
        elif kind == "rolling_barrel":
            self.canvas.create_oval(x, top, x + width, top + height, fill="#8c5a34", outline="#5d3a22", width=2)
            self.canvas.create_line(x + 6, top + 12, x + width - 6, top + 12, fill="#c7a16a", width=2)
            self.canvas.create_line(x + 6, top + 28, x + width - 6, top + 28, fill="#c7a16a", width=2)
        elif kind == "jumping_crate":
            self.canvas.create_rectangle(x, top, x + width, top + height, fill="#9b6c40", outline="#6f4928", width=2)
            self.canvas.create_line(x, top, x + width, top + height, fill="#6f4928", width=2)
            self.canvas.create_line(x + width, top, x, top + height, fill="#6f4928", width=2)
            self.canvas.create_oval(x + 8, top + height + 2, x + width - 8, top + height + 8, fill="#6d8f56", outline="")
        elif kind == "brick_block":
            self.canvas.create_rectangle(x, top, x + width, top + height, fill="#c96b37", outline="#6e2f16", width=3)
            self.canvas.create_line(x, top + 18, x + width, top + 18, fill="#8a3c1d", width=3)
            self.canvas.create_line(x, top + 36, x + width, top + 36, fill="#8a3c1d", width=3)
            for brick_x in (14, 34):
                self.canvas.create_line(x + brick_x, top, x + brick_x, top + 18, fill="#8a3c1d", width=3)
            self.canvas.create_line(x + 24, top + 18, x + 24, top + height, fill="#8a3c1d", width=3)
        elif kind == "spike":
            self.canvas.create_polygon(
                x,
                self.ground_y,
                x + 10,
                top + 10,
                x + 18,
                self.ground_y,
                x + 28,
                top,
                x + 36,
                self.ground_y,
                x + width,
                top + 8,
                x + width,
                self.ground_y,
                fill="#d6d8dd",
                outline="#49515c",
                width=3,
            )
        elif kind == "mushroom":
            self.canvas.create_rectangle(x + 22, top + 18, x + 36, self.ground_y, fill="#f4e6cb", outline="#8b6239", width=2)
            self.canvas.create_oval(x, top, x + width, top + 28, fill="#da3e3e", outline="#7a1717", width=3)
            for dot_x, dot_y in ((10, 8), (26, 5), (40, 11)):
                self.canvas.create_oval(x + dot_x, top + dot_y, x + dot_x + 8, top + dot_y + 8, fill="#fff3df", outline="")
        elif kind == "piranha_pipe":
            self.canvas.create_rectangle(x + 6, top + 18, x + width - 6, self.ground_y, fill="#2f973f", outline="#0d5a21", width=3)
            self.canvas.create_rectangle(x, top + 10, x + width, top + 28, fill="#49bb54", outline="#0d5a21", width=3)
            self.canvas.create_oval(x + 12, top - 6, x + width - 12, top + 24, fill="#d33f47", outline="#7f1218", width=3)
            self.canvas.create_polygon(
                x + 18,
                top + 10,
                x + 24,
                top + 3,
                x + 30,
                top + 10,
                x + 36,
                top + 3,
                x + 42,
                top + 10,
                fill="#fff7ea",
                outline="",
            )
            self.canvas.create_oval(x + 18, top + 3, x + 24, top + 9, fill="#fff7ea", outline="")
            self.canvas.create_oval(x + width - 24, top + 3, x + width - 18, top + 9, fill="#fff7ea", outline="")
        elif kind == "crow":
            self.canvas.create_polygon(
                x, top + 14,
                x + 18, top,
                x + 34, top + 10,
                x + width, top + 16,
                x + 30, top + 20,
                x + 14, top + 24,
                fill="#3b3e44",
                outline="#23262a",
                width=2,
            )
            self.canvas.create_oval(x + 34, top + 8, x + 40, top + 14, fill="#f4e57b", outline="")

    def draw_horse(self) -> None:
        """Draw the horse near the left side with a tiny idle bob when grounded."""
        bob = 0
        if self.on_ground and not self.game_over:
            bob = 2 * ((self.frame_count // 15) % 2)

        x = self.horse_x
        ground_y = self.horse_y - bob
        alpha_fill = "#9b6338"
        alpha_outline = "#704522"

        if self.invisible_until > self.frame_count and (self.frame_count // 6) % 2 == 0:
            alpha_fill = "#c8dced"
            alpha_outline = "#8ba1b3"

        if self.power_mode:
            self.canvas.create_polygon(
                x + 122, ground_y - 84,
                x + 112, ground_y - 110,
                x + 94, ground_y - 58,
                fill="#d94040",
                outline="#9d2323",
                width=2,
            )
            self.canvas.create_line(x + 116, ground_y - 82, x + 126, ground_y - 99, fill="#9d2323", width=3)

        self.canvas.create_oval(x + 26, ground_y - 82, x + 120, ground_y - 28, fill=alpha_fill, outline=alpha_outline, width=2)
        self.canvas.create_polygon(
            x + 100, ground_y - 78,
            x + 132, ground_y - 118,
            x + 146, ground_y - 111,
            x + 118, ground_y - 62,
            fill=alpha_fill,
            outline=alpha_outline,
            width=2,
        )
        self.canvas.create_oval(x + 128, ground_y - 134, x + 180, ground_y - 88, fill=alpha_fill, outline=alpha_outline, width=2)
        self.canvas.create_polygon(
            x + 144, ground_y - 134,
            x + 149, ground_y - 154,
            x + 157, ground_y - 132,
            fill="#87552f",
            outline=alpha_outline,
        )
        self.canvas.create_polygon(
            x + 160, ground_y - 132,
            x + 165, ground_y - 151,
            x + 172, ground_y - 129,
            fill="#87552f",
            outline=alpha_outline,
        )
        self.canvas.create_line(
            x + 130, ground_y - 113,
            x + 116, ground_y - 100,
            x + 107, ground_y - 82,
            fill="#3f2512",
            width=7,
            smooth=True,
        )
        self.canvas.create_line(
            x + 34, ground_y - 60,
            x + 10, ground_y - 42,
            x + 18, ground_y - 18,
            fill="#3f2512",
            width=7,
            smooth=True,
        )
        self.canvas.create_oval(x + 166, ground_y - 114, x + 172, ground_y - 108, fill="#1c1208", outline="")
        self.canvas.create_oval(x + 174, ground_y - 102, x + 179, ground_y - 97, fill="#5d3820", outline="")

        if self.power_mode:
            self.canvas.create_rectangle(x + 134, ground_y - 130, x + 164, ground_y - 118, fill="#3452c8", outline="")
            self.canvas.create_polygon(
                x + 145, ground_y - 120,
                x + 153, ground_y - 111,
                x + 145, ground_y - 102,
                x + 137, ground_y - 111,
                fill="#ffd84d",
                outline="",
            )
            self.canvas.create_text(x + 145, ground_y - 111, text="S", font=("Helvetica", 8, "bold"), fill="#9d2323")
            self.canvas.create_line(x + 136, ground_y - 104, x + 148, ground_y - 96, fill="#3452c8", width=3)
            self.canvas.create_line(x + 154, ground_y - 104, x + 166, ground_y - 96, fill="#3452c8", width=3)

        leg_bottom = ground_y
        self.canvas.create_line(x + 46, ground_y - 28, x + 44, leg_bottom, fill="#704522", width=6)
        self.canvas.create_line(x + 68, ground_y - 28, x + 70, leg_bottom, fill="#704522", width=6)
        self.canvas.create_line(x + 94, ground_y - 28, x + 92, leg_bottom, fill="#704522", width=6)
        self.canvas.create_line(x + 114, ground_y - 28, x + 116, leg_bottom, fill="#704522", width=6)

        self.canvas.create_oval(
            x + 24, ground_y - 8, x + 122, ground_y + 10,
            fill="#7dae5f", outline=""
        )

    def draw_scene(self) -> None:
        self.canvas.delete("all")
        theme = self.get_theme()

        # Sky and distant landscape.
        self.canvas.create_rectangle(0, 0, self.width, self.height, fill=theme["sky"], outline="")
        self.canvas.create_oval(740, 38, 828, 126, fill=theme["sun"], outline="")

        for cloud in self.clouds:
            self.draw_cloud(cloud["x"], cloud["y"], cloud["size"])

        for mountain in self.mountains:
            x = mountain["x"]
            width = mountain["width"]
            height = mountain["height"]
            self.canvas.create_polygon(
                x, self.ground_y - 40,
                x + width * 0.45, self.ground_y - height,
                x + width, self.ground_y - 40,
                fill=theme["mountain"],
                outline="",
            )

        self.canvas.create_rectangle(0, self.ground_y, self.width, self.height, fill=theme["ground"], outline="")
        self.canvas.create_rectangle(0, self.ground_y + 18, self.width, self.height, fill=theme["ground_2"], outline="")

        for mark in self.ground_marks:
            self.canvas.create_rectangle(
                mark["x"],
                self.ground_y + 26,
                mark["x"] + mark["width"],
                self.ground_y + 30,
                fill=theme["grass"],
                outline="",
            )
            self.canvas.create_oval(
                mark["x"] + 6,
                self.ground_y + 4,
                mark["x"] + 12,
                self.ground_y + 12,
                fill=theme["flower"],
                outline="",
            )

        for item in self.trees:
            if item["kind"] == "tree":
                self.draw_tree(item["x"])
            else:
                self.draw_bush(item["x"])

        for decoration in self.decorations:
            self.draw_decoration(decoration)

        for effect in self.special_effects:
            self.draw_special_effect(effect)

        for obstacle in self.obstacles:
            self.draw_obstacle(obstacle)

        for pickup in self.pickups:
            self.draw_pickup(pickup)

        for coin in self.coins:
            self.draw_coin(coin)

        for projectile in self.projectiles:
            self.draw_projectile(projectile)

        self.draw_horse()

        # HUD overlay.
        active_perk, active_seconds = self.get_active_perk_status()

        self.canvas.create_rectangle(14, 14, 228, 92, fill="#fffdf6", outline="#53402d", width=3)
        self.canvas.create_text(30, 35, anchor="w", text="SCORE", font=("Helvetica", 10, "bold"), fill="#81644b")
        self.canvas.create_text(30, 63, anchor="w", text=f"{self.score}", font=("Helvetica", 24, "bold"), fill="#25170d")
        self.canvas.create_text(
            30,
            84,
            anchor="w",
            text=f"Passed: {self.passed_obstacles}   Stage: {self.difficulty_stage + 1}   Area: {self.area_stage + 1}",
            font=("Helvetica", 11),
            fill="#4f3d2c",
        )
        self.canvas.create_rectangle(244, 14, 452, 92, fill="#fff7db", outline="#5e4520", width=3)
        self.canvas.create_text(260, 35, anchor="w", text="COINS", font=("Helvetica", 10, "bold"), fill="#8a6222")
        self.canvas.create_text(260, 63, anchor="w", text=f"{self.coin_count}", font=("Helvetica", 24, "bold"), fill="#3d2a0f")
        self.canvas.create_text(338, 63, anchor="w", text=f"Jumps {self.jumps_left}", font=("Helvetica", 15, "bold"), fill="#4d3a28")
        self.canvas.create_rectangle(468, 14, 724, 92, fill="#eef7ff", outline="#214563", width=3)
        self.canvas.create_text(484, 35, anchor="w", text="ACTIVE", font=("Helvetica", 10, "bold"), fill="#36536f")
        perk_line = f"{active_perk}"
        if active_perk != "None":
            perk_line = f"{active_perk} {active_seconds}s"
        self.canvas.create_text(484, 62, anchor="w", text=perk_line, font=("Helvetica", 18, "bold"), fill="#13293d")

        if self.power_mode:
            seconds_left = max(0, self.power_timer // 60)
            self.canvas.create_text(
                484,
                84,
                anchor="w",
                text=f"Apple Power: {seconds_left}s",
                font=("Helvetica", 11, "bold"),
                fill="#b32f2f",
            )
            if self.fly_until > self.frame_count:
                self.canvas.create_text(
                    730,
                    36,
                    anchor="w",
                    text="Fly active: spam Space",
                    font=("Helvetica", 11, "bold"),
                    fill="#2d78b2",
                )
        elif self.rotten_speed_until > self.frame_count:
            rotten_seconds = max(0, (self.rotten_speed_until - self.frame_count) // 60)
            self.canvas.create_text(
                484,
                84,
                anchor="w",
                text=f"Rotten Apple: {rotten_seconds}s   Fast but vulnerable",
                font=("Helvetica", 10, "bold"),
                fill="#6f7d1a",
            )
        else:
            self.canvas.create_text(
                484,
                84,
                anchor="w",
                text="1 Fly   2 Magnet   3 Blaster",
                font=("Helvetica", 10),
                fill="#51677b",
            )

        perk_badges = [
            ("fly", "1", "FLY", "#d8f0ff", "#5aa9d6"),
            ("magnet", "2", "MAG", "#fff2cc", "#d9a327"),
            ("blaster", "3", "BLS", "#ffe1e1", "#db6767"),
        ]
        badge_y = 18
        for perk_name, hotkey, label, fill, accent in perk_badges:
            affordable = self.coin_count >= self.perk_costs[perk_name]
            is_active = active_perk.lower() == perk_name
            panel_fill = fill if affordable or is_active else "#e8e3db"
            panel_outline = accent if affordable or is_active else "#9d9489"
            self.canvas.create_rectangle(748, badge_y, 900, badge_y + 44, fill=panel_fill, outline=panel_outline, width=3)
            self.canvas.create_oval(758, badge_y + 8, 790, badge_y + 36, fill=accent, outline=panel_outline, width=2)
            self.canvas.create_text(774, badge_y + 22, text=hotkey, font=("Helvetica", 12, "bold"), fill="white")
            self.canvas.create_text(800, badge_y + 16, anchor="w", text=label, font=("Helvetica", 11, "bold"), fill="#2f241a")
            status_text = f"{self.perk_costs[perk_name]} coins"
            if is_active:
                status_text = f"ACTIVE {active_seconds}s"
            elif affordable:
                status_text = "READY"
            self.canvas.create_text(800, badge_y + 31, anchor="w", text=status_text, font=("Helvetica", 9, "bold"), fill="#5c4632")
            badge_y += 50

        if self.blaster_until > self.frame_count:
            self.canvas.create_text(
                730,
                84,
                anchor="w",
                text="Auto blaster active",
                font=("Helvetica", 11, "bold"),
                fill="#2d78b2",
            )

        if self.game_over:
            self.canvas.create_rectangle(250, 145, 670, 265, fill="#fff4ef", outline="#dbb8a8", width=3)
            self.canvas.create_text(460, 185, text="Game Over", font=("Helvetica", 28, "bold"), fill="#9d3a31")
            self.canvas.create_text(
                460,
                220,
                text="Press R or click Restart to play again",
                font=("Helvetica", 14),
                fill="#5c4330",
            )

    def game_loop(self) -> None:
        self.frame_count += 1

        if not self.game_over:
            self.update_background()
            self.update_power_mode()
            self.update_horse()
            self.update_obstacles()
            self.check_collisions()
            self.update_score()
        elif not self.name_prompt_open and not self.score_saved_this_run:
            self.root.after(100, self.prompt_for_score_name)

        self.maintain_background_music()
        self.draw_scene()
        self.root.after(16, self.game_loop)


def main() -> None:
    root = tk.Tk()
    HorseJumpGame(root)
    root.mainloop()


if __name__ == "__main__":
    main()
