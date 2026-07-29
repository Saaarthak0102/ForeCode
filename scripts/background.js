

// URL for your backend API
const API_URL = "http://localhost:8000/api/v1"; // Change this to your hosted backend URL

// Simple in-memory cache for predictions to avoid spamming the API
const predictionCache = new Map();
async function getLeetCodeUsername() {
  try {
    const res = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "query globalData { userStatus { username } }"
      })
    });
    const data = await res.json();
    return data?.data?.userStatus?.username;
  } catch (e) {
    return null;
  }
}

async function addOrUpdateHistoryEntry(record, username) {
  return new Promise((resolve) => {
    const key = `history_${username}`;
    chrome.storage.local.get([key], (result) => {
      let history = result[key] || [];
      
      const mappedRecord = {
        name: record.contest_title,
        actualRating: record.actual_rating,
        predictedRating: record.predicted_rating || '-',
        delta: record.actual_delta !== null ? record.actual_delta : record.predicted_delta
      };

      const existingIdx = history.findIndex(r => r.name === mappedRecord.name);
      if (existingIdx >= 0) {
        history[existingIdx] = mappedRecord;
      } else {
        // Push to bottom (older history usually fetched in bulk)
        // Wait, for new pending predictions we want unshift, but for bulk history we just append
        history.push(mappedRecord);
      }

      chrome.storage.local.set({ [key]: history }, () => resolve());
    });
  });
}

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('checkPendingPrediction', { periodInMinutes: 20 });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create('checkPendingPrediction', { periodInMinutes: 20 });
  
  if (details.reason === "install") {
    console.log("LeetCode Rating Predictor Extension installed.");
    const username = await getLeetCodeUsername();
    
    if (username) {
      chrome.storage.local.set({ lc_username: username });
      try {
        await fetch(`${API_URL}/user/${username}/register`, { method: 'POST' });
        const res = await fetch(`${API_URL}/user/${username}/history?limit=5`);
        if (res.ok) {
            const history = await res.json();
            for (const record of history) {
              await addOrUpdateHistoryEntry(record, username);
            }
        }
      } catch (err) {
        console.error("Failed to setup during install", err);
      }
    }
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkPendingPrediction') {
    chrome.storage.local.get(['lc_username'], async (result) => {
      const username = result.lc_username;
      if (!username) return;

      try {
        const res = await fetch(`${API_URL}/user/${username}/pending-prediction`);
        if (!res.ok) return;
        
        const prediction = await res.json();
        if (!prediction) return; // no pending predictions

        const key = `history_${username}`;
        chrome.storage.local.get([key], (histResult) => {
          let history = histResult[key] || [];
          const existingIdx = history.findIndex(r => r.name === prediction.contest_title);
          
          let changed = false;

          if (prediction.status === "pending" && existingIdx === -1) {
            // New pending prediction not in history
            const mappedRecord = {
              name: prediction.contest_title,
              actualRating: null,
              predictedRating: prediction.predicted_rating,
              delta: prediction.predicted_delta
            };
            history.unshift(mappedRecord); // Add to top since it's the newest
            changed = true;
          } else if (prediction.status === "confirmed" && existingIdx >= 0) {
            // Already in history, check if we need to lock in actual rating
            if (history[existingIdx].actualRating === null || history[existingIdx].actualRating === undefined) {
              history[existingIdx].actualRating = prediction.actual_rating;
              history[existingIdx].delta = prediction.actual_delta;
              changed = true;
            }
          }

          if (changed) {
            chrome.storage.local.set({ [key]: history }, () => {
              // Notify any open popups
              chrome.runtime.sendMessage({ action: 'historyUpdated' }).catch(() => {});
              
              // Notify active LeetCode tabs
              chrome.tabs.query({ url: "*://leetcode.com/*" }, (tabs) => {
                for (const tab of tabs) {
                  chrome.tabs.sendMessage(tab.id, { action: 'historyUpdated' }).catch(() => {});
                }
              });
            });
          }
        });
      } catch (err) {
        console.error("Failed to check pending predictions", err);
      }
    });
  }
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
  return new Promise((resolve) => {
    const key = `history_${username}`;
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] || []);
    });
  });
}

async function handleFetchPredictions(usernames) {
  const results = {};
  const usersToFetch = [];

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
