"""Slate mark: K5 on a golden slab, gray's K6 sibling.

A φ:1 rectangle with one corner cut at 45° by 1/φ² of the short side;
every corner joins every other. Same band width and scale as gray
(assets/logo-dark.svg). Run: python3 slate-logo.py
"""
import math
from itertools import combinations
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union

PHI = (1 + 5**0.5) / 2
GRAY_W, BAND, SCALE = 146.69458, 5.893, 5.46  # gray's local width, band, scale
W, H = GRAY_W, GRAY_W / PHI
c = H / PHI**2
P = [(c, 0), (W, 0), (W, H), (0, H), (0, c)]
TX, TY = 485 - GRAY_W * SCALE / 2, 485 - H * SCALE / 2

hull = Polygon(P)
n = len(P)
bands = []
for i, j in combinations(range(n), 2):
    side = (j - i) % n in (1, n - 1)
    (x1, y1), (x2, y2) = P[i], P[j]
    L = math.dist(P[i], P[j])
    ex, ey = (x2 - x1) / L * 20, (y2 - y1) / L * 20
    seg = LineString([(x1 - ex, y1 - ey), (x2 + ex, y2 + ey)])
    bands.append(seg.buffer(BAND if side else BAND / 2, cap_style="flat"))
mark = hull.intersection(unary_union(bands))
assert mark.geom_type == "Polygon", mark


def d(rings, f=lambda p: p):
    return " ".join("M " + " ".join(f"{x:.3f},{y:.3f}" for x, y in map(f, r.coords[:-1])) + " Z"
                    for r in rings)


mark_d = d([mark.exterior, *mark.interiors])
mark_path = f'<path fill="#ffffff" fill-rule="evenodd" transform="translate({TX:.2f} {TY:.2f}) scale({SCALE})" d="{mark_d}" />'
px = lambda p: (TX + p[0] * SCALE, TY + p[1] * SCALE)

open("slate-logo.svg", "w").write(f"""<svg xmlns="http://www.w3.org/2000/svg" width="970" height="970" viewBox="0 0 970 970">
  <rect width="970" height="970" rx="160" fill="#000000" />
  {mark_path}
</svg>
""")

# Animated: arrangement faces open from their most central corner, as gray's do.
lines = [LineString([P[i], P[j]]) for i, j in combinations(range(n), 2)]
faces = list(polygonize(unary_union(lines)))
mid = px((W / 2, H / 2))
items = []
for f in faces:
    pts = [px(p) for p in f.exterior.coords[:-1]]
    o = min(pts, key=lambda p: math.dist(p, mid))
    rel = " L ".join(f"{x - o[0]:.2f} {y - o[1]:.2f}" for x, y in pts)
    items.append((math.dist(o, mid), o, rel))
items.sort()
rows = "\n".join(
    f'        <g transform="translate({o[0]:.2f} {o[1]:.2f})"><path class="line" fill="#000000" '
    f'style="animation-delay:{0.1 + k * 0.0354:.3f}s" d="M {rel} Z" /></g>'
    for k, (_, o, rel) in enumerate(items))
outline = " L ".join(f"{x:.2f} {y:.2f}" for x, y in map(px, P))
open("slate-logo-animated-lines.svg", "w").write(f"""<svg xmlns="http://www.w3.org/2000/svg" width="970" height="970" viewBox="0 0 970 970">
  <title>slate mark lines, growing out from the centre</title>
  <defs>
    <mask id="lines" maskUnits="userSpaceOnUse" x="0" y="0" width="970" height="970">
      <rect width="970" height="970" fill="#ffffff" />
      <g>
{rows}
      </g>
      {mark_path}
    </mask>
  </defs>
  <path fill="#ffffff" mask="url(#lines)" d="M {outline} Z" />
  <style>
    .line {{ transform-origin: 0 0; animation: line-grow 0.42s cubic-bezier(0.34, 1.25, 0.5, 1.0) both; }}
    @keyframes line-grow {{ from {{ transform: scale(0); }} }}
    @media (prefers-reduced-motion: reduce) {{
      .line {{ animation: none; }}
    }}
  </style>
</svg>
""")
