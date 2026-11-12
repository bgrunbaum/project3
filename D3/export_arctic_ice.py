"""
Export September Arctic sea-ice concentration as a polar picture for the D3 map.

Data: MIROC6 historical r5i1p1f1, variable `siconc` (SImon, sea-ice concentration, %).
Same model and run as the SST map.

The ocean grid is curved near the pole, so we interpolate onto a regular picture instead of
a lat/lon grid: N×N pixels, the North Pole at the centre, latitude LAT_MIN at the edge of the
disc, longitude 0° pointing down and 90°E to the right (this matches sst_anomaly.js).

Output (D3/data/):
  arctic_ice.bin        uint8, shape (n_years, N, N). Each value is:
                          0–100    % of the pixel covered by ice (open ocean)
                          128–228  same, plus 128 = this pixel is land (value taken from the nearest ocean)
                          255      outside the disc
  arctic_ice_meta.json  years, n, lat_min, fill, September ice area (million km², estimated)

Run from the project root:  python3 D3/export_arctic_ice.py
"""
import json
from pathlib import Path

import gcsfs
import numpy as np
import pandas as pd
import xarray as xr
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import cKDTree

OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)

LAT_MIN = 50
N = 300
SPAN = 90 - LAT_MIN                     # degrees from the pole to the edge of the disc

df = pd.read_csv("https://storage.googleapis.com/cmip6/cmip6-zarr-consolidated-stores.csv")
rows = df.query("source_id == 'MIROC6' & member_id == 'r5i1p1f1' & table_id == 'SImon' "
                "& variable_id == 'siconc' & experiment_id == 'historical'")
if rows.empty:
    raise SystemExit("No MIROC6 r5i1p1f1 siconc store found in the catalog. Check the query.")
if (rows.grid_label == "gn").any():
    rows = rows[rows.grid_label == "gn"]

ds = xr.open_zarr(gcsfs.GCSFileSystem(token="anon").get_mapper(rows.zstore.values[0]), consolidated=True)
sic = ds.siconc

lat_name = "latitude" if "latitude" in sic.coords else "lat"
lon_name = "longitude" if "longitude" in sic.coords else "lon"
lat2d, lon2d = sic[lat_name].values, sic[lon_name].values % 360
if lat2d.ndim == 1:
    lon2d, lat2d = np.meshgrid(lon2d, lat2d)

# keep only the northern rows (less to download)
ydim = sic.dims[-2]
y0 = int(np.where((lat2d >= LAT_MIN - 10).any(axis=1))[0].min())
sic = sic.isel({ydim: slice(y0, None)})
lat2d, lon2d = lat2d[y0:], lon2d[y0:]

print("loading September siconc ...")
sept = sic.sel(time=sic.time.dt.month == 9).groupby("time.year").mean("time").load()
years = sept.year.values.astype(int)
T = len(years)
flat = sept.values.astype(np.float32).reshape(T, -1)
if np.nanmax(flat) <= 1.5:                       # some stores use fractions instead of %
    flat *= 100

# model cells, placed on the flat polar picture (units: degrees from the pole)
colat = (90 - lat2d).ravel()
lon_r = np.deg2rad(lon2d).ravel()
pts = np.column_stack([colat * np.sin(lon_r), colat * np.cos(lon_r)])
is_ocean = np.isfinite(flat[0]) & np.isfinite(pts).all(axis=1)
near = colat <= SPAN + 8                          # only cells near the picture
src_ocean = is_ocean & near

pts_o = pts[src_ocean]
vals_o = flat[:, src_ocean].T                     # (n_cells, T)

# pixel centres of the output picture (x to the right, y DOWN, like the screen)
u = (np.arange(N) + 0.5) / N * 2 - 1
U, V = np.meshgrid(u, u)
inside = np.hypot(U, V) <= 1
targets = np.column_stack([U[inside] * SPAN, V[inside] * SPAN])

print("interpolating ...")
conc = LinearNDInterpolator(pts_o, vals_o)(targets)          # smooth in between the model cells
_, nearest_ocean = cKDTree(pts_o).query(targets)
missing = np.isnan(conc).any(axis=1)
conc[missing] = vals_o[nearest_ocean][missing]               # outside the interpolation area: nearest ocean cell

# land = the nearest model cell is land
_, nearest_any = cKDTree(pts[near]).query(targets)
land = ~is_ocean[near][nearest_any]
conc[land] = vals_o[nearest_ocean[land]]                      # land pixels borrow the nearest ocean value

conc = np.clip(np.round(conc), 0, 100)

# estimated ice area: concentration × pixel area (azimuthal-equidistant correction), ocean pixels only
c = np.deg2rad(np.hypot(targets[:, 0], targets[:, 1]))
factor = np.where(c > 1e-6, np.sin(c) / np.maximum(c, 1e-6), 1.0)
pixel_km2 = 6371.0**2 * factor * np.deg2rad(2 * SPAN / N) ** 2
area = ((conc / 100) * (~land)[:, None] * pixel_km2[:, None]).sum(axis=0) / 1e6

enc = conc.astype(np.uint8) + np.where(land, 128, 0).astype(np.uint8)[:, None]
out = np.full((T, N * N), 255, dtype=np.uint8)
out[:, inside.ravel()] = enc.T
out.tofile(OUT / "arctic_ice.bin")

meta = {
    "source": "MIROC6 historical r5i1p1f1, siconc (September mean), interpolated onto a polar picture",
    "years": years.tolist(),
    "n": N,
    "lat_min": LAT_MIN,
    "fill": 255,
    "area": np.round(area, 3).tolist(),
}
(OUT / "arctic_ice_meta.json").write_text(json.dumps(meta))
print("wrote", (T, N, N), round((OUT / "arctic_ice.bin").stat().st_size / 1e6, 1), "MB")
