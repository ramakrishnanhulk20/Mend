"""Seven clay icons for the demo steps, one object each on a transparent background.

    blender -b --python-exit-code 1 -P icons.py -- --icon start --out out/icons/start.png --size 512 --samples 96

Names: start, regulars, plan, approve, payout, results, breakit. The builders from scenes.py and the hero are
reused, with the ground flattened to nothing.
"""
import argparse
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import materials  # noqa: E402
import palette  # noqa: E402
import props  # noqa: E402
import scenes  # noqa: E402
import story  # noqa: E402
import terrain  # noqa: E402
import town  # noqa: E402

YAW_DEG = -33.0
ELEV_DEG = 24.0
LENS_MM = 80.0
FILL = 0.8
WAX = "#DB2B17"
PADLOCK = "#3F7F9E"
PENCIL_YELLOW = palette.QUILT["butter"]
ERASER = "#F7A9B8"


def flat_ground():
    terrain.surface = lambda x, y: np.zeros(np.shape(x))


def to_camera_dir():
    y, e = math.radians(YAW_DEG), math.radians(ELEV_DEG)
    return Vector((math.sin(y) * math.cos(e), -math.cos(y) * math.cos(e), math.sin(e)))


def world_box_points(objs):
    """Every vertex of the rendered objects, after modifiers, in world space."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in objs:
        if o.hide_render:
            continue
        oe = o.evaluated_get(dg)
        me = oe.to_mesh()
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        mw = np.array(oe.matrix_world)
        out.append(co.reshape(-1, 3).astype(np.float64) @ mw[:3, :3].T + mw[:3, 3])
        oe.to_mesh_clear()
    return np.vstack(out)


def rest_on_floor(objs):
    """Move the objects together so the lowest point of the group sits at z = 0."""
    bpy.context.view_layer.update()
    lo = world_box_points(objs)[:, 2].min()
    for o in objs:
        m = o.matrix_world.copy()
        m.translation.z -= lo
        o.matrix_world = m
    bpy.context.view_layer.update()


def fit_camera(objs, extra=None):
    """Perspective camera at the three-quarter angle, backed off until the group fills 80 percent of the frame."""
    P = world_box_points(objs)
    if extra is not None:
        P = np.vstack([P, extra])
    target = Vector(((P.min(0) + P.max(0)) / 2.0).tolist())
    d = to_camera_dir()
    data = bpy.data.cameras.new("icon_camera")
    data.lens = LENS_MM
    data.sensor_width = 36.0
    data.sensor_fit = "AUTO"
    data.clip_start = 0.1
    data.clip_end = 400.0
    cam = bpy.data.objects.new("icon_camera", data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    half = 18.0 / LENS_MM
    dist = 30.0
    for _ in range(14):
        pos = target + d * dist
        quat = (target - pos).to_track_quat("-Z", "Y")
        cam.location = pos
        cam.rotation_euler = quat.to_euler()
        bpy.context.view_layer.update()
        rot = quat.to_matrix()
        right, up, back = rot @ Vector((1, 0, 0)), rot @ Vector((0, 1, 0)), rot @ Vector((0, 0, 1))
        v = P - np.array(pos)
        zc = -(v @ np.array(back))
        u = (v @ np.array(right)) / zc / half
        w = (v @ np.array(up)) / zc / half
        ext = max(u.max() - u.min(), w.max() - w.min()) / 2.0
        mid_u, mid_w = (u.max() + u.min()) / 2.0, (w.max() + w.min()) / 2.0
        scale = float(zc.mean()) * half
        target = target + right * (mid_u * scale) + up * (mid_w * scale)
        dist *= ext / FILL
    pos = target + d * dist
    cam.location = pos
    cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    return cam


def contact_shadow(cx, cy, rx, ry):
    """A soft dark teal oval under the object. It is a plane with a see-through gradient, so it keeps real alpha."""
    bm = bmesh.new()
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        bm.verts.new((sx, sy, 0.0))
    bm.faces.new(list(bm.verts))
    mesh = bpy.data.meshes.new("contact_shadow")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("contact_shadow", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = (cx, cy, -0.004)
    obj.scale = (rx, ry, 1.0)
    for flag in ("visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter", "visible_shadow"):
        setattr(obj, flag, False)

    mat, nt = materials._new_material("contact_shadow")
    out = materials._node(nt, "ShaderNodeOutputMaterial")
    clear = materials._node(nt, "ShaderNodeBsdfTransparent")
    ink = materials._node(nt, "ShaderNodeEmission")
    ink.inputs["Color"].default_value = (0.01, 0.05, 0.05, 1.0)
    ink.inputs["Strength"].default_value = 1.0
    mix = materials._node(nt, "ShaderNodeMixShader")
    coord = materials._node(nt, "ShaderNodeTexCoord")
    vec = materials._node(nt, "ShaderNodeVectorMath", operation="LENGTH")
    nt.links.new(coord.outputs["Object"], vec.inputs[0])
    soft = materials._map_range(nt, vec.outputs["Value"], 0.0, 1.0, 0.5, 0.0)
    ease = materials._math(nt, "MULTIPLY", soft.outputs["Result"], soft.outputs["Result"])
    nt.links.new(ease.outputs["Value"], mix.inputs["Fac"])
    nt.links.new(clear.outputs["BSDF"], mix.inputs[1])
    nt.links.new(ink.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    obj.data.materials.append(mat)
    return obj


def footprint(objs):
    """Centre and half sizes of the lowest slice of the group, for the contact shadow."""
    P = world_box_points(objs)
    low = P[P[:, 2] < P[:, 2].min() + 0.15 * (P[:, 2].max() - P[:, 2].min())]
    c = (low.min(0) + low.max(0)) / 2.0
    half = (low.max(0) - low.min(0)) / 2.0
    return c[0], c[1], max(half[0], 0.3), max(half[1], 0.3)


# ---------------------------------------------------------------------------------------------------------------
# The seven objects
# ---------------------------------------------------------------------------------------------------------------
def icon_start():
    """A steel needle leaning to the right, a short loop of red yarn threaded through its eye."""
    rng = np.random.default_rng([palette.SEED, 201])
    lean = math.radians(34.0)
    a = np.array([math.sin(lean), 0.0, math.cos(lean)])
    c = np.array(to_camera_dir())
    n = c - (c @ a) * a
    n /= np.linalg.norm(n)
    p = np.cross(a, n)
    eye_dist = 4.2
    base = np.array([0.0, 0.0, 0.0])
    plan = {"tip": base + a * story.NEEDLE_BURY, "eye": base + a * (eye_dist + story.NEEDLE_BURY), "axis": a, "n": n,
            "p": p, "eye_dist": eye_dist, "length": eye_dist + story.NEEDLE_BURY + story.NEEDLE_HEAD_PAST_EYE}
    objs = story.build_needle(plan)
    for o in objs:
        o.matrix_world = o.matrix_world @ Matrix.Diagonal((1.7, 1.7, 1.0, 1.0))
    eye = plan["eye"]

    def at(pp, aa, nn):
        return eye + p * pp + a * aa + n * nn

    ctrl = [at(0.02, 0.0, -0.34), at(0.0, 0.0, -0.12), at(0.0, 0.0, 0.14), at(-0.25, 0.12, 0.42),
            at(-0.82, -0.1, 0.62), at(-1.2, -0.85, 0.7), at(-1.0, -1.65, 0.6), at(-0.5, -1.95, 0.52),
            at(0.02, -1.7, 0.42), at(0.12, -1.25, 0.3)]
    path = story._catmull(np.array(ctrl), 0.02)
    thread = scenes.build_yarn("thread", [path], ply=0.05, helix=0.044, period=0.55, tapers=[(True, True)], rng=rng, around=8)
    return objs + [thread]


def icon_regulars():
    """A tiny house, butter walls, teal roof, dark windows."""
    b = town.make_house("house", 0.0, 0.0, 2.3, 1.9, 1.55, 1.0, palette.HOUSES["A"], 0.0, index=1,
                        anchor=np.array([0.0, 0.0, 0.0]), lit=False)
    for o in b["objects"]:
        for v in o.data.vertices:
            if v.co.z < 0.0:
                v.co.z = 0.0
    return b["objects"]


def icon_plan():
    """A wooden spool of red yarn with a yellow pencil leaning on it."""
    objs = props.build_spool({"spool": np.array([0.0, 0.0, 0.0])})
    theta = math.radians(-58.0)
    u = np.array([math.cos(theta), math.sin(theta), 0.0])
    alpha = math.radians(21.0)
    z = np.array([0.0, 0.0, 1.0])
    d = -math.sin(alpha) * u + math.cos(alpha) * z
    n_out = math.cos(alpha) * u + math.sin(alpha) * z
    r = 0.14
    rim = u * (props.SPOOL_FLANGE_RADIUS - 0.03) + z * (props.SPOOL_HEIGHT - 0.03)
    on_axis = rim + n_out * r
    t0 = -on_axis[2] / d[2]
    tip = on_axis + d * t0
    e1 = np.cross(z, d)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(d, e1)
    m = Matrix.Identity(4)
    for col, vec in enumerate((e1, e2, d)):
        for row in range(3):
            m[row][col] = float(vec[row])
    for row in range(3):
        m[row][3] = float(tip[row])

    yellow = town._clay_for(PENCIL_YELLOW, 0.5)
    wood = town._clay_for(palette.OWNER_HEAD, 0.6)
    lead = town._clay_for(palette.DOLL_FACE, 0.5)
    brass = scenes.brass()
    pink = town._clay_for(ERASER, 0.6)
    R, L = 0.13, 3.4
    parts = [
        ("pencil_body", [(0.0, 0.46), (R, 0.46), (R, 2.88), (0.0, 2.88)], 6, yellow, 0.012),
        ("pencil_wood", [(0.0, 0.0), (R * 0.96, 0.5), (0.0, 0.5)], 24, wood, 0.01),
        ("pencil_lead", [(0.0, 0.0), (0.05, 0.11), (0.0, 0.11)], 16, lead, 0.004),
        ("pencil_band", [(0.0, 2.86), (R + 0.012, 2.86), (R + 0.012, 3.14), (0.0, 3.14)], 24, brass, 0.01),
        ("pencil_eraser", [(0.0, 3.12), (R - 0.004, 3.12), (R - 0.004, L), (R - 0.05, L + 0.04), (0.0, L + 0.05)], 24, pink, 0.015),
    ]
    for name, prof, seg, mat, bevel in parts:
        v, t = story.lathe_arrays(prof, seg)
        o = story.object_from_arrays(name, v, t, mat)
        town.add_wobble(o, bevel)
        o.matrix_world = m
        objs.append(o)
    return objs


def icon_approve():
    """A chunky red clay wax seal with a raised cross-stitch X, tipped up toward the camera."""
    wax = materials.clay("wax_seal", WAX, roughness=0.36)
    prof = [(0.0, 0.0, 0.0), (1.46, 0.0, 1.0), (1.5, 0.05, 1.0), (1.5, 0.2, 1.0), (1.43, 0.3, 0.7), (1.26, 0.35, 0.3),
            (1.1, 0.28, 0.0), (0.0, 0.25, 0.0)]
    v, t = story.lathe_arrays(prof, 140, ridge=lambda ang: 0.065 * (0.5 + 0.5 * np.cos(7 * ang + 0.6))
                              + 0.04 * (0.5 + 0.5 * np.cos(13 * ang + 1.7)))
    seal = story.object_from_arrays("seal", v, t, wax)
    town.add_wobble(seal, 0.03)
    bar = story._stadium_outline(0.0, 0.0, 0.18, 0.82)
    bars = [story._prism_z_arrays(story._rotate_outline(bar, ang), 0.2, 0.5) for ang in (math.pi / 4, -math.pi / 4)]
    bv, bt = story.merge_arrays(bars)
    cross = story.object_from_arrays("seal_cross", bv, bt, wax)
    town.add_wobble(cross, 0.05)

    c = np.array(to_camera_dir())
    horiz = np.array([c[0], c[1], 0.0])
    horiz /= np.linalg.norm(horiz)
    tilt = math.radians(24.0)
    nrm = horiz * math.cos(tilt) + np.array([0.0, 0.0, 1.0]) * math.sin(tilt)
    h = np.cross(np.array([0.0, 0.0, 1.0]), nrm)
    h /= np.linalg.norm(h)
    y_axis = np.cross(nrm, h)
    m = Matrix.Identity(4)
    for col, vec in enumerate((h, y_axis, nrm)):
        for row in range(3):
            m[row][col] = float(vec[row])
    for o in (seal, cross):
        o.matrix_world = m
    return [seal, cross]


def icon_payout():
    """The hero's blue wallet standing half open with a gold coin half slid into the slot."""
    plan = {"wallet": {"base": np.array([0.0, 0.0, 0.0]), "yaw": 0.0}}
    objs = story.build_wallet(plan)
    note = bpy.data.objects["wallet_note"]
    objs.remove(note)
    bpy.data.objects.remove(note)
    th = story.WALLET_THICK
    lean = math.radians(-16.0)
    centre = np.array([0.08, 0.14, 0.5])
    normal = np.array([0.0, -math.cos(lean), -math.sin(lean)])
    objs += scenes.make_coin("slot_coin", centre, normal, np.array([1.0, 0.0, 0.0]), 0.86)
    return objs


def icon_results():
    """A small balance: left pan lower, three dolls and a coin on the left, three dolls on the right."""
    rng = np.random.default_rng([palette.SEED, 204])
    objs, ends, pan_r = scenes.build_balance((0.0, 0.0), -10.0, beam_half=2.15, pan_r=1.3, hang=1.7, top=4.1, string_r=0.07)
    left_c, right_c = ends[-1][1], ends[1][1]
    objs += scenes.fill_pan(left_c, [(-0.6, 0.3), (0.1, 0.55), (0.75, 0.15)], (-0.05, -0.5, 14.0, 10.0, 0.9), 0.85, rng,
                            ["#6C7BD9", "#F7A9B8", "#7A5BA8"])
    objs += scenes.fill_pan(right_c, [(-0.6, 0.25), (0.05, 0.55), (0.65, 0.1)], None, 0.85, rng,
                            ["#FFF1DC", "#E5A93B", "#3F7F9E"])
    return objs


def icon_breakit():
    """A blue clay padlock with a red yarn X tied over its front."""
    rng = np.random.default_rng([palette.SEED, 205])
    blue = town._clay_for(PADLOCK, 0.5)
    ink = town._clay_for(palette.DOLL_FACE, 0.5)
    W, H, T = 2.3, 1.75, 0.95
    front = -T / 2.0
    body = scenes.finish("lock_body", scenes.rounded_slab(W, H, T, 0.0, 0.4, step=0.14), blue, 0.12, (0.0, 0.0, 0.0),
                         (0.0, 0.0, 0.0))

    r_arc, z_arc = 0.66, H + 0.78
    pts = [(-r_arc, 0.0, H - 0.3), (-r_arc, 0.0, z_arc)]
    for k in range(1, 12):
        ang = math.pi - math.pi * k / 12.0
        pts.append((r_arc * math.cos(ang), 0.0, z_arc + r_arc * math.sin(ang)))
    pts += [(r_arc, 0.0, z_arc), (r_arc, 0.0, H - 0.3)]
    v, t = story.tube_arrays(story._catmull(np.array(pts), 0.04), 0.2, 18, up=(0.0, 1.0, 0.0))
    shackle = story.object_from_arrays("lock_shackle", v, t, blue)
    town.add_wobble(shackle, 0.02)

    collars = []
    for sx in (-1, 1):
        cv, ct = story.lathe_arrays([(0.0, H - 0.04), (0.31, H - 0.04), (0.31, H + 0.16), (0.0, H + 0.16)], 24)
        collar = story.object_from_arrays("lock_collar_%d" % sx, cv + np.array([sx * r_arc, 0.0, 0.0]), ct, blue)
        town.add_wobble(collar, 0.05)
        collars.append(collar)

    key = bmesh.new()
    town._sphere(key, (0.0, front + 0.01, 0.58), (0.17, 0.06, 0.17))
    town._box(key, (0.0, front + 0.01, 0.34), (0.1, 0.12, 0.36))
    keyhole = town._finish_object("lock_keyhole", key, ink, 0.01, (0.0, 0.0, 0.0), (0.0, 0.0, 0.0))

    zc = H / 2.0
    y_on = front - 0.1

    def strand(direction, bridge):
        xs = np.array([-1.0, -0.5, 0.0, 0.5, 1.0]) * direction
        zs = [H - 0.35, zc + 0.26, zc, zc - 0.26, 0.35]
        pts = []
        for x, z in zip(xs, zs):
            lift = bridge * math.exp(-((x / 0.3) ** 2))
            pts.append((x, y_on - lift, z))
        e0, e1 = xs[0], xs[-1]
        head = [(e0 * 1.22, front + 0.12, H - 0.3), (e0 * 1.22, 0.1, H - 0.27), (e0 * 1.2, 0.4, H - 0.24)]
        tail = [(e1 * 1.22, front + 0.12, 0.3), (e1 * 1.22, 0.1, 0.27), (e1 * 1.2, 0.4, 0.24)]
        return story._catmull(np.array(head[::-1] + pts + tail), 0.02)

    yarn = scenes.build_yarn("lock_yarn", [strand(1, 0.0), strand(-1, 0.17)], ply=0.062, helix=0.054, period=0.5, rng=rng,
                             around=10)
    knot_bm = bmesh.new()
    town._sphere(knot_bm, (0.0, 0.0, 0.0), (0.21, 0.17, 0.21))
    knot = town._finish_object("lock_knot", knot_bm, scenes.yarn_mat(), 0.02, (0.0, y_on - 0.17, zc), (0.0, 0.0, 0.0))
    return [body, shackle, keyhole, yarn, knot] + collars


ICONS = {
    "start": icon_start, "regulars": icon_regulars, "plan": icon_plan, "approve": icon_approve,
    "payout": icon_payout, "results": icon_results, "breakit": icon_breakit,
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--icon", required=True, choices=sorted(ICONS))
    p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=512)
    p.add_argument("--samples", type=int, default=96)
    p.add_argument("--no-shadow", action="store_true")
    return p.parse_args(argv)


def main():
    t_start = time.time()
    args = parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    flat_ground()
    objs = ICONS[args.icon]()
    rest_on_floor(objs)
    extra = None
    if not args.no_shadow:
        cx, cy, rx, ry = footprint(objs)
        sx, sy = cx + 0.12 * rx, cy + 0.1 * ry
        contact_shadow(sx, sy, rx * 1.35, ry * 1.35)
        ang = np.linspace(0.0, 2 * math.pi, 16, endpoint=False)
        extra = np.stack([sx + 0.8 * rx * 1.35 * np.cos(ang), sy + 0.8 * ry * 1.35 * np.sin(ang), np.zeros(16)], axis=-1)
    cam = fit_camera(objs, extra)
    materials.build_world(scene, scenes.WORLD_STRENGTH)
    scenes.add_sun(scene)
    scenes.setup_render(scene, args.size, args.size, args.samples, args.out, transparent=True)
    print("OBJECTS %d  SETUP %.1fs" % (len(bpy.data.objects), time.time() - t_start))
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print("RENDER_SECONDS %.1f" % (time.time() - t))
    print("WROTE %s" % scene.render.filepath)


if __name__ == "__main__":
    main()
