import { predictRatings } from './predictor.js';

// URL for your backend API
const API_URL = "http://localhost:8000/api/predict"; // Change this to your hosted backend URL

// Simple in-memory cache for predictions to avoid spamming the API
const predictionCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.log("LeetCode Rating Predictor Extension installed.");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchPredictions') {
    handleFetchPredictions(request.usernames)
      .then(data => sendResponse({ data }))
      .catch(err => {
        console.error("Prediction fetch failed:", err);
        sendResponse({ data: null, error: err.message });
      });
    return true; // Keep channel open for async response
  }
  if (request.action === 'fetchUserContestHistory') {
    handleFetchUserContestHistory(request.username)
      .then(data => sendResponse({ data }))
      .catch(err => {
        console.error("History fetch failed:", err);
        sendResponse({ data: null, error: err.message });
      });
    return true;
  }
});

async function handleFetchUserContestHistory(username) {
  // Mock data for the last 5 contests for a given user
  return [
    { name: "Weekly Contest 400", actualRating: 1850, predictedRating: 1845, delta: 25 },
    { name: "Biweekly Contest 120", actualRating: 1825, predictedRating: 1830, delta: -10 },
    { name: "Weekly Contest 399", actualRating: 1835, predictedRating: 1830, delta: 40 },
    { name: "Weekly Contest 398", actualRating: 1795, predictedRating: 1800, delta: 15 },
    { name: "Biweekly Contest 119", actualRating: 1780, predictedRating: 1775, delta: -5 }
  ];
}

async function handleFetchPredictions(usernames) {
  const results = {};
  const usersToFetch = [];

  // Check cache first
  for (const username of usernames) {
    if (predictionCache.has(username)) {
      results[username] = predictionCache.get(username);
    } else {
      usersToFetch.push(username);
    }
  }

  if (usersToFetch.length === 0) {
    return results;
  }

  try {
    // Mock API call - in a real scenario, you'd POST to your backend
    /*
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: usersToFetch })
    });
    if (!response.ok) throw new Error("API request failed");
    const data = await response.json();
    // Cache and merge data...
    */

    // For now, generate mock data to demonstrate functionality without a live backend
    for (const username of usersToFetch) {
      const mockDelta = (Math.random() * 100) - 50; 
      const data = {
        delta: mockDelta,
        newRating: 1800 + mockDelta
      };
      predictionCache.set(username, data);
      results[username] = data;
    }

  } catch (error) {
    console.warn("Failed to fetch from backend, using mock data.", error);
  }

  return results;
}
