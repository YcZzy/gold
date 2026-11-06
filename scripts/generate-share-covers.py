"""Generate text-and-shape share covers from SVG (requires rsvg-convert)."""
from pathlib import Path
import subprocess

OUTPUT = Path(__file__).resolve().parents[1] / "assets/share"
TITLES = {"watchlist": "My List", "quote": "Details", "reminders": "Reminders"}
PALETTES = {
    "blackgold": ("#14120b", "#211d12", "#51452b", "#f2e6c9", "#d9b45b"),
    "paper": ("#f4f1ea", "#faf8f3", "#d8d1c1", "#2c2c2a", "#8d713b"),
}

for theme, (background, surface, border, text, accent) in PALETTES.items():
    for kind, title in TITLES.items():
        name = kind + ("-paper" if theme == "paper" else "")
        rows = "".join(
            f'<circle cx="60" cy="{y}" r="4" fill="{accent}"/>'
            f'<rect x="82" y="{y-4}" width="{width}" height="8" rx="4" fill="{border}"/>'
            f'<rect x="448" y="{y-4}" width="86" height="8" rx="4" fill="{accent}" opacity="{opacity}"/>'
            f'<path d="M54 {y+28}H546" stroke="{border}"/>'
            for y, width, opacity in [(240, 128, 1), (298, 172, .7), (356, 148, .5)]
        )
        svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="600" height="480" viewBox="0 0 600 480">
<rect width="600" height="480" fill="{background}"/>
<rect x="29" y="29" width="542" height="422" rx="26" fill="{surface}" stroke="{border}"/>
<g font-family="Arial, sans-serif">
<path d="M60 64L66 70L60 76L54 70Z" stroke="{accent}" fill="none"/>
<text x="82" y="77" font-size="15" fill="{accent}">FOLLOW &amp; REMIND</text>
<text x="54" y="158" font-size="58" fill="{text}">{title}</text>
<path d="M54 193H546" stroke="{border}"/>
{rows}
<text x="54" y="423" font-size="12" fill="{accent}">MY LIST / ORGANIZE / REMINDERS</text>
</g></svg>'''
        source = OUTPUT / (name + ".svg")
        source.write_text(svg)
        subprocess.run(["rsvg-convert", str(source), "-o", str(OUTPUT / (name + ".png"))], check=True)
