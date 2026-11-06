"""Colours for the Mend world, as display hex strings, plus a hex to linear helper."""

SEED = 7

SKY_TOP = "#A8E2EE"
SKY_HORIZON = "#FFE7C8"
CLOUD = "#FFF6EA"

FAR_HILLS = ["#6FCFBE", "#8FDDCF"]

QUILT = {
    "teal": "#3FBFAE",
    "sage": "#8FD18F",
    "butter": "#FFD45E",
    "peach": "#FFB27A",
    "sky": "#6EC5F0",
}
# Teal and butter lead and peach is rare, so the land reads as a quilt and the yarn is the one strong red.
QUILT_WEIGHTS = {"teal": 0.30, "butter": 0.28, "sky": 0.23, "sage": 0.14, "peach": 0.05}

STITCH = "#FFF1DC"

SHOP = {
    "walls": "#FFF1DC",
    "roof": "#6C7BD9",
    "awning_a": "#E8402A",
    "awning_b": "#FFF1DC",
    "door": "#2F8F83",
    "sign": "#FFF1DC",
}

HOUSES = {
    "A": {"walls": "#FFD27A", "roof": "#2F8F83", "door": "#6C7BD9"},
    "B": {"walls": "#F7A9B8", "roof": "#7A5BA8", "door": "#2F8F83"},
    "C": {"walls": "#8CC9F0", "roof": "#E5A93B", "door": "#FFF1DC"},
    "D": {"walls": "#FFF1DC", "roof": "#3F7F9E", "door": "#F6D67E"},
}
# Wall colours and roof colours the small far houses draw from.
FAR_WALLS = ["#FFF1DC", "#FFD27A", "#F7A9B8", "#8CC9F0"]
FAR_ROOFS = ["#6C7BD9", "#2F8F83", "#7A5BA8", "#E5A93B", "#3F7F9E"]

WINDOW_FRAME = "#FFF1DC"
WINDOW_GLASS = "#5B4632"
WINDOW_GLOW = "#FFC46B"
TRUNK = "#8A5A3C"
CROWNS = ["#2F8F83", "#3FA69A", "#6FC7B8", "#9CCFA2"]

SUN = "#FFD9A8"
YARN = "#E8321E"
COIN = "#F5B62E"
WALLET = "#2B6CDE"
BUTTON = "#6FC7B8"
STEEL = "#A9AFB8"
SPOOL_WOOD = "#8A5A3C"
OWNER_HEAD = "#D9A070"
CUSTOMER_HEAD = "#A86F4A"
DOLL_FACE = "#3A2A20"
CHEEK = "#E8957A"
OWNER_HAIR = "#3A2A20"
CUSTOMER_HAIR = "#2F4F7F"
COIN_MARK = "#C98A12"
OWNER_BODY = "#2F8F83"
OWNER_APRON = "#FFF1DC"
CUSTOMER_BODY = "#6C7BD9"


def hex_to_rgb(hex_str):
    h = hex_str.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def _to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(hex_str):
    """Scene linear RGB for a display hex colour, which is what Blender colour sockets want."""
    r, g, b = hex_to_rgb(hex_str)
    return (_to_linear(r), _to_linear(g), _to_linear(b))
