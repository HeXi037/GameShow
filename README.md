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

Default host password is `mogulhost` (set `HOST_PASSWORD` env var in production).

## Loading Custom JSON Game Data
You can start a game using either an uploaded JSON file or a pre-existing file in `data/`.

### Workflow A: Upload JSON from your computer
1. Login as host.
2. Enter comma-separated player names.
3. Upload a JSON file that follows the same structure as `data/sample-game.json`.
4. Click **Start New Game**.

### Workflow B: Load named local file from `data/`
1. Add your game file under `data/` (for example: `data/my-event-rounds.json`).
2. Login as host.
3. Enter comma-separated player names.
4. Leave upload blank and set **Or load from local data/ file** to the file name (for example `my-event-rounds.json`).
5. Click **Start New Game**.

If both upload and local file name are provided, the uploaded file is used.

The server now:
- Cleans up uploaded temp files after parsing (to avoid disk growth).
- Returns clear errors for malformed JSON and file-read failures.

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
