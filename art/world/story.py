"""The story: a red yarn road with a gap, three cross-stitches, a giant needle, a coin, a wallet and two people.

Every builder takes `frame` so a later order can animate it. At frame 1 each one builds the pose in the still.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import layout
import materials
import palette
import terrain
import town

SEED = palette.SEED

# Yarn sizes from the spec.
PLY_RADIUS = 0.055
HELIX_RADIUS = 0.05
TWIST_PERIOD = 0.55
YARN_LIFT = PLY_RADIUS + HELIX_RADIUS - 0.01

LEFT_FRAMES = [(0.215, 0.665), (0.30, 0.70), (0.40, 0.67), (0.47, 0.645)]
# The right stretch ends at the wallet, whose left foot is added to these points by plan_story.
RIGHT_FRAMES = [(0.575, 0.645), (0.64, 0.675), (0.70, 0.66)]
# Each cross-stitch is stretched along the view direction so it reads as a squat X from the low camera.
STITCH_WIDTH = 0.50
STITCH_SPACING = 0.72
STITCH_DEPTH = 2.0
STITCH_ARCH = 0.04
STITCH_BRIDGE = 0.14
STITCH_DIP = 0.09
FRAYS_PER_END = 6


def _catmull(points, ds=0.02):
    """Centripetal Catmull-Rom curve through the points, resampled every `ds` along its length."""
    P = np.asarray(points, dtype=np.float64)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5
        t = np.linspace(t1, t2, 80, endpoint=False)[:, None]
        a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
        a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
        a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
        b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
        b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
        out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    out.append(P[-2][None, :])
    return _resample(np.vstack(out), ds)


def _resample(pts, ds):
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    targets = np.linspace(0.0, s[-1], max(2, int(round(s[-1] / ds)) + 1))
    return np.stack([np.interp(targets, s, pts[:, k]) for k in range(pts.shape[1])], axis=-1)


def _arc_length(pts):
    return np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])


def _smooth(values, window):
    k = np.ones(window) / window
    pad = window // 2
    v = np.concatenate([np.full(pad, values[0]), values, np.full(pad, values[-1])])
    return np.convolve(v, k, mode="valid")[:len(values)]


def lay_on_ground(xy, lift):
    """3D path that follows the ground (swell plus pillow), `lift` above it, lightly smoothed along its length."""
    z = terrain.surface(xy[:, 0], xy[:, 1]) + lift
    return np.stack([xy[:, 0], xy[:, 1], _smooth(z, 9)], axis=-1)


def _tangents(pts):
    t = np.gradient(pts, axis=0)
    return t / np.linalg.norm(t, axis=1, keepdims=True)


def tube_arrays(centre, radius, around=10, up=(0.0, 0.0, 1.0)):
    """Closed tube along `centre` (n, 3) with per-point `radius`. Returns vertices (m, 3) and triangles (k, 3)."""
    centre = np.asarray(centre, dtype=np.float64)
    n = len(centre)
    radius = np.broadcast_to(np.asarray(radius, dtype=np.float64), (n,))
    T = _tangents(centre)
    ref = np.broadcast_to(np.asarray(up, dtype=np.float64), T.shape)
    A = np.cross(T, ref)
    bad = np.linalg.norm(A, axis=1) < 1e-4
    if bad.any():
        A[bad] = np.cross(T[bad], np.array([0.0, 1.0, 0.0]))
    A /= np.linalg.norm(A, axis=1, keepdims=True)
    B = np.cross(A, T)
    ang = np.linspace(0.0, 2 * np.pi, around, endpoint=False)
    ring = (centre[:, None, :]
            + radius[:, None, None] * (np.cos(ang)[None, :, None] * A[:, None, :] + np.sin(ang)[None, :, None] * B[:, None, :]))
    verts = np.concatenate([ring.reshape(-1, 3), centre[:1], centre[-1:]], axis=0)
    tris = []
    j = np.arange(around)
    j2 = (j + 1) % around
    for i in range(n - 1):
        a, b = i * around, (i + 1) * around
        tris.append(np.stack([a + j, a + j2, b + j2], axis=-1))
        tris.append(np.stack([a + j, b + j2, b + j], axis=-1))
    start_c, end_c = n * around, n * around + 1
    tris.append(np.stack([np.full(around, start_c), j2, j], axis=-1))
    last = (n - 1) * around
    tris.append(np.stack([np.full(around, end_c), last + j, last + j2], axis=-1))
    tris = np.concatenate(tris, axis=0)
    # Flip all triangles when the tube came out inside-out (negative signed volume).
    v0, v1, v2 = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    if np.sum(np.einsum("ij,ij->i", v0, np.cross(v1, v2))) < 0:
        tris = tris[:, ::-1]
    return verts, tris


def merge_arrays(parts):
    verts, tris, off = [], [], 0
    for v, t in parts:
        verts.append(v)
        tris.append(t + off)
        off += len(v)
    return np.concatenate(verts, axis=0), np.concatenate(tris, axis=0)


def object_from_arrays(name, verts, tris, material, smooth=True):
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(verts))
    mesh.vertices.foreach_set("co", verts.astype(np.float32).ravel())
    mesh.loops.add(len(tris) * 3)
    mesh.polygons.add(len(tris))
    mesh.loops.foreach_set("vertex_index", tris.astype(np.int32).ravel())
    mesh.polygons.foreach_set("loop_start", np.arange(0, len(tris) * 3, 3, dtype=np.int32))
    mesh.polygons.foreach_set("use_smooth", np.full(len(tris), smooth, dtype=bool))
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def twisted_yarn(path3, ply_r=PLY_RADIUS, helix_r=HELIX_RADIUS, period=TWIST_PERIOD, around=10, taper=(False, False),
                 rng=None, up=(0.0, 0.0, 1.0)):
    """Two plies wound around the path in a helix. Returns a list of (vertices, triangles), one per ply."""
    rng = rng or np.random.default_rng(1)
    T = _tangents(path3)
    ref = np.asarray(up, dtype=np.float64)
    N = ref[None, :] - (T @ ref)[:, None] * T
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    B = np.cross(T, N)
    s = _arc_length(path3)
    drift = rng.uniform(0, 6.28)
    taper_fac = np.ones(len(s))
    span = 0.07
    if taper[0]:
        taper_fac = np.minimum(taper_fac, 0.4 + 0.6 * np.clip(s / span, 0, 1))
    if taper[1]:
        taper_fac = np.minimum(taper_fac, 0.4 + 0.6 * np.clip((s[-1] - s) / span, 0, 1))
    wobble = 1.0 + 0.07 * np.sin(2 * np.pi * s / 0.93 + drift)
    parts = []
    for k in (0, 1):
        phi = 2 * np.pi * s / period + k * np.pi + 0.15 * np.sin(2 * np.pi * s / 1.7 + drift)
        ctr = path3 + (helix_r * taper_fac)[:, None] * (np.cos(phi)[:, None] * N + np.sin(phi)[:, None] * B)
        parts.append(tube_arrays(ctr, ply_r * taper_fac * wobble, around, up=N.mean(axis=0)))
    return parts


def fibre_arrays(start, direction, length, rng, lift_end=0.04, radius=0.011, curl=0.05, points=14):
    """One loose fibre lying on the ground, curling a little, its tip lifting off the surface."""
    d = np.array([direction[0], direction[1]], dtype=np.float64)
    d /= np.linalg.norm(d)
    perp = np.array([-d[1], d[0]])
    s = np.linspace(0.0, 1.0, points)
    phase = rng.uniform(0, 6.28)
    xy = (np.asarray(start[:2])[None, :] + (d[None, :] * (length * s)[:, None])
          + perp[None, :] * (curl * np.sin(2 * np.pi * (s * rng.uniform(0.6, 1.4)) + phase) * s)[:, None])
    z = terrain.surface(xy[:, 0], xy[:, 1]) + radius * 1.1 + lift_end * s ** 2
    path = np.stack([xy[:, 0], xy[:, 1], z], axis=-1)
    return tube_arrays(path, radius * (1.0 - 0.55 * s), 5)


def _project_xy(world_xy):
    z = terrain.surface(world_xy[0], world_xy[1])
    fx, fy, _ = layout.project(np.array([[world_xy[0], world_xy[1], z]]))
    return float(fx[0]), float(fy[0])


# The wallet stands about 0.8 tall, so its visual centre is near frame (0.765, 0.60) with the base below it.
WALLET_FRAME = (0.765, 0.637)
WALLET_WIDTH = 1.15
WALLET_THICK = 0.13
WALLET_BACK = (0.88, -30.0)
WALLET_FRONT = (0.5, -3.0)
WALLET_YAW = math.radians(-20.0)


def plan_wallet():
    """Base point and turn of the wallet, and the point where the yarn road stops against its left end."""
    base = layout.ground_point(*WALLET_FRAME)
    along = np.array([math.cos(WALLET_YAW), math.sin(WALLET_YAW)])
    foot = base[:2] - along * (WALLET_WIDTH / 2.0 + 0.06)
    return {"base": base, "yaw": WALLET_YAW, "foot": foot}


def plan_story(plan):
    """Work out the yarn road, the gap, the three stitches and the needle in world units.

    Uses only the ground height function, so it can run before the ground mesh exists.
    """
    shop = next(sp for sp in plan if sp["name"] == "shop")
    face = math.radians(shop["facing_deg"])
    c, s = math.cos(face), math.sin(face)
    ax, ay = shop["anchor"][0], shop["anchor"][1]
    door_front = np.array([ax + c * 0.0 - s * (-shop["depth"] / 2 - 0.2), ay + s * 0.0 + c * (-shop["depth"] / 2 - 0.2)])

    def ctrl(frames):
        return np.array([layout.ground_point(fx, fy)[:2] for fx, fy in frames])

    wallet = plan_wallet()
    left_ctrl = np.vstack([door_front[None, :], ctrl(LEFT_FRAMES)])
    right_ctrl = np.vstack([ctrl(RIGHT_FRAMES), wallet["foot"][None, :]])
    left_xy = _catmull(left_ctrl)
    right_xy = _catmull(right_ctrl)

    g0 = left_xy[-1]
    g1 = right_xy[0]
    gap = g1 - g0
    gap_len = float(np.linalg.norm(gap))
    r = gap / gap_len
    q = np.array([-r[1], r[0]])
    if q[1] < 0:
        q = -q
    tip = layout.ground_point(*layout.NEEDLE_TIP_FRAME)[:2]

    # Row of three X's. The needle tip is the far left corner of the third one, so the row is laid out from it.
    a_tip = float((tip - g0) @ r)
    b_far = float((tip - g0) @ q)
    b_near = b_far - STITCH_DEPTH
    lefts = [a_tip + (k - 2) * STITCH_SPACING for k in range(3)]

    def pt(a, b):
        return g0 + a * r + b * q

    stitches = []
    for k, a0 in enumerate(lefts):
        a1 = a0 + STITCH_WIDTH
        stitches.append({"diag1": (pt(a0, b_near), pt(a1, b_far)),
                         "diag2": (pt(a0, b_far), pt(a1, b_near)) if k < 2 else None,
                         "centre": pt((a0 + a1) / 2.0, (b_far + b_near) / 2.0)})
    corners = [pt(a, b) for a0 in lefts for a in (a0, a0 + STITCH_WIDTH) for b in (b_far, b_near)]
    for corner in corners:
        terrain.add_dimple(corner[0], corner[1])
    return {"left_xy": left_xy, "right_xy": right_xy, "g0": g0, "g1": g1, "gap_len": gap_len, "gap_dir": r,
            "gap_side": q, "tip": tip, "stitch_centres": [st["centre"] for st in stitches], "stitches": stitches,
            "dimples": corners, "door_front": door_front, "wallet": wallet}


def footprint_points(story):
    """Ground points under the road, the stitches, the wallet and the coin, for the quilt colour rules."""
    pts = [p for p in story["left_xy"][::4]] + [p for p in story["right_xy"][::4]]
    t = np.linspace(0, 1, 30)
    pts += [story["g0"] + t_ * (story["g1"] - story["g0"]) for t_ in t]
    for st in story["stitches"]:
        for d in (st["diag1"], st["diag2"]):
            if d is not None:
                pts += [d[0] + t_ * (d[1] - d[0]) for t_ in t[::2]]
    pts.append(layout.ground_point(*WALLET_FRAME)[:2])
    pts.append(layout.ground_point(0.66, 0.665)[:2])
    pts.append(story["tip"])
    return pts


def _stitch_arm(p_from, p_to, bridge=0.0, dip=0.0):
    """One arm of a cross-stitch: a shallow arch over the ground that sinks into the quilt at both ends.

    Where the two arms cross, `bridge` lifts the upper one and `dip` presses the lower one into the quilt.
    """
    a, b = np.asarray(p_from, dtype=np.float64), np.asarray(p_to, dtype=np.float64)
    xy = _resample(np.stack([a, b]), 0.02)
    t = np.linspace(0.0, 1.0, len(xy))
    sink = 0.2 * (1.0 - _smoothstep(np.minimum(t, 1.0 - t) / 0.09))
    z = (terrain.surface(xy[:, 0], xy[:, 1]) + YARN_LIFT + STITCH_ARCH * np.sin(np.pi * t) ** 0.7
         + (bridge - dip) * np.sin(np.pi * t) ** 6 - sink)
    return np.stack([xy[:, 0], xy[:, 1], z], axis=-1)


def build_yarn_road(story, frame=1):
    """The red road in two stretches, frayed at the gap, plus the three cross-stitches. Returns the objects."""
    rng = np.random.default_rng([SEED, 50])
    left = lay_on_ground(story["left_xy"], YARN_LIFT)
    right = lay_on_ground(story["right_xy"], YARN_LIFT)
    parts = []
    parts += twisted_yarn(left, taper=(False, True), rng=rng)
    parts += twisted_yarn(right, taper=(True, False), rng=rng)

    # Two arms per X, the second passing over the first. The third X has only its first arm.
    for st in story["stitches"]:
        parts += twisted_yarn(_stitch_arm(*st["diag1"], dip=STITCH_DIP), rng=rng)
        if st["diag2"] is not None:
            parts += twisted_yarn(_stitch_arm(*st["diag2"], bridge=STITCH_BRIDGE), rng=rng)
    verts, tris = merge_arrays(parts)
    road = object_from_arrays("yarn_road", verts, tris, materials.yarn("yarn_red", palette.YARN, 0.09))

    # Loose fibres only at the two frayed ends, fanning out over about 0.4 units.
    fibres = []
    for xy, out_dir in ((story["left_xy"], story["gap_dir"]), (story["right_xy"], -story["gap_dir"])):
        end = xy[-1] if out_dir is story["gap_dir"] else xy[0]
        base_angle = math.atan2(out_dir[1], out_dir[0])
        for j in range(FRAYS_PER_END):
            a = base_angle + (j - (FRAYS_PER_END - 1) / 2.0) * 0.24 + rng.uniform(-0.05, 0.05)
            length = rng.uniform(0.28, 0.42)
            start = np.array([end[0], end[1], 0.0])
            fibres.append(fibre_arrays(start, (math.cos(a), math.sin(a)), length, rng, lift_end=rng.uniform(0.02, 0.07),
                                       radius=rng.uniform(0.010, 0.016), curl=rng.uniform(0.03, 0.08)))
    fv, ft = merge_arrays(fibres)
    fib = object_from_arrays("yarn_fibres", fv, ft, materials.yarn("yarn_fibre", palette.YARN, 0.16))
    return [road, fib]


# ---------------------------------------------------------------------------------------------------------------
# Needle and strand
# ---------------------------------------------------------------------------------------------------------------
NEEDLE_EYE_FRAME = (0.70, 0.16)
NEEDLE_BURY = 0.10
NEEDLE_HEAD_PAST_EYE = 0.5
NEEDLE_PLATE_WIDTH = 0.34
NEEDLE_PLATE_THICK = 0.10
NEEDLE_SLOT_WIDTH = 0.15
NEEDLE_SLOT_LENGTH = 0.62
STRAND_PLY = 0.03
STRAND_HELIX = 0.026
STRAND_PERIOD = 0.4


def _smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def plan_needle():
    """Needle pose in world units: the tip at its frame position, the eye at its frame position.

    The eye ray gives one free number, how far along the ray the eye sits. The closest point to the tip
    gives the shortest needle that satisfies both frame positions, and the needle lies across the view.
    """
    c = layout.CAM_LOC
    tip = layout.ground_point(*layout.NEEDLE_TIP_FRAME)
    tip[2] = float(terrain.surface(tip[0], tip[1]))
    _, d = layout.ray(*NEEDLE_EYE_FRAME)
    eye = c + float((tip - c) @ d) * d
    axis = eye - tip
    eye_dist = float(np.linalg.norm(axis))
    a = axis / eye_dist
    to_cam = c - tip
    n = to_cam - float(to_cam @ a) * a
    n /= np.linalg.norm(n)
    p = np.cross(a, n)
    return {"tip": tip, "eye": eye, "axis": a, "n": n, "p": p, "eye_dist": eye_dist,
            "length": eye_dist + NEEDLE_BURY + NEEDLE_HEAD_PAST_EYE}


def _loft_arrays(zs, half_a, half_b, around=28):
    """Closed elliptical loft along local z. half_a runs along x, half_b along y."""
    n = len(zs)
    ang = np.linspace(0.0, 2 * np.pi, around, endpoint=False)
    ring = np.zeros((n, around, 3))
    ring[:, :, 0] = half_a[:, None] * np.cos(ang)[None, :]
    ring[:, :, 1] = half_b[:, None] * np.sin(ang)[None, :]
    ring[:, :, 2] = zs[:, None]
    verts = np.concatenate([ring.reshape(-1, 3), np.array([[0, 0, zs[0]], [0, 0, zs[-1]]])], axis=0)
    j = np.arange(around)
    j2 = (j + 1) % around
    tris = []
    for i in range(n - 1):
        a, b = i * around, (i + 1) * around
        tris.append(np.stack([a + j, a + j2, b + j2], axis=-1))
        tris.append(np.stack([a + j, b + j2, b + j], axis=-1))
    tris.append(np.stack([np.full(around, n * around), j2, j], axis=-1))
    last = (n - 1) * around
    tris.append(np.stack([np.full(around, n * around + 1), last + j, last + j2], axis=-1))
    tris = np.concatenate(tris, axis=0)
    v0, v1, v2 = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    if np.sum(np.einsum("ij,ij->i", v0, np.cross(v1, v2))) < 0:
        tris = tris[:, ::-1]
    return verts, tris


def _prism_arrays(outline, y0, y1):
    """Convex outline in the local x, z plane extruded along y from y0 to y1."""
    pts = np.asarray(outline, dtype=np.float64)
    n = len(pts)
    front = np.stack([pts[:, 0], np.full(n, y0), pts[:, 1]], axis=-1)
    back = np.stack([pts[:, 0], np.full(n, y1), pts[:, 1]], axis=-1)
    centre = pts.mean(axis=0)
    cf = np.array([[centre[0], y0, centre[1]]])
    cb = np.array([[centre[0], y1, centre[1]]])
    verts = np.concatenate([front, back, cf, cb], axis=0)
    i = np.arange(n)
    i2 = (i + 1) % n
    tris = [np.stack([i, i2, n + i2], axis=-1), np.stack([i, n + i2, n + i], axis=-1),
            np.stack([np.full(n, 2 * n), i2, i], axis=-1), np.stack([np.full(n, 2 * n + 1), n + i, n + i2], axis=-1)]
    tris = np.concatenate(tris, axis=0)
    v0, v1, v2 = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    if np.sum(np.einsum("ij,ij->i", v0, np.cross(v1, v2))) < 0:
        tris = tris[:, ::-1]
    return verts, tris


def _stadium_outline(cx, cz, half_w, half_len, steps=10):
    """Rounded slot: two half circles joined by straight sides, counter clockwise."""
    r = half_w
    pts = []
    for k in range(steps + 1):
        a = math.pi * k / steps
        pts.append((cx + r * math.cos(a), cz + half_len - r + r * math.sin(a)))
    for k in range(steps + 1):
        a = math.pi + math.pi * k / steps
        pts.append((cx + r * math.cos(a), cz - half_len + r + r * math.sin(a)))
    return pts


def _needle_matrix(plan):
    m = Matrix.Identity(4)
    base = plan["tip"] - plan["axis"] * NEEDLE_BURY
    for col, vec in enumerate((plan["p"], plan["n"], plan["axis"])):
        for row in range(3):
            m[row][col] = float(vec[row])
    for row in range(3):
        m[row][3] = float(base[row])
    return m


def build_needle(plan, frame=1):
    """Polished steel needle: tapered shaft, flat head with a slot cut for the eye. Returns its objects."""
    L = plan["length"]
    head_len = 1.15
    s_head = L - head_len
    zs = np.concatenate([np.linspace(0.0, 1.0, 14), np.linspace(1.0, s_head, 60)[1:]])
    radius = 0.052 + 0.02 * (zs / s_head)
    tip_fac = _smoothstep(zs / 1.0) ** 0.75
    radius = radius * tip_fac
    flare = _smoothstep((zs - (s_head - 0.35)) / 0.35)
    half_a = radius + flare * (NEEDLE_PLATE_WIDTH / 2.0 - radius)
    half_b = radius + flare * (NEEDLE_PLATE_THICK / 2.0 - radius)
    sv, st = _loft_arrays(zs, half_a, half_b)
    steel = materials.polished_steel()
    shaft = object_from_arrays("needle_shaft", sv, st, steel)

    w = NEEDLE_PLATE_WIDTH / 2.0
    outline = [(-w, s_head - 0.02), (w, s_head - 0.02), (w, L - w)]
    for k in range(1, 13):
        a = math.pi * k / 12
        outline.append((w * math.cos(a), L - w + w * math.sin(a)))
    outline.append((-w, L - w))
    pv, pt = _prism_arrays(outline, -NEEDLE_PLATE_THICK / 2.0, NEEDLE_PLATE_THICK / 2.0)
    plate = object_from_arrays("needle_head", pv, pt, steel)

    eye_s = plan["eye_dist"] + NEEDLE_BURY
    cv, ct = _prism_arrays(_stadium_outline(0.0, eye_s, NEEDLE_SLOT_WIDTH / 2.0, NEEDLE_SLOT_LENGTH / 2.0), -0.3, 0.3)
    cutter = object_from_arrays("needle_eye_cutter", cv, ct, steel)
    cutter.hide_render = True
    cutter.display_type = "WIRE"
    boolean = plate.modifiers.new("eye", "BOOLEAN")
    boolean.operation = "DIFFERENCE"
    boolean.object = cutter
    boolean.solver = "EXACT"
    bevel = plate.modifiers.new("edge", "BEVEL")
    bevel.width = 0.012
    bevel.segments = 2
    bevel.limit_method = "ANGLE"
    bevel.angle_limit = math.radians(30.0)

    m = _needle_matrix(plan)
    for o in (shaft, plate, cutter):
        o.matrix_world = m
    return [shaft, plate, cutter]


def build_strand(plan, story, frame=1):
    """One red strand: out of the third stitch, up in a slack curve, through the eye, away to the top right."""
    rng = np.random.default_rng([SEED, 51])
    tip, eye, a, n, p = plan["tip"], plan["eye"], plan["axis"], plan["n"], plan["p"]
    r = np.array([story["gap_dir"][0], story["gap_dir"][1], 0.0])
    ground = float(terrain.surface(tip[0], tip[1]))
    start = np.array([tip[0], tip[1], ground - 0.03]) + r * 0.1 - np.array([0.0, 0.0, 0.0])
    left = np.array([-1.0, 0.0, 0.0])
    cam = np.array([0.0, -1.0, 0.0])

    def along(s):
        return tip + a * s

    ctrl = [
        start,
        start + np.array([0.0, 0.0, 0.16]) + left * 0.05,
        along(0.7) + left * 0.55 + cam * 0.25,
        along(1.9) + left * 0.85 + cam * 0.35,
        along(3.2) + left * 0.55 + cam * 0.45,
        eye - a * 0.35 + n * 0.45 + left * 0.1,
        eye + n * 0.16 - a * 0.05,
        eye - n * 0.16 + a * 0.05,
    ]
    c = layout.CAM_LOC
    f_axis = layout._basis()[0]
    depth_eye = float((eye - c) @ f_axis)
    _, dir_out = layout.ray(1.06, -0.09)
    p_out = c + dir_out * (depth_eye / float(dir_out @ f_axis))
    mid = 0.5 * (eye + p_out) + np.array([0.0, 0.0, 0.45]) - n * 0.2
    ctrl += [eye - n * 0.5 + a * 0.35 + p * 0.45, mid, p_out]
    path = _catmull(np.array(ctrl), 0.02)
    parts = twisted_yarn(path, STRAND_PLY, STRAND_HELIX, STRAND_PERIOD, around=8, rng=rng, taper=(False, False))
    verts, tris = merge_arrays(parts)
    return [object_from_arrays("yarn_strand", verts, tris, materials.yarn("yarn_strand", palette.YARN, 0.08))]


# ---------------------------------------------------------------------------------------------------------------
# Shared shape helpers, coin, wallet and people
# ---------------------------------------------------------------------------------------------------------------
def _fix_winding(verts, tris):
    v0, v1, v2 = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    if np.sum(np.einsum("ij,ij->i", v0, np.cross(v1, v2))) < 0:
        return tris[:, ::-1]
    return tris


def lathe_arrays(profile, segments=24, ridge=None):
    """Spin a (radius, z) or (radius, z, ridge weight) profile around z. A radius of 0 makes a pole."""
    prof = np.asarray(profile, dtype=np.float64)
    if prof.shape[1] == 2:
        prof = np.concatenate([prof, np.zeros((len(prof), 1))], axis=1)
    ang = np.linspace(0.0, 2 * np.pi, segments, endpoint=False)
    rid = np.zeros(segments) if ridge is None else ridge(ang)
    verts, starts, poles = [], [], []
    for r, z, w in prof:
        starts.append(len(verts))
        if r < 1e-9:
            verts.append([0.0, 0.0, z])
            poles.append(True)
        else:
            rr = r * (1.0 - w * rid)
            for k in range(segments):
                verts.append([rr[k] * math.cos(ang[k]), rr[k] * math.sin(ang[k]), z])
            poles.append(False)
    verts = np.array(verts)
    j = np.arange(segments)
    j2 = (j + 1) % segments
    tris = []
    for i in range(len(prof) - 1):
        a, b = starts[i], starts[i + 1]
        if poles[i] and poles[i + 1]:
            continue
        if poles[i]:
            tris.append(np.stack([np.full(segments, a), b + j, b + j2], axis=-1))
        elif poles[i + 1]:
            tris.append(np.stack([np.full(segments, b), a + j2, a + j], axis=-1))
        else:
            tris.append(np.stack([a + j, a + j2, b + j2], axis=-1))
            tris.append(np.stack([a + j, b + j2, b + j], axis=-1))
    tris = np.concatenate(tris, axis=0)
    return verts, _fix_winding(verts, tris)


def bmesh_from_arrays(verts, tris):
    bm = bmesh.new()
    vs = [bm.verts.new(tuple(v)) for v in verts]
    for t in tris:
        try:
            bm.faces.new((vs[t[0]], vs[t[1]], vs[t[2]]))
        except ValueError:
            pass
    return bm


def _prism_z_arrays(outline, z0, z1):
    """Convex outline in the x, y plane extruded along z. Built from the y extrusion with the axes swapped."""
    v, t = _prism_arrays(outline, z0, z1)
    v = v[:, [0, 2, 1]]
    return v, _fix_winding(v, t)


def _rotate_outline(pts, ang):
    c, s = math.cos(ang), math.sin(ang)
    return [(x * c - y * s, x * s + y * c) for x, y in pts]


COIN_RADIUS = 0.42
COIN_THICK = 0.09
COIN_YAW = math.radians(25.0)
COIN_LEAN = math.radians(6.0)


def plan_coin(story):
    """Where the coin stands: the point on the right stretch nearest its frame position."""
    target = layout.ground_point(0.66, 0.665)[:2]
    path = story["right_xy"]
    i = int(np.argmin(np.linalg.norm(path - target[None, :], axis=1)))
    return path[i]


def build_coin(story, frame=1):
    """Gold clay coin on its edge on the right stretch of yarn, turned 25 degrees and leaning 6 as if rolling."""
    pos = plan_coin(story)
    R, t = COIN_RADIUS, COIN_THICK
    profile = [(0.0, t / 2, 0), (R - 0.03, t / 2, 0), (R - 0.012, t / 2 - 0.012, 0.6), (R, t / 2 - 0.028, 1.0),
               (R, -t / 2 + 0.028, 1.0), (R - 0.012, -t / 2 + 0.012, 0.6), (R - 0.03, -t / 2, 0), (0.0, -t / 2, 0)]
    body_v, body_t = lathe_arrays(profile, 200, ridge=lambda a: 0.06 * (0.5 + 0.5 * np.cos(40 * a)))
    # Raised cross-stitch X on both faces: two rounded bars at 45 degrees.
    bars = []
    bar = _stadium_outline(0.0, 0.0, 0.044, 0.26)
    for z0 in (t / 2 - 0.004, -t / 2 - 0.03 + 0.004):
        for ang in (math.pi / 4, -math.pi / 4):
            bars.append(_prism_z_arrays(_rotate_outline(bar, ang), z0, z0 + 0.034))
    obj = object_from_arrays("coin", body_v, body_t, materials.clay("gold_coin", palette.COIN, roughness=0.35, metallic=0.3))
    town.add_wobble(obj, 0.008)
    mv, mt = merge_arrays(bars)
    mark = object_from_arrays("coin_mark", mv, mt, materials.clay("gold_mark", palette.COIN_MARK, roughness=0.4, metallic=0.3))
    town.add_wobble(mark, 0.008)

    h = np.array([math.cos(COIN_YAW), math.sin(COIN_YAW), 0.0])
    n0 = np.array([math.sin(COIN_YAW), -math.cos(COIN_YAW), 0.0])
    n = n0 * math.cos(COIN_LEAN) + np.array([0.0, 0.0, 1.0]) * math.sin(COIN_LEAN)
    y_axis = np.cross(n, h)
    yarn_top = float(terrain.surface(pos[0], pos[1])) + YARN_LIFT + PLY_RADIUS + HELIX_RADIUS - 0.01
    drop = R * math.sqrt(max(0.0, 1.0 - n[2] ** 2)) + (t / 2) * abs(n[2])
    centre = np.array([pos[0], pos[1], yarn_top + drop - 0.012])
    m = Matrix.Identity(4)
    for col, vec in enumerate((h, y_axis, n)):
        for row in range(3):
            m[row][col] = float(vec[row])
    for row in range(3):
        m[row][3] = float(centre[row])
    obj.matrix_world = m
    mark.matrix_world = m
    return [obj, mark]


def _lean(deg):
    return Matrix.Rotation(math.radians(deg), 3, "X")


def _leaf_box(bm, centre, size, lean_deg):
    """A box built upright on the spine line, then tipped about the x axis through the origin."""
    first = len(bm.verts)
    town._box(bm, centre, size)
    rot = _lean(lean_deg)
    for v in list(bm.verts)[first:]:
        v.co = rot @ v.co


def _rounded_outline(width, height, radius, steps=6):
    """Convex rounded rectangle in the x, z plane with its bottom edge on z = 0, counter clockwise."""
    pts = []
    for cx, cz, a0 in ((width / 2 - radius, radius, -90), (width / 2 - radius, height - radius, 0),
                       (-width / 2 + radius, height - radius, 90), (-width / 2 + radius, radius, 180)):
        for k in range(steps + 1):
            a = math.radians(a0 + 90.0 * k / steps)
            pts.append((cx + radius * math.cos(a), cz + radius * math.sin(a)))
    return pts


def _leaf_slab(bm, width, height, thick, lean_deg, y_centre=0.0, radius=0.12, z0=0.0):
    """A rounded-corner leaf standing on the spine line, tipped about the x axis through the origin."""
    first = len(bm.verts)
    town._extrude(bm, _rounded_outline(width, height, radius), (0.0, y_centre - thick / 2.0, z0),
                  (1, 0, 0), (0, 0, 1), (0, 1, 0), thick)
    rot = _lean(lean_deg)
    for v in list(bm.verts)[first:]:
        v.co = rot @ v.co


def build_wallet(story, frame=1):
    """Blue leather bifold standing half open on its edge, front flap toward the camera, with a folded note."""
    w = story["wallet"]
    base, yaw = w["base"], w["yaw"]
    loc = (float(base[0]), float(base[1]), float(terrain.surface(base[0], base[1])) - 0.01)
    rot = (0.0, 0.0, yaw)
    W, th = WALLET_WIDTH, WALLET_THICK
    h_back, lean_back = WALLET_BACK
    h_front, lean_front = WALLET_FRONT
    leather = town._clay_for(palette.WALLET, 0.5)
    cream = town._clay_for(palette.STITCH, 0.7)
    lining_mat = town._clay_for(palette.QUILT["sky"], 0.6)
    gold = materials.clay("gold_coin", palette.COIN, roughness=0.35, metallic=0.3)
    objs = []

    body = bmesh.new()
    _leaf_slab(body, W, h_back, th, lean_back)
    _leaf_slab(body, W, h_front, th, lean_front)
    spine = [(0.085 * math.cos(2 * math.pi * k / 14), 0.085 * math.sin(2 * math.pi * k / 14)) for k in range(14)]
    town._extrude(body, spine, (-W / 2 + 0.03, 0.0, 0.085), (0, 1, 0), (0, 0, 1), (1, 0, 0), W - 0.06)
    objs.append(town._finish_object("wallet_body", body, leather, 0.055, loc, rot))

    lining = bmesh.new()
    _leaf_slab(lining, W - 0.16, h_back - 0.2, 0.012, lean_back, y_centre=-th / 2 - 0.004, radius=0.08, z0=0.1)
    _leaf_slab(lining, W - 0.16, h_front - 0.2, 0.012, lean_front, y_centre=th / 2 + 0.004, radius=0.08, z0=0.1)
    objs.append(town._finish_object("wallet_lining", lining, lining_mat, 0.004, loc, rot))

    clasp = bmesh.new()
    _leaf_box(clasp, (0.0, -th / 2 - 0.012, h_front - 0.16), (0.13, 0.04, 0.075), lean_front)
    objs.append(town._finish_object("wallet_clasp", clasp, gold, 0.012, loc, rot))

    card = bmesh.new()
    first = len(card.verts)
    town._box(card, (-0.3, th / 2 + 0.03, h_front - 0.02), (0.3, 0.02, 0.3))
    rot_f = _lean(lean_front)
    for v in list(card.verts)[first:]:
        v.co = rot_f @ v.co
    objs.append(town._finish_object("wallet_card", card, town._clay_for(palette.QUILT["butter"], 0.6), 0.006, loc, rot))

    # A folded thank-you card, tent shaped, standing up out of the gap. Plain cream, no marks.
    note = bmesh.new()
    for sign in (1, -1):
        first = len(note.verts)
        town._box(note, (sign * 0.09, 0.0, 0.0), (0.18, 0.022, 0.74))
        c, s_ = math.cos(math.radians(sign * 48.0)), math.sin(math.radians(sign * 48.0))
        for v in list(note.verts)[first:]:
            v.co = Vector((v.co.x * c - v.co.y * s_ + 0.14, v.co.x * s_ + v.co.y * c + 0.10, v.co.z + 0.62))
    objs.append(town._finish_object("wallet_note", note, cream, 0.005, loc, (0.0, 0.0, yaw + math.radians(7.0))))

    # Running stitches around the front flap's outer face, in leaf space, then into the world.
    inset = 0.1
    hx, top = W / 2 - inset, h_front - inset
    corners = [(-hx, inset), (hx, inset), (hx, top), (-hx, top), (-hx, inset)]
    centres, tangents = [], []
    for (x0, z0), (x1, z1) in zip(corners[:-1], corners[1:]):
        length = math.hypot(x1 - x0, z1 - z0)
        count = int(length / 0.16)
        d = np.array([(x1 - x0) / length, 0.0, (z1 - z0) / length])
        for k in range(count):
            f = (k + 0.5) / count
            centres.append((x0 + f * (x1 - x0), -th / 2 - 0.012, z0 + f * (z1 - z0)))
            tangents.append(d)
    count = int((top - inset) / 0.16)
    for k in range(count):
        centres.append((0.0, -th / 2 - 0.012, inset + (k + 0.5) * (top - inset) / count))
        tangents.append(np.array([0.0, 0.0, 1.0]))
    rx = np.array(_lean(lean_front))
    cy_, sy_ = math.cos(yaw), math.sin(yaw)
    rz = np.array([[cy_, -sy_, 0.0], [sy_, cy_, 0.0], [0.0, 0.0, 1.0]])
    transform = rz @ rx
    world_c = np.array(centres) @ transform.T + np.array(loc)
    world_t = np.array(tangents) @ transform.T
    world_n = np.tile(transform @ np.array([0.0, -1.0, 0.0]), (len(world_c), 1))
    objs.append(town.merge_capsules("wallet_stitches", world_c, world_t, world_n, cream,
                                    np.full(len(world_c), 0.4), np.full(len(world_c), 0.6)))
    return objs


def _ellipsoid(bm, centre, radii, rot=None):
    res = bmesh.ops.create_uvsphere(bm, u_segments=14, v_segments=9, radius=1.0)
    scale = Matrix.Diagonal(Vector((radii[0], radii[1], radii[2], 1.0)))
    m = Matrix.Translation(Vector(centre)) @ (rot.to_4x4() if rot is not None else Matrix.Identity(4)) @ scale
    bmesh.ops.transform(bm, matrix=m, verts=res["verts"])


DOLL_BODY_HEIGHT = 0.5
DOLL_HEAD_RADIUS = 0.2
DOLL_HEAD_Z = DOLL_BODY_HEIGHT + 0.17


def _rot_x(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _arm(bm, shoulder, direction, length=0.3, radius=0.062):
    d = Vector(direction).normalized()
    centre = Vector(shoulder) + d * (length / 2.0)
    rot = Vector((0.0, 0.0, 1.0)).rotation_difference(d).to_matrix()
    _ellipsoid(bm, tuple(centre), (radius, radius, length / 2.0), rot)


WAVE_SHOULDER = (0.13, 0.0, 0.38)


def make_doll(name, pos, yaw, body_hex, head_hex, hair_hex, apron_hex=None, wave=False, split_wave_arm=False):
    """Peg doll about 0.87 tall: rounded cone body, round head with a clay hair cap, nub arms, pressed face.

    The face looks along local -y. With `wave` the right arm is raised. With `split_wave_arm` the raised arm is
    its own object, named `<name>_wave_arm`, so a film can swing it about WAVE_SHOULDER.
    """
    loc = (float(pos[0]), float(pos[1]), float(terrain.surface(pos[0], pos[1])) - 0.02)
    rot = (0.0, 0.0, yaw)
    body_mat = town._clay_for(body_hex, 0.55)
    head_mat = town._clay_for(head_hex, 0.5)
    hair_mat = town._clay_for(hair_hex, 0.6)
    face_mat = town._clay_for(palette.DOLL_FACE, 0.4)
    cheek_mat = town._clay_for(palette.CHEEK, 0.6)
    objs = []
    R = DOLL_HEAD_RADIUS
    hz = DOLL_HEAD_Z

    prof = [(0.0, 0.0), (0.27, 0.0), (0.265, 0.05), (0.22, 0.2), (0.17, 0.34), (0.13, 0.44), (0.11, 0.49), (0.0, 0.5)]
    v, t = lathe_arrays(prof, 24)
    objs.append(town._finish_object(name + "_body", bmesh_from_arrays(v, t), body_mat, 0.025, loc, rot))

    arms = bmesh.new()
    _arm(arms, (-0.13, 0.0, 0.38), (-0.32, 0.0, -0.95))
    if wave and split_wave_arm:
        raised = bmesh.new()
        _arm(raised, WAVE_SHOULDER, (0.75, -0.25, 0.62), length=0.34)
        objs.append(town._finish_object(name + "_wave_arm", raised, body_mat, 0.02, loc, rot))
    elif wave:
        _arm(arms, (0.13, 0.0, 0.38), (0.75, -0.25, 0.62), length=0.34)
    else:
        _arm(arms, (0.13, 0.0, 0.38), (0.32, 0.0, -0.95))
    objs.append(town._finish_object(name + "_arms", arms, body_mat, 0.02, loc, rot))

    head = bmesh.new()
    _ellipsoid(head, (0.0, 0.0, hz), (R, R, R))
    objs.append(town._finish_object(name + "_head", head, head_mat, 0.02, loc, rot))

    # Hair: a clay dome tipped back so the forehead and the face stay clear.
    dome = [(0.0, 0.0), (0.213, 0.0), (0.215, 0.05), (0.2, 0.12), (0.15, 0.185), (0.08, 0.215), (0.0, 0.225)]
    hv, ht = lathe_arrays(dome, 28)
    hv = hv @ _rot_x(-14.0).T + np.array([0.0, 0.015, hz + 0.045])
    objs.append(town._finish_object(name + "_hair", bmesh_from_arrays(hv, ht), hair_mat, 0.02, loc, rot))

    if apron_hex:
        apron = bmesh.new()
        _ellipsoid(apron, (0.0, -0.2, 0.24), (0.13, 0.055, 0.19))
        objs.append(town._finish_object(name + "_apron", apron, town._clay_for(apron_hex, 0.6), 0.02, loc, rot))

    face = bmesh.new()
    cheeks = bmesh.new()
    centre = np.array([0.0, 0.0, hz])
    for sx in (-1, 1):
        d = np.array([sx * 0.34, -0.93, 0.04])
        d /= np.linalg.norm(d)
        _ellipsoid(face, tuple(centre + (R - 0.004) * d), (0.034, 0.022, 0.04))
        d = np.array([sx * 0.62, -0.76, -0.14])
        d /= np.linalg.norm(d)
        _ellipsoid(cheeks, tuple(centre + (R - 0.006) * d), (0.042, 0.018, 0.032))
    xs = np.linspace(-0.075, 0.075, 11)
    zs = hz - 0.075 + 0.032 * (xs / 0.075) ** 2
    ys = -np.sqrt(np.maximum(R ** 2 - xs ** 2 - (zs - hz) ** 2, 0.0)) + 0.006
    smile = np.stack([xs, ys, zs], axis=-1)
    sv, st = tube_arrays(smile, 0.016, 6, up=(0.0, -1.0, 0.0))
    for tri in st:
        try:
            face.faces.new([face.verts.new(tuple(sv[k])) for k in tri])
        except ValueError:
            pass
    for label, bm, mat in (("face", face, face_mat), ("cheeks", cheeks, cheek_mat)):
        o = town._finish_object(name + "_" + label, bm, mat, 0.004, loc, rot)
        o.modifiers.clear()
        objs.append(o)
    return objs


OWNER_SPOT = (0.95, -0.85)


def build_people(buildings, story, frame=1, split_wave_arm=False):
    """The shop owner beside the shop door, waving, and the customer by house A's door looking at the wallet."""
    shop, house_a = buildings["shop"], buildings["house_a"]
    owner_pos = shop["to_world"](OWNER_SPOT[0], -shop["depth_m"] / 2 + OWNER_SPOT[1] - 0.2)
    owner_yaw = math.atan2(0.25, 1.0)
    objs = make_doll("owner", owner_pos, owner_yaw, palette.OWNER_BODY, palette.OWNER_HEAD, palette.OWNER_HAIR,
                     palette.OWNER_APRON, wave=True, split_wave_arm=split_wave_arm)

    wallet = story["wallet"]["base"]
    along = np.array([math.cos(story["wallet"]["yaw"]), math.sin(story["wallet"]["yaw"])])
    cust_pos = wallet[:2] + 1.25 * along + np.array([0.0, 0.5])
    to_wallet = wallet[:2] - cust_pos
    to_wallet /= np.linalg.norm(to_wallet)
    # Look at the wallet but keep the face turned enough toward the camera to read.
    d = 0.6 * to_wallet + 0.4 * np.array([0.0, -1.0])
    cust_yaw = math.atan2(d[0], -d[1])
    objs += make_doll("customer", cust_pos, cust_yaw, palette.CUSTOMER_BODY, palette.CUSTOMER_HEAD, palette.CUSTOMER_HAIR)
    return objs
