r"""Erzeugt aus codium-terminal-quelle.png die Vektormarke der Terminal-Variante.

Ablauf wie in gisrede-webseite/assets-originals/brand/produktlogos/skripte/symbol_varianten.py:
blaue Koralle freistellen, VTracer-Splinekontur, Farbverlauf per RGB-Ebenenfit aus der Vorlage.

Ausgabe:
  codium_cnl.svg            Marke ohne Hintergrund (Verlauf), fuer build_icons.sh
  codium_clt.svg            Marke einfarbig hell (Workbench-Medienicon)
  codium-terminal-icon.svg  App-Icon: weisses abgerundetes Quadrat plus Marke, 1024 x 1024
Aufruf: C:\Users\Chris\.codex\tools\logo-vectorize-venv\Scripts\python.exe vectorize.py
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import vtracer
from PIL import Image
from scipy import ndimage

NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)
HIER = Path(__file__).parent
ARBEIT = HIER / 'arbeit'
ARBEIT.mkdir(exist_ok=True)


def freistellen(quelle):
    bild = np.asarray(Image.open(quelle).convert('RGB')).astype(int)
    blau = bild[..., 2] - bild[..., 0] > 40
    labels, n = ndimage.label(blau)
    groessen = ndimage.sum(blau, labels, range(1, n + 1))
    symbol = np.zeros_like(blau)
    for i, groesse in enumerate(groessen, 1):
        if groesse > 200:
            symbol |= labels == i
    assert symbol.sum() > 20000, symbol.sum()
    glatt = ndimage.gaussian_filter(symbol.astype(float), .8) > .5
    Image.fromarray(np.where(glatt, 0, 255).astype('uint8')).save(ARBEIT / 'silhouette.png')
    vtracer.convert_image_to_svg_py(
        str(ARBEIT / 'silhouette.png'), str(ARBEIT / 'konturen.svg'),
        colormode='binary', mode='spline', filter_speckle=4,
        corner_threshold=60, length_threshold=4.0, splice_threshold=45, path_precision=3)
    konturen = list(ET.parse(ARBEIT / 'konturen.svg').getroot())
    for el in konturen:
        el.attrib.pop('fill', None)
        verschiebung = el.attrib.pop('transform', '')
        if verschiebung:
            assert verschiebung.startswith('translate(')
            dx, dy = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', verschiebung)]
            d = el.get('d')
            assert set(re.findall('[A-Za-z]', d)) <= set('MLCZ')
            zahlen = iter([dx, dy] * (len(re.findall(r'-?\d+(?:\.\d+)?', d)) // 2))
            el.set('d', re.sub(r'-?\d+(?:\.\d+)?', lambda m: f'{float(m[0]) + next(zahlen):.3f}', d))
    return bild, symbol, konturen


def farbverlauf(bild, maske, name, defs):
    yy, xx = np.nonzero(ndimage.binary_erosion(maske, iterations=3))
    rgb = bild[yy, xx].astype(float)
    xy = np.column_stack((xx, yy)).astype(float)
    mitte = xy.mean(0)
    fit = np.linalg.lstsq(np.column_stack((xy - mitte, np.ones(len(xx)))), rgb, rcond=None)[0]
    richtung = np.linalg.svd(fit[:2], full_matrices=False)[0][:, 0]
    if richtung[0] < 0:
        richtung *= -1
    t = (xy - mitte) @ richtung
    lo, hi = float(t.min()), float(t.max())
    proben = np.linspace(lo, hi, 12)
    breite = (hi - lo) / 12
    farben = np.asarray([np.median(rgb[np.abs(t - z) < breite], axis=0) for z in proben])
    farben[1:-1] = (farben[:-2] + 2 * farben[1:-1] + farben[2:]) / 4
    vorher = np.column_stack([np.interp(t, proben, farben[:, k]) for k in range(3)])
    rmse = float(np.sqrt(np.mean((vorher - rgb) ** 2)))
    start, ende = mitte + richtung * lo, mitte + richtung * hi
    grad = ET.SubElement(defs, f'{{{NS}}}linearGradient', id=name, gradientUnits='userSpaceOnUse',
                         x1=f'{start[0]:.3f}', y1=f'{start[1]:.3f}', x2=f'{ende[0]:.3f}', y2=f'{ende[1]:.3f}')
    for off, c in zip(np.linspace(0, 1, len(farben)), farben):
        farbe = '#' + ''.join(f'{int(v):02x}' for v in np.clip(np.round(c), 0, 255))
        ET.SubElement(grad, f'{{{NS}}}stop', offset=f'{off:.4f}', **{'stop-color': farbe})
    return rmse


def marke_svg(konturen, box, fuellung, defs_fn=None):
    x0, y0, x1, y1 = box
    svg = ET.Element(f'{{{NS}}}svg', width='100', height='100',
                     viewBox=f'{x0:.0f} {y0:.0f} {x1 - x0:.0f} {y1 - y0:.0f}')
    defs = ET.SubElement(svg, f'{{{NS}}}defs')
    if defs_fn:
        defs_fn(defs)
    g = ET.SubElement(svg, f'{{{NS}}}g', fill=fuellung, **{'fill-rule': 'evenodd'})
    for el in konturen:
        ET.SubElement(g, f'{{{NS}}}path', d=el.get('d'))
    return svg


def schreiben(svg, ziel):
    ET.indent(svg, space=' ')
    ziel.write_bytes(ET.tostring(svg, xml_declaration=True, encoding='utf-8'))


bild, symbol, konturen = freistellen(HIER / 'codium-terminal-quelle.png')
yy, xx = np.nonzero(symbol)
rand = 0.06 * max(np.ptp(xx), np.ptp(yy))
box = (xx.min() - rand, yy.min() - rand, xx.max() + rand, yy.max() + rand)
seite = max(box[2] - box[0], box[3] - box[1])
cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
box = (cx - seite / 2, cy - seite / 2, cx + seite / 2, cy + seite / 2)

rmse = [0.0]
schreiben(marke_svg(konturen, box, 'url(#verlauf)', lambda d: rmse.__setitem__(0, farbverlauf(bild, symbol, 'verlauf', d))),
          HIER / 'codium_cnl.svg')
schreiben(marke_svg(konturen, box, '#ffffff'), HIER / 'codium_clt.svg')

# App-Icon: 1024er Flaeche, weisses abgerundetes Quadrat (Radius 22 %), Marke auf 62 % Breite
icon = ET.Element(f'{{{NS}}}svg', width='1024', height='1024', viewBox='0 0 1024 1024')
defs = ET.SubElement(icon, f'{{{NS}}}defs')
farbverlauf(bild, symbol, 'verlauf', defs)
platte = ET.SubElement(defs, f'{{{NS}}}linearGradient', id='platte', x1='0', y1='0', x2='0', y2='1')
ET.SubElement(platte, f'{{{NS}}}stop', offset='0', **{'stop-color': '#ffffff'})
ET.SubElement(platte, f'{{{NS}}}stop', offset='1', **{'stop-color': '#f2f3f5'})
ET.SubElement(icon, f'{{{NS}}}rect', x='64', y='64', width='896', height='896', rx='200', fill='url(#platte)')
ET.SubElement(icon, f'{{{NS}}}rect', x='64', y='64', width='896', height='896', rx='200', fill='none',
              stroke='#c9ccd1', **{'stroke-width': '4'})
skala = 0.62 * 896 / seite
g = ET.SubElement(icon, f'{{{NS}}}g', fill='url(#verlauf)', **{'fill-rule': 'evenodd'},
                  transform=f'translate({512 - cx * skala:.3f} {512 - cy * skala:.3f}) scale({skala:.5f})')
for el in konturen:
    ET.SubElement(g, f'{{{NS}}}path', d=el.get('d'))
schreiben(icon, HIER / 'codium-terminal-icon.svg')
print(f'konturen={len(konturen)} box={tuple(round(v) for v in box)} verlauf-rmse={rmse[0]:.2f}')
