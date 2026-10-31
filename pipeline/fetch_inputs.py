"""
Download every input from the official sources into ./input (used by the GitHub Action).

  python pipeline/fetch_inputs.py all          # Wohnlagen + Zensus + LoD2
  python pipeline/fetch_inputs.py wohnlagen    # only one part (wohnlagen | zensus | lod2)

Sources
  Wohnlagen 2026  WFS https://gdi.berlin.de/services/wfs/wohnlagenadr2026        dl-de/zero-2-0
  Zensus 2022     https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Durchschn_Nettokaltmiete.zip
  LoD2 Berlin     ATOM https://gdi.berlin.de/data/a_lod2/atom/                    dl-de/zero-2-0
"""
import io, json, sys, time, zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin
from xml.etree import ElementTree as ET

import requests

IN = Path("input")
WFS = "https://gdi.berlin.de/services/wfs/wohnlagenadr2026"
ZENSUS = "https://www.destatis.de/static/DE/zensus/gitterdaten/Zensus2022_Durchschn_Nettokaltmiete.zip"
LOD2_ATOM = "https://gdi.berlin.de/data/a_lod2/atom/"
S = requests.Session()
S.headers["User-Agent"] = "30DayMapChallenge-research (github.com/barisparlatangiller)"


def get(url, **kw):
    for i in range(5):
        try:
            r = S.get(url, timeout=600, **kw)
            r.raise_for_status()
            return r
        except Exception as e:
            print(f"  retry {i+1}: {e}", flush=True)
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"failed: {url}")


def wohnlagen():
    IN.mkdir(exist_ok=True)
    page, start, k, seen = 20000, 0, 0, set()
    while True:
        k += 1
        params = {"SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": "wohnlagenadr2026",
                  "OUTPUTFORMAT": "application/json", "COUNT": page, "STARTINDEX": start, "SORTBY": "schluessel"}
        try:
            j = get(WFS, params=params).json()
        except Exception:                      # server without SORTBY support
            params.pop("SORTBY"); j = get(WFS, params=params).json()
        feats = j.get("features", [])
        keys = {f["properties"]["schluessel"] for f in feats}
        new = len(keys - seen); seen |= keys
        json.dump(j, open(IN / f"wohnlagenadr2026_1_{k}.json", "w", encoding="utf-8"))
        print(f"page {k}: {len(feats):,} features, {new:,} new, total unique {len(seen):,} / {j.get('numberMatched')}", flush=True)
        if len(feats) < page:
            break
        start += page
    print(f"Wohnlagen: {len(seen):,} unique addresses")


def zensus():
    IN.mkdir(exist_ok=True)
    z = zipfile.ZipFile(io.BytesIO(get(ZENSUS).content))
    for n in z.namelist():
        if "100m" in n and n.lower().endswith(".csv"):
            (IN / Path(n).name).write_bytes(z.read(n))
            print("Zensus:", Path(n).name)


A = "{http://www.w3.org/2005/Atom}"
DATA_EXT = (".zip", ".gml", ".gz", ".json", ".xml.zip")


def crawl(url, seen, files, depth=0):
    if url in seen or depth > 4:
        return
    seen.add(url)
    r = get(url)
    try:
        root = ET.fromstring(r.content)
    except ET.ParseError:                       # plain HTML directory listing
        import re
        for href in re.findall(r'href="([^"]+)"', r.text):
            u = urljoin(url, href)
            if u.lower().endswith(DATA_EXT):
                files.add(u)
            elif u.endswith("/") and u.startswith(url) and u != url:
                crawl(u, seen, files, depth + 1)
        return
    for link in root.iter(f"{A}link"):
        href, typ, rel = link.get("href"), (link.get("type") or "").lower(), (link.get("rel") or "alternate")
        if not href or rel in ("self", "describedby", "search", "up"):
            continue
        u = urljoin(url, href)
        if "atom" in typ or u.lower().endswith((".atom", "atom.xml", "/atom/")):
            crawl(u, seen, files, depth + 1)
        elif u.lower().endswith(DATA_EXT) or "zip" in typ or "gml" in typ or "citygml" in typ or "json" in typ:
            files.add(u)


def lod2():
    out = IN / "lod2"; out.mkdir(parents=True, exist_ok=True)
    files = set(); crawl(LOD2_ATOM, set(), files)
    files = sorted(files)
    print(f"LoD2: {len(files)} files listed in the ATOM feed", flush=True)
    if not files:
        raise SystemExit("No LoD2 files found in the ATOM feed")

    def dl(u):
        name = Path(u.split("?")[0]).name or "tile.zip"
        p = out / name
        if p.exists() and p.stat().st_size > 0:
            return 0
        with S.get(u, stream=True, timeout=900) as r:
            r.raise_for_status()
            with open(p, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        return p.stat().st_size

    with ThreadPoolExecutor(6) as ex:
        total = 0
        for i, n in enumerate(ex.map(dl, files), 1):
            total += n
            if i % 25 == 0 or i == len(files):
                print(f"  {i}/{len(files)} downloaded, {total/1e9:.2f} GB", flush=True)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    for name, fn in (("wohnlagen", wohnlagen), ("zensus", zensus), ("lod2", lod2)):
        if what in (name, "all"):
            fn()
