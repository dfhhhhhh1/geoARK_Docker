-- Fine sample points: the 118M 2020 block centroids + hexagon points of
-- /scratch/US_L48GeoARK_TEMP/US_L48GeoARK.gdb, layer
-- L48_All_Pt_Blk1020ZipHUC_TH_Area, with their precomputed distances.
-- Plan and status: docs/POINTS_INTEGRATION_PLAN.md (Step 2).
--
-- NOT a geo_unit level: these are sample points, not units anything is
-- reported by. One partition per state so a single-state question never
-- touches the rest, and each partition gets its own GIST index.
--
-- Distances are MILES, already corrected to approximate ground distance:
--   d_*            ArcGIS Near, planar metres in World Cylindrical Equal Area
--                  (ESRI:54034). Stored as given / 1609.344: no per-point
--                  correction exists, because the error depends on direction
--                  (east-west x 1/cos(lat), north-south x cos(lat)). Measured
--                  around Columbia MO: median 0.977 of geodesic, p05-p95 0.78-1.28.
--   vha_mi         DIST_VHA, same metric as d_* (median 1.003 of the 54034 distance
--                  to the loaded VHA layer, but an exact match for only 2.4% of
--                  points: it was computed against a different VHA facility list).
--   hosp/parks     sampled from Euclidean-distance rasters in Web Mercator
--                  (EPSG:3857, HospEDist.aux.xml), which scale every distance by
--                  1/cos(lat). Stored as value * cos(lat) / 1609.344. Measured for
--                  hospitals in MO: raw/Mercator median 0.998 (p05-p95
--                  0.986-1.006), raw/geodesic 1.287 = 1/cos(39N). Parks assumed
--                  the same pipeline (same integer *EDist field); which park
--                  layer it measured to is not recorded.
--   UrgCareEDist   not loaded: NULL on every point checked (all 2.7M in MO).
-- The loader is etl/load_fine_points.sh.

CREATE TABLE IF NOT EXISTS fine_pt (
    state_fp        char(2)  NOT NULL,
    pt_id           bigint   NOT NULL,          -- gdb OBJECTID
    block20         char(15) NOT NULL,
    grid_id         text,                       -- hexagon id; 'BLOCK2020_ID' for block centroids
    is_centroid     boolean  NOT NULL,
    zip             text,
    huc12           char(12),
    thiessen_m2     real,                       -- Thiessen (Voronoi) cell area, m2
    geom            geometry(Point, 4326) NOT NULL,
    hosp_mi real, parks_mi real, vha_mi real,
    power_line_density real,                    -- as published; units not documented
    ems_mi real, public_health_mi real, child_care_mi real, public_school_mi real,
    college_mi real, worship_mi real, public_transit_mi real, power_line_mi real,
    substation_mi real, power_plant_mi real, oil_refinery_mi real,
    oil_refinery_site_mi real, biodiesel_mi real, tri_facility_mi real,
    tsca_facility_mi real, landfill_mi real, tornado_track_mi real,
    construction_minerals_mi real, agricultural_minerals_mi real,
    abrasive_minerals_mi real, misc_industrial_minerals_mi real,
    mine_mineral_site_mi real, ferrous_mine_mi real, ferrous_processing_mi real,
    nonferrous_mine_mi real, nonferrous_processing_mi real,
    uranium_vanadium_mi real,
    ems_fid integer,                            -- nearest EMS station, gdb FID
    PRIMARY KEY (state_fp, pt_id)
) PARTITION BY LIST (state_fp);
