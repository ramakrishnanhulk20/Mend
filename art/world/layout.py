"""Camera and frame-position maths. Every object is placed by a pixel position in the frame."""
import numpy as np

import terrain

CAM_LOC = np.array([0.0, -17.0, 4.2])
CAM_TARGET = np.array([0.0, 3.0, 1.6])
LENS_MM = 42.0
SENSOR_MM = 36.0
ASPECT = 2.0
FSTOP = 0.25
# The lens focuses on the needle tip where it enters the ground.
NEEDLE_TIP_FRAME = (0.545, 0.635)

# Frame boxes (fx0, fy0, fx1, fy1) that trees and far houses keep out of: road and stitches, needle and strand,
# button, spool and the two doorways where the people stand.
STORY_KEEPOUT = [
    (0.17, 0.585, 0.86, 0.75),
    (0.50, 0.09, 0.78, 0.66),
    (0.66, 0.0, 0.99, 0.22),
    (0.84, 0.65, 0.97, 0.76),
    (0.03, 0.27, 0.16, 0.44),
]


def set_aspect(width, height):
    global ASPECT
    ASPECT = float(width) / float(height)


def _basis():
    f = CAM_TARGET - CAM_LOC
    f = f / np.linalg.norm(f)
    r = np.cross(f, np.array([0.0, 0.0, 1.0]))
    r = r / np.linalg.norm(r)
    u = np.cross(r, f)
    return f, r, u


def ray(fx, fy):
    """Origin and unit direction of the camera ray through frame position (fx, fy)."""
    f, r, u = _basis()
    half_w = (SENSOR_MM / 2.0) / LENS_MM
    half_h = half_w / ASPECT
    d = f + r * ((fx - 0.5) * 2.0 * half_w) + u * (-(fy - 0.5) * 2.0 * half_h)
    return CAM_LOC.copy(), d / np.linalg.norm(d)


def ground_point(fx, fy):
    """World point on the terrain under frame position (fx, fy).

    Marches the camera ray in small steps until it dips below h(x, y), then bisects.
    """
    o, d = ray(fx, fy)
    t = np.arange(1.0, 120.0, 0.03)
    pts = o[None, :] + t[:, None] * d[None, :]
    below = pts[:, 2] < terrain.h(pts[:, 0], pts[:, 1])
    hits = np.nonzero(below)[0]
    if len(hits) == 0 or hits[0] == 0:
        raise ValueError("ray through (%.3f, %.3f) never meets the terrain" % (fx, fy))
    lo, hi = t[hits[0] - 1], t[hits[0]]
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        p = o + mid * d
        if p[2] < float(terrain.h(p[0], p[1])):
            hi = mid
        else:
            lo = mid
    p = o + 0.5 * (lo + hi) * d
    return np.array([p[0], p[1], float(terrain.h(p[0], p[1]))])


def plane_point(fx, fy, y_plane):
    """World point where the camera ray through (fx, fy) meets the plane y = y_plane."""
    o, d = ray(fx, fy)
    t = (y_plane - o[1]) / d[1]
    return o + t * d


def project(points):
    """Frame position (fx, fy) and depth along the view axis for an (N, 3) array of world points."""
    f, r, u = _basis()
    p = np.asarray(points, dtype=np.float64).reshape(-1, 3) - CAM_LOC[None, :]
    depth = p @ f
    half_w = (SENSOR_MM / 2.0) / LENS_MM
    half_h = half_w / ASPECT
    sx = (p @ r) / depth / half_w
    sy = (p @ u) / depth / half_h
    return 0.5 + 0.5 * sx, 0.5 - 0.5 * sy, depth


def focus_depth():
    """Distance along the view axis to the needle tip, where the lens is focused."""
    tip = ground_point(*NEEDLE_TIP_FRAME)
    return float((tip - CAM_LOC) @ _basis()[0])


def coc_pixels(depth, width_px):
    """Blur circle diameter in pixels for something `depth` units along the view axis (thin lens)."""
    s_mm, d_mm = focus_depth() * 1000.0, depth * 1000.0
    coc_mm = LENS_MM ** 2 / (FSTOP * (s_mm - LENS_MM)) * abs(d_mm - s_mm) / d_mm
    return coc_mm * width_px / SENSOR_MM


def make_camera():
    import bpy
    from mathutils import Vector

    cam_data = bpy.data.cameras.new("mend_camera")
    cam_data.lens = LENS_MM
    cam_data.sensor_width = SENSOR_MM
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.clip_start = 0.1
    cam_data.clip_end = 400.0
    cam_data.dof.use_dof = True
    tip = ground_point(*NEEDLE_TIP_FRAME)
    f_axis = _basis()[0]
    cam_data.dof.focus_distance = float((tip - CAM_LOC) @ f_axis)
    cam_data.dof.aperture_fstop = FSTOP
    cam_data.dof.aperture_blades = 0
    cam = bpy.data.objects.new("mend_camera", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = Vector(CAM_LOC.tolist())
    direction = Vector((CAM_TARGET - CAM_LOC).tolist())
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam
