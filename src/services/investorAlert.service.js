const pool = require('../config/db');
const configService = require('./config.service');
const notificationService = require('./notification.service');
const { formatInr } = require('../utils/price');

// Engine 4 auction alerts with Module 43 notification intelligence:
//   - matching: verified investors whose preferences fit the deal
//     (cities, asset class, ticket size);
//   - priority: deals at/above opportunity.priority_alert_score go out
//     immediately; everything else waits for the investor's daily window
//     (alerts.window_start-end, in the investor's own time zone);
//   - fatigue control: alerts.max_per_day (or the investor's own cap) on
//     non-priority alerts; matches in a city + category the investor keeps
//     dismissing are suppressed;
//   - channels: in-app always, WhatsApp when the investor opted in and an
//     approved template is configured.
// opportunity_alert_log is both the queue (pending) and the history.

const CATEGORIES = ['auction', 'special_situation', 'institutional'];

function parseHm(value, fallback) {
  const m = /^([0-2]?[0-9]):([0-5][0-9])$/.exec(String(value || fallback));
  return m ? { h: Number(m[1]), m: Number(m[2]) } : parseHm(fallback, '09:30');
}

// Minutes since local midnight for `date` in `timeZone`.
function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return (get('hour') % 24) * 60 + get('minute');
}

function safeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Kolkata' });
    return tz || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

// Next time the investor's local clock is inside [start, end): now if we are
// already inside it, otherwise the next start.
async function nextWindow(timeZone, from = new Date()) {
  const tz = safeZone(timeZone);
  const start = parseHm(await configService.getConfig('alerts.window_start', '09:30'), '09:30');
  const end = parseHm(await configService.getConfig('alerts.window_end', '10:30'), '10:30');
  const startMin = start.h * 60 + start.m;
  const endMin = end.h * 60 + end.m;
  const now = localMinutes(from, tz);
  if (now >= startMin && now < endMin) return from;
  const delta = now < startMin ? startMin - now : 24 * 60 - now + startMin;
  const at = new Date(from.getTime() + delta * 60 * 1000);
  at.setSeconds(0, 0);
  return at;
}

async function matchInvestors(property) {
  const ticket = property.reserve_price ?? property.price_value;
  const result = await pool.query(
    `SELECT ip.id AS profile_id, ip.user_id, ip.time_zone, ip.alert_mode, ip.alert_max_per_day, ip.alert_channels,
            ip.preferred_cities, ip.asset_class_preferences, u.mobile
     FROM investor_profiles ip
     JOIN users u ON u.id = ip.user_id AND u.status = 'active'
     WHERE ip.verification_status = 'verified' AND ip.alerts_enabled = true
       AND (ip.preferred_cities = '[]'::jsonb OR EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(ip.preferred_cities) c WHERE LOWER(c) = LOWER($1)))
       AND (ip.asset_class_preferences = '[]'::jsonb OR ip.asset_class_preferences ? $2)
       AND ($3::numeric IS NULL OR ip.ticket_size_min IS NULL OR ip.ticket_size_min <= $3)
       AND ($3::numeric IS NULL OR ip.ticket_size_max IS NULL OR ip.ticket_size_max >= $3)`,
    [property.city, property.listing_category, ticket]
  );
  return result.rows;
}

// Behavioural signal for one investor on this deal's city + category over
// the last 30 days: positive engagement vs dismissals.
async function behaviour(userId, property) {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE action IN ('viewed', 'shortlisted', 'shared', 'document_requested', 'interest_expressed'))::int AS positive,
            COUNT(*) FILTER (WHERE action = 'dismissed')::int AS dismissed
     FROM investor_deal_interactions
     WHERE user_id = $1 AND LOWER(city) = LOWER($2) AND listing_category = $3 AND created_at > now() - interval '30 days'`,
    [userId, property.city, property.listing_category]
  );
  return result.rows[0];
}

// Queue alerts for a newly live deal; priority ones are delivered now.
async function queueAlertsForDeal(propertyId) {
  const result = await pool.query('SELECT * FROM properties WHERE id = $1', [propertyId]);
  const property = result.rows[0];
  if (!property || property.status !== 'approved' || !CATEGORIES.includes(property.listing_category)) return { queued: 0 };

  const priorityScore = Number(await configService.getConfig('opportunity.priority_alert_score', 75));
  const isPriority = property.investment_score != null && Number(property.investment_score) >= priorityScore;
  const dismissThreshold = Number(await configService.getConfig('alerts.dismiss_suppress_threshold', 3)) || 3;

  const summary = { matched: 0, queued: 0, suppressed: 0, priority: isPriority };
  for (const investor of await matchInvestors(property)) {
    summary.matched += 1;
    const b = await behaviour(investor.user_id, property);
    const suppressed = !isPriority && b.dismissed >= dismissThreshold && b.positive === 0;
    const scheduledFor = isPriority || investor.alert_mode === 'instant' ? new Date() : await nextWindow(investor.time_zone);
    const inserted = await pool.query(
      `INSERT INTO opportunity_alert_log (property_id, user_id, is_priority, status, scheduled_for, reason, match_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (property_id, user_id) DO NOTHING RETURNING id`,
      [
        propertyId,
        investor.user_id,
        isPriority,
        suppressed ? 'suppressed' : 'pending',
        scheduledFor,
        suppressed ? 'repeatedly_dismissed_similar' : isPriority ? 'priority' : investor.alert_mode === 'instant' ? 'instant_preference' : 'window',
        Math.min(100, 50 + b.positive * 10 - b.dismissed * 10),
      ]
    );
    if (!inserted.rows[0]) continue;
    if (suppressed) summary.suppressed += 1;
    else summary.queued += 1;
  }
  const dispatched = await dispatchDue();
  return { ...summary, sentNow: dispatched.sent };
}

async function sendWhatsapp(alert, property, template) {
  if (!template || !alert.mobile) return false;
  try {
    const metaWhatsapp = require('./metaWhatsapp.service');
    const siteUrl = await configService.getConfig('alerts.site_url', 'https://propertyserch.com');
    const digits = String(alert.mobile).replace(/\D/g, '').slice(-10);
    await metaWhatsapp.sendTemplate({
      to: `91${digits}`,
      templateName: template,
      variables: [property.title, property.city || '', formatInr(property.reserve_price ?? property.price_value) || '', `${siteUrl}/deals/${property.id}`],
    });
    return true;
  } catch (err) {
    console.error(`[alerts] WhatsApp alert failed for ${alert.user_id}:`, err.message);
    return false;
  }
}

// Deliver every pending alert that is due, respecting the daily cap for
// non-priority alerts. Safe to call often (from the scheduler and after
// queueing).
async function dispatchDue() {
  const defaultCap = Number(await configService.getConfig('alerts.max_per_day', 3)) || 3;
  const template = await configService.getConfig('alerts.whatsapp_template', '');
  const due = await pool.query(
    `SELECT a.*, ip.alert_max_per_day, ip.alert_channels, u.mobile
     FROM opportunity_alert_log a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN investor_profiles ip ON ip.user_id = a.user_id
     WHERE a.status = 'pending' AND a.scheduled_for <= now()
     ORDER BY a.is_priority DESC, a.match_score DESC NULLS LAST, a.scheduled_for ASC
     LIMIT 500`
  );
  let sent = 0;
  let capped = 0;
  for (const alert of due.rows) {
    const property = (await pool.query('SELECT * FROM properties WHERE id = $1', [alert.property_id])).rows[0];
    if (!property || property.status !== 'approved') {
      await pool.query(`UPDATE opportunity_alert_log SET status = 'suppressed', reason = 'deal_no_longer_live' WHERE id = $1`, [alert.id]);
      continue;
    }
    if (!alert.is_priority) {
      const today = await pool.query(
        `SELECT COUNT(*)::int AS n FROM opportunity_alert_log WHERE user_id = $1 AND status = 'sent' AND NOT is_priority AND sent_at > now() - interval '24 hours'`,
        [alert.user_id]
      );
      if (today.rows[0].n >= (alert.alert_max_per_day || defaultCap)) {
        await pool.query(`UPDATE opportunity_alert_log SET status = 'suppressed', reason = 'daily_cap' WHERE id = $1`, [alert.id]);
        capped += 1;
        continue;
      }
    }
    const ticket = property.reserve_price ?? property.price_value;
    const label = property.listing_category === 'auction' ? 'bank auction' : property.listing_category === 'institutional' ? 'institutional' : 'special situation';
    await notificationService.createNotification({
      userId: alert.user_id,
      type: alert.is_priority ? 'opportunity_alert_priority' : 'opportunity_alert',
      title: `${alert.is_priority ? 'Priority: ' : ''}New ${label} deal in ${property.city}`,
      message: `${property.title}${ticket ? ` - ${formatInr(ticket)}` : ''}${property.investment_score != null ? ` (score ${property.investment_score})` : ''}`,
      relatedEntityType: 'property',
      relatedEntityId: property.id,
    });
    const channels = ['in_app'];
    if ((alert.alert_channels || []).includes('whatsapp') && (await sendWhatsapp(alert, property, template))) channels.push('whatsapp');
    await pool.query(`UPDATE opportunity_alert_log SET status = 'sent', sent_at = now(), channels = $1 WHERE id = $2`, [JSON.stringify(channels), alert.id]);
    sent += 1;
  }
  return { due: due.rows.length, sent, capped };
}

async function listAlerts({ status, propertyId, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`a.status = $${params.length}`);
  }
  if (propertyId) {
    params.push(propertyId);
    where.push(`a.property_id = $${params.length}`);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const result = await pool.query(
    `SELECT a.*, u.full_name AS investor_name, p.title AS property_title, p.city, p.listing_category
     FROM opportunity_alert_log a JOIN users u ON u.id = a.user_id JOIN properties p ON p.id = a.property_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params
  );
  const stats = await pool.query(
    `SELECT status, reason, COUNT(*)::int AS n FROM opportunity_alert_log WHERE created_at > now() - interval '30 days' GROUP BY status, reason`
  );
  return { items: result.rows, last30Days: stats.rows };
}

// Background dispatcher: every 5 minutes deliver alerts whose window opened.
// Once a day it also re-scores live deals so the conversion-history
// learning adjustment keeps up with outcomes.
let timer = null;
let lastRescore = 0;
function startDispatcher() {
  if (timer) return;
  timer = setInterval(() => {
    dispatchDue().catch((err) => console.error('[alerts] dispatch failed:', err.message));
    if (Date.now() - lastRescore > 24 * 60 * 60 * 1000) {
      lastRescore = Date.now();
      require('./opportunityScoring.service')
        .rescoreAll()
        .catch((err) => console.error('[scoring] daily rescore failed:', err.message));
    }
  }, 5 * 60 * 1000);
}

module.exports = { queueAlertsForDeal, dispatchDue, listAlerts, nextWindow, startDispatcher };
