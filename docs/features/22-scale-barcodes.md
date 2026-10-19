# Scale Barcode Support

X POS supports barcode parsing for weighing scales - used in retail environments where items are weighed and a barcode label is printed containing the item code and weight (and optionally price).

---

## Overview

Many grocery stores, butchers, and produce retailers use digital weighing scales that print barcode labels encoding:
- A **prefix** identifying the barcode type
- An **item code** segment
- A **weight** segment (with decimal precision)
- Optionally, a **price** segment

X POS can parse these barcodes and automatically add the correct item with the right quantity (weight) to the cart.

---

## Scale Barcode Settings

The **Scale Barcode Settings** screen configures how to parse scale barcodes:

### Prefix Configuration
| Field | Description |
|---|---|
| Prefix Included | Whether the barcode has a fixed prefix |
| Number of Prefix Characters | Length of the prefix segment |
| Prefix | Expected prefix value (e.g., "331", "99") |

### Item Code Segment
| Field | Description |
|---|---|
| Item Code Starting Position | Position where the item code starts |
| Item Code Total Digits | Number of digits in the item code segment |

### Weight Segment
| Field | Description |
|---|---|
| Weight Starting Position | Position where weight starts |
| Weight digits (`weight_total_digits`) | Number of digits **before** the decimal point |
| Weight decimals (`weight_decimals`) | Number of digits after the decimal point |

### Price Segment (Optional)
| Field | Description |
|---|---|
| Price Included | Whether the barcode contains a price |
| Price Starting Position | Position where price starts |
| Price Total Digits | Number of integer digits in the price |
| Price Decimals | Number of decimal digits in the price |

---

## How the weight segment is measured

**Weight digits counts the digits before the decimal point, not the length of the whole field.**
The weight segment therefore spans `Weight digits + Weight decimals` characters. Getting this
backwards is the most common configuration mistake, and it yields a quantity wrong by a factor of
ten or more rather than an error.

With Weight starting position 8, Weight digits 2 and Weight decimals 3, the parser reads positions
8-9 as the whole part and positions 10-12 as the decimals, then joins them: `"00" + "." + "205"`.

---

## Example

### Barcode format: `P IIIIII WWWWW C`
```
Barcode:  2001001002053
          │├────┤├───┤│
          ││     │    └── Check digit: not read by the parser
          ││     └── Weight: 00.205 → 0.205 kg
          │└── Item code: 001001
          └── Prefix: 2
```

### Settings
```
Prefix included in barcode:   Yes
Prefix length:                1
Prefix:                       2
Item code starting position:  2
Item code digits:             6
Weight starting position:     8
Weight digits:                2
Weight decimals:              3
Price included in barcode:    No
```

### Result
- Item code: `001001`, matched against the Item name first, then Item Barcode records
- Quantity: `0.205` kg
- Rate comes from the price list, so the line total is rate x 0.205

Leading zeros are significant: the item code is matched as the string `001001`, not as `1001`.

### A note on positions

Positions are 1-indexed against the full barcode, including the prefix. This layout is gap-free for
a 13-digit EAN: 1 prefix + 6 item code + 5 weight + 1 check digit.

One sample barcode cannot always prove where the item code ends and the weight begins, because a
boundary digit is often `0` either way. Confirm the layout against the scale's own PLU configuration
software before going live.

---

## How It Works in the POS

1. The cashier scans a scale barcode using the barcode scanner
2. X POS first tries to match the barcode against Item Barcode records and direct item codes
3. If no match is found, the **scale barcode parser** is invoked
4. The parser:
   - Checks if the barcode starts with the configured prefix
   - Extracts the item code segment
   - Extracts the weight segment (with decimal precision)
   - Optionally extracts the price segment
   - Looks up the item by the extracted code
5. If the item is found:
   - It is added to the cart with the extracted weight as the quantity
   - The price may be overridden if the barcode contains price data

---

## Configuration Steps

1. Navigate to **Scale Barcode Settings** in the system
2. Enable the prefix check if your scale barcodes use one
3. Enter the prefix value and length
4. Map the digit positions for item code, weight, and optionally price
5. Save the settings
6. Test with a sample barcode to verify parsing

---

## Testing

| Suite | Covers |
|---|---|
| `xpos/api/tests/test_scale_barcode.py` | The decoding itself: prefixes, digit windows, implied decimals, malformed input |
| `frontend/tests/e2e/specs/scale-barcodes.cy.ts` | What the screen does with the result: the weight reaching the cart line, the price, the quantity prompt being skipped, and the not-found path |

Watch the e2e run at human speed with:

```bash
node scripts/run-cypress.mjs run --with-server --demo --spec tests/e2e/specs/scale-barcodes.cy.ts
```

---

## Tips

- Scale barcode formats vary by manufacturer - consult your scale's manual for the exact format
- Use the prefix to distinguish scale barcodes from regular product barcodes
- Test thoroughly with actual scale-printed barcodes before going live
- Weight decimals are critical - incorrect decimal placement will result in wrong quantities
- This feature works offline when items are pre-cached
