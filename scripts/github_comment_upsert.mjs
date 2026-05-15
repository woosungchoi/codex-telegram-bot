import fs from 'node:fs/promises';

const [issueNumber, marker, bodyPath] = process.argv.slice(2);

if (!issueNumber || !marker || !bodyPath) {
  throw new Error('Usage: node scripts/github_comment_upsert.mjs <issue-number> <marker> <body-file>');
}

const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
const token = process.env.GITHUB_TOKEN;

if (!owner || !repo) {
  throw new Error('GITHUB_REPOSITORY must be set to owner/repo');
}

if (!token) {
  throw new Error('GITHUB_TOKEN is required');
}

const markerText = `<!-- codex-telegram-bot:${marker} -->`;
const body = `${markerText}\n${await fs.readFile(bodyPath, 'utf8')}`;

async function github(path, { method = 'GET', payload } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

const comments = await github(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
const existing = comments.find((comment) => comment.body?.includes(markerText));

if (existing) {
  await github(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
    method: 'PATCH',
    payload: { body },
  });
  console.log(`Updated existing comment ${existing.id}.`);
} else {
  await github(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    payload: { body },
  });
  console.log('Created new comment.');
}
