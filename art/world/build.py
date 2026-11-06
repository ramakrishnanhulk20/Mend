"""Builds the Mend hero still and renders it. Run with Blender in background mode:

    blender -b --python-exit-code 1 -P build.py -- --out out/w2.png --width 1500 --height 750 --samples 96
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
from mathutils import Vector  # noqa: E402

import layout  # noqa: E402
import materials  # noqa: E402
import palette  # noqa: E402
import props  # noqa: E402
import story  # noqa: E402
import terrain  # noqa: E402
import town  # noqa: E402

SUN_ELEVATION_DEG = 24.0
SUN_AZIMUTH_DEG = 35.0
SUN_STRENGTH = 2.1
WORLD_STRENGTH = 0.58


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--width", type=int, default=1500)
    p.add_argument("--height", type=int, default=750)
    p.add_argument("--samples", type=int, default=96)
    p.add_argument("--frame", type=int, default=1)
    return p.parse_args(argv)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def add_sun(scene):
    """Golden hour sun, low on the left and a little behind the camera: long shadows fall right and away."""
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


def setup_render(scene, args):
    scene.render.engine = "CYCLES"
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.frame_set(args.frame)

    cy = scene.cycles
    cy.device = "GPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.refresh_devices()
    for dev in prefs.devices:
        dev.use = dev.type == "OPTIX" and "NVIDIA" in dev.name
    cy.samples = args.samples
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

    img = scene.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGB"
    img.color_depth = "8"
    img.compression = 15
    scene.render.filepath = os.path.abspath(args.out)


def report_positions(built, story_plan, needle_plan, props_plan):
    """Print where each story object lands in the frame, and its height above the ground under it."""
    def row(label, p):
        p = np.asarray(p, dtype=float)
        fx, fy, _ = layout.project(np.array([p]))
        gz = float(terrain.surface(p[0], p[1]))
        print("  POS %-22s frame (%.3f, %.3f)  z above ground %+.2f" % (label, fx[0], fy[0], p[2] - gz))

    bpy.context.view_layer.update()
    print("FRAME POSITIONS (base point of each object):")
    for name, b in built["buildings"].items():
        if b["width"] > 1.0:
            row(name, [b["x"], b["y"], b["z"]])
    row("yarn starts at door", np.append(story_plan["left_xy"][0], terrain.surface(*story_plan["left_xy"][0])))
    row("left stretch ends", np.append(story_plan["g0"], terrain.surface(*story_plan["g0"])))
    row("right stretch starts", np.append(story_plan["g1"], terrain.surface(*story_plan["g1"])))
    row("right stretch ends", np.append(story_plan["right_xy"][-1], terrain.surface(*story_plan["right_xy"][-1])))
    for k, c in enumerate(story_plan["stitch_centres"]):
        row("stitch %d centre" % (k + 1), np.append(c, terrain.surface(*c)))
    row("needle tip", needle_plan["tip"])
    row("needle eye", needle_plan["eye"])
    coin_xy = story.plan_coin(story_plan)
    row("coin (where it touches)", np.append(coin_xy, terrain.surface(*coin_xy) + story.YARN_LIFT + 0.1))
    for label, name in (("wallet", "wallet_body"), ("owner", "owner_body"), ("customer", "customer_body"),
                        ("spool", "spool_wood"), ("button", "button")):
        loc = bpy.data.objects[name].matrix_world.translation
        row(label, [loc.x, loc.y, loc.z])


def report_blur(width_px, built, needle_plan):
    """Print the computed blur circle, in pixels at the render width, for the things the brief names."""
    def depth_of(p):
        return float(layout.project(np.array([p]))[2][0])

    rows = [("focus (needle tip)", depth_of(needle_plan["tip"]))]
    for name in ("shop", "house_a", "house_b", "house_c", "house_d"):
        b = built["buildings"][name]
        rows.append((name, depth_of([b["x"], b["y"], b["z"]])))
    rows.append(("far hill apex", depth_of([3.0, 26.0, 5.0])))
    rows.append(("far hill edge", depth_of([-13.0, 24.0, 4.4])))
    rows.append(("cloud", depth_of(layout.plane_point(0.4, 0.05, 33.0))))
    for fy in (0.75, 0.85, 0.95):
        rows.append(("ground at fy %.2f" % fy, depth_of(layout.ground_point(0.5, fy))))
    print("DOF f/%.2f focus depth %.2f, blur circle in pixels at width %d:" % (layout.FSTOP, layout.focus_depth(), width_px))
    for label, d in rows:
        print("  DOF %-20s depth %5.1f blur %5.1f px" % (label, d, layout.coc_pixels(d, width_px)))


def main():
    t_start = time.time()
    args = parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    scene = clear_scene()
    layout.set_aspect(args.width, args.height)
    frame = args.frame

    plan = town.plan_layout()
    story_plan = story.plan_story(plan)
    props_plan = props.plan_props()
    footprint = story.footprint_points(story_plan)
    table = terrain.constrain_cells(footprint, forbidden=("peach",),
                                    forced=[(props_plan["button"][0], props_plan["button"][1], "butter")])
    names = list(palette.QUILT.keys())
    under = {}
    for (i, j) in terrain._cells_under(footprint):
        under[names[int(table[i, j])]] = under.get(names[int(table[i, j])], 0) + 1
    print("PATCHES UNDER THE ROAD %s" % under)

    t = time.time()
    image_path = terrain.color_image_path(os.path.join(HERE, "out"))
    ground = terrain.build_terrain_object()
    ground_mat = materials.ground_material(image_path)
    ground.data.materials.append(ground_mat)
    far_plain = terrain.build_far_plain_object()
    far_plain.data.materials.append(ground_mat)
    print("TERRAIN_READY %.1fs" % (time.time() - t))

    layout.make_camera()
    t = time.time()
    built = town.build_town(plan, frame)
    print("TOWN_READY %.1fs  stitches=%d trees=%d small_trees=%d far_houses=%d objects=%d" % (
        time.time() - t, built["stitch_count"], len(built["trees"]), len(built["small_trees"]), len(built["far"]),
        len(bpy.data.objects)))
    for name, b in built["main"].items():
        bb = b["bbox"]
        print("BUILDING %-8s frame=(%.2f, %.2f) world=(%.2f, %.2f, %.2f) box fx %.3f..%.3f fy %.3f..%.3f" % (
            name, b["fx"], b["fy"], b["x"], b["y"], b["z"], bb[0], bb[2], bb[1], bb[3]))

    story.build_yarn_road(story_plan, frame)
    needle_plan = story.plan_needle()
    story.build_needle(needle_plan, frame)
    story.build_strand(needle_plan, story_plan, frame)
    story.build_coin(story_plan, frame)
    story.build_wallet(story_plan, frame)
    story.build_people(built["buildings"], story_plan, frame)
    props.build_spool(props_plan, frame)
    props.build_button(props_plan, frame)
    print("NEEDLE tip=(%.2f, %.2f, %.2f) eye=(%.2f, %.2f, %.2f) length=%.2f" % (
        *needle_plan["tip"], *needle_plan["eye"], needle_plan["length"]))
    report_blur(args.width, built, needle_plan)
    report_positions(built, story_plan, needle_plan, props_plan)
    materials.build_world(scene, WORLD_STRENGTH)
    add_sun(scene)
    setup_render(scene, args)

    t = time.time()
    bpy.ops.render.render(write_still=True)
    render_seconds = time.time() - t
    print("RENDER_SECONDS %.1f" % render_seconds)
    print("TOTAL_SECONDS %.1f" % (time.time() - t_start))
    print("WROTE %s" % scene.render.filepath)


if __name__ == "__main__":
    main()
