#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

async function main() {
  const stat = execSync('git diff --cached --stat').toString().trim();
  const patch = execSync('git diff --cached').toString().slice(0, 4000);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `Write a git commit message for these changes. Imperative mood, under 72 chars, no quotes, no trailing period. Just the message, nothing else.\n\n${stat}\n\n${patch}`
    }]
  });

  process.stdout.write(res.content[0].text.trim());
}

main().catch(() => process.stdout.write('update codebase'));
