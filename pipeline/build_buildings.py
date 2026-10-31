"""
Day 1 · step 2 — transfer the address labels to 3D buildings.

Every building footprint receives the labels of the Mietspiegel addresses inside it
(majority label), the Zensus 2022 rent of the 100 m cell its centre lies in, a mismatch
flag and a height. Output: docs/data/buildings.pmtiles (vector tiles, layer "b").

Input: any polygon layer of Berlin buildings readable by GDAL (GeoPackage, Shapefile, GeoJSON),
e.g. ALKIS Berlin Gebäude exported from the WFS in QGIS.
Height: taken from a storeys field (auto-detected, or --floors-field) × --floor-height,
or from a height field in metres (--height-field); otherwise --default-floors.

Run (after build_data.py):
  python pipeline/build_buildings.py --input <folder> --buildings <buildings.gpkg>
Needs tippecanoe on PATH (brew install tippecanoe / apt install tippecanoe).
"""
import argparse, json, re, subprocess, sys, tempfile, zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import pyogrio
from pyproj import Transformer
from shapely import from_wkb, points, STRtree, centroid
from shapely.geometry import mapping

sys.path.insert(0, str(Path(__file__).parent))
from build_data import load_addresses, load_rent, band, gitter_id, SCORE_NAMES  # noqa: E402

CODE = {"einfach": 0, "mittel": 1, "gut": 2}


def pick_field(cols, pattern):
    for c in cols:
        if re.search(pattern, c, flags=re.I):
            return c
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="input", help="folder with the Wohnlagen JSON pages and the Zensus CSV")
    ap.add_argument("--buildings", required=True, help="building footprints (polygons)")
    ap.add_argument("--layer", default=None)
    ap.add_argument("--floors-field", default=None)
    ap.add_argument("--height-field", default=None)
    ap.add_argument("--floor-height", type=float, default=3.2)
    ap.add_argument("--default-floors", type=float, default=3)
    ap.add_argument("--out", default="docs/data")
    args = ap.parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------ buildings
    if str(args.buildings).lower().endswith(".parquet"):
        import geopandas as gpd
        meta = gpd.read_parquet(args.buildings)
        cols = [c for c in meta.columns if c != "geometry"]
    else:
        info = pyogrio.read_info(args.buildings, layer=args.layer)
        cols = list(info["fields"])
        meta = None
    ff = args.floors_field or (None if args.height_field else pick_field(cols, r"geschoss|^aog$|storey|level|anzahl.*ober"))
    hf = args.height_field
    idcol = next((c for c in ("gml_id", "id", "gid", "oid") if c in cols), None)
    keep = [c for c in (ff, hf, idcol) if c]
    if meta is None:
        meta = pyogrio.read_dataframe(args.buildings, layer=args.layer, columns=keep, read_geometry=True)
    else:
        meta = meta[keep + ["geometry"]]
    print(f"Buildings: {len(meta):,} features, fields: {cols}")
    meta = meta.to_crs(25833)
    meta = meta[meta.geometry.notna() & meta.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].reset_index(drop=True)
    if hf:
        h = pd.to_numeric(meta[hf], errors="coerce")
        print(f"Height from '{hf}' (m)")
    elif ff:
        h = pd.to_numeric(meta[ff], errors="coerce") * args.floor_height
        print(f"Height from storeys field '{ff}' × {args.floor_height} m")
    else:
        h = pd.Series(np.nan, index=meta.index)
        print("No height field found; using default storeys")
    meta["h"] = h.where(h > 0, args.default_floors * args.floor_height).clip(3, 250).round(1)

    # ------------------------------------------------ addresses → buildings
    a, _ = load_addresses(args.input)
    a = a.reset_index(drop=True)
    tree = STRtree(meta.geometry.values)
    pts = points(a.x.values, a.y.values)
    ai, bi = tree.query(pts, predicate="within")
    print(f"Addresses inside a building: {len(np.unique(ai)):,} of {len(a):,}")
    rest = np.setdiff1d(np.arange(len(a)), ai)          # address point just outside the footprint
    ri, rb = tree.query_nearest(pts[rest], max_distance=10, all_matches=False)
    ai, bi = np.concatenate([ai, rest[ri]]), np.concatenate([bi, rb])
    print(f"  + {len(ri):,} matched to the nearest building within 10 m")
    j = pd.DataFrame({"b": bi, "c": a.wol.map(CODE).values[ai]})
    ct = pd.crosstab(j.b, j.c).reindex(columns=[0, 1, 2], fill_value=0)
    meta["n"] = 0
    meta.loc[ct.index, "n"] = ct.sum(axis=1).values
    meta["l"] = -1
    meta.loc[ct.index, "l"] = ct.values.argmax(axis=1)

    # ------------------------------------------------ rent of the 100 m cell at the building centre
    c = centroid(meta.geometry.values)
    t = Transformer.from_crs(25833, 3035, always_xy=True)
    ex, ny = t.transform(np.array([p.x for p in c]), np.array([p.y for p in c]))
    meta["cx"] = (np.floor(ex / 100) * 100 + 50).astype(int)
    meta["cy"] = (np.floor(ny / 100) * 100 + 50).astype(int)
    meta = meta.merge(load_rent(args.input), on=["cx", "cy"], how="left")
    meta["gitter_id"] = gitter_id(meta["cx"].values, meta["cy"].values)
    stats = json.load(open(out / "stats.json", encoding="utf-8"))
    q1, q2 = stats["berlin"]["terciles"]
    meta["R"] = band(meta["rent"], q1, q2)
    meta["s"] = np.where(meta.l >= 0, meta["R"] - (meta.l + 1), np.nan)    # score = rent third − label level
    for k, col in enumerate(["n_einfach", "n_mittel", "n_gut"]):
        meta[col] = 0
        meta.loc[ct.index, col] = ct[k].values

    # ------------------------------------------------ write vector tiles
    meta = meta.set_crs(25833, allow_override=True).to_crs(4326)
    with tempfile.TemporaryDirectory() as td:
        seq = Path(td) / "b.geojsonl"
        with open(seq, "w") as f:
            for r in meta.itertuples():
                p = {"h": float(r.h), "l": int(r.l), "n": int(r.n)}
                if not pd.isna(r.rent):
                    p["r"] = round(float(r.rent), 2); p["R"] = int(r.R)
                if not pd.isna(r.s):
                    p["s"] = int(r.s)
                f.write(json.dumps({"type": "Feature", "properties": p, "geometry": mapping(r.geometry)}, separators=(",", ":")) + "\n")
        target = out / "buildings.pmtiles"
        cmd = ["tippecanoe", "-o", str(target), "--force", "-l", "b", "-Z", "12", "-z", "16",
               "--drop-smallest-as-needed", "--coalesce-densest-as-needed", "--extend-zooms-if-still-dropping",
               "--simplification=2", "-P", str(seq)]
        print(" ".join(cmd)); subprocess.run(cmd, check=True)

    # scoring table, one row per building
    lab = {-1: "", 0: "einfach", 1: "mittel", 2: "gut"}
    cen = meta.geometry.representative_point()
    t = pd.DataFrame({
        "building_id": meta[idcol] if idcol else meta.index, "height_m": meta.h, "lon": cen.x.round(6), "lat": cen.y.round(6),
        "addresses": meta.n, "n_einfach": meta.n_einfach, "n_mittel": meta.n_mittel, "n_gut": meta.n_gut,
        "label": meta.l.map(lab), "label_level": (meta.l + 1).where(meta.l >= 0).astype("Int64"),
        "gitter_id": meta.gitter_id, "rent_eur_m2": meta.rent.round(2), "value_in_brackets": meta.unsure,
        "rent_third": pd.Series(meta.R).astype("Int64"), "score": pd.Series(meta.s).astype("Int64"),
        "score_text": pd.Series(meta.s).map(SCORE_NAMES)})
    with zipfile.ZipFile(out / "scores_buildings.csv.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("scores_buildings.csv", t.to_csv(index=False))

    s = meta.groupby("l").size().to_dict()
    sc = meta.dropna(subset=["s"])
    stats["buildings"] = {"total": int(len(meta)), "labelled": int((meta.l >= 0).sum()),
                          "by_label": {k: int(s.get(v, 0)) for k, v in CODE.items()},
                          "with_rent": int(meta.rent.notna().sum()),
                          "score": {str(k): int((sc.s == k).sum()) for k in range(-2, 3)},
                          "matrix": [[int(((sc.l == L - 1) & (sc.R == R)).sum()) for R in (1, 2, 3)] for L in (1, 2, 3)],
                          "height_source": hf or ff or f"default {args.default_floors} storeys"}
    json.dump(stats, open(out / "stats.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(stats["buildings"], indent=1))
    print(f"buildings.pmtiles: {target.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
