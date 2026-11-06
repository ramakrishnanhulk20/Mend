"""Renders the Mend hero film one frame at a time. Run with Blender in background mode:

    blender -b --python-exit-code 1 -P animate.py -- --out-dir out/preview --width 750 --height 375 --samples 24 --start 1 --end 312

The static world (ground, town, sky, spool, button) is built once. Between frames only the moving parts change:
object matrices for the needle, coin, wallet, people, trees and clouds, and small meshes for the stitches, the
frayed ends, the strand and the dents in the quilt. A frame whose PNG already exists is skipped, so an
interrupted run continues when the same command is run again. All timing lives in timeline.py.
"""
import argparse
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import build  # noqa: E402
import layout  # noqa: E402
import materials  # noqa: E402
import palette  # noqa: E402
import props  # noqa: E402
import story  # noqa: E402
import terrain  # noqa: E402
import timeline  # noqa: E402
import town  # noqa: E402

Z_UP = np.array([0.0, 0.0, 1.0])
EXIT_DISTANCE = 8.0
LEFT = np.array([-1.0, 0.0, 0.0])
TOWARD_CAMERA = np.array([0.0, -1.0, 0.0])
COIN_LEAN_DEG = 6.0
COIN_LEAN_CURVATURE = 0.04
COIN_TURN_DISTANCE = 2.5
WALLET_SLOT = (0.0, 0.14, -0.25)
FRAY_TURN, FRAY_SHORTEN, FRAY_FLATTEN, FRAY_UNCURL = 0.45, 0.2, 0.7, 0.4


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out-dir", required=True)
    p.add_argument("--width", type=int, default=750)
    p.add_argument("--height", type=int, default=375)
    p.add_argument("--samples", type=int, default=24)
    p.add_argument("--start", type=int, default=1)
    p.add_argument("--end", type=int, default=312)
    p.add_argument("--probe", action="store_true", help="print checks for the exit of the needle and stop")
    p.add_argument("--frames", default="", help="comma separated frame numbers to render instead of the start to end range")
    return p.parse_args(argv)


def move(v):
    return Matrix.Translation(Vector(tuple(float(x) for x in v)))


def about(pivot, m):
    """Apply matrix `m` as if its origin were at `pivot`."""
    return move(pivot) @ m @ move(-np.asarray(pivot, dtype=float))


def smooth01(x):
    return timeline.smoothstep(x)


def wrap_angle(a):
    return (a + math.pi) % (2.0 * math.pi) - math.pi


class FixedDraws:
    """Stand-in for a random generator that hands back numbers drawn earlier, so a rebuilt part keeps its look."""

    def __init__(self, values):
        self.values = list(values)

    def uniform(self, *_):
        return self.values.pop(0)


def pin_wobble(obj):
    """Make the hand-made wobble travel with the object instead of staying fixed in the world.

    The wobble reads its noise at world positions. A moving object would crawl through that noise, so each
    displace modifier is pointed at an empty that rides along with the object. At the starting pose the empty
    undoes the object's own matrix, so the wobble there equals the still's.
    """
    mods = [m for m in obj.modifiers if m.type == "DISPLACE"]
    if not mods:
        return
    pin = bpy.data.objects.new(obj.name + "_wobble_pin", None)
    bpy.context.scene.collection.objects.link(pin)
    pin.parent = obj
    pin.matrix_parent_inverse = obj.matrix_world.inverted()
    for m in mods:
        m.texture_coords = "OBJECT"
        m.texture_coords_object = pin


class Rig:
    """A group of objects that move together, each remembering its pose in the approved still."""

    def __init__(self, objs, pin=True):
        bpy.context.view_layer.update()
        self.objs = list(objs)
        self.base = [o.matrix_world.copy() for o in self.objs]
        if pin:
            for o in self.objs:
                pin_wobble(o)

    def apply(self, m):
        for o, b in zip(self.objs, self.base):
            o.matrix_world = m @ b

    def apply_absolute(self, m):
        for o in self.objs:
            o.matrix_world = m

    def hide(self, hidden):
        for o in self.objs:
            o.hide_render = hidden


def replace_mesh_object(slot, name, verts, tris, material):
    """Swap the mesh of a moving part: drop the old object and mesh, build the new one."""
    old = slot.get("obj")
    if old is not None:
        mesh = old.data
        bpy.data.objects.remove(old, do_unlink=True)
        bpy.data.meshes.remove(mesh)
    slot["obj"] = story.object_from_arrays(name, verts, tris, material)


class QuiltDents:
    """The twelve pressed dents where stitches go in. The ground is built without them and they grow in."""

    def __init__(self, ground, points):
        self.mesh = ground.data
        n = len(self.mesh.vertices)
        flat = np.empty(n * 3, dtype=np.float32)
        self.mesh.vertices.foreach_get("co", flat)
        self.co = flat.reshape(-1, 3)
        self.z0 = self.co[:, 2].copy()
        nx, ny = terrain.NX, terrain.NY
        dx = (terrain.X1 - terrain.X0) / (nx - 1)
        dy = (terrain.Y1 - terrain.Y0) / (ny - 1)
        reach = 3.0 * terrain.DIMPLE_RADIUS
        sets = []
        for px, py in points:
            i0 = max(0, int((px - reach - terrain.X0) / dx))
            i1 = min(nx - 1, int((px + reach - terrain.X0) / dx) + 1)
            j0 = max(0, int((py - reach - terrain.Y0) / dy))
            j1 = min(ny - 1, int((py + reach - terrain.Y0) / dy) + 1)
            ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
            sets.append((jj * nx + ii).ravel())
        self.index = np.unique(np.concatenate(sets))
        x, y = self.co[self.index, 0], self.co[self.index, 1]
        self.weight = np.stack([np.exp(-((x - px) ** 2 + (y - py) ** 2) / terrain.DIMPLE_RADIUS ** 2) for px, py in points])
        self.last = None

    def set(self, factors):
        key = tuple(round(f, 5) for f in factors)
        if key == self.last:
            return
        self.last = key
        depth = terrain.DIMPLE_DEPTH * (np.asarray(factors)[:, None] * self.weight).sum(axis=0)
        self.co[self.index, 2] = self.z0[self.index] - depth
        self.mesh.vertices.foreach_set("co", self.co.ravel())
        self.mesh.update()


class Stitching:
    """The yarn road. Two stretches never change. The six stitch arms grow, and the frayed ends settle."""

    def __init__(self, sp):
        self.sp = sp
        rng = np.random.default_rng([story.SEED, 50])
        left = story.lay_on_ground(sp["left_xy"], story.YARN_LIFT)
        right = story.lay_on_ground(sp["right_xy"], story.YARN_LIFT)
        parts = story.twisted_yarn(left, taper=(False, True), rng=rng) + story.twisted_yarn(right, taper=(True, False), rng=rng)
        verts, tris = story.merge_arrays(parts)
        self.red = materials.yarn("yarn_red", palette.YARN, 0.09)
        self.fibre_material = materials.yarn("yarn_fibre", palette.YARN, 0.16)
        self.road = story.object_from_arrays("yarn_road", verts, tris, self.red)

        # Draw the twist phase of every arm in the same order the still does, so the first five arms match it.
        self.arms = []
        for st in sp["stitches"]:
            nl, fr = st["diag1"]
            drift1 = rng.uniform(0, 6.28)
            if st["diag2"] is not None:
                fl, nr = st["diag2"]
                drift2 = rng.uniform(0, 6.28)
            else:
                fl = sp["tip"]
                nr = nl + (fr - fl)
                drift2 = None
            self.arms.append([{"from": nl, "to": fr, "bridge": 0.0, "dip": story.STITCH_DIP, "drift": drift1},
                              {"from": fl, "to": nr, "bridge": story.STITCH_BRIDGE, "dip": 0.0, "drift": drift2}])
        self.fibres = self._plan_fibres(rng)
        self.arms[2][1]["drift"] = rng.uniform(0, 6.28)
        self.arm_slot, self.fibre_slot = {}, {}
        self.arm_key = self.fibre_key = None

    def _plan_fibres(self, rng):
        """Same draws as the still: angle jitter, length, lift, radius, curl, then the two inside the fibre."""
        sp = self.sp
        out = []
        for xy, out_dir, at_end in ((sp["left_xy"], sp["gap_dir"], True), (sp["right_xy"], -sp["gap_dir"], False)):
            end = xy[-1] if at_end else xy[0]
            base_angle = math.atan2(out_dir[1], out_dir[0])
            centre = sp["stitches"][0]["centre"] if at_end else sp["stitches"][2]["centre"]
            target = math.atan2(centre[1] - end[1], centre[0] - end[0])
            for j in range(story.FRAYS_PER_END):
                angle = base_angle + (j - (story.FRAYS_PER_END - 1) / 2.0) * 0.24 + rng.uniform(-0.05, 0.05)
                length = rng.uniform(0.28, 0.42)
                lift = rng.uniform(0.02, 0.07)
                radius = rng.uniform(0.010, 0.016)
                curl = rng.uniform(0.03, 0.08)
                phase = rng.uniform(0, 6.28)
                freq = rng.uniform(0.6, 1.4)
                out.append({"end": end, "angle": angle, "turn": wrap_angle(target - angle), "length": length,
                            "lift": lift, "radius": radius, "curl": curl, "draws": (phase, freq)})
        return out

    def arm_path(self, arm, grown):
        """One arm of an X grown `grown` of the way (0 to 1). The growing head sinks into the quilt like the real end."""
        a, b = np.asarray(arm["from"], dtype=float), np.asarray(arm["to"], dtype=float)
        full = len(story._resample(np.stack([a, b]), 0.02))
        count = max(3, int(round((full - 1) * grown)) + 1)
        t = np.linspace(0.0, grown, count)
        xy = a[None, :] + (b - a)[None, :] * t[:, None]
        sink = 0.2 * (1.0 - story._smoothstep(np.minimum(t, grown - t) / 0.09))
        z = (terrain.surface(xy[:, 0], xy[:, 1]) + story.YARN_LIFT + story.STITCH_ARCH * np.sin(np.pi * t) ** 0.7
             + (arm["bridge"] - arm["dip"]) * np.sin(np.pi * t) ** 6 - sink)
        return np.stack([xy[:, 0], xy[:, 1], z], axis=-1)

    def update(self, arm_growth, settle):
        key = tuple(round(g, 5) for pair in arm_growth for g in pair)
        if key != self.arm_key:
            self.arm_key = key
            parts = []
            for pair, grown in zip(self.arms, arm_growth):
                for arm, g in zip(pair, grown):
                    if g > 0.004:
                        parts += story.twisted_yarn(self.arm_path(arm, g), rng=FixedDraws([arm["drift"]]))
            if parts:
                verts, tris = story.merge_arrays(parts)
            else:
                verts, tris = np.zeros((3, 3)), np.array([[0, 1, 2]])
            replace_mesh_object(self.arm_slot, "yarn_stitches", verts, tris, self.red)
        fkey = round(settle, 5)
        if fkey != self.fibre_key:
            self.fibre_key = fkey
            parts = []
            for f in self.fibres:
                angle = f["angle"] + f["turn"] * FRAY_TURN * settle
                start = np.array([f["end"][0], f["end"][1], 0.0])
                parts.append(story.fibre_arrays(
                    start, (math.cos(angle), math.sin(angle)), f["length"] * (1.0 - FRAY_SHORTEN * settle),
                    FixedDraws(f["draws"]), lift_end=f["lift"] * (1.0 - FRAY_FLATTEN * settle), radius=f["radius"],
                    curl=f["curl"] * (1.0 - FRAY_UNCURL * settle)))
            verts, tris = story.merge_arrays(parts)
            replace_mesh_object(self.fibre_slot, "yarn_fibres", verts, tris, self.fibre_material)


class Needle:
    """The needle, the red strand through its eye, and the road the strand hangs from."""

    def __init__(self, sp):
        self.sp = sp
        self.plan = story.plan_needle()
        self.rig = Rig(story.build_needle(self.plan), pin=False)
        self.axis, self.n, self.p = self.plan["axis"], self.plan["n"], self.plan["p"]
        self.eye_off = self.plan["eye"] - self.plan["tip"]
        r = np.array([sp["gap_dir"][0], sp["gap_dir"][1], 0.0])
        self.r = r

        def surf(xy):
            return float(terrain.surface(xy[0], xy[1]))

        corners = [st["diag2"][0] if st["diag2"] is not None else sp["tip"] for st in sp["stitches"]]
        dive = [np.array([c[0], c[1], surf(c)]) for c in corners]
        nxt = corners[2] + sp["gap_dir"] * story.STITCH_SPACING
        dive.append(np.array([nxt[0], nxt[1], surf(nxt)]))
        self.dive = dive
        end = sp["left_xy"][-1]
        road_end_z = story.lay_on_ground(sp["left_xy"], story.YARN_LIFT)[-1, 2]
        self.anchors = [np.array([end[0], end[1], road_end_z])]
        for d in dive[:3]:
            self.anchors.append(np.array([d[0], d[1], d[2] - 0.03]) + r * 0.1)
        self.strand_slot = {}
        self.strand_key = None
        self.strand_material = materials.yarn("yarn_strand", palette.YARN, 0.08)
        self.taut_after = 0.0
        self.reach = self._distance_range()
        self.taut_after = self._taut_distance()

    def tip_point(self, nd):
        i, w = nd["i"], nd["w"]
        base = self.dive[i] if w == 0.0 else self.dive[i] * (1.0 - w) + self.dive[i + 1] * w
        tip = base + Z_UP * nd["lift"]
        return tip + self.axis * (EXIT_DISTANCE * nd["leave"])

    def root_point(self, rt, leave):
        m, w = rt["m"], rt["w"]
        pt = self.anchors[m] if w == 0.0 else self.anchors[m] * (1.0 - w) + self.anchors[m + 1] * w
        return pt + self.axis * max(0.0, EXIT_DISTANCE * leave - self.taut_after)

    @staticmethod
    def cycle_of(frame):
        """Which stitch the strand belongs to. Before the first stitch it is the first, after the last the last."""
        starts = timeline.STITCH_STARTS
        return 0 if frame < starts[1] else 1 if frame < starts[2] else 2

    def _distance_range(self):
        """Shortest and longest reach from root to eye in each stitch's cycle, so every cycle goes taut at its own top."""
        starts = list(timeline.STITCH_STARTS) + [timeline.NEEDLE_LEAVE[0] + 1]
        ranges = []
        for k in range(3):
            lo = 1 if k == 0 else starts[k]
            ds = []
            for f in range(lo, starts[k + 1]):
                nd, rt = timeline.needle(f), timeline.root(f)
                tip = self.tip_point(nd)
                ds.append(float(np.linalg.norm(tip + self.eye_off - self.root_point(rt, 0.0))))
            ranges.append((min(ds), max(ds)))
        return ranges

    def _taut_distance(self):
        """How far the needle can leave before the strand is as tight as it ever gets."""
        nd, rt = timeline.needle(timeline.NEEDLE_LEAVE[0]), timeline.root(timeline.NEEDLE_LEAVE[0])
        tip0 = self.tip_point(nd)
        root0 = self.root_point(rt, 0.0)
        d_max = self.reach[2][1]
        for step in range(0, 4000):
            delta = step * 0.01
            if np.linalg.norm(tip0 + self.axis * delta + self.eye_off - root0) >= d_max - 1e-6:
                return delta
        return 0.0

    def slack(self, frame, tip, root):
        d = float(np.linalg.norm(tip + self.eye_off - root))
        d_min, d_max = self.reach[self.cycle_of(frame)]
        return 1.0 - smooth01((d - d_min) / (d_max - d_min))

    def strand_points(self, tip, root, slack):
        """Control points of the strand: out of the quilt, a slack bow, through the eye, away to the top right."""
        eye = tip + self.eye_off
        a, n, p = self.axis, self.n, self.p
        reach = eye - root
        length = float(self.plan["eye_dist"])

        def along(s):
            return root + reach * (s / length)

        ctrl = [root,
                root + Z_UP * 0.16 + LEFT * 0.05,
                along(0.7) + (LEFT * 0.55 + TOWARD_CAMERA * 0.25) * slack,
                along(1.9) + (LEFT * 0.85 + TOWARD_CAMERA * 0.35) * slack,
                along(3.2) + (LEFT * 0.55 + TOWARD_CAMERA * 0.45) * slack,
                eye - a * 0.35 + n * 0.45 + LEFT * 0.1,
                eye + n * 0.16 - a * 0.05,
                eye - n * 0.16 + a * 0.05]
        cam = layout.CAM_LOC
        view = layout._basis()[0]
        depth_eye = float((eye - cam) @ view)
        _, dir_out = layout.ray(1.06, -0.09)
        p_out = cam + dir_out * (depth_eye / float(dir_out @ view))
        mid = 0.5 * (eye + p_out) + Z_UP * 0.45 - n * 0.2
        ctrl += [eye - n * 0.5 + a * 0.35 + p * 0.45, mid, p_out]
        return np.array(ctrl)

    def update(self, frame, nd, rt):
        if nd["gone"]:
            self.rig.hide(True)
            old = self.strand_slot.pop("obj", None)
            if old is not None:
                mesh = old.data
                bpy.data.objects.remove(old, do_unlink=True)
                bpy.data.meshes.remove(mesh)
            self.strand_key = "gone"
            return
        self.rig.hide(False)
        tip = self.tip_point(nd)
        root = self.root_point(rt, nd["leave"])
        key = tuple(np.round(np.concatenate([tip, root]), 5))
        if key == self.strand_key:
            return
        self.strand_key = key
        m = Matrix.Identity(4)
        for col, vec in enumerate((self.p, self.n, self.axis)):
            for row in range(3):
                m[row][col] = float(vec[row])
        base = tip - self.axis * story.NEEDLE_BURY
        for row in range(3):
            m[row][3] = float(base[row])
        self.rig.apply_absolute(m)
        path = story._catmull(self.strand_points(tip, root, self.slack(frame, tip, root)), 0.02)
        rng = np.random.default_rng([story.SEED, 51])
        parts = story.twisted_yarn(path, story.STRAND_PLY, story.STRAND_HELIX, story.STRAND_PERIOD, around=8, rng=rng,
                                   taper=(False, False))
        verts, tris = story.merge_arrays(parts)
        replace_mesh_object(self.strand_slot, "yarn_strand", verts, tris, self.strand_material)


class Coin:
    """The coin rolling along the whole road, then hopping into the wallet."""

    def __init__(self, sp, wallet_base, wallet_yaw):
        self.rig = Rig(story.build_coin(sp))
        self.wallet_base, self.wallet_yaw = wallet_base, wallet_yaw
        left, right = sp["left_xy"], sp["right_xy"]
        g0, g1 = sp["g0"], sp["g1"]
        # The coin crosses the gap along the straight line between the two frayed ends, which runs over both arms of
        # each X. The two corners where the road meets that line are rounded off, away from the ends of the road.
        gap_steps = max(2, int(round(sp["gap_len"] / 0.02)))
        gap = g0[None, :] + (g1 - g0)[None, :] * np.linspace(0.0, 1.0, gap_steps + 1)[:, None]
        raw = np.vstack([left[:-1], gap, right[1:]])
        run = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(raw, axis=0).T))])
        soft = np.stack([story._smooth(raw[:, 0], 61), story._smooth(raw[:, 1], 61)], axis=-1)
        keep = story._smoothstep(run / 1.5) * story._smoothstep((run[-1] - run) / 1.5)
        xy = raw + (soft - raw) * keep[:, None]
        path = story.lay_on_ground(xy, story.YARN_LIFT)
        self.xy, self.z = xy, path[:, 2]
        self.s = story._arc_length(path)
        self.total = float(self.s[-1])
        sm = np.stack([story._smooth(xy[:, 0], 15), story._smooth(xy[:, 1], 15)], axis=-1)
        tang = np.gradient(sm, axis=0)
        self.heading = np.unwrap(np.arctan2(tang[:, 1], tang[:, 0]))
        ds = np.maximum(np.hypot(np.gradient(xy[:, 0]), np.gradient(xy[:, 1])), 1e-6)
        self.curvature = np.gradient(story._smooth(self.heading, 75)) / ds
        # Bump positions: where the road crosses the middle of each X, measured along the gap direction.
        along = (xy - g0[None, :]) @ sp["gap_dir"]
        self.bumps = []
        for st in sp["stitches"]:
            a_centre = float((st["centre"] - g0) @ sp["gap_dir"])
            k = int(np.argmin(np.abs(along - a_centre)))
            self.bumps.append(float(self.s[k]))
        self.bump_width = 0.6
        # The coin stands at the door turned to show its face, as in the still, swings into the road's direction, and
        # turns again to face the camera along the wallet before the hop.
        self.rest_heading = story.COIN_YAW
        self.end_state = self._state(self.total)
        self.slot = self._slot_state()

    def _bump(self, s):
        out = 0.0
        for c in self.bumps:
            u = (s - c) / self.bump_width + 0.5
            if 0.0 < u < 1.0:
                out += timeline.COIN_BUMP * 0.5 * (1.0 - math.cos(2.0 * math.pi * u))
        return out

    def _matrix(self, x, y, contact_z, heading, lean, spin):
        t = np.array([math.cos(heading), math.sin(heading), 0.0])
        n0 = np.array([t[1], -t[0], 0.0])
        n = n0 * math.cos(lean) + Z_UP * math.sin(lean)
        up = np.cross(n, t)
        R, th = story.COIN_RADIUS, story.COIN_THICK
        drop = R * math.sqrt(max(0.0, 1.0 - n[2] ** 2)) + (th / 2.0) * abs(n[2])
        m = Matrix.Identity(4)
        for col, vec in enumerate((t, up, n)):
            for row in range(3):
                m[row][col] = float(vec[row])
        m[0][3], m[1][3], m[2][3] = float(x), float(y), float(contact_z + drop - 0.012)
        return m @ Matrix.Rotation(-spin, 4, "Z")

    def _state(self, s):
        x = float(np.interp(s, self.s, self.xy[:, 0]))
        y = float(np.interp(s, self.s, self.xy[:, 1]))
        z = float(np.interp(s, self.s, self.z)) + 0.095 + self._bump(s)
        path_heading = float(np.interp(s, self.s, self.heading))
        heading = self.rest_heading + wrap_angle(path_heading - self.rest_heading) * smooth01(s / COIN_TURN_DISTANCE)
        into_wallet = smooth01((s - (self.total - COIN_TURN_DISTANCE)) / COIN_TURN_DISTANCE)
        heading = heading + wrap_angle(self.wallet_yaw - heading) * into_wallet
        kappa = float(np.interp(s, self.s, self.curvature))
        lean = math.radians(COIN_LEAN_DEG) * math.tanh(kappa / COIN_LEAN_CURVATURE)
        return self._matrix(x, y, z, heading, lean, s / story.COIN_RADIUS)

    def _slot_state(self):
        """Where the coin ends: standing between the wallet leaves, sunk low enough that the front leaf hides it."""
        base, yaw = self.wallet_base, self.wallet_yaw
        along = np.array([math.cos(yaw), math.sin(yaw)])
        back = np.array([-math.sin(yaw), math.cos(yaw)])
        xy = base[:2] + along * WALLET_SLOT[0] + back * WALLET_SLOT[1]
        m = self._matrix(xy[0], xy[1], 0.0, yaw, 0.0, self.total / story.COIN_RADIUS)
        m[2][3] = float(terrain.surface(base[0], base[1])) + WALLET_SLOT[2]
        return m

    def update(self, cn):
        if cn["hidden"]:
            self.rig.hide(True)
            return
        self.rig.hide(False)
        if cn["hop"] <= 0.0:
            state = self._state(cn["roll"] * self.total)
            self.rig.apply_absolute(state @ Matrix.Scale(max(cn["pop"], 0.001), 4))
            return
        u = cn["hop"]
        a, b = self.end_state, self.slot
        e = smooth01(u)
        quat = a.to_quaternion().slerp(b.to_quaternion(), e)
        pos = a.to_translation().lerp(b.to_translation(), u)
        pos.z += timeline.COIN_HOP_HEIGHT * 4.0 * u * (1.0 - u)
        self.rig.apply_absolute(Matrix.Translation(pos) @ quat.to_matrix().to_4x4())


class Wallet:
    """The wallet squashing when the coin lands, and the card sliding up."""

    def __init__(self, sp):
        objs = story.build_wallet(sp)
        self.card = Rig([o for o in objs if o.name == "wallet_card"])
        self.body = Rig([o for o in objs if o.name != "wallet_card"])
        base = sp["wallet"]["base"]
        self.pivot = np.array([base[0], base[1], float(terrain.surface(base[0], base[1]))])
        self.last = None

    def update(self, height, card_dz):
        key = (round(height, 5), round(card_dz, 5))
        if key == self.last:
            return
        self.last = key
        squash = about(self.pivot, Matrix.Diagonal(Vector((1.0, 1.0, height, 1.0))))
        self.body.apply(squash)
        self.card.apply(squash @ move((0.0, 0.0, card_dz)))


class People:
    """Owner waving, customer hopping and turning. Each doll is a group of small objects moved as one."""

    def __init__(self, buildings, sp):
        objs = story.build_people(buildings, sp, split_wave_arm=True)
        bpy.context.view_layer.update()
        owner = [o for o in objs if o.name.startswith("owner_")]
        self.owner_arm_obj = next(o for o in owner if o.name == "owner_wave_arm")
        self.arm = Rig([self.owner_arm_obj])
        self.customer = Rig([o for o in objs if o.name.startswith("customer_")])
        body = self.owner_arm_obj
        self.shoulder = np.array(body.matrix_world @ Vector(story.WAVE_SHOULDER))
        yaw = body.rotation_euler.z
        self.arm_axis = (Matrix.Rotation(yaw, 3, "Z") @ Vector((0.0, 1.0, 0.0))).normalized()
        cust = next(o for o in objs if o.name == "customer_body")
        self.cust_pos = np.array([cust.location.x, cust.location.y, float(terrain.surface(cust.location.x, cust.location.y))])
        self.yaw0 = cust.rotation_euler.z
        to_cam = layout.CAM_LOC[:2] - self.cust_pos[:2]
        to_cam /= np.linalg.norm(to_cam)
        self.yaw1 = self.yaw0 + wrap_angle(math.atan2(to_cam[0], -to_cam[1]) - self.yaw0)
        self.last_arm = self.last_cust = None

    def update(self, owner_deg, cust):
        key = round(owner_deg, 5)
        if key != self.last_arm:
            self.last_arm = key
            rot = Matrix.Rotation(math.radians(owner_deg), 4, self.arm_axis)
            self.arm.apply(about(self.shoulder, rot))
        ckey = (round(cust["lift"], 5), round(cust["squash"], 5), round(cust["turn"], 5))
        if ckey != self.last_cust:
            self.last_cust = ckey
            sz = 1.0 - cust["squash"]
            sx = 1.0 + 0.5 * cust["squash"]
            turn = Matrix.Rotation((self.yaw1 - self.yaw0) * cust["turn"], 4, "Z")
            m = move((0.0, 0.0, cust["lift"])) @ about(self.cust_pos, turn @ Matrix.Diagonal(Vector((sx, sx, sz, 1.0))))
            self.customer.apply(m)


class Scenery:
    """Trees swaying and clouds drifting in the ambient loop, and house A's windows lighting up."""

    def __init__(self, built):
        self.trees = []
        for k, tree in enumerate(built["trees"] + built["small_trees"]):
            rig = Rig(tree["objects"], pin=False)
            self.trees.append((rig, np.array(tree["objects"][0].location), (k * 2.399963) % (2.0 * math.pi)))
        self.clouds = [(Rig([bpy.data.objects["cloud%d" % k]], pin=False), 1.0 if k % 2 == 0 else -1.0) for k in range(4)]
        glass = bpy.data.objects["house_a_glass"]
        mat = materials.clay("window_glow_a", palette.WINDOW_GLASS, 0.25)
        self.bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        self.bsdf.inputs["Emission Color"].default_value = materials._rgba(palette.WINDOW_GLOW)
        self.bsdf.inputs["Emission Strength"].default_value = 0.0
        glass.data.materials[0] = mat
        self.last_tau = None
        self.last_glow = None

    def update(self, frame, glow):
        tau = timeline.ambient_tau(frame)
        if tau != self.last_tau:
            self.last_tau = tau
            for rig, pivot, phase in self.trees:
                deg = timeline.tree_sway_deg(frame, phase)
                rig.apply(about(pivot, Matrix.Rotation(math.radians(deg), 4, "Y")))
            drift = timeline.cloud_drift(frame)
            for rig, sign in self.clouds:
                rig.apply(move((sign * drift, 0.0, 0.0)))
        if glow != self.last_glow:
            self.last_glow = glow
            self.bsdf.inputs["Emission Strength"].default_value = 0.86 * glow


def build_world(args):
    scene = build.clear_scene()
    layout.set_aspect(args.width, args.height)
    plan = town.plan_layout()
    sp = story.plan_story(plan)
    props_plan = props.plan_props()
    footprint = story.footprint_points(sp)
    terrain.constrain_cells(footprint, forbidden=("peach",), forced=[(props_plan["button"][0], props_plan["button"][1], "butter")])
    image_path = terrain.color_image_path(os.path.join(HERE, "out"))

    dents = list(terrain.DIMPLES)
    terrain.DIMPLES[:] = []
    ground = terrain.build_terrain_object()
    far_plain = terrain.build_far_plain_object()
    terrain.DIMPLES[:] = dents
    ground_mat = materials.ground_material(image_path)
    ground.data.materials.append(ground_mat)
    far_plain.data.materials.append(ground_mat)

    layout.make_camera()
    built = town.build_town(plan, 1)
    props.build_spool(props_plan, 1)
    props.build_button(props_plan, 1)
    materials.build_world(scene, build.WORLD_STRENGTH)
    build.add_sun(scene)
    render_args = argparse.Namespace(out=os.path.join(args.out_dir, "_render.png"), width=args.width, height=args.height,
                                     samples=args.samples, frame=1)
    build.setup_render(scene, render_args)
    scene.render.use_persistent_data = True

    film = {"scene": scene, "sp": sp, "built": built}
    film["stitching"] = Stitching(sp)
    corners = []
    for near_left_arm, far_left_arm in film["stitching"].arms:
        corners += [near_left_arm["from"], far_left_arm["from"], near_left_arm["to"], far_left_arm["to"]]
    for c in corners:
        assert min(math.hypot(c[0] - d[0], c[1] - d[1]) for d in dents) < 1e-6, "corner is not one of the planned dents"
    film["dents"] = QuiltDents(ground, [(float(c[0]), float(c[1])) for c in corners])
    film["needle"] = Needle(sp)
    wallet = sp["wallet"]
    film["wallet"] = Wallet(sp)
    film["coin"] = Coin(sp, wallet["base"], wallet["yaw"])
    film["people"] = People(built["buildings"], sp)
    film["scenery"] = Scenery(built)
    return film


def set_frame(film, frame):
    p = timeline.pose(frame)
    film["dents"].set(p["dimples"])
    film["stitching"].update(p["arms"], p["fray"])
    film["needle"].update(frame, p["needle"], p["root"])
    film["coin"].update(p["coin"])
    film["wallet"].update(p["wallet"], p["card"])
    film["people"].update(p["owner"], p["customer"])
    film["scenery"].update(frame, p["glow"])


def probe(film):
    """Check that the needle and strand are fully out of the frame when the exit ends."""
    needle = film["needle"]
    nd = timeline.needle(timeline.NEEDLE_LEAVE[1])
    tip = needle.tip_point(nd)
    root = needle.root_point(timeline.root(timeline.NEEDLE_LEAVE[1]), nd["leave"])
    pts = needle.strand_points(tip, root, 0.0)
    length = needle.plan["length"]
    needle_pts = np.array([tip + needle.axis * s - needle.axis * story.NEEDLE_BURY for s in np.linspace(0.0, length, 12)])
    for label, arr in (("needle", needle_pts), ("strand controls", pts)):
        fx, fy, _ = layout.project(arr)
        print("PROBE %-16s frame x %s y %s" % (label, np.round(fx, 2), np.round(fy, 2)))
    print("PROBE root displacement %.2f, taut after %.2f, reach per stitch %s" % (
        max(0.0, EXIT_DISTANCE * nd["leave"] - needle.taut_after), needle.taut_after, np.round(needle.reach, 2).tolist()))
    print("PROBE coin path length %.2f bumps at %s" % (film["coin"].total, np.round(film["coin"].bumps, 2)))
    k = film["coin"]
    print("PROBE lean degrees along the road %s" % np.round(
        [math.degrees(math.radians(COIN_LEAN_DEG) * math.tanh(float(np.interp(s, k.s, k.curvature)) / COIN_LEAN_CURVATURE))
         for s in np.linspace(0, k.total, 17)], 1))


def main():
    t_start = time.time()
    args = parse_args()
    args.out_dir = os.path.abspath(args.out_dir)
    os.makedirs(args.out_dir, exist_ok=True)
    film = build_world(args)
    print("WORLD_READY %.1fs objects=%d" % (time.time() - t_start, len(bpy.data.objects)), flush=True)
    if args.probe:
        probe(film)
        return
    scene = film["scene"]
    tmp = os.path.join(args.out_dir, "_render.png")
    done = skipped = 0
    spent = 0.0
    frames = [int(x) for x in args.frames.split(",")] if args.frames else range(args.start, args.end + 1)
    for frame in frames:
        final = os.path.join(args.out_dir, "f_%04d.png" % frame)
        if os.path.exists(final) and os.path.getsize(final) > 0:
            skipped += 1
            continue
        t = time.time()
        set_frame(film, frame)
        scene.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        os.replace(tmp, final)
        dt = time.time() - t
        spent += dt
        done += 1
        print("FRAME %d %.1fs" % (frame, dt), flush=True)
    print("DONE rendered=%d skipped=%d seconds_per_frame=%.2f total=%.1fs" % (
        done, skipped, spent / max(done, 1), time.time() - t_start), flush=True)


if __name__ == "__main__":
    main()
