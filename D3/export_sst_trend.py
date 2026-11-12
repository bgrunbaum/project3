"""
Export annual sea-surface temperature maps for the D3 slider (Plot 2).

For every year 1850..2014 and every ocean grid cell, save the annual-mean SST.

Data: MIROC6 historical r5i1p1f1, variable `tos`. (`tos` instead of
`thetao.isel(lev=0)`, which would download ~46 GB.)

Output (in D3/data/):
  sst.bin        int16, shape (n_years, ny, nx), SST in centi-°C, -32768 = land
  sst_meta.json  grid coordinates, years, mapped-ocean mean series

Run from the project root:  python3 D3/export_sst_trend.py
"""
import json
from pathlib import Path

import dask
import gcsfs
import numpy as np
import xarray as xr
from dask.diagnostics import ProgressBar

# 1 = native grid (~1 deg, smoother, ~25 MB). 2 = 2 deg grid (~6 MB, blurrier).
COARSEN = 1

try:
    HERE = Path(__file__).parent          # running as a script
except NameError:
    HERE = Path(".")                       # running in a notebook (e.g. Colab)
OUT = HERE / "data"
OUT.mkdir(exist_ok=True)

STORE = "gs://cmip6/CMIP6/CMIP/MIROC/MIROC6/historical/r5i1p1f1/Omon/tos/gn/v20181212/"
ds = xr.open_zarr(gcsfs.GCSFileSystem(token="anon").get_mapper(STORE), consolidated=True)

print("loading tos ...")
# The download is network-latency bound, so read many chunks in parallel.
with dask.config.set(scheduler="threads", num_workers=32), ProgressBar():
    sst = ds.tos.groupby("time.year").mean("time").load()      # (165, y, x)

# Same map fixes as before: longitude = x + 60, y is latitude only south of ~63N.
sst = sst.assign_coords(x=(sst.x + 60) % 360).sortby("x")
sst = sst.sel(y=slice(-80, 63))
if COARSEN > 1:
    sst = sst.coarsen(x=COARSEN, y=COARSEN, boundary="trim").mean()

years = sst.year.values.astype(int)                             # 1850..2014
v = sst.values.astype(np.float64)                               # (T, ny, nx), deg C
if np.nanmax(v) > 100:                                          # Kelvin guard
    v -= 273.15
print("SST range:", np.nanmin(v), np.nanmax(v))

# Cos-latitude weighted mean over the mapped ocean (80S-63N only, not truly global).
w = np.cos(np.deg2rad(sst.y.values))[None, :, None] * np.ones_like(v)
w = np.where(np.isnan(v), 0, w)
gmean = np.nansum(v * w, axis=(1, 2)) / w.sum(axis=(1, 2))

q = np.where(np.isnan(v), -32768, np.clip(np.round(v * 100), -32767, 32767)).astype("<i2")
q.tofile(OUT / "sst.bin")

meta = {
    "source": f"MIROC6 historical r5i1p1f1, tos (annual mean), coarsen={COARSEN}",
    "start_year": int(years[0]),
    "years": years.tolist(),
    "x": np.round(sst.x.values, 3).tolist(),
    "y": np.round(sst.y.values, 3).tolist(),
    "scale": 100,
    "fill": -32768,
    "global_mean": np.round(gmean, 4).tolist(),
}
(OUT / "sst_meta.json").write_text(json.dumps(meta))
print("wrote", q.shape, (OUT / "sst.bin").stat().st_size / 1e6, "MB")