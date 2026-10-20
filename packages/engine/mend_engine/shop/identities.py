"""Synthetic identities for the demo shop's customers (C25).

The source file holds a customer number and a country, nothing else about a person.
Every name and email the demo shows is generated here from that number, so no real
person can enter the system and no generated email can ever receive mail.
"""

from __future__ import annotations

import hashlib
import re

# .example is reserved by RFC 2606: no address under it can ever receive mail.
SYNTHETIC_DOMAIN = "shop.example"

FIRST_NAMES = (
    "Maya", "Arjun", "Lena", "Omar", "Priya", "Theo", "Amara", "Kenji", "Sofia", "Diego",
    "Nadia", "Felix", "Ines", "Ravi", "Zara", "Hugo", "Leila", "Mateo", "Anya", "Kofi",
    "Elena", "Yusuf", "Clara", "Dev", "Mira", "Oscar", "Tara", "Jonas", "Ayesha", "Luca",
    "Noor", "Emil", "Sana", "Rafael", "Ivy", "Kiran", "Freya", "Malik", "Rosa", "Tomas",
)
INITIALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

MAX_SOURCE_ID = 999_999_999
_REF = re.compile(r"C[1-9][0-9]{0,8}", re.ASCII)


def customer_ref(source_id: int) -> str:
    """Turn a source customer number into the shop's customer reference: 13085 becomes "C13085".

    Raises ValueError for anything that is not a whole number from 1 to 999,999,999
    (bools included).
    """
    if type(source_id) is not int or not 1 <= source_id <= MAX_SOURCE_ID:
        raise ValueError("source customer id must be a whole number from 1 to 999999999")
    return f"C{source_id}"


def display_name(ref: str) -> str:
    """Generate the customer's display name, such as "Maya R.", from their reference.

    The same reference always gives the same name. A hash of the reference picks the
    name, never the digits themselves, so the name carries nothing that leads back to
    the source number. Names repeat across customers; emails do not. Raises ValueError
    for a malformed reference.
    """
    digest = hashlib.sha256(b"mend-display-name:" + _checked(ref).encode("ascii")).digest()
    first = FIRST_NAMES[int.from_bytes(digest[0:4], "big") % len(FIRST_NAMES)]
    initial = INITIALS[int.from_bytes(digest[4:8], "big") % len(INITIALS)]
    return f"{first} {initial}."


def synthetic_email(ref: str) -> str:
    """Generate the customer's email, such as "c13085@shop.example". Unique per reference.

    Raises ValueError for a malformed reference.
    """
    return f"{_checked(ref).lower()}@{SYNTHETIC_DOMAIN}"


def _checked(ref: str) -> str:
    if type(ref) is not str or not _REF.fullmatch(ref):
        raise ValueError("customer reference must be C followed by the source number")
    return ref
