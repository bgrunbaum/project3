"""
Export annual SST anomaly maps (vs 1850-1900) on a regular 1° lat/lon grid.

Data: MIROC6 historical r5i1p1f1, `tos`

Output (D3/data/):
  sst_anom.bin        int16, shape (n_years, 180, 360), anomaly in 0.01 °C, -32768 = land
                      row 0 = 89.5°S, column 0 = 0.5°E
  sst_anom_meta.json  years, lon, lat, scale, fill, global-mean series

Needs: gcsfs, xarray, zarr, numpy, scipy.   Run from the project root:
  python3 D3/export_sst_anomaly.py
"""
import json
from pathlib import Path

import gcsfs
import numpy as np
import xarray as xr
from scipy.spatial import cKDTree

OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)

STORE = "gs://cmip6/CMIP6/CMIP/MIROC/MIROC6/historical/r5i1p1f1/Omon/tos/gn/v20181212/"
BASE = (1850, 1900)
MAX_CHORD = 2 * np.sin(np.deg2rad(1.5) / 2)   # targets farther than ~1.5° from any ocean cell = land

ds = xr.open_zarr(gcsfs.GCSFileSystem(token="anon").get_mapper(STORE), consolidated=True)
print("loading tos ...")                              # ~730 MB download
sst = ds.tos.groupby("time.year").mean("time").load()
years = sst.year.values.astype(int)
lat2d, lon2d = ds.latitude.values, ds.longitude.values % 360

def xyz(lat, lon):
    la, lo = np.deg2rad(lat), np.deg2rad(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)

# source: ocean cells only
ocean = np.isfinite(sst.values[0]) & np.isfinite(lat2d)
tree = cKDTree(xyz(lat2d[ocean], lon2d[ocean]))

# target: regular 1° grid, south -> north
lon_t = np.arange(0.5, 360, 1.0)
lat_t = np.arange(-89.5, 90, 1.0)
LON, LAT = np.meshgrid(lon_t, lat_t)
dist, idx = tree.query(xyz(LAT, LON).reshape(-1, 3), distance_upper_bound=MAX_CHORD)
ok = idx < tree.n

vals = sst.values[:, ocean]                                    # (T, n_ocean)
grid = np.full((len(years), LAT.size), np.nan, dtype=np.float32)
grid[:, ok] = vals[:, idx[ok]]
grid = grid.reshape(len(years), len(lat_t), len(lon_t))

# anomaly vs baseline
b = (years >= BASE[0]) & (years <= BASE[1])
anom = grid - grid[b].mean(axis=0)

# cos(lat)-weighted global mean over ocean cells
w = np.cos(np.deg2rad(lat_t))[None, :, None] * np.isfinite(anom)
gmean = np.nansum(anom * w, axis=(1, 2)) / w.sum(axis=(1, 2))

q = np.clip(np.round(anom * 100), -32767, 32767)
q = np.where(np.isnan(anom), -32768, q).astype("<i2")
q.tofile(OUT / "sst_anom.bin")

meta = {
    "source": "MIROC6 historical r5i1p1f1, tos annual mean, regridded to 1° (nearest neighbour)",
    "baseline": list(BASE),
    "years": years.tolist(),
    "lon": lon_t.tolist(),
    "lat": lat_t.tolist(),
    "scale": 100,
    "fill": -32768,
    "global_mean": np.round(gmean, 3).tolist(),
}
(OUT / "sst_anom_meta.json").write_text(json.dumps(meta))
print("wrote", q.shape, round((OUT / "sst_anom.bin").stat().st_size / 1e6, 1), "MB")
