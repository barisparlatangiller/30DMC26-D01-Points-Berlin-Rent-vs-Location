"""Write docs/data/diagnostics.json: what the build produced and whether Berlin's aerial-photo WMS
can be used from the browser (layer name + CORS). The web map reads this file."""
import json, re, sys
from datetime import datetime, timezone
from pathlib import Path

import requests

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/data")
WMS = "https://gdi.berlin.de/services/wms/truedop_2025_sommer"
ORIGIN = "https://barisparlatangiller.github.io"

d = {"built_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
for f in sorted(OUT.iterdir()):
    d.setdefault("files", {})[f.name] = round(f.stat().st_size / 1e6, 2)
st = json.load(open(OUT / "stats.json", encoding="utf-8"))
d["addresses"] = st["berlin"]["n"]; d["addresses_wfs"] = st["berlin"]["n_wfs"]
d["buildings"] = st.get("buildings")
d["berlin"] = {k: st["berlin"][k] for k in ("with_rent", "terciles", "by_label", "score_addresses", "score_cells", "cells")}

w = {}
try:
    cap = requests.get(WMS, params={"SERVICE": "WMS", "REQUEST": "GetCapabilities"}, timeout=60, headers={"Origin": ORIGIN})
    w["capabilities_status"] = cap.status_code
    names = re.findall(r"<Layer[^>]*>\s*<Name>([^<]+)</Name>", cap.text)
    w["layers"] = names[:20]
    w["layer"] = next((n for n in names if re.search("dop", n, re.I) and not re.search("cir|ir$", n, re.I)), names[-1] if names else None)
    if w["layer"]:
        r = requests.get(WMS, timeout=60, headers={"Origin": ORIGIN}, params={
            "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": w["layer"], "STYLES": "",
            "FORMAT": "image/jpeg", "CRS": "EPSG:3857", "WIDTH": 256, "HEIGHT": 256,
            "BBOX": "1491000,6891000,1492000,6892000"})
        w["getmap_status"] = r.status_code
        w["getmap_type"] = r.headers.get("Content-Type")
        acao = r.headers.get("Access-Control-Allow-Origin")
        w["acao"] = acao
        w["cors"] = bool(acao) and r.ok and "image" in (r.headers.get("Content-Type") or "")
except Exception as e:
    w["error"] = str(e)[:300]
d["wms"] = w
json.dump(d, open(OUT / "diagnostics.json", "w"), indent=1)
print(json.dumps(d, indent=1))
