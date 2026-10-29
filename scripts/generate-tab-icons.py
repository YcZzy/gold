"""Generate transparent native tabBar PNGs: python3 scripts/generate-tab-icons.py.

Development-only dependency: Pillow. No runtime dependency in the mini program.
All geometry uses a 24-unit grid, a centered 18-unit optical box,
and a consistent 1.6-unit rounded stroke (including the avatar circle).
"""
from pathlib import Path
from math import cos, sin, pi
from PIL import Image, ImageDraw

OUTPUT = Path(__file__).resolve().parents[1] / "assets/icons/tabbar"
PALETTES = {
    "paper": {"normal": "#8a857b", "selected": "#2c2c2a"},
    "blackgold": {"normal": "#9a8f6e", "selected": "#d9b45b"},
}
SCALE = 12
STROKE = 1.6


def cubic(a, b, c, d):
    return [tuple((1-t)**3*a[j] + 3*(1-t)**2*t*b[j]
                  + 3*(1-t)*t*t*c[j] + t**3*d[j] for j in (0, 1))
            for t in (i / 32 for i in range(33))]


def render(name, color):
    image = Image.new("RGBA", (24*SCALE, 24*SCALE))
    draw = ImageDraw.Draw(image)

    def line(points):
        draw.line([(round(x*SCALE), round(y*SCALE)) for x, y in points],
                  fill=color, width=round(STROKE*SCALE), joint="curve")
        for x, y in points:
            r = STROKE / 2
            draw.ellipse(((x-r)*SCALE, (y-r)*SCALE,
                          (x+r)*SCALE, (y+r)*SCALE), fill=color)

    if name == "watchlist":
        # Rounded frame balances the closed bell and avatar forms.
        points = [(7, 3.5), (17, 3.5)]
        points += cubic((17, 3.5), (19.4, 3.5), (20.5, 4.6), (20.5, 7))
        points += [(20.5, 17)]
        points += cubic((20.5, 17), (20.5, 19.4), (19.4, 20.5), (17, 20.5))
        points += [(7, 20.5)]
        points += cubic((7, 20.5), (4.6, 20.5), (3.5, 19.4), (3.5, 17))
        points += [(3.5, 7)]
        points += cubic((3.5, 7), (3.5, 4.6), (4.6, 3.5), (7, 3.5))
        line(points)
        line([(7, 14.5), (10.3, 11), (13.5, 13), (17, 9)])
    elif name == "reminders":
        points = cubic((6, 9), (6, 1.8), (18, 1.8), (18, 9))
        points += cubic((18, 9), (18, 13), (18.4, 14.5), (19.5, 16))
        points += cubic((19.5, 16), (20, 16.7), (19.5, 17.5), (18.5, 17.5))
        points += [(5.5, 17.5)]
        points += cubic((5.5, 17.5), (4.5, 17.5), (4, 16.7), (4.5, 16))
        points += cubic((4.5, 16), (5.6, 14.5), (6, 13), (6, 9))
        line(points)
        line(cubic((10, 20), (10.8, 21.2), (13.2, 21.2), (14, 20)))
    else:
        # Use a centerline circle: Pillow's ellipse outline is inset and
        # previously made the head visibly lighter than the shoulder stroke.
        line([(12 + 3.6*cos(i*2*pi/96), 7.5 + 3.6*sin(i*2*pi/96))
              for i in range(97)])
        points = [(4.5, 20.5), (4.5, 19)]
        points += cubic((4.5, 19), (4.5, 12.6), (19.5, 12.6), (19.5, 19))
        points += [(19.5, 20.5)]
        line(points)
    # Add equal breathing room around every glyph inside the native icon slot.
    glyph = image.resize((63, 63), Image.Resampling.LANCZOS)
    output = Image.new("RGBA", (72, 72))
    output.paste(glyph, (4, 4))
    return output


if __name__ == "__main__":
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for theme, states in PALETTES.items():
        for state, color in states.items():
            for name in ("watchlist", "reminders", "mine"):
                render(name, color).save(OUTPUT / f"{name}-{theme}-{state}.png", optimize=True)
