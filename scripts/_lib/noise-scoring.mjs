// Noise scoring formula, extracted out of scripts/recompute-noise.mjs so
// it can be shared between that batch script (data/neighbourhoods.json,
// all 80 neighbourhoods) and api/grid-lookup.js (a single grid cell's
// road/rail proximity, computed per-request for exact-point precision, for
// any registered city's grid) - same mirroring relationship
// infra-walk-scoring.mjs already has with recompute-infra-walk.mjs. Same
// thresholds, same worse-of-two combination, no behavior change from the
// version validated and shipped for the 80-neighbourhood rollout - this
// file only relocates the pure math.
//
// Unlike Infrastructure/Walkability, closer = WORSE here (louder), not
// better - distanceToNoiseScore is the same linear-ramp shape but
// inverted: floor at the near threshold, 10 at the far threshold.

const FLOOR = 1.5; // same practical-minimum reasoning as Infrastructure/Walkability

function distanceToNoiseScore(distanceKm, closeKm, farKm) {
  if (distanceKm <= closeKm) return FLOOR;
  if (distanceKm >= farKm) return 10;
  return FLOOR + (10 - FLOOR) * (distanceKm - closeKm) / (farKm - closeKm);
}

// [closeKm, farKm] - empirical p10/p90 nearest-distance across the 80 real
// neighbourhoods (road: true p10/p90 after the precision fix documented in
// recompute-noise.mjs; rail: p10/p90 of the 79/80 resolved). Reused as-is
// for the grid, per explicit instruction - not re-derived from grid-scale
// distributions, so a cell's score stays comparable to a neighbourhood's.
const ROAD_THRESHOLDS = [0.0028, 0.4456];
const RAIL_THRESHOLDS = [0.05, 2.01];

// Worse (louder) of the two dominates - noise doesn't average, the
// closer/louder source determines the actual ambient experience.
function combineNoiseScore(roadScore, railScore) {
  return parseFloat(Math.min(roadScore, railScore).toFixed(1));
}

// Grid-specific: cell.roadPrecise/cell.railway (scripts/fetch-grid-noise-
// proximity.mjs) use distanceKm: null to mean "confirmed absent within the
// 5km search radius" - a real fact from a single successful whole-city
// fetch, not an unresolved gap the way a per-neighbourhood fetch failure
// would be. Infinity is the correct input for that: distanceToNoiseScore
// already returns 10 (quietest) for any distance >= farKm, so "nothing
// found" naturally floors out at the right answer without a separate
// branch. Contrast with recompute-noise.mjs's own null-handling, which
// still means "unresolved/gap" there (see that file) - deliberately NOT
// reused here, the two contexts have genuinely different null semantics.
function computeGridNoiseScore(cell) {
  if (!cell || !cell.roadPrecise || !cell.railway) return null;
  const roadDistanceKm = cell.roadPrecise.distanceKm === null ? Infinity : cell.roadPrecise.distanceKm;
  const railDistanceKm = cell.railway.distanceKm === null ? Infinity : cell.railway.distanceKm;
  const roadScore = distanceToNoiseScore(roadDistanceKm, ...ROAD_THRESHOLDS);
  const railScore = distanceToNoiseScore(railDistanceKm, ...RAIL_THRESHOLDS);
  return combineNoiseScore(roadScore, railScore);
}

export {
  FLOOR,
  distanceToNoiseScore,
  ROAD_THRESHOLDS,
  RAIL_THRESHOLDS,
  combineNoiseScore,
  computeGridNoiseScore
};
