/**
 * Morning Publish SLA: schedule start vs publish deadline (local time).
 * Default: start 03:00, publish complete by 07:00.
 */

const DEFAULT_SCHEDULE_HOUR = 3;
const DEFAULT_SCHEDULE_MINUTE = 0;
const DEFAULT_PUBLISH_DEADLINE_HOUR = 7;
const DEFAULT_PUBLISH_DEADLINE_MINUTE = 0;
const DEADLINE_WARNING = "PIPELINE_DEADLINE_MISSED";

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Local calendar wall-time on the same day as `base`.
 * @param {Date|string|number} base
 * @param {number} hour
 * @param {number} minute
 */
function atLocalTime(base, hour, minute) {
  const d = toDate(base) || new Date();
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    Number(hour) || 0,
    Number(minute) || 0,
    0,
    0
  );
}

function formatLocalHm(value) {
  const d = toDate(value);
  if (!d) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatDeadlineLabel(hour = DEFAULT_PUBLISH_DEADLINE_HOUR, minute = DEFAULT_PUBLISH_DEADLINE_MINUTE) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * @param {object} [options]
 * @param {Date|string|number} [options.now]
 * @param {number} [options.scheduleHour]
 * @param {number} [options.scheduleMinute]
 * @param {number} [options.deadlineHour]
 * @param {number} [options.deadlineMinute]
 */
function resolveMorningSlaWindow(options = {}) {
  const now = toDate(options.now) || new Date();
  const scheduleHour =
    options.scheduleHour == null ? DEFAULT_SCHEDULE_HOUR : Number(options.scheduleHour);
  const scheduleMinute =
    options.scheduleMinute == null
      ? DEFAULT_SCHEDULE_MINUTE
      : Number(options.scheduleMinute);
  const deadlineHour =
    options.deadlineHour == null
      ? DEFAULT_PUBLISH_DEADLINE_HOUR
      : Number(options.deadlineHour);
  const deadlineMinute =
    options.deadlineMinute == null
      ? DEFAULT_PUBLISH_DEADLINE_MINUTE
      : Number(options.deadlineMinute);

  const scheduledStartAt = atLocalTime(now, scheduleHour, scheduleMinute);
  const publishDeadline = atLocalTime(now, deadlineHour, deadlineMinute);

  return {
    scheduledStartAt: scheduledStartAt.toISOString(),
    publishDeadline: publishDeadline.toISOString(),
    scheduleLabel: formatDeadlineLabel(scheduleHour, scheduleMinute),
    deadlineLabel: formatDeadlineLabel(deadlineHour, deadlineMinute),
    scheduleHour,
    scheduleMinute,
    deadlineHour,
    deadlineMinute,
  };
}

/**
 * @param {Date|string|number} finishedAt
 * @param {Date|string|number} publishDeadline
 * @returns {{ deadlineMet: boolean, warning: string|null }}
 */
function evaluatePublishDeadline(finishedAt, publishDeadline) {
  const finished = toDate(finishedAt);
  const deadline = toDate(publishDeadline);
  if (!finished || !deadline) {
    return { deadlineMet: false, warning: DEADLINE_WARNING };
  }
  const met = finished.getTime() <= deadline.getTime();
  return {
    deadlineMet: met,
    warning: met ? null : DEADLINE_WARNING,
  };
}

module.exports = {
  DEFAULT_SCHEDULE_HOUR,
  DEFAULT_SCHEDULE_MINUTE,
  DEFAULT_PUBLISH_DEADLINE_HOUR,
  DEFAULT_PUBLISH_DEADLINE_MINUTE,
  DEADLINE_WARNING,
  atLocalTime,
  formatLocalHm,
  formatDeadlineLabel,
  resolveMorningSlaWindow,
  evaluatePublishDeadline,
};
