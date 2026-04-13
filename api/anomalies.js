export default async function handler(req, res) {
  try {
    const flightRes = await fetch("https://opensky-network.org/api/states/all");
    const data = await flightRes.json();

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
      anomalies
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
