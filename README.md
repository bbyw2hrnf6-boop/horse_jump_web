# Horse Jump Web

Browser-playable endless runner built with static HTML, CSS, and JavaScript.

## Current Features

- Canvas-based horse jumping gameplay
- Fixed-step game loop for steadier speed on Safari iPhone and desktop Chrome
- Coins, apples, rotten apples, Friday meat boost, and purchasable perks
- Carrot Blaster perk that shoots carrots at obstacles
- Firebase leaderboard support with local storage fallback
- Responsive layout for desktop and mobile play

## Run Locally

From this folder:

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173/`.

## Commit Notes

This project is static and has no build step. Before committing, open the page in a browser and confirm the game starts, jumps, and the leaderboard panel loads or falls back locally.
