// A missing/failed member query is unknown, not proof that a user left.
export async function refreshPushMembers(bot, groupIds, fetchMembers) {
  const ids = [...new Set(groupIds.map(String))];
  if (!ids.length) return true;
  let snapshot;
  try { snapshot = await fetchMembers(ids); } catch { snapshot = {}; }
  let complete = true;
  for (const id of ids) {
    const rows = snapshot?.members?.[id];
    const valid = Array.isArray(rows) && rows.length > 0 && rows.every(
      row => row && /^\d+$/.test(String(row.user_id)) && Number(row.user_id) > 0);
    if (!valid) {
      bot.gml.delete(Number(id));
      bot.gml.delete(id);
      complete = false;
      continue;
    }
    bot.gml.delete(id);
    bot.gml.set(Number(id), new Map(rows.map(row => [Number(row.user_id), row])));
  }
  return complete;
}

export async function runPushTask(bot, groupIds, fetchMembers, task, isCurrent = () => true) {
  if (!await refreshPushMembers(bot, groupIds, fetchMembers)) return false;
  // Subscriptions created while fetching must wait for their own fresh snapshot.
  if (!isCurrent()) return false;
  await task();
  return true;
}
