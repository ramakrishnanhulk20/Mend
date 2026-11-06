"""Materials: pressed clay, felted quilt ground, painted sky backdrop and the world light."""
import bpy

import palette
import terrain


def _new_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    return mat, mat.node_tree


def _node(nt, kind, **props):
    n = nt.nodes.new(kind)
    for key, value in props.items():
        setattr(n, key, value)
    return n


def _rgba(hex_color, k=1.0):
    r, g, b = palette.hex_to_linear(hex_color)
    return (r * k, g * k, b * k, 1.0)


def _math(nt, op, a, b=None, clamp=False):
    n = _node(nt, "ShaderNodeMath", operation=op, use_clamp=clamp)
    for slot, val in ((0, a), (1, b)):
        if val is None:
            continue
        if isinstance(val, (int, float)):
            n.inputs[slot].default_value = val
        else:
            nt.links.new(val, n.inputs[slot])
    return n


def _map_range(nt, src, lo, hi, out_lo=0.0, out_hi=1.0):
    n = _node(nt, "ShaderNodeMapRange", clamp=True)
    nt.links.new(src, n.inputs[0])
    n.inputs[1].default_value = lo
    n.inputs[2].default_value = hi
    n.inputs[3].default_value = out_lo
    n.inputs[4].default_value = out_hi
    return n


def _mix_colour(nt, fac, a, b):
    """Colour mix. `fac` is a socket or a number; a and b are sockets or RGBA tuples."""
    n = _node(nt, "ShaderNodeMix", data_type="RGBA", blend_type="MIX")
    # Mix has float, vector and colour sockets with the same names, so pick by position:
    # inputs 0 = float factor, 6 = colour A, 7 = colour B; output 2 = colour result.
    if isinstance(fac, (int, float)):
        n.inputs[0].default_value = fac
    else:
        nt.links.new(fac, n.inputs[0])
    for slot, val in ((6, a), (7, b)):
        if isinstance(val, tuple):
            n.inputs[slot].default_value = val
        else:
            nt.links.new(val, n.inputs[slot])
    return n.outputs[2], n


def clay(name, hex_color, roughness=0.5, metallic=0.0, tiles=False, tile_period=0.16, glow=0.0, albedo=1.0):
    """Hand-pressed clay: soft subsurface glow, a slow mottle, a low-frequency dent and a fingerprint ridge.

    With `tiles` set, rows of pressed grooves run along the object's x axis, `tile_period` apart.
    `glow` gives the clay a soft light of its own in its own colour, and `albedo` scales how much sun it
    reflects, so clouds in low sun stay bright without burning out on their lit side.
    """
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    out = _node(nt, "ShaderNodeOutputMaterial")
    bsdf = _node(nt, "ShaderNodeBsdfPrincipled", subsurface_method="RANDOM_WALK")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    coord = _node(nt, "ShaderNodeTexCoord")

    mottle = _node(nt, "ShaderNodeTexNoise")
    mottle.inputs["Scale"].default_value = 3.2
    mottle.inputs["Detail"].default_value = 3.0
    nt.links.new(coord.outputs["Object"], mottle.inputs["Vector"])
    mottle_fac = _map_range(nt, mottle.outputs["Factor"], 0.35, 0.65)
    base, _ = _mix_colour(nt, mottle_fac.outputs["Result"], _rgba(hex_color, albedo), _rgba(hex_color, 0.9 * albedo))
    nt.links.new(base, bsdf.inputs["Base Color"])

    last_normal = None
    if tiles:
        # Wave bands repeat every 0.314 / Scale along y, so Scale = 0.314 / period. Distortion wobbles the rows.
        rows = _node(nt, "ShaderNodeTexWave", wave_type="BANDS", bands_direction="Y")
        rows.inputs["Scale"].default_value = 0.314 / tile_period
        rows.inputs["Distortion"].default_value = 1.6
        rows.inputs["Detail"].default_value = 1.5
        rows.inputs["Detail Scale"].default_value = 0.7
        nt.links.new(coord.outputs["Object"], rows.inputs["Vector"])
        groove = _map_range(nt, rows.outputs["Factor"], 0.0, 0.32)
        bump_t = _node(nt, "ShaderNodeBump")
        bump_t.inputs["Strength"].default_value = 0.9
        bump_t.inputs["Distance"].default_value = 0.025
        nt.links.new(groove.outputs["Result"], bump_t.inputs["Height"])
        last_normal = bump_t.outputs["Normal"]

    dent = _node(nt, "ShaderNodeTexNoise")
    dent.inputs["Scale"].default_value = 5.5
    dent.inputs["Detail"].default_value = 3.0
    dent.inputs["Roughness"].default_value = 0.6
    nt.links.new(coord.outputs["Object"], dent.inputs["Vector"])
    bump_a = _node(nt, "ShaderNodeBump")
    bump_a.inputs["Strength"].default_value = 0.35
    bump_a.inputs["Distance"].default_value = 0.05
    nt.links.new(dent.outputs["Factor"], bump_a.inputs["Height"])
    if last_normal is not None:
        nt.links.new(last_normal, bump_a.inputs["Normal"])

    ridge = _node(nt, "ShaderNodeTexWave", wave_type="RINGS", rings_direction="SPHERICAL")
    ridge.inputs["Scale"].default_value = 16.0
    ridge.inputs["Distortion"].default_value = 7.0
    ridge.inputs["Detail"].default_value = 2.0
    ridge.inputs["Detail Scale"].default_value = 1.4
    nt.links.new(coord.outputs["Object"], ridge.inputs["Vector"])
    bump_b = _node(nt, "ShaderNodeBump")
    bump_b.inputs["Strength"].default_value = 0.18
    bump_b.inputs["Distance"].default_value = 0.006
    nt.links.new(ridge.outputs["Factor"], bump_b.inputs["Height"])
    nt.links.new(bump_a.outputs["Normal"], bump_b.inputs["Normal"])
    nt.links.new(bump_b.outputs["Normal"], bsdf.inputs["Normal"])

    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Subsurface Weight"].default_value = 0.25
    bsdf.inputs["Subsurface Scale"].default_value = 0.05
    bsdf.inputs["Specular IOR Level"].default_value = 0.3
    bsdf.inputs["Sheen Weight"].default_value = 0.2
    bsdf.inputs["Sheen Roughness"].default_value = 0.6
    if glow:
        bsdf.inputs["Emission Color"].default_value = _rgba(hex_color)
        bsdf.inputs["Emission Strength"].default_value = glow
    return mat


def glow_glass(name, glass_hex, glow_hex, strength=1.0):
    """A lit window: dark pane that gives off a warm light of its own."""
    mat, nt = _new_material(name)
    out = _node(nt, "ShaderNodeOutputMaterial")
    bsdf = _node(nt, "ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = _rgba(glass_hex)
    bsdf.inputs["Roughness"].default_value = 0.25
    bsdf.inputs["Emission Color"].default_value = _rgba(glow_hex)
    bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def polished_steel(name="needle_steel", hex_color=palette.STEEL):
    """The one non-clay material: bright metal that mirrors the sky."""
    mat, nt = _new_material(name)
    out = _node(nt, "ShaderNodeOutputMaterial")
    bsdf = _node(nt, "ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = _rgba(hex_color)
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = 0.18
    return mat


def yarn(name, hex_color, variation=0.1):
    """Wool yarn: fuzzy sheen, fine fibre bump and a slight strand to strand colour drift."""
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
    mat, nt = _new_material(name)
    out = _node(nt, "ShaderNodeOutputMaterial")
    bsdf = _node(nt, "ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    coord = _node(nt, "ShaderNodeTexCoord")
    drift = _node(nt, "ShaderNodeTexNoise")
    drift.inputs["Scale"].default_value = 9.0
    drift.inputs["Detail"].default_value = 2.0
    nt.links.new(coord.outputs["Object"], drift.inputs["Vector"])
    fac = _map_range(nt, drift.outputs["Factor"], 0.3, 0.7)
    colour, _ = _mix_colour(nt, fac.outputs["Result"], _rgba(hex_color, 1.0 - variation),
                            _rgba(hex_color, 1.0 + variation * 0.5))
    nt.links.new(colour, bsdf.inputs["Base Color"])
    fibre = _node(nt, "ShaderNodeTexNoise")
    fibre.inputs["Scale"].default_value = 120.0
    fibre.inputs["Detail"].default_value = 6.0
    fibre.inputs["Roughness"].default_value = 0.7
    nt.links.new(coord.outputs["Object"], fibre.inputs["Vector"])
    bump = _node(nt, "ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.7
    bump.inputs["Distance"].default_value = 0.01
    nt.links.new(fibre.outputs["Factor"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Sheen Weight"].default_value = 0.8
    bsdf.inputs["Sheen Roughness"].default_value = 0.4
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    return mat


def ground_material(image_path, name="quilt_felt"):
    """Felted wool: the painted quilt colour map, high roughness, strong sheen, fine fibre bump."""
    mat, nt = _new_material(name)
    out = _node(nt, "ShaderNodeOutputMaterial")
    bsdf = _node(nt, "ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    uv = _node(nt, "ShaderNodeUVMap", uv_map="UV")
    img = _node(nt, "ShaderNodeTexImage", interpolation="Linear", extension="EXTEND")
    img.image = bpy.data.images.load(image_path)
    img.image.colorspace_settings.name = "sRGB"
    nt.links.new(uv.outputs["UV"], img.inputs["Vector"])

    # Past the edge of the colour map, fade to the far hill colour instead of smearing the border pixels.
    coord = _node(nt, "ShaderNodeTexCoord")
    sep = _node(nt, "ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Object"], sep.inputs["Vector"])
    far_y = _map_range(nt, sep.outputs["Y"], terrain.IMG_Y1 - 1.9, terrain.IMG_Y1 - 0.3)
    ax = _math(nt, "ABSOLUTE", sep.outputs["X"])
    far_x = _map_range(nt, ax.outputs["Value"], terrain.IMG_X1 - 1.2, terrain.IMG_X1 - 0.2)
    far = _math(nt, "MAXIMUM", far_y.outputs["Result"], far_x.outputs["Result"])
    colour, _ = _mix_colour(nt, far.outputs["Value"], img.outputs["Color"], _rgba(palette.FAR_HILLS[0]))
    nt.links.new(colour, bsdf.inputs["Base Color"])

    lumps = _node(nt, "ShaderNodeTexNoise")
    lumps.inputs["Scale"].default_value = 13.0
    lumps.inputs["Detail"].default_value = 3.0
    nt.links.new(coord.outputs["Object"], lumps.inputs["Vector"])
    bump_a = _node(nt, "ShaderNodeBump")
    bump_a.inputs["Strength"].default_value = 0.25
    bump_a.inputs["Distance"].default_value = 0.03
    nt.links.new(lumps.outputs["Factor"], bump_a.inputs["Height"])

    fibre = _node(nt, "ShaderNodeTexNoise")
    fibre.inputs["Scale"].default_value = 70.0
    fibre.inputs["Detail"].default_value = 4.0
    fibre.inputs["Roughness"].default_value = 0.65
    nt.links.new(coord.outputs["Object"], fibre.inputs["Vector"])
    bump_b = _node(nt, "ShaderNodeBump")
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


def stitch_material():
    return clay("stitch_yarn", palette.STITCH, roughness=0.8)


def sky_material(name="sky_backdrop"):
    """Painted gradient: horizon peach to a pale teal top, with soft horizontal brush noise."""
    mat, nt = _new_material(name)
    out = _node(nt, "ShaderNodeOutputMaterial")
    emit = _node(nt, "ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 0.96
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])

    coord = _node(nt, "ShaderNodeTexCoord")
    sep = _node(nt, "ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    stretch = _node(nt, "ShaderNodeMapping")
    stretch.inputs["Scale"].default_value = (3.0, 1.0, 16.0)
    nt.links.new(coord.outputs["Generated"], stretch.inputs["Vector"])
    brush = _node(nt, "ShaderNodeTexNoise")
    brush.inputs["Scale"].default_value = 2.2
    brush.inputs["Detail"].default_value = 5.0
    brush.inputs["Distortion"].default_value = 0.6
    nt.links.new(stretch.outputs["Vector"], brush.inputs["Vector"])
    centred = _math(nt, "SUBTRACT", brush.outputs["Factor"], 0.5)
    shift = _math(nt, "MULTIPLY", centred.outputs["Value"], 0.05)
    height = _math(nt, "ADD", sep.outputs["Z"], shift.outputs["Value"])

    ramp = _node(nt, "ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    ramp.color_ramp.elements[0].position = 0.25
    ramp.color_ramp.elements[0].color = _rgba(palette.SKY_HORIZON)
    ramp.color_ramp.elements[1].position = 0.31
    ramp.color_ramp.elements[1].color = _rgba(palette.SKY_TOP)
    nt.links.new(height.outputs["Value"], ramp.inputs["Factor"])
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    return mat


def build_world(scene, strength=0.8):
    """Sky-coloured ambient light: pale teal overhead, warm peach at the horizon, teal bounce below."""
    world = bpy.data.worlds.new("mend_world")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = _node(nt, "ShaderNodeOutputWorld")
    bg = _node(nt, "ShaderNodeBackground")
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    coord = _node(nt, "ShaderNodeTexCoord")
    sep = _node(nt, "ShaderNodeSeparateXYZ")
    nt.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    pos = _map_range(nt, sep.outputs["Z"], -1.0, 1.0)
    ramp = _node(nt, "ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = _rgba(palette.QUILT["teal"])
    ramp.color_ramp.elements[1].position = 0.9
    ramp.color_ramp.elements[1].color = _rgba(palette.SKY_TOP)
    mid = ramp.color_ramp.elements.new(0.52)
    mid.color = _rgba(palette.SKY_HORIZON)
    nt.links.new(pos.outputs["Result"], ramp.inputs["Factor"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    scene.world = world
    return world
