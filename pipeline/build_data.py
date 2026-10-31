"""
#30DayMapChallenge 2026 · Day 1 · Points · Berlin
"Label vs. Reality" — do Berlin's official residential-location labels match what people pay?

Inputs (put them in ./input or pass --input):
  wohnlagenadr2026_1_*.json   Wohnlagen nach Adressen zum Berliner Mietspiegel 2026, WFS pages
                              (gdi.berlin.de/services/wfs/wohnlagenadr2026, EPSG:25833, dl-de/zero-2-0)
  Zensus2022_Durchschn_Nettokaltmiete_100m-Gitter.csv
                              Zensus 2022, average net rent per 100 m cell (EPSG:3035)

Outputs (docs/data):
  addresses.json   compact columnar address points for the web map
  cells.geojson    100 m cells with rent, label mix and mismatch class
  stats.json       Berlin and district summaries
Run:  python pipeline/build_data.py --input input
"""
import argparse, glob, json, zipfile
from pathlib import Path

import numpy as np
import pandas as pd
from pyproj import Transformer

CLASSES = ["einfach", "mittel", "gut"]
CODE = {"einfach": 0, "mittel": 1, "gut": 2}


def load_addresses(folder):
    rows = []
    for f in sorted(glob.glob(str(Path(folder) / "wohnlagenadr2026_1_*.json"))):
        j = json.load(open(f, encoding="utf-8"))
        for x in j["features"]:
            p, c = x["properties"], x["geometry"]["coordinates"]
            rows.append((p["schluessel"], p["wol"], p["bezname"], p["plr_name"], p["strasse"], p["hnr"], p["plz"], c[0], c[1]))
        matched = j.get("numberMatched")
    a = pd.DataFrame(rows, columns=["key", "wol", "bez", "plr", "str", "hnr", "plz", "x", "y"])
    n_raw = len(a)
    a = a.drop_duplicates("key").reset_index(drop=True)
    print(f"Addresses: {n_raw:,} read, {len(a):,} unique, WFS total {matched:,}")
    if matched and len(a) < matched:
        print(f"  WARNING: {matched - len(a):,} addresses missing (duplicate WFS pages?)")
    return a, matched


def load_rent(folder):
    f = next(Path(folder).rglob("Zensus2022_Durchschn_Nettokaltmiete_100m-Gitter.csv"))
    z = pd.read_csv(f, sep=";", dtype=str)
    z["rent"] = pd.to_numeric(z["durchschnMieteQM"].str.replace(",", ".", regex=False), errors="coerce")
    z["cx"] = z["x_mp_100m"].astype(int)
    z["cy"] = z["y_mp_100m"].astype(int)
    z["unsure"] = z["werterlaeuternde_Zeichen"].eq("KLAMMERN")
    return z[["cx", "cy", "rent", "unsure"]]


def gitter_id(cx, cy):
    """Zensus 2022 / INSPIRE 100 m grid id from the cell centre (EPSG:3035)"""
    return "CRS3035RES100mN" + (pd.Series(cy) - 50).astype(int).astype(str).values + "E" + (pd.Series(cx) - 50).astype(int).astype(str).values


SCORE_NAMES = {-2: "much cheaper than label", -1: "cheaper than label", 0: "as label suggests",
               1: "pricier than label", 2: "much pricier than label"}


def band(rent, q1, q2):
    """Berlin-wide rent third: 1 cheapest, 2 middle, 3 most expensive (NaN without rent)"""
    return np.where(pd.isna(rent), np.nan, np.where(rent < q1, 1, np.where(rent < q2, 2, 3)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="input")
    ap.add_argument("--out", default="docs/data")
    args = ap.parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)

    a, matched = load_addresses(args.input)
    to3035 = Transformer.from_crs(25833, 3035, always_xy=True)
    to4326 = Transformer.from_crs(25833, 4326, always_xy=True)
    a["ex"], a["ny"] = to3035.transform(a.x.values, a.y.values)
    a["lon"], a["lat"] = to4326.transform(a.x.values, a.y.values)
    a["cx"] = (np.floor(a.ex / 100) * 100 + 50).astype(int)
    a["cy"] = (np.floor(a.ny / 100) * 100 + 50).astype(int)
    a = a.merge(load_rent(args.input), on=["cx", "cy"], how="left")
    a["gitter_id"] = gitter_id(a.cx, a.cy)
    a["c"] = a["wol"].map(CODE)

    # ---------------------------------------------------------------- scoring
    # L = label level (1 einfach, 2 mittel, 3 gut); R = Berlin-wide rent third of the 100 m cell (1..3)
    # score = R − L  (−2 … +2): negative = rent lower than the label suggests, positive = higher
    q1, q2 = a["rent"].quantile([1 / 3, 2 / 3]).round(2).tolist()
    print(f"Rent terciles (address weighted): {q1} / {q2} €/m²")
    a["L"] = a["c"] + 1
    a["R"] = band(a["rent"], q1, q2)
    a["score"] = a["R"] - a["L"]

    # ---------------------------------------------------------------- cells
    g = a.groupby(["cx", "cy"])
    cells = g.agg(gitter_id=("gitter_id", "first"), rent=("rent", "first"), unsure=("unsure", "first"),
                  n=("key", "size")).reset_index()
    for k in CLASSES:
        cells[k[0]] = g["wol"].apply(lambda s, k=k: int((s == k).sum())).values
    cells = cells.dropna(subset=["rent"])
    cells["L"] = cells[["e", "m", "g"]].values.argmax(axis=1) + 1        # dominant label level
    cells["R"] = band(cells["rent"], q1, q2).astype(int)
    cells["s"] = cells["R"] - cells["L"]
    print(f"Cells with addresses and rent: {len(cells):,}")
    print(cells.s.value_counts().sort_index())

    fr = Transformer.from_crs(3035, 4326, always_xy=True)
    feats = []
    for r in cells.itertuples():
        xs = [r.cx - 50, r.cx + 50, r.cx + 50, r.cx - 50, r.cx - 50]
        ys = [r.cy - 50, r.cy - 50, r.cy + 50, r.cy + 50, r.cy - 50]
        lo, la = fr.transform(xs, ys)
        feats.append({"type": "Feature",
                      "properties": {"r": round(float(r.rent), 2), "n": int(r.n), "e": int(r.e), "m": int(r.m), "g": int(r.g),
                                     "L": int(r.L), "R": int(r.R), "s": int(r.s), "u": int(bool(r.unsure)), "id": r.gitter_id},
                      "geometry": {"type": "Polygon", "coordinates": [[[round(o, 5), round(t, 5)] for o, t in zip(lo, la)]]}})
    json.dump({"type": "FeatureCollection", "features": feats}, open(out / "cells.geojson", "w"), separators=(",", ":"))

    # ---------------------------------------------------------------- addresses (compact, columnar)
    streets = sorted(a["str"].unique().tolist())
    sidx = {s: i for i, s in enumerate(streets)}
    plrs = sorted(a["plr"].unique().tolist())
    pidx = {s: i for i, s in enumerate(plrs)}
    a = a.sort_values(["lon", "lat"]).reset_index(drop=True)
    addr = {
        "lon": (a.lon * 1e5).round().astype(int).tolist(),
        "lat": (a.lat * 1e5).round().astype(int).tolist(),
        "c": a["c"].tolist(),
        "s": a["str"].map(sidx).tolist(),
        "h": a["hnr"].str.lstrip("0").tolist(),
        "p": a["plr"].map(pidx).tolist(),
        "r": [None if pd.isna(v) else round(float(v), 2) for v in a["rent"]],
        "streets": streets, "plrs": plrs,
    }
    json.dump(addr, open(out / "addresses.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    # ---------------------------------------------------------------- scoring tables (CSV)
    t = a.assign(label=a.wol, rent_eur_m2=a.rent.round(2), rent_third=a.R.astype("Int64"), label_level=a.L,
                 score=a.score.astype("Int64"), score_text=a.score.map(SCORE_NAMES), value_in_brackets=a.unsure.fillna(False))
    cols = ["key", "str", "hnr", "plz", "bez", "plr", "label", "label_level", "gitter_id", "rent_eur_m2",
            "value_in_brackets", "rent_third", "score", "score_text"]
    t = t[cols].rename(columns={"key": "schluessel", "str": "strasse", "bez": "bezirk", "plr": "planungsraum"})
    with zipfile.ZipFile(out / "scores_addresses.csv.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("scores_addresses.csv", t.to_csv(index=False))

    def summarise(df, key):
        r = df.groupby(key).agg(addresses=("key", "size"), with_rent=("rent", "count"), mean_rent=("rent", "mean"),
                                share_einfach=("wol", lambda s: (s == "einfach").mean()),
                                share_mittel=("wol", lambda s: (s == "mittel").mean()),
                                share_gut=("wol", lambda s: (s == "gut").mean()),
                                mean_score=("score", "mean"),
                                share_cheaper=("score", lambda s: (s < 0).sum() / max(s.notna().sum(), 1)),
                                share_as_label=("score", lambda s: (s == 0).sum() / max(s.notna().sum(), 1)),
                                share_pricier=("score", lambda s: (s > 0).sum() / max(s.notna().sum(), 1)))
        return r.round(3).reset_index()

    plr = summarise(a, ["bez", "plr"]).rename(columns={"bez": "bezirk", "plr": "planungsraum"})
    plr.to_csv(out / "scores_planungsraum.csv", index=False)

    # ---------------------------------------------------------------- stats.json
    by = a.groupby("wol")["rent"]
    sc = a.dropna(subset=["score"])
    matrix = [[int(((sc.L == L) & (sc.R == R)).sum()) for R in (1, 2, 3)] for L in (1, 2, 3)]
    berlin = {"n": int(len(a)), "n_wfs": int(matched or len(a)), "with_rent": round(float(a.rent.notna().mean()), 3),
              "terciles": [q1, q2],
              "by_label": [{"label": k, "n": int((a.wol == k).sum()), "share": round(float((a.wol == k).mean()), 3),
                            "mean": round(float(by.mean()[k]), 2), "median": round(float(by.median()[k]), 2),
                            "p25": round(float(by.quantile(.25)[k]), 2), "p75": round(float(by.quantile(.75)[k]), 2)} for k in CLASSES],
              "matrix_addresses": matrix,                      # rows L1..L3, cols R1..R3
              "score_addresses": {str(k): int((sc.score == k).sum()) for k in range(-2, 3)},
              "cells": int(len(cells)),
              "score_cells": {str(k): int((cells.s == k).sum()) for k in range(-2, 3)}}
    d = summarise(a, "bez")
    bb = a.groupby("bez").agg(x0=("lon", "min"), y0=("lat", "min"), x1=("lon", "max"), y1=("lat", "max")).round(4)
    d = d.merge(bb, left_on="bez", right_index=True)
    d["bbox"] = d[["x0", "y0", "x1", "y1"]].apply(lambda r: [[r.x0, r.y0], [r.x1, r.y1]], axis=1)
    d = d.drop(columns=["x0", "y0", "x1", "y1"]).rename(columns={"bez": "name"})
    d["mean_rent"] = d.mean_rent.round(2)
    p = plr[plr.with_rent >= 50].copy()
    pb = a.groupby("plr").agg(x0=("lon", "min"), y0=("lat", "min"), x1=("lon", "max"), y1=("lat", "max")).round(4)
    p = p.merge(pb, left_on="planungsraum", right_index=True)
    p["bbox"] = p[["x0", "y0", "x1", "y1"]].apply(lambda r: [[r.x0, r.y0], [r.x1, r.y1]], axis=1)
    p = p.drop(columns=["x0", "y0", "x1", "y1"])
    stats = {"berlin": berlin,
             "districts": d.sort_values("mean_score").to_dict("records"),
             "plr_cheaper": p.sort_values("mean_score").head(8).to_dict("records"),
             "plr_pricier": p.sort_values("mean_score", ascending=False).head(8).to_dict("records")}
    json.dump(stats, open(out / "stats.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(berlin, indent=1))
    for f in sorted(out.iterdir()):
        print(f"{f.name}: {f.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
