"""The land: height function, quilt cells, pillowed mesh, colour image, seam stitch points."""
import hashlib
import inspect
import os
import struct
import zlib

import numpy as np

import palette

# Mesh grid: one object, x -22 to 22, y -10 to 18.
X0, X1, Y0, Y1 = -22.0, 22.0, -10.0, 18.0
NX, NY = 1100, 700

# The colour image covers a smaller window than the mesh.
IMG_X0, IMG_X1, IMG_Y0, IMG_Y1 = -16.0, 16.0, -5.5, 18.5
IMG_W, IMG_H = 6144, 4608

ROT_DEG = 11.0
CELL_U, CELL_V = 3.4, 2.7
WARP_AMP = 0.25
WARP_FU, WARP_PU = 0.33, 1.1
WARP_FV, WARP_PV = 0.29, 0.4
PILLOW_H = 0.09
PILLOW_W = 0.45

CELL_I = (-18, 18)
CELL_J = (-20, 20)

# Flat pads under buildings and props: (x, y, z, radius). Registered before the mesh is built.
PADS = []
PAD_BLEND = 0.9
# Small pressed dents in the quilt where a stitch goes in: (x, y).
DIMPLES = []
DIMPLE_DEPTH = 0.08
DIMPLE_RADIUS = 0.15


def _smooth(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def h_base(x, y):
    """Ground height before pads: flat across the town band, a low rise behind it and two rear mounds."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    swell = (0.45 * np.sin(0.42 * x + 0.9) * np.cos(0.31 * y - 0.4)
             + 0.33 * np.sin(0.23 * x - 0.7 * y + 2.0)
             + 0.22 * np.sin(0.67 * x + 0.15 * y + 0.3))
    flat = 1.0 - 0.85 * np.exp(-(np.abs(y - 1.8) / 7.0) ** 6)
    rise = 1.2 * _smooth(9.0, 16.0, y) * (1.0 - _smooth(19.0, 32.0, y))
    left = 2.4 * np.exp(-(((x + 8.0) / 6.0) ** 2 + ((y - 15.5) / 4.2) ** 2))
    right = 2.0 * np.exp(-(((x - 7.5) / 6.0) ** 2 + ((y - 14.5) / 4.0) ** 2))
    return 0.35 * swell * flat + rise + left + right


def add_pad(x, y, radius):
    """Level the ground under a building at the height it had at its centre. Returns that height."""
    z = float(h_base(x, y))
    PADS.append((float(x), float(y), z, float(radius)))
    return z


def add_dimple(x, y):
    """Press a small dent into the quilt where a stitch goes in."""
    DIMPLES.append((float(x), float(y)))


def h(x, y):
    """Ground height used for placement and for the mesh: base shape with the flat pads laid in."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    z = h_base(x, y)
    for px, py, pz, pr in PADS:
        w = 1.0 - _smooth(pr, pr + PAD_BLEND, np.hypot(x - px, y - py))
        z = z + w * (pz - z)
    return z


def _warp(x, y):
    th = np.radians(ROT_DEG)
    c, s = np.cos(th), np.sin(th)
    xr = x * c - y * s
    yr = x * s + y * c
    u = xr + WARP_AMP * np.sin(WARP_FU * yr + WARP_PU)
    v = yr + WARP_AMP * np.sin(WARP_FV * xr + WARP_PV)
    return u, v


def _unwarp(u, v):
    xr, yr = u, v
    for _ in range(12):
        xr = u - WARP_AMP * np.sin(WARP_FU * yr + WARP_PU)
        yr = v - WARP_AMP * np.sin(WARP_FV * xr + WARP_PV)
    th = np.radians(ROT_DEG)
    c, s = np.cos(th), np.sin(th)
    return xr * c + yr * s, -xr * s + yr * c


def _cell_and_edge(x, y):
    """Cell index (i, j) and distance to the nearest cell edge in world units."""
    u, v = _warp(x, y)
    fu = u / CELL_U
    fv = v / CELL_V
    i = np.floor(fu)
    j = np.floor(fv)
    du = np.minimum(fu - i, 1.0 - (fu - i)) * CELL_U
    dv = np.minimum(fv - j, 1.0 - (fv - j)) * CELL_V
    return i.astype(np.int64), j.astype(np.int64), np.minimum(du, dv)


def pillow(d):
    return PILLOW_H * (1.0 - np.exp(-((d / PILLOW_W) ** 2)))


def surface(x, y):
    """Ground height with the pillowed patches on top of the base shape."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    _, _, d = _cell_and_edge(x, y)
    z = h(x, y) + pillow(d) * (1.0 - _smooth(15.0, 18.0, y))
    for dx, dy in DIMPLES:
        z = z - DIMPLE_DEPTH * np.exp(-((x - dx) ** 2 + (y - dy) ** 2) / DIMPLE_RADIUS ** 2)
    return z


def surface_normal(x, y, eps=0.03):
    zx = (surface(x + eps, y) - surface(x - eps, y)) / (2 * eps)
    zy = (surface(x, y + eps) - surface(x, y - eps)) / (2 * eps)
    n = np.stack([-zx, -zy, np.ones_like(zx)], axis=-1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


_TABLE = None


def _generate_table():
    names = list(palette.QUILT.keys())
    weights = np.array([palette.QUILT_WEIGHTS[n] for n in names], dtype=np.float64)
    rng = np.random.default_rng([palette.SEED, 1])
    ni = CELL_I[1] - CELL_I[0] + 1
    nj = CELL_J[1] - CELL_J[0] + 1
    table = -np.ones((ni, nj), dtype=np.int64)
    for j in range(nj):
        for i in range(ni):
            probs = weights.copy()
            for di, dj in ((-1, 0), (-1, -1), (0, -1), (1, -1)):
                ii, jj = i + di, j + dj
                if 0 <= ii < ni and 0 <= jj < nj:
                    probs[table[ii, jj]] = 0.0
            probs /= probs.sum()
            table[i, j] = rng.choice(len(names), p=probs)
    return table


def _cell_table():
    global _TABLE
    if _TABLE is None:
        _TABLE = _generate_table()
    return _TABLE


_NEIGHBOURS = [(di, dj) for di in (-1, 0, 1) for dj in (-1, 0, 1) if (di, dj) != (0, 0)]


def _cells_under(points_xy):
    px = np.asarray([p[0] for p in points_xy], dtype=np.float64)
    py = np.asarray([p[1] for p in points_xy], dtype=np.float64)
    i, j, _ = _cell_and_edge(px, py)
    return sorted(set(zip((i - CELL_I[0]).tolist(), (j - CELL_J[0]).tolist())))


def _neighbour_colours(table, i, j):
    out = set()
    for di, dj in _NEIGHBOURS:
        ii, jj = i + di, j + dj
        if 0 <= ii < table.shape[0] and 0 <= jj < table.shape[1]:
            out.add(int(table[ii, jj]))
    return out


def constrain_cells(avoid_points, forbidden=("peach",), forced=()):
    """Quilt colour rules for the story.

    Patches under `avoid_points` never take a forbidden colour. Each (x, y, colour name) in `forced` fixes
    the patch under that point. Touching patches stay different: a clashing neighbour is recoloured.
    """
    table = _cell_table()
    names = list(palette.QUILT.keys())
    bad = {names.index(n) for n in forbidden}
    rng = np.random.default_rng([palette.SEED, 5])
    avoid_cells = set(_cells_under(avoid_points))
    locked = set()
    for x, y, colour in forced:
        cell = _cells_under([(x, y)])[0]
        table[cell] = names.index(colour)
        locked.add(cell)
    for cell in sorted(avoid_cells - locked):
        if int(table[cell]) in bad:
            options = [k for k in range(len(names)) if k not in bad and k not in _neighbour_colours(table, *cell)]
            options = options or [k for k in range(len(names)) if k not in bad]
            table[cell] = int(rng.choice(options))
    for _ in range(60):
        changed = False
        for i in range(table.shape[0]):
            for j in range(table.shape[1]):
                same = [(i + di, j + dj) for di, dj in _NEIGHBOURS
                        if 0 <= i + di < table.shape[0] and 0 <= j + dj < table.shape[1]
                        and table[i + di, j + dj] == table[i, j]]
                if not same:
                    continue
                movable = [cell for cell in [(i, j)] + same if cell not in locked]
                if not movable:
                    continue
                cell = movable[0] if movable[0] not in avoid_cells else movable[-1]
                ban = bad if cell in avoid_cells else set()
                options = [k for k in range(len(names)) if k not in _neighbour_colours(table, *cell) and k not in ban]
                if options:
                    table[cell] = int(rng.choice(options))
                    changed = True
        if not changed:
            break
    return table


def cell_colour_index(x, y):
    i, j, _ = _cell_and_edge(x, y)
    i = np.clip(i - CELL_I[0], 0, CELL_I[1] - CELL_I[0])
    j = np.clip(j - CELL_J[0], 0, CELL_J[1] - CELL_J[0])
    return _cell_table()[i, j]


def _png_chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def _cache_key():
    parts = [inspect.getsource(f) for f in (_warp, _cell_and_edge, cell_colour_index, build_color_image)]
    parts.append(hashlib.md5(_cell_table().tobytes()).hexdigest())
    parts.append(repr((IMG_X0, IMG_X1, IMG_Y0, IMG_Y1, IMG_W, IMG_H, ROT_DEG, CELL_U, CELL_V, WARP_AMP,
                       palette.QUILT, palette.QUILT_WEIGHTS, palette.SEED)))
    return hashlib.md5("".join(parts).encode()).hexdigest()[:10]


def build_color_image(path):
    """Write the 6144 by 4608 quilt colour map as an 8-bit PNG: patch colour, speckle, dark flecks."""
    names = list(palette.QUILT.keys())
    lut = np.array([[round(c * 255) for c in palette.hex_to_rgb(palette.QUILT[n])] for n in names], dtype=np.float32)
    rng = np.random.default_rng([palette.SEED, 2])
    comp = zlib.compressobj(2)
    idat = []
    rows_per = 128
    xs = IMG_X0 + (np.arange(IMG_W) + 0.5) / IMG_W * (IMG_X1 - IMG_X0)
    for r0 in range(0, IMG_H, rows_per):
        r1 = min(IMG_H, r0 + rows_per)
        n = r1 - r0
        ys = IMG_Y1 - (np.arange(r0, r1) + 0.5) / IMG_H * (IMG_Y1 - IMG_Y0)
        X, Y = np.meshgrid(xs, ys)
        idx = cell_colour_index(X, Y)
        rgb = lut[idx]
        fine = rng.normal(0.0, 0.022, size=(n, IMG_W)).astype(np.float32)
        coarse = rng.normal(0.0, 0.020, size=(n // 3 + 1, IMG_W // 3 + 1)).astype(np.float32)
        coarse = np.repeat(np.repeat(coarse, 3, axis=0), 3, axis=1)[:n, :IMG_W]
        lum = 1.0 + fine + coarse
        nfleck = int(n * IMG_W * 0.00045)
        fy = rng.integers(0, n, nfleck)
        fx = rng.integers(0, IMG_W, nfleck)
        ang = rng.uniform(0, np.pi, nfleck)
        length = rng.integers(3, 9, nfleck)
        dark = rng.uniform(0.10, 0.22, nfleck).astype(np.float32)
        for t in range(8):
            live = t < length
            px = np.clip((fx + np.cos(ang) * t).astype(np.int64), 0, IMG_W - 1)[live]
            py = np.clip((fy + np.sin(ang) * t).astype(np.int64), 0, n - 1)[live]
            lum[py, px] *= 1.0 - dark[live]
            lum[np.clip(py + 1, 0, n - 1), px] *= 1.0 - 0.5 * dark[live]
        out = np.clip(rgb * lum[..., None], 0, 255).astype(np.uint8)
        raw = np.zeros((n, 1 + IMG_W * 3), dtype=np.uint8)
        raw[:, 1:] = out.reshape(n, IMG_W * 3)
        idat.append(comp.compress(raw.tobytes()))
    idat.append(comp.flush())
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(_png_chunk(b"IHDR", struct.pack(">IIBBBBB", IMG_W, IMG_H, 8, 2, 0, 0, 0)))
        fh.write(_png_chunk(b"IDAT", b"".join(idat)))
        fh.write(_png_chunk(b"IEND", b""))


def color_image_path(out_dir):
    """Path of the cached colour map. It is rebuilt only when the quilt code or palette changes."""
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "quilt_color_%s.png" % _cache_key())
    if not os.path.exists(path):
        build_color_image(path)
    return path


def build_terrain_object(name="quilt_ground"):
    import bpy

    xs = np.linspace(X0, X1, NX)
    ys = np.linspace(Y0, Y1, NY)
    X, Y = np.meshgrid(xs, ys)
    Z = surface(X, Y)
    co = np.stack([X, Y, Z], axis=-1).reshape(-1, 3).astype(np.float32)
    idx = np.arange(NX * NY, dtype=np.int32).reshape(NY, NX)
    quads = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], axis=-1).reshape(-1, 4)
    nq = len(quads)

    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(co))
    mesh.vertices.foreach_set("co", co.ravel())
    mesh.loops.add(nq * 4)
    mesh.polygons.add(nq)
    mesh.loops.foreach_set("vertex_index", quads.ravel())
    mesh.polygons.foreach_set("loop_start", np.arange(0, nq * 4, 4, dtype=np.int32))
    mesh.polygons.foreach_set("use_smooth", np.ones(nq, dtype=bool))
    mesh.update(calc_edges=True)

    u = ((X - IMG_X0) / (IMG_X1 - IMG_X0)).ravel().astype(np.float32)
    v = ((Y - IMG_Y0) / (IMG_Y1 - IMG_Y0)).ravel().astype(np.float32)
    uv = np.stack([u[quads], v[quads]], axis=-1).reshape(-1)
    layer = mesh.uv_layers.new(name="UV")
    layer.data.foreach_set("uv", uv)

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_far_plain_object(name="far_plain"):
    """Coarse land from the end of the quilt mesh back to the backdrop, so the horizon has ground under it."""
    import bpy

    nx, ny = 300, 96
    xs = np.linspace(-80.0, 80.0, nx)
    ys = np.linspace(Y1 - 0.2, 33.5, ny)
    X, Y = np.meshgrid(xs, ys)
    Z = h(X, Y) - 0.02
    co = np.stack([X, Y, Z], axis=-1).reshape(-1, 3).astype(np.float32)
    idx = np.arange(nx * ny, dtype=np.int32).reshape(ny, nx)
    quads = np.stack([idx[:-1, :-1], idx[:-1, 1:], idx[1:, 1:], idx[1:, :-1]], axis=-1).reshape(-1, 4)
    nq = len(quads)
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(co))
    mesh.vertices.foreach_set("co", co.ravel())
    mesh.loops.add(nq * 4)
    mesh.polygons.add(nq)
    mesh.loops.foreach_set("vertex_index", quads.ravel())
    mesh.polygons.foreach_set("loop_start", np.arange(0, nq * 4, 4, dtype=np.int32))
    mesh.polygons.foreach_set("use_smooth", np.ones(nq, dtype=bool))
    mesh.update(calc_edges=True)
    uv = np.stack([((X - IMG_X0) / (IMG_X1 - IMG_X0)).ravel()[quads], ((Y - IMG_Y0) / (IMG_Y1 - IMG_Y0)).ravel()[quads]],
                  axis=-1).reshape(-1).astype(np.float32)
    mesh.uv_layers.new(name="UV").data.foreach_set("uv", uv)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def seam_stitch_points(spacing, keep, seed_stream=3):
    """Points along every seam, one every `spacing` units of length, with the seam direction.

    `keep(x, y)` returns a boolean mask of the points worth building. Returns x, y, tx, ty arrays.
    """
    rng = np.random.default_rng([palette.SEED, seed_stream])
    corners = np.array([[-18.0, -8.0], [18.0, -8.0], [18.0, 20.0], [-18.0, 20.0]])
    cu, cv = _warp(corners[:, 0], corners[:, 1])
    i_lo, i_hi = int(np.floor(cu.min() / CELL_U)) - 1, int(np.ceil(cu.max() / CELL_U)) + 1
    j_lo, j_hi = int(np.floor(cv.min() / CELL_V)) - 1, int(np.ceil(cv.max() / CELL_V)) + 1
    xs_out, ys_out, tx_out, ty_out = [], [], [], []

    def walk(pu, pv):
        x, y = _unwarp(pu, pv)
        seg = np.hypot(np.diff(x), np.diff(y))
        s = np.concatenate([[0.0], np.cumsum(seg)])
        phase = rng.uniform(0.0, spacing)
        targets = np.arange(phase, s[-1], spacing)
        px = np.interp(targets, s, x)
        py = np.interp(targets, s, y)
        ax = np.interp(targets + 0.04, s, x) - np.interp(targets - 0.04, s, x)
        ay = np.interp(targets + 0.04, s, y) - np.interp(targets - 0.04, s, y)
        norm = np.hypot(ax, ay)
        mask = keep(px, py) & (norm > 1e-6)
        xs_out.append(px[mask])
        ys_out.append(py[mask])
        tx_out.append((ax / np.where(norm > 0, norm, 1))[mask])
        ty_out.append((ay / np.where(norm > 0, norm, 1))[mask])

    vs = np.arange(cv.min() - 2.0, cv.max() + 2.0, 0.02)
    us = np.arange(cu.min() - 2.0, cu.max() + 2.0, 0.02)
    for i in range(i_lo, i_hi + 1):
        walk(np.full_like(vs, i * CELL_U), vs)
    for j in range(j_lo, j_hi + 1):
        walk(us, np.full_like(us, j * CELL_V))
    return (np.concatenate(xs_out), np.concatenate(ys_out),
            np.concatenate(tx_out), np.concatenate(ty_out))
