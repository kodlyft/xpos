"""Gift card codes: format, entropy and what is ever shown of them."""

import re
import unittest

from xpos.x_pos.gift_cards import (
	CODE_ALPHABET,
	CODE_LENGTH,
	generate_code,
	hash_code,
	mask_code,
	normalize_code,
)


class TestGiftCardCodes(unittest.TestCase):
	def test_codes_are_long_random_and_readable(self):
		codes = {generate_code() for _ in range(2000)}
		self.assertEqual(len(codes), 2000)
		for code in list(codes)[:50]:
			self.assertRegex(code, r"^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$")
			self.assertTrue(set(code.replace("-", "")) <= set(CODE_ALPHABET))
		# 32 symbols x 16 places = 80 bits, far beyond guessing within the lookup lockout
		self.assertEqual(len(CODE_ALPHABET) ** CODE_LENGTH, 2**80)
		self.assertFalse(re.search(r"[ILOU]", "".join(codes)))

	def test_typed_codes_normalise_to_the_same_hash(self):
		code = "AB0C-D1EF-GH23-JK45"
		for typed in ("ab0c d1ef gh23 jk45", "ABOC-DIEF-GH23-JK45", "AB0CD1EFGH23JK45"):
			self.assertEqual(normalize_code(typed), "AB0CD1EFGH23JK45")
			self.assertEqual(hash_code(typed), hash_code(code))
		self.assertNotEqual(hash_code(code), hash_code("AB0C-D1EF-GH23-JK46"))

	def test_mask_shows_only_the_last_four(self):
		self.assertEqual(mask_code("JK45"), "••••-JK45")
		self.assertNotIn("AB0C", mask_code("JK45"))
