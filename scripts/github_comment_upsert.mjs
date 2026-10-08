import fs from 'node:fs/promises';

const [issueNumber, marker, bodyPath] = process.argv.slice(2);

if (!/^[1-9]\d*$/.test(issueNumber || '') || !/^[a-z0-9-]{1,40}$/.test(marker || '') || !bodyPath) {
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
const input = await fs.open(bodyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let text;
try {
  const stat = await input.stat();
  if (!stat.isFile() || stat.size > 50000) throw new Error('Review artifact must be bounded regular text.');
  text = await input.readFile('utf8');
  if (text.includes('\0')) throw new Error('Binary review artifact refused.');
} finally { await input.close(); }
const body = `${markerText}\n${text}`;

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

if (process.env.EXPECTED_HEAD) {
  const pr = await github(`/repos/${owner}/${repo}/pulls/${issueNumber}`);
  if (pr.state !== 'open' || pr.head.sha !== process.env.EXPECTED_HEAD) throw new Error('Stale review; PR head changed.');
}
const comments = await github(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
const existing = comments.find((comment) => comment.user?.type === 'Bot' && comment.body?.startsWith(markerText));

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
