"""Sewing landmarks: a wooden spool wound with red yarn on the left rear mound, and a mint four-hole button
lying flat like a pond. Every builder takes `frame` so a later order can animate it; frame 1 is the still."""
import math

import bmesh
import numpy as np
from mathutils import Matrix

import layout
import materials
import palette
import story
import terrain
import town

SPOOL_FRAME = (0.09, 0.40)
SPOOL_HEIGHT = 2.2
SPOOL_FLANGE_RADIUS = 0.95
BUTTON_FRAME = (0.90, 0.70)
BUTTON_RADIUS = 0.55
HOLE_OFFSET = 0.18
HOLE_RADIUS = 0.095


def plan_props():
    """Find where the spool and button stand and level the ground under the spool."""
    spool = layout.ground_point(*SPOOL_FRAME)
    terrain.add_pad(spool[0], spool[1], SPOOL_FLANGE_RADIUS + 0.15)
    button = layout.ground_point(*BUTTON_FRAME)
    return {"spool": spool, "button": button}


def build_spool(plan, frame=1):
    """Wooden spool 2.2 tall with a drum of wound red yarn between two flanges, and a loose end trailing down."""
    rng = np.random.default_rng([palette.SEED, 70])
    base = plan["spool"]
    z0 = float(terrain.surface(base[0], base[1])) - 0.04
    loc = (float(base[0]), float(base[1]), z0)
    tilt = rng.uniform(-1.5, 1.5, 2)
    shear = (math.tan(math.radians(tilt[0])), math.tan(math.radians(tilt[1])))
    H, FR, FT = SPOOL_HEIGHT, SPOOL_FLANGE_RADIUS, 0.17
    wood = town._clay_for(palette.SPOOL_WOOD, 0.6)
    profile = [(0.0, 0.0), (FR, 0.0), (FR, FT), (0.5, FT), (0.5, H - FT), (FR, H - FT), (FR, H), (0.0, H)]
    wv, wt = story.lathe_arrays(profile, 48)
    objs = [town._finish_object("spool_wood", story.bmesh_from_arrays(wv, wt), wood, 0.03, loc, (0.0, 0.0, 0.0), shear)]

    zs = np.arange(FT, H - FT + 1e-6, 0.012)
    rings = [(0.0, FT - 0.01)] + [(0.8 + 0.03 * math.cos(2 * math.pi * (z - FT) / 0.14), float(z)) for z in zs] + [(0.0, H - FT + 0.01)]
    yv, yt = story.lathe_arrays(rings, 64)
    yv = yv + np.array([0.0, 0.0, 0.0])
    for v in yv:
        v[0] += shear[0] * v[2]
        v[1] += shear[1] * v[2]
    yarn_obj = story.object_from_arrays("spool_yarn", yv, yt, materials.yarn("spool_wound", palette.YARN, 0.08))
    yarn_obj.location = loc
    town.add_wobble(yarn_obj, 0.0, displace_only=True)
    objs.append(yarn_obj)

    # A loose end comes off the drum, runs down over the flange and curls on the ground.
    a = math.radians(-82.0)
    ca, sa = math.cos(a), math.sin(a)
    radial = [(0.84, 1.15), (0.87, 0.7), (0.99, 0.32), (1.08, 0.12)]
    pts = [np.array([base[0] + r * ca, base[1] + r * sa, z0 + z]) for r, z in radial]
    for k, (dx, dy) in enumerate([(0.3, -0.2), (0.6, -0.15), (0.9, 0.0), (1.15, 0.2)]):
        px = base[0] + 1.08 * ca + dx
        py = base[1] + 1.08 * sa + dy
        pts.append(np.array([px, py, float(terrain.surface(px, py)) + 0.05]))
    path = story._catmull(np.array(pts), 0.02)
    path[:, 2] = np.maximum(path[:, 2], terrain.surface(path[:, 0], path[:, 1]) + 0.045)
    parts = story.twisted_yarn(path, 0.035, 0.03, 0.4, around=8, rng=rng)
    v, t = story.merge_arrays(parts)
    objs.append(story.object_from_arrays("spool_tail", v, t, materials.yarn("spool_wound", palette.YARN, 0.08)))
    return objs


def build_button(plan, frame=1):
    """Large mint four-hole button, radius 0.55, lying flat like a pond."""
    base = plan["button"]
    xs = base[0] + np.array([-BUTTON_RADIUS, BUTTON_RADIUS, 0, 0])
    ys = base[1] + np.array([0, 0, -BUTTON_RADIUS, BUTTON_RADIUS])
    z0 = float(np.max(terrain.surface(np.append(xs, base[0]), np.append(ys, base[1])))) - 0.025
    loc = (float(base[0]), float(base[1]), z0)
    R = BUTTON_RADIUS
    seg = 64
    dish_z = 0.075
    profile = [(R, 0.0), (R, 0.10), (R - 0.05, 0.14), (R - 0.12, 0.12), (R - 0.17, dish_z)]
    bm = bmesh.new()
    angles = [2 * math.pi * k / seg for k in range(seg)]
    rings = [[bm.verts.new((r * math.cos(a), r * math.sin(a), z)) for a in angles] for r, z in profile]
    for i in range(len(rings) - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))

    def edge_loop(verts):
        return [bm.edges.get((verts[k], verts[(k + 1) % len(verts)])) or bm.edges.new((verts[k], verts[(k + 1) % len(verts)]))
                for k in range(len(verts))]

    hole_top, hole_bottom = [], []
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx, cy = sx * HOLE_OFFSET, sy * HOLE_OFFSET
            ha = [2 * math.pi * k / 16 for k in range(16)]
            hole_top.append([bm.verts.new((cx + HOLE_RADIUS * math.cos(a), cy + HOLE_RADIUS * math.sin(a), dish_z)) for a in ha])
            hole_bottom.append([bm.verts.new((cx + HOLE_RADIUS * math.cos(a), cy + HOLE_RADIUS * math.sin(a), 0.0)) for a in ha])
    for top, bottom in zip(hole_top, hole_bottom):
        for k in range(16):
            k2 = (k + 1) % 16
            bm.faces.new((top[k], bottom[k], bottom[k2], top[k2]))
    top_edges = edge_loop(rings[-1])
    bottom_edges = edge_loop(rings[0])
    for loop in hole_top:
        top_edges += edge_loop(loop)
    for loop in hole_bottom:
        bottom_edges += edge_loop(loop)
    bmesh.ops.triangle_fill(bm, edges=top_edges, use_beauty=True)
    bmesh.ops.triangle_fill(bm, edges=bottom_edges, use_beauty=True)
    mat = town._clay_for(palette.BUTTON, 0.5)
    obj = town._finish_object("button", bm, mat, 0.02, loc, (0.0, 0.0, 0.0))
    return [obj]
