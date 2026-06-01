const counters = new Map();

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function checkAndIncrement(guildId, dailyLimit) {
  if (!guildId || !dailyLimit || dailyLimit <= 0) {
    return { allowed: true, remaining: Infinity };
  }

  const today = todayString();
  let entry = counters.get(guildId);

  if (!entry || entry.date !== today) {
    entry = { date: today, count: 0 };
    counters.set(guildId, entry);
  }

  if (entry.count >= dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  return { allowed: true, remaining: dailyLimit - entry.count };
}

function getUsage(guildId) {
  if (!guildId) return null;
  const today = todayString();
  const entry = counters.get(guildId);
  if (!entry || entry.date !== today) return { count: 0, date: today };
  return { count: entry.count, date: entry.date };
}

function resetForTests() {
  counters.clear();
}

module.exports = {
  checkAndIncrement,
  getUsage,
  resetForTests,
};
