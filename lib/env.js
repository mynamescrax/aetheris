// Empty, invalid and out-of-range values use the default; an explicit zero
// remains zero (notably for cache budgets that can be disabled).
export function envNumber(name, fallback, minimum = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}
