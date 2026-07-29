import fs from 'fs';
import { predictRatings } from '../scripts/predictor.js';

function runValidation() {
  const dataPath = 'contest_data.json';
  
  if (!fs.existsSync(dataPath)) {
    console.error(`Error: Could not find ${dataPath}.`);
    console.log(`Please use the snippet in fetch_data.js in your browser console to download a contest dataset, and save it as ${dataPath}.`);
    
    console.log("\n--- Running with sample dummy data instead ---");
    const dummyRecords = [
      { username: "alice", rank: 1, score: 18, oldRating: 2500, attendedContestsCount: 50, actualDelta: 20 },
      { username: "bob", rank: 2, score: 18, oldRating: 2400, attendedContestsCount: 20, actualDelta: 15 },
      { username: "charlie", rank: 3, score: 12, oldRating: 1500, attendedContestsCount: 0, actualDelta: 50 }, // new user
      { username: "david", rank: 4, score: 7, oldRating: 1600, attendedContestsCount: 5, actualDelta: -10 }
    ];
    validateRecords(dummyRecords);
    return;
  }

  const rawData = fs.readFileSync(dataPath, 'utf-8');
  const records = JSON.parse(rawData);
  console.log(`Loaded ${records.length} records from ${dataPath}.`);
  validateRecords(records);
}

function validateRecords(records) {
  console.log("Running prediction algorithm...");
  const startTime = Date.now();
  
  // Predict
  const results = predictRatings(records);
  
  const timeTaken = Date.now() - startTime;
  console.log(`Prediction completed in ${timeTaken}ms.`);

  let totalAbsoluteError = 0;
  let errorCount = 0;

  console.log("\n--- Validation Results (First 10) ---");
  console.log("Username | Rank | Old Rating | Predicted Delta | Actual Delta | Error");
  console.log("---------------------------------------------------------------------");

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    
    // We can only validate if we know the actual delta
    if (res.actualDelta !== undefined) {
      const err = Math.abs(res.delta - res.actualDelta);
      totalAbsoluteError += err;
      errorCount++;

      if (i < 10) {
        console.log(`${res.username.padEnd(8)} | ${String(res.rank).padEnd(4)} | ${String(res.oldRating).padEnd(10)} | ${res.delta.toFixed(2).padEnd(15)} | ${res.actualDelta.toFixed(2).padEnd(12)} | ${err.toFixed(2)}`);
      }
    } else {
       if (i < 10) {
        console.log(`${res.username.padEnd(8)} | ${String(res.rank).padEnd(4)} | ${String(res.oldRating).padEnd(10)} | ${res.delta.toFixed(2).padEnd(15)} | N/A          | N/A`);
       }
    }
  }

  if (errorCount > 0) {
    const mae = totalAbsoluteError / errorCount;
    console.log("---------------------------------------------------------------------");
    console.log(`Mean Absolute Error (MAE) across ${errorCount} validated users: ${mae.toFixed(4)} points.`);
  } else {
    console.log("\nNo 'actualDelta' found in dataset to compare against.");
  }
}

runValidation();
