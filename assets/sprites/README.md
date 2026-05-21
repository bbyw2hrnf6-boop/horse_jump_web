# Sprite Assets

The game now uses individual transparent PNGs from these folders:

- `bosses/`: Crab, Biber, Alien, Dinosaur, and Bigfoot.
- `obstacles/`: hay, crate, barrel, bush, fence, log, hurdle, mailbox, farmer, tractor, spikes, sheep, scarecrow, rooster, wagon, windmill, and cow.

The current uploaded sheets live at `assets/newbosses.png` and `assets/newobstacles.png`. The script falls back to `assets/image2.png` and `assets/image.png` for the older sheets if needed. Run `python3 tools/split_sprite_assets.py` after replacing those sheets to regenerate all individual sprites.
