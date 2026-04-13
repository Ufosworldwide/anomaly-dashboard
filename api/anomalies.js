export default async function handler(req, res) {
  try {
    let data;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch("https://opensky-network.org/api/states/all", {
        headers: {
          "User-Agent": "Mozilla/5.0"
        },
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) throw new Error("Bad response");

      data = await response.json();

    } catch (fetchError) {
      console.log("Primary fetch failed, using fallback");

      // 🔁 FALLBACK DATA (so system never breaks)
      data = {
        states: [
          ["test1", null, null, null, null, -80.0, 35.0, 50000, null, 950],
          ["test2", null, null, null, null, 10.0, 50.0, 30000, null, 400]
        ]
      };
    }

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
        score:
          (f.altitude > 45000 ? 2 : 0) +
          (f.velocity > 900 ? 2 : 0)
      }));

    res.status(200).json({
      timestamp: new Date().toISOString(),
      totalFlights: flights.length,
      anomalyCount: anomalies.length,
      anomalies,
      source: data.states.length > 2 ? "live" : "fallback"
    });

  } catch (err) {
    res.status(500).json({
      error: "System failure",
      details: err.message
    });
  }
}
