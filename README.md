# Mogul Money-Style Self-Hosted Game Show

This project is a self-hosted Node.js + Express + Socket.io web app inspired by the casual trivia flow of Mogul Money.

## Features
- Variable-player scoreboard generated from a dynamic players array (`{ name, score }`).
- Two full 5x5 rounds with automatic transition from Round 1 to Round 2.
- Host-only password-protected control panel.
- Realtime board and score updates via WebSockets (Socket.io).
- Custom game content loading from JSON uploads.
- Quick Money final round controls with timer and per-answer point assignment.
- Supports negative scoring and live re-sorting leaderboard.

## Project Structure
- `server.js`: Express server, game-state engine, Socket.io events, host routes.
- `views/`: EJS templates for viewer board and host/admin pages.
- `public/`: Client-side JS and CSS.
- `data/sample-game.json`: Sample categories, clues, and Quick Money prompts.

## Install and Run
```bash
npm install
node server.js
```

Then open:
- Viewer board: `http://localhost:3000/`
- Host login: `http://localhost:3000/host/login`

Default host password is `mogulhost` in development only (`NODE_ENV=development`). In non-development deployments, `HOST_PASSWORD` is required and the app will fail to start if it is missing.

## Loading Custom JSON Game Data
1. Login as host.
2. Enter comma-separated player names.
3. Upload a JSON file that follows the same structure as `data/sample-game.json`.
4. Click **Start New Game**.

## Sample JSON Schema (simplified)
```json
{
  "round1": { "categories": [ { "name": "...", "clues": [ { "value": 100, "answer": "...", "question": "..." } ] } ] },
  "round2": { "mogulMultiplier": { "categoryIndex": 0, "clueIndex": 0 }, "categories": [ ... ] },
  "quickMoneyPrompts": ["Prompt 1", "Prompt 2", "Prompt 3", "Prompt 4", "Prompt 5"]
}
```

## Notes
- If a client disconnects/reconnects, the server emits current state on connection so they recover gracefully.
- `round2.mogulMultiplier` identifies where the special wager clue can be placed. The host can apply wagers from the host panel.

## Secure Deployment Recommendations
- Set a strong `HOST_PASSWORD` value in your environment for any non-development deployment.
- Run behind a TLS-terminating reverse proxy (for example Nginx/Caddy/Traefik) so host logins and sessions are encrypted.
- Enable secure cookies by setting `COOKIE_SECURE=true` when HTTPS is used (recommended in production).
- Keep `SESSION_SECRET` private and use a long random value in production.
