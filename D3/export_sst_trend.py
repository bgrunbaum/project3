"""
Export annual sea-surface temperature for the D3 trend map (Plot 2).

The page fits trends in the browser, so we only ship the annual-mean SST of
every ocean cell. That lets the reader pick any window (e.g. a sliding 30-year
window, or everything since 1850) without pre-computing one map per window.

Data: MIROC6 historical r5i1p1f1 (same run as the notebook), variable `tos`
(sea-surface temperature). We use `tos` instead of `thetao.isel(lev=0)` because
thetao is chunked with all 63 depth levels together, so reading just the surface
would still download ~46 GB; `tos` is ~730 MB.

Output (in D3/data/):
  sst_annual.bin  int16, shape (n_years, ny, nx), SST in °C * scale, fill = land
  sst_meta.json   grid coordinates, years, cos-latitude-weighted global-mean SST

Run from the project root:  python3 D3/export_sst_trend.py
"""
import json
from pathlib import Path

import gcsfs
import numpy as np
import xarray as xr

OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)
SCALE = 500            # int16 step = 0.002 °C, range ±65 °C
FILL = -32768

STORE = "gs://cmip6/CMIP6/CMIP/MIROC/MIROC6/historical/r5i1p1f1/Omon/tos/gn/v20181212/"
ds = xr.open_zarr(gcsfs.GCSFileSystem(token="anon").get_mapper(STORE), consolidated=True)

# Annual means (165, y, x). Downloads ~730 MB.
print("loading tos ...")
sst = ds.tos.groupby("time.year").mean("time").load()

# Same map fixes as the notebook: longitude = x + 60, and y is latitude only south of ~63°N.
sst = sst.assign_coords(x=(sst.x + 60) % 360).sortby("x")
sst = sst.sel(y=slice(-80, 63))
# 2x2 coarsening keeps the file small (~6 MB) while still looking like a map.
sst = sst.coarsen(x=2, y=2, boundary="trim").mean()

years = sst.year.values.astype(int)              # 1850..2014
v = sst.values.astype(np.float64)                # (T, ny, nx)

# A cell is ocean only if it has data in every year (keeps the mask constant,
# so the global mean of per-cell trends equals the trend of the global mean).
ocean = np.isfinite(v).all(axis=0)
v = np.where(ocean[None], v, np.nan)

# Global-mean SST per year, weighted by cos(latitude) (cell area).
w = np.cos(np.deg2rad(sst.y.values))[:, None] * ocean
gmean = np.nansum(v * w[None], axis=(1, 2)) / w.sum()

q = np.clip(np.round(v * SCALE), -32767, 32767)
q = np.where(np.isnan(v), FILL, q).astype("<i2")
q.tofile(OUT / "sst_annual.bin")

meta = {
    "source": "MIROC6 historical r5i1p1f1, tos (annual mean), 2x2 coarsened",
    "years": years.tolist(),
    "x": np.round(sst.x.values, 3).tolist(),
    "y": np.round(sst.y.values, 3).tolist(),
    "scale": SCALE,
    "fill": FILL,
    "global_mean_sst": np.round(gmean, 4).tolist(),
}
(OUT / "sst_meta.json").write_text(json.dumps(meta))
print("wrote", q.shape, (OUT / "sst_annual.bin").stat().st_size / 1e6, "MB")
