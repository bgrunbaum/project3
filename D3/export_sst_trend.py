"""
Export SST-trend maps for the D3 slider (Plot 2).

For every end year Y (1851..2014) and every ocean grid cell, fit a straight line
to annual-mean SST over 1850..Y and save the slope (°C per decade).

Data: MIROC6 historical r5i1p1f1 (same run as the notebook), variable `tos`
(sea-surface temperature). We use `tos` instead of `thetao.isel(lev=0)` because
thetao is chunked with all 63 depth levels together, so reading just the surface
would still download ~46 GB; `tos` is ~730 MB.

Output (in D3/data/):
  sst_trend.bin   int16, shape (n_years, ny, nx), slope in milli-°C/decade, -32768 = land
  sst_meta.json   grid coordinates, years, global-mean series

Run from the project root:  python3 D3/export_sst_trend.py
"""
import json
from pathlib import Path

import gcsfs
import numpy as np
import xarray as xr

OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)

STORE = "gs://cmip6/CMIP6/CMIP/MIROC/MIROC6/historical/r5i1p1f1/Omon/tos/gn/v20181212/"
ds = xr.open_zarr(gcsfs.GCSFileSystem(token="anon").get_mapper(STORE), consolidated=True)

# Annual means (165, y, x). Downloads ~730 MB.
print("loading tos ...")
sst = ds.tos.groupby("time.year").mean("time").load()

# Same map fixes as the notebook: longitude = x + 60, and y is latitude only south of ~63°N.
sst = sst.assign_coords(x=(sst.x + 60) % 360).sortby("x")
sst = sst.sel(y=slice(-80, 63))
# No coarsening: we keep the native ~1° grid. (2x2 coarsening would shrink the file
# to ~6 MB; uncomment below and update "source" in meta if you want that.)
#sst = sst.coarsen(x=2, y=2, boundary="trim").mean()

years = sst.year.values.astype(float)            # 1850..2014
v = sst.values.astype(np.float64)                # (T, ny, nx)
T = len(years)

# Running least-squares slope for every end index k using cumulative sums:
# slope_k = (n*Sty - St*Sy) / (n*Stt - St^2), sums over years[0..k]
t = (years - years[0])[:, None, None]
n = np.arange(1, T + 1)[:, None, None].astype(float)
St = np.cumsum(t, axis=0)
Stt = np.cumsum(t**2, axis=0)
Sy = np.cumsum(v, axis=0)
Sty = np.cumsum(t * v, axis=0)
with np.errstate(invalid="ignore", divide="ignore"):
    slope = (n * Sty - St * Sy) / (n * Stt - St**2)   # °C / year
slope = slope[1:] * 10                                 # drop Y=1850 (one point); °C / decade
end_years = years[1:].astype(int)

# Global mean (cos-latitude weighted) of the slope for each end year.
w = np.cos(np.deg2rad(sst.y.values))[None, :, None] * np.ones_like(slope)
w = np.where(np.isnan(slope), 0, w)
gmean = np.nansum(slope * w, axis=(1, 2)) / w.sum(axis=(1, 2))

q = np.clip(np.round(slope * 1000), -32767, 32767)
q = np.where(np.isnan(slope), -32768, q).astype("<i2")
q.tofile(OUT / "sst_trend.bin")

meta = {
    "source": "MIROC6 historical r5i1p1f1, tos (annual mean), native ~1° grid",
    "start_year": int(years[0]),
    "years": end_years.tolist(),
    "x": np.round(sst.x.values, 3).tolist(),
    "y": np.round(sst.y.values, 3).tolist(),
    "scale": 1000,
    "fill": -32768,
    "global_mean_trend": np.round(gmean, 4).tolist(),
}
(OUT / "sst_meta.json").write_text(json.dumps(meta))
print("wrote", q.shape, (OUT / "sst_trend.bin").stat().st_size / 1e6, "MB")
