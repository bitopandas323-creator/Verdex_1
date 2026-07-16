// Infrastructure/Transit & Amenity Access scoring formula, extracted out
// of scripts/recompute-infra-walk.mjs so it can be shared between that
// batch script (data/nearby-places.json, all 80 neighbourhoods) and
// api/hyderabad-grid-lookup.js (a single grid cell's places, computed
// per-request for exact-point precision). Same functions, same
// thresholds, no behavior change from the version validated and shipped
// for the 80-neighbourhood rollout — this file only relocates them.
//
// Callers just need `places` in the schema produced by fetchPlaces/
// CATEGORY_DEFS (scripts/fetch-nearby-places.mjs): both data/nearby-
// places.json entries and pilot-grid-hyderabad-core.json cells are built
// by that same function, so no adaptation is needed either way.

// FLOOR: the practical minimum is 1.5, not 0 — a hard 0 read identically to
// "nothing exists here" for legitimately spread-out/suburban areas (e.g.
// New Town) that just have longer-than-average but non-zero distances.
// Applied per-category (not as a final clamp on the combined average) so a
// neighbourhood where every single category maxes out its distance still
// averages to exactly the floor, not below it.
const FLOOR = 1.5;

function distanceToScore(distanceKm, goodKm, zeroKm) {
  if (distanceKm <= goodKm) return 10;
  if (distanceKm >= zeroKm) return FLOOR;
  return FLOOR + (10 - FLOOR) * (zeroKm - distanceKm) / (zeroKm - goodKm);
}

// [goodKm, zeroKm] — empirical p10/p90 nearest-distance across all 80
// real neighbourhoods, computed directly from data/nearby-places.json.
const INFRA_THRESHOLDS = {
  hospital:     [0.5, 4.7],
  clinic:       [0.1, 0.8],
  school:       [0.5, 5.6],
  college:      [0.7, 4.6],
  police:       [0.2, 2.1],
  fire_station: [0.8, 4.1],
  grocery:      [0.5, 3.9],
  pharmacy:     [0.3, 5.2],
  atm_bank:     [0,   1.0]
};

const TRANSIT_THRESHOLDS = {
  bus_stop:      [0,   0.9],
  metro_station: [0.2, 2.1]
};
const RESTAURANT_DENSITY_THRESHOLD = [0.1, 1.3]; // distance to 4th-closest (or farthest found)

function computeInfraScore(places) {
  const categoryScores = [];
  for (const [cat, [goodKm, zeroKm]] of Object.entries(INFRA_THRESHOLDS)) {
    const p = places[cat];
    if (p && p.candidates && p.candidates.length > 0) {
      categoryScores.push(distanceToScore(p.candidates[0].distanceKm, goodKm, zeroKm));
    }
    // Missing category (e.g. fire_station in a genuinely sparse area) is
    // excluded from the average, not scored 0 — a missing fire station
    // within 5km is normal (16/80 neighbourhoods), not a sign of poor
    // infrastructure.
  }
  if (categoryScores.length === 0) return null;
  const avg = categoryScores.reduce((a, b) => a + b, 0) / categoryScores.length;
  return parseFloat(avg.toFixed(1));
}

function computeWalkScore(places) {
  const transitScores = [];
  for (const [cat, [goodKm, zeroKm]] of Object.entries(TRANSIT_THRESHOLDS)) {
    const p = places[cat];
    if (p && p.candidates && p.candidates.length > 0) {
      transitScores.push(distanceToScore(p.candidates[0].distanceKm, goodKm, zeroKm));
    }
  }
  const transitScore = transitScores.length > 0
    ? transitScores.reduce((a, b) => a + b, 0) / transitScores.length
    : null;

  const restaurants = places.restaurant_cafe;
  let densityScore = null;
  if (restaurants && restaurants.candidates && restaurants.candidates.length > 0) {
    const farthest = restaurants.candidates[restaurants.candidates.length - 1].distanceKm;
    densityScore = distanceToScore(farthest, RESTAURANT_DENSITY_THRESHOLD[0], RESTAURANT_DENSITY_THRESHOLD[1]);
  }

  if (transitScore === null && densityScore === null) return null;
  if (transitScore === null) return parseFloat(densityScore.toFixed(1));
  if (densityScore === null) return parseFloat(transitScore.toFixed(1));
  return parseFloat((transitScore * 0.6 + densityScore * 0.4).toFixed(1));
}

export {
  FLOOR,
  distanceToScore,
  INFRA_THRESHOLDS,
  TRANSIT_THRESHOLDS,
  RESTAURANT_DENSITY_THRESHOLD,
  computeInfraScore,
  computeWalkScore
};
