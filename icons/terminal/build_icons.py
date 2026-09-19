r"""Erzeugt die Icon-Dateien der Terminal-Variante aus den SVGs in diesem Ordner.

Ziel: src/terminal/resources/{win32,darwin,linux,server} und das Workbench-Medienicon.
Werkzeuge: Inkscape (PNG-Render), Pillow (ico/icns). Ohne ImageMagick, daher bleiben
die Dateityp-Icons und Inno-Setup-Bilder aus src/stable erhalten.
Aufruf: C:\Users\Chris\.codex\tools\logo-vectorize-venv\Scripts\python.exe build_icons.py
"""
import shutil
import subprocess
from pathlib import Path

from PIL import Image

HIER = Path(__file__).parent
ROOT = HIER.parent.parent
ZIEL = ROOT / 'src' / 'terminal'
ARBEIT = HIER / 'arbeit'
INKSCAPE = r'C:\Program Files\Inkscape\bin\inkscape.com'
ARBEIT.mkdir(exist_ok=True)


def render(svg, size, png, background=None):
    args = [INKSCAPE, str(svg), '--export-type=png', f'--export-width={size}', f'--export-height={size}',
            f'--export-filename={png}']
    if background:
        args.append(f'--export-background={background}')
    subprocess.run(args, check=True, capture_output=True)
    return Image.open(png).convert('RGBA')


icon = render(HIER / 'codium-terminal-icon.svg', 1024, ARBEIT / 'icon-1024.png')
mark = render(HIER / 'codium_cnl.svg', 1024, ARBEIT / 'mark-1024.png')

# Windows: Exe-/Fenster-Icon, Kachelbilder
win32 = ZIEL / 'resources' / 'win32'
win32.mkdir(parents=True, exist_ok=True)
icon.save(win32 / 'code.ico', sizes=[(256, 256), (128, 128), (96, 96), (64, 64), (48, 48), (32, 32), (24, 24), (20, 20), (16, 16)])
for name, size, logo in (('code_70x70.png', 70, 45), ('code_150x150.png', 150, 64)):
    tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    m = mark.resize((logo, logo), Image.LANCZOS)
    tile.alpha_composite(m, ((size - logo) // 2, (size - logo) // 2))
    tile.save(win32 / name)

# macOS
darwin = ZIEL / 'resources' / 'darwin'
darwin.mkdir(parents=True, exist_ok=True)
icon.save(darwin / 'code.icns', sizes=[(1024, 1024), (512, 512), (256, 256), (128, 128), (64, 64), (32, 32), (16, 16)])

# Linux
linux = ZIEL / 'resources' / 'linux'
linux.mkdir(parents=True, exist_ok=True)
icon.resize((512, 512), Image.LANCZOS).save(linux / 'code.png')
shutil.copy(HIER / 'codium-terminal-icon.svg', linux / 'code.svg')

# Server / PWA
server = ZIEL / 'resources' / 'server'
server.mkdir(parents=True, exist_ok=True)
icon.resize((192, 192), Image.LANCZOS).save(server / 'code-192.png')
icon.resize((512, 512), Image.LANCZOS).save(server / 'code-512.png')
icon.save(server / 'favicon.ico', sizes=[(64, 64), (48, 48), (32, 32), (16, 16)])

# Workbench: Medienicon (hell) und Wasserzeichen
media = ZIEL / 'src' / 'vs' / 'workbench' / 'browser' / 'media'
media.mkdir(parents=True, exist_ok=True)
clt = (HIER / 'codium_clt.svg').read_text(encoding='utf-8').replace('width="100" height="100"', 'width="1024" height="1024"', 1)
(media / 'code-icon.svg').write_text(clt, encoding='utf-8')
letterpress = ZIEL / 'src' / 'vs' / 'workbench' / 'browser' / 'parts' / 'editor' / 'media'
letterpress.mkdir(parents=True, exist_ok=True)
for variant in ('dark', 'light', 'hcDark', 'hcLight'):
    shutil.copy(HIER / 'codium_cnl.svg', letterpress / f'letterpress-{variant}.svg')

print('written:', *sorted(str(p.relative_to(ROOT)) for p in ZIEL.rglob('*') if p.is_file() and 'extensions' not in p.parts), sep='\n  ')
