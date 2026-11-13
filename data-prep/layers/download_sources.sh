#!/bin/zsh
# Re-download the raw inputs for the MOONDA science layers into data-raw/.
# Each source gets its own directory; nothing in data-raw is ever executed.
# Total ~400 MB. Safe to re-run (curl overwrites).
set -euo pipefail

RAW=/Volumes/CodexWork/Projects/MOONDA/data-raw

# 1) LOLA polar illumination (Mazarico et al. 2011; 2016 release), PDS Geosciences mirror
#    of the LOLA EXTRAS (also at https://imbrium.mit.edu/EXTRAS/ILLUMINATION/ and as
#    GeoTIFF/COG on https://pgda.gsfc.nasa.gov/products/69).
D=$RAW/pds-lola-illumination; mkdir -p $D
B=https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/extras/illumination
curl -fL --max-time 120 -o $D/readme_illumination_2016.txt $B/readme_illumination_2016.txt
for f in avgvisib_65s_240m_201608 avgvisib_65s_240m_201608_earth lpsr_65s_240m_201608; do
  curl -fL --max-time 120 -o $D/$f.lbl $B/img/$f.lbl
  curl -fL --max-time 1800 -o $D/$f.img $B/img/$f.img
done

# 2) Diviner Polar Resource Product, south (Paige et al. 2010), PDS Geosciences.
#    The zip in extras/prp is the same table as data_derived_prp/dlre_prp_south.tab (605 MB).
D=$RAW/pds-diviner-prp; mkdir -p $D
B=https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1
curl -fL --max-time 1800 -o $D/dlre_prp_south.zip $B/extras/prp/dlre_prp_south.zip
for f in data_derived_prp/dlre_prp_south.lbl data_derived_prp/dlre_prp_south.xml \
         label/dlre_prp.fmt catalog/prpds.cat catalog/dsmap_polar.cat readme.txt; do
  curl -fL --max-time 120 -o $D/${f:t} $B/$f
done

# 3) LOLA LDEM_80S_80M labels (the DEM itself is the local read-only copy
#    /Volumes/CodexWork/Projects/MOONDA/data-raw/source/terrain-raw/LDEM_80S_80M.JP2,
#    byte-identical in size to the PDS file below).
D=$RAW/pds-lola-ldem; mkdir -p $D
B=https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar
curl -fL --max-time 120 -o $D/ldem_80s_80m_jp2.lbl $B/jp2/ldem_80s_80m_jp2.lbl
curl -fL --max-time 120 -o $D/ldem_80s_80m.lbl $B/img/ldem_80s_80m.lbl
# To fetch the DEM itself (30 MB) instead of using the local copy:
#   curl -fL -o $D/ldem_80s_80m.jp2 $B/jp2/ldem_80s_80m.jp2

# 4) Cross-check only (not used in the app): Schorghofer & Williams Diviner maps,
#    Harvard Dataverse doi:10.7910/DVN/EGOOCL, directory polar_south_24x6.
D=$RAW/dataverse-schorghofer-williams; mkdir -p $D
curl -fL --max-time 600 -o $D/polar_south_24x6_Tmax.grd https://dataverse.harvard.edu/api/access/datafile/8128918
curl -fL --max-time 600 -o $D/polar_south_24x6_Tmean.grd https://dataverse.harvard.edu/api/access/datafile/8128920
curl -fL --max-time 120 -o $D/README.TXT https://dataverse.harvard.edu/api/access/datafile/9832143

md5 $RAW/pds-lola-illumination/*.img $RAW/pds-diviner-prp/*.zip $RAW/dataverse-schorghofer-williams/*.grd
