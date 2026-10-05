'use strict';

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
function haversine(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Distance in metres from point P to segment AB (local flat projection). */
function pointToSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
  const k = Math.cos(rad(pLat)) * 111320, m = 110540;
  const px = pLng * k, py = pLat * m;
  const ax = aLng * k, ay = aLat * m, bx = bLng * k, by = bLat * m;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

module.exports = { haversine, pointToSegment };
