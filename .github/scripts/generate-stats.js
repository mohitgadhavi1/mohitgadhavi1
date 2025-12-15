const https = require('https');
const fs = require('fs');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const USERNAME = process.env.USERNAME;

// GitHub API request helper
function githubRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'GitHub-Stats-Generator',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
        }
      });
    }).on('error', reject);
  });
}

// Get all repositories (including private)
async function getAllRepos() {
  const repos = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await githubRequest(`/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`);
    // Filter out forked repositories
    const nonForkedRepos = data.filter(repo => !repo.fork);
    repos.push(...nonForkedRepos);
    hasMore = data.length === 100;
    page++;
  }

  return repos;
}

// Get commit activity for a repo
async function getCommitActivity(owner, repo) {
  try {
    const commits = await githubRequest(`/repos/${owner}/${repo}/commits?author=${USERNAME}&per_page=100`);
    return commits;
  } catch (error) {
    console.log(`Could not fetch commits for ${owner}/${repo}`);
    return [];
  }
}

// Calculate streaks and active days
function calculateStreaks(dates) {
  if (dates.length === 0) return { current: 0, longest: 0, total: 0 };

  const sortedDates = [...new Set(dates)].sort((a, b) => new Date(b) - new Date(a));
  const today = new Date().toISOString().split('T')[0];
  
  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;
  
  // Calculate current streak
  let checkDate = new Date();
  for (let i = 0; i < sortedDates.length; i++) {
    const dateStr = checkDate.toISOString().split('T')[0];
    if (sortedDates.includes(dateStr)) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }
  
  // Calculate longest streak
  for (let i = 0; i < sortedDates.length; i++) {
    if (i === 0) {
      tempStreak = 1;
    } else {
      const prev = new Date(sortedDates[i - 1]);
      const curr = new Date(sortedDates[i]);
      const diffDays = Math.floor((prev - curr) / (1000 * 60 * 60 * 24));
      
      if (diffDays === 1) {
        tempStreak++;
      } else {
        longestStreak = Math.max(longestStreak, tempStreak);
        tempStreak = 1;
      }
    }
  }
  longestStreak = Math.max(longestStreak, tempStreak);
  
  return {
    current: currentStreak,
    longest: longestStreak,
    total: sortedDates.length
  };
}

// Calculate year-wise stats
function calculateYearlyStats(dates) {
  const yearly = {};
  
  dates.forEach(date => {
    const year = new Date(date).getFullYear();
    if (!yearly[year]) {
      yearly[year] = { days: new Set(), contributions: 0 };
    }
    yearly[year].days.add(date);
    yearly[year].contributions++;
  });
  
  return Object.entries(yearly)
    .sort((a, b) => b[0] - a[0])
    .map(([year, data]) => ({
      year,
      activeDays: data.days.size,
      contributions: data.contributions
    }));
}

// Get language statistics
async function getLanguageStats(repos) {
  const languages = {};
  const excludedLanguages = ['Open Policy Agent', 'SCSS', 'Scss'];
  
  for (const repo of repos) {
    try {
      const repoLangs = await githubRequest(`/repos/${repo.owner.login}/${repo.name}/languages`);
      
      for (const [lang, bytes] of Object.entries(repoLangs)) {
        // Skip excluded languages
        if (excludedLanguages.includes(lang)) {
          continue;
        }
        languages[lang] = (languages[lang] || 0) + bytes;
      }
      
      // Debug logging
      const includedLangs = Object.keys(repoLangs).filter(l => !excludedLanguages.includes(l));
      if (includedLangs.length > 0) {
        console.log(`${repo.name}: ${includedLangs.join(', ')}`);
      }
    } catch (error) {
      console.log(`Could not fetch languages for ${repo.name}`);
    }
  }
  
  const total = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0);
  
  console.log('\nTotal bytes per language:');
  Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .forEach(([lang, bytes]) => {
      const mb = (bytes / 1024 / 1024).toFixed(2);
      const pct = ((bytes / total) * 100).toFixed(1);
      console.log(`  ${lang}: ${mb} MB (${pct}%)`);
    });
  
  return Object.entries(languages)
    .map(([name, bytes]) => ({
      name,
      percentage: ((bytes / total) * 100).toFixed(1)
    }))
    .sort((a, b) => parseFloat(b.percentage) - parseFloat(a.percentage))
    .slice(0, 10);
}

// Generate progress bar
function generateProgressBar(percentage, length = 20) {
  const filled = Math.round((percentage / 100) * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

// Main function
async function main() {
  console.log('Fetching repositories...');
  const repos = await getAllRepos();
  console.log(`Found ${repos.length} repositories`);
  
  console.log('Fetching commit data...');
  const allDates = [];
  
  for (const repo of repos) {
    const commits = await getCommitActivity(repo.owner.login, repo.name);
    commits.forEach(commit => {
      if (commit.commit && commit.commit.author) {
        const date = commit.commit.author.date.split('T')[0];
        allDates.push(date);
      }
    });
  }
  
  console.log('Calculating statistics...');
  const streaks = calculateStreaks(allDates);
  const yearlyStats = calculateYearlyStats(allDates);
  const languageStats = await getLanguageStats(repos);
  
  // Read README
  let readme = fs.readFileSync('README.md', 'utf8');
  
  // Update streak section
  const streakContent = `**Current Streak:** ${streaks.current} days  
**Longest Streak:** ${streaks.longest} days  
**Total Active Days:** ${streaks.total} days`;
  
  readme = readme.replace(
    /<!-- STREAK_START -->[\s\S]*?<!-- STREAK_END -->/,
    `<!-- STREAK_START -->\n${streakContent}\n<!-- STREAK_END -->`
  );
  
  // Update yearly section
  const yearlyTable = `| Year | Active Days | Contributions |
|------|-------------|---------------|
${yearlyStats.map(y => `| ${y.year} | ${y.activeDays} | ${y.contributions} |`).join('\n')}`;
  
  readme = readme.replace(
    /<!-- YEARLY_START -->[\s\S]*?<!-- YEARLY_END -->/,
    `<!-- YEARLY_START -->\n${yearlyTable}\n<!-- YEARLY_END -->`
  );
  
  // Update languages section
  const languagesContent = languageStats
    .map(lang => `${lang.name.padEnd(12)} ${generateProgressBar(parseFloat(lang.percentage))} ${lang.percentage.padStart(5)}%`)
    .join('\n');
  
  readme = readme.replace(
    /<!-- LANGUAGES_START -->[\s\S]*?<!-- LANGUAGES_END -->/,
    `<!-- LANGUAGES_START -->\n\`\`\`\n${languagesContent}\n\`\`\`\n<!-- LANGUAGES_END -->`
  );
  
  // Update last updated timestamp
  const now = new Date().toUTCString();
  readme = readme.replace(
    /\*Last Updated:.*\*/,
    `*Last Updated: ${now}*`
  );
  
  // Write README
  fs.writeFileSync('README.md', readme);
  console.log('README.md updated successfully!');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});