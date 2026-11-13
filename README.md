# Platossimo

A [Battlesnake](https://docs.battlesnake.com/) bot, written in TypeScript and
hosted for free on Cloudflare Workers.

- Live profile: https://arena.battlesnake.com/battlesnakes/80a0b275-e702-48a9-a523-59987f60a4dc/profile
- Standard 11x11 leaderboard: https://arena.battlesnake.com/leaderboards/d692fd01-5376-4060-8c4c-91dc2ecfe3ba

## Development

- `npm run dev`: run it locally with Wrangler
- `npm test`: run the move-logic tests
- `npm run game`: play a local duel against itself with the Battlesnake CLI

Deploys automatically on every push to `main` via Cloudflare Workers Builds.
