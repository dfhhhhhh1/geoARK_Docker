const express = require("express");
const cors = require("cors");


console.log("Starting server...")

const mockDatasets = [
  {
    id: '1',
    title: 'aUS Census Population Density 2020',
    description: 'Comprehensive population density data for all US metropolitan areas, including demographic breakdowns by age, income, and housing characteristics.',
    source: 'US Census Bureau',
    fields: ['population_density', 'total_population', 'median_age', 'median_income', 'housing_units'],
    tags: ['population', 'demographics', 'census', 'urban', 'density'],
    fileSize: '45.2 MB',
    lastUpdated: '2023-08-15',
    coverage: {
      geographic: 'United States',
      temporal: '2020 Census'
    },
    coordinates: { lat: 39.8283, lng: -98.5795 },
    boundingBox: { north: 49.3457, south: 24.7433, east: -66.9513, west: -124.7844 },
    downloadUrl: '#',
    previewUrl: 'https://images.pexels.com/photos/290275/pexels-photo-290275.jpeg'
  },
  {
    id: '2',
    title: 'aEuropean River Water Quality Monitoring 2023',
    description: 'Real-time water quality measurements from major European river systems, including pollutant levels, pH, dissolved oxygen, and temperature data.',
    source: 'European Environment Agency',
    fields: ['ph_level', 'dissolved_oxygen', 'temperature', 'pollutant_concentration', 'turbidity'],
    tags: ['water quality', 'rivers', 'pollution', 'monitoring', 'environment'],
    fileSize: '128.7 MB',
    lastUpdated: '2023-12-01',
    coverage: {
      geographic: 'European Union',
      temporal: '2023 ongoing'
    },
    coordinates: { lat: 54.5260, lng: 15.2551 },
    boundingBox: { north: 71.1853, south: 34.8021, east: 40.2286, west: -31.2685 },
    downloadUrl: '#'
  },
  {
    id: '3',
    title: 'aGlobal Land Cover Classification Satellite Data',
    description: 'High-resolution land cover classification data derived from Landsat and Sentinel satellite imagery, categorizing terrestrial surfaces into forest, agriculture, urban, and water bodies.',
    source: 'NASA Earth Science Division',
    fields: ['land_cover_class', 'confidence_score', 'change_detection', 'vegetation_index', 'surface_reflectance'],
    tags: ['satellite', 'land cover', 'classification', 'remote sensing', 'global'],
    fileSize: '2.1 GB',
    lastUpdated: '2023-11-20',
    coverage: {
      geographic: 'Global',
      temporal: '2020-2023'
    },
    coordinates: { lat: 0, lng: 0 },
    boundingBox: { north: 85, south: -85, east: 180, west: -180 },
    downloadUrl: '#',
    previewUrl: 'https://images.pexels.com/photos/87651/earth-blue-planet-globe-planet-87651.jpeg'
  },
  {
    id: '4',
    title: 'aUrban Heat Island Temperature Data - Major Cities',
    description: 'Detailed temperature measurements and heat island analysis for 50 major global cities, including seasonal variations and correlation with urban development patterns.',
    source: 'International Climate Research Institute',
    fields: ['temperature', 'heat_index', 'urban_density', 'green_space_ratio', 'surface_albedo'],
    tags: ['temperature', 'urban', 'climate', 'heat island', 'cities'],
    fileSize: '89.3 MB',
    lastUpdated: '2023-10-30',
    coverage: {
      geographic: 'Global Major Cities',
      temporal: '2020-2023'
    },
    coordinates: { lat: 40.7128, lng: -74.0060 },
    boundingBox: { north: 60.1699, south: -33.8688, east: 151.2093, west: -122.4194 },
    downloadUrl: '#'
  },
  {
    id: '5',
    title: 'aAgricultural Crop Yield and Soil Data Midwest US',
    description: 'Comprehensive agricultural dataset covering crop yields, soil composition, precipitation, and farming practices across the American Midwest farming region.',
    source: 'USDA Agricultural Research Service',
    fields: ['crop_yield', 'soil_type', 'ph_level', 'nitrogen_content', 'precipitation', 'farming_method'],
    tags: ['agriculture', 'crops', 'soil', 'farming', 'midwest', 'yield'],
    fileSize: '156.4 MB',
    lastUpdated: '2023-09-15',
    coverage: {
      geographic: 'US Midwest',
      temporal: '2018-2023'
    },
    coordinates: { lat: 41.5868, lng: -93.6250 },
    boundingBox: { north: 49.3457, south: 36.9986, east: -80.5204, west: -104.0205 },
    downloadUrl: '#',
    previewUrl: 'https://images.pexels.com/photos/325944/pexels-photo-325944.jpeg'
  },
  {
    id: '6',
    title: 'aCoastal Erosion and Sea Level Rise Pacific Coast',
    description: 'Longitudinal study of coastal changes along the Pacific Coast, measuring erosion rates, sea level variations, and impact on coastal infrastructure.',
    source: 'NOAA Coastal Services Center',
    fields: ['erosion_rate', 'sea_level_change', 'shoreline_position', 'wave_energy', 'infrastructure_impact'],
    tags: ['coastal', 'erosion', 'sea level', 'climate change', 'pacific'],
    fileSize: '234.8 MB',
    lastUpdated: '2023-11-05',
    coverage: {
      geographic: 'US Pacific Coast',
      temporal: '2010-2023'
    },
    coordinates: { lat: 36.7783, lng: -119.4179 },
    boundingBox: { north: 48.9917, south: 32.5343, east: -117.1260, west: -124.4096 },
    downloadUrl: '#'
  }
];

const app = express();
app.use(cors());

// Endpoint: search datasets
app.get("/api/search", (req, res) => {
  const query = (req.query.q || "").toLowerCase();
  const filtered = mockDatasets.filter(
    d =>
      d.title.toLowerCase().includes(query) ||
      d.description.toLowerCase().includes(query) ||
      d.tags.some(tag => tag.toLowerCase().includes(query))
  );
  res.json(filtered);
});

const PORT = 4000;


app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
