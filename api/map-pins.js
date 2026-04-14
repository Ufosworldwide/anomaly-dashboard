import { db } from "../firebase.js";

export default async function handler(req, res) {
  try {
    const { days = 30, source, severity } = req.query;

    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));
    const sinceStr = since.toISOString().split("T")[0];

    let query = db.collection("map_pins")
      .where("date", ">=", sinceStr)
      .orderBy("date", "desc");

    const snapshot = await query.get();
    let pins = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Optional filters
    if (source) pins = pins.filter(p => p.source === source);
    if (severity) pins = pins.filter(p => p.severity === severity);

    // Hotspot detection — cluster pins within ~500km radius
    const hotspots = detectHotspots(pins);

    res.status(200).json({
      total_pins: pins.length,
      date_range: { from: sinceStr, to: new Date().toISOString().split("T")[0] },
      hotspots_detected: hotspots.length,
      hotspots,
      pins
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to load pins", details: err.message });
  }
}

function detectHotspots(pins, radiusDeg = 5, minCount = 3) {
  // Simple grid-based density clustering
  // Groups pins within ~500km (5 degree radius) and flags clusters with 3+ pins
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < pins.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [pins[i]];
    assigned.add(i);

    for (let j = i + 1; j < pins.length; j++) {
      if (assigned.has(j)) continue;
      const dist = Math.sqrt(
        Math.pow(pins[i].lat - pins[j].lat, 2) +
        Math.pow(pins[i].lng - pins[j].lng, 2)
      );
      if (dist <= radiusDeg) {
        cluster.push(pins[j]);
        assigned.add(j);
      }
    }

    if (cluster.length >= minCount) {
      const centroidLat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
      const centroidLng = cluster.reduce((s, p) => s + p.lng, 0) / cluster.length;
      clusters.push({
        pin_count: cluster.length,
        centroid: { lat: parseFloat(centroidLat.toFixed(3)), lng: parseFloat(centroidLng.toFixed(3)) },
        sources: [...new Set(cluster.map(p => p.source))],
        severity_breakdown: {
          extreme: cluster.filter(p => p.severity === "extreme").length,
          major: cluster.filter(p => p.severity === "major").length,
          significant: cluster.filter(p => p.severity === "significant").length,
          moderate: cluster.filter(p => p.severity === "moderate").length
        },
        date_range: {
          first: cluster.map(p => p.date).sort()[0],
          last: cluster.map(p => p.date).sort().reverse()[0]
        }
      });
    }
  }

  return clusters.sort((a, b) => b.pin_count - a.pin_count);
}
