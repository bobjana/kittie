# Money and split core

All money in Kittie is integer minor units. For EUR, one major unit is 100
minor units (cents). `300.00 EUR` is stored and computed as `30000`. No
floating point arithmetic exists in the domain: division, remainder and
rounding are all integer operations (BigInt for the percentage scaling, so
results stay exact beyond `Number.MAX_SAFE_INTEGER`).

The engine is `computeShares` in `src/domain/split.ts`. Inputs are validated
first by `validateExpenseInput` in `src/domain/validation.ts`; the server
validates every write, never the client. `computeShares` assumes validated
input.

## Algorithm

For an expense with total `T` (integer minor units) and participants with
personal carve-outs `p_i`:

1. Personal carve-out first: `P = sum(p_i)`, remainder `R = T - P`.
2. Every share gets its personal amount back, plus a slice of `R`:

   `share_i = p_i + s_i`, where `sum(s_i) = R`.

3. Equal mode: `s_i = floor(R / n)` for every member, and the leftover units
   (`R mod n`) are distributed one each to the members in canonical order
   (the order of the participants array).

4. Percentage mode: basis points `bp_i` (integers, `0..10000`, summing to
   exactly `10000`) apply to `R`, **not** to `T`. `s_i = floor(R * bp_i /
   10000)` with the leftover units handed out by largest remainder; ties go
   to the earlier member in canonical order. Every share is within one minor
   unit of its exact proportion.

5. The result always reconciles exactly: `sum(shares) === T` and
   `remainderMinor === 0`.

`computeShares` returns `{ shares: [{ memberId, shareMinor }], remainderMinor }`.
`remainderMinor` is the unassigned residue `T - sum(shares)`, always `0` for
validated input; it exists as a reconciliation check, not as leftover money.

## Golden vectors

Canonical vectors live in `tests/unit/domain/vectors.ts`; the same values are
asserted in the unit tests.

### Equal mode (EQ)

| ID     | Total | Personals       | Expected shares |
| ------ | ----- | --------------- | --------------- |
| EQ-01  | 30000 | A 5000          | 17500 / 12500   |
| EQ-02  | 1000  | none            | 334 / 333 / 333 |
| EQ-03  | 1000  | A 1             | 501 / 499       |
| EQ-04  | 1000  | A 1000 (payer)  | 1000 / 0        |
| EQ-05  | 1000  | A 1000 (B pays) | 1000 / 0        |
| EQ-06  | 500   | none            | 500             |
| EQ-07  | 10000 | A 2000, B 3000  | 3667 / 4667 / 1666 |
| EQ-08  | 300   | A 50            | 175 / 125       |

EQ-08 is the canonical worked example: total 300, one member takes 50
personally, the remaining 250 split evenly gives 175 and 125.

### Percentage mode (PCT)

| ID     | Total | Personal | Basis points      | Expected shares    |
| ------ | ----- | -------- | ----------------- | ------------------ |
| PCT-01 | 1000  | none     | 5000/3000/2000    | 500 / 300 / 200    |
| PCT-02 | 1000  | none     | 3333/3333/3334    | 333 / 333 / 334    |
| PCT-03 | 999   | none     | 5000/5000         | 500 / 499          |
| PCT-04 | 30000 | A 5000   | 5000/5000         | 17500 / 12500      |
| PCT-05 | 1000  | none     | 6000/4000/0       | 600 / 400 / 0      |

PCT-02: exact shares are 333.3 / 333.3 / 333.4; C has the largest remainder
and receives the extra minor unit.

PCT-03: the tie (5000/5000) falls back to canonical order, so A gets the
extra unit.

PCT-04 is the combined example: total 30000, A takes 5000 personally,
`R = 25000`, and 5000/5000 basis points of **R** gives A `5000 + 12500 =
17500` and B `12500`. If percentages applied to the total, B would get
15000 - which is wrong and why the rule is carve-out first.

### Edit scenarios (EDIT)

| ID      | Scenario                                    | Input                    | Expected shares |
| ------- | ------------------------------------------- | ------------------------ | --------------- |
| EDIT-01 | adding a personal contribution              | 1000 equal, A 100        | 550 / 450       |
| EDIT-02 | switching equal to percentage               | 1000 pct, 2500/7500      | 250 / 750       |
| EDIT-03 | removing a participant                      | 1000 equal, A + B        | 500 / 500       |
| EDIT-04 | swapping percentages                        | 1000 pct, 4000/6000      | 400 / 600       |
| EDIT-05 | clearing the payer's personal amount        | 30000 equal, no personal | 15000 / 15000   |

## Validation

`validateExpenseInput` checks, in this order, and returns
`{ ok: false, code, message }` with a named code on the first violation:

| Code                      | Condition                                          |
| ------------------------- | -------------------------------------------------- |
| `INVALID_MODE`            | mode is not `equal` or `percentage`                |
| `TOTAL_NOT_INTEGER`       | `totalMinor` is not an integer                     |
| `TOTAL_NOT_POSITIVE`      | `totalMinor <= 0`                                  |
| `EMPTY_PARTICIPANTS`      | participants list is empty                         |
| `PERSONAL_NOT_INTEGER`    | a `personalMinor` is not an integer                |
| `NEGATIVE_PERSONAL`       | a `personalMinor < 0`                              |
| `PERSONAL_EXCEEDS_TOTAL`  | a `personalMinor > totalMinor`                     |
| `PERSONAL_SUM_EXCEEDS_TOTAL` | the sum of all `personalMinor` exceeds the total |
| `PAYER_NOT_MEMBER`        | the payer is not among the event's member ids      |
| `BP_REQUIRED`             | percentage mode with a missing `splitBp`           |
| `BP_OUT_OF_RANGE`         | a `splitBp` is not an integer in `0..10000`        |
| `PCT_SUM_INVALID`         | the `splitBp` sum is not exactly `10000`           |

The payer may be any event member, not necessarily a participant of the
expense (see the permissions matrix in `docs/PERMISSIONS.md`).
