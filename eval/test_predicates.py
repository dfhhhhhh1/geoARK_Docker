#!/usr/bin/env python3
"""
Tests for the assertion matcher.

The matcher decides every number this harness reports, so a bug here is
invisible and corrupts all of it. `any_of` short-circuiting past its sibling
fields was exactly that: it silently turned
`{desc: "povert", any_of: [{start: "2015"}]}` into "any row from 2015",
inflating the score with no visible symptom.

    python3 eval/test_predicates.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run import row_matches  # noqa: E402

POVERTY = {"attr_desc": "Poverty rate 2015", "tags": "['poverty','socioeconomic']",
           "dataset_clean": "ACS_combined", "entity_type": "COUNTY",
           "start_date": "2015", "end_date": "2015"}
UNEMP = {"attr_desc": "Unemployment rate 2015", "tags": "['unemployment']",
         "dataset_clean": "ACS_combined", "entity_type": "COUNTY",
         "start_date": "2015", "end_date": "2015"}

CASES = [
    # (row, predicate, expected, label)
    (POVERTY, {"desc": "povert"}, True, "desc regex is case-insensitive"),
    (POVERTY, {"desc": "unemploy"}, False, "non-matching desc"),
    (POVERTY, {"tags": "socioeconomic"}, True, "tags"),
    (POVERTY, {"dataset": "acs"}, True, "dataset is case-insensitive"),
    (POVERTY, {"entity": "COUNTY"}, True, "entity is an exact match"),
    (POVERTY, {"entity": "county"}, False, "entity is case-SENSITIVE"),
    (POVERTY, {"start": "2015"}, True, "start_date"),
    (POVERTY, {"end": "2017"}, False, "end_date mismatch"),

    # Multiple fields are ANDed.
    (POVERTY, {"desc": "povert", "entity": "COUNTY"}, True, "AND, both true"),
    (POVERTY, {"desc": "povert", "entity": "STATE"}, False, "AND, one false"),

    # any_of is ORed internally...
    (POVERTY, {"any_of": [{"start": "2020"}, {"start": "2015"}]}, True, "any_of, second hits"),
    (POVERTY, {"any_of": [{"start": "2020"}, {"start": "2019"}]}, False, "any_of, none hit"),

    # ...and ANDed with its siblings. The regression that motivated this file:
    (POVERTY, {"desc": "povert", "any_of": [{"start": "2015"}]}, True,
     "any_of + sibling, both true"),
    (UNEMP, {"desc": "povert", "any_of": [{"start": "2015"}]}, False,
     "any_of true but sibling FALSE -> False"),
    (POVERTY, {"desc": "povert", "any_of": [{"start": "1999"}]}, False,
     "sibling true but any_of FALSE -> False"),

    # Missing fields must not crash or match.
    ({}, {"start": "2015"}, False, "empty row"),
    ({}, {}, True, "empty predicate matches anything"),
]


def main() -> int:
    failures = 0
    for row, pred, want, label in CASES:
        got = row_matches(row, pred)
        if got != want:
            failures += 1
            print(f"  FAIL {label}\n       {pred}\n       expected {want}, got {got}")
        else:
            print(f"  ok   {label}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
