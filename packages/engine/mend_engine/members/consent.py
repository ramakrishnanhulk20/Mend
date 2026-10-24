"""The words a customer agrees to when they join a shop's thank-you list (C28).

Each member row stores CONSENT_VERSION and the SHA-256 of the exact text they saw,
so a later change of wording can never be passed off as what an earlier member
agreed to. Any change to CONSENT_TEXT needs a new CONSENT_VERSION.
"""

from __future__ import annotations

import hashlib
import unicodedata

CONSENT_VERSION = "2026-10-20.1"
CONSENT_TEXT = (
    "{shop_name} may look at your past orders with them and send you thank-you cashback "
    "to this PayPal account. You can leave at any time."
)
DEMO_SHOP_NAME = "Wolf and Wren Gifts"
MAX_SHOP_NAME_CHARS = 100


def consent_text_for(shop_name: str) -> str:
    """The exact consent wording a customer of shop_name agrees to.

    Raises ValueError if shop_name is not text, is blank, has leading or trailing
    spaces, is longer than 100 characters, or holds any character in Unicode's
    "other" group (controls, invisible format marks such as direction overrides,
    surrogates, private-use and unassigned code points).
    """
    if type(shop_name) is not str:
        raise ValueError("shop name must be text")
    if not shop_name.strip() or shop_name != shop_name.strip():
        raise ValueError("shop name must be non-blank with no leading or trailing spaces")
    if len(shop_name) > MAX_SHOP_NAME_CHARS:
        raise ValueError(f"shop name must be at most {MAX_SHOP_NAME_CHARS} characters")
    if any(unicodedata.category(ch).startswith("C") for ch in shop_name):
        raise ValueError("shop name has a control or invisible character")
    return CONSENT_TEXT.format(shop_name=shop_name)


def consent_hash(text: str) -> str:
    """SHA-256 of text as UTF-8, in lowercase hex. Raises ValueError if text is not a str."""
    if type(text) is not str:
        raise ValueError("consent text must be text")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
