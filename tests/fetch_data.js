/**
 * Instructions to fetch validation data for LeetCode contests
 * 
 * Since LeetCode heavily protects its ranking APIs with Cloudflare, running a Node.js script
 * to scrape 25,000+ users' ratings often fails. 
 * 
 * However, since you are building a Chrome extension, you can easily bypass this by running 
 * a fetch script directly in your browser!
 * 
 * --- HOW TO GET VALIDATION DATA ---
 * 1. Open Chrome and go to any LeetCode page (e.g. https://leetcode.com/contest/).
 * 2. Open Developer Tools (F12 or Ctrl+Shift+I) and go to the "Console" tab.
 * 3. Copy and paste the following snippet into the console and hit Enter.
 *    (It uses a 3rd party API `lccn.lbao.site` which maintains historical contest data 
 *    with BOTH old_rating and the actual official rating changes).
 * 
 * ```javascript
 * (async function dumpContestData(contestName = "weekly-contest-350") {
 *   console.log(`Fetching records for ${contestName}... this may take a moment.`);
 *   try {
 *     // lccn.lbao.site allows fetching archived results which include old_rating and actual rating changes.
 *     // A typical contest has 20-30k users. We fetch the top 20000 for validation.
 *     const res = await fetch(`https://lccn.lbao.site/api/v1/contest-records/?contest_name=${contestName}&archived=true&limit=25000`);
 *     const data = await res.json();
 *     
 *     const formattedRecords = data.map(record => ({
 *       username: record.username,
 *       rank: record.rank,
 *       score: record.score,
 *       oldRating: record.old_rating,
 *       actualDelta: record.delta_rating,
 *       attendedContestsCount: record.attendedContestsCount
 *     }));
 * 
 *     // Trigger download of the JSON file
 *     const blob = new Blob([JSON.stringify(formattedRecords, null, 2)], { type: "application/json" });
 *     const url = URL.createObjectURL(blob);
 *     const a = document.createElement("a");
 *     a.href = url;
 *     a.download = "contest_data.json";
 *     a.click();
 *     console.log("Download triggered! Save this file to the root of your project.");
 *   } catch (err) {
 *     console.error("Failed to fetch data:", err);
 *   }
 * })();
 * ```
 * 
 * 4. Move the downloaded `contest_data.json` into the root of this project.
 * 5. Run `node src/validate.js` to see the algorithm's accuracy!
 */
