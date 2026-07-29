import { getDeltaCoefficient, getExpectedWinRate, binarySearchExpectedRating } from '../scripts/predictor.js';

function assertApprox(actual, expected, tolerance = 0.01) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`Assertion failed: expected ${expected} but got ${actual}`);
  }
}

console.log("Running unit tests for predictor.js...");

try {
  // 1. Test getDeltaCoefficient
  // Brand new user (0 contests) -> should be 0.5
  assertApprox(getDeltaCoefficient(0), 0.5);
  // Extremely established user (e.g., 200 contests) -> should be 2/9 (approx 0.2222)
  assertApprox(getDeltaCoefficient(200), 2/9);

  // 2. Test getExpectedWinRate
  // Equal ratings -> 50% win rate
  assertApprox(getExpectedWinRate(1500, 1500), 0.5);
  // Huge rating gap (2500 vs 1500) -> 1500 should almost always lose (win rate close to 0)
  // Formula: 1 / (1 + 10^((1500 - 2500)/400)) = 1 / (1 + 10^(-2.5)) ≈ 0.9968 probability that 2500 wins
  // Wait, our function is getExpectedWinRate(otherRating, myRating)
  assertApprox(getExpectedWinRate(2500, 1500), 1 / (1 + Math.pow(10, (1500 - 2500)/400)));

  // 3. Test binarySearchExpectedRating
  // If everyone has 1500 rating (5 competitors), and you are expected to lose to exactly 2.5 of them
  // your target expected rank is 3.5. Your rating should be exactly 1500.
  const allRatings = [1500, 1500, 1500, 1500, 1500]; 
  const expectedRat = binarySearchExpectedRating(3.5, allRatings);
  assertApprox(expectedRat, 1500, 1); 

  console.log("✅ All core math unit tests passed!");
} catch (e) {
  console.error("❌ Test failed:", e.message);
}
