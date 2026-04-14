import { db } from "../firebase.js";

// ─────────────────────────────────────────────
// DATA FETCHERS
// ─────────────────────────────────────────────

async function fetchKp(since) {
  const url = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
  const res = await fetch(url);
  const raw = await res.json();

  // raw is array of [datetime_string, kp_value, ...], first row is header
  const rows = raw.slice(1);
  const sinceTime = since ? new Date(since) : new Date(Date.now() - 86400000);

  const readings = rows
    .filter(r => new Date(r[0]) > sinceTime)
    .map(r => ({
      time: r[0],
      kp: parseFloat(r[1])
    }));

  if (readings.length === 0) return null;

  const values = readings.map(r => r.kp);
  const peak = Math.max(...values);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  const stormReadings = readings.filter(r => r.kp >= 5);

  const anomalies = stormReadings.map(r => ({
    source: "kp_geomagnetic",
    time: r.time,
    value: r.kp,
    label: `Geomagnetic storm — Kp ${r.kp}`,
    severity: r.kp >= 7 ? "extreme" : r.kp >= 6 ? "severe" : "moderate",
    lat: null,
    lng: null,
    anomaly_score: Math.min(10, (r.kp / 9) * 10)
  }));

  return {
    feed: "kp_geomagnetic",
    stats: {
      readings_captured: readings.length,
      peak_kp: peak,
      average_kp: parseFloat(average.toFixed(2)),
      storm_level_readings: stormReadings.length,
      status: peak >= 7 ? "EXTREME STORM" : peak >= 5 ? "GEOMAGNETIC STORM" : peak >= 4 ? "ELEVATED" : "QUIET"
    },
    anomalies
  };
}

async function fetchSeismic(since) {
  const sinceTime = since
    ? new Date(since).toISOString()
    : new Date(Date.now() - 86400000).toISOString();

  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${sinceTime}&minmagnitude=2.5&orderby=magnitude`;
  const res = await fetch(url);
  const raw = await res.json();

  const events = raw.features || [];
  if (events.length === 0) return null;

  const magnitudes = events.map(e => e.properties.mag);
  const significant = events.filter(e => e.properties.mag >= 5.0);
  const major = events.filter(e => e.properties.mag >= 6.0);

  const anomalies = significant.map(e => {
    const [lng, lat, depth] = e.geometry.coordinates;
    const mag = e.properties.mag;
    return {
      source: "usgs_seismic",
      time: new Date(e.properties.time).toISOString(),
      value: mag,
      label: `M${mag} — ${e.properties.place}`,
      severity: mag >= 7.0 ? "extreme" : mag >= 6.0 ? "major" : "significant",
      lat,
      lng,
      depth_km: depth,
      anomaly_score: Math.min(10, ((mag - 5) / 4) * 10 + 5)
    };
  });

  return {
    feed: "usgs_seismic",
    stats: {
      total_events: events.length,
      above_m3: events.filter(e => e.properties.mag >= 3.0).length,
      above_m5: significant.length,
      above_m6: major.length,
      peak_magnitude: Math.max(...magnitudes),
      average_magnitude: parseFloat(
        (magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length).toFixed(2)
      ),
      status: major.length > 0 ? "MAJOR SEISMIC ACTIVITY" : significant.length > 0 ? "SIGNIFICANT ACTIVITY" : "NORMAL"
    },
    anomalies
  };
}

async function fetchSolar(since) {
  const sinceDate = since
    ? new Date(since).toISOString().split("T")[0]
    : new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const today = new Date().toISOString().split("T")[0];

  const [flareRes, cmeRes] = await Promise.all([
    fetch(`https://api.nasa.gov/DONKI/FLR?startDate=${sinceDate}&endDate=${today}&api_key=DEMO_KEY`),
    fetch(`https://api.nasa.gov/DONKI/CME?startDate=${sinceDate}&endDate=${today}&api_key=DEMO_KEY`)
  ]);

  const flares = await flareRes.json();
  const cmes = await cmeRes.json();

  const significantFlares = (flares || []).filter(f =>
    f.classType && (f.classType.startsWith("M") || f.classType.startsWith("X"))
  );

  const earthDirectedCMEs = (cmes || []).filter(c =>
    c.cmeAnalyses?.some(a => a.enlilList?.some(e => e.isEarthGB))
  );

  const anomalies = [
    ...significantFlares.map(f => ({
      source: "donki_solar",
      time: f.peakTime || f.beginTime,
      value: f.classType,
      label: `Solar flare — Class ${f.classType}`,
      severity: f.classType.startsWith("X") ? "extreme" : "moderate",
      lat: null,
      lng: null,
      anomaly_score: f.classType.startsWith("X") ? 9 : 6
    })),
    ...earthDirectedCMEs.map(c => ({
      source: "donki_cme",
      time: c.startTime,
      value: "CME",
      label: `Earth-directed CME detected`,
      severity: "major",
      lat: null,
      lng: null,
      anomaly_score: 8
    }))
  ];

  return {
    feed: "donki_solar",
    stats: {
      total_flares: (flares || []).length,
      m_class_flares: significantFlares.filter(f => f.classType.startsWith("M")).length,
      x_class_flares: significantFlares.filter(f => f.classType.startsWith("X")).length,
      cmes_detected: (cmes || []).length,
      earth_directed_cmes: earthDirectedCMEs.length,
      status: earthDirectedCMEs.length > 0 ? "EARTH-DIRECTED CME ACTIVE" :
              significantFlares.some(f => f.classType.startsWith("X")) ? "X-CLASS FLARE" :
              significantFlares.length > 0 ? "M-CLASS FLARE ACTIVITY" : "QUIET"
    },
    anomalies
  };
}

// ─────────────────────────────────────────────
// CROSS-CHANNEL ANALYSIS
// ─────────────────────────────────────────────

function analyzeCrossChannel(feeds) {
  const activeFeeds = feeds.filter(f => f && f.anomalies.length > 0);
  const isMultiChannel = activeFeeds.length >= 2;

  const flags = [];
  if (isMultiChannel) {
    flags.push(`Multi-channel event: ${activeFeeds.map(f => f.feed).join(" + ")}`);
  }

  // Check for solar → geomagnetic correlation
  const hasSolar = activeFeeds.find(f => f.feed === "donki_solar");
  const hasKp = activeFeeds.find(f => f.feed === "kp_geomagnetic");
  if (hasSolar && hasKp) {
    flags.push("Solar activity correlating with geomagnetic disturbance — causal chain possible");
  }

  return {
    multi_channel: isMultiChannel,
    active_feed_count: activeFeeds.length,
    flags
  };
}

// ─────────────────────────────────────────────
// MAP PIN WRITER
// ─────────────────────────────────────────────

async function writePins(anomalies, caseId, date) {
  const geoAnomalies = anomalies.filter(a => a.lat !== null && a.lng !== null);
  const batch = db.batch();

  for (const a of geoAnomalies) {
    const pinRef = db.collection("map_pins").doc();
    batch.set(pinRef, {
      case_id: caseId,
      date,
      source: a.source,
      lat: a.lat,
      lng: a.lng,
      label: a.label,
      severity: a.severity,
      anomaly_score: a.anomaly_score,
      created_at: new Date().toISOString()
    });
  }

  if (geoAnomalies.length > 0) await batch.commit();
  return geoAnomalies.length;
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // Get last pull timestamp from system state
    const stateRef = db.collection("system_state").doc("pull_tracker");
    const stateDoc = await stateRef.get();
    const lastPull = stateDoc.exists ? stateDoc.data().last_pull : null;
    const pullDate = new Date().toISOString().split("T")[0];

    // Fetch all three feeds in parallel
    const [kpData, seismicData, solarData] = await Promise.allSettled([
      fetchKp(lastPull),
      fetchSeismic(lastPull),
      fetchSolar(lastPull)
    ]);

    const feeds = [
      kpData.status === "fulfilled" ? kpData.value : null,
      seismicData.status === "fulfilled" ? seismicData.value : null,
      solarData.status === "fulfilled" ? solarData.value : null
    ];

    // Collect all anomalies across feeds, sorted by time
    const allAnomalies = feeds
      .filter(Boolean)
      .flatMap(f => f.anomalies)
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    // Cross-channel analysis
    const crossChannel = analyzeCrossChannel(feeds.filter(Boolean));

    // Build the unified daily case document
    const dailyCase = {
      case_type: "daily_anomaly_report",
      date: pullDate,
      pull_window: {
        from: lastPull || new Date(Date.now() - 86400000).toISOString(),
        to: new Date().toISOString()
      },
      summary: {
        total_anomalies: allAnomalies.length,
        feeds_active: feeds.filter(Boolean).length,
        multi_channel_event: crossChannel.multi_channel,
        cross_channel_flags: crossChannel.flags,
        overall_status: crossChannel.multi_channel ? "MULTI-CHANNEL ANOMALY" :
                        allAnomalies.length > 0 ? "ANOMALIES DETECTED" : "BASELINE NORMAL"
      },
      feed_stats: {
        kp_geomagnetic: kpData.status === "fulfilled" && kpData.value ? kpData.value.stats : null,
        usgs_seismic: seismicData.status === "fulfilled" && seismicData.value ? seismicData.value.stats : null,
        donki_solar: solarData.status === "fulfilled" && solarData.value ? solarData.value.stats : null
      },
      anomalies: allAnomalies,
      created_at: new Date().toISOString()
    };

    // Write case to Firestore
    const caseRef = await db.collection("daily_reports").add(dailyCase);

    // Write geographic pins
    const pinsWritten = await writePins(allAnomalies, caseRef.id, pullDate);

    // Update system state with last pull timestamp
    await stateRef.set({ last_pull: new Date().toISOString() });

    res.status(200).json({
      success: true,
      case_id: caseRef.id,
      date: pullDate,
      pull_window: dailyCase.pull_window,
      summary: dailyCase.summary,
      pins_written: pinsWritten,
      feed_stats: dailyCase.feed_stats
    });

  } catch (err) {
    res.status(500).json({
      error: "Daily pull failed",
      details: err.message
    });
  }
}
