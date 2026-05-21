"""Split the provided boss and obstacle sheets into transparent game sprites."""

from collections import deque
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "assets"
SPRITE_DIR = ASSET_DIR / "sprites"

NEW_BOSS_SOURCE = ASSET_DIR / "newbosses.png"
BOSS_SOURCE = NEW_BOSS_SOURCE if NEW_BOSS_SOURCE.exists() else ASSET_DIR / "image2.png"
NEW_OBSTACLE_SOURCE = ASSET_DIR / "newobstacles.png"
OBSTACLE_SOURCE = NEW_OBSTACLE_SOURCE if NEW_OBSTACLE_SOURCE.exists() else ASSET_DIR / "image.png"

BOSS_CROPS_CLASSIC = {
    "crab": (15, 185, 500, 545),
    "biber": (500, 205, 910, 545),
    "alien": (900, 190, 1390, 550),
    "dinosaur": (35, 630, 685, 1035),
    "bigfoot": (715, 635, 1370, 1035),
}

BOSS_CROPS_HD = {
    "crab": (45, 55, 560, 420),
    "biber": (910, 55, 1465, 410),
    "alien": (515, 255, 1015, 640),
    "dinosaur": (50, 515, 665, 940),
    "bigfoot": (895, 520, 1455, 935),
}

BOSS_CROPS = BOSS_CROPS_HD if BOSS_SOURCE == NEW_BOSS_SOURCE else BOSS_CROPS_CLASSIC

OBSTACLE_CROPS_CLASSIC = {
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

OBSTACLE_CROPS_HD = {
    "hay": (30, 160, 255, 385),
    "crate": (262, 165, 445, 382),
    "barrel": (458, 155, 610, 382),
    "bush": (612, 165, 815, 380),
    "fence": (815, 180, 1025, 365),
    "log": (1020, 185, 1215, 365),
    "hurdle": (1228, 178, 1402, 365),
    "mailbox": (1405, 165, 1538, 375),
    "farmer": (1530, 125, 1684, 382),
    "tractor": (20, 458, 286, 714),
    "spike": (296, 548, 460, 712),
    "sheep": (462, 486, 660, 714),
    "scarecrow": (662, 422, 822, 715),
    "rooster": (824, 462, 1008, 715),
    "wagon": (1020, 486, 1242, 715),
    "windmill": (1270, 420, 1430, 715),
    "cow": (1436, 486, 1680, 715),
}

OBSTACLE_CROPS = OBSTACLE_CROPS_HD if OBSTACLE_SOURCE == NEW_OBSTACLE_SOURCE else OBSTACLE_CROPS_CLASSIC


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


def keep_largest_component(image):
    """Keep the main cutout and remove unrelated pieces from nearby sprites."""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()
    seen = set()
    components = []

    for y in range(height):
        for x in range(width):
            if (x, y) in seen or pixels[x, y][3] == 0:
                continue
            queue = deque([(x, y)])
            seen.add((x, y))
            component = []
            while queue:
                px, py = queue.popleft()
                component.append((px, py))
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in seen and pixels[nx, ny][3] > 0:
                        seen.add((nx, ny))
                        queue.append((nx, ny))
            components.append(component)

    if not components:
        return rgba

    keep = set(max(components, key=len))
    for y in range(height):
        for x in range(width):
            if pixels[x, y][3] > 0 and (x, y) not in keep:
                r, g, b, _ = pixels[x, y]
                pixels[x, y] = (r, g, b, 0)
    return rgba


def split_sheet(source_path, crop_map, output_dir, isolate_main=False):
    source = Image.open(source_path).convert("RGBA")
    output_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for name, box in crop_map.items():
        sprite = source.crop(box)
        sprite = remove_connected_backdrop(sprite)
        if isolate_main:
            sprite = keep_largest_component(sprite)
        sprite = trim_transparent(sprite)
        output_path = output_dir / f"{name}.png"
        sprite.save(output_path, optimize=True)
        written.append(output_path)
    return written


def main():
    if not BOSS_SOURCE.exists() or not OBSTACLE_SOURCE.exists():
        raise SystemExit("Expected a boss sheet and assets/image.png to exist.")
    written = []
    written += split_sheet(BOSS_SOURCE, BOSS_CROPS, SPRITE_DIR / "bosses", isolate_main=True)
    written += split_sheet(OBSTACLE_SOURCE, OBSTACLE_CROPS, SPRITE_DIR / "obstacles")
    for path in written:
        print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
