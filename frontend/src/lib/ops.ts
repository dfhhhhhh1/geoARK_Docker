import type { PlanOp } from '../types';

/**
 * Display names for plan operators.
 *
 * Shared rather than duplicated, because it was already in two files and the
 * copies were what made adding an operator a seven-file change. A missing entry
 * falls back to the raw op name, so a new operator shows something honest
 * rather than blank.
 */
export const OP_LABEL: Record<PlanOp, string> = {
  load: 'Load',
  count_features: 'Count features',
  count_near: 'Count nearby',
  nearest_distance: 'Distance to nearest',
  select_features: 'Map locations',
  filter_attr: 'Filter',
  filter_area: 'Restrict to area',
  filter_place: 'Restrict to place',
  per_area: 'Per square mile',
  normalize: 'Normalize',
  aggregate: 'Aggregate',
  rank: 'Rank',
  join: 'Combine',
  combine: 'Compute',
  hotspot: 'Hot and cold spots',
  outlier: 'Outliers',
  correlate: 'Correlation',
  explain: 'Explain',
  output: 'Output',
  intersect: 'Keep matching counties',
  compare_groups: 'Compare two groups',
  composite: 'Composite index',
  moran: "Moran's I / LISA",
  access: 'Access score (2SFCA)',
  neighbors: 'Compare to neighbours',
  residual: 'Above or below expected',
  aggregate_to: 'Roll up to county',
  within: 'Within distance',
  summarize: 'Summarize',
  overlay: 'Overlay',
  enrich: 'Attach area values',
  zonal: 'Summarize raster',
  network_population: 'People within travel time',
};

/**
 * How each statistic should be read. The numbers are derived rather than
 * measured, so a reader who did not choose the operator has no way to know what
 * "2.3" means without being told.
 */
export const OP_READING: Partial<Record<PlanOp, string>> = {
  composite:
    'One score per county from several measures. Each measure is standardized ' +
    'across the counties scored (percentile rank unless the question asked for ' +
    'z-scores or 0-1 rescaling), turned so that the end the question cares about ' +
    'scores high, then combined: a weighted sum (a high value on one measure can ' +
    'offset a low one), a geometric mean (a zero on any measure gives zero), or ' +
    'the minimum (the weakest measure decides). The weights and directions used ' +
    'are listed with the plan.',
  compare_groups:
    'The difference in medians between the two groups, with a Mann-Whitney test ' +
    'whose sample sizes are discounted for neighbouring counties resembling each ' +
    "other (Moran's I). The rank-biserial correlation runs from -1 to 1: the chance " +
    'a county in the first group is higher than one in the second, minus the reverse.',
  hotspot:
    'Getis-Ord Gi*. Strongly positive means this county and its neighbours are ' +
    'all high; strongly negative means they are all low. Around ±2 is the ' +
    'conventional threshold, though with 3,233 counties that ignores multiple ' +
    'comparisons, so read it as a strength ordering rather than a significance test.',
  moran:
    "Moran's I: whether neighbouring counties resemble each other more than a random " +
    'arrangement would (near 0 random, toward 1 clustered, negative dispersed), with ' +
    'a pseudo p-value from random permutations. As LISA it labels each county: ' +
    'High-High and Low-Low are clusters, High-Low and Low-High are spatial outliers ' +
    '(a value unlike its neighbours). At p < 0.05 about 1 county in 20 clears the bar ' +
    'by chance alone, so read isolated classes with care. Neighbours share a border or ' +
    'a corner (queen contiguity), row-standardized.',
  access:
    'Two-step floating catchment (2SFCA). Each facility is shared among all the ' +
    'people within the catchment radius of it, then each county adds up the shares ' +
    'of every facility within that radius, per 100,000 people. A facility shared ' +
    'with a city counts for less than one serving few people. Distance is a ' +
    'straight line from the county centre, not road travel. Zero means no facility ' +
    'within reach, not missing data.',
  neighbors:
    'Spatial lag: each county\'s value minus (or, if asked, divided by) the average ' +
    'of the counties that touch it. Positive means higher than its surroundings. It ' +
    'says nothing about whether the county is high or low nationally, and if the ' +
    'analysis was restricted to an area, only neighbours inside that area count.',
  residual:
    'What is left after a straight-line fit on the predictor (ordinary least squares ' +
    'across counties). Positive means higher than the predictor alone would expect, ' +
    'negative lower. The fit is one predictor only, so a large residual can simply be ' +
    'a factor the fit left out.',
  network_population:
    'People counted along the road network, not in a straight line: each 1 km ' +
    'WorldPop population cell is snapped to its nearest road and costed by drive or ' +
    'walk time (or road distance) to the nearest facility. Reported as people or as ' +
    'a percent of the area\'s population. The short leg from a cell to its road is ' +
    'not costed, and a cell counts as inside an area when its centre is.',
  zonal:
    'A raster summarised over each unit or polygon. A share counts the pixels whose ' +
    'centre falls inside, so a polygon smaller than a pixel reads the pixel it sits in.',
  outlier:
    'Distance from the median in interquartile ranges. Only counties beyond ' +
    '1.5 IQRs from the quartiles are kept, which is the rule a boxplot uses ' +
    'for its whiskers.',
  correlate:
    "Spearman's rank correlation between the two measures across counties, from " +
    '-1 to 1. Significance uses an effective sample size discounted for ' +
    'neighbouring counties resembling each other (Moran\'s I).',
  explain:
    'Each candidate factor correlated with the outcome after holding income, age ' +
    'and rurality fixed (partial Spearman), ranked by the end of its 95% interval ' +
    'nearest zero, with a false-discovery-rate adjustment across the factors.',
};
