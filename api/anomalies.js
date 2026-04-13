import { db } from "../firebase.js";

export default async function handler(req, res) {
  try {
    let data = null;

    try {
      const response = await fetch("https://opensky-network.org/api/states/all", {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (response.ok) {
        data = await response.json();
      }
    } catch (e) {
      console.log("Live data failed, using fallback");
    }

    if (!data || !data.states) {
      data = {
        states: [
          ["fallback1", null, null, null, null, -80, 35, 52000, null, 980],
          ["fallback2", null, null, null, null, 10, 50, 30000, null, 420]
        ]
      };
    }

    const flights = data.states.map(f => ({
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
      source: data.states[0][0] === "fallback1" ? "fallback" : "live"
    };

    // 🔥 SAVE TO FIREBASE
    await db.collection("daily_reports").add(report);

    res.status(200).json(report);

  } catch (err) {
    res.status(500).json({
      error: "system failure",
      details: err.message
    });
  }
}
