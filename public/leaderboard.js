async function loadLeaderboard() {
  const sortBy = document.getElementById('sortBy').value;
  const order = document.getElementById('order').value;
  const res = await fetch(`/leaderboard?format=json&sortBy=${encodeURIComponent(sortBy)}&order=${encodeURIComponent(order)}&limit=100`);
  const payload = await res.json();
  const tbody = document.querySelector('#leaderboardTable tbody');
  tbody.innerHTML = '';
  payload.entries.forEach((entry) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${entry.name}</td><td>${entry.wins}</td><td>${entry.totalGames}</td><td>${entry.averageScore.toFixed(2)}</td><td>${entry.fastestBuzz == null ? '-' : entry.fastestBuzz}</td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById('sortBy').addEventListener('change', loadLeaderboard);
document.getElementById('order').addEventListener('change', loadLeaderboard);
loadLeaderboard();
