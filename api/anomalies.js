export default async function handler(req, res) {
  try {
    const response = await fetch("https://opensky-network.org/api/states/all", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const data = await response.json().catch(() => ({ states: [] }));

    const flights = (data.states || []).map(f => ({
      icao: f[0],
      lat: f[6],
      lon: f[5],
      altitude: f[7],
      velocity: f[9]
    }));

    const anomalies = flights
      .filter(f => f.altitude > 45000 || f.velocity > 900)
      .map(f => ({
        icao: f.icao,
        lat: f.lat,
        lon: f.lon,
        altitude: f.altitude,
        velocity: f.velocity,
        score: (f.altitude > 45000 ? 2 : 0) + (f.velocity > 900 ? 2 : 0)
      }));

    const report = {
      timestamp: new Date().toISOString(),
      totalFlights: flights.length,
      anomalyCount: anomalies.length,
      anomalies,
      source: data.states?.length ? "live" : "fallback"
    };

    // 🔥 FIREBASE WRITE (direct REST API)
    await fetch(
      "https://firestore.googleapis.com/v1/projects/anomaly-intelligence/databases/(default)/documents/daily_reports",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fields: {
            timestamp: { stringValue: report.timestamp },
            totalFlights: { integerValue: String(report.totalFlights) },
            anomalyCount: { integerValue: String(report.anomalyCount) },
            source: { stringValue: report.source }
          }
        })
      }
    );

    res.status(200).json(report);

  } catch (err) {
    res.status(500).json({
      error: "system failure",
      details: err.message
    });
  }
}}
