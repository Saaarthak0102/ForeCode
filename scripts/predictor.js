/**
 * LeetCode Contest Rating Prediction Algorithm
 * Based on the official LeetCode Elo variant.
 */

// Cache for the sigma series to calculate delta coefficients
const sigmaCache = new Map();
sigmaCache.set(0, 1);

function preSumOfSigma(k) {
  if (k < 0) return 0;
  if (sigmaCache.has(k)) {
    return sigmaCache.get(k);
  }
  const val = Math.pow(5 / 7, k) + preSumOfSigma(k - 1);
  sigmaCache.set(k, val);
  return val;
}

/**
 * Get the weight adjustment factor based on attended contests.
 * New users have a higher factor (~0.5) that decays to 2/9.
 */
function getDeltaCoefficient(k) {
  if (k <= 100) {
    return 1 / (1 + preSumOfSigma(k));
  }
  return 2 / 9;
}

/**
 * Calculate expected win rate of `rating` against `otherRating`.
 * Returns the probability that `otherRating` wins (i.e. `rating` loses).
 */
function getExpectedWinRate(otherRating, rating) {
  return 1 / (1 + Math.pow(10, (rating - otherRating) / 400));
}

/**
 * Binary search to find expected rating based on mean rank.
 */
function binarySearchExpectedRating(meanRank, allRatings) {
  let lo = 0;
  let hi = 4000;
  let maxIteration = 50;
  const precision = 0.01;
  const target = meanRank - 1; // expected_rank is 1-indexed

  let mid = 0;
  while (hi - lo > precision && maxIteration >= 0) {
    mid = lo + (hi - lo) / 2;
    
    // Sum of expected win rates for `mid` against all competitors
    let sumWinRates = 0;
    for (let i = 0; i < allRatings.length; i++) {
      sumWinRates += getExpectedWinRate(allRatings[i], mid);
    }
    
    if (sumWinRates < target) {
      hi = mid;
    } else {
      lo = mid;
    }
    maxIteration--;
  }
  return mid;
}

/**
 * Predicts the new ratings for a list of contest records.
 * 
 * @param {Array} records - Array of participant objects. 
 * Expected shape for each object:
 * {
 *   username: string,
 *   rank: number, // 1-indexed rank. Tied users should have the exact same rank.
 *   score: number,
 *   oldRating: number, // The user's rating before the contest
 *   attendedContestsCount: number // How many contests the user attended prior to this one
 * }
 * 
 * @returns {Array} - The modified array of records with `newRating` and `delta` fields added.
 */
function predictRatings(records) {
  // Only users with score > 0 get rating changes normally, 
  // but let's process everyone passed in. 
  // Filter out any invalid records if needed (the caller should ideally pass valid submitters).

  const allRatings = records.map(r => r.oldRating || 1500); // 1500 is default for unrated
  
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const currentRating = record.oldRating || 1500;
    const k = record.attendedContestsCount || 0;
    
    // 1. Calculate Expected Rank for the current rating
    let expectedRank = 0.5;
    for (let j = 0; j < allRatings.length; j++) {
      expectedRank += getExpectedWinRate(allRatings[j], currentRating);
    }
    
    // 2. Geometric mean of expected rank and actual rank
    const meanRank = Math.sqrt(expectedRank * record.rank);
    
    // 3. Binary search to find what rating would give us `meanRank`
    const expectedRating = binarySearchExpectedRating(meanRank, allRatings);
    
    // 4. Calculate actual delta using the weight coefficient
    const deltaCoefficient = getDeltaCoefficient(k);
    const delta = (expectedRating - currentRating) * deltaCoefficient;
    
    record.delta = delta;
    record.newRating = currentRating + delta;
  }
  
  return records;
}

export {
  getDeltaCoefficient,
  getExpectedWinRate,
  binarySearchExpectedRating,
  predictRatings
};
