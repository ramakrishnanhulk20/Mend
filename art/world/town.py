"""The little town: hand-made houses and shop, lollipop trees, seam stitches, clouds and far hills."""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

import layout
import materials
import palette
import terrain

SEED = palette.SEED
BEVEL_WIDTH = {
    "walls": 0.06, "roof": 0.055, "door": 0.014, "frame": 0.008, "glass": 0.008,
    "sign": 0.014, "awning_a": 0.012, "awning_b": 0.012,
}
_wobble_tex = None


def _wobble_texture():
    global _wobble_tex
    if _wobble_tex is None:
        _wobble_tex = bpy.data.textures.new("hand_wobble", type="CLOUDS")
        _wobble_tex.noise_scale = 0.35
        _wobble_tex.noise_depth = 2
    return _wobble_tex


def add_wobble(obj, bevel_width=0.05, displace_only=False):
    """Bevel, then subdivide twice, then push the surface about with cloud noise so no edge stays straight.

    `displace_only` skips the bevel and subdivision for meshes that are already finely built, like wound yarn.
    """
    if not displace_only:
        bev = obj.modifiers.new("bevel", "BEVEL")
        bev.width = bevel_width
        bev.segments = 2
        bev.limit_method = "ANGLE"
        bev.angle_limit = math.radians(30.0)
        sub = obj.modifiers.new("subdivide", "SUBSURF")
        sub.levels = 2
        sub.render_levels = 2
    dis = obj.modifiers.new("hand_wobble", "DISPLACE")
    dis.texture = _wobble_texture()
    dis.texture_coords = "GLOBAL"
    dis.strength = 0.015
    dis.mid_level = 0.5


_material_cache = {}


def _clay_for(hex_color, roughness=0.5, tiles=False):
    key = (hex_color, roughness, tiles)
    if key not in _material_cache:
        name = "clay_%s_%d%s" % (hex_color.lstrip("#"), int(roughness * 100), "_tiles" if tiles else "")
        _material_cache[key] = materials.clay(name, hex_color, roughness, tiles=tiles)
    return _material_cache[key]


def _finish_object(name, bm, material, bevel_width, location, rotation, shear=(0.0, 0.0)):
    """Turn a bmesh into a scene object with the hand-made modifiers and a clay material."""
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    kx, ky = shear
    if kx or ky:
        for v in bm.verts:
            v.co.x += kx * v.co.z
            v.co.y += ky * v.co.z
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.polygons.foreach_set("use_smooth", np.ones(len(mesh.polygons), dtype=bool))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = rotation
    obj.data.materials.append(material)
    add_wobble(obj, bevel_width)
    return obj


def _box(bm, centre, size):
    cx, cy, cz = centre
    hx, hy, hz = size[0] / 2.0, size[1] / 2.0, size[2] / 2.0
    pts = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
           (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    vs = [bm.verts.new((cx + p[0], cy + p[1], cz + p[2])) for p in pts]
    for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([vs[i] for i in f])


def _extrude(bm, profile, origin, u_axis, v_axis, n_axis, length):
    """Extrude a flat convex outline along n_axis. Outline points are (a, b) on the u and v axes."""
    o, U, V, N = Vector(origin), Vector(u_axis), Vector(v_axis), Vector(n_axis)
    near = [bm.verts.new(o + U * a + V * b) for a, b in profile]
    far = [bm.verts.new(o + U * a + V * b + N * length) for a, b in profile]
    bm.faces.new(near[::-1])
    bm.faces.new(far)
    n = len(profile)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((near[i], near[j], far[j], far[i]))


def _slab(bm, a0, a1, b0, b1, thickness):
    """A thin sloping slab. a0 a1 are the high edge, b0 b1 the low edge, in the same left to right order."""
    a0, a1, b0, b1 = Vector(a0), Vector(a1), Vector(b0), Vector(b1)
    n = (a1 - a0).cross(b0 - a0).normalized()
    if n.z < 0:
        n = -n
    top = [a0, a1, b1, b0]
    vt = [bm.verts.new(p) for p in top]
    vb = [bm.verts.new(p - n * thickness) for p in top]
    bm.faces.new(vt)
    bm.faces.new(vb[::-1])
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((vt[i], vt[j], vb[j], vb[i]))


def _sphere(bm, centre, radii, u_seg=16, v_seg=10):
    res = bmesh.ops.create_uvsphere(bm, u_segments=u_seg, v_segments=v_seg, radius=1.0)
    m = Matrix.Translation(Vector(centre)) @ Matrix.Diagonal(Vector((radii[0], radii[1], radii[2], 1.0)))
    bmesh.ops.transform(bm, matrix=m, verts=res["verts"])


def _arch_profile(w, h, steps=10):
    r = w / 2.0
    zc = h - r
    pts = [(-r, 0.0), (r, 0.0)]
    for k in range(steps + 1):
        a = math.pi * k / steps
        pts.append((r * math.cos(a), zc + r * math.sin(a)))
    return pts


def _add_window(parts, cx, cz, w, h, y_wall, t):
    """Unlit dark glass with a cream frame and a cream cross, set in the front wall."""
    glass = parts("glass")
    _box(glass, (cx, y_wall - 0.004, cz), (w, 0.03, h))
    frame = parts("frame")
    yc, depth = y_wall - 0.03, 0.05
    _box(frame, (cx - (w / 2 + t / 2), yc, cz), (t, depth, h + 2 * t))
    _box(frame, (cx + (w / 2 + t / 2), yc, cz), (t, depth, h + 2 * t))
    _box(frame, (cx, yc, cz + (h / 2 + t / 2)), (w, depth, t))
    _box(frame, (cx, yc, cz - (h / 2 + t / 2)), (w, depth, t))
    _box(frame, (cx, yc - 0.005, cz), (t * 0.7, depth, h))
    _box(frame, (cx, yc - 0.005, cz), (w, depth, t * 0.7))


def _add_awning(parts, width, y_wall, stripes=6):
    """Six stripes across the front, each ending in a half-round scallop."""
    span = width - 0.2
    sw = span / stripes
    z_attach, z_front, proj = 1.18, 1.04, 0.42
    y_front = y_wall - proj
    for k in range(stripes):
        x0 = -span / 2 + k * sw
        x1 = x0 + sw
        bm = parts("awning_a" if k % 2 == 0 else "awning_b")
        _slab(bm, (x0, y_wall - 0.01, z_attach), (x1, y_wall - 0.01, z_attach),
              (x0, y_front, z_front), (x1, y_front, z_front), 0.04)
        r = sw / 2.0 * 0.97
        prof = [(r * math.cos(math.pi + math.pi * i / 10), r * math.sin(math.pi + math.pi * i / 10)) for i in range(11)]
        _extrude(bm, prof, ((x0 + x1) / 2.0, y_front + 0.02, z_front - 0.01), (1, 0, 0), (0, 0, 1), (0, -1, 0), 0.04)


def make_house(name, fx, fy, width, depth, wall_h, roof_h, colours, facing_deg,
               windows=None, door_x=0.0, shop=False, index=0, anchor=None, lit=False):
    """Build one clay building whose base sits under frame position (fx, fy). Returns a dict with its footprint.

    `anchor` is the world point to use when the layout has already been planned. `lit` makes the windows glow.
    """
    rng = np.random.default_rng([SEED, 10, index])
    if anchor is None:
        anchor = layout.ground_point(fx, fy)
    far = width < 1.0
    bevel_k = 0.5 if far else 1.0
    face = math.radians(facing_deg)
    c, s = math.cos(face), math.sin(face)

    corners_local = [(-width / 2, -depth / 2), (width / 2, -depth / 2), (width / 2, depth / 2), (-width / 2, depth / 2),
                     (0.0, 0.0), (door_x, -depth / 2 - 0.2)]
    wx = np.array([anchor[0] + c * lx - s * ly for lx, ly in corners_local])
    wy = np.array([anchor[1] + s * lx + c * ly for lx, ly in corners_local])
    ground = terrain.surface(wx, wy)
    z0 = float(np.mean(ground[:4]))
    low = float(np.min(ground)) - z0 - 0.25

    shear_deg = rng.uniform(-1.5, 1.5, 2)
    shear = (math.tan(math.radians(shear_deg[0])), math.tan(math.radians(shear_deg[1])))

    bms = {}

    def parts(key):
        if key not in bms:
            bms[key] = bmesh.new()
        return bms[key]

    y_wall = -depth / 2
    _box(parts("walls"), (0.0, 0.0, (wall_h + low) / 2.0), (width, depth, wall_h - low))

    overhang = 0.12 * (0.6 if far else 1.0)
    eave = 0.15 * (0.6 if far else 1.0)
    half_span = depth / 2 + overhang
    roof_profile = [(-half_span, 0.0), (half_span, 0.0), (half_span, eave), (0.0, roof_h + 0.04), (-half_span, eave)]
    _extrude(parts("roof"), roof_profile, (-(width / 2 + overhang), 0.0, wall_h - 0.04),
             (0, 1, 0), (0, 0, 1), (1, 0, 0), width + 2 * overhang)

    chim_x = (0.28 if not shop else -0.3) * width
    chim_h = roof_h + 0.28 * (0.6 if far else 1.0)
    chim_w = 0.2 * (0.6 if far else 1.0)
    _box(parts("walls"), (chim_x, depth * 0.1, wall_h - 0.05 + chim_h / 2.0), (chim_w, chim_w, chim_h))

    door_w = 0.2 * width
    door_h = (0.55 if shop else 0.6) * wall_h
    _extrude(parts("door"), _arch_profile(door_w, door_h), (door_x, y_wall + 0.02, -0.03),
             (1, 0, 0), (0, 0, 1), (0, -1, 0), 0.075 * (0.6 if far else 1.0))

    t = 0.028 * width
    if windows is None:
        windows = (-0.31, 0.31) if width >= 1.45 else (0.27,)
    win_w = 0.2 * width if not shop else 0.21 * width
    win_h = 0.3 * wall_h
    for wxr in windows:
        _add_window(parts, wxr * width, 0.55 * wall_h if not shop else 0.5, win_w, win_h, y_wall, t)

    if shop:
        _box(parts("sign"), (door_x, y_wall - 0.03, wall_h - 0.2), (0.95, 0.06, 0.27))
        _add_awning(parts, width, y_wall)

    slot = {"walls": colours["walls"], "roof": colours["roof"], "door": colours["door"],
            "frame": palette.WINDOW_FRAME, "glass": palette.WINDOW_GLASS, "sign": palette.SHOP["sign"],
            "awning_a": palette.SHOP["awning_a"], "awning_b": palette.SHOP["awning_b"]}
    objs = []
    for key, bm in bms.items():
        if key == "glass":
            if lit:
                mat = materials.glow_glass("window_glow", palette.WINDOW_GLASS, palette.WINDOW_GLOW, 0.86)
            else:
                mat = _clay_for(slot[key], 0.25)
        elif key == "roof":
            mat = _clay_for(slot[key], 0.5, tiles=True)
        else:
            mat = _clay_for(slot[key], 0.5)
        objs.append(_finish_object("%s_%s" % (name, key), bm, mat, BEVEL_WIDTH[key] * bevel_k,
                                   (anchor[0], anchor[1], z0), (0.0, 0.0, face), shear))

    hx, hy = width / 2 + overhang, depth / 2 + overhang
    top = wall_h + roof_h + 0.3
    box = []
    for lx in (-hx, hx):
        for ly in (-hy, hy):
            for lz in (low, top):
                box.append((anchor[0] + c * lx - s * ly, anchor[1] + s * lx + c * ly, z0 + lz))
    bfx, bfy, _ = layout.project(np.array(box))
    bbox = (float(bfx.min()), float(bfy.min()), float(bfx.max()), float(bfy.max()))

    def to_world(lx, ly):
        x = anchor[0] + c * lx - s * ly
        y = anchor[1] + s * lx + c * ly
        return np.array([x, y, float(terrain.surface(x, y))])

    return {"name": name, "x": anchor[0], "y": anchor[1], "z": z0, "fx": fx, "fy": fy, "bbox": bbox,
            "depth": float(layout.project(np.array([[anchor[0], anchor[1], z0]]))[2][0]),
            "radius": math.hypot(width, depth) / 2.0 + overhang, "objects": objs, "face": face,
            "width": width, "depth_m": depth, "wall_h": wall_h, "roof_h": roof_h, "to_world": to_world}


MAIN_HOUSES = [
    dict(name="shop", fx=0.20, fy=0.58, width=2.4, depth=1.8, wall_h=1.5, roof_h=0.9, colours=palette.SHOP,
         facing_deg=8.0, shop=True, lit=True, index=0),
    dict(name="house_a", fx=0.80, fy=0.56, width=1.5, depth=1.3, wall_h=1.0, roof_h=0.7, colours=palette.HOUSES["A"],
         facing_deg=-10.0, index=1),
    dict(name="house_b", fx=0.38, fy=0.47, width=1.3, depth=1.1, wall_h=0.9, roof_h=0.6, colours=palette.HOUSES["B"],
         facing_deg=5.0, windows=(0.27,), door_x=-0.18 * 1.3, index=2),
    dict(name="house_c", fx=0.63, fy=0.45, width=1.3, depth=1.1, wall_h=0.9, roof_h=0.6, colours=palette.HOUSES["C"],
         facing_deg=-5.0, windows=(-0.31, 0.31), index=3),
    dict(name="house_d", fx=0.90, fy=0.48, width=1.3, depth=1.1, wall_h=0.9, roof_h=0.6, colours=palette.HOUSES["D"],
         facing_deg=-14.0, windows=(-0.27,), door_x=0.18 * 1.3, lit=True, index=4),
]

FAR_HOUSE_COUNT = 8
FAR_DOORS = ["#2F8F83", "#6C7BD9", "#FFF1DC", "#F6D67E"]


def _inside_box(fx, fy, box, margin=0.0):
    return box[0] - margin <= fx <= box[2] + margin and box[1] - margin <= fy <= box[3] + margin


def plan_layout():
    """Find where every building stands and level a pad under each, before the ground mesh is built."""
    rng = np.random.default_rng([SEED, 11])
    specs = [dict(spec) for spec in MAIN_HOUSES]
    anchors = [layout.ground_point(sp["fx"], sp["fy"]) for sp in specs]
    main_pts = [(sp["fx"], sp["fy"]) for sp in specs]

    far_specs = []
    attempts = 0
    while len(far_specs) < FAR_HOUSE_COUNT and attempts < 4000:
        attempts += 1
        fx = rng.uniform(0.05, 0.96)
        fy = rng.uniform(0.285, 0.40)
        if any(_inside_box(fx, fy, box, 0.02) for box in layout.STORY_KEEPOUT):
            continue
        if any(abs(fx - px) < 0.05 and -0.03 < fy - py < 0.09 for px, py in main_pts):
            continue
        if any(math.hypot((fx - q["fx"]) * layout.ASPECT, fy - q["fy"]) < 0.11 for q in far_specs):
            continue
        k = len(far_specs)
        far_specs.append(dict(
            name="far_house_%d" % k, fx=fx, fy=fy, width=0.6, depth=0.5, wall_h=0.42, roof_h=0.28,
            colours={"walls": palette.FAR_WALLS[k % len(palette.FAR_WALLS)],
                     "roof": palette.FAR_ROOFS[(k * 2 + 1) % len(palette.FAR_ROOFS)],
                     "door": FAR_DOORS[k % len(FAR_DOORS)]},
            facing_deg=float(rng.uniform(-18.0, 18.0)), windows=(0.27,), index=20 + k))
    far_anchors = [layout.ground_point(sp["fx"], sp["fy"]) for sp in far_specs]

    for sp, a in zip(specs + far_specs, anchors + far_anchors):
        radius = math.hypot(sp["width"], sp["depth"]) / 2.0 + 0.2
        terrain.add_pad(a[0], a[1], radius)
        sp["anchor"] = a
    return specs + far_specs


def build_buildings(plan, frame=1):
    """Build every planned house. `frame` is accepted so a later order can move them; frame 1 is the still."""
    out = {}
    for sp in plan:
        kwargs = {k: v for k, v in sp.items()}
        name = kwargs.pop("name")
        out[name] = make_house(name, **kwargs)
    return out


def _segment_distance(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)))
    return math.hypot(px - (ax + t * abx), py - (ay + t * aby))


def _crown_hits_box(cx, cy, r, box, margin=0.012):
    """True when a circle (frame coordinates, x stretched by the aspect) overlaps a frame box."""
    x0, y0, x1, y1 = box[0] * layout.ASPECT - margin, box[1] - margin, box[2] * layout.ASPECT + margin, box[3] + margin
    nx = min(max(cx, x0), x1)
    ny = min(max(cy, y0), y1)
    return math.hypot(cx - nx, cy - ny) < r


def build_trees(buildings, count, fx_range, fy_range, crown_range, stream, name="tree", extra_points=(), min_gap=1.1,
                frame=1):
    """Lollipop trees at seeded frame positions, clear of buildings and of the story keep-out boxes.

    The checks use where the whole tree lands in the frame, not just its trunk base, so no crown
    covers the road, the needle or the front of a building.
    """
    rng = np.random.default_rng([SEED, stream])
    asp = layout.ASPECT
    blds = list(buildings.values())
    placed = []
    attempts = 0
    while len(placed) < count and attempts < 40000:
        attempts += 1
        fx = rng.uniform(*fx_range)
        fy = rng.uniform(*fy_range)
        crown_r = rng.uniform(*crown_range)
        trunk_h = 0.7 * crown_r + rng.uniform(0.0, 0.25)
        try:
            p = layout.ground_point(fx, fy)
        except ValueError:
            continue
        if any(math.hypot(p[0] - b["x"], p[1] - b["y"]) < b["radius"] + (1.2 if b["width"] > 1.0 else 0.5)
               for b in blds):
            continue
        if any(math.hypot(p[0] - q[0], p[1] - q[1]) < min_gap for q, _, _, _ in placed):
            continue
        if any(math.hypot(p[0] - e[0], p[1] - e[1]) < min_gap for e in extra_points):
            continue
        gz = float(terrain.surface(p[0], p[1]))
        pts = np.array([[p[0], p[1], gz], [p[0], p[1], gz + trunk_h + crown_r * 0.55],
                        [p[0], p[1], gz + trunk_h + crown_r * 1.2]])
        tfx, tfy, tdepth = layout.project(pts)
        crown_frame_r = crown_r / (tdepth[1] * (layout.SENSOR_MM / 2.0 / layout.LENS_MM) * 2.0 / layout.ASPECT)
        bad = False
        for box in layout.STORY_KEEPOUT:
            if _crown_hits_box(tfx[1] * asp, tfy[1], crown_frame_r, box) or _crown_hits_box(tfx[0] * asp, tfy[0], 0.004, box):
                bad = True
        if bad:
            continue
        for b in blds:
            if b["width"] > 1.0 and tdepth[0] < b["depth"] and _crown_hits_box(tfx[1] * asp, tfy[1], crown_frame_r, b["bbox"]):
                bad = True
        if bad:
            continue
        placed.append((p, crown_r, trunk_h, (fx, fy)))

    trees = []
    for k, (p, crown_r, trunk_h, (fx, fy)) in enumerate(placed):
        trng = np.random.default_rng([SEED, stream + 1, k])
        trunk_r = trng.uniform(0.06, 0.09) * min(1.0, crown_r / 0.5)
        gz = float(terrain.surface(p[0], p[1]))
        tilt = trng.uniform(-1.5, 1.5, 2) * math.pi / 180.0
        loc = (p[0], p[1], gz - 0.06)
        rot = (tilt[0], tilt[1], trng.uniform(0, 6.28))

        trunk = bmesh.new()
        profile = [(trunk_r * math.cos(2 * math.pi * i / 12), trunk_r * math.sin(2 * math.pi * i / 12)) for i in range(12)]
        _extrude(trunk, profile, (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1), trunk_h + 0.1)
        o1 = _finish_object("%s%02d_trunk" % (name, k), trunk, _clay_for(palette.TRUNK, 0.6), 0.02, loc, rot)

        crown = bmesh.new()
        _sphere(crown, (0, 0, trunk_h + crown_r * 0.55), (crown_r, crown_r, crown_r * 0.82))
        colour = palette.CROWNS[k % len(palette.CROWNS)]
        o2 = _finish_object("%s%02d_crown" % (name, k), crown, _clay_for(colour, 0.55), 0.02 * min(1.0, crown_r / 0.5), loc, rot)
        trees.append({"x": p[0], "y": p[1], "fx": fx, "fy": fy, "objects": [o1, o2]})
    return trees


_CAPSULE_LENGTH, _CAPSULE_RADIUS = 0.22, 0.028


def _capsule_template(around=10):
    """Vertices and triangles of one stitch lying along local x, with rounded ends."""
    r = _CAPSULE_RADIUS
    hl = _CAPSULE_LENGTH / 2.0 - r
    rings = []
    for k in (1, 2, 3):
        th = k * math.pi / 6
        rings.append((-hl - r * math.cos(th), r * math.sin(th)))
    for k in (3, 2, 1):
        th = k * math.pi / 6
        rings.append((hl + r * math.cos(th), r * math.sin(th)))
    verts = [(-hl - r, 0.0, 0.0)]
    for x, rad in rings:
        for a in range(around):
            ang = 2 * math.pi * a / around
            verts.append((x, rad * math.cos(ang), rad * math.sin(ang)))
    verts.append((hl + r, 0.0, 0.0))
    tris = []
    first = 1
    for a in range(around):
        tris.append((0, first + (a + 1) % around, first + a))
    for ring in range(len(rings) - 1):
        for a in range(around):
            a2 = (a + 1) % around
            p0, p1 = first + ring * around + a, first + ring * around + a2
            q0, q1 = first + (ring + 1) * around + a, first + (ring + 1) * around + a2
            tris.append((p0, p1, q1))
            tris.append((p0, q1, q0))
    last = first + (len(rings) - 1) * around
    end = len(verts) - 1
    for a in range(around):
        tris.append((end, last + a, last + (a + 1) % around))
    return np.array(verts, dtype=np.float64), np.array(tris, dtype=np.int64)


def merge_capsules(name, centres, tangents, normals, material, length_k=None, radius_k=None):
    """One mesh object holding many capsules: centres, unit tangents and unit surface normals, all (N, 3)."""
    n = len(centres)
    side = np.cross(normals, tangents)
    rot = np.stack([tangents, side, normals], axis=-1)
    verts_t, tris_t = _capsule_template()
    length_k = np.ones(n) if length_k is None else length_k
    radius_k = np.ones(n) if radius_k is None else radius_k
    scale = np.stack([length_k, radius_k, radius_k], axis=-1)
    local = verts_t[None, :, :] * scale[:, None, :]
    world = np.einsum("nij,nvj->nvi", rot, local) + centres[:, None, :]
    nv = len(verts_t)
    faces = (tris_t[None, :, :] + (np.arange(n) * nv)[:, None, None]).reshape(-1, 3)
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(n * nv)
    mesh.vertices.foreach_set("co", world.reshape(-1, 3).astype(np.float32).ravel())
    mesh.loops.add(len(faces) * 3)
    mesh.polygons.add(len(faces))
    mesh.loops.foreach_set("vertex_index", faces.astype(np.int32).ravel())
    mesh.polygons.foreach_set("loop_start", np.arange(0, len(faces) * 3, 3, dtype=np.int32))
    mesh.polygons.foreach_set("use_smooth", np.ones(len(faces), dtype=bool))
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def build_stitches(buildings, frame=1):
    """One cream capsule every 0.34 units along every seam in view, merged into a single mesh object."""
    blds = list(buildings.values())

    def keep(x, y):
        z = terrain.surface(x, y)
        fxs, fys, depth = layout.project(np.stack([x, y, z], axis=-1))
        ok = (fxs > -0.08) & (fxs < 1.08) & (fys > 0.1) & (fys < 1.12) & (depth > 1.0)
        for b in blds:
            ok &= np.hypot(x - b["x"], y - b["y"]) > b["radius"] * 0.95
        return ok

    px, py, tx, ty = terrain.seam_stitch_points(0.34, keep)
    rng = np.random.default_rng([SEED, 30])
    n = len(px)
    pz = terrain.surface(px, py)
    normal = terrain.surface_normal(px, py)
    jitter = rng.uniform(-0.2, 0.2, n)
    cj, sj = np.cos(jitter), np.sin(jitter)
    tx2, ty2 = tx * cj - ty * sj, tx * sj + ty * cj
    tang = np.stack([tx2, ty2, np.zeros(n)], axis=-1)
    tang -= normal * np.sum(tang * normal, axis=-1, keepdims=True)
    tang /= np.linalg.norm(tang, axis=-1, keepdims=True)
    centre = np.stack([px, py, pz], axis=-1) + normal * (_CAPSULE_RADIUS * 0.55)
    obj = merge_capsules("seam_stitches", centre, tang, normal, materials.stitch_material(),
                         rng.uniform(0.92, 1.1, n), rng.uniform(0.95, 1.08, n))
    return obj, n


CLOUD_FRAMES = [(0.13, 0.075), (0.40, 0.05), (0.665, 0.085), (0.885, 0.055)]
FAR_HILLS = [(-13.0, 24.0, 10.0, 4.4, 4.4, 0), (3.0, 26.0, 12.0, 4.5, 5.0, 1), (17.0, 22.0, 9.0, 4.0, 3.8, 0)]


def build_sky_set(frame=1):
    """Backdrop wall, four clay clouds in front of it and three far hills. Returns the backdrop object."""
    bm = bmesh.new()
    corners = [(-60.0, 34.0, -8.0), (60.0, 34.0, -8.0), (60.0, 34.0, 40.0), (-60.0, 34.0, 40.0)]
    vs = [bm.verts.new(c) for c in corners]
    bm.faces.new(vs)
    mesh = bpy.data.meshes.new("backdrop")
    bm.to_mesh(mesh)
    bm.free()
    wall = bpy.data.objects.new("backdrop", mesh)
    bpy.context.scene.collection.objects.link(wall)
    wall.data.materials.append(materials.sky_material())
    wall.visible_shadow = False

    cloud_mat = materials.clay("cloud_puff", palette.CLOUD, 0.75, glow=0.72, albedo=0.18)
    for k, (fx, fy) in enumerate(CLOUD_FRAMES):
        rng = np.random.default_rng([SEED, 40, k])
        centre = layout.plane_point(fx, fy, 33.0)
        cbm = bmesh.new()
        n = int(rng.integers(5, 9))
        span = rng.uniform(5.5, 8.0)
        for i in range(n):
            t = i / (n - 1)
            r = 1.3 * (1.0 - 0.55 * abs(2 * t - 1)) * rng.uniform(0.85, 1.15)
            _sphere(cbm, ((t - 0.5) * span, rng.uniform(-0.4, 0.4), 0.45 * r * (1 - abs(2 * t - 1)) + rng.uniform(-0.1, 0.1)),
                    (r, r * 0.8, r * 0.6))
        _finish_object("cloud%d" % k, cbm, cloud_mat, 0.05, tuple(centre), (0.0, 0.0, 0.0))

    for k, (x, y, sx, sy, top, which) in enumerate(FAR_HILLS):
        hbm = bmesh.new()
        sz = top + 1.5
        _sphere(hbm, (0.0, 0.0, 0.0), (sx, sy, sz), u_seg=40, v_seg=20)
        _finish_object("far_hill%d" % k, hbm, _clay_for(palette.FAR_HILLS[which], 0.7), 0.05, (x, y, top - sz),
                       (0.0, 0.0, 0.0))
    return wall


def build_town(plan, frame=1):
    """Houses, far houses, trees, stitches, clouds and hills. Story props are built by story.py and props.py."""
    buildings = build_buildings(plan, frame)
    main = {k: v for k, v in buildings.items() if v["width"] > 1.0}
    far = [v for v in buildings.values() if v["width"] <= 1.0]
    trees = build_trees(buildings, 14, (0.02, 0.98), (0.40, 0.76), (0.35, 0.7), 20, name="tree", frame=frame)
    far_pts = [(v["x"], v["y"]) for v in far]
    small = build_trees(buildings, 12, (0.03, 0.97), (0.285, 0.43), (0.2, 0.34), 60, name="small_tree",
                        extra_points=far_pts, min_gap=0.8, frame=frame)
    stitches, count = build_stitches(buildings, frame)
    wall = build_sky_set(frame)
    return {"buildings": buildings, "main": main, "far": far, "trees": trees, "small_trees": small,
            "stitches": stitches, "stitch_count": count, "backdrop": wall}
