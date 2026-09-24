"""The link code's shape: the public route only consults the link table for
a token that could be in it, so a legacy chat token never costs a lookup.
"""

from __future__ import annotations

import string

import pytest

from src.server.database.share_codes import (
    SHARE_CODE_LENGTH,
    is_share_code,
    mint_share_code,
)

_BASE62 = set(string.digits + string.ascii_letters)


def test_a_minted_code_is_twelve_base62_characters():
    for _ in range(50):
        code = mint_share_code()
        assert len(code) == SHARE_CODE_LENGTH == 12
        assert set(code) <= _BASE62
        assert is_share_code(code)


def test_two_mints_differ():
    assert mint_share_code() != mint_share_code()


@pytest.mark.parametrize(
    "value",
    [
        "a" * 11,
        "a" * 13,
        "abcdefghijk-",
        "abcdefghijk_",
        "abcdefghijkл",
        "abcdefghijk1\n",
        "",
        # A legacy 22-char base64url chat token.
        "AbCdEfGhIjKlMnOpQrStUv",
    ],
)
def test_anything_but_an_exact_twelve_base62_run_is_not_a_code(value):
    assert not is_share_code(value)
