document.addEventListener('DOMContentLoaded', () => {
  const contestsContainer = document.getElementById('contests-container');

  function fetchAndRenderHistory() {
    chrome.storage.local.get(['lc_username'], (result) => {
      const username = result.lc_username;
      
      if (!username) {
        contestsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--lc-text-secondary);">Please log in to LeetCode, then reopen this popup.</div>';
        return;
      }

      chrome.runtime.sendMessage(
        { action: 'fetchUserContestHistory', username: username }, 
        (response) => {
          if (response && response.data && response.data.length > 0) {
            renderContests(response.data.slice(0, 5));
          } else {
            contestsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--lc-text-secondary);">No contest history found.</div>';
          }
        }
      );
    });
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'historyUpdated') {
      fetchAndRenderHistory();
    }
  });

  fetchAndRenderHistory();

  function renderContests(contests) {
    contestsContainer.innerHTML = '';

    contests.forEach(contest => {
      const card = document.createElement('div');
      card.className = 'contest-card';

      let deltaClass = 'neutral';
      let deltaSign = '';
      let arrow = '';
      
      const deltaVal = contest.delta !== null && contest.delta !== undefined && contest.delta !== '-' ? Math.round(contest.delta) : null;
      
      if (deltaVal !== null) {
        if (deltaVal > 0) {
          deltaClass = 'positive';
          deltaSign = '+';
          arrow = '↑';
        } else if (deltaVal < 0) {
          deltaClass = 'negative';
          arrow = '↓';
        } else {
          deltaSign = '';
          arrow = '-';
        }
      }

      const deltaHTML = deltaVal !== null ? `${deltaSign}${deltaVal} ${arrow}` : '–';

      const actualText = contest.actualRating !== null && contest.actualRating !== undefined && contest.actualRating !== '-'
        ? Math.round(contest.actualRating) 
        : '–';
        
      const predictedText = contest.predictedRating !== null && contest.predictedRating !== undefined && contest.predictedRating !== '-'
        ? Math.round(contest.predictedRating) 
        : '–';

      card.innerHTML = `
        <div class="contest-header">
          <div class="contest-title">${contest.name}</div>
          <div class="delta ${deltaClass}">
            ${deltaHTML}
          </div>
        </div>
        <div class="contest-details">
          <div class="rating-info">
            <span class="rating-label">Actual</span>
            <span class="rating-value">${actualText}</span>
          </div>
          <div class="rating-info" style="text-align: right;">
            <span class="rating-label">Predicted</span>
            <span class="rating-value">${predictedText}</span>
          </div>
        </div>
      `;
      
      contestsContainer.appendChild(card);
    });
  }
});
