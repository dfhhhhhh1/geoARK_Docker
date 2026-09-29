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
};

/**
 * How each statistic should be read. The numbers are derived rather than
 * measured, so a reader who did not choose the operator has no way to know what
 * "2.3" means without being told.
 */
export const OP_READING: Partial<Record<PlanOp, string>> = {
  hotspot:
    'Getis-Ord Gi*. Strongly positive means this county and its neighbours are ' +
    'all high; strongly negative means they are all low. Around ±2 is the ' +
    'conventional threshold, though with 3,233 counties that ignores multiple ' +
    'comparisons, so read it as a strength ordering rather than a significance test.',
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
