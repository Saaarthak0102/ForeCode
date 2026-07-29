document.addEventListener('DOMContentLoaded', () => {
  const contestsContainer = document.getElementById('contests-container');

  // Fetch the user's contest history from the background script
  chrome.runtime.sendMessage(
    { action: 'fetchUserContestHistory', username: 'current_user' }, 
    (response) => {
      if (response && response.data) {
        renderContests(response.data);
      } else {
        contestsContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--lc-error);">Failed to load history.</div>';
      }
    }
  );

  function renderContests(contests) {
    contestsContainer.innerHTML = '';

    contests.forEach(contest => {
      const card = document.createElement('div');
      card.className = 'contest-card';

      let deltaClass = 'neutral';
      let deltaSign = '';
      let arrow = '-';
      
      if (contest.delta > 0) {
        deltaClass = 'positive';
        deltaSign = '+';
        arrow = '↑';
      } else if (contest.delta < 0) {
        deltaClass = 'negative';
        arrow = '↓';
      }

      card.innerHTML = `
        <div class="contest-header">
          <div class="contest-title">${contest.name}</div>
          <div class="delta ${deltaClass}">
            ${deltaSign}${contest.delta} ${arrow}
          </div>
        </div>
        <div class="contest-details">
          <div class="rating-info">
            <span class="rating-label">Actual</span>
            <span class="rating-value">${contest.actualRating}</span>
          </div>
          <div class="rating-info" style="text-align: right;">
            <span class="rating-label">Predicted</span>
            <span class="rating-value">${contest.predictedRating}</span>
          </div>
        </div>
      `;
      
      contestsContainer.appendChild(card);
    });
  }
});
