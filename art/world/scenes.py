"""Four clay dioramas for the How it works section, in the same world as the hero.

    blender -b --python-exit-code 1 -P scenes.py -- --scene 1 --out out/scenes/how-1.png --width 1600 --height 1200 --samples 128

The hero modules are only imported. The ground is replaced here by a small quilt with a few big patches, so
`terrain.surface` is pointed at that quilt for this process, and everything the hero builders place on the
ground follows it.
"""
import argparse
import math
import os
import sys
import time
import zlib
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import materials  # noqa: E402
import palette  # noqa: E402
import story  # noqa: E402
import terrain  # noqa: E402
import town  # noqa: E402

SUN_ELEVATION_DEG = 24.0
SUN_AZIMUTH_DEG = 35.0
SUN_STRENGTH = 2.1
WORLD_STRENGTH = 0.58
LENS_MM = 50.0
SENSOR_MM = 36.0

GROUND_X = (-13.0, 13.0)
GROUND_STEP = 0.04
PPU = 140


# ---------------------------------------------------------------------------------------------------------------
# The quilt: a few big pillowed patches
# ---------------------------------------------------------------------------------------------------------------
class Quilt:
    """Patches cut by straight seams in a slightly turned and warped grid. `grid[i][j]` names each patch colour."""

    def __init__(self, rot_deg, u_cuts, v_cuts, grid, wall_y):
        self.th = math.radians(rot_deg)
        self.u_cuts = np.array(sorted(u_cuts), dtype=np.float64)
        self.v_cuts = np.array(sorted(v_cuts), dtype=np.float64)
        self.names = list(palette.QUILT.keys())
        self.table = np.array([[self.names.index(c) for c in row] for row in grid], dtype=np.int64)
        self.wall_y = wall_y
        self.y_max = wall_y - 1.6
        self.fade = (wall_y - 4.8, wall_y - 2.4)

    def warp(self, x, y):
        c, s = math.cos(self.th), math.sin(self.th)
        xr = x * c - y * s
        yr = x * s + y * c
        return (xr + terrain.WARP_AMP * np.sin(terrain.WARP_FU * yr + terrain.WARP_PU),
                yr + terrain.WARP_AMP * np.sin(terrain.WARP_FV * xr + terrain.WARP_PV))

    def unwarp(self, u, v):
        xr, yr = u, v
        for _ in range(12):
            xr = u - terrain.WARP_AMP * np.sin(terrain.WARP_FU * yr + terrain.WARP_PU)
            yr = v - terrain.WARP_AMP * np.sin(terrain.WARP_FV * xr + terrain.WARP_PV)
        c, s = math.cos(self.th), math.sin(self.th)
        return xr * c + yr * s, -xr * s + yr * c

    def locate(self, x, y):
        u, v = self.warp(np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64))
        iu = np.searchsorted(self.u_cuts, u)
        iv = np.searchsorted(self.v_cuts, v)
        d = np.full(np.shape(u), 99.0)
        for c in self.u_cuts:
            d = np.minimum(d, np.abs(u - c))
        for c in self.v_cuts:
            d = np.minimum(d, np.abs(v - c))
        return iu, iv, d

    def colour_index(self, x, y):
        iu, iv, _ = self.locate(x, y)
        return self.table[iu, iv]

    def height(self, x, y):
        _, _, d = self.locate(x, y)
        y = np.asarray(y, dtype=np.float64)
        return terrain.pillow(d) * (1.0 - terrain._smooth(self.fade[0], self.fade[1], y))


def install_ground(quilt):
    """Point the hero's height function at this quilt for the rest of the process."""
    def surface(x, y):
        return quilt.height(x, y)
    terrain.surface = surface


def write_colour_image(quilt, path, x0, x1, y0, y1):
    names = quilt.names
    lut = np.array([[round(c * 255) for c in palette.hex_to_rgb(palette.QUILT[n])] for n in names], dtype=np.float32)
    w = int((x1 - x0) * PPU)
    h = int((y1 - y0) * PPU)
    rng = np.random.default_rng([palette.SEED, 2])
    comp = zlib.compressobj(2)
    idat = []
    xs = x0 + (np.arange(w) + 0.5) / w * (x1 - x0)
    for r0 in range(0, h, 128):
        r1 = min(h, r0 + 128)
        n = r1 - r0
        ys = y1 - (np.arange(r0, r1) + 0.5) / h * (y1 - y0)
        X, Y = np.meshgrid(xs, ys)
        rgb = lut[quilt.colour_index(X, Y)]
        fine = rng.normal(0.0, 0.022, size=(n, w)).astype(np.float32)
        coarse = rng.normal(0.0, 0.020, size=(n // 3 + 1, w // 3 + 1)).astype(np.float32)
        coarse = np.repeat(np.repeat(coarse, 3, axis=0), 3, axis=1)[:n, :w]
        lum = 1.0 + fine + coarse
        nfleck = int(n * w * 0.00045)
        fy = rng.integers(0, n, nfleck)
        fx = rng.integers(0, w, nfleck)
        ang = rng.uniform(0, np.pi, nfleck)
        length = rng.integers(3, 9, nfleck)
        dark = rng.uniform(0.10, 0.22, nfleck).astype(np.float32)
        for t in range(8):
            live = t < length
            px = np.clip((fx + np.cos(ang) * t).astype(np.int64), 0, w - 1)[live]
            py = np.clip((fy + np.sin(ang) * t).astype(np.int64), 0, n - 1)[live]
            lum[py, px] *= 1.0 - dark[live]
            lum[np.clip(py + 1, 0, n - 1), px] *= 1.0 - 0.5 * dark[live]
        out = np.clip(rgb * lum[..., None], 0, 255).astype(np.uint8)
        raw = np.zeros((n, 1 + w * 3), dtype=np.uint8)
        raw[:, 1:] = out.reshape(n, w * 3)
        idat.append(comp.compress(raw.tobytes()))
    idat.append(comp.flush())
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(terrain._png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        fh.write(terrain._png_chunk(b"IDAT", b"".join(idat)))
        fh.write(terrain._png_chunk(b"IEND", b""))


def ground_material(image_path, x1, y1, name="quilt_felt"):
    """Felted wool, the same recipe as the hero ground, fading to the far hill colour at the mesh edge."""
    mat, nt = materials._new_material(name)
    out = materials._node(nt, "ShaderNodeOutputMaterial")
    bsdf = materials._node(nt, "ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    uv = materials._node(nt, "ShaderNodeUVMap", uv_map="UV")
    img = materials._node(nt, "ShaderNodeTexImage", interpolation="Linear", extension="EXTEND")
    img.image = bpy.data.images.load(image_path)
    img.image.colorspace_settings.name = "sRGB"
    nt.links.new(uv.outputs["UV"], img.inputs["Vector"])
    coord = materials._node(nt, "ShaderNodeTexCoord")
    sep = materials._node(nt, "ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    far_y = materials._map_range(nt, sep.outputs["Y"], y1 - 1.6, y1 - 0.2)
    ax = materials._math(nt, "ABSOLUTE", sep.outputs["X"])
    far_x = materials._map_range(nt, ax.outputs["Value"], GROUND_X[1] - 1.5, GROUND_X[1] - 0.2)
    far = materials._math(nt, "MAXIMUM", far_y.outputs["Result"], far_x.outputs["Result"])
    colour, _ = materials._mix_colour(nt, far.outputs["Value"], img.outputs["Color"], materials._rgba(palette.FAR_HILLS[0]))
    nt.links.new(colour, bsdf.inputs["Base Color"])

    lumps = materials._node(nt, "ShaderNodeTexNoise")
    lumps.inputs["Scale"].default_value = 13.0
    lumps.inputs["Detail"].default_value = 3.0
    nt.links.new(coord.outputs["Object"], lumps.inputs["Vector"])
    bump_a = materials._node(nt, "ShaderNodeBump")
    bump_a.inputs["Strength"].default_value = 0.25
    bump_a.inputs["Distance"].default_value = 0.03
    nt.links.new(lumps.outputs["Factor"], bump_a.inputs["Height"])
    fibre = materials._node(nt, "ShaderNodeTexNoise")
    fibre.inputs["Scale"].default_value = 70.0
    fibre.inputs["Detail"].default_value = 4.0
    fibre.inputs["Roughness"].default_value = 0.65
    nt.links.new(coord.outputs["Object"], fibre.inputs["Vector"])
    bump_b = materials._node(nt, "ShaderNodeBump")
    bump_b.inputs["Strength"].default_value = 0.45
    bump_b.inputs["Distance"].default_value = 0.012
    nt.links.new(fibre.outputs["Factor"], bump_b.inputs["Height"])
    nt.links.new(bump_a.outputs["Normal"], bump_b.inputs["Normal"])
    nt.links.new(bump_b.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Sheen Weight"].default_value = 0.6
    bsdf.inputs["Sheen Roughness"].default_value = 0.45
    bsdf.inputs["Sheen Tint"].default_value = (1.0, 0.96, 0.9, 1.0)
    bsdf.inputs["Specular IOR Level"].default_value = 0.2
    return mat


def _grid_mesh(name, X, Y, Z, extent):
    nx, ny = X.shape[1], X.shape[0]
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
    x0, x1, y0, y1 = extent
    u = ((X - x0) / (x1 - x0)).ravel().astype(np.float32)
    v = ((Y - y0) / (y1 - y0)).ravel().astype(np.float32)
    uv = np.stack([u[quads], v[quads]], axis=-1).reshape(-1)
    mesh.uv_layers.new(name="UV").data.foreach_set("uv", uv)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_ground(quilt, tag, y_min=-9.0):
    """Fine pillowed quilt in front, a flat coarse plain behind it up to the backdrop. Returns the mesh objects."""
    x0, x1 = GROUND_X
    y0, y1 = y_min, quilt.y_max
    cache = os.path.join(HERE, "out", "scenes", "_cache")
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, "quilt_%s.png" % tag)
    t = time.time()
    write_colour_image(quilt, path, x0, x1, y0, y1)
    print("COLOUR_IMAGE %.1fs" % (time.time() - t))
    mat = ground_material(path, x1, y1)

    xs = np.arange(x0, x1 + 1e-6, GROUND_STEP)
    ys = np.arange(y0, y1 + 1e-6, GROUND_STEP)
    X, Y = np.meshgrid(xs, ys)
    fine = _grid_mesh("quilt_ground", X, Y, quilt.height(X, Y), (x0, x1, y0, y1))
    fine.data.materials.append(mat)

    px = np.linspace(-80.0, 80.0, 200)
    py = np.linspace(y1 - 0.3, quilt.wall_y + 2.0, 24)
    PX, PY = np.meshgrid(px, py)
    plain = _grid_mesh("far_plain", PX, PY, np.full_like(PX, -0.02), (x0, x1, y0, y1))
    plain.data.materials.append(mat)
    return [fine, plain]


def seam_stitches(quilt, exclusions, y_lo=-8.6):
    """Cream capsules every 0.34 units along every seam, clear of the exclusion circles (x, y, radius)."""
    rng = np.random.default_rng([palette.SEED, 3])
    spacing = 0.34
    span = np.arange(-60.0, 60.0, 0.02)
    xs, ys, txs, tys = [], [], [], []

    def keep(x, y):
        ok = (np.abs(x) < GROUND_X[1] - 1.0) & (y > y_lo) & (y < quilt.y_max - 0.4)
        for cx, cy, r in exclusions:
            ok &= np.hypot(x - cx, y - cy) > r
        return ok

    def walk(pu, pv):
        x, y = quilt.unwarp(pu, pv)
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
        xs.append(px[mask])
        ys.append(py[mask])
        txs.append((ax / np.where(norm > 0, norm, 1))[mask])
        tys.append((ay / np.where(norm > 0, norm, 1))[mask])

    for c in quilt.u_cuts:
        walk(np.full_like(span, c), span)
    for c in quilt.v_cuts:
        walk(span, np.full_like(span, c))
    px, py = np.concatenate(xs), np.concatenate(ys)
    tx, ty = np.concatenate(txs), np.concatenate(tys)
    n = len(px)
    pz = terrain.surface(px, py)
    normal = terrain.surface_normal(px, py)
    jitter = rng.uniform(-0.2, 0.2, n)
    cj, sj = np.cos(jitter), np.sin(jitter)
    tang = np.stack([tx * cj - ty * sj, tx * sj + ty * cj, np.zeros(n)], axis=-1)
    tang -= normal * np.sum(tang * normal, axis=-1, keepdims=True)
    tang /= np.linalg.norm(tang, axis=-1, keepdims=True)
    centre = np.stack([px, py, pz], axis=-1) + normal * (town._CAPSULE_RADIUS * 0.55)
    obj = town.merge_capsules("seam_stitches", centre, tang, normal, materials.stitch_material(),
                              rng.uniform(0.92, 1.1, n), rng.uniform(0.95, 1.08, n))
    print("SEAM_STITCHES %d" % n)
    return obj


# ---------------------------------------------------------------------------------------------------------------
# Set: backdrop, sun, camera, render
# ---------------------------------------------------------------------------------------------------------------
def sky_material(wall_z0, wall_z1, name="sky_backdrop"):
    """The hero's painted sky: peach at the bottom, pale teal above, with soft brush noise."""
    mat, nt = materials._new_material(name)
    out = materials._node(nt, "ShaderNodeOutputMaterial")
    emit = materials._node(nt, "ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 0.96
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    coord = materials._node(nt, "ShaderNodeTexCoord")
    sep = materials._node(nt, "ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    stretch = materials._node(nt, "ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = (3.0, 1.0, 16.0)
    nt.links.new(coord.outputs["Generated"], stretch.inputs["Vector"])
    brush = materials._node(nt, "ShaderNodeTexNoise")
    brush.inputs["Scale"].default_value = 2.2
    brush.inputs["Detail"].default_value = 5.0
    brush.inputs["Distortion"].default_value = 0.6
    nt.links.new(stretch.outputs["Vector"], brush.inputs["Vector"])
    centred = materials._math(nt, "SUBTRACT", brush.outputs["Factor"], 0.5)
    shift = materials._math(nt, "MULTIPLY", centred.outputs["Value"], 0.05)
    height = materials._math(nt, "ADD", sep.outputs["Z"], shift.outputs["Value"])
    ramp = materials._node(nt, "ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    ramp.color_ramp.elements[0].position = wall_z0
    ramp.color_ramp.elements[0].color = materials._rgba(palette.SKY_HORIZON)
    ramp.color_ramp.elements[1].position = wall_z1
    ramp.color_ramp.elements[1].color = materials._rgba(palette.SKY_TOP)
    nt.links.new(height.outputs["Value"], ramp.inputs["Factor"])
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    return mat


def build_backdrop(wall_y, hill_x=2.5):
    """A painted sky wall standing behind the quilt and one soft teal hill in front of it."""
    z_lo, z_hi = -1.0, 11.0
    bm = bmesh.new()
    vs = [bm.verts.new(c) for c in [(-90.0, wall_y, z_lo), (90.0, wall_y, z_lo), (90.0, wall_y, z_hi), (-90.0, wall_y, z_hi)]]
    bm.faces.new(vs)
    mesh = bpy.data.meshes.new("backdrop")
    bm.to_mesh(mesh)
    bm.free()
    wall = bpy.data.objects.new("backdrop", mesh)
    bpy.context.scene.collection.objects.link(wall)
    span = z_hi - z_lo
    wall.data.materials.append(sky_material((0.0 - z_lo) / span, (2.9 - z_lo) / span))
    wall.visible_shadow = False

    top, sx, sy = 1.35, 8.5, 2.2
    sz = top + 1.5
    hbm = bmesh.new()
    town._sphere(hbm, (0.0, 0.0, 0.0), (sx, sy, sz), u_seg=40, v_seg=20)
    hill = town._finish_object("far_hill", hbm, town._clay_for(palette.FAR_HILLS[0], 0.7), 0.05,
                               (hill_x, wall_y - 1.9, top - sz), (0.0, 0.0, 0.0))
    return wall, hill


def add_sun(scene):
    """Golden hour sun, low on the left and a little behind the camera: shadows fall right and away."""
    el, az = math.radians(SUN_ELEVATION_DEG), math.radians(SUN_AZIMUTH_DEG)
    to_sun = Vector((-math.cos(el) * math.cos(az), -math.cos(el) * math.sin(az), math.sin(el)))
    data = bpy.data.lights.new("sun", "SUN")
    data.energy = SUN_STRENGTH
    data.angle = math.radians(12.0)
    data.color = palette.hex_to_linear(palette.SUN)
    obj = bpy.data.objects.new("sun", data)
    scene.collection.objects.link(obj)
    obj.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
    return obj


def make_camera(target, width_at_target, pitch_deg=28.0, yaw_deg=0.0, fstop=0.35, focus=None, lens=LENS_MM):
    """50 mm camera looking down `pitch_deg` at `target`, close enough that `width_at_target` fills the frame width."""
    dist = width_at_target / (SENSOR_MM / lens)
    p, y = math.radians(pitch_deg), math.radians(yaw_deg)
    target = Vector(target)
    pos = target + Vector((math.sin(y) * math.cos(p), -math.cos(y) * math.cos(p), math.sin(p))) * dist
    data = bpy.data.cameras.new("scene_camera")
    data.lens = lens
    data.sensor_width = SENSOR_MM
    data.sensor_fit = "HORIZONTAL"
    data.clip_start = 0.1
    data.clip_end = 400.0
    data.dof.use_dof = True
    focus_point = Vector(focus) if focus is not None else target
    axis = (target - pos).normalized()
    data.dof.focus_distance = float((focus_point - pos).dot(axis))
    data.dof.aperture_fstop = fstop
    data.dof.aperture_blades = 0
    cam = bpy.data.objects.new("scene_camera", data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = pos
    cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam


def setup_render(scene, width, height, samples, out, transparent=False):
    scene.render.engine = "CYCLES"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    cy = scene.cycles
    cy.device = "GPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.refresh_devices()
    for dev in prefs.devices:
        dev.use = dev.type == "OPTIX" and "NVIDIA" in dev.name
    cy.samples = samples
    cy.use_adaptive_sampling = False
    cy.seed = palette.SEED
    cy.use_animated_seed = False
    cy.use_denoising = True
    cy.denoiser = "OPENIMAGEDENOISE"
    cy.denoising_use_gpu = True
    cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    cy.denoising_prefilter = "ACCURATE"
    cy.max_bounces = 8
    cy.diffuse_bounces = 4
    cy.glossy_bounces = 4
    cy.transmission_bounces = 2
    cy.sample_clamp_indirect = 8.0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    scene.render.filter_size = 1.5
    vs = scene.view_settings
    vs.view_transform = "Standard"
    vs.look = "None"
    vs.exposure = 0.0
    vs.gamma = 1.0
    scene.display_settings.display_device = "sRGB"
    scene.render.film_transparent = transparent
    img = scene.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGBA" if transparent else "RGB"
    img.color_depth = "8"
    img.compression = 15
    scene.render.filepath = os.path.abspath(out)


def frame_report(label, objs, cam):
    """Print the extent of a group of objects in the camera frame (0 to 1, y up) so framing can be checked."""
    from bpy_extras.object_utils import world_to_camera_view
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    lo = np.array([9e9, 9e9])
    hi = np.array([-9e9, -9e9])
    for o in objs:
        oe = o.evaluated_get(dg)
        for corner in oe.bound_box:
            p = world_to_camera_view(scene, cam, oe.matrix_world @ Vector(corner))
            lo = np.minimum(lo, [p.x, p.y])
            hi = np.maximum(hi, [p.x, p.y])
    print("FRAME %-10s x %.3f..%.3f  y(up) %.3f..%.3f" % (label, lo[0], hi[0], lo[1], hi[1]))


# ---------------------------------------------------------------------------------------------------------------
# Shared builders
# ---------------------------------------------------------------------------------------------------------------
def finish(name, bm, material, bevel, loc, rot, before=None):
    """Like town._finish_object, but lets a modifier go on first (a boolean cut has to come before the bevel)."""
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.polygons.foreach_set("use_smooth", np.ones(len(mesh.polygons), dtype=bool))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = rot
    obj.data.materials.append(material)
    if before is not None:
        before(obj)
    town.add_wobble(obj, bevel)
    return obj


def yarn_mat(name="yarn_red", variation=0.09):
    return materials.yarn(name, palette.YARN, variation)


def build_yarn(name, paths, ply=story.PLY_RADIUS, helix=story.HELIX_RADIUS, period=story.TWIST_PERIOD, tapers=None,
               rng=None, around=10, mat=None):
    parts = []
    for k, p in enumerate(paths):
        parts += story.twisted_yarn(p, ply, helix, period, around, tapers[k] if tapers else (False, False), rng)
    v, t = story.merge_arrays(parts)
    return story.object_from_arrays(name, v, t, mat or yarn_mat())


def ground_path(xy, lift=story.YARN_LIFT, ds=0.02, arch=0.0, smooth=9):
    """3D path along the quilt through the xy points, `lift` above the ground, with an optional arch in the middle."""
    pts = story._catmull(np.asarray(xy, dtype=np.float64), ds)
    z = terrain.surface(pts[:, 0], pts[:, 1]) + lift
    if arch:
        z = z + arch * np.sin(np.pi * np.linspace(0.0, 1.0, len(pts)))
    return np.stack([pts[:, 0], pts[:, 1], story._smooth(z, smooth)], axis=-1)


def lifted_path(ctrl, lift=story.YARN_LIFT, ds=0.02):
    """3D path through control points, never lower than `lift` above the quilt."""
    pts = story._catmull(np.asarray(ctrl, dtype=np.float64), ds)
    floor = terrain.surface(pts[:, 0], pts[:, 1]) + lift
    pts[:, 2] = story._smooth(np.maximum(pts[:, 2], floor), 9)
    return pts


def arc_slice(path, s0, s1):
    """The part of a path between two arc lengths."""
    s = story._arc_length(path)
    keep = (s >= s0) & (s <= s1)
    return path[keep]


def fibres(end_xy, direction_xy, count, rng, spread=0.24, length=(0.28, 0.42)):
    """A little fan of loose fibres lying on the quilt, fanning out from a cut end of yarn."""
    base = math.atan2(direction_xy[1], direction_xy[0])
    out = []
    for j in range(count):
        a = base + (j - (count - 1) / 2.0) * spread + rng.uniform(-0.05, 0.05)
        out.append(story.fibre_arrays(np.array([end_xy[0], end_xy[1], 0.0]), (math.cos(a), math.sin(a)),
                                      rng.uniform(*length), rng, lift_end=rng.uniform(0.02, 0.07),
                                      radius=rng.uniform(0.010, 0.016), curl=rng.uniform(0.03, 0.08)))
    return out


def fibre_object(name, parts, strength=0.16):
    v, t = story.merge_arrays(parts)
    return story.object_from_arrays(name, v, t, materials.yarn("yarn_fibre", palette.YARN, strength))


def build_bow(end_xy, direction_xy, rng, size=1.0):
    """A tied bow lying on the quilt: knot, two loops and two short tails. Returns the objects."""
    d = np.asarray(direction_xy, dtype=np.float64)
    d = d / np.linalg.norm(d)
    end = np.asarray(end_xy, dtype=np.float64)

    def rot(v, deg):
        a = math.radians(deg)
        return np.array([v[0] * math.cos(a) - v[1] * math.sin(a), v[0] * math.sin(a) + v[1] * math.cos(a)])

    def to_xy(local, axis):
        q = np.array([-axis[1], axis[0]])
        return end + size * (local[0] * axis + local[1] * q)

    loop_pts = [(0.03, 0.02), (0.28, 0.20), (0.60, 0.27), (0.86, 0.14), (0.90, -0.04), (0.70, -0.19), (0.38, -0.16),
                (0.05, -0.02)]
    paths = []
    for sign in (1, -1):
        axis = rot(d, sign * 58.0)
        pts = [to_xy((a, sign * b), axis) for a, b in loop_pts]
        paths.append(ground_path(pts, story.YARN_LIFT, arch=0.13 * size))
    tail_pts = [(0.0, 0.0), (0.38, 0.09), (0.86, 0.2)]
    for sign in (1, -1):
        axis = rot(d, sign * 22.0)
        pts = [to_xy((a, sign * b), axis) for a, b in tail_pts]
        paths.append(ground_path(pts, story.YARN_LIFT - 0.01))
    bow = build_yarn("bow_yarn", paths, ply=0.05, helix=0.045, rng=rng)
    knot_bm = bmesh.new()
    kz = float(terrain.surface(end[0], end[1])) + story.YARN_LIFT + 0.02
    town._sphere(knot_bm, (0.0, 0.0, 0.0), (0.17 * size, 0.17 * size, 0.13 * size))
    knot = town._finish_object("bow_knot", knot_bm, yarn_mat(), 0.02, (end[0], end[1], kz), (0.0, 0.0, 0.0))
    return [bow, knot]


def sample_closed(points, ds):
    """Resample a closed polyline every `ds`. Returns points and unit tangents."""
    pts = np.vstack([points, points[:1]])
    res = story._resample(pts, ds)[:-1]
    t = np.roll(res, -1, axis=0) - np.roll(res, 1, axis=0)
    return res, t / np.linalg.norm(t, axis=1, keepdims=True)


def make_person(name, xy, yaw, body, head, hair, scale=1.0, z=None, wave=False, apron=None):
    objs = story.make_doll(name, xy, yaw, body, head, hair, apron, wave=wave)
    for o in objs:
        o.scale = (scale, scale, scale)
        if z is not None:
            o.location.z = z
    return objs


def make_coin(name, centre, normal, along, scale=1.0):
    """The hero's gold coin at `centre`, its face turned to `normal`, with `along` as a direction in its plane."""
    R, t = story.COIN_RADIUS, story.COIN_THICK
    profile = [(0.0, t / 2, 0), (R - 0.03, t / 2, 0), (R - 0.012, t / 2 - 0.012, 0.6), (R, t / 2 - 0.028, 1.0),
               (R, -t / 2 + 0.028, 1.0), (R - 0.012, -t / 2 + 0.012, 0.6), (R - 0.03, -t / 2, 0), (0.0, -t / 2, 0)]
    body_v, body_t = story.lathe_arrays(profile, 160, ridge=lambda a: 0.06 * (0.5 + 0.5 * np.cos(40 * a)))
    bars = []
    bar = story._stadium_outline(0.0, 0.0, 0.044, 0.26)
    for z0 in (t / 2 - 0.004, -t / 2 - 0.03 + 0.004):
        for ang in (math.pi / 4, -math.pi / 4):
            bars.append(story._prism_z_arrays(story._rotate_outline(bar, ang), z0, z0 + 0.034))
    obj = story.object_from_arrays(name, body_v, body_t, materials.clay("gold_coin", palette.COIN, roughness=0.35, metallic=0.3))
    town.add_wobble(obj, 0.008)
    mv, mt = story.merge_arrays(bars)
    mark = story.object_from_arrays(name + "_mark", mv, mt, materials.clay("gold_mark", palette.COIN_MARK, roughness=0.4, metallic=0.3))
    town.add_wobble(mark, 0.008)
    n = np.asarray(normal, dtype=np.float64)
    n = n / np.linalg.norm(n)
    h = np.asarray(along, dtype=np.float64)
    h = h - n * float(h @ n)
    h = h / np.linalg.norm(h)
    y_axis = np.cross(n, h)
    m = Matrix.Identity(4)
    for col, vec in enumerate((h, y_axis, n)):
        for row in range(3):
            m[row][col] = float(vec[row]) * scale
    for row in range(3):
        m[row][3] = float(centre[row])
    obj.matrix_world = m
    mark.matrix_world = m
    return [obj, mark]


def coin_on_edge(name, xy, yaw_deg, lean_deg, scale=1.0, z_ground=None):
    """A coin standing on its rim on the ground, facing the camera turned by `yaw_deg` and leaning back."""
    yaw, lean = math.radians(yaw_deg), math.radians(lean_deg)
    h = np.array([math.cos(yaw), math.sin(yaw), 0.0])
    n0 = np.array([math.sin(yaw), -math.cos(yaw), 0.0])
    n = n0 * math.cos(lean) + np.array([0.0, 0.0, 1.0]) * math.sin(lean)
    g = float(terrain.surface(xy[0], xy[1])) if z_ground is None else z_ground
    R, t = story.COIN_RADIUS * scale, story.COIN_THICK * scale
    drop = R * math.sqrt(max(0.0, 1.0 - n[2] ** 2)) + (t / 2) * abs(n[2])
    return make_coin(name, (xy[0], xy[1], g + drop - 0.01), n, h, scale)


def box_arrays(centre, axes, half):
    """Eight corners and twelve triangles of an oriented box. `axes` are three unit vectors, `half` three half sizes."""
    verts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                verts.append(np.asarray(centre) + sx * half[0] * axes[0] + sy * half[1] * axes[1] + sz * half[2] * axes[2])
    verts = np.array(verts)
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    tris = []
    for a, b, c, d in quads:
        tris += [(a, b, c), (a, c, d)]
    tris = np.array(tris)
    return verts, story._fix_winding(verts, tris)


def tag_objects(before):
    """Objects created since the set `before` was taken."""
    return [o for o in bpy.data.objects if o not in before]


# ---------------------------------------------------------------------------------------------------------------
# Scene 1: They say yes
# ---------------------------------------------------------------------------------------------------------------
SIGN_W, SIGN_H, SIGN_T = 3.2, 1.3, 0.35
SIGN_BOTTOM = 0.26
HOLE_X = 0.8
HOLE_Z = 0.78
HOLE_R = 0.19


def rounded_slab(W, H, T, z0, r, step=0.11):
    """A flat slab with rounded corners built from a quad grid, so a boolean cut through it stays clean.

    The slab is W wide, H tall and T thick, its bottom edge at height z0, its faces toward -y and +y.
    """
    def lines(L):
        n_mid = max(2, int(round((L - 2 * r) / step)))
        return np.concatenate([np.linspace(0.0, r, 5), np.linspace(r, L - r, n_mid + 1)[1:-1], np.linspace(L - r, L, 5)])

    xs = lines(W) - W / 2.0
    zs = lines(H)
    nx, nz = len(xs), len(zs)

    def corner_map(x, z):
        ax = abs(x)
        u = (ax - (W / 2.0 - r)) / r
        if z < r:
            v, zc, sgn = (r - z) / r, r, -1.0
        elif z > H - r:
            v, zc, sgn = (z - (H - r)) / r, H - r, 1.0
        else:
            return x, z
        if u <= 0.0:
            return x, z
        u2 = u * math.sqrt(1.0 - v * v / 2.0)
        v2 = v * math.sqrt(1.0 - u * u / 2.0)
        return math.copysign(W / 2.0 - r + r * u2, x), zc + sgn * r * v2

    bm = bmesh.new()
    layers = []
    for y in (-T / 2.0, T / 2.0):
        grid = []
        for j in range(nz):
            row = []
            for i in range(nx):
                px, pz = corner_map(xs[i], zs[j])
                row.append(bm.verts.new((px, y, z0 + pz)))
            grid.append(row)
        layers.append(grid)
    front, back = layers
    for j in range(nz - 1):
        for i in range(nx - 1):
            bm.faces.new((front[j][i], front[j][i + 1], front[j + 1][i + 1], front[j + 1][i]))
            bm.faces.new((back[j][i + 1], back[j][i], back[j + 1][i], back[j + 1][i + 1]))
    border = ([(0, i) for i in range(nx)] + [(j, nx - 1) for j in range(1, nz)] +
              [(nz - 1, i) for i in range(nx - 2, -1, -1)] + [(j, 0) for j in range(nz - 2, 0, -1)])
    for k in range(len(border)):
        (j0, i0), (j1, i1) = border[k], border[(k + 1) % len(border)]
        bm.faces.new((front[j0][i0], front[j1][i1], back[j1][i1], back[j0][i0]))
    return bm


def build_sign(origin, yaw):
    """Chunky blue button-sign on two clay feet, two holes through it for the yarn, cream running stitches."""
    blue = town._clay_for(palette.WALLET, 0.5)
    wood = town._clay_for(palette.TRUNK, 0.6)
    cream = town._clay_for(palette.STITCH, 0.7)
    gz = float(terrain.surface(origin[0], origin[1]))
    loc = (float(origin[0]), float(origin[1]), gz - 0.02)
    rot = (0.0, 0.0, yaw)

    bm = rounded_slab(SIGN_W, SIGN_H, SIGN_T, SIGN_BOTTOM, 0.3)
    cutters = []

    def add_holes(obj):
        for sx in (-1, 1):
            cv, ct = story.lathe_arrays([(0.0, -0.5), (HOLE_R, -0.5), (HOLE_R, 0.5), (0.0, 0.5)], 32)
            cut = story.object_from_arrays("sign_hole_%d" % sx, cv, ct, blue)
            cut.parent = obj
            cut.location = (sx * HOLE_X, 0.0, HOLE_Z + SIGN_BOTTOM - 0.26)
            cut.rotation_euler = (math.pi / 2, 0.0, 0.0)
            cut.hide_render = True
            cut.display_type = "WIRE"
            mod = obj.modifiers.new("hole_%d" % sx, "BOOLEAN")
            mod.operation = "DIFFERENCE"
            mod.object = cut
            mod.solver = "EXACT"
            cutters.append(cut)

    sign = finish("sign_board", bm, blue, 0.055, loc, rot, before=add_holes)

    objs = [sign] + cutters
    for sx in (-1, 1):
        fbm = bmesh.new()
        town._box(fbm, (sx * 1.0, 0.0, 0.17), (0.62, 0.8, 0.34))
        objs.append(finish("sign_foot_%d" % sx, fbm, wood, 0.11, loc, rot))

    inset = 0.17
    outline = np.array(story._rounded_outline(SIGN_W - 2 * inset, SIGN_H - 2 * inset, 0.3 - inset))
    pts2 = np.stack([outline[:, 0], outline[:, 1] + SIGN_BOTTOM + inset], axis=-1)
    res, tang = sample_closed(pts2, 0.2)
    local_c = np.stack([res[:, 0], np.full(len(res), -SIGN_T / 2 - 0.004), res[:, 1]], axis=-1)
    local_t = np.stack([tang[:, 0], np.zeros(len(res)), tang[:, 1]], axis=-1)
    cy, sy = math.cos(yaw), math.sin(yaw)
    rz = np.array([[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]])
    world_c = local_c @ rz.T + np.array(loc)
    world_t = local_t @ rz.T
    world_n = np.tile(rz @ np.array([0.0, -1.0, 0.0]), (len(res), 1))
    objs.append(town.merge_capsules("sign_stitches", world_c, world_t, world_n, cream,
                                    np.full(len(res), 0.42), np.full(len(res), 0.72)))

    def to_world(lx, ly, lz):
        return np.array([origin[0] + lx * cy - ly * sy, origin[1] + lx * sy + ly * cy, gz + lz])

    return {"objects": objs, "world": to_world}


def scene_1(args, ctx):
    rng = np.random.default_rng([palette.SEED, 101])
    quilt = ctx["quilt"]
    sign_xy = (0.0, 0.0)
    sign_yaw = math.radians(-8.0)
    shop_xy = (4.0, 4.7)
    cust_scale = 1.5
    cust_yaw = math.radians(18.0)

    before = set(bpy.data.objects)
    sign = build_sign(sign_xy, sign_yaw)
    sw = sign["world"]

    # The shop stands behind, out of focus.
    shop_anchor = np.array([shop_xy[0], shop_xy[1], float(terrain.surface(*shop_xy))])
    town.make_house("shop", 0.0, 0.0, 2.4, 1.8, 1.5, 0.9, palette.SHOP, 6.0, shop=True, index=0, anchor=shop_anchor, lit=True)

    # The customer, scaled up, stands left of the sign with the raised hand on its edge.
    shoulder = np.array(story.WAVE_SHOULDER)
    d = np.array([0.75, -0.25, 0.62])
    d /= np.linalg.norm(d)
    tip_local = (shoulder + d * 0.34) * cust_scale
    target = sw(-SIGN_W / 2 + 0.03, -0.08, 0.0)
    c, s = math.cos(cust_yaw), math.sin(cust_yaw)
    tip_xy = np.array([tip_local[0] * c - tip_local[1] * s, tip_local[0] * s + tip_local[1] * c])
    cust_xy = target[:2] - tip_xy
    make_person("customer", cust_xy, cust_yaw, palette.CUSTOMER_BODY, palette.CUSTOMER_HEAD, palette.CUSTOMER_HAIR,
                scale=cust_scale, wave=True)

    # The red road: in from the left edge, up through the first hole, behind, out of the second, down to a bow.
    ground_in = [(-11.5, -3.6), (-8.2, -2.9), (-5.2, -3.1), (-3.3, -2.6)]
    ctrl = [(x, y, float(terrain.surface(x, y)) + story.YARN_LIFT) for x, y in ground_in]
    local = [(-1.95, -1.6, 0.10), (-1.5, -1.15, 0.26), (-1.15, -0.75, 0.52),
             (-HOLE_X, -0.42, HOLE_Z), (-HOLE_X, -0.1, HOLE_Z), (-HOLE_X, 0.25, HOLE_Z), (-HOLE_X, 0.55, HOLE_Z),
             (-0.4, 0.8, HOLE_Z - 0.04), (0.4, 0.8, HOLE_Z - 0.04),
             (HOLE_X, 0.55, HOLE_Z), (HOLE_X, 0.25, HOLE_Z), (HOLE_X, -0.1, HOLE_Z), (HOLE_X, -0.42, HOLE_Z),
             (1.15, -0.8, 0.5), (1.5, -1.15, 0.26), (1.95, -1.4, 0.1)]
    for lx, ly, lz in local:
        p = sw(lx, ly, lz)
        ctrl.append((p[0], p[1], p[2]))
    end_xy = (3.15, -1.6)
    ctrl += [(2.6, -1.62, float(terrain.surface(2.6, -1.62)) + story.YARN_LIFT),
             (end_xy[0], end_xy[1], float(terrain.surface(*end_xy)) + story.YARN_LIFT)]
    road = lifted_path(ctrl)
    road_obj = build_yarn("yarn_road", [road], rng=rng)
    direction = road[-1, :2] - road[-40, :2]
    bow = build_bow(road[-1, :2], direction, rng, size=1.0)

    subject = tag_objects(before)
    ctx["subject"] = [o for o in subject if not o.name.startswith(("shop", "sign_hole"))]
    ctx["exclusions"] = [(0.0, 0.0, 2.4), (cust_xy[0], cust_xy[1], 0.9), (shop_xy[0], shop_xy[1], 2.4),
                         (end_xy[0], end_xy[1], 1.4)]
    ctx["target"] = (0.9, 0.9, 0.7)
    ctx["width"] = 9.8
    ctx["focus"] = (0.0, -0.2, 0.8)
    ctx["fstop"] = 0.5


def quilt_for(scene, wall_y):
    if scene == 1:
        return Quilt(11.0, [3.6], [2.3], [["butter", "sage"], ["teal", "sky"]], wall_y)
    if scene == 2:
        return Quilt(9.0, [-1.6, 3.4], [-1.8], [["sky", "sage"], ["teal", "butter"], ["sage", "butter"]], wall_y)
    if scene == 3:
        return Quilt(7.0, [6.2], [-2.4, 3.6], [["butter", "sage", "teal"], ["sky", "sky", "sage"]], wall_y)
    return Quilt(9.0, [4.0], [-3.2, 2.8], [["sage", "teal", "sky"], ["sky", "sky", "sage"]], wall_y)


# ---------------------------------------------------------------------------------------------------------------
# Scene 2: Mend sees who is slipping
# ---------------------------------------------------------------------------------------------------------------
def scene_2(args, ctx):
    rng = np.random.default_rng([palette.SEED, 102])
    before = set(bpy.data.objects)
    specs = [
        ("house_1", (-3.0, 2.4), 5.0, palette.HOUSES["A"], 1.25),
        ("house_2", (0.1, 0.8), -4.0, palette.HOUSES["B"], 0.375),
        ("house_3", (3.1, -0.9), 7.0, palette.HOUSES["C"], 0.0),
    ]
    W, D, WH, RH = 2.3, 1.9, 1.55, 1.0
    doors = []
    for k, (name, (x, y), face, colours, glow) in enumerate(specs):
        anchor = np.array([x, y, float(terrain.surface(x, y))])
        b = town.make_house(name, 0.0, 0.0, W, D, WH, RH, colours, face, index=k + 1, anchor=anchor, lit=False)
        glass = bpy.data.objects[name + "_glass"]
        if glow > 0.0:
            glass.data.materials[0] = materials.glow_glass("window_glow_%d" % k, palette.WINDOW_GLASS, palette.WINDOW_GLOW, glow)
        doors.append(b["to_world"](0.0, -D / 2 - 0.13))

    def with_z(xy, lift):
        return (xy[0], xy[1], float(terrain.surface(xy[0], xy[1])) + lift)

    # Road 1: thick, whole and taut, nearly a straight line from the bottom left to the first door.
    d1 = doors[0]
    r1 = ground_path([(-9.0, -4.6), (-7.4, -2.6), (-5.8, -0.9), (d1[0] - 0.45, d1[1] - 0.9), (d1[0], d1[1])], 0.14, smooth=15)
    build_yarn("yarn_road_1", [r1], ply=0.082, helix=0.072, period=0.7, tapers=[(False, True)], rng=rng, around=12)

    # Road 2: thinner, loose fibres along it and two short gaps.
    d2 = doors[1]
    r2 = ground_path([(-9.0, -5.5), (-6.4, -4.2), (-3.6, -2.9), (-1.2, -1.7), (d2[0] - 0.45, d2[1] - 0.9), (d2[0], d2[1])],
                     story.YARN_LIFT - 0.02)
    s2 = story._arc_length(r2)
    total2 = s2[-1]
    gaps = [(total2 - 4.6, total2 - 4.6 + 0.45), (total2 - 2.1, total2 - 2.1 + 0.45)]
    cuts = [(0.0, gaps[0][0]), (gaps[0][1], gaps[1][0]), (gaps[1][1], total2)]
    pieces = [arc_slice(r2, a, b) for a, b in cuts]
    build_yarn("yarn_road_2", pieces, ply=0.042, helix=0.036, period=0.42, rng=rng, around=8,
               tapers=[(False, True), (True, True), (True, False)])
    frays = []
    for a, b in gaps:
        i0 = int(np.argmin(np.abs(s2 - a)))
        i1 = int(np.argmin(np.abs(s2 - b)))
        frays += fibres(r2[i0, :2], r2[i0, :2] - r2[i0 - 6, :2], 5, rng, spread=0.3, length=(0.18, 0.3))
        frays += fibres(r2[i1, :2], r2[i1, :2] - r2[min(i1 + 6, len(r2) - 1), :2], 5, rng, spread=0.3, length=(0.18, 0.3))
    for frac in (0.5, 0.58, 0.64, 0.72, 0.8, 0.88, 0.94):
        i = int(frac * (len(r2) - 1))
        t = r2[min(i + 5, len(r2) - 1), :2] - r2[i - 5, :2]
        ang = math.atan2(t[1], t[0]) + rng.choice([-1, 1]) * rng.uniform(0.7, 1.2)
        frays += fibres(r2[i, :2], (math.cos(ang), math.sin(ang)), 1, rng, length=(0.22, 0.38))
    fibre_object("yarn_road_2_fibres", frays, 0.2)

    # Road 3: stops halfway on a frayed end, then a clear gap to the door.
    d3 = doors[2]
    r3 = ground_path([(-9.0, -6.3), (-6.0, -5.6), (-2.4, -4.4), (1.6, -3.1), (d3[0] - 0.5, d3[1] - 1.0), (d3[0], d3[1])], story.YARN_LIFT - 0.02)
    s3 = story._arc_length(r3)
    stop = 0.66 * s3[-1]
    half = arc_slice(r3, 0.0, stop)
    build_yarn("yarn_road_3", [half], ply=0.042, helix=0.036, period=0.42, rng=rng, around=8, tapers=[(False, True)])
    end = half[-1, :2]
    back = half[-1, :2] - half[-8, :2]
    fray3 = fibres(end, back, 8, rng, spread=0.26, length=(0.3, 0.55))
    for frac in (0.3, 0.6, 0.82):
        i = int(frac * (len(half) - 1))
        t = half[i + 5, :2] - half[i - 5, :2]
        ang = math.atan2(t[1], t[0]) + rng.choice([-1, 1]) * rng.uniform(0.7, 1.2)
        fray3 += fibres(half[i, :2], (math.cos(ang), math.sin(ang)), 1, rng, length=(0.22, 0.34))
    fibre_object("yarn_road_3_fibres", fray3, 0.2)

    ctx["subject"] = [o for o in tag_objects(before)]
    ctx["exclusions"] = [(x, y, 2.1) for _, (x, y), _, _, _ in specs]
    ctx["target"] = (0.45, -0.2, 0.9)
    ctx["width"] = 11.4
    ctx["focus"] = (0.1, 0.8, 0.8)
    ctx["fstop"] = 0.35


# ---------------------------------------------------------------------------------------------------------------
# Scene 3: Some get cashback. Some don't.
# ---------------------------------------------------------------------------------------------------------------
BODIES_FRONT = ["#6C7BD9", "#F7A9B8", "#7A5BA8", "#FFF1DC", "#3F7F9E"]
BODIES_BACK = ["#E5A93B", "#7A5BA8", "#F7A9B8", "#3F7F9E", "#6C7BD9"]
HEADS = [palette.OWNER_HEAD, palette.CUSTOMER_HEAD, palette.TRUNK]
HAIRS = [palette.OWNER_HAIR, palette.CUSTOMER_HAIR, palette.TRUNK, palette.OWNER_HAIR, "#7A5BA8"]


def scene_3(args, ctx):
    rng = np.random.default_rng([palette.SEED, 103])
    before = set(bpy.data.objects)
    xs = np.linspace(-2.5, 2.5, 5)
    y_front, y_back = -0.5, 2.5
    for k, x in enumerate(xs):
        yaw = math.radians(rng.uniform(-12, 12))
        make_person("front_%d" % k, (x + rng.uniform(-0.06, 0.06), y_front), yaw, BODIES_FRONT[k], HEADS[k % 3],
                    HAIRS[(k + 1) % 5])
        coin_on_edge("coin_%d" % k, (x + 0.3 + rng.uniform(-0.05, 0.05), y_front - 1.3), rng.uniform(-24, 24), 8.0)
        yaw = math.radians(rng.uniform(-12, 12))
        make_person("back_%d" % k, (x + rng.uniform(-0.06, 0.06), y_back), yaw, BODIES_BACK[k], HEADS[(k + 1) % 3],
                    HAIRS[k])

    # Widely spaced cream dots between the rows mark the ones held back.
    dots_y = 1.45
    dx = np.arange(-3.1, 3.11, 0.62)
    pts = np.stack([dx, np.full_like(dx, dots_y)], axis=-1)
    z = terrain.surface(pts[:, 0], pts[:, 1])
    normal = terrain.surface_normal(pts[:, 0], pts[:, 1])
    tang = np.tile(np.array([1.0, 0.0, 0.0]), (len(dx), 1))
    tang -= normal * np.sum(tang * normal, axis=-1, keepdims=True)
    tang /= np.linalg.norm(tang, axis=1, keepdims=True)
    centre = np.stack([pts[:, 0], pts[:, 1], z], axis=-1) + normal * 0.035
    town.merge_capsules("held_back_dots", centre, tang, normal, town._clay_for(palette.STITCH, 0.7),
                        np.full(len(dx), 0.45), np.full(len(dx), 2.0))

    ctx["subject"] = tag_objects(before)
    ctx["exclusions"] = [(x, yy, 1.0) for x in xs for yy in (y_front, y_back, y_front - 1.3)]
    ctx["exclusions"] += [(x, dots_y, 0.45) for x in dx]
    ctx["target"] = (0.3, 0.7, 0.5)
    ctx["width"] = 9.2
    ctx["focus"] = (0.3, 0.7, 0.5)
    ctx["fstop"] = 0.5


# ---------------------------------------------------------------------------------------------------------------
# Scene 4: You learn if it worked
# ---------------------------------------------------------------------------------------------------------------
BRASS = "#E5A93B"


def brass():
    return materials.clay("brass", BRASS, roughness=0.32, metallic=0.4)


def lathe_object(name, profile, material, loc=(0.0, 0.0, 0.0), segments=48, bevel=0.02):
    v, t = story.lathe_arrays(profile, segments)
    obj = story.object_from_arrays(name, v, t, material)
    obj.location = loc
    town.add_wobble(obj, bevel)
    return obj


def line_tube(name, a, b, radius, material):
    pts = np.linspace(np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64), 10)
    v, t = story.tube_arrays(pts, radius, 8)
    obj = story.object_from_arrays(name, v, t, material)
    return obj


def build_balance(origin, tilt_deg, beam_half=2.7, pan_r=1.4, hang=1.7, top=3.5, string_r=0.04):
    """Clay balance scale on a wooden base with a brass beam and pans. Left pan sits lower. Returns the objects."""
    wood = town._clay_for(palette.TRUNK, 0.6)
    gold = brass()
    ox, oy = origin
    gz = float(terrain.surface(ox, oy))
    objs = []

    prof = [(0.0, 0.0), (1.85, 0.0), (1.9, 0.1), (1.8, 0.32), (1.4, 0.45), (0.65, 0.58), (0.36, 0.9), (0.25, 1.5),
            (0.2, 3.1), (0.23, top - 0.17), (0.0, top - 0.13)]
    objs.append(lathe_object("scale_stand", prof, wood, (ox, oy, gz - 0.03), 64, 0.03))

    th = math.radians(tilt_deg)
    ry = np.array([[math.cos(th), 0.0, math.sin(th)], [0.0, 1.0, 0.0], [-math.sin(th), 0.0, math.cos(th)]])
    pivot = np.array([ox, oy, gz + top])
    beam_prof = [(0.0, -beam_half - 0.02), (0.11, -beam_half), (0.14, -beam_half + 0.15), (0.22, -1.2), (0.32, 0.0),
                 (0.22, 1.2), (0.14, beam_half - 0.15), (0.11, beam_half), (0.0, beam_half + 0.02)]
    bv, bt = story.lathe_arrays(beam_prof, 28)
    bv = bv[:, [2, 0, 1]]
    bv = bv @ ry.T + pivot
    # lathe_arrays spins around z with the profile as (radius, z); the beam runs along z, so z became x after the swap.
    beam = story.object_from_arrays("scale_beam", bv, story._fix_winding(bv, bt), gold)
    town.add_wobble(beam, 0.02)
    objs.append(beam)

    knob = bmesh.new()
    town._sphere(knob, (0.0, 0.0, 0.0), (0.34, 0.34, 0.34))
    objs.append(town._finish_object("scale_pivot", knob, gold, 0.02, tuple(pivot), (0.0, 0.0, 0.0)))

    ends = {}
    for side in (-1, 1):
        e = pivot + ry @ np.array([side * beam_half, 0.0, 0.0])
        cap = bmesh.new()
        town._sphere(cap, (0.0, 0.0, 0.0), (0.18, 0.18, 0.18))
        objs.append(town._finish_object("scale_cap_%d" % side, cap, gold, 0.02, tuple(e), (0.0, 0.0, 0.0)))

        centre = e + np.array([0.0, 0.0, -hang])
        rr = np.linspace(0.0, pan_r, 14)
        depth = 0.36
        outer = [(float(r), depth * (r / pan_r) ** 2.2) for r in rr]
        lip = [(pan_r + 0.02, depth + 0.015), (pan_r - 0.02, depth + 0.035)]
        inner = [(float(r), depth * (r / pan_r) ** 2.2 + 0.065) for r in rr[::-1][1:-1]]
        pan_prof = outer + lip + inner + [(0.0, 0.065)]
        objs.append(lathe_object("scale_pan_%d" % side, pan_prof, gold, tuple(centre), 56, 0.02))
        for a in (90.0, 210.0, 330.0):
            ar = math.radians(a)
            rim = centre + np.array([(pan_r - 0.04) * math.cos(ar), (pan_r - 0.04) * math.sin(ar), 0.36])
            objs.append(line_tube("scale_string", e, rim, string_r, gold))
        ends[side] = (e, centre)
    return objs, ends, pan_r


def fill_pan(centre, dolls, coin, doll_scale, rng, body_hexes):
    """Little dolls, and maybe a coin, standing on a pan floor."""
    objs = []
    floor = centre[2] + 0.07
    for k, (dx, dy) in enumerate(dolls):
        yaw = math.radians(rng.uniform(-14, 14))
        objs += make_person("pan_doll_%d_%d" % (int(centre[0] * 10), k), (centre[0] + dx, centre[1] + dy), yaw, body_hexes[k],
                            HEADS[k % 3], HAIRS[k % 5], scale=doll_scale, z=floor - 0.01)
    if coin is not None:
        dx, dy, yaw_deg, lean, s = coin
        xy = (centre[0] + dx, centre[1] + dy)
        objs += coin_on_edge("pan_coin", xy, yaw_deg, lean, s, z_ground=floor)
    return objs


def build_tape(origin, tail_dir_deg=195.0, end_angle_deg=115.0, turns=4.5, tail_len=2.8):
    """A coiled cloth tape: a vertical band wound flat on the quilt, its tail lying out flat with dark tick marks."""
    cloth = town._clay_for("#FFD27A", 0.65)
    ink = town._clay_for(palette.DOLL_FACE, 0.6)
    ox, oy = origin
    r_in, pitch, band_w, band_t = 0.27, 0.098, 0.56, 0.062
    th_end = math.radians(end_angle_deg)
    total = 2 * math.pi * turns
    th = np.arange(th_end - total, th_end, 0.02)
    r = r_in + pitch * (th - th[0]) / (2 * math.pi)
    coil_xy = np.stack([ox + r * np.cos(th), oy + r * np.sin(th)], axis=-1)
    r_end = r_in + pitch * turns
    p_end = np.array([ox + r_end * math.cos(th_end), oy + r_end * math.sin(th_end)])
    t_end = np.array([-math.sin(th_end), math.cos(th_end)])
    # The tail leaves along the coil tangent, then eases toward its own heading.
    heading = math.radians(tail_dir_deg)
    h_vec = np.array([math.cos(heading), math.sin(heading)])
    ts = np.arange(0.0, tail_len, 0.02)
    k = np.clip(ts / 1.2, 0.0, 1.0) ** 1.5
    dirs = (1.0 - k)[:, None] * t_end[None, :] + k[:, None] * h_vec[None, :]
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    tail_xy = p_end[None, :] + np.cumsum(dirs * 0.02, axis=0)
    path_xy = np.vstack([coil_xy, tail_xy])
    n_coil = len(coil_xy)
    s_len = story._arc_length(np.column_stack([path_xy, np.zeros(len(path_xy))]))

    g_coil = float(np.max(terrain.surface(coil_xy[:, 0], coil_xy[:, 1]))) - 0.01
    phi = np.zeros(len(path_xy))
    s_tail0 = s_len[n_coil - 1]
    ramp = np.clip((s_len - s_tail0) / 0.7, 0.0, 1.0)
    phi = (ramp * ramp * (3.0 - 2.0 * ramp)) * (math.pi / 2)
    ground = np.where(np.arange(len(path_xy)) < n_coil, g_coil,
                      terrain.surface(path_xy[:, 0], path_xy[:, 1]))
    ground = story._smooth(ground, 11)
    zc = ground + (band_w / 2) * np.cos(phi) + (band_t / 2 - 0.004) * np.sin(phi)
    P = np.column_stack([path_xy, zc])
    T = story._tangents(P)
    Z = np.array([0.0, 0.0, 1.0])
    L = np.cross(Z, T)
    L /= np.linalg.norm(L, axis=1, keepdims=True)
    W = np.cos(phi)[:, None] * Z[None, :] + np.sin(phi)[:, None] * L
    W /= np.linalg.norm(W, axis=1, keepdims=True)
    Th = np.cross(T, W)
    corners = []
    for sw_, st_ in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        corners.append(P + sw_ * (band_w / 2) * W + st_ * (band_t / 2) * Th)
    ring = np.stack(corners, axis=1)
    n = len(P)
    verts = np.concatenate([ring.reshape(-1, 3), P[:1], P[-1:]], axis=0)
    tris = []
    for i in range(n - 1):
        for j in range(4):
            j2 = (j + 1) % 4
            a, b = i * 4 + j, i * 4 + j2
            c, d = (i + 1) * 4 + j2, (i + 1) * 4 + j
            tris += [(a, b, c), (a, c, d)]
    for j in range(4):
        j2 = (j + 1) % 4
        tris.append((n * 4, j2, j))
        tris.append((n * 4 + 1, (n - 1) * 4 + j, (n - 1) * 4 + j2))
    tris = story._fix_winding(verts, np.array(tris))
    tape = story.object_from_arrays("tape_cloth", verts, tris, cloth)
    town.add_wobble(tape, 0.0, displace_only=True)
    objs = [tape]

    tick_v, tick_t = [], []
    last_turn = s_len[n_coil - 1] - 2 * math.pi * (r_end - 0.15)
    spacing = 0.2
    s_vals = np.arange(max(last_turn, 0.0) + 0.1, s_len[-1] - 0.12, spacing)
    for idx, s in enumerate(s_vals):
        i = int(np.argmin(np.abs(s_len - s)))
        long = idx % 5 == 0
        half_len = 0.19 if long else 0.1
        centre = P[i] + Th[i] * (band_t / 2 + 0.003) + W[i] * ((band_w / 2 - half_len - 0.02) * (1 if long else 1))
        v, t = box_arrays(centre, (W[i], T[i], Th[i]), (half_len, 0.016, 0.008))
        tick_v.append(v)
        tick_t.append(t)
    tv, tt = story.merge_arrays(list(zip(tick_v, tick_t)))
    objs.append(story.object_from_arrays("tape_ticks", tv, tt, ink))
    return objs, p_end, tail_xy


def scene_4(args, ctx):
    rng = np.random.default_rng([palette.SEED, 104])
    before = set(bpy.data.objects)
    objs, ends, pan_r = build_balance((0.0, 0.0), -7.0)
    left_c = ends[-1][1]
    right_c = ends[1][1]
    fill_pan(left_c, [(-0.6, 0.35), (0.1, 0.6), (0.78, 0.2)], (-0.1, -0.5, 14.0, 10.0, 0.8), 0.68, rng,
             ["#6C7BD9", "#F7A9B8", "#7A5BA8"])
    fill_pan(right_c, [(-0.65, 0.3), (0.05, 0.6), (0.7, 0.15)], None, 0.68, rng, ["#FFF1DC", "#E5A93B", "#3F7F9E"])
    tape_objs, p_end, tail = build_tape((4.0, -2.6))

    ctx["subject"] = tag_objects(before)
    ctx["exclusions"] = [(0.0, 0.0, 2.3), (4.0, -2.6, 1.2)] + [(float(p[0]), float(p[1]), 0.45) for p in tail[::10]]
    ctx["target"] = (0.5, -0.2, 1.9)
    ctx["width"] = 12.3
    ctx["focus"] = (0.0, 0.0, 1.9)
    ctx["fstop"] = 0.5


SCENES = {1: scene_1, 2: scene_2, 3: scene_3, 4: scene_4}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--scene", type=int, required=True, choices=[1, 2, 3, 4])
    p.add_argument("--out", required=True)
    p.add_argument("--width", type=int, default=1600)
    p.add_argument("--height", type=int, default=1200)
    p.add_argument("--samples", type=int, default=128)
    p.add_argument("--pitch", type=float, default=28.0)
    p.add_argument("--fstop", type=float, default=None)
    p.add_argument("--wall", type=float, default=8.4)
    return p.parse_args(argv)


def main():
    t_start = time.time()
    args = parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene

    quilt = quilt_for(args.scene, args.wall)
    install_ground(quilt)
    ctx = {"quilt": quilt}
    SCENES[args.scene](args, ctx)

    ground = build_ground(quilt, "scene%d" % args.scene)
    seam_stitches(quilt, ctx["exclusions"])
    build_backdrop(args.wall)
    cam = make_camera(ctx["target"], ctx["width"], args.pitch, 0.0, args.fstop or ctx["fstop"], ctx["focus"])
    materials.build_world(scene, WORLD_STRENGTH)
    add_sun(scene)
    setup_render(scene, args.width, args.height, args.samples, args.out)
    bpy.context.view_layer.update()
    frame_report("subject", ctx["subject"], cam)
    print("OBJECTS %d  SETUP %.1fs" % (len(bpy.data.objects), time.time() - t_start))
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print("RENDER_SECONDS %.1f" % (time.time() - t))
    print("WROTE %s" % scene.render.filepath)


if __name__ == "__main__":
    main()
