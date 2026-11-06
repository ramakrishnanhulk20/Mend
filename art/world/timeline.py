"""Timing of the Mend hero film: pure functions of an integer frame at 24 fps. No Blender, no scene geometry.

Frames 1 to 216 are the story, played once. Frames 217 to 312 are the ambient loop, and frame 313 equals
frame 217 exactly. Every function here returns plain numbers: progress values, heights, angles. animate.py
turns them into positions in the scene.

Run this file with any Python to print the key frames:  python timeline.py
"""
import math

FPS = 24
STORY_START, STORY_END = 1, 216
AMBIENT_START, AMBIENT_END = 217, 312
LOOP_FRAMES = 96

STITCH_STARTS = (12, 44, 76)
STITCH_LENGTH = 32
NEEDLE_HOVER = 0.6
NEEDLE_BURY = 0.2
NEEDLE_RISE_ARC = 0.3
NEEDLE_LEAVE = (108, 136)
FRAY_SETTLE = (108, 132)

COIN_POP = (84, 96)
COIN_ROLL = (96, 186)
COIN_HOP = (186, 198)
COIN_BUMP = 0.05
COIN_HOP_HEIGHT = 0.45

WALLET_SQUASH_KEYS = ((198, 1.0), (201, 0.92), (204, 1.03), (206, 1.0))
CARD_SLIDE = (198, 210)
CARD_RISE = 0.25
CARD_OVERSHOOT = 2.2
WINDOW_GLOW = (200, 216)

CUSTOMER_TURN = (202, 216)
CUSTOMER_HOP_HEIGHT = 0.12
CUSTOMER_HOPS = ((202, 207), (209, 214))
CUSTOMER_SQUASH_FRAMES = 2
CUSTOMER_SQUASH = 0.07
CUSTOMER_BOB = 0.02

OWNER_WAVE_DEG = 12.0
OWNER_WAVE_PERIOD_STORY = 36
OWNER_WAVE_PERIOD_AMBIENT = 48

CLOUD_DRIFT = 0.12
TREE_SWAY_DEG = 0.6


def clamp01(x):
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def smoothstep(x):
    x = clamp01(x)
    return x * x * (3.0 - 2.0 * x)


def ease_in(x):
    x = clamp01(x)
    return x * x


def ease_out(x):
    x = clamp01(x)
    return 1.0 - (1.0 - x) ** 2


def ease_out_back(x, overshoot=CARD_OVERSHOOT):
    x = clamp01(x)
    c3 = overshoot + 1.0
    return 1.0 + c3 * (x - 1.0) ** 3 + overshoot * (x - 1.0) ** 2


def span(frame, start, end):
    """0 before `start`, 1 after `end`, a straight ramp between."""
    return clamp01((frame - start) / float(end - start))


def ambient_tau(frame):
    """Frames since the ambient loop began. Zero for the whole story, so ambient offsets are all zero there."""
    return max(0, frame - AMBIENT_START)


def needle(frame):
    """Needle tip as a blend between two dive points, plus a height above the quilt.

    `i` and `w`: the tip sits at dive point i blended w of the way to point i + 1. `lift` is the height
    above the quilt, negative while the tip is buried. `leave` is the eased progress of the exit along the
    needle's own axis. `gone` is true once the needle has left the frame and is removed. `cycle` is the
    stitch being sewn, or None. Dive points 0 to 2 are the far left corners of the three X's; point 3 is
    where a fourth would start.
    """
    first = STITCH_STARTS[0]
    if frame < first:
        return {"i": 0, "w": 0.0, "lift": NEEDLE_HOVER, "leave": 0.0, "gone": False, "cycle": None}
    for k, c in enumerate(STITCH_STARTS):
        local = frame - c
        if 0 <= local < STITCH_LENGTH:
            if local < 10:
                lift = NEEDLE_HOVER - (NEEDLE_HOVER + NEEDLE_BURY) * ease_in(local / 10.0)
                return {"i": k, "w": 0.0, "lift": lift, "leave": 0.0, "gone": False, "cycle": k}
            if local < 16:
                return {"i": k, "w": 0.0, "lift": -NEEDLE_BURY, "leave": 0.0, "gone": False, "cycle": k}
            e = ease_out((local - 16) / 16.0)
            lift = -NEEDLE_BURY + (NEEDLE_HOVER + NEEDLE_BURY) * e + NEEDLE_RISE_ARC * math.sin(math.pi * e)
            return {"i": k, "w": e, "lift": lift, "leave": 0.0, "gone": False, "cycle": k}
    leave = ease_in(span(frame, *NEEDLE_LEAVE))
    return {"i": 3, "w": 0.0, "lift": NEEDLE_HOVER, "leave": leave, "gone": frame >= NEEDLE_LEAVE[1], "cycle": None}


def root(frame):
    """Where the strand is anchored: anchor m blended w of the way to m + 1.

    Anchor 0 is the frayed end of the road, anchors 1 to 3 are the dive points. The anchor slides while the
    tip is hidden in the quilt, so the strand never jumps.
    """
    m, w = 0, 0.0
    for k, c in enumerate(STITCH_STARTS):
        local = frame - c
        if local >= 16:
            m, w = k + 1, 0.0
        elif local >= 10:
            m, w = k, smoothstep((local - 10) / 6.0)
    return {"m": m, "w": w}


def arms(frame):
    """Growth of each X's two arms, 0 to 1, as (arm1, arm2) per stitch. Length grows continuously."""
    out = []
    for c in STITCH_STARTS:
        out.append((smoothstep(span(frame, c, c + 16)), smoothstep(span(frame, c + 16, c + 32))))
    return out


CORNERS = ("NL", "FL", "FR", "NR")


def dimples(frame):
    """Depth factor 0 to 1 of the 12 dents in the quilt, three X's by four corners (NL, FL, FR, NR)."""
    out = []
    for c in STITCH_STARTS:
        out += [smoothstep(span(frame, c, c + 6)), smoothstep(span(frame, c + 8, c + 12)),
                smoothstep(span(frame, c + 10, c + 16)), smoothstep(span(frame, c + 26, c + 32))]
    return out


def fray_settle(frame):
    return smoothstep(span(frame, *FRAY_SETTLE))


def coin(frame):
    """`roll` is the eased fraction of the road covered, `hop` the linear fraction of the hop, `hidden` once inside."""
    u = span(frame, *COIN_POP)
    pop = 1.0 if u >= 1.0 else smoothstep(u) * (1.0 + 0.35 * math.sin(math.pi * u))
    return {"roll": smoothstep(span(frame, *COIN_ROLL)), "hop": span(frame, *COIN_HOP), "pop": pop,
            "hidden": frame < COIN_POP[0] or frame >= COIN_HOP[1]}


def wallet_height(frame):
    keys = WALLET_SQUASH_KEYS
    if frame <= keys[0][0]:
        return keys[0][1]
    for (f0, v0), (f1, v1) in zip(keys[:-1], keys[1:]):
        if frame <= f1:
            return v0 + (v1 - v0) * smoothstep((frame - f0) / float(f1 - f0))
    return keys[-1][1]


def card_offset(frame):
    """Height of the card relative to its finished position: down 0.25 at the start, 0 at the end."""
    return -CARD_RISE + CARD_RISE * ease_out_back(span(frame, *CARD_SLIDE))


def window_glow(frame):
    return smoothstep(span(frame, *WINDOW_GLOW))


def customer(frame):
    """Two small hops, a squash after each landing, and the turn to face the camera."""
    lift = 0.0
    squash = 0.0
    for start, end in CUSTOMER_HOPS:
        if start <= frame < end:
            u = (frame - start) / float(end - start)
            lift = CUSTOMER_HOP_HEIGHT * 4.0 * u * (1.0 - u)
        since = frame - end
        if 0 <= since < CUSTOMER_SQUASH_FRAMES:
            squash = CUSTOMER_SQUASH * math.sin(math.pi * since / CUSTOMER_SQUASH_FRAMES)
    tau = ambient_tau(frame)
    bob = CUSTOMER_BOB * 0.5 * (1.0 - math.cos(2.0 * math.pi * tau / 48.0))
    return {"lift": lift + bob, "squash": squash, "turn": smoothstep(span(frame, *CUSTOMER_TURN))}


def owner_wave_deg(frame):
    """Raised arm angle in degrees. Phase counts from frame 1 in the story and from frame 217 in the loop.

    216 is six whole story periods after frame 1, so the story ends at phase zero and the loop starts at
    phase zero: the two sines join with no jump.
    """
    if frame < AMBIENT_START:
        return OWNER_WAVE_DEG * math.sin(2.0 * math.pi * (frame - STORY_START) / OWNER_WAVE_PERIOD_STORY)
    return OWNER_WAVE_DEG * math.sin(2.0 * math.pi * (frame - AMBIENT_START) / OWNER_WAVE_PERIOD_AMBIENT)


def cloud_drift(frame):
    """Sideways offset in scene units for a cloud with direction +1. Zero through the whole story."""
    return CLOUD_DRIFT * math.sin(2.0 * math.pi * ambient_tau(frame) / LOOP_FRAMES)


def tree_sway_deg(frame, phase):
    """Sway angle of one tree. The phase differs per tree and the offset is zero at frame 217."""
    tau = ambient_tau(frame)
    return TREE_SWAY_DEG * (math.sin(2.0 * math.pi * tau / LOOP_FRAMES + phase) - math.sin(phase))


def pose(frame):
    return {"needle": needle(frame), "root": root(frame), "arms": arms(frame), "dimples": dimples(frame),
            "fray": fray_settle(frame), "coin": coin(frame), "wallet": wallet_height(frame),
            "card": card_offset(frame), "glow": window_glow(frame), "customer": customer(frame),
            "owner": owner_wave_deg(frame), "cloud": cloud_drift(frame)}


if __name__ == "__main__":
    for f in (1, 11, 12, 17, 21, 22, 28, 33, 44, 60, 76, 92, 96, 108, 112, 122, 130, 136, 150, 186, 192, 198, 201,
              204, 206, 210, 216, 217, 264, 312, 313):
        p = pose(f)
        n = p["needle"]
        print("f%3d needle i=%d w=%.2f lift=%+.2f leave=%.2f gone=%d | root m=%d w=%.2f | arms %s | dimples on %d | "
              "fray %.2f | coin roll %.3f hop %.2f hid=%d | wallet %.3f card %+.3f glow %.2f | cust lift %.3f sq %.3f "
              "turn %.2f | owner %+.1f | cloud %+.3f tree(1.0) %+.3f" % (
                  f, n["i"], n["w"], n["lift"], n["leave"], n["gone"], p["root"]["m"], p["root"]["w"],
                  " ".join("%.2f/%.2f" % a for a in p["arms"]), sum(1 for d in p["dimples"] if d > 0.5), p["fray"],
                  p["coin"]["roll"], p["coin"]["hop"], p["coin"]["hidden"], p["wallet"], p["card"], p["glow"],
                  p["customer"]["lift"], p["customer"]["squash"], p["customer"]["turn"], p["owner"], p["cloud"],
                  tree_sway_deg(f, 1.0)))
    worst = max(abs(owner_wave_deg(217) - owner_wave_deg(216)), 0.0)
    print("owner step 216 to 217: %.2f deg" % worst)
    print("loop closes: pose(313) == pose(217): %s" % (
        all(abs(a - b) < 1e-9 for a, b in ((cloud_drift(313), cloud_drift(217)), (tree_sway_deg(313, 2.0), tree_sway_deg(217, 2.0)),
                                           (owner_wave_deg(313), owner_wave_deg(217)),
                                           (customer(313)["lift"], customer(217)["lift"])))))
    print("overshoot of card slide: max %.4f of 1" % max(ease_out_back(i / 100.0) for i in range(101)))
