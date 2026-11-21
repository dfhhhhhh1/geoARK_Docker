"""
Reference values for the `moran` op from PySAL (esda 2.10.0, libpysal 4.x).

Reads CSVs dumped from the live database (see README.md), builds the same
weights GeoARK uses (county_neighbors, i.e. queen contiguity by ST_Intersects,
restricted to the units that have a value), and writes esda's global and local
Moran's I for each case to a JSON file that compare_pysal.js checks the Node
implementation against.

    python pysal_gold.py <data_dir> <out.json> [permutations]

Needs numpy, esda, libpysal: install them in a scratch venv, not the project.
"""
import csv
import json
import sys

import numpy as np
import esda
import libpysal

CASES = [
    ("poverty_national", "PCTPOVALL.csv", None),
    ("obesity_national", "PLACES_OBESITY_CrdPrv.csv", None),
    ("unemployment_national", "UNEMPLOYMENT_RATE.csv", None),
    # Within an area: weights over Texas counties and their Texas neighbours.
    ("poverty_texas", "PCTPOVALL.csv", "48"),
    ("obesity_missouri", "PLACES_OBESITY_CrdPrv.csv", "29"),
]


def read_values(path, state):
    out = {}
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if state and not r["fips"].startswith(state):
                continue
            out[r["fips"]] = float(r["value"])
    return out


def main():
    data_dir, out_path = sys.argv[1], sys.argv[2]
    perms = int(sys.argv[3]) if len(sys.argv) > 3 else 9999
    adj = {}
    with open(f"{data_dir}/neighbors.csv", newline="") as f:
        for r in csv.DictReader(f):
            adj.setdefault(r["fips"], []).append(r["neighbor_fips"])

    results = {"esda": esda.__version__, "libpysal": libpysal.__version__,
               "permutations": perms, "cases": {}}
    for name, file, state in CASES:
        vals = read_values(f"{data_dir}/{file}", state)
        ids = sorted(vals)
        present = set(ids)
        nb = {i: sorted(j for j in adj.get(i, []) if j in present and j != i) for i in ids}
        w = libpysal.weights.W(nb, id_order=ids, silence_warnings=True)
        y = np.array([vals[i] for i in ids])
        g = esda.Moran(y, w, transformation="r", permutations=perms)
        loc = esda.Moran_Local(y, w, transformation="r", permutations=perms, seed=1)
        results["cases"][name] = {
            "file": file, "state": state, "n": len(ids), "islands": len(w.islands),
            "global": {"I": g.I, "EI": g.EI, "VI_rand": g.VI_rand, "z_rand": g.z_rand,
                       "p_rand": g.p_rand, "p_sim": g.p_sim},
            "local": {i: {"Is": float(loc.Is[k]), "q": int(loc.q[k]), "p_sim": float(loc.p_sim[k])}
                      for k, i in enumerate(ids)},
            "labels": dict(zip(ids, loc.get_cluster_labels(0.05).tolist())),
        }
        print(name, len(ids), "I", round(g.I, 6), "islands", len(w.islands))
    with open(out_path, "w") as f:
        json.dump(results, f)


if __name__ == "__main__":
    main()
