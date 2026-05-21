"""Split the provided boss and obstacle sheets into transparent game sprites."""

from collections import deque
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "assets"
SPRITE_DIR = ASSET_DIR / "sprites"

BOSS_SOURCE = ASSET_DIR / "image2.png"
OBSTACLE_SOURCE = ASSET_DIR / "image.png"

BOSS_CROPS = {
    "crab": (15, 185, 500, 545),
    "biber": (500, 205, 910, 545),
    "alien": (900, 190, 1390, 550),
    "dinosaur": (35, 630, 685, 1035),
    "bigfoot": (715, 635, 1370, 1035),
}

OBSTACLE_CROPS = {
    "hay": (15, 200, 232, 382),
    "crate": (240, 195, 410, 382),
    "barrel": (432, 185, 580, 384),
    "bush": (605, 198, 742, 382),
    "fence": (775, 220, 982, 382),
    "log": (992, 226, 1215, 382),
    "hurdle": (1215, 210, 1438, 382),
    "mailbox": (1410, 198, 1540, 382),
    "farmer": (1540, 145, 1748, 382),
    "tractor": (10, 492, 282, 700),
    "spike": (292, 572, 452, 700),
    "sheep": (470, 510, 658, 700),
    "scarecrow": (670, 468, 824, 700),
    "rooster": (856, 500, 1002, 700),
    "wagon": (1020, 520, 1294, 700),
    "windmill": (1315, 435, 1518, 700),
    "cow": (1508, 515, 1742, 700),
}


def color_distance(a, b):
    return sum(abs(int(a[i]) - int(b[i])) for i in range(3))


def average_corner_color(image):
    width, height = image.size
    samples = []
    for x in (0, min(8, width - 1), max(0, width - 9), width - 1):
        for y in (0, min(8, height - 1), max(0, height - 9), height - 1):
            samples.append(image.getpixel((x, y)))
    return tuple(sum(pixel[i] for pixel in samples) // len(samples) for i in range(3))


def remove_connected_backdrop(image, tolerance=68):
    """Remove only the dark sheet backdrop connected to the crop edges."""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()
    background = average_corner_color(rgba)
    queue = deque()
    seen = set()

    def should_remove(x, y):
        pixel = pixels[x, y]
        return pixel[3] == 0 or color_distance(pixel, background) <= tolerance

    for x in range(width):
        for y in (0, height - 1):
            if should_remove(x, y):
                queue.append((x, y))
                seen.add((x, y))
    for y in range(height):
        for x in (0, width - 1):
            if (x, y) not in seen and should_remove(x, y):
                queue.append((x, y))
                seen.add((x, y))

    while queue:
        x, y = queue.popleft()
        r, g, b, _ = pixels[x, y]
        pixels[x, y] = (r, g, b, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in seen and should_remove(nx, ny):
                seen.add((nx, ny))
                queue.append((nx, ny))

    return rgba


def trim_transparent(image, padding=8):
    alpha_box = image.getchannel("A").getbbox()
    if not alpha_box:
        return image
    left, top, right, bottom = alpha_box
    left = max(0, left - padding)
    top = max(0, top - padding)
    right = min(image.width, right + padding)
    bottom = min(image.height, bottom + padding)
    return image.crop((left, top, right, bottom))


def split_sheet(source_path, crop_map, output_dir):
    source = Image.open(source_path).convert("RGBA")
    output_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for name, box in crop_map.items():
        sprite = source.crop(box)
        sprite = remove_connected_backdrop(sprite)
        sprite = trim_transparent(sprite)
        output_path = output_dir / f"{name}.png"
        sprite.save(output_path, optimize=True)
        written.append(output_path)
    return written


def main():
    if not BOSS_SOURCE.exists() or not OBSTACLE_SOURCE.exists():
        raise SystemExit("Expected assets/image2.png and assets/image.png to exist.")
    written = []
    written += split_sheet(BOSS_SOURCE, BOSS_CROPS, SPRITE_DIR / "bosses")
    written += split_sheet(OBSTACLE_SOURCE, OBSTACLE_CROPS, SPRITE_DIR / "obstacles")
    for path in written:
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
